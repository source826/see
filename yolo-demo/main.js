// YOLOv8n + onnxruntime-web 摄像头实时检测
// 模型来源：Ultralytics yolov8n.pt（AGPL-3.0），导出说明见 README.md

const ORT = window.ort;
ORT.env.wasm.wasmPaths = new URL('./vendor/ort/', window.location.href).href;
ORT.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1; // 服务器带 COOP/COEP 时启用多线程 wasm
ORT.env.logLevel = 'error';

const MODEL_URL = './models/yolov8n.onnx';
const MODEL_URL_WEBGPU = './models/yolov8n.fp16.onnx';
const INPUT_SIZE = 640;
const PAD_VALUE = 114;

const COCO_NAMES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush',
];

const ZH_NAMES = [
  '行人', '自行车', '汽车', '摩托车', '飞机', '公交车', '火车', '卡车', '船', '红绿灯',
  '消防栓', '停车标志', '停车计时器', '长椅', '鸟', '猫', '狗', '马', '羊', '牛',
  '大象', '熊', '斑马', '长颈鹿', '背包', '雨伞', '手提包', '领带', '行李箱', '飞盘',
  '滑雪板', '单板滑雪', '球', '风筝', '棒球棒', '棒球手套', '滑板', '冲浪板', '网球拍',
  '瓶子', '酒杯', '杯子', '叉子', '刀', '勺子', '碗', '香蕉', '苹果', '三明治',
  '橙子', '西兰花', '胡萝卜', '热狗', '披萨', '甜甜圈', '蛋糕', '椅子', '沙发', '盆栽',
  '床', '餐桌', '马桶', '电视', '笔记本', '鼠标', '遥控器', '键盘', '手机', '微波炉',
  '烤箱', '烤面包机', '水槽', '冰箱', '书', '时钟', '花瓶', '剪刀', '泰迪熊', '吹风机',
  '牙刷',
];

const PALETTE = [
  '#ff5c5c', '#ff9f43', '#ffd93d', '#6bcB77', '#4d96ff', '#b983ff', '#ff6bcb',
  '#00c2a8', '#f9a826', '#7f8cff',
];

const els = {
  stage: document.getElementById('stage'),
  video: document.getElementById('video'),
  overlay: document.getElementById('overlay'),
  hint: document.getElementById('hint'),
  modelState: document.getElementById('modelState'),
  epBadge: document.getElementById('epBadge'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  imageBtn: document.getElementById('imageBtn'),
  conf: document.getElementById('conf'),
  confVal: document.getElementById('confVal'),
  iou: document.getElementById('iou'),
  iouVal: document.getElementById('iouVal'),
  stats: document.getElementById('stats'),
};

const overlayCtx = els.overlay.getContext('2d');

// 预处理用的离屏画布：640x640 灰底 letterbox
const inputCanvas = document.createElement('canvas');
inputCanvas.width = INPUT_SIZE;
inputCanvas.height = INPUT_SIZE;
const inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true });

let session = null;
let stream = null;
let running = false;
let busy = false;
let imageMode = false;
let fpsEma = 0;
let backend = 'wasm';
let gpuName = '';

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function setHint(text) {
  els.hint.textContent = text;
  els.hint.hidden = !text;
}

function setModelBadge(text, cls) {
  els.modelState.textContent = text;
  els.modelState.className = `badge ${cls ?? ''}`.trim();
}

async function warmup(inst) {
  // 预热一次：WebGPU 首次推理要编译着色器，避免第一次真实检测卡顿
  const zero = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const feeds = {};
  feeds[inst.inputNames[0]] = new ORT.Tensor('float32', zero, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  await inst.run(feeds);
}

async function createSession() {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
        gpuName = [info.vendor, info.architecture].filter(Boolean).join(' ');
        const inst = await ORT.InferenceSession.create(MODEL_URL_WEBGPU, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        await warmup(inst);
        backend = 'WebGPU';
        return inst;
      }
    } catch (err) {
      console.warn('WebGPU 初始化失败，回退 WASM：', err);
    }
  }
  const inst = await ORT.InferenceSession.create(MODEL_URL, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  backend = 'WASM';
  return inst;
}

