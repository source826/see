import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyPitchChange, detectStairs, TerrainTracker } from '../src/vision/terrain.js';
import { TERRAIN_TEXTS, terrainCandidate } from '../src/app/announce.js';

function makeGray(w, h, fn) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y);
  }
  return { w, h, data };
}

const flat = makeGray(320, 180, () => 100);
const stripes = makeGray(320, 180, (x, y) => (y >= 90 && y < 170 && (y - 90) % 10 < 3 ? 210 : 70));
const gradient = makeGray(320, 180, (x, y) => (y * 0.6) % 255);

test('台阶检测：等间距水平边缘触发', () => {
  const r = detectStairs(stripes);
  assert.equal(r.stairs, true, `peaks=${r.peaks}, cv=${r.cv}`);
  assert.ok(r.peaks >= 6);
});

test('台阶检测：平整地面和渐变地面不触发', () => {
  assert.equal(detectStairs(flat).stairs, false);
  assert.equal(detectStairs(gradient).stairs, false);
});

test('台阶跟踪：连续两帧确认，消失后保持约 1 秒', () => {
  const tracker = new TerrainTracker({ confirmFrames: 2, holdMs: 1000 });
  assert.equal(tracker.update(stripes, 1000).stairs, false);
  assert.equal(tracker.update(stripes, 1033).stairs, true);
  assert.equal(tracker.update(flat, 1100).stairs, true);
  assert.equal(tracker.update(flat, 2500).stairs, false);
});

test('姿态俯仰变化分上坡/下坡/不确定', () => {
  assert.equal(classifyPitchChange(0, 10), 'up');
  assert.equal(classifyPitchChange(0, -10), 'down');
  assert.equal(classifyPitchChange(0, 5), 'unknown');
  assert.equal(classifyPitchChange(0, 1), null);
  assert.equal(classifyPitchChange(NaN, 5), null);
});

test('地形候选文案：台阶优先，其次坡道', () => {
  assert.equal(terrainCandidate({ stairs: true }, 'up').text, TERRAIN_TEXTS.stairs);
  assert.equal(terrainCandidate(null, 'up').text, TERRAIN_TEXTS.up);
  assert.equal(terrainCandidate(null, 'down').text, TERRAIN_TEXTS.down);
  assert.equal(terrainCandidate(null, 'unknown').text, TERRAIN_TEXTS.slopeUnknown);
  assert.equal(terrainCandidate(null, null), null);
});
