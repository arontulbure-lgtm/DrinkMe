"""Latency + VRAM benchmark per model (real Ollama, GPU).

Usage: python eval/bench.py --models qwen3-vl:4b-instruct qwen3-vl:8b-instruct --images 8 [--recipes 3]
Writes D:\\AI\\reports\\bench-<timestamp>.json and prints a table. The first call per model (load) is reported
separately as cold start and excluded from p50/p95.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import dataclasses
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import load_settings  # noqa: E402
from app.ollama_client import OllamaClient  # noqa: E402
from app.pipeline import run_recipes, run_scan  # noqa: E402
from app.schemas import RecipeRequest, ScanRequest  # noqa: E402

RECIPE_INPUTS = [
    {"mode": "smart_bar", "language": "en", "ingredients": [{"name": "gin"}, {"name": "tonic water"}, {"name": "lime"}, {"name": "cucumber"}], "basics": ["ice", "water", "sugar", "salt"]},
    {"mode": "scan", "language": "ro", "ingredients": [{"name": "Aperol", "category": "vermouth_aperitif"}], "basics": ["ice", "water", "sugar", "salt"]},
    {"mode": "smart_bar", "language": "ro", "ingredients": [{"name": "suc de portocale"}, {"name": "sirop de zmeură"}, {"name": "apă minerală"}, {"name": "mentă"}], "basics": ["gheață", "apă", "zahăr", "sare"]},
]


def vram_used_mb() -> int | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        return int(out.strip().splitlines()[0])
    except Exception:  # noqa: BLE001
        return None


def unload(model: str, url: str) -> None:
    """Stops every loaded model so each run starts from the same idle VRAM."""
    import httpx
    try:
        loaded = httpx.get(f"{url}/api/ps", timeout=10).json().get("models", [])
        for m in loaded:
            httpx.post(f"{url}/api/generate", json={"model": m["name"], "keep_alive": 0}, timeout=60)
    except httpx.HTTPError:
        pass
    for _ in range(30):
        try:
            if not httpx.get(f"{url}/api/ps", timeout=10).json().get("models"):
                break
        except httpx.HTTPError:
            break
        time.sleep(1)
    time.sleep(2)


def pct(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


async def bench_model(model: str, images: list[Path], recipes: int, ocr: bool) -> dict:
    base = load_settings()
    settings = dataclasses.replace(base, vision_model=model, text_model=model, ocr_enabled=ocr)
    unload(model, settings.ollama_url)
    idle = vram_used_mb()
    client = OllamaClient(settings)
    scan_ms, ocr_ms, peak = [], [], idle or 0
    cold = None
    try:
        for i, path in enumerate(images):
            b64 = base64.b64encode(path.read_bytes()).decode()
            t0 = time.perf_counter()
            res = await run_scan(ScanRequest(imageBase64=b64, mimeType="image/jpeg"), client, settings)
            ms = (time.perf_counter() - t0) * 1000
            peak = max(peak, vram_used_mb() or 0)
            if i == 0:
                cold = ms
            else:
                scan_ms.append(ms)
                ocr_ms.append(res.timings.ocrMs)
        recipe_ms = []
        for spec in RECIPE_INPUTS[:recipes]:
            t0 = time.perf_counter()
            out = await run_recipes(RecipeRequest(**spec, count=4), client, settings)
            recipe_ms.append((time.perf_counter() - t0) * 1000)
            peak = max(peak, vram_used_mb() or 0)
            print(f"  recipes {spec['mode']}/{spec['language']}: {len(out.recipes)} ok, {out.dropped} dropped")
    finally:
        await client.close()
    return {
        "model": model, "ocr": ocr, "images": len(images), "coldStartMs": round(cold or 0),
        "scanP50Ms": round(pct(scan_ms, 0.5)), "scanP95Ms": round(pct(scan_ms, 0.95)),
        "ocrP50Ms": round(pct(ocr_ms, 0.5)) if ocr_ms else None,
        "recipeP50Ms": round(statistics.median(recipe_ms)) if recipe_ms else None,
        "vramIdleMb": idle, "vramPeakMb": peak, "vramModelMb": (peak - idle) if idle else None,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--dataset", default=r"D:\AI\datasets\scan-v1")
    ap.add_argument("--images", type=int, default=8)
    ap.add_argument("--recipes", type=int, default=3)
    ap.add_argument("--no-ocr", action="store_true")
    args = ap.parse_args()
    images = sorted((Path(args.dataset) / "images").glob("off_*.jpg"))[: args.images]
    results = []
    for model in args.models:
        print(f"== {model}")
        results.append(asyncio.run(bench_model(model, images, args.recipes, not args.no_ocr)))
        print(json.dumps(results[-1]))
    out = Path(r"D:\AI\reports") / f"bench-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\n{'model':28} {'cold':>7} {'p50':>7} {'p95':>7} {'ocr':>6} {'recipe':>8} {'VRAM MB':>8}")
    for r in results:
        print(f"{r['model']:28} {r['coldStartMs']:>7} {r['scanP50Ms']:>7} {r['scanP95Ms']:>7} "
              f"{str(r['ocrP50Ms']):>6} {str(r['recipeP50Ms']):>8} {str(r['vramModelMb']):>8}")
    print(f"report: {out}")


if __name__ == "__main__":
    main()
