// 地形提醒：台阶用画面水平边缘周期检测；上/下坡用手机姿态俯仰变化。
// 策略是“宁可多报，不要漏报”：阈值偏低，连续 2 帧确认，持续 1.2s 保持。

/**
 * 台阶检测：在下方中央 ROI 统计逐行垂直梯度，寻找等间距的水平边缘峰。
 * @param {{w:number,h:number,data:Float32Array}} gray
 * @param {object} opts
 * @returns {{stairs:boolean, peaks:number, cv:number|null, score:number}}
 */
export function detectStairs(gray, opts = {}) {
  const { w, h, data } = gray;
  const x0 = Math.max(2, Math.floor(w * (opts.x0 ?? 0.18)));
  const x1 = Math.min(w - 2, Math.floor(w * (opts.x1 ?? 0.82)));
  const y0 = Math.max(4, Math.floor(h * (opts.y0 ?? 0.42)));
  const y1 = Math.min(h - 2, Math.floor(h * (opts.y1 ?? 0.96)));
  if (x1 - x0 < 20 || y1 - y0 < 30) return { stairs: false, peaks: 0, cv: null, score: 0 };

  const row = new Float32Array(y1 - y0);
  for (let y = y0; y < y1; y++) {
    let sum = 0;
    const idx = y * w;
    for (let x = x0; x < x1; x++) {
      const i = idx + x;
      sum += Math.abs(data[i + w] - data[i - w]);
    }
    row[y - y0] = sum / (x1 - x0);
  }

  // 5 点平滑，抑制单行噪声
  const smooth = new Float32Array(row.length);
  for (let i = 0; i < row.length; i++) {
    let s = 0;
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= row.length) continue;
      s += row[j];
      n++;
    }
    smooth[i] = s / Math.max(1, n);
  }

  let mean = 0;
  for (let i = 0; i < smooth.length; i++) mean += smooth[i];
  mean /= smooth.length;
  let varSum = 0;
  for (let i = 0; i < smooth.length; i++) varSum += (smooth[i] - mean) ** 2;
  const std = Math.sqrt(varSum / smooth.length);
  const threshold = mean + (opts.peakStd ?? 0.5) * std;

  const peaks = [];
  for (let i = 2; i < smooth.length - 2; i++) {
    if (smooth[i] < threshold) continue;
    if (smooth[i] < smooth[i - 1] || smooth[i] <= smooth[i + 1]) continue;
    if (!peaks.length || i - peaks[peaks.length - 1] >= (opts.minPeakGap ?? 3)) peaks.push(i);
  }

  let cv = null;
  if (peaks.length >= 3) {
    const diffs = [];
    for (let i = 1; i < peaks.length; i++) diffs.push(peaks[i] - peaks[i - 1]);
    const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const v = diffs.reduce((a, b) => a + (b - m) ** 2, 0) / diffs.length;
    cv = m > 0 ? Math.sqrt(v) / m : null;
  }

  const minPeaks = opts.minPeaks ?? 6;
  const maxCv = opts.maxCv ?? 0.7;
  const stairs = peaks.length >= minPeaks && cv !== null && cv <= maxCv;
  const score = stairs ? Math.min(1, peaks.length / 12) * (1 - Math.min(1, cv)) : 0;
  return { stairs, peaks: peaks.length, cv, score };
}

/** 手机俯仰变化 → 上坡/下坡。beta 增大视为相机上仰（上坡），减小视为下俯（下坡）。 */
export function classifyPitchChange(baseline, pitch, opts = {}) {
  if (!Number.isFinite(baseline) || !Number.isFinite(pitch)) return null;
  const delta = pitch - baseline;
  const strong = opts.strongDeg ?? 7;
  const weak = opts.weakDeg ?? 3.5;
  if (delta >= strong) return 'up';
  if (delta <= -strong) return 'down';
  if (Math.abs(delta) >= weak) return 'unknown';
  return null;
}

export class TerrainTracker {
  constructor(opts = {}) {
    this.opts = {
      confirmFrames: 2,
      holdMs: 1200,
      ...opts,
    };
    this.streak = 0;
    this.activeUntil = 0;
  }

  reset() {
    this.streak = 0;
    this.activeUntil = 0;
  }

  update(gray, nowMs) {
    const r = detectStairs(gray, this.opts);
    if (r.stairs) this.streak++;
    else this.streak = 0;
    if (this.streak >= this.opts.confirmFrames) this.activeUntil = nowMs + this.opts.holdMs;
    return {
      ...r,
      stairs: nowMs <= this.activeUntil,
      streak: this.streak,
    };
  }
}
