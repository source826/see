"""GT 标注辅助：用本地 yolov8n 生成行人候选框，按位置跟踪选中目标，输出带编号的核对图。

只用于离线标注辅助，最终 GT 会人工核对；不参与导盲管线。
"""
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "videos" / "tune" / "nanjing_00.mp4"
TMP = ROOT / "tmp" / "gt"
MODEL = ROOT / "yolo-demo" / "models" / "yolov8n.pt"
FPS = 30
FRAMES = list(range(380, 426, 5))
SEEDS = {1: (394, 339), 2: (440, 334)}  # 轨迹 1=提袋男士，2=同行女士（帧 380 的初始中心）


def extract(frame: int) -> Path:
    out = TMP / f"raw_{frame}.jpg"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-ss", f"{frame / FPS:.3f}", "-i", str(SRC),
         "-frames:v", "1", str(out)],
        check=True,
    )
    return out


def center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def main():
    TMP.mkdir(parents=True, exist_ok=True)
    paths = [extract(f) for f in FRAMES]
    model = YOLO(str(MODEL))
    results = model.predict([str(p) for p in paths], conf=0.10, classes=[0], imgsz=960, verbose=False)

    tracks = {1: [], 2: []}
    prev = {k: v for k, v in SEEDS.items()}
    for frame, res in zip(FRAMES, results):
        boxes = [tuple(map(float, b)) for b in res.boxes.xyxy.cpu().numpy()]
        scores = [float(s) for s in res.boxes.conf.cpu().numpy()]
        chosen = {}
        for tid, pc in prev.items():
            best, best_d = None, 1e9
            for i, b in enumerate(boxes):
                if i in chosen:
                    continue
                c = center(b)
                d = ((c[0] - pc[0]) ** 2 + (c[1] - pc[1]) ** 2) ** 0.5
                if d < best_d:
                    best, best_d = i, d
            if best is not None and best_d < 160:
                chosen[best] = tid
                prev[tid] = center(boxes[best])
        for i, tid in chosen.items():
            x1, y1, x2, y2 = boxes[i]
            tracks[tid].append((frame, round(x1), round(y1), round(x2 - x1), round(y2 - y1), round(scores[i], 2)))
        # 画核对图：所有候选细灰框+编号，选中目标粗绿框+轨迹号
        img = Image.open(paths[FRAMES.index(frame)]).convert("RGB")
        d = ImageDraw.Draw(img)
        for i, (b, s) in enumerate(zip(boxes, scores)):
            d.rectangle(b, outline=(140, 140, 140), width=1)
            d.text((b[0] + 2, max(0, b[1] - 12)), f"{i}:{s:.2f}", fill=(200, 200, 200))
        for i, tid in chosen.items():
            b = boxes[i]
            d.rectangle(b, outline=(0, 255, 128), width=3)
            d.text((b[0] + 3, b[1] + 2), f"T{tid}", fill=(0, 255, 128))
        img.save(TMP / f"pick_{frame}.jpg", quality=90)

    tiles = [Image.open(TMP / f"pick_{f}.jpg") for f in FRAMES]
    tw, th = tiles[0].size
    sheet = Image.new("RGB", (2 * tw, 5 * th))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % 2) * tw, (i // 2) * th))
    sheet.save(TMP / "pick_sheet.jpg", quality=85)

    for tid, rows in tracks.items():
        print(f"track {tid}: {len(rows)} 帧")
        for r in rows:
            print("  ", r)
    print("sheet:", TMP / "pick_sheet.jpg")

    gt = {"name": "nanjing_00", "width": 854, "height": 480, "fps": FPS, "frames": {}}
    for tid, rows in tracks.items():
        for f, x, y, w, h, _score in rows:
            gt["frames"].setdefault(str(f), []).append(
                {"id": tid, "cls": "ped", "x": x, "y": y, "w": w, "h": h}
            )
    out = ROOT / "gt" / "nanjing_00_sample.json"
    out.write_text(json.dumps(gt, ensure_ascii=False, indent=2), encoding="utf-8")
    print("gt:", out)


if __name__ == "__main__":
    main()
