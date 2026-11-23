# 极端场景真实视频清单

10 段真实街景视频（B站公开视频截取），每段约 20 秒。用于评测页 8 类极端场景分组验收。
从 B 站真实视频截取，非合成数据。文件名即评测页里的视频名，无强制 manifest。

| 文件名 | 来源 BV | 截取点 | 分辨率 | 对应 eval 极端场景标签 |
|---|---|---|---|---|
| night_rain_walk.mp4 | BV1k6yhzHEph | 60s+20 | 1280x720 | 低照度/夜间 + 雨天/镜头水珠 |
| handheld_night_run.mp4 | BV1mD4y1F74V | 60s+20 | 640x360 | 剧烈手抖/小跑 + 低照度/夜间 |
| tunnel_backlight.mp4 | BV1kUpsedE4R | 300s+20 | 1280x720 | 强逆光/隧道出入口 |
| crowd_dense.mp4 | BV17kVgzrEag | 200s+20 | 1280x720 | 密集人群/长时间遮挡 |
| fast_crossing.mp4 | BV1hvY969EXZ | 18s+20 | 1280x720 | 自行车电动车快速横穿 |
| ebike_pov_traffic.mp4 | BV1Mepoe4EbN | 120s+20 | 1280x720 | 自行车电动车快速横穿 |
| puddle_reflection.mp4 | BV1pe411q7Fz | 15s+20 | 1280x720 | 积水反光/镜面倒影 |
| stairs_pov.mp4 | BV1sG411W7te | 15s+20 | 640x360 | 上下楼梯/路缘石 |
| overcast_street_pov.mp4 | BV1JgsC6QEnj | 120s+20 | 1280x720 | 补充：阴天普通街景（日常基准对照） |
| narrow_street_approach.mp4 | BV14Jyiz3EUL | 900s+20 | 1280x720 | **走廊侵入**：窄商店街、密集人群、有人正面迎面逼近（最接近"侵入"事件） |

原有素材：
- `hongkong_walk_02.webm`：iPhone 5 拍摄，元数据日期 2014-10-20，坐标 +22.2805,+114.1554（香港）；来源未记录，仅本地使用，不对外分发。
- `pedestrian_avoidance.ogv`：来源未记录，仅本地使用，不对外分发。

## 2026-11-23 新增素材与质量备注

| 文件 | 来源 BV | 用途 | 质量备注 |
|---|---|---|---|
| `new/BV17kVgzrEag_300_h264.mp4` | BV17kVgzrEag | 人群场景最终检验 | 人群密集，仅作 crowd 规则一次性验证 |
| `new/BV1hvY969EXZ_60_h264.mp4` | BV1hvY969EXZ | 快速横穿最终检验 | 事件目标多在画面边缘，未穿过走廊；只用于误报压力测试 |
| `new/BV1JgsC6QEnj_200_h264.mp4` | BV1JgsC6QEnj | 阴天街景最终检验 | 普通街景对照 |
| `new/BV1k6yhzHEph_120_h264.mp4` | BV1k6yhzHEph | 夜间雨天最终检验 | 24 fps；**前 4 秒为静止机位**，事件/三态统计从 4 s 后开始 |
| `stairs_pov.mp4` | BV1sG411W7te | 仅环境层/稳定性参考 | **整段手抖+模糊**，不纳入感知指标，不作为算法效果依据 |

## 2026-11-23 开发集诊断用素材

- 这 4 段最初按“参数冻结后一次性”跑过，现已改称开发集，只用于诊断，不再当最终检验：`narrow_street_approach.mp4`、`narrow_hutong_approach_01.mp4`、`tunnel_backlight.mp4`、`puddle_reflection.mp4`。
- 对应 GT：`gt/narrow_street_approach_full.json`、`gt/narrow_hutong_approach_full.json`、`gt/tunnel_backlight_full.json`、`gt/puddle_reflection_full.json`。
- `stairs_pov`（整段手抖模糊）、`handheld_night_run`、`ebike_pov_traffic`、`crowd_dense` 未纳入本轮按目标召回；`stairs_pov` 只作环境层/稳定性参考。

## 素材使用限制
- 以上素材版权归原作者/平台所有；仓库仅记录来源与用途，不对外分发视频文件。
- 未能追溯 BV 号的素材统一按“来源未记录，仅本地使用，不对外分发”处理。

## 重要说明
- 这些是**测试输入素材**，不含真值标注。要在评测页跑出事件召回数字，仍需对每段做人工帧标注（标出真正的侵入/接近事件发生在哪几帧）。
- **narrow_street_approach.mp4** 是专门补的"迎面逼近"镜头：第一人称窄商店街，有人正面朝镜头走来且逐渐逼近（抽帧已确认 3s/10s/17s 白衣人由远及近）。这是 10 段里最接近"走廊侵入/迎面来人"的一条，建议优先拿它做事件召回验收。
- 其余 9 段没有明确"迎面逼近"镜头：最接近的是 fast_crossing（快速横穿）和 ebike_pov_traffic（电动车车流），需人工逐帧确认里面有没有真正的接近/侵入事件；没有的话事件召回 0.0% 是"素材里没有可抓事件"，不是算法结论——和内置街景的情况一样。
