# Deploy the DrinkMe server on Render

Written 2026-11-22 for v1.0.0. Every variable is described in `docs/PRODUCTION_ENV.md`; this file covers only the Render steps. Render's UI and plans change: names below are what they were when written, and nothing here was run against a live Render account yet. Values in angle brackets are placeholders: never paste real secrets into tracked files.

## 0. Before you start
- `npm run docker:smoke` passes locally (builds the root `Dockerfile`, checks `/healthz`, `/readyz`, 401 without a session).
- `cd server && npm test` and `npm run check` are green on the commit you deploy.
- Decide the data mode. **Recommended on Render: Render Postgres** (`DB_DRIVER=postgres`). A persistent disk attaches to one service only, blocks zero-downtime deploys and cannot be read by a cron job.
- Paid instance type: free web services sleep and have no persistent disk.

## 1. Web Service from the Dockerfile
1. New, then Web Service, connect the repo and pick the release branch.
2. Runtime: Docker. Dockerfile path `./Dockerfile`, build context `.` (the repo root; the Dockerfile copies from `server/`).
3. Instances: 1. The server allows one instance per database (Postgres lock; a JSON file cannot be shared either).
4. Set `PORT=8080` in the variables so Render routes to the port the image listens on.

## 2. Data
**Render Postgres (recommended)**
1. New, then Postgres, in the same region as the web service.
2. On the web service: `DB_DRIVER=postgres`, `DATABASE_URL=<Internal Database URL>`, and `DATABASE_SSL`:
   - internal URL (private network): `DATABASE_SSL=disable` (accepted with a warning);
   - external URL: `DATABASE_SSL=require`, which needs a certificate the server can verify. If refused, use the internal URL.
3. First deploy only: `ALLOW_EMPTY_DB=true`, or migrate an existing `db.json` once with `npm run db:migrate-to-postgres -- <path>` (locally, `DATABASE_URL` = the external URL).
4. Backups / point-in-time recovery of the Render database: retention 30 days or less.

**JSON file on a persistent disk (alternative)**
1. Web service, then Disks: mount path `/app/server/data`, size 1 GB to start.
2. `DB_FILE=/app/server/data/db.json`.
3. A cron job cannot mount this disk, so scheduled `npm run backup` is not possible; rely on the in-server backups and Render's disk snapshots (check their retention is 30 days or less), or move to Postgres before real users arrive.

## 3. Variables
Environment, then add (or an Environment Group shared with the cron job), from `docs/PRODUCTION_ENV.md` section 1:
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
- `TRUST_PROXY_HOPS`: not verified for Render yet. Start with `1`, then check that two different networks get separate rate-limit buckets (and a forged `X-Forwarded-For` does not change the bucket) before launch.
- Alternatively store the service-account JSON as a Secret File and set `FIREBASE_SERVICE_ACCOUNT_KEY=/etc/secrets/<file name>` (the server accepts a path).
- Do not set `NODE_ENV` (the Dockerfile sets `production`), `DEBUG`, `ALLOW_INSECURE_DEV_AUTH` or `REQUIRE_VERIFIED_EMAIL` (see `server/README.md`).

## 4. Health check
Settings, then Health Check Path: `/readyz`. Render routes traffic to a new deploy only when it answers 200 (database loaded, firebase-admin initialised). A 503 body names a reason code only (`db_not_loaded`, `auth_not_initialized`, `shutting_down`).

After the first deploy: read the log (`[firebase-admin] ✅ Initialized`, no `FATAL`), remove `ALLOW_EMPTY_DB` and redeploy.

## 5. Daily backup job (Postgres mode)
1. New, then Cron Job, same repo, Runtime Docker, same Dockerfile.
2. Schedule `15 3 * * *` (UTC), Command `npm run backup`.
3. Variables: `DB_DRIVER`, `DATABASE_URL`, `DATABASE_SSL` as on the web service, `AI_PROVIDER=off`, and `BACKUP_DIR` pointing at storage that outlives the job. A cron job has no persistent disk, so the copies must leave the container: until an object-storage adapter exists for `scripts/backup.js`, rely on Render Postgres backups (30 days or less) and run `npm run db:export-from-postgres -- <file>` from a trusted machine weekly.
4. Check the job's log the next day.

## 6. Custom domain and HTTPS
1. Web service, then Settings, then Custom Domains: add `api.<your domain>`, create the CNAME Render shows.
2. Render issues the TLS certificate automatically; HTTP redirects to HTTPS.
3. Set `EXPO_PUBLIC_API_URL=https://api.<your domain>` in the EAS build profile.

## 7. Verify
- `https://api.<your domain>/healthz` gives `{"status":"ok"}`, `/readyz` gives `{"status":"ready"}`.
- `/api/drinks` without a session gives 401.
- Sign in from a build, post, delete a test account.
- Uptime monitor on `/readyz`; log alerts on `FATAL` and `[db]` errors (docs/PRODUCTION_ENV.md section 5).
