// 评测台交互：GT 标注 + 真实视频评测 + 结果导出。
import { runBench, resultToCSV } from './bench.js';
import { PIPELINE_DEFAULTS } from '../src/app/pipeline.js';

const $ = (id) => document.getElementById(id);
const video = $('evalVideo');
const canvas = $('annoCanvas');
const ctx = canvas.getContext('2d');

const CLS_COLORS = { ped: '#38bdf8', veh: '#f59e0b', static: '#a78bfa' };
const CLS_NAMES = { ped: '行人', veh: '车辆', static: '静止障碍' };
const CHECK_KEY = 'guidao.checklist';

const state = {
  name: '',
  gt: { name: '', width: 0, height: 0, fps: 30, frames: {} },
  frame: 0,
  fps: 30,
  cls: 'ped',
  pressing: false,
  drawStart: null,
  drawCur: null,
  selectedId: null,
  undoStack: [],
  result: null,
  baseline: null,
  overrides: {},
  yoloOptions: {},
  busy: false,
  sliderActive: false,
  saveTimer: null,
};

function totalFrames() {
  if (!video.duration || !Number.isFinite(video.duration)) return 0;
  return Math.max(0, Math.floor(video.duration * state.fps) - 1);
}

function syncCanvas() {
  if (!video.videoWidth) return;
  const vr = video.getBoundingClientRect();
  const wr = $('evalWrap').getBoundingClientRect();
  if (vr.width < 2 || vr.height < 2) return;
  const scale = Math.min(vr.width / video.videoWidth, vr.height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  const x = vr.left - wr.left + (vr.width - w) / 2;
  const y = vr.top - wr.top + (vr.height - h) / 2;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.left = `${x}px`;
  canvas.style.top = `${y}px`;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
}

function currentBoxes() {
  return state.gt.frames[String(state.frame)] || [];
}

function drawBox(b, selected) {
  const sx = canvas.width / video.videoWidth;
  const sy = canvas.height / video.videoHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const color = CLS_COLORS[b.cls] || '#2dd4bf';
  ctx.lineWidth = (selected ? 2.4 : 1.6) * dpr;
  ctx.strokeStyle = color;
  ctx.setLineDash(selected ? [6 * dpr, 4 * dpr] : []);
  ctx.strokeRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
  ctx.setLineDash([]);
  const label = `#${b.id} ${CLS_NAMES[b.cls] || b.cls}`;
  ctx.font = `${Math.round(11 * dpr)}px "Segoe UI", sans-serif`;
  const tw = ctx.measureText(label).width;
  const lx = Math.max(0, b.x * sx);
  const ly = Math.max(0, b.y * sy - 16 * dpr);
  ctx.fillStyle = 'rgba(4,7,12,0.72)';
  ctx.fillRect(lx, ly, tw + 8 * dpr, 15 * dpr);
  ctx.fillStyle = color;
  ctx.fillText(label, lx + 4 * dpr, ly + 11 * dpr);
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!video.videoWidth) return;
  for (const b of currentBoxes()) drawBox(b, b.id === state.selectedId);
  if (state.pressing && state.drawStart && state.drawCur) {
    const sx = canvas.width / video.videoWidth;
    const sy = canvas.height / video.videoHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const x = Math.min(state.drawStart.x, state.drawCur.x);
    const y = Math.min(state.drawStart.y, state.drawCur.y);
    const w = Math.abs(state.drawCur.x - state.drawStart.x);
    const h = Math.abs(state.drawCur.y - state.drawStart.y);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.6 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeRect(x * sx, y * sy, w * sx, h * sy);
    ctx.setLineDash([]);
  }
}

function toVideoCoords(ev) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - r.left) / Math.max(1, r.width)) * video.videoWidth,
    y: ((ev.clientY - r.top) / Math.max(1, r.height)) * video.videoHeight,
  };
}

function hitTest(p) {
  const boxes = currentBoxes();
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
  }
  return null;
}

