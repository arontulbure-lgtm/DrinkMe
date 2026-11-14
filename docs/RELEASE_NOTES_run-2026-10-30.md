# Release notes: branch `auto/run-2026-10-30`

Work from 2026-11-10 to 2026-11-14, merged into `main`. Beta app (Expo SDK 54, Express backend, Firebase Auth). Details per session are in `AUTONOMOUS_RUN_LOG.md`; decisions waiting for the owner are in `docs/legal/OPEN_DECISIONS.md` and `docs/JOHN_TODO.md`.

## Checks at merge
Server tests 1279/1279 (node:test, including the route-coverage guard and the source-level client guards); `npm run check` (TypeScript + ESLint) 0 errors, 0 warnings; gitleaks over all branches: no leaks (reviewed false positives in `.gitleaksignore`).

## Security and data protection
- **Sign-in:** Firebase ID tokens verified server-side; strong JWT secret required in production; one server session generation per account (a newer verified sign-in, a password reset, or disabling or deleting the Firebase user ends older sessions). The email takeover is closed. Every API and media route needs a session and the 18+ confirmation (route-coverage guard and gate tests for every route).
- **Input and abuse:** sanitising, rate limits per user and IP, upload size caps, storage limits.
- **Moderation:** reports, auto-hide after 3 distinct eligible reporters (48 h old accounts that accepted the notice), suspensions, blocks, admin endpoints, GDPR-minimal audit log (90 days).
- **Data:** atomic JSON persistence with backups (30-day ceiling), account deletion cascade (server + Firebase), privacy notice versioning.
- **Secrets:** gitleaks over the full history is clean (false positives recorded); key rotation list in `docs/SECURITY_ROTATION.md`; `.gitignore` covers every `.env` variant, service-account files, the Firebase web config, logs and reports.

## Features
- Edit post, drink categories and Explore filters, idempotent cheer and save with optimistic UI, notifications in ro/en, forgot password, fully localised UI (ro/en), error boundary, typed navigation.
- Official DrinkMe account: `OFFICIAL_USER_IDS`, Official badge, reserved brand names, exempt from auto-hide but still moderated.
- Post photos and avatars load on Android (expo-image with the session header; memory-only cache cleared on account change).

## Firebase
- The app's project is `drinkmeapp-a8fea`. `npm run firebase:configure` switches app and server together; `npm run official:check` / `official:find` / `official:set`; `npm run firebase:auth-check` (Email/Password on, enumeration protection on, password policy matching the app).
- Google sign-in: disabled in Expo Go by design; the current browser flow will not work in a development build either. Setup and the recommended native fix are in `docs/DEVICE_TEST_SESSION.md` section G (owner decision pending).

## Device testing
- `npm run test:android` / `test:ios` / `npm run emulator`: preflight, API server, Expo, live issue watcher, development-only client log bridge with a 📝 Note button, session folders in `logs/sessions/` (git-ignored).
- `log-triage` agent; `scripts/adb-ui.mjs` for scripted emulator tests; `npm run testusers:create|reset|delete`.
- Android emulator setup on Windows documented in `docs/DEVICE_TEST_SESSION.md`.

## Fixed from device tests
- Android: post photos and avatars were refused (401) because React Native Image drops headers; now expo-image (0837a8e).
- Empty Home feed: "Create first post" opened Explore (e4cb004).
- Sign In / Sign Up hidden behind the keyboard on Android; keyboard Go key now submits (faf3f72, 23a66f7).
- Post detail Cheer/Save never showed their state or the count (75d1097).
- Feed cards did not open the post detail (2b30d1b).
- App build: babel-preset-expo was no longer resolvable (d8eea14).
- Verified on the Android emulator (2026-11-14, scripted): sign-up with 18+ gate and notice, sign-in/out, forgot password, post with photo, feed and detail images, rating, comment, cheers, save, partner request and acceptance, notifications, report ×3 (no auto-hide from new accounts, as designed), block, Explore/search, Smart Bar, profile edit, ro/en switch, official badge, account deletion (gone from Firebase).

## Legal
Draft legal set (EN + RO), GDPR records, compliance matrix and a build plan for the code gaps (`docs/legal/`). All drafts need a lawyer before publication.

## Known open items
- Owner: rotate the keys in `docs/SECURITY_ROTATION.md`; move `server/serviceAccount.json` (old project) out of the repository folder; decide where `ANTHROPIC_API_KEY` lives (the `agents/` tool reads it from the root `.env`).
- Google sign-in needs a native implementation (decision + new dependency) and the client IDs listed in `docs/DEVICE_TEST_SESSION.md` section G.
- iPhone testing needs a development build (App Store Expo Go no longer runs SDK 54).
- Low issues from the device tests: name-less users shown as "DrinkMe user" (looks official), `GET /api/friends/count` 401 after logout, "What's next?" tip text overflow and AI copy while AI is off, keyboard avoiders elsewhere (comments, delete-account, note) untested with the soft keyboard on Android, dev log bridge screen name after Fast Refresh, card buttons without accessibility state, `.claude` project skill still describing `getImageSource` for images.
- Legal code gaps (`docs/legal/CODE_GAPS_PLAN.md`), real database and hosting (`docs/JOHN_TODO.md` section 4).
