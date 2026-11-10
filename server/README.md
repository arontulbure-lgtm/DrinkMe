# DrinkMe API Server

Express backend with JSON-file persistence. Firebase is used only to verify sign-in tokens and to delete Firebase users. Routes, limits and response codes are in `.claude/skills/drinkme-backend-api/SKILL.md`.

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

Uses `node:test` and `fetch`, with no extra dependency. About 975 tests, taking about 10 minutes. Each test server gets a temp database, never `server/data/`. Tests use port 5055, so only one run can go at a time.

## Environment Variables
Core:
- `NODE_ENV`: `development` or `test` for non-production behavior. Any other value, including unset, applies production rules.
- `PORT`: Port to listen on (default `5000`).
- `HOST`: Interface to bind (default `0.0.0.0`).
- `JWT_SECRET`: Signs API tokens. Required in production: at least 32 characters, 16 of them distinct. Outside production, a missing value gives a random secret that lasts until restart.
- `FIREBASE_SERVICE_ACCOUNT_KEY`: Service account as a JSON string or file path. Required in production. It also needs permission to delete Firebase users, for account deletion.
- `CORS_ALLOWED_ORIGINS`: Comma-separated production allowlist origins.
- `TRUST_PROXY_HOPS`: Number of reverse proxies in front of the server (default `0`). Too low puts all users behind the proxy in one rate-limit bucket; too high lets clients choose their own IP.

Database:
- `DB_FILE`: Database file path (default `server/data/db.json`). Must be absolute in production. Give it a directory of its own: temp files and backups are written next to it, and the backup purge deletes files there whose names match the database's.
- `ALLOW_EMPTY_DB`: `true` lets production start with no database file, or start empty after a corrupt one is backed up. Use it for a first deploy only, then remove it.
- `CORRUPT_BACKUP_RETENTION_DAYS`: Days to keep `.corrupt-*` and `.pre-migration-*` backups (default `30`, allowed `1` to `36500`; anything else uses `30` with a warning). A value above `30` logs a warning, because the app tells users backup copies are removed within 40 days.

Accounts and moderation:
- `ADMIN_USER_IDS`: Comma-separated Firebase uids allowed to use `/api/admin/*` (default empty, so every admin route returns 403 and nobody can review reports; production logs a warning). Ids are never logged, only a count of ids that match no user.
- `PARTNER_CONSENT_REQUIRED`: On unless exactly `false`. On, a partnership needs a request and an accept. `false` is an emergency rollback only: anyone can add themselves as someone's partner and then read that person's partner list, which makes partner lists effectively public; links made while it is off stay after turning it back on; and the privacy notice's sentence about private partner lists becomes untrue. Production logs a warning while it is `false`.
- `REQUIRE_VERIFIED_EMAIL`: On only when exactly `true`; needs Firebase. On, accounts with an unconfirmed email get 403 `email_not_verified` and no API token, and `POST /api/account/delete-unverified` exists. Production logs a warning while it is off. See the rollout note below before turning it on.

AI and development:
- `AI_ENABLED`: AI routes run only when this is exactly `true`. Otherwise they return 503.
- `OPENAI_API_KEY`: Required for AI, and not enough on its own to enable it.
- `ALLOW_INSECURE_DEV_AUTH`: `true` makes sign-in trust the client uid when no Firebase key is set. Ignored in production. Without it, sign-in returns 503 in that case.

Test-only overrides (`IMAGE_STORAGE_MAX_BYTES`, `DB_GROWTH_MAX_BYTES`, `MEDIA_CACHE_MAX_BYTES`, `ACCOUNT_TOMBSTONE_MS`, `ACCOUNT_DELETION_RETRY_INTERVAL_MS`, `DB_BACKUP_PURGE_INTERVAL_MS`, `DB_RECOVERY_PURGE_HOLD_MS`) are ignored unless `NODE_ENV=test`.

### `REQUIRE_VERIFIED_EMAIL` rollout note
Do not turn it on before testing against a real Firebase project: Google relinking an address registered with a password, token revocation, `auth_time` on token refresh, and `getUser`. Its last round of security fixes also still needs a re-review. Turning it on:
- Logs out every API token issued without the `ev` claim, so running apps act logged out until their next session.
- Asks password users without a stored verified state, including verified ones who signed in more than 5 minutes ago, to sign in again once.
- Adds a Firebase revocation check to every sign-in, so sign-in fails during a Firebase outage.
- Refuses password sign-ins when the server clock runs behind. Look for `[auth] A token auth_time is ahead` in the log.

While it is off, someone who registers another person's email address first keeps a working API token after the real owner signs in with Google, for up to 30 days.

## Production startup guard
With production rules, the server exits at startup and names the setting to fix, never its value, when any of these fail:
- `JWT_SECRET` meets the rules above. The old hardcoded default is refused in every environment.
- `FIREBASE_SERVICE_ACCOUNT_KEY` gives a working service account.
- `DB_FILE`, if set, is absolute.
- The database file exists, unless `ALLOW_EMPTY_DB=true`.
- The database file holds valid data, unless `ALLOW_EMPTY_DB=true`. An invalid file is copied to `<DB_FILE>.corrupt-<timestamp>` first.

