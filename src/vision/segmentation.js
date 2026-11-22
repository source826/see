// 运动分层：对“全部 valid 光流对应点”做顺序 RANSAC，把场景拆成
// 背景平面层（相机自运动）与若干独立运动刚体层；无法被任何层解释的残差点
// 再按空间+运动一致性聚类成运动目标。
//
// 硬约束：拟合只使用全量 valid 对应点（或上一层已解释后剩余的全部点）。
// 严禁按 TTC、距离、图像 ROI、前景概率等先验挑点后再拟合。

import { ransacHomography } from './ransac.js';
import { applyH, mat3Inv } from '../math/matrix.js';

function bboxOf(pts, indices, w, h, pad = 4) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const x = pts[2 * i];
    const y = pts[2 * i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  let x0 = minX - pad;
  let y0 = minY - pad;
  let x1 = maxX + pad;
  let y1 = maxY + pad;
  if (w) {
    x0 = Math.max(0, x0);
    x1 = Math.min(w - 1, x1);
  }
  if (h) {
    y0 = Math.max(0, y0);
    y1 = Math.min(h - 1, y1);
  }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function flowStats(src, dst, indices) {
  let sx = 0;
  let sy = 0;
  let mag = 0;
  let sq = 0;
  const n = indices.length;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    const fx = dst[2 * i] - src[2 * i];
    const fy = dst[2 * i + 1] - src[2 * i + 1];
    sx += fx;
    sy += fy;
    const m = Math.hypot(fx, fy);
    mag += m;
    sq += m * m;
  }
  const mx = sx / Math.max(1, n);
  const my = sy / Math.max(1, n);
  const meanMag = mag / Math.max(1, n);
  const variance = Math.max(0, sq / Math.max(1, n) - meanMag * meanMag);
  return { mx, my, meanMag, stdMag: Math.sqrt(variance) };
}

function residualMeanOf(src, dst, H, indices) {
  let sum = 0;
  let cnt = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const p = applyH(H, src[2 * i], src[2 * i + 1]);
    if (!p) continue;
    sum += Math.hypot(p.x - dst[2 * i], p.y - dst[2 * i + 1]);
    cnt++;
  }
  return cnt ? sum / cnt : Infinity;
}

