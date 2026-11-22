// 基于 YOLO 检测框的逼近事件判定：IoU 关联拿 ID → 面积/中心历史 → 逼近事件。
// 光流只用于估计“已检出目标”的相对膨胀速度（TTC），不再做前景/背景分层找人。
//
// 备选增强（未实现，排在本在线判定之后）：多帧时序基线（连续多帧特征/3D CNN），
// 当前先以逐帧检测 + 短窗口几何统计满足实时性与可解释性。
import { boxCenter, boxIoU } from '../math/boxes.js';
import { pointInPolygon } from '../math/matrix.js';
import { buildCorridor, estimateDistance, directionLabel } from './risk.js';

export const APPROACH_DEFAULTS = {
  iouThreshold: 0.25,
  maxMissed: 3,
  minHits: 2,
  historyLength: 14,
  window: 8,
  minSamples: 5,
  // ln(框面积) 的每秒增长率；0.35 ≈ 面积每秒增长 35%
  minAreaGrowth: 0.35,
  // 框中心到参考点的距离变化率（按画面短边归一化，每秒）
  maxCenterRate: 0.05,
  // 'bottom'：画面下方中央（行进方向）；'image'：几何画面中心
  centerRef: 'bottom',
  minAreaUpRatio: 0.55,
  minBoxHeight: 18,
  minScore: 0.15,
  flowMinPoints: 5,
  ttcMax: 8,
  // 连续满足逼近条件的帧数，过滤单帧抖动造成的短促误报
  approachMinFrames: 4,
};

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function linreg(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let den = 0;
  let num = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    den += dx * dx;
    num += dx * (ys[i] - my);
  }
  return den > 1e-9 ? num / den : 0;
}

/**
 * 由框中心/面积历史计算逼近指标。纯函数，便于单测。
 * @param {Array<{frame:number, area:number, cx:number, cy:number}>} history
 * @param {object} opts {width,height,fps,window,minSamples,minAreaGrowth,maxCenterRate,centerRef,minAreaUpRatio}
 */
export function computeApproachMetrics(history, opts = {}) {
  const width = opts.width ?? 320;
  const height = opts.height ?? 180;
  const fps = opts.fps ?? 30;
  const window = opts.window ?? APPROACH_DEFAULTS.window;
  const minSamples = opts.minSamples ?? APPROACH_DEFAULTS.minSamples;
  const minAreaGrowth = opts.minAreaGrowth ?? APPROACH_DEFAULTS.minAreaGrowth;
  const maxCenterRate = opts.maxCenterRate ?? APPROACH_DEFAULTS.maxCenterRate;
  const minAreaUpRatio = opts.minAreaUpRatio ?? APPROACH_DEFAULTS.minAreaUpRatio;
  const centerRef = opts.centerRef ?? APPROACH_DEFAULTS.centerRef;

  const h = history.slice(-window);
  if (h.length < minSamples) {
    return {
      ready: false,
      samples: h.length,
      areaRate: 0,
      centerRate: 0,
      areaUpRatio: 0,
      approaching: false,
    };
  }

  const frames = h.map((v) => v.frame);
  const deltas = [];
  for (let i = 1; i < frames.length; i++) deltas.push(Math.max(1, frames[i] - frames[i - 1]));
  const frameStep = median(deltas) || 1;
  const perSec = fps / frameStep;

  const areas = h.map((v) => Math.max(1, v.area));
  const areaSlope = linreg(frames, areas.map((a) => Math.log(a)));
  const areaRate = areaSlope * perSec;

  const ref =
    centerRef === 'image'
      ? { x: width * 0.5, y: height * 0.5 }
      : { x: width * 0.5, y: height };
  const dists = h.map((v) => Math.hypot(v.cx - ref.x, v.cy - ref.y));
  const centerSlope = linreg(frames, dists);
  const shortSide = Math.max(1, Math.min(width, height));
  const centerRate = (centerSlope * perSec) / shortSide;

  let areaUp = 0;
  for (let i = 1; i < areas.length; i++) if (areas[i] > areas[i - 1]) areaUp++;
  const areaUpRatio = areas.length > 1 ? areaUp / (areas.length - 1) : 0;

  const approaching =
    areaRate >= minAreaGrowth && areaUpRatio >= minAreaUpRatio && centerRate <= maxCenterRate;

  return {
    ready: true,
    samples: h.length,
    frameStep,
    areaRate,
    centerRate,
    areaUpRatio,
    approaching,
  };
}

/**
 * 用框内光流估计目标的相对膨胀率 s（下一帧尺寸 / 当前帧尺寸）。
 * 以框中心为原点做最小二乘径向缩放估计，单点比值取中位数抗遮挡/外点。
 * TTC ≈ dt / (s - 1)。
 * @param {{x:number,y:number,w:number,h:number}} bbox 上一帧目标框
 * @param {{x:number,y:number}} center 当前帧框中心（光流目的点围绕它展开）
 * @param {Float32Array} src 上一帧光流点
 * @param {Float32Array} dst 当前帧光流点
 */
