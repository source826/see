import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyH,
  estimateHomography,
  fixedPointOfH,
  mat3Inv,
  solveLinear,
  symmetricError,
} from '../src/math/matrix.js';

test('solveLinear 解 2x2 线性方程', () => {
  const A = new Float64Array([2, 1, 1, 3]);
  const b = new Float64Array([3, 5]);
  const x = solveLinear(A, b, 2);
  assert.ok(x);
  assert.ok(Math.abs(x[0] - 0.8) < 1e-12);
  assert.ok(Math.abs(x[1] - 1.4) < 1e-12);
});

test('estimateHomography 精确恢复已知单应', () => {
  const H = new Float64Array([1.08, 0.16, 14, -0.04, 1.19, -9, 0.00035, -0.00028, 1]);
  const pts = [
    [10, 20], [210, 26], [190, 160], [24, 148], [100, 84], [50, 60], [180, 90],
  ];
  const n = pts.length;
  const src = new Float32Array(n * 2);
  const dst = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    src[2 * i] = pts[i][0];
    src[2 * i + 1] = pts[i][1];
    const p = applyH(H, pts[i][0], pts[i][1]);
    dst[2 * i] = p.x;
    dst[2 * i + 1] = p.y;
  }
  const idx = [...Array(n).keys()];
  const Hest = estimateHomography(src, dst, idx);
  assert.ok(Hest, '应返回单应矩阵');
  for (let i = 0; i < n; i++) {
    const p = applyH(Hest, src[2 * i], src[2 * i + 1]);
    assert.ok(Math.hypot(p.x - dst[2 * i], p.y - dst[2 * i + 1]) < 1e-4);
  }
});

test('mat3Inv 与 applyH 往返一致', () => {
  const H = new Float64Array([1.2, 0.1, 30, -0.03, 0.95, -12, 0.0002, 0.0001, 1]);
  const inv = mat3Inv(H);
  assert.ok(inv);
  const p = applyH(H, 123, 77);
  const q = applyH(inv, p.x, p.y);
  assert.ok(Math.hypot(q.x - 123, q.y - 77) < 1e-8);
});

test('fixedPointOfH 求缩放中心', () => {
  const cx = 160;
  const cy = 120;
  const s = 1.12;
  const H = new Float64Array([s, 0, cx - s * cx, 0, s, cy - s * cy, 0, 0, 1]);
  const f = fixedPointOfH(H);
  assert.ok(f);
  assert.ok(Math.abs(f.x - cx) < 1e-6);
  assert.ok(Math.abs(f.y - cy) < 1e-6);
});

test('symmetricError 对精确对应为零', () => {
  const H = new Float64Array([1.05, 0.02, 8, -0.01, 1.03, -5, 0.0001, 0.0002, 1]);
  const inv = mat3Inv(H);
  const p = applyH(H, 100, 50);
  const e = symmetricError(H, inv, 100, 50, p.x, p.y);
  assert.ok(e < 1e-8);
});
