"""把全片背景目标轨迹并入事件 GT：事件目标保留原 id，其余标 bg=true。

用法：
  python tools/merge_bg_gt.py --tracks tmp/gt/tracks_nanjing_00.json \
      --event-gt gt/nanjing_00_sample.json --out gt/nanjing_00_full.json --min-hits 5
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def iou(a, b):
    x0 = max(a[0], b[0])
    y0 = max(a[1], b[1])
    x1 = min(a[2], b[2])
    y1 = min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks", required=True)
    ap.add_argument("--event-gt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-hits", type=int, default=5)
    args = ap.parse_args()

    tracks = json.loads((ROOT / args.tracks).read_text(encoding="utf-8"))
    event = json.loads((ROOT / args.event_gt).read_text(encoding="utf-8"))
    frames = {k: list(v) for k, v in event["frames"].items()}
    event_ids = {b["id"] for boxes in event["frames"].values() for b in boxes}

    # 背景轨迹始终用独立 id；如果它和某条事件 GT 框重叠，只记录 bgMap，
    # 评测时把该 background id 的报警映射到事件 id，但不让它参与事件定义。
    bg_map = {}
    next_id = 1000
    added = 0
    for tr in tracks:
        if len(tr["hits"]) < args.min_hits:
            continue
        gid = next_id
        next_id += 1
        cls = "ped" if tr["cls"] == "person" else "veh"
        for f, box, _score in tr["hits"]:
            boxes = event["frames"].get(str(f), [])
            for b in boxes:
                if iou(box, [b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]]) >= 0.3:
                    bg_map[str(gid)] = b["id"]
                    break
            x1, y1, x2, y2 = (round(v) for v in box)
            frames.setdefault(str(f), []).append({
                "id": gid,
                "cls": cls,
                "x": x1,
                "y": y1,
                "w": x2 - x1,
                "h": y2 - y1,
                "bg": True,
            })
            added += 1

    out = {
        "name": event.get("name", "clip") + "_full",
        "width": event["width"],
        "height": event["height"],
        "fps": event["fps"],
        "bgMap": bg_map,
        "frames": {k: frames[k] for k in sorted(frames, key=int)},
    }
    out_path = ROOT / args.out
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"tracks={len(tracks)} event_ids={len(event_ids)} added_boxes={added} out={out_path}")


if __name__ == "__main__":
    main()
