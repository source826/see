import assert from 'node:assert/strict';
import test from 'node:test';

import { CrosswalkTracker, detectCrosswalk } from '../src/vision/crosswalk.js';
import { classifyTrafficLight, TrafficLightTracker } from '../src/vision/traffic.js';
import { GroundObstacleTracker } from '../src/vision/ground.js';
import {
  ENV_TEXTS,
  environmentCandidate,
  groundCandidate,
  trafficCandidate,
} from '../src/app/announce.js';

const W = 320;
const H = 180;

function makeRGBA(fn) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data };
}

function crosswalkImage(shiftX = 0, removeMiddle = false) {
  const bars = [100, 112, 124, 136, 148, 160];
  return makeRGBA((x, y) => {
    if (removeMiddle && y >= 124 && y < 129) return [25, 25, 25];
    const hit = bars.some((b) => y >= b && y < b + 5);
    const inX = x >= 90 + shiftX && x <= 230 + shiftX;
    return hit && inX ? [235, 235, 235] : [25, 25, 25];
  });
}

test('斑马线：连续白条检测为在线内', () => {
  const r = detectCrosswalk(crosswalkImage(), W, H);
  assert.equal(r.active, true);
  assert.equal(r.off, false);
  assert.ok(r.stripes >= 4);
});

test('斑马线：整体偏移后判定偏离', () => {
  const r = detectCrosswalk(crosswalkImage(120), W, H);
  assert.equal(r.active, true);
  assert.equal(r.off, true);
});

test('斑马线：中间缺一块仍按直线补齐', () => {
  const r = detectCrosswalk(crosswalkImage(0, true), W, H);
  assert.equal(r.active, true);
  assert.equal(r.off, false);
  assert.ok(r.stripes >= 4);
});

test('斑马线：没有白条时不激活', () => {
  const img = makeRGBA(() => [30, 30, 30]);
  const r = detectCrosswalk(img, W, H);
  assert.equal(r.active, false);
  assert.equal(r.off, false);
});

test('斑马线跟踪：连续两帧确认，偏离两帧才报警', () => {
  const tracker = new CrosswalkTracker({ confirmFrames: 2, offFrames: 2, holdMs: 1000, cooldownMs: 0 });
  const on = detectCrosswalk(crosswalkImage(), W, H);
  const off = detectCrosswalk(crosswalkImage(120), W, H);
  tracker.update(on, 1000);
  assert.equal(tracker.update(on, 1033).active, true);
  tracker.update(off, 1066);
  const r = tracker.update(off, 1100);
  assert.equal(r.off, true);
  assert.equal(r.alert, true);
});

test('红绿灯：红/绿/黄/暗色分类', () => {
  const box = { x: 10, y: 10, w: 60, h: 60 };
  const red = classifyTrafficLight(makeRGBA(() => [220, 30, 30]), box, W, H);
  const green = classifyTrafficLight(makeRGBA(() => [30, 200, 40]), box, W, H);
  const yellow = classifyTrafficLight(makeRGBA(() => [230, 190, 30]), box, W, H);
  const dark = classifyTrafficLight(makeRGBA(() => [20, 20, 20]), box, W, H);
  assert.equal(red.color, 'red');
  assert.equal(green.color, 'green');
  assert.equal(yellow.color, 'yellow');
  assert.equal(dark.color, null);
});

test('红绿灯跟踪：连续三帧确认并播报红灯', () => {
  const tracker = new TrafficLightTracker({ confirmFrames: 3, holdMs: 1000, cooldownMs: 0 });
  const img = makeRGBA(() => [220, 30, 30]);
  const light = { bbox: { x: 10, y: 10, w: 60, h: 60 } };
  tracker.update([light], img, W, H, 1000);
  tracker.update([light], img, W, H, 1033);
  const r = tracker.update([light], img, W, H, 1066);
  assert.equal(r.color, 'red');
  assert.equal(r.active, true);
  assert.equal(r.alert, true);
});

test('地面障碍：香蕉连续三帧确认', () => {
  const tracker = new GroundObstacleTracker({ minHits: 3, holdMs: 1000, cooldownMs: 0 });
  const det = { bbox: { x: 150, y: 140, w: 20, h: 20 }, cls: 46, score: 0.5 };
  tracker.update([det], { w: W, h: H, nowMs: 1000 });
  tracker.update([det], { w: W, h: H, nowMs: 1033 });
  const r = tracker.update([det], { w: W, h: H, nowMs: 1066 });
  assert.equal(r.active, true);
  assert.equal(r.text, '前方地面有香蕉皮，请小心');
  assert.equal(r.alert, true);
});

test('环境候选优先级：斑马线偏离 > 台阶 > 红灯 > 地面', () => {
  const all = {
    crosswalk: { off: true },
    terrain: { stairs: true },
    traffic: { active: true, color: 'red' },
    ground: { active: true, text: '前方地面有香蕉皮，请小心' },
  };
  assert.equal(environmentCandidate(all, null).kind, 'crosswalk');
  assert.equal(environmentCandidate({ terrain: all.terrain, traffic: all.traffic }, null).kind, 'stairs');
  assert.equal(environmentCandidate({ traffic: all.traffic, ground: all.ground }, null).kind, 'red');
  assert.equal(groundCandidate(all.ground).text, '前方地面有香蕉皮，请小心');
});

test('红绿灯文案：绿灯只提示确认行人信号', () => {
  assert.equal(trafficCandidate({ active: true, color: 'red' }).text, ENV_TEXTS.red);
  assert.equal(trafficCandidate({ active: true, color: 'green' }).text, ENV_TEXTS.green);
  assert.equal(trafficCandidate({ active: true, color: 'yellow' }).text, ENV_TEXTS.yellow);
});
