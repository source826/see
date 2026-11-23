// 用实时页真实处理帧（frame/t/dt 均为实际值）跑同一套事件评测。
import { readFileSync } from 'node:fs';
import { evaluateAlarmEvents } from '../eval/events.js';

const livePath = process.argv[2];
const gtPath = process.argv[3];
const live = JSON.parse(readFileSync(livePath, 'utf8'));
const gt = JSON.parse(readFileSync(gtPath, 'utf8'));
const analysis = live.analysis || { width: 320, height: 180 };
const sx = analysis.width / gt.width;
const sy = analysis.height / gt.height;
const frames = [...(live.frames || [])].sort((a, b) => a.frame - b.frame);
const scale = (b) => ({ x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy });

function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

// GT 每 5 帧一个样本，实时页约 6 fps，采样帧通常不落在 GT 网格上。
// 按 track id 做线性插值，把 GT 补到每个实际处理帧，避免“采样帧没 GT”导致漏配。
const gtTracks = new Map();
for (const [fs, boxes] of Object.entries(gt.frames)) {
  for (const b of boxes) {
    if (b.cls === 'static') continue;
    if (!gtTracks.has(b.id)) gtTracks.set(b.id, []);
    gtTracks.get(b.id).push({ frame: Number(fs), ...b });
  }
}
for (const list of gtTracks.values()) list.sort((a, b) => a.frame - b.frame);
function gtAt(frame) {
  const out = [];
  for (const [id, list] of gtTracks) {
    if (frame < list[0].frame || frame > list[list.length - 1].frame) continue;
    let i = 0;
    while (i + 1 < list.length && list[i + 1].frame < frame) i++;
    const a = list[i];
    const b = list[Math.min(i + 1, list.length - 1)];
    const span = Math.max(1, b.frame - a.frame);
    const k = Math.min(1, Math.max(0, (frame - a.frame) / span));
    out.push({
      id,
      cls: a.cls,
      bg: Boolean(a.bg || b.bg),
      bbox: scale({
        x: a.x + (b.x - a.x) * k,
        y: a.y + (b.y - a.y) * k,
        w: a.w + (b.w - a.w) * k,
        h: a.h + (b.h - a.h) * k,
      }),
    });
  }
  return out;
}
const firstGtFrame = Math.min(...Object.keys(gt.frames).map(Number));
// 评测以“真正播出的报警”为准（live.alerts 由播报器冷却后写入），
// 而不是每帧风险等级；否则会把被冷却压掉的重复提示也算成误报。
const spokenByFrame = new Map();
for (const a of live.alerts || []) {
  if (a.trackId < 0) continue;
  if (!spokenByFrame.has(a.frame)) spokenByFrame.set(a.frame, []);
  spokenByFrame.get(a.frame).push({ level: a.level, trackId: a.trackId });
}
const hasSpoken = spokenByFrame.size > 0;
const matchByFrame = {};
const eventFrames = [];
const idVotes = new Map();
for (const rec of frames) {
  const gtBoxes = gtAt(rec.frame);
  const pred = (rec.perTrack || []).filter((p) => p.confirmed).map((p) => ({ id: p.id, bbox: p.bbox }));
  const pairs = [];
  for (let a = 0; a < gtBoxes.length; a++) {
    for (let b = 0; b < pred.length; b++) {
      const v = iou(gtBoxes[a].bbox, pred[b].bbox);
      // 小目标（贴边行人）框抖动大，实时匹配用 0.2；大目标仍用 0.3。
      const small = gtBoxes[a].bbox.w * gtBoxes[a].bbox.h < 0.01 * analysis.width * analysis.height;
      if (v >= (small ? 0.2 : 0.3)) pairs.push({ a, b, v, small });
    }
  }
  pairs.sort((p, q) => q.v - p.v || (q.small ? 1 : 0) - (p.small ? 1 : 0));
  const usedA = new Uint8Array(gtBoxes.length);
  const usedB = new Uint8Array(pred.length);
  const map = new Map();
  for (const p of pairs) {
    if (usedA[p.a] || usedB[p.b]) continue;
    usedA[p.a] = 1;
    usedB[p.b] = 1;
    // 背景轨迹如果和事件目标重叠，报警映射到事件 id（只用于事件对齐，
    // 背景框本身仍 bg=true，不参与事件定义）。
    const rawId = gtBoxes[p.a].id;
    const mappedId = gtBoxes[p.a].bg && gt.bgMap && gt.bgMap[String(rawId)]
      ? Number(gt.bgMap[String(rawId)])
      : rawId;
    map.set(pred[p.b].id, mappedId);
    let votes = idVotes.get(pred[p.b].id);
    if (!votes) {
      votes = new Map();
      idVotes.set(pred[p.b].id, votes);
    }
    votes.set(mappedId, (votes.get(mappedId) || 0) + 1);
  }
  matchByFrame[rec.frame] = map;
  eventFrames.push({
    frame: rec.frame,
    gt: gtBoxes,
    alerts: hasSpoken
      ? spokenByFrame.get(rec.frame) || []
      : (rec.alerts || []).filter((a) => a.level >= 2),
    corridor: rec.corridor && rec.corridor.wide ? { poly: rec.corridor.wide } : null,
  });
}
// GT 起点之前的帧没有 GT，用全局 ID 多数票映射（和评测台 warmup 口径一致），
// 这样“事件发生前的报警”才能算提前量，而不是一律 0。
const idMap = new Map();
for (const [trackId, votes] of idVotes) {
  let bestId;
  let best = -1;
  for (const [gtId, n] of votes) {
    if (n > best) {
      best = n;
      bestId = gtId;
    }
  }
  idMap.set(trackId, bestId);
}
for (const rec of frames) {
  if (rec.frame < firstGtFrame) matchByFrame[rec.frame] = idMap;
}
const events = evaluateAlarmEvents({
  frames: eventFrames,
  matchByFrame,
  fps: gt.fps || 30,
  // 提前量窗口放到 5 s：3 s 以内才认会把 3.1 s 的有效预警直接丢掉。
  leadSec: 5,
  minLevel: 2,
  durationSec: live.duration,
  groupSec: gt.eventGroupSec || 0,
  // 人群里同一个人反复贴边进出通道不算多次事件；街景仍按 0.5 s 允许短时重入。
  reentrySec: gt.reentrySec || 0.5,
  // 远处小目标单帧 IoU 会漏配，用轨迹多数票兜底报警归属。
  idMap,
  // 静止机位/预热段（如夜间雨天前 4 秒）不纳入误报统计。
  evalStartFrame: gt.evalStartSec ? Math.round(gt.evalStartSec * (gt.fps || 30)) : undefined,
});
const fpIds = [...new Set((events.fpAlerts || []).map((a) => a.trackId))];
// 三态：事件目标 / 背景目标 / 未匹配。未匹配才是真正的“来源不明”误报。
const eventIds = new Set();
const bgIds = new Set();
for (const boxes of Object.values(gt.frames || {})) {
  for (const b of boxes) (b.bg ? bgIds : eventIds).add(b.id);
}
// 三态计数由事件评测器统一给出；这里只额外收集未匹配轨迹的明细。
const bgStates = events.alertStates;
// 人群场景的“该报”口径：每个进入过通道的 GT 目标，至少听到一次映射到它的语音提醒即可。
// 人群是连续流，不要求每次贴边重入都提前报；看覆盖率而不是逐次提前量。
const eventGtIdsForCoverage = new Set((events.events || []).map((e) => e.gtId));
const coveredGtIds = new Set();
for (const rec of frames) {
  const spoken = hasSpoken ? spokenByFrame.get(rec.frame) || [] : rec.alerts || [];
  for (const a of spoken) {
    if (a.level < 2) continue;
    const mapped = matchByFrame[rec.frame] ? matchByFrame[rec.frame].get(a.trackId) : undefined;
    if (mapped !== undefined && eventGtIdsForCoverage.has(mapped)) coveredGtIds.add(mapped);
  }
}
const eventCoverage = {
  covered: coveredGtIds.size,
  total: eventGtIdsForCoverage.size,
  ratio: eventGtIdsForCoverage.size ? coveredGtIds.size / eventGtIdsForCoverage.size : null,
  ids: [...coveredGtIds],
};
// 诊断：每个事件 GT 目标被检出/进通道/给等级的帧数，区分“没检出”和“检出了但规则没报”。
const eventDiagnostics = [];
for (const gtId of eventGtIdsForCoverage) {
  const firstEntry = Math.min(...(events.events || []).filter((e) => e.gtId === gtId).map((e) => e.entryFrame));
  const d = {
    gtId,
    entryFrame: firstEntry,
    samples: 0,
    matched: 0,
    level2Frames: 0,
    strictFrames: 0,
    approachingFrames: 0,
    firstMatchedFrame: null,
    firstLevel2Frame: null,
    firstStrictFrame: null,
    firstSpokenFrame: null,
    firstSpokenLeadSec: null,
    predIds: [],
    idSwitches: 0,
    matchedBeforeEntry: 0,
    strictBeforeEntry: 0,
    level2BeforeEntry: 0,
    maxMatchGapFrames: 0,
  };
  let prevPredId = null;
  let prevMatchedFrame = null;
  for (const rec of frames) {
    const boxes = (gt.frames[String(rec.frame)] || []).filter((b) => b.id === gtId && !b.bg);
    if (!boxes.length) continue;
    d.samples++;
    const predId = [...(matchByFrame[rec.frame] || new Map())].find(([, gid]) => gid === gtId)?.[0];
    if (predId === undefined) continue;
    d.matched++;
    if (d.firstMatchedFrame === null) d.firstMatchedFrame = rec.frame;
    if (prevPredId !== null && predId !== prevPredId) d.idSwitches++;
    prevPredId = predId;
    if (!d.predIds.includes(predId)) d.predIds.push(predId);
    if (prevMatchedFrame !== null) d.maxMatchGapFrames = Math.max(d.maxMatchGapFrames, rec.frame - prevMatchedFrame);
    prevMatchedFrame = rec.frame;
    const beforeEntry = rec.frame < firstEntry;
    if (beforeEntry) d.matchedBeforeEntry++;
    const p = (rec.perTrack || []).find((x) => x.id === predId);
    if (!p) continue;
    if (p.level >= 2) {
      d.level2Frames++;
      if (beforeEntry) d.level2BeforeEntry++;
      if (d.firstLevel2Frame === null) d.firstLevel2Frame = rec.frame;
    }
    if (p.inStrict) {
      d.strictFrames++;
      if (beforeEntry) d.strictBeforeEntry++;
      if (d.firstStrictFrame === null) d.firstStrictFrame = rec.frame;
    }
    if (p.approaching) d.approachingFrames++;
  }
  for (const rec of frames) {
    const spoken = hasSpoken ? spokenByFrame.get(rec.frame) || [] : rec.alerts || [];
    const hit = spoken.find((a) => {
      if (a.level < 2) return false;
      const m = matchByFrame[rec.frame];
      const gid = m ? m.get(a.trackId) : undefined;
      return gid === gtId;
    });
    if (hit) {
      d.firstSpokenFrame = rec.frame;
      d.firstSpokenLeadSec = Math.round(((firstEntry - rec.frame) / (gt.fps || 30)) * 100) / 100;
      break;
    }
  }
  eventDiagnostics.push(d);
}
const unmatched = new Map();
for (const rec of frames) {
  const spoken = hasSpoken ? spokenByFrame.get(rec.frame) || [] : rec.alerts || [];
  for (const a of spoken) {
    if (a.level < 2) continue;
    const mapped = matchByFrame[rec.frame] ? matchByFrame[rec.frame].get(a.trackId) : undefined;
    if (mapped === undefined && !unmatched.has(a.trackId)) {
      const p = (rec.perTrack || []).find((x) => x.id === a.trackId);
      unmatched.set(a.trackId, {
        trackId: a.trackId,
        firstFrame: rec.frame,
        level: a.level,
        cls: p ? p.cls : null,
        className: p ? p.className : null,
        bbox: p ? p.bbox : null,
      });
    }
  }
}
// 三态一致性：GT 用脚点纵坐标独立标注 motion，系统用面积增长给 motionState。
// 只在 GT 采样帧上比较，避免插值标签误差。
const motionConfusion = {};
let motionTotal = 0;
let motionAgree = 0;
const motionPairs = [];
const trackHistory = new Map();
for (const rec of frames) {
  for (const p of rec.perTrack || []) {
    if (!p.bbox) continue;
    if (!trackHistory.has(p.id)) trackHistory.set(p.id, []);
    trackHistory.get(p.id).push({
      frame: rec.frame,
      area: Math.max(1, p.bbox.w * p.bbox.h),
      h: Math.max(1, p.bbox.h),
    });
  }
}
function linregSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let den = 0;
  let num = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    den += dx * dx;
    num += dx * (ys[i] - my);
  }
  return den > 1e-9 ? num / den : 0;
}
function logRateAt(trackId, frame, field, fps) {
  const hist = (trackHistory.get(trackId) || []).filter((v) => v.frame <= frame && v.frame >= frame - 1.5 * fps);
  if (hist.length < 5) return null;
  const xs = hist.map((v) => v.frame);
  const ys = hist.map((v) => Math.log(v[field]));
  const deltas = [];
  for (let i = 1; i < xs.length; i++) deltas.push(Math.max(1, xs[i] - xs[i - 1]));
  deltas.sort((a, b) => a - b);
  const step = deltas[Math.floor(deltas.length / 2)] || 1;
  return linregSlope(xs, ys) * (fps / step);
}
const evalStartFrame = gt.evalStartSec ? gt.evalStartSec * (gt.fps || 30) : 0;
for (const rec of frames) {
  if (rec.frame < evalStartFrame) continue;
  const boxes = gt.frames[String(rec.frame)] || [];
  if (!boxes.length) continue;
  const reverse = new Map();
  for (const [predId, gtId] of (matchByFrame[rec.frame] || new Map())) reverse.set(gtId, predId);
  for (const b of boxes) {
    if (!b.motion || b.motion === 'unknown') continue;
    // GT 轨迹首尾各 12 帧的脚点斜率只由单侧窗口估计，标签不稳定，不参与一致性统计。
    const range = gtTracks.get(b.id);
    if (range && (rec.frame - range[0].frame < 12 || range[range.length - 1].frame - rec.frame < 12)) continue;
    const predId = reverse.get(b.id);
    if (predId === undefined) continue;
    const p = (rec.perTrack || []).find((x) => x.id === predId);
    // 系统轨迹刚建立、样本不足时三态也会跳变，等 5 次命中后再比。
    if (!p || !p.motionState || p.hits < 5) continue;
    const key = `${b.motion}->${p.motionState}`;
    motionConfusion[key] = (motionConfusion[key] || 0) + 1;
    motionTotal++;
    if (b.motion === p.motionState) motionAgree++;
    motionPairs.push({
      gt: b.motion,
      heightRate: logRateAt(predId, rec.frame, 'h', gt.fps || 30),
      areaRate: logRateAt(predId, rec.frame, 'area', gt.fps || 30),
    });
  }
}
// 用外部脚点标签做网格搜索：看哪种系统信号/死区阈值最接近独立三态。
function motionGrid(field) {
  let best = null;
  for (let th = 0.01; th <= 0.201; th += 0.01) {
    let agree = 0;
    let n = 0;
    const conf = {};
    for (const s of motionPairs) {
      const r = s[field];
      if (r === null) continue;
      const state = r > th ? 'approaching' : r < -th ? 'receding' : 'static';
      conf[`${s.gt}->${state}`] = (conf[`${s.gt}->${state}`] || 0) + 1;
      n++;
      if (state === s.gt) agree++;
    }
    if (n >= 20 && (!best || agree / n > best.agreement)) {
      best = { signal: field, threshold: Math.round(th * 100) / 100, agreement: Math.round((agree / n) * 1000) / 1000, samples: n, confusion: conf };
    }
  }
  return best;
}
const motionGridBest = [motionGrid('heightRate'), motionGrid('areaRate')].filter(Boolean);
function motionSeries(field) {
  const out = [];
  for (let th = 0.01; th <= 0.101; th += 0.01) {
    let agree = 0;
    let n = 0;
    for (const s of motionPairs) {
      const r = s[field];
      if (r === null) continue;
      const state = r > th ? 'approaching' : r < -th ? 'receding' : 'static';
      n++;
      if (state === s.gt) agree++;
    }
    if (n >= 20) out.push({ threshold: Math.round(th * 100) / 100, agreement: Math.round((agree / n) * 1000) / 1000, samples: n });
  }
  return out;
}
const motionSeriesHeight = motionSeries('heightRate');
// 误报是否可评估：需要有背景 GT，且 GT 覆盖大部分片长；否则“未标注的真实目标”会被误算成 FP。
let gtBgCount = 0;
let gtMinFrame = Infinity;
let gtMaxFrame = -Infinity;
for (const [k, boxes] of Object.entries(gt.frames || {})) {
  const f = Number(k);
  gtMinFrame = Math.min(gtMinFrame, f);
  gtMaxFrame = Math.max(gtMaxFrame, f);
  for (const b of boxes) if (b.bg) gtBgCount++;
}
const gtSpanSec = Number.isFinite(gtMinFrame) ? (gtMaxFrame - gtMinFrame) / (gt.fps || 30) : 0;
const fpEvaluable = gtBgCount > 0 && gtSpanSec >= 0.6 * (live.duration || 0);

