# Changelog

Notable changes to DrinkMe (client and server). Newest first. Details: `server/README.md`, `.claude/skills/drinkme-backend-api/SKILL.md`, `AUTONOMOUS_RUN_LOG.md`.

## 2026-11-11

### Added
- **Scheduled database backups** (f4986e5): `npm run backup` in `server/` writes a checked copy to `BACKUP_DIR` (daily kept 7 days, weekly kept 4 weeks), never prunes after a failure, and ships in the Docker image. Env: `BACKUP_DIR`, `BACKUP_SOURCE`, `DB_FILE`. Why: the owner decided deleted accounts must leave every backup within 30 days, and the JSON database had no scheduled backup.
- **Moderation decisions** (937ccb0): content with 3 distinct open reporters (accounts 48 h old that accepted the privacy notice) is hidden from everyone but its owner and admins until review. Admins can suspend users (`POST /api/admin/users/:id/suspend`, `/unsuspend`, or `suspend: true` on resolve): 7 days first, permanent on a repeat. Suspended users get 403 `account_suspended` on posting, comments, partner requests, profile edits and reports, and see a banner. The admin report list adds `ageHours`, `overdue`, reporter counts and `overdueCount`. Why: owner decisions of 2026-11-10 (store UGC rules: offenders must be removable).

### Changed
- **Sign-in and 18+ required everywhere** (2f05704): `requireSignedInAdult` on `/api` and `/media`; only sign-in, `delete-unverified`, `/healthz` and the caller's own first-run routes are exempt. The app's age gate is hard (Confirm, Log out, Delete account; no decline). `PRIVACY_NOTICE_VERSION` is 2. Why: owner decision "no logged-out reads"; a block did not stop viewing while signed out.
- **Email takeover closed with `REQUIRE_VERIFIED_EMAIL` off** (2f05704): a per-user session generation in the JWT (`sg`) and an auth floor that refuses older password sessions (403 `sign_in_again`). The app rebuilds its session on a 401 (at most every 30 s). Why: someone who registered another person's email first kept a working token after the owner's Google sign-in.
- **In-server backup retention** (937ccb0): `.corrupt-*` / `.pre-migration-*` kept 21 days plus the 7-day recovery hold, with a hard 30-day ceiling; `CORRUPT_BACKUP_RETENTION_DAYS` capped at 21. The app now says deleted accounts leave backups within 30 days (was 40). Why: the 30-day promise.

### Known limits
- A suspended user can delete the account and register again.
- The auth floor covers password sessions only; check before enabling more sign-in providers.
- Restoring an older `db.json` revives sessions logged out since the backup: rotate `JWT_SECRET` after a restore.
- 3 colluding accounts that are 48 h old and accepted the notice can still hide content until an admin reviews it.
