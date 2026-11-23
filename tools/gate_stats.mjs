// 逐门阻塞统计：对每个事件目标，记录从进通道到语音之间每道闸门首次满足的帧，
// 找出 level2 之前最后满足的那道门（真正的卡点），并统计 level2 后为何没播。
// 用法：
//   node tools/gate_stats.mjs --live=tmp/replay_tunnel.json --report=tmp/replay_tunnel_report.json --gt=gt/tunnel_backlight_full.json
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i > 0 ? [a.slice(2, i), a.slice(i + 1)] : [a.slice(2), 'true'];
  }),
);
if (!args.live || !args.report || !args.gt) {
  console.error('用法: node tools/gate_stats.mjs --live=<回放.json> --report=<报告.json> --gt=<gt.json> [--fps=30]');
  process.exit(1);
}
const rd = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const live = rd(args.live);
const report = rd(args.report);
const gt = rd(args.gt);
const fps = Number(args.fps || gt.fps || 30);
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
function matchFrame(gtBoxes, pred) {
  const pairs = [];
  for (let a = 0; a < gtBoxes.length; a++) {
    for (let b = 0; b < pred.length; b++) {
      const v = iou(gtBoxes[a].bbox, pred[b].bbox);
      const small = gtBoxes[a].bbox.w * gtBoxes[a].bbox.h < 0.01 * analysis.width * analysis.height;
      if (v >= (small ? 0.2 : 0.3)) pairs.push({ a, b, v, small });
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
    const rawId = gtBoxes[p.a].id;
    const mappedId = gtBoxes[p.a].bg && gt.bgMap && gt.bgMap[String(rawId)]
      ? Number(gt.bgMap[String(rawId)])
      : rawId;
    map.set(pred[p.b].id, mappedId);
  }
  return map;
}
const matchByFrame = new Map();
for (const rec of frames) {
  const pred = (rec.perTrack || []).filter((p) => p.confirmed).map((p) => ({ id: p.id, bbox: p.bbox }));
  matchByFrame.set(rec.frame, matchFrame(gtAt(rec.frame), pred));
}
const spokenByFrame = new Map();
for (const a of live.alerts || []) {
  if (!spokenByFrame.has(a.frame)) spokenByFrame.set(a.frame, []);
  spokenByFrame.get(a.frame).push(a.trackId);
}
const firstWhere = (gtId, test) => {
  for (const rec of frames) {
    const predId = [...(matchByFrame.get(rec.frame) || new Map())].find(([, gid]) => gid === gtId)?.[0];
    if (predId === undefined) continue;
    const p = (rec.perTrack || []).find((x) => x.id === predId);
    if (p && test(p, rec)) return { frame: rec.frame, predId, p };
  }
  return null;
};
const out = [];
for (const d of report.events?.diagnostics || []) {
  const gtId = d.gtId;
  const entry = d.entryFrame;
  const strict = firstWhere(gtId, (p) => p.inStrict);
  const wide = firstWhere(gtId, (p) => p.inWide || p.inPath);
  const dist5 = firstWhere(gtId, (p) => p.distance !== null && p.distance <= 5);
  const dist12 = firstWhere(gtId, (p) => p.distance !== null && p.distance <= 12);
  const hits8 = firstWhere(gtId, (p) => p.hits >= 8);
  const height3 = firstWhere(gtId, (p) => typeof p.heightRate === 'number' && p.heightRate > 0.03);
  const approach = firstWhere(gtId, (p) => p.approaching);
  const crowdApproach = firstWhere(gtId, (p) => p.crowdApproach);
  const looming = firstWhere(gtId, (p) => p.loomingInPath);
  const l2 = firstWhere(gtId, (p) => p.level >= 2);
  const spoken = firstWhere(gtId, (p, rec) => (spokenByFrame.get(rec.frame) || []).includes(p.id));
  const triggerP = l2 ? l2.p : null;
  const trigger = !triggerP
    ? null
    : triggerP.crowdApproach
      ? 'crowdApproach'
      : triggerP.loomingInPath
        ? 'loomingInPath'
        : triggerP.crossing
          ? 'crossing'
          : triggerP.approaching
            ? 'approaching'
            : 'other';
  const required =
    trigger === 'crowdApproach'
      ? [['strict', strict], ['dist5', dist5], ['hits8', hits8], ['height3', height3]]
      : trigger === 'loomingInPath'
        ? [['strict', strict], ['dist12', dist12], ['hits8', hits8], ['height3', height3]]
        : trigger === 'approaching'
          ? [['strict', strict], ['dist5', dist5], ['approach', approach]]
          : [['wide', wide], ['approach', approach]];
  const satisfied = l2 ? required.filter(([, v]) => v !== null) : [];
  const binding = l2
    ? satisfied.sort((a, b) => b[1].frame - a[1].frame)[0]?.[0] ?? 'none'
    : 'no-level2';
  // level2 后到语音前，逐帧诊断谁挡住了播报。
  const block = { primaryOther: 0, notStrict: 0, cooldown: 0, level2Frames: 0 };
  if (l2) {
    for (const rec of frames) {
      if (rec.frame < l2.frame) continue;
      const predId = [...(matchByFrame.get(rec.frame) || new Map())].find(([, gid]) => gid === gtId)?.[0];
      if (predId === undefined) continue;
      const p = (rec.perTrack || []).find((x) => x.id === predId);
      if (!p || p.level < 2) continue;
      block.level2Frames++;
      if ((spokenByFrame.get(rec.frame) || []).includes(predId)) continue;
      if (rec.primaryId !== null && rec.primaryId !== undefined && rec.primaryId !== predId) block.primaryOther++;
      else if (!p.inStrict) block.notStrict++;
      else block.cooldown++;
    }
  }
  const sec = (v) => (v === null ? null : Math.round(((v.frame - entry) / fps) * 100) / 100);
  out.push({
    gtId,
    entryFrame: entry,
    frames: {
      strict: strict?.frame ?? null,
      wide: wide?.frame ?? null,
      dist5: dist5?.frame ?? null,
      dist12: dist12?.frame ?? null,
      hits8: hits8?.frame ?? null,
      height3: height3?.frame ?? null,
      approaching: approach?.frame ?? null,
      crowdApproach: crowdApproach?.frame ?? null,
      loomingInPath: looming?.frame ?? null,
      level2: l2?.frame ?? null,
      spoken: spoken?.frame ?? null,
    },
    secondsFromEntry: {
      strict: sec(strict),
      wide: sec(wide),
      dist5: sec(dist5),
      dist12: sec(dist12),
      hits8: sec(hits8),
      height3: sec(height3),
      approaching: sec(approach),
      level2: sec(l2),
      spoken: sec(spoken),
    },
    trigger,
    bindingGate: binding,
    speechBlock: block,
  });
}
const gateCounts = {};
for (const r of out) gateCounts[r.bindingGate] = (gateCounts[r.bindingGate] || 0) + 1;
console.log(JSON.stringify({ live: args.live, gt: args.gt, fps, events: out, gateCounts }, null, 2));
