import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApproachTracker,
  assessApproachRisk,
  computeApproachMetrics,
  estimateFlowScale,
} from '../src/tracking/approach.js';
import { buildCorridor } from '../src/tracking/risk.js';

const W = 320;
const H = 180;

function det(cx, cy, w, h) {
  return { bbox: { x: cx - w / 2, y: cy - h / 2, w, h }, score: 0.9, cls: 0, className: '行人' };
}

function feed(tracker, frames, makeDet, start = 0) {
  for (let i = 0; i < frames; i++) {
    const f = start + i;
    tracker.update(makeDet(i) ? [makeDet(i)] : [], f, { width: W, height: H, fps: 30, flow: null, dt: 1 / 30 });
  }
}

test('面积持续增长且中心朝行进中心移动：判定为逼近并给出报警', () => {
  const tracker = new ApproachTracker({ minHits: 2, approachMinFrames: 4 });
  let last = null;
  for (let f = 0; f <= 14; f++) {
    const s = 1 + 0.02 * f;
    const dets = tracker.update([det(160 + 0.2 * f, 120 + 1.2 * f, 20 * s, 40 * s)], f, {
      width: W,
      height: H,
      fps: 30,
      flow: null,
      dt: 1 / 30,
    });
    last = dets.find((t) => t.confirmed) || last;
  }
  assert.ok(last, '应有已确认轨迹');
  assert.equal(last.approaching, true, `areaRate=${last.areaRate} centerRate=${last.centerRate}`);
  assert.ok(last.approachFrames >= 4);
  assert.ok(last.ttc !== null && last.ttc > 0);

  const corridor = buildCorridor(null, W, H);
  const risk = assessApproachRisk({ tracks: [last], corridor, w: W, h: H, fps: 30 });
  assert.equal(risk.perTrack.length, 1);
  assert.ok(risk.perTrack[0].level >= 2, `等级过低: ${risk.perTrack[0].level}`);
  assert.ok(risk.alerts.length >= 1);
  assert.match(risk.alerts[0].text, /逼近|避让|停下/);
});

test('面积增长但中心远离行进中心：不判定为逼近', () => {
  const tracker = new ApproachTracker({ minHits: 2, approachMinFrames: 4 });
  let last = null;
  for (let f = 0; f <= 14; f++) {
    const s = 1 + 0.02 * f;
    const dets = tracker.update([det(160 - 7 * f, 120, 20 * s, 40 * s)], f, {
      width: W,
      height: H,
      fps: 30,
      flow: null,
      dt: 1 / 30,
    });
    last = dets.find((t) => t.confirmed) || last;
  }
  assert.ok(last);
  assert.ok(last.areaRate > 0.35, `面积应增长: ${last.areaRate}`);
  assert.equal(last.approaching, false);
});

test('逼近目标在走廊外：不报警', () => {
  const tracker = new ApproachTracker({ minHits: 2, approachMinFrames: 4 });
  let last = null;
  for (let f = 0; f <= 14; f++) {
    const s = 1 + 0.02 * f;
    const dets = tracker.update([det(20, 120 + 1.2 * f, 20 * s, 40 * s)], f, {
      width: W,
      height: H,
      fps: 30,
      flow: null,
      dt: 1 / 30,
    });
    last = dets.find((t) => t.confirmed) || last;
  }
  assert.ok(last && last.approaching);
  const risk = assessApproachRisk({ tracks: [last], corridor: buildCorridor(null, W, H), w: W, h: H, fps: 30 });
  assert.equal(risk.alerts.length, 0);
  assert.equal(risk.perTrack[0].level, 0);
});

test('短时漏检保持同一 ID', () => {
  const tracker = new ApproachTracker({ minHits: 2, maxMissed: 3 });
  tracker.update([det(160, 130, 24, 48)], 0, { width: W, height: H, fps: 30 });
  const id = tracker.tracks[0].id;
  tracker.update([], 1, { width: W, height: H, fps: 30 });
  tracker.update([], 2, { width: W, height: H, fps: 30 });
  const out = tracker.update([det(162, 132, 26, 51)], 3, { width: W, height: H, fps: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, id);
  assert.equal(out[0].confirmed, true);
});

test('光流尺度估计恢复已知膨胀率', () => {
  const prevBbox = { x: 100, y: 100, w: 40, h: 40 };
  const prevCenter = { x: 120, y: 120 };
  const curCenter = { x: 121.5, y: 121 };
  const offsets = [
    [-12, -12], [-6, -12], [0, -12], [6, -12], [12, -12],
    [-12, 0], [12, 0], [-12, 12], [0, 12], [12, 12],
  ];
  const src = new Float32Array(offsets.length * 2);
  const dst = new Float32Array(offsets.length * 2);
  const s = 1.03;
  offsets.forEach(([dx, dy], i) => {
    src[2 * i] = prevCenter.x + dx;
    src[2 * i + 1] = prevCenter.y + dy;
    dst[2 * i] = curCenter.x + dx * s;
    dst[2 * i + 1] = curCenter.y + dy * s;
  });
  const r = estimateFlowScale(prevBbox, curCenter, src, dst);
  assert.ok(r.count >= 8);
  assert.ok(Math.abs(r.scale - s) < 0.005, `scale=${r.scale}`);
});

test('指标计算：窗口不足时不判定', () => {
  const m = computeApproachMetrics(
    [
      { frame: 0, area: 100, cx: 160, cy: 100 },
      { frame: 1, area: 110, cx: 160, cy: 101 },
    ],
    { width: W, height: H, fps: 30 },
  );
  assert.equal(m.ready, false);
  assert.equal(m.approaching, false);
});