function clusterLeftovers(src, dst, residual, leftover, threshold, opts, w, h) {
  const cell = opts.cellSize ?? 24;
  const motionTol = opts.motionTolerance ?? 4;
  const minPts = opts.minObjectPoints ?? 6;
  const maxLinkDist = cell * 1.8;
  const maxLinkDist2 = maxLinkDist * maxLinkDist;

  const parent = new Int32Array(src.length >> 1);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const grid = new Map();
  for (let k = 0; k < leftover.length; k++) {
    const i = leftover[k];
    const cx = Math.floor(src[2 * i] / cell);
    const cy = Math.floor(src[2 * i + 1] / cell);
    const key = cy * 4096 + cx;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }

  for (let k = 0; k < leftover.length; k++) {
    const i = leftover[k];
    const cx = Math.floor(src[2 * i] / cell);
    const cy = Math.floor(src[2 * i + 1] / cell);
    for (let gy = cy; gy <= cy + 1; gy++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        if (gy === cy && gx < cx) continue;
        const bucket = grid.get(gy * 4096 + gx);
        if (!bucket) continue;
        for (let m = 0; m < bucket.length; m++) {
          const j = bucket[m];
          if (j <= i) continue;
          const di = 2 * i;
          const dj = 2 * j;
          const dx = src[di] - src[dj];
          const dy = src[di + 1] - src[dj + 1];
          if (dx * dx + dy * dy > maxLinkDist2) continue;
          const fxi = dst[di] - src[di];
          const fyi = dst[di + 1] - src[di + 1];
          const fxj = dst[dj] - src[dj];
          const fyj = dst[dj + 1] - src[dj + 1];
          if (Math.hypot(fxi - fxj, fyi - fyj) > motionTol) continue;
          if (Math.abs(residual[i] - residual[j]) > threshold * 2) continue;
          union(i, j);
        }
      }
    }
  }

  const groups = new Map();
  for (let k = 0; k < leftover.length; k++) {
    const i = leftover[k];
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = [];
      groups.set(r, g);
    }
    g.push(i);
  }

  const raw = [];
  for (const indices of groups.values()) {
    if (indices.length < minPts) continue;
    const stats = flowStats(src, dst, indices);
    let res = 0;
    for (let k = 0; k < indices.length; k++) res += residual[indices[k]];
    raw.push({
      indices,
      count: indices.length,
      bbox: bboxOf(src, indices, w, h),
      meanFlow: { x: stats.mx, y: stats.my },
      flowMag: stats.meanMag,
      flowStd: stats.stdMag,
      residualMean: res / indices.length,
      confidence: Math.min(1, indices.length / 16),
      source: 'residual-cluster',
    });
  }

  // 相近且运动一致的簇合并
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < raw.length && !merged; a++) {
      for (let b = a + 1; b < raw.length && !merged; b++) {
        const A = raw[a].bbox;
        const B = raw[b].bbox;
        const gapX = Math.max(0, Math.max(A.x - (B.x + B.w), B.x - (A.x + A.w)));
        const gapY = Math.max(0, Math.max(A.y - (B.y + B.h), B.y - (A.y + A.h)));
        const flowDiff = Math.hypot(
          raw[a].meanFlow.x - raw[b].meanFlow.x,
          raw[a].meanFlow.y - raw[b].meanFlow.y,
        );
        if (gapX < 10 && gapY < 10 && flowDiff < 3.5) {
          const indices = raw[a].indices.concat(raw[b].indices);
          const stats = flowStats(src, dst, indices);
          let res = 0;
          for (let k = 0; k < indices.length; k++) res += residual[indices[k]];
          raw[a] = {
            indices,
            count: indices.length,
            bbox: bboxOf(src, indices, w, h),
            meanFlow: { x: stats.mx, y: stats.my },
            flowMag: stats.meanMag,
            flowStd: stats.stdMag,
            residualMean: res / indices.length,
            confidence: Math.min(1, indices.length / 16),
            source: 'residual-cluster',
          };
          raw.splice(b, 1);
          merged = true;
        }
      }
    }
  }
  return raw;
}

/**
 * @param {Float32Array} src 上一帧全部 valid 点
 * @param {Float32Array} dst 当前帧全部 valid 点
 */
