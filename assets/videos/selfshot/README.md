# 自拍最终检验素材：采集与标注协议

用途：作为下一批**最终检验**。拍摄、标注期间不得查看或调参算法结果；GT 完成并冻结参数后只跑一次。

## 1. 片段清单（5 段，每段 15–30 s）

| 文件名 | 场景 | 该报事件 | 负样本/压力点 |
|---|---|---|---|
| `selfshot_frontal_01.mp4` | 3–5 m 宽人行道，单人正面走来，从左侧或右侧通过 | 1 次迎面逼近 | 对向路人不算 |
| `selfshot_side_entry_01.mp4` | 侧方 3–8 m 处行人突然折入前方通道 | 1 次侧向进入 | 路边停留的人 |
| `selfshot_crowd_01.mp4` | 4 人以上在 5 m 内，其中 1 人明确迎面逼近 | 至少 1 次 | 同向行走/横穿人群 |
| `selfshot_lowlight_01.mp4` | 傍晚或地下通道，单人迎面走来 | 1 次 | 背光、低对比 |
| `selfshot_negative_01.mp4` | 空旷街道或有路人但无人进入通道 | 0 次 | 静止障碍、同向/横向路人 |

- 同一场景可拍 2–3 条，选 1 条入最终集；未入选的不要提前跑算法。
- 拍摄前记录：地点、时间、天气/光照、相机高度、镜头、帧率、时长、事件大致秒数、目标衣着。
- 所有出镜人员需知情同意；不要在未授权场所拍摄。

## 2. 拍摄参数

- 分辨率 ≥ 1280×720，横屏；30 fps **固定帧率**，H.264 MP4。
- 关闭电子防抖/超广角裁切；手持或胸挂，相机高度约 1.5 m，步行速度 1.2–1.4 m/s。
- 不要变焦、不要后期裁剪/加速；曝光锁定，避免自动曝光频繁跳变。
- 每段开头留 1–2 s 静止或直行画面，便于预热与走廊估计。

## 3. 入库与元数据

- 放到 `assets/videos/selfshot/`，文件名按上表。
- 在 `assets/videos/manifest.json` 的 `selfshot_plan.clips` 中登记：文件、时长、fps、分辨率、场景、事件秒数、拍摄备注。
- 视频本体不入 Git（`.gitignore` 已排除 mp4/webm/ogv）。

## 4. GT 标注（参数冻结前完成）

1. 抽轨迹与核对图（工具已支持按视频实际帧率抽帧）：

   ```powershell
   D:\guidao\yolo-demo\.venv\Scripts\python.exe tools/gt_tracks.py `
     --video assets/videos/selfshot/selfshot_frontal_01.mp4 `
     --start 0 --end <末帧> --step 5 --cols 4
   ```

