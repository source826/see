"""生成 nanjing_00 的 10 帧 GT 样例（只标迎面走来、提白色购物袋的男士）。

框坐标先按锚点人工测量，再在锚点之间线性插值；本脚本负责画框预览和导出 GT JSON。
"""
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "videos" / "tune" / "nanjing_00.mp4"
TMP = ROOT / "tmp" / "gt"
OUT = ROOT / "gt" / "nanjing_00_sample.json"
FPS = 30

# 锚点：帧号 -> (x, y, w, h)，人工在带网格的帧上测量
ANCHORS = {
    360: (352, 250, 40, 105),   # 12.0s
    405: (352, 288, 46, 120),   # 13.5s
    420: (305, 288, 62, 142),   # 14.0s
    435: (208, 258, 84, 222),   # 14.5s（下沿已出画）
    450: (70, 245, 110, 235),   # 15.0s（下沿已出画）
}
FRAMES = list(range(360, 451, 10))


def lerp(a, b, t):
    return round(a + (b - a) * t)


def box_at(frame):
    keys = sorted(ANCHORS)
    if frame <= keys[0]:
        return ANCHORS[keys[0]]
    if frame >= keys[-1]:
        return ANCHORS[keys[-1]]
    for lo, hi in zip(keys, keys[1:]):
        if lo <= frame <= hi:
            t = (frame - lo) / (hi - lo)
            a, b = ANCHORS[lo], ANCHORS[hi]
            return tuple(lerp(a[i], b[i], t) for i in range(4))
    raise ValueError(frame)


def main():
    TMP.mkdir(parents=True, exist_ok=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tiles = []
    gt_frames = {}
    for f in FRAMES:
        t = f / FPS
        img_path = TMP / f"qa_{f}.jpg"
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(SRC),
                "-frames:v", "1", str(img_path),
            ],
            check=True,
        )
        image = Image.open(img_path).convert("RGB")
        draw = ImageDraw.Draw(image)
        x, y, w, h = box_at(f)
        draw.rectangle([x, y, x + w, y + h], outline=(0, 255, 128), width=3)
        draw.text((x + 4, max(2, y - 14)), f"f{f} t={t:.2f}", fill=(0, 255, 128))
        tiles.append(image)
        gt_frames[str(f)] = [{"id": 1, "cls": "ped", "x": x, "y": y, "w": w, "h": h}]

    cols, rows = 2, 5
    tw, th = tiles[0].size
    sheet = Image.new("RGB", (cols * tw, rows * th), (0, 0, 0))
    for i, tile in enumerate(tiles):
        sheet.paste(tile, ((i % cols) * tw, (i // cols) * th))
    sheet.save(TMP / "sample_sheet.jpg", quality=88)

    data = {
        "name": "nanjing_00",
        "width": 854,
        "height": 480,
        "fps": FPS,
        "frames": gt_frames,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"GT: {OUT} ({len(gt_frames)} 帧)")
    print(f"预览: {TMP / 'sample_sheet.jpg'}")


if __name__ == "__main__":
    main()
