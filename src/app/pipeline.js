// 单帧处理管线：灰度 -> 金字塔 -> 光流 -> 运动分层 -> 跟踪 -> 风险。
// yoloDetect 模式：YOLO 检测框 -> 逼近跟踪（面积/中心） -> 风险；光流只测已检出目标。
import { GrayImage } from '../vision/image.js';
import { detectFast } from '../vision/features.js';
import { buildPyramid, lkTrack, lkTrackFB } from '../vision/flow.js';
import { segmentScene } from '../vision/segmentation.js';
import { TerrainTracker } from '../vision/terrain.js';
import { CrosswalkTracker, detectCrosswalk } from '../vision/crosswalk.js';
import { GroundObstacleTracker, GROUND_CLASSES } from '../vision/ground.js';
import { TrafficLightTracker } from '../vision/traffic.js';
import { Tracker } from '../tracking/tracker.js';
import { ApproachTracker, assessApproachRisk } from '../tracking/approach.js';
import { assessRisk, buildCorridor } from '../tracking/risk.js';
import { fixedPointOfH } from '../math/matrix.js';

export const PIPELINE_DEFAULTS = {
  pyramidLevels: 3,
  fastThreshold: 18,
  maxFeatures: 320,
  fbCheck: true,
  maxTrackError: 32,
  ransacThreshold: 2.5,
  maxLayers: 3,
  minLayerRatio: 0.12,
  residualThreshold: 5,
  corridorRatio: 0.24,
  horizonSec: 1.4,
  hfovDeg: 65,
  fps: 25,
  minObjectPoints: 6,
  // 安全策略：宁可多报，不要漏报
  recallFirst: true,
  maxMissed: 6,
  // YOLO 检测层 + 逼近事件判定
  yoloDetect: false,
  yoloMinHits: 2,
  approachWindow: 8,
  approachMinSamples: 5,
  minAreaGrowth: 0.35,
  maxCenterRate: 0.05,
  centerRef: 'bottom',
  approachMinHeight: 18,
  approachMinScore: 0.15,
  approachMinFrames: 4,
  alertPath: 'wide',
  // 相机离地高度（米）与地平线位置（占图像高度比例），用于地面几何估距
  cameraHeight: 1.5,
  horizonRatio: 0.5,
  // 相机光轴向下俯角（度）；实时页默认 10°，评测/演示默认不启用地面模式
  cameraPitchDeg: 0,
  // 'bbox'：框高估距（历史指标兼容）；'ground'：按相机高度与地面线估距
  distanceMode: 'bbox',
  // 地形提醒：下方中央水平边缘周期检测台阶
  terrainDetect: true,
  flowPointsPerBox: 32,
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function mergePoints(primary, secondary, minDist, maxCount) {
  const n1 = primary.length >> 1;
  const n2 = secondary.length >> 1;
  const cell = Math.max(4, minDist);
  const grid = new Map();
  const out = [];
  const minD2 = minDist * minDist;

  const add = (x, y) => {
    if (out.length * 0.5 >= maxCount) return false;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const bucket = grid.get(gy * 4096 + gx);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k += 2) {
          const dx = bucket[k] - x;
          const dy = bucket[k + 1] - y;
          if (dx * dx + dy * dy < minD2) return false;
        }
      }
    }
    out.push(x, y);
    const key = cy * 4096 + cx;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(x, y);
    return true;
  };

  for (let i = 0; i < n1; i++) add(primary[2 * i], primary[2 * i + 1]);
  for (let i = 0; i < n2; i++) add(secondary[2 * i], secondary[2 * i + 1]);
  return Float32Array.from(out);
}

export class GuidePipeline {
  constructor(opts = {}) {
    this.options = { ...PIPELINE_DEFAULTS, ...opts };
    this.reset();
  }

  setOptions(opts) {
    this.options = { ...this.options, ...opts };
    this.tracker.maxMissed = this.options.maxMissed ?? this.tracker.maxMissed;
    this.tracker.minHits = this.options.recallFirst ? 1 : 2;
    this.approachTracker.setOptions(this.approachOptions());
  }

  approachOptions() {
    return {
      minHits: this.options.yoloMinHits,
      window: this.options.approachWindow,
      minSamples: this.options.approachMinSamples,
      minAreaGrowth: this.options.minAreaGrowth,
      maxCenterRate: this.options.maxCenterRate,
      centerRef: this.options.centerRef,
      minBoxHeight: this.options.approachMinHeight,
      minScore: this.options.approachMinScore,
      approachMinFrames: this.options.approachMinFrames,
    };
  }

