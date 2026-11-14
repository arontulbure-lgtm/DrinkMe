# DrinkMe API Server

Express backend with JSON-file persistence. Firebase is used only to verify sign-in tokens and to delete Firebase users. Full rules, limits and response codes are in `.claude/skills/drinkme-backend-api/SKILL.md`; this file covers running and operating the server.

## Prerequisites
- Node.js 22

## Setup
```bash
cd server
npm install
```

## Running
```bash
npm start
```

Start it from the `server/` folder, because `.env` is loaded from the current folder. The server listens on `PORT` (default `5000`). For local work, `.env` must set `NODE_ENV=development`; otherwise production rules apply and the server may refuse to start. A healthy start logs `[db] Loaded` once a database exists.

The first start on a database from before schema version 2 migrates it once and logs `[db] Migrated to schema version 2 (plain text). Previous file saved to ...pre-migration-<timestamp>`. Keep that backup until the app has been checked, and do not run older server code on the migrated file without restoring it.

## Testing
```bash
npm test
```

Uses `node:test` and `fetch`, with no extra dependency. Over 1165 tests, taking about 14 minutes. Each test server gets a temp database, never `server/data/`. Tests use port 5055, so only one run can go at a time.

Every route must be listed in `ROUTE_MANIFEST` (`test/helpers/routes.js`) with its gate, its `suspended` and `admin` flags and the test files that exercise it. `test/route-coverage.test.js` fails when a route in `server.js` is missing there, and `test/route-gates.test.js` checks the listed gates against a running server.

## Access rules in short
- Nothing is readable without signing in. Every `/api` and `/media` route needs a valid API token (401 otherwise) and a user who has confirmed they are 18+ (403 `age_required` otherwise).
- Exempt for everyone: `POST /api/auth/mobile`, `POST /api/account/delete-unverified` (only with `REQUIRE_VERIFIED_EMAIL` on) and `GET /healthz`.
- Exempt before the 18+ confirmation, for the caller's own account only: `GET /api/users/:id`, `PUT /api/users/:id`, `POST /api/users/:id/acknowledgements`, `POST /api/users/:id/delete-account`. This is everything the app's age gate, privacy notice and name prompt need, plus deleting the account.
- A suspended user gets 403 `account_suspended` on the routes marked "not suspended" below.
- A block, or content hidden after reports, answers exactly like missing content (404).

