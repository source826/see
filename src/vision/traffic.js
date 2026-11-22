// 红绿灯：YOLO 给灯框，颜色用框内高饱和像素投票，连续 3 帧确认。
// 绿灯只提示“请确认行人信号”，不直接说“可以通行”，避免把机动车绿灯当成行人绿灯。

export function classifyTrafficLight(imageData, box, w, h) {
  const data = imageData.data;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(w, Math.ceil(box.x + box.w));
  const y1 = Math.min(h, Math.ceil(box.y + box.h));
  let red = 0;
  let green = 0;
  let yellow = 0;
  let total = 0;
  const stride = (x1 - x0) * (y1 - y0) > 2400 ? 2 : 1;
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      total++;
      if (r > 100 && r > g * 1.35 && r > b * 1.35 && r - Math.max(g, b) > 25) red++;
      else if (g > 80 && g > r * 1.15 && g > b * 1.15 && g - Math.max(r, b) > 15) green++;
      else if (r > 140 && g > 100 && b < 110 && r > b * 1.5 && g > b * 1.3 && Math.abs(r - g) < 90) yellow++;
    }
  }
  const minCount = Math.max(4, total * 0.03);
  const ranked = [
    ['red', red],
    ['green', green],
    ['yellow', yellow],
  ].sort((a, b) => b[1] - a[1]);
  const color = ranked[0][1] >= minCount && ranked[0][1] > ranked[1][1] * 1.2 ? ranked[0][0] : null;
  return { color, red, green, yellow, total };
}

export class TrafficLightTracker {
  constructor(opts = {}) {
    this.opts = { confirmFrames: 3, holdMs: 1500, cooldownMs: 5000, ...opts };
    this.color = null;
    this.streak = 0;
    this.activeUntil = 0;
    this.lastAlertAt = 0;
  }

  reset() {
    this.color = null;
    this.streak = 0;
    this.activeUntil = 0;
    this.lastAlertAt = 0;
  }

  update(lights, imageData, w, h, nowMs) {
    let best = null;
    for (const light of lights) {
      const result = classifyTrafficLight(imageData, light.bbox, w, h);
      if (!result.color) continue;
      const area = light.bbox.w * light.bbox.h;
      if (!best || area > best.area) best = { ...result, bbox: light.bbox, area };
    }
    if (best) {
      if (best.color === this.color) this.streak++;
      else {
        this.color = best.color;
        this.streak = 1;
      }
    } else {
      this.streak = 0;
    }
    if (this.streak >= this.opts.confirmFrames) this.activeUntil = nowMs + this.opts.holdMs;
    const color = nowMs <= this.activeUntil ? this.color : null;
    let alert = false;
    if (color && nowMs - this.lastAlertAt >= this.opts.cooldownMs) {
      alert = true;
      this.lastAlertAt = nowMs;
    }
    return { color, active: Boolean(color), alert, best };
  }
}