  reset() {
    this.prevGray = null;
    this.prevPyr = null;
    this.prevPts = new Float32Array(0);
    this.lastBgH = null;
    this.tracker = new Tracker({
      maxMissed: this.options.maxMissed ?? 6,
      minHits: this.options.recallFirst ? 1 : 2,
    });
    this.approachTracker = new ApproachTracker(this.approachOptions());
    this.terrainTracker = new TerrainTracker();
    this.trafficTracker = new TrafficLightTracker();
    this.crosswalkTracker = new CrosswalkTracker();
    this.groundTracker = new GroundObstacleTracker();
    this.frameIndex = 0;
    this.lastTimestamp = null;
    this.instantFps = 0;
  }

  /** 在检测框内布置 FAST 角点，供下一帧光流估计目标自身膨胀率。 */
  seedFlowPoints(gray, detections, w, h) {
    if (!detections.length) return new Float32Array(0);
    const fresh = detectFast(gray, this.options.fastThreshold, this.options.maxFeatures);
    const perBox = new Uint16Array(detections.length);
    const out = [];
    for (let i = 0; i < fresh.count; i++) {
      const x = fresh.pts[2 * i];
      const y = fresh.pts[2 * i + 1];
      for (let j = 0; j < detections.length; j++) {
        const b = detections[j].bbox || detections[j];
        if (
          perBox[j] >= this.options.flowPointsPerBox ||
          x < b.x + 2 || x > b.x + b.w - 2 ||
          y < b.y + 2 || y > b.y + b.h - 2
        ) {
          continue;
        }
        perBox[j]++;
        out.push(x, y);
        break;
      }
      if (out.length >> 1 >= this.options.maxFeatures) break;
    }
    return Float32Array.from(out);
  }

  /** 保留成功跟踪点，不足时补充新角点。 */
  maintainFlowPoints(lk, flowUsed, gray, w, h) {
    const keptArr = [];
    for (let i = 0; i < flowUsed; i++) {
      if (!lk.status[i]) continue;
      const x = lk.nextPts[2 * i];
      const y = lk.nextPts[2 * i + 1];
      if (x < 4 || y < 4 || x > w - 5 || y > h - 5) continue;
      keptArr.push(x, y);
    }
    let pts = Float32Array.from(keptArr);
    if ((pts.length >> 1) < this.options.maxFeatures * 0.6) {
      const fresh = detectFast(gray, this.options.fastThreshold, this.options.maxFeatures);
      pts = mergePoints(pts, fresh.pts, 7, this.options.maxFeatures);
    }
    return pts;
  }

