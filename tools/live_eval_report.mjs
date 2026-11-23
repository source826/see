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
    alerts: (rec.alerts || []).filter((a) => a.level >= 2),
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
  fps: 30,
  leadSec: 3,
  minLevel: 2,
  durationSec: live.duration,
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
const unmatched = new Map();
for (const rec of frames) {
  for (const a of rec.alerts || []) {
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
    details: events.events,
    fpEpisodes: events.fpEpisodes,
    fpPerMin: events.fpPerMin,
    fpTrackIds: fpIds,
  },
  bgStates,
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
