DRAFT v0.1 – 2026-11-12 (§5 rewritten, §5a final and §1–2 updated 2026-11-13) – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Data inventory (internal)

Built from the code on branch `auto/run-2026-10-30` (HEAD `e90693b`), `server/README.md` and `AUTONOMOUS_RUN_LOG.md`, on 2026-11-12. Line numbers refer to that commit. `server/server.js` is being edited by another developer while this was written, so line numbers may shift; re-check before relying on them.
Secrets files (`.env`, `server/.env`, service-account JSON) and `server/data/db.json` were **not** read. Field lists come from the code that writes the records.

Controller: Tulbure Aron PFA (see `../imprint.md`). Contact: drinkmesocialapp@gmail.com.

## 1. Where data lives

| Store | What | Code |
|---|---|---|
| Server database: one JSON file (`DB_FILE`, default `server/data/db.json`) | Everything in section 2 | `server/README.md` "Data operations"; persistence in `server/server.js` |
| Server backups | Full copies of the database | `server/scripts/backup.js:29-30` (daily 7 days, weekly 28 days); in-server `.corrupt-*` / `.pre-migration-*` copies `server/server.js:4587-4612` (21 days), recovery hold `:4619` (7 days), hard ceiling `:4690` (30 days) |
| Server request log (stdout of the host) | IP address, time, method, path (query string and the account-deletion uid removed), status, size, referrer, user agent (morgan `combined` in production) | `server/server.js:239-244` |
| Firebase Authentication (Google) | Email, password hash (password users), provider ids (Google, Apple), display name and photo URL from the provider, sign-in metadata; the server reads `disabled` and `tokensValidAfterTime` with one `getUser` per sign-in (section 5) | `src/config/firebase.ts:20-22`; `server/server.js:135` (fields read from the verified token); `server/server.js:2630-2648` (lookup) |
| Phone (device) | API token, Firebase session, language choice, an email-verification cooldown record, cached images | section 4 |
| Google Maps Platform (Places API, called from the phone) | The place search text and the phone's IP address | `src/components/LocationPickerModal.tsx:66`, `:110` |
| Google user-content servers | Google profile photos are linked, not copied; other users' phones load them from `lh3`–`lh6.googleusercontent.com` | `server/server.js:2588-2631`, `server/README.md` (auth flow) |
| OpenAI (only if `AI_ENABLED=true`, currently **off**) | Photos for the scanner, Smart Bar ingredient lists | `server/server.js:4408` (`store: false`), `:4512-4548` |

No analytics, advertising, crash-reporting or push-notification SDK is installed (checked `package.json`: no `expo-notifications`, no analytics or Sentry packages). Notifications are in-app lists only.

## 2. Server records

