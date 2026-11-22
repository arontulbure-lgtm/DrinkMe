"""Held-out scan test set, mostly products sold in Romania: D:\\AI\\datasets\\heldout-ro-v1 (never in git).

HELD OUT: never used to tune prompts, thresholds or models. Only for reporting (docs/ai/EVAL_REPORT.md).
Disjoint from scan-v1 (same barcodes are skipped).

Sources (openly licensed only):
- Open Food Facts (CC BY-SA 3.0): Romanian brands and Romania-country categories; expected labels are mapped from
  the OFF categories with the same table as server/ai/openFoodFacts.js (unmapped products are skipped).
- Open Products Facts / Open Beauty Facts (CC BY-SA 3.0): negatives.
- Wikimedia Commons (free licences only; John allowed the project contact drinkmesocialapp@gmail.com in the
  User-Agent, as its robot policy requires): real-world photos of Romanian drinks, fresh produce and objects.
  Commons labels come from the search intent and are marked "review": true.
- Derived blurry photos (same licence).

Usage: python -I eval/build_heldout.py
"""
from __future__ import annotations

import io
import json
import random
import re
import sys
import time
from pathlib import Path

import httpx
from PIL import Image, ImageFilter

OUT = Path(r"D:\AI\datasets\heldout-ro-v1")
OLD_MANIFEST = Path(r"D:\AI\datasets\scan-v1\manifest.jsonl")
UA = "DrinkMeEval/0.1 (open dataset builder; contact: drinkmesocialapp@gmail.com)"
OFF, OPF, OBF = "world.openfoodfacts.org", "world.openproductsfacts.org", "world.openbeautyfacts.org"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
FREE_LICENCES = ("cc0", "public domain", "pd", "cc by", "cc-by")

# Same order and tags as server/ai/openFoodFacts.js TAG_MAP (most specific first).
TAG_MAP = [
    (["en:energy-drinks"], "energy_drink"),
    (["en:flavoured-waters", "en:flavored-waters"], "soda_mixer"),
    (["en:waters", "en:mineral-waters", "en:spring-waters", "en:natural-mineral-waters", "en:sparkling-waters"], "water"),
    (["en:tonic-water", "en:tonic-waters", "en:sodas", "en:colas", "en:carbonated-drinks", "en:lemonades", "en:iced-teas",
      "en:ginger-beers", "en:ginger-ales"], "soda_mixer"),
    (["en:syrups", "en:simple-syrups", "en:flavoured-syrups"], "syrup"),
    (["en:juices", "en:fruit-juices", "en:nectars", "en:vegetable-juices", "en:orange-juices"], "juice"),
    (["en:milks", "en:creams", "en:plant-based-milks", "en:dairy-drinks"], "dairy_cream"),
    (["en:liqueurs", "en:cream-liqueurs"], "liqueur"),
    (["en:vermouths", "en:aperitifs", "en:bitters", "en:bitter-aperitifs"], "vermouth_aperitif"),
    (["en:sparkling-wines", "en:champagnes", "en:proseccos", "en:cavas"], "sparkling_wine"),
    (["en:wines", "en:red-wines", "en:white-wines", "en:rose-wines", "en:fortified-wines"], "wine"),
    (["en:ciders"], "cider"),
    (["en:beers", "en:lagers", "en:non-alcoholic-beers"], "beer"),
    (["en:spirits", "en:distilled-spirits", "en:distilled-beverages", "en:hard-liquors", "en:eaux-de-vie", "en:gins",
      "en:vodkas", "en:rums", "en:whiskies", "en:brandies", "en:tequilas", "en:fruit-brandies"], "spirit"),
]

