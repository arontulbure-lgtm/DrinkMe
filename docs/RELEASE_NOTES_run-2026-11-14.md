# Release notes: branch `auto/run-2026-11-14`

Autonomous run of 2026-11-16, merged into `main`. Goal: finish everything in `docs/JOHN_TODO.md` and the open items of the previous release that do not need John. What is left for John is the new, short `docs/JOHN_TODO.md`.

## Checks at merge
Server tests: full run 1319 passed, 8 skipped (Postgres integration without TEST_DATABASE_URL), 2 failed (owner-view field lists missing the new termsVersion); both fixed and re-run (90/90), so 1321 of 1321 run tests pass. Postgres tests against Docker: 25 passed, 1 skipped (SIGTERM on Windows). npm run check: 0 errors, 0 warnings. npm run docker:smoke: all checks passed. gitleaks (all branches, 91 commits): no leaks.

## Security
- **App Check slot (SEC-I):** server `APP_CHECK_MODE` off | monitor | enforce on `/api` (firebase-admin verification, production refuses a typo); app `EXPO_PUBLIC_APP_CHECK_ENABLED` + token-provider slot in `apiFetch`. Plan: `docs/APP_CHECK_PLAN.md` (native provider needs a development build).
- **Maps key:** Places requests send `X-Android-Package` / `X-Android-Cert` (`EXPO_PUBLIC_ANDROID_CERT_SHA1`) / `X-Ios-Bundle-Identifier`, so the key can be app-restricted; Google's raw error text is never shown; Place Details no longer asks for coordinates.
- **Password policy:** Firebase's `password-does-not-meet-requirements` maps to a clear ro/en message naming the rules (same rules as the app and the console policy).
- **Key files:** `npm run official:keys` (which key is in use, project ids only), `npm run firebase:use-key` (switch the server key safely).
- **Production logs** without IP address, user agent or referrer (legal T-05).
- **Docker image** ships only the production scripts and modules (`docker-build.test.js`), smoke-tested with `npm run docker:smoke`.
- Security review of the run: no BLOCKER; all SHOULD-FIX items fixed (durable critical saves, verified TLS, history retention, provider backups).

## Database (DATA-1)
- `DB_DRIVER=json` (default, unchanged) or `postgres` (`DATABASE_URL`, `DATABASE_SSL`): whole document as JSONB with hourly history (28 days), ordered write-behind, durable waits for account deletion, session revocation and suspensions, one server per database (advisory lock), verified TLS in production.
- `db:migrate-to-postgres`, `db:export-from-postgres`, backups from Postgres, `test:postgres` (throwaway Docker Postgres).

## Legal (Phase 0/1 without open decisions)
- T-01/T-02: Legal & help section (Edit Profile), agreement line on sign-in, full-policy link on the notice; hidden until `EXPO_PUBLIC_LEGAL_BASE_URL` (D-06). Contact always shown.
- T-04: "Powered by Google", no raw Google errors.
- T-05: logs without IP/UA.
- T-06/T-07: Terms acceptance with `TERMS_VERSION` (server, audited) and a Terms step in the app behind `EXPO_PUBLIC_TERMS_STEP_ENABLED` (D-01).
- Status per task: `docs/legal/CODE_GAPS_PLAN.md`.

## Store and hosting prep
- `docs/store/`: listings (en/ro), Apple privacy labels, Play Data safety, age-rating answers (Apple now 18+ tier), what to paste where.
- `docs/public/`: static en/ro legal site (privacy, terms, account deletion, guidelines, …) from `docs/legal`, draft banner until the lawyer's OK.
- `app.config.ts`: home-screen name DrinkMe; unused photo-library-add permission removed.
- `docs/PRODUCTION_ENV.md`: variables, first deploy, backups, monitoring for any Docker host.

## Device checks
`docs/DEVICE_CHECKS.md`: 1a, 1b, 1c and section 2 marked PASS / PARTLY / NEEDS-JOHN with dates. New today: 1c moderation 8/8 PASS (temporary admin test user), email verification server steps 2, 3, 5, 6, 9, 10 PASS, sign-in screen 1a 5, 6, 15-19 PASS, 1b 3/7 PASS. Tools: `npm run testapi` (login/call/verify-link/reset-password/disable/delete-unverified as test users), `npm run testusers:create|reset|delete` (four users, test4 is the session-only admin).

## Known open items
- Everything in the new `docs/JOHN_TODO.md` (key moves and rotation, decisions, consoles, real devices, host, stores, lawyer).
- Legal T-03 and T-08 onwards wait on decisions (see the plan's status table).
- Postgres mode: crash-time loss window for non-critical writes, SIGTERM flush test unverified on Linux, a lost lock connection is logged not prevented.
- Lows from earlier device runs (name-less users shown as "DrinkMe user", `GET /api/friends/count` 401 after logout, tip text overflow, keyboard on other modal screens).