function setFrame(f) {
  const total = totalFrames();
  const target = Math.max(0, Math.min(total, Math.round(f)));
  state.frame = target;
  video.currentTime = Math.min(Math.max(0, target / state.fps), video.duration - 0.001);
  $('frameSlider').value = String(target);
  $('frameLabel').textContent = `帧 ${target} / ${total}`;
}

function step(dir) {
  if (video.paused) {
    setFrame(state.frame + dir);
  } else {
    setFrame(Math.round(video.currentTime * state.fps) + dir);
  }
}

function updatePlayLabel() {
  $('evalPlay').textContent = video.paused ? '播放' : '暂停';
}

function updateGtStats() {
  const frames = state.gt.frames;
  const keys = Object.keys(frames).filter((k) => (frames[k] || []).length);
  let boxes = 0;
  const ids = new Set();
  for (const k of keys) {
    for (const b of frames[k]) {
      boxes++;
      ids.add(b.id);
    }
  }
  $('gtStats').textContent = `已标注 ${keys.length} 帧 / ${boxes} 个框 / ${ids.size} 条轨迹`;
}

function gtKey() {
  return `guidao.gt.${state.gt.name}|${state.gt.width}x${state.gt.height}|${state.fps}`;
}

function saveGt() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(gtKey(), JSON.stringify(state.gt));
    } catch {
      /* 存储空间不足时忽略 */
    }
  }, 350);
}

function loadGt() {
  try {
    const raw = localStorage.getItem(gtKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.frames && typeof parsed.frames === 'object') {
      state.gt = parsed;
      updateGtStats();
      $('evalStatus').textContent = `已恢复标注：${state.name}`;
    }
  } catch {
    /* 忽略损坏缓存 */
  }
}

function addBox(box) {
  const key = String(state.frame);
  if (!state.gt.frames[key]) state.gt.frames[key] = [];
  state.gt.frames[key].push(box);
  state.undoStack.push({ frame: state.frame, id: box.id, type: 'add' });
  updateGtStats();
  saveGt();
}

function deleteSelected() {
  if (state.selectedId === null) return;
  const key = String(state.frame);
  const boxes = state.gt.frames[key] || [];
  const idx = boxes.findIndex((b) => b.id === state.selectedId);
  if (idx < 0) return;
  const [removed] = boxes.splice(idx, 1);
  if (!boxes.length) delete state.gt.frames[key];
  state.undoStack.push({ frame: state.frame, box: removed, type: 'delete' });
  state.selectedId = null;
  updateGtStats();
  saveGt();
}

function undo() {
  const op = state.undoStack.pop();
  if (!op) return;
  const key = String(op.frame);
  if (op.type === 'add') {
    const boxes = state.gt.frames[key] || [];
    const idx = boxes.findIndex((b) => b.id === op.id);
    if (idx >= 0) boxes.splice(idx, 1);
    if (boxes && !boxes.length) delete state.gt.frames[key];
  } else if (op.type === 'delete') {
    if (!state.gt.frames[key]) state.gt.frames[key] = [];
    state.gt.frames[key].push(op.box);
  }
  updateGtStats();
  saveGt();
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!video.videoWidth || state.busy) return;
  if (!video.paused) {
    video.pause();
    updatePlayLabel();
  }
  const p = toVideoCoords(ev);
  const hit = hitTest(p);
  state.selectedId = hit ? hit.id : null;
  state.pressing = true;
  state.drawStart = p;
  state.drawCur = p;
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener('pointermove', (ev) => {
  if (!state.pressing) return;
  state.drawCur = toVideoCoords(ev);
});

canvas.addEventListener('pointerup', (ev) => {
  if (!state.pressing) return;
  state.pressing = false;
  const p = toVideoCoords(ev);
  const start = state.drawStart;
  state.drawStart = null;
  state.drawCur = null;
  if (!start) return;
  const x = Math.min(start.x, p.x);
  const y = Math.min(start.y, p.y);
  const w = Math.abs(p.x - start.x);
  const h = Math.abs(p.y - start.y);
  if (w < 8 || h < 8) {
    draw();
    return;
  }
  const id = Math.max(1, Number($('trackId').value) || 1);
  addBox({ id, cls: state.cls, x, y, w, h });
  draw();
});

