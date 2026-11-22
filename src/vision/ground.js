// 地面小障碍：只处理 YOLO 现有类别（香蕉/苹果/橘子/瓶子/杯子/固定障碍）。
// 石墩子、西瓜皮等没有 COCO 类，当前只能归入“固定障碍/异物”或后续换模型。

export const GROUND_CLASSES = new Map([
  [10, '固定障碍'],
  [39, '瓶子'],
  [41, '杯子'],
  [46, '香蕉皮'],
  [47, '水果皮'],
  [49, '水果皮'],
]);

function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export class GroundObstacleTracker {
  constructor(opts = {}) {
    this.opts = {
      minHits: 3,
      holdMs: 1500,
      cooldownMs: 5000,
      maxAreaRatio: 0.12,
      minBottomRatio: 0.5,
      ...opts,
    };
    this.tracks = [];
    this.lastAlertAt = 0;
  }

  reset() {
    this.tracks = [];
    this.lastAlertAt = 0;
  }

  update(dets, { w, h, nowMs }) {
    const valid = [];
    for (const d of dets) {
      if (!GROUND_CLASSES.has(d.cls)) continue;
      const box = d.bbox;
      const area = box.w * box.h;
      const bottom = box.y + box.h;
      const cx = box.x + box.w * 0.5;
      if (bottom < h * this.opts.minBottomRatio) continue;
      if (area > w * h * this.opts.maxAreaRatio) continue;
      if (cx < w * 0.18 || cx > w * 0.82) continue;
      valid.push(d);
    }

    for (const t of this.tracks) t.matched = false;
    for (const d of valid) {
      let best = null;
      let bestIou = 0.2;
      for (const t of this.tracks) {
        if (t.matched) continue;
        const v = iou(t.bbox, d.bbox);
        if (v > bestIou) {
          best = t;
          bestIou = v;
        }
      }
      if (best) {
        best.bbox = { ...d.bbox };
        best.cls = d.cls;
        best.hits++;
        best.lastSeen = nowMs;
        best.matched = true;
      } else {
        this.tracks.push({ bbox: { ...d.bbox }, cls: d.cls, hits: 1, lastSeen: nowMs, matched: true });
      }
    }
    this.tracks = this.tracks.filter((t) => t.matched || nowMs - t.lastSeen <= this.opts.holdMs);

    let active = null;
    for (const t of this.tracks) {
      if (t.hits < this.opts.minHits) continue;
      if (nowMs - t.lastSeen > this.opts.holdMs) continue;
      if (!active || t.bbox.y + t.bbox.h > active.bbox.y + active.bbox.h) active = t;
    }
    let alert = false;
    if (active && nowMs - this.lastAlertAt >= this.opts.cooldownMs) {
      alert = true;
      this.lastAlertAt = nowMs;
    }
    const label = active ? GROUND_CLASSES.get(active.cls) : null;
    return {
      active: Boolean(active),
      alert,
      label,
      text: active ? `前方地面有${label}，请小心` : null,
      bbox: active ? { ...active.bbox } : null,
      hits: active ? active.hits : 0,
    };
  }
}
