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
const matchByFrame = {};
const eventFrames = [];
for (const rec of frames) {
  const gtBoxes = gtAt(rec.frame);
  const pred = (rec.perTrack || []).filter((p) => p.confirmed).map((p) => ({ id: p.id, bbox: p.bbox }));
  const pairs = [];
  for (let a = 0; a < gtBoxes.length; a++) {
    for (let b = 0; b < pred.length; b++) {
      const v = iou(gtBoxes[a].bbox, pred[b].bbox);
      if (v >= 0.3) pairs.push({ a, b, v });
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
  }
  matchByFrame[rec.frame] = map;
  eventFrames.push({
    frame: rec.frame,
    gt: gtBoxes,
    alerts: (rec.alerts || []).filter((a) => a.level >= 2),
    corridor: rec.corridor && rec.corridor.wide ? { poly: rec.corridor.wide } : null,
  });
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
}, null, 2));
