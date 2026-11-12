# Changelog

Notable changes to DrinkMe (client and server). Newest first. Details: `server/README.md`, `.claude/skills/drinkme-backend-api/SKILL.md`, `AUTONOMOUS_RUN_LOG.md`.

## 2026-11-12

Tiers 3 to 6 of the autonomous run (commits 0c7b20b to d96bbd9, plus the docs below). None of the client changes has run on a device yet; see `docs/JOHN_TODO.md`.

### Added
- **Forgot password** (dbfc339): "Forgot password?" on the sign-in screen sends Firebase's reset email in the app's language, with the same neutral confirmation for any email and a 60 s cooldown. Firebase errors go through `src/lib/authErrors.ts`: wrong password and unknown email share one message, and raw Firebase text is never shown. AuthScreen is fully ro/en. Why: users had no way back into a password account (FEAT-1).
- **Edit post** (3ee33f3): `PUT /api/drinks/:id` (text, rating, alcoholic flag, category; never the image) and Edit in the post menu; edited posts show "edited". 409 `hidden_pending_review` while the post is hidden after reports; the first edit after an open report keeps the reported content on the report (`targetSnapshot`) for the moderator. Why: FEAT-3, without letting an owner erase what was reported.
- **Drink categories** (277157b): optional `category` on posts (cocktail, wine, beer, spirits / mocktail, coffee, tea, other), stored as `tags: [category]`; `GET /api/drinks?category=`; CreatePost picker and Explore chips. Why: Explore's Cocktail, Wine and Beer chips were always empty.
- **Audit log** (3954281): 8 security and moderation actions, ids only (no IP, email or free text), 90 days, separate caps for user and admin entries, cleaned up by account deletion; `GET /api/admin/audit`. Why: SEC-H, and moderation decisions need a record.
- **Error boundary** and **typed navigation** (00c986e): a crash shows "Try again" instead of a blank app; route params are checked by TypeScript, which also fixed four buttons that did nothing. PartnersList got pull-to-refresh and an error state.
- **Route-coverage guard** : every server route must be listed in `server/test/helpers/routes.js` (`ROUTE_MANIFEST`) with its gate; tests check 401, `age_required`, `account_suspended` and admin refusals on every route. Why: a new route can no longer skip the sign-in or 18+ gate unnoticed.
- `npm run check` (typecheck + lint) in the root `package.json`. Why: the QA checklist referred to it and it did not exist.

### Changed
- **Cheers and saves** (e0f1e29): the app updates at once and sends the wanted state (`{ cheered }` / `{ saved }`); the server is idempotent and rolls back a failed save; one cheer notification per person and post per 7 days. Cheer now works on Profile and Smart Bar Saved. Why: FEAT-7, and an empty `onCheer` handler; the de-duplication stops notification floods.
- **Notifications in ro/en** (7051e84, bb639d5): the server adds `params` (`actorName`, `drinkName`, `variant`) and the app writes the sentence in its language; the English `message` stays for older apps. Why: notifications were English only.
- **Remaining English strings localized; one `formatTimeAgo`** (d96bbd9): about 70 strings moved to ro/en; posts and comments 7+ days old show a short date; icon-only buttons have screen-reader labels and 44 px targets.
- **Windows `EPERM` on save** (0c7b20b): the database rename and read are retried briefly instead of failing the request.
- Docs: skills, `server/README.md` (audit log, routes), `docs/JOHN_TODO.md` (device checks for forgot password and localization, Firebase Console settings), external docs in `D:\DrinkMeApp\`, and a jest-expo proposal in `AUTONOMOUS_RUN_LOG.md` (not installed).

### Known limits
- A password reset does not end the 30-day server session; fixing it needs one Firebase call per sign-in (waiting for the owner's OK).
- Firebase Console settings are still to confirm: email enumeration protection, an enforced password policy, a restricted web API key, App Check before the public launch. The app's reset cooldown is not a security control.

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
