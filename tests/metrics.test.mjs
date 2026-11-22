import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFrame, summarizeDetections, trajectoryMetrics } from '../eval/metrics.js';

test('matchFrame 贪心 IoU 匹配', () => {
  const gt = [
    { id: 1, bbox: { x: 10, y: 10, w: 40, h: 40 } },
    { id: 2, bbox: { x: 100, y: 10, w: 40, h: 40 } },
  ];
  const pred = [
    { id: 7, bbox: { x: 12, y: 12, w: 40, h: 40 } },
    { id: 8, bbox: { x: 200, y: 200, w: 20, h: 20 } },
  ];
  const res = matchFrame(gt, pred, 0.5);
  assert.equal(res.matches.length, 1);
  assert.equal(res.unmatchedGt.length, 1);
  assert.equal(res.unmatchedPred.length, 1);
  assert.equal(gt[res.matches[0].gi].id, 1);
  assert.equal(pred[res.matches[0].pi].id, 7);
});

test('summarizeDetections 计算 MOTA / IDSW', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  const frames = [
    { gt: [{ id: 1, bbox: box }], pred: [{ id: 100, bbox: box }] },
    { gt: [{ id: 1, bbox: box }], pred: [{ id: 101, bbox: box }] },
  ];
  const r = summarizeDetections(frames, 0.5);
  assert.equal(r.tp, 2);
  assert.equal(r.fp, 0);
  assert.equal(r.fn, 0);
  assert.equal(r.idsw, 1);
  assert.ok(Math.abs(r.mota - (1 - 1 / 2)) < 1e-9);
  assert.ok(Math.abs(r.precision - 1) < 1e-9);
  assert.ok(Math.abs(r.recall - 1) < 1e-9);
});

test('trajectoryMetrics 对完全正确的预测给出 0 误差', () => {
  const gtCenters = new Map([[1, new Map([
    [0, { x: 10, y: 10 }],
    [1, { x: 12, y: 10 }],
    [2, { x: 14, y: 10 }],
  ])]]);
  const samples = [{
    frame: 0,
    trackId: 9,
    path: [{ x: 12, y: 10 }, { x: 14, y: 10 }],
  }];
  const matchByFrame = [];
  matchByFrame[0] = new Map([[9, 1]]);
  const r = trajectoryMetrics(samples, gtCenters, matchByFrame, 2, 100);
  assert.ok(r.ade !== null);
  assert.ok(r.ade < 1e-9);
  assert.ok(r.fde < 1e-9);
  assert.equal(r.count, 1);
});
