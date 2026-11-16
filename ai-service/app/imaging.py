"""Image decoding and OCR. Everything stays in memory; nothing is written to disk or logged."""
from __future__ import annotations

import base64
import binascii
import io
import logging
import re
import threading
import warnings

from PIL import Image, ImageOps

log = logging.getLogger("ai-service.imaging")

MAX_DECODED_BYTES = 7 * 1024 * 1024
# Decompression-bomb guards: a small PNG can expand to gigabytes. Checked on the header, before decoding.
MAX_PIXELS = 25_000_000
MAX_SIDE = 8000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)

_SIGNATURES = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
}


class ImageInvalid(Exception):
    pass


def _matches_signature(data: bytes, mime: str) -> bool:
    if mime == "image/webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return any(data.startswith(sig) for sig in _SIGNATURES.get(mime, ()))


def decode_image(image_b64: str, mime: str, max_side: int) -> tuple[Image.Image, str]:
    """Returns (RGB image downscaled to max_side, JPEG base64 for the model)."""
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageInvalid("invalid base64") from exc
    if len(raw) > MAX_DECODED_BYTES:
        raise ImageInvalid("image too large")
    if not _matches_signature(raw, mime):
        raise ImageInvalid("type does not match content")
    try:
        img = Image.open(io.BytesIO(raw))
        width, height = img.size
        if width * height > MAX_PIXELS or max(width, height) > MAX_SIDE:
            raise ImageInvalid("image dimensions too large")
        if img.format == "JPEG":
            img.draft("RGB", (max_side, max_side))  # decode at reduced size: less memory and time
        img = ImageOps.exif_transpose(img).convert("RGB")
    except (OSError, Image.DecompressionBombError, Image.DecompressionBombWarning, ValueError) as exc:
        raise ImageInvalid("cannot decode image") from exc
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return img, base64.b64encode(buf.getvalue()).decode("ascii")


# ── OCR (RapidOCR on ONNX Runtime, CPU) ──────────────────────────────────────
_ocr_engine = None
_ocr_lock = threading.Lock()


def ocr_available() -> bool:
    try:
        _get_engine()
        return True
    except Exception:  # noqa: BLE001 - any import/model failure means "not available"
        return False


def _get_engine():
    global _ocr_engine
    with _ocr_lock:
        if _ocr_engine is None:
            from rapidocr_onnxruntime import RapidOCR  # imported lazily: ~1 s

            _ocr_engine = RapidOCR()
        return _ocr_engine


def run_ocr(img: Image.Image, min_score: float = 0.6, max_lines: int = 25) -> list[str]:
    import numpy as np

    engine = _get_engine()
    small = img.copy()
    small.thumbnail((960, 960))
    result, _ = engine(np.asarray(small))
    lines: list[str] = []
    for _box, text, score in result or []:
        text = str(text).strip()
        if text and float(score) >= min_score:
            lines.append(text)
        if len(lines) >= max_lines:
            break
    return lines


# ── Label facts from OCR text (deterministic backup for the model) ───────────
_ABV_RE = re.compile(r"(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*(?:vol|alc|abv)?", re.IGNORECASE)
_VOL_RE = re.compile(r"(?<![\d.,])(\d{1,4}(?:[.,]\d{1,3})?)\s*(ml|cl|l|ltr|litre|liter)\b", re.IGNORECASE)


def abv_from_text(lines: list[str]) -> float | None:
    for line in lines:
        if "%" not in line:
            continue
        lowered = line.lower()
        # Ignore nutrition percentages such as "10% juice" unless it says vol/alc.
        m = _ABV_RE.search(line)
        if not m:
            continue
        if any(w in lowered for w in ("vol", "alc", "abv")) or len(line) <= 8:
            value = float(m.group(1).replace(",", "."))
            if 0 <= value <= 96:
                return value
    return None


def volume_from_text(lines: list[str]) -> float | None:
    factors = {"ml": 1, "cl": 10, "l": 1000, "ltr": 1000, "litre": 1000, "liter": 1000}
    for line in lines:
        m = _VOL_RE.search(line)
        if m:
            value = float(m.group(1).replace(",", ".")) * factors[m.group(2).lower()]
            if 20 <= value <= 5000:
                return round(value)
    return None
