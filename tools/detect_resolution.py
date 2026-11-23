"""检测分辨率对照：320/480/640 宽下的首次稳定检出、单帧延迟、帧率。

只做检测层，不跑 JS 管线；视频按 10 fps 抽帧，帧号 3*i 对应 30 fps 原视频。
"""
import json
import subprocess
import time
from pathlib import Path

from PIL import Image
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / "tmp" / "detect"
MODEL = ROOT / "yolo-demo" / "models" / "yolov8n.pt"
CLASSES = {0: "ped", 1: "veh", 2: "veh", 3: "veh", 5: "veh", 7: "veh"}
VEH = {1, 2, 3, 5, 7}
VIDEOS = [
    ("narrow_street", "assets/videos/narrow_street_approach.mp4", "gt/narrow_street_approach_full.json", [1, 2]),
    ("narrow_hutong", "assets/videos/narrow_hutong_approach_01.mp4", "gt/narrow_hutong_approach_full.json", [1, 2]),
    ("tunnel", "assets/videos/tunnel_backlight.mp4", "gt/tunnel_backlight_full.json", [1, 2, 3]),
]
SIZES = [320, 480, 640]
SAMPLE_FPS = 10


def iou(a, b):
    x0 = max(a[0], b[0])
    y0 = max(a[1], b[1])
    x1 = min(a[2], b[2])
    y1 = min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    uni = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / uni if uni > 0 else 0


def cls_ok(gt_cls, det_cls):
    return det_cls in VEH if gt_cls == "veh" else det_cls == 0


def main():
    TMP.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(MODEL))
    results = []
    for name, video, gt_path, event_ids in VIDEOS:
        frame_dir = TMP / name
        frame_dir.mkdir(exist_ok=True)
        imgs = sorted(frame_dir.glob("*.jpg"))
        if not imgs:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", video, "-vf", f"fps={SAMPLE_FPS}",
                 "-q:v", "3", str(frame_dir / "%05d.jpg")],
                check=True,
            )
            imgs = sorted(frame_dir.glob("*.jpg"))
        gt = json.loads((ROOT / gt_path).read_text(encoding="utf-8"))
        gt_frames = {int(k): v for k, v in gt["frames"].items()}
        gt_keys = sorted(gt_frames)
        pil_images = [Image.open(p).convert("RGB") for p in imgs]
        for size in SIZES:
            hits = {eid: [] for eid in event_ids}
            correct = 0
            # 预热一次，避免把模型初始化算进首帧延迟。
            model.predict([pil_images[0]], imgsz=size, conf=0.12, classes=list(CLASSES), verbose=False)
            t0 = time.perf_counter()
            for i in range(0, len(pil_images), 8):
                batch = pil_images[i:i + 8]
                preds = model.predict(batch, imgsz=size, conf=0.12, classes=list(CLASSES), verbose=False)
                for j, res in enumerate(preds):
                    idx = i + j
                    frame = idx * (30 // SAMPLE_FPS)
                    gt_frame = min(gt_keys, key=lambda k: abs(k - frame))
                    if abs(gt_frame - frame) > 3:
                        for eid in event_ids:
                            hits[eid].append(False)
                        continue
                    boxes = [
                        (list(map(float, b)), int(c))
                        for b, c in zip(res.boxes.xyxy.cpu().numpy(), res.boxes.cls.cpu().numpy())
                    ]
                    for eid in event_ids:
                        target = next((b for b in gt_frames[gt_frame] if b["id"] == eid and not b.get("bg")), None)
                        if target is None:
                            hits[eid].append(False)
                            continue
                        gb = [target["x"], target["y"], target["x"] + target["w"], target["y"] + target["h"]]
                        ok = any(cls_ok(target["cls"], c) and iou(gb, bb) >= 0.2 for bb, c in boxes)
                        hits[eid].append(ok)
                        if ok:
                            correct += 1
            elapsed = time.perf_counter() - t0
            first_stable = {}
            for eid in event_ids:
                run = 0
                found = None
                for i, ok in enumerate(hits[eid]):
                    run = run + 1 if ok else 0
                    if run >= 2:
                        frame = i * (30 // SAMPLE_FPS)
                        found = {"sample": i, "frame30": frame, "sec": round(frame / 30, 2)}
                        break
                first_stable[eid] = found
            mean_ms = (elapsed / max(1, len(imgs))) * 1000
            row = {
                "video": name,
                "size": size,
                "frames": len(imgs),
                "meanLatencyMs": round(mean_ms, 1),
                "fps": round(1000 / mean_ms, 1) if mean_ms > 0 else None,
                "matchedDetections": correct,
                "firstStable": first_stable,
            }
            results.append(row)
            print(json.dumps(row, ensure_ascii=False))
    out = ROOT / "eval" / "detect_resolution_20261123.json"
    out.write_text(json.dumps({"sampleFps": SAMPLE_FPS, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out)


if __name__ == "__main__":
    main()
