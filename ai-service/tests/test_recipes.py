from app.pipeline import abv_floor, compute_strength

RECIPE = {"name": "Gin Fizz Light", "description": "Fresh and light.",
          "ingredients": [{"name": "gin", "amount": 40, "unit": "ml", "abv": 40},
                          {"name": "lemon juice", "amount": 20, "unit": "ml", "abv": 0},
                          {"name": "soda water", "amount": 100, "unit": "ml", "abv": 0}],
          "steps": ["Shake gin and lemon with ice.", "Top with soda."], "glass": "highball",
          "garnish": "lemon wheel", "method": "shake", "isAlcoholic": True, "tags": ["fresh"]}
MOCK = {**RECIPE, "name": "Lemon Spritz",
        "ingredients": [{"name": "lemon juice", "amount": 20, "unit": "ml", "abv": 0},
                        {"name": "soda water", "amount": 120, "unit": "ml", "abv": 0}],
        "isAlcoholic": False}


def req(**over):
    body = {"schemaVersion": "1", "mode": "smart_bar", "language": "en",
            "ingredients": [{"name": "gin"}, {"name": "lemon juice"}, {"name": "soda water"}],
            "basics": ["ice", "sugar"], "count": 3}
    body.update(over)
    return body


def test_recipes_are_normalised_and_strength_computed(client_factory, fake):
    fake.replies.append({"recipes": [RECIPE, MOCK]})
    with client_factory() as c:
        r = c.post("/v1/recipes", json=req())
    assert r.status_code == 200
    recipes = r.json()["recipes"]
    assert [x["name"] for x in recipes] == ["Gin Fizz Light", "Lemon Spritz"]
    gin = recipes[0]
    # 40 ml x 40 % = 16 ml ethanol x 0.789 = 12.6 g -> 1.26 standard drinks
    assert gin["standardDrinks"] == 1.26 and gin["isAlcoholic"] is True and gin["aiGenerated"] is True
    assert recipes[1]["isAlcoholic"] is False and recipes[1]["standardDrinks"] == 0
    system = fake.requests[0]["messages"][0]["content"]
    assert "ONLY the ingredients" in system and '"ice"' not in system
    assert '"ice"; "sugar"' in fake.requests[0]["messages"][1]["content"]


def test_model_under_reported_abv_is_raised():
    assert abv_floor("London dry gin") == 40
    assert abv_floor("ginger beer") == 0
    assert abv_floor("non-alcoholic gin") == 0
    assert abv_floor("Prosecco") == 12
    abv, sd = compute_strength([{"amount": 50, "unit": "ml", "abv": 40}, {"amount": 2, "unit": "piece", "abv": 0}])
    assert abv == 40 and sd == 1.58


def test_lying_mocktail_becomes_alcoholic(client_factory, fake):
    lying = {**RECIPE, "name": "Totally Virgin", "isAlcoholic": False,
             "ingredients": [{"name": "vodka", "amount": 40, "unit": "ml", "abv": 0}]}
    fake.replies.append({"recipes": [lying]})
    with client_factory() as c:
        data = c.post("/v1/recipes", json=req(mocktailsOnly=True)).json()
    assert data["recipes"] == [] and data["dropped"] == 1


def test_excluded_and_duplicate_names_dropped(client_factory, fake):
    fake.replies.append({"recipes": [RECIPE, {**RECIPE}, MOCK]})
    with client_factory() as c:
        data = c.post("/v1/recipes", json=req(excludeNames=["lemon spritz"])).json()
    assert [x["name"] for x in data["recipes"]] == ["Gin Fizz Light"] and data["dropped"] == 2
    user = fake.requests[0]["messages"][1]["content"]
    assert '"lemon spritz"' in user


def test_invalid_recipe_is_dropped_not_fatal(client_factory, fake):
    bad = {**RECIPE, "name": "Bad", "ingredients": [{"name": "gin", "amount": 40, "unit": "oz", "abv": 40}]}
    fake.replies.append({"recipes": [MOCK]})
    with client_factory() as c:
        data = c.post("/v1/recipes", json=req()).json()
    assert [x["name"] for x in data["recipes"]] == ["Lemon Spritz"]
    # A unit outside ml/g/piece fails the model-output schema for that recipe only.
    from app.pipeline import normalise_recipe
    assert normalise_recipe(bad, "en") is None


def test_romanian_language_in_prompt(client_factory, fake):
    fake.replies.append({"recipes": [MOCK]})
    with client_factory() as c:
        c.post("/v1/recipes", json=req(language="ro", mode="scan", ingredients=[{"name": "Tonic"}]))
    system = fake.requests[0]["messages"][0]["content"]
    assert "Romanian" in system and "AROUND the main ingredient" in system


def test_request_limits(client_factory):
    with client_factory() as c:
        assert c.post("/v1/recipes", json=req(count=9)).status_code == 422
        assert c.post("/v1/recipes", json=req(ingredients=[])).status_code == 422
        assert c.post("/v1/recipes", json=req(extra=1)).status_code == 422
