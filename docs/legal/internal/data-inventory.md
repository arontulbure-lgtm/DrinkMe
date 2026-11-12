DRAFT v0.1 – 2026-11-12 – to be reviewed by a qualified lawyer before publication. Not legal advice.

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
| Firebase Authentication (Google) | Email, password hash (password users), provider ids (Google, Apple), display name and photo URL from the provider, sign-in metadata | `src/config/firebase.ts:20-22`; `server/server.js:135` (fields read from the verified token) |
| Phone (device) | API token, Firebase session, language choice, an email-verification cooldown record, cached images | section 4 |
| Google Maps Platform (Places API, called from the phone) | The place search text and the phone's IP address | `src/components/LocationPickerModal.tsx:66`, `:110` |
| Google user-content servers | Google profile photos are linked, not copied; other users' phones load them from `lh3`–`lh6.googleusercontent.com` | `server/server.js:2588-2631`, `server/README.md` (auth flow) |
| OpenAI (only if `AI_ENABLED=true`, currently **off**) | Photos for the scanner, Smart Bar ingredient lists | `server/server.js:4408` (`store: false`), `:4512-4548` |

No analytics, advertising, crash-reporting or push-notification SDK is installed (checked `package.json`: no `expo-notifications`, no analytics or Sentry packages). Notifications are in-app lists only.

## 2. Server records

| Record | Fields (personal data) | Source | Purpose | Visible to | Retention | Code |
|---|---|---|---|---|---|---|
| User | Firebase uid, email (from the verified token; placeholder `<uid>@drinkme.app` if none), first and last name, city, bio, avatar (uploaded image or Google photo URL), `createdAt`, `emailVerified`, `noticePending`, `privacyNoticeVersion` + time, `ageConfirmedAt` (no birth date), session generation and auth-floor timestamps, `federatedVerifiedAt`, suspension state and history (dates, permanent/void flags, reason up to 300 chars, admin uid) | User, Firebase token, admins | Account, profile, security, moderation | Public profile (name, city, bio, avatar) to signed-in 18+ users after the owner accepts the notice (`toPublicUser`, `server/server.js:2144-2151`); email, age state and suspension only to the owner and the server | Until account deletion | `server/server.js:1087-1113`, `:2888-2932`, `:1717-1770` |
| Post ("drink") | Author uid, name, description, rating, location text (free text from Google Places, max 180 chars; no coordinates stored), alcoholic flag, category, photo (stored as data URL in the database), created/edited time | User | Core feature | Signed-in 18+ users not blocked, unless hidden after reports | Until the author or an admin deletes it, or account deletion | `server/server.js:3404-3460`, edit `:3612` |
| Comment | Author uid, post id, text (max 500), time | User | Core feature | Like the post | Until deleted by author, post owner, admin, or account deletion | `server/server.js:3322` |
| Cheer, save | uid + post id | User | Core feature | Post owner sees who cheered; saves are private | Until undone, post deleted, or account deletion | `server/server.js:3682`, `:3728` |
| Drink partner link / request | Two uids, status, time | User | Social graph (consented) | The two users and their partners | Links until removed; pending requests expire after 90 days | `server/server.js:1514`, `:3090-3227` |
| Block | Two uids | User | Safety | Only the blocker | Until removed or account deletion | `server/server.js:3852` |
| Report | Reporter uid, target type and id, reason (one of 6), details (max 300), status, time, `targetSnapshot` (reported version of an edited post), resolution (action, admin uid, time) | User, admin | Moderation (notice and action) | Admins | Details and snapshot removed on resolve; reporter uid removed 30 days after resolve; the rest of a resolved report has **no defined limit** (gap LC-16). Open reports of a deleted reporter kept under `deleted-<hex>` without details | `server/server.js:3905-3990`, `:3587-3595`, `:1783-1794`, `:4136-4200` |
| Notification | Recipient uid, type, actor uid, post id, English message, read flag, time | System | Feature | Recipient | 7 days, newest 200 per user | `server/server.js:1013`, `:1027` |
| Smart Bar item | uid, name, quantity, unit | User | Feature (private home-bar list) | Only the owner | Until deleted or account deletion | `server/server.js:3794-3830` |
| Limit events | uid, kind, time | System | Abuse limits | Server only | 24 hours | `server/server.js:1259-1300` |
| Audit log | id, time, action (8 types), actor and target uid (or `deleted-<hex>`), whitelisted meta; never IP, email, name or free text | System | Security and moderation accountability | Admins | 90 days (plus backups up to 30 days) | `server/server.js:1810-1880`, `server/README.md` "Audit log" |
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

## 5. Being implemented now (another developer, 2026-11-12; not yet in the code read)
- A password reset will end the server session (sessions issued before the reset stop working).
- Official DrinkMe account: `OFFICIAL_USER_IDS`, an "Official" badge, display names "DrinkMe" / "DrinkMe Official" reserved for official users, official content exempt from auto-hide by reports but still moderated by admins. The official account will publish brand-partner recipes (commercial communications).
Update this inventory with file:line once merged.

## 6. Not collected
Birth date, precise location (GPS), contacts, device identifiers for advertising, payment data, health data as such (alcohol posts may allow inferences; see `dpia-screening.md`), biometric data (no face recognition).

## 7. Open points
- EXIF metadata (possibly GPS) inside uploaded photos: the server checks only the file signature and does not re-encode (`server/README.md` SEC-E). Whether the cropping step in the image picker removes EXIF is not verified (LC-17).
- Host log retention is not set yet (hosting not chosen, INFRA-1) (LC-15).