export function estimateFlowScale(bbox, center, src, dst, opts = {}) {
  const minPoints = opts.minPoints ?? APPROACH_DEFAULTS.flowMinPoints;
  const n = Math.min(src.length >> 1, dst.length >> 1);
  const mx = bbox.w * 0.08;
  const my = bbox.h * 0.08;
  const ratios = [];
  const prevCenter = boxCenter(bbox);
  for (let i = 0; i < n; i++) {
    const px = src[2 * i];
    const py = src[2 * i + 1];
    if (
      px < bbox.x + mx || px > bbox.x + bbox.w - mx ||
      py < bbox.y + my || py > bbox.y + bbox.h - my
    ) {
      continue;
    }
    const ax = px - prevCenter.x;
    const ay = py - prevCenter.y;
    const bx = dst[2 * i] - center.x;
    const by = dst[2 * i + 1] - center.y;
    const den = ax * ax + ay * ay;
    if (den < 9) continue;
    const r = (ax * bx + ay * by) / den;
    if (!(r > 0.5 && r < 2)) continue;
    ratios.push(r);
  }
  if (ratios.length < minPoints) return { scale: null, count: ratios.length };
  return { scale: median(ratios), count: ratios.length };
}

class ApproachTrack {
  constructor(id, det, frameIndex, opts) {
    this._opts = opts;
    this.id = id;
    this.bbox = { ...det.bbox };
    this.prevBbox = null;
    this.cls = det.cls ?? -1;
    this.className = det.className ?? '';
    this.score = det.score ?? 1;
    this.hits = 1;
    this.misses = 0;
    this.age = 1;
    this.confirmed = opts.minHits <= 1;
    this.bornAt = frameIndex;
    this.history = [];
    this._push(frameIndex, det.bbox);
    this.flowScale = null;
    this.flowPoints = 0;
    this.ttc = null;
    this.ttcSource = null;
    this.velocity = { x: 0, y: 0 };
    this.approaching = false;
    this.approachFrames = 0;
    this.areaRate = 0;
    this.centerRate = 0;
    this.areaUpRatio = 0;
    this.samples = 0;
  }

  _push(frame, bbox) {
    const c = boxCenter(bbox);
    this.history.push({
      frame,
      area: Math.max(1, bbox.w * bbox.h),
      cx: c.x,
      cy: c.y,
      w: bbox.w,
      h: bbox.h,
    });
    if (this.history.length > this.options.historyLength) this.history.shift();
  }

  get options() {
    return this._opts;
  }

  setOptions(opts) {
    this._opts = opts;
  }

  update(det, frameIndex, flow, dt, fps) {
    this.prevBbox = { ...this.bbox };
    if (this.history.length) {
      const last = this.history[this.history.length - 1];
      const df = Math.max(1, frameIndex - last.frame);
      this.velocity = { x: (boxCenter(det.bbox).x - last.cx) / df, y: (boxCenter(det.bbox).y - last.cy) / df };
    }
    this.bbox = { ...det.bbox };
    this.cls = det.cls ?? this.cls;
    this.className = det.className ?? this.className;
    this.score = det.score ?? this.score;
    this._push(frameIndex, det.bbox);
    this.hits++;
    this.misses = 0;
    this.confirmed = this.hits >= this.options.minHits;
    this._refresh(flow, dt, fps);
  }

  _refresh(flow, dt, fps) {
    const opts = this.options;
    const m = computeApproachMetrics(this.history, {
      width: this._w,
      height: this._h,
      fps,
      window: opts.window,
      minSamples: opts.minSamples,
      minAreaGrowth: opts.minAreaGrowth,
      maxCenterRate: opts.maxCenterRate,
      centerRef: opts.centerRef,
      minAreaUpRatio: opts.minAreaUpRatio,
    });
    this.samples = m.samples;
    this.areaRate = m.areaRate;
    this.centerRate = m.centerRate;
    this.areaUpRatio = m.areaUpRatio;
    this.approaching = m.approaching;
    this.approachFrames = m.approaching ? this.approachFrames + 1 : 0;

    let flowScale = null;
    let flowPoints = 0;
    if (flow && this.prevBbox && flow.src && flow.dst) {
      const c = boxCenter(this.bbox);
      const r = estimateFlowScale(this.prevBbox, c, flow.src, flow.dst, { minPoints: opts.flowMinPoints });
      flowScale = r.scale;
      flowPoints = r.count;
    }
    this.flowScale = flowScale;
    this.flowPoints = flowPoints;

    if (flowScale !== null && flowScale > 1.002) {
      this.ttc = Math.min(opts.ttcMax, dt / (flowScale - 1));
      this.ttcSource = 'flow';
    } else if (this.areaRate > 0.02) {
      // 面积 ~ 1/距离²，TTC ≈ 2 / 面积增长率
      this.ttc = Math.min(opts.ttcMax, 2 / this.areaRate);
      this.ttcSource = 'area';
    } else {
      this.ttc = null;
      this.ttcSource = null;
    }
  }

