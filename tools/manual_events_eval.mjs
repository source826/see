// 人工事件时间点评测：读取 gt/events_manual.json，按 targetId 把语音映射到人工事件。
// 同时计算旧口径（wideEntrySec 前 5 s）和新口径（dangerSec 前 1.5–5.0 s）。
// 用法：
//   node tools/manual_events_eval.mjs --live=tmp/x.json --gt=gt/x_full.json [--events=gt/events_manual.json] [--out=...]
import { readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i > 0 ? [a.slice(2, i), a.slice(i + 1)] : [a.slice(2), 'true'];
  })
);
if (!args.live || !args.gt) {
  console.error('用法: node tools/manual_events_eval.mjs --live=<记录.json> --gt=<GT.json> [--events=gt/events_manual.json] [--out=...]');
  process.exit(1);
}
const rd = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const norm = (p) => String(p || '').replace(/\\/g, '/');
const live = rd(args.live);
const gt = rd(args.gt);
const manual = rd(args.events || 'gt/events_manual.json');
const leadSec = Number(args.leadSec || manual.evaluation?.leadSec || 5);
const minLeadSec = Number(args.minLeadSec || manual.evaluation?.minLeadSec || 1.5);
const minLevel = Number(args.minLevel || manual.evaluation?.minLevel || 2);
const fps = Number(gt.fps || 30);
const analysis = live.analysis || { width: 320, height: 180 };
const sx = analysis.width / gt.width;
const sy = analysis.height / gt.height;
const events = (manual.events || []).filter((e) => {
  if (e.gtFile && norm(e.gtFile) !== norm(args.gt)) return false;
  if (e.record && norm(e.record) !== norm(args.live)) return false;
  if (e.run && args.run && e.run !== args.run) return false;
  return true;
});

function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
const scale = (b) => ({ x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy });
const tracks = new Map();
for (const [fs, boxes] of Object.entries(gt.frames || {})) {
  for (const b of boxes) {
    if (!tracks.has(b.id)) tracks.set(b.id, []);
    tracks.get(b.id).push({ frame: Number(fs), bbox: scale(b), bg: Boolean(b.bg) });
  }
}
for (const list of tracks.values()) list.sort((a, b) => a.frame - b.frame);
function gtAtAll(frame) {
  const out = [];
  for (const [id, list] of tracks) {
    if (frame < list[0].frame || frame > list[list.length - 1].frame) continue;
    let i = 0;
    while (i + 1 < list.length && list[i + 1].frame < frame) i++;
    const a = list[i];
    const b = list[Math.min(i + 1, list.length - 1)];
    const span = Math.max(1, b.frame - a.frame);
    const k = Math.min(1, Math.max(0, (frame - a.frame) / span));
    out.push({
      id,
      bg: a.bg || b.bg,
      bbox: {
        x: a.bbox.x + (b.bbox.x - a.bbox.x) * k,
        y: a.bbox.y + (b.bbox.y - a.bbox.y) * k,
        w: a.bbox.w + (b.bbox.w - a.bbox.w) * k,
        h: a.bbox.h + (b.bbox.h - a.bbox.h) * k,
      },
    });
  }
  return out;
}
const frames = [...(live.frames || [])].sort((a, b) => a.frame - b.frame);
const alerts = Array.isArray(live.alerts)
  ? live.alerts.map((a) => ({ ...a, sec: a.sec ?? a.time ?? a.frame / fps }))
  : frames.flatMap((rec) =>
      (rec.alerts || [])
        .filter((a) => a.level >= minLevel)
        .map((a) => ({ frame: rec.frame, sec: rec.frame / fps, level: a.level, trackId: a.trackId }))
    );
