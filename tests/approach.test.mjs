import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApproachTracker,
  assessApproachRisk,
  computeApproachMetrics,
  estimateFlowScale,
  estimateGroundDistance,
  predictTrackPath,
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

test('同帧高度重叠的重复检测框合并为一条轨迹', () => {
  const tracker = new ApproachTracker({ minHits: 1, mergeIou: 0.2 });
  const a = det(160, 120, 30, 60);
  const b = det(162, 121, 30, 60);
  const out = tracker.update([a, b], 0, { width: W, height: H, fps: 30 });
  assert.equal(out.length, 1);
});

test('并排但未高度重叠的目标保持两条轨迹', () => {
  const tracker = new ApproachTracker({ minHits: 1, mergeIou: 0.2 });
  const out = tracker.update([det(110, 120, 30, 60), det(210, 120, 30, 60)], 0, {
    width: W,
    height: H,
    fps: 30,
  });
  assert.equal(out.length, 2);
});

test('已确认目标站在走廊内且预测不离开：给 level 2 提醒', () => {
  const tracker = new ApproachTracker({ minHits: 2 });
  let last = null;
  for (let f = 0; f <= 5; f++) {
    const out = tracker.update([det(160, 120, 25, 60)], f, { width: W, height: H, fps: 30, dt: 1 / 30 });
    last = out.find((t) => t.confirmed) || last;
  }
  const risk = assessApproachRisk({
    tracks: [last],
    corridor: buildCorridor(null, W, H),
    w: W,
    h: H,
    fps: 30,
    warnOnInPath: true,
  });
  assert.equal(risk.perTrack[0].level, 2);
  assert.ok(risk.alerts.length >= 1);
});

test('矮宽框（横躺杂物）在走廊内不触发 warnOnInPath', () => {
  const tracker = new ApproachTracker({ minHits: 2 });
  let last = null;
  for (let f = 0; f <= 5; f++) {
    const out = tracker.update([det(160, 140, 60, 30)], f, { width: W, height: H, fps: 30, dt: 1 / 30 });
    last = out.find((t) => t.confirmed) || last;
  }
  const risk = assessApproachRisk({
    tracks: [last],
    corridor: buildCorridor(null, W, H),
    w: W,
    h: H,
    fps: 30,
    warnOnInPath: true,
  });
  assert.equal(risk.perTrack[0].level, 0);
  assert.equal(risk.alerts.length, 0);
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

test('地面几何估距与相机高度成正比', () => {
  const bbox = { x: 120, y: 300, w: 40, h: 180 }; // 框底 480，地平线 240
  const d1 = estimateGroundDistance(bbox, 854, 480, { cameraHeight: 1.5, hfovDeg: 65, horizonRatio: 0.5 });
  const d2 = estimateGroundDistance(bbox, 854, 480, { cameraHeight: 3.0, hfovDeg: 65, horizonRatio: 0.5 });
  assert.ok(d1 !== null && d2 !== null);
  assert.ok(Math.abs(d2 / d1 - 2) < 1e-9, `d1=${d1}, d2=${d2}`);
});

test('框底在地平线以上时地面估距返回 null', () => {
  const bbox = { x: 120, y: 100, w: 40, h: 40 }; // 框底 140 < 地平线 240
  assert.equal(estimateGroundDistance(bbox, 854, 480, { cameraHeight: 1.5, horizonRatio: 0.5 }), null);
});

test('俯角越大，同一框底估距越近', () => {
  const bbox = { x: 120, y: 300, w: 40, h: 180 }; // 框底 480
  const flat = estimateGroundDistance(bbox, 854, 480, { cameraHeight: 1.5, cameraPitchDeg: 0 });
  const down = estimateGroundDistance(bbox, 854, 480, { cameraHeight: 1.5, cameraPitchDeg: 10 });
  assert.ok(flat !== null && down !== null);
  assert.ok(down < flat, `flat=${flat}, down=${down}`);
});

test('短时轨迹按平滑速度外推', () => {
  const track = { bbox: { x: 100, y: 100, w: 20, h: 40 }, velocity: { x: 1, y: 0.5 } };
  const p = predictTrackPath(track, { fps: 10, seconds: 1, w: 320, h: 180 });
  assert.equal(p.points.length, 10);
  const last = p.points[p.points.length - 1];
  assert.ok(Math.abs(last.x - 120) < 1e-9, `x=${last.x}`);
  assert.ok(Math.abs(last.y - 125) < 1e-9, `y=${last.y}`);
  assert.ok(p.ground.y > last.y);
});

test('轨迹速度用最近窗口回归，抗单帧抖动', () => {
  const tracker = new ApproachTracker({ minHits: 1 });
  for (let f = 0; f < 8; f++) {
    tracker.update([det(100 + 2 * f, 100 + f, 20, 40)], f, { width: W, height: H, fps: 30 });
  }
  const t = tracker.tracks[0];
  assert.ok(Math.abs(t.velocity.x - 2) < 0.05, `vx=${t.velocity.x}`);
  assert.ok(Math.abs(t.velocity.y - 1) < 0.05, `vy=${t.velocity.y}`);
});

test('ground 模式使用相机高度估距，bbox 模式保持框高估距', () => {
  const track = {
    id: 1,
    confirmed: true,
    bbox: { x: 150, y: 120, w: 20, h: 50 },
    cls: 0,
    className: '行人',
    hits: 12,
    samples: 8,
    age: 12,
    approaching: true,
    approachFrames: 5,
    areaRate: 1,
    centerRate: -0.01,
    ttc: 1.5,
    ttcSource: 'area',
    flowScale: null,
    flowPoints: 0,
    velocity: { x: 0, y: 1 },
  };
  const corridor = buildCorridor(null, W, H);
  const ground = assessApproachRisk({
    tracks: [track],
    corridor,
    w: W,
    h: H,
    fps: 30,
    cameraHeight: 1.5,
    horizonRatio: 0.5,
    distanceMode: 'ground',
  });
  const bbox = assessApproachRisk({
    tracks: [track],
    corridor,
    w: W,
    h: H,
    fps: 30,
    distanceMode: 'bbox',
  });
  assert.equal(ground.perTrack[0].distanceSource, 'ground');
  assert.ok(ground.perTrack[0].distance > 0);
  assert.equal(bbox.perTrack[0].distanceSource, 'bbox');
  assert.ok(Math.abs(ground.perTrack[0].distance - bbox.perTrack[0].distance) > 0.1);
});
