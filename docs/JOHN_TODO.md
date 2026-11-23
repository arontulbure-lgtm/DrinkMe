# What only John can do

Updated by the launch run of 2026-11-23 (release candidate `v1.0.0-rc1`). Everything that could be done without you is done: see `docs/LAUNCH_READINESS.md` (go/no-go), `docs/DEVICE_CHECKS.md` and the run log. Items are in the order to do them. Values in angle brackets are placeholders: never paste real keys into tracked files.

## 1. iPhone Expo Go test (first; the app is on Expo SDK 58 now)
1. iPhone: update **Expo Go** in the App Store (58.0.5 or later). Same Wi-Fi as the PC.
2. Once, PowerShell **as administrator**: `New-NetFirewallRule -DisplayName "DrinkMe dev (Metro + API)" -Direction Inbound -Protocol TCP -LocalPort 5000,8081-8090 -Action Allow -Profile Private`
3. `npm run test:ios` in `D:\DrinkMeApp\DrinkMeFinal`, scan the QR code with the Camera app. If Expo Go hangs: iPhone Settings → Wi-Fi → (i) → Configure DNS → Manual → `1.1.1.1`, `8.8.8.8`.
4. Go through `docs/DEVICE_TEST_SESSION.md` section 4, plus the AI scanner (photo and barcode) and Smart Bar recipes (start with `AI_PROVIDER=local` in the shell; the session starts the AI service), then ask for the log triage.
5. While on the phone: post a photo taken **with location on**, open it from the feed and check that no GPS data is left (download from `/media/...`). If location survives, it becomes a launch blocker.

## 2. Local cleanup (PowerShell in `D:\DrinkMeApp\DrinkMeFinal`)
1. `ANTHROPIC_API_KEY`: move it to your user environment variables (the `agents/` tool reads it), then `npm run env:remove -- ANTHROPIC_API_KEY`.
2. Delete `.env.before-firebase-*` (old project values inside); the app runs on drinkmeapp-a8fea.
3. Test accounts: before launch run `npm run testusers:delete`, and delete the throwaway e2e accounts `drinkmesocialapp+e2e…@gmail.com` by hand in the Firebase console (Authentication → Users).

## 3. Keys (consoles; links in `docs/SECURITY_ROTATION.md`)
1. **Maps key (also fixes the location search, which fails for every query today):** new key restricted to the Places API with a daily quota (e.g. 1,000) and a budget alert. After the first EAS build, add the Android restriction (package `com.aroncarola.drinkmefinal` + the build's SHA-1) and the iOS one (bundle ID), and set `EXPO_PUBLIC_ANDROID_CERT_SHA1=<SHA-1>`.
2. Old Firebase project drinkme-b2269: delete its service-account keys (or the whole project).
3. Firebase web key of drinkmeapp-a8fea: restrict it to the Identity Toolkit API and the Token Service API.
4. OpenAI key: revoke it. The app no longer uses OpenAI (decision D-24).
5. `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`: replace it with drinkmeapp-a8fea's Web client ID (Firebase → Authentication → Google → Web SDK configuration).

## 4. Decisions (each unlocks finished work)
| Decision | Unlocks |
|---|---|
| D-01 lawyer reviews `docs/legal`, `docs/public`, `docs/store` | `EXPO_PUBLIC_TERMS_STEP_ENABLED=true` (Terms step); remove the draft banner and noindex (`scripts/build-public-pages.mjs`) |
| D-06 where the legal pages are hosted (e.g. GitHub Pages of `docs/public`) | `EXPO_PUBLIC_LEGAL_BASE_URL=https://…`: the legal links, the sign-in agreement line and the AI transparency link appear |
| D-17 CUI and Trade Register number | the imprint and the Terms |
| D-02/03/04, N-1, N-3, D-10: launch countries and age rules | the 18+ market list in both consoles; per-country age gate T-08…T-12 later |
| D-18 remove the Explore "partners offer discounts" card | T-03 (ready to do) |
| AI: an all non-alcoholic Smart Bar can get a recipe labelled "~0.4 % ABV" (the server keeps the safer, higher value) | keep the label, or treat trace ABV as 0 |
| Wording: Romanian "norocuri" for cheers | one string change |
| JSON or Postgres in production | `DB_DRIVER` is ready either way |
| `REQUIRE_VERIFIED_EMAIL` on at launch? | server side tested; signs every app out once |
| Google sign-in: OK to add `@react-native-google-signin/google-signin` | native Google sign-in (Expo Go cannot do it) |
| When to switch AI on: EU GPU host (LC-45) | `AI_PROVIDER=local` on the server, no new app build (`docs/deploy/EU_GPU.md`) |

## 5. Hosting (`docs/PRODUCTION_ENV.md`, guides in `docs/deploy/`)
1. Choose the host and the EU region, and create the volume or the Postgres database. HTTPS is required.
2. Set the variables. The server refuses to start without `AI_PROVIDER=off` (or `local` once the GPU host runs). Never set `NODE_ENV` in the env file.
3. Deploy, then check `/healthz` and `/readyz`.
4. Schedule `npm run backup` daily. Set host log retention and provider backup retention to 30 days or less.

## 6. Build and stores (`docs/RELEASE_BUILD.md`, `docs/store/README.md`)
1. Artwork:
   - a 1024×1024 icon without transparency
   - an adaptive-icon foreground with the glass inside the safe zone
   - a transparent splash logo
   - a 512×512 Play icon and a 1024×500 feature graphic
   - confirm the licence of the current glass drawing
2. `eas.json`: replace `https://api.example.invalid` with the real API URL. Create the EAS environment variables: Firebase, Google client ID, Maps key, and later the legal base URL and the Terms step.
3. Apple Developer ($99/year) and Google Play ($25) accounts. Then the first `eas build --profile preview`, which gives the SHA-1 for step 3.1.
4. Sign in with Apple: enable it in Firebase, then test it on the iPhone in a development or TestFlight build. Apple 4.8 requires it when Google sign-in ships on iOS.
5. Paste the listing, privacy labels, Data safety, age rating and review notes (`docs/store/`). Create the review account by signing up in the release build.
6. Screenshots: the drafts are in `D:\DrinkMeApp\_release\store-assets\`. Retake the Apple ones on the iPhone.
7. Firebase: confirm "Link accounts that use the same email". After a development build, register App Check (`docs/APP_CHECK_PLAN.md`).

## 7. Release repository
`arontulbure-lgtm/drinkme-release` (private) holds `DrinkMe 1.0.0-rc1` as one commit. Build store releases from it. To publish a new version: `npm run release:export`, then `docs/RELEASE_PROCESS.md`.

## 8. Still open on real devices (`docs/DEVICE_CHECKS.md`)
- Google sign-in and the takeover test (1a 7, 8, 20; 2.8)
- two phones (1a 23)
- the backend-off screen (1a 11)
- airplane mode (1a 17)
- posts older than 7 days (1b 14)
- Resend on the Verify Email screen (2.4)
- a TalkBack/VoiceOver pass
- a real barcode with the camera