const matchByFrame = new Map();
const idVotes = new Map();
for (const rec of frames) {
  const gtBoxes = gtAtAll(rec.frame);
  const pred = (rec.perTrack || []).filter((p) => p.confirmed);
  const pairs = [];
  for (let a = 0; a < gtBoxes.length; a++) {
    for (let b = 0; b < pred.length; b++) {
      const v = iou(gtBoxes[a].bbox, pred[b].bbox);
      const small = gtBoxes[a].bbox.w * gtBoxes[a].bbox.h < 0.01 * analysis.width * analysis.height;
      if (v >= (small ? 0.2 : 0.3)) pairs.push({ a, b, v });
    }
  }
  pairs.sort((p, q) => q.v - p.v);
  const usedA = new Uint8Array(gtBoxes.length);
  const usedB = new Uint8Array(pred.length);
  const map = new Map();
  for (const p of pairs) {
    if (usedA[p.a] || usedB[p.b]) continue;
    usedA[p.a] = 1;
    usedB[p.b] = 1;
    // 背景重复框通过 bgMap 归到事件 id；否则报警会被映射到背景 id，TP 判不出来。
    const rawId = gtBoxes[p.a].id;
    const mappedId =
      gtBoxes[p.a].bg && gt.bgMap && gt.bgMap[String(rawId)]
        ? Number(gt.bgMap[String(rawId)])
        : rawId;
    map.set(pred[p.b].id, mappedId);
    let votes = idVotes.get(pred[p.b].id);
    if (!votes) idVotes.set(pred[p.b].id, (votes = new Map()));
    votes.set(mappedId, (votes.get(mappedId) || 0) + 1);
  }
  matchByFrame.set(rec.frame, map);
}
const idMap = new Map();
for (const [trackId, votes] of idVotes) {
  let bestId = null;
  let best = -1;
  for (const [gtId, n] of votes) if (n > best) { best = n; bestId = gtId; }
  idMap.set(trackId, bestId);
}
const mappedGt = (frame, trackId) => {
  const m = matchByFrame.get(frame);
  const direct = m ? m.get(trackId) : undefined;
  return direct !== undefined ? direct : idMap.get(trackId);
};
const eventTargets = new Set(events.map((e) => Number(e.targetId)));
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;
const pct = (arr, q) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor((a.length - 1) * q))] * 1000) / 1000 : null;
};
const episodesOf = (list) => {
  const byTrack = new Map();
  for (const a of list) {
    if (!byTrack.has(a.trackId)) byTrack.set(a.trackId, []);
    byTrack.get(a.trackId).push(a.sec);
  }
  let episodes = 0;
  for (const secs of byTrack.values()) {
    secs.sort((a, b) => a - b);
    let last = null;
    for (const sec of secs) {
      if (last === null || sec - last > 1) episodes++;
      last = sec;
    }
  }
  return episodes;
};

// 旧口径：wideEntrySec 前 5 s 内的首条语音。新口径：dangerSec 前 1.5–5.0 s 内。
function evaluateCriterion(e, criterion) {
  const targetId = Number(e.targetId);
  const start = Number(e.startSec ?? 0);
  const wide = Number(e.wideEntrySec);
  const strict = numOrNull(e.strictEntrySec);
  const danger = numOrNull(e.dangerSec);
  let deadline;
  let winStart;
  let winEnd;
  if (criterion === 'old') {
    deadline = wide;
    winStart = Math.max(start, wide - leadSec);
    winEnd = wide;
  } else {
    if (!Number.isFinite(danger)) return { result: 'missing_danger' };
    deadline = danger;
    winStart = danger - leadSec;
    winEnd = danger - minLeadSec;
  }
  let best = null;
  for (const a of alerts) {
    if (a.level < minLevel) continue;
    if (a.sec < winStart - 1e-6 || a.sec > winEnd + 1e-6) continue;
    if (mappedGt(a.frame, a.trackId) !== targetId) continue;
    if (!best || a.sec < best.sec) best = a;
  }
  if (best) {
    return {
      result: 'tp',
      alertSec: round2(best.sec),
      leadSec: round2(deadline - best.sec),
      trackId: best.trackId,
      key: `${best.frame}:${best.trackId}`,
    };
  }
  // 迟到：旧口径 wide→strict；新口径 danger-1.5→danger。
  const lateStart = criterion === 'old' ? wide : danger - minLeadSec;
  const lateEnd = criterion === 'old' ? (Number.isFinite(strict) ? strict : wide + 1) : danger;
  let late = null;
  for (const a of alerts) {
    if (a.level < minLevel) continue;
    if (a.sec <= lateStart || a.sec > lateEnd) continue;
    if (mappedGt(a.frame, a.trackId) !== targetId) continue;
    if (!late || a.sec < late.sec) late = a;
  }
  if (late) {
    return {
      result: 'late',
      alertSec: round2(late.sec),
      lateSec: round2(late.sec - lateStart),
      trackId: late.trackId,
      key: `${late.frame}:${late.trackId}`,
    };
  }
  return { result: 'fn' };
}

