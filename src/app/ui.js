// 浏览器实时界面：真实视频/摄像头 -> YOLO 检测 + 逼近跟踪 -> 叠加层 + 分级语音提示。
import { GuidePipeline } from './pipeline.js';
import { FrameRecorder } from './recorder.js';
import { classifyAnnouncement, SpeechAnnouncer, environmentCandidate } from './announce.js';
import { classifyPitchChange } from '../vision/terrain.js';
import { TileMap } from '../nav/tilemap.js';
import { NavigationController } from '../nav/navigation.js';

const $ = (id) => document.getElementById(id);
const DEMO_VIDEO = 'assets/videos/narrow_street_approach.mp4';

const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const analysis = document.createElement('canvas');
const analysisCtx = analysis.getContext('2d', { willReadFrequently: true });
const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

const LAYER_COLORS = ['rgba(148,163,184,0.55)', '#a78bfa', '#34d399', '#f472b6'];

const state = {
  pipeline: new GuidePipeline({
    fps: 30,
    cameraHeight: 1.5,
    horizonRatio: 0.5,
    cameraPitchDeg: 10,
    distanceMode: 'ground',
  }),
  source: null,
  stream: null,
  objectUrl: null,
  running: true,
  analysisWidth: 320,
  fps: 30,
  cameraHeight: 1.5,
  horizonRatio: 0.5,
  cameraPitchDeg: 10,
  predictSec: 1.4,
  slope: null,
  terrainStatus: '未启用',
  pitchBaseline: null,
  pitchSamples: [],
  pitchCandidate: null,
  pitchSince: 0,
  calibrateStart: 0,
  lastTargetSpeechAt: 0,
  // 路面危险语音的最近时间；导航语音必须让路 2 秒。
  lastHazardSpeechAt: 0,
  navigation: null,
  tileMap: null,
  navRecognition: null,
  frameIndex: 0,
  debug: new URLSearchParams(location.search).get('debug') === '1',
  debugAlerts: [],
  debugFrames: [],
  debugSpeech: [],
  lastVideoTime: -1,
  lastProcessAt: 0,
  lastPanelAt: 0,
  disp: { x: 0, y: 0, w: 0, h: 0, dpr: 1 },
  show: { flow: true, tracks: true, predict: true, corridor: true },
  speech: true,
  vibration: true,
  uiMode: 'simple',
  lastStatusLevel: 'safe',
  loadingTimers: [],
  seeking: false,
  lastResult: null,
  startAt: 0,
  detector: null,
  yoloReady: false,
  busy: false,
  lastDetectMs: 0,
  lastProcessedFrame: null,
  announcer: new SpeechAnnouncer(),
  terrainAnnouncer: new SpeechAnnouncer({
    stairsCooldown: 4000,
    slopeCooldown: 6000,
    crosswalkCooldown: 4000,
    redCooldown: 5000,
    greenCooldown: 8000,
    yellowCooldown: 5000,
    groundCooldown: 5000,
    globalCooldown: 800,
    downgradeHold: 0,
  }),
  recorder: new FrameRecorder({ maxFrames: 5000, pointStep: 5 }),
};
if (state.debug) {
  window.__guidaoAlerts = state.debugAlerts;
  window.__guidaoFrames = state.debugFrames;
  window.__guidaoSpeech = state.debugSpeech;
}
// 三条核心语音用预录音频，绕开 speechSynthesis 的排队抖动；环境提醒仍用合成语音。
const VOICE_FILES = {
  rush: 'demo/audio/rush.wav',
  static: 'demo/audio/static.wav',
  uncertain: 'demo/audio/uncertain.wav',
};
const voiceAudio = {};
for (const [kind, file] of Object.entries(VOICE_FILES)) {
  const a = new Audio(file);
  a.preload = 'auto';
  voiceAudio[kind] = a;
}

function updateDisplayRect() {
  if (!video.videoWidth) return;
  const wrap = $('videoWrap');
  const vr = video.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  if (vr.width < 2 || vr.height < 2) return;
  const scale = Math.min(vr.width / video.videoWidth, vr.height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  const x = vr.left - wr.left + (vr.width - w) / 2;
  const y = vr.top - wr.top + (vr.height - h) / 2;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  state.disp = { x, y, w, h, dpr };
  overlay.style.left = `${x}px`;
  overlay.style.top = `${y}px`;
  overlay.style.width = `${w}px`;
  overlay.style.height = `${h}px`;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (overlay.width !== pw || overlay.height !== ph) {
    overlay.width = pw;
    overlay.height = ph;
  }
}

function setupAnalysis() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  let aw = state.analysisWidth;
  let ah = Math.round((aw * vh) / vw);
  if (ah > 540) {
    ah = 540;
    aw = Math.round((ah * vw) / vh);
  }
  aw -= aw % 2;
  ah -= ah % 2;
  aw = Math.max(64, aw);
  ah = Math.max(64, ah);
  analysis.width = aw;
  analysis.height = ah;
  window.__guidaoAnalysis = { width: aw, height: ah };
  frameCanvas.width = vw;
  frameCanvas.height = vh;
  state.pipeline.reset();
  state.announcer.reset();
  state.frameIndex = 0;
  state.lastVideoTime = -1;
  updateDisplayRect();
  const label = state.source === 'camera' ? '摄像头' : '本地真实视频';
  $('sourceName').textContent = `${label} · 源 ${vw}×${vh} · 分析 ${aw}×${ah}`;
  $('status').textContent = state.source === 'camera' ? '摄像头实时分析中' : '真实视频分析中';
  $('empty').hidden = true;
}

