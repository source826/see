"""把导出的 fp32 ONNX 转成 fp16（输入输出仍保持 fp32），供 WebGPU 后端使用。

用法（在 D:\\guidao\\yolo-demo 下）：
  .venv\\Scripts\\python.exe tools\\convert_fp16.py
"""
from pathlib import Path

import onnx
from onnxconverter_common import float16

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "models" / "yolov8n.onnx"
DST = ROOT / "models" / "yolov8n.fp16.onnx"


def main() -> None:
    model = onnx.load(str(SRC))
    converted = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(converted, str(DST))
    print(f"fp16 onnx: {DST} ({DST.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
