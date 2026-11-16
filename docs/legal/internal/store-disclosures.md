DRAFT v0.2 – 2026-11-16 (AI features: scanner, recipes, opt-in photos) – to be reviewed by a qualified lawyer before publication. Not legal advice.

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

## AI features (added 2026-11-16) – changes to make when the AI scanner / recipes ship

Facts: `data-inventory.md` §8. Default: photos processed in memory on our own server and discarded; kept only with the opt-in (90 days); barcode number to Open Food Facts; no outside AI company (`AI_PROVIDER=local`).

### Google Play
| Item | Answer / change | Status |
|---|---|---|
| Data safety – Photos (Photos and videos → Photos) | **Collected** – because opted-in users' photos are stored, the "processed ephemerally" exemption covers only the default flow, not the opt-in. Purposes: **App functionality** (the scan); for the opt-in also **Analytics** (Google: data used to evaluate how the app performs and improve it) – VERIFY the purpose definitions in Play Console. Optional: **Yes** (the scanner is optional; users can add items by hand). Shared: **No** (own ai-service; a GPU host is a service provider, not sharing). Ephemeral: answer per Google's definition – data processed in memory and kept no longer than needed for the request (Play Console help "Data safety", answer 10787469; checked 2026-11-16 via secondary summaries – VERIFY) | To do at submission |
| Data safety – Other user-generated content | Add saved AI recipes and AI basics (already "other UGC" for posts/Smart Bar) | To do |
| Data safety – deletion | Account deletion deletes saved recipes and kept photos; users can also turn the opt-in off (deletes kept photos) | To do |
| **AI-Generated Content policy** (Play Console help 13985936 / 14094294, fetched 2026-11-16) | Apps that **generate content with AI** must (1) not generate offensive or restricted content (dangerous activities are named), and (2) provide **in-app user reporting or flagging** of offensive AI output **without leaving the app**, and use reports to improve filtering. Scope examples are chatbots and image generators; a text recipe generator is "content generated using AI" – treat as **in scope** (VERIFY with Play Console wording). DrinkMe: safety rules S1–S13 filter output ✅; **no report/flag button on AI recipes or scan results ❌ → LC-39** | **Gap – blocks Play submission with AI on** |
| Alcohol / restricted content | AI recipes are alcohol content: 18+ audience, no sale, responsible-drinking note on every alcoholic recipe | Met (keep) |
| Content rating (IARC) questionnaire | Answer "yes" to AI-generated content if asked; alcohol references already declared | To do |

### Apple App Store
| Item | Answer / change | Status |
|---|---|---|
| Privacy nutrition label – User Content → Photos or Videos | **Collected, linked to the user** (opt-in photos are stored with a pseudonymous user prefix). Purposes: **App Functionality**; for the opt-in also **Analytics** (Apple: evaluating behaviour or performance to improve the product) – Apple has no "model improvement" purpose; VERIFY the closest category. Not used for tracking. Apple's label rules let data processed only in real time and not retained be left out (App Store Connect "optional disclosure" – VERIFY current wording); the opt-in storage makes it collected anyway | To do |
| User Content → Other User Content | Saved AI recipes, AI basics | To do |
| **5.1.2(i) – sharing personal data with third-party AI** (amended 13 Nov 2025: apps must clearly disclose and obtain explicit permission before sharing personal data with third-party AI; reported by TechCrunch 2025-11-13, Apple text not fetched – VERIFY on developer.apple.com) | With `AI_PROVIDER=local` the photo goes to **our own** model on our own (or rented) server – arguably not "third-party AI"; the AI notice is still shown and accepted before first use, which also covers the rule if Apple sees it otherwise. **If `AI_PROVIDER=openai` is ever used: a separate explicit permission naming OpenAI is required** (LC-41) | Met for local (VERIFY) |
| 1.2 UGC / AI output | Report and filter expectations apply to AI output shown to users as well – same fix as LC-39 | Gap LC-39 |
| 1.4.1 / 1.4.3 Physical harm, alcohol | Recipes: no health claims, raw-egg and energy+alcohol warnings, no drinking games (S2), max 2 standard drinks per serving (S1), 18+ | Met (keep) |
| Camera usage string (`NSCameraUsageDescription`) | Must mention scanning labels and barcodes, not only posting photos – check `app.config.ts` (developer task) | VERIFY |