async function processFrame(ts) {
  if (state.busy || !video.videoWidth || !analysis.width) return;
  state.busy = true;
  const procStart = performance.now();
  try {
    if (frameCanvas.width !== video.videoWidth || frameCanvas.height !== video.videoHeight) {
      frameCanvas.width = video.videoWidth;
      frameCanvas.height = video.videoHeight;
    }
    // 先抓同一帧，再分别给 YOLO 和管线，避免推理期间视频前进导致框与画面错位。
    frameCtx.drawImage(video, 0, 0);
    analysisCtx.drawImage(frameCanvas, 0, 0, analysis.width, analysis.height);
    const image = analysisCtx.getImageData(0, 0, analysis.width, analysis.height);

    let detections = [];
    let detectMs = 0;
    if (state.detector && state.yoloReady) {
      const t0 = performance.now();
      // 部分机器的 WebGPU 推理会永久挂起，必须限时并回退，不能把实时循环卡死。
      const out = await Promise.race([
        state.detector.detect(frameCanvas, frameCanvas.width, frameCanvas.height),
        new Promise((_, reject) => setTimeout(() => reject(new Error('YOLO 推理超时')), 3000)),
      ]);
      detectMs = performance.now() - t0;
      const sx = analysis.width / frameCanvas.width;
      const sy = analysis.height / frameCanvas.height;
      detections = out.boxes.map((d) => ({
        ...d,
        bbox: { x: d.bbox.x * sx, y: d.bbox.y * sy, w: d.bbox.w * sx, h: d.bbox.h * sy },
      }));
    }
    state.lastDetectMs = detectMs;

    const isFile = state.source === 'file';
    if (isFile && state.lastVideoTime > 0 && video.currentTime < state.lastVideoTime - 0.5) {
      // 视频循环回到开头：清空轨迹与播报状态，避免跨越循环的错误关联。
      state.pipeline.reset();
      state.announcer.reset();
      state.lastProcessedFrame = null;
    }
    const frameIndex = isFile ? Math.round(video.currentTime * state.fps) : state.frameIndex++;
    const prev = state.lastProcessedFrame;
    const dt = isFile && prev !== null ? Math.max(1, frameIndex - prev) / state.fps : 1 / state.fps;
    state.lastProcessedFrame = frameIndex;

    const res = state.pipeline.process(image, frameIndex, { detections, dt });
    state.lastResult = res;
    if (state.debug) {
      const risk = res.risk;
      state.debugFrames.push({
        frame: res.frame.index,
        t: Math.round(performance.now() * 10) / 10,
        dt: Math.round(dt * 10000) / 10000,
        procMs: Math.round((performance.now() - procStart) * 10) / 10,
        detectMs: Math.round(detectMs * 10) / 10,
        detections: detections.map((d) => ({
          cls: d.cls,
          score: Math.round(d.score * 1000) / 1000,
          bbox: {
            x: Math.round(d.bbox.x * 10) / 10,
            y: Math.round(d.bbox.y * 10) / 10,
            w: Math.round(d.bbox.w * 10) / 10,
            h: Math.round(d.bbox.h * 10) / 10,
          },
        })),
        alerts: risk ? risk.alerts.map((a) => ({ level: a.level, trackId: a.trackId })) : [],
        primaryId: risk && risk.primaryId !== undefined ? risk.primaryId : null,
        sceneMode: risk && risk.sceneMode ? risk.sceneMode : null,
        perTrack: risk
          ? risk.perTrack.map((p) => ({
              id: p.id,
              cls: p.cls,
              className: p.className,
              score: p.score,
              hits: p.hits,
              level: p.level,
              confirmed: p.confirmed,
              inPath: p.inPath,
              inStrict: p.inStrict,
              approaching: p.approaching,
              crossing: Boolean(p.crossing),
              motionState: p.motionState,
              heightRate: typeof p.heightRate === 'number' ? Math.round(p.heightRate * 1000) / 1000 : null,
              flowRadialRate:
                typeof p.flowRadialRate === 'number' ? Math.round(p.flowRadialRate * 1000) / 1000 : null,
              flowRadialMean:
                typeof p.flowRadialMean === 'number' ? Math.round(p.flowRadialMean * 1000) / 1000 : null,
              flowRadialPoints: p.flowRadialPoints ?? 0,
              ttc: p.ttc === null ? null : Math.round(p.ttc * 100) / 100,
              distance: p.distance === null ? null : Math.round(p.distance * 10) / 10,
              bbox: {
                x: Math.round(p.bbox.x * 10) / 10,
                y: Math.round(p.bbox.y * 10) / 10,
                w: Math.round(p.bbox.w * 10) / 10,
                h: Math.round(p.bbox.h * 10) / 10,
              },
            }))
          : [],
        corridor: risk && risk.corridor
          ? { apex: risk.corridor.apex, halfWidth: risk.corridor.halfWidth, wide: risk.corridor.wide, poly: risk.corridor.poly }
          : null,
      });
      if (state.debugFrames.length > 5000) state.debugFrames.shift();
    }
    if (state.recorder.active) state.recorder.add(res);
    drawOverlay(res);
    const now = ts ?? performance.now();
    if (now - state.lastPanelAt > 120) {
      state.lastPanelAt = now;
      updatePanel(res);
    }
    handleAlert(res);
    state.lastVideoTime = video.currentTime;
    state.lastProcessAt = now;
  } catch (err) {
    console.error(err);
    if (state.yoloReady && /超时/.test(err.message)) {
      state.yoloReady = false;
      state.detector = null;
      state.pipeline.setOptions({ yoloDetect: false });
      state.pipeline.reset();
      $('enginePill').textContent = 'YOLO 超时 · 运动分层';
      $('status').textContent = 'YOLO 推理超时，已回退运动分层';
    } else {
      $('status').textContent = `处理失败：${err.message}`;
    }
  } finally {
    state.busy = false;
  }
}

let rafId = 0;
function tick(ts) {
  rafId = requestAnimationFrame(tick);
  const v = video;
  if (!state.running || state.busy || !v.videoWidth || v.readyState < 2) return;
  if (state.source === 'camera') {
    if (ts - state.lastProcessAt < 1000 / Math.max(10, state.fps)) return;
  } else if (state.source === 'file') {
    if (v.paused) return;
    if (v.currentTime === state.lastVideoTime) return;
  } else {
    return;
  }
  processFrame(ts);
}

