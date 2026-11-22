import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlarmEvents } from '../eval/events.js';

function corridor() {
  return { poly: [{ x: 50, y: 20 }, { x: 0, y: 100 }, { x: 100, y: 100 }] };
}

function buildFrames() {
  const frames = [];
  for (let f = 0; f <= 21; f++) {
    const gt = [];
    const inside = f >= 10;
    gt.push({
      id: 1,
      bbox: inside ? { x: 40, y: 55, w: 20, h: 40 } : { x: 40, y: 0, w: 20, h: 15 },
    });
    gt.push({
      id: 2,
      bbox: inside ? { x: 20, y: 55, w: 20, h: 40 } : { x: 20, y: 0, w: 20, h: 15 },
    });
    const alerts = [];
    if (f === 2) alerts.push({ level: 3, trackId: 7 });
    if (f === 20 || f === 21) alerts.push({ level: 2, trackId: 99 });
    frames.push({ frame: f, gt, alerts, corridor: corridor() });
  }
  return frames;
}

test('事件级评测：TP 提前量、漏报、误报分段', () => {
  const frames = buildFrames();
  const matchByFrame = { 2: new Map([[7, 1]]) };
  const r = evaluateAlarmEvents({ frames, matchByFrame, fps: 10, leadSec: 3, minLevel: 2 });

  assert.equal(r.eventCount, 2, '两条 GT 轨迹各一次进入事件');
  assert.equal(r.tpEvents, 1);
  assert.equal(r.fnEvents, 1);
  assert.equal(r.lateEvents, 0);
  assert.equal(Math.round(r.eventRecall * 100), 50);
  assert.ok(Math.abs(r.leadMedian - 0.8) < 1e-9, `提前量应为 0.8s，实际 ${r.leadMedian}`);
  assert.equal(r.fpEpisodes, 1, '连续两帧误报应合并为一次');
  assert.equal(r.fpFrames, 2);
  assert.ok(r.fpPerMin > 0);
});

test('事件后 1 秒内的报警算迟到，不算提前预警', () => {
  const frames = buildFrames();
  frames.push({ frame: 11, gt: [], alerts: [{ level: 3, trackId: 5 }], corridor: corridor() });
  const matchByFrame = { 2: new Map([[7, 1]]), 11: new Map([[5, 2]]) };
  const r = evaluateAlarmEvents({ frames, matchByFrame, fps: 10, leadSec: 3, minLevel: 2 });
  assert.equal(r.lateEvents, 1);
  assert.equal(r.tpEvents, 1, '只有 gt1 的提前报警算 TP');
  assert.equal(r.fnEvents, 1);
});

test('低于最低等级的提示不计入报警', () => {
  const frames = buildFrames();
  frames[2].alerts = [{ level: 1, trackId: 7 }];
  const matchByFrame = { 2: new Map([[7, 1]]) };
  const r = evaluateAlarmEvents({ frames, matchByFrame, fps: 10, leadSec: 3, minLevel: 2 });
  assert.equal(r.tpEvents, 0);
  assert.equal(r.fnEvents, 2);
});

test('同一 GT 事件目标在事件后的持续报警不计入误报', () => {
  const frames = buildFrames();
  for (const rec of frames) rec.alerts = [];
  frames[2].alerts = [{ level: 3, trackId: 7 }];
  for (let f = 12; f <= 15; f++) frames[f].alerts = [{ level: 2, trackId: 7 }];
  for (let f = 18; f <= 19; f++) frames[f].alerts = [{ level: 2, trackId: 99 }];
  const matchByFrame = { 2: new Map([[7, 1]]) };
  for (let f = 12; f <= 15; f++) matchByFrame[f] = new Map([[7, 1]]);
  const r = evaluateAlarmEvents({ frames, matchByFrame, fps: 10, leadSec: 3, minLevel: 2 });
  assert.equal(r.tpEvents, 1);
  assert.equal(r.fpEpisodes, 1, '只有无对应 GT 目标的 track 99 算误报');
  assert.equal(r.fpFrames, 2);
});
