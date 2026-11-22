# App Check plan (SEC-I)

Goal: only the real DrinkMe app (not scripts holding the public API keys) can call the DrinkMe API and Firebase Authentication, before the public launch. Written 2026-11-16.

## Done (works without a development build)
- **Server:** `APP_CHECK_MODE` = `off` (default) | `monitor` | `enforce` checks the `X-Firebase-AppCheck` header on every `/api` request with firebase-admin (`server/app-check.js`). Monitor counts valid / missing / invalid tokens and logs a summary line every 15 minutes; enforce answers 401 `app_check_failed`. A mistyped value stops a production start. Tests: `server/test/app-check.test.js`.
- **App:** `src/lib/appCheck.ts` is the slot. With `EXPO_PUBLIC_APP_CHECK_ENABLED=true` and a registered token provider, `apiFetch` sends the header. Today no provider is registered, so nothing is sent.
- **Image:** `server/app-check.js` is in the Docker image (guarded by `docker-build.test.js`).

## Needs a development build (order)
1. **Owner:** Firebase console (drinkmeapp-a8fea) → App Check → register the Android app (Play Integrity; needs the app in a Play Console track and the SHA-256 of the signing key) and the iOS app (App Attest, with DeviceCheck as fallback; needs the Apple Developer account).
2. **Code (next run, needs the owner's OK for the dependency):** add `@react-native-firebase/app` + `@react-native-firebase/app-check` with their Expo config plugins (development build only, not Expo Go), initialise App Check at start with the Play Integrity / App Attest providers, and register `setAppCheckTokenProvider(() => appCheck().getToken().then((t) => t.token))`. Debug provider + debug token for the emulator and development builds.
3. **Firebase Authentication:** the app signs in with the Firebase JS SDK; to have Auth requests checked too, the JS SDK must get the token (`initializeAppCheck` with a `CustomProvider` that returns the native token). Then turn on **enforcement for Authentication** in the console (stops scripted password-reset floods on the shared email quota).
4. **Rollout:** ship with `EXPO_PUBLIC_APP_CHECK_ENABLED=true`, server `APP_CHECK_MODE=monitor`. Watch the `[app-check]` lines: when almost all requests are valid (old app versions gone), set `APP_CHECK_MODE=enforce` and enforcement in the console.
5. **Images:** `/media` requests (expo-image headers) are not checked yet; add the header in `getImageSource` once tokens exist, then extend the middleware to `/media`.

## Risks
- Enforce before every installed app sends tokens locks those users out: always monitor first.
- Emulators and rooted devices fail Play Integrity: testers use the debug provider.
- App Check is not authentication: the JWT and the 18+ gate stay as they are.
