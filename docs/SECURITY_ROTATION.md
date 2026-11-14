# Key rotation list

For John. Written 2026-11-14 after the secrets cleanup. **Names only: no value appears in this file or anywhere in git.** Each item says why it is listed, where to rotate it, and what to update afterwards. Do them in order; tick them off in the run log when done.

## What the cleanup found
- `D:\DrinkMeApp\CLAUDE.md` (outside the repository, read by Claude Code) held plaintext values. Every value in its env blocks is now `<set in .env – rotated>`; the names are kept.
- **Git history (all branches, 61 commits) is clean.** gitleaks found 5 matches, all false positives: synthetic test canaries in `server/test/*.test.js`, and the SHA-256 of the old public default JWT secret that `server.js` refuses. They are listed by fingerprint in `.gitleaksignore`. No `.env`, service-account or admin-SDK file has ever been committed.
- The old Firebase project's service-account key `server/serviceAccount.json` (project `drinkme-b2269`) is no longer used. The server uses the `drinkmeapp-a8fea` key; `npm run official:check` shows MATCH.

## Rotate or revoke (in this order)

| # | Name | Why | Where | Then |
|---|---|---|---|---|
| 1 | `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | Was in plaintext in `D:\DrinkMeApp\CLAUDE.md`. A Maps key is billable. | Google Cloud console of the project that owns it → APIs & Services → Credentials: <https://console.cloud.google.com/apis/credentials> (choose the project at the top). Create a new key, restrict it (API restrictions: Places API; application restrictions: Android package + SHA-1 and iOS bundle ID once builds exist), then delete the old key. | Put the new value in the root `.env`. Restart the session. |
| 2 | Old Firebase service-account key (`firebase-adminsdk-fbsvc@drinkme-b2269…`) | Grants admin access to the old project; the file was on this PC and named in the old docs. | <https://console.cloud.google.com/iam-admin/serviceaccounts?project=drinkme-b2269> → the firebase-adminsdk account → Keys → delete every key. Or delete the whole old project if nothing else uses it: <https://console.firebase.google.com/project/drinkme-b2269/settings/general> → Delete project. | Then delete `D:\DrinkMeApp\_old_secrets\serviceAccount.drinkme-b2269.json` (see the move below). |
| 3 | `EXPO_PUBLIC_FIREBASE_API_KEY` of `drinkme-b2269` | Was in plaintext in `CLAUDE.md`. Firebase web keys are public by design, but this project is retired. | Done by deleting the old project (item 2). Otherwise <https://console.cloud.google.com/apis/credentials?project=drinkme-b2269> → delete the "Browser key". | Nothing: the app now uses the `drinkmeapp-a8fea` web config. |
| 4 | `ANTHROPIC_API_KEY` | Sits in the app's root `.env`, which Expo loads into Metro (never bundled into the app, never committed). Rotate if that file was ever shared or synced. | <https://console.anthropic.com/settings/keys> | Keep the key **out** of the app's `.env`: set it as a user environment variable (System → Environment variables) or in `agents/.env`. Then `npm run env:remove -- ANTHROPIC_API_KEY`. Note: `npm run agent:feature` (`agents/orchestrator.ts`) reads it from the root `.env` today, which is why it was not removed automatically. |
| 5 | `OPENAI_API_KEY` (server) | Open item SEC-C: older notes say "rotate if it was in git". This repository's history is clean, but the key predates it. | <https://platform.openai.com/api-keys> | New value in `server/.env`. AI features are off in the app (flags), so nothing else changes. |
| 6 | `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Not a secret, but it names the old project's OAuth client. | Replace with the `drinkmeapp-a8fea` Web client ID: <https://console.firebase.google.com/project/drinkmeapp-a8fea/authentication/providers> → Google → Web SDK configuration. | Root `.env`. See `docs/DEVICE_TEST_SESSION.md` section G. |

Not needing rotation:
- `JWT_SECRET` (server) was never written anywhere outside `server/.env`. Rotating it signs every user out; do it only if `server/.env` was exposed.
- `drinkmeapp-a8fea` web config values are public by design (they ship inside the app). Protect them with App Check and API restrictions before launch, not with secrecy.

## Files to clean up by hand
- **Move the old key out of the repository folder** (Claude Code's sandbox cannot write outside the project, so this one is yours). In PowerShell:
  ```powershell
  New-Item -ItemType Directory -Force D:\DrinkMeApp\_old_secrets | Out-Null
  Move-Item D:\DrinkMeApp\DrinkMeFinal\server\serviceAccount.json D:\DrinkMeApp\_old_secrets\serviceAccount.drinkme-b2269.json
  cd D:\DrinkMeApp\DrinkMeFinal; npm run official:check   # still MATCH on drinkmeapp-a8fea
  ```
  It is git-ignored where it is, so this is about not keeping an admin key next to the code, not about git.
- `D:\DrinkMeApp\DrinkMeFinal\.env.before-firebase-*` and `server\.env.before-firebase-*` (made by `npm run firebase:configure`) hold the old project's values and the Anthropic key. Delete them once the new project works for you. They are git-ignored.
- The other documents in `D:\DrinkMeApp\` (outside the repository: `SECURITY.md`, `DEPLOY.md`, `TECHNICAL_REFERENCE.md`, …) were not scanned. Check them for values with the same names as above.

## How to check again
```powershell
gitleaks git D:\DrinkMeApp\DrinkMeFinal --redact --log-opts="--all"   # history; expect "no leaks found"
npm run official:check                                                # MATCH on drinkmeapp-a8fea
```
