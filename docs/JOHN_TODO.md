# What only John can do

Updated by the run of 2026-11-16. Everything that could be done without you is done (see the run log, `docs/DEVICE_CHECKS.md` for test results, and the git history for the earlier long checklists). Values in angle brackets are placeholders: never paste real keys into tracked files.

## 1. Now (10 minutes, PowerShell in `D:\DrinkMeApp\DrinkMeFinal`)
1. Rename the active key and point the server at it (Claude Code may not edit `server/.env`):
   ```powershell
   Rename-Item server\serviceAccount.a8fea.json.json serviceAccount-drinkmeapp-a8fea.json
   npm run firebase:use-key -- server\serviceAccount-drinkmeapp-a8fea.json   # prints MATCH
   ```
2. Move the old project's key out of the project folder (Claude Code's sandbox cannot write outside it):
   ```powershell
   New-Item -ItemType Directory -Force D:\DrinkMeApp\_old_secrets | Out-Null
   Move-Item server\serviceAccount.json D:\DrinkMeApp\_old_secrets\serviceAccount.drinkme-b2269.json
   npm run official:keys    # only the drinkmeapp-a8fea key, marked "in use"
   ```
3. `ANTHROPIC_API_KEY`: move it to your user environment variables (the `agents/` tool reads it), then `npm run env:remove -- ANTHROPIC_API_KEY`.
4. Delete `.env.before-firebase-*` and `server\.env.before-firebase-*` once the app works with drinkmeapp-a8fea (old project values inside).

## 2. Keys (consoles; full list with links: `docs/SECURITY_ROTATION.md`)
1. Maps key: new key restricted to Places API with a daily quota (e.g. 1,000) and a budget alert; after the first EAS build add the Android restriction (package `com.aroncarola.drinkmefinal` + the build's SHA-1) and the iOS one (bundle ID), and set `EXPO_PUBLIC_ANDROID_CERT_SHA1=<SHA-1>` in `.env` (the app already sends the headers).
2. Old Firebase project drinkme-b2269: delete its service-account keys (or the whole project).
3. Firebase web key of drinkmeapp-a8fea: restrict to the Identity Toolkit API and Token Service API.
4. OpenAI key: rotate, set a monthly budget; AI stays off.
5. `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`: replace with drinkmeapp-a8fea's Web client ID (Firebase → Authentication → Google → Web SDK configuration).

## 3. Decisions (each unlocks finished code)
| Decision | Unlocks |
|---|---|
| D-06 where the legal pages are hosted (e.g. GitHub Pages of `docs/public`) | set `EXPO_PUBLIC_LEGAL_BASE_URL=https://…`: legal links, sign-in agreement line, policy link appear |
| D-01 lawyer reviews `docs/legal` + `docs/public` + `docs/store` | `EXPO_PUBLIC_TERMS_STEP_ENABLED=true` (Terms step); remove the draft banner/noindex (`scripts/build-public-pages.mjs`) |
| D-18 remove the Explore "partners offer discounts" card | T-03 (Claude Code) |
| D-02/03/04, N-1, N-3, D-10 countries and age rules | per-country age gate T-08…T-12 (Claude Code) |
| Google sign-in: OK to add `@react-native-google-signin/google-signin` | native Google sign-in (docs/DEVICE_TEST_SESSION.md section G) |
| `REQUIRE_VERIFIED_EMAIL` on for the closed beta? | server side tested (DEVICE_CHECKS section 2); signs every app out once |
| JSON or Postgres in production | DATA-1 code is ready (`DB_DRIVER`) |

## 4. Firebase console
1. Authentication → Settings → User account linking: confirm "Link accounts that use the same email".
2. After a development build: App Check → register Android (Play Integrity) and iOS (App Attest) (`docs/APP_CHECK_PLAN.md`).

## 5. Real devices (results so far: `docs/DEVICE_CHECKS.md`)
Google sign-in and the takeover test (1a 7, 8, 20; 2.8), Apple (1a 9), two phones (1a 23), backend-off screen (1a 11), airplane mode (1a 17), a geotagged phone photo (1b 4), posts older than 7 days (1b 14), Resend on the Verify Email screen (2.4), a TalkBack/VoiceOver pass, and an iPhone run (needs a development build: App Store Expo Go no longer runs SDK 54).

## 6. Hosting (`docs/PRODUCTION_ENV.md`)
Choose the host, create the volume or the Postgres database, set the variables, deploy, check `/healthz`, schedule `npm run backup` daily, set provider/host backup retention to 30 days or less, set `EXPO_PUBLIC_API_URL` in the EAS profile.

## 7. Stores (`docs/store/README.md`)
Apple Developer ($99/year) and Google Play ($25) accounts; first `eas build --profile preview` (gives the SHA-1 for step 2.1); Sign in with Apple once Google sign-in ships on iOS (Apple 4.8); paste the listing, privacy labels, Data safety and age-rating answers; host `docs/public` and use its account-deletion URL; Play target audience 18+ only.

## 8. Lawyer
`docs/legal` (all drafts), the in-app privacy notice and Terms step texts, `docs/store`, `docs/public`; questions listed in `docs/legal/OPEN_DECISIONS.md`.
