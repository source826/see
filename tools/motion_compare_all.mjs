// 对 9 条开发记录逐条比较三种膨胀信号与 GT 三态，并汇总一致率。
// 用法：node tools/motion_compare_all.mjs [--tag=after]
// 读取既有离线回放（base/rob/video），只改 GT 标签时不需要重跑回放。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i > 0 ? [a.slice(2, i), a.slice(i + 1)] : [a.slice(2), 'true'];
  })
);
const tag = args.tag || 'after';
const runs = [
  ['ns1', 'gt/narrow_street_approach_full.json', 'tmp/replay_narrow_street.json', 'tmp/rob_narrow_street1.json', 'tmp/vid_narrow_street.json'],
  ['ns2', 'gt/narrow_street_approach_full.json', 'tmp/replay_narrow_street2.json', 'tmp/rob_narrow_street2.json', 'tmp/vid_narrow_street2.json'],
  ['ns3', 'gt/narrow_street_approach_full.json', 'tmp/replay_narrow_street3.json', 'tmp/rob_narrow_street3.json', 'tmp/vid_narrow_street3.json'],
  ['ht1', 'gt/narrow_hutong_approach_full.json', 'tmp/replay_narrow_hutong.json', 'tmp/rob_hutong1.json', 'tmp/vid_hutong1.json'],
  ['ht2', 'gt/narrow_hutong_approach_full.json', 'tmp/replay_hutong2.json', 'tmp/rob_hutong2.json', 'tmp/vid_hutong2.json'],
  ['ht3', 'gt/narrow_hutong_approach_full.json', 'tmp/replay_hutong3.json', 'tmp/rob_hutong3.json', 'tmp/vid_hutong3.json'],
  ['tu1', 'gt/tunnel_backlight_full.json', 'tmp/replay_tunnel.json', 'tmp/rob_tunnel1.json', 'tmp/vid_tunnel1.json'],
  ['tu2', 'gt/tunnel_backlight_full.json', 'tmp/replay_tunnel2.json', 'tmp/rob_tunnel2.json', 'tmp/vid_tunnel2.json'],
  ['tu3', 'gt/tunnel_backlight_full.json', 'tmp/replay_tunnel3.json', 'tmp/rob_tunnel3.json', 'tmp/vid_tunnel3.json'],
];
mkdirSync('tmp', { recursive: true });
const rows = [];
for (const [run, gt, base, rob, vid] of runs) {
  const out = `tmp/motion_${tag}_${run}.json`;
  // motion_compare 只写 stdout，这里直接解析。
  const j = JSON.parse(
    execFileSync('node', [
      'tools/motion_compare.mjs',
      `--gt=${gt}`,
      `--base=${base}`,
      `--robust=${rob}`,
      `--video=${vid}`,
    ], { encoding: 'utf8' })
  );
  writeFileSync(out, JSON.stringify(j, null, 2));
  rows.push({ run, samples: j.samples, ...j.at003 });
}
const total = rows.reduce((a, r) => a + r.samples, 0);
const agg = (k) => rows.reduce((a, r) => a + (r[k] ?? 0) * r.samples, 0) / total;
const summary = {
  tag,
  totalSamples: total,
  diff: agg('diff'),
  robust: agg('robust'),
  flowMedian: agg('flowMedian'),
  flowMean: agg('flowMean'),
  runs: rows,
};
writeFileSync(`tmp/motion_${tag}_summary.json`, JSON.stringify(summary, null, 2));
console.log('run samples diff robust flowMed flowMean');
for (const r of rows) {
  console.log(
    `${r.run.padEnd(3)} ${String(r.samples).padStart(7)} ${(r.diff ?? 0).toFixed(3)} ${(r.robust ?? 0).toFixed(3)} ${(r.flowMedian ?? 0).toFixed(3)} ${(r.flowMean ?? 0).toFixed(3)}`
  );
}
console.log(
  `\n合计 ${total}  diff ${summary.diff.toFixed(3)}  robust ${summary.robust.toFixed(3)}  flowMedian ${summary.flowMedian.toFixed(3)}  flowMean ${summary.flowMean.toFixed(3)}`
);
