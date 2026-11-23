// 比较三种膨胀信号与 GT 三态的一致率：逐帧差分、稳健斜率、框内光流径向膨胀。
// 只做离线对照，不接入报警。用法：
//   node tools/motion_compare.mjs --gt=gt/x.json --base=tmp/replay_x.json --robust=tmp/rob_x.json --video=tmp/vid_x.json
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i > 0 ? [a.slice(2, i), a.slice(i + 1)] : [a.slice(2), 'true'];
  })
);
const rd = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const gt = rd(args.gt);
const base = rd(args.base);
const robust = rd(args.robust);
const video = rd(args.video);
const frameMap = (live) => new Map((live.frames || []).map((f) => [f.frame, f]));
const fmB = frameMap(base);
const fmR = frameMap(robust);
const fmV = frameMap(video);
const fps = gt.fps || 30;
const sx = (base.analysis?.width || 320) / gt.width;
const sy = (base.analysis?.height || 180) / gt.height;
function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
// GT 轨迹首尾各 12 帧标签不稳定，排除。
const ranges = new Map();
for (const [fs, boxes] of Object.entries(gt.frames)) {
  for (const b of boxes) {
    if (!ranges.has(b.id)) ranges.set(b.id, [Number(fs), Number(fs)]);
    const r = ranges.get(b.id);
    r[0] = Math.min(r[0], Number(fs));
    r[1] = Math.max(r[1], Number(fs));
  }
}
const samples = [];
const gtFrames = Object.keys(gt.frames).map(Number).sort((a, b) => a - b);
const nearestGt = (frame) => {
  let best = null;
  let bestD = Infinity;
  for (const f of gtFrames) {
    const d = Math.abs(f - frame);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
    if (f > frame && d > bestD) break;
  }
  return bestD <= 3 ? best : null;
};
for (const frame of [...fmB.keys()].sort((a, b) => a - b)) {
  const bRec = fmB.get(frame);
  const rRec = fmR.get(frame);
  const vRec = fmV.get(frame);
  if (!bRec || !rRec || !vRec) continue;
  const gf = nearestGt(frame);
  if (gf === null) continue;
  for (const b of gt.frames[String(gf)] || []) {
    if (b.motion !== 'approaching' && b.motion !== 'receding' && b.motion !== 'static') continue;
    const gbox = { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy };
    const range = ranges.get(b.id);
    if (range && (frame - range[0] < 12 || range[1] - frame < 12)) continue;
    const best = (rec) => {
      let hit = null;
      let bestIou = 0;
      for (const p of rec.perTrack || []) {
        if (!p.confirmed || p.hits < 5) continue;
        const v = iou(gbox, p.bbox);
        if (v > bestIou) {
          bestIou = v;
          hit = p;
        }
      }
      return bestIou >= 0.2 ? hit : null;
    };
    const pb = best(bRec);
    const pr = best(rRec);
    const pv = best(vRec);
    if (!pb || !pr || !pv) continue;
    if (typeof pb.heightRate !== 'number' || typeof pr.heightRate !== 'number') continue;
    if (typeof pv.flowRadialRate !== 'number' || typeof pv.flowRadialMean !== 'number') continue;
    samples.push({
      gt: b.motion,
      diff: pb.heightRate,
      robust: pr.heightRate,
      flowMedian: pv.flowRadialRate,
      flowMean: pv.flowRadialMean,
    });
  }
}
const state = (v, th) => (v > th ? 'approaching' : v < -th ? 'receding' : 'static');
const agreement = (signal, th) => {
  let ok = 0;
  const conf = {};
  for (const s of samples) {
    const st = state(s[signal], th);
    conf[`${s.gt}->${st}`] = (conf[`${s.gt}->${st}`] || 0) + 1;
    if (st === s.gt) ok++;
  }
  return { agreement: samples.length ? ok / samples.length : null, confusion: conf };
};
const grid = [];
for (let th = 0.01; th <= 0.2001; th += 0.01) {
  grid.push({
    threshold: Math.round(th * 100) / 100,
    diff: agreement('diff', th).agreement,
    robust: agreement('robust', th).agreement,
    flowMedian: agreement('flowMedian', th).agreement,
    flowMean: agreement('flowMean', th).agreement,
  });
}
const best = (key) => {
  const row = grid.reduce((a, b) => (b[key] > a[key] ? b : a), grid[0]);
  return { threshold: row.threshold, agreement: row[key] };
};
const at003 = grid.find((g) => Math.abs(g.threshold - 0.03) < 1e-9) || grid[0];
console.log(
  JSON.stringify(
    {
      gt: args.gt,
      samples: samples.length,
      at003,
      best: Object.fromEntries(
        ['diff', 'robust', 'flowMedian', 'flowMean'].map((k) => [k, { ...best(k), confusion: agreement(k, best(k).threshold).confusion }])
      ),
    },
    null,
    2
  )
);
