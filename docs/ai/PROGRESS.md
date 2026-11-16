# Local AI track – progress

Branch `auto/ai-2026-11-16` (worktree `D:\DrinkMeApp\DrinkMeFinal-ai`). Not merged into main until John says so.
Detailed log: [RUN_LOG.md](RUN_LOG.md) · Setup: [LOCAL_SETUP.md](LOCAL_SETUP.md) · Numbers: [EVAL_REPORT.md](EVAL_REPORT.md) ·
Rollout: [ROLLOUT.md](ROLLOUT.md) · Production: [PRODUCTION_PLAN.md](PRODUCTION_PLAN.md)

| Phase | Scope | Status |
|---|---|---|
| 0 | Team: agents integration-manager, ml-engineer, data-curator, ai-evaluator; skills drinkme-ai-service, recipe-schema, ingredient-taxonomy; planner / legal-compliance / test-engineer / alcohol-content-policy updated; CLAUDE.md team table | ✅ |
| 1 | ai-service (FastAPI + Ollama + RapidOCR, schemas v1), Express provider layer `AI_PROVIDER=local\|openai\|off` (default off), `/api/ai/*` routes, npm `ai:setup/start/stop/health/test`, `test:android` starts the ai-service | ✅ |
| 2 | Scanner: label photo → structured result; low confidence → barcode (expo-camera, Expo Go) → Open Food Facts; confirm/edit before saving; water / not-an-ingredient messages; photos in memory, opt-in only | ✅ |
| 3 | Recipes from a scanned item and from the Smart Bar (+ editable basics), batches of 3–5, no repeats, safety rules S1–S13 server-side, saved recipes (API + persistence + tests) | ✅ (mocktail in 16/20 batches – see EVAL_REPORT) |
| 4 | App integration (Scanner, AiRecipes, AiRecipeDetail, AiSettings, Smart Bar Recipes + Saved › Recipes, report sheet, ro/en, a11y) | ✅ code · ⛔ emulator test blocked (see below) |
| 5 | Dataset (153 images, D:\AI\datasets) + evaluation | ✅ report · ❌ 82.7 % vs 85 % target |
| 6 | Legal / privacy (legal-compliance agent) | ✅ drafts (lawyer review + DPIA still open) |
| 7 | Production plan (docs) | ✅ |

## Checks at the end
- Server suite 1343 tests: 1342 pass, 0 fail, 1 skipped · ai-service pytest 24/24 · `npm run check` clean ·
  end-to-end API run with the real model 17/17.

## Blocked: Android emulator test (Phase 4)
The worktree has no `.env`, `server/.env`, service account or dev database (all git-ignored). Copying them from the
main checkout was refused by the permission classifier, so the app could not sign in from this worktree and the
emulator/adb flow was not run. Replaced by `ai-service/eval/e2e_api.mjs` (real server + real model over HTTP).
To run it: allow the copy (or copy the four files yourself), then `npm run test:android` in this worktree with
`AI_PROVIDER=local` and follow the checklist in the PR.