| Record | Fields (personal data) | Source | Purpose | Visible to | Retention | Code |
|---|---|---|---|---|---|---|
| User | Firebase uid, email (from the verified token; placeholder `<uid>@drinkme.app` if none), first and last name, city, bio, avatar (uploaded image or Google photo URL), `createdAt`, `emailVerified`, `noticePending`, `privacyNoticeVersion` + time, `ageConfirmedAt` (no birth date), session generation and auth-floor timestamps, `federatedVerifiedAt`, `tokensValidAfterSeen` and `firebaseSessionEndedReason` (section 5), `nameReservedAtSignIn` (yes/no, temporary, section 5a), suspension state and history (dates, permanent/void flags, reason up to 300 chars, admin uid) | User, Firebase token, admins | Account, profile, security, moderation | Public profile (name, city, bio, avatar) to signed-in 18+ users after the owner accepts the notice (`toPublicUser`, `server/server.js:2144-2151`); email, age state and suspension only to the owner and the server | Until account deletion | `server/server.js:1087-1113`, `:2888-2932`, `:1717-1770` |
| Post ("drink") | Author uid, name, description, rating, location text (free text from Google Places, max 180 chars; no coordinates stored), alcoholic flag, category, photo (stored as data URL in the database), created/edited time | User | Core feature | Signed-in 18+ users not blocked, unless hidden after reports | Until the author or an admin deletes it, or account deletion | `server/server.js:3404-3460`, edit `:3612` |
| Comment | Author uid, post id, text (max 500), time | User | Core feature | Like the post | Until deleted by author, post owner, admin, or account deletion | `server/server.js:3322` |
| Cheer, save | uid + post id | User | Core feature | Post owner sees who cheered; saves are private | Until undone, post deleted, or account deletion | `server/server.js:3682`, `:3728` |
| Drink partner link / request | Two uids, status, time | User | Social graph (consented) | The two users and their partners | Links until removed; pending requests expire after 90 days | `server/server.js:1514`, `:3090-3227` |
| Block | Two uids | User | Safety | Only the blocker | Until removed or account deletion | `server/server.js:3852` |
| Report | Reporter uid, target type and id, reason (one of 6), details (max 300), status, time, `targetSnapshot` (reported version of an edited post), resolution (action, admin uid, time) | User, admin | Moderation (notice and action) | Admins | Details and snapshot removed on resolve; reporter uid removed 30 days after resolve; the rest of a resolved report has **no defined limit** (gap LC-16). Open reports of a deleted reporter kept under `deleted-<hex>` without details | `server/server.js:3905-3990`, `:3587-3595`, `:1783-1794`, `:4136-4200` |
| Notification | Recipient uid, type, actor uid, post id, English message, read flag, time | System | Feature | Recipient | 7 days, newest 200 per user | `server/server.js:1013`, `:1027` |
| Smart Bar item | uid, name, quantity, unit | User | Feature (private home-bar list) | Only the owner | Until deleted or account deletion | `server/server.js:3794-3830` |
| Limit events | uid, kind, time | System | Abuse limits | Server only | 24 hours | `server/server.js:1259-1300` |
| Audit log | id, time, action (8 types), actor and target uid (or `deleted-<hex>`), whitelisted meta (incl. `reason` on `auth.session_revoked`, section 5); never IP, email, name or free text | System | Security and moderation accountability | Admins | 90 days (plus backups up to 30 days) | `server/server.js:1810-1880`, `server/README.md` "Audit log" |
| Pending account deletion / tombstone | uid, anonymous id, time | System | Completing deletion; stop a pre-deletion token recreating the account | Server only | Until the deletion finishes; tombstone about 1 hour | `server/server.js:1624`, `:2362`, `:2484-2516` |

## 3. Who can see what (as the in-app notice v2 says)
In-app notice text: `src/context/LocalizationContext.tsx:482-498` (en), `:973-989` (ro). Gate: `requireSignedInAdult` `server/server.js:2046`, mounted `:340` (and `/media` `:255-257`). Nothing is readable without signing in and confirming 18+.

## 4. Device storage (phone)
| Item | Store | Code | Purpose |
|---|---|---|---|
| API token (JWT, 30-day expiry) | expo-secure-store (Keychain / Keystore) | `src/context/AuthContext.tsx:178`, `:187`; expiry `server/server.js:42` | Stay signed in |
| Firebase Auth session | AsyncStorage | `src/config/firebase.ts:20-22` | Stay signed in |
| Language choice | AsyncStorage | `src/context/LocalizationContext.tsx:1046`, `:1079` | Preference |
| Email-verification resend cooldown (uid + time) | AsyncStorage | `src/screens/VerifyEmailScreen.tsx:23` | Prevent repeated emails |
| Images | HTTP cache, `Cache-Control: private, max-age=86400` | `server/server.js:248` | Performance |
| Camera / photo library | OS permission, only when the user picks a photo | `app.config.ts:21-23`; `src/screens/CreatePostScreen.tsx:282-305`; `src/screens/ProfileScreen.tsx:239` | Photos |
No location permission is requested (place search is typed text).

