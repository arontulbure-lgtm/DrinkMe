DRAFT v0.3 – 2026-11-22 (AI rows updated for D-21 to D-27: no photo kept, OpenAI row removed, AI reports and daily counters added; AI rows added 2026-11-16; session-security, audit and `nameReservedAtSignIn` rows 2026-11-13) – to be reviewed by a qualified lawyer before publication. Not legal advice.

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
| AI scan photo (every user – D-21) | Only for the request (memory, on our server and the EU/EEA GPU host) | Discarded after the answer; never written to disk or logged (Express and ai-service), never used for training | Code (`server/server.js:5379-5397`; `ai-service/app/imaging.py`, `main.py:42-49`) **after LC-49**: today the code still keeps photos of users with `aiPhotoOptIn = true` (`:5387-5389`) |
| AI opt-in photo store (`AI_PHOTO_DIR`) | **Not used at launch – must be empty** (D-21, D-22) | LC-49: with `AI_PHOTO_OPT_IN_ENABLED` off, nothing is written, `photoOptIn: true` is refused, and at start-up any files left from beta tests are deleted and the opt-in fields cleared | Code (LC-49, pending) + **operational**: host snapshots that still contain beta-test files expire within 30 days (LC-40) |
| AI notice acceptance (`aiNoticeVersion`, `aiNoticeAt`), AI settings (`aiBasics`) | Life of the account | Account deletion cascade (fields of the user record) | Code |
| Saved AI recipes | Until the user removes them, or account deletion; max 200 per user | Delete route / cascade (`savedRecipesByUser.delete`) | Code (`server/server.js:5518-5528`; cascade) |
| Recipe-session names (anti-duplicate list, hashed key) | 2 hours after the last use (memory only); lost on restart | Expiry | Code (`server/ai/recipeEngine.js`) |
| Barcode answer cache (EAN + language → product; no user data) | 24 hours (memory) | Expiry | Code (`server/ai/openFoodFacts.js:8-9`) |
| AI rate-limit counters (`ai:<uid>`, `barcode:<uid>`, `ai-report:<uid>`) | 1 hour / 1 hour / 24 hours (memory) | Window ends | Code (`server/server.js:5218-5233`, `:5532-5539`) |
| Daily AI usage counters (20 scans, 10 recipe batches per user per day) | One day (rolling 24 h or until the day boundary) | Reset / pruned | Code – **pending LC-51**; the privacy policy §7 promises "one day" |
| AI output reports (audit action `ai.output_reported`) | 90 days; deleted with the reporter's account | Audit purge (start + every 24 h); account-deletion cascade (user self action) | Code (`AUDIT_RETENTION_DAYS` `server/server.js:2200`; `AUDIT_SELF_ACTIONS` `:2225`) |
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
