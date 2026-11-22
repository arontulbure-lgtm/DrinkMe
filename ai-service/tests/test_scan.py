import httpx

from tests.conftest import jpeg_b64

GOOD = {"readable": True, "isDrinkIngredient": True, "isPlainWater": False, "category": "spirit",
        "brand": "Bombay Sapphire", "product": "London Dry Gin", "style": "London dry gin",
        "abv": 40, "volumeMl": 700, "confidence": 0.92}


def scan(client, **body):
    payload = {"schemaVersion": "1", "imageBase64": jpeg_b64(), "mimeType": "image/jpeg", "language": "en"}
    payload.update(body)
    return client.post("/v1/scan", json=payload)


def test_recognized_spirit(client_factory, fake):
    fake.replies.append(GOOD)
    with client_factory() as c:
        r = scan(c)
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "recognized" and data["suggestBarcode"] is False
    assert data["item"]["isAlcoholic"] is True and data["item"]["category"] == "spirit"
    assert data["schemaVersion"] == "1"
    sent = fake.requests[0]
    assert sent["format"]["type"] == "object" and sent["messages"][1]["images"]


def test_low_confidence_suggests_barcode(client_factory, fake):
    fake.replies.append({**GOOD, "confidence": 0.3})
    with client_factory() as c:
        data = scan(c).json()
    assert data["status"] == "low_confidence" and data["suggestBarcode"] is True and data["item"]


def test_water_is_recognised_without_recipes(client_factory, fake):
    fake.replies.append({**GOOD, "category": "water", "isPlainWater": True, "abv": None, "brand": "Borsec"})
    with client_factory() as c:
        data = scan(c).json()
    assert data["status"] == "water" and data["item"]["isAlcoholic"] is False


def test_not_ingredient(client_factory, fake):
    fake.replies.append({**GOOD, "isDrinkIngredient": False, "category": None})
    with client_factory() as c:
        data = scan(c).json()
    assert data["status"] == "not_ingredient" and data["item"] is None and data["suggestBarcode"] is False


def test_unreadable_is_unclear(client_factory, fake):
    fake.replies.append({**GOOD, "readable": False, "isDrinkIngredient": False, "category": None})
    with client_factory() as c:
        data = scan(c).json()
    assert data["status"] == "unclear" and data["suggestBarcode"] is True


def test_energy_drink_flag_and_zero_beer(client_factory, fake):
    fake.replies.append({**GOOD, "category": "energy_drink", "abv": None})
    fake.replies.append({**GOOD, "category": "beer", "abv": 0.0})
    with client_factory() as c:
        energy = scan(c).json()
        beer = scan(c).json()
    assert energy["item"]["flags"] == ["energy_drink", "contains_caffeine"]
    assert beer["item"]["isAlcoholic"] is False


def test_rejects_wrong_signature(client_factory, fake):
    with client_factory() as c:
        r = scan(c, mimeType="image/png")
    assert r.status_code == 400 and r.json()["error"]["code"] == "image_invalid"


def test_rejects_bad_schema_without_echo(client_factory):
    with client_factory() as c:
        r = c.post("/v1/scan", json={"schemaVersion": "2", "imageBase64": "secretsecretsecret", "mimeType": "image/jpeg"})
    assert r.status_code == 422 and "secret" not in r.text


def test_model_errors_map_to_codes(client_factory, fake):
    fake.replies.append("not json")
    fake.replies.append(httpx.ReadTimeout("slow"))
    with client_factory() as c:
        assert scan(c).json()["error"]["code"] == "model_invalid_output"
        r = scan(c)
        assert r.status_code == 504 and r.json()["error"]["code"] == "model_timeout"
    fake.status = 404
    with client_factory() as c:
        r = scan(c)
    assert r.status_code == 503 and r.json()["error"]["code"] == "model_unavailable"