## Routes
Access: `signed in` = signed in and 18+ confirmed. `owner` = `:id` must be the caller. `admin` = the caller's uid is in `ADMIN_USER_IDS`. Paged lists take `?limit=` (1 to 50, default 20) and `?before=<id>` and return `{ items, nextCursor }`.

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/healthz` | none | `{ status: 'ok' }` |
| GET | `/media/drinks/:id` | signed in | Post image. Admins bypass blocks and the hide after reports here |
| GET | `/media/avatars/:userId` | signed in | 404 while the notice is pending or the profile is hidden after reports |
| POST | `/api/auth/mobile` | none | `{ idToken, uid }`, returns `{ token }` |
| POST | `/api/account/delete-unverified` | none (Firebase ID token) | Exists only with `REQUIRE_VERIFIED_EMAIL=true` |
| GET | `/api/users/search` | signed in | `?q=` (2+ characters), at most 50 results |
| GET | `/api/users/:id` | signed in; owner before 18+ | Owner gets email, `ageConfirmed`, suspension and hide state |
| GET | `/api/users/:id/partners` | signed in | Owner and that user's partners only |
| PUT | `/api/users/:id` | owner, not suspended; before 18+ allowed | Name, city, bio, `nameChosen`. 400 `name_reserved` for a brand-name look-alike (official account excepted) |
| POST | `/api/users/:id/acknowledgements` | owner; before 18+ allowed | `{ type: 'age', confirmed: true }` or `{ type: 'privacy', version }` |
| POST | `/api/users/:id/avatar` | owner, not suspended | JSON `imageData` or multipart `avatar` |
| GET | `/api/users/:userId/saved-drinks` | owner | Paged |
| POST | `/api/users/:id/delete-account` | owner; before 18+ allowed | `{ idToken }`, fresh Firebase sign-in |
| GET | `/api/drink-partners` | signed in | The caller's partners |
| GET | `/api/drink-partners/requests` | signed in | `{ incoming, outgoing }` |
| POST | `/api/drink-partners/:targetId` | signed in, not suspended | Asks, or accepts a pending request |
| POST | `/api/drink-partners/requests/:fromId/accept` | signed in, not suspended | |
| DELETE | `/api/drink-partners/requests/:fromId` | signed in | Declines |
| DELETE | `/api/drink-partners/:targetId` | signed in | Removes or cancels; optional `?expect=partner\|request` |
| GET | `/api/friends/count` | signed in | |
| GET | `/api/stories` | signed in | Always empty |
| GET | `/api/drinks` | signed in | Paged; `?q=`, `?city=`, `?alcoholic=false`, `?category=`, `?scope=discover`, `?sort=trending` |
| GET | `/api/drinks/partners` | signed in | Paged; own and partners' posts |
| GET | `/api/drinks/user/:userId` | signed in | Paged, plus `total` |
| GET | `/api/drinks/:id` | signed in | |
| POST | `/api/drinks` | signed in, not suspended | 201; optional `category` (must match `isAlcoholic`) |
| PUT | `/api/drinks/:id` | post owner, not suspended | Edit text, rating, flag, category; never the image. 409 `hidden_pending_review` while hidden after reports |
| DELETE | `/api/drinks/:id` | post owner | 204 |
| POST | `/api/drinks/:id/like` | signed in | `{ cheered: true\|false }` sets the state; no body toggles |
| POST | `/api/drinks/:id/save` | signed in | `{ saved: true\|false }` sets the state; no body toggles |
| GET | `/api/drinks/:id/comments` | signed in | Paged |
| POST | `/api/drinks/:id/comments` | signed in, not suspended | 201 |
| DELETE | `/api/drinks/:id/comments/:commentId` | comment author or post owner | 204 |
| GET | `/api/blocks` | signed in | |
| POST | `/api/blocks/:targetId` | signed in | `{ blocked: true }` |
| DELETE | `/api/blocks/:targetId` | signed in | 204 |
| POST | `/api/reports` | signed in, not suspended | `{ targetType, targetId, reason, details? }` |
| GET | `/api/notifications` | signed in | Items carry `params` (`actorName`, `drinkName`, `variant`) for the app's ro/en text |
| POST | `/api/notifications/read` | signed in | Marks all read |
| GET, POST | `/api/smart-bar` | signed in | |
| DELETE | `/api/smart-bar/:itemId` | signed in | |
| POST | `/api/smart-bar/generate-recipes` | signed in | AI, 503 `ai_disabled` unless `AI_ENABLED=true` |
| POST | `/api/detect-product` | signed in | AI, upload field `image` |
| POST | `/api/generate-recipes` | signed in | AI |
| GET | `/api/admin/reports` | admin | `?status=open\|resolved`, see Moderation |
| POST | `/api/admin/reports/:id/resolve` | admin | See Moderation |
| POST | `/api/admin/users/:id/suspend` | admin | See Moderation |
| POST | `/api/admin/users/:id/unsuspend` | admin | See Moderation |
| GET | `/api/admin/audit` | admin | Paged, newest first; `?action=`. See Audit log |

## Environment Variables
| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `NODE_ENV` | unset (production rules) | server | `development` or `test` for non-production behavior. Any other value, including unset, applies production rules |
| `PORT` | `5000` | server | Port to listen on |
| `HOST` | `0.0.0.0` | server | Interface to bind |
| `JWT_SECRET` | random per process outside production | server | Signs API tokens. Required in production: at least 32 characters, 16 of them distinct. Rotating it signs everyone out |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | none | server | Service account as a JSON string or file path. Required in production. Needs permission to delete Firebase users |
| `CORS_ALLOWED_ORIGINS` | none | server | Comma-separated production allowlist |
| `TRUST_PROXY_HOPS` | `0` | server | Reverse proxies in front of the server. Too low puts all users in one rate-limit bucket; too high lets clients choose their own IP |
| `DB_FILE` | `server/data/db.json` | server, backup script | Database file. Absolute in production, in a directory of its own (temp files and in-server backups go next to it) |
| `ALLOW_EMPTY_DB` | off | server | `true` lets production start with no database or after a corrupt one. First deploy only |
| `CORRUPT_BACKUP_RETENTION_DAYS` | `21` | server | Days to keep `.corrupt-*` and `.pre-migration-*` backups, `1` to `21`. Larger whole numbers are capped at `21`, anything else uses `21`, both with a warning |
| `ADMIN_USER_IDS` | empty | server | Comma-separated Firebase uids allowed on `/api/admin/*`. Empty: every admin route returns 403 (production logs a warning). Ids are never logged |
| `OFFICIAL_USER_IDS` | empty | server | Comma-separated Firebase uids of the official DrinkMe account, parsed like `ADMIN_USER_IDS`. Gives `official: true` (the app's "Official" badge), the right to use the brand name in the profile name, and no auto-hide by reports. Not an admin, and must never also be in `ADMIN_USER_IDS` (it could not be suspended; startup warns). Ids are logged as counts only; startup also warns while `ALLOW_INSECURE_DEV_AUTH=true`. See Official account below |
| `PARTNER_CONSENT_REQUIRED` | on | server | Off only for exactly `false`, an emergency rollback that makes partner lists effectively public (see below) |
| `REQUIRE_VERIFIED_EMAIL` | off | server | On only for exactly `true`; needs Firebase. See the rollout note |
| `AI_ENABLED` | off | server | AI routes run only when exactly `true` |
| `OPENAI_API_KEY` | none | server | Required for AI, not enough on its own |
| `ALLOW_INSECURE_DEV_AUTH` | off | server | `true` makes sign-in trust the client uid when no Firebase key is set. Ignored in production |
| `BACKUP_DIR` | `server/backups` | backup script | Where `npm run backup` writes. Use separate storage in production |
| `BACKUP_SOURCE` | `json-file` | backup script | Backup adapter. Only `json-file` exists |

Test-only overrides (`IMAGE_STORAGE_MAX_BYTES`, `DB_GROWTH_MAX_BYTES`, `MEDIA_CACHE_MAX_BYTES`, `ACCOUNT_TOMBSTONE_MS`, `ACCOUNT_DELETION_RETRY_INTERVAL_MS`, `DB_BACKUP_PURGE_INTERVAL_MS`, `DB_RECOVERY_PURGE_HOLD_MS`) are ignored unless `NODE_ENV=test`.

`PARTNER_CONSENT_REQUIRED=false`: anyone can add themselves as someone's partner and then read that person's partner list; links made while it is off stay after turning it back on; and the privacy notice's sentence about private partner lists becomes untrue. Production logs a warning while it is `false`.

### `REQUIRE_VERIFIED_EMAIL` rollout note
Do not turn it on before testing against a real Firebase project: Google relinking an address registered with a password, token revocation, `auth_time` on token refresh, and `getUser`. Its last round of security fixes also still needs a re-review. Turning it on:
- Logs out every API token issued without the `ev` claim, so running apps act logged out until their next session.
- Asks password users without a stored verified state, including verified ones who signed in more than 5 minutes ago, to sign in again once.
- Adds a Firebase revocation check to every sign-in, so sign-in fails during a Firebase outage.
- Refuses password sign-ins when the server clock runs behind. Look for `[auth] A token auth_time is ahead` in the log.

### Email takeover guard (flag on or off)
Someone could register another person's email address with a password before its owner. The owner's first verified Google or Apple sign-in, or first fresh verified password sign-in, raises the account's session generation (`sg` in the token), which logs out every earlier token, and sets an auth floor that refuses older password sessions with 403 `sign_in_again`. This works whether `REQUIRE_VERIFIED_EMAIL` is on or off. Accounts are matched by Firebase uid only. The floor covers password sessions only: check on the real Firebase project before enabling more sign-in providers.

### Password reset ends the server session
Every sign-in (Firebase mode) makes one `getUser(uid)` call and reads `tokensValidAfterTime`, which Firebase moves forward on a password reset or change, an email change, or `revokeRefreshTokens()`. An ID token whose `auth_time` is before it, or a disabled user, gets 401; a user Firebase does not know gets 410. For an existing account, disabled or unknown in Firebase also raises the session generation once (`reason: 'account_disabled'` / `'account_gone'`). When the value is newer than the one stored on the user (`tokensValidAfterSeen`, ms since epoch; 0 = looked up, none reported), the session generation goes up, so every earlier API token stops working, and `auth.session_revoked` is logged with `reason: 'tokens_revoked'`. On the first lookup of an account, the value is compared with the last accepted ID token's `iat` (`lastIdTokenIat`): a later revocation bumps, anything else is only stored, so the deploy logs out only accounts reset since their last sign-in. A reset is applied even when that sign-in then gets 403. Earlier tokens end at the owner's next sign-in after the reset, not at the reset itself. Sign-in fails closed: a failed lookup answers 503 `auth_unavailable` (also for new users). The app retries a 401 once with a refreshed Firebase token, so a revoked session signs out cleanly. Dev mode (`ALLOW_INSECURE_DEV_AUTH`) makes no lookup.

## Production startup guard
With production rules, the server exits at startup and names the setting to fix, never its value, when any of these fail:
- `JWT_SECRET` meets the rules above. The old hardcoded default is refused in every environment.
- `FIREBASE_SERVICE_ACCOUNT_KEY` gives a working service account.
- `DB_FILE`, if set, is absolute.
- The database file exists, unless `ALLOW_EMPTY_DB=true`.
- The database file holds valid data, unless `ALLOW_EMPTY_DB=true`. An invalid file is copied to `<DB_FILE>.corrupt-<timestamp>` first.

## Data operations
- Saves are atomic. A failed save answers 503 and keeps the previous file; creates, edits, cheers and saves, moderation actions, audit entries and most other changes are undone in memory. Marking notifications read and deleting a Smart Bar item are not.
- On Windows, something holding the file open (antivirus, an editor) can make the rename fail with `EPERM`. The rename and the startup read are retried up to 5 times (25 to 400 ms, about 0.8 s at most) and log one `[db] ... needed N retries` line with the error codes only.
- Size guard: once the saved file passes 450,000,000 bytes, anything that grows the database answers 507 `storage_full`. The file cannot be loaded above about 536.87 million bytes, so this keeps the server able to restart. Sign-in of existing users, removals, blocks, moderation and account deletion keep working.
- Text is stored as typed, not HTML-escaped, because the only client renders it with React Native `<Text>`. Any web client must encode it on output.
- Keep the server clock accurate (NTP). Account deletion needs a Firebase token issued within the last 5 minutes and allows 60 seconds of skew.

## Backups
**Rule: the app promises that a deleted account leaves every backup within 30 days.** Everything below is set up to keep that promise; anything outside it (host snapshots, hand-made copies) must be kept 30 days or less too.

### Scheduled backups (`npm run backup`)
- Run it once a day from `server/` (cron, or the host's scheduled job), with the same `DB_FILE` as the server:
  ```bash
  cd server
  npm run backup
  ```
- It copies the database to `<BACKUP_DIR>/daily/drinkme-YYYY-MM-DD.json`, checks the copy parses, and on Sundays (UTC), or on the first run of a week with no weekly copy, also writes `<BACKUP_DIR>/weekly/drinkme-YYYY-MM-DD.json`. A second run on the same day refreshes that day's copy.
- Retention: daily copies 7 days, weekly copies 4 weeks (28 days), counted from the date in the file name. A deleted account is gone from these within 30 days.
- A failed backup prints `[backup] FAILED: ...`, exits with code 1 and prunes nothing. Monitor the exit code.
- Put `BACKUP_DIR` on storage separate from the database volume, so one failure cannot take both. Files are written with mode 0600 and directories 0700 (no effect on Windows).
- The script is in the Docker image (`scripts/backup.js`).

### In-server backups
- The server itself writes `<DB_FILE>.corrupt-<timestamp>` (a database that failed to load) and `<DB_FILE>.pre-migration-<timestamp>` (before a schema migration). They hold personal data, including that of deleted accounts.
- They are deleted once older than `CORRUPT_BACKUP_RETENTION_DAYS` (default and maximum 21), counted from the timestamp in the name. The check runs every 24 hours, or earlier when a backup is due.
- After a start that lost its data (no file, a corrupt file, or no users), nothing younger than 30 days is deleted for 7 days, so there is time to recover. The start time is saved as `recoveryStartedAt`, so restarts do not reset it. The hold also starts when the last user deletes their account.
- Hard ceiling: a backup older than 30 days is always deleted, during the recovery hold too.

### Restoring a backup
1. Stop the server.
2. Move the current database file and any `.corrupt-*` / `.pre-migration-*` backup you want to keep out of the `DB_FILE` directory. A restored file with users and no `recoveryStartedAt` ends a running recovery hold, and the next check then deletes expired backups. Delete anything you moved aside within 30 days.
3. Copy the chosen backup (from `<BACKUP_DIR>/daily`, `<BACKUP_DIR>/weekly`, or an in-server backup) to the `DB_FILE` path.
4. **Rotate `JWT_SECRET`.** An older file holds older session generations, so tokens that were logged out after the backup was made (for example an attacker's session closed by the owner's verified sign-in) would work again. Until the server fixes this, a new secret makes everyone sign in again, which is safe.
5. Start the server and check for `[db] Loaded`.
6. Repeat by hand what happened after the backup and is now lost: account deletions (the restored file brings those accounts back), moderation actions (resolved reports, suspensions) and anything users posted. A start from a corrupt file also loses pending account deletions, because they were stored in that file.

### Account deletion
`POST /api/users/:id/delete-account` saves a pending entry first, removes every record that holds or names the user, then deletes the Firebase user. Unfinished deletions resume at startup and every 15 minutes. A finished deletion keeps only the uid for about 1 hour, so a Firebase token issued before the deletion cannot recreate the account. Open reports the user filed about others stay under an anonymous `deleted-<hex>` id without details. In the audit log, the user's own entries are deleted and admin entries by or about them get that same anonymous id.

## Audit log
A minimal record of security and moderation actions, stored in the database (`auditLog`). Each entry holds an id, a time, the action, the acting and target uids (or an anonymous `deleted-<hex>` id, or null) and a few whitelisted values. It never holds an IP, a user agent, an email, a name, report or suspension reason text, a token or a request body. Refused sign-ins are not logged.

- Actions: `ack.age_confirmed`, `ack.privacy_accepted`, `auth.session_revoked` (a sign-in that logged out older sessions), `account.deletion_requested`, `account.deletion_completed`, `admin.report_resolved`, `admin.user_suspended`, `admin.user_unsuspended`.
- Retention: 90 days, pruned at startup and every 24 hours. Backups add up to 30 days.
- Caps: entries users cause themselves keep their newest 15,000; admin entries and completed deletions have their own cap of 20,000, so user activity cannot push them out.
- Entries are rebuilt at startup with only the known fields; anything unrecognised is dropped.

```bash
# Newest first, 20 per page by default (limit 1 to 50); pass nextCursor as before= for the next page
curl -s "$API/api/admin/audit?limit=50" -H "Authorization: Bearer $TOKEN"
curl -s "$API/api/admin/audit?action=admin.user_suspended" -H "Authorization: Bearer $TOKEN"
```
An unknown `action` or invalid page parameters answer 400; a non-admin gets 403.

## Moderation
There is no admin screen; admins use the API. An admin is a uid in `ADMIN_USER_IDS` that has signed in and confirmed 18+ in the app. The review target for an open report is 24 hours; nothing alerts on it, so check the queue daily.

### What happens automatically
- A post, comment or profile with 3 distinct open reporters whose accounts are at least 48 hours old and have accepted the privacy notice is hidden from everyone but its owner and the admins. The owner sees a notice in the app. Resolving its reports (a dismiss too) unhides it at once. Reports from newer accounts still reach the queue.
- Known limit: 3 colluding accounts that meet those conditions can still hide content until an admin reviews it.
- The official account's posts, comments and profile are never hidden this way. Their reports still reach the queue with `targetOfficial: true` (and `autoHidden: false`); admins can remove the content or clear the profile as usual.

### Suspensions
- First suspension: 7 days. Any later one (voided ones do not count): permanent. `permanent: true` makes one permanent at once.
- A suspended user cannot post, edit a post, comment, send or accept partner requests, edit their profile or avatar, or report (403 `account_suspended` with `until`). They can still read, cheer, save, block, log out and delete their account. The app shows a banner on Home and Profile.
- Suspending someone already suspended answers 409 `already_suspended` with the current state, unless `permanent: true` escalates a temporary suspension. Admins cannot be suspended (403 `cannot_suspend_admin`). The official account can be suspended like any user (a kill switch if it is ever compromised), unless its uid is also in `ADMIN_USER_IDS`.
- Known limit: a suspended user can delete the account and register again.

### Official account
- Set up by the owner, not by code (nothing creates the account), in this order:
  1. Sign up in the app with the brand address.
  2. Confirm 18+ and accept the privacy notice.
  3. At the name prompt, choose "Later" or any ordinary name (the brand name is refused until step 5).
  4. Copy the account's uid from the Firebase console (Authentication, Users) into `OFFICIAL_USER_IDS` on the server, and restart it. Never put the same uid in `ADMIN_USER_IDS`.
  5. In the app, Edit profile: set the name to "DrinkMe" / "DrinkMe Official".
- Removing a uid from `OFFICIAL_USER_IDS`: first rename the account (or have an admin clear its profile), because once it is no longer official its brand name stays stored but can no longer be edited into another brand name, and the badge disappears while the name stays. Then remove the uid and restart. Its content becomes subject to the auto-hide again at once (open reports count).
- Every user view has `official` (true only for these uids; the stripped view of a profile without a public name is always false), so posts, comments, search results and partner lists carry it on their `user`. The app shows an "Official" / "Oficial" badge next to the name.
- Reserved names: a non-official account cannot save a first name, last name or both together that contain "drinkme" after folding. Folding (best effort, not a full Unicode TR39 confusables check): NFKC, lowercase, diacritics stripped; Cyrillic, Greek, Cherokee and other Latin look-alikes, regional-indicator letters and digits or symbols used as letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t, ! i, | i, $ s, @ a; "l" reads as "i") mapped to a-z; any other letter or symbol becomes a wildcard; spaces, punctuation and invisible characters removed. "drinkme" matches with at most 2 wildcards (at least 5 real letters), or with the wildcards removed; "rn" read as "m" and "cl" read as "d" are checked too. A non-official name is also refused when it contains "official" / "oficial" or a check mark (✓ ✔ ☑ ✅ 🗸 🗹 ⍻ √), so it cannot imitate the badge. `PUT /api/users/:id` answers 400 `name_reserved` when the name changes (including the name prompt making a masked email-prefix name public). At sign-in such a Google or Apple name is not stored: the account starts without a name, the owner view carries `nameReservedAtSignIn: true` while the name prompt is due (cleared by the next profile save), and the app says why.
- Names stored before this rule are left as they are (no silent data change). The server logs how many there are, as a count only. Edits to city or bio still work; any name change that keeps the brand is refused. An admin can clear such a profile after a report (`clear_profile`).
- No auto-hide by reports (see above). Suspension works as for any user.

### Getting an admin API token
The examples use shell variables; never paste a real token or password into a document or ticket. `EXPO_PUBLIC_FIREBASE_API_KEY` is the client's Firebase web API key from the root `.env`. This works for an admin account with an email and password:

```bash
API=https://your-api-host            # or http://<LAN IP>:5000 locally
FIREBASE_LOGIN=$(curl -s "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$EXPO_PUBLIC_FIREBASE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"returnSecureToken\":true}")
ID_TOKEN=$(echo "$FIREBASE_LOGIN" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).idToken))")
TOKEN=$(curl -s "$API/api/auth/mobile" -H 'Content-Type: application/json' \
  -d "{\"idToken\":\"$ID_TOKEN\"}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
```

A fresh password sign-in counts as a verified sign-in: if the account's stored state was unverified, it logs out the admin's other sessions once, and the app signs in again by itself.

### List the queue
```bash
curl -s "$API/api/admin/reports?status=open" -H "Authorization: Bearer $TOKEN"
```
Oldest first, at most 100 items, plus `total` and `overdueCount` (open reports older than 24 hours). Each item has `target` (the public view of the post, comment or profile; null once gone), `ageHours`, `overdue`, `openReporterCount`, `autoHideReporterCount`, `autoHidden` and `targetOfficial` (the content belongs to the official account, which is never auto-hidden). Use `?status=resolved` for the history (details are cleared on resolve). Owners can edit a reported post (the image never changes): a post report then has `editedAfterReport: true`, `target` shows the current text, and `targetSnapshot` holds the content as it was when first edited after the report. The snapshot is deleted when the report is resolved.

### Resolve a report
```bash
# Dismiss (keeps the content, unhides it if it was auto-hidden)
curl -s -X POST "$API/api/admin/reports/12/resolve" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"action":"dismiss"}'

# Remove a post or comment and suspend its owner
curl -s -X POST "$API/api/admin/reports/12/resolve" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"action":"remove_content","suspend":true}'

# Clear a reported profile (user reports only)
curl -s -X POST "$API/api/admin/reports/12/resolve" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"action":"clear_profile"}'
```
Every open report on the same target is resolved together. 409 if already resolved. With `suspend: true`: 409 `suspend_target_gone` if the content or its owner no longer exists, 403 `cannot_suspend_admin`; in both cases nothing changes. The answer then has `suspension` with `applied`; an owner already suspended gets `applied: false, code: "already_suspended"` (the report is still resolved). Add `"permanent":true` to make the suspension permanent.

### Suspend and unsuspend directly
```bash
# Suspend (7 days the first time, permanent on a repeat). reason is optional, up to 300 characters.
curl -s -X POST "$API/api/admin/users/<uid>/suspend" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"reason":"harassment in comments"}'

# Escalate a temporary suspension to permanent
curl -s -X POST "$API/api/admin/users/<uid>/suspend" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"permanent":true}'

# Lift it (still counts towards "a repeat is permanent")
curl -s -X POST "$API/api/admin/users/<uid>/unsuspend" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'

# Lift a suspension made by mistake (kept in the history, not counted)
curl -s -X POST "$API/api/admin/users/<uid>/unsuspend" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"void":true}'
```
All four answer `{ userId, suspended, suspendedUntil, suspendedPermanently, suspensionCount }`. The uid of a reported profile is the report's `targetId`; for a post or comment it is `target.userId`.

## Enabling AI
AI needs `AI_ENABLED=true`, `OPENAI_API_KEY`, and the client flags in `ScannerScreen.tsx` and `SmartBarScreen.tsx`. Only users who confirmed 18+ reach the AI routes, and the server still gives mocktail recipes to anyone unconfirmed as defence in depth. Do not enable AI where real users can reach it until all of these are done:
- A global daily AI cap and a hard monthly budget in the OpenAI dashboard.
- A privacy disclosure and data agreement for photos sent to OpenAI.
- One real OpenAI call; only a local mock has been used so far.
- A rebuilt scanner screen, since its AI path currently returns null.
- `SmartBarScreen.tsx` sending `nonAlcoholicOnly`.

## Privacy notice
`PRIVACY_NOTICE_VERSION` (currently 2) in `server.js` and `src/screens/OnboardingScreen.tsx` must match. The notice text is under `onboarding.privacy*` in `src/context/LocalizationContext.tsx` and describes what this server lets others read, moderation and the 30-day backup rule. Change the text whenever those rules change, and raise both version numbers when it changes in substance. Deploy the server before releasing the client.

## Docker
The `Dockerfile` and `.dockerignore` are in the repo root, so build from there. Checked on 2026-11-11: the image builds (about 400 MB, includes `scripts/backup.js`), `/healthz` answers in a development start, a production start without secrets refuses as designed, and `npm run backup` inside the image wrote a daily and a weekly copy to a mounted folder. Not yet tested: a production start with a real service account.

```bash
docker build -t drinkme-api .
docker run -p 8080:8080 -e JWT_SECRET -e FIREBASE_SERVICE_ACCOUNT_KEY -e CORS_ALLOWED_ORIGINS -e TRUST_PROXY_HOPS -e ADMIN_USER_IDS -e OFFICIAL_USER_IDS -v drinkme-data:/app/server/data drinkme-api
```

The image uses Node 22, production dependencies only, a non-root user, `NODE_ENV=production` and `PORT=8080`. `.dockerignore` is an allowlist: only `server/package.json`, `server/package-lock.json`, `server/server.js` and `server/scripts/` enter the build, so a new server source file must be added there and in the `Dockerfile`.

Deploy variables:
- `JWT_SECRET`, as described above.
- `FIREBASE_SERVICE_ACCOUNT_KEY`: Pass the JSON itself, because the image holds no key file.
- `CORS_ALLOWED_ORIGINS`, if browser origins need access.
- `TRUST_PROXY_HOPS`: Set the host's real hop count, which has not been verified for Railway or Render.
- `ADMIN_USER_IDS`: The uids of the people who review reports.
- `OFFICIAL_USER_IDS`: The uid of the official DrinkMe account, once the owner has created it.
- `ALLOW_EMPTY_DB=true`: For the first start only, then remove it.
- Storage: Mount a volume writable by uid 1000 at `/app/server/data`, or set an absolute `DB_FILE` in a directory of its own. Without a volume, data is lost on redeploy.
- Backups: schedule `npm run backup` daily in the same image (for example `docker run ... drinkme-api npm run backup` with the same volume and `-e BACKUP_DIR` pointing at separate storage), and keep host or volume snapshots 30 days or less.

Leave `PARTNER_CONSENT_REQUIRED` unset and `REQUIRE_VERIFIED_EMAIL` off unless you have read the notes above. Never pass secrets with `--build-arg`. Do not set `DEBUG=true` in production, because the OpenAI SDK may log request bodies.