async function loadModel() {
  setModelBadge('模型加载中…', '');
  try {
    const t0 = performance.now();
    session = await createSession();
    const ms = Math.round(performance.now() - t0);
    setModelBadge(`模型已就绪（${backend}，${ms} ms）`, 'ok');
    els.epBadge.textContent = backend === 'WebGPU' && gpuName ? `后端 WebGPU · ${gpuName}` : `后端 ${backend}`;
    els.startBtn.disabled = false;
    setHint('点击「开启摄像头」开始检测');
  } catch (err) {
    console.error(err);
    setModelBadge('模型加载失败', 'err');
    setHint(`模型加载失败：${err.message}。请确认 models/yolov8n.onnx 存在，并通过本地服务器打开。`);
  }
}

// 等比缩放到 640x640，居中灰边填充
function makeInput(source, srcW, srcH) {
  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const drawW = Math.round(srcW * scale);
  const drawH = Math.round(srcH * scale);
  const padX = Math.round((INPUT_SIZE - drawW) / 2);
  const padY = Math.round((INPUT_SIZE - drawH) / 2);

  inputCtx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
  inputCtx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  inputCtx.drawImage(source, padX, padY, drawW, drawH);

  const { data: rgba } = inputCtx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const area = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(area * 3);
  for (let i = 0; i < area; i++) {
    const p = i * 4;
    chw[i] = rgba[p] / 255;
    chw[area + i] = rgba[p + 1] / 255;
    chw[2 * area + i] = rgba[p + 2] / 255;
  }
  return { chw, scale, padX, padY };
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter);
}

// 逐类别 NMS
function nms(boxes, iouThreshold) {
  const byClass = new Map();
  for (const b of boxes) {
    if (!byClass.has(b.cls)) byClass.set(b.cls, []);
    byClass.get(b.cls).push(b);
  }
  const kept = [];
  for (const list of byClass.values()) {
    list.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const box of list) {
      let ok = true;
      for (const p of picked) {
        if (iou(box, p) > iouThreshold) {
          ok = false;
          break;
        }
      }
      if (ok) picked.push(box);
    }
    kept.push(...picked);
  }
  return kept;
}

function decodeOutput(output, confThreshold, iouThreshold, scale, padX, padY) {
  const dims = output.dims; // [1, 84, 8400]
  const data = output.data;
  const numAnchors = dims[2];
  const numClasses = dims[1] - 4;
  const stride = numAnchors;

  const boxes = [];
  for (let i = 0; i < numAnchors; i++) {
    let best = 0;
    let bestCls = -1;
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * stride + i];
      if (s > best) {
        best = s;
        bestCls = c;
      }
    }
    if (best < confThreshold) continue;
    const cx = data[i];
    const cy = data[stride + i];
    const w = data[2 * stride + i];
    const h = data[3 * stride + i];
    boxes.push({
      x1: cx - w / 2,
      y1: cy - h / 2,
      x2: cx + w / 2,
      y2: cy + h / 2,
      score: best,
      cls: bestCls,
    });
  }

  const kept = nms(boxes, iouThreshold);
  // 640 letterbox 坐标 → 原始画面坐标
  for (const b of kept) {
    b.x1 = (b.x1 - padX) / scale;
    b.y1 = (b.y1 - padY) / scale;
    b.x2 = (b.x2 - padX) / scale;
    b.y2 = (b.y2 - padY) / scale;
  }
  return kept;
}

async function infer(source, srcW, srcH) {
  const { chw, scale, padX, padY } = makeInput(source, srcW, srcH);
  const tensor = new ORT.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;
  const t0 = performance.now();
  const results = await session.run(feeds);
  const ms = performance.now() - t0;
  const output = results[session.outputNames[0]];
  const confThreshold = Number(els.conf.value);
  const iouThreshold = Number(els.iou.value);
  const boxes = decodeOutput(output, confThreshold, iouThreshold, scale, padX, padY);
  return { boxes, ms };
}