BRANDS = [  # OFF brand tags of drinks sold in Romania
    "ursus", "timisoreana", "ciuc", "bergenbier", "silva", "golden-brau", "noroc", "jidvei", "murfatlar", "cotnari",
    "recas", "cramele-recas", "zarea", "alexandrion", "angelli", "borsec", "dorna", "bucovina", "aqua-carpatica",
    "izvorul-minunilor", "perla-harghitei", "prigat", "cappy", "tymbark", "santal", "hell", "burn", "zuzu",
    "napolact", "olympus", "pitoresti", "carpathian", "stalinskaya", "unirea", "tuica-zetea", "zetea",
]
RO_CATEGORIES = ["beers", "lagers", "wines", "red-wines", "white-wines", "rose-wines", "mineral-waters", "juices", "nectars",
                 "spirits", "fruit-brandies", "liqueurs", "sodas", "colas", "iced-teas", "energy-drinks", "syrups",
                 "sparkling-wines", "milks", "ciders", "tonic-water"]
NEGATIVES = [(OFF, "en:biscuits"), (OFF, "en:chips-and-fries"), (OFF, "en:chocolates"), (OFF, "en:canned-vegetables"),
             (OPF, "en:medicines"), (OPF, "en:dishwashing-liquids"), (OBF, "en:shower-gels"), (OBF, "en:deodorants")]
# (query, status, category, brand)
COMMONS = [
    ("Ursus beer bottle", "recognized", "beer", "Ursus"), ("Timișoreana beer", "recognized", "beer", "Timișoreana"),
    ("Ciuc beer", "recognized", "beer", "Ciuc"), ("Borsec mineral water", "water", "water", "Borsec"),
    ("Dorna water bottle", "water", "water", "Dorna"), ("Jidvei wine bottle", "recognized", "wine", "Jidvei"),
    ("Murfatlar wine", "recognized", "wine", "Murfatlar"), ("Cotnari wine", "recognized", "wine", "Cotnari"),
    ("Zarea sparkling wine", "recognized", "sparkling_wine", "Zarea"), ("Alexandrion brandy", "recognized", "spirit", "Alexandrion"),
    ("pălincă bottle", "recognized", "spirit", None), ("țuică bottle", "recognized", "spirit", None),
    ("limes fruit market", "recognized", "fresh_fruit", None), ("lemons fruit", "recognized", "fresh_fruit", None),
    ("fresh mint herb", "recognized", "herb_spice", None), ("oranges fruit", "recognized", "fresh_fruit", None),
    ("office chair", "not_ingredient", None, None), ("bicycle parked", "not_ingredient", None, None),
    ("computer mouse", "not_ingredient", None, None), ("cat sitting", "not_ingredient", None, None),
]


def category_for(tags: list[str]) -> str | None:
    s = set(tags or [])
    for cands, cat in TAG_MAP:
        if any(t in s for t in cands):
            return cat
    return None


def get_json(client: httpx.Client, url: str, params: dict) -> dict:
    for attempt in range(5):
        try:
            r = client.get(url, params=params, timeout=40)
            if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
                return r.json()
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(4 + attempt * 6)
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


def off_rows(client, host, params, status_override, seen, limit, rows, tag_label):
    data = get_json(client, f"https://{host}/api/v2/search", {
        **params, "fields": "code,product_name,brands,image_front_url,categories_tags", "page_size": 40})
    taken = 0
    for p in data.get("products", []):
        if taken >= limit:
            break
        code = p.get("code")
        if not code or code in seen or not p.get("image_front_url") or not p.get("product_name"):
            continue
        if status_override == "not_ingredient":
            category, status = None, "not_ingredient"
        else:
            category = category_for(p.get("categories_tags"))
            if not category:
                continue
            status = "water" if category == "water" else "recognized"
        fid = f"off_{code}"
        path = OUT / "images" / f"{fid}.jpg"
        if not path.exists() and not save_image(client, p["image_front_url"], path):
            continue
        seen.add(code)
        taken += 1
        brand = (p.get("brands") or "").split(",")[0].strip() or None
        rows.append({"id": fid, "file": f"images/{fid}.jpg", "sourceUrl": p["image_front_url"],
                     "pageUrl": f"https://{host}/product/{code}", "licence": "CC BY-SA 3.0",
                     "attribution": f"{host.split('.')[1]} contributors",
                     "expected": {"status": status, "category": category,
                                  "brand": brand if category else None,
                                  "product": p["product_name"].strip() if category else None},
                     "barcode": code, "split": "heldout", "source": "off", "query": tag_label})
        time.sleep(1.0)
    print(f"{tag_label}: {taken}", flush=True)


