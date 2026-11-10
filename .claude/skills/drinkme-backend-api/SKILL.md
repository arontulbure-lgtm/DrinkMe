---
name: drinkme-backend-api
description: The DrinkMe Express backend - API endpoints, auth flow, data persistence, security measures and open security items. Use when a feature calls or changes the API, touches authentication, users, posts, comments, partners, blocks, reports, notifications, account deletion or Smart Bar data, or during any security review.
---

# DrinkMe backend (server/server.js)

## Runtime
Node.js 22, Express, ESM (`"type": "module"`). Port 5000 by default (`PORT`), host `0.0.0.0` (`HOST`). Packages: express, cors, helmet, express-rate-limit, morgan, multer, jsonwebtoken, dotenv, openai, firebase-admin v14 (ESM imports `firebase-admin/app`, `firebase-admin/auth`), validator.
Setup, every env var and Docker usage are in `server/README.md`.

## Environment and production rules
Any `NODE_ENV` other than `development` or `test`, including unset, applies production rules.
The server refuses to start in production unless all of these hold:
- `JWT_SECRET` has at least 32 characters, 16 of them distinct. The old hardcoded default is refused in every environment.
- `FIREBASE_SERVICE_ACCOUNT_KEY` gives a valid service account (JSON string or file path).
- `DB_FILE`, if set, is an absolute path.
- The database file exists and holds valid data, unless `ALLOW_EMPTY_DB=true` (first deploy only; remove it afterwards).
Production also enforces the `CORS_ALLOWED_ORIGINS` allowlist; other environments allow any origin.
`ALLOW_INSECURE_DEV_AUTH=true` works outside production only. It makes sign-in trust the client uid when no Firebase key is set; without it, sign-in returns 503 in that case.
`TRUST_PROXY_HOPS` (default 0) is the number of reverse proxies in front of the server. It must match the host, or users share one rate-limit bucket (too low) or clients can pick their own IP (too high).

### Feature switches (read once at start)
| Variable | Default | On means | Warnings |
|---|---|---|---|
| `AI_ENABLED` | off; on only for exactly `true` | AI routes call OpenAI (also needs `OPENAI_API_KEY`) | See AI below before turning it on |
| `PARTNER_CONSENT_REQUIRED` | on; off only for exactly `false` | A partnership needs a request and an accept | `false` is an emergency rollback only: `POST` links both sides at once, so anyone can add themselves and then read that person's partner list, which makes partner lists effectively public. Links made while off stay after turning it back on. The privacy notice's partner sentence is then untrue. Production logs a warning |
| `REQUIRE_VERIFIED_EMAIL` | off; on only for exactly `true` | Accounts with an unconfirmed email get no JWT | Rollout note below. Do not turn on before a real Firebase test. Production logs a warning while it is off |
| `ADMIN_USER_IDS` | empty | Comma-separated uids that may use `/api/admin/*` | Empty means every admin route returns 403 and nobody can review reports (production logs a warning). Unknown ids are logged as a count only |
| `CORRUPT_BACKUP_RETENTION_DAYS` | 30 | Days before `.corrupt-*` and `.pre-migration-*` backups are deleted | Whole number 1 to 36500; anything else falls back to 30 with a warning. Above 30 logs a warning, because the app tells users backups go within 40 days (30 plus the 7-day hold and a purge delay) |

`REQUIRE_VERIFIED_EMAIL` rollout note. Turning it on:
- logs out every JWT without the `ev` claim, so running apps act logged out until their next session;
- asks password users without a stored verified state, including verified ones who signed in more than 5 minutes ago, to sign in again once (`sign_in_again`);
- adds a Firebase revocation check to every sign-in, so sign-in fails during a Firebase outage;
- refuses password users when the server clock runs behind (look for `[auth] A token auth_time is ahead`);
- registers `POST /api/account/delete-unverified`.
Before turning it on: test on a real Firebase project (Google relink, revocation, `auth_time` on refresh, `getUser`) and re-review the last fix loop of this feature, which has only the developer's tests. While it is off, someone who registers another person's address first keeps a working JWT after the owner signs in with Google (up to 30 days).