def test_token_required_when_set(client_factory, fake):
    fake.replies.append(GOOD)
    with client_factory(token="t0ken") as c:
        assert scan(c).status_code == 401
        assert c.get("/health").status_code == 200
        payload = {"schemaVersion": "1", "imageBase64": jpeg_b64(), "mimeType": "image/jpeg"}
        assert c.post("/v1/scan", json=payload, headers={"X-AI-Service-Token": "t0ken"}).status_code == 200


def test_health(client_factory, fake):
    with client_factory() as c:
        assert c.get("/v1/health").json()["status"] == "ok"
    fake.models = []
    with client_factory() as c:
        data = c.get("/health").json()
    assert data["status"] == "degraded" and data["ollama"] is False


def test_ocr_abv_and_volume_parsing():
    from app.imaging import abv_from_text, volume_from_text
    assert abv_from_text(["LONDON DRY GIN", "40% vol"]) == 40
    assert abv_from_text(["100% juice"]) is None
    assert abv_from_text(["alc. 4,5% vol"]) == 4.5
    assert volume_from_text(["70 cl"]) == 700
    assert volume_from_text(["0,5 L"]) == 500


def test_rejects_oversized_dimensions_before_decoding(client_factory, fake):
    import base64
    import io

    from PIL import Image
    buf = io.BytesIO()
    Image.new("L", (9000, 8), 0).save(buf, "PNG")  # tiny file, too wide
    with client_factory() as c:
        r = c.post("/v1/scan", json={"schemaVersion": "1", "imageBase64": base64.b64encode(buf.getvalue()).decode(),
                                     "mimeType": "image/png"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "image_invalid"
    assert fake.requests == []


def test_second_pass_runs_only_when_unsure_and_keeps_the_better_answer(client_factory, fake):
    unsure = {**GOOD, "confidence": 0.4}
    better = {**GOOD, "brand": "Tanqueray", "confidence": 0.9}
    fake.replies.extend([unsure, better])
    with client_factory(second_pass_model="big:test") as c:
        data = scan(c).json()
    assert data["status"] == "recognized" and data["item"]["brand"] == "Tanqueray"
    assert data["model"] == "vision:test+big:test" and data["timings"]["secondPassMs"] >= 0
    assert [r["model"] for r in fake.requests] == ["vision:test", "big:test"]
    assert fake.requests[1]["keep_alive"] == "2m"


def test_second_pass_not_better_or_failing_keeps_the_first(client_factory, fake):
    fake.replies.extend([{**GOOD, "confidence": 0.4}, {**GOOD, "readable": False, "isDrinkIngredient": False, "category": None}])
    with client_factory(second_pass_model="big:test") as c:
        assert scan(c).json()["status"] == "low_confidence"
    fake.replies.extend([{**GOOD, "confidence": 0.4}, "not json"])
    with client_factory(second_pass_model="big:test") as c:
        assert scan(c).json()["status"] == "low_confidence"


def test_no_second_pass_when_the_first_is_confident(client_factory, fake):
    fake.replies.append(GOOD)
    with client_factory(second_pass_model="big:test") as c:
        assert scan(c).json()["timings"]["secondPassMs"] == 0
    assert len(fake.requests) == 1


def test_second_pass_over_budget_returns_the_first_answer(client_factory, fake):
    import asyncio

    fake.replies.append({**GOOD, "readable": False, "isDrinkIngredient": False, "category": None})
    original = fake.handler

    async def slow(request):
        if b'"big:test"' in request.content:
            await asyncio.sleep(0.5)
        return original(request)

    fake.handler = slow
    fake.replies.append(GOOD)
    with client_factory(second_pass_model="big:test", second_pass_budget_s=0.1) as c:
        data = scan(c).json()
    assert data["status"] == "unclear" and data["suggestBarcode"] is True
    assert data["timings"]["secondPassMs"] >= 100


def test_category_code_is_not_a_style(client_factory, fake):
    fake.replies.append({**GOOD, "category": "soda_mixer", "style": "soda_mixer"})
    with client_factory() as c:
        assert scan(c).json()["item"]["style"] is None
