// 汇总浏览器实时记录的检测延迟、端到端帧率、语音延迟。
// 用法：node tools/browser_bench.mjs --live=tmp/x.json [--label=480-wasm]
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i > 0 ? [a.slice(2, i), a.slice(i + 1)] : [a.slice(2), 'true'];
  })
);
const j = JSON.parse(readFileSync(args.live, 'utf8').replace(/^\uFEFF/, ''));
const frames = [...(j.frames || [])].sort((a, b) => a.frame - b.frame);
const pct = (arr, q) => {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor((a.length - 1) * q))] * 10) / 10 : null;
};
const detect = frames.map((f) => f.detectMs).filter(Number.isFinite);
const proc = frames.map((f) => f.procMs).filter(Number.isFinite);
const e2e = (j.speech || []).map((s) => {
  const f = frames.find((x) => x.frame === s.frame);
  return (f ? f.procMs || 0 : 0) + (s.queueMs || 0);
});
const summary = {
  label: args.label || args.live,
  status: j.status,
  duration: j.duration,
  processedFrames: frames.length,
  fps: Math.round((frames.length / j.duration) * 10) / 10,
  detectP50: pct(detect, 0.5),
  detectP95: pct(detect, 0.95),
  procP50: pct(proc, 0.5),
  procP95: pct(proc, 0.95),
  speechCount: (j.speech || []).length,
  e2eP50: pct(e2e, 0.5),
  e2eP95: pct(e2e, 0.95),
  below8fps: frames.length / j.duration < 8,
};
console.log(JSON.stringify(summary, null, 2));
