---
name: drinkme-project
description: Ground-truth facts about the DrinkMe codebase - stack, exact versions, folder structure, navigation, design system, feature flags, working rules. Use for any task that reads, writes, reviews or tests DrinkMe code.
---

# DrinkMe project context

Treat these facts as ground truth. Do not contradict them. If something needed for the task is not covered here, ask the user to paste the relevant file instead of assuming.

## Product
DrinkMe is a social beverage discovery mobile app ("Untappd meets Instagram") in beta / pre-launch, launching first in Romania. It covers alcoholic and non-alcoholic drinks. Users post drinks, rate them, comment ("cheers" = like), save posts, add drink partners, and manage a home bar inventory (Smart Bar).
Long-term goal: grow to a size where the app can be acquired. Code must stay clean, documented and transferable, and every technical decision should consider scalability.

## Location
- Project root: `D:\DrinkMeApp\DrinkMeFinal` (older docs say `C:\Users\Aron\DrinkMeFinal`; the D: path is current).
- External documentation (not in the repo): `D:\DrinkMeApp\` - BETA_CHECKLIST.md, SECURITY.md, DEPLOY.md, TECHNICAL_REFERENCE.md, QA_CHECKLIST.md, FUTURE_RELEASE_PLAN.md.
- GitHub: arontulbure-lgtm/DrinkMe
- Runs only locally (Windows). Not deployed.

## Architecture: two parts
1. **Mobile client** - React Native + Expo, TypeScript (strict).
2. **Backend** - Express.js server in `server/` (Node.js 22, ESM, `"type": "module"`), JSON-file persistence. See the drinkme-backend-api skill.
Firebase is used ONLY for authentication (client Firebase Auth + server-side firebase-admin token verification). Firestore and Firebase Storage are NOT used.

## Client stack (from package.json)
- expo ~54.0.0, react-native 0.81.5, react 19.1.0, typescript ~5.9.2
- @react-navigation/native ^7.1 + stack ^7.4 + bottom-tabs ^7.4
- @tanstack/react-query ^5.87 (server state / fetching)
- firebase ^12.2.1 (Auth only, web SDK)
- expo-auth-session ~7.0.11 (Google OAuth, PKCE), expo-apple-authentication ~8.0.4 (iOS)
- expo-secure-store (API token), expo-image-picker, @react-native-async-storage/async-storage
- react-native-reanimated ~4.1.1, react-native-worklets ^0.5.1, gesture-handler ~2.28
- Styling: React Native **StyleSheet**. nativewind/tailwind are installed but NOT used - do not introduce NativeWind classes.
- Google Places via REST fetch (no native maps SDK). OpenAI GPT-4o-mini via the server (disabled for beta).

### Critical versions - never change without explicit user approval and testing
- react-native-reanimated must stay ~4.1.1 (not 4.2+)
- react-native-worklets must stay 0.5.1 (not 0.9.x)
- expo-auth-session must stay ~7.0.x
- expo-apple-authentication must stay ~8.0.x

## Folder structure
```
DrinkMeFinal/
├── App.tsx, index.js, app.config.ts, eas.json, metro.config.js, babel.config.js
├── Dockerfile, .dockerignore ← backend image only; .dockerignore is an allowlist
├── .env                     ← client env vars (EXPO_PUBLIC_*), never commit or print
├── src/
│   ├── screens/    AuthScreen, HomeScreen, ExploreScreen, ScannerScreen, SmartBarScreen,
│   │               ProfileScreen, EditProfileScreen, CreatePostScreen, DrinkDetailScreen,
│   │               RecipeResultsScreen, LanguageSettingsScreen, PartnersListScreen,
│   │               SessionErrorScreen, VerifyEmailScreen, AgeGateScreen, OnboardingScreen,
│   │               BlockedUsersScreen
│   ├── components/ CommentDrawer, DrinkPostCard, LocationPickerModal, StoriesSection,
│   │               ListLoadState, LoadMoreButton, PostActionsSheet (Edit, Delete, Report, Block), ReportSheet,
│   │               ErrorBoundary (in App.tsx, inside LocalizationProvider; "Try again" clears the
│   │               React Query cache and remounts; logs the error name and component stack only),
│   │               DeleteAccountModal (shared by AgeGate and EditProfile),
│   │               ModerationNotice (hidden-content notice + SuspensionBanner),
│   ├── context/    AuthContext.tsx, LocalizationContext.tsx
│   ├── config/     firebase.ts
│   ├── lib/        api.ts  ← apiFetch wrapper, injects the JWT automatically; getImageSource
│   │               drinkCache.ts  ← React Query cache helpers for posts, comments, users
│   │               useDrinkToggles.ts + drinkToggleChains.ts ← the one cheer/save hook (optimistic)
│   │               authErrors.ts  ← Firebase error code → auth.errors.* key (pure)
│   │               passwordReset.ts ← forgot-password helpers, 60 s cooldown (pure)
│   │               formatTimeAgo.ts ← the one "time ago" label for posts and comments (pure)
│   │               useConfirmAge.ts, usePartnerAction.ts, useRefreshIfSuspended.ts
│   ├── types/      api.ts  ← all shared types, incl. the drink category lists
│   └── navigation/ AppNavigator.tsx, types.ts (param lists, global RootParamList)
├── server/
│   ├── server.js            ← Express backend (all routes)
│   ├── README.md            ← setup, routes, env vars, backups, moderation, Docker
│   ├── scripts/backup.js    ← scheduled backup (`npm run backup`), shipped in the Docker image
│   ├── test/                ← node:test suites and helpers; helpers/routes.js holds ROUTE_MANIFEST
│   ├── data/db.json         ← JSON persistence (gitignored)
│   ├── serviceAccount.json  ← Firebase Admin key (gitignored) - never read or print
│   └── .env                 ← server secrets - never read or print
└── agents/                  ← older experimental multi-agent scripts (open-multi-agent); ignore unless asked
```

## Navigation
`AppNavigator.tsx` checks these in order:
1. `sessionStatus === 'loading'`: spinner.
2. Age gate (hard): `AgeGateScreen` while `profile.ageConfirmed !== true`. There is no "decline": the only actions are Confirm, Log out and Delete account (`DeleteAccountModal`). Nothing else mounts before the confirmation, because the server refuses every other route with 403 `age_required` (see `requireSignedInAdult` in the backend skill).
3. Onboarding: `OnboardingScreen` while `profile.privacyNoticeVersion` is below `PRIVACY_NOTICE_VERSION` (cannot be skipped), then the name prompt while `profile.needsName` ("Later" lasts for this session).
4. The stack:
```
Stack Root (headerShown: false)
├── Auth (signed out)
├── SessionError (sessionStatus 'error': Retry and Log out)
├── VerifyEmail (sessionStatus 'verification_required')
└── Main (sessionStatus 'ready')
    ├── TabNavigator: Home, Explore, Scanner, SmartBar, Profile
    ├── CreatePost (default card presentation, headerShown: false; `{ drinkId }` opens it in edit mode)
    ├── DrinkDetail, EditProfile, PartnersList, BlockedUsers
    ├── RecipeResults (modal), LanguageSettings (modal)
    └── UserProfile (reuses ProfileScreen; its X button must call navigation.goBack(), not navigate('Profile'))
