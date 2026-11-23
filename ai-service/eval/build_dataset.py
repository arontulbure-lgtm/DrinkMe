"""Builds the scan test set in D:\\AI\\datasets\\scan-v1 (never in git).

Sources (openly licensed only):
- Open Food Facts front images (CC BY-SA 3.0); expected labels come from the OFF product data, not from a model.
- Open Products Facts / Open Beauty Facts (same licence) for negatives: medicines, detergents, cosmetics, phones.
- Derived "blurry" images: heavy Gaussian blur of OFF images (same CC BY-SA licence, marked derived).
- Wikimedia Commons (free licences only) is supported but OFF by default: its robot policy requires a User-Agent
  with personal contact details, which this project does not send without John's OK (--commons to enable).

Usage: python -I eval/build_dataset.py [--out D:\\AI\\datasets\\scan-v1] [--per-category 6]
Re-running resumes: downloaded product rows are kept, derived rows are rebuilt.
"""
from __future__ import annotations

import argparse
import io
import json
import random
import time
from pathlib import Path

import httpx
from PIL import Image, ImageFilter

UA = "DrinkMeEval/0.1 (open dataset builder)"
OFF = "world.openfoodfacts.org"
OPF = "world.openproductsfacts.org"
OBF = "world.openbeautyfacts.org"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
FREE_LICENCES = ("cc0", "public domain", "pd", "cc by", "cc-by")

# (host, category tag, expected status, expected category, country filter)
OFF_CATEGORIES = [
    (OFF, "en:gins", "recognized", "spirit", None), (OFF, "en:vodkas", "recognized", "spirit", None),
    (OFF, "en:rums", "recognized", "spirit", None), (OFF, "en:whiskies", "recognized", "spirit", None),
    (OFF, "en:liqueurs", "recognized", "liqueur", None), (OFF, "en:red-wines", "recognized", "wine", None),
    (OFF, "en:white-wines", "recognized", "wine", None),
    (OFF, "en:sparkling-wines", "recognized", "sparkling_wine", None),
    (OFF, "en:beers", "recognized", "beer", "en:romania"), (OFF, "en:lagers", "recognized", "beer", None),
    (OFF, "en:ciders", "recognized", "cider", None), (OFF, "en:vermouths", "recognized", "vermouth_aperitif", None),
    (OFF, "en:bitters", "recognized", "vermouth_aperitif", None), (OFF, "en:syrups", "recognized", "syrup", None),
    (OFF, "en:orange-juices", "recognized", "juice", None),
    (OFF, "en:tonic-water", "recognized", "soda_mixer", None), (OFF, "en:colas", "recognized", "soda_mixer", None),
    (OFF, "en:energy-drinks", "recognized", "energy_drink", None),
    (OFF, "en:milks", "recognized", "dairy_cream", None), (OFF, "en:mineral-waters", "water", "water", None),
    (OFF, "en:lemons", "recognized", "fresh_fruit", None), (OFF, "en:limes", "recognized", "fresh_fruit", None),
    (OFF, "en:strawberries", "recognized", "fresh_fruit", None), (OFF, "en:mint", "recognized", "herb_spice", None),
    (OPF, "en:medicines", "not_ingredient", None, None),
    (OFF, "en:dietary-supplements", "not_ingredient", None, None),
    (OPF, "en:laundry-detergents", "not_ingredient", None, None),
    (OBF, "en:shampoos", "not_ingredient", None, None), (OBF, "en:toothpastes", "not_ingredient", None, None),
    (OPF, "en:smartphones", "not_ingredient", None, None),
]
# (search, expected status, expected category) - only with --commons
COMMONS_QUERIES = [
    ("lime fruit", "recognized", "fresh_fruit"), ("mint leaves", "recognized", "herb_spice"),
    ("office chair", "not_ingredient", None), ("bicycle", "not_ingredient", None),
]


def get_json(client: httpx.Client, url: str, params: dict) -> dict:
    for attempt in range(5):
        try:
            r = client.get(url, params=params, timeout=40)
            if r.status_code == 200:
                return r.json()
        except (httpx.HTTPError, ValueError):  # OFF sometimes answers 200 with an HTML "busy" page
            pass
        time.sleep(5 + attempt * 10)
    return {}


def save_image(client: httpx.Client, url: str, path: Path) -> bool:
    try:
        r = client.get(url, timeout=60, follow_redirects=True)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:  # noqa: BLE001
        return False
    if min(img.size) < 200:
        return False
    img.thumbnail((1280, 1280))
    img.save(path, "JPEG", quality=90)
    return True


