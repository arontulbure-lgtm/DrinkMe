"""Ingredient taxonomy v1 (see .claude/skills/ingredient-taxonomy). Must equal server/ai/taxonomy.js."""
from __future__ import annotations

CATEGORIES: tuple[str, ...] = (
    "spirit", "liqueur", "wine", "sparkling_wine", "beer", "cider", "vermouth_aperitif", "bitters",
    "syrup", "juice", "soda_mixer", "energy_drink", "dairy_cream", "fresh_fruit", "herb_spice", "water",
)
ALCOHOLIC_CATEGORIES: frozenset[str] = frozenset({
    "spirit", "liqueur", "wine", "sparkling_wine", "beer", "cider", "vermouth_aperitif", "bitters",
})
# Used when the label gives no ABV, and as the floor for recipe ingredients the model under-reports.
DEFAULT_ABV: dict[str, float] = {
    "spirit": 40, "liqueur": 25, "vermouth_aperitif": 16, "wine": 12, "sparkling_wine": 12,
    "beer": 5, "cider": 5, "bitters": 40,
}
SCAN_STATUSES: tuple[str, ...] = ("recognized", "low_confidence", "water", "not_ingredient", "unclear")
FLAGS: tuple[str, ...] = ("energy_drink", "contains_caffeine")
NON_ALCOHOLIC_MAX_ABV = 0.5


def is_alcoholic(category: str | None, abv: float | None) -> bool:
    if category not in ALCOHOLIC_CATEGORIES:
        return False
    return abv is None or abv > NON_ALCOHOLIC_MAX_ABV


def flags_for(category: str | None) -> list[str]:
    return ["energy_drink", "contains_caffeine"] if category == "energy_drink" else []