function drawOverlay(res) {
  updateDisplayRect();
  const ctx = overlayCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  // 简洁模式不绘制任何叠加层；检测框、标签、走廊虚线只在调试模式显示。
  if (state.uiMode !== 'debug') return;
  if (!res || !res.frame || overlay.width < 2) return;
  const dpr = state.disp.dpr;
  const sx = overlay.width / res.frame.width;
  const sy = overlay.height / res.frame.height;
  const X = (x) => x * sx;
  const Y = (y) => y * sy;
  const lw = Math.max(1, dpr);

  if (state.show.corridor && res.risk) {
    const c = res.risk.corridor;
    ctx.beginPath();
    ctx.moveTo(X(c.apex.x), Y(c.apex.y));
    ctx.lineTo(X(c.poly[1].x), Y(c.poly[1].y));
    ctx.lineTo(X(c.poly[2].x), Y(c.poly[2].y));
    ctx.closePath();
    ctx.fillStyle = 'rgba(56,189,248,0.10)';
    ctx.fill();
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(56,189,248,0.7)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (state.show.flow && res.seg && res.flow) {
    const pts = res.flow.src;
    const size = Math.max(1.6, 1.4 * dpr);
    for (let li = 0; li < res.seg.layers.length; li++) {
      const L = res.seg.layers[li];
      ctx.fillStyle = LAYER_COLORS[Math.min(li, LAYER_COLORS.length - 1)];
      ctx.beginPath();
      for (let k = 0; k < L.indices.length; k++) {
        const i = L.indices[k];
        ctx.rect(X(pts[2 * i]) - size / 2, Y(pts[2 * i + 1]) - size / 2, size, size);
      }
      ctx.fill();
    }
    if (res.seg.leftover && res.seg.leftover.length) {
      ctx.fillStyle = 'rgba(251,191,36,0.9)';
      ctx.beginPath();
      for (let k = 0; k < res.seg.leftover.length; k++) {
        const i = res.seg.leftover[k];
        ctx.rect(X(pts[2 * i]) - size / 2, Y(pts[2 * i + 1]) - size / 2, size, size);
      }
      ctx.fill();
    }
  }

  if (res.seg) {
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.lineWidth = Math.max(1, dpr * 1.1);
    ctx.strokeStyle = 'rgba(251,191,36,0.75)';
    for (const o of res.seg.objects) {
      const b = o.bbox;
      ctx.strokeRect(X(b.x), Y(b.y), X(b.w), Y(b.h));
    }
    ctx.setLineDash([]);
  }

  const riskById = new Map();
  if (res.risk) for (const p of res.risk.perTrack) riskById.set(p.id, p);

  if (state.show.tracks) {
    for (const tr of res.tracks) {
      if (!tr.confirmed) continue;
      const p = riskById.get(tr.id);
      const level = p ? p.level : 0;
      const color = level >= 4 ? '#ef4444' : level === 3 ? '#fb923c' : level === 2 ? '#facc15' : '#2dd4bf';
      const b = tr.bbox;
      ctx.lineWidth = level >= 3 ? 2.2 * dpr : 1.6 * dpr;
      ctx.strokeStyle = color;
      ctx.strokeRect(X(b.x), Y(b.y), X(b.w), Y(b.h));
      const label = `#${tr.id}${p ? ` ${p.distance.toFixed(1)}m` : ''}${p && p.ttc ? ` ${p.ttc.toFixed(1)}s` : ''}`;
      ctx.font = `${Math.round(11 * dpr)}px "Segoe UI", sans-serif`;
      const tw = ctx.measureText(label).width;
      const lx = Math.max(0, X(b.x));
      const ly = Math.max(0, Y(b.y) - 16 * dpr);
      ctx.fillStyle = 'rgba(4,7,12,0.72)';
      ctx.fillRect(lx, ly, tw + 8 * dpr, 15 * dpr);
      ctx.fillStyle = color;
      ctx.fillText(label, lx + 4 * dpr, ly + 11 * dpr);
    }
  }

  if (state.show.predict && res.risk) {
    for (const p of res.risk.perTrack) {
      if (!p.confirmed || !p.path || p.path.length < 2) continue;
      const color =
        p.level >= 4
          ? 'rgba(239,68,68,0.95)'
          : p.level === 3
            ? 'rgba(251,146,60,0.9)'
            : p.predictedInPath
              ? 'rgba(250,204,21,0.9)'
              : 'rgba(45,212,191,0.8)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(X(p.path[0].x), Y(p.path[0].y));
      for (let k = 1; k < p.path.length; k++) ctx.lineTo(X(p.path[k].x), Y(p.path[k].y));
      ctx.stroke();
      const last = p.path[p.path.length - 1];
      ctx.beginPath();
      ctx.arc(X(last.x), Y(last.y), 3.2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      // 末端标出预判秒数，提醒这是短时外推而不是确定轨迹。
      const label = `${(p.predictSec ?? state.predictSec).toFixed(1)}s`;
      ctx.font = `${Math.round(9 * dpr)}px "Segoe UI", sans-serif`;
      const tw = ctx.measureText(label).width;
      const lx = Math.min(overlay.width - tw - 8 * dpr, X(last.x) + 5 * dpr);
      const ly = Math.max(2, Y(last.y) - 7 * dpr);
      ctx.fillStyle = 'rgba(4,7,12,0.72)';
      ctx.fillRect(lx, ly, tw + 6 * dpr, 13 * dpr);
      ctx.fillStyle = color;
      ctx.fillText(label, lx + 3 * dpr, ly + 10 * dpr);
    }
  }

  if (res.foe && Number.isFinite(res.foe.x) && Number.isFinite(res.foe.y)) {
    const fx = X(res.foe.x);
    const fy = Y(res.foe.y);
    if (fx > 0 && fy > 0 && fx < overlay.width && fy < overlay.height) {
      ctx.strokeStyle = 'rgba(56,189,248,0.9)';
      ctx.lineWidth = 1.5 * dpr;
      const r = 7 * dpr;
      ctx.beginPath();
      ctx.moveTo(fx - r, fy);
      ctx.lineTo(fx + r, fy);
      ctx.moveTo(fx, fy - r);
      ctx.lineTo(fx, fy + r);
      ctx.stroke();
    }
  }
}

function setBar(barId, valId, value, max) {
  const pct = Math.max(2, Math.min(100, (value / Math.max(1, max)) * 100));
  $(barId).style.width = `${pct}%`;
  $(valId).textContent = `${value.toFixed(1)} ms`;
}

function updatePanel(res) {
  const t = res.timings;
  const seg = res.seg;
  const detect = state.lastDetectMs || 0;
  const totalMs = t.total + detect;
  $('stFps').textContent = totalMs > 0 ? (1000 / totalMs).toFixed(1) : '–';
  $('stMs').textContent = `${totalMs.toFixed(1)} ms`;
  $('stDetect').textContent = state.yoloReady ? `${detect.toFixed(1)} ms` : '–';
  $('stMode').textContent = res.mode === 'yolo' ? 'YOLO' : '运动分层';
  $('stRisk').textContent = res.risk ? `${res.risk.perTrack.length} / ${res.risk.alerts.length}` : '–';
  $('stDistance').textContent =
    res.risk && res.risk.perTrack.length
      ? res.risk.perTrack[0].distanceSource === 'ground'
        ? '相机高度'
        : '框高'
      : '–';
  $('stTerrain').textContent = res.terrain && res.terrain.stairs
    ? '台阶'
    : state.slope === 'up'
      ? '上坡'
      : state.slope === 'down'
        ? '下坡'
        : state.slope === 'unknown'
          ? '坡道?'
          : '平坦/未知';
  $('stTraffic').textContent =
    res.traffic && res.traffic.color === 'red'
      ? '红灯'
      : res.traffic && res.traffic.color === 'green'
        ? '绿灯'
        : res.traffic && res.traffic.color === 'yellow'
          ? '黄灯'
          : '–';
  $('stCrosswalk').textContent =
    res.crosswalk && res.crosswalk.off
      ? '偏离'
      : res.crosswalk && res.crosswalk.active
        ? '在线内'
        : '–';
  $('stPoints').textContent = `${res.flowStats.valid} / ${res.flowStats.used}`;
  $('stBg').textContent = seg ? `${(seg.stats.bgInlierRatio * 100).toFixed(1)}%` : '–';
  $('stLayers').textContent = seg ? String(seg.stats.layerCount) : '–';
  $('stObjects').textContent = seg ? String(seg.stats.objectCount) : '–';
  $('stTracks').textContent = String(res.tracks.filter((x) => x.confirmed).length);
  $('stRansac').textContent = seg ? String(seg.stats.ransacIterations) : '–';
  const max = Math.max(totalMs, 1);
  setBar('tDetect', 'vDetect', detect, max);
  setBar('tGray', 'vGray', t.gray, max);
  setBar('tPyr', 'vPyr', t.pyramid, max);
  setBar('tFlow', 'vFlow', t.flow, max);
  setBar('tSeg', 'vSeg', t.segment, max);
  setBar('tTrack', 'vTrack', t.track, max);

  const rec = state.recorder;
  if (rec.active) {
    $('recStatus').textContent = `记录中 ${rec.frameCount} 帧 · ~${Math.round(rec.bytes / 1024)} KB`;
  }

  const instruction = $('instruction');
  instruction.textContent = res.risk ? res.risk.instruction : '前方通畅，可以直行';
}

function announceDanger(text) {
  const live = $('dangerLive');
  if (!live) return;
  // 同一句话重复时读屏可能不播；先清空再写入。
  live.textContent = '';
  window.setTimeout(() => {
    live.textContent = text;
  }, 30);
}

function vibrate(pattern) {
  if (!state.vibration || !navigator.vibrate) return;
  // 浏览器要求页面先有用户交互才允许震动；未交互时直接跳过，避免控制台报错。
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  navigator.vibrate(pattern);
}

function setStatusBanner(level, text) {
  const banner = $('alert');
  if (!banner) return;
  const safe = level !== 'attention' && level !== 'danger';
  const next = safe ? 'safe' : level;
  banner.className = `status-banner ${next}`;
  $('alertLevel').textContent = next === 'danger' ? '危险' : next === 'attention' ? '注意' : '安全';
  $('alertText').textContent = text || (next === 'safe' ? '前方通畅，可以直行' : '');
  $('videoWrap').classList.toggle('danger-frame', next === 'danger');
  if (next === 'danger' && state.lastStatusLevel !== 'danger') {
    announceDanger(text || '危险，请停下');
    vibrate([120, 60, 120]);
  } else if (next === 'attention' && state.lastStatusLevel === 'safe') {
    vibrate(80);
  }
  state.lastStatusLevel = next;
}

function handleAlert(res) {
  const now = performance.now();
  const cand = classifyAnnouncement(res.risk);
  let targetVisible = false;
  if (cand) {
    targetVisible = true;
    const level = cand.kind === 'rush' || cand.level >= 4 ? 'danger' : 'attention';
    setStatusBanner(level, cand.text);
    const speak = state.announcer.shouldSpeak(cand, now);
    if (speak) {
      addLog(cand.text, cand.level);
      if (state.debug) {
        const p = res.risk && res.risk.perTrack ? res.risk.perTrack.find((x) => x.id === cand.trackId) : null;
        state.debugAlerts.push({
          kind: cand.kind,
          trackId: cand.trackId,
          level: cand.level,
          frame: res.frame ? res.frame.index : state.frameIndex,
          bbox: p && p.bbox ? p.bbox : null,
          text: cand.text,
        });
      }
      if (state.speech) speakAnnouncement(cand);
      state.lastTargetSpeechAt = now;
      return;
    }
  }

  // 环境提醒：地形/红绿灯/斑马线/地面异物；目标语音刚播完时先让路 2 秒。
  const envCand = environmentCandidate(res, state.slope);
  if (envCand && now - state.lastTargetSpeechAt > 2000) {
    setStatusBanner('attention', envCand.text);
    if (state.terrainAnnouncer.shouldSpeak(envCand, now)) {
      addLog(envCand.text, envCand.level);
      if (state.debug) {
        state.debugAlerts.push({
          kind: envCand.kind,
          trackId: -1,
          level: envCand.level,
          frame: res.frame ? res.frame.index : state.frameIndex,
          bbox: null,
          text: envCand.text,
        });
      }
      if (state.speech) speakAnnouncement(envCand);
    }
    return;
  }
  if (targetVisible) return;

  const top = res.risk && res.risk.topAlert;
  if (top && top.level >= 2) {
    const level = top.level >= 4 ? 'danger' : 'attention';
    setStatusBanner(level, top.text);
  } else {
    const text = res.risk && res.risk.instruction ? res.risk.instruction : '前方通畅，可以直行';
    setStatusBanner('safe', text);
  }
}

function recordSpeech(cand, queuedAt, startedAt) {
  if (!state.debug) return;
  state.debugSpeech.push({
    kind: cand.kind,
    text: cand.text,
    frame: state.lastResult && state.lastResult.frame ? state.lastResult.frame.index : null,
    queuedAt: Math.round(queuedAt * 10) / 10,
    startedAt: Math.round(startedAt * 10) / 10,
    queueMs: Math.round((startedAt - queuedAt) * 10) / 10,
  });
}

function speakAnnouncement(cand) {
  const queuedAt = performance.now();
  // 路面/环境危险优先：记录时间并打断正在播的导航语音。
  state.lastHazardSpeechAt = queuedAt;
  if (state.navigation) state.navigation.cancelSpeech();
  const pre = voiceAudio[cand.kind];
  if (pre) {
    // 预录音频：先停掉正在播的语音，再从头播；rush 优先级最高。
    for (const a of Object.values(voiceAudio)) {
      if (a !== pre && !a.paused) a.pause();
    }
    pre.pause();
    pre.currentTime = 0;
    pre.onplaying = () => recordSpeech(cand, queuedAt, performance.now());
    const p = pre.play();
    if (p && p.catch) p.catch(() => {});
  } else if ('speechSynthesis' in window) {
    if (cand.kind === 'rush') window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(cand.text);
    u.lang = 'zh-CN';
    u.rate = cand.kind === 'rush' ? 1.18 : 1.05;
    u.pitch = cand.kind === 'rush' ? 1.05 : 1;
    u.onstart = () => recordSpeech(cand, queuedAt, performance.now());
    window.speechSynthesis.speak(u);
  }
  vibrate(cand.kind === 'rush' ? [120, 60, 120] : 70);
}

function addLog(text, level) {
  const list = $('log');
  const muted = list.querySelector('.muted');
  if (muted) muted.remove();
  const li = document.createElement('li');
  li.className = level >= 4 ? 'critical' : level === 3 ? 'high' : 'medium';
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  li.appendChild(time);
  li.appendChild(document.createTextNode(text));
  list.prepend(li);
  while (list.children.length > 20) list.lastElementChild.remove();
}

function updatePlayLabel() {
  const btn = $('playBtn');
  if (!btn) return;
  const playing = !video.paused;
  btn.textContent = playing ? '停止' : '开始';
  btn.setAttribute('aria-pressed', String(playing));
}

function updateMuteButton() {
  const btn = $('muteBtn');
  const toggle = $('speechToggle');
  if (toggle) toggle.checked = state.speech;
  if (!btn) return;
  btn.textContent = state.speech ? '静音' : '开启声音';
  btn.setAttribute('aria-pressed', String(!state.speech));
  btn.setAttribute('aria-label', state.speech ? '静音' : '开启声音');
}

function setSpeechEnabled(enabled) {
  state.speech = Boolean(enabled);
  if (!state.speech && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  updateMuteButton();
}

function loadDemo() {
  hideSourceError();
  loadUrl(DEMO_VIDEO);
}

function showSourceError(text) {
  const box = $('sourceError');
  if (!box) return;
  $('sourceErrorText').textContent = text;
  box.hidden = false;
}

function hideSourceError() {
  const box = $('sourceError');
  if (box) box.hidden = true;
}

function openSourceSheet() {
  const sheet = $('sourceSheet');
  if (!sheet) return;
  if (typeof sheet.showModal === 'function') sheet.showModal();
  else sheet.setAttribute('open', '');
}

function closeSourceSheet() {
  const sheet = $('sourceSheet');
  if (!sheet) return;
  if (typeof sheet.close === 'function') sheet.close();
  else sheet.removeAttribute('open');
}

function stopCamera() {
  if (state.stream) {
    for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
  }
}

function loadFile(file) {
  if (!file) return;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  loadUrl(state.objectUrl);
}

function loadUrl(url) {
  stopCamera();
  hideSourceError();
  state.source = 'file';
  const params = new URLSearchParams(location.search);
  const t = Number(params.get('t'));
  state.startAt = Number.isFinite(t) && t > 0 ? t : 0;
  video.pause();
  video.srcObject = null;
  video.src = url;
  video.loop = true;
  video.muted = true;
  $('empty').hidden = true;
  $('status').textContent = '视频已载入 · 准备检测';
  if (state.startAt > 0) {
    // 指定起始时间时先暂停，等 YOLO 就绪后再从该时间播放，保证演示段被完整判定。
    video.pause();
  } else {
    video.play().catch(() => {});
  }
  updatePlayLabel();
}

async function startCamera() {
  try {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('浏览器不支持摄像头');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.stream = stream;
    state.source = 'camera';
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
    video.src = '';
    video.srcObject = stream;
    video.loop = false;
    $('empty').hidden = true;
    hideSourceError();
    await video.play();
    $('status').textContent = '摄像头已开启';
    updatePlayLabel();
  } catch (err) {
    $('status').textContent = `摄像头不可用：${err.message}`;
    showSourceError('摄像头未授权或没有可用设备。可以先用示例视频体验。');
  }
}

function stepFrame(dir) {
  if (!video.duration || !Number.isFinite(video.duration)) return;
  video.pause();
  updatePlayLabel();
  const dt = 1 / state.fps;
  const target = Math.min(video.duration - 0.001, Math.max(0, video.currentTime + dir * dt));
  state.seeking = true;
  video.currentTime = target;
}

video.addEventListener('play', updatePlayLabel);
video.addEventListener('pause', updatePlayLabel);

video.addEventListener('loadedmetadata', () => {
  updatePlayLabel();
  setupAnalysis();
  if (state.startAt > 0 && state.startAt < video.duration) {
    state.lastProcessedFrame = null;
    video.currentTime = state.startAt;
    if (state.yoloReady) video.play().catch(() => {});
    else video.pause();
    updatePlayLabel();
  }
});

video.addEventListener('seeked', () => {
  if (!state.seeking) return;
  state.seeking = false;
  if (video.paused) processFrame(performance.now());
});

$('fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files && e.target.files[0]);
});

$('cameraBtn').addEventListener('click', startCamera);

$('demoBtn').addEventListener('click', loadDemo);

$('recBtn').addEventListener('click', () => {
  const rec = state.recorder;
  if (rec.active) {
    rec.stop();
    $('recBtn').textContent = '● 记录中间结果';
    $('recBtn').classList.remove('primary');
    if (rec.frameCount) {
      rec.download();
      $('recStatus').textContent = `已导出 ${rec.frameCount} 帧`;
    } else {
      $('recStatus').textContent = '未捕获帧';
    }
  } else {
    rec.start({
      source: state.source || 'none',
      sourceSize: [video.videoWidth || 0, video.videoHeight || 0],
      analysisSize: [analysis.width, analysis.height],
      fps: state.fps,
      options: { ...state.pipeline.options },
    });
    $('recBtn').textContent = '■ 停止并导出';
    $('recBtn').classList.add('primary');
    $('recStatus').textContent = '记录中 0 帧';
  }
});

$('playBtn').addEventListener('click', () => {
  if (!video.src && !video.srcObject) {
    openSourceSheet();
    return;
  }
  if (video.paused) video.play().catch(() => {});
  else video.pause();
  updatePlayLabel();
});

$('muteBtn').addEventListener('click', () => setSpeechEnabled(!state.speech));
$('sourceBtn').addEventListener('click', openSourceSheet);
$('sheetDemo').addEventListener('click', () => {
  closeSourceSheet();
  loadDemo();
});
$('sheetFile').addEventListener('click', () => {
  closeSourceSheet();
  $('fileInput').click();
});
$('sheetCamera').addEventListener('click', () => {
  closeSourceSheet();
  startCamera();
});
$('sheetClose').addEventListener('click', closeSourceSheet);
$('sourceErrorSample').addEventListener('click', loadDemo);
$('vibrationToggle').addEventListener('change', (e) => {
  state.vibration = e.target.checked;
});

$('prevBtn').addEventListener('click', () => stepFrame(-1));
$('nextBtn').addEventListener('click', () => stepFrame(1));

$('precisionToggle').addEventListener('change', (e) => {
  state.pipeline.setOptions({ fbCheck: e.target.checked });
  state.pipeline.reset();
  state.frameIndex = 0;
});

$('speechToggle').addEventListener('change', (e) => setSpeechEnabled(e.target.checked));

$('resSelect').addEventListener('change', (e) => {
  state.analysisWidth = Number(e.target.value);
  setupAnalysis();
});

$('fpsSelect').addEventListener('change', (e) => {
  state.fps = Number(e.target.value);
  state.pipeline.setOptions({ fps: state.fps });
});

function applyDistanceOptions() {
  state.pipeline.setOptions({
    cameraHeight: state.cameraHeight,
    horizonRatio: state.horizonRatio,
    cameraPitchDeg: state.cameraPitchDeg,
    distanceMode: 'ground',
  });
}

$('cameraHeight').addEventListener('change', (e) => {
  const v = Math.min(2.5, Math.max(0.3, Number(e.target.value) || 1.5));
  e.target.value = String(v);
  state.cameraHeight = v;
  applyDistanceOptions();
});

$('cameraPitch').addEventListener('change', (e) => {
  const v = Math.min(45, Math.max(-10, Number(e.target.value) || 0));
  e.target.value = String(v);
  state.cameraPitchDeg = v;
  applyDistanceOptions();
});

$('predictSec').addEventListener('change', (e) => {
  const v = Math.min(2.5, Math.max(0.8, Number(e.target.value) || 1.4));
  e.target.value = String(v);
  state.predictSec = v;
  state.pipeline.setOptions({ horizonSec: v });
});

const toggle = (id, key) => {
  $(id).addEventListener('change', (e) => {
    state.show[key] = e.target.checked;
  });
};
toggle('showFlow', 'flow');
toggle('showTracks', 'tracks');
toggle('showPredict', 'predict');
toggle('showCorridor', 'corridor');

const wrap = $('videoWrap');
wrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  wrap.style.outline = '2px dashed rgba(45,212,191,0.7)';
});
wrap.addEventListener('dragleave', () => {
  wrap.style.outline = '';
});
wrap.addEventListener('drop', (e) => {
  e.preventDefault();
  wrap.style.outline = '';
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && file.type.startsWith('video/')) loadFile(file);
});