def collect_off(client: httpx.Client, out: Path, per_category: int, rows: list[dict]) -> None:
    seen: set[str] = {r["barcode"] for r in rows if r.get("barcode")}
    for host, tag, status, category, country in OFF_CATEGORIES:
        have = sum(1 for r in rows if r.get("offCategory") == tag)
        if have >= per_category:
            print(f"{tag}: {have} (kept)", flush=True)
            continue
        params = {
            "categories_tags_en": tag.removeprefix("en:"),
            "fields": "code,product_name,brands,image_front_url",
            "page_size": 40, "sort_by": "unique_scans_n",
        }
        if country:
            params["countries_tags_en"] = country.removeprefix("en:")
        data = get_json(client, f"https://{host}/api/v2/search", params)
        products = [p for p in data.get("products", []) if p.get("image_front_url") and p.get("product_name")
                    and (p.get("brands") or not category) and p.get("code") not in seen]
        taken = have
        for p in products:
            if taken >= per_category:
                break
            fid = f"off_{p['code']}"
            path = out / "images" / f"{fid}.jpg"
            if not path.exists() and not save_image(client, p["image_front_url"], path):
                continue
            seen.add(p["code"])
            taken += 1
            rows.append({
                "id": fid, "file": f"images/{fid}.jpg", "sourceUrl": p["image_front_url"],
                "pageUrl": f"https://{host}/product/{p['code']}",
                "licence": "CC BY-SA 3.0", "attribution": f"{host.split('.')[1]} contributors",
                "expected": {"status": status, "category": category,
                             "brand": (p.get("brands") or "").split(",")[0].strip() or None if category else None,
                             "product": p["product_name"].strip() if category else None},
                "barcode": p["code"], "split": "test", "source": "off", "offCategory": tag,
            })
            time.sleep(1.0)
        print(f"{tag}: {taken}", flush=True)


def collect_commons(client: httpx.Client, out: Path, per_query: int, rows: list[dict]) -> None:
    for query, status, category in COMMONS_QUERIES:
        data = get_json(client, COMMONS_API, {
            "action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
            "gsrsearch": f"{query} filetype:bitmap", "gsrlimit": 15, "prop": "imageinfo",
            "iiprop": "url|extmetadata", "iiurlwidth": 1024,
        })
        pages = list((data.get("query") or {}).get("pages", {}).values())
        taken = 0
        for page in pages:
            if taken >= per_query:
                break
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata", {})
            licence = meta.get("LicenseShortName", {}).get("value", "")
            if not licence.lower().startswith(FREE_LICENCES) or "nc" in licence.lower().split("-"):
                continue
            url = info.get("thumburl") or info.get("url")
            fid = f"wm_{page['pageid']}"
            path = out / "images" / f"{fid}.jpg"
            if not url or (not path.exists() and not save_image(client, url, path)):
                continue
            taken += 1
            rows.append({
                "id": fid, "file": f"images/{fid}.jpg", "sourceUrl": url,
                "pageUrl": info.get("descriptionurl", ""), "licence": licence,
                "attribution": meta.get("Artist", {}).get("value", "")[:200],
                "expected": {"status": status, "category": category, "brand": None, "product": None},
                "barcode": None, "split": "test", "source": "commons", "query": query,
            })
            time.sleep(1.0)
        print(f"commons '{query}': {taken}", flush=True)


def add_blurred(out: Path, rows: list[dict], count: int) -> None:
    rng = random.Random(7)
    candidates = [r for r in rows if r["source"] == "off" and r["expected"]["status"] == "recognized"
                  and r["expected"]["category"] not in ("fresh_fruit", "herb_spice")]
    for src in rng.sample(candidates, min(count, len(candidates))):
        fid = f"blur_{src['id']}"
        img = Image.open(out / src["file"]).filter(ImageFilter.GaussianBlur(radius=18))
        img.save(out / "images" / f"{fid}.jpg", "JPEG", quality=80)
        rows.append({**src, "id": fid, "file": f"images/{fid}.jpg", "derivedFrom": src["id"],
                     "notes": "Gaussian blur r=18 (derived work, same licence)", "barcode": None,
                     "expected": {"status": "unclear", "category": None, "brand": None, "product": None},
                     "source": "blur"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"D:\AI\datasets\scan-v1")
    ap.add_argument("--per-category", type=int, default=6)
    ap.add_argument("--per-query", type=int, default=2)
    ap.add_argument("--blurred", type=int, default=8)
    ap.add_argument("--commons", action="store_true", help="also query Wikimedia Commons (see module docstring)")
    args = ap.parse_args()
    out = Path(args.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    manifest = out / "manifest.jsonl"
    rows: list[dict] = []
    if manifest.exists():
        rows = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
        rows = [r for r in rows if r.get("source") in ("off", "commons")]
    with httpx.Client(headers={"User-Agent": UA}) as client:
        collect_off(client, out, args.per_category, rows)
        if args.commons:
            collect_commons(client, out, args.per_query, rows)
    add_blurred(out, rows, args.blurred)
    with open(manifest, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"{len(rows)} rows -> {manifest}", flush=True)


if __name__ == "__main__":
    main()