## Data operations
- Saves are atomic. A failed save answers 503 and keeps the previous file; creates, profile edits and most other changes are undone in memory. Cheer and save toggles, marking notifications read and deleting a Smart Bar item are not.
- Size guard: once the saved file passes 450,000,000 bytes, anything that grows the database answers 507 `storage_full`. The file cannot be loaded above about 536.87 million bytes, so this keeps the server able to restart. Sign-in of existing users, removals, blocks and account deletion keep working.
- Text is stored as typed, not HTML-escaped, because the only client renders it with React Native `<Text>`. Any web client must encode it on output.
- Keep the server clock accurate (NTP). Account deletion needs a Firebase token issued within the last 5 minutes and allows 60 seconds of skew.

### Backups and retention
- `.corrupt-<timestamp>` and `.pre-migration-<timestamp>` backups hold personal data, including that of deleted accounts. They are deleted once older than `CORRUPT_BACKUP_RETENTION_DAYS`, counted from the timestamp in the name. The check runs every 24 hours, or earlier when a backup is due.
- After a start that lost its data (no file, a corrupt file, or no users), nothing is deleted for 7 days, so there is time to recover. The start time is saved as `recoveryStartedAt`, so restarts do not reset it. The hold also starts when the last user deletes their account.
- Restoring a backup that has users but no `recoveryStartedAt` ends a running hold, and the next check deletes expired backups. Move any backup you want to keep out of the directory before restoring.
- Restoring a backup brings back accounts deleted since it was made: repeat those deletions. A start from a corrupt file loses pending account deletions, because they were stored in that file.
- Host snapshots and hand-made copies are outside this retention and must be handled separately.

### Account deletion
`POST /api/users/:id/delete-account` saves a pending entry first, removes every record that holds or names the user, then deletes the Firebase user. Unfinished deletions resume at startup and every 15 minutes. A finished deletion keeps only the uid for about 1 hour, so a Firebase token issued before the deletion cannot recreate the account.

## Enabling AI
AI needs `AI_ENABLED=true`, `OPENAI_API_KEY`, and the client flags in `ScannerScreen.tsx` and `SmartBarScreen.tsx`. The server-side age gate is in place: users who have not confirmed their age get mocktail recipes only. Do not enable AI where real users can reach it until all of these are done:
- A global daily AI cap and a hard monthly budget in the OpenAI dashboard.
- A privacy disclosure and data agreement for photos sent to OpenAI.
- One real OpenAI call; only a local mock has been used so far.
- A rebuilt scanner screen, since its AI path currently returns null.
- `SmartBarScreen.tsx` sending `nonAlcoholicOnly`.

## Privacy notice
`PRIVACY_NOTICE_VERSION` in `server.js` and `src/screens/OnboardingScreen.tsx` must match. The notice text is under `onboarding.privacy*` in `src/context/LocalizationContext.tsx` and describes what this server lets others read. Change the text whenever those rules change, and raise both version numbers when it changes in substance. Deploy the server before releasing the client.

## Docker
The `Dockerfile` and `.dockerignore` are in the repo root, so build from there. The image has not been built or run yet, so treat these commands as untested.

```bash
docker build -t drinkme-api .
docker run -p 8080:8080 -e JWT_SECRET -e FIREBASE_SERVICE_ACCOUNT_KEY -e CORS_ALLOWED_ORIGINS -e TRUST_PROXY_HOPS -e ADMIN_USER_IDS -v drinkme-data:/app/server/data drinkme-api
```

The image uses Node 22, production dependencies only, a non-root user, `NODE_ENV=production` and `PORT=8080`. `.dockerignore` is an allowlist: only `server/package.json`, `server/package-lock.json` and `server/server.js` enter the build, so a new server source file must be added there and in the `Dockerfile`.

Deploy variables:
- `JWT_SECRET`, as described above.
- `FIREBASE_SERVICE_ACCOUNT_KEY`: Pass the JSON itself, because the image holds no key file.
- `CORS_ALLOWED_ORIGINS`, if browser origins need access.
- `TRUST_PROXY_HOPS`: Set the host's real hop count, which has not been verified for Railway or Render.
- `ADMIN_USER_IDS`: The uids of the people who review reports.
- `ALLOW_EMPTY_DB=true`: For the first start only, then remove it.
- Storage: Mount a volume writable by uid 1000 at `/app/server/data`, or set an absolute `DB_FILE` in a directory of its own. Without a volume, data is lost on redeploy.

Leave `PARTNER_CONSENT_REQUIRED` unset and `REQUIRE_VERIFIED_EMAIL` off unless you have read the notes above. Never pass secrets with `--build-arg`. Do not set `DEBUG=true` in production, because the OpenAI SDK may log request bodies.