window.addEventListener('resize', updateDisplayRect);
if ('ResizeObserver' in window) new ResizeObserver(updateDisplayRect).observe(video);

document.addEventListener('visibilitychange', () => {
  state.running = !document.hidden;
});

function setupNavigation() {
  const canvas = $('navMap');
  if (!canvas) return;
  const statusEl = $('navStatus');
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };
  const canSpeak = () =>
    state.speech &&
    performance.now() - (state.lastHazardSpeechAt || 0) > 2000 &&
    !(window.speechSynthesis && window.speechSynthesis.speaking);
  const speak = (text) => {
    if (!state.speech || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  };
  const map = new TileMap(canvas, {
    onDestination: (lat, lon) => {
      $('navLat').value = lat.toFixed(6);
      $('navLon').value = lon.toFixed(6);
      map.setDestination(lat, lon);
      state.navigation.setDestination(lat, lon);
      setStatus('已在地图上设置目的地。点“开始导航”后播报方向和距离。');
    },
  });
  const nav = new NavigationController({
    canSpeak,
    speak,
    onStatus: (s) => {
      setStatus(s.text);
      if (s.position) map.setPosition(s.position.lat, s.position.lon);
      if (s.destination) map.setDestination(s.destination.lat, s.destination.lon);
    },
    onPosition: (p) => {
      map.setPosition(p.lat, p.lon);
    },
    onHeading: (h) => map.setHeading(h),
  });
  state.navigation = nav;
  state.tileMap = map;
  window.addEventListener('resize', () => map.draw());
  const navDetails = $('navDetails');
  if (navDetails) {
    navDetails.addEventListener('toggle', () => {
      if (navDetails.open) requestAnimationFrame(() => map.draw());
    });
  }

  const setFromInputs = () => {
    const lat = Number($('navLat').value);
    const lon = Number($('navLon').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setStatus('请输入有效的纬度和经度。');
      return false;
    }
    map.setDestination(lat, lon);
    nav.setDestination(lat, lon);
    return true;
  };

  $('navLocate').addEventListener('click', () => {
    setStatus('正在定位…');
    nav.locateOnce();
  });
  $('navSet').addEventListener('click', () => {
    if (setFromInputs()) setStatus('目的地已设置。点“开始导航”开始播报。');
  });
  $('navStart').addEventListener('click', () => {
    if (!nav.destination && !setFromInputs()) return;
    nav.start();
  });
  $('navStop').addEventListener('click', () => {
    nav.stop();
    nav.cancelSpeech();
  });
  $('navQuery').addEventListener('click', () => nav.query());
  $('navCache').addEventListener('click', async () => {
    setStatus('正在缓存当前区域地图…');
    const r = await map.cacheArea(1);
    setStatus(
      r.ok
        ? `已缓存 ${r.saved}/${r.tiles} 个地图瓦片${r.failed ? `，${r.failed} 个失败` : ''}。`
        : '请先“定位”或设置目的地，再缓存地图。'
    );
  });
  $('navDownload').addEventListener('click', async () => {
    try {
      await map.downloadPng(`guidao-map-${Date.now()}.png`);
      setStatus('当前地图已下载为 PNG。');
    } catch {
      setStatus('地图下载失败：瓦片未加载完或跨域限制。');
    }
  });
  $('navVoice').addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setStatus('当前浏览器不支持语音识别，请用按钮操作。');
      return;
    }
    if (state.navRecognition) {
      try { state.navRecognition.stop(); } catch {}
      state.navRecognition = null;
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
      setStatus(`听到：${text || '（空）'}`);
      if (text && !nav.handleCommand(text)) {
        setStatus(`没有识别到导航指令：${text}`);
      }
    };
    rec.onerror = (e) => setStatus(`语音识别失败：${e.error || '未知错误'}`);
    rec.onend = () => {
      state.navRecognition = null;
    };
    state.navRecognition = rec;
    try {
      rec.start();
      setStatus('请说“开始导航 / 停止 / 还有多远 / 是不是前方”。');
    } catch {
      state.navRecognition = null;
      setStatus('语音识别启动失败，请用按钮操作。');
    }
  });
}

