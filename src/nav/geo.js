// 纯地理计算：距离、方位角、相对方向、距离文案。
// 只做球面近似，不依赖地图/网络；供导航页和单测使用。

export const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export function normalizeDeg(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** 两点球面距离（米）。 */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 从 a 指向 b 的初始方位角，0=北，90=东。 */
export function bearing(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** 方位角差的短弧，范围 -180..180。 */
export function angleDiff(target, heading) {
  return ((target - heading + 540) % 360) - 180;
}

/** 无罗盘时的八方向文案。 */
export function cardinalLabel(deg) {
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return names[Math.round(normalizeDeg(deg) / 45) % 8];
}

/**
 * 相对方向。
 * heading 为设备朝向（0=北）。没有 heading 时退为八方向。
 */
export function relativeDirection(targetBearing, heading = null) {
  if (heading === null || heading === undefined || !Number.isFinite(heading)) {
    return { label: `${cardinalLabel(targetBearing)}方向`, angle: null, kind: 'cardinal' };
  }
  const d = angleDiff(targetBearing, heading);
  const abs = Math.abs(d);
  let label;
  let kind;
  if (abs <= 20) {
    label = '正前方';
    kind = 'front';
  } else if (abs <= 70) {
    label = d > 0 ? '右前方' : '左前方';
    kind = d > 0 ? 'front-right' : 'front-left';
  } else if (abs <= 120) {
    label = d > 0 ? '右侧' : '左侧';
    kind = d > 0 ? 'right' : 'left';
  } else {
    label = '后方';
    kind = 'behind';
  }
  return { label, angle: Math.round(d), kind };
}

/** 距离文案：近距离报米，远距离报公里。 */
export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '未知距离';
  if (meters < 10) return `${Math.max(1, Math.round(meters))} 米`;
  if (meters < 100) return `${Math.round(meters / 5) * 5} 米`;
  if (meters < 1000) return `${Math.round(meters / 10) * 10} 米`;
  return `${(meters / 1000).toFixed(1)} 公里`;
}

/** 到达判定：默认 8 m 内算到达附近。 */
export function isArrived(meters, threshold = 8) {
  return Number.isFinite(meters) && meters <= threshold;
}

/**
 * 生成一句导航提示。
 * @param {{distance:number,bearing:number,heading:number|null,destinationLabel?:string,arrivedThreshold?:number}} args
 */
export function guidanceText({ distance, bearing: brg, heading = null, destinationLabel = '目的地', arrivedThreshold = 8 }) {
  if (!Number.isFinite(distance)) return '还没有定位，无法计算到目的地的距离。';
  if (isArrived(distance, arrivedThreshold)) return `已到达${destinationLabel}附近。`;
  const dir = relativeDirection(brg, heading);
  return `${destinationLabel}在${dir.label}，约 ${formatDistance(distance)}。`;
}
