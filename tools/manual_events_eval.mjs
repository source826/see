// 人工事件时间点评测：读取 gt/events_manual.json，按 targetId 把语音映射到人工事件，
// 计算提前量、漏报、迟到和未匹配语音。用法：
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
const minLevel = Number(args.minLevel || manual.evaluation?.minLevel || 2);
const fps = Number(gt.fps || 30);
const analysis = live.analysis || { width: 320, height: 180 };
const sx = analysis.width / gt.width;
const sy = analysis.height / gt.height;
const events = (manual.events || []).filter((e) => {
  if (e.gtFile) return norm(e.gtFile) === norm(args.gt);
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
    map.set(pred[p.b].id, gtBoxes[p.a].id);
    let votes = idVotes.get(pred[p.b].id);
    if (!votes) idVotes.set(pred[p.b].id, (votes = new Map()));
    votes.set(gtBoxes[p.a].id, (votes.get(gtBoxes[p.a].id) || 0) + 1);
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
const used = new Set();
const details = [];
for (const e of events) {
  const start = Number(e.startSec ?? 0);
  const wide = Number(e.wideEntrySec);
  const strict = Number(e.strictEntrySec);
  const targetId = Number(e.targetId);
  let best = null;
  for (const a of alerts) {
    if (a.level < minLevel) continue;
    if (a.sec < Math.max(start, wide - leadSec)) continue;
    if (a.sec > wide) continue;
    if (mappedGt(a.frame, a.trackId) !== targetId) continue;
    if (!best || a.sec < best.sec) best = a;
  }
  let late = null;
  if (!best) {
    for (const a of alerts) {
      if (a.level < minLevel) continue;
      if (a.sec <= wide || a.sec > strict) continue;
      if (mappedGt(a.frame, a.trackId) !== targetId) continue;
      if (!late || a.sec < late.sec) late = a;
    }
  }
  if (best) {
    used.add(`${best.frame}:${best.trackId}`);
    details.push({
      targetId,
      startSec: start,
      wideEntrySec: wide,
      strictEntrySec: strict,
      result: 'tp',
      alertSec: Math.round(best.sec * 100) / 100,
      leadVsWideSec: Math.round((wide - best.sec) * 100) / 100,
      leadVsStrictSec: Math.round((strict - best.sec) * 100) / 100,
      trackId: best.trackId,
    });
  } else if (late) {
    used.add(`${late.frame}:${late.trackId}`);
    details.push({
      targetId,
      startSec: start,
      wideEntrySec: wide,
      strictEntrySec: strict,
      result: 'late',
      alertSec: Math.round(late.sec * 100) / 100,
      lateSec: Math.round((late.sec - wide) * 100) / 100,
      trackId: late.trackId,
    });
  } else {
    details.push({ targetId, startSec: start, wideEntrySec: wide, strictEntrySec: strict, result: 'fn' });
  }
}
const unmatched = alerts.filter((a) => {
  if (a.level < minLevel || a.trackId < 0) return false;
  if (used.has(`${a.frame}:${a.trackId}`)) return false;
  const gid = mappedGt(a.frame, a.trackId);
  return gid === undefined || !eventTargets.has(gid);
});
const matchedEventAlerts = alerts.filter(
  (a) => a.level >= minLevel && a.trackId >= 0 && used.has(`${a.frame}:${a.trackId}`)
);
const fpByTrack = new Map();
for (const a of unmatched) {
  const key = a.trackId;
  if (!fpByTrack.has(key)) fpByTrack.set(key, []);
  fpByTrack.get(key).push(a.sec);
}
let fpEpisodes = 0;
for (const list of fpByTrack.values()) {
  list.sort((a, b) => a - b);
  let last = null;
  for (const sec of list) {
    if (last === null || sec - last > 1) fpEpisodes++;
    last = sec;
  }
}
const pct = (arr, q) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor((a.length - 1) * q))] * 1000) / 1000 : null;
};
const leads = details.filter((d) => d.result === 'tp').map((d) => d.leadVsWideSec);
const leadsStrict = details.filter((d) => d.result === 'tp').map((d) => d.leadVsStrictSec);
const summary = {
  events: events.length,
  tp: details.filter((d) => d.result === 'tp').length,
  fn: details.filter((d) => d.result === 'fn').length,
  late: details.filter((d) => d.result === 'late').length,
  recall: events.length ? details.filter((d) => d.result === 'tp').length / events.length : null,
  leadMedian: pct(leads, 0.5),
  leadP10: pct(leads, 0.1),
  leadVsStrictMedian: pct(leadsStrict, 0.5),
  leadVsStrictP10: pct(leadsStrict, 0.1),
  fpEpisodes: events.length ? fpEpisodes : null,
  unmatchedAlerts: events.length ? unmatched.length : null,
  envAlerts: alerts.filter((a) => a.trackId < 0 && a.level >= minLevel).length,
  matchedAlerts: matchedEventAlerts.length,
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