function drawBoxes(boxes, width, height) {
  overlayCtx.clearRect(0, 0, width, height);
  if (!boxes.length) return;

  const lineWidth = Math.max(2, Math.round(width / 320));
  const fontSize = Math.max(12, Math.round(width / 42));
  overlayCtx.lineWidth = lineWidth;
  overlayCtx.font = `600 ${fontSize}px system-ui, "Microsoft YaHei", sans-serif`;
  overlayCtx.textBaseline = 'top';

  for (const b of boxes) {
    const color = PALETTE[b.cls % PALETTE.length];
    const x = Math.max(0, b.x1);
    const y = Math.max(0, b.y1);
    const w = Math.min(width, b.x2) - x;
    const h = Math.min(height, b.y2) - y;
    if (w <= 1 || h <= 1) continue;

    overlayCtx.strokeStyle = color;
    overlayCtx.strokeRect(x, y, w, h);

    const label = `${ZH_NAMES[b.cls] ?? COCO_NAMES[b.cls]} ${b.score.toFixed(2)}`;
    const textW = overlayCtx.measureText(label).width;
    const textH = fontSize + 6;
    const labelY = y - textH < 0 ? y : y - textH;
    overlayCtx.fillStyle = color;
    overlayCtx.fillRect(x, labelY, textW + 8, textH);
    overlayCtx.fillStyle = '#101418';
    overlayCtx.fillText(label, x + 4, labelY + 3);
  }
}

function updateStats(boxes, ms = null) {
  const parts = [];
  if (ms !== null) {
    parts.push(`推理 ${ms.toFixed(1)} ms`);
    fpsEma = fpsEma ? fpsEma * 0.9 + (1000 / ms) * 0.1 : 1000 / ms;
    parts.push(`约 ${fpsEma.toFixed(1)} FPS`);
  }
  parts.push(`${boxes.length} 个目标`);
  els.stats.textContent = parts.join(' · ');
}

async function detectFromSource(source, srcW, srcH) {
  const { boxes, ms } = await infer(source, srcW, srcH);
  drawBoxes(boxes, srcW, srcH);
  updateStats(boxes, ms);
  return boxes;
}

function tick() {
  if (!running || imageMode) return;
  const video = els.video;
  if (!busy && video.readyState >= 2 && video.videoWidth) {
    busy = true;
    detectFromSource(video, video.videoWidth, video.videoHeight)
      .catch((err) => console.error(err))
      .finally(() => {
        busy = false;
      });
  }
  if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback(tick);
  } else {
    requestAnimationFrame(tick);
  }
}

async function startCamera() {
  els.startBtn.disabled = true;
  setHint('正在请求摄像头权限…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    els.video.srcObject = stream;
    await els.video.play();
    imageMode = false;
    els.stage.classList.remove('image-mode');
    els.video.style.display = '';
    els.overlay.width = els.video.videoWidth;
    els.overlay.height = els.video.videoHeight;
    els.overlay.style.width = '';
    els.overlay.style.height = '';
    setHint('');
    els.stopBtn.disabled = false;
    els.imageBtn.hidden = true;
    running = true;
    busy = false;
    tick();
  } catch (err) {
    console.error(err);
    els.startBtn.disabled = false;
    els.imageBtn.hidden = false;
    setHint(`无法访问摄像头：${err.name}。请检查权限，或使用「用示例图片检测」。`);
  }
}

function stopCamera() {
  running = false;
  imageMode = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  els.video.srcObject = null;
  els.stopBtn.disabled = true;
  els.startBtn.disabled = false;
  els.imageBtn.hidden = false;
  overlayCtx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.stats.textContent = '';
  setHint('已停止。点击「开启摄像头」重新开始');
}

async function detectSampleImage() {
  if (!session) return;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    els.video.srcObject = null;
    els.stopBtn.disabled = true;
  }
  setHint('正在检测示例图片…');
  els.imageBtn.disabled = true;
  try {
    const img = new Image();
    img.src = './sample.jpg';
    await img.decode();
    imageMode = true;
    running = false;
    els.stage.classList.add('image-mode');
    els.video.style.display = 'none';
    els.overlay.width = img.naturalWidth;
    els.overlay.height = img.naturalHeight;
    overlayCtx.drawImage(img, 0, 0);
    await detectFromSource(img, img.naturalWidth, img.naturalHeight);
    setHint('示例图片检测结果（无摄像头时用于验证）');
  } catch (err) {
    console.error(err);
    setHint(`示例图片加载失败：${err.message}`);
  } finally {
    els.imageBtn.disabled = false;
  }
}

els.startBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
els.imageBtn.addEventListener('click', detectSampleImage);

els.conf.addEventListener('input', () => {
  els.confVal.textContent = els.conf.value;
});
els.iou.addEventListener('input', () => {
  els.iouVal.textContent = els.iou.value;
});

els.video.addEventListener('loadedmetadata', () => {
  if (!imageMode) {
    els.overlay.width = els.video.videoWidth;
    els.overlay.height = els.video.videoHeight;
  }
});

loadModel();