  markMissed() {
    this.misses++;
  }
}

export class ApproachTracker {
  constructor(opts = {}) {
    this.options = { ...APPROACH_DEFAULTS, ...opts };
    this.tracks = [];
    this.nextId = 1;
  }

  setOptions(opts = {}) {
    this.options = { ...this.options, ...opts };
    for (const t of this.tracks) t.setOptions(this.options);
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }

  /**
   * @param {Array} detections [{bbox:{x,y,w,h}, score, cls, className}]
   * @param {number} frameIndex
   * @param {{width:number,height:number,flow?:{src,dst},dt?:number,fps?:number}} ctx
   */
  update(detections, frameIndex, ctx = {}) {
    const opts = this.options;
    const width = ctx.width ?? 320;
    const height = ctx.height ?? 180;
    const fps = ctx.fps ?? 30;
    const dt = ctx.dt ?? 1 / fps;
    const dets = [];
    for (const d of detections || []) {
      const b = d.bbox || d;
      if (!b || !(b.w > 1) || !(b.h > 1)) continue;
      if (b.h < opts.minBoxHeight) continue;
      if (d.score !== undefined && d.score < opts.minScore) continue;
      dets.push({
        bbox: { x: b.x, y: b.y, w: b.w, h: b.h },
        score: d.score ?? 1,
        cls: d.cls ?? -1,
        className: d.className ?? '',
      });
    }

    const pairs = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      const tc = boxCenter(t.bbox);
      const diag = Math.hypot(t.bbox.w, t.bbox.h);
      const gate = Math.max(14, diag * 0.75);
      for (let di = 0; di < dets.length; di++) {
        const iou = boxIoU(t.bbox, dets[di].bbox);
        const dc = boxCenter(dets[di].bbox);
        const dist = Math.hypot(dc.x - tc.x, dc.y - tc.y);
        if (iou < opts.iouThreshold && dist > gate) continue;
        const cost =
          1 - iou +
          0.5 * (dist / Math.max(1, gate)) +
          (dets[di].cls !== t.cls ? 0.15 : 0);
        pairs.push({ ti, di, cost });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);

    const trackUsed = new Uint8Array(this.tracks.length);
    const detUsed = new Uint8Array(dets.length);
    for (const p of pairs) {
      if (trackUsed[p.ti] || detUsed[p.di]) continue;
      trackUsed[p.ti] = 1;
      detUsed[p.di] = 1;
      const t = this.tracks[p.ti];
      t._w = width;
      t._h = height;
      t.update(dets[p.di], frameIndex, ctx.flow, dt, fps);
    }

    const alive = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      if (!trackUsed[ti]) {
        t.markMissed();
        if (t.misses > opts.maxMissed) continue;
      }
      t.age++;
      alive.push(t);
    }
    this.tracks = alive;

    for (let di = 0; di < dets.length; di++) {
      if (detUsed[di]) continue;
      const t = new ApproachTrack(this.nextId++, dets[di], frameIndex, opts);
      t._w = width;
      t._h = height;
      t.setOptions(opts);
      t._refresh(null, dt, fps);
      this.tracks.push(t);
    }

    return this.tracks;
  }

  get confirmed() {
    return this.tracks.filter((t) => t.confirmed);
  }
}

/**
 * 地面几何估距：假设地面平坦、相机离地 H、地平线在 horizonRatio * 图像高。
 * d = f * H / (y_ground - y_horizon)，f = W / (2*tan(HFOV/2))。
 * 只返回可信范围（0.3–200m）；框底在地平线以上时返回 null，由框高估距兜底。
 */
export function estimateGroundDistance(bbox, imageWidth, imageHeight, opts = {}) {
  const cameraHeight = Number(opts.cameraHeight) || 0;
  if (!(cameraHeight > 0)) return null;
  const hfov = ((opts.hfovDeg ?? 65) * Math.PI) / 180;
  const f = (imageWidth * 0.5) / Math.tan(hfov * 0.5);
  const horizonY = imageHeight * (opts.horizonRatio ?? 0.5);
  const groundY = bbox.y + bbox.h;
  const dy = groundY - horizonY;
  if (!(dy > 1)) return null;
  const d = (f * cameraHeight) / dy;
  if (!Number.isFinite(d) || d < 0.3 || d > 200) return null;
  return d;
}