const pct = (arr, q) => {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  return Math.round(a[Math.min(a.length - 1, Math.floor((a.length - 1) * q))] * 10) / 10;
};
const proc = frames.map((f) => f.procMs);
const detect = frames.map((f) => f.detectMs);
const speech = live.speech || [];
const queue = speech.map((s) => s.queueMs);
const e2e = speech.map((s) => {
  const f = frames.find((x) => x.frame === s.frame);
  return (f ? f.procMs || 0 : 0) + s.queueMs;
});
console.log(JSON.stringify({
  live: livePath,
  backend: live.status,
  processedFrames: frames.length,
  frameSpan: frames.length ? [frames[0].frame, frames[frames.length - 1].frame] : null,
  avgDt: frames.length > 1 ? (frames.reduce((a, r) => a + (r.dt || 0), 0) / frames.length).toFixed(3) : null,
  events: {
    eventCount: events.eventCount,
    tp: events.tpEvents,
    fn: events.fnEvents,
    recall: events.eventRecall,
    late: events.lateEvents,
    leadMedian: events.leadMedian,
    leadP10: events.leadP10,
    groupCount: events.groupCount,
    groupRecall: events.groupRecall,
    groupLeadMedian: events.groupLeadMedian,
    groupLeadP10: events.groupLeadP10,
    groups: events.eventGroups,
    coverage: eventCoverage,
    diagnostics: eventDiagnostics,
    details: events.events,
    fpEpisodes: events.fpEpisodes,
    fpPerMin: fpEvaluable ? events.fpPerMin : null,
    fpPerMinRaw: events.fpPerMin,
    fpEvaluable,
    fpNote: fpEvaluable ? null : 'GT 无背景标注或覆盖不足，未匹配报警不能当误报',
    fpTrackIds: fpIds,
    fpAlerts: events.fpAlerts,
  },
  bgStates,
  motionConfusion,
  motionAgreement: motionTotal ? Math.round((motionAgree / motionTotal) * 1000) / 1000 : null,
  motionSamples: motionTotal,
  motionGridBest,
  motionSeriesHeight,
  unmatchedTracks: [...unmatched.values()],
  latencyMs: {
    pipelineP50: pct(proc, 0.5),
    pipelineP95: pct(proc, 0.95),
    detectP50: pct(detect, 0.5),
    detectP95: pct(detect, 0.95),
    speechQueueP50: pct(queue, 0.5),
    speechQueueP95: pct(queue, 0.95),
    e2eP50: pct(e2e, 0.5),
    e2eP95: pct(e2e, 0.95),
    speechCount: speech.length,
  },
}, null, 2));
