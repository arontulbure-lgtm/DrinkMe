# Dependency plan (launch, 2026-11-22)

Source: `npm audit` and `npm outdated` in the root and in `server/` on branch auto/launch-2026-11-17, before the Expo SDK 58 upgrade.

## Security audit
| Where | High | Path | Launch blocker? | Plan |
|---|---|---|---|---|
| server | 0 | — | — | — |
| app | firebase → @grpc/grpc-js | Firestore code pulled in by the firebase JS SDK; the app uses Auth only | No: not reached at runtime | Fixed by firebase 13 (comes with or after the SDK 58 upgrade) |
| app | postcss | build-time only (tailwind/nativewind) | No: not shipped to devices | Goes with the SDK 58 upgrade / tailwind decision below |
| app | image-size | build tooling (expo/metro) | No | `npm audit fix` after the SDK 58 upgrade; re-audit |
| app (dev) | openai, zod via @jackchen_me/open-multi-agent | agent tooling devDependency | No: not in app or server builds | Excluded from the clean release export (Part C) |

Re-run `npm audit --omit=dev` in both packages after the SDK upgrade; the release gate is **0 high/critical in production dependencies**.

## Outdated majors – app
| Package | Now → latest | Plan |
|---|---|---|
| expo + all expo-* + @expo/metro-runtime, eslint-config-expo | 54 → 58 | **Launch step 7b** (one SDK at a time, `npx expo install --fix`). This supersedes the pinned versions of reanimated, worklets, expo-auth-session and expo-apple-authentication: they move to the versions SDK 58 requires |
| react-native-gesture-handler | 2 → 3 | Take the version `expo install --fix` picks for SDK 58; don't upgrade separately |
| @react-native-async-storage/async-storage | 2 → 3 | Same: follow the SDK 58 choice |
| firebase | 12 → 13 | After SDK 58; check the Auth persistence API (getReactNativePersistence) and re-test email/Google sign-in |
| typescript | 5.9 → 7 | Post-launch: TS 7 (native compiler) needs a tsconfig and tooling check; stay on the SDK 58-recommended version |
| eslint | 9 → 10 | With eslint-config-expo 58 in step 7b, if the config supports it; otherwise post-launch |
| tailwindcss | 3 → 4 | Post-launch: nativewind decides the supported tailwind major; don't upgrade separately |
| @babel/core | 7 → 8 | Follow babel-preset-expo for SDK 58; no separate upgrade |
| dotenv | 17 → 18 | Post-launch, low value (used only by app.config.ts) |
| @types/node | 25 → 26 | Match the Node runtime (22 LTS); no change needed |

## Outdated majors – server
| Package | Now → latest | Plan |
|---|---|---|
| express | 4 → 5 | Post-launch, its own PR: route path syntax (`*`, optional params), `req.query` getter, rejected-promise handling. The 1300+ server tests cover the routes; do it with a full test run |
| express-rate-limit | 7 → 8 | Post-launch with express 5 (keyGenerator / IPv6 helper changes) |
| helmet | 7 → 8 | Post-launch: default header changes; check the CSP and HSTS defaults in tests |
| dotenv | 16 → 18 | Post-launch, low value |
| openai | 4 → 7 | Remove if unused once AI runs on the local provider (decision D-24, checked in Part C); otherwise upgrade with the AI track |

## Rules
- One major per PR, with the full server suite or `npm run check` plus a device test.
- Never upgrade Expo-managed packages outside `npx expo install`.
- Install everything on D: (npm cache on D:).

## After the Expo SDK 58 upgrade (2026-11-23)
Done in four steps (55, 56, 57, 58), each with expo-doctor, typecheck, lint, a production export and the full server suite:
expo 58.0.x, React Native 0.88.1 (New Architecture only), React 19.3, TypeScript 6.0, reanimated 4.7.1, worklets 0.13.0,
gesture-handler 3.3, all expo-* on 58.x. `@expo/vector-icons` and `expo-font` are now declared directly (SDK 56 dropped
them from `expo`). The old version pins (reanimated ~4.1.1, worklets 0.5.1, expo-auth-session ~7.0, expo-apple-authentication
~8.0) are replaced by "Expo-managed versions move only through `npx expo install`".

Post-launch from the upgrade:
- React Compiler lint rules (`react-hooks/refs`, `set-state-in-effect`, `purity`) are warnings, 16 spots in 9 files
  (`eslint.config.mjs`). Refactor them, then turn the rules back to errors.
- firebase 12 → 13 (still open; re-test email and Google sign-in).
- Re-run `npm audit --omit=dev` and update the table above.
