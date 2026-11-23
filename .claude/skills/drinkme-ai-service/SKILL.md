---
name: drinkme-ai-service
description: Architecture and contracts of DrinkMe's AI features - the local ai-service (Python FastAPI + Ollama + OCR), the Express AI provider layer (AI_PROVIDER=local|off; no OpenAI), the /api/ai/* routes, schema versioning, feature flags, env vars and rollout order. Use for any task that touches bottle scanning, barcode lookup, recipe generation, saved recipes, the AI notice or the ai-service itself.
---

# DrinkMe AI service

## Three parts, one direction of calls
```
App (Expo)  --HTTPS+JWT-->  Express server (server/)  --HTTP+token-->  ai-service (ai-service/)  -->  Ollama (GPU)
                                   |                                        └── RapidOCR (CPU, ONNX)
                                   └── Open Food Facts (barcode lookup, server-side only)
```
- No third-party AI (decision D-24): the OpenAI provider and its legacy routes were removed on 2026-11-22.
- The app never talks to the ai-service or Ollama. Only the Express server does.
- The Express server is the authority: auth, 18+, AI notice, rate limits, schema validation, **safety validation**,
  ingredient compliance, de-duplication, persistence. The ai-service is stateless and trusted only for producing
  candidate output that the server re-validates.
- Photos are processed in memory and discarded (see Privacy). Nothing in the ai-service writes to disk.

## Contract versions
- Wire schema version: `"1"` (`AI_SCHEMA_VERSION`). Every ai-service request and response carries
  `schemaVersion: "1"`. A breaking change means `/v2/*` routes on the ai-service and a new `AI_SCHEMA_VERSION`; the
  server keeps calling v1 until it is upgraded (rollout order below).
- JSON schemas live in `ai-service/schemas/*.schema.json` (source of truth, generated from the pydantic models by
  `ai-service/scripts/export_schemas.py`) and are mirrored by the server validators in `server/ai/schemas.js` and
  the client types in `src/types/api.ts` (`AiScanResult`, `AiRecipe`, ...). A server test compares the enums.

## ai-service HTTP API (default `http://127.0.0.1:8088`)
All routes except `/health` need header `X-AI-Service-Token: <AI_SERVICE_TOKEN>` when the token is set (always set
outside local development; the service refuses to bind a non-loopback host without it).
| Route | Body | Answer |
|---|---|---|
| `GET /health`, `GET /v1/health` | - | `{status: "ok"|"degraded", schemaVersion, models: {vision, text}, ollama: bool, modelsPresent: bool, ocr: bool}` |
| `POST /v1/scan` | `{schemaVersion, imageBase64, mimeType, language}` (JPEG/PNG/WebP, max 7 MB decoded) | `ScanResult` |
| `POST /v1/recipes` | `RecipeRequest` | `{schemaVersion, recipes: Recipe[], model, timings}` |
Error answers: `{error: {code, message}}` with codes `invalid_request` (400/422), `unauthorized` (401),
`image_invalid` (400), `model_unavailable` (503), `model_timeout` (504), `model_invalid_output` (502).

### ScanResult
`{schemaVersion, status, item, suggestBarcode, model, timings: {ocrMs, visionMs, totalMs}}`
- `status`: `recognized` | `low_confidence` | `water` | `not_ingredient` | `unclear`
- `item` (null for `not_ingredient`/`unclear`): `{category, brand, product, style, abv, volumeMl, isAlcoholic, flags, confidence}`
  - `category`: see the ingredient-taxonomy skill (`spirit`, `liqueur`, `wine`, `sparkling_wine`, `beer`, `cider`,
    `vermouth_aperitif`, `bitters`, `syrup`, `juice`, `soda_mixer`, `energy_drink`, `dairy_cream`, `fresh_fruit`,
    `herb_spice`, `water`)
  - `abv` 0-100 or null, `volumeMl` > 0 or null, `confidence` 0-1, `flags` ⊆ [`energy_drink`, `contains_caffeine`]
- `suggestBarcode` is true when `status` is `low_confidence` or `unclear` (`confidence < SCAN_MIN_CONFIDENCE`, 0.6).
- `water`: recognised but the app shows "no recipes - it's water".

