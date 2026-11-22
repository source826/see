// 多目标跟踪：卡尔曼预测 + 相机自运动补偿 + 贪心数据关联。
import { applyH } from '../math/matrix.js';
import { boxCenter, boxIoU } from '../math/boxes.js';
import { KalmanCV } from './kalman.js';

class Track {
  constructor(id, det, frameIndex) {
    this.id = id;
    this.kf = new KalmanCV(det.bbox.x + det.bbox.w * 0.5, det.bbox.y + det.bbox.h * 0.5);
    this.bbox = { ...det.bbox };
    this.hits = 1;
    this.misses = 0;
    this.age = 1;
    this.confirmed = false;
    this.bornAt = frameIndex;
    this.sizeHistory = [det.bbox.h];
    this.flowMag = det.flowMag ?? 0;
    this.source = det.source ?? 'cluster';
    this.areaRatio = det.bbox.w * det.bbox.h;
  }

  predictEgo(bgH) {
    let dx = 0;
    let dy = 0;
    if (bgH) {
      const p = applyH(bgH, this.kf.x[0], this.kf.x[1]);
      if (p) {
        dx = p.x - this.kf.x[0];
        dy = p.y - this.kf.x[1];
      }
    }
    this.kf.predict(dx, dy);
  }

  update(det, minHits = 2) {
    const c = boxCenter(det.bbox);
    const sigma = Math.max(3, Math.min(14, 0.12 * Math.max(det.bbox.w, det.bbox.h)));
    this.kf.update(c.x, c.y, sigma);
    const a = 0.55;
    this.bbox = {
      x: this.bbox.x * (1 - a) + det.bbox.x * a,
      y: this.bbox.y * (1 - a) + det.bbox.y * a,
      w: this.bbox.w * (1 - a) + det.bbox.w * a,
      h: this.bbox.h * (1 - a) + det.bbox.h * a,
    };
    this.sizeHistory.push(det.bbox.h);
    if (this.sizeHistory.length > 12) this.sizeHistory.shift();
    this.flowMag = det.flowMag ?? 0;
    this.areaRatio = this.bbox.w * this.bbox.h;
    this.hits++;
    this.misses = 0;
    if (this.hits >= minHits) this.confirmed = true;
  }

  markMissed() {
    this.misses++;
    // 漏检时仅按自运动外推，速度项不额外积分
    this.bbox = {
      x: this.kf.x[0] - this.bbox.w * 0.5,
      y: this.kf.x[1] - this.bbox.h * 0.5,
      w: this.bbox.w,
      h: this.bbox.h,
    };
  }
}

export class Tracker {
  constructor(opts = {}) {
    this.maxMissed = opts.maxMissed ?? 6;
    this.maxDist = opts.maxDist ?? 90;
    // 安全优先：首次命中即可确认（recallFirst），否则需要连续 2 帧
    this.minHits = opts.minHits ?? 2;
    this.tracks = [];
    this.nextId = 1;
    this.frameIndex = 0;
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
    this.frameIndex = 0;
  }

  /** @param {Array} detections 运动分层输出的目标框 */
  update(detections, bgH, frameIndex) {
    this.frameIndex = frameIndex;
    for (const t of this.tracks) t.predictEgo(bgH);

    const pairs = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      const c = { x: t.kf.x[0], y: t.kf.x[1] };
      for (let di = 0; di < detections.length; di++) {
        const det = detections[di];
        const dc = boxCenter(det.bbox);
        const dist = Math.hypot(dc.x - c.x, dc.y - c.y);
        const diag = Math.hypot(t.bbox.w, t.bbox.h);
        const iou = boxIoU(t.bbox, det.bbox);
        const gate = Math.max(32, this.maxDist * 0.45 + diag * 0.8);
        if (dist > gate && iou < 0.04) continue;
        const cost = dist / Math.max(20, diag * 1.6) - iou * 1.2;
        pairs.push({ ti, di, cost });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);

    const trackUsed = new Uint8Array(this.tracks.length);
    const detUsed = new Uint8Array(detections.length);
    for (const p of pairs) {
      if (trackUsed[p.ti] || detUsed[p.di]) continue;
      trackUsed[p.ti] = 1;
      detUsed[p.di] = 1;
      this.tracks[p.ti].update(detections[p.di], this.minHits);
    }

    const alive = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      if (!trackUsed[ti]) {
        t.markMissed();
        if (t.misses > this.maxMissed) continue;
      }
      t.age++;
      alive.push(t);
    }
    this.tracks = alive;

    for (let di = 0; di < detections.length; di++) {
      if (detUsed[di]) continue;
      const t = new Track(this.nextId++, detections[di], frameIndex);
      this.tracks.push(t);
    }

    return this.tracks;
  }

  get confirmed() {
    return this.tracks.filter((t) => t.confirmed);
  }
}
