"""Scan and recipe pipelines: model call → normalise → validate against the API schema."""
from __future__ import annotations

import asyncio
import logging
import re
import time
import unicodedata
from typing import Any

from pydantic import ValidationError

from . import imaging, prompts
from .config import Settings
from .ollama_client import ModelInvalidOutput, OllamaClient
from .schemas import (
    ModelRecipes, ModelScan, Recipe, RecipeRequest, RecipeResponse, RecipeTimings, ScanItem, ScanRequest,
    ScanResult, ScanTimings,
)
from .taxonomy import CATEGORIES, DEFAULT_ABV, flags_for, is_alcoholic

log = logging.getLogger("ai-service.pipeline")

_SCAN_SCHEMA = ModelScan.model_json_schema()
_RECIPES_SCHEMA = ModelRecipes.model_json_schema()
ETHANOL_G_PER_ML = 0.789
GRAMS_PER_STANDARD_DRINK = 10.0


def _clean(value: Any, max_len: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = unicodedata.normalize("NFC", value)
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    text = re.sub(r"\s+", " ", text).strip()
    if not text or text.lower() in {"null", "none", "unknown", "n/a"}:
        return None
    return text[:max_len]


def _num(value: Any, lo: float, hi: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if lo <= value <= hi else None


# ── Scan ─────────────────────────────────────────────────────────────────────
def build_scan_result(raw: dict[str, Any], ocr_lines: list[str], settings: Settings, model: str,
                      timings: ScanTimings) -> ScanResult:
    try:
        parsed = ModelScan.model_validate(raw)
    except ValidationError as exc:
        raise ModelInvalidOutput() from exc

    def result(status: str, item: ScanItem | None, suggest: bool) -> ScanResult:
        return ScanResult(status=status, item=item, suggestBarcode=suggest, model=model, timings=timings)

    confidence = max(0.0, min(1.0, parsed.confidence))
    if not parsed.readable and not parsed.isDrinkIngredient:
        return result("unclear", None, True)
    if not parsed.isDrinkIngredient:
        return result("not_ingredient", None, False)
    category = parsed.category if parsed.category in CATEGORIES else None
    if parsed.isPlainWater and category in (None, "water"):
        category = "water"
    if category is None:
        return result("unclear", None, True)

    abv = _num(parsed.abv, 0, 96)
    ocr_abv = imaging.abv_from_text(ocr_lines)
    if ocr_abv is not None and (abv is None or abs(abv - ocr_abv) > 1.5):
        abv = ocr_abv  # the printed number wins over the model's reading
    volume = _num(parsed.volumeMl, 1, 10_000) or imaging.volume_from_text(ocr_lines)

    item = ScanItem(
        category=category,
        brand=_clean(parsed.brand, 80),
        product=_clean(parsed.product, 120),
        style=_clean(parsed.style, 80),
        abv=abv,
        volumeMl=volume,
        isAlcoholic=is_alcoholic(category, abv),
        flags=flags_for(category),
        confidence=round(confidence, 3),
    )
    if category == "water":
        return result("water", item, False)
    if not parsed.readable or confidence < settings.scan_min_confidence:
        return result("low_confidence", item, True)
    return result("recognized", item, False)


async def run_scan(req: ScanRequest, client: OllamaClient, settings: Settings) -> ScanResult:
    started = time.perf_counter()
    # Off the event loop: a large decode must not block health checks and other requests.
    img, model_b64 = await asyncio.to_thread(imaging.decode_image, req.imageBase64, req.mimeType, settings.max_image_side)
    ocr_lines: list[str] = []
    ocr_ms = 0
    if settings.ocr_enabled:
        t0 = time.perf_counter()
        try:
            ocr_lines = await asyncio.to_thread(imaging.run_ocr, img)
        except Exception as exc:  # noqa: BLE001 - OCR is a hint; the model still runs
            log.warning("ocr failed: %s", type(exc).__name__)
        ocr_ms = int((time.perf_counter() - t0) * 1000)
    del img
    t1 = time.perf_counter()
    raw = await client.chat_json(
        settings.vision_model, prompts.SCAN_SYSTEM, prompts.scan_user_message(ocr_lines), _SCAN_SCHEMA,
        images=[model_b64], temperature=0.1, num_predict=256,
    )
    vision_ms = int((time.perf_counter() - t1) * 1000)
    timings = ScanTimings(ocrMs=ocr_ms, visionMs=vision_ms, totalMs=int((time.perf_counter() - started) * 1000))
    return build_scan_result(raw, ocr_lines, settings, settings.vision_model, timings)


# ── Recipes ──────────────────────────────────────────────────────────────────
_ALCOHOL_HINTS = {
    "spirit": ("vodka", "gin", "rum", "whisky", "whiskey", "bourbon", "tequila", "mezcal", "brandy", "cognac",
               "tuica", "palinca", "rachiu", "votca", "vodca", "rom", "coniac", "pisco", "cachaca"),
    "liqueur": ("liqueur", "lichior", "amaretto", "triple sec", "cointreau", "kahlua", "baileys", "limoncello"),
    "vermouth_aperitif": ("vermouth", "vermut", "aperol", "campari", "aperitif"),
    "sparkling_wine": ("prosecco", "champagne", "cava", "spumant", "sampanie"),
    "wine": ("wine", "vin "),
    "beer": ("beer", "bere", "lager", "ipa", "stout"),
    "cider": ("cider", "cidru"),
    "bitters": ("bitters",),
}


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def abv_floor(name: str) -> float:
    folded = f" {_fold(name)} "
    if any(w in folded for w in ("non-alcoholic", "alcohol-free", "fara alcool", "0.0", "zero")):
        return 0.0
    if "ginger beer" in folded or "root beer" in folded or "bere de ghimbir" in folded:
        return 0.0
    for category, words in _ALCOHOL_HINTS.items():
        if any(re.search(rf"(?<![a-z]){re.escape(w.strip())}(?![a-z])", folded) for w in words):
            return DEFAULT_ABV[category]
    return 0.0


def compute_strength(ingredients: list[dict[str, Any]]) -> tuple[float, float]:
    """Returns (estimatedAbv %, standardDrinks) from ml ingredients; ice and solids are ignored."""
    total_ml = 0.0
    ethanol_ml = 0.0
    for ing in ingredients:
        if ing["unit"] != "ml":
            continue
        total_ml += ing["amount"]
        ethanol_ml += ing["amount"] * ing["abv"] / 100
    if total_ml <= 0:
        return 0.0, 0.0
    return round(ethanol_ml / total_ml * 100, 1), round(ethanol_ml * ETHANOL_G_PER_ML / GRAMS_PER_STANDARD_DRINK, 2)


def normalise_recipe(raw: dict[str, Any], language: str) -> Recipe | None:
    ingredients = []
    for ing in raw.get("ingredients", [])[:12]:
        name = _clean(ing.get("name"), 80)
        amount = _num(ing.get("amount"), 0.01, 1000)
        unit = ing.get("unit")
        if not name or amount is None or unit not in ("ml", "g", "piece"):
            return None
        abv = _num(ing.get("abv"), 0, 100) or 0.0
        abv = max(abv, abv_floor(name))
        ingredients.append({"name": name, "amount": round(amount, 1), "unit": unit, "abv": abv,
                            "optional": bool(ing.get("optional", False))})
    estimated_abv, standard_drinks = compute_strength(ingredients)
    steps = [s for s in (_clean(step, 300) for step in raw.get("steps", [])[:10]) if s]
    tags = [t for t in (_clean(tag, 30) for tag in raw.get("tags", [])[:6]) if t]
    try:
        return Recipe(
            name=_clean(raw.get("name"), 80) or "",
            description=_clean(raw.get("description"), 300) or "",
            ingredients=ingredients,
            steps=steps,
            glass=_clean(raw.get("glass"), 60) or "",
            garnish=_clean(raw.get("garnish"), 80),
            method=raw.get("method"),
            estimatedAbv=estimated_abv,
            standardDrinks=standard_drinks,
            isAlcoholic=standard_drinks > 0,
            tags=tags,
            language=language,
        )
    except ValidationError:
        return None


async def run_recipes(req: RecipeRequest, client: OllamaClient, settings: Settings) -> RecipeResponse:
    started = time.perf_counter()
    names = [i.name for i in req.ingredients]
    system = prompts.recipe_system(req.language, req.mode, req.basics, req.mocktailsOnly, req.count)
    user = prompts.recipe_user_message(req.mode, names, req.excludeNames, req.count, req.basics)
    raw = await client.chat_json(
        settings.text_model, system, user, _RECIPES_SCHEMA, temperature=0.7, num_predict=2600, num_ctx=6144,
    )
    try:
        parsed = ModelRecipes.model_validate(raw)
    except ValidationError as exc:
        raise ModelInvalidOutput() from exc
    recipes: list[Recipe] = []
    dropped = 0
    seen = {_fold(n) for n in req.excludeNames}
    for model_recipe in parsed.recipes:
        recipe = normalise_recipe(model_recipe.model_dump(), req.language)
        if recipe is None or _fold(recipe.name) in seen or (req.mocktailsOnly and recipe.isAlcoholic):
            dropped += 1
            continue
        seen.add(_fold(recipe.name))
        recipes.append(recipe)
    return RecipeResponse(
        recipes=recipes[: req.count], dropped=dropped, model=settings.text_model,
        timings=RecipeTimings(totalMs=int((time.perf_counter() - started) * 1000)),
    )
