// FAST-9 角点检测 + 非极大值抑制 + 网格均匀化。手写实现。

const CIRCLE_X = new Int8Array([0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3, -3, -3, -2, -1]);
const CIRCLE_Y = new Int8Array([-3, -3, -2, -1, 0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3]);

/**
 * @param {import('./image.js').GrayImage} img 已做轻度模糊的灰度图
 * @param {number} threshold 亮度差阈值
 * @param {number} maxFeatures 最大角点数
 * @returns {{count:number, pts:Float32Array, scores:Float32Array}}
 */
export function detectFast(img, threshold = 18, maxFeatures = 400) {
  const { w, h, data } = img;
  const t = threshold;
  const scores = new Float32Array(w * h);
  const margin = 4;
  const vals = new Float32Array(16);
  const bright = new Uint8Array(16);
  const dark = new Uint8Array(16);

  for (let y = margin; y < h - margin; y++) {
    const row = y * w;
    for (let x = margin; x < w - margin; x++) {
      const idx = row + x;
      const p = data[idx];
      // 高速测试：四个罗盘点至少 3 个同向超阈值
      const c0 = data[idx - 3 * w];
      const c4 = data[idx + 3];
      const c8 = data[idx + 3 * w];
      const c12 = data[idx - 3];
      let b = 0;
      let d = 0;
      if (c0 > p + t) b++; else if (c0 < p - t) d++;
      if (c4 > p + t) b++; else if (c4 < p - t) d++;
      if (c8 > p + t) b++; else if (c8 < p - t) d++;
      if (c12 > p + t) b++; else if (c12 < p - t) d++;
      if (b < 3 && d < 3) continue;

      let sumContrast = 0;
      let ok = false;
      for (let k = 0; k < 16; k++) {
        const v = data[idx + CIRCLE_Y[k] * w + CIRCLE_X[k]];
        vals[k] = v;
        bright[k] = v > p + t ? 1 : 0;
        dark[k] = v < p - t ? 1 : 0;
        const dv = Math.abs(v - p) - t;
        if (dv > 0) sumContrast += dv;
      }
      // 检查 9 个连续同向点
      for (let i = 0; i < 16 && !ok; i++) {
        if (bright[i]) {
          let run = 1;
          for (let k = 1; k < 9; k++) {
            if (!bright[(i + k) & 15]) break;
            run++;
          }
          if (run >= 9) ok = true;
        }
        if (!ok && dark[i]) {
          let run = 1;
          for (let k = 1; k < 9; k++) {
            if (!dark[(i + k) & 15]) break;
            run++;
          }
          if (run >= 9) ok = true;
        }
      }
      if (ok) scores[idx] = sumContrast;
    }
  }

  // 3x3 非极大值抑制
  const cand = [];
  for (let y = margin; y < h - margin; y++) {
    const row = y * w;
    for (let x = margin; x < w - margin; x++) {
      const idx = row + x;
      const s = scores[idx];
      if (s <= 0) continue;
      if (
        s >= scores[idx - 1] && s > scores[idx + 1] &&
        s >= scores[idx - w] && s > scores[idx + w] &&
        s >= scores[idx - w - 1] && s > scores[idx + w + 1] &&
        s >= scores[idx - w + 1] && s > scores[idx + w - 1]
      ) {
        cand.push(idx);
      }
    }
  }
  cand.sort((a, b) => scores[b] - scores[a]);

  const cell = Math.max(8, Math.sqrt((w * h) / Math.max(1, maxFeatures)) * 0.7);
  const minDist = cell * 0.9;
  const minDist2 = minDist * minDist;
  const grid = new Map();
  const kept = [];

  for (let c = 0; c < cand.length && kept.length < maxFeatures; c++) {
    const idx = cand[c];
    const x = idx % w;
    const y = (idx / w) | 0;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let suppressed = false;
    for (let gy = cy - 1; gy <= cy + 1 && !suppressed; gy++) {
      for (let gx = cx - 1; gx <= cx + 1 && !suppressed; gx++) {
        const bucket = grid.get(gy * 4096 + gx);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          const dx = (j % w) - x;
          const dy = ((j / w) | 0) - y;
          if (dx * dx + dy * dy < minDist2) {
            suppressed = true;
            break;
          }
        }
      }
    }
    if (suppressed) continue;
    kept.push(idx);
    const key = cy * 4096 + cx;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(idx);
  }

  const count = kept.length;
  const pts = new Float32Array(count * 2);
  const outScores = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const idx = kept[i];
    pts[2 * i] = idx % w;
    pts[2 * i + 1] = (idx / w) | 0;
    outScores[i] = scores[idx];
  }
  return { count, pts, scores: outScores };
}
