"""
Python/OpenCV reference for the JS face pipeline (dev-time only).

Run with the Python Paseboon venv (OpenCV 4.14.0):
  ~/Documents/projects/python/paseboon/.venv/bin/python -I scripts/parity/reference.py

For each fixture image it writes:
  test/fixtures/<name>.bgr.gz     decoded BGR pixels, gzipped (so JS skips JPEG decoding)
  test/fixtures/<name>.ref.json   YuNet rows, aligned crops (base64) and SFace embeddings
Settings match the app: score 0.8, NMS 0.3, top_k 50, input size = image size.
"""
import base64
import gzip
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "test" / "fixtures"
MODELS = ROOT / "models"

det = cv2.FaceDetectorYN.create(str(MODELS / "face_detection_yunet_2023mar.onnx"), "",
                                (320, 320), 0.8, 0.3, 50)
rec = cv2.FaceRecognizerSF.create(str(MODELS / "face_recognition_sface_2021dec.onnx"), "")


def load(name):
    """Fixture images; *_1024 / *_x2 are upscaled copies that exercise the
    JS downscale path (frames larger than the 640x640 detector input)."""
    if name == "lena_1024":
        return cv2.resize(load("lena.jpg"), (1024, 1024), interpolation=cv2.INTER_LINEAR)
    if name == "messi_x2":
        img = load("messi5.jpg")
        return cv2.resize(img, (img.shape[1] * 2, img.shape[0] * 2), interpolation=cv2.INTER_LINEAR)
    return cv2.imread(str(FIX / name), cv2.IMREAD_COLOR)


for name in sys.argv[1:] or ["lena.jpg", "messi5.jpg", "box.png", "lena_1024", "messi_x2"]:
    img = load(name)
    h, w = img.shape[:2]
    stem = Path(name).stem
    (FIX / f"{stem}.bgr.gz").write_bytes(
        gzip.compress(np.ascontiguousarray(img).tobytes(), mtime=0))
    det.setInputSize((w, h))
    _, faces = det.detect(img)
    out = {"source": name, "width": w, "height": h, "opencv": cv2.__version__, "faces": []}
    for f in ([] if faces is None else faces):
        aligned = rec.alignCrop(img, f)
        emb = rec.feature(aligned).reshape(-1)
        out["faces"].append({
            "row": [float(x) for x in f],
            "aligned_bgr_b64": base64.b64encode(np.ascontiguousarray(aligned).tobytes()).decode(),
            "embedding": [float(x) for x in emb],
        })
    (FIX / f"{stem}.ref.json").write_text(json.dumps(out))
    print(f"{name}: {w}x{h}, {len(out['faces'])} face(s)")