  process(imageData, frameIndex = this.frameIndex, ctx = {}) {
    const t0 = now();
    const w = imageData.width;
    const h = imageData.height;
    if (!w || !h) throw new Error('无效帧尺寸');
    const yoloMode = Boolean(this.options.yoloDetect);

    if (this.prevGray && (this.prevGray.w !== w || this.prevGray.h !== h)) this.reset();

    const gray = GrayImage.fromRGBA(imageData.data, w, h);
    const tGray = now();
    const pyr = buildPyramid(gray, this.options.pyramidLevels);
    const tPyr = now();
    const terrain = this.options.terrainDetect ? this.terrainTracker.update(gray, now()) : null;

    let seg = null;
    let detections = [];
    let tracks = [];
    let risk = null;
    let traffic = null;
    let crosswalk = null;
    let ground = null;
    let flowUsed = 0;
    let flowOk = 0;
    let tFlow = tPyr;
    let tSeg = tPyr;
    let tTrack = tPyr;
    let flowPts = null;
    let lk = null;

    if (this.prevPyr && this.prevPts.length >= 8) {
      const trackFn = this.options.fbCheck ? lkTrackFB : lkTrack;
      lk = trackFn(this.prevPyr, pyr, this.prevPts, {
        window: 2,
        iterations: 4,
        maxFbError: 1.5,
      });
      tFlow = now();
      flowUsed = this.prevPts.length >> 1;
      const srcArr = [];
      const dstArr = [];
      for (let i = 0; i < flowUsed; i++) {
        if (!lk.status[i]) continue;
        if (lk.errors[i] > this.options.maxTrackError) continue;
        srcArr.push(this.prevPts[2 * i], this.prevPts[2 * i + 1]);
        dstArr.push(lk.nextPts[2 * i], lk.nextPts[2 * i + 1]);
      }
      const src = Float32Array.from(srcArr);
      const dst = Float32Array.from(dstArr);
      flowOk = src.length >> 1;
      flowPts = { src, dst };
    }

    if (yoloMode) {
      // 目标发现只走 YOLO + 逼近跟踪；光流仅用于估计已检出目标的相对膨胀率。
      const external = Array.isArray(ctx.detections) ? ctx.detections : [];
      const trafficLights = external.filter((d) => d.cls === 9);
      const groundDets = external.filter((d) => GROUND_CLASSES.has(d.cls));
      const targetDets = external.filter((d) => d.cls !== 9 && !GROUND_CLASSES.has(d.cls));
      tSeg = now();
      const dt = ctx.dt ?? 1 / this.options.fps;
      traffic = this.trafficTracker.update(trafficLights, imageData, w, h, now());
      tracks = this.approachTracker.update(targetDets, frameIndex, {
        width: w,
        height: h,
        fps: this.options.fps,
        flow: flowPts,
        dt,
      });
      const confirmed = tracks.filter((t) => t.confirmed);
      detections = confirmed.map((t) => ({
        id: t.id,
        bbox: { ...t.bbox },
        score: t.score,
        cls: t.cls,
        className: t.className,
      }));
      const corridor = buildCorridor(null, w, h, {
        widthRatio: this.options.corridorRatio,
      });
      risk = assessApproachRisk({
        tracks: confirmed,
        corridor,
        w,
        h,
        fps: this.options.fps,
        horizonSec: this.options.horizonSec,
        hfovDeg: this.options.hfovDeg,
        minApproachFrames: this.options.approachMinFrames,
        pathMode: this.options.alertPath,
        cameraHeight: this.options.cameraHeight,
        horizonRatio: this.options.horizonRatio,
        cameraPitchDeg: this.options.cameraPitchDeg,
        distanceMode: this.options.distanceMode,
      });
      this.lastBgH = null;
      crosswalk = this.crosswalkTracker.update(
        detectCrosswalk(imageData, w, h, { boxes: external.map((d) => d.bbox) }),
        now(),
      );
      ground = this.groundTracker.update(groundDets, { w, h, nowMs: now() });
      // 下一帧在目标检测框内布光流点，避免背景/地面小物体稀释目标膨胀估计。
      this.prevPts = this.seedFlowPoints(gray, targetDets, w, h);
      tTrack = now();
    } else if (flowPts && flowOk >= 12) {
      // 拟合使用全部 valid 点，不做 TTC/距离/ROI 预筛选
      seg = segmentScene(flowPts.src, flowPts.dst, {
        width: w,
        height: h,
        threshold: this.options.ransacThreshold,
        maxLayers: this.options.maxLayers,
        minLayerInliers: Math.max(12, Math.round(flowOk * this.options.minLayerRatio)),
        residualThreshold: this.options.residualThreshold,
        minObjectPoints: this.options.minObjectPoints,
        seed: 20260101,
      });
      detections = seg.objects.filter((o) => o.count >= this.options.minObjectPoints && o.bbox.w >= 6 && o.bbox.h >= 6);
      tracks = this.tracker.update(detections, seg.bg ? seg.bg.H : null, frameIndex);
      const corridor = buildCorridor(seg.bg ? seg.bg.H : null, w, h, {
        widthRatio: this.options.corridorRatio,
      });
      risk = assessRisk({
        tracks: this.tracker.confirmed,
        bgH: seg.bg ? seg.bg.H : null,
        corridor,
        w,
        h,
        fps: this.options.fps,
        horizonSec: this.options.horizonSec,
        hfovDeg: this.options.hfovDeg,
      });
      this.lastBgH = seg.bg ? seg.bg.H : this.lastBgH;
      tSeg = now();
      this.prevPts = this.maintainFlowPoints(lk, flowUsed, gray, w, h);
      tTrack = now();
    } else if (flowPts) {
      // 安全降级：valid 点不足时不能“静默无输出”，必须明确告知感知受限
      const corridor = buildCorridor(this.lastBgH, w, h, {
        widthRatio: this.options.corridorRatio,
      });
      risk = {
        corridor,
        perTrack: [],
        alerts: [],
        topAlert: null,
        instruction: '感知受限：画面纹理或光照不足，请放慢脚步',
        degraded: true,
      };
      tSeg = now();
      this.prevPts = this.maintainFlowPoints(lk, flowUsed, gray, w, h);
      tTrack = now();
    } else {
      const fresh = detectFast(gray, this.options.fastThreshold, this.options.maxFeatures);
      this.prevPts = fresh.pts;
      tTrack = now();
      tFlow = tPyr;
      tSeg = tPyr;
    }

    this.prevGray = gray;
    this.prevPyr = pyr;
    this.frameIndex = frameIndex + 1;

    const tEnd = now();
    if (this.lastTimestamp !== null) {
      const dt = tEnd - this.lastTimestamp;
      this.instantFps = dt > 0 ? 1000 / dt : 0;
    }
    this.lastTimestamp = tEnd;

    return {
      frame: { width: w, height: h, index: frameIndex },
      mode: yoloMode ? 'yolo' : 'motion',
      terrain,
      traffic,
      crosswalk,
      ground,
      seg,
      detections,
      tracks,
      risk,
      flow: flowPts,
      flowStats: { used: flowUsed, valid: flowOk },
      foe: seg && seg.bg ? fixedPointOfH(seg.bg.H) : null,
      timings: {
        gray: tGray - t0,
        pyramid: tPyr - tGray,
        flow: tFlow - tPyr,
        segment: tSeg - tFlow,
        track: tTrack - tSeg,
        total: tEnd - t0,
      },
      instantFps: this.instantFps,
      options: { ...this.options },
    };
  }
}
