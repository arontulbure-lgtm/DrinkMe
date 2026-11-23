"""Data-curator label review for D:\\AI\\datasets\\scan-v1 (run once; idempotent).

Open Food Facts category tags are product-database categories, not our taxonomy, so a few expected labels are
wrong for DrinkMe. This script corrects only rows whose source data shows the label is wrong, keeps the original in
`expectedOriginal`, and marks them `"review": true` with a reason. run_eval.py --labels reviewed uses the
corrected labels; --labels original the untouched ones. Both numbers go into docs/ai/EVAL_REPORT.md.
"""
from __future__ import annotations

import json
from pathlib import Path

MANIFEST = Path(r"D:\AI\datasets\scan-v1\manifest.jsonl")

# id → (new expected fields, reason). Only clear cases, checked against the product name / OFF page.
CORRECTIONS = {
    # en:mint holds mint candy and mint tea, which are not drink ingredients in taxonomy v1 (rule 3 and rule 5).
    "off_80050025": ({"status": "not_ingredient", "category": None}, "Tic Tac candy, not a drink ingredient"),
    "off_80780588": ({"status": "not_ingredient", "category": None}, "Mentos candy, not a drink ingredient"),
    "off_50836383": ({"status": "not_ingredient", "category": None}, "Fisherman's Friend lozenges"),
    "off_96060636": ({"status": "not_ingredient", "category": None}, "Fisherman's Friend lozenges"),
    "off_8402001019777": ({"status": "not_ingredient", "category": None}, "mint tea bags: tea is not a v1 scan category"),
    # en:strawberries holds strawberry syrups.
    "off_3092718637392": ({"category": "syrup"}, "product is 'Sirop de fraise' (strawberry syrup)"),
    "off_3330720280015": ({"category": "syrup"}, "Lucien Georgelin 'Fraise' is a fruit syrup/coulis, not fresh fruit"),
    # Aperitifs are vermouth_aperitif in taxonomy v1, whatever OFF calls them.
    "off_8002230350582": ({"category": "vermouth_aperitif"}, "Aperol is a bitter aperitif (taxonomy v1)"),
    "off_8000040001106": ({"category": "vermouth_aperitif"}, "Campari is a bitter aperitif (taxonomy v1)"),
    "off_3047100055421": ({"category": "vermouth_aperitif"}, "Suze is a gentian aperitif (taxonomy v1)"),
    # Alcohol-free cocktail mix wrongly under en:rums.
    "off_3012993035508": ({"category": "soda_mixer"}, "label says 'alkoholfreier Cocktail' (alcohol-free)"),
    # OFF 'brand' is the company or the retailer; the bottle shows another brand.
    "off_8410655000010": ({"brand": "San Miguel"}, "OFF brand is the company (Mahou S.A.)"),
    "off_0619947000020": ({"brand": "Tito's"}, "unchanged brand; model read the distillery name"),
    "off_8902080000227": ({"brand": "Sting"}, "OFF brand is the company (PepsiCo)"),
    "off_6111252422183": ({"brand": "Sting"}, "OFF brand is the company (PepsiCo)"),
    "off_8410702063043": ({"brand": "Mucho Más"}, "OFF brand is the company (Félix Solís)"),
    "off_8402001014062": ({"brand": "Hacendado"}, "OFF brand is the retailer (Mercadona); bottle says Hacendado"),
    "off_90338243": ({"brand": "Coca-Cola"}, "OFF brand is 'maroc'"),
}


def main() -> None:
    rows = [json.loads(line) for line in MANIFEST.read_text(encoding="utf-8").splitlines() if line.strip()]
    changed = 0
    for row in rows:
        fix = CORRECTIONS.get(row["id"])
        if not fix or row.get("review"):
            continue
        fields, reason = fix
        row["expectedOriginal"] = dict(row["expected"])
        row["expected"].update(fields)
        if row["expected"]["status"] == "not_ingredient":
            row["expected"].update(brand=None, product=None)
        row["review"] = True
        row["reviewNote"] = reason
        changed += 1
    MANIFEST.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    print(f"{changed} rows reviewed; {sum(1 for r in rows if r.get('review'))} rows carry review notes")


if __name__ == "__main__":
    main()
