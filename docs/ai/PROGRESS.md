# Local AI track – progress

Branch `auto/ai-2026-11-16` (worktree `D:\DrinkMeApp\DrinkMeFinal-ai`). Not merged into main until John says so.
Detailed log: [RUN_LOG.md](RUN_LOG.md) · Setup: [LOCAL_SETUP.md](LOCAL_SETUP.md) · Numbers: [EVAL_REPORT.md](EVAL_REPORT.md) ·
Rollout: [ROLLOUT.md](ROLLOUT.md) · Production: [PRODUCTION_PLAN.md](PRODUCTION_PLAN.md)

| Phase | Scope | Status |
|---|---|---|
| 0 | Team: agents integration-manager, ml-engineer, data-curator, ai-evaluator; skills drinkme-ai-service, recipe-schema, ingredient-taxonomy; planner / legal-compliance / test-engineer / alcohol-content-policy updated; CLAUDE.md team table | ✅ |
| 1 | ai-service (FastAPI + Ollama + RapidOCR, schemas v1), Express provider layer `AI_PROVIDER=local\|off` (default off; OpenAI removed, D-24), `/api/ai/*` routes, npm `ai:setup/start/stop/health/test`, `test:android` starts the ai-service | ✅ |
| 2 | Scanner: label photo → structured result; low confidence → barcode (expo-camera, Expo Go) → Open Food Facts; confirm/edit before saving; water / not-an-ingredient messages; photos never kept (D-21, opt-in flag off, D-22); optional 8B second pass (off – no gain on the held-out set) | ✅ |
| 3 | Recipes from a scanned item and from the Smart Bar (+ editable basics), batches of 3–5, no repeats, safety rules S1–S13 server-side, saved recipes; streamed one by one (first recipe p50 5.3 s); mocktail slot with flavour-only input | ✅ (mocktail 19/20 batches) |
| 4 | App integration (Scanner, AiRecipes with streaming progress, AiRecipeDetail, AiSettings, Smart Bar Recipes + Saved › Recipes, report sheet, ro/en, a11y); per-user daily limits | ✅ · Android emulator test run 2026-11-22 |
| 5 | Datasets: scan-v1 (153, tuning) + held-out heldout-ro-v1 (132, Romanian, never tuned on) in D:\AI\datasets; evaluation | ✅ report · held-out 76.3 % (tuned set 82.7 %) vs 85 % target – accepted for beta (decision 2026-11-22) |
| 6 | Legal / privacy (legal-compliance agent): D-21..D-28, Terms v0.4 AI section, transparency, privacy, DPIA draft | ✅ drafts (lawyer review open) |
| 7 | Production plan incl. EU scale-to-zero GPU hosting and cost per user | ✅ |

## Checks at the end (2026-11-22)
See the last RUN_LOG entry for the exact numbers (server suite, ai-service pytest, `npm run check`).

## Android emulator test (2026-11-22)
Run with `npm run test:android` (Pixel AVD, Expo Go, photos pushed with adb): scan, edit, add to Smart Bar, Make
something, blurry photo → barcode offer, water message, non-drink, Generate recipes (streamed), another batch, save,
Saved › Recipes, report, ro/en, 18+ path. Log-triage report: `reports/test-sessions/2026-11-22_22-32-37.md` – no
crashes; the medium findings (first-scan 504 after a cold model load, second pass eating the scan budget, Ursus Cooler
0 % shown as alcoholic, recipe style in English/category codes) are fixed. Barcode scanning was exercised through the
API only (the emulator camera cannot read a real barcode).