```
Steps 2 and 3 render outside the stack and only once the session is `ready` with a profile, so the effective order is: session, verify email, age gate, onboarding, Main.
Navigation is typed: route params live in `src/navigation/types.ts` (`TabParamList`, `RootStackParamList`, global `RootParamList`); no `any` on navigation props. A stack screen reaches a tab with `navigate('Main', { screen: 'Scanner' })`, never `navigate('Scanner')` (React Navigation 7 ignores that).

## Session and cache (src/context/AuthContext.tsx)
- `SessionStatus` is `'loading' | 'ready' | 'error' | 'verification_required'`. `'ready'` also covers signed out. `isAuthenticated` only means a Firebase user exists; the API works only when the status is `'ready'`.
- Main opens only with a JWT the server accepted and a loaded profile. Each session step times out after 15 seconds. A 401 or 403 from the server deletes the stored JWT. `'verification_required'` only comes from the server's `email_not_verified`, so it never appears while `REQUIRE_VERIFIED_EMAIL` is off.
- Stale JWT: a 401 on the JWT in use while the session is `ready` (for example after a verified sign-in elsewhere raised the session generation) calls the handler set with `setStaleTokenHandler` (src/lib/api.ts), and AuthContext re-runs the exchange, at most once per 30 seconds. The stored-token check at session start uses `GET /api/users/:id` (own id) and accepts the JWT only if the answer holds `ageConfirmed` (owner-only field).
- Suspension: the owner's profile carries `suspendedUntil` (null when permanent) and `suspendedPermanently` while suspended, and `hiddenPendingReview` while the profile is hidden after reports. `SuspensionBanner` shows on Home and own Profile. A 403 `account_suspended` maps to `moderation.actionBlocked`; `useRefreshIfSuspended` refreshes the profile so the banner appears.
- When the user changes, queries are cancelled and the React Query cache is cleared in the same tick.
- `isCurrentAuthUser(uid)`: cancelling queries does not stop mutations, so every mutation callback that writes to the cache first checks `isCurrentAuthUser(serverUserId)` with the id it was created for. The `drinkCache.ts` helpers assume the caller did this, except `removeDrinkIfNotFound`, which checks itself.
- Lists are paged (`useInfiniteQuery` with `{ items, nextCursor }`). `drinkCache.ts` holds `getNextCursor`, `flattenPages`, `trimToFirstPage` and `trimAndInvalidate` (trim before refetching, because a refetch costs one request per loaded page against 100 requests / 15 min), `syncSavedList`, `prependDrink`, `updateDrinkInCaches`, `removeDrinkFromCaches`, `findCachedDrink`, `removeCommentFromCache`, `removeUserFromCaches` (after a block), `invalidateDrinkQueries`, `invalidateAuthorQueries`, `invalidateAfterPartnerRequest`, `invalidateAfterPartnerChange`, `setPartnerStatusInCaches`, `invalidateAfterUnblock` and `removeDrinkIfNotFound`. Use them instead of writing cache keys by hand.
- Images: always render API image paths through `getImageSource()` (src/lib/api.ts). It sends the JWT only to this server's `/media` routes (which need a signed-in, 18+ confirmed user) and gives other URLs empty headers, so Android cannot resend the token to Google.
- Hidden after reports: posts and comments with `hiddenPendingReview: true` reach only their owner and admins; show `ModerationNotice` (`moderation.hiddenPost`, `moderation.hiddenComment`, `moderation.hiddenProfile`).
- Failed lists show `ListLoadState` with Retry, never an empty state.
- Cheer and save: always through `useDrinkToggles` (src/lib/useDrinkToggles.ts), used by Home, Explore, Profile, DrinkDetail and Smart Bar Saved. It updates every cached list optimistically, sends the target state (`{ cheered }` / `{ saved }`), serializes requests per post, lets the last request to settle write the cache, and rolls back on failure. Its shared state (`drinkToggleChains.ts`) is reset together with the query cache.
- Categories: `ALCOHOLIC_DRINK_CATEGORIES` (cocktail, wine, beer, spirits) and `NON_ALCOHOLIC_DRINK_CATEGORIES` (mocktail, coffee, tea, other) in `src/types/api.ts` must equal `DRINK_CATEGORIES` in server.js (a server test checks it). CreatePost's picker follows the alcoholic toggle; Explore chips query `GET /api/drinks?category=`; labels are `categories.*`.
- Edit post: Edit in `PostActionsSheet` opens CreatePost with `{ drinkId }` (prefilled from the cache; sends only changed fields; the image cannot change). Edited posts show an "edited" label (`post.edited`).
- Auth errors: every Firebase error goes through `src/lib/authErrors.ts`; never show `error.message`. Wrong password, unknown email and invalid credential share one message, social sign-in never shows it, and cancellations show nothing.
- Forgot password: AuthScreen's "Forgot password?" calls `AuthContext.sendPasswordReset` (Firebase `sendPasswordResetEmail`, in the app's language). The same neutral confirmation for any account state; a 60 s cooldown after every outcome except invalid email and network errors (survives remounts, resets on app restart). The cooldown is UX, not a security control. A reset does not end the server JWT (open item).
- Times: `formatTimeAgo` (src/lib/formatTimeAgo.ts) for every "time ago" label; 7 days or older shows a short date in the app's locale.

## Feature flags
| Feature | Flag | Default | File |
|---|---|---|---|
| Stories | STORIES_ENABLED | false | HomeScreen.tsx |
| AI Scanner | AI_ENABLED | false | ScannerScreen.tsx |
| AI Recipes | AI_RECIPES_ENABLED | false | SmartBarScreen.tsx |
| AI routes (server) | AI_ENABLED env var | off; on only for exactly `true` | server/server.js |
| Partner consent (server) | PARTNER_CONSENT_REQUIRED env var | on; `false` is an emergency rollback that makes partner lists effectively public | server/server.js |
| Email verification (server) | REQUIRE_VERIFIED_EMAIL env var | off; do not turn on before a real Firebase test. The takeover guard (session generation + auth floor) works with it off | server/server.js |
| Privacy notice | PRIVACY_NOTICE_VERSION = 2 | must match the server | OnboardingScreen.tsx and server/server.js |
Details and warnings for the server switches: drinkme-backend-api skill.
Never delete AI features - disable them with a flag and show a "Coming soon" preview.

## Design system
Background #000000 · Primary #8B5FBF · Cards #1F2937 · Cards dark #0F172A · Text #FFFFFF · Text muted #9CA3AF · Text dim #6B7280 · Danger #EF4444 · Warning #FFD700 · Border #374151

## Localization
Custom LocalizationContext. Romanian (ro) and English (en) are complete; other languages exist but are empty. Every new UI string needs both ro and en.
- The privacy notice text is under `onboarding.privacy*`. It describes the server's read rules (who sees what: nothing without signing in, hide after reports, suspensions, kept anonymised open reports, the 30-day backup rule), so it must change whenever those rules or `PARTNER_CONSENT_REQUIRED` change; raise `PRIVACY_NOTICE_VERSION` on both sides when it changes in substance. It has not had a legal review.
- The account deletion warning (`deleteAccount.warning`) says the account leaves "our backups" within 30 days: in-server backups 21 days plus the 7-day recovery hold, with a hard 30-day ceiling, and `npm run backup` keeps at most 28 days. Host snapshots must be kept 30 days or less for this to stay true.
- Age gate strings: `ageGate.confirm`, `ageGate.leaveHint`, `ageGate.logout`, `ageGate.deleteAccount` (no `ageGate.decline`). Moderation strings: `moderation.*`.
- Notifications are written on the client from `params` (`actorName`, `drinkName`, `variant`) with the `notifications.*` templates (`getNotificationText` in HomeScreen); the server's English `message` is the fallback for older apps and unknown types. `t()` replaces placeholders in one pass, so user text such as `{{drink}}` or `$&` is inserted as typed. The Smart Bar limit message hardcodes 500.
- Every AuthScreen string is `auth.*`; icon-only buttons need `accessibilityRole`, a ro/en `accessibilityLabel` and a 44 px target (`hitSlop`).

## Working rules (agreed with the user)
1. Keep the current structure; do not rewrite the architecture without a strong reason.
2. Keep the color theme above.
3. Keep existing variable names.
4. Major structural changes only when absolutely necessary, and ask first.
5. All code in English; comments and UI strings may be RO/EN.
6. Never delete AI features; disable with a flag.
7. Never read, print or commit `.env`, `server/.env` or any service-account JSON.

## Running locally (the user runs these)
- Backend: `cd server` then `node server.js` (port 5000; expect "[firebase-admin] ✅ Initialized"). `server/.env` must set `NODE_ENV=development` locally; any other value, or none, applies production rules. Env vars and Docker usage: `server/README.md`.
- App: `npx expo start` (Metro port 8081); phone via Expo Go on the same Wi-Fi
- Type check: `npm run typecheck` · Lint: `npm run lint` · Both: `npm run check` (server tests stay separate)
- Backend tests: `cd server` then `npm test` (node:test and fetch, no extra dependency). Over 1165 tests taking about 14 minutes. They use port 5055 and a temp database, so only one run at a time.
- Backup: `cd server` then `npm run backup` (daily on a real host; see `server/README.md`).
- Client tests: no test framework is installed yet. A jest-expo proposal (first targets: authErrors, passwordReset, formatTimeAgo, drinkToggleChains, ro/en key parity) is in `AUTONOMOUS_RUN_LOG.md` under Tier 5; it needs the user's OK because it adds dependencies.
- Expo Go limitation: Google Sign-In is disabled in Expo Go (IS_EXPO_GO check); it needs a development build.
