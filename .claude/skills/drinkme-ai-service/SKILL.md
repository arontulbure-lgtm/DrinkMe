---
name: drinkme-ai-service
description: Architecture and contracts of DrinkMe's AI features - the local ai-service (Python FastAPI + Ollama + OCR), the Express AI provider layer (AI_PROVIDER=local|openai|off), the /api/ai/* routes, schema versioning, feature flags, env vars and rollout order. Use for any task that touches bottle scanning, barcode lookup, recipe generation, saved recipes, the AI notice or the ai-service itself.
---

# DrinkMe AI service

## Three parts, one direction of calls
```
App (Expo)  --HTTPS+JWT-->  Express server (server/)  --HTTP+token-->  ai-service (ai-service/)  -->  Ollama (GPU)
                                   |                                        └── RapidOCR (CPU, ONNX)
                                   ├── Open Food Facts (barcode lookup, server-side only)
                                   └── OpenAI (only when AI_PROVIDER=openai)
```
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
| `GET /health`, `GET /v1/health` | - | `{status: "ok"|"degraded", schemaVersion, models: {vision, text}, ollama: bool, ocr: bool}` |
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
mocktailsOnly: bool, excludeNames: string[], count: 3..5}`
- `scan`: `ingredients` holds exactly the scanned item; other ingredients are allowed and become "you'll also need".
- `smart_bar`: only `ingredients` + `basics` may be used.

### Recipe
See the recipe-schema skill.

## Express side (server/)
- `server/ai/provider.js`: `AI_PROVIDER` = `local` | `openai` | `off` (default `off`). Legacy: when `AI_PROVIDER` is
  unset and `AI_ENABLED=true`, the provider is `openai` (old behaviour of `/api/detect-product`,
  `/api/generate-recipes`, `/api/smart-bar/generate-recipes`, which only ever use OpenAI).
- `server/ai/localProvider.js`: calls the ai-service with timeout `AI_SERVICE_TIMEOUT_MS` (scan 20 s, recipes 60 s
  default), 1 retry on connection errors and 503 only (never on 4xx or timeouts of generation).
- `server/ai/openaiProvider.js`: same interface on OpenAI (`gpt-4o-mini`, `store: false`).
- `server/ai/schemas.js`, `server/ai/recipeSafety.js`, `server/ai/taxonomy.js`, `server/ai/openFoodFacts.js`.
- Routes (all behind `requireSignedInAdult`, `requireAuth`, the AI limiter):
  | Route | Notes |
  |---|---|
  | `GET /api/ai/status` | `{available, provider, scan, recipes, barcode, noticeVersion, noticeAccepted, settings}`; the app's feature flag |
  | `POST /api/ai/notice` | `{version}` accepts the AI notice (stored as `aiNoticeVersion` on the user) |
  | `PUT /api/ai/settings` | `{basics?: string[], photoOptIn?: bool}` |
  | `POST /api/ai/scan` | JSON `{imageBase64, language}`; needs notice; 18+; AI limiter |
  | `POST /api/ai/barcode` | `{ean, language}`; EAN-8/12/13 checksum; Open Food Facts; needs notice |
  | `POST /api/ai/recipes` | `{mode, item?, language, newSession?}`; returns `{recipes, exhausted}` |
  | `GET /api/recipes/saved` · `POST /api/recipes/saved` · `DELETE /api/recipes/saved/:recipeId` | saved recipes (max 200) |
- Error codes to the app: `ai_disabled` 503, `ai_notice_required` 403, `ai_rate_limit` 429, `ai_unavailable` 503
  (provider down), `ai_timeout` 504, `ai_invalid_output` 502 (nothing valid after one regeneration),
  `barcode_not_found` 404, `barcode_invalid` 400, `recipe_limit` 429, `recipes_exhausted` (200 with `exhausted: true`).
- Every new route is in `server/test/helpers/routes.js` `ROUTE_MANIFEST`.

## Env vars
| Var | Where | Default | Meaning |
|---|---|---|---|
| `AI_PROVIDER` | server | `off` | `local`, `openai` or `off` |
| `AI_SERVICE_URL` | server | `http://127.0.0.1:8088` | ai-service base URL |
| `AI_SERVICE_TOKEN` | server + ai-service | none | shared secret, header `X-AI-Service-Token` |
| `AI_SERVICE_TIMEOUT_MS` | server | `60000` | recipes; scan uses min(20000, this) |
| `AI_PHOTO_RETENTION_DAYS` | server | `90` | only for users who opted in |
| `OLLAMA_HOST` | ai-service | `127.0.0.1:11434` | |
| `DRINKME_VISION_MODEL` / `DRINKME_TEXT_MODEL` | ai-service | see docs/ai/LOCAL_SETUP.md | Ollama tags |
| `OLLAMA_MODELS`, `PIP_CACHE_DIR`, `HF_HOME`, `TORCH_HOME` | Windows user env | D:\AI\... | see docs/ai/LOCAL_SETUP.md |

## Feature flags
- Server: `AI_PROVIDER`. `off` makes every `/api/ai/*` AI route answer 503 `ai_disabled`; barcode lookup and saved
  recipes stay on (they need no model).
- Client: `AI_ENABLED` (ScannerScreen.tsx) and `AI_RECIPES_ENABLED` (SmartBarScreen.tsx) are hard kill switches
  (true on this branch). The real flows show only when the kill switch is on **and** `GET /api/ai/status` says
  `available`; otherwise the "coming soon" preview stays. Never delete the preview.

## Privacy
- Photos: base64 in memory → ai-service → discarded. Not logged (no request bodies in logs, no OCR text in logs).
- Opt-in (`photoOptIn`, off by default): only then the server keeps the photo + result in `AI_PHOTO_DIR`
  (default `server/data/ai-scans/`, gitignored) for `AI_PHOTO_RETENTION_DAYS`, deleted with the account.
- Every AI answer is labelled "AI-generated" in the app.

## Rollout order (never change it)
1. ai-service (new schema version served side by side) → 2. Express server (reads new fields, still accepts old) →
3. app (shows new fields). Turning a feature off: server flag first, the app follows `GET /api/ai/status`.
The integration-manager reviews every change that crosses these parts.