Test-only overrides, honoured only with `NODE_ENV=test`: `IMAGE_STORAGE_MAX_BYTES`, `DB_GROWTH_MAX_BYTES`, `MEDIA_CACHE_MAX_BYTES`, `ACCOUNT_TOMBSTONE_MS`, `ACCOUNT_DELETION_RETRY_INTERVAL_MS`, `DB_BACKUP_PURGE_INTERVAL_MS`, `DB_RECOVERY_PURGE_HOLD_MS`.

## Persistence
- All data lives in `DB_FILE` (default `server/data/db.json`), loaded at start and written after every mutation. Logged-out reads write nothing.
- **`DB_FILE` needs its own directory.** Temp files (`.tmp-*`), backups and the backup purge all work in that directory and match on the database's file name. Do not keep other copies of the database there.
- Saves are atomic: temp file (mode 0600), fsync, rename. A failed save returns 503 and keeps the previous file.
- Rollback after a failed save: creates (post, comment, Smart Bar item, avatar, report, partner request), profile edits, acknowledgements, partner and block changes, post and comment deletions and moderation actions are undone. Not undone: cheer and save toggles, marking notifications read, deleting a Smart Bar item, and a new user created at sign-in (no token is issued; a retry reuses the record).
- Loading: no file means an empty start (production needs `ALLOW_EMPTY_DB=true`). Invalid JSON or an invalid shape saves a verified copy to `<DB_FILE>.corrupt-<timestamp>`, then starts empty, or exits in production unless `ALLOW_EMPTY_DB=true`. Any other load failure exits and writes nothing.
- Schema version 2: text is stored plain. A file without `dbSchemaVersion` is backed up to `<DB_FILE>.pre-migration-<timestamp>`, decoded once from the old HTML-escaped form and saved (`[db] Migrated to schema version 2`). A failed backup or decode stops startup with the file unchanged. Running older code on a migrated file and then newer code again can double-decode.
- No seed data (`DEFAULT_USERS = []`, `DEFAULT_DRINKS = []`). New users start with empty city, bio and Smart Bar.
- Known limitation (DATA-1, launch blocker): the JSON file is lost on redeploy without a persistent volume, and each save blocks the server. Any feature that adds data should keep the data-access code isolated so it can move to a real database (Supabase Postgres or MongoDB Atlas are the candidates) without rewriting routes.

### Backups and recovery
- `.corrupt-*` and `.pre-migration-*` backups hold personal data, including that of deleted accounts. They are deleted after `CORRUPT_BACKUP_RETENTION_DAYS` (default 30), counted from the timestamp in the file name. The purge runs every 24 hours, or sooner when a backup is due.
- 7-day recovery hold: after a start that lost its data (no file, a corrupt file, or no users) nothing is purged for 7 days, so an operator can recover. `recoveryStartedAt` is saved in the file so restarts do not extend or reset it. The hold also starts when the last user is deleted. A start that just migrated purges nothing until the next timer run.
- Restoring a backup that has users and no `recoveryStartedAt` ends a running hold, so the next purge can delete expired backups. Move the backups you want to keep out of the directory first.
- Restoring a backup brings deleted accounts back; repeat those deletions by hand. A corrupt start loses pending account deletions, because they were stored in the corrupt file.

## Auth flow
1. Phone signs in with Firebase Auth (email/password or Google with PKCE; Apple on iOS) and gets an idToken.
2. Client calls `POST /api/auth/mobile { idToken, uid, email, displayName, photoURL }`.
3. Server runs `verifyIdToken(idToken)`; an invalid token or decoded.uid ≠ body.uid returns 401. Otherwise it creates/updates the user and signs an internal JWT (HS256, 30-day expiry, `JWT_SECRET`, `ev: true` when the email is verified). The email comes only from the verified token. `photoURL` comes only from the verified token, is accepted only from https `lh3` to `lh6.googleusercontent.com`, and never replaces an existing avatar.
4. Client stores the JWT in SecureStore; `setApiToken()` makes `apiFetch` (src/lib/api.ts) inject it into every request.
A valid JWT whose uid is not in the database, or whose account deletion is pending, counts as logged out.
Sign-in answers 410 `account_deleted` for a pending deletion or a token issued before a deletion finished, and 507 `storage_full` for a new user when the database is full. With `REQUIRE_VERIFIED_EMAIL` on it can also answer 403 `email_not_verified` or `sign_in_again`.
New accounts are stored with `noticePending` and look blank to others (no name, city, bio or avatar, and left out of search) until the owner accepts the privacy notice.

