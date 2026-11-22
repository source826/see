// 逐帧中间结果记录器：把每个阶段（光流/分层/目标/跟踪/风险）的输出序列化为 JSONL。
// 只做记录与压缩，不参与任何检测、筛选或报警决策。

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

function roundBox(b) {
  if (!b) return null;
  return { x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h) };
}

function roundMatrix(H) {
  if (!H) return null;
  return Array.from(H, r2);
}

function samplePoints(src, dst, step) {
  const n = src.length >> 1;
  const out = [];
  for (let i = 0; i < n; i += step) {
    out.push([r2(src[2 * i]), r2(src[2 * i + 1]), r2(dst[2 * i]), r2(dst[2 * i + 1])]);
  }
  return out;
}

function layerRecord(l) {
  return {
    id: l.id,
    type: l.type,
    count: l.count,
    inlierRatio: r2(l.inlierRatio),
    errorRMS: r2(l.errorRMS),
    residualMean: r2(l.residualMean),
    flowMag: r2(l.flowMag),
    flowStd: r2(l.flowStd),
    meanFlow: { x: r2(l.meanFlow.x), y: r2(l.meanFlow.y) },
    bbox: roundBox(l.bbox),
    H: roundMatrix(l.H),
  };
}

function objectRecord(o) {
  return {
    count: o.count,
    source: o.source,
    layerId: o.layerId ?? null,
    bbox: roundBox(o.bbox),
    flowMag: r2(o.flowMag),
    flowStd: r2(o.flowStd),
    flow: { x: r2(o.meanFlow.x), y: r2(o.meanFlow.y) },
    residualMean: r2(o.residualMean),
    confidence: r2(o.confidence),
  };
}

function trackRecord(t) {
  return {
    id: t.id,
    confirmed: t.confirmed,
    hits: t.hits,
    misses: t.misses,
    age: t.age,
    bbox: roundBox(t.bbox),
    flowMag: r2(t.flowMag),
  };
}

function riskTrackRecord(p) {
  const path = Array.isArray(p.path)
    ? p.path.filter((_, i) => i % 4 === 0 || i === p.path.length - 1).map((q) => [r2(q.x), r2(q.y)])
    : [];
  return {
    id: p.id,
    level: p.level,
    ttc: r2(p.ttc),
    distance: r2(p.distance),
    direction: p.direction,
    strictStep: p.strictStep,
    wideStep: p.wideStep,
    areaRatio: r2(p.areaRatio),
    path,
  };
}

export class FrameRecorder {
  constructor(opts = {}) {
    this.maxFrames = opts.maxFrames ?? 5000;
    this.pointStep = Math.max(1, opts.pointStep ?? 5);
    this.active = false;
    this.meta = null;
    this.rows = [];
    this.bytes = 0;
  }

  start(meta) {
    this.active = true;
    this.meta = {
      type: 'meta',
      startedAt: new Date().toISOString(),
      ...meta,
    };
    this.rows = [];
    this.bytes = 0;
  }

  stop() {
    this.active = false;
  }

  get frameCount() {
    return this.rows.length;
  }

  add(res) {
    if (!this.active) return;
    if (this.rows.length >= this.maxFrames) {
      this.active = false;
      return;
    }

    const seg = res.seg;
    const flow = res.flow;
    const record = {
      f: res.frame.index,
      size: [res.frame.width, res.frame.height],
      ms: {
        gray: r2(res.timings.gray),
        pyramid: r2(res.timings.pyramid),
        flow: r2(res.timings.flow),
        segment: r2(res.timings.segment),
        track: r2(res.timings.track),
        total: r2(res.timings.total),
      },
      flow: {
        used: res.flowStats.used,
        valid: res.flowStats.valid,
        ratio: r2(res.flowStats.valid / Math.max(1, res.flowStats.used)),
        points: flow ? samplePoints(flow.src, flow.dst, this.pointStep) : [],
      },
      seg: seg
        ? {
            points: seg.stats.points,
            bgInliers: seg.stats.bgInliers,
            bgInlierRatio: r2(seg.stats.bgInlierRatio),
            bgResidualMean: r2(seg.stats.bgResidualMean),
            layerCount: seg.stats.layerCount,
            objectCount: seg.stats.objectCount,
            ransacIterations: seg.stats.ransacIterations,
            suppressedLayers: seg.stats.suppressedLayers ?? 0,
            layers: seg.layers.map(layerRecord),
            objects: seg.objects.map(objectRecord),
          }
        : null,
      foe: res.foe ? { x: r2(res.foe.x), y: r2(res.foe.y) } : null,
      tracks: res.tracks.map(trackRecord),
      risk: res.risk
        ? {
            degraded: Boolean(res.risk.degraded),
            instruction: res.risk.instruction,
            corridor: {
              apex: { x: r2(res.risk.corridor.apex.x), y: r2(res.risk.corridor.apex.y) },
              halfWidth: r2(res.risk.corridor.halfWidth),
            },
            perTrack: res.risk.perTrack.map(riskTrackRecord),
            alerts: res.risk.alerts.map((a) => ({
              level: a.level,
              trackId: a.trackId,
              ttc: r2(a.ttc),
              distance: r2(a.distance),
              text: a.text,
            })),
          }
        : null,
    };

    const line = JSON.stringify(record);
    this.bytes += line.length + 1;
    this.rows.push(line);
  }

  toJSONL() {
    const head = this.meta ? JSON.stringify(this.meta) : '';
    return [head, ...this.rows].filter(Boolean).join('\n');
  }

  download(prefix = 'guidao_trace') {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const blob = new Blob([this.toJSONL()], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${prefix}_${stamp}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}
