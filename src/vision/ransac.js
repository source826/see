// 单应矩阵 RANSAC：自适应迭代次数 + 局部优化 + 确定性随机源。
import { estimateHomography, mat3Inv, symmetricError } from '../math/matrix.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 估计单应矩阵并做 RANSAC。
 * @param {Float32Array} src 上一帧点 (x,y,...)
 * @param {Float32Array} dst 当前帧点
 * @param {object} opts
 */
export function ransacHomography(src, dst, opts = {}) {
  const n = src.length >> 1;
  const indices = opts.indices ?? null;
  const listLen = indices ? indices.length : n;
  if (listLen < 4) return null;

  const threshold = opts.threshold ?? 2.5;
  const maxIters = opts.maxIters ?? 500;
  const confidence = opts.confidence ?? 0.999;
  const minInliers = opts.minInliers ?? 8;
  const rand = mulberry32(opts.seed ?? 20260101);

  const sample = new Uint32Array(4);
  const sampleIdx = new Uint32Array(4);
  let best = null;
  let needed = maxIters;

  for (let it = 0; it < needed && it < maxIters; it++) {
    for (let s = 0; s < 4; s++) {
      let pos;
      let dup;
      do {
        pos = (rand() * listLen) | 0;
        if (pos >= listLen) pos = listLen - 1;
        dup = false;
        for (let k = 0; k < s; k++) if (sample[k] === pos) dup = true;
      } while (dup);
      sample[s] = pos;
      sampleIdx[s] = indices ? indices[pos] : pos;
    }

    const H = estimateHomography(src, dst, sampleIdx);
    if (!H) continue;
    const Hinv = mat3Inv(H);
    if (!Hinv) continue;

    // 退化检查：单应不应把点压成一线或极大放大
    let degenerate = false;
    for (let s = 0; s < 4 && !degenerate; s++) {
      const i = sampleIdx[s];
      const p = symmetricError(H, Hinv, src[2 * i], src[2 * i + 1], dst[2 * i], dst[2 * i + 1]);
      if (!Number.isFinite(p) || p > threshold * 2) degenerate = true;
    }
    if (degenerate) continue;

    const mask = new Uint8Array(listLen);
    const inlierIndices = [];
    let count = 0;
    let errSum = 0;
    for (let k = 0; k < listLen; k++) {
      const i = indices ? indices[k] : k;
      const e = symmetricError(H, Hinv, src[2 * i], src[2 * i + 1], dst[2 * i], dst[2 * i + 1]);
      if (e < threshold) {
        mask[k] = 1;
        inlierIndices.push(i);
        count++;
        errSum += e * e;
      }
    }
    if (!best || count > best.count) {
      best = { H, Hinv, mask, count, inlierIndices, errorRMS: Math.sqrt(errSum / Math.max(1, count)), iterations: it + 1 };
      const w = count / listLen;
      if (w > 0.001 && w < 1) {
        const p4 = w * w * w * w;
        const denom = Math.log(1 - p4);
        if (denom < -1e-12) {
          const need = Math.log(1 - confidence) / denom;
          if (Number.isFinite(need)) needed = Math.min(maxIters, Math.max(it + 1, Math.ceil(need)));
        }
      } else if (w >= 1) {
        needed = it + 1;
      }
    }
  }

  if (!best || best.count < minInliers) return null;

  // 局部优化：用全部内点重拟合两轮
  let model = best;
  for (let round = 0; round < 2; round++) {
    const refit = estimateHomography(src, dst, model.inlierIndices);
    if (!refit) break;
    const Hinv = mat3Inv(refit);
    if (!Hinv) break;
    const mask = new Uint8Array(listLen);
    const inlierIndices = [];
    let count = 0;
    let errSum = 0;
    for (let k = 0; k < listLen; k++) {
      const i = indices ? indices[k] : k;
      const e = symmetricError(refit, Hinv, src[2 * i], src[2 * i + 1], dst[2 * i], dst[2 * i + 1]);
      if (e < threshold) {
        mask[k] = 1;
        inlierIndices.push(i);
        count++;
        errSum += e * e;
      }
    }
    if (count < model.count) break;
    const improved = {
      H: refit,
      Hinv,
      mask,
      count,
      inlierIndices,
      errorRMS: Math.sqrt(errSum / Math.max(1, count)),
      iterations: model.iterations,
    };
    const unchanged = count === model.count && Math.abs(improved.errorRMS - model.errorRMS) < 1e-3;
    model = improved;
    if (unchanged) break;
  }

  return {
    H: model.H,
    Hinv: model.Hinv,
    inlierMask: model.mask,
    inlierIndices: model.inlierIndices,
    count: model.count,
    inlierRatio: model.count / listLen,
    errorRMS: model.errorRMS,
    iterations: model.iterations,
  };
}