### RecipeRequest
`{schemaVersion, mode: "scan"|"smart_bar", language: "en"|"ro", ingredients: [{name, category?}], basics: string[],
mocktailsOnly: bool, excludeNames: string[], count: 1..5}` (the server asks 4, and 1 for the mocktail top-up)
- `scan`: `ingredients` holds exactly the scanned item; other ingredients are allowed and become "you'll also need".
- `smart_bar`: only `ingredients` + `basics` may be used. Basics are user text: they go in the user message, never
  the system prompt.

### Recipe
See the recipe-schema skill.

## Express side (server/)
- `server/ai/provider.js`: `AI_PROVIDER` = `local` | `off` (default `off`; only exactly `local` is on; `openai` and the
  legacy `AI_ENABLED=true` just log a warning).
- `server/ai/localProvider.js`: calls the ai-service with timeout `AI_SERVICE_TIMEOUT_MS` (scan 20 s, recipes 60 s
  default; counted from the start of the call, incl. the upload), 1 retry on connection errors and 503 only.
- `server/ai/recipeEngine.js`: slot engine – one model call per recipe (style hints, one mocktail slot that gets only a
  flavour description of an alcoholic scanned bottle, one retry per slot, refill, `AI_RECIPE_CONCURRENCY` 2), and an
  `onRecipe` callback used for streaming.
- `server/ai/schemas.js`, `server/ai/recipeSafety.js`, `server/ai/taxonomy.js`, `server/ai/openFoodFacts.js`,
  `server/ai/photoStore.js` (only used while `AI_PHOTO_OPT_IN_ENABLED` is on; otherwise `deleteAll()` at start).
- ai-service scan: 4B first; an optional second model (`DRINKME_SECOND_PASS_MODEL`, off by default) only for
  `unclear`/low-confidence answers, inside a 17 s total budget (held-out eval: no gain, so off).
- Per-user daily limits `AI_DAILY_SCAN_LIMIT` (20) / `AI_DAILY_RECIPE_LIMIT` (10), rolling 24 h; 429
  `ai_daily_limit` with `kind` and `limit`; outages/timeouts give the unit back. `GET /api/ai/status` returns
  `dailyLeft` and `dailyLimits`.
- Routes (all behind `requireSignedInAdult`, `requireAuth`, the AI limiter):
  | Route | Notes |
  |---|---|
  | `GET /api/ai/status` | `{available, provider, scan, recipes, barcode, noticeVersion, noticeAccepted, processing, settings}`; the app's feature flag |
  | `POST /api/ai/notice` | `{version}` accepts the AI notice (`AI_NOTICE_VERSION` 1) |
  | `PUT /api/ai/settings` | `{basics?: string[] \| null, photoOptIn?: bool}`; `photoOptIn: true` → 400 `photo_opt_in_unavailable` unless `AI_PHOTO_OPT_IN_ENABLED`; turning it off always works |
  | `POST /api/ai/scan` | JSON `{imageBase64, language}`; needs notice; 18+; one request per user, then AI limiter |
  | `POST /api/ai/barcode` | `{ean, language}`; EAN-8/12/13 checksum; Open Food Facts; no notice needed, works with AI off |
  | `POST /api/ai/report` | `{kind: 'recipe'\|'scan', reason: 'offensive'\|'unsafe'\|'wrong'\|'other', ...}` → audit entry `ai.output_reported` (Google Play AI content policy) |
  | `POST /api/ai/recipes` | `{mode, item?, language, newSession?, stream?}`; returns `{recipes, exhausted}`; with `stream: true` NDJSON lines `start` / `recipe` (one per recipe) / `done` / `error` (client: `streamRecipes` in `src/lib/ai.ts`, XHR) |
  | `GET /api/recipes/saved` · `POST /api/recipes/saved` · `DELETE /api/recipes/saved/:recipeId` | saved recipes (max 200) |
- Error codes to the app (each has an `ai.errors.*` string in ro/en): `ai_disabled` 503, `ai_notice_required` 403,
  `ai_rate_limit` 429, `ai_daily_limit` 429, `ai_busy` 409 (one AI request per user at a time), `ai_unavailable` 503 (provider down),
  `ai_timeout` 504, `ai_invalid_output` 502 (nothing valid after one regeneration), `ai_bad_request` 400,
  `barcode_not_found` 404, `barcode_invalid` 400, `barcode_unavailable` 503, `smart_bar_empty` 400,
  `water_no_recipes` 400, `recipe_limit` 429, `recipe_invalid` 400; exhausted batches are 200 with `exhausted: true`.
