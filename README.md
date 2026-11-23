# 导盲视觉（guidao-vision）

真实街景视频 / 摄像头 → YOLOv8n 检测 → 跟踪 ID → 面积与中心逼近判定 → 分级中文语音提示。

- 实时页：[index.html](index.html)（`?video=` 载入本地视频，`?t=` 指定起始秒，`?webgpu=1` 尝试 WebGPU）
- 量化评测台：[eval.html](eval.html)
- YOLO 独立演示页：[yolo-demo/index.html](yolo-demo/index.html)
- 演示视频：[GitHub Releases v0.1](https://github.com/source826/see/releases/tag/v0.1)（视频不放入 commit；B站链接待补）

## 快速开始

```bash
node tools/serve.mjs 8080
```

- 实时页：`http://localhost:8080/index.html`
- 评测台：`http://localhost:8080/eval.html`
- 测试：`npm test`；本机没有 npm 时用 `node --test tests`
- 实时对齐评测（Edge，需先启动本地服务）：
  ```bash
  node tools/live_eval.mjs --videoUrl=assets/videos/tune/nanjing_00.mp4 --port=9400 --out=tmp/live.json
  node tools/live_eval_report.mjs tmp/live.json gt/nanjing_00_sample.json
  ```
  第一个脚本让实时页按真实速度播放并记录实际处理帧（frame/dt/检测/轨迹/报警）；第二个脚本把 GT 按 track id 插值到这些帧，用同一套事件评测计算召回、提前量和误报。

### 相机高度、俯角与估距

实时页可输入相机离地高度和俯角（默认 1.5m / 10°），系统按地面几何估算距离：

```
y' = (y_ground - H/2) / f
d = H * (1 - y' * tanθ) / (y' + tanθ)
f = W / (2 * tan(HFOV / 2))
```

- `H` 为相机离地高度，`θ` 为相机光轴向下俯角（0=水平）。
- 高度/俯角改变后实时生效；可用 `?cam=1.5&pitch=10` 校准。
- 轨迹预判：用最近 6 帧框中心做线性回归估计速度，外推 1.4s（可调 0.8–2.5s），只做短时外推；路径末端标注预判秒数，供反应时间参考。
- 用户播报只说“很近 / 近 / 有点远”，具体米数只保留在 JSON 和叠加层调试信息里。
- 框底在地平线以上或几何值异常时，自动回退到框高估距。
- 评测台与离线演示默认仍用框高估距，以保持历史指标可比。

### 台阶与坡道提醒

- **台阶（暂缓播报）**：街景中的栏杆、树影、花坛会产生等间距水平边缘，实测 `nanjing_02` 会把平地判成台阶。误报会让人在车道上停下摸索，比漏报更危险；当前版本不播报台阶，检测代码与单测保留，等有正样本和更强验证后再开。
  - 既有检测：下方中央 ROI 等间距水平边缘，连续 2 帧确认；`stairs_pov.mp4` 可触发，但街景误报未解决。
- **上坡/下坡**：使用手机姿态传感器（`DeviceOrientationEvent`）的俯仰变化。
  - 点击实时页的“校准姿态/坡道”，在平地上按平常握持角度站约 2 秒完成校准。
  - `beta` 增大按上坡、减小按下坡；变化 3.5°–7° 时保守说“前方有坡道，请小心”。
  - 语音：`前方上坡，请小心` / `前方下坡，请小心`。
- 地形语音不会和“冲过来”叠放：目标语音结束后至少 2 秒才播地形；地形提醒使用独立冷却。
- 桌面浏览器通常没有姿态传感器，坡道提醒会提示“没有收到姿态数据”；台阶检测不依赖传感器。

### 红绿灯

- YOLO 检出红绿灯框后，对框内高饱和红/黄/绿像素投票；连续 3 帧同色才确认。
- 红灯、黄灯提示等待；绿灯只说“请确认行人信号”，不直接说可以通行。
- 远距离小灯在 320 分析宽度下可能检不到；需要更高分辨率或专用裁剪。

### 评测口径与当前结果

**新旧口径并列**（同一批 nanjing_00/02）：

| 指标 | 旧口径（逐帧/未对齐） | 旧口径（实时，GT 未插值） | 新口径（实时对齐 + 背景 GT 三态） |
|---|---|---|---|
| 召回 | 4/4、2/2 | 3/4、2/2（id4 漏） | **4/4、2/2** |
| 提前量中位 | 3.00 s | 0 s | **2.80 s、2.93 s** |
| P10 | 0.00 s、1.13 s | 0 s | **1.10 s、1.17 s** |
| 误报/分 | 39.13（1.53 s 窗口） | 10.08 | **7.20、5.76** |

- 新口径定义：实时页真实速度播放，记录实际处理帧（frame/dt/检测/轨迹/报警）；GT 按 track id 插值到实际帧；GT 起点前用 ID 多数票映射提前报警；小目标匹配 IoU≥0.2；GT 分**事件目标 / 背景目标 / 未匹配**三态，只有未匹配算误报。
- 三态计数（nanjing_00 / 02）：事件目标 95 / 95，背景目标 154 / 123，**未匹配 31 / 39** 次报警。未匹配的唯一轨迹全是真实类别（行人、公交车），没有非目标幻觉；主要是背景 GT 漏标和小目标 ID 抖动。
- 提速：WASM 约 5–8.7 fps；WebGPU 约 11.5 fps，约 1.5–2 倍。ONNX 固定 640，不能改 inputSize；headless WebGPU 不稳定，需 headful。
- 端到端延迟（WASM）：流水线 p50 121–149 ms、p95 176–191 ms；语音排队 p50 147–185 ms、p95 921–1174 ms；**捕获→语音开始 p50 285–365 ms、p95 1.10–1.31 s**。p95 主要耗在 `speechSynthesis` 调度。
- GT 抽样复核：6 帧/51 框，发现约 5 个错误（橱窗模特、花坛、截断行人），约 10% 需人工修正；背景 GT 仍是半自动。
- holdout：nanjing_03 初测 2/4、提前量 2.87 s、误报 8.64 次/分；walk_03/05 无报警；seaside_01 事件 GT 待标注。holdout 不参与调参。
- 新素材：已并行下载 4 段未参与调参的 20 秒片段（人群、快速横穿、阴天街景、夜雨），放在 `assets/videos/new/`，未入 commit，待做一次性最终检验。
- 台阶、斑马线、地面小障碍暂缓播报；检测与单测保留。

### 斑马线（暂缓播报）

- 检测下方中央的多条平行白色横条，用直线拟合左右边界；缺一段时按拟合直线补齐，不要求白条连续。
- 方向文案已实现：左偏说“已向左偏离斑马线，请向右靠”，右偏说“已向右偏离斑马线，请向左靠”；在补齐范围内不报，走到斑马线尽头（白条消失）也不报。
- 合成测试覆盖连续、缺块、左偏、右偏、无斑马线，但真实街景里的车道线/白色标线会被误判成斑马线；清晰斑马线正样本视频仍待补（**正样本待补**）。
- 当前版本不播报斑马线偏离，避免在普通街道上把人引向错误方向；检测、方向文案和单测保留。

### 地面小障碍（暂缓）

- 当前版本不接入语音和横幅提醒；检测代码与单测保留，后续再评估。
- 现有 YOLO 类别只能覆盖香蕉、瓶子、杯子等少数 COCO 类；**石墩子、西瓜皮没有对应类别**，暂不作为交付功能。

## 来源与许可

### 模型与浏览器推理

| 组件 | 文件 / 版本 | 来源 | 许可 |
|---|---|---|---|
| YOLOv8n 权重 | `yolo-demo/models/yolov8n.pt`（本地导出用，未入库） | Ultralytics 官方资源：https://github.com/ultralytics/assets/releases | AGPL-3.0 |
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

- `assets/videos/manifest.json`：tune / holdout 素材清单。tune 7 条、holdout 4 条逐条包含 `bv` 与 `sourceNote`；能追溯的填写 BV 号，未能追溯的统一写“来源未记录，仅本地使用，不对外分发”。素材为 **B 站公开视频的本地缓存**，只用于参数校准与检验，不含合成画面；tune 组用于调参，holdout 组在参数冻结前不参与调参。
- `assets/videos/README-extreme-videos.md`：10 段极端场景视频的来源 BV 号、截取点与用途。
- `assets/videos/tune/nanjing_00.mp4`、`nanjing_02.mp4`：来源描述为“上海南京西路傍晚步行 POV”，具体 BV 号未在仓库记录。
- `assets/videos/narrow_street_approach.mp4`：来源 BV14Jyiz3EUL，用于“迎面逼近/静止障碍”演示。
- `assets/videos/hongkong_walk_02.webm`、`pedestrian_avoidance.ogv`：来源未记录，仅本地使用，不对外分发。
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
- 本项目整体按 AGPL-3.0 发布（因集成 YOLOv8n 权重），自写代码同样适用 AGPL-3.0。
- 根目录 [LICENSE](LICENSE) 为 AGPL-3.0 全文；[yolo-demo/vendor/ort/LICENSE](yolo-demo/vendor/ort/LICENSE) 为 ONNX Runtime MIT 全文。

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
- 演示视频 `demo/yolo_approach_demo.mp4` 体积约 10MB，未放入代码提交；对外分发见 [GitHub Releases v0.1](https://github.com/source826/see/releases/tag/v0.1)。
