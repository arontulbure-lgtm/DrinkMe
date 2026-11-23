import subprocess
import sys
from pathlib import Path

from app.schemas import Category
from app.taxonomy import CATEGORIES

ROOT = Path(__file__).resolve().parents[1]


def test_taxonomy_matches_schema_enum():
    assert tuple(Category.__args__) == CATEGORIES


def test_exported_schemas_are_current():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "export_schemas.py"), "--check"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout
