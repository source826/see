"""下载 Ultralytics 官方 yolov8n 权重并导出 ONNX。

用法（在 D:\\guidao\\yolo-demo 下）：
  .venv\\Scripts\\python.exe tools\\export_onnx.py

YOLO('yolov8n.pt') 会从 Ultralytics 官方资源地址
(https://github.com/ultralytics/assets/releases) 下载权重，再导出静态 640 输入的 ONNX。
"""
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
MODELS.mkdir(exist_ok=True)


def main() -> None:
    model = YOLO("yolov8n.pt")  # 官方权重，自动下载到当前目录
    exported = Path(
        model.export(format="onnx", imgsz=640, opset=12, simplify=False, dynamic=False)
    )
    target = MODELS / "yolov8n.onnx"
    if exported.resolve() != target.resolve():
        target.write_bytes(exported.read_bytes())
        exported.unlink()
    weights = ROOT / "yolov8n.pt"
    if weights.exists():
        (MODELS / "yolov8n.pt").write_bytes(weights.read_bytes())
        weights.unlink()
    print(f"weights: {(MODELS / 'yolov8n.pt').resolve()}")
    print(f"onnx   : {target.resolve()} ({target.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
