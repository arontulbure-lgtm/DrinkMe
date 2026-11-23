"""Wire schemas v1 (see .claude/skills/drinkme-ai-service and recipe-schema).

Two groups:
- API models: what the Express server sends and receives. Exported to ../schemas/*.schema.json.
- Model-output models: the JSON the LLM must produce (passed to Ollama as `format`). They are looser on purpose
  (the model fills them) and are normalised into the API models.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .config import SCHEMA_VERSION

Category = Literal[
    "spirit", "liqueur", "wine", "sparkling_wine", "beer", "cider", "vermouth_aperitif", "bitters",
    "syrup", "juice", "soda_mixer", "energy_drink", "dairy_cream", "fresh_fruit", "herb_spice", "water",
]
ScanStatus = Literal["recognized", "low_confidence", "water", "not_ingredient", "unclear"]
Flag = Literal["energy_drink", "contains_caffeine"]
Language = Literal["en", "ro"]
Unit = Literal["ml", "g", "piece"]
Method = Literal["build", "stir", "shake", "blend", "muddle"]
MimeType = Literal["image/jpeg", "image/png", "image/webp"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── API: scan ────────────────────────────────────────────────────────────────
class ScanRequest(Strict):
    schemaVersion: Literal["1"] = SCHEMA_VERSION
    imageBase64: str = Field(min_length=16, max_length=10_000_000)
    mimeType: MimeType
    language: Language = "en"


class ScanItem(Strict):
    category: Category
    brand: str | None = Field(default=None, max_length=80)
    product: str | None = Field(default=None, max_length=120)
    style: str | None = Field(default=None, max_length=80)
    abv: float | None = Field(default=None, ge=0, le=100)
    volumeMl: float | None = Field(default=None, gt=0, le=10_000)
    isAlcoholic: bool
    flags: list[Flag] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)


class ScanTimings(Strict):
    ocrMs: int = 0
    visionMs: int = 0
    # Second pass with the larger model when the first was unsure (additive in v1; 0 when it did not run).
    secondPassMs: int = 0
    totalMs: int = 0


class ScanResult(Strict):
    schemaVersion: Literal["1"] = SCHEMA_VERSION
    status: ScanStatus
    item: ScanItem | None
    suggestBarcode: bool
    model: str
    timings: ScanTimings


# ── API: recipes ─────────────────────────────────────────────────────────────
class RecipeInputIngredient(Strict):
    name: str = Field(min_length=1, max_length=120)
    category: Category | None = None


class RecipeRequest(Strict):
    schemaVersion: Literal["1"] = SCHEMA_VERSION
    mode: Literal["scan", "smart_bar"]
    language: Language = "en"
    ingredients: list[RecipeInputIngredient] = Field(min_length=1, max_length=60)
    basics: list[str] = Field(default_factory=list, max_length=20)
    mocktailsOnly: bool = False
    excludeNames: list[str] = Field(default_factory=list, max_length=60)
    count: int = Field(default=4, ge=1, le=5)
    # Optional (additive in v1): the kind of drink wanted for a single-recipe request, chosen by the server.
    styleHint: str | None = Field(default=None, max_length=120)


class RecipeIngredient(Strict):
    name: str = Field(min_length=1, max_length=80)
    amount: float = Field(gt=0, le=1000)
    unit: Unit
    abv: float = Field(default=0, ge=0, le=100)
    optional: bool = False


class Recipe(Strict):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    ingredients: list[RecipeIngredient] = Field(min_length=1, max_length=12)
    steps: list[str] = Field(min_length=1, max_length=10)
    glass: str = Field(min_length=1, max_length=60)
    garnish: str | None = Field(default=None, max_length=80)
    method: Method
    estimatedAbv: float = Field(ge=0, le=100)
    standardDrinks: float = Field(ge=0)
    isAlcoholic: bool
    tags: list[str] = Field(default_factory=list, max_length=6)
    language: Language
    aiGenerated: Literal[True] = True


class RecipeTimings(Strict):
    totalMs: int = 0


class RecipeResponse(Strict):
    schemaVersion: Literal["1"] = SCHEMA_VERSION
    recipes: list[Recipe]
    dropped: int = 0
    model: str
    timings: RecipeTimings


class HealthResponse(Strict):
    status: Literal["ok", "degraded"]
    schemaVersion: Literal["1"] = SCHEMA_VERSION
    models: dict[str, str]
    ollama: bool
    modelsPresent: bool
    ocr: bool


# ── Model output (what the LLM must return) ──────────────────────────────────
class ModelScan(BaseModel):
    readable: bool = Field(description="false if the photo is too blurry/dark/partial to identify anything")
    isDrinkIngredient: bool = Field(description="true only for a drink or a food ingredient usable in a cocktail or mocktail")
    isPlainWater: bool = Field(description="true for still or unflavoured sparkling water")
    category: Category | None
    brand: str | None
    product: str | None
    style: str | None
    abv: float | None
    volumeMl: float | None
    confidence: float = Field(ge=0, le=1)


class ModelRecipeIngredient(BaseModel):
    name: str
    amount: float
    unit: Unit
    abv: float
    optional: bool = False


class ModelRecipe(BaseModel):
    name: str
    description: str
    ingredients: list[ModelRecipeIngredient]
    steps: list[str]
    glass: str
    garnish: str | None
    method: Method
    isAlcoholic: bool
    tags: list[str]


class ModelRecipes(BaseModel):
    recipes: list[ModelRecipe]


API_MODELS: dict[str, type[BaseModel]] = {
    "scan-request": ScanRequest,
    "scan-result": ScanResult,
    "recipe-request": RecipeRequest,
    "recipe": Recipe,
    "recipe-response": RecipeResponse,
    "health": HealthResponse,
}
