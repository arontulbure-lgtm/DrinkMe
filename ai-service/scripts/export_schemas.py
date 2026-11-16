"""Writes ai-service/schemas/*.schema.json from the pydantic models. --check fails if they are out of date."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.schemas import API_MODELS  # noqa: E402


def render(model) -> str:
    return json.dumps(model.model_json_schema(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    check = "--check" in sys.argv
    out = ROOT / "schemas"
    out.mkdir(exist_ok=True)
    stale = []
    for name, model in API_MODELS.items():
        path = out / f"{name}.schema.json"
        text = render(model)
        if check:
            # A Windows checkout (core.autocrlf) has CRLF; compare the content, not the line endings.
            if not path.exists() or path.read_text(encoding="utf-8").replace("\r\n", "\n") != text:
                stale.append(path.name)
        else:
            path.write_text(text, encoding="utf-8", newline="\n")
    if stale:
        print("Out of date:", ", ".join(stale), "- run python ai-service/scripts/export_schemas.py")
        return 1
    print("schemas ok" if check else f"wrote {len(API_MODELS)} schemas to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
