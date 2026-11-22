// 评测指标：检测/跟踪（MOTA/MOTP/IDSW）+ 轨迹预测（ADE/FDE）+ 耗时统计。
import { boxIoU, boxCenter } from '../src/math/boxes.js';

export function matchFrame(gt, pred, thresh = 0.5) {
  const pairs = [];
  for (let i = 0; i < gt.length; i++) {
    for (let j = 0; j < pred.length; j++) {
      const iou = boxIoU(gt[i].bbox, pred[j].bbox);
      if (iou >= thresh) pairs.push({ gi: i, pi: j, iou });
    }
  }
  pairs.sort((a, b) => b.iou - a.iou);
  const gtUsed = new Uint8Array(gt.length);
  const predUsed = new Uint8Array(pred.length);
  const matches = [];
  for (const p of pairs) {
    if (gtUsed[p.gi] || predUsed[p.pi]) continue;
    gtUsed[p.gi] = 1;
    predUsed[p.pi] = 1;
    matches.push(p);
  }
  const unmatchedGt = [];
  const unmatchedPred = [];
  for (let i = 0; i < gt.length; i++) if (!gtUsed[i]) unmatchedGt.push(i);
  for (let j = 0; j < pred.length; j++) if (!predUsed[j]) unmatchedPred.push(j);
  return { matches, unmatchedGt, unmatchedPred };
}

/**
 * @param {Array<{gt:Array, pred:Array}>} frames 已按帧对齐的 GT / 预测框
 */
export function summarizeDetections(frames, thresh = 0.5) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let idsw = 0;
  let iouSum = 0;
  const lastMatch = new Map();
  const perFrame = [];

  for (let f = 0; f < frames.length; f++) {
    const { gt, pred } = frames[f];
    const { matches, unmatchedGt, unmatchedPred } = matchFrame(gt, pred, thresh);
    tp += matches.length;
    fp += unmatchedPred.length;
    fn += unmatchedGt.length;
    for (const m of matches) {
      iouSum += m.iou;
      const gtId = gt[m.gi].id;
      const predId = pred[m.pi].id;
      if (lastMatch.has(gtId) && lastMatch.get(gtId) !== predId) idsw++;
      lastMatch.set(gtId, predId);
    }
    perFrame.push({
      frame: f,
      gt: gt.length,
      pred: pred.length,
      tp: matches.length,
      fp: unmatchedPred.length,
      fn: unmatchedGt.length,
    });
  }

  const gtCount = tp + fn;
  const predCount = tp + fp;
  const precision = predCount ? tp / predCount : 0;
  const recall = gtCount ? tp / gtCount : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const mota = gtCount ? 1 - (fn + fp + idsw) / gtCount : 0;
  const motp = tp ? iouSum / tp : 0;

  return { tp, fp, fn, idsw, gtCount, predCount, precision, recall, f1, mota, motp, perFrame };
}

/**
 * @param {Array<{frame:number, trackId:number, path:Array<{x:number,y:number}>}>} samples
 * @param {Map<string|number, Map<number,{x:number,y:number}>>} gtCenters
 * @param {Array<Map<number,string|number>>} matchByFrame frame -> (predId -> gtId)
 */
export function trajectoryMetrics(samples, gtCenters, matchByFrame, horizon = 10, imageDiag = 1) {
  let adeSum = 0;
  let adeCount = 0;
  let fdeSum = 0;
  let fdeCount = 0;
  let samplesUsed = 0;
  const perStep = [];

  for (const s of samples) {
    const frameMatch = matchByFrame[s.frame];
    if (!frameMatch) continue;
    const gtId = frameMatch.get(s.trackId);
    if (gtId === undefined) continue;
    const centers = gtCenters.get(gtId);
    if (!centers) continue;
    let used = false;
    for (let k = 1; k <= Math.min(horizon, s.path.length); k++) {
      const c = centers.get(s.frame + k);
      if (!c) continue;
      const err = Math.hypot(s.path[k - 1].x - c.x, s.path[k - 1].y - c.y);
      adeSum += err;
      adeCount++;
      used = true;
      if (!perStep[k - 1]) perStep[k - 1] = { sum: 0, count: 0 };
      perStep[k - 1].sum += err;
      perStep[k - 1].count++;
      if (k === horizon) {
        fdeSum += err;
        fdeCount++;
      }
    }
    if (used) samplesUsed++;
  }

  return {
    ade: adeCount ? adeSum / adeCount : null,
    fde: fdeCount ? fdeSum / fdeCount : null,
    adeNorm: adeCount ? (adeSum / adeCount) / imageDiag : null,
    fdeNorm: fdeCount ? (fdeSum / fdeCount) / imageDiag : null,
    count: samplesUsed,
    perStep: perStep.map((p, i) => ({ step: i + 1, error: p ? p.sum / p.count : null, count: p ? p.count : 0 })),
  };
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export function timingSummary(timings) {
  const pick = (k) => timings.map((t) => t[k]);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const total = pick('total');
  return {
    totalMean: mean(total),
    totalP95: percentile(total, 95),
    grayMean: mean(pick('gray')),
    pyramidMean: mean(pick('pyramid')),
    flowMean: mean(pick('flow')),
    segmentMean: mean(pick('segment')),
    trackMean: mean(pick('track')),
    detectMean: mean(pick('detect')),
  };
}

export function gtCentersOf(gtDoc) {
  const centers = new Map();
  for (const key of Object.keys(gtDoc.frames)) {
    const f = Number(key);
    const boxes = gtDoc.frames[key] || [];
    for (const b of boxes) {
      let m = centers.get(b.id);
      if (!m) {
        m = new Map();
        centers.set(b.id, m);
      }
      m.set(f, { x: b.x + b.w * 0.5, y: b.y + b.h * 0.5 });
    }
  }
  return centers;
}

export function boxCenterSafe(b) {
  return boxCenter(b);
}
