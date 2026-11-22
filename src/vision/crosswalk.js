// 斑马线检测：只找“多条平行白色横条”，用直线拟合把缺失段补上。
// 用户脚下点固定在画面底边中央；只判断左右偏离，不把“走到尽头”误报成偏离。

function isWhite(r, g, b) {
  return r > 140 && g > 140 && b > 140 && Math.max(r, g, b) - Math.min(r, g, b) < 45;
}

function linreg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { a: 0, b: ys[0] || 0 };
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
  const a = den > 1e-9 ? num / den : 0;
  return { a, b: my - a * mx };
}

/**
 * @param {{data:Uint8ClampedArray}} imageData
 * @param {number} w
 * @param {number} h
 * @param {{boxes?:Array<{x:number,y:number,w:number,h:number}>}} opts
 */
export function detectCrosswalk(imageData, w, h, opts = {}) {
  const data = imageData.data;
  const y0 = Math.floor(h * (opts.y0 ?? 0.48));
  const blocked = new Uint8Array(w * h);
  for (const b of opts.boxes || []) {
    const bx0 = Math.max(0, Math.floor(b.x) - 3);
    const bx1 = Math.min(w, Math.ceil(b.x + b.w) + 3);
    const by0 = Math.max(0, Math.floor(b.y) - 3);
    const by1 = Math.min(h, Math.ceil(b.y + b.h) + 3);
    for (let y = by0; y < by1; y++) blocked.fill(1, y * w + bx0, y * w + bx1);
  }

  const runs = [];
  const minRun = Math.max(16, Math.floor(w * 0.09));
  const stepY = Math.max(2, Math.round(h / 120));
  for (let y = y0; y < h; y += stepY) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const inside = x < w && !blocked[y * w + x];
      let white = false;
      if (inside) {
        const i = (y * w + x) * 4;
        white = isWhite(data[i], data[i + 1], data[i + 2]);
      }
      if (white && start < 0) start = x;
      if (!white && start >= 0) {
        const len = x - start;
        if (len >= minRun) runs.push({ x0: start, x1: x - 1, y, len });
        start = -1;
      }
    }
  }

  // 把相邻行的白色长条并成一条斑马线
  runs.sort((a, b) => a.y - b.y);
  const stripes = [];
  for (const run of runs) {
    let hit = null;
    for (const s of stripes) {
      if (Math.abs(s.y - run.y) > 5) continue;
      const ov = Math.min(s.x1, run.x1) - Math.max(s.x0, run.x0);
      if (ov > Math.min(s.x1 - s.x0, run.len) * 0.25) {
        hit = s;
        break;
      }
    }
    if (hit) {
      hit.count++;
      hit.x0 = Math.min(hit.x0, run.x0);
      hit.x1 = Math.max(hit.x1, run.x1);
      hit.y = (hit.y * (hit.count - 1) + run.y) / hit.count;
    } else {
      stripes.push({ x0: run.x0, x1: run.x1, y: run.y, count: 1 });
    }
  }

  const valid = stripes.filter(
    (s) => s.count >= 2 && s.x1 - s.x0 >= w * 0.12 && s.y >= h * 0.5 && s.x1 - s.x0 <= w * 0.95,
  );
  if (valid.length < (opts.minStripes ?? 4)) {
    return { active: false, off: false, complete: false, stripes: valid.length };
  }
  const ys = valid.map((s) => s.y);
  const yspan = Math.max(...ys) - Math.min(...ys);
  if (yspan < h * 0.06) return { active: false, off: false, complete: false, stripes: valid.length };

  const leftFit = linreg(ys, valid.map((s) => s.x0));
  const rightFit = linreg(ys, valid.map((s) => s.x1));
  const left = leftFit.a * h + leftFit.b;
  const right = rightFit.a * h + rightFit.b;
  const half = (right - left) * 0.5;
  if (!(half > w * 0.04)) return { active: false, off: false, complete: false, stripes: valid.length };
  const center = (left + right) * 0.5;
  const margin = opts.margin ?? 0.15;
  const off = Math.abs(w * 0.5 - center) > half * (1 + margin);
  // side 表示“人偏向哪一侧”：拟合带在画面左侧说明人偏右，反之偏左。
  const side = off ? (center < w * 0.5 ? 'right' : 'left') : null;
  return {
    active: true,
    off,
    side,
    complete: false,
    left,
    right,
    center,
    stripes: valid.length,
    yspan,
  };
}

export class CrosswalkTracker {
  constructor(opts = {}) {
    this.opts = { confirmFrames: 2, offFrames: 2, holdMs: 1200, cooldownMs: 4000, ...opts };
    this.activeStreak = 0;
    this.offStreak = 0;
    this.activeUntil = 0;
    this.lastAlertAt = 0;
  }

  reset() {
    this.activeStreak = 0;
    this.offStreak = 0;
    this.activeUntil = 0;
    this.lastAlertAt = 0;
  }

  update(result, nowMs) {
    if (result.active) this.activeStreak++;
    else this.activeStreak = 0;
    if (this.activeStreak >= this.opts.confirmFrames) this.activeUntil = nowMs + this.opts.holdMs;
    const active = nowMs <= this.activeUntil;
    if (active && result.off) this.offStreak++;
    else this.offStreak = 0;
    const off = active && this.offStreak >= this.opts.offFrames;
    let alert = false;
    if (off && nowMs - this.lastAlertAt >= this.opts.cooldownMs) {
      alert = true;
      this.lastAlertAt = nowMs;
    }
    return { ...result, active, off, alert };
  }
}
