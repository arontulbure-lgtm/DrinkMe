"""Runtime settings, read once from the environment. No secrets are ever logged."""
from __future__ import annotations

import os
from dataclasses import dataclass

SCHEMA_VERSION = "1"


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "on", "yes"}


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    token: str | None
    ollama_url: str
    vision_model: str
    text_model: str
    ocr_enabled: bool
    scan_min_confidence: float
    ollama_timeout_s: float
    keep_alive: str
    max_image_side: int

    @property
    def is_loopback(self) -> bool:
        return self.host in {"127.0.0.1", "localhost", "::1"}


def load_settings() -> Settings:
    ollama_host = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434")
    if not ollama_host.startswith("http"):
        ollama_host = f"http://{ollama_host}"
    vision = os.environ.get("DRINKME_VISION_MODEL", "qwen3-vl:4b-instruct")
    return Settings(
        host=os.environ.get("AI_SERVICE_HOST", "127.0.0.1"),
        port=int(os.environ.get("AI_SERVICE_PORT", "8088")),
        token=os.environ.get("AI_SERVICE_TOKEN") or None,
        ollama_url=ollama_host.rstrip("/"),
        vision_model=vision,
        text_model=os.environ.get("DRINKME_TEXT_MODEL", vision),
        ocr_enabled=_bool("DRINKME_OCR", True),
        scan_min_confidence=_float("SCAN_MIN_CONFIDENCE", 0.6),
        ollama_timeout_s=_float("OLLAMA_TIMEOUT_S", 90.0),
        keep_alive=os.environ.get("OLLAMA_KEEP_ALIVE", "30m"),
        max_image_side=int(os.environ.get("DRINKME_MAX_IMAGE_SIDE", "1024")),
    )
