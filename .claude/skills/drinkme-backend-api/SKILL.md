---
name: drinkme-backend-api
description: The DrinkMe Express backend - API endpoints, auth flow, data persistence, security measures and open security items. Use when a feature calls or changes the API, touches authentication, the sign-in and age gate, users, posts (create, edit, categories, cheers, saves), comments, partners, blocks, reports, moderation (auto-hide, suspensions), the audit log, notifications, account deletion, backups or Smart Bar data, or during any security review.
---

# DrinkMe backend (server/server.js)

## Runtime
Node.js 22, Express, ESM (`"type": "module"`). Port 5000 by default (`PORT`), host `0.0.0.0` (`HOST`). Packages: express, cors, helmet, express-rate-limit, morgan, multer, jsonwebtoken, dotenv, firebase-admin v14 (ESM imports `firebase-admin/app`, `firebase-admin/auth`), validator.
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
| `AI_PROVIDER` | off; on only for exactly `local` | `/api/ai/*` call the local ai-service | See AI below and the drinkme-ai-service skill. `AI_ENABLED` and `openai` no longer do anything (D-24, logged as a warning) |
| `PARTNER_CONSENT_REQUIRED` | on; off only for exactly `false` | A partnership needs a request and an accept | `false` is an emergency rollback only: `POST` links both sides at once, so anyone can add themselves and then read that person's partner list, which makes partner lists effectively public. Links made while off stay after turning it back on. The privacy notice's partner sentence is then untrue. Production logs a warning |
| `REQUIRE_VERIFIED_EMAIL` | off; on only for exactly `true` | Accounts with an unconfirmed email get no JWT | Rollout note below. Do not turn on before a real Firebase test. Production logs a warning while it is off. The email takeover guard (session generation and auth floor, see Auth flow) works with it off |
| `ADMIN_USER_IDS` | empty | Comma-separated uids that may use `/api/admin/*` | Empty means every admin route returns 403 and nobody can review reports (production logs a warning). Unknown ids are logged as a count only. Admins also need the 18+ confirmation, and cannot be suspended |
| `OFFICIAL_USER_IDS` | empty | Comma-separated uids of the official DrinkMe account, parsed like `ADMIN_USER_IDS` | Not an admin, and must never be in `ADMIN_USER_IDS` too (it could not be suspended; startup warns, counts only; also warns with `ALLOW_INSECURE_DEV_AUTH=true`). Gives `official: true`, the reserved brand name and no auto-hide (see Official account). Setup by the owner, nothing in code creates it: sign up with the brand address, confirm 18+, accept the notice, skip or pick any name at the name prompt, copy the uid from the Firebase console into `OFFICIAL_USER_IDS`, restart, then set "DrinkMe" / "DrinkMe Official" in Edit Profile. To remove one: rename or clear the profile first, then remove the uid and restart |
| `CORRUPT_BACKUP_RETENTION_DAYS` | 21 | Days before `.corrupt-*` and `.pre-migration-*` backups are deleted | Whole number 1 to 21. A larger whole number is capped at 21 with a warning; anything else falls back to 21 with a warning. The app tells users backups go within 30 days (21 plus the 7-day hold and a purge delay; a hard 30-day ceiling applies anyway) |

`REQUIRE_VERIFIED_EMAIL` rollout note. Turning it on:
- logs out every JWT without the `ev` claim, so running apps act logged out until their next session;
- asks password users without a stored verified state, including verified ones who signed in more than 5 minutes ago, to sign in again once (`sign_in_again`);
- adds a Firebase revocation check to every sign-in, so sign-in fails during a Firebase outage;
- refuses password users when the server clock runs behind (look for `[auth] A token auth_time is ahead`);
- registers `POST /api/account/delete-unverified`.
Before turning it on: test on a real Firebase project (Google relink, revocation, `auth_time` on refresh, `getUser`) and re-review the last fix loop of this feature, which has only the developer's tests. The email takeover (someone registers another person's address with a password first) is closed with the flag on or off, by the session generation and auth floor described under Auth flow.

Test-only overrides, honoured only with `NODE_ENV=test`: `IMAGE_STORAGE_MAX_BYTES`, `DB_GROWTH_MAX_BYTES`, `MEDIA_CACHE_MAX_BYTES`, `ACCOUNT_TOMBSTONE_MS`, `ACCOUNT_DELETION_RETRY_INTERVAL_MS`, `DB_BACKUP_PURGE_INTERVAL_MS`, `DB_RECOVERY_PURGE_HOLD_MS`.

## Persistence
- All data lives in `DB_FILE` (default `server/data/db.json`), loaded at start and written after every mutation. Reads write nothing.
- **`DB_FILE` needs its own directory.** Temp files (`.tmp-*`), backups and the backup purge all work in that directory and match on the database's file name. Do not keep other copies of the database there.
- Saves are atomic: temp file (mode 0600), fsync, rename. A failed save returns 503 and keeps the previous file.
- Windows `EPERM`: the rename (on `EPERM`, `EBUSY`, `EACCES`) and the startup read (those plus `EMFILE`) are retried up to 5 times with waits of 25, 50, 100, 200 and 400 ms (about 0.8 s at most, failure path only), with one log line naming the action, the count and the codes, never a path or message. A save still failing after that returns 503 as above.
- Rollback after a failed save: creates (post, comment, Smart Bar item, avatar, report, partner request), post edits (with their report snapshots), cheers and saves (set, count and the cheer notification), profile edits, acknowledgements, audit entries, partner and block changes, post and comment deletions and moderation actions are undone. Not undone: marking notifications read, deleting a Smart Bar item, and a new user created at sign-in (no token is issued; a retry reuses the record). A `sessionGen` bump and its `auth.session_revoked` audit entry are kept on purpose (see Auth flow).
- Loading: no file means an empty start (production needs `ALLOW_EMPTY_DB=true`). Invalid JSON or an invalid shape saves a verified copy to `<DB_FILE>.corrupt-<timestamp>`, then starts empty, or exits in production unless `ALLOW_EMPTY_DB=true`. Any other load failure exits and writes nothing.
- Schema version 2: text is stored plain. A file without `dbSchemaVersion` is backed up to `<DB_FILE>.pre-migration-<timestamp>`, decoded once from the old HTML-escaped form and saved (`[db] Migrated to schema version 2`). A failed backup or decode stops startup with the file unchanged. Running older code on a migrated file and then newer code again can double-decode.
- No seed data (`DEFAULT_USERS = []`, `DEFAULT_DRINKS = []`). New users start with empty city, bio and Smart Bar.
- Known limitation (DATA-1, launch blocker): the JSON file is lost on redeploy without a persistent volume, and each save blocks the server. Any feature that adds data should keep the data-access code isolated so it can move to a real database (Supabase Postgres or MongoDB Atlas are the candidates) without rewriting routes.

