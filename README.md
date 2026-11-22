# 导盲视觉（guidao-vision）

真实街景视频 / 摄像头 → YOLOv8n 检测 → 跟踪 ID → 面积与中心逼近判定 → 分级中文语音提示。

- 实时页：[index.html](index.html)（`?video=` 载入本地视频，`?t=` 指定起始秒，`?webgpu=1` 尝试 WebGPU）
- 量化评测台：[eval.html](eval.html)
- YOLO 独立演示页：[yolo-demo/index.html](yolo-demo/index.html)
- 演示视频：[demo/yolo_approach_demo.mp4](demo/yolo_approach_demo.mp4)

## 快速开始

```bash
node tools/serve.mjs 8080
```

- 实时页：`http://localhost:8080/index.html`
- 评测台：`http://localhost:8080/eval.html`
- 测试：`npm test`；本机没有 npm 时用 `node --test tests`

## 来源与许可

### 模型与浏览器推理

| 组件 | 文件 / 版本 | 来源 | 许可 |
|---|---|---|---|
| YOLOv8n 权重 | `yolo-demo/models/yolov8n.pt` | Ultralytics 官方资源：https://github.com/ultralytics/assets/releases | AGPL-3.0 |
| YOLOv8n ONNX（fp32） | `yolo-demo/models/yolov8n.onnx` | 由上述官方权重经 Ultralytics `export` 导出，见 `yolo-demo/tools/export_onnx.py` | AGPL-3.0 |
| YOLOv8n ONNX（fp16） | `yolo-demo/models/yolov8n.fp16.onnx` | 由 fp32 ONNX 转换，见 `yolo-demo/tools/convert_fp16.py` | AGPL-3.0 |
| onnxruntime-web | 1.20.1，`yolo-demo/vendor/ort/` | 微软 ONNX Runtime 官方 Web 发行包：https://github.com/microsoft/onnxruntime ；npm：`onnxruntime-web@1.20.1` | MIT |

- YOLOv8 由 Ultralytics 以 **AGPL-3.0** 发布：https://github.com/ultralytics/ultralytics/blob/main/LICENSE
- ONNX Runtime 许可证：https://github.com/microsoft/onnxruntime/blob/main/LICENSE
- 模型输入 `1x3x640x640`，输出 `1x84x8400`；浏览器端 letterbox、解码、逐类 NMS 在 [src/detection/yolo.js](src/detection/yolo.js)，实时页与评测台共用。YOLO 独立演示页的更多说明见 [yolo-demo/README.md](yolo-demo/README.md)。

### 离线工具（不随浏览器下发）

| 工具 | 用途 | 许可 |
|---|---|---|
| Ultralytics `ultralytics` | 下载官方权重、导出 ONNX、离线检测 | AGPL-3.0 |
| PyTorch | Ultralytics 运行依赖 | BSD-3-Clause |
| OpenCV (`opencv-python`) | 读取视频、绘制演示画面 | Apache-2.0 |
| Pillow | 演示视频中文文字渲染 | HPND |
| NumPy | 数值计算 | BSD-3-Clause |
| onnx | 检查/转换 ONNX 模型 | Apache-2.0 |
| FFmpeg | 视频解码、抽帧、演示视频编码 | 本地使用 GPL 构建（`ffmpeg-master-latest-win64-gpl`）；仓库不分发其二进制 |

离线环境位于 `yolo-demo/.venv/`，仅用于模型导出、GT 标注辅助和演示视频渲染，不参与浏览器运行时。

### 视频与标注素材

- `assets/videos/manifest.json`：tune / holdout 素材清单。素材为 **B 站公开视频的本地缓存**，只用于参数校准与检验，不含合成画面；tune 组用于调参，holdout 组在参数冻结前不参与调参。
- `assets/videos/README-extreme-videos.md`：10 段极端场景视频的来源 BV 号、截取点与用途。
- `assets/videos/tune/nanjing_00.mp4`、`nanjing_02.mp4`：来源描述为“上海南京西路傍晚步行 POV”，具体 BV 号未在仓库记录。
- `assets/videos/narrow_street_approach.mp4`：来源 BV14Jyiz3EUL，用于“迎面逼近/静止障碍”演示。
- `assets/videos/hongkong_walk_02.webm`、`pedestrian_avoidance.ogv`：项目原有真实素材，来源信息未在仓库记录。
- `gt/*.json`：人工逐帧标注；标注辅助工具为 `tools/gt_tracks.py`、`tools/make_gt_sample.py`。
- `demo/yolo_approach_demo.mp4`：由上述真实素材离线渲染，包含 nanjing_00、nanjing_02、narrow_street_approach（BV14Jyiz3EUL）三段；语音来自系统中文 TTS，不含第三方音乐或录音。

### 语音

- 演示视频语音：Windows SAPI `Microsoft Huihui Desktop`（zh-CN）生成，音源文件在 `demo/audio/`。
- 实时页语音：浏览器 Web Speech API（`speechSynthesis`），不依赖外部语音文件。
- 语音文案策略在 [src/app/announce.js](src/app/announce.js)：明确快速逼近才说“有人冲过来”，近处静止目标说“前方静止障碍”，拿不准时说“前方有情况请确认”。

## 许可与合规

- 本项目集成了 **YOLOv8n（AGPL-3.0）** 权重与 ONNX 模型。分发包含该模型的应用时，需按 AGPL-3.0 兼容方式处理；如需闭源商用，请先向 Ultralytics 取得商业授权。
- onnxruntime-web 为 MIT，需保留其版权与许可声明。
- 视频素材版权归原作者/平台所有，仓库内仅作本地评测与演示缓存；对外发布演示视频前请确认素材授权。
- 自写代码如无另行声明，不对外授予额外许可。

## 主要目录

```
src/app/          实时页、管线、语音播报策略
src/detection/    YOLOv8n ONNX 检测层
src/tracking/     逼近跟踪、风险判定、卡尔曼/轨迹
src/vision/       灰度、金字塔、LK 光流、RANSAC
eval/             评测台指标、事件评测、bench
gt/               人工标注样例
tools/            静态服务器、GT 辅助、离线体检
yolo-demo/        YOLOv8n 独立演示页、模型、ORT 运行时
demo/             演示视频与三条语音音源
tests/            单元测试
```

## GitHub 仓库内容说明

- **已包含**：`src/`、`eval/`、`tests/`、`tools/`、`gt/` 样例、页面文件、YOLOv8n ONNX 模型、onnxruntime-web 运行时。
- **未包含**（体积或版权原因）：`assets/videos/` 真实视频、`demo/` 演示视频与音源、`yolo-demo/.venv/` 离线 Python 环境、`bench/` 与 `tmp/` 生成结果。
- 复现评测：把真实视频按 `assets/videos/manifest.json` 的路径放回本地；模型权重与 ORT 运行时已随仓库提供。
- 演示视频 `demo/yolo_approach_demo.mp4` 体积约 10MB，未放入代码提交；如需对外分发，建议放到 GitHub Releases 而不是普通 commit。