function setLoadingStatus(text) {
  const el = $('loadingText');
  if (el) el.textContent = text;
}

function clearLoadingTimers() {
  for (const t of state.loadingTimers) clearTimeout(t);
  state.loadingTimers = [];
}

function hideLoading() {
  clearLoadingTimers();
  const overlay = $('loadingOverlay');
  if (overlay) overlay.hidden = true;
}

function showLoadingError(message) {
  clearLoadingTimers();
  const title = $('loadingTitle');
  const overlay = $('loadingOverlay');
  if (title) title.textContent = '视觉模型未就绪';
  setLoadingStatus(message || '加载失败，已回退运动分层');
  if (overlay) overlay.hidden = false;
  const bar = overlay && overlay.querySelector('.loading-bar');
  if (bar) bar.hidden = true;
  const sample = $('loadingSampleBtn');
  const cont = $('loadingContinueBtn');
  if (sample) sample.hidden = false;
  if (cont) cont.hidden = false;
}

function setupShell() {
  const simple = $('modeSimpleBtn');
  const debug = $('modeDebugBtn');
  const panel = $('debugPanel');
  const debugBar = $('debugBar');
  const panelToggle = $('debugPanelToggle');
  const panelClose = $('debugPanelClose');
  const layout = $('layout');

  const closePanel = (focusToggle = false) => {
    if (panel) panel.hidden = true;
    if (layout) layout.classList.remove('panel-open');
    if (panelToggle) panelToggle.setAttribute('aria-expanded', 'false');
    if (focusToggle && panelToggle) panelToggle.focus();
  };
  const openPanel = () => {
    if (panel) panel.hidden = false;
    if (layout) layout.classList.add('panel-open');
    if (panelToggle) panelToggle.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      if (state.tileMap) state.tileMap.draw();
      if (panelClose) panelClose.focus();
    });
  };
  const setMode = (mode) => {
    const next = mode === 'debug' ? 'debug' : 'simple';
    state.uiMode = next;
    document.body.dataset.mode = next;
    if (simple) {
      simple.classList.toggle('is-active', next === 'simple');
      simple.setAttribute('aria-pressed', String(next === 'simple'));
    }
    if (debug) {
      debug.classList.toggle('is-active', next === 'debug');
      debug.setAttribute('aria-pressed', String(next === 'debug'));
    }
    if (debugBar) debugBar.hidden = next === 'simple';
    if (overlay) {
      overlay.hidden = next === 'simple';
      if (next === 'simple') overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    }
    if (next === 'simple') closePanel();
    else requestAnimationFrame(() => state.tileMap && state.tileMap.draw());
  };

  if (simple) simple.addEventListener('click', () => setMode('simple'));
  if (debug) debug.addEventListener('click', () => setMode('debug'));
  if (panelToggle) {
    panelToggle.addEventListener('click', () => {
      if (panel && panel.hidden) openPanel();
      else closePanel();
    });
  }
  if (panelClose) panelClose.addEventListener('click', () => closePanel(true));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (panel && !panel.hidden) closePanel(true);
    const sheet = $('sourceSheet');
    if (sheet && sheet.open) sheet.close();
  });

  const sampleBtn = $('loadingSampleBtn');
  if (sampleBtn) {
    sampleBtn.addEventListener('click', () => {
      hideLoading();
      loadDemo();
    });
  }
  const continueBtn = $('loadingContinueBtn');
  if (continueBtn) {
    continueBtn.addEventListener('click', () => hideLoading());
  }

  setMode('simple');
  updatePlayLabel();
  updateMuteButton();
}

