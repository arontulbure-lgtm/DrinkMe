DRAFT v0.1 – 2026-11-12 (request-log, Postgres history rows 2026-11-22; session-security, audit and `nameReservedAtSignIn` rows 2026-11-13) – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Retention schedule (internal)

Every period below is enforced by code unless marked **operational** (someone must configure or do it) or **gap**. Sources: `data-inventory.md` (file:line there). GDPR Art. 5(1)(e) (storage limitation).

| Data | Period | How it ends | Enforced by |
|---|---|---|---|
| Account and profile | Until the user deletes the account | In-app deletion; cascade removes every record that holds or names the user, then the Firebase user | Code (`server/server.js` `deleteUserDataCascade`, `deleteFirebaseUser`) |
| Posts, photos, comments, cheers, saves, Smart Bar, blocks, partner links | Until deleted by the user (or an admin for posts/comments), or account deletion | Delete routes / cascade | Code |
| Pending partner requests | 90 days | Expire | Code (`PARTNER_REQUEST_MAX_AGE_MS`) |
| Notifications | 7 days; newest 200 per user | Pruned | Code (`NOTIFICATION_MAX_AGE_MS`, `NOTIFICATIONS_MAX_PER_USER`) |
| Daily-limit events | 24 hours | Pruned | Code |
| Report details (free text) | Until the report is resolved | Set to null on resolve | Code |
| Reported-version snapshot of an edited post | Until the report is resolved or account deletion | Removed | Code |
| Reporter uid on a resolved report | 30 days after resolution | Removed | Code (`RESOLVED_REPORTER_RETENTION_MS`) |
| Rest of a resolved report (target, reason code, action, admin uid, dates) | **No limit defined** | — | **Gap LC-16**: proposed 12 months, then delete |
| Open reports filed by a deleted user | Until resolved; kept under `deleted-<hex>`, no details | Resolve | Code |
| Session-security fields `tokensValidAfterSeen`, `firebaseSessionEndedReason` (`data-inventory.md` §5) | Life of the account (`firebaseSessionEndedReason` is cleared earlier, at the next good Firebase lookup) | Account deletion cascade | Code |
| `nameReservedAtSignIn` marker (yes/no; a Google/Apple name was refused as reserved at sign-in; holds no name) (`data-inventory.md` §5a) | Until the next successful profile save, or account deletion | Deleted by `PUT /api/users/:id`; account deletion cascade | Code |
| Suspension history | Life of the account (needed for "a repeat is permanent") | Account deletion | Code. Decision D-09 on keeping something after deletion to stop ban evasion |
| Audit log (incl. `auth.session_revoked` with reason `tokens_revoked` / `account_disabled` / `account_gone`) | 90 days (caps 15,000 user / 20,000 admin entries); a user's own entries, including `auth.session_revoked`, are deleted with the account; at most one `auth.session_revoked` entry per account and reason per 24 hours | Pruned at start and every 24 h | Code (`AUDIT_RETENTION_DAYS`, `AUDIT_SELF_ACTIONS`, `appendSessionRevokedAudit`) |
| Deletion tombstone (uid only) | About 1 hour | Pruned within the next 15-minute run | Code |
| Scheduled backups (`npm run backup`) | Daily 7 days, weekly 28 days | Pruned by the script after a successful run | Code + **operational** (must run daily) |
| In-server backups (`.corrupt-*`, `.pre-migration-*`) | 21 days; 7-day recovery hold after data loss; hard ceiling 30 days | Purge timer | Code |
| Host / volume snapshots, hand-made copies | ≤ 30 days | — | **Operational** (`server/README.md` Backups) |
| Server request logs (time, method, path, status, size, duration; no IP/UA/referrer since T-05) | **≤ 30 days at the host** – operational, not set yet (host not chosen) | Host log retention | Code ✅ (no IP/UA); **operational** LC-15: set the host's log retention ≤ 30 days |
| Rate-limit IP keys | 15 minutes (global limiter) / 1 minute (mutations), memory only | Window ends | Code |
| Postgres history snapshots (`DB_DRIVER=postgres`) | ≤ 28 days (and ≤ 30 rows) | Pruned on write, at start and every 24 h | Code (`server/storage/postgres-store.js:16-20`) + **operational**: provider backups / PITR ≤ 30 days |
| Terms acceptance (`termsVersion`, `termsAcceptedAt`) | Life of the account | Account deletion cascade | Code |
| Firebase Authentication account | Until account deletion (server deletes it) | `deleteUser` | Code; Google's own backup retention: VERIFY in Firebase terms |
| Emails sent by Firebase (verification, reset) | Google's retention | — | VERIFY |
| Device: API token | 30-day expiry; deleted on logout or a 401/403 | — | Code |
| Device: Firebase session, language, cooldown record | Until logout / app uninstall | — | Code |
| Device: cached images | 1 day (`max-age=86400`) | — | Code |
| Data subject request records (`dsr-procedure.md`) | 3 years after closing (proposal, VERIFY limitation period) | Manual | Operational |
| Law-enforcement request records | 3 years (proposal, VERIFY) | Manual | Operational |
| Breach register | 5 years (proposal; GDPR Art. 33(5) sets no period) | Manual | Operational |

The user-facing promise "a deleted account is removed from our backups within 30 days" (`deleteAccount.warning`, privacy notice) holds only while the operational rows above are respected.