## 5. Password reset ends the server session (merged in commit `0844255`, read 2026-11-13)
Line numbers are from the working tree of `server/server.js` on 2026-11-13 (this agent cannot run `git show`; the tree already contains later uncommitted edits by another developer, so lines may differ slightly from `0844255` – re-check before quoting externally). Behaviour description: `server/README.md` "Password reset ends the server session" (`:131-132`) and "Audit log" (`:181-187`).
- **Recipient / call:** every Firebase-mode sign-in (`POST /api/auth/mobile`, `:2681`) makes one `firebaseAuth.getUser(uid)` call to Google (`lookUpFirebaseUser`, `:2630-2648`; called `:2748`). Data sent: the Firebase uid. Data received and used: `disabled`, `tokensValidAfterTime`. Only the error code is logged, never the value (`:2636`, `:2644`). Google is already the auth processor – no new recipient.
- **Fail closed:** a failed lookup answers 503 `auth_unavailable`, also for new users (`:2668-2671`, `:2749`). Dev mode (`ALLOW_INSECURE_DEV_AUTH`) makes no lookup.
- **New private user field `tokensValidAfterSeen`:** ms since epoch of Firebase's `tokensValidAfterTime`, `0` = looked up, none reported; missing = never looked up. Written for existing users `:2804`, for new users `:2922`; compared `:2777-2782`, `:2793-2798`. Indirectly reveals when the user last reset or changed the password or email. Not in `toPublicUser` (`:2199-2211`) or `toOwnerUser` (`:2229`), both whitelists.
- **New private user field `firebaseSessionEndedReason`:** `'account_disabled'` or `'account_gone'`, set once per state (`endSessionsForFirebaseState`, `:2658-2665`; called `:2753`, `:2757`), cleared by the next good lookup (`:2806`). Not in any user view.
- **Effect:** the user's `sessionGen` is raised (`:2661`, `:2800`), which invalidates every earlier API JWT (`sg` claim, `:37-40`). Earlier tokens end at the owner's next sign-in after the reset, not at the reset itself (README `:132`). A token with `auth_time` before `tokensValidAfterTime`, or a disabled user, gets 401; an unknown user 410 (`:2752-2764`).
- **Audit:** `auth.session_revoked` with whitelisted meta `reason` = `tokens_revoked` (`:2901`) / `account_disabled` / `account_gone` (`endSessionsForFirebaseState` `:2758-2765`, entry `:2763`); no reason for the email-takeover bump (`:3019`). Meta whitelist `:1945-1958` (entry `:1951`); it is a user self-action (`AUDIT_SELF_ACTIONS` `:1963`), so it is deleted with the account and counts against the users' audit budget (`AUDIT_USER_MAX_ENTRIES` 15,000, `:1943`). Retention 90 days like the rest of the audit log (`AUDIT_RETENTION_DAYS` `:1941`). (Line numbers re-read in the working tree on 2026-11-13, after the official-account changes.)
- **Rate of entries (verified 2026-11-13):** at most one `auth.session_revoked` entry per account and reason (no reason counts as its own reason) per 24 hours: `appendSessionRevokedAudit` `server/server.js:2026-2042` (window `SESSION_REVOKED_AUDIT_WINDOW_MS` `:2030`; scan of newer entries for the same actor, action and reason `:2033-2040`). All three call sites use it (`:2763`, `:2901`, `:3019`). The session generation bump always happens; only the log entry is skipped. Effect for data protection: repeated resets by one account cannot push other users' consent records out of the shared budget (minimisation and integrity of the accountability record, GDPR Art. 5(1)(c), 5(2)). Consequence to remember: the audit log is not a complete history of every session revocation – the users' `sessionGen` is.
- **Deletion:** both fields live on the user record and go with it in the account-deletion cascade; backups within 30 days.
- **Privacy notice impact:** no new purpose (security), no new recipient, no change to what others see. The in-app notice v2 lists security-log examples with "for example" (`src/context/LocalizationContext.tsx:498`), so it stays accurate. `PRIVACY_NOTICE_VERSION` bump: **not needed** (see `../CHANGELOG.md` 2026-11-13).

