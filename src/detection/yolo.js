// 浏览器端 YOLOv8n 检测层（onnxruntime-web）。
// 复用 yolo-demo 的 letterbox / 84x8400 解码 / 逐类 NMS，只保留行人车辆类别。
// 模型与运行时来源见 yolo-demo/README.md（YOLOv8 AGPL-3.0，ORT MIT）。

export const COCO_NAMES = [
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

export const ZH_NAMES = [
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

// 行人 / 自行车 / 汽车 / 摩托车 / 公交车 / 卡车 / 红绿灯 / 地面小障碍
export const DETECT_CLASS_IDS = [0, 1, 2, 3, 5, 7, 9, 10, 39, 41, 46, 47, 49];

const INPUT_SIZE = 640;
const PAD_VALUE = 114;

let ortPromise = null;

function ensureOrt(scriptUrl) {
  if (window.ort) return Promise.resolve(window.ort);
  if (!ortPromise) {
    ortPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = scriptUrl;
      s.async = true;
      s.onload = () => (window.ort ? resolve(window.ort) : reject(new Error('ORT 脚本已加载但未找到 window.ort')));
      s.onerror = () => reject(new Error(`ORT 脚本加载失败：${scriptUrl}`));
      document.head.appendChild(s);
    });
  }
  return ortPromise;
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

function nms(boxes, iouThreshold) {
  if (!boxes.length) return [];
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

export class YoloDetector {
  /**
   * @param {object} opts
   * @param {string} opts.assetBase yolo-demo 目录 URL，默认按本模块位置推导
   * @param {number} opts.conf 置信度阈值
   * @param {number} opts.iou NMS IoU 阈值
   * @param {number[]} opts.classIds 保留的 COCO 类别
   * @param {boolean} opts.preferWebGPU 优先 WebGPU（fp16 模型）
   */
  constructor(opts = {}) {
    const base = opts.assetBase || new URL('../../yolo-demo/', import.meta.url).href;
    if (!base.endsWith('/')) base += '/';
    this.assetBase = base;
    this.ortScriptUrl = opts.ortScriptUrl || `${base}vendor/ort/ort.webgpu.min.js`;
    this.wasmBase = opts.wasmBase || `${base}vendor/ort/`;
    this.inputSize = opts.inputSize || INPUT_SIZE;
    const suffix = this.inputSize === INPUT_SIZE ? '' : `_${this.inputSize}`;
    this.modelUrl = opts.modelUrl || `${base}models/yolov8n${suffix}.onnx`;
    this.modelUrlFp16 = opts.modelUrlFp16 || `${base}models/yolov8n${suffix}.fp16.onnx`;
    this.conf = opts.conf ?? 0.15;
    this.iou = opts.iou ?? 0.45;
    this.classIds = new Set(opts.classIds || DETECT_CLASS_IDS);
    this.preferWebGPU = opts.preferWebGPU !== false;
    this.maxDetections = opts.maxDetections ?? 60;
    this.webgpuTimeoutMs = opts.webgpuTimeoutMs ?? 4000;
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 12000;

    this.session = null;
    this.backend = '';
    this.ready = false;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.inputSize;
    this.canvas.height = this.inputSize;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  async load() {
    if (this.ready) return this;
    const ort = await ensureOrt(this.ortScriptUrl);
    ort.env.wasm.wasmPaths = this.wasmBase;
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1)
      : 1;
    ort.env.logLevel = 'error';

    if (this.preferWebGPU && navigator.gpu) {
      try {
        // GPU 进程异常时 requestAdapter 可能永久挂起，必须限时回退 WASM。
        const adapter = await Promise.race([
          navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('WebGPU 适配器超时')), this.webgpuTimeoutMs),
          ),
        ]);
        if (adapter) {
          const session = await Promise.race([
            ort.InferenceSession.create(this.modelUrlFp16, {
              executionProviders: ['webgpu'],
              graphOptimizationLevel: 'all',
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('WebGPU 会话超时')), this.sessionTimeoutMs),
            ),
          ]);
          await Promise.race([
            this._warmup(ort, session),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('WebGPU 预热超时')), this.sessionTimeoutMs),
            ),
          ]);
          this.session = session;
          this.backend = 'WebGPU';
          this.ready = true;
          return this;
        }
      } catch (err) {
        console.warn('YOLO WebGPU 初始化失败，回退 WASM：', err);
      }
    }

    const session = await ort.InferenceSession.create(this.modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    await this._warmup(ort, session);
    this.session = session;
    this.backend = 'WASM';
    this.ready = true;
    return this;
  }

  async _warmup(ort, session) {
    const zero = new Float32Array(3 * this.inputSize * this.inputSize);
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', zero, [1, 3, this.inputSize, this.inputSize]);
    await session.run(feeds);
  }

  _makeInput(source, srcW, srcH) {
    const size = this.inputSize;
    const scale = Math.min(size / srcW, size / srcH);
    const drawW = Math.round(srcW * scale);
    const drawH = Math.round(srcH * scale);
    const padX = Math.round((size - drawW) / 2);
    const padY = Math.round((size - drawH) / 2);
    this.ctx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
    this.ctx.fillRect(0, 0, size, size);
    this.ctx.drawImage(source, padX, padY, drawW, drawH);

    const { data: rgba } = this.ctx.getImageData(0, 0, size, size);
    const area = size * size;
    const chw = new Float32Array(area * 3);
    const debugInput = !this.lastInputRange;
    let mn = 1;
    let mx = 0;
    let sum = 0;
    for (let i = 0; i < area; i++) {
      const p = i * 4;
      const r = rgba[p] / 255;
      const g = rgba[p + 1] / 255;
      const b = rgba[p + 2] / 255;
      chw[i] = r;
      chw[area + i] = g;
      chw[2 * area + i] = b;
      if (debugInput) {
        if (r < mn) mn = r;
        if (r > mx) mx = r;
        sum += r;
      }
    }
    if (debugInput) {
      this.lastInputRange = {
        min: Math.round(mn * 1000) / 1000,
        max: Math.round(mx * 1000) / 1000,
        mean: Math.round((sum / area) * 1000) / 1000,
      };
    }
    return { chw, scale, padX, padY };
  }

  _decode(output, scale, padX, padY) {
    const dims = output.dims;
    const data = output.data;
    const transposed = dims.length === 3 && dims[1] < dims[2];
    const attrs = 4 + 80;
    const numAnchors = transposed ? dims[2] : dims[1];
    const numClasses = transposed ? dims[1] - 4 : dims[2] - 4;
    const at = transposed
      ? (c, i) => data[c * numAnchors + i]
      : (c, i) => data[i * attrs + c];

    const boxes = [];
    for (let i = 0; i < numAnchors; i++) {
      let best = 0;
      let bestCls = -1;
      const nc = Math.min(numClasses, attrs - 4);
      for (let c = 0; c < nc; c++) {
        const s = at(4 + c, i);
        if (s > best) {
          best = s;
          bestCls = c;
        }
      }
      if (best < this.conf) continue;
      if (!this.classIds.has(bestCls)) continue;
      const cx = at(0, i);
      const cy = at(1, i);
      const w = at(2, i);
      const h = at(3, i);
      boxes.push({
        x1: cx - w / 2,
        y1: cy - h / 2,
        x2: cx + w / 2,
        y2: cy + h / 2,
        score: best,
        cls: bestCls,
      });
    }

    const kept = nms(boxes, this.iou).slice(0, this.maxDetections);
    return kept.map((b) => {
      const x1 = (b.x1 - padX) / scale;
      const y1 = (b.y1 - padY) / scale;
      const x2 = (b.x2 - padX) / scale;
      const y2 = (b.y2 - padY) / scale;
      return {
        bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
        score: b.score,
        cls: b.cls,
        className: ZH_NAMES[b.cls] || COCO_NAMES[b.cls] || String(b.cls),
      };
    });
  }

  /**
   * @param {CanvasImageSource} source 视频帧/画布/图片
   * @param {number} srcW
   * @param {number} srcH
   * @returns {Promise<{boxes:Array<{bbox:{x,y,w,h}, score:number, cls:number, className:string}>, ms:number}>}
   */
  async detect(source, srcW, srcH) {
    if (!this.ready) await this.load();
    const t0 = performance.now();
    const { chw, scale, padX, padY } = this._makeInput(source, srcW, srcH);
    const tensor = new window.ort.Tensor('float32', chw, [1, 3, this.inputSize, this.inputSize]);
    const feeds = {};
    feeds[this.session.inputNames[0]] = tensor;
    const results = await this.session.run(feeds);
    const output = results[this.session.outputNames[0]];
    const boxes = this._decode(output, scale, padX, padY);
    return { boxes, ms: performance.now() - t0 };
  }
}