async function initYolo() {
  const params = new URLSearchParams(location.search);
  if (params.get('yolo') === '0') {
    hideLoading();
    $('enginePill').textContent = 'YOLO 已关闭 · 运动分层';
    $('status').textContent = 'YOLO 已关闭 · 运动分层';
    return;
  }
  $('loadingTitle').textContent = '正在准备视觉模型';
  setLoadingStatus('加载模型文件…');
  const bar = $('loadingOverlay').querySelector('.loading-bar');
  if (bar) bar.hidden = false;
  state.loadingTimers.push(setTimeout(() => setLoadingStatus('初始化推理后端…'), 500));
  state.loadingTimers.push(setTimeout(() => setLoadingStatus('预热模型…'), 1600));
  try {
    const { YoloDetector } = await import('../detection/yolo.js');
    // 实时循环默认 WASM；需要 WebGPU 时加 ?webgpu=1。
    // 当前 ONNX 固定 1x3x640x640，不能改 inputSize。
    const detector = new YoloDetector({ preferWebGPU: params.get('webgpu') === '1' });
    state.detector = detector;
    await detector.load();
    clearLoadingTimers();
    while (state.busy) await new Promise((r) => setTimeout(r, 50));
    state.yoloReady = true;
    state.pipeline.setOptions({ yoloDetect: true });
    state.pipeline.reset();
    state.frameIndex = 0;
    setLoadingStatus(`模型就绪 · ${detector.backend}`);
    $('enginePill').textContent = `YOLOv8n · ${detector.backend}`;
    if (state.source !== 'camera') $('status').textContent = `YOLO ${detector.backend} · 逼近判定就绪`;
    setTimeout(hideLoading, 300);
    if (state.startAt > 0 && state.source === 'file' && video.readyState >= 1) {
      state.lastProcessedFrame = null;
      video.currentTime = state.startAt;
      video.play().catch(() => {});
      updatePlayLabel();
    }
  } catch (err) {
    console.warn(err);
    $('enginePill').textContent = 'YOLO 不可用 · 运动分层';
    $('status').textContent = `YOLO 加载失败：${err.message}`;
    showLoadingError(`模型加载失败：${err.message}`);
  }
}

