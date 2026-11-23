// 朴素基线：不经过逼近/通道规则，只按“最近的人/最近的目标/框高”直接播报。
// 读取离线回放记录，输出同样结构的 live JSON，交给 live_eval_report 评测。
// 用法：node tools/naive_baseline.mjs --live=tmp/replay_tunnel.json --out=tmp/naive_tunnel.json --rule=nearestPerson
import { readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i > 0 ? [a.slice(2, i), a.slice(i + 1)] : [a.slice(2), 'true'];
  }),
);
if (!args.live || !args.out || !args.rule) {
  console.error('用法: node tools/naive_baseline.mjs --live=<回放.json> --out=<输出.json> --rule=nearestPerson|nearestPerson5|nearestTargetWide|height40 [--cooldown=6000]');
  process.exit(1);
}
const rd = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const live = rd(args.live);
const cooldownMs = Number(args.cooldown || 6000);
const fps = Number(args.fps || 30);
const frames = [...(live.frames || [])].sort((a, b) => a.frame - b.frame);
const lastByTrack = new Map();
const alerts = [];
const outFrames = [];
for (const rec of frames) {
  const now = (rec.frame / fps) * 1000;
  let cands = (rec.perTrack || []).filter((p) => p.confirmed);
  if (args.rule === 'nearestPerson' || args.rule === 'nearestPerson5') {
    cands = cands.filter((p) => p.cls === 0);
  }
  if (args.rule === 'nearestPerson5') cands = cands.filter((p) => p.distance !== null && p.distance <= 5);
  if (args.rule === 'nearestTargetWide') cands = cands.filter((p) => p.inWide || p.inPath);
  if (args.rule === 'height40') cands = cands.filter((p) => p.bbox.h >= 40);
  cands.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99));
  const pick = cands[0];
  let spoken = null;
  if (pick) {
    const last = lastByTrack.get(pick.id);
    if (last === undefined || now - last >= cooldownMs) {
      lastByTrack.set(pick.id, now);
      spoken = { frame: rec.frame, time: Math.round(now) / 1000, kind: 'naive', level: 2, trackId: pick.id, text: 'naive' };
      alerts.push(spoken);
    }
  }
  outFrames.push({
    ...rec,
    alerts: spoken ? [{ level: 2, trackId: spoken.trackId }] : [],
    primaryId: spoken ? spoken.trackId : null,
  });
}
writeFileSync(
  args.out,
  `${JSON.stringify({ ...live, alerts, frames: outFrames, speech: [], naiveRule: args.rule }, null, 1)}\n`,
  'utf8'
);
console.log(`${args.out} rule=${args.rule} spoken=${alerts.length}`);
