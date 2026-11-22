// 语音播报策略：把逼近/静止/不确定三类风险映射成固定中文短句，并做冷却与降级保护。
// 原则：只在“确实很快逼近”时喊“冲过来”，其余情况宁可说“有情况请确认”。

export const ANNOUNCE_TEXTS = {
  rushPerson: '有人冲过来，请停下',
  rushVehicle: '有车冲过来，请停下',
  rushObject: '有目标冲过来，请停下',
  staticObject: '有静止障碍，请绕行',
  uncertain: '前方有情况请确认',
};

export const TERRAIN_TEXTS = {
  stairs: '前方台阶，请小心',
  up: '前方上坡，请小心',
  down: '前方下坡，请小心',
  slopeUnknown: '前方有坡道，请小心',
};

/** 把台阶/坡道状态转成播报候选；没有地形时返回 null。 */
export function terrainCandidate(terrain, slope) {
  if (terrain && terrain.stairs) {
    return { kind: 'stairs', text: TERRAIN_TEXTS.stairs, priority: 3, level: 3, trackId: -1 };
  }
  if (slope === 'up') {
    return { kind: 'slope', text: TERRAIN_TEXTS.up, priority: 2, level: 2, trackId: -1 };
  }
  if (slope === 'down') {
    return { kind: 'slope', text: TERRAIN_TEXTS.down, priority: 2, level: 2, trackId: -1 };
  }
  if (slope === 'unknown') {
    return { kind: 'slope', text: TERRAIN_TEXTS.slopeUnknown, priority: 2, level: 2, trackId: -1 };
  }
  return null;
}

/** 用户侧距离档位：很近 / 近 / 有点远。具体米数只留在调试信息里。 */
export function distanceBucket(distance) {
  if (!(distance > 0)) return '附近';
  if (distance <= 3) return '很近';
  if (distance <= 8) return '近';
  return '有点远';
}

function placeLabel(p) {
  const dir = p.direction || '前方';
  const bucket = distanceBucket(p.distance);
  const suffix = bucket === '很近' ? '很近处' : bucket === '近' ? '近处' : bucket === '有点远' ? '有点远处' : '附近';
  return `${dir}${suffix}`;
}

function classKind(className = '') {
  if (/行人|自行车|摩托车/.test(className)) return 'person';
  if (/汽车|公交车|卡车|火车/.test(className)) return 'vehicle';
  return 'object';
}

/**
 * 从 risk.perTrack 里选出当前最该播报的一条。
 * @param {object} risk assessApproachRisk 的返回值
 * @param {object} opts
 * @returns {null|{kind:string,text:string,trackId:number,level:number,priority:number,distance:number,ttc:number|null}}
 */
