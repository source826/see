import test from 'node:test';
import assert from 'node:assert/strict';
import { KalmanCV } from '../src/tracking/kalman.js';
import { estimateTTC } from '../src/tracking/risk.js';

test('卡尔曼滤波收敛到匀速运动', () => {
  const kf = new KalmanCV(0, 0, { posVar: 20, velVar: 20, accVar: 1 });
  for (let t = 1; t <= 40; t++) {
    kf.predict();
    kf.update(t * 2, t * 1, 2);
  }
  assert.ok(Math.abs(kf.x[2] - 2) < 0.35, `vx=${kf.x[2]}`);
  assert.ok(Math.abs(kf.x[3] - 1) < 0.35, `vy=${kf.x[3]}`);
  assert.ok(Math.abs(kf.x[0] - 80) < 4, `x=${kf.x[0]}`);
  assert.ok(Math.abs(kf.x[1] - 40) < 4, `y=${kf.x[1]}`);
});

test('卡尔曼在静止目标上不产生虚假速度', () => {
  const kf = new KalmanCV(100, 100);
  for (let t = 0; t < 30; t++) {
    kf.predict();
    kf.update(100, 100, 2);
  }
  assert.ok(Math.hypot(kf.x[2], kf.x[3]) < 0.15, `速度=${kf.x[2]},${kf.x[3]}`);
});

test('TTC 对持续放大目标给出有限值', () => {
  const track = { sizeHistory: [] };
  for (let i = 0; i < 10; i++) track.sizeHistory.push(40 * Math.exp(0.05 * i));
  const ttc = estimateTTC(track, 30);
  assert.ok(ttc !== null);
  assert.ok(Math.abs(ttc - 1 / (0.05 * 30)) < 0.2, `ttc=${ttc}`);
});

test('TTC 对不接近目标返回 null', () => {
  const track = { sizeHistory: [40, 39, 40, 38, 39] };
  assert.equal(estimateTTC(track, 30), null);
});