document.querySelectorAll('.cls-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cls-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.cls = btn.dataset.cls;
  });
});

$('trackId').addEventListener('change', () => {
  $('trackId').value = String(Math.max(1, Number($('trackId').value) || 1));
});

$('nextTrack').addEventListener('click', () => {
  $('trackId').value = String((Number($('trackId').value) || 1) + 1);
});

$('undoBtn').addEventListener('click', undo);
$('delBtn').addEventListener('click', deleteSelected);

$('clearFrame').addEventListener('click', () => {
  delete state.gt.frames[String(state.frame)];
  state.selectedId = null;
  updateGtStats();
  saveGt();
});

$('clearAll').addEventListener('click', () => {
  if (!window.confirm('清空当前视频的全部标注？')) return;
  state.gt.frames = {};
  state.undoStack = [];
  state.selectedId = null;
  updateGtStats();
  saveGt();
});

$('evalPlay').addEventListener('click', () => {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
  updatePlayLabel();
});

$('evalPrev').addEventListener('click', () => {
  video.pause();
  updatePlayLabel();
  step(-1);
});

$('evalNext').addEventListener('click', () => {
  video.pause();
  updatePlayLabel();
  step(1);
});

$('frameSlider').addEventListener('pointerdown', () => {
  state.sliderActive = true;
});
$('frameSlider').addEventListener('pointerup', () => {
  state.sliderActive = false;
});
$('frameSlider').addEventListener('input', (e) => {
  video.pause();
  updatePlayLabel();
  setFrame(Number(e.target.value));
});

$('frameJump').addEventListener('change', (e) => {
  const f = Math.max(0, Math.min(totalFrames(), Number(e.target.value) || 0));
  video.pause();
  updatePlayLabel();
  setFrame(f);
  e.target.value = String(f);
});

$('evalFps').addEventListener('change', (e) => {
  state.fps = Number(e.target.value);
  state.gt.fps = state.fps;
  const total = totalFrames();
  $('frameSlider').max = String(total);
  $('benchStart').value = '0';
  $('benchEnd').value = String(total);
  updateGtStats();
  saveGt();
});

$('evalFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  state.name = file.name.replace(/\.[^.]+$/, '');
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  $('evalEmpty').hidden = true;
});

video.addEventListener('loadedmetadata', () => {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const total = totalFrames();
  $('frameSlider').max = String(total);
  $('benchEnd').value = String(total);
  const q = new URLSearchParams(location.search);
  if (q.has('start')) $('benchStart').value = String(Math.max(0, Number(q.get('start')) || 0));
  if (q.has('end')) $('benchEnd').value = String(Math.min(total, Math.max(0, Number(q.get('end')) || total)));
  if (q.has('stride')) $('benchStride').value = String(Math.max(1, Number(q.get('stride')) || 1));
  if (q.has('res')) $('benchRes').value = q.get('res');
  state.gt = {
    name: state.name || 'video',
    width: vw,
    height: vh,
    fps: state.fps,
    frames: {},
  };
  loadGt();
  applyPendingGt();
  updateGtStats();
  $('evalStatus').textContent = `真实视频 ${vw}×${vh} · ${state.fps}fps`;
  syncCanvas();
  setFrame(0);
  $('evalVideo').pause();
  updatePlayLabel();
});

$('exportGt').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.gt, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gt_${state.gt.name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('importGt').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed.frames !== 'object') throw new Error('缺少 frames');
    state.gt = {
      name: parsed.name || state.gt.name,
      width: parsed.width || state.gt.width,
      height: parsed.height || state.gt.height,
      fps: parsed.fps || state.gt.fps,
      frames: parsed.frames,
    };
    state.undoStack = [];
    state.selectedId = null;
    updateGtStats();
    saveGt();
    $('evalStatus').textContent = 'GT 已导入';
  } catch (err) {
    $('evalStatus').textContent = `GT 导入失败：${err.message}`;
  }
});

function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('exportJson').addEventListener('click', () => {
  if (!state.result) return;
  downloadText(JSON.stringify(state.result, null, 2), `bench_${state.gt.name}.json`, 'application/json');
});

