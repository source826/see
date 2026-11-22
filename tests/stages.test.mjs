import test from 'node:test';
import assert from 'node:assert/strict';
import { GrayImage } from '../src/vision/image.js';
import { buildPyramid, lkTrack } from '../src/vision/flow.js';
import { assessRisk, buildCorridor } from '../src/tracking/risk.js';

function makePattern(w, h, shiftX, shiftY) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - shiftX;
      const sy = y - shiftY;
      const v =
        128 +
        55 * Math.sin(sx * 0.28) * Math.cos(sy * 0.31) +
        35 * Math.sin((sx + sy) * 0.19) +
        25 * Math.cos((sx - sy) * 0.23);
      data[y * w + x] = Math.max(0, Math.min(255, v));
    }
  }
  return new GrayImage(w, h, data);
}

test('Lucas-Kanade 恢复已知平移（算法单测，非场景数据）', () => {
  const w = 96;
  const h = 72;
  const prev = makePattern(w, h, 0, 0);
  const next = makePattern(w, h, 2, 1);
  const pts = [];
  for (let y = 20; y <= 48; y += 8) {
    for (let x = 20; x <= 72; x += 8) pts.push(x, y);
  }
  const prevPts = Float32Array.from(pts);
  const r = lkTrack(buildPyramid(prev, 3), buildPyramid(next, 3), prevPts, {
    window: 3,
    iterations: 8,
    minEig: 0.05,
  });
  let ok = 0;
  const errs = [];
  for (let i = 0; i < prevPts.length >> 1; i++) {
    if (!r.status[i]) continue;
    ok++;
    errs.push(Math.hypot(r.flow[2 * i] - 2, r.flow[2 * i + 1] - 1));
  }
  assert.ok(ok >= (prevPts.length >> 1) * 0.9, `跟踪成功率不足: ${ok}`);
  errs.sort((a, b) => a - b);
  const median = errs[Math.floor(errs.length / 2)];
  assert.ok(median < 0.6, `中位光流误差过大: ${median}`);
});

function fakeTrack() {
  return {
    id: 1,
    kf: { x: [64, 30, 0, 2, 0, 0], P: new Float64Array(36) },
    bbox: { x: 56, y: 20, w: 16, h: 20 },
    sizeHistory: [20, 20, 20, 20, 20],
    confirmed: true,
    flowMag: 2,
  };
}

test('风险判定：目标进入通行走廊时给出报警与中文提示', () => {
  const w = 128;
  const h = 96;
  const corridor = buildCorridor(null, w, h);
  const r = assessRisk({
    tracks: [fakeTrack()],
    bgH: null,
    corridor,
    w,
    h,
    fps: 25,
    horizonSec: 1.4,
  });
  assert.equal(r.perTrack.length, 1);
  assert.ok(r.perTrack[0].level >= 3, `等级过低: ${r.perTrack[0].level}`);
  assert.ok(r.alerts.length >= 1);
  assert.match(r.alerts[0].text, /米/);
  assert.ok(r.instruction.length > 0);
});

test('背景不动点在画面外时，走廊回退到中轴', () => {
  const w = 320;
  const h = 180;
  const s = 1.2;
  const cx = 10 * w;
  const cy = 5 * h;
  const H = [s, 0, (1 - s) * cx, 0, s, (1 - s) * cy, 0, 0, 1];
  const c = buildCorridor(H, w, h);
  assert.ok(Math.abs(c.apex.x - w * 0.5) < 1e-6, `apex.x=${c.apex.x}`);
  assert.ok(Math.abs(c.apex.y - h * 0.42) < 1e-6, `apex.y=${c.apex.y}`);
});
