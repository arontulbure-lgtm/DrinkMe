# Release build (v1.0.0)

How the store builds of the DrinkMe app are configured. Config lives in `app.config.ts` and `eas.json`; a source-level guard is in `server/test/client-source.test.js` ("release config").
Kept SDK-neutral: nothing here depends on Expo SDK 54 specifically, so it carries over to the later SDK upgrade.

## 1. Version and build numbers
| Field | Value | Where |
|---|---|---|
| App name | DrinkMe | `app.config.ts` `name` |
| Slug | DrinkMeFinal (Expo project id, do not change) | `slug` |
| Version (store "marketing" version) | 1.0.0 | `version` |
| iOS bundle id / Android package | `com.aroncarola.drinkmefinal` | `ios.bundleIdentifier`, `android.package` |
| iOS build number | "1" (starting value) | `ios.buildNumber` |
| Android version code | 1 (starting value) | `android.versionCode` |
| Runtime version | `{ policy: "appVersion" }` | `runtimeVersion` |

**Decision: `cli.appVersionSource: "remote"`.** EAS stores the build number / version code on its servers and the `production` profile has `autoIncrement: true`, so each production build gets the next number without a commit. Reasons: `app.config.ts` is a dynamic config, which EAS cannot rewrite for a local auto-increment; and two people building cannot collide on the same number. On the first build EAS offers to import the local values (`1`); accept. The local `buildNumber`/`versionCode` are then only used by local `expo prebuild` / `expo run:*`. To see or set the remote values: `eas build:version:get` / `eas build:version:set`.
For a new release, raise `version` in `app.config.ts` (1.0.1, 1.1.0 …); build numbers keep increasing on their own.
`runtimeVersion` only matters if `expo-updates` is added later (not installed now): with `appVersion`, an OTA update only reaches builds with the same `version`.

## 2. EAS profiles (`eas.json`)
| Profile | Use | Distribution | Android | iOS |
|---|---|---|---|---|
| `development` | dev client for local work (Google Sign-In needs it, not Expo Go) | internal | APK (dev client) | ad hoc / device |
| `preview` | testers | internal | **APK** (`buildType: apk`) | ad hoc (registered devices) |
| `production` | stores | store | **AAB** (`buildType: app-bundle`) | App Store |

All profiles extend `base`: `node: 22.23.4` (same major as the server, Node 22). `cli.version: ">= 16.0.0"`.
Each profile names an EAS environment (`development`, `preview`, `production`) for the `EXPO_PUBLIC_*` values (see §3).

### `EXPO_PUBLIC_API_URL` placeholder
Every profile has `env.EXPO_PUBLIC_API_URL = "https://api.example.invalid"`. **This is a placeholder: replace it in `eas.json` with the real HTTPS API URL before the first preview/production build.** `.invalid` never resolves, so a build that still has it fails on every request instead of talking to a wrong server. The API URL is public (it ships in the app), so it may stay in `eas.json`. Values in `eas.json` `env` win over EAS environment variables with the same name.

