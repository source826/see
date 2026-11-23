// 为 9 条开发记录生成人工事件模板：wide/strict 来自现有自动事件，
// dangerSec 暂用“产品距离最近点”自动推导，供新旧 TP 口径对照；后续可替换为人工值。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const runs = [
  ['narrow1', 'tmp/regress/narrow_street1.json', 'gt/narrow_street_approach_full.json', 'assets/videos/narrow_street_approach.mp4'],
  ['narrow2', 'tmp/regress/narrow_street2.json', 'gt/narrow_street_approach_full.json', 'assets/videos/narrow_street_approach.mp4'],
  ['narrow3', 'tmp/regress/narrow_street3.json', 'gt/narrow_street_approach_full.json', 'assets/videos/narrow_street_approach.mp4'],
  ['hutong1', 'tmp/regress/hutong1.json', 'gt/narrow_hutong_approach_full.json', 'assets/videos/narrow_hutong_approach_01.mp4'],
  ['hutong2', 'tmp/regress/hutong2.json', 'gt/narrow_hutong_approach_full.json', 'assets/videos/narrow_hutong_approach_01.mp4'],
  ['hutong3', 'tmp/regress/hutong3.json', 'gt/narrow_hutong_approach_full.json', 'assets/videos/narrow_hutong_approach_01.mp4'],
  ['tunnel1', 'tmp/regress/tunnel1.json', 'gt/tunnel_backlight_full.json', 'assets/videos/tunnel_backlight.mp4'],
  ['tunnel2', 'tmp/regress/tunnel2.json', 'gt/tunnel_backlight_full.json', 'assets/videos/tunnel_backlight.mp4'],
  ['tunnel3', 'tmp/regress/tunnel3.json', 'gt/tunnel_backlight_full.json', 'assets/videos/tunnel_backlight.mp4'],
];
const rd = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const fps = 30;
const round = (v) => Math.round(v * 1000) / 1000;
const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
};
const events = [];
for (const [run, livePath, gtPath, video] of runs) {
  const live = rd(livePath);
  const gt = rd(gtPath);
  const report = JSON.parse(execFileSync('node', ['tools/live_eval_report.mjs', livePath, gtPath], { encoding: 'utf8' }));
  const diag = new Map((report.events.diagnostics || []).map((d) => [d.gtId, d]));
  const frames = [...(live.frames || [])].sort((a, b) => a.frame - b.frame);
  const analysis = live.analysis || { width: 320, height: 180 };
  const sx = analysis.width / gt.width;
  const sy = analysis.height / gt.height;
  const gtFrames = Object.fromEntries(Object.entries(gt.frames || {}).map(([k, v]) => [Number(k), v]));
  const gtKeys = Object.keys(gtFrames).map(Number);
  const nearestGt = (frame) => {
    let best = null;
    let bestD = Infinity;
    for (const f of gtKeys) {
      const d = Math.abs(f - frame);
      if (d < bestD) { bestD = d; best = f; }
      if (f > frame && d > bestD) break;
    }
    return bestD <= 3 ? best : null;
  };
  for (const ev of report.events.details || []) {
    const gtId = ev.gtId;
    const entrySec = round(ev.entryFrame / fps);
    const d = diag.get(gtId) || {};
    const strictRaw = Number.isFinite(d.firstStrictFrame) ? round(d.firstStrictFrame / fps) : null;
    const gtFramesForId = gtKeys.filter((f) => (gtFrames[f] || []).some((b) => b.id === gtId && !b.bg));
    const startSec = gtFramesForId.length ? round(Math.min(...gtFramesForId) / fps) : 0;
    // 自动 strict 可能来自早期 ID 切换；早于起点或宽通道的 strict 不可信，置 null。
    const strictSec =
      strictRaw !== null && strictRaw >= Math.max(startSec, entrySec) - 0.5 ? strictRaw : null;
    let best = null;
    for (const rec of frames) {
      const gf = nearestGt(rec.frame);
      if (gf === null) continue;
      const g = (gtFrames[gf] || []).find((b) => b.id === gtId && !b.bg);
      if (!g) continue;
      const gb = { x: g.x * sx, y: g.y * sy, w: g.w * sx, h: g.h * sy };
      for (const p of rec.perTrack || []) {
        if (!p.confirmed || p.distance === null || p.distance === undefined) continue;
        if (iou(gb, p.bbox) < 0.3) continue;
        if (!best || p.distance < best.distance) best = { distance: p.distance, frame: rec.frame };
      }
    }
    events.push({
      run,
      record: livePath,
      video,
      gtFile: gtPath,
      targetId: gtId,
      startSec,
      wideEntrySec: entrySec,
      strictEntrySec: strictSec,
      dangerSec: best ? round(best.frame / fps) : null,
      dangerDistanceM: best ? round(best.distance) : null,
      dangerSource: 'auto-min-product-distance',
      dangerKey: best ? `${run}|${gtId}|${round(best.frame / fps)}` : null,
      strictSource: strictSec === strictRaw ? 'auto' : 'auto-unreliable-null',
      note: best
        ? 'dangerSec 取产品距离最近点；不是 1.5 m 人工点，后续可替换。'
        : '没有匹配到产品距离，dangerSec 待人工补。',
    });
  }
  console.log(run, 'events', (report.events.details || []).length);
}
const dangerCounts = new Map();
for (const e of events) {
  if (!e.dangerKey) continue;
  dangerCounts.set(e.dangerKey, (dangerCounts.get(e.dangerKey) || 0) + 1);
}
const duplicateDangerKeys = [...dangerCounts.entries()]
  .filter(([, n]) => n > 1)
  .map(([key, n]) => ({ key, count: n }));
const out = {
  version: 1,
  status: 'auto-derived-dev',
  note: '9 条开发记录的临时人工事件：wide/strict 来自现有自动事件；dangerSec 取产品距离最近点，仅用于新旧口径对照，不是最终人工真值。同一 target 的多次宽通道重入可能共享同一 dangerKey，新口径按唯一 dangerKey 计一次。',
  evaluation: { leadSec: 5, minLeadSec: 1.5, minLevel: 2 },
  duplicateDangerKeys,
  events,
};
writeFileSync('gt/events_manual_dev_20261123.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('wrote gt/events_manual_dev_20261123.json', 'events', events.length);
