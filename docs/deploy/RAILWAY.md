# Deploy the DrinkMe server on Railway

Written 2026-11-22 for v1.0.0. Every variable is described in `docs/PRODUCTION_ENV.md`; this file covers only the Railway steps. Railway's UI changes often: menu names below are what they were when written, and nothing here was run against a live Railway project yet. Values in angle brackets are placeholders: never paste real secrets into tracked files.

## 0. Before you start
- `npm run docker:smoke` passes locally (builds the root `Dockerfile`, checks `/healthz`, `/readyz`, 401 without a session).
- `cd server && npm test` and `npm run check` are green on the commit you deploy.
- Decide the data mode. **Recommended on Railway: Postgres** (`DB_DRIVER=postgres`). A Railway volume attaches to one service only, so a separate backup job cannot read a JSON database file there.

## 1. Service from the Dockerfile
1. New Project, then Deploy from GitHub repo, and pick the repo and the release branch.
2. Railway finds the root `Dockerfile` and builds it (Node 22, production dependencies only, non-root, `NODE_ENV=production`, port 8080). Leave the root directory empty: the Dockerfile copies from `server/`.
3. Settings, then Networking: generate a domain, or add the custom domain (section 6). The app listens on `PORT`; set `PORT=8080` explicitly so the domain's target port matches.

## 2. Data
**Postgres (recommended)**
1. Add a Postgres database to the project.
2. On the server service, set `DB_DRIVER=postgres`, `DATABASE_URL` as a reference to the database's private URL (`${{Postgres.DATABASE_URL}}` style reference variable), and `DATABASE_SSL`:
   - private network URL: `DATABASE_SSL=disable` (accepted with a warning; the traffic stays on Railway's private network);
   - public URL: `DATABASE_SSL=require`, which needs a certificate the server can verify. If the connection is refused, use the private URL.
3. First deploy only: `ALLOW_EMPTY_DB=true`, or migrate an existing `db.json` once with `npm run db:migrate-to-postgres -- <path>` (run locally with `DATABASE_URL` set to the public URL).
4. One server instance per database: keep replicas at 1 (the server refuses to start when another instance holds the lock).

**JSON file (alternative, single service)**
1. Add a volume to the server service, mount path `/app/server/data`.
2. Set `DB_FILE=/app/server/data/db.json`.
3. Scheduled `npm run backup` cannot run in a second service here (it cannot mount the same volume). Rely on the in-server backups next to the file plus Railway volume backups with retention of 30 days or less, or move to Postgres before real users arrive.

## 3. Variables
Add on the server service (Variables, then Raw editor), from `docs/PRODUCTION_ENV.md` section 1:
```
AI_PROVIDER=off
JWT_SECRET=<64 random bytes, base64>
FIREBASE_SERVICE_ACCOUNT_KEY=<the whole service-account JSON, one line>
TRUST_PROXY_HOPS=<hops in front of the app; verify, see below>
ADMIN_USER_IDS=<your uid>
OFFICIAL_USER_IDS=<official account uid>
APP_CHECK_MODE=off
PORT=8080
# optional
LOG_FORMAT=json
CORS_ALLOWED_ORIGINS=
```
- `AI_PROVIDER` is required: production refuses to start without it. Keep `off` until the AI service is merged and deployed (docs/deploy/EU_GPU.md).
- `TRUST_PROXY_HOPS`: not verified for Railway yet. Start with `1`, then check that two different networks get separate rate-limit buckets (and that a forged `X-Forwarded-For` does not change the bucket) before launch.
- Do not set `NODE_ENV` (the Dockerfile sets `production`), `DEBUG`, `ALLOW_INSECURE_DEV_AUTH` or `REQUIRE_VERIFIED_EMAIL` (see the rollout note in `server/README.md`).

## 4. Health check
Settings, then Deploy, then Healthcheck Path: `/readyz`. A new deploy goes live only when it answers 200 (database loaded, firebase-admin initialised). A 503 body names a reason code only (`db_not_loaded`, `auth_not_initialized`, `shutting_down`).

After the first deploy: read the start log (`[firebase-admin] ✅ Initialized`, `[ai] ` warnings, no `FATAL`), then remove `ALLOW_EMPTY_DB` and redeploy.

## 5. Daily backup job
Postgres mode:
1. Add a second service from the same repo and Dockerfile, named `backup`.
2. Settings: Start Command `npm run backup`, Cron Schedule `15 3 * * *` (UTC). Attach a volume to this service at `/backups`.
3. Variables: the same `DB_DRIVER`, `DATABASE_URL`, `DATABASE_SSL` as the server, plus `BACKUP_DIR=/backups` and `AI_PROVIDER=off`. The job needs no JWT secret or Firebase key: `scripts/backup.js` does not start the server.
4. The next day, check its log and that a file appeared under `daily/`. The script keeps 7 daily and 4 weekly copies (within 30 days).
5. Railway's own Postgres backups: retention 30 days or less (the app promises removal from backups within 30 days).

## 6. Custom domain and HTTPS
1. Settings, then Networking, then Custom Domain: add `api.<your domain>`, then create the CNAME Railway shows at your DNS provider.
2. Railway issues the TLS certificate; HTTPS is on once the DNS check passes. Clients use `https://api.<your domain>`.
3. Set `EXPO_PUBLIC_API_URL=https://api.<your domain>` in the EAS build profile.

## 7. Verify
- `https://api.<your domain>/healthz` gives `{"status":"ok"}`, `/readyz` gives `{"status":"ready"}`.
- `/api/drinks` without a session gives 401.
- Sign in from a build, post, delete a test account.
- Uptime monitor on `/readyz`; log alerts on `FATAL` and `[db]` errors (docs/PRODUCTION_ENV.md section 5).
