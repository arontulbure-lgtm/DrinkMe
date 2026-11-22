DRAFT v0.1 – 2026-11-12 (P7 updated 2026-11-22; P5, P12 updated 2026-11-13) – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Record of processing activities – GDPR Art. 30(1) (internal)

Controller: Tulbure Aron PFA, B-dul Bucureștii Noi 136, Parter, Ap. 5, Sector 1, Bucharest, Romania. CUI `[TO FILL BY JOHN]`, Trade Register no. `[TO FILL BY JOHN]`. Contact: drinkmesocialapp@gmail.com. DPO: not appointed (Art. 37 conditions not met – VERIFY at scale). EU representative: not needed (established in the EU). UK representative: decision D-03.

Art. 30(5) exempts organisations under 250 employees only for occasional processing; DrinkMe's processing is not occasional, so this record is kept.

| # | Activity | Purposes | Data subjects | Categories of data | Lawful basis (Art. 6) | Recipients | Transfers | Retention | Security |
|---|---|---|---|---|---|---|---|---|---|
| P1 | Account and sign-in | Create and secure the account | Users | Email, name, provider ids, photo URL, uid, session data | (b) contract | Firebase (processor) | US – DPF/SCCs (VERIFY) | Until deletion | Firebase token verification, JWT HS256 30 d, takeover guard |
| P2 | Age confirmation | Keep minors out (alcohol content), store rules | Users | `ageConfirmedAt` (no birth date) | (c) legal obligation where national law requires it / (f) legitimate interest (protecting minors, store compliance) – VERIFY | none | none | Until deletion; audit entry 90 d | Server-side gate |
| P3 | Profile and social features (posts, photos, comments, cheers, saves, partners, notifications, search, Explore) | Provide the service | Users; people visible in photos | Profile, UGC, social graph, free-text location | (b) contract | Hosting (processor) | Depends on host (D-07) | Until deleted | Access rules, blocks |
| P4 | Smart Bar | Private home-bar list | Users | Drink names, quantities | (b) contract | Hosting | as P3 | Until deleted | Owner-only |
| P5 | Moderation (reports, auto-hide, admin review, suspensions, reported-version snapshot; automated reserved-name check against impersonation of the official account, with a temporary `nameReservedAtSignIn` yes/no marker) | Safety, enforce Terms, DSA notice and action | Users, reporters, reported users | Report data, reason codes, suspension history; profile names (checked, not stored differently) | (f) legitimate interest (safe platform, preventing impersonation); (c) DSA Arts. 16–17 | Admins (internal) | none | See retention schedule | Admin allowlist, data minimised |
| P6 | Audit log | Accountability for security and moderation actions | Users, admins | ids, action, time | (f) legitimate interest; Art. 5(2) accountability | Admins | none | 90 d | Whitelisted fields only |
| P7 | Abuse prevention (rate limits, daily limits, request logs) | Security | Users, any client | IP (memory only, ≤ 15 min), path, uid counters, App Check result counts | (f) legitimate interest (security, Recital 49) | Hosting; Google/Apple for App Check once on | as P3 | Limits 24 h; request logs without IP/UA, host retention ≤ 30 days (operational, LC-15) | — |
| P8 | Backups | Recovery | All | Full database | (f) legitimate interest; Art. 32 | Hosting/backup storage | as P3 | ≤ 30 d | 0600 files, separate storage |
| P9 | Account deletion | Erasure | Users | uid, anonymous id | (c) Art. 17 GDPR | Firebase | US | Tombstone ~1 h | Fresh sign-in required |
| P10 | Place search | Add a venue to a post | Users | Search text, IP | (b) contract | Google Maps Platform | US | Google's | — |
| P11 | Contact, data subject requests, legal notices | Answer users, authorities, rights holders | Users, non-users | Email, message content | (c) legal obligation (GDPR, DSA, DMCA); (f) | Mail provider (D-15) | US | 3 y (proposal) | Restricted mailbox |
| P12 | Brand-partner content (official account) – official account **built in code** (uncommitted on 2026-11-13: `OFFICIAL_USER_IDS`, badge, reserved names, no auto-hide); **no brand-partner post until the commercial label ships (LC-11)** and the account is set up by John (LC-34) | Publish partner recipes | Brand contacts | Business contact details | (b) contract with the brand / (f) | none | none | Contract + 3 y (VERIFY) | Official uid only in server config; never also an admin (startup warning) |
| P13 | AI scanner and recipes – **disabled** | — | — | Photos, ingredients | would need (b)/(a) – decide before enabling | OpenAI | US | — | `store: false` |

Special categories (Art. 9): not intended. Alcohol consumption posts are not health data by themselves, but see `dpia-screening.md`.
Review this record at every release that changes `data-inventory.md`.
