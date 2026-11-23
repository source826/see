// minBoxHeight 单变量扫描：门槛以 720p 原始帧像素表示。
// 默认 72@720p = 18@320×180；试验 68（17@320）和 60（15@320）。
// 用法：node tools/minheight_sweep.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const rd = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const runs = [
  ['narrow_street1', 'tmp/unseen_narrow_street', 'gt/narrow_street_approach_full.json'],
  ['narrow_street2', 'tmp/base_run2_narrow_street', 'gt/narrow_street_approach_full.json'],
  ['narrow_street3', 'tmp/base_run3_narrow_street', 'gt/narrow_street_approach_full.json'],
  ['hutong1', 'tmp/unseen_narrow_hutong', 'gt/narrow_hutong_approach_full.json'],
  ['hutong2', 'tmp/base_repeat1_hutong', 'gt/narrow_hutong_approach_full.json'],
  ['hutong3', 'tmp/base_repeat2_hutong', 'gt/narrow_hutong_approach_full.json'],
  ['tunnel1', 'tmp/unseen_tunnel', 'gt/tunnel_backlight_full.json'],
  ['tunnel2', 'tmp/base_run2_tunnel', 'gt/tunnel_backlight_full.json'],
  ['tunnel3', 'tmp/base_run3_tunnel', 'gt/tunnel_backlight_full.json'],
];
const thresholds = [72, 68, 60];
const pct = (a, q) => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))] : null;
};
const points = [];
for (const th of thresholds) {
  const tag = `mh_${th}`;
  mkdirSync(`tmp/minheight_sweep/${tag}`, { recursive: true });
  const agg = { tp: 0, events: 0, groupTp: 0, groupN: 0, cover: 0, coverN: 0, fp: 0, speech: 0, duration: 0, leads: [] };
  const per = [];
  for (const [name, liveBase, gt] of runs) {
    const out = `tmp/minheight_sweep/${tag}/${name}.json`;
    const opts = th === 72 ? [] : [`--opt=approachMinHeight:${th}`];
    execFileSync('node', ['tools/offline_replay.mjs', `--live=${liveBase}.json`, `--out=${out}`, ...opts]);
    const rep = JSON.parse(execFileSync('node', ['tools/live_eval_report.mjs', out, gt], { encoding: 'utf8' }));
    const e = rep.events;
    const speech = (rd(out).alerts || []).length;
    const leads = e.details.filter((d) => d.leadSec !== null).map((d) => d.leadSec);
    per.push({ name, tp: e.tp, events: e.eventCount, cover: e.coverage.covered, coverN: e.coverage.total, fp: e.fpEpisodes, speech, leads });
    agg.tp += e.tp;
    agg.events += e.eventCount;
    agg.groupTp += Math.round((e.groupRecall || 0) * e.groupCount);
    agg.groupN += e.groupCount;
    agg.cover += e.coverage.covered;
    agg.coverN += e.coverage.total;
    agg.fp += e.fpEpisodes;
    agg.speech += speech;
    agg.duration += rd(`${liveBase}.json`).duration;
    agg.leads.push(...leads);
  }
  const point = {
    thresholdSrc720: th,
    thresholdAt320: th / 4,
    thresholdAtInput640: th / 2,
    targetRecall: `${agg.tp}/${agg.events}`,
    groupRecall: `${agg.groupTp}/${agg.groupN}`,
    coverage: `${agg.cover}/${agg.coverN}`,
    fpEpisodes: agg.fp,
    fpPerMin: agg.fp / (agg.duration / 60),
    speech: agg.speech,
    leadMedian: pct(agg.leads, 0.5),
    leadP10: pct(agg.leads, 0.1),
    leads: agg.leads,
    per,
  };
  points.push(point);
  console.log(JSON.stringify({ ...point, per: undefined }));
}
writeFileSync(
  'eval/minheight_sweep_20261123.json',
  `${JSON.stringify({ generatedAt: new Date().toISOString(), note: 'minBoxHeight 以 720p 原始帧像素表示；72=18@320，68=17@320，60=15@320。9 条开发记录离线回放。', thresholds, points }, null, 2)}\n`,
  'utf8'
);
console.log('wrote eval/minheight_sweep_20261123.json');
