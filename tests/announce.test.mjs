import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAnnouncement, distanceBucket, SpeechAnnouncer, ANNOUNCE_TEXTS } from '../src/app/announce.js';

function track(over = {}) {
  return {
    id: 1,
    confirmed: true,
    inPath: true,
    className: '行人',
    direction: '正前方',
    approaching: true,
    ttc: 1.2,
    areaRate: 0.8,
    centerRate: -0.01,
    areaRatio: 0.02,
    distance: 8,
    samples: 8,
    hits: 12,
    level: 3,
    ...over,
  };
}

function risk(...tracks) {
  return { perTrack: tracks };
}

test('快速逼近的行人说“有人冲过来”', () => {
  const a = classifyAnnouncement(risk(track()));
  assert.equal(a.kind, 'rush');
  assert.ok(a.text.includes(ANNOUNCE_TEXTS.rushPerson));
});

test('快速逼近的车辆说“有车冲过来”', () => {
  const a = classifyAnnouncement(risk(track({ className: '汽车', distance: 9 })));
  assert.equal(a.kind, 'rush');
  assert.ok(a.text.includes(ANNOUNCE_TEXTS.rushVehicle));
});

test('距离很远时不喊冲过来，退为“前方有情况请确认”', () => {
  const a = classifyAnnouncement(risk(track({ distance: 18, ttc: 1.5 })));
  assert.equal(a.kind, 'uncertain');
  assert.equal(a.text, ANNOUNCE_TEXTS.uncertain);
});

test('走廊内静止目标说“前方静止障碍”', () => {
  const a = classifyAnnouncement(
    risk(track({ approaching: false, ttc: null, areaRate: 0.02, centerRate: 0.001, distance: 4, samples: 8, hits: 15, level: 0 })),
  );
  assert.equal(a.kind, 'static');
  assert.ok(a.text.includes(ANNOUNCE_TEXTS.staticObject));
});

test('距离只用很近/近/有点远三档', () => {
  assert.equal(distanceBucket(2), '很近');
  assert.equal(distanceBucket(5), '近');
  assert.equal(distanceBucket(12), '有点远');
});

test('播报带方向和粗距离，不报具体米数', () => {
  const a = classifyAnnouncement(risk(track({ distance: 5, direction: '左前方' })));
  assert.match(a.text, /左前方近处/);
  assert.match(a.text, /有人冲过来/);
  assert.doesNotMatch(a.text, /米/);
});

test('同类播报有全局冷却，不会因换了目标就连喊', () => {
  const ann = new SpeechAnnouncer({ rushCooldown: 4500 });
  const a = { kind: 'rush', trackId: 1, priority: 3, text: '有人冲过来，请停下' };
  const b = { ...a, trackId: 2 };
  assert.equal(ann.shouldSpeak(a, 0), true);
  assert.equal(ann.shouldSpeak(b, 1000), false);
  assert.equal(ann.shouldSpeak(b, 4600), true);
});

test('冲过来刚播完时不急着降级成“请确认”', () => {
  const ann = new SpeechAnnouncer({ downgradeHold: 3000 });
  const rush = { kind: 'rush', trackId: 1, priority: 3, text: '有人冲过来，请停下' };
  const uncertain = { kind: 'uncertain', trackId: 1, priority: 1, text: '前方有情况请确认' };
  assert.equal(ann.shouldSpeak(rush, 0), true);
  assert.equal(ann.shouldSpeak(uncertain, 1000), false);
  assert.equal(ann.shouldSpeak(uncertain, 3200), true);
});

test('不同类别之间也有最短间隔，避免来回改口', () => {
  const ann = new SpeechAnnouncer({ globalCooldown: 800 });
  const staticCand = { kind: 'static', trackId: 1, priority: 2, text: '前方静止障碍，请绕行' };
  const uncertain = { kind: 'uncertain', trackId: 2, priority: 1, text: '前方有情况请确认' };
  assert.equal(ann.shouldSpeak(staticCand, 0), true);
  assert.equal(ann.shouldSpeak(uncertain, 500), false);
  assert.equal(ann.shouldSpeak(uncertain, 900), true);
});

test('没有风险目标时不播报', () => {
  assert.equal(classifyAnnouncement(risk()), null);
  const ann = new SpeechAnnouncer();
  assert.equal(ann.shouldSpeak(null, 0), false);
});
