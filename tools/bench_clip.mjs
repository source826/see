// 离线批量体检：用 ffmpeg 只做“视频解码/缩放”，算法仍然是同一套手写管线。
// 逐帧保存中间结果到 JSONL，并输出汇总 JSON，便于调参前后对比。
// 用法：node tools/bench_clip.mjs <video> [--fps=30] [--width=320] [--maxSec=40] [--outdir=bench]
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GuidePipeline } from '../src/app/pipeline.js';

const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith('--'));
if (!video) {
  console.error('用法: node tools/bench_clip.mjs <video> [--fps=30] [--width=320] [--maxSec=40] [--outdir=bench]');
  process.exit(1);
}
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
// 单参数实验：--opt=ransacThreshold:1.2 可重复
const overrides = {};
for (const a of args.filter((x) => x.startsWith('--opt='))) {
  const pair = a.slice(6);
  const idx = pair.indexOf(':');
  if (idx < 0) continue;
  const k = pair.slice(0, idx);
  const raw = pair.slice(idx + 1);
  overrides[k] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
}
const fps = Number(flag('fps', 30));
const aw = Number(flag('width', 320));
const maxSec = Number(flag('maxSec', 40));
const outdir = flag('outdir', 'bench');
mkdirSync(outdir, { recursive: true });

const probe = spawnSync('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', video,
], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error('ffprobe 失败:', probe.stderr);
  process.exit(1);
}
const [vw, vh] = probe.stdout.trim().split('x').map(Number);
const ah = Math.max(2, Math.round((vh * aw) / vw / 2) * 2);
const frameBytes = aw * ah * 4;
const baseName = basename(video).replace(/\.[^.]+$/, '');
const suffix = Object.entries(overrides).map(([k, v]) => `${k}-${v}`).join('_');
const name = suffix ? `${baseName}__${suffix}` : baseName;
const jsonlPath = join(outdir, `${name}.jsonl`);
const summaryPath = join(outdir, `${name}.json`);
const out = createWriteStream(jsonlPath);

const pipeline = new GuidePipeline({ fps, fbCheck: true, ...overrides });
const stats = {
  frames: 0,
  used: 0,
  valid: 0,
  bgRatioSum: 0,
  bgFrames: 0,
  degraded: 0,
  layerSum: 0,
  objectSum: 0,
  trackSum: 0,
  alertFrames: 0,
  episodes: 0,
  framesWithObjects: 0,
  maxObjects: 0,
  totalMs: [],
};
let lastAlertFrame = -Infinity;
const gapFrames = Math.max(1, Math.round(0.8 * fps));

const ff = spawn('ffmpeg', [
  '-v', 'error', '-t', String(maxSec), '-i', video,
  '-vf', `scale=${aw}:${ah},fps=${fps}`,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let parts = [];
let available = 0;
let frameIndex = 0;

ff.stdout.on('data', (chunk) => {
  parts.push(chunk);
  available += chunk.length;
  while (available >= frameBytes) {
    const all = Buffer.concat(parts, available);
    const frame = all.subarray(0, frameBytes);
    const rest = all.subarray(frameBytes);
    parts = rest.length ? [rest] : [];
    available = rest.length;
    consume(frame, frameIndex++);
  }
});

function consume(frame, idx) {
  const res = pipeline.process({ width: aw, height: ah, data: frame }, idx);
  const r = res.risk;
  const alerts = r ? r.alerts : [];
  const maxLevel = alerts.reduce((m, a) => Math.max(m, a.level), 0);
  const bgRatio = res.seg ? res.seg.stats.bgInlierRatio : 0;

  stats.frames++;
  stats.used += res.flowStats.used;
  stats.valid += res.flowStats.valid;
  if (res.seg) {
    stats.bgRatioSum += bgRatio;
    stats.bgFrames++;
    stats.layerSum += res.seg.layers.length;
    stats.objectSum += res.seg.objects.length;
    stats.framesWithObjects += res.seg.objects.length > 0 ? 1 : 0;
    stats.maxObjects = Math.max(stats.maxObjects, res.seg.objects.length);
  }
  stats.trackSum += res.tracks.length;
  stats.totalMs.push(res.timings.total);
  if (r && r.degraded) stats.degraded++;
  if (maxLevel >= 2) {
    stats.alertFrames++;
    if (idx - lastAlertFrame > gapFrames) stats.episodes++;
    lastAlertFrame = idx;
  }

  out.write(JSON.stringify({
    f: idx,
    ms: Math.round(res.timings.total * 100) / 100,
    flow: { used: res.flowStats.used, valid: res.flowStats.valid },
    bg: res.seg ? {
      inliers: res.seg.stats.bgInliers,
      ratio: Math.round(bgRatio * 1000) / 1000,
      residual: Math.round(res.seg.stats.bgResidualMean * 100) / 100,
    } : null,
    layers: res.seg ? res.seg.layers.length : 0,
    suppressed: res.seg ? res.seg.stats.suppressedLayers ?? 0 : 0,
    objects: res.seg ? res.seg.objects.length : 0,
    tracks: res.tracks.length,
    level: maxLevel,
    degraded: Boolean(r && r.degraded),
    fos: res.foe ? [Math.round(res.foe.x), Math.round(res.foe.y)] : null,
  }) + '\n');
}

ff.stderr.on('data', (d) => {
  const text = d.toString().trim();
  if (text) console.error('[ffmpeg]', text);
});

ff.on('close', (code) => {
  out.end();
  const durationSec = stats.frames / fps;
  const sorted = [...stats.totalMs].sort((a, b) => a - b);
  const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q))] : 0);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const summary = {
    clip: baseName,
    variant: suffix || 'baseline',
    options: overrides,
    path: video,
    group: video.includes('holdout') ? 'holdout' : video.includes('tune') ? 'tune' : 'other',
    fps,
    analysis: `${aw}x${ah}`,
    frames: stats.frames,
    durationSec: Math.round(durationSec * 10) / 10,
    ffmpegExit: code,
    validRatio: stats.used ? Math.round((stats.valid / stats.used) * 1000) / 1000 : 0,
    bgInlierRatio: stats.bgFrames ? Math.round((stats.bgRatioSum / stats.bgFrames) * 1000) / 1000 : 0,
    degradedRatio: stats.frames ? Math.round((stats.degraded / stats.frames) * 1000) / 1000 : 0,
    avgLayers: stats.frames ? Math.round((stats.layerSum / stats.frames) * 100) / 100 : 0,
    avgObjects: stats.frames ? Math.round((stats.objectSum / stats.frames) * 100) / 100 : 0,
    framesWithObjects: stats.framesWithObjects,
    framesWithObjectsRatio: stats.frames ? Math.round((stats.framesWithObjects / stats.frames) * 1000) / 1000 : 0,
    maxObjects: stats.maxObjects,
    avgTracks: stats.frames ? Math.round((stats.trackSum / stats.frames) * 100) / 100 : 0,
    alertFrames: stats.alertFrames,
    alarmEpisodes: stats.episodes,
    alarmPerMin: durationSec > 0 ? Math.round((stats.episodes / (durationSec / 60)) * 100) / 100 : 0,
    msMean: Math.round(mean(stats.totalMs) * 100) / 100,
    msP95: Math.round(pct(0.95) * 100) / 100,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (code !== 0 && stats.frames === 0) process.exitCode = 1;
});