export function segmentScene(src, dst, opts = {}) {
  const n = src.length >> 1;
  const threshold = opts.threshold ?? 2.5;
  const maxLayers = opts.maxLayers ?? 3;
  const minLayerInliers = opts.minLayerInliers ?? Math.max(12, Math.round(n * 0.12));
  const w = opts.width ?? 0;
  const h = opts.height ?? 0;

  // 全量 valid 点，不做任何 TTC/距离/区域预筛选
  let remaining = new Uint32Array(n);
  for (let i = 0; i < n; i++) remaining[i] = i;

  const layers = [];
  let bg = null;
  let totalIterations = 0;

  for (let li = 0; li < maxLayers && remaining.length >= 8; li++) {
    const need = li === 0 ? Math.max(8, Math.round(minLayerInliers * 0.6)) : minLayerInliers;
    const r = ransacHomography(src, dst, {
      indices: remaining,
      threshold,
      maxIters: li === 0 ? (opts.maxIters ?? 500) : (opts.maxItersSecondary ?? 250),
      minInliers: need,
      confidence: opts.confidence ?? 0.999,
      seed: (opts.seed ?? 20260101) + li * 7919,
    });
    if (!r) break;
    totalIterations += r.iterations;

    const inSet = new Uint8Array(n);
    for (let k = 0; k < r.inlierIndices.length; k++) inSet[r.inlierIndices[k]] = 1;
    const rest = [];
    for (let k = 0; k < remaining.length; k++) {
      const i = remaining[k];
      if (!inSet[i]) rest.push(i);
    }

    const stats = flowStats(src, dst, r.inlierIndices);
    const layer = {
      id: li,
      type: li === 0 ? 'background' : 'rigid',
      isBackground: li === 0,
      H: r.H,
      Hinv: r.Hinv,
      indices: r.inlierIndices,
      count: r.count,
      inlierRatio: r.inlierRatio,
      errorRMS: r.errorRMS,
      iterations: r.iterations,
      bbox: bboxOf(src, r.inlierIndices, w, h),
      meanFlow: { x: stats.mx, y: stats.my },
      flowMag: stats.meanMag,
      flowStd: stats.stdMag,
      residualMean: residualMeanOf(src, dst, r.H, r.inlierIndices),
      confidence: Math.min(1, r.count / Math.max(1, minLayerInliers * 2)),
    };
    layers.push(layer);
    if (li === 0) bg = layer;
    remaining = Uint32Array.from(rest);
  }

  // 相对背景模型的残差：用于识别独立运动/非平面结构
  const residual = new Float32Array(n).fill(Infinity);
  if (bg) {
    for (let i = 0; i < n; i++) {
      const p = applyH(bg.H, src[2 * i], src[2 * i + 1]);
      if (p) residual[i] = Math.hypot(p.x - dst[2 * i], p.y - dst[2 * i + 1]);
    }
  }

  // 未被任何层解释、且残差显著的点
  const explained = new Uint8Array(n);
  for (let li = 0; li < layers.length; li++) {
    const idx = layers[li].indices;
    for (let k = 0; k < idx.length; k++) explained[idx[k]] = 1;
  }
  const leftover = [];
  const residualThreshold = opts.residualThreshold ?? threshold * 2;
  for (let i = 0; i < n; i++) {
    if (!explained[i] && residual[i] > residualThreshold) leftover.push(i);
  }

  const objects = clusterLeftovers(src, dst, residual, leftover, threshold, opts, w, h);

  // 非背景的刚体层同样是运动目标。大面积层多为墙面/地面等另一平面，默认不作为目标；
  // 但若它与背景运动明显不同（如横穿的大车），仍保留为目标，避免漏报。
  const suppressed = [];
  for (let li = 1; li < layers.length; li++) {
    const L = layers[li];
    if (w && h) {
      const areaRatio = (L.bbox.w * L.bbox.h) / (w * h);
      const spans = L.bbox.w > w * 0.75 || L.bbox.h > h * 0.85;
      if (areaRatio > 0.38 || spans) {
        const tol = opts.planarFlowTolerance ?? 6;
        const dx = bg ? L.meanFlow.x - bg.meanFlow.x : L.meanFlow.x;
        const dy = bg ? L.meanFlow.y - bg.meanFlow.y : L.meanFlow.y;
        const flowDiff = Math.hypot(dx, dy);
        const lowerHalf = L.bbox.y + L.bbox.h > h * 0.55;
        const independent = flowDiff > tol || Math.abs(dx) > tol * 1.4;
        if (!(independent && lowerHalf)) {
          suppressed.push({ layerId: li, areaRatio, flowDiff, reason: 'large-planar' });
          continue;
        }
      }
    }
    const stats = flowStats(src, dst, L.indices);
    objects.push({
      indices: L.indices,
      count: L.count,
      bbox: L.bbox,
      meanFlow: L.meanFlow,
      flowMag: L.flowMag,
      flowStd: stats.stdMag,
      residualMean: L.residualMean,
      confidence: L.confidence,
      source: 'rigid-layer',
      layerId: li,
    });
  }

  let bgResidualSum = 0;
  let bgResidualCnt = 0;
  if (bg) {
    for (let k = 0; k < bg.indices.length; k++) {
      bgResidualSum += residual[bg.indices[k]];
      bgResidualCnt++;
    }
  }

  return {
    layers,
    objects,
    bg,
    residual,
    leftover,
    stats: {
      points: n,
      validPoints: n,
      layerCount: layers.length,
      bgInliers: bg ? bg.count : 0,
      bgInlierRatio: bg ? bg.count / Math.max(1, n) : 0,
      bgResidualMean: bgResidualCnt ? bgResidualSum / bgResidualCnt : Infinity,
      objectCount: objects.length,
      suppressedLayers: suppressed.length,
      ransacIterations: totalIterations,
      threshold,
    },
  };
}