2. 看 `tmp/gt/trk_sheet_<name>.jpg`，确认哪些轨迹是**迎面逼近/进入通道**的事件目标；站立、同向、横穿但不会进入通道的标为背景。
3. 用 `--keep "轨迹号:GT号,..."` 导出事件 GT 样例；背景轨迹用 `tools/merge_bg_gt.py` 合并：

   ```powershell
   python tools/merge_bg_gt.py --tracks tmp/gt/tracks_<name>.json `
     --event-gt gt/<name>_sample.json --out gt/<name>_full.json --min-hits 5
   ```

4. 用 `python tools/label_gt_motion.py --gt gt/<name>_full.json` 补三态标签。
5. 人工抽检：
   - 事件轨迹逐条确认（100%）；
   - 背景框至少抽 20% 帧，记录错框数；
   - GT 覆盖片长 ≥80%，否则该段不用于误报评估。
6. 把复核比例、事件数、覆盖帧数写入 `manifest.json` 与该片段记录。

## 5. 冻结与一次性运行

1. 5 段 GT 全部完成并复核后，运行 `node tools/freeze_params.mjs --out=eval/frozen_params_<日期>.json`。
2. 冻结后不再改任何规则、阈值或 GT。
3. 每段实时跑一次，记录 `tmp/selfshot_<name>.json`，用 `tools/live_eval_report.mjs` 出报告。
4. 结果无论好坏都如实记录；不重跑、不调参。目标召回为主指标，群体召回和覆盖为辅。

## 6. 最低验收

- 至少 3 段可评估（有背景 GT、覆盖 ≥60% 片长）。
- 至少 2 个明确的迎面逼近事件。
- 至少 1 段负样本，用于看是否乱报。
- 若达不到，补拍，不得用开发集/验证集片段顶替。

## 7. 实际入库与结果（2026-11-23）

用户上传两段 1080p/60 手持街景（`VID_20261122_160013.mp4`、`VID_20261122_160356.mp4`），切出 30 s 固定帧率窗口后复核：

| 文件 | 原片区间 | 复核结论 |
|---|---|---|
| `selfshot_pass_01.mp4` | 160013 的 30–60 s | 沿街停靠车辆，无移动目标进通道；负样本 |
| `selfshot_negative_01.mp4` | 160356 的 240–270 s | 前方红车驶离、远处车流；负样本 |
| `selfshot_approach_01.mp4` | 160013 的 60–90 s | 白色 SUV 为路边停放车辆；不作为事件 |
| `selfshot_approach_02.mp4` | 160356 的 175–205 s | 白色本田在窗口起点已贴近通过，无接近过程；不作为事件 |

- 最终只把两个负样本窗口纳入本批检验：GT 全背景、冻结参数后各跑一次。60 s 内 3 条语音全部匹配背景 GT，未匹配 0，FP 0/min。
- **本批没有可计算的召回**；不要把它写成“通过最终检验”。下一批自拍必须拍到目标从 10–15 m 外开始、有至少 5 s 可见接近过程，再标注事件目标。

## 8. 2026-11-23 新素材冒烟（非最终检验）

新入库 `selfshot_pass_02.mp4`（1080p30/30 s）、`selfshot_frontal_01.mp4`（1080p60/113 s）、`selfshot_frontal_02.mp4`（1080p60/361 s）。三条都还没有 GT 和事件时间点，本轮只做技术冒烟：

| 视频 | 实时 fps | detect p50/p95 | e2e p50/p95 | 语音 | 语音/分 |
|---|---|---|---|---|---|
| pass_02 | 7.5 | 107.3 / 152.4 ms | 133.2 / 133.2 ms | 2 | 3.99 |
| frontal_01 | 5.9 | 127.8 / 195.7 ms | 415.2 / 781.1 ms | 6 | 3.19 |
| frontal_02 | 5.8 | 142.1 / 178.3 ms | 400.9 / 930.9 ms | 54 | 8.97 |

- 三条都低于 8 fps；frontal_01/02 是 60 fps 且长度超过 15–30 s 协议，最终检验前应先转 30 fps 并裁窗口。
- pass_02 两条都是汽车“静止障碍”；frontal_01 六条全是车辆；frontal_02 6 分钟 54 条，车辆为主，语音密度偏高。
- 没有 GT，不能算召回/FP/提前量；结果见 `eval/smoke_new_videos_20261123.json`，联系表在 `eval/smoke_new_videos_20261123/`。下一步等人工事件时间点，冻结后只跑一次。

### zebra_b_approach（用户提供 GT/时间点）

- 用户提供 `D:/cf/guardian-videos/zebra_b_approach.mp4` + JSON：目标 1 粉衣女子，`startSec=0`、`dangerSec=10.5`（相对片段）。
- 已复制到本目录，并用 `gt_tracks.py` 的 T2 轨迹生成事件 1、合并背景 GT；`events_manual_zebra_20261123.json` 记录 wide=0.16 s、strict=0.36 s、danger=10.5 s。
- 结果：0 条语音，旧/新口径都 0/1，FP 0；目标匹配/严格通道 24/24 帧，但 `approachingFrames=0`、`level2Frames=0`。框高增长率 0.001–0.022/s，低于人群规则 0.03/s，卡点在人群逼近门槛，不是 TP 口径。
- 证据：`eval/zebra_b_approach_eval_20261123.json`、`gt/zebra_b_approach_full.json`。未改阈值。
