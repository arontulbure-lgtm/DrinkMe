# Local AI – rollout and rollback

Order is always **ai-service → server → app**, and switching off is always **server first**. Reviewed by the
integration review on 2026-11-16. Contracts: `.claude/skills/drinkme-ai-service/SKILL.md`.

## Flags
| Flag | Where | Default | Role |
|---|---|---|---|
| `AI_PROVIDER` | server env | `off` | Master switch: only exactly `local` turns AI on. The OpenAI provider and the legacy `AI_ENABLED` server switch were removed (D-24); `openai` or `AI_ENABLED=true` now only log a warning |
| `AI_PHOTO_OPT_IN_ENABLED` | server env | off | Offers the photo opt-in. Off at launch (D-21/D-22); while off, kept photos and old opt-ins are removed at start |
| `AI_DAILY_SCAN_LIMIT` / `AI_DAILY_RECIPE_LIMIT` | server env | 20 / 10 | Per-user daily limits (cost control) |
| `AI_ENABLED` | `src/screens/ScannerScreen.tsx` | `true` | Client kill switch for the scanner |
| `AI_RECIPES_ENABLED` | `src/screens/SmartBarScreen.tsx` | `true` | Client kill switch for recipes |
The app shows the real flows only while its kill switch is on **and** `GET /api/ai/status` says `available`. No flag
is ever deleted; the "coming soon" previews stay.

## Rollout
1. **ai-service** on loopback or a private network; `AI_SERVICE_TOKEN` (32+ chars) whenever it is not loopback (the
   service refuses to start otherwise). Pull the model, check `GET /v1/health` → `status: ok`, `schemaVersion: "1"`.
   No traffic yet: the server does not call it.
2. **Server**: set `AI_PROVIDER=off` explicitly, run `npm run backup`, deploy. Check `GET /api/ai/status` →
   `available: false, provider: 'off'`; `/api/ai/scan` and `/api/ai/recipes` → 503 `ai_disabled`; barcode, saved
   recipes and reports work. Store apps built from main never call `/api/ai/*`.
3. **App**: release the binary with expo-camera (both kill switches true). With the server flag off users still see
   the previews; against an older server the Saved › Recipes switch stays hidden (no status answer → not shown).
4. **Turn on**: `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `AI_PROVIDER=local` (optional `AI_RATE_LIMIT_PER_HOUR`,
   `AI_SERVICE_TIMEOUT_MS`), restart the server. The app follows within ~30 s (React Query `staleTime`), no app update.
   Before real users: the legal items in `docs/legal/compliance-matrix.md` LC-35…LC-48 (DPIA, store forms).

## Rollback
- **Feature**: `AI_PROVIDER=off` + restart. No data lost; barcode, saved recipes and reports stay up.
- **ai-service down**: nothing to do. Health fails → `available: false` → the app shows the preview within ~10 s
  (health cache) + ~30 s (app cache). In-flight requests end with `ai_unavailable` / `ai_timeout` and a retry button.
- **Server code back to main**: take a backup first. The old server drops `savedRecipesByUser` on its next save
  (saved AI recipes are lost) and no longer purges `AI_PHOTO_DIR` (delete that folder by hand). The new app keeps
  working against the old server (status 404 → previews; saved recipes hidden).
- **App**: no store rollback needed; the server flag controls everything the app shows.

## Changing the contract later
- Adding an enum value (category, status, warning) is additive: the app tolerates unknown values. Removing or renaming
  one, or a new required field, needs `schemaVersion` "2" served next to "1" (`/v2/*` on the ai-service).
- Changing the AI notice text in substance: raise `AI_NOTICE_VERSION` on the server (now 1) so
  users accept it again.