export function classifyAnnouncement(risk, opts = {}) {
  if (!risk || !Array.isArray(risk.perTrack)) return null;
  const rushTtc = opts.rushTtc ?? 1.8;
  const rushAreaRate = opts.rushAreaRate ?? 1.0;
  const rushMaxDist = opts.rushMaxDist ?? 12;
  const staticAreaRate = opts.staticAreaRate ?? 0.15;
  const staticCenterRate = opts.staticCenterRate ?? 0.04;
  const staticDist = opts.staticDist ?? 8;
  const uncertainDist = opts.uncertainDist ?? 8;

  let rush = null;
  let staticObs = null;
  let uncertain = null;

  for (const p of risk.perTrack) {
    if (!p.confirmed || !p.inPath) continue;
    const kind = classKind(p.className);
    const place = placeLabel(p);
    const fast =
      p.approaching &&
      p.distance <= rushMaxDist &&
      ((p.ttc !== null && p.ttc <= rushTtc) ||
        (p.level >= 4 && p.areaRatio >= 0.01) ||
        (p.areaRate >= rushAreaRate && p.areaRatio >= 0.015));
    if (fast) {
      const text =
        kind === 'person'
          ? `${place}${ANNOUNCE_TEXTS.rushPerson}`
          : kind === 'vehicle'
            ? `${place}${ANNOUNCE_TEXTS.rushVehicle}`
            : `${place}${ANNOUNCE_TEXTS.rushObject}`;
      const cand = {
        kind: 'rush',
        text,
        trackId: p.id,
        level: 4,
        priority: 3,
        distance: p.distance,
        ttc: p.ttc,
      };
      if (
        !rush ||
        (p.ttc ?? 99) < (rush.ttc ?? 99) ||
        ((p.ttc ?? 99) === (rush.ttc ?? 99) && p.areaRatio > (rush.areaRatio ?? 0))
      ) {
        rush = { ...cand, areaRatio: p.areaRatio };
      }
      continue;
    }

    const isStatic =
      p.hits >= 10 &&
      Math.abs(p.areaRate) <= staticAreaRate &&
      Math.abs(p.centerRate) <= staticCenterRate &&
      (p.ttc === null || p.ttc > 4) &&
      p.distance <= staticDist &&
      p.areaRatio >= 0.004;
    if (isStatic) {
      const cand = {
        kind: 'static',
        text: `${place}${ANNOUNCE_TEXTS.staticObject}`,
        trackId: p.id,
        level: 2,
        priority: 2,
        distance: p.distance,
        ttc: null,
      };
      if (!staticObs || p.distance < staticObs.distance) staticObs = cand;
      continue;
    }

    const near = p.distance <= uncertainDist;
    const timely = p.ttc !== null && p.ttc <= 3;
    if (p.samples >= 4 && (near || timely)) {
      // 近处但不像在逼近的目标先等等，确认静止后直接说“静止障碍”，不先猜“有情况”。
      if (!p.approaching && near) continue;
      // 已经明显像静止目标但样本还不够时，先不猜“前方有情况”，等确认后直接说静止障碍。
      const staticLike =
        opts.suppressStaticLikeUncertain !== false &&
        p.hits < 10 &&
        Math.abs(p.areaRate) <= staticAreaRate &&
        Math.abs(p.centerRate) <= staticCenterRate;
      if (staticLike) continue;
      const cand = {
        kind: 'uncertain',
        text: ANNOUNCE_TEXTS.uncertain,
        trackId: p.id,
        level: 2,
        priority: 1,
        distance: p.distance,
        ttc: p.ttc,
      };
      if (!uncertain || p.distance < uncertain.distance) uncertain = cand;
    }
  }

  return rush || staticObs || uncertain;
}

/**
 * 播报节流：同类同目标冷却；刚从“冲过来”降级时保持一段时间不急着改口。
 */
export class SpeechAnnouncer {
  constructor(opts = {}) {
    this.opts = {
      rushCooldown: 4500,
      staticCooldown: 12000,
      uncertainCooldown: 12000,
      globalCooldown: 800,
      downgradeHold: 3000,
      ...opts,
    };
    this.lastSpoke = null;
    this.lastSpokeAt = null;
    this.byKind = {};
    this.lastSeen = null;
  }

  shouldSpeak(candidate, now) {
    if (!candidate) {
      if (this.lastSeen && now - this.lastSeen.at > 1500) this.lastSeen = null;
      return false;
    }
    const cooldown =
      candidate.kind === 'rush'
        ? this.opts.rushCooldown
        : candidate.kind === 'static'
          ? this.opts.staticCooldown
          : candidate.kind === 'stairs'
            ? (this.opts.stairsCooldown ?? 4000)
            : candidate.kind === 'slope'
              ? (this.opts.slopeCooldown ?? 6000)
              : this.opts.uncertainCooldown;
    if (this.lastSpokeAt !== null && now - this.lastSpokeAt < this.opts.globalCooldown) {
      this.lastSeen = { ...candidate, at: now };
      return false;
    }
    const kindAt = this.byKind[candidate.kind];
    if (kindAt !== undefined && now - kindAt < cooldown) {
      this.lastSeen = { ...candidate, at: now };
      return false;
    }
    if (
      this.lastSpoke &&
      this.lastSpoke.kind === 'rush' &&
      candidate.priority < 3 &&
      now - this.lastSpoke.at < this.opts.downgradeHold
    ) {
      this.lastSeen = { ...candidate, at: now };
      return false;
    }
    this.lastSpoke = { ...candidate, at: now };
    this.lastSpokeAt = now;
    this.byKind[candidate.kind] = now;
    this.lastSeen = { ...candidate, at: now };
    return true;
  }

  reset() {
    this.lastSpoke = null;
    this.lastSpokeAt = null;
    this.byKind = {};
    this.lastSeen = null;
  }
}
