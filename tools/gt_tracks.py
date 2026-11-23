"""扫描一段视频里的运动目标，按尺寸增长找逼近目标，输出核对图与 GT。

用法：
  python tools/gt_tracks.py --video assets/videos/tune/nanjing_01.mp4 --start 660 --end 705 --step 5 --out gt/nanjing_01_sample.json
  # 人工看 tmp/gt/trk_sheet_<name>.jpg 后，用 --keep 选择轨迹重新导出：
  python tools/gt_tracks.py ... --keep "3:1,2:2"

只用于离线 GT 标注辅助；站立的、横穿的目标需要人工排除。
"""
import argparse
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / "tmp" / "gt"
MODEL = ROOT / "yolo-demo" / "models" / "yolov8n.pt"
DEFAULT_FPS = 30
CLASSES = {0: "ped", 1: "veh", 2: "veh", 3: "veh", 5: "veh", 7: "veh"}
NAMES = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
COLORS = {"ped": (0, 255, 128), "veh": (255, 170, 0)}


def center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True)
    p.add_argument("--start", type=int, required=True)
    p.add_argument("--end", type=int, required=True)
    p.add_argument("--step", type=int, default=5)
    p.add_argument("--keep", default="", help='轨迹映射，如 "3:1,2:2"')
    p.add_argument("--out", default="")
    p.add_argument("--imgsz", type=int, default=960, help="YOLO 推理尺寸；内存不足时降到 640")
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--fps", type=float, default=0, help="抽帧帧率；缺省按 ffprobe 探测")
    p.add_argument("--cols", type=int, default=2, help="核对图拼版列数")
    return p.parse_args()


def main():
    args = parse_args()
    video = Path(args.video)
    if not video.is_absolute():
        video = ROOT / video
    name = video.stem
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", str(video)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    vw, vh = (int(v) for v in probe.split("x"))
    rate = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
         "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    num, _, den = rate.partition("/")
    fps = args.fps or (float(num) / float(den or 1) if num else DEFAULT_FPS)
    frames = list(range(args.start, args.end + 1, args.step))
    paths = []
    for f in frames:
        out = TMP / f"raw_{name}_{f}.jpg"
        if not out.exists():
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-ss", f"{f / fps:.3f}", "-i", str(video),
                 "-frames:v", "1", str(out)],
                check=True,
            )
        paths.append(out)

    model = YOLO(str(MODEL))
    results = model.predict(
        [str(p) for p in paths],
        conf=0.12,
        classes=list(CLASSES),
        imgsz=args.imgsz,
        batch=args.batch,
        verbose=False,
    )

    tracks = []
    active = []
    for frame, res in zip(frames, results):
        dets = [
            {"box": tuple(map(float, b)), "score": float(s), "cls": int(c)}
            for b, s, c in zip(res.boxes.xyxy.cpu().numpy(), res.boxes.conf.cpu().numpy(), res.boxes.cls.cpu().numpy())
        ]
        used = set()
        for tr in active:
            lc = center(tr["hits"][-1][1])
            best, best_d = None, 1e9
            for i, det in enumerate(dets):
                if i in used or det["cls"] != tr["cls"]:
                    continue
                d = sum((a - b) ** 2 for a, b in zip(center(det["box"]), lc)) ** 0.5
                if d < best_d and d < 130:
                    best, best_d = i, d
            if best is not None:
                used.add(best)
                tr["hits"].append((frame, dets[best]["box"], dets[best]["score"]))
        for i, det in enumerate(dets):
            if i in used:
                continue
            tr = {"cls": det["cls"], "hits": [(frame, det["box"], det["score"])]}
            tracks.append(tr)
            active.append(tr)
        active = [t for t in active if frame - t["hits"][-1][0] <= 10]

    kept = []
    for i, tr in enumerate(tracks, 1):
        if len(tr["hits"]) < 3:
            continue
        h0 = tr["hits"][0][1][3] - tr["hits"][0][1][1]
        h1 = tr["hits"][-1][1][3] - tr["hits"][-1][1][1]
        kept.append({"id": i, "cls": tr["cls"], "growth": round(h1 / max(h0, 1e-6), 2), "hits": tr["hits"]})

    for k in kept:
        print(f"T{k['id']} {NAMES[k['cls']]:10s} growth={k['growth']:.2f} hits={len(k['hits'])} "
              f"frames={k['hits'][0][0]}..{k['hits'][-1][0]} box0={tuple(round(v) for v in k['hits'][0][1])}")

    for f in frames:
        img = Image.open(TMP / f"raw_{name}_{f}.jpg").convert("RGB")
        d = ImageDraw.Draw(img)
        for k in kept:
            for fr, box, _s in k["hits"]:
                if fr != f:
                    continue
                color = COLORS[CLASSES[k["cls"]]]
                d.rectangle(box, outline=color, width=3)
                d.text((box[0] + 3, box[1] + 2), f"T{k['id']}", fill=color)
        img.save(TMP / f"trk_{name}_{f}.jpg", quality=90)
    tiles = [Image.open(TMP / f"trk_{name}_{f}.jpg") for f in frames]
    tw, th = tiles[0].size
    cols = max(1, args.cols)
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * th))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * tw, (i // cols) * th))
    sheet_path = TMP / f"trk_sheet_{name}.jpg"
    sheet.save(sheet_path, quality=85)
    print("sheet:", sheet_path)

    (TMP / f"tracks_{name}.json").write_text(
        json.dumps(
            [
                {
                    "id": t["id"],
                    "cls": NAMES[t["cls"]],
                    "growth": t["growth"],
                    "hits": [[f, [round(v) for v in b], round(s, 2)] for f, b, s in t["hits"]],
                }
                for t in kept
            ],
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )

    if args.keep:
        mapping = {}
        for pair in args.keep.split(","):
            src, gid = pair.split(":")
            mapping[int(src)] = int(gid)
        gt = {"name": name, "width": vw, "height": vh, "fps": fps, "frames": {}}
        for t in kept:
            if t["id"] not in mapping:
                continue
            for f, b, _s in t["hits"]:
                x1, y1, x2, y2 = (round(v) for v in b)
                gt["frames"].setdefault(str(f), []).append(
                    {"id": mapping[t["id"]], "cls": CLASSES[t["cls"]], "x": x1, "y": y1,
                     "w": x2 - x1, "h": y2 - y1}
                )
        out = ROOT / (args.out or f"gt/{name}_sample.json")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(gt, ensure_ascii=False, indent=2), encoding="utf-8")
        print("gt:", out)


if __name__ == "__main__":
    main()
