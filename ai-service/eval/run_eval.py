"""AI evaluation (scan + recipes + red team) against the real local model. See the ai-evaluator agent.

Usage (venv python, from the repo root):
  python ai-service/eval/run_eval.py scan     [--ocr on|off|both] [--limit N]
  python ai-service/eval/run_eval.py recipes  [--limit N]
  python ai-service/eval/run_eval.py redteam
Raw results go to D:\\AI\\reports\\eval-<timestamp>\\. Recipe outputs are then checked by the SERVER's validator:
  node ai-service/eval/validate_recipes.mjs <report dir>
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import dataclasses
import json
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import load_settings  # noqa: E402
from app.ollama_client import ModelInvalidOutput, ModelTimeout, ModelUnavailable, OllamaClient  # noqa: E402
from app.pipeline import run_recipes, run_scan  # noqa: E402
from app.schemas import RecipeRequest, ScanRequest  # noqa: E402

DATASET = Path(r"D:\AI\datasets\scan-v1")
REPORTS = Path(r"D:\AI\reports")
BASICS = {"en": ["ice", "water", "sugar", "salt"], "ro": ["gheață", "apă", "zahăr", "sare"]}
# Categories that are easily confused and both acceptable for the expected OFF category.
CATEGORY_ALIASES = {"vermouth_aperitif": {"vermouth_aperitif", "bitters", "liqueur"}, "liqueur": {"liqueur", "spirit"},
                    "sparkling_wine": {"sparkling_wine", "wine"}, "cider": {"cider", "beer"}}


def fold(text: str | None) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def tokens(text: str | None) -> set[str]:
    return {t for t in fold(text).split() if len(t) >= 3}


def squash(text: str | None) -> str:
    return fold(text).replace(" ", "")


def brand_matches(exp_brand: str | None, exp_product: str | None, item: dict) -> bool:
    """Same brand, ignoring case, accents, spaces and punctuation ('SanMiguel' = 'San Miguel'); or the brand the
    model read is part of the expected product name ('Sting' in 'Sting Energy')."""
    predicted = " ".join(filter(None, [item.get("brand"), item.get("product"), item.get("style")]))
    exp_tokens = tokens(exp_brand)
    if exp_tokens and exp_tokens & tokens(predicted):
        return True
    if exp_brand and len(squash(exp_brand)) >= 3 and squash(exp_brand) in squash(predicted):
        return True
    pred_brand = squash(item.get("brand"))
    return len(pred_brand) >= 4 and pred_brand in squash(f"{exp_brand or ''} {exp_product or ''}")


def vram_mb() -> int | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        return int(out.strip().splitlines()[0])
    except Exception:  # noqa: BLE001
        return None


def score_scan(row: dict, res: dict | None, labels: str = "reviewed") -> dict:
    exp = row.get("expectedOriginal", row["expected"]) if labels == "original" else row["expected"]
    out = {"id": row["id"], "expectedStatus": exp["status"], "expectedCategory": exp["category"]}
    if res is None:
        return {**out, "error": True}
    item = res.get("item") or {}
    status = res["status"]
    out.update(status=status, category=item.get("category"), brand=item.get("brand"), product=item.get("product"),
               suggestBarcode=res["suggestBarcode"], ms=res["timings"]["totalMs"],
               secondPassMs=res["timings"].get("secondPassMs", 0))
    if exp["status"] == "not_ingredient":
        out["correct"] = status in ("not_ingredient", "unclear")
        return out
    if exp["status"] == "unclear":
        out["correct"] = status in ("unclear", "low_confidence") or res["suggestBarcode"]
        return out
    if exp["status"] == "water":
        out["correct"] = status == "water"
        out["categoryOk"] = item.get("category") == "water"
        return out
    allowed = set(row.get("acceptCategories") or []) | CATEGORY_ALIASES.get(exp["category"], {exp["category"]})
    out["categoryOk"] = item.get("category") in allowed
    packaged = exp["category"] not in ("fresh_fruit", "herb_spice")
    predicted_text = " ".join(filter(None, [item.get("brand"), item.get("product"), item.get("style")]))
    brand_tokens = tokens(exp.get("brand"))
    out["brandOk"] = (not packaged) or brand_matches(exp.get("brand"), exp.get("product"), item)
    product_tokens = tokens(exp.get("product")) - brand_tokens
    out["productOk"] = (not packaged) or (not product_tokens) or \
        len(product_tokens & tokens(predicted_text)) / len(product_tokens) >= 0.5
    out["correct"] = status in ("recognized", "low_confidence") and out["categoryOk"] and out["brandOk"]
    return out


async def eval_scan(out_dir: Path, ocr: bool, limit: int | None) -> dict:
    rows = [json.loads(line) for line in (DATASET / "manifest.jsonl").read_text(encoding="utf-8").splitlines() if line]
    rows = rows[:limit] if limit else rows
    settings = dataclasses.replace(load_settings(), ocr_enabled=ocr, max_image_side=768, ollama_timeout_s=180,
                                   second_pass_model=SECOND_PASS or None, second_pass_budget_s=SECOND_PASS_BUDGET)
    client = OllamaClient(settings)
    results, peak = [], vram_mb() or 0
    try:
        for i, row in enumerate(rows):
            b64 = base64.b64encode((DATASET / row["file"]).read_bytes()).decode()
            try:
                res = (await run_scan(ScanRequest(imageBase64=b64, mimeType="image/jpeg"), client, settings)).model_dump()
            except (ModelInvalidOutput, ModelTimeout, ModelUnavailable) as exc:
                print(f"  {row['id']}: {type(exc).__name__}")
                res = None
            scored = score_scan(row, res)
            scored["warm"] = i > 0
            results.append(scored)
            if i % 10 == 0:
                peak = max(peak, vram_mb() or 0)
                print(f"  [{'ocr' if ocr else 'no-ocr'}] {i + 1}/{len(rows)}", flush=True)
    finally:
        await client.close()
    path = out_dir / f"scan-{'ocr' if ocr else 'noocr'}{'-2pass' if SECOND_PASS else ''}.jsonl"
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n", encoding="utf-8")
    summary = summarise_scan(results)
    summary.update(ocr=ocr, model=settings.vision_model, secondPass=SECOND_PASS or None, vramPeakMb=peak,
                   secondPassUsed=sum(1 for r in results if r.get("secondPassMs")))
    return summary


def pct(n: int, d: int) -> dict:
    return {"n": n, "of": d, "pct": round(100 * n / d, 1) if d else None}


def summarise_scan(results: list[dict]) -> dict:
    rec = [r for r in results if r["expectedStatus"] == "recognized" and not r.get("error")]
    neg = [r for r in results if r["expectedStatus"] == "not_ingredient"]
    blur = [r for r in results if r["expectedStatus"] == "unclear"]
    water = [r for r in results if r["expectedStatus"] == "water"]
    warm_ms = sorted(r["ms"] for r in results if r.get("warm") and "ms" in r)
    q = lambda p: warm_ms[min(len(warm_ms) - 1, int(round(p * (len(warm_ms) - 1))))] if warm_ms else None  # noqa: E731
    return {
        "total": len(results),
        "errors": sum(1 for r in results if r.get("error")),
        "recognisableCorrect": pct(sum(r["correct"] for r in rec), len(rec)),
        "categoryAccuracy": pct(sum(r["categoryOk"] for r in rec), len(rec)),
        "brandAccuracy": pct(sum(r["brandOk"] for r in rec), len(rec)),
        "productAccuracy": pct(sum(r["productOk"] for r in rec), len(rec)),
        "barcodeFallbackRate": pct(sum(bool(r.get("suggestBarcode")) for r in rec), len(rec)),
        "negativesRefused": pct(sum(r["correct"] for r in neg), len(neg)),
        "blurryFlagged": pct(sum(r["correct"] for r in blur), len(blur)),
        "waterRecognised": pct(sum(r["correct"] for r in water), len(water)),
        "latencyMs": {"p50": q(0.5), "p95": q(0.95), "max": warm_ms[-1] if warm_ms else None},
    }


# ── Recipes ──────────────────────────────────────────────────────────────────
BAR_SETS = [
    ["Bombay Sapphire gin", "Schweppes tonic", "lime", "cucumber"],
    ["vodka", "cranberry juice", "orange juice", "lime"],
    ["white rum", "mint", "lime", "soda water", "brown sugar"],
    ["Aperol", "prosecco", "soda water", "orange"],
    ["bourbon", "angostura bitters", "orange", "honey"],
    ["tequila", "grapefruit soda", "lime", "jalapeño"],
    ["Campari", "sweet vermouth", "gin", "orange"],
    ["Ursus beer", "lemonade", "lemon"],
    ["apple juice", "ginger beer", "cinnamon", "lemon"],
    ["orange juice", "pineapple juice", "grenadine", "soda water"],
    ["milk", "espresso", "vanilla syrup", "cocoa powder"],
    ["coconut milk", "pineapple juice", "lime"],
    ["țuică de prune", "suc de mere", "scorțișoară", "lămâie"],
    ["vin roșu", "portocală", "scorțișoară", "miere"],
    ["sirop de soc", "apă minerală", "lămâie", "mentă"],
    ["Prosecco", "elderflower syrup", "mint"],
    ["dark rum", "cola", "lime"],
    ["gin", "elderflower cordial", "cucumber", "tonic water"],
    ["red bull", "vodka", "lime"],
    ["egg white", "lemon juice", "whisky", "sugar syrup"],
    ["water"],
    ["strawberries", "basil", "lemon", "soda water"],
    ["cider", "apple", "cinnamon"],
    ["cold brew coffee", "tonic water", "orange"],
    ["kombucha", "ginger", "lime", "mint"],
]
SCAN_ITEMS = [
    ("Tanqueray London Dry Gin", "spirit"), ("Aperol", "vermouth_aperitif"), ("Jameson Irish Whiskey", "spirit"),
    ("Baileys Original", "liqueur"), ("Ursus Premium", "beer"), ("Schweppes Tonic Water", "soda_mixer"),
    ("Cappy portocale", "juice"), ("Monin sirop de vanilie", "syrup"), ("Red Bull", "energy_drink"),
    ("Prosecco Martini", "sparkling_wine"), ("Cotnari Grasă", "wine"), ("Strongbow Cider", "cider"),
    ("lime", "fresh_fruit"), ("mentă proaspătă", "herb_spice"), ("Zuzu lapte", "dairy_cream"),
    ("Angostura aromatic bitters", "bitters"), ("Martini Rosso", "vermouth_aperitif"), ("Havana Club 3", "spirit"),
    ("Coca-Cola", "soda_mixer"), ("Pălincă de pere", "spirit"), ("Fever-Tree Ginger Beer", "soda_mixer"),
    ("Kahlúa", "liqueur"), ("Heineken 0.0", "beer"), ("Borsec apă minerală aromată cu lămâie", "soda_mixer"),
    ("Absolut Vodka", "spirit"),
]


def recipe_inputs(limit: int | None) -> list[dict]:
    items = []
    for i, bar in enumerate(BAR_SETS):
        lang = "ro" if any(ord(c) > 127 for c in "".join(bar)) or i % 3 == 0 else "en"
        items.append({"id": f"bar-{i:02d}", "mode": "smart_bar", "language": lang,
                      "ingredients": [{"name": n} for n in bar], "basics": BASICS[lang]})
    for i, (name, category) in enumerate(SCAN_ITEMS):
        lang = "ro" if i % 2 else "en"
        items.append({"id": f"scan-{i:02d}", "mode": "scan", "language": lang,
                      "ingredients": [{"name": name, "category": category}], "basics": BASICS[lang]})
    return items[:limit] if limit else items


async def ask(client, settings, spec: dict, exclude: list[str], mocktails_only=False) -> dict:
    req = RecipeRequest(mode=spec["mode"], language=spec["language"], ingredients=spec["ingredients"],
                        basics=spec["basics"], excludeNames=exclude, count=4, mocktailsOnly=mocktails_only)
    t0 = time.perf_counter()
    try:
        # Raw model output is kept too: the server validator must see what it would drop.
        res = await run_recipes(req, client, settings)
        return {"ok": True, "ms": int((time.perf_counter() - t0) * 1000), "recipes": [r.model_dump() for r in res.recipes],
                "droppedByService": res.dropped}
    except (ModelInvalidOutput, ModelTimeout, ModelUnavailable) as exc:
        return {"ok": False, "error": type(exc).__name__, "ms": int((time.perf_counter() - t0) * 1000), "recipes": []}


async def eval_recipes(out_dir: Path, limit: int | None) -> None:
    settings = dataclasses.replace(load_settings(), ollama_timeout_s=240)
    client = OllamaClient(settings)
    lines = []
    try:
        for i, spec in enumerate(recipe_inputs(limit)):
            first = await ask(client, settings, spec, [])
            second = await ask(client, settings, spec, [r["name"] for r in first["recipes"]])
            lines.append({**spec, "batches": [first, second]})
            print(f"  recipes {i + 1}: {spec['id']} {len(first['recipes'])}+{len(second['recipes'])} "
                  f"({first['ms']}+{second['ms']} ms)", flush=True)
            (out_dir / "recipes.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", encoding="utf-8")
    finally:
        await client.close()


async def eval_redteam(out_dir: Path) -> None:
    settings = dataclasses.replace(load_settings(), ollama_timeout_s=240)
    client = OllamaClient(settings)
    cases = [json.loads(line) for line in (Path(__file__).parent / "redteam.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    lines = []
    try:
        for case in cases:
            spec = {"mode": case["mode"], "language": case["language"], "ingredients": [{"name": n} for n in case["ingredients"]],
                    "basics": BASICS[case["language"]]}
            res = await ask(client, settings, spec, [], case.get("mocktailsOnly", False))
            lines.append({**case, **spec, "batches": [res]})
            print(f"  redteam {case['id']}: {len(res['recipes'])} recipes", flush=True)
    finally:
        await client.close()
    (out_dir / "redteam.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", encoding="utf-8")


def rescore(out_dir: Path, labels: str) -> list[dict]:
    """Re-scores saved predictions (scan-*.jsonl) against the manifest, without the model."""
    rows = {r["id"]: r for r in (json.loads(line) for line in (DATASET / "manifest.jsonl").read_text(encoding="utf-8").splitlines() if line)}
    summaries = []
    for name in ("scan-ocr.jsonl", "scan-noocr.jsonl"):
        path = out_dir / name
        if not path.exists():
            continue
        saved = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
        results = []
        for s in saved:
            res = None if s.get("error") else {
                "status": s["status"], "suggestBarcode": s["suggestBarcode"], "timings": {"totalMs": s["ms"]},
                "item": {"category": s.get("category"), "brand": s.get("brand"), "product": s.get("product")} if s.get("category") else None,
            }
            scored = score_scan(rows[s["id"]], res, labels)
            scored["warm"] = s.get("warm", True)
            results.append(scored)
        summary = summarise_scan(results)
        summary.update(ocr=name == "scan-ocr.jsonl", labels=labels)
        summaries.append(summary)
    (out_dir / f"scan-summary-{labels}.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
    return summaries


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["scan", "recipes", "redteam", "rescore"])
    ap.add_argument("--labels", choices=["original", "reviewed"], default="reviewed")
    ap.add_argument("--ocr", choices=["on", "off", "both"], default="on")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--out")
    ap.add_argument("--dataset", help="dataset folder with manifest.jsonl (default scan-v1)")
    ap.add_argument("--second-pass", default="", help="Ollama tag of the second-pass model (default: none)")
    ap.add_argument("--second-pass-budget", type=float, default=60.0, help="seconds; eval default is generous to measure the 8B itself")
    args = ap.parse_args()
    global DATASET, SECOND_PASS, SECOND_PASS_BUDGET
    if args.dataset:
        DATASET = Path(args.dataset)
    SECOND_PASS = args.second_pass
    SECOND_PASS_BUDGET = args.second_pass_budget
    out_dir = Path(args.out) if args.out else REPORTS / f"eval-{time.strftime('%Y%m%d-%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.what == "rescore":
        for labels in ("original", "reviewed"):
            for s in rescore(out_dir, labels):
                print(json.dumps({k: v for k, v in s.items() if k != "latencyMs"}))
    elif args.what == "scan":
        summaries = []
        for ocr in ([True, False] if args.ocr == "both" else [args.ocr == "on"]):
            summaries.append(asyncio.run(eval_scan(out_dir, ocr, args.limit)))
            print(json.dumps(summaries[-1], indent=2))
        (out_dir / "scan-summary.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
    elif args.what == "recipes":
        asyncio.run(eval_recipes(out_dir, args.limit))
    else:
        asyncio.run(eval_redteam(out_dir))
    print(f"report dir: {out_dir}")


if __name__ == "__main__":
    main()
