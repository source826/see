// 事件级报警评测：把“真实危险事件”与“系统实际报警”对齐，得到
// 事件召回、漏报事件数、误报次数/分钟、提前量。全部为纯函数，可单独测试。
import { pointInPolygon } from '../src/math/matrix.js';

function groundPoint(bbox) {
  return { x: bbox.x + bbox.w * 0.5, y: bbox.y + bbox.h };
}

/**
 * @param {object} args
 * @param {Array} args.frames 按帧排序：[{frame, gt:[{id,bbox}], alerts:[{level,trackId}], corridor:{poly}}]
 * @param {object} args.matchByFrame 帧号 -> Map(predTrackId -> gtId)
 * @param {number} args.fps
 * @param {number} args.leadSec 允许的最大提前报警窗口（秒）
 * @param {number} args.minLevel 计入“报警”的最低等级
 * @param {number} args.lateSec 事件发生后仍可算迟到的宽限（秒）
 * @param {number} args.gapSec 误报分段间隔（秒）
 * @param {number} args.reentrySec 同一 GT 轨迹重复进入的最短间隔（秒）
 */
export function evaluateAlarmEvents(args) {
  const {
    frames,
    matchByFrame = {},
    fps = 25,
    leadSec = 3,
    minLevel = 2,
    lateSec = 1,
    gapSec = 0.8,
    reentrySec = 0.5,
  } = args || {};
  const durationSec =
    Number.isFinite(args?.durationSec) && args.durationSec > 0
      ? args.durationSec
      : null;
  // 预热帧没有 GT，只允许“提前报警”计入 TP，不计入误报。
  const evalStartFrame = Number.isFinite(args?.evalStartFrame) ? args.evalStartFrame : null;

  if (!Array.isArray(frames) || !frames.length || !(fps > 0)) {
    return {
      eventCount: 0,
      tpEvents: 0,
      fnEvents: 0,
      lateEvents: 0,
      eventRecall: null,
      leadMedian: null,
      leadP10: null,
      fpEpisodes: 0,
      fpFrames: 0,
      fpPerMin: null,
      alarmFrames: 0,
      durationSec: 0,
      events: [],
      fnList: [],
    };
  }

  const leadFrames = Math.max(1, Math.round(leadSec * fps));
  const lateFrames = Math.max(1, Math.round(lateSec * fps));
  const gapFrames = Math.max(1, Math.round(gapSec * fps));
  const reentryFrames = Math.max(1, Math.round(reentrySec * fps));

  const sorted = [...frames].sort((a, b) => a.frame - b.frame);
  const firstFrame = sorted[0].frame;
  const lastFrame = sorted[sorted.length - 1].frame;
  const evalDurationSec = durationSec ?? Math.max(1 / fps, (lastFrame - firstFrame + 1) / fps);

  // 1) 从 GT 中提取“进入通行走廊”的事件
  const inside = new Map();
  const lastEntry = new Map();
  const events = [];
  const bgGtIds = new Set();
  let corridorPoly = null;
  let gtSamples = 0;
  let gtInsideSamples = 0;
  let sampleGt = null;
  let sampleApex = null;

  for (const rec of sorted) {
    if (rec.corridor && Array.isArray(rec.corridor.poly)) corridorPoly = rec.corridor.poly;
    for (const box of rec.gt || []) {
      // 背景行人/车辆只用于“报警打到了真实目标”判定，不构成事件。
      if (box.bg) {
        bgGtIds.add(box.id);
        continue;
      }
      const wasInside = inside.get(box.id) || false;
      const g = groundPoint(box.bbox);
      let nowInside = false;
      if (corridorPoly) {
        nowInside = pointInPolygon(corridorPoly, g.x, g.y);
      }
      gtSamples++;
      if (nowInside) gtInsideSamples++;
      if (!sampleGt) {
        sampleGt = {
          frame: rec.frame,
          x: Math.round(g.x),
          y: Math.round(g.y),
          w: Math.round(box.bbox.w),
          h: Math.round(box.bbox.h),
          inside: nowInside,
        };
      }
      if (!sampleApex && rec.corridor && rec.corridor.apex) {
        sampleApex = {
          x: Math.round(rec.corridor.apex.x),
          y: Math.round(rec.corridor.apex.y),
          w: rec.corridor.halfWidth ? Math.round(rec.corridor.halfWidth * 2) : null,
        };
      }
      if (nowInside && !wasInside) {
        const prev = lastEntry.get(box.id);
        if (prev === undefined || rec.frame - prev > reentryFrames) {
          events.push({ gtId: box.id, entryFrame: rec.frame, alertFrame: null, leadSec: null, late: false });
          lastEntry.set(box.id, rec.frame);
        }
      }
      inside.set(box.id, nowInside);
    }
  }

  // 2) 报警帧与 GT 事件对齐：只认“事件发生前 leadSec 内、且映射到同一 GT”的报警
  const usedAlerts = new Set();
  const mappedGt = (frame, trackId) => {
    const m = matchByFrame[frame];
    if (!m) return undefined;
    return m instanceof Map ? m.get(trackId) : m[trackId];
  };

  for (const ev of events) {
    let best = null;
    for (const rec of sorted) {
      if (rec.frame < ev.entryFrame - leadFrames) continue;
      if (rec.frame > ev.entryFrame) break;
      for (const a of rec.alerts || []) {
        if (a.level < minLevel) continue;
        if (mappedGt(rec.frame, a.trackId) !== ev.gtId) continue;
        const key = `${rec.frame}:${a.trackId}`;
        if (usedAlerts.has(key)) continue;
        if (!best || rec.frame < best.frame) best = { frame: rec.frame, key };
      }
      if (best) break;
    }
    if (best) {
      usedAlerts.add(best.key);
      ev.alertFrame = best.frame;
      ev.leadSec = (ev.entryFrame - best.frame) / fps;
    }
  }

  // 3) 漏报事件：如果事件后 lateSec 内才报警，单独记为“迟到”
  for (const ev of events) {
    if (ev.alertFrame !== null) continue;
    for (const rec of sorted) {
      if (rec.frame < ev.entryFrame) continue;
      if (rec.frame > ev.entryFrame + lateFrames) break;
      let hit = false;
      for (const a of rec.alerts || []) {
        if (a.level < minLevel) continue;
        if (mappedGt(rec.frame, a.trackId) !== ev.gtId) continue;
        hit = true;
        break;
      }
      if (hit) {
        ev.late = true;
        break;
      }
    }
  }

  // 4) 误报：不属于任何 GT 事件目标的报警帧，按时间连续性合并为“次”
  const eventGtIds = new Set(events.map((e) => e.gtId));
  // 同一物理目标可能短暂映射错 GT 或漏配，只要它在某帧对上过事件目标，就不算误报。
  const eventTrackIds = new Set();
  for (const key of Object.keys(matchByFrame)) {
    const map = matchByFrame[key];
    const iter = map instanceof Map ? map.entries() : Object.entries(map);
    for (const [trackId, gtId] of iter) {
      if (eventGtIds.has(gtId)) eventTrackIds.add(trackId);
    }
  }
  const fpFrameSet = new Set();
  const fpAlerts = [];
  let alarmFrames = 0;
  for (const rec of sorted) {
    if (evalStartFrame !== null && rec.frame < evalStartFrame) continue;
    for (const a of rec.alerts || []) {
      if (a.level < minLevel) continue;
      alarmFrames++;
      const key = `${rec.frame}:${a.trackId}`;
      if (usedAlerts.has(key)) continue;
      if (eventTrackIds.has(a.trackId)) continue;
      const mapped = mappedGt(rec.frame, a.trackId);
      if (mapped !== undefined && (eventGtIds.has(mapped) || bgGtIds.has(mapped))) continue;
      fpFrameSet.add(rec.frame);
      fpAlerts.push({ frame: rec.frame, trackId: a.trackId, level: a.level, gtId: mapped ?? null });
    }
  }
  const fpFramesSorted = [...fpFrameSet].sort((a, b) => a - b);
  let fpEpisodes = 0;
  let prev = -Infinity;
  for (const f of fpFramesSorted) {
    if (f - prev > gapFrames) fpEpisodes++;
    prev = f;
  }

  const tpEvents = events.filter((e) => e.alertFrame !== null);
  const fnEvents = events.length - tpEvents.length;
  const leads = tpEvents.map((e) => e.leadSec).sort((a, b) => a - b);
  const pick = (arr, q) => {
    if (!arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * q)));
    return arr[idx];
  };

  return {
    eventCount: events.length,
    tpEvents: tpEvents.length,
    fnEvents,
    lateEvents: events.filter((e) => e.late).length,
    eventRecall: events.length ? tpEvents.length / events.length : null,
    leadMedian: pick(leads, 0.5),
    leadP10: pick(leads, 0.1),
    fpEpisodes,
    fpFrames: fpFrameSet.size,
    fpAlerts,
    fpPerMin: fpEpisodes / (evalDurationSec / 60),
    alarmFrames,
    durationSec: evalDurationSec,
    gtSamples,
    gtInsideSamples,
    sampleGt,
    sampleApex,
    events: events.map((e) => ({
      gtId: e.gtId,
      entryFrame: e.entryFrame,
      alertFrame: e.alertFrame,
      leadSec: e.leadSec,
      late: e.late,
    })),
    fnList: events.filter((e) => e.alertFrame === null).map((e) => ({ gtId: e.gtId, entryFrame: e.entryFrame })),
  };
}
