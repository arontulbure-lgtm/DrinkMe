DRAFT v0.3 – 2026-11-22 (AI section rewritten for D-21 to D-27: scanner photos ephemeral/not collected, no opt-in, OpenAI removed, AI reports; AI features added 2026-11-16) – to be reviewed by a qualified lawyer before publication. Not legal advice.

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

## AI features (updated 2026-11-22 for decisions D-21 to D-27; added 2026-11-16)

Facts: `data-inventory.md` §8.0. Launch state: scan photos processed **in memory only** on our own AI server (EU/EEA) and deleted after the answer – **never stored** (opt-in not offered, `AI_PHOTO_OPT_IN_ENABLED` off); barcode number only to Open Food Facts; no outside AI company (OpenAI removed); in-app reporting of AI answers; daily limits.

### Google Play
| Item | Answer / change | Status |
|---|---|---|
| Data safety – Photos (Photos and videos → Photos) | **Not collected** for the scanner: the photo leaves the device but is **processed ephemerally** – used only in memory and kept no longer than needed to answer the request (Google's definition). In the form, mark it as processed ephemerally if the console asks; ephemeral data is then not shown as "collected" on the listing (Play Console help 10787469; checked 2026-11-22 – VERIFY the current form wording). Post photos (users' posts) remain **collected** as before. If the opt-in is ever offered, this answer becomes "Collected" (new purpose) | To do at submission |
| Data safety – Other user-generated content | Add saved AI recipes and AI basics (already "other UGC" for posts/Smart Bar). AI reports: reason and recipe/scan reference linked to the user id – declare under "App activity → Other actions" or "Other user-generated content" (VERIFY which category Play prefers), purpose **App functionality / Fraud prevention, security and compliance** | To do |
| Data safety – App activity / daily limits | Daily-limit events (uid, kind, time, 24 h) are security/abuse counters – purpose "Fraud prevention, security and compliance" (VERIFY whether Play expects them declared) | To do |
| Data safety – shared | **No** – own ai-service; the EU/EEA GPU host is a service provider; Open Food Facts receives only a barcode number (not user data) | To do |
| Data safety – deletion | Account deletion deletes saved recipes, AI settings and AI reports; nothing to delete for scan photos (never stored) | To do |
| **AI-Generated Content policy** (Play Console help 13985936 / 14094294, fetched 2026-11-16) | Apps that generate content with AI must not generate offensive or restricted content and must offer **in-app reporting/flagging without leaving the app**. DrinkMe: safety rules S1–S13 on every recipe before it is shown ✅; **Report** on every recipe and scan result (`POST /api/ai/report`) ✅ (LC-39); review targets 24 h / 72 h (D-25, LC-54) | Met in code; operational review routine (John) |
| Alcohol / restricted content | AI recipes are alcohol content: 18+ audience, no sale, responsible-drinking note on every alcoholic recipe | Met (keep) |
| Content rating (IARC) questionnaire | Answer "yes" to AI-generated content if asked; alcohol references already declared | To do |

### Apple App Store
| Item | Answer / change | Status |
|---|---|---|
| Privacy nutrition label – Photos or Videos | **Scanner photos: not collected.** Apple defines "collect" as transmitting data off the device in a way that allows access "for a period longer than what is necessary to service the transmitted request in real time" (developer.apple.com/support/app-privacy-on-the-app-store, checked 2026-11-22). Our server and AI server hold the photo only for the request. Post photos stay **collected, linked to the user** (App Functionality) as before. If the opt-in is ever offered, scanner photos become collected | To do |
| User Content → Other User Content | Saved AI recipes, AI basics, AI reports (App Functionality; reports also for safety) | To do |
| **5.1.2(i) – sharing personal data with third-party AI** (amended 13 Nov 2025 – VERIFY Apple text) | Not triggered: photos go only to **our own** model on our own (rented, EU/EEA) server; no third-party AI (OpenAI removed, D-24/D-26). The AI notice is still shown and accepted before first use | Met (VERIFY) |
| 1.2 UGC / AI output | In-app Report on AI recipes and scan results ✅ (LC-39); filter = S1–S13 | Met in code |
| 1.4.1 / 1.4.3 Physical harm, alcohol | Recipes: no health claims, raw-egg and energy+alcohol warnings, no drinking games (S2), max 2 standard drinks per serving (S1), 18+ | Met (keep) |
| Camera usage string (`NSCameraUsageDescription`) | `app.config.ts:22` says "DrinkMe needs the camera to photograph your drinks." – should also mention scanning labels and barcodes (the barcode plugin string `:47` already does) | Dev (LC-48) |
