import test from 'node:test';
import assert from 'node:assert/strict';
import { applyH } from '../src/math/matrix.js';
import { mulberry32, ransacHomography } from '../src/vision/ransac.js';
import { segmentScene } from '../src/vision/segmentation.js';

function makeGaussian(rand) {
  return () => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

test('RANSAC 在 30% 外点下恢复主平面（算法单测，非场景数据）', () => {
  const rand = mulberry32(42);
  const gauss = makeGaussian(rand);
  const H = new Float64Array([1.02, 0.05, 6, -0.03, 0.99, -4, 0.00008, 0.00006, 1]);
  const N = 140;
  const outRatio = 0.3;
  const src = new Float32Array(N * 2);
  const dst = new Float32Array(N * 2);
  const isOutlier = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = 10 + rand() * 300;
    const y = 10 + rand() * 220;
    src[2 * i] = x;
    src[2 * i + 1] = y;
    if (i >= N * (1 - outRatio)) {
      isOutlier[i] = 1;
      dst[2 * i] = 5 + rand() * 310;
      dst[2 * i + 1] = 5 + rand() * 230;
    } else {
      const p = applyH(H, x, y);
      dst[2 * i] = p.x + gauss() * 0.45;
      dst[2 * i + 1] = p.y + gauss() * 0.45;
    }
  }
  const res = ransacHomography(src, dst, {
    threshold: 2,
    maxIters: 1200,
    minInliers: 50,
    confidence: 0.999,
    seed: 7,
  });
  assert.ok(res, 'RANSAC 应成功');
  assert.ok(res.count >= 0.85 * N * (1 - outRatio), `内点数量不足: ${res.count}`);
  assert.ok(res.errorRMS < 1.2, `重投影误差过大: ${res.errorRMS}`);
  let outlierIn = 0;
  for (const i of res.inlierIndices) if (isOutlier[i]) outlierIn++;
  assert.ok(outlierIn <= 6, `外点混入过多: ${outlierIn}`);
});

test('运动分层把两个刚体运动拆成两层', () => {
  const rand = mulberry32(9);
  const gauss = makeGaussian(rand);
  const H1 = new Float64Array([1.0, 0.2, 25, -0.1, 1.02, 3, 0.0001, 0.0002, 1]);
  const H2 = new Float64Array([1.0, 0.0, 2, 0.0, 1.0, 14, 0, 0, 1]);
  const n1 = 90;
  const n2 = 40;
  const N = n1 + n2;
  const src = new Float32Array(N * 2);
  const dst = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const x = i < n1 ? 12 + rand() * 288 : 150 + rand() * 100;
    const y = i < n1 ? 12 + rand() * 216 : 70 + rand() * 110;
    src[2 * i] = x;
    src[2 * i + 1] = y;
    const Huse = i < n1 ? H1 : H2;
    const p = applyH(Huse, x, y);
    dst[2 * i] = p.x + gauss() * 0.3;
    dst[2 * i + 1] = p.y + gauss() * 0.3;
  }
  const seg = segmentScene(src, dst, {
    width: 320,
    height: 240,
    threshold: 2,
    maxLayers: 3,
    minLayerInliers: 20,
    minObjectPoints: 8,
    residualThreshold: 4,
  });
  assert.ok(seg.bg, '必须有背景层');
  assert.ok(seg.layers.length >= 2, `层数不足: ${seg.layers.length}`);
  assert.ok(seg.bg.count >= n1 * 0.8, `背景内点不足: ${seg.bg.count}`);
  const rigid = seg.objects.find((o) => o.source === 'rigid-layer');
  assert.ok(rigid, '应识别出第二个刚体运动层');
  assert.ok(rigid.count >= 20);
});

test('多运动层拟合使用全部 valid 点，内点数与全局一致', () => {
  const rand = mulberry32(11);
  const H = new Float64Array([1.0, 0.03, 3, -0.02, 1.0, -2, 0, 0, 1]);
  const N = 60;
  const src = new Float32Array(N * 2);
  const dst = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const x = 20 + rand() * 280;
    const y = 20 + rand() * 200;
    src[2 * i] = x;
    src[2 * i + 1] = y;
    const p = applyH(H, x, y);
    dst[2 * i] = p.x;
    dst[2 * i + 1] = p.y;
  }
  const res = ransacHomography(src, dst, { threshold: 2, minInliers: 30, seed: 3 });
  assert.ok(res);
  assert.equal(res.count, N, '全部 valid 点都应参与并被计入内点');
});
