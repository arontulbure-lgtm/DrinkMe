# Local AI track – run log

## 2026-11-16
- Worktree `D:\DrinkMeApp\DrinkMeFinal-ai` created on `auto/ai-2026-11-16` from `origin/main` (442321b).
- Hardware check: RTX 4060 Laptop 8 GB, driver 595.79, CUDA 13.2; ~7.2 GB VRAM free with the desktop running.
- Ollama 0.40.16 installed to `D:\AI\Ollama` (signed installer, `/DIR`). The installer's tray app started before the
  new user env vars were visible to it, so it was stopped; the server is run with `ollama serve` and
  `OLLAMA_MODELS=D:\AI\ollama-models` (nothing was written to `C:\Users\Aron\.ollama\models`, checked: 0 MB).
- Model candidates (web check, Nov 2026): Qwen3-VL is the usual pick for label OCR on 8 GB; 8B Q4 = 6.2 GB, 4B Q4 = 3.3 GB.
  Pulled `qwen3-vl:4b-instruct` and `qwen3-vl:8b-instruct`.
- Python 3.12 venv at `D:\AI\venvs\drinkme-ai` (fastapi, uvicorn, httpx, pydantic, pillow, rapidocr-onnxruntime, pytest).
- Phase 0 written (agents + skills). The server test harness port is made overridable (`DRINKME_TEST_PORT`) so this
  worktree can run the suite on 5056 while the to-do run uses 5055.
- Phase 1: ai-service (FastAPI + Ollama + RapidOCR), server provider layer and `/api/ai/*` routes, npm scripts.
  Model benchmark (`ai-service/eval/bench.py`): qwen3-vl:8b-instruct 8.8 s/scan (over budget) → **qwen3-vl:4b-instruct**,
  4.7 s p50, 4.5 GB VRAM, one model for scans and recipes. First-ever load from disk ~59 s → `ai:start` warms it.
  Full server suite: 1324 tests, 1323 pass, 0 fail (1 skipped).
- Phases 2-4: scanner flow, barcode fallback (expo-camera ~17.0.10), AI recipes, saved recipes, AI settings, ro/en.
- Dataset: 153 images in `D:\AI\datasets\scan-v1` (Open Food Facts / Open Products Facts / Open Beauty Facts,
  CC BY-SA 3.0, 8 derived blurry). Wikimedia Commons was skipped: its robot policy requires a User-Agent with
  personal contact details, which was not sent without John's OK (decision listed in the PR).
- The `legal-compliance` agent did not load: its frontmatter description had an unquoted `: ` (invalid YAML, also on
  main). Fixed by quoting it; this session ran the brief through a general-purpose agent following that file.
- Reviews: integration-manager (0 blockers, 7 should-fix) and security-reviewer (3 blockers: brand-name spirits with
  missing/0 ABV passed as mocktails; energy-drink warning only knew a few brands; raw-egg exemption read the whole
  text) – all fixed with regression tests, plus lock release on disconnect, image-bomb guard, EXIF stripping of kept
  photos, failed photo deletion retried with the account cascade, production guard for the ai-service link,
  provider-specific AI notice, installer signature check. Legal: in-app report of AI output (Google Play policy),
  consent record for the photo opt-in, legal-approved notice/consent/disclaimer texts, misleading marketing strings.
- Emulator test NOT run: copying the git-ignored `.env`, `server/.env`, service account and dev DB from the main
  checkout into this worktree was blocked by the permission classifier (and listing AVDs afterwards). Replaced by an
  end-to-end API run against the real server + real model (`ai-service/eval/e2e_api.mjs`). Needs John (see PR).
- Scan eval (153 photos, qwen3-vl:4b, 768 px): see EVAL_REPORT.md. Label review of 18 OFF rows (`review_labels.py`).
- Evaluation rounds 2-3: prompt taxonomy clarifications (one round, same test set – noted in EVAL_REPORT), red-team
  fixes (Romanian inhalation wording, alcohol in ml only, mislabelled "mocktails" dropped as S9, alcohol-free
  qualifiers, gin-free mocktail allowed for a scanned spirit), OFF generic spirit tags + one retry, per-recipe
  validation in the ai-service, one engine retry on an unusable answer. Scan 82.7 % (reviewed labels, target 85 %),
  p50 2.4 s; real pipeline mocktail 16/20; 0 safety violations after validation in every round.
- Final checks: server suite 1343 tests / 1342 pass / 0 fail / 1 skipped (the last engine change was verified with
  ai-v1 24/24 and ai-safety 41/41 on a separate port); ai-service pytest 24/24; `npm run check` clean;
  end-to-end API run with the real model 17/17.
