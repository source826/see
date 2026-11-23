"""按 20 样本人工审计结果修正 GT 三态，并把隧道 id2 的 ID 切换拆成两条轨迹。

修正范围（只改审计明确指出的问题，不动其他轨迹）：
- narrow_street id1 f335-435：static -> approaching（远处慢速迎面）
- narrow_hutong id1 f161-231：static -> approaching（远处慢速迎面）
- tunnel id1 f25-50：static -> approaching（远处慢速迎面）
- tunnel id2：f130 起 x 从 408 跳到 533，拆成 id2（<=125）和 id4（>=130）；
  id4 的标签按脚点 ±12 帧斜率重新生成，f265 因再次跳变保持 unknown。

用法：python tools/fix_gt_motion_audit.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TH = 0.0008
FIXES = [
    ("gt/narrow_street_approach_full.json", 1, 335, 435, "static", "approaching"),
    ("gt/narrow_hutong_approach_full.json", 1, 161, 231, "static", "approaching"),
    ("gt/tunnel_backlight_full.json", 1, 25, 50, "static", "approaching"),
]


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


def motion_of(r):
    if r is None:
        return "unknown"
    if r > TH:
        return "approaching"
    if r < -TH:
        return "receding"
    return "static"


def relabel_track(gt, tid, frames):
    h = gt["height"]
    items = sorted(
        (f, b)
        for f in frames
        for b in gt["frames"].get(str(f), [])
        if b.get("id") == tid
    )
    changed = 0
    for f, b in items:
        if f not in frames:
            continue
        local = [(ff, (bb["y"] + bb["h"]) / h) for ff, bb in items if abs(ff - f) <= 12]
        new = motion_of(slope(local))
        if b.get("motion") != new:
            b["motion"] = new
            changed += 1
    return changed


def main():
    cache = {}
    fix_log = []
    for path, tid, start, end, old, new in FIXES:
        gt = cache.setdefault(path, json.loads((ROOT / path).read_text(encoding="utf-8")))
        changed = 0
        for f in range(start, end + 1):
            for b in gt["frames"].get(str(f), []):
                if b.get("id") == tid and b.get("motion") == old:
                    b["motion"] = new
                    changed += 1
        fix_log.append({"file": path, "trackId": tid, "from": start, "to": end, "old": old, "new": new})
        print(f"{path} id{tid} f{start}-{end} {old}->{new}: {changed} boxes")

    # 隧道 id2 拆分：f130 起归到 id4。背景重复轨迹 1019 同源，也一起拆成 1049，
    # 否则 bgMap 仍把后半段的人映射到只剩 2 帧的 id2。
    path = "gt/tunnel_backlight_full.json"
    gt = cache.setdefault(path, json.loads((ROOT / path).read_text(encoding="utf-8")))
    split = 0
    bg_split = 0
    for f in sorted(int(k) for k in gt["frames"]):
        if f < 130:
            continue
        for b in gt["frames"].get(str(f), []):
            if b.get("id") == 2:
                b["id"] = 4
                split += 1
            elif b.get("id") == 1019:
                b["id"] = 1049
                bg_split += 1
    gt.setdefault("bgMap", {})["1049"] = 4
    if "1023" in gt["bgMap"]:
        gt["bgMap"]["1023"] = 4
    print(f"{path} id2 -> id4 from f130: {split} boxes; bg1019 -> bg1049: {bg_split} boxes")

    # 拆分后按各自轨迹重算标签；id4 / bg1049 末尾 f265 再次跳变，保持 unknown。
    changed2 = relabel_track(gt, 2, {120, 125})
    changed4 = relabel_track(gt, 4, set(range(130, 256, 5)))
    changed1019 = relabel_track(gt, 1019, {120, 125})
    changed1049 = relabel_track(gt, 1049, set(range(130, 256, 5)))
    print(
        f"{path} relabel id2: {changed2}; id4: {changed4}; "
        f"bg1019: {changed1019}; bg1049: {changed1049}"
    )

    gt["motionAuditFix"] = {
        "source": "eval/gt_motion_audit_20261123.json",
        "note": "按 20 样本人工审计修正 4 个错标，并拆分隧道 id2 的 ID 切换；同源背景轨迹 1019 一起拆成 1049，bgMap 的 1023 改指 id4；f265 因再次跳变保持 unknown。",
        "fixes": fix_log
        + [
            {"file": path, "trackId": 2, "splitAt": 130, "newTrackId": 4},
            {"file": path, "trackId": 1019, "splitAt": 130, "newTrackId": 1049},
            {"file": path, "bgMap": {"1023": 4, "1049": 4}},
        ],
    }

    for path, gt in cache.items():
        with open(ROOT / path, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(gt, ensure_ascii=False, indent=1) + "\n")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
