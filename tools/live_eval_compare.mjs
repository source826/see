// 同一份实时记录上并列计算旧口径（精确 GT 帧、IoU 0.3、无背景 GT、无 warmup 映射）
// 与新口径（GT 插值、小目标 IoU 0.2、背景 GT 三态、warmup 多数票映射）。
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

function evaluate(mode) {
  const firstGt = Math.min(...Object.keys(gt.frames).map(Number));
  const matchByFrame = {};
  const eventFrames = [];
  const idVotes = new Map();
  for (const rec of frames) {
    let gtBoxes;
    if (mode === 'old') {
      gtBoxes = (gt.frames[String(rec.frame)] || [])
        .filter((b) => b.cls !== 'static' && !b.bg)
        .map((b) => ({ id: b.id, cls: b.cls, bbox: scale(b) }));
    } else {
      gtBoxes = gtAt(rec.frame);
    }
    const pred = (rec.perTrack || []).filter((p) => p.confirmed).map((p) => ({ id: p.id, bbox: p.bbox }));
    const pairs = [];
    for (let a = 0; a < gtBoxes.length; a++) {
      for (let b = 0; b < pred.length; b++) {
        const v = iou(gtBoxes[a].bbox, pred[b].bbox);
        const small = gtBoxes[a].bbox.w * gtBoxes[a].bbox.h < 0.01 * analysis.width * analysis.height;
        const threshold = mode === 'new' && small ? 0.2 : 0.3;
        if (v >= threshold) pairs.push({ a, b, v });
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
      const raw = gtBoxes[p.a].id;
      const mapped = mode === 'new' && gtBoxes[p.a].bg && gt.bgMap && gt.bgMap[String(raw)]
        ? Number(gt.bgMap[String(raw)])
        : raw;
      map.set(pred[p.b].id, mapped);
      if (mode === 'new') {
        let votes = idVotes.get(pred[p.b].id);
        if (!votes) {
          votes = new Map();
          idVotes.set(pred[p.b].id, votes);
        }
        votes.set(mapped, (votes.get(mapped) || 0) + 1);
      }
    }
    matchByFrame[rec.frame] = map;
    eventFrames.push({
      frame: rec.frame,
      gt: gtBoxes,
      alerts: (rec.alerts || []).filter((a) => a.level >= 2),
      corridor: rec.corridor && rec.corridor.wide ? { poly: rec.corridor.wide } : null,
    });
  }
  if (mode === 'new') {
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
    for (const rec of frames) if (rec.frame < firstGt) matchByFrame[rec.frame] = idMap;
  }
  const ev = evaluateAlarmEvents({
    frames: eventFrames,
    matchByFrame,
    fps: 30,
    leadSec: 3,
    minLevel: 2,
    durationSec: live.duration,
  });
  return {
    recall: ev.eventRecall,
    tp: ev.tpEvents,
    fn: ev.fnEvents,
    leadMedian: ev.leadMedian,
    leadP10: ev.leadP10,
    fpEpisodes: ev.fpEpisodes,
    fpPerMin: ev.fpPerMin,
    states: ev.alertStates,
  };
}

console.log(JSON.stringify({ live: livePath, gt: gtPath, old: evaluate('old'), new: evaluate('new') }, null, 2));
