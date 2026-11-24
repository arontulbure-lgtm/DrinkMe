# Launch readiness: DrinkMe 1.0.0 (release candidate rc1)

State on 2026-11-23, branch `auto/launch-2026-11-17` → `main`, tag `v1.0.0-rc1`.

**Verdict: technical GO for the release candidate. Public launch is NO-GO until the owner items in section 3 are done.** The code, tests and builds are ready. What is missing is outside the code: lawyer sign-off, hosting, store accounts, keys and artwork.

## 1. What passed
| Check | Result |
|---|---|
| Server test suite (`cd server; npm test`, node:test, includes route coverage, the production startup guards, the Docker allowlist and the client source guards for i18n, a11y and release config) | 1264 pass, 0 fail, 8 skipped (section 4) |
| ai-service tests (`npm run ai:test`, pytest) | 31/31 |
| Client typecheck + lint (`npm run check`) | typecheck clean; lint 0 errors, 16 warnings (React Compiler rules, post-launch, `docs/DEPENDENCY_PLAN.md`) |
| Schema contracts app ↔ server ↔ ai-service (`export_schemas.py --check`, enum comparison) | identical, schemaVersion 1 |
| Expo SDK 58 upgrade (55 → 56 → 57 → 58, one SDK at a time) | expo-doctor clean at every step; full server suite 0 fail at every step |
| Production bundles (`expo export`, Android and iOS) | build; no dev log bridge, note button or test strings in the bundle |
| ai-service Docker image (`ai-service/Dockerfile`) | builds; non-root; compose config valid (server, `ai` and `postgres` profiles) |
| Server Docker smoke test (`npm run docker:smoke`) | 7/7 (healthz, readyz, /api 401, /__dev 404, non-root) |
| Emulator end-to-end on SDK 58 with `AI_PROVIDER=local` (session `2026-11-23_13-32-35`, report `reports/test-sessions/2026-11-23_13-32-35.md`) | no crash, no red box, no server 5xx; every automatable flow passed (sign-up, age gate, session restore, posts, cheers, comments, report, block, partners, notifications, search, profiles, ro/en, Smart Bar, AI notice, scanner, recipes streamed, save, AI report, barcode API, daily limit) |
| SDK 58 regressions found in that run | 2, both fixed and re-checked (Google button active in Expo Go 58; text overflow on post detail) |
| Security review (whole app + launch changes) | no BLOCKER; every SHOULD-FIX fixed (Apple sign-in nonce, Android backup off, per-user API limiter with an IP ceiling, compose pins production mode and binds loopback, AI provider rules) |
| Integration review after the AI merge | no BLOCKER; doc fixes applied |
| Legal final pass | AI sections in Privacy Policy and Terms (en/ro), compliance matrix with a go/no-go section, store disclosures; public pages rebuilt (16 per language) |
| i18n en/ro | 100 % key parity, no empty strings, no hard-coded UI text (enforced by a test) |
| Accessibility | every icon-only button has a label (enforced by a test) |
| Dependency audit, production dependencies | server: 0 high. App: 4 high, all in the Firestore → gRPC chain of the firebase SDK; the app never imports Firestore, so that code is not in the bundle; fixed by firebase 13 (post-launch plan) |

## 2. Known issues accepted for rc1 (none is a crash, high or medium in code)
| # | Severity | Issue | Plan |
|---|---|---|---|
| 1 | medium (configuration) | Places location search answers "Unable to load suggestions" for every query | Maps key: new restricted key (JOHN_TODO §2.1). The code sends the right headers |
| 2 | low | AI: an all non-alcoholic Smart Bar produced one recipe labelled "~0.4 % ABV" (the server keeps the higher, safer ABV on purpose) | Product/legal decision: keep the conservative label or treat trace ABV as 0 |
| 3 | low | Explore: Trending and search ignore the category chip; "Discover" heading twice | post-launch |
| 4 | low | Romanian "norocuri" for cheers | wording decision |
| 5 | low | CreatePost: Android Back discards a filled draft without asking | post-launch |
| 6 | low | Post card has no "Non-alcoholic" label (the detail shows it) | post-launch |
| 7 | low | AI recipe quality: near-duplicates across batches; Romanian prose from the 4B model has mistakes (the disclaimer says so) | AI track next steps (`docs/ai/EVAL_REPORT.md`) |
| 8 | low | Scan accuracy 76 % on the held-out Romanian set (target 85 %) | accepted for beta by the AI track; Romanian brand list next |
| 9 | low | 16 React Compiler lint warnings | post-launch refactor |

## 3. Go / no-go: what only John can do (in this order)
Blocking a **public** launch:
1. **iPhone Expo Go test** (Expo Go 58 from the App Store): JOHN_TODO §0.
2. **GPS in post photos:** the server now strips photo metadata (2026-11-23, `server/imageMetadata.js`). Confirm on the iPhone with a geotagged photo that no location survives.
3. **Lawyer sign-off** of `docs/legal`, `docs/public` and `docs/store` (D-01). Then remove the draft banner and noindex.
4. **Host the legal pages** (D-06). Set `EXPO_PUBLIC_LEGAL_BASE_URL` and, after D-01, `EXPO_PUBLIC_TERMS_STEP_ENABLED=true` in the EAS production environment.
5. **Company data** in imprint and terms (CUI and Trade Register number, D-17). **Launch countries** limited to 18+ markets (D-02/D-03).
6. **Explore "partners offer discounts" card** (D-18): approve its removal (T-03).
7. **Hosting:** choose the host and the EU region, set up Postgres or the volume, use HTTPS, and set all production variables (`docs/PRODUCTION_ENV.md`). This includes `AI_PROVIDER=off` (or `local` once the EU GPU host runs) and log and backup retention of 30 days or less. Guides are in `docs/deploy/`.
8. **Keys:** a new restricted Maps key (this fixes Places), the Firebase web key restriction, and the `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` of the current project (JOHN_TODO §2).
9. **EAS:** replace the API URL placeholder in `eas.json` and create the EAS environment variables (`docs/RELEASE_BUILD.md`).
10. **Artwork:** 1024×1024 icon, adaptive icon, splash logo, Play icon and feature graphic. Confirm the licence of the current glass drawing.
11. **Store accounts** (Apple $99/year, Google $25). Enable **Sign in with Apple** in Firebase if Google sign-in ships on iOS (Apple 4.8). First `eas build --profile preview`. Fill in the listing, privacy labels, Data safety and age rating (`docs/store/`). Write the review notes with a review account created in the release build.
12. Before launch: `npm run testusers:delete`. Also remove the throwaway e2e accounts (`drinkmesocialapp+e2e…@gmail.com`) by hand in the Firebase console.

Not blocking (accepted risks if John agrees): per-country age check, in-app report outcomes, the objectionable-word filter, data export, App Check (off at launch), and the AI GPU host (AI can be switched on later from the server without a new app build).

## 4. Final test run (2026-11-23, commit bfdde89)
| Suite | Result |
|---|---|
| Server (`cd server; npm test`) | 1272 tests: 1264 pass, **0 fail**, 8 skipped (Postgres integration, which needs `TEST_DATABASE_URL`) |
| ai-service (`npm run ai:test`) | 31 pass |
| `npm run check` | typecheck clean, lint 0 errors |
| Docker smoke (`npm run docker:smoke`) | 7/7 on the merged server image |
| Emulator e2e | session 2026-11-23_13-32-35: no crash/high/medium code issue left open |