$('exportCsv').addEventListener('click', () => {
  if (!state.result) return;
  downloadText(resultToCSV(state.result), `bench_${state.gt.name}.csv`, 'text/csv');
});

$('runBench').addEventListener('click', async () => {
  if (state.busy || !video.videoWidth) return;
  const total = totalFrames();
  const startFrame = Math.max(0, Number($('benchStart').value) || 0);
  const endFrame = Math.min(total, Math.max(startFrame, Number($('benchEnd').value) || total));
  const stride = Math.max(1, Number($('benchStride').value) || 1);
  const onlyDynamic = $('onlyDynamic').checked;
  const analysisWidth = Number($('benchRes').value) || 320;
  const yolo = $('useYolo').checked;
  const warmupFrames = Math.max(0, Number($('benchWarmup').value) || 0);

  state.busy = true;
  $('runBench').disabled = true;
  $('benchStatus').textContent = '运行中…';
  $('benchBar').style.width = '0%';
  video.pause();
  updatePlayLabel();

  try {
    const result = await runBench({
      video,
      gt: state.gt,
      fps: state.fps,
      analysisWidth,
      startFrame,
      endFrame,
      stride,
      onlyDynamic,
      yolo,
      warmupFrames,
      yoloOptions: state.yoloOptions,
      options: state.overrides,
      onProgress: (p, f) => {
        $('benchBar').style.width = `${Math.round(p * 100)}%`;
        $('benchStatus').textContent = `处理帧 ${f} · ${Math.round(p * 100)}%`;
      },
      onStatus: (text) => {
        $('benchStatus').textContent = text;
      },
    });
    state.result = result;
    showResult(result);
    state.baseline = result;
    refreshExpBase();
    $('exportJson').disabled = false;
    $('exportCsv').disabled = false;
    const ev = result.events;
    const sample = ev && ev.sampleGt
      ? ` · 示例(${ev.sampleGt.x},${ev.sampleGt.y}) ${ev.sampleGt.inside ? '内' : '外'} 顶点(${ev.sampleApex ? ev.sampleApex.x : '-'},${ev.sampleApex ? ev.sampleApex.y : '-'})`
      : '';
    const backend = result.config.detectorBackend ? ` · YOLO ${result.config.detectorBackend}` : '';
    const warm = result.config.warmupFrames ? ` · 预热 ${result.config.warmupFrames} 帧` : '';
    const fpDetail = ev && ev.fpAlerts && ev.fpAlerts.length
      ? ` · 误报 ${ev.fpAlerts.slice(0, 5).map((x) => `#${x.trackId}@${x.frame}`).join(',')}`
      : '';
    const warn = result.config.warning ? `⚠ ${result.config.warning} · ` : '';
    $('benchStatus').textContent = `${warn}完成：评测 ${result.frameCount} 帧${backend}${warm} · GT ${ev ? ev.gtSamples : 0} 框，走廊内 ${ev ? ev.gtInsideSamples : 0} · 检测框 ${result.detection.predCount}${sample}${fpDetail}`;
  } catch (err) {
    $('benchStatus').textContent = `评测失败：${err.message}`;
  } finally {
    state.busy = false;
    $('runBench').disabled = false;
    setFrame(state.frame);
  }
});