- The client tolerates enum values it does not know (unknown status/category → `unclear`, unknown warnings dropped),
  so adding a value is an additive change; removing or renaming one needs a new schema version.
- The one-request lock is released when the provider work settles, not on disconnect; a disconnect aborts the call.
- Production refuses to start with `AI_PROVIDER=local` unless `AI_SERVICE_TOKEN` has 32+ characters and
  `AI_SERVICE_URL` is loopback or https.
- Every new route is in `server/test/helpers/routes.js` `ROUTE_MANIFEST`.

## Env vars
| Var | Where | Default | Meaning |
|---|---|---|---|
| `AI_PROVIDER` | server | `off` | exactly `local` = on; anything else = off |
| `AI_DAILY_SCAN_LIMIT` / `AI_DAILY_RECIPE_LIMIT` | server | `20` / `10` | per user per rolling 24 h |
| `AI_RECIPE_CONCURRENCY` | server | `2` | recipe calls in parallel per batch (match `OLLAMA_NUM_PARALLEL`) |
| `AI_PHOTO_OPT_IN_ENABLED` | server | off | offer the photo opt-in (off at launch, D-22) |
| `DRINKME_SECOND_PASS_MODEL` / `_BUDGET_S` / `_KEEP_ALIVE` | ai-service | off / 12 / `2m` | optional second scan pass |
| `AI_SERVICE_URL` | server | `http://127.0.0.1:8088` | ai-service base URL |
| `AI_SERVICE_TOKEN` | server + ai-service | none | shared secret, header `X-AI-Service-Token` |
| `AI_SERVICE_TIMEOUT_MS` | server | `60000` | recipes; scan uses min(20000, this) |
| `AI_PHOTO_RETENTION_DAYS` | server | `90` | only for users who opted in |
| `AI_PHOTO_DIR` | server | `server/data/ai-scans` | kept photos (opt-in), metadata stripped |
| `AI_RATE_LIMIT_PER_HOUR` | server | `30` | scans + batches per user per hour |
| `AI_SERVICE_HOST` / `AI_SERVICE_PORT` | ai-service | `127.0.0.1` / `8088` | non-loopback needs the token |
| `DRINKME_MAX_IMAGE_SIDE`, `DRINKME_OCR`, `SCAN_MIN_CONFIDENCE`, `OLLAMA_TIMEOUT_S`, `OLLAMA_KEEP_ALIVE` | ai-service | see LOCAL_SETUP | |
| `OLLAMA_HOST` | ai-service | `127.0.0.1:11434` | |
| `DRINKME_VISION_MODEL` / `DRINKME_TEXT_MODEL` | ai-service | see docs/ai/LOCAL_SETUP.md | Ollama tags |
| `OLLAMA_MODELS`, `PIP_CACHE_DIR`, `HF_HOME`, `TORCH_HOME` | Windows user env | D:\AI\... | see docs/ai/LOCAL_SETUP.md |

## Feature flags
- Server: `AI_PROVIDER`. `off` makes every `/api/ai/*` AI route answer 503 `ai_disabled`; barcode lookup, saved
  recipes and reports stay on (they need no model). Rollback = `AI_PROVIDER=off` (see docs/ai/ROLLOUT.md).
- Client: `AI_ENABLED` (ScannerScreen.tsx) and `AI_RECIPES_ENABLED` (SmartBarScreen.tsx) are hard kill switches
  (true on this branch). The real flows show only when the kill switch is on **and** `GET /api/ai/status` says
  `available`; otherwise the "coming soon" preview stays. Never delete the preview.

## Privacy
- Photos: base64 in memory → ai-service → discarded. Not logged (no request bodies in logs, no OCR text in logs).
- No photo retention at launch (D-21/D-22): `AI_PHOTO_OPT_IN_ENABLED` is off, the switch is hidden in the app and the
  server deletes any kept photo and clears old opt-ins at start (LC-49). Only if the flag is turned on later does an
  opted-in user's photo + result stay in `AI_PHOTO_DIR` for `AI_PHOTO_RETENTION_DAYS`, deleted with the account.
- Every AI answer is labelled "AI-generated" in the app.

## Rollout order (never change it)
1. ai-service (new schema version served side by side) → 2. Express server (reads new fields, still accepts old) →
3. app (shows new fields). Turning a feature off: server flag first, the app follows `GET /api/ai/status`.
The integration-manager reviews every change that crosses these parts.
