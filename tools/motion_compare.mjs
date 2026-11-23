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
const allowMissingFlow = args.allowMissingFlow === '1';
const robustPost = args.robustPost === '1';
const wantDetail = args.detail === '1';
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
const robustWindowSec = 1.5;
const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
// 事后计算稳健斜率：用 video 回放里同一 track 的确认框高历史，最近 1.5 s 的
// 所有点对斜率中位数。用于含小目标时无法重跑已归档 robust 回放的情况。
const historyByTrack = new Map();
for (const rec of video.frames || []) {
  for (const p of rec.perTrack || []) {
    if (!p.confirmed) continue;
    if (!historyByTrack.has(p.id)) historyByTrack.set(p.id, []);
    historyByTrack.get(p.id).push({ frame: rec.frame, h: p.bbox.h });
  }
}
for (const list of historyByTrack.values()) list.sort((a, b) => a.frame - b.frame);
function robustSlopeAt(trackId, frame) {
  const list = historyByTrack.get(trackId) || [];
  const pts = list
    .filter((p) => p.frame <= frame && p.frame >= frame - robustWindowSec * fps)
    .map((p) => [p.frame / fps, Math.log(Math.max(1, p.h))]);
  const slopes = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dt = pts[j][0] - pts[i][0];
      if (dt > 1e-4) slopes.push((pts[j][1] - pts[i][1]) / dt);
    }
  }
  return median(slopes);
}
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
    const flowOk =
      typeof pv.flowRadialRate === 'number' && typeof pv.flowRadialMean === 'number';
    if (!flowOk && !allowMissingFlow) continue;
    samples.push({
      gt: b.motion,
      frame,
      gtId: b.id,
      hAt320: gbox.h,
      diff: pb.heightRate,
      robust: robustPost ? robustSlopeAt(pv.id, frame) : pr.heightRate,
      flowMedian: flowOk ? pv.flowRadialRate : null,
      flowMean: flowOk ? pv.flowRadialMean : null,
      flowPoints: pv.flowRadialPoints ?? 0,
    });
  }
}
const state = (v, th) => (v > th ? 'approaching' : v < -th ? 'receding' : 'static');
const agreement = (signal, th) => {
  let ok = 0;
  let n = 0;
  const conf = {};
  for (const s of samples) {
    if (typeof s[signal] !== 'number' || !Number.isFinite(s[signal])) continue;
    n++;
    const st = state(s[signal], th);
    conf[`${s.gt}->${st}`] = (conf[`${s.gt}->${st}`] || 0) + 1;
    if (st === s.gt) ok++;
  }
  return { agreement: n ? ok / n : null, n, confusion: conf };
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
  const rows = grid.filter((g) => typeof g[key] === 'number');
  if (!rows.length) return { threshold: null, agreement: null };
  const row = rows.reduce((a, b) => (b[key] > a[key] ? b : a), rows[0]);
  return { threshold: row.threshold, agreement: row[key] };
};
const at003 = grid.find((g) => Math.abs(g.threshold - 0.03) < 1e-9) || grid[0];
const counts = Object.fromEntries(
  ['diff', 'robust', 'flowMedian', 'flowMean'].map((k) => [k, agreement(k, 0.03).n])
);
console.log(
  JSON.stringify(
    {
      gt: args.gt,
      samples: samples.length,
      smallSamples: samples.filter((s) => s.hAt320 < 18).length,
      at003,
      counts,
      best: Object.fromEntries(
        ['diff', 'robust', 'flowMedian', 'flowMean'].map((k) => [
          k,
          { ...best(k), confusion: best(k).threshold === null ? {} : agreement(k, best(k).threshold).confusion },
        ])
      ),
      ...(wantDetail ? { samplesDetail: samples } : {}),
    },
    null,
    2
  )
);