function showResult(r) {
  const d = r.detection;
  const t = r.trajectory;
  const s = r.segmentation;
  const pct = (v) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(1)}%`);
  const num = (v, digits = 2) => (v === null || v === undefined ? '–' : v.toFixed(digits));
  $('mPrecision').textContent = pct(d.precision);
  $('mRecall').textContent = pct(d.recall);
  $('mF1').textContent = pct(d.f1);
  $('mMOTA').textContent = pct(d.mota);
  $('mMOTP').textContent = num(d.motp, 3);
  $('mIDSW').textContent = String(d.idsw);
  const e = r.events || {};
  $('mEventRecall').textContent = pct(e.eventRecall);
  $('mFnEvents').textContent = e.fnEvents === undefined ? '–' : String(e.fnEvents);
  $('mFpPerMin').textContent = e.fpPerMin === null || e.fpPerMin === undefined ? '–' : e.fpPerMin.toFixed(2);
  $('mLead').textContent = e.leadMedian === null || e.leadMedian === undefined ? '–' : `${e.leadMedian.toFixed(2)} s`;
  $('mLate').textContent = e.lateEvents === undefined ? '–' : String(e.lateEvents);
  $('mADE').textContent = num(t.ade, 1);
  $('mFDE').textContent = num(t.fde, 1);
  $('mADErel').textContent = pct(t.adeNorm);
  $('mFDErel').textContent = pct(t.fdeNorm);
  $('mBg').textContent = pct(s.meanBgInlierRatio);
  $('mRansac').textContent = num(s.meanRansacIterations, 0);
  $('mMs').textContent = `${num(r.timing.totalMean, 1)} ms`;
  $('mP95').textContent = `${num(r.timing.totalP95, 1)} ms`;
  $('mDetect').textContent = r.config && r.config.yolo ? `${num(r.timing.detectMean, 1)} ms` : '–';
  $('mFrames').textContent = String(r.frameCount);
  $('mSamples').textContent = String(t.count);
}

/* 单参数实验：每次只改一个参数，自动记录基线与试验结果 */
const EXP_PARAMS = [
  'fastThreshold',
  'ransacThreshold',
  'minLayerRatio',
  'residualThreshold',
  'maxLayers',
  'maxFeatures',
  'pyramidLevels',
  'corridorRatio',
  'horizonSec',
  'hfovDeg',
  'minObjectPoints',
  'recallFirst',
  'yoloMinHits',
  'approachWindow',
  'approachMinSamples',
  'minAreaGrowth',
  'maxCenterRate',
  'approachMinHeight',
  'approachMinScore',
  'approachMinFrames',
];
const EXP_KEY = 'guidao.experiments';
const expParam = $('expParam');
for (const p of EXP_PARAMS) {
  const o = document.createElement('option');
  o.value = p;
  o.textContent = p;
  expParam.appendChild(o);
}

let experiments = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(EXP_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
})();

function expBaseValue() {
  const p = expParam.value;
  const opts = state.baseline && state.baseline.config ? state.baseline.config.options : null;
  if (opts && Object.prototype.hasOwnProperty.call(opts, p)) return opts[p];
  return PIPELINE_DEFAULTS[p];
}

function refreshExpBase() {
  $('expBase').value = String(expBaseValue());
}

function expCell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function renderExperiments() {
  const body = $('expTable').querySelector('tbody');
  body.innerHTML = '';
  const rows = experiments.slice(-30).reverse();
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(expCell(r.param));
    tr.appendChild(expCell(`${r.base} → ${r.trial}`));
    tr.appendChild(expCell(r.eventRecall === null || r.eventRecall === undefined ? '–' : `${(r.eventRecall * 100).toFixed(1)}%`));
    tr.appendChild(expCell(r.fpPerMin === null || r.fpPerMin === undefined ? '–' : r.fpPerMin.toFixed(2)));
    tr.appendChild(expCell(r.leadMedian === null || r.leadMedian === undefined ? '–' : `${r.leadMedian.toFixed(2)}s`));
    tr.appendChild(expCell(r.f1 === null || r.f1 === undefined ? '–' : `${(r.f1 * 100).toFixed(1)}%`));
    tr.appendChild(expCell(r.msMean === null || r.msMean === undefined ? '–' : `${r.msMean.toFixed(1)}ms`));
    body.appendChild(tr);
  }
  $('exportExp').disabled = experiments.length === 0;
}

function saveExperiments() {
  try {
    localStorage.setItem(EXP_KEY, JSON.stringify(experiments.slice(-200)));
  } catch {
    /* 容量不足时只保留内存记录 */
  }
}

expParam.addEventListener('change', () => {
  refreshExpBase();
  $('expTrial').value = '';
});

$('runExp').addEventListener('click', async () => {
  if (state.busy || !video.videoWidth) return;
  if (!state.baseline) {
    $('expStatus').textContent = '请先运行一次基准评测，再改一个参数';
    return;
  }
  const param = expParam.value;
  const base = expBaseValue();
  const raw = $('expTrial').value.trim();
  if (raw === '') {
    $('expStatus').textContent = '请输入试验值';
    return;
  }
  let trial = Number(raw);
  if (!Number.isFinite(trial)) {
    $('expStatus').textContent = '试验值必须是数字';
    return;
  }
  if (typeof base === 'boolean') trial = trial !== 0;
  if (trial === base) {
    $('expStatus').textContent = '试验值与基线值相同，请改一个值';
    return;
  }

  const cfg = state.baseline.config;
  state.busy = true;
  $('runBench').disabled = true;
  $('runExp').disabled = true;
  $('expStatus').textContent = `运行中：${param} ${base} → ${trial}`;
  video.pause();
  updatePlayLabel();

  try {
    const result = await runBench({
      video,
      gt: state.gt,
      fps: state.fps,
      analysisWidth: cfg.analysisWidth,
      startFrame: cfg.startFrame,
      endFrame: cfg.endFrame,
      stride: cfg.stride,
      onlyDynamic: cfg.onlyDynamic,
      yolo: cfg.yolo,
      warmupFrames: cfg.warmupFrames,
      yoloOptions: state.yoloOptions,
      options: { [param]: trial },
      onProgress: () => {},
    });
    const e = result.events || {};
    experiments.push({
      time: new Date().toISOString(),
      param,
      base,
      trial,
      gtName: state.gt.name,
      frames: result.frameCount,
      eventRecall: e.eventRecall ?? null,
      fnEvents: e.fnEvents ?? null,
      fpPerMin: e.fpPerMin ?? null,
      leadMedian: e.leadMedian ?? null,
      f1: result.detection.f1 ?? null,
      recall: result.detection.recall ?? null,
      precision: result.detection.precision ?? null,
      mota: result.detection.mota ?? null,
      ade: result.trajectory.ade ?? null,
      fde: result.trajectory.fde ?? null,
      msMean: result.timing.totalMean ?? null,
    });
    saveExperiments();
    renderExperiments();
    $('expStatus').textContent = `已记录：${param} ${base} → ${trial}（${result.frameCount} 帧）`;
  } catch (err) {
    $('expStatus').textContent = `实验失败：${err.message}`;
  } finally {
    state.busy = false;
    $('runBench').disabled = false;
    $('runExp').disabled = false;
    setFrame(state.frame);
  }
});

$('exportExp').addEventListener('click', () => {
  if (!experiments.length) return;
  const cols = [
    'time', 'param', 'base', 'trial', 'gtName', 'frames', 'eventRecall', 'fnEvents',
    'fpPerMin', 'leadMedian', 'f1', 'recall', 'precision', 'mota', 'ade', 'fde', 'msMean',
  ];
  const lines = [cols.join(',')];
  for (const r of experiments) lines.push(cols.map((c) => (r[c] === null || r[c] === undefined ? '' : r[c])).join(','));
  downloadText(lines.join('\n'), 'guidao_experiments.csv', 'text/csv');
});

$('clearExp').addEventListener('click', () => {
  experiments = [];
  saveExperiments();
  renderExperiments();
  $('expStatus').textContent = '实验记录已清空';
});

refreshExpBase();
renderExperiments();

/* 极端场景清单 */
const checklist = $('checklist');
const savedChecks = (() => {
  try {
    return JSON.parse(localStorage.getItem(CHECK_KEY) || '{}');
  } catch {
    return {};
  }
})();
checklist.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
  cb.checked = Boolean(savedChecks[cb.dataset.tag]);
  cb.addEventListener('change', () => {
    const next = {};
    checklist.querySelectorAll('input[type="checkbox"]').forEach((x) => {
      if (x.checked) next[x.dataset.tag] = true;
    });
    localStorage.setItem(CHECK_KEY, JSON.stringify(next));
    updateChecklistStatus();
  });
});
function updateChecklistStatus() {
  const all = checklist.querySelectorAll('input[type="checkbox"]').length;
  const done = checklist.querySelectorAll('input[type="checkbox"]:checked').length;
  $('checklistStatus').textContent = `已完成 ${done} / ${all} 类极端场景`;
}
updateChecklistStatus();

document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    updatePlayLabel();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    video.pause();
    updatePlayLabel();
    step(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    video.pause();
    updatePlayLabel();
    step(1);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  }
});

function raf() {
  requestAnimationFrame(raf);
  syncCanvas();
  if (!video.videoWidth) return;
  if (state.busy) return;
  if (!state.pressing && video.paused) {
    const f = Math.round(video.currentTime * state.fps);
    if (f !== state.frame) {
      state.frame = Math.max(0, Math.min(totalFrames(), f));
    }
  }
  if (!video.paused) {
    state.frame = Math.max(0, Math.min(totalFrames(), Math.round(video.currentTime * state.fps)));
    if (!state.sliderActive) $('frameSlider').value = String(state.frame);
  }
  $('frameLabel').textContent = `帧 ${state.frame} / ${totalFrames()}`;
  draw();
}
const bootParams = new URLSearchParams(location.search);
// ?yolo=1&warmup=45 直接启用 YOLO 检测层并设置预热帧
if (bootParams.get('yolo') === '1' || bootParams.get('yolo') === 'true') {
  $('useYolo').checked = true;
  if (!bootParams.has('warmup')) $('benchWarmup').value = '45';
}
if (bootParams.has('warmup')) {
  $('benchWarmup').value = String(Math.max(0, Number(bootParams.get('warmup')) || 0));
}
// ?wasm=1 强制 WASM 后端；?conf=0.1&iou=0.45 覆盖检测阈值
if (bootParams.get('wasm') === '1') state.yoloOptions.preferWebGPU = false;
if (bootParams.has('conf')) state.yoloOptions.conf = Number(bootParams.get('conf'));
if (bootParams.has('iou')) state.yoloOptions.iou = Number(bootParams.get('iou'));
$('useYolo').addEventListener('change', () => {
  if ($('useYolo').checked && !(Number($('benchWarmup').value) > 0)) $('benchWarmup').value = '45';
  if (!$('useYolo').checked) $('benchWarmup').value = '0';
});
// 允许 ?opt=ransacThreshold:1.5&opt=minLayerRatio:0.05 直接带入参数实验
const bootOpts = {};
for (const raw of bootParams.getAll('opt')) {
  const idx = raw.indexOf(':');
  if (idx < 0) continue;
  const k = raw.slice(0, idx);
  const v = raw.slice(idx + 1);
  bootOpts[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
}
state.overrides = bootOpts;
const bootVideo = bootParams.get('video');
if (bootVideo) {
  const fpsParam = Number(bootParams.get('fps'));
  if (Number.isFinite(fpsParam) && fpsParam > 0) {
    state.fps = fpsParam;
    $('evalFps').value = String(fpsParam);
  }
  state.name = bootVideo.split('/').pop().replace(/\.[^.]+$/, '');
  video.src = bootVideo;
  $('evalEmpty').hidden = true;
}

// ?gt=gt/xxx.json 直接从项目内载入 GT，省掉文件选择
let pendingGt = null;
function applyPendingGt() {
  if (!pendingGt) return;
  state.gt = {
    name: pendingGt.name || state.gt.name,
    width: pendingGt.width || state.gt.width,
    height: pendingGt.height || state.gt.height,
    fps: pendingGt.fps || state.gt.fps,
    frames: pendingGt.frames,
  };
  pendingGt = null;
  state.undoStack = [];
  state.selectedId = null;
  updateGtStats();
  saveGt();
  $('evalStatus').textContent = 'GT 已从 URL 载入';
}
const bootGt = bootParams.get('gt');
if (bootGt) {
  fetch(bootGt)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((parsed) => {
      if (!parsed || typeof parsed.frames !== 'object') throw new Error('缺少 frames');
      pendingGt = parsed;
      if (video.videoWidth) applyPendingGt();
    })
    .catch((err) => {
      $('evalStatus').textContent = `GT 载入失败：${err.message}`;
    });
}

requestAnimationFrame(raf);
window.addEventListener('resize', syncCanvas);
if ('ResizeObserver' in window) new ResizeObserver(syncCanvas).observe(video);