def commons_rows(client, rows, per_query=2):
    for query, status, category, brand in COMMONS:
        data = get_json(client, COMMONS_API, {
            "action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
            "gsrsearch": f"{query} filetype:bitmap", "gsrlimit": 20, "prop": "imageinfo",
            "iiprop": "url|extmetadata", "iiurlwidth": 1024})
        taken = 0
        for page in (data.get("query") or {}).get("pages", {}).values():
            if taken >= per_query:
                break
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata", {})
            licence = meta.get("LicenseShortName", {}).get("value", "")
            if not licence.lower().startswith(FREE_LICENCES) or "-nc" in licence.lower():
                continue
            url = info.get("thumburl") or info.get("url")
            fid = f"wm_{page['pageid']}"
            path = OUT / "images" / f"{fid}.jpg"
            if not url or (not path.exists() and not save_image(client, url, path)):
                continue
            taken += 1
            artist = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", ""))[:200]
            rows.append({"id": fid, "file": f"images/{fid}.jpg", "sourceUrl": url, "pageUrl": info.get("descriptionurl", ""),
                         "licence": licence, "attribution": artist,
                         "expected": {"status": status, "category": category, "brand": brand, "product": None},
                         "barcode": None, "split": "heldout", "source": "commons", "query": query, "review": True,
                         "reviewNote": "label from the search intent; check the photo"})
            time.sleep(1.0)
        print(f"commons '{query}': {taken}", flush=True)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # Romanian names on a cp1252 Windows console
    (OUT / "images").mkdir(parents=True, exist_ok=True)
    seen = {json.loads(l).get("barcode") for l in OLD_MANIFEST.read_text(encoding="utf-8").splitlines() if l.strip()}
    rows: list[dict] = []
    with httpx.Client(headers={"User-Agent": UA}) as client:
        for brand in BRANDS:
            off_rows(client, OFF, {"brands_tags": brand, "countries_tags_en": "romania"}, None, seen, 4, rows, f"brand:{brand}")
        for cat in RO_CATEGORIES:
            off_rows(client, OFF, {"categories_tags_en": cat, "countries_tags_en": "romania", "sort_by": "unique_scans_n"},
                     None, seen, 6, rows, f"ro:{cat}")
        for host, tag in NEGATIVES:
            params = {"categories_tags_en": tag.removeprefix("en:")}
            if host == OFF:
                params["countries_tags_en"] = "romania"
            off_rows(client, host, params, "not_ingredient", seen, 3, rows, f"neg:{tag}")
        commons_rows(client, rows)
    rng = random.Random(11)
    blur_src = [r for r in rows if r["source"] == "off" and r["expected"]["status"] == "recognized"]
    for src in rng.sample(blur_src, min(6, len(blur_src))):
        fid = f"blur_{src['id']}"
        Image.open(OUT / src["file"]).filter(ImageFilter.GaussianBlur(radius=18)).save(OUT / "images" / f"{fid}.jpg", "JPEG", quality=80)
        rows.append({**src, "id": fid, "file": f"images/{fid}.jpg", "barcode": None, "source": "blur",
                     "notes": "Gaussian blur r=18 (derived work, same licence)",
                     "expected": {"status": "unclear", "category": None, "brand": None, "product": None}})
    (OUT / "manifest.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    print(f"{len(rows)} rows -> {OUT / 'manifest.jsonl'}", flush=True)


if __name__ == "__main__":
    main()
