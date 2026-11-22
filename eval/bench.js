// 在真实视频上逐帧跑管线，并与人工标注 GT 对比。
import { GuidePipeline } from '../src/app/pipeline.js';
import { SpeechAnnouncer, classifyAnnouncement, environmentCandidate } from '../src/app/announce.js';
import { gtCentersOf, summarizeDetections, timingSummary, trajectoryMetrics } from './metrics.js';
import { evaluateAlarmEvents } from './events.js';

async function seekTo(video, time) {
  const wasPaused = video.paused;
  // 暂停态下部分浏览器不会为新 seek 位置解码；保持播放再 seek，拿到帧后立即暂停。
  if (wasPaused) {
    try {
      // play() 在媒体未就绪/省电策略下可能长期挂起，必须限时。
      await Promise.race([video.play(), new Promise((r) => setTimeout(r, 250))]);
    } catch {
      /* 自动播放被拦截时退回暂停 seek */
    }
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', onSeeked);
      if (wasPaused) video.pause();
      resolve();
    };
    const onSeeked = () => {
      // 等一帧合成，确保 drawImage 读到的是刚 seek 到的画面。
      requestAnimationFrame(() => finish());
      setTimeout(finish, 120);
    };
    if (Math.abs(video.currentTime - time) < 1e-6) {
      finish();
      return;
    }
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
    setTimeout(finish, 1500);
  });
}

/** 暂停态逐帧 seek 时，部分浏览器不会解码新帧；短暂播放一下预热解码器。 */
async function primeVideo(video) {
  if (video.readyState < 1) return null;
  let pixel = null;
  try {
    await Promise.race([video.play(), new Promise((r) => setTimeout(r, 250))]);
    await new Promise((r) => setTimeout(r, 600));
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(video, 0, 0, 64, 36);
    pixel = [...cx.getImageData(32, 18, 1, 1).data];
  } catch {
    /* 自动播放被拦截时继续，后续 seek 会再尝试 */
  }
  video.pause();
  return { pixel, readyState: video.readyState, time: video.currentTime };
}

/**
 * @param {object} args
 * @param {HTMLVideoElement} args.video
 * @param {object} args.gt 标注文档
 * @param {number} args.fps
 * @param {number} args.analysisWidth
 * @param {number} args.startFrame
 * @param {number} args.endFrame
 * @param {number} args.stride
 * @param {boolean} args.onlyDynamic 只评测动态目标
 * @param {boolean} args.yolo 启用 YOLO 检测层 + 逼近事件判定
 * @param {object} args.yoloOptions YoloDetector 参数
 * @param {number} args.warmupFrames 事件判定预热帧数（不计入指标）
 * @param {object} args.options 单参数实验用的管线覆盖项（只覆盖给定键）
 * @param {Function} args.onProgress
 * @param {Function} args.onStatus
 */