## Age gate (alcohol policy rule 1, enforced here)
- `POST /api/users/:id/acknowledgements { type: 'age', confirmed: true }` stores only `ageConfirmedAt`, never a birth date. Declining stores nothing.
- A post counts as alcoholic unless `isAlcoholic === false`. Logged-out and unconfirmed viewers, the owner included, get no alcoholic post, image, comment or cheer/save: lists leave them out, by-id routes return 403 `age_required` (404 if a block applies).
- `POST /api/drinks` returns 403 `age_required` unless the user confirmed or sends `isAlcoholic: false`.
- Notifications that name an alcoholic post show neutral text to an unconfirmed reader.
- AI recipe routes give unconfirmed users mocktails only, whatever the client sends.

## Endpoints
`auth` = requireAuth (401 otherwise). `owner` = the `:id` must be the caller (403). Everything else is readable logged out. Blocks apply in both directions to signed-in viewers and answer like a missing record (404).

**Paged lists** take `?limit=` (1 to 50, default 20) and `?before=<id>` (exclusive; pass the previous `nextCursor`) and return `{ items, nextCursor }`, newest id first; `nextCursor` is null on the last page. Invalid values return 400. Every route that names a post or comment by id accepts only a plain positive integer.

Health: `GET /healthz`
Media (outside `/api`, 600 req / 15 min / IP, `Cache-Control: private, max-age=86400`, ETag, 304): `GET /media/drinks/:id` (age gate and blocks as for the post; users in `ADMIN_USER_IDS` bypass both here, to review reports) · `GET /media/avatars/:userId` (public; 404 while the owner's notice is pending). JSON responses carry `/media/...` paths, never image bytes. `avatar` is a `/media/avatars/:id?v=<hash>` path, a Google photo URL, or null.
Auth: `POST /api/auth/mobile`
Users:
- `GET /api/users/search` (auth; `?q=`, under 2 characters returns `[]`, at most 50 results, 60 searches / 15 min per account; matches public name and city only; adds `isPartner` and `partnerStatus`)
- `GET /api/users/:id` (owner gets `toOwnerUser` plus `partnerCount`; signed-in viewers get the public profile plus `partnerStatus`, and `partnerCount` only if they are that user's partner)
- `GET /api/users/:id/partners` (auth; the owner and that user's partners only, otherwise 403 `partner_list_private`)
- `PUT /api/users/:id` (auth + owner; `firstName`, `lastName`, `city`, `bio`, and `nameChosen: true` from the name prompt)
- `POST /api/users/:id/acknowledgements` (auth + owner; `{ type: 'age', confirmed: true }` or `{ type: 'privacy', version }`; works when storage is full)
- `POST /api/users/:id/avatar` (auth + owner)
- `GET /api/users/:userId/saved-drinks` (auth + owner; paged)
- `POST /api/users/:id/delete-account` (auth + owner; body `{ idToken }`; see Account deletion)
- `POST /api/account/delete-unverified` (no JWT; body `{ idToken }`; exists only with `REQUIRE_VERIFIED_EMAIL` on)
Partners (status values: `none`, `requested`, `incoming`, `partner`; actions answer `{ status, isPartner }`):
- `GET /api/drink-partners` (auth; the caller's partners)
- `GET /api/drink-partners/requests` (auth; `{ incoming, outgoing }`)
- `POST /api/drink-partners/:targetId` (auth; asks, or accepts if the target already asked; never removes. 400 for yourself, 404 missing or blocked, 429 `partner_request_limit`)
- `POST /api/drink-partners/requests/:fromId/accept` (auth)
- `DELETE /api/drink-partners/requests/:fromId` (auth; declines, 204, tells nobody)
- `DELETE /api/drink-partners/:targetId` (auth; removes a partner or cancels the caller's request, 204. Optional `?expect=partner|request`: 409 `partner_state_changed` with the current status if the button was stale)
- `GET /api/friends/count` (auth)
Posts:
- `GET /api/drinks` (paged; `?q=` text search, `?city=`, `?alcoholic=false`, `?scope=discover` (auth; excludes own and partners' posts), `?sort=trending` (top 20 by cheers, one page, no `before`))
- `GET /api/drinks/partners` (auth; paged; own and partners' posts)
- `GET /api/drinks/user/:userId` (paged; also returns `total`)
- `GET /api/drinks/:id`
- `POST /api/drinks` (auth; 201)
- `DELETE /api/drinks/:id` (auth; owner only, 403 otherwise; 204; removes its comments, cheers, saves and image; does not refund daily limits)
- `POST /api/drinks/:id/like` (auth, toggle) · `POST /api/drinks/:id/save` (auth, toggle)
- `GET /api/drinks/:id/comments` (paged) · `POST /api/drinks/:id/comments` (auth; 201)
- `DELETE /api/drinks/:id/comments/:commentId` (auth; the comment's author or the post's owner; 204)
Blocks: `GET /api/blocks` (auth; the caller's own blocks only) · `POST /api/blocks/:targetId` (auth; `{ blocked: true }`; also ends any partnership and requests, which do not come back on unblock; 429 `block_limit` at 200) · `DELETE /api/blocks/:targetId` (auth; 204)
Reports: `POST /api/reports` (auth; `{ targetType: 'drink'|'comment'|'user', targetId, reason, details? }`, reasons `spam`, `harassment`, `underage`, `dangerous_drinking`, `mislabeled_alcohol`, `other`, details up to 300 characters; 201 `{ id }`, or 200 with the existing id for a repeat while open; 404 if not visible; 400 for own content)
Admin (auth + uid in `ADMIN_USER_IDS`, 403 otherwise; API only, no screen): `GET /api/admin/reports?status=open|resolved` (oldest first, at most 100 items, plus `total`) · `POST /api/admin/reports/:id/resolve { action: 'dismiss'|'remove_content'|'clear_profile' }` (resolves every open report on the same target; `clear_profile` only for users, `remove_content` only for posts and comments; 409 if already resolved)
Stories: `GET /api/stories` (always empty)
Notifications: `GET /api/notifications` (auth; returns `notifications` and `unreadCount`) · `POST /api/notifications/read` (auth; marks all read)
Smart Bar: `GET|POST /api/smart-bar` (auth) · `DELETE /api/smart-bar/:itemId` (auth)
AI (auth; off by default): `POST /api/smart-bar/generate-recipes` · `POST /api/detect-product` · `POST /api/generate-recipes`
These do not exist: editing a post, editing a Smart Bar item, `PUT /api/drinks/:id`, `DELETE /api/users/:id`, any `/api/notifications/count` or `read-all` route.

## Account deletion
- `POST /api/users/:id/delete-account` needs the JWT, ownership and a fresh Firebase ID token for the same uid, not revoked, issued in the last 5 minutes; password accounts must also have signed in within 5 minutes (60 seconds of clock skew allowed). 5 attempts / 15 min per account. Works when storage is full.
- Answers `{ deleted: true, firebaseDeleted }`; 401 `reauth_required`; 500 `account_deletion_incomplete`; 503 without Firebase unless `ALLOW_INSECURE_DEV_AUTH=true`.
- A pending entry is saved first, then every stored record that holds or names the user is removed, then the Firebase user. Unfinished deletions resume at startup and every 15 minutes.
- When done, in Firebase mode, a tombstone keeps only the uid for 1 hour (pruned within the next 15-minute run), so an ID token issued before the deletion cannot recreate the account (410 `account_deleted`).
- `delete-unverified` takes the same proof without a JWT, refuses a confirmed email (403 `email_already_verified`), and answers 503 if the Firebase lookup fails.
- What code cannot delete: backups until they expire, host snapshots and hand-made copies, older request logs, copies cached on other phones, Google-hosted photos, and text other users wrote about the person.

## Limits
- Body: 100 KB by default; JSON up to 10 MB on `POST /api/drinks` and 3 MB on the avatar route, parsed after auth. Rate limits run before body parsing. Malformed JSON or uploads return 400; too large returns 413.
- Images: the type comes from the file signature, never from what the client declares. Base64 is strict. Posts take JPEG, PNG, WebP or HEIC up to 7 MB; avatars and AI scans take JPEG, PNG or WebP (avatars up to 2 MB, scans up to 7 MB). Only the signature is checked, not the full file (see SEC-E). Posts send JSON `imageData`; avatars send JSON `imageData` or a multipart `avatar` file.
- Image storage: new images are refused above 200 MB in total or 100 MB per user for all time (507), and above 20 posts or 50 MB per user per rolling 24 hours (429). These count stored data-URL length, about 4/3 of the image bytes. Deleting a post frees the total and lifetime quotas, not the daily limit.
- Text: post name 120, description 1000, location 180; profile names and city 120, bio 500; comment 500; report details 300; Smart Bar name 120, quantity and unit 60.
- Per user: 20 posts and 200 comments per rolling 24 hours; 20 reports per 24 hours; 50 pending outgoing partner requests and 100 new requests per 24 hours (requests expire after 90 days); 200 blocks; 500 Smart Bar items (429 `smart_bar_limit`; larger existing lists keep their items and can delete); the newest 200 notifications, kept for 7 days.
- Limit events: each post, comment and partner request records `{ kind, at }` in `limitEventsByUser`. The daily limits read only these, so deleting content never resets them. Events older than 24 hours are pruned.
- DB size guard: growth stops with 507 `storage_full` once the last saved file passes 450,000,000 bytes (the file cannot be loaded above about 536.87 million UTF-8 bytes). Blocked: new users, posts, comments, Smart Bar adds, reports, partner requests and accepts, larger avatars, new notifications, and turning on a cheer or save. Still open: existing users' sign-in, removals, blocks, acknowledgements and account deletion.
- Rate limits: 100 req / 15 min / IP on `/api`; 600 req / 15 min / IP on `/media`; 30 mutations/min per user (skips GET); search 60 / 15 min per user; account deletion 5 / 15 min per user; AI 20 req/hour per user across all three routes.

## Response codes
Errors are `{ error, code? }`. Only the app's own messages reach clients; other failures get a generic message.
| Status | `code` | Meaning |
|---|---|---|
| 400 | none | Invalid input, page parameters or filter |
| 401 | `reauth_required` | Account deletion needs a fresh sign-in. Other 401s have no code |
| 403 | `age_required` | Alcoholic post and the viewer has not confirmed their age |
| 403 | `partner_list_private` | Partner list of someone who is not your partner |
| 403 | `email_not_verified`, `sign_in_again`, `email_already_verified` | `REQUIRE_VERIFIED_EMAIL` paths |
| 404 | none | Missing, deleted, or hidden by a block |
| 409 | `partner_state_changed` | Stale partner button; the body carries the current `status` |
| 409 | none | Report already resolved |
| 410 | `account_deleted` | Sign-in to a deleted or deleting account |
| 429 | `daily_post_limit`, `daily_comment_limit`, `daily_report_limit`, `partner_request_limit`, `smart_bar_limit`, `block_limit`, `ai_rate_limit` | Per-user limits. The general rate limiters and search return 429 with no `code` |
| 500 | `account_deletion_incomplete` | The deletion is retried in the background |
| 502 | `ai_upstream_error`, `ai_invalid_output` | The AI call failed or its output was unusable |
| 503 | `ai_disabled` | AI is off; checked after auth and before any upload is read |
| 503 | none | Save failed, sign-in has no Firebase key, or a Firebase lookup failed |
| 507 | `storage_full`, `image_storage_full`, `user_image_quota` | Storage limits above |

## AI
AI runs only when `AI_ENABLED` is exactly `true` and `OPENAI_API_KEY` is set; a key alone does not enable it. The client flags (`AI_ENABLED`, `AI_RECIPES_ENABLED`) are separate. Upload field for scans: `image`. Requests use `store: false`.
The server-side age gate now covers AI recipes. Do not set `AI_ENABLED=true` where real users can reach it until the rest are done:
- a global daily AI cap and a hard monthly budget in the OpenAI dashboard
- a privacy disclosure and data agreement for photos sent to OpenAI
- one real OpenAI call (only a local mock has been used)
- the scanner screen rebuilt (`ScannerScreen.tsx` returns null on the AI path)
- `SmartBarScreen.tsx` sends `nonAlcoholicOnly`

## Privacy notice
`PRIVACY_NOTICE_VERSION` in `server.js` and in `src/screens/OnboardingScreen.tsx` must match. The notice text (`onboarding.privacy*` in `LocalizationContext.tsx`) describes the read rules in this file: change it whenever who-can-see-what changes, and raise both numbers when it changes in substance. Deploy the server first; it accepts any version from 1 up to its own. The text has not had a legal review.

## Security already in place - do not regress
- requireAuth middleware on every mutation except sign-in (401 on invalid token); getUserId() returns null on invalid tokens (no demo fallback).
- Ownership checks (403) on profile edits, acknowledgements, avatars, saved lists, account deletion and post deletion.
- Other users get the `toPublicUser` allowlist and owners get `toOwnerUser`; email goes only to the owner. Names derived from an email are hidden. Search terms and the uid in the account deletion URL stay out of request logs.
- Age gate, blocks, reports and partner consent as described above. Partner lists are visible only to the owner and their partners.
- Input sanitization (SEC-A) with validator: `sanitizeText()` / `sanitizeOptional()` on posts, profile updates, comments, reports and Smart Bar items. Any new text input must go through these. They strip control characters (newlines kept, tabs become spaces), C1 controls and bidi overrides, trim, and cut to the length limit without splitting an emoji. **Text is stored plain, not HTML-escaped,** because React Native `<Text>` does not parse HTML. Any web client must encode on output.
- JWTs pinned to HS256; helmet(); CORS restricted via `CORS_ALLOWED_ORIGINS` in production.
- Limits and image checks under Limits above.
- Keep the server clock accurate (NTP): account deletion and the `REQUIRE_VERIFIED_EMAIL` sign-in compare Firebase `iat` and `auth_time` with it, allowing 60 seconds of skew.

## Open security items (from SECURITY.md)
- DATA-1 (blocker): real database.
- INFRA-1 (blocker): backend on a public host (Railway/Render planned, see DEPLOY.md).
- SEC-C: rotate the OpenAI key; restrict the Google Maps key (after the first EAS build, needs SHA-1).
- SEC-D: HTTPS (comes with cloud hosting).
- SEC-E: content security for images (only the signature is checked; re-encoding needed).
- `multer` is still 1.x (`^1.4.5-lts.2`), which has DoS advisories; upgrade to `^2.5.0` and retest avatar upload.
- `REQUIRE_VERIFIED_EMAIL` is off, so the email takeover described above stays open until it is turned on.
- Logged-out reads (profiles, non-alcoholic posts, comments, `/media/avatars`) stay public, so a block does not stop viewing while signed out.
- Nobody reviews reports until `ADMIN_USER_IDS` is set and someone is assigned; a repeat offender cannot be suspended.
- Later: refresh tokens, audit log, Firebase App Check.

## Rules for every backend change
1. New routes that change data use requireAuth, an ownership check where relevant, sanitization, and the mutation rate limiter. They save through `saveDbOrRespond`, and roll back their change when it fails.
2. New content that counts against a daily limit records a limit event; new growth checks `isDbGrowthBlocked()`. Removals stay open when storage is full.
3. New read routes apply `canViewDrink` (age gate and blocks) and `isLiveAccount`, and return `{ items, nextCursor }` if they list records.
4. New stored data about a user must also be removed by `deleteUserDataCascade`.
5. Update the shared types in `src/types/api.ts` and call the route through `apiFetch` on the client. If the change alters who can see what, update the privacy notice text and version.
6. Never log tokens, secrets or full request bodies with user data.
7. Never read, print or modify `server/.env`, `server/serviceAccount.json` or anything in `server/data/`.
8. Write tests in `server/test/` with node:test, `fetch` and `test/helpers/harness.js`. Run them with `npm test` in `server/`: about 975 tests, about 10 minutes, port 5055 and a temp database, so only one run at a time.
