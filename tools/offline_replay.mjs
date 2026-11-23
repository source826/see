// 离线回放：读取实时记录里的逐帧检测框，重放同一套管线与播报规则。
// 不重新跑 YOLO、不依赖浏览器时钟，用于把规则差异和检测/播放采样噪声分开。
// 用法：
//   node tools/offline_replay.mjs --live=tmp/unseen_tunnel.json --out=tmp/replay_tunnel.json
//   node tools/offline_replay.mjs --live=... --out=... --opt=crowdApproachMaxDist:8
import { readFileSync, writeFileSync } from 'node:fs';
import { GuidePipeline } from '../src/app/pipeline.js';
import { classifyAnnouncement, SpeechAnnouncer } from '../src/app/announce.js';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i > 0 ? [a.slice(2, i), a.slice(i + 1)] : [a.slice(2), 'true'];
  }),
);
if (!args.live || !args.out) {
  console.error('用法: node tools/offline_replay.mjs --live=<记录.json> --out=<回放.json> [--fps=30] [--opt=key:value]');
  process.exit(1);
}
const overrides = {};
for (const a of process.argv.slice(2).filter((x) => x.startsWith('--opt='))) {
  const pair = a.slice(6);
  const idx = pair.indexOf(':');
  if (idx < 0) continue;
  const k = pair.slice(0, idx);
  const raw = pair.slice(idx + 1);
  const num = Number(raw);
  overrides[k] =
    raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(num) && raw.trim() !== '' ? num : raw;
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const live = readJson(args.live);
const fps = Number(args.fps || 30);
const width = live.analysis?.width || 320;
const height = live.analysis?.height || 180;
const frames = [...(live.frames || [])].sort((a, b) => a.frame - b.frame);
const pipeline = new GuidePipeline({
  yoloDetect: true,
  fps,
  // 与实时页 state.pipeline 的默认值一致；否则距离口径不同，人群/逼近规则会对不上。
  // 实时页 initDistanceOptions 在 URL 没有 pitch 参数时会把俯角设成 0（Number(null)=0），
  // 不是构造函数的 10°；这里必须跟着实时路径，否则地面估距会偏。
  cameraHeight: 1.5,
  horizonRatio: 0.5,
  cameraPitchDeg: 0,
  distanceMode: 'ground',
  ...overrides,
});
const announcer = new SpeechAnnouncer();
const alerts = [];
const outFrames = [];

function processFrame(rec, imageData) {
  const dt = rec.dt || 1 / fps;
  const res = pipeline.process(imageData, rec.frame, { detections: rec.detections || [], dt });
  const risk = res.risk;
  const cand = classifyAnnouncement(risk);
  if (cand && announcer.shouldSpeak(cand, (rec.frame / fps) * 1000)) {
    alerts.push({
      frame: rec.frame,
      time: Math.round((rec.frame / fps) * 1000) / 1000,
      kind: cand.kind,
      level: cand.level,
      trackId: cand.trackId,
      text: cand.text,
    });
  }
  outFrames.push({
    frame: rec.frame,
    dt,
    procMs: 0,
    detections: rec.detections || [],
    alerts: risk ? risk.alerts.map((a) => ({ level: a.level, trackId: a.trackId })) : [],
    primaryId: risk && risk.primaryId !== undefined ? risk.primaryId : null,
    sceneMode: risk && risk.sceneMode ? risk.sceneMode : null,
    perTrack: risk
      ? risk.perTrack.map((p) => ({
          id: p.id,
          cls: p.cls,
          className: p.className,
          score: p.score,
          hits: p.hits,
          level: p.level,
          confirmed: p.confirmed,
          inPath: p.inPath,
          inStrict: p.inStrict,
          inWide: p.inWide,
          predictedInPath: p.predictedInPath,
          areaRatio: typeof p.areaRatio === 'number' ? Math.round(p.areaRatio * 10000) / 10000 : null,
          approaching: p.approaching,
          crowdApproach: p.crowdApproach,
          loomingInPath: p.loomingInPath,
          crossing: Boolean(p.crossing),
          motionState: p.motionState,
          heightRate: typeof p.heightRate === 'number' ? Math.round(p.heightRate * 1000) / 1000 : null,
          flowRadialRate:
            typeof p.flowRadialRate === 'number' ? Math.round(p.flowRadialRate * 1000) / 1000 : null,
          flowRadialMean:
            typeof p.flowRadialMean === 'number' ? Math.round(p.flowRadialMean * 1000) / 1000 : null,
          flowRadialPoints: p.flowRadialPoints ?? 0,
          ttc: p.ttc === null ? null : Math.round(p.ttc * 100) / 100,
          distance: p.distance === null ? null : Math.round(p.distance * 10) / 10,
          bbox: {
            x: Math.round(p.bbox.x * 10) / 10,
            y: Math.round(p.bbox.y * 10) / 10,
            w: Math.round(p.bbox.w * 10) / 10,
            h: Math.round(p.bbox.h * 10) / 10,
          },
        }))
      : [],
    corridor:
      risk && risk.corridor
        ? { apex: risk.corridor.apex, halfWidth: risk.corridor.halfWidth, wide: risk.corridor.wide, poly: risk.corridor.poly }
        : null,
  });
}

if (args.video) {
  // 有视频时用真实像素重放，光流点才有内容；没有视频时用空白帧，只复现规则。
  const { spawn } = await import('node:child_process');
  const byFrame = new Map(frames.map((f) => [f.frame, f]));
  const ff = spawn(
    'ffmpeg',
    ['-v', 'error', '-i', args.video, '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const frameBytes = width * height * 4;
  let buf = Buffer.alloc(0);
  let frameIndex = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= frameBytes) {
      const rec = byFrame.get(frameIndex);
      if (rec) {
        const data = new Uint8ClampedArray(buf.subarray(0, frameBytes));
        processFrame(rec, { width, height, data });
      }
      buf = buf.subarray(frameBytes);
      frameIndex++;
    }
  }
} else {
  // 管线在 YOLO 模式下只用像素做光流布点；规则与走廊都不依赖画面内容。
  const blank = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (const rec of frames) processFrame(rec, blank);
}
writeFileSync(
  args.out,
  `${JSON.stringify(
    {
      videoUrl: live.videoUrl,
      duration: live.duration,
      status: 'offline-replay',
      offline: true,
      source: args.live,
      options: overrides,
      analysis: { width, height },
      alerts,
      frames: outFrames,
      speech: [],
    },
    null,
    1,
  )}\n`,
  'utf8',
);
console.log(
  `${args.out}  frames=${outFrames.length}  spoken=${alerts.length}  opts=${JSON.stringify(overrides)}`
);
