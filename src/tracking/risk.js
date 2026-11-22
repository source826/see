// 自写轨迹预测 + 走廊侵入判定 + TTC + 分级提示。
import { applyH, clamp, fixedPointOfH, pointInPolygon } from '../math/matrix.js';

export function buildCorridor(bgH, w, h, opts = {}) {
  let apex = { x: w * 0.5, y: h * 0.42 };
  if (bgH) {
    const foe = fixedPointOfH(bgH);
    // 只接受“可信”的不动点：应落在画面中上部、靠近行进方向。
    // 单应失配时不动点常跑到画面角落/边缘，直接采用会让走廊完全偏离路面。
    const inFrame =
      foe &&
      Number.isFinite(foe.x) &&
      Number.isFinite(foe.y) &&
      foe.x > w * 0.2 && foe.x < w * 0.8 &&
      foe.y > h * 0.15 && foe.y < h * 0.65;
    if (inFrame) {
      apex = {
        x: clamp(foe.x, 0, w - 1),
        y: clamp(foe.y, 0, h * 0.85),
      };
    }
  }
  const baseY = h - 1;
  const half = Math.max(w * 0.16, Math.min(w * 0.34, (opts.widthRatio ?? 0.24) * w));
  const cx = w * 0.5;
  const poly = [apex, { x: cx - half, y: baseY }, { x: cx + half, y: baseY }];
  const wide = [apex, { x: cx - half * 1.75, y: baseY }, { x: cx + half * 1.75, y: baseY }];
  return { apex, poly, wide, baseY, halfWidth: half, centerX: cx };
}

/**
 * 自写预测：图像位置 = 背景单应外推（相机自运动） + 目标独立速度/加速度积分。
 * 不使用任何第三方预测库。
 */
export function predictTrack(track, steps, bgH, opts = {}) {
  const s = track.kf.x;
  let x = s[0];
  let y = s[1];
  let vx = s[2];
  let vy = s[3];
  let ax = clamp(s[4], -1.5, 1.5);
  let ay = clamp(s[5], -1.5, 1.5);
  const maxVel = opts.maxVel ?? 35;
  const pts = [];
  for (let k = 1; k <= steps; k++) {
    vx = clamp(vx + ax, -maxVel, maxVel);
    vy = clamp(vy + ay, -maxVel, maxVel);
    if (bgH) {
      const p = applyH(bgH, x, y);
      if (p) {
        x = p.x;
        y = p.y;
      }
    }
    x += vx;
    y += vy;
    const sigma = Math.sqrt(Math.max(1, track.kf.P[0] + track.kf.P[7])) * Math.sqrt(k);
    pts.push({ x, y, sigma });
  }
  return pts;
}

/** 用目标框高度对数增长率估计碰撞时间（秒）。 */
export function estimateTTC(track, fps) {
  const hist = track.sizeHistory;
  if (!hist || hist.length < 5 || !(fps > 0)) return null;
  const n = hist.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const ly = Math.log(Math.max(1, hist[i]));
    sx += i;
    sy += ly;
    sxx += i * i;
    sxy += i * ly;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sxy - sx * sy) / denom;
  if (!(slope > 0.004)) return null;
  const ttc = 1 / (slope * fps);
  if (!Number.isFinite(ttc)) return null;
  return Math.min(ttc, 12);
}

/** 单目距离估计：用目标框高度与假设的物理高度近似。 */
export function estimateDistance(bbox, imageWidth, opts = {}) {
  const hfov = ((opts.hfovDeg ?? 65) * Math.PI) / 180;
  const f = imageWidth * 0.5 / Math.tan(hfov * 0.5);
  const realH = opts.objectHeight ?? 1.7;
  return (f * realH) / Math.max(1, bbox.h);
}

export function directionLabel(x, w) {
  if (x < w * 0.4) return '左前方';
  if (x > w * 0.6) return '右前方';
  return '正前方';
}

/**
 * @param {object} args
 * @param {Array} args.tracks 已确认轨迹
 */
export function assessRisk(args) {
  const { tracks, bgH, corridor, w, h, fps = 25, horizonSec = 1.4, hfovDeg = 65 } = args;
  const steps = Math.max(4, Math.round(horizonSec * fps));
  const perTrack = [];
  const alerts = [];

  for (const t of tracks) {
    const path = predictTrack(t, steps, bgH, {});
    // 先用当前位置判定：目标已经在走廊里时必须立刻报，不能被“未来轨迹预测”
    // 推出去而漏报（id4 这类贴边进入的目标尤其明显）。
    let strictStep = -1;
    let wideStep = -1;
    const groundNowX = t.kf.x[0];
    const groundNowY = t.kf.x[1] + t.bbox.h * 0.5;
    if (pointInPolygon(corridor.poly, groundNowX, groundNowY)) strictStep = 0;
    if (pointInPolygon(corridor.wide, groundNowX, groundNowY)) wideStep = 0;
    for (let k = 0; k < path.length; k++) {
      const ground = { x: path[k].x, y: path[k].y + t.bbox.h * 0.5 };
      if (strictStep < 0 && pointInPolygon(corridor.poly, ground.x, ground.y)) strictStep = k + 1;
      if (wideStep < 0 && pointInPolygon(corridor.wide, ground.x, ground.y)) wideStep = k + 1;
      if (strictStep >= 0 && wideStep >= 0) break;
    }

    const ttc = estimateTTC(t, fps);
    const distance = estimateDistance(t.bbox, w, { hfovDeg });
    const cx = t.kf.x[0];
    const dir = directionLabel(cx, w);
    const areaRatio = t.bbox.w * t.bbox.h / (w * h);

    let level = 0;
    if (wideStep >= 0) level = 2;
    if (strictStep >= 0) level = 3;
    if (strictStep >= 0 && ttc !== null && ttc < 1.3) level = 4;
    if (strictStep >= 0 && areaRatio > 0.12) level = Math.max(level, 4);
    if (level === 0 && ttc !== null && ttc < 2.2) level = 1;

    perTrack.push({
      id: t.id,
      level,
      ttc,
      distance,
      direction: dir,
      strictStep,
      wideStep,
      areaRatio,
      bbox: { ...t.bbox },
      path,
      confirmed: t.confirmed,
      flowMag: t.flowMag,
    });

    if (level >= 2) {
      alerts.push({
        level,
        trackId: t.id,
        direction: dir,
        distance,
        ttc,
        text:
          level >= 4
            ? `${dir}约 ${distance.toFixed(1)} 米有障碍物快速接近，请立即停下`
            : level === 3
              ? `${dir}约 ${distance.toFixed(1)} 米有障碍物进入通行路径，请避让`
              : `${dir}约 ${distance.toFixed(1)} 米有移动障碍物，请留意`,
      });
    }
  }

  perTrack.sort((a, b) => b.level - a.level || (a.ttc ?? 99) - (b.ttc ?? 99));
  alerts.sort((a, b) => b.level - a.level || (a.ttc ?? 99) - (b.ttc ?? 99));

  const blocking = perTrack.filter((p) => p.level >= 3);
  let instruction = '前方通畅，可以直行';
  if (blocking.length) {
    const nearest = blocking[0];
    const side = nearest.path.length ? (nearest.path[0].x < w * 0.5 ? '右' : '左') : '右';
    instruction = nearest.level >= 4 ? '正前方危险，请立即停下等待' : `请向${side}侧避让`;
  } else if (perTrack.some((p) => p.level === 2)) {
    instruction = '前方有移动障碍物，请减速留意';
  }

  return {
    corridor,
    perTrack,
    alerts,
    instruction,
    topAlert: alerts[0] ?? null,
  };
}
