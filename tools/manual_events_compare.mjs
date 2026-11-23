// 9 条开发记录：旧口径（wideEntrySec 前 5 s）vs 新口径（dangerSec 前 1.5–5.0 s）。
// 用法：node tools/manual_events_compare.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const eventsFile = 'gt/events_manual_dev_20261123.json';
const runs = [
  ['narrow1', 'tmp/regress/narrow_street1.json', 'gt/narrow_street_approach_full.json'],
  ['narrow2', 'tmp/regress/narrow_street2.json', 'gt/narrow_street_approach_full.json'],
  ['narrow3', 'tmp/regress/narrow_street3.json', 'gt/narrow_street_approach_full.json'],
  ['hutong1', 'tmp/regress/hutong1.json', 'gt/narrow_hutong_approach_full.json'],
  ['hutong2', 'tmp/regress/hutong2.json', 'gt/narrow_hutong_approach_full.json'],
  ['hutong3', 'tmp/regress/hutong3.json', 'gt/narrow_hutong_approach_full.json'],
  ['tunnel1', 'tmp/regress/tunnel1.json', 'gt/tunnel_backlight_full.json'],
  ['tunnel2', 'tmp/regress/tunnel2.json', 'gt/tunnel_backlight_full.json'],
  ['tunnel3', 'tmp/regress/tunnel3.json', 'gt/tunnel_backlight_full.json'],
];
const pct = (a, q) => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))] * 1000) / 1000 : null;
};
const perRun = [];
let duration = 0;
for (const [name, live, gt] of runs) {
  const out = JSON.parse(
    execFileSync('node', [
      'tools/manual_events_eval.mjs',
      `--live=${live}`,
      `--gt=${gt}`,
      `--events=${eventsFile}`,
    ], { encoding: 'utf8' })
  );
  const s = out.summary;
  duration += s.durationSec || 0;
  perRun.push({ name, ...s });
}
const agg = (key) => {
  const rows = perRun.map((r) => r[key]);
  const sum = (f) => rows.reduce((a, r) => a + (r[f] || 0), 0);
  return {
    evaluable: sum('evaluable'),
    tp: sum('tp'),
    fn: sum('fn'),
    late: sum('late'),
    missingDanger: sum('missingDanger'),
    duplicates: sum('duplicates'),
    recall: sum('evaluable') ? sum('tp') / sum('evaluable') : null,
    fpEpisodes: sum('fpEpisodes'),
    outsideWindowAlerts: sum('outsideWindowAlerts'),
    notTpEpisodes: sum('notTpEpisodes'),
  };
};
// 聚合时直接用每条记录汇总里的 TP 提前量中位数无法还原全部分布；
// 重新从 details 收集所有 TP lead，保证中位/P10 正确。
const leads = { old: [], new: [] };
for (const [name, live, gt] of runs) {
  const out = JSON.parse(
    execFileSync('node', [
      'tools/manual_events_eval.mjs',
      `--live=${live}`,
      `--gt=${gt}`,
      `--events=${eventsFile}`,
    ], { encoding: 'utf8' })
  );
  for (const d of out.details) {
    if (d.old?.result === 'tp') leads.old.push(d.old.leadSec);
    if (d.new?.result === 'tp') leads.new.push(d.new.leadSec);
  }
}
const oldAgg = agg('old');
const newAgg = agg('new');
const minutes = duration / 60;
const summary = {
  generatedAt: new Date().toISOString(),
  eventsFile,
  runs: perRun.map((r) => r.name),
  durationSec: Math.round(duration * 100) / 100,
  old: {
    ...oldAgg,
    leadMedian: pct(leads.old, 0.5),
    leadP10: pct(leads.old, 0.1),
    fpPerMin: Math.round((oldAgg.fpEpisodes / minutes) * 1000) / 1000,
    outsideWindowPerMin: Math.round((oldAgg.outsideWindowAlerts / minutes) * 1000) / 1000,
    notTpPerMin: Math.round((oldAgg.notTpEpisodes / minutes) * 1000) / 1000,
  },
  new: {
    ...newAgg,
    leadMedian: pct(leads.new, 0.5),
    leadP10: pct(leads.new, 0.1),
    fpPerMin: Math.round((newAgg.fpEpisodes / minutes) * 1000) / 1000,
    outsideWindowPerMin: Math.round((newAgg.outsideWindowAlerts / minutes) * 1000) / 1000,
    notTpPerMin: Math.round((newAgg.notTpEpisodes / minutes) * 1000) / 1000,
  },
  perRun,
};
writeFileSync('eval/manual_events_compare_20261123.json', JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ durationSec: summary.durationSec, old: summary.old, new: summary.new }, null, 2));
