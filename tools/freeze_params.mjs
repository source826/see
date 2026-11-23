// 冻结评测参数：把管线默认值、播报冷却、硬编码阈值和源码哈希写入一个 JSON。
// 用法：node tools/freeze_params.mjs [--out=eval/frozen_params_20261123.json]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PIPELINE_DEFAULTS } from '../src/app/pipeline.js';
import { APPROACH_DEFAULTS } from '../src/tracking/approach.js';
import { SpeechAnnouncer } from '../src/app/announce.js';

const outArg = process.argv.find((a) => a.startsWith('--out='));
const out = outArg ? outArg.slice('--out='.length) : 'eval/frozen_params_20261123.json';
const sources = [
  'src/tracking/approach.js',
  'src/app/announce.js',
  'src/app/pipeline.js',
  'eval/events.js',
  'tools/live_eval_report.mjs',
];
const sha256 = Object.fromEntries(
  sources.map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]),
);
const frozen = {
  frozenAt: new Date().toISOString(),
  note: '此文件生成后不再改规则；新素材只跑一次。',
  pipelineDefaults: PIPELINE_DEFAULTS,
  approachDefaults: APPROACH_DEFAULTS,
  announcerDefaults: new SpeechAnnouncer().opts,
  hardcoded: {
    motionStateHeightRate: 0.03,
    crowdStaticDistance: 2.5,
    crowdStaticHits: 15,
    crowdStaticAreaRatio: 0.01,
    crossingWideCorridorRequired: true,
    crossingLateralSpeedRatio: 0.06,
    crossingLateralDominance: 0.8,
  },
  evaluation: {
    alertSource: 'window.__guidaoAlerts (actual speech)',
    leadSec: 5,
    minLevel: 2,
    groupSec: 1.5,
    reentrySec: 0.5,
    crowdReentrySec: 4,
    fpCoverageRequirement: 'bg GT and >=60% clip span',
  },
  sourceSha256: sha256,
};
writeFileSync(out, JSON.stringify(frozen, null, 2) + '\n', 'utf8');
console.log(out);
