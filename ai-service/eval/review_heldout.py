"""Data-curator review of the Wikimedia Commons rows in D:\\AI\\datasets\\heldout-ro-v1 (2026-11-22).

Commons labels come from the search intent, so every photo was looked at (contact sheet) before evaluation.
Kept: only photos that clearly show the labelled thing and no people. Dropped rows are removed from the manifest
(the image files stay on disk, unused). Idempotent.
"""
from __future__ import annotations

import json
from pathlib import Path

MANIFEST = Path(r"D:\AI\datasets\heldout-ro-v1\manifest.jsonl")
KEEP = {
    "wm_63673711": {"brand": "Ursus"},          # Ursus bottle and glass
    "wm_20702196": {"brand": "Ursus"},          # Ursus bottle
    "wm_13065631": {"brand": "Cotnari"},        # Cotnari wine label
    "wm_64992339": {"brand": None},             # Romanian spirit bottle ("Dracula"), not a known țuică brand
    "wm_47012223": {}, "wm_164959": {},          # lemon halves, oranges
    "wm_3613567": {}, "wm_123849907": {},        # office chair, bicycles
    "wm_127824590": {}, "wm_83718308": {},       # computer mice
    "wm_147960076": {}, "wm_21253159": {},       # cats
}
# Open Food Facts rows checked blind (product names only, before any model ran on the set).
OFF_FIXES = {
    "off_8007270700731": ({"status": "not_ingredient", "category": None, "brand": None, "product": None}, None, "balsamic vinegar, not wine"),
    "off_5942016306798": ({}, ["beer", "soda_mixer"], "Ursus Cooler is an alcohol-free beer mix"),
    "off_59492689": ({}, ["juice", "soda_mixer"], "Cappy orange: juice drink"),
    "off_5949000505731": ({}, ["juice", "soda_mixer"], "Prigat orange: juice drink"),
    "off_59493242": ({}, ["juice", "soda_mixer"], "Cappy lemonade"),
    "off_5999860497080": ({}, ["energy_drink", "soda_mixer", "dairy_cream"], "Hell iced coffee"),
    "off_5941065003207": ({}, ["dairy_cream"], "sour cream 15 %"),
}
DROP_REASONS = "search hit does not show the labelled product, shows people, or is a drawing/market scene"


def main() -> None:
    rows = [json.loads(line) for line in MANIFEST.read_text(encoding="utf-8").splitlines() if line.strip()]
    kept = []
    dropped = 0
    for row in rows:
        if row["id"] in OFF_FIXES and row["source"] == "off":
            fields, accept, note = OFF_FIXES[row["id"]]
            row.setdefault("expectedOriginal", dict(row["expected"]))
            row["expected"].update(fields)
            if accept:
                row["acceptCategories"] = accept
            row["reviewNote"] = note
        if row["source"] != "commons":
            kept.append(row)
            continue
        if row["id"] not in KEEP:
            dropped += 1
            continue
        row["expected"].update(KEEP[row["id"]])
        row["review"] = False
        row["reviewNote"] = "checked on the contact sheet 2026-11-22"
        kept.append(row)
    MANIFEST.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in kept) + "\n", encoding="utf-8")
    print(f"kept {len(kept)} rows, dropped {dropped} Commons rows ({DROP_REASONS})")


if __name__ == "__main__":
    main()