function initDistanceOptions() {
  const params = new URLSearchParams(location.search);
  const cam = Number(params.get('cam'));
  if (Number.isFinite(cam) && cam > 0) state.cameraHeight = Math.min(2.5, Math.max(0.3, cam));
  const pitch = Number(params.get('pitch'));
  if (Number.isFinite(pitch)) state.cameraPitchDeg = Math.min(45, Math.max(-10, pitch));
  const horizon = Number(params.get('horizon'));
  if (Number.isFinite(horizon) && horizon > 0 && horizon < 1) state.horizonRatio = horizon;
  const predict = Number(params.get('predict'));
  if (Number.isFinite(predict) && predict > 0) state.predictSec = Math.min(2.5, Math.max(0.8, predict));
  // 调试/对照用：?primary=0 关闭“只报主目标”，?primary=1 强制开启。
  const primary = params.get('primary');
  if (primary === '0' || primary === '1') state.pipeline.setOptions({ primaryOnly: primary === '1' });
  // 调试/对照用：?scene=crowd|crossing|street 固定场景规则，缺省 auto。
  const scene = params.get('scene');
  if (['auto', 'street', 'crowd', 'crossing'].includes(scene)) state.pipeline.setOptions({ sceneMode: scene });
  $('cameraHeight').value = String(state.cameraHeight);
  $('cameraPitch').value = String(state.cameraPitchDeg);
  $('predictSec').value = String(state.predictSec);
  applyDistanceOptions();
  state.pipeline.setOptions({ horizonSec: state.predictSec });
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function initTerrainSensor() {
  const btn = $('terrainBtn');
  const status = $('terrainStatus');
  let attached = false;

  const onOrient = (e) => {
    const beta = Number(e.beta);
    if (!Number.isFinite(beta)) return;
    const now = performance.now();
    state.pitchSamples.push(beta);
    if (state.pitchSamples.length > 40) state.pitchSamples.shift();
    if (state.pitchBaseline === null) {
      if (now - state.calibrateStart > 1500 && state.pitchSamples.length >= 20) {
        state.pitchBaseline = median(state.pitchSamples);
        state.pitchSamples = [];
        state.terrainStatus = '已校准';
        status.textContent = '姿态已校准，开始检测上/下坡';
      }
      return;
    }
    const recent = median(state.pitchSamples.slice(-8));
    const next = classifyPitchChange(state.pitchBaseline, recent);
    if (next !== state.pitchCandidate) {
      state.pitchCandidate = next;
      state.pitchSince = now;
    }
    if (next && now - state.pitchSince > 800) state.slope = next;
    else if (!next) state.slope = null;
  };

  btn.addEventListener('click', async () => {
    if (!('DeviceOrientationEvent' in window)) {
      status.textContent = '当前设备不支持姿态传感器';
      return;
    }
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') {
          status.textContent = '姿态权限被拒绝';
          return;
        }
      }
      if (!attached) {
        window.addEventListener('deviceorientation', onOrient);
        attached = true;
      }
      state.pitchBaseline = null;
      state.pitchSamples = [];
      state.pitchCandidate = null;
      state.pitchSince = 0;
      state.slope = null;
      state.calibrateStart = performance.now();
      state.terrainStatus = '校准中';
      status.textContent = '请把手机放在平常握持角度，在平地上站 2 秒';
      setTimeout(() => {
        if (state.pitchBaseline === null) {
          status.textContent = '没有收到姿态数据（桌面浏览器通常不支持）';
        }
      }, 2500);
    } catch (err) {
      status.textContent = `姿态不可用：${err.message}`;
    }
  });
}

initDistanceOptions();
initTerrainSensor();
setupShell();
setupNavigation();
initYolo();
requestAnimationFrame(tick);

const demoParam = new URLSearchParams(location.search).get('video');
if (demoParam) loadUrl(demoParam);
