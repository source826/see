import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine,
  bearing,
  angleDiff,
  cardinalLabel,
  relativeDirection,
  formatDistance,
  isArrived,
  guidanceText,
} from '../src/nav/geo.js';

test('haversine 赤道 1 度约 111.2 km', () => {
  const d = haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  assert.ok(Math.abs(d - 111195) < 500, `got ${d}`);
});

test('haversine 同一点为 0', () => {
  assert.equal(haversine({ lat: 39.9, lon: 116.4 }, { lat: 39.9, lon: 116.4 }), 0);
});

test('bearing 正北/正东', () => {
  assert.ok(Math.abs(bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })) < 1e-6);
  assert.ok(Math.abs(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 90) < 1e-6);
});

test('angleDiff 取短弧', () => {
  assert.equal(angleDiff(350, 10), -20);
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(Math.abs(angleDiff(180, 0)), 180);
});

test('cardinalLabel 八方向', () => {
  assert.equal(cardinalLabel(0), '北');
  assert.equal(cardinalLabel(45), '东北');
  assert.equal(cardinalLabel(180), '南');
  assert.equal(cardinalLabel(359), '北');
});

test('relativeDirection 前后左右', () => {
  assert.equal(relativeDirection(0, 0).label, '正前方');
  assert.equal(relativeDirection(90, 0).label, '右侧');
  assert.equal(relativeDirection(45, 0).label, '右前方');
  assert.equal(relativeDirection(300, 0).label, '左前方');
  assert.equal(relativeDirection(270, 0).label, '左侧');
  assert.equal(relativeDirection(180, 0).label, '后方');
  assert.equal(relativeDirection(90, null).label, '东方向');
});

test('formatDistance 分档', () => {
  assert.equal(formatDistance(0.4), '1 米');
  assert.equal(formatDistance(7.4), '7 米');
  assert.equal(formatDistance(23), '25 米');
  assert.equal(formatDistance(183), '180 米');
  assert.equal(formatDistance(1234), '1.2 公里');
});

test('isArrived 阈值', () => {
  assert.equal(isArrived(7.9), true);
  assert.equal(isArrived(8.1), false);
  assert.equal(isArrived(9, 10), true);
});

test('guidanceText 包含方向和距离，到达时换文案', () => {
  assert.equal(
    guidanceText({ distance: 30, bearing: 90, heading: 0 }),
    '目的地在右侧，约 30 米。'
  );
  assert.equal(
    guidanceText({ distance: 3, bearing: 0, heading: 0 }),
    '已到达目的地附近。'
  );
  assert.match(
    guidanceText({ distance: 30, bearing: 90, heading: null }),
    /东方向/
  );
});