export async function runBench(args) {
  const { video, gt, fps, analysisWidth, startFrame, endFrame, stride, onlyDynamic, onProgress, onStatus } = args;
  const override = args.options && typeof args.options === 'object' ? args.options : {};
  const useYolo = Boolean(args.yolo);
  const detectOnCanvas = Boolean(args.detectOnCanvas);
  const disableEnv = Boolean(args.disableEnv);
  const debug = Boolean(args.debug);
  const warmupFrames = Math.max(0, Number(args.warmupFrames) || 0);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let aw = analysisWidth;
  let ah = Math.round((aw * vh) / vw);
  if (ah > 540) {
    ah = 540;
    aw = Math.round((ah * vw) / vh);
  }
  aw -= aw % 2;
  ah -= ah % 2;
  const sx = aw / vw;
  const sy = ah / vh;

  let detector = null;
  if (useYolo) {
    const { YoloDetector } = await import('../src/detection/yolo.js');
    detector = new YoloDetector(args.yoloOptions || {});
    onStatus?.('加载 YOLO 模型…');
    await detector.load();
    onStatus?.(`YOLO 已就绪（${detector.backend}）`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = aw;
  canvas.height = ah;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pipeline = new GuidePipeline({ fps, fbCheck: true, yoloDetect: useYolo, ...override });
  pipeline.reset();

  const frames = [];
  const evalAlerts = new Map();
  const alertHistory = [];
  const debugFrames = [];
  // 环境提醒（斑马线/红绿灯/台阶/地面异物）独立计数：按实时页同样的冷却与让路规则，
  // 统计“实际会播出去几次”，用于评估目标报警之外的额外误报。
  const targetAnnouncer = new SpeechAnnouncer();
  const envAnnouncer = new SpeechAnnouncer();
  const environmentAlerts = { crosswalk: 0, red: 0, green: 0, yellow: 0, stairs: 0, slope: 0, ground: 0 };
  const environmentAlertDetails = [];
  let lastTargetSpeechAt = -Infinity;
  const timings = [];
  const segStats = [];
  const samples = [];
  const matchByFrame = [];
  const gtScale = (boxes) =>
    boxes.map((b) => ({
      id: b.id,
      cls: b.cls,
      bg: Boolean(b.bg),
      bbox: { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy },
    }));

  const wasPaused = video.paused;
  video.pause();
  const prime = await primeVideo(video);
  const lastFrame = Math.min(endFrame, Math.floor(video.duration * fps));
  const total = Math.max(1, Math.floor((lastFrame - startFrame) / stride) + 1);
  const processStart = warmupFrames > 0 ? Math.max(0, startFrame - warmupFrames) : 0;
  let done = 0;
  let firstPixel = null;
  let firstSeek = null;
  let firstMean = null;

  for (let f = processStart; f <= lastFrame; f += stride) {
    const targetTime = Math.min(video.duration - 0.002, (f + 0.5) / fps);
    await seekTo(video, targetTime);
    if (!firstSeek) {
      firstSeek = {
        frame: f,
        target: Math.round(targetTime * 1000) / 1000,
        actual: Math.round(video.currentTime * 1000) / 1000,
        ready: video.readyState,
      };
    }
    ctx.drawImage(video, 0, 0, aw, ah);
    const image = ctx.getImageData(0, 0, aw, ah);
    if (!firstPixel) {
      const idx = ((ah >> 1) * aw + (aw >> 1)) * 4;
      firstPixel = [...image.data.slice(idx, idx + 4)];
      let sum = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        sum += (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
      }
      firstMean = Math.round((sum / (image.data.length / 4)) * 10) / 10;
    }

    let detections = [];
    let detectMs = 0;
    if (detector) {
      // 实时页在缩小后的画布上跑 YOLO；评测台默认仍在原视频上跑（历史口径）。
      // detectOnCanvas=true 时与实时页对齐，用于排查分辨率对边缘小目标的影响。
      const out = await Promise.race([
        detector.detect(detectOnCanvas ? canvas : video, detectOnCanvas ? aw : vw, detectOnCanvas ? ah : vh),
        new Promise((_, reject) => setTimeout(() => reject(new Error('YOLO 推理超时')), 5000)),
      ]);
      detectMs = out.ms;
      detections = out.boxes.map((d) => ({
        ...d,
        bbox: detectOnCanvas
          ? { ...d.bbox }
          : { x: d.bbox.x * sx, y: d.bbox.y * sy, w: d.bbox.w * sx, h: d.bbox.h * sy },
      }));
    }

    const res = pipeline.process(image, f, { detections, dt: stride / fps });
    const alerts = res.risk
      ? res.risk.alerts.map((a) => ({ level: a.level, trackId: a.trackId }))
      : [];
    if (debug) {
      debugFrames.push({
        frame: f,
        detections: detections.map((d) => ({
          cls: d.cls,
          score: Math.round(d.score * 1000) / 1000,
          bbox: {
            x: Math.round(d.bbox.x * 10) / 10,
            y: Math.round(d.bbox.y * 10) / 10,
            w: Math.round(d.bbox.w * 10) / 10,
            h: Math.round(d.bbox.h * 10) / 10,
          },
        })),
        tracks: res.tracks.map((t) => ({
          id: t.id,
          cls: t.cls,
          className: t.className,
          hits: t.hits,
          misses: t.misses,
          confirmed: t.confirmed,
          score: Math.round((t.score ?? 0) * 1000) / 1000,
          bbox: {
            x: Math.round(t.bbox.x * 10) / 10,
            y: Math.round(t.bbox.y * 10) / 10,
            w: Math.round(t.bbox.w * 10) / 10,
            h: Math.round(t.bbox.h * 10) / 10,
          },
        })),
        risk: res.risk
          ? {
              alerts,
              perTrack: res.risk.perTrack.map((p) => ({
                id: p.id,
                confirmed: p.confirmed,
                inPath: p.inPath,
                approaching: p.approaching,
                areaRate: p.areaRate === null ? null : Math.round(p.areaRate * 1000) / 1000,
                areaUpRatio: p.areaUpRatio === null || p.areaUpRatio === undefined ? null : Math.round(p.areaUpRatio * 100) / 100,
                centerRate: p.centerRate === null ? null : Math.round(p.centerRate * 1000) / 1000,
                ttc: p.ttc === null ? null : Math.round(p.ttc * 100) / 100,
                distance: p.distance === null ? null : Math.round(p.distance * 10) / 10,
                level: p.level,
                hits: p.hits,
                samples: p.samples,
              })),
              corridor: res.risk.corridor
                ? { apex: res.risk.corridor.apex, halfWidth: res.risk.corridor.halfWidth, wide: res.risk.corridor.wide }
                : null,
            }
          : null,
        env: {
          terrain: res.terrain,
          crosswalk: res.crosswalk ? { active: res.crosswalk.active, off: res.crosswalk.off, side: res.crosswalk.side, center: res.crosswalk.center } : null,
          traffic: res.traffic ? { active: res.traffic.active, color: res.traffic.color } : null,
        },
      });
    }
    const nowMs = (f / fps) * 1000;
    const targetCand = classifyAnnouncement(res.risk);
    if (targetCand && targetAnnouncer.shouldSpeak(targetCand, nowMs)) lastTargetSpeechAt = nowMs;
    if (f >= startFrame && !disableEnv) {
      const envCand = environmentCandidate(res, null);
      if (envCand && nowMs - lastTargetSpeechAt > 2000 && envAnnouncer.shouldSpeak(envCand, nowMs)) {
        environmentAlerts[envCand.kind] = (environmentAlerts[envCand.kind] || 0) + 1;
        environmentAlertDetails.push({
          kind: envCand.kind,
          frame: f,
          text: envCand.text,
          terrain: res.terrain
            ? {
                peaks: res.terrain.peaks,
                cv: res.terrain.cv,
                score: res.terrain.score,
                streak: res.terrain.streak,
              }
            : null,
          crosswalk: res.crosswalk
            ? { side: res.crosswalk.side, off: res.crosswalk.off, center: res.crosswalk.center }
            : null,
          traffic: res.traffic ? { color: res.traffic.color } : null,
          ground: res.ground ? { label: res.ground.label, bbox: res.ground.bbox, hits: res.ground.hits } : null,
        });
      }
    }
    // YOLO 模式用宽走廊定义 GT 事件（把贴边经过的 id4 也算进去）；
    // 报警判定同样走宽走廊，保证“判定路径”和“评测路径”一致。
    const eventCorridor =
      res.risk && res.risk.corridor
        ? useYolo
          ? { ...res.risk.corridor, poly: res.risk.corridor.wide }
          : res.risk.corridor
        : null;
    if (res.risk) alertHistory.push({ frame: f, alerts, corridor: eventCorridor });

    const inRange = f >= startFrame;
    if (inRange) {
      const rawGt = (gt.frames[String(f)] || []).filter((b) => !onlyDynamic || b.cls !== 'static');
      const gtBoxes = gtScale(rawGt);
      const pred = res.tracks
        .filter((t) => t.confirmed)
        .map((t) => ({ id: t.id, bbox: { x: t.bbox.x, y: t.bbox.y, w: t.bbox.w, h: t.bbox.h } }));

      // 记录预测轨迹（供 ADE/FDE）
      const riskMap = new Map();
      if (res.risk) for (const p of res.risk.perTrack) riskMap.set(p.id, p);
      for (const t of res.tracks) {
        if (!t.confirmed) continue;
        const p = riskMap.get(t.id);
        if (!p || !p.path || !p.path.length) continue;
        samples.push({ frame: f, trackId: t.id, path: p.path.map((pt) => ({ x: pt.x, y: pt.y })) });
      }

      frames.push({ frame: f, gt: gtBoxes, pred });
      evalAlerts.set(f, alerts);
      timings.push({ ...res.timings, detect: detectMs, total: res.timings.total + detectMs });
      if (res.seg) {
        segStats.push({
          bgInlierRatio: res.seg.stats.bgInlierRatio,
          layers: res.seg.stats.layerCount,
          objects: res.seg.stats.objectCount,
          ransacIterations: res.seg.stats.ransacIterations,
          residual: res.seg.stats.bgResidualMean,
        });
      }
      done++;
      if (onProgress) onProgress(Math.min(1, done / total), f);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (f % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  // 建立帧级 GT<->预测 匹配（用于轨迹评测）；同时统计 ID 映射，供预热帧报警对齐。
  const detection = summarizeDetections(frames, 0.5);
  const idVotes = new Map();
  for (let i = 0; i < frames.length; i++) {
    const gt = frames[i].gt;
    const pred = frames[i].pred;
    const pairs = [];
    for (let a = 0; a < gt.length; a++) {
      for (let b = 0; b < pred.length; b++) {
        const x0 = Math.max(gt[a].bbox.x, pred[b].bbox.x);
        const y0 = Math.max(gt[a].bbox.y, pred[b].bbox.y);
        const x1 = Math.min(gt[a].bbox.x + gt[a].bbox.w, pred[b].bbox.x + pred[b].bbox.w);
        const y1 = Math.min(gt[a].bbox.y + gt[a].bbox.h, pred[b].bbox.y + pred[b].bbox.h);
        const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
        const uni = gt[a].bbox.w * gt[a].bbox.h + pred[b].bbox.w * pred[b].bbox.h - inter;
        const iou = uni > 0 ? inter / uni : 0;
        if (iou >= 0.3) pairs.push({ a, b, iou });
      }
    }
    pairs.sort((p, q) => q.iou - p.iou);
    const usedA = new Uint8Array(gt.length);
    const usedB = new Uint8Array(pred.length);
    const map = new Map();
    for (const p of pairs) {
      if (usedA[p.a] || usedB[p.b]) continue;
      usedA[p.a] = 1;
      usedB[p.b] = 1;
      const rawId = gt[p.a].id;
      const mappedId = gt[p.a].bg && gt.bgMap && gt.bgMap[String(rawId)] ? Number(gt.bgMap[String(rawId)]) : rawId;
      map.set(pred[p.b].id, mappedId);
      let votes = idVotes.get(pred[p.b].id);
      if (!votes) {
        votes = new Map();
        idVotes.set(pred[p.b].id, votes);
      }
      votes.set(mappedId, (votes.get(mappedId) || 0) + 1);
    }
    matchByFrame[frames[i].frame] = map;
  }

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

  // 预热帧只用于“事件前报警”对齐，不计入 GT 样本；误报率仍按评测帧时长计算。
  const eventFrames = [];
  for (const rec of alertHistory) {
    if (rec.frame >= startFrame) continue;
    eventFrames.push({ frame: rec.frame, gt: [], alerts: rec.alerts, corridor: rec.corridor });
    matchByFrame[rec.frame] = idMap;
  }
  for (const rec of frames) {
    eventFrames.push({
      frame: rec.frame,
      gt: rec.gt,
      alerts: evalAlerts.get(rec.frame) || [],
      corridor: alertHistory.find((a) => a.frame === rec.frame)?.corridor || null,
    });
  }
  eventFrames.sort((a, b) => a.frame - b.frame);

  const gtCenters = gtCentersOf(gt);
  const scaledCenters = new Map();
  for (const [id, m] of gtCenters) {
    const mm = new Map();
    for (const [f, c] of m) mm.set(f, { x: c.x * sx, y: c.y * sy });
    scaledCenters.set(id, mm);
  }

  const diagonal = Math.hypot(aw, ah);
  const trajectory = trajectoryMetrics(samples, scaledCenters, matchByFrame, 10, diagonal);
  const timing = timingSummary(timings);
  const evalDurationSec = frames.length ? ((frames[frames.length - 1].frame - startFrame) / fps + 1 / fps) : null;
  const events = evaluateAlarmEvents({
    frames: eventFrames,
    matchByFrame,
    fps,
    leadSec: 3,
    minLevel: 2,
    durationSec: evalDurationSec,
    evalStartFrame: startFrame,
  });
  const mean = (arr, k) => (arr.length ? arr.reduce((a, b) => a + b[k], 0) / arr.length : 0);

  if (!wasPaused) {
    // 保持原状态，不自动播放
  }
  return {
    config: {
      fps,
      analysisWidth: aw,
      analysisHeight: ah,
      startFrame,
      endFrame,
      stride,
      onlyDynamic,
      yolo: useYolo,
      detectOnCanvas,
      disableEnv,
      debug,
      warmupFrames,
      eventPath: useYolo ? 'wide' : 'strict',
      detectorBackend: detector ? detector.backend : null,
      yoloInput: detector ? detector.lastInputRange : null,
      prime,
      firstPixel,
      firstMean,
      firstSeek,
      warning:
        firstMean !== null && firstMean < 5
          ? '首帧接近全黑，视频可能未解码，本次结果无效；请刷新页面后重试'
          : null,
      options: { ...pipeline.options },
    },
    detection,
    trajectory,
    events,
    timing,
    segmentation: {
      meanBgInlierRatio: mean(segStats, 'bgInlierRatio'),
      meanLayers: mean(segStats, 'layers'),
      meanObjects: mean(segStats, 'objects'),
      meanRansacIterations: mean(segStats, 'ransacIterations'),
      meanBgResidual: mean(segStats, 'residual'),
    },
    environmentAlerts,
    environmentAlertDetails,
    environmentAlertTotal: Object.values(environmentAlerts).reduce((a, b) => a + b, 0),
    debugFrames: debug ? debugFrames : undefined,
    frameCount: frames.length,
    sampleCount: samples.length,
  };
}

export function resultToCSV(result) {
  const rows = [
    ['metric', 'value'],
    ['frames', result.frameCount],
    ['yolo', result.config.yolo ? 1 : 0],
    ['warmup_frames', result.config.warmupFrames],
    ['detector_backend', result.config.detectorBackend || ''],
    ['gt', result.detection.gtCount],
    ['tp', result.detection.tp],
    ['fp', result.detection.fp],
    ['fn', result.detection.fn],
    ['idsw', result.detection.idsw],
    ['precision', result.detection.precision],
    ['recall', result.detection.recall],
    ['f1', result.detection.f1],
    ['mota', result.detection.mota],
    ['motp', result.detection.motp],
    ['event_count', result.events ? result.events.eventCount : ''],
    ['event_recall', result.events ? result.events.eventRecall ?? '' : ''],
    ['fn_events', result.events ? result.events.fnEvents : ''],
    ['late_events', result.events ? result.events.lateEvents : ''],
    ['fp_episodes', result.events ? result.events.fpEpisodes : ''],
    ['fp_per_min', result.events ? result.events.fpPerMin ?? '' : ''],
    ['lead_median_s', result.events ? result.events.leadMedian ?? '' : ''],
    ['lead_p10_s', result.events ? result.events.leadP10 ?? '' : ''],
    ['env_crosswalk', result.environmentAlerts ? result.environmentAlerts.crosswalk : ''],
    ['env_red', result.environmentAlerts ? result.environmentAlerts.red : ''],
    ['env_green', result.environmentAlerts ? result.environmentAlerts.green : ''],
    ['env_yellow', result.environmentAlerts ? result.environmentAlerts.yellow : ''],
    ['env_stairs', result.environmentAlerts ? result.environmentAlerts.stairs : ''],
    ['env_slope', result.environmentAlerts ? result.environmentAlerts.slope : ''],
    ['env_ground', result.environmentAlerts ? result.environmentAlerts.ground : ''],
    ['env_total', result.environmentAlertTotal ?? ''],
    ['ade_px', result.trajectory.ade ?? ''],
    ['fde_px', result.trajectory.fde ?? ''],
    ['ade_norm', result.trajectory.adeNorm ?? ''],
    ['fde_norm', result.trajectory.fdeNorm ?? ''],
    ['bg_inlier_ratio', result.segmentation.meanBgInlierRatio],
    ['bg_residual_px', result.segmentation.meanBgResidual],
    ['ransac_iters', result.segmentation.meanRansacIterations],
    ['total_ms_mean', result.timing.totalMean],
    ['total_ms_p95', result.timing.totalP95],
    ['detect_ms_mean', result.timing.detectMean ?? ''],
    ['flow_ms_mean', result.timing.flowMean],
    ['segment_ms_mean', result.timing.segmentMean],
  ];
  return rows.map((r) => r.join(',')).join('\n');
}
