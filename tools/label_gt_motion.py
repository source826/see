"""用 GT 框脚点纵坐标（bbox 底边）给每个框独立标注 approaching/receding/static。

不依赖系统跟踪器或面积增长，作为三态的外部校验信号。
对每个框取 ±12 帧内的脚点归一化纵坐标做线性回归，按阈值分类。
这里刻意不做“减去同帧中位斜率”：在多人都迎面走来的场景里，中位斜率本身就等于
逼近速度，减掉会把整组人误标成 static；而对使用者而言，脚点在画面里持续下移
（无论自己走还是对方走）就是相对逼近。

用法：python tools/label_gt_motion.py --gt gt/nanjing_00_full.json
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TH = 0.0008  # 归一化脚点纵坐标 / 帧


def slope(points):
    n = len(points)
    if n < 2:
        return None
    sx = sum(p[0] for p in points)
    sy = sum(p[1] for p in points)
    sxx = sum(p[0] * p[0] for p in points)
    sxy = sum(p[0] * p[1] for p in points)
    den = n * sxx - sx * sx
    if abs(den) < 1e-9:
        return None
    return (n * sxy - sx * sy) / den


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gt", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    path = ROOT / args.gt
    gt = json.loads(path.read_text(encoding="utf-8"))
    frames = {int(k): v for k, v in gt["frames"].items()}
    h = gt["height"]
    # 先把所有框按 track 聚起来
    tracks = {}
    for f, boxes in frames.items():
        for b in boxes:
            tracks.setdefault(b["id"], []).append((f, b))

    raw = {}
    for tid, items in tracks.items():
        items.sort(key=lambda x: x[0])
        for f, b in items:
            local = [(ff, (bb["y"] + bb["h"]) / h) for ff, bb in items if abs(ff - f) <= 12]
            raw[(tid, f)] = slope(local)

    counts = {"approaching": 0, "receding": 0, "static": 0, "unknown": 0}
    for tid, items in tracks.items():
        for f, b in items:
            r = raw.get((tid, f))
            if r is None:
                b["motion"] = "unknown"
                counts["unknown"] += 1
                continue
            if r > TH:
                b["motion"] = "approaching"
            elif r < -TH:
                b["motion"] = "receding"
            else:
                b["motion"] = "static"
            counts[b["motion"]] += 1

    out = ROOT / (args.out or args.gt)
    out.write_text(json.dumps(gt, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"out": str(out), "boxes": sum(len(v) for v in frames.values()), "counts": counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
