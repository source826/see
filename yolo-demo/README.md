# YOLOv8n 实时检测（摄像头 + onnxruntime-web）

浏览器打开页面后调用摄像头，用 YOLOv8n（ONNX）逐帧检测行人和车辆等 COCO 目标，在画面上绘制检测框、类别与置信度。

## 模型来源与许可证

- 权重：**Ultralytics YOLOv8n**（`yolov8n.pt`），来自 Ultralytics 官方资源渠道
  `https://github.com/ultralytics/assets/releases`，由 `ultralytics` 包自动下载。
- 导出：使用 Ultralytics 官方 `export` 接口导出 ONNX：
  ```bash
  .venv\Scripts\python.exe tools\export_onnx.py
  # 等价于 YOLO("yolov8n.pt").export(format="onnx", imgsz=640, opset=12, dynamic=False)
  ```
  产物：`models/yolov8n.onnx`（输入 `1x3x640x640`，输出 `1x84x8400`）。
- **许可证：YOLOv8 由 Ultralytics 以 AGPL-3.0 发布**（https://github.com/ultralytics/ultralytics/blob/main/LICENSE）。
  本目录下的网页代码同样以 AGPL-3.0 提供；如需闭源商用，请先向 Ultralytics 取得商业授权。
- 推理运行时：`onnxruntime-web` 1.20.1（MIT），文件已放在 `vendor/ort/`，页面不依赖外部 CDN。
  - 来源：微软 ONNX Runtime 官方 Web 发行包 `onnxruntime-web@1.20.1`
  - 项目主页：https://github.com/microsoft/onnxruntime
  - npm 包：https://www.npmjs.com/package/onnxruntime-web
  - 文件获取地址（官方 npm 包的分发镜像）：`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/`
  - 已落地的文件：`ort.webgpu.min.js`、`ort-wasm-simd-threaded.jsep.mjs/.wasm`、`ort-wasm-simd-threaded.mjs/.wasm`
  - 许可证：MIT（https://github.com/microsoft/onnxruntime/blob/main/LICENSE）

## 目录结构

```
yolo-demo/
├── index.html          页面
├── main.js             预处理、推理、NMS、绘制
├── style.css
├── sample.jpg          无摄像头时的验证图片（取自项目真实视频帧）
├── models/
│   ├── yolov8n.pt      Ultralytics 官方权重
│   ├── yolov8n.onnx    fp32 ONNX（WASM 后端）
│   └── yolov8n.fp16.onnx  fp16 ONNX（WebGPU 后端，tools/convert_fp16.py 生成）
├── vendor/ort/         onnxruntime-web 运行时（js + wasm）
└── tools/              export_onnx.py（下载+导出）、convert_fp16.py（fp16 转换）
```

## 运行

在本机任意位置启动静态服务器（需要支持 `.wasm` 的 MIME，项目自带 `tools/serve.mjs` 已支持）：

```bash
cd D:\guidao
node tools/serve.mjs 8080 .
```

浏览器打开 `http://localhost:8080/yolo-demo/`，点击「开启摄像头」。

- 摄像头只在 `https` 或 `localhost` 下可用。
- 无摄像头或拒绝权限时，可点「用示例图片检测」验证模型推理链路。

## 参数

- 置信度阈值：默认 0.25，滑杆可调。
- NMS IoU 阈值：默认 0.45，滑杆可调。

## 实现要点

- 预处理：等比缩放 + 灰边（114）letterbox 到 640×640，RGB、`0~1` 归一化、NCHW。
- 解码：输出 `1x84x8400`，前 4 通道为 `cx,cy,w,h`，其余 80 通道为类别分数；取最大类别后按阈值过滤。
- 后处理：逐类别 NMS，再把框从 letterbox 坐标映射回原始画面。
- 执行后端：优先 **WebGPU**（加载 fp16 模型），初始化或预热失败时自动回退 **WASM**（fp32 模型）；WASM 在服务器带 `COOP/COEP` 时自动用多线程（最多 4 线程）。页面右上角显示实际后端。
  - 实测：Intel UHD 核显（4 线程 WASM）下 fp32 WebGPU ≈161ms、fp16 WebGPU ≈170ms、WASM ≈146ms；NVIDIA RTX 4060 Laptop（fp16 WebGPU）下 ≈116ms。核显上 WebGPU 没有优势，独显上更快。
  - 前提：Edge/Chrome 需开启「使用图形加速」，且 Windows 中该浏览器设为高性能显卡。

## 已知限制

- 只做逐帧 2D 检测，不含跟踪、测距或运动预测。
- 小目标、逆光、夜间、雨雾、密集遮挡时召回会明显下降。