### Backups and recovery
Owner rule: a deleted account is gone from every backup within 30 days, and the app says so (`deleteAccount.warning`, privacy notice).
- In-server backups: `.corrupt-*` and `.pre-migration-*` hold personal data, including that of deleted accounts. They are deleted after `CORRUPT_BACKUP_RETENTION_DAYS` (default and maximum 21), counted from the timestamp in the file name. The purge runs every 24 hours, or sooner when a backup is due.
- 7-day recovery hold: after a start that lost its data (no file, a corrupt file, or no users) only backups past the ceiling are purged for 7 days, so an operator can recover. `recoveryStartedAt` is saved in the file so restarts do not extend or reset it. The hold also starts when the last user is deleted. A start that just migrated applies only the ceiling until the next timer run.
- Hard ceiling (`DB_BACKUP_HARD_MAX_DAYS` = 30): a backup older than 30 days is always deleted, during the hold, at a start that lost its data, and right after a migration.
- Scheduled backups: `npm run backup` (`server/scripts/backup.js`) copies the database through an adapter (`BACKUP_SOURCE`, default and only one `json-file`; a Postgres adapter would go there), parses the copy, then prunes by the date in the file name. Daily copies in `<BACKUP_DIR>/daily` are kept 7 days; weekly copies in `<BACKUP_DIR>/weekly` (the Sunday UTC run, or the first run of a week with none) are kept 4 weeks (28 days). A failed backup never prunes. Env: `DB_FILE` (same default as the server), `BACKUP_DIR` (default `server/backups`; use separate storage in production), `BACKUP_SOURCE`. Must run daily; host and volume snapshots must be kept 30 days or less.
- Restoring a backup that has users and no `recoveryStartedAt` ends a running hold, so the next purge can delete expired backups. Move the backups you want to keep out of the directory first.
- Restoring a backup brings deleted accounts back; repeat those deletions by hand. A corrupt start loses pending account deletions, because they were stored in the corrupt file.
- Restoring an older file lowers users' `sessionGen`, so JWTs logged out since the backup work again. Until a fix exists, rotate `JWT_SECRET` after any restore so everyone signs in again (runbook in `server/README.md`).

