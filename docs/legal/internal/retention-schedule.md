DRAFT v0.2 – 2026-11-16 (AI rows added; session-security, audit and `nameReservedAtSignIn` rows 2026-11-13) – to be reviewed by a qualified lawyer before publication. Not legal advice.

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
| AI scan photo – default (no opt-in) | Only for the request (memory) | Discarded after the answer; never written to disk or logged (Express and ai-service) | Code (`server/server.js:5088-5104`; `ai-service/app/imaging.py`, `main.py:42-49`) |
| AI scan photo + scan result – user opted in (`aiPhotoOptIn`) | **90 days** (`AI_PHOTO_RETENTION_DAYS`, default 90; decision D-21), checked every 6 h, so ≤ 90 days + 6 h | Purge; **immediately** when the user turns the opt-in off or deletes the account | Code (`photoStore.purgeExpired` / `deleteForUser`; `server/server.js:5084`, `:2664`, `:5225-5226`) + **operational**: never set the env var above 90 without updating the documents; host snapshots of `AI_PHOTO_DIR` ≤ 30 days (LC-40) |
| AI notice acceptance (`aiNoticeVersion`, `aiNoticeAt`), AI settings (`aiBasics`, `aiPhotoOptIn`) | Life of the account | Account deletion cascade (fields of the user record) | Code |
| Saved AI recipes | Until the user removes them, or account deletion; max 200 per user | Delete route / cascade (`savedRecipesByUser.delete`) | Code (`server/server.js:2663`, `:5213-5223`) |
| Recipe-session names (anti-duplicate list, hashed key) | 2 hours after the last use (memory only); lost on restart | Expiry | Code (`server/ai/recipeEngine.js:14-36`) |
| Barcode answer cache (EAN + language → product; no user data) | 24 hours (memory) | Expiry | Code (`server/ai/openFoodFacts.js:8-9`) |
| AI rate-limit counters (`ai:<uid>`, `barcode:<uid>`) | 1 hour (memory) | Window ends | Code (`server/server.js:4944-4959`) |
| OpenAI (only `AI_PROVIDER=openai`) | OpenAI's API retention (`store: false`; abuse-monitoring logs – VERIFY current terms) | OpenAI | **Not used** (default off); VERIFY before any use |
| Suspension history | Life of the account (needed for "a repeat is permanent") | Account deletion | Code. Decision D-09 on keeping something after deletion to stop ban evasion |
| Audit log (incl. `auth.session_revoked` with reason `tokens_revoked` / `account_disabled` / `account_gone`) | 90 days (caps 15,000 user / 20,000 admin entries); a user's own entries, including `auth.session_revoked`, are deleted with the account; at most one `auth.session_revoked` entry per account and reason per 24 hours | Pruned at start and every 24 h | Code (`AUDIT_RETENTION_DAYS`, `AUDIT_SELF_ACTIONS`, `appendSessionRevokedAudit`) |
| Deletion tombstone (uid only) | About 1 hour | Pruned within the next 15-minute run | Code |
| Scheduled backups (`npm run backup`) | Daily 7 days, weekly 28 days | Pruned by the script after a successful run | Code + **operational** (must run daily) |
| In-server backups (`.corrupt-*`, `.pre-migration-*`) | 21 days; 7-day recovery hold after data loss; hard ceiling 30 days | Purge timer | Code |
| Host / volume snapshots, hand-made copies | ≤ 30 days | — | **Operational** (`server/README.md` Backups) |
| Server request logs (IP, user agent, path) | **Not set** (depends on host) | — | **Gap LC-15**: set ≤ 30 days at the host, or drop IP/UA from the production log format |
| Firebase Authentication account | Until account deletion (server deletes it) | `deleteUser` | Code; Google's own backup retention: VERIFY in Firebase terms |
| Emails sent by Firebase (verification, reset) | Google's retention | — | VERIFY |
| Device: API token | 30-day expiry; deleted on logout or a 401/403 | — | Code |
| Device: Firebase session, language, cooldown record | Until logout / app uninstall | — | Code |
| Device: cached images | 1 day (`max-age=86400`) | — | Code |
| Data subject request records (`dsr-procedure.md`) | 3 years after closing (proposal, VERIFY limitation period) | Manual | Operational |
| Law-enforcement request records | 3 years (proposal, VERIFY) | Manual | Operational |
| Breach register | 5 years (proposal; GDPR Art. 33(5) sets no period) | Manual | Operational |

The user-facing promise "a deleted account is removed from our backups within 30 days" (`deleteAccount.warning`, privacy notice) holds only while the operational rows above are respected.
