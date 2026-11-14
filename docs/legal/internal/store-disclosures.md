DRAFT v0.1 – 2026-11-12 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# App store disclosures (internal)

Checked 2026-11-12: Apple App Review Guidelines fetched from developer.apple.com/app-store/review/guidelines (1.2, 1.4.3, 4.8, 5.1.1(v) quoted below). Google Play policies **not re-fetched** – VERIFY in Play Console before submission.

## Apple App Store
| Item | Answer / requirement | Status |
|---|---|---|
| 1.2 UGC: filter objectionable material | No automatic filter today | **Gap LC-19** |
| 1.2 UGC: report + timely response | Report (6 reasons) + admin queue, 24 h target | Met in code; **operational**: `ADMIN_USER_IDS` must be set and someone must review daily (LC-20) |
| 1.2 UGC: block abusive users | Block | Met |
| 1.2 UGC: published contact information | Not in the app | **Gap LC-05** |
| 1.4.3: no encouragement of excessive alcohol; never to minors | Guidelines + 18+ gate + `dangerous_drinking` report reason | Met in policy; keep |
| 4.8 Login services: an equivalent privacy-friendly login when Google sign-in is offered | Sign in with Apple button on iOS (`src/screens/AuthScreen.tsx:222`, `:354`) | VERIFY the Firebase Apple provider is enabled (LC-22) |
| 5.1.1(v) account deletion in app | Edit Profile and age gate → Delete account | Met |
| Age rating | Answer the age-rating questionnaire honestly: frequent/intense alcohol references, user-generated content, unrestricted web access = No → expected 18+ (VERIFY the current Apple rating tiers) | To do at submission |
| Privacy nutrition label – "Data linked to you" | Contact info: email address; User content: photos, other user content (posts, comments, Smart Bar); Identifiers: user ID; Usage data: none collected for analytics; Location: none (coarse/precise not collected; place text is user content) | Draft – verify when hosting/logs are set |
| "Data used to track you" | None | — |
| Privacy policy URL | Needed | Decision D-06 (hosting) |
| Regions | Exclude markets per `../age-and-alcohol.md` §3 | Decision D-02 |
| Age assurance laws (Texas SB 2420, Utah, Louisiana) and Apple's Declared Age Range API | If distributed in the US, check obligations; Texas law reported in effect after a Fifth Circuit stay (FPF, 2026; status changed several times – VERIFY) | LC-26 |

## Google Play
| Item | Answer | Status |
|---|---|---|
| Target audience and content | 18+ only; not designed for children | To do |
| Content rating (IARC) questionnaire | Alcohol references; UGC; users interact | To do |
| UGC policy | Terms + guidelines accepted before UGC (**gap LC-03**), in-app reporting, block, moderation | Partly met |
| Data safety form | Collected: email, name, user IDs, photos, other UGC (posts, comments), app interactions? (cheers/saves are UGC, not analytics). Shared: none (processors are not "sharing"). Encrypted in transit: **only after HTTPS (SEC-D)**. Deletion: in-app + web URL | Draft |
| Account deletion URL (web) | Publish `../account-deletion.md` at a public URL | Decision D-06 |
| Alcohol / restricted content | No sale of alcohol; responsible content | Met |
| Age signals (Play Age Signals API) for US state laws | VERIFY | LC-26 |