## Auth flow
1. Phone signs in with Firebase Auth (email/password or Google with PKCE; Apple on iOS) and gets an idToken.
2. Client calls `POST /api/auth/mobile { idToken, uid, email, displayName, photoURL }`.
3. Server runs `verifyIdToken(idToken)`; an invalid token or decoded.uid ≠ body.uid returns 401. Otherwise it creates/updates the user and signs an internal JWT (HS256, 30-day expiry, `JWT_SECRET`, `ev: true` when the email is verified, `sg` = the user's `sessionGen` when above 0). The email comes only from the verified token. `photoURL` comes only from the verified token, is accepted only from https `lh3` to `lh6.googleusercontent.com`, and never replaces an existing avatar (nor sets one for a suspended user).
4. Client stores the JWT in SecureStore; `setApiToken()` makes `apiFetch` (src/lib/api.ts) inject it into every request. A 401 on the JWT in use triggers one session rebuild (at most every 30 s).
A valid JWT whose uid is not in the database, whose account deletion is pending, or whose `sg` (missing = 0) differs from the stored `sessionGen`, counts as logged out.
Accounts are matched by Firebase uid only; nothing looks up or links accounts by email.

Email takeover guard (works with `REQUIRE_VERIFIED_EMAIL` on or off):
- A strong verified sign-in is a token with a verified email that is either federated (Google, Apple; decided from the token's own claims, even if stale) or a password sign-in that is not stale and whose `auth_time` is within 5 minutes.
- It raises `sessionGen` (logging out every earlier JWT) when the stored state is unverified, or on the account's first federated sign-in (`federatedVerifiedAt` is then set). The bump is not rolled back on a failed save, on purpose.
- It also sets the auth floor `verifiedAuthFloor` (password: its `auth_time`; federated: `iat + 1`; also on a new account's strong sign-in). A password token whose `auth_time` is below the floor gets 403 `sign_in_again`, checked before anything is written.
- With the flag off, a verified but not strong token gets a JWT without `ev` and the stored state stays unverified. Once `federatedVerifiedAt` is set, an unverified token cannot lower the stored verified state.
Password reset ends the server session (Firebase mode, owner decision of 2026-11-12):
- Every sign-in makes one `getUser(uid)` call (`lookUpFirebaseUser`) after the token check and the deletion and growth checks. With `REQUIRE_VERIFIED_EMAIL` off it is the only Firebase call: `verifyIdToken(idToken, true)` would do the same lookup inside firebase-admin and not return the value. Failed lookup or unreadable date: 503 `auth_unavailable`, no JWT, nothing written (fails closed, also for new users). No such user: 410 `account_deleted`; disabled: 401 (same body as an invalid token). For an existing live account both also raise `sessionGen` once per state (`firebaseSessionEndedReason`, cleared by the next good lookup), in their own save, with `auth.session_revoked` `reason: 'account_gone'` / `'account_disabled'`; a brand-new uid writes nothing. An ID token whose `auth_time` (missing counts as before) is before `tokensValidAfterTime` (Firebase's answer, or the stored value when a concurrent sign-in stored a newer one during the lookup): 401.
- `user.tokensValidAfterSeen` (ms since epoch; 0 = looked up, Firebase reported none; missing = never looked up). Newer Firebase value than the stored one: `sessionGen` + 1 (one bump even when the takeover guard bumps too) and `auth.session_revoked` with `meta.reason: 'tokens_revoked'`. First lookup of an existing account (nothing stored): bumps only if the Firebase value is later than `lastIdTokenIat` (the iat of the last accepted ID token sign-in, so no JWT is newer), otherwise only stores. A new account stores without a bump. The bump is applied right after the revocation checks, before the 403 answers (`sign_in_again`, `email_not_verified`), which save it too. Kept on a failed save like the other bump, so a retry does not bump again. Never in a response or a log line; leaves with the user record on account deletion.
- With `REQUIRE_VERIFIED_EMAIL` on, the flag's own `verifyIdToken(idToken, true)` still runs, so that mode makes two Firebase calls per sign-in.
- Dev mode (`ALLOW_INSECURE_DEV_AUTH`) makes no lookup and stores nothing.
- Limit: the floor covers password sessions only. If Firebase lets an attacker link another provider with a different email before the relink, it passes; check on the real project before enabling more providers.

Sign-in answers 410 `account_deleted` for a pending deletion, a token issued before a deletion finished or a uid Firebase does not know, 503 `auth_unavailable` when the Firebase lookup fails, 401 for a token issued before `tokensValidAfterTime`, 403 `sign_in_again` for a password token below the auth floor, and 507 `storage_full` for a new user when the database is full. With `REQUIRE_VERIFIED_EMAIL` on it can also answer 403 `email_not_verified` or `sign_in_again` for other reasons (see the rollout note).
New accounts are stored with `noticePending` and `createdAt`, and look blank to others (no name, city, bio or avatar, and left out of search) until the owner accepts the privacy notice.

## Sign-in and age gate (alcohol policy rule 1, enforced here)
Owner decision: nothing is readable without signing in, and nothing but the first-run flow works before the 18+ confirmation.
- `requireSignedInAdult` is mounted on `/api` (after the rate limiters, before every body parser and route) and on `/media` (after the media limiter). No valid JWT: 401. Signed in but not confirmed: 403 `age_required`. Refusals carry `Vary: Authorization` and `Cache-Control: no-store`.
- Exempt for everyone: `POST /api/auth/mobile`, `POST /api/account/delete-unverified` (flag on only), `/healthz` and `/readyz` (outside `/api`).
- Exempt before the confirmation, for the caller's own uid only (`:id` must equal the JWT's uid; the routes check ownership again): `GET /api/users/:id`, `PUT /api/users/:id`, `POST /api/users/:id/acknowledgements`, `POST /api/users/:id/delete-account`.
- Paths match without case and with an optional trailing slash; `HEAD` counts as `GET`. A path the rules miss gets the full gate, never less.
- `POST /api/users/:id/acknowledgements { type: 'age', confirmed: true }` stores only `ageConfirmedAt`, never a birth date. There is no decline: the app's age gate offers only Confirm, Log out and Delete account.
- Admins need the confirmation too.
- Defence in depth that stays: a post counts as alcoholic unless `isAlcoholic === false`; `canViewDrink` still checks the age gate, blocks and the hide after reports; `POST /api/drinks` refuses an alcoholic post from an unconfirmed user; notifications naming an alcoholic post show neutral text to an unconfirmed reader; AI recipe routes give unconfirmed users mocktails only.
- `ageConfirmed` is owner-only (`toOwnerUser`): the client uses its presence to prove that a stored JWT is the owner's.

## Audit log (T6-1, SEC-H)
- `auditLog` in the database: `{ id, at, action, actorId, targetId, meta? }`. Ids are uids, a `deleted-<hex>` id or null. Never stored: IP, user agent, email, names, report or suspension reason text, tokens or request bodies. Refused sign-ins are not logged.
- 8 actions (`AUDIT_META_KEYS` lists the only meta keys each may keep): `ack.age_confirmed`, `ack.privacy_accepted` (`version`), `auth.session_revoked` (a `sessionGen` bump; `reason`: `tokens_revoked` for the password-reset bump, `account_disabled` / `account_gone` when Firebase reports an existing account disabled or deleted, absent for the takeover guard's), `account.deletion_requested`, `account.deletion_completed`, `admin.report_resolved` (`reportId`, `action`, `resolvedCount`), `admin.user_suspended` (`permanent`), `admin.user_unsuspended` (`void`). `appendAudit` throws on any other action.
- Written in the same save as its action and undone with it when that save fails. Allowed while the growth guard blocks writes, because both budgets are capped.
- Retention 90 days (`AUDIT_RETENTION_DAYS`), pruned at load and by the 24-hour purge timer; backups add up to 30 days.
- `auth.session_revoked` is written at most once per account and reason per 24 hours (`appendSessionRevokedAudit`); the `sessionGen` bump itself always happens. So repeated password resets cannot push other users' consent records out of the shared budget.
- Two budgets, so users cannot push moderation records out: the user's own actions (`AUDIT_SELF_ACTIONS`: the two acknowledgements, `auth.session_revoked`, `account.deletion_requested`) keep their newest 15,000 (`AUDIT_USER_MAX_ENTRIES`) among themselves; admin entries and completed deletions have a separate safety cap of 20,000 (`AUDIT_SYSTEM_MAX_ENTRIES`). Eviction is undone with a failed save.
- At load every entry is rebuilt from the whitelist (known fields, allowed meta keys with plain values); an entry with no whole-number id, an unknown action or a non-string id is dropped.
- Account deletion: the user's own entries are deleted (data minimisation); admin entries by or about them get the same `deleted-<hex>` id as their kept open reports. That id is made once and stored on the pending deletion entry, so a retried cascade keeps reports and audit entries matching.
- Read: `GET /api/admin/audit` (see Endpoints). All access goes through the helpers (`appendAudit`, `pruneAuditLog`, `anonymizeAuditForUser`, `listAuditEntries`) so the log can move to a real database.
- Cost: at the full cap the log adds about 3 to 4 MB to every save (one more reason for DATA-1).

## Moderation decisions (owner decisions of 2026-11-10)
Auto-hide after reports:
- A post, comment or profile with at least 3 (`AUTO_HIDE_REPORTER_THRESHOLD`) distinct counting reporters among its open reports is hidden from everyone but its owner and the admins, until an admin resolves the reports (a dismiss also unhides). It is derived from open reports, never stored.
- A reporter counts only if their account is at least 48 hours old (`createdAt`; accounts without it are legacy and count) and has accepted the privacy notice. Every report still reaches the admin queue.
- Hidden content answers like missing content (404), and is left out of every list, detail, search, comment list, report target lookup and `/media` route. A hidden profile is shown stripped (like a pending notice), has no avatar for others, and is left out of search. A notification created while the actor's profile was hidden names "Someone" for good.
- The owner (and admins) get `hiddenPendingReview: true` on the post, comment or own profile; the app shows a notice. A post's owner can still delete a hidden comment on their post.
- A deleted reporter's open reports stay under one anonymous `deleted-<hex>` id, without details, and keep counting only if they counted at deletion. Their resolved reports are removed.

Official account (owner decision of 2026-11-12):
- `isOfficialUser(uid)` = uid in `OFFICIAL_USER_IDS`. `toPublicUser` and `toOwnerUser` always carry `official` (boolean; the stripped view is always false), so every post, comment, search, partner, request, block and admin-target user object has it.
- No auto-hide: `isTargetAutoHidden(target, ownerId)` is false when the owner is official, so its posts, comments and profile are never hidden by reports and never get `hiddenPendingReview`. Reports are still accepted and queued; admin queue items carry `targetOfficial` (and `autoHidden: false`). Admins can still remove content, clear the profile and suspend it (not exempt like admins, unless also in `ADMIN_USER_IDS`).
- Reserved names: `isReservedDisplayName(first, last)` checks the first name, the last name and both together. Folding (best effort, not a full Unicode TR39 confusables check): NFKC, lowercase, diacritics stripped; Cyrillic, Greek, Cherokee and other Latin look-alikes, regional-indicator letters and digits or symbols used as letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t, ! i, | i, $ s, @ a; "l" reads as "i") mapped to a-z; any other letter or symbol becomes a wildcard; spaces, punctuation and invisible characters removed. "drinkme" matches with at most 2 wildcards (at least 5 real letters), or with the wildcards removed; "rn" read as "m" and "cl" read as "d" are checked too. A non-official name is also refused when it contains "official" / "oficial" or a check mark (✓ ✔ ☑ ✅ 🗸 🗹 ⍻ √), so it cannot imitate the badge. `PUT /api/users/:id` answers 400 `name_reserved` for a non-official user when the saved name would change (or `nameSetByUser` flips, i.e. the name prompt publishes a masked email-prefix name) and match. At sign-in such a provider or body name is not stored for a non-official new account: it starts with an empty name (`needsName`) and `nameReservedAtSignIn: true` (owner view only while `needsName`; deleted by the next successful profile save).
- Names stored before the rule stay as they are (no silent data change); startup logs their count only. City and bio edits still work; a name change that keeps the brand is refused; admins can `clear_profile`.

Suspensions:
- Admins suspend through `POST /api/admin/users/:id/suspend` or `suspend: true` on a resolve. The first counted suspension lasts 7 days; any later one is permanent. `permanent: true` makes it permanent at once.
- A suspension in force gives 409 `already_suspended` (with the current state) unless `permanent: true` escalates a temporary one, so a double tap changes nothing.
- `POST /api/admin/users/:id/unsuspend` ends it; `{ void: true }` marks it a mistake, kept in the history but not counted towards "a repeat is permanent". Nothing in force: 200 with the unchanged state.
- Admins cannot be suspended (403 `cannot_suspend_admin`). Unknown or deleted user: 404.
- A suspended user gets 403 `account_suspended` with `until` (null when permanent) on: `POST /api/drinks`, `PUT /api/drinks/:id`, `POST /api/drinks/:id/comments`, `POST /api/drink-partners/:targetId`, `POST /api/drink-partners/requests/:fromId/accept`, `PUT /api/users/:id`, `POST /api/users/:id/avatar`, `POST /api/reports`. Reading, cheers, saves, blocks, removals, Smart Bar, notifications, logout and account deletion still work.
- The owner's profile carries `suspendedUntil` and `suspendedPermanently` while suspended. The history (`user.suspensions`) keeps only dates, the permanent and voided flags, the reason (up to 300 characters; on a resolve, `report <id>: <reason code>`) and admin ids; an admin's id is removed from others' histories when the admin's account is deleted.
- Expiry is read from the date; nothing runs when it ends.

## Endpoints
Every `/api` and `/media` route except sign-in and `delete-unverified` needs a signed-in, 18+ confirmed caller (`requireSignedInAdult`, see above); nothing is readable logged out. `auth` = the route also runs requireAuth (401 otherwise). `owner` = the `:id` must be the caller (403). `not suspended` = 403 `account_suspended` while the caller is suspended. Blocks apply in both directions and answer like a missing record (404); so does content hidden after reports, for everyone but its owner and admins.

**Paged lists** take `?limit=` (1 to 50, default 20) and `?before=<id>` (exclusive; pass the previous `nextCursor`) and return `{ items, nextCursor }`, newest id first; `nextCursor` is null on the last page. Invalid values return 400. Every route that names a post or comment by id accepts only a plain positive integer.

Health: `GET /healthz` (no sign-in, liveness) · `GET /readyz` (no sign-in, readiness: 200 once the database is loaded and, in production, firebase-admin is initialised; 503 `{status:'not_ready', reason}` with `db_not_loaded` | `auth_not_initialized` | `shutting_down`)
Media (outside `/api`, 600 req / 15 min / IP, signed in and 18+ confirmed, `Cache-Control: private, max-age=86400`, ETag, 304; refusals and 404s are `no-store` with `Vary: Authorization`): `GET /media/drinks/:id` (blocks and the hide after reports as for the post; users in `ADMIN_USER_IDS` bypass both here, to review reports) · `GET /media/avatars/:userId` (404 while the owner's notice is pending or the profile is hidden after reports, except to its owner and admins). JSON responses carry `/media/...` paths, never image bytes. `avatar` is a `/media/avatars/:id?v=<hash>` path, a Google photo URL, or null.
Auth: `POST /api/auth/mobile`
Users:
- `GET /api/users/search` (auth; `?q=`, under 2 characters returns `[]`, at most 50 results, 60 searches / 15 min per account; matches public name and city only; leaves out pending-notice and hidden profiles; adds `isPartner` and `partnerStatus`)
- `GET /api/users/:id` (open to the owner before the 18+ confirmation; owner gets `toOwnerUser` plus `partnerCount`, and `hiddenPendingReview`, `suspendedUntil`, `suspendedPermanently` when they apply; other viewers get the public profile plus `partnerStatus`, and `partnerCount` only if they are that user's partner)
- `GET /api/users/:id/partners` (auth; the owner and that user's partners only, otherwise 403 `partner_list_private`)
- `PUT /api/users/:id` (auth + owner + not suspended; open to the owner before the 18+ confirmation; `firstName`, `lastName`, `city`, `bio`, and `nameChosen: true` from the name prompt; 400 `name_reserved` for a brand-name look-alike from a non-official user)
- `POST /api/users/:id/acknowledgements` (auth + owner; open before the 18+ confirmation; `{ type: 'age', confirmed: true }` or `{ type: 'privacy', version }`; works when storage is full)
- `POST /api/users/:id/avatar` (auth + owner + not suspended)
- `GET /api/users/:userId/saved-drinks` (auth + owner; paged)
- `POST /api/users/:id/delete-account` (auth + owner; open before the 18+ confirmation and while suspended; body `{ idToken }`; see Account deletion)
- `POST /api/account/delete-unverified` (no JWT, exempt from the gate; body `{ idToken }`; exists only with `REQUIRE_VERIFIED_EMAIL` on)
Partners (status values: `none`, `requested`, `incoming`, `partner`; actions answer `{ status, isPartner }`):
- `GET /api/drink-partners` (auth; the caller's partners)
- `GET /api/drink-partners/requests` (auth; `{ incoming, outgoing }`)
- `POST /api/drink-partners/:targetId` (auth + not suspended; asks, or accepts if the target already asked; never removes. 400 for yourself, 404 missing or blocked, 429 `partner_request_limit`)
- `POST /api/drink-partners/requests/:fromId/accept` (auth + not suspended)
- `DELETE /api/drink-partners/requests/:fromId` (auth; declines, 204, tells nobody)
- `DELETE /api/drink-partners/:targetId` (auth; removes a partner or cancels the caller's request, 204. Optional `?expect=partner|request`: 409 `partner_state_changed` with the current status if the button was stale)
- `GET /api/friends/count` (auth)
Posts:
- `GET /api/drinks` (paged; `?q=` text search, `?city=`, `?alcoholic=false`, `?category=` (one of the 8 categories; applied after visibility and before ranking and paging; works with discover and trending; `alcoholic=false` with an alcoholic category is 400), `?scope=discover` (auth; excludes own and partners' posts), `?sort=trending` (top 20 by cheers, one page, no `before`))
- `GET /api/drinks/partners` (auth; paged; own and partners' posts)
- `GET /api/drinks/user/:userId` (paged; also returns `total`)
- `GET /api/drinks/:id` (`hiddenPendingReview: true` on a hidden post, which only its owner and admins receive)
- `POST /api/drinks` (auth + not suspended; 201; optional `category`, see Categories; `isAlcoholic` must be a boolean when sent, missing means alcoholic)
- `PUT /api/drinks/:id` (auth + not suspended; edit own post, see Edit post)
- `DELETE /api/drinks/:id` (auth; owner only, 403 otherwise; 204; removes its comments, cheers, saves and image; does not refund daily limits)
- `POST /api/drinks/:id/like` (auth; body `{ cheered: boolean }` sets the state, idempotent; no body or no field toggles, for older apps; any other value 400; answers `{ cheered, cheersCount }`) · `POST /api/drinks/:id/save` (auth; same with `{ saved }`, answers `{ saved }`). Asking for the state already held saves nothing. Turning one on checks the growth guard. A failed save rolls back the set, the count and the notification. One cheer notification per cheerer and post while the earlier one is kept (7 days, read or not), so cycling a cheer cannot flood the owner
- `GET /api/drinks/:id/comments` (paged; leaves out hidden comments except for their author and admins) · `POST /api/drinks/:id/comments` (auth + not suspended; 201)
- `DELETE /api/drinks/:id/comments/:commentId` (auth; the comment's author or the post's owner, also for a hidden comment; 204)
Blocks: `GET /api/blocks` (auth; the caller's own blocks only) · `POST /api/blocks/:targetId` (auth; `{ blocked: true }`; also ends any partnership and requests, which do not come back on unblock; 429 `block_limit` at 200) · `DELETE /api/blocks/:targetId` (auth; 204)
Reports: `POST /api/reports` (auth + not suspended; `{ targetType: 'drink'|'comment'|'user', targetId, reason, details? }`, reasons `spam`, `harassment`, `underage`, `dangerous_drinking`, `mislabeled_alcohol`, `other`, details up to 300 characters; 201 `{ id }`, or 200 with the existing id for a repeat while open; 404 if not visible; 400 for own content)
Admin (auth + uid in `ADMIN_USER_IDS`, 403 otherwise; 18+ confirmation needed too; API only, no screen; review target 24 hours, nothing alerts on it). Post report items also carry `editedAfterReport` (the post was edited after this report), the current `category`, `rating` and `editedAt` in `target`, and `targetSnapshot` (the content as reported, from the first edit after the report) when present:
- `GET /api/admin/reports?status=open|resolved` (oldest first, at most 100 items; returns `{ items, total, overdueCount }`; `overdueCount` counts open reports older than 24 h whichever status is listed. Each item adds `target` (public view, null once gone), `ageHours`, `overdue`, `openReporterCount`, `autoHideReporterCount`, `autoHidden`, `targetOfficial`)
- `POST /api/admin/reports/:id/resolve { action: 'dismiss'|'remove_content'|'clear_profile', suspend?: boolean, permanent?: boolean }` (resolves every open report on the same target; `clear_profile` only for users, `remove_content` only for posts and comments; 409 if already resolved. `suspend: true` suspends the content's owner, checked before anything changes: 403 `cannot_suspend_admin`, 409 `suspend_target_gone` if the content or owner is gone. The answer adds `suspension` = the suspension result plus `applied`; an owner already suspended is not suspended again unless `permanent: true`, and gets `applied: false, code: 'already_suspended'` while the report is still resolved)
- `POST /api/admin/users/:id/suspend { reason?, permanent? }` (reason up to 300 characters; answers `{ userId, suspended, suspendedUntil, suspendedPermanently, suspensionCount }`; 409 `already_suspended` with that state; 403 `cannot_suspend_admin`; 404 unknown user; 400 on wrong types)
- `POST /api/admin/users/:id/unsuspend { void? }` (same answer shape; nothing in force changes nothing)
- `GET /api/admin/audit?action=&limit=&before=` (newest first, paged `{ items, nextCursor }`; `action` must be one of the 8 audit actions, 400 otherwise; entries hold ids only)
Stories: `GET /api/stories` (always empty)
Notifications: `GET /api/notifications` (auth; returns `notifications` and `unreadCount`) · `POST /api/notifications/read` (auth; marks all read)
- Each item of type `cheer`, `comment`, `partner` or `partner_request` with an actor carries `params`, worked out on every read and never stored: `actorName` (the actor's current name; "Someone" when the entry was made while the actor was hidden, or the account is gone or deleting), `drinkName` (only for the reader's own post that still exists and the reader may see, under its current name; otherwise null), and for `partner` `variant: 'added' | 'accepted'`. Other entries get `params: null` and the app shows the stored English `message`, which stays for older apps. An unconfirmed reader of an alcoholic-post notification gets the neutral text with `actorName: 'Someone'` and `drinkName: null`.
Smart Bar: `GET|POST /api/smart-bar` (auth) · `DELETE /api/smart-bar/:itemId` (auth)
AI (auth; off by default): `POST /api/smart-bar/generate-recipes` · `POST /api/detect-product` · `POST /api/generate-recipes`
These do not exist: editing a Smart Bar item, changing a post's image, `DELETE /api/users/:id`, any `/api/notifications/count` or `read-all` route.

Route-coverage guard: `server/test/helpers/routes.js` holds `ROUTE_MANIFEST`: every route with its gate (`public`, `own-before-age`, `adult`), its `suspended` and `admin` flags and the test files that exercise it. `route-coverage.test.js` reads server.js and fails if a registered route is missing from the manifest (or listed but gone), if a route is registered with a non-literal path, `app.all`/`app.route` or an `express.Router`, or if the public or before-18+ lists change. `route-gates.test.js` checks every listed route against a running server: 401 logged out, 403 `age_required` unconfirmed, 403 `account_suspended` exactly where marked, 403 for non-admins on admin routes, and malformed ids. **Every new route must be added there.**

### Categories
- `DRINK_CATEGORIES` in server.js: alcoholic `cocktail`, `wine`, `beer`, `spirits`; non-alcoholic `mocktail`, `coffee`, `tea`, `other`. It must equal the lists in `src/types/api.ts` (`categories.test.js` checks this).
- Stored as `tags: [category]`; no category is `tags: []`. The category must match the post's alcoholic state (missing `isAlcoholic` = alcoholic) or the request gets 400. Every route that sets a category goes through `parseDrinkCategory`.
- A stored post matches a filter only if its alcoholic state agrees too, so an inconsistent record never shows under the wrong chip. Posts without a category show only under All (and Non-alcoholic when non-alcoholic).

### Edit post (`PUT /api/drinks/:id`)
- Order of checks: gate, requireAuth, `refuseIfSuspended` (403), then the post: missing 404; another user's post 404 if blocked or hidden, else 403; the owner's own auto-hidden post 409 `hidden_pending_review`.
- Body: any of `name`, `description`, `rating` (number 0 to 5), `location` (null or '' clears it), `isAlcoholic` (boolean), `category` (null clears it). Fields left out stay as stored. `imageData` gives 400 (the image cannot change); no editable field gives 400. Text goes through `sanitizeText` / `sanitizeOptional` with the create limits; an empty name or description is 400.
- The category is checked against the flag the post will have after the edit. A flag change that leaves the stored category on the wrong side, without a new `category`, gives 400 `category_required`.
- No change: 200 with the post, no save and no new `editedAt`. Otherwise `editedAt` is set; the growth guard applies only when the record grows (507). No daily cap and no limit event; the mutation limiter applies. A failed save restores every field and removes the snapshots it added.
- No edit history (GDPR-minimal). Moderation evidence instead: the first edit after an open report stores the content as reported on that report as `targetSnapshot`; a second edit never overwrites it. It is removed when the report is resolved or by the account deletion cascade. Owners may edit reported posts below the hide threshold, because refusing would tell them they were reported.

## Account deletion
- `POST /api/users/:id/delete-account` needs the JWT, ownership and a fresh Firebase ID token for the same uid, not revoked, issued in the last 5 minutes; password accounts must also have signed in within 5 minutes (60 seconds of clock skew allowed). 5 attempts / 15 min per account. Works when storage is full.
- Answers `{ deleted: true, firebaseDeleted }`; 401 `reauth_required`; 500 `account_deletion_incomplete`; 503 without Firebase unless `ALLOW_INSECURE_DEV_AUTH=true`.
- A pending entry is saved first, then every stored record that holds or names the user is removed, then the Firebase user. Unfinished deletions resume at startup and every 15 minutes.
- When done, in Firebase mode, a tombstone keeps only the uid for 1 hour (pruned within the next 15-minute run), so an ID token issued before the deletion cannot recreate the account (410 `account_deleted`).
- `delete-unverified` takes the same proof without a JWT, refuses a confirmed email (403 `email_already_verified`), and answers 503 if the Firebase lookup fails.
- The user's open reports about others stay under an anonymous `deleted-<hex>` id without details (see Moderation decisions); resolved ones are removed. The user's admin id is removed from others' suspension histories.
- What code cannot delete: backups until they expire (30 days at most for in-server and `npm run backup` copies), host snapshots and hand-made copies, older request logs, copies cached on other phones, Google-hosted photos, and text other users wrote about the person.

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
| 400 | none | Invalid input, page parameters, filter or category |
| 400 | `name_reserved` | Profile edit: the name uses the brand name reserved for the official account |
| 400 | `category_required` | Edit post: the flag change leaves the stored category on the wrong side |
| 401 | `reauth_required` | Account deletion needs a fresh sign-in. Other 401s have no code (no valid JWT, including a JWT from an older session generation) |
| 403 | `age_required` | The caller has not confirmed 18+ (every route but the exempt ones), or an alcoholic post for an unconfirmed viewer |
| 403 | `account_suspended` | The caller is suspended; body has `until` (null when permanent) |
| 403 | `cannot_suspend_admin` | Admin routes: the target is an admin |
| 403 | `partner_list_private` | Partner list of someone who is not your partner |
| 403 | `sign_in_again` | Sign-in with a password token below the auth floor (flag on or off) |
| 403 | `email_not_verified`, `email_already_verified` | `REQUIRE_VERIFIED_EMAIL` paths (which can also answer `sign_in_again`) |
| 404 | none | Missing, deleted, hidden by a block, or hidden after reports |
| 409 | `partner_state_changed` | Stale partner button; the body carries the current `status` |
| 409 | `hidden_pending_review` | Edit of the owner's own post while it is hidden after reports |
| 409 | `already_suspended` | Suspend while one is in force, without `permanent: true` to escalate; body carries the current state |
| 409 | `suspend_target_gone` | Resolve with `suspend: true` on content or an owner that no longer exists |
| 409 | none | Report already resolved |
| 410 | `account_deleted` | Sign-in to a deleted or deleting account |
| 429 | `daily_post_limit`, `daily_comment_limit`, `daily_report_limit`, `partner_request_limit`, `smart_bar_limit`, `block_limit`, `ai_rate_limit` | Per-user limits. The general rate limiters and search return 429 with no `code` |
| 500 | `account_deletion_incomplete` | The deletion is retried in the background |
| 502 | `ai_upstream_error`, `ai_invalid_output` | The AI call failed or its output was unusable |
| 503 | `ai_disabled` | AI is off; checked after auth and before any upload is read |
| 503 | `auth_unavailable` | Sign-in: the Firebase user lookup failed; retry |
| 503 | none | Save failed, sign-in has no Firebase key, or another Firebase lookup failed |
| 507 | `storage_full`, `image_storage_full`, `user_image_quota` | Storage limits above |

## AI
AI runs only with `AI_PROVIDER=local` (local ai-service + Ollama; no third-party AI, D-24). The OpenAI provider and the
legacy routes `/api/detect-product`, `/api/generate-recipes`, `/api/smart-bar/generate-recipes` were removed on
2026-11-22. Routes, limits (hourly + daily per user), photo rules and env vars: the drinkme-ai-service skill. The client
flags (`AI_ENABLED`, `AI_RECIPES_ENABLED`) are separate kill switches; the app also follows `GET /api/ai/status`.
Production startup: `AI_PROVIDER` must be set explicitly to `off` or `local` (unset, `openai` or unknown refuses the start, operations.js); `local` also needs `AI_SERVICE_TOKEN` (32+ characters) and an `AI_SERVICE_URL` that is loopback, https or a host listed in `AI_SERVICE_PRIVATE_HOSTS` (e.g. `ai-service` on the compose network). `LOG_FORMAT=json` makes the request log one JSON object per line `{ts, method, path, status, ms, size}`, same privacy rules as the text format (default).

## Privacy notice
`PRIVACY_NOTICE_VERSION` is 2 in `server.js` and in `src/screens/OnboardingScreen.tsx`; they must match. Version 2 covers: nothing visible without signing in, the hide after reports, suspensions and their history, kept anonymised open reports, and the 30-day backup rule. The notice text (`onboarding.privacy*` in `LocalizationContext.tsx`) describes the read rules in this file: change it whenever who-can-see-what changes, and raise both numbers when it changes in substance. Deploy the server first; it accepts any version from 1 up to its own. The text has not had a legal review.

## Security already in place - do not regress
- `requireSignedInAdult` on `/api` and `/media` with the short exemption list above; requireAuth on every mutation except sign-in (401 on invalid token); getUserId() returns null on invalid tokens, unknown or deleting accounts and older session generations (no demo fallback).
- Email takeover guard: `sg` / `sessionGen`, `federatedVerifiedAt` and the auth floor, with the flag on or off. Accounts matched by uid only.
- Password reset check: one `getUser` per sign-in, `tokensValidAfterSeen`, fails closed (503 `auth_unavailable`).
- Moderation: auto-hide after 3 counting reporters (never for the official account), suspensions via `refuseIfSuspended` (runs after requireAuth and ownership checks, before any body parser or upload), admins cannot be suspended.
- Ownership checks (403) on profile edits, acknowledgements, avatars, saved lists, account deletion and post deletion.
- Other users get the `toPublicUser` allowlist and owners get `toOwnerUser`; email goes only to the owner. Names derived from an email are hidden. Search terms and the uid in the account deletion URL stay out of request logs.
- Age gate, blocks, reports and partner consent as described above. Partner lists are visible only to the owner and their partners.
- Input sanitization (SEC-A) with validator: `sanitizeText()` / `sanitizeOptional()` on posts, profile updates, comments, reports and Smart Bar items. Any new text input must go through these. They strip control characters (newlines kept, tabs become spaces), C1 controls and bidi overrides, trim, and cut to the length limit without splitting an emoji. **Text is stored plain, not HTML-escaped,** because React Native `<Text>` does not parse HTML. Any web client must encode on output.
- JWTs pinned to HS256; helmet(); CORS restricted via `CORS_ALLOWED_ORIGINS` in production.
- Limits and image checks under Limits above.
- Audit log (SEC-H) for acknowledgements, session revocations, account deletion and admin actions, without IP or free text (see Audit log).
- Route-coverage guard: every route is in `ROUTE_MANIFEST` and its gates are tested (see Endpoints).
- Keep the server clock accurate (NTP): account deletion and the `REQUIRE_VERIFIED_EMAIL` sign-in compare Firebase `iat` and `auth_time` with it, allowing 60 seconds of skew.

## Open security items (from SECURITY.md)
- DATA-1 (blocker): real database.
- INFRA-1 (blocker): backend on a public host (Railway/Render planned, see DEPLOY.md).
- SEC-C: rotate the OpenAI key; restrict the Google Maps key (after the first EAS build, needs SHA-1).
- SEC-D: HTTPS (comes with cloud hosting).
- SEC-E: content security for images (only the signature is checked; re-encoding needed).
- Nobody reviews reports until `ADMIN_USER_IDS` is set and someone is assigned; there is no admin screen and nothing alerts on the 24-hour review target.
- Ban evasion: a suspended user can delete the account and register again (closing it needs something like a stored email hash, a legal question).
- The auth floor is password-only: check on the real Firebase project before enabling more sign-in providers.
- Restoring an older `db.json` revives sessions logged out since the backup; rotate `JWT_SECRET` after a restore until a fix exists.
- 3 colluding accounts that are 48 hours old and accepted the notice can still hide content until an admin reviews it.
- Password reset: earlier JWTs end at the owner's next sign-in after the reset, not at the reset itself (the app is signed out by Firebase then, so this follows quickly in practice). On an account's first lookup after the deploy, a reset is detected only against `lastIdTokenIat`; accounts with none (older records, dev mode) only store the value. `lastIdTokenIat` is also written by a refused flag-on `email_not_verified` sign-in, which can hide a reset between the last JWT and that refusal.
- An account deleted in Firebase outside the app leaves an orphan server record (its sessions end at the next sign-in attempt, the data stays until a cleanup or deletion exists).
- Every sign-in costs one Firebase `getUser`: the per-IP `/api` limiter (100 / 15 min) is the only throttle, so watch the Firebase Admin lookup quota at scale. No change for now.
- Firebase Console (not code): email enumeration protection, a password policy with enforcement, restricting the Firebase web API key, and App Check before the public launch. The app's password-reset cooldown is not a security control.
- Sign-up still says when an email is taken (Firebase does not hide it; accepted).
- Later: refresh tokens, Firebase App Check.

## Rules for every backend change
1. New routes sit behind `requireSignedInAdult` (do not add to its exemption lists without the user's OK). New routes that change data use requireAuth, an ownership check where relevant, `refuseIfSuspended` if they create content or contact other users, sanitization, and the mutation rate limiter. They save through `saveDbOrRespond`, and roll back their change when it fails.
2. New content that counts against a daily limit records a limit event; new growth checks `isDbGrowthBlocked()`. Removals stay open when storage is full.
3. New read routes apply `canViewDrink` (age gate, blocks, hide after reports), `isCommentHiddenFrom` / `toPublicUser(user, viewerId)` for comments and profiles, and `isLiveAccount`, and return `{ items, nextCursor }` if they list records.
4. New stored data about a user must also be removed by `deleteUserDataCascade` (as the audit log is: own entries deleted, admin entries anonymised).
5. Update the shared types in `src/types/api.ts` and call the route through `apiFetch` on the client. If the change alters who can see what, update the privacy notice text and version.
6. Never log tokens, secrets or full request bodies with user data.
7. Never read, print or modify `server/.env`, `server/serviceAccount.json` or anything in `server/data/`.
8. Write tests in `server/test/` with node:test, `fetch` and `test/helpers/harness.js`. Run them with `npm test` in `server/`: over 1165 tests, about 14 minutes, port 5055 and a temp database, so only one run at a time.
9. Add every new route to `ROUTE_MANIFEST` in `server/test/helpers/routes.js` with its gate, flags and test files, or `route-coverage.test.js` fails. Never widen the `public` or `own-before-age` lists without the user's OK.
10. A new security or moderation action that should be audited gets an action in `AUDIT_META_KEYS` with id-like meta only, written in the same save as the action and undone with it.