/**
 * 逼近风险：面积持续增长 + 中心朝行进中心移动 + 脚下点进入通行走廊。
 * 输出结构与 risk.assessRisk 兼容（alerts/perTrack/instruction/topAlert）。
 */
export function assessApproachRisk(args) {
  const { tracks, corridor, w, h, fps = 30, horizonSec = 1.4, hfovDeg = 65 } = args;
  const minApproachFrames = args.minApproachFrames ?? APPROACH_DEFAULTS.approachMinFrames;
  const pathMode = args.pathMode ?? 'wide';
  const cameraHeight = Number(args.cameraHeight) || 0;
  const horizonRatio = args.horizonRatio ?? 0.5;
  const distanceMode = args.distanceMode ?? 'bbox';
  const steps = Math.max(4, Math.round(horizonSec * fps));
  const perTrack = [];
  const alerts = [];

  for (const t of tracks) {
    if (!t.confirmed) continue;
    const cx = t.bbox.x + t.bbox.w * 0.5;
    const ground = { x: cx, y: t.bbox.y + t.bbox.h };
    const inStrict = pointInPolygon(corridor.poly, ground.x, ground.y);
    const inWide = pointInPolygon(corridor.wide, ground.x, ground.y);
    const inPath = pathMode === 'strict' ? inStrict : inWide;
    const approaching = Boolean(t.approaching && t.approachFrames >= minApproachFrames && inPath);
    const areaRatio = (t.bbox.w * t.bbox.h) / Math.max(1, w * h);
    const groundDistance = estimateGroundDistance(t.bbox, w, h, { cameraHeight, hfovDeg, horizonRatio });
    const useGround = distanceMode === 'ground' && groundDistance !== null;
    const distance = useGround ? groundDistance : estimateDistance(t.bbox, w, { hfovDeg });
    const distanceSource = useGround ? 'ground' : 'bbox';
    const dir = directionLabel(cx, w);

    let level = 0;
    if (approaching) level = 2;
    if (approaching && t.ttc !== null && t.ttc < 2) level = Math.max(level, 3);
    if (approaching && t.ttc !== null && t.ttc < 1) level = 4;
    if (approaching && areaRatio > 0.15) level = Math.max(level, 4);

    const path = [];
    for (let k = 1; k <= steps; k++) {
      path.push({
        x: cx + t.velocity.x * k,
        y: t.bbox.y + t.bbox.h * 0.5 + t.velocity.y * k,
        sigma: 2 * Math.sqrt(k),
      });
    }

    const item = {
      id: t.id,
      level,
      ttc: t.ttc,
      ttcSource: t.ttcSource,
      distance,
      distanceSource,
      groundDistance,
      direction: dir,
      strictStep: inStrict ? 1 : -1,
      wideStep: inWide ? 1 : -1,
      inPath,
      inStrict,
      inWide,
      areaRatio,
      bbox: { ...t.bbox },
      path,
      confirmed: true,
      cls: t.cls,
      className: t.className,
      samples: t.samples,
      hits: t.hits,
      age: t.age,
      flowMag: t.flowScale !== null ? t.flowScale - 1 : 0,
      approaching,
      areaRate: t.areaRate,
      centerRate: t.centerRate,
      flowScale: t.flowScale,
      flowPoints: t.flowPoints,
    };
    perTrack.push(item);

    if (level >= 2) {
      alerts.push({
        level,
        trackId: t.id,
        direction: dir,
        distance,
        ttc: t.ttc,
        text:
          level >= 4
            ? `${dir}约 ${distance.toFixed(1)} 米有目标快速逼近，请立即停下`
            : level === 3
              ? `${dir}约 ${distance.toFixed(1)} 米有目标持续逼近，请避让`
              : `${dir}有目标正在逼近，请留意`,
      });
    }
  }

  perTrack.sort((a, b) => b.level - a.level || (a.ttc ?? 99) - (b.ttc ?? 99));
  alerts.sort((a, b) => b.level - a.level || (a.ttc ?? 99) - (b.ttc ?? 99));

  const blocking = perTrack.filter((p) => p.level >= 3);
  let instruction = '前方通畅，可以直行';
  if (blocking.length) {
    const nearest = blocking[0];
    const side = nearest.bbox.x + nearest.bbox.w * 0.5 < w * 0.5 ? '右' : '左';
    instruction = nearest.level >= 4 ? '正前方危险，请立即停下等待' : `请向${side}侧避让`;
  } else if (perTrack.some((p) => p.level === 2)) {
    instruction = '前方有目标正在逼近，请减速留意';
  }

  return {
    corridor,
    perTrack,
    alerts,
    instruction,
    topAlert: alerts[0] ?? null,
  };
}

export { buildCorridor };