const details = [];
const seenDanger = new Set();
for (const e of events) {
  const danger = numOrNull(e.dangerSec);
  const dangerKey = e.dangerKey || (Number.isFinite(danger) ? `${e.targetId}|${danger}` : null);
  let newResult;
  if (!Number.isFinite(danger)) {
    newResult = { result: 'missing_danger' };
  } else if (dangerKey && seenDanger.has(dangerKey)) {
    // 同一目标的多次宽通道重入共享同一个危险时刻，新口径只计一次。
    newResult = { result: 'duplicate' };
  } else {
    newResult = evaluateCriterion(e, 'new');
    if (dangerKey) seenDanger.add(dangerKey);
  }
  details.push({
    targetId: Number(e.targetId),
    startSec: Number(e.startSec ?? 0),
    wideEntrySec: Number(e.wideEntrySec),
    strictEntrySec: numOrNull(e.strictEntrySec),
    dangerSec: danger,
    dangerDistanceM: numOrNull(e.dangerDistanceM),
    dangerKey,
    old: evaluateCriterion(e, 'old'),
    new: newResult,
  });
}

// 与 live_eval_report 一致：只有完全没映射到 GT 的语音才算未匹配 FP；
// 映射到背景 GT 的语音是真实背景目标，不算 FP。
const unmatched = alerts.filter((a) => {
  if (a.level < minLevel || a.trackId < 0) return false;
  return mappedGt(a.frame, a.trackId) === undefined;
});
const durationSec = Number(live.duration) || null;
const perMin = (n) => (durationSec ? Math.round((n / (durationSec / 60)) * 1000) / 1000 : null);
const summarize = (criterion) => {
  const rows = details.filter((d) => d[criterion] && d[criterion].result);
  const missing = rows.filter((d) => d[criterion].result === 'missing_danger').length;
  const duplicates = rows.filter((d) => d[criterion].result === 'duplicate').length;
  const evaluable = rows.length - missing - duplicates;
  const tps = rows.filter((d) => d[criterion].result === 'tp');
  const late = rows.filter((d) => d[criterion].result === 'late');
  const fn = rows.filter((d) => d[criterion].result === 'fn');
  const handled = new Set(
    rows
      .filter((d) => d[criterion].result === 'tp' || d[criterion].result === 'late')
      .map((d) => d[criterion].key)
  );
  const outside = alerts.filter(
    (a) =>
      a.level >= minLevel &&
      a.trackId >= 0 &&
      eventTargets.has(mappedGt(a.frame, a.trackId)) &&
      !handled.has(`${a.frame}:${a.trackId}`)
  );
  const leads = tps.map((d) => d[criterion].leadSec);
  const unmatchedEpisodes = episodesOf(unmatched);
  const outsideEpisodes = episodesOf(outside);
  return {
    evaluable,
    missingDanger: missing,
    duplicates,
    tp: tps.length,
    fn: fn.length,
    late: late.length,
    recall: evaluable ? Math.round((tps.length / evaluable) * 1000) / 1000 : null,
    leadMedian: pct(leads, 0.5),
    leadP10: pct(leads, 0.1),
    fpEpisodes: events.length ? unmatchedEpisodes : null,
    fpPerMin: events.length ? perMin(unmatchedEpisodes) : null,
    outsideWindowAlerts: events.length ? outside.length : null,
    outsideWindowPerMin: events.length ? perMin(outsideEpisodes) : null,
    notTpEpisodes: events.length ? unmatchedEpisodes + outsideEpisodes : null,
    notTpPerMin: events.length ? perMin(unmatchedEpisodes + outsideEpisodes) : null,
  };
};
const summary = {
  events: events.length,
  durationSec,
  leadSec,
  minLeadSec,
  old: summarize('old'),
  new: summarize('new'),
  unmatchedAlerts: events.length ? unmatched.length : null,
  envAlerts: alerts.filter((a) => a.trackId < 0 && a.level >= minLevel).length,
};
const out = {
  status: events.length ? 'ok' : 'awaiting_user_data',
  live: args.live,
  gt: args.gt,
  eventsFile: args.events || 'gt/events_manual.json',
  summary,
  details,
};
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(out, null, 2));