## 3. Build-time values (no secrets in eas.json)
`.env` is git-ignored, so EAS builders do not get it. Set the client values as EAS environment variables (visibility *plaintext* or *sensitive*; they are `EXPO_PUBLIC_*`, so they end up in the app bundle anyway and must never be real secrets):
```
eas env:create --environment production --name EXPO_PUBLIC_FIREBASE_API_KEY --value <value> --visibility sensitive
```
Needed for `preview` and `production`: `EXPO_PUBLIC_FIREBASE_API_KEY`, `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`, `EXPO_PUBLIC_FIREBASE_PROJECT_ID`, `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET`, `EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `EXPO_PUBLIC_FIREBASE_APP_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`, and when ready `EXPO_PUBLIC_ANDROID_CERT_SHA1`, `EXPO_PUBLIC_LEGAL_BASE_URL`, `EXPO_PUBLIC_TERMS_STEP_ENABLED` (plus any App Check values from `docs/APP_CHECK_PLAN.md`). Server secrets (`server/.env`, service-account JSON, OpenAI key, JWT secret) never go into EAS or `eas.json`.
The `development` profile's JS comes from the local Metro server, which reads the local `.env`.

## 4. Commands
```
eas build --profile preview --platform android      # APK for testers (also gives the signing SHA-1)
eas build --profile production --platform android   # AAB for Play
eas build --profile production --platform ios       # App Store build
eas submit --profile production --platform android|ios
```
`eas-cli` is not a project dependency; run it with `npx eas-cli@latest …` (nothing is installed globally).

## 5. Permissions
### iOS (Info.plist)
| Key | English base (`app.config.ts`) | Romanian (`locales/ro.json`) |
|---|---|---|
| NSCameraUsageDescription | DrinkMe needs the camera to photograph your drinks. | DrinkMe are nevoie de cameră pentru a fotografia băuturile tale. |
| NSPhotoLibraryUsageDescription | DrinkMe needs access to your photos to add drink images. | DrinkMe are nevoie de acces la fotografiile tale pentru a adăuga imagini cu băuturi. |

- Localized through Expo `locales` (`locales/en.json`, `locales/ro.json`, keys under `ios`), which writes `en.lproj/InfoPlist.strings` and `ro.lproj/InfoPlist.strings`. `CFBundleDevelopmentRegion: en`, `CFBundleLocalizations: [en, ro]`, `CFBundleAllowMixedLocalizations: true`. Do not use double quotes in these strings (Expo writes them unescaped).
- **No `NSPhotoLibraryAddUsageDescription`** (the app never saves to the library; removed on purpose).
- **No `NSMicrophoneUsageDescription`** (`expo-image-picker` `microphonePermission: false`; photos only).
- **No `NSFaceIDUsageDescription`** (`expo-secure-store` `faceIDPermission: false`; the token is stored without biometrics).

### Android (final merged list, from `npx expo config --type introspect` + the library manifests)
| Permission | Source | Why it stays |
|---|---|---|
| INTERNET | template | API, Firebase, Places |
| ACCESS_NETWORK_STATE | expo-image (library manifest) | Glide restarts failed image loads when the network returns |
| CAMERA | expo-image-picker | Take photo |
| READ_EXTERNAL_STORAGE | template + expo-image-picker | `requestMediaLibraryPermissionsAsync` asks for it on Android 12 and older; Android 13+ uses the system photo picker and asks nothing |
| WRITE_EXTERNAL_STORAGE | template + expo-image-picker | same call on Android 12 and older, and the camera on Android 9 and older |
| VIBRATE | template | normal (install-time) permission, not shown to users; left as is |

Blocked (`android.blockedPermissions`, merged with `tools:node="remove"`):
- `RECORD_AUDIO`: added by expo-image-picker unless `microphonePermission: false`; also blocked explicitly.
- `SYSTEM_ALERT_WINDOW`: Expo template, only for the dev menu overlay.

Not requested: READ_MEDIA_IMAGES / READ_MEDIA_VIDEO (so the Play "Photo and video permissions" declaration is not needed), location (Places search is typed text), notifications.
This list comes from the config and the npm packages' manifests; transitive Gradle (AAR) dependencies can add more. After the first build, confirm the final list in Play Console (App bundle explorer → Permissions) or with `aapt dump permissions` on the APK.
Possible later refinement: cap the two storage permissions with `android:maxSdkVersion="32"` through a small config plugin (they are ignored on Android 13+ anyway). Not done now to avoid a custom native mod before the first build.

### iOS App Transport Security
The SDK 54 prebuild template sets `NSAllowsArbitraryLoads: false` with `NSAllowsLocalNetworking: true`, so release builds need the HTTPS API URL (SEC-D). (`expo config --type introspect` shows `NSAllowsArbitraryLoads: true`, but that is only its fallback template, not what prebuild writes.)

## 6. Splash, icons and assets
`splash.backgroundColor` and `android.adaptiveIcon.backgroundColor` are `#000000` (brand background).

Asset check (2026-11-22): all four files are **the same image** (identical bytes): a pink/violet line-art cocktail glass on an opaque white background.
| File | Size | Format | Store requirement | Status |
|---|---|---|---|---|
| `assets/icon.png` | 510×529 | PNG RGBA (8-bit), no transparent pixels | iOS: 1024×1024, square, no alpha | **Undersized and not square** |
| `assets/adaptive-icon.png` | 510×529 | PNG RGBA, opaque white | Android adaptive foreground 1024×1024 (432 dp canvas), artwork inside the central ~66% safe zone, transparent around it | **Undersized, not square, no safe zone (artwork reaches the edges, will be clipped by the mask), white background covers the #000000 layer** |
| `assets/splash-icon.png` | 510×529 | PNG RGBA, opaque white | Centered logo, transparent background, ~1024×1024 recommended | **Undersized; its white box will show on the black splash** |
| `assets/splash.png` | 510×529 | same | not referenced by `app.config.ts` | unused |
| `assets/favicon.png` | missing | — | web only | not needed for the mobile release (`web.favicon` points to it) |
Play listing also needs a 512×512 icon and a 1024×500 feature graphic (`docs/store/README.md`).

## 7. Dev-only code in release builds
Checked with a production export (`npx expo export --platform android --no-bytecode`, then deleted): the bundle contains none of `devLogBridge`, `installDevLogBridge`, `/__dev/client-log`, `X-DrinkMe-Dev-Log`, `DevNoteButton`, `addDevNote`, `reportApiFailure`, or the test-note texts (en/ro). App.tsx loads the bridge and the note button with `__DEV__ ? require(…) : null`, so the release app starts without them. The test-note strings now live inside `DevNoteButton.tsx` (not `LocalizationContext.tsx`) so they leave with it. No other dev-only UI, test routes or debug menus exist in `src/`.
A local export inlines the local `.env` values; EAS builds use the profile's values instead.

## 8. John's items before the first store build
1. Replace `https://api.example.invalid` in `eas.json` (all three profiles) with the real HTTPS API URL.
2. Create the EAS environment variables listed in §3 for `preview` and `production`.
3. New artwork: 1024×1024 square icon without alpha; adaptive foreground 1024×1024 with transparent background and the glass inside the safe zone; splash logo on a transparent background; 512×512 Play icon and 1024×500 feature graphic. Confirm the licence of the current glass drawing (it looks like a stock icon) or replace it.
4. First `eas build` per platform: accept importing build number 1 / version code 1 to EAS; let EAS create the signing credentials (keep the Android upload key backed up in EAS).
5. Optional: consider `userInterfaceStyle: "dark"` (the app is dark-only; it is "light" now, which keeps system dialogs light).