### 5a. Official DrinkMe account (re-read in the uncommitted working tree on 2026-11-13, final version; line numbers from that tree)
- Which account is official: env var `OFFICIAL_USER_IDS` (Firebase uids), read once at start, `server/server.js:4203-4205`. `official` is computed per request (`isOfficialUser`, `:1818`) and sent in every user view (`toPublicUser` `:2306`, `toOwnerUser` `:2339`). It describes the operator's own account, so it adds no personal data about ordinary users (always `false` for them).
- Reserved names: names are checked, not stored differently (`isReservedDisplayName`, `:1184`). Fold `:1085-1180`: NFKC, lowercase, diacritics stripped, Cyrillic/Greek/Cherokee/Latin look-alikes and digits or symbols mapped to a-z (`:1094-1117`), regional-indicator letters (`:1118-1129`), any other letter or symbol becomes a wildcard, at most 2 wildcards in "drinkme" or wildcards removed (`:1146-1164`), "rn"→"m" and "cl"→"d" forms (`:1170-1180`). Also refused for non-official users: "official" / "oficial" (`:1168`) and check-mark characters ✓ ✔ ☑ ✅ 🗸 🗹 ⍻ √ (`:1121`, checked `:1186`). Best effort, not a full Unicode TR39 confusables check (`server/README.md` "Official account").
- Sign-in with Google/Apple: a reserved provider name is not stored for a non-official account (`registerUserIfNeeded` `:1214-1219`) – less data stored, the user is asked for a name.
- **New private user field `nameReservedAtSignIn`** (boolean `true`, set only when a non-empty provider name was dropped as reserved, `:1231`). Holds no name. Sent only in the owner's own view while the name prompt is due (`toOwnerUser` `:2343-2344`; client type `src/types/api.ts:9`; shown by `src/screens/OnboardingScreen.tsx:167-168`, strings `src/context/LocalizationContext.tsx:507` en, `:1004` ro). Deleted at the next successful profile save (`PUT /api/users/:id`, `:3152-3153`; restored with the other fields if the save fails or the name is refused, `:3103-3106`, `:3137-3142`). Not in `toPublicUser`. Goes with the user record on account deletion; backups within 30 days. Retention: until the next profile save or account deletion. Lawful basis: as P1/P5 in `ropa.md` (legitimate interest – explaining an automated refusal; transparency, GDPR Art. 12). Not a new category of data: derived from the provider name already disclosed in the privacy policy §2 "Account".
- Profile edits refused with 400 `name_reserved` only when the name changes (`:3143-3151`); the previous values are restored, nothing extra is kept.
- Logs: start-up warnings give counts only – unknown official uids `:4208-4211`; official uid also in `ADMIN_USER_IDS` (could not be suspended) `:4214-4217`; official uids while `ALLOW_INSECURE_DEV_AUTH=true` `:4219-4221`; legacy non-official names that use a reserved name (brand, Official or a check mark) `:4225-4229`. No names or uids in logs.
- Moderation: official content is never auto-hidden (`isTargetAutoHidden` `:1824-1826`); reports about it are stored like any report; the admin list adds the computed `targetOfficial` (`:4366-4378`), not stored.
- Client: `src/components/OfficialBadge.tsx` renders only when `official === true`; error string `editProfile.nameReserved` `src/context/LocalizationContext.tsx:396` (en), `:893` (ro). Nothing stored on the device.
- Password-reset hint (closes the LC-24 gap): `auth.forgot.sent` now tells users to sign in again after choosing a new password, which signs DrinkMe out on other devices – `src/context/LocalizationContext.tsx:213` (en), `:711` (ro); used by `src/screens/AuthScreen.tsx:316`.
- No change to the in-app privacy notice is needed for this feature (no new personal data category, purpose or recipient); the privacy policy footer records the marker. The official account will publish brand-partner recipes (commercial communications) – LC-11 still open.

## 6. Not collected
Birth date, precise location (GPS), contacts, device identifiers for advertising, payment data, health data as such (alcohol posts may allow inferences; see `dpia-screening.md`), biometric data (no face recognition).

## 7. Open points
- EXIF metadata (possibly GPS) inside uploaded photos: the server checks only the file signature and does not re-encode (`server/README.md` SEC-E). Whether the cropping step in the image picker removes EXIF is not verified (LC-17).
- Host log retention is not set yet (hosting not chosen, INFRA-1) (LC-15).
