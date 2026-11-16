# Production checklist (any Docker host)

Host-independent: Railway, Render, Fly.io, a VPS with Docker, or any platform that builds the root `Dockerfile`. Written 2026-11-16. Values in angle brackets are placeholders: never paste real secrets into tracked files.

## 0. Before choosing a host
- `npm run docker:smoke` builds the image and checks it locally (healthz, 401 without a session, no dev route, non-root user, clean start). Needs Docker.
- `cd server && npm test` (full suite) and `npm run check` are green on the commit you deploy.

## 1. Variables (server)
| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Set by the Dockerfile; any other value turns production guards off. |
| `PORT` | host's port (Dockerfile default 8080) | |
| `JWT_SECRET` | 64 random bytes, base64 (`node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"`) | New value for production; never reuse the local one. Rotating it signs everyone out. |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | the whole drinkmeapp-a8fea service-account JSON as one value | Production refuses to start without a valid one. |
| `CORS_ALLOWED_ORIGINS` | empty for the mobile app only; add web origins if a web client exists | |
| `ADMIN_USER_IDS` | `<your uid>` | Never the official account's uid. |
| `OFFICIAL_USER_IDS` | `<official account uid>` | |
| `TRUST_PROXY_HOPS` | `1` on most hosts (one proxy in front) | Check the host's docs; wrong values let clients choose their IP for rate limits. |
| `ALLOW_EMPTY_DB` | `true` for the very first start only | Remove and redeploy after the first start. |
| `DB_DRIVER` | `json` (default) or `postgres` | See section 3. |
| `DB_FILE` | `/data/db/db.json` on a persistent volume (JSON mode) | Its own folder: backups are written next to it. |
| `DATABASE_URL`, `DATABASE_SSL` | Postgres mode only | `DATABASE_SSL=require` (verified TLS) unless the database is on a private network. |
| `APP_CHECK_MODE` | `off` until the app sends tokens, then `monitor`, then `enforce` | docs/APP_CHECK_PLAN.md. A typo stops the start. |
| `REQUIRE_VERIFIED_EMAIL` | unset until decided (docs/DEVICE_CHECKS.md section 2 passed on the server side) | Turning it on signs every app out once. |
| `AI_ENABLED`, `OPENAI_API_KEY` | unset | AI stays off for the beta. |
| `CORRUPT_BACKUP_RETENTION_DAYS` | unset (21) | Never above 21: the app promises removal from backups within 30 days. |

## 2. Deploy and verify
1. Deploy; open `https://<host>/healthz` → `{"status":"ok"}`.
2. Read the start log: `[firebase-admin] ✅ Initialized`, `[official] 1 official account(s) configured`, no `FATAL`, no `[app-check]` warning.
3. Remove `ALLOW_EMPTY_DB`, redeploy.
4. App build: `EXPO_PUBLIC_API_URL=https://<host>` in the EAS build profile; sign in, post, delete a test account.

## 3. Data
- **JSON mode (default):** one instance only, persistent volume for `DB_FILE`'s folder.
- **Postgres mode (DATA-1):** create the database at the provider, set `DB_DRIVER=postgres`, `DATABASE_URL`, `DATABASE_SSL`; migrate once with `npm run db:migrate-to-postgres -- <path to db.json>` (prints counts only); keep `npm run db:export-from-postgres -- <file>` for rollback. One server instance per database. Details and the durability difference: `server/README.md`, "Database: JSON or Postgres".
- **Provider backups / point-in-time recovery:** retention 30 days or less (the app promises a deleted account is gone from backups within 30 days).

## 4. Backups (both modes)
- Schedule `npm run backup` once a day (host cron job or scheduled service) with `BACKUP_DIR` on a second volume or bucket. It keeps 7 daily and 4 weekly copies (all within 30 days). In Postgres mode it exports from the database.
- Example (cron, UTC): `15 3 * * * cd /app/server && npm run backup`.
- Check the next day that a file appeared under `daily/`. After any restore, rotate `JWT_SECRET` (runbook in `server/README.md`, "Backups").
- Host snapshots of the volume: 30 days or less.

## 5. Monitoring
- Uptime check on `/healthz` (any free uptime monitor).
- Log alerts on `FATAL`, `[db]` errors, `[moderation] ADMIN_USER_IDS is empty`, and the daily overdue-reports line.
