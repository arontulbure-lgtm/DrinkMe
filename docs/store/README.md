DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Store submission kit – what to paste where

Covers `docs/JOHN_TODO.md` §5. Files in this folder:

| File | Use |
|---|---|
| `listing.en.md`, `listing.ro.md` | Name, subtitle, short/full description, keywords, promo text, category, URLs, screenshot rules |
| `apple-privacy-labels.md` | App Store Connect → App Privacy, answer by answer |
| `play-data-safety.md` | Play Console → App content: Data safety, Target audience, App access, Ads, alcohol notes |
| `age-rating.md` | Apple age-rating questionnaire and Play/IARC content rating |
| `review-notes.md` | App Review notes and test-account instructions for both stores |
| `../public/` | Static legal site to host (privacy, terms, guidelines, account deletion, …), built by `scripts/build-public-pages.mjs` – see `../public/README.md` |

## 1. Before anything – needs John
1. **Lawyer sign-off (D-01).** The texts in `docs/legal/` and the hosted pages are drafts. Stores need a final privacy policy; publishing drafts as final is not acceptable. After sign-off: set effective dates, change the banner and remove `noindex` in `scripts/build-public-pages.mjs`, rebuild.
2. **Registration data (D-17):** CUI and Trade Register number in `imprint.md` and `terms.md` (shown as `[TO FILL BY JOHN]` on the pages).
3. **Hosting of the legal pages (D-06):** choose the host, publish `docs/public/`, note the base URL. Replace `[BASE_URL]` in every file of this folder.
4. **Developer accounts:** Apple Developer Program and Google Play Console under **Tulbure Aron PFA** (same name as in the privacy policy). Play organisation accounts need a D-U-N-S number – VERIFY.
5. **Launch countries (D-02):** recommended Romania/EU first; set the same list in both consoles.
6. **Contact mailbox (D-15):** drinkmesocialapp@gmail.com is used everywhere for now; if it moves to a domain address, change it in `docs/legal/`, `scripts/build-public-pages.mjs` (`CONTACT_EMAIL`), the listings and the app (T-01 `CONTACT_EMAIL`).
7. **Technical prerequisites:** HTTPS API (SEC-D) before answering "encrypted in transit: Yes"; Sign in with Apple enabled in Firebase (LC-22, Apple 4.8); first EAS build (Maps key SHA-1).
8. **Screenshots:** real devices or simulators, sizes required by each console, following `listing.en.md` §6. Not prepared here.
9. **Reviewer test account:** an 18+-confirmed account with a password, not a personal one.

## 2. Apple – App Store Connect, in order
1. Create the app: name **DrinkMe**, bundle id `com.aroncarola.drinkmefinal`, primary language English (U.S.) or Romanian, SKU of your choice.
2. App Information: subtitle, category (Food & Drink / Social Networking), **Privacy Policy URL** `[BASE_URL]/en/privacy.html`, content rights ("does not contain third-party content" → **it does contain user content**; answer per the console wording – VERIFY), **Age Rating** per `age-rating.md` §1 (expect 18+).
3. App Privacy: `apple-privacy-labels.md` step by step.
4. Version page (per localization en + ro): promo text, description, keywords, support URL, screenshots, "What's new".
5. Pricing and Availability: Free; countries per D-02.
6. App Review Information: test account + notes from `review-notes.md`. Choose AI paragraph (a) if the production server runs `AI_PROVIDER=off` at submission, (b) if it runs `AI_PROVIDER=local` (the app follows the server: it shows the real scanner and recipes only when `GET /api/ai/status` says available, otherwise the "Coming soon" previews).
7. Submit.

## 3. Google Play – Play Console, in order
1. Create app: name **DrinkMe**, default language, App (not game), Free; accept the declarations.
2. Policy → App content: everything in `play-data-safety.md` (privacy policy, app access, ads, content rating per `age-rating.md` §2, target audience **18+ only**, data safety with the deletion URL `[BASE_URL]/en/account-deletion.html`).
3. Store presence → Main store listing (en + ro translation): title, short and full description, graphics (icon 512×512, feature graphic 1024×500, phone screenshots), category Food & Drink, contact email.
4. Testing: Play requires closed testing with a minimum number of testers for a period before production for new personal developer accounts – VERIFY the current numbers in the console.
5. Production → Countries per D-02 → release.

## 4. Open points before submission (VERIFY)
- **Unfinished features on screen:** the Scanner tab ("AI Scanner – Coming soon") and the Smart Bar "Recipes" tab ("Coming soon") are visible in the app. Apple 2.1 (app completeness) can reject placeholder screens. Ask the planner whether to hide them in store builds (rule: never delete AI features – a flag that hides the tab keeps them).
- **Home-screen name:** fixed – `app.config.ts` `name: "DrinkMe"` (slug stays `DrinkMeFinal`, not shown to users).
- **Permission texts:** fixed – `NSPhotoLibraryAddUsageDescription` removed, no microphone permission, `RECORD_AUDIO` blocked (`app.config.ts`, working tree 2026-11-22).
- **In-app legal links and contact (LC-04, LC-05, T-01/T-02):** built. "Contact us" always shows; the document links show only when `EXPO_PUBLIC_LEGAL_BASE_URL` is set (https) in the **production** build – `eas.json` does not set it (LC-56). Check on the release build.
- **Terms acceptance (LC-03, T-06/T-07):** built; the server records version and date. The app step shows only with `EXPO_PUBLIC_TERMS_STEP_ENABLED=true` in the production build (LC-56) – turn it on after the lawyer review (D-01). Play's UGC policy expects it.
- **Misleading Explore card (LC-18, D-18):** "DrinkMe partners … offer discounts to beta testers" is still shown – remove before submission (Apple 2.3, consumer law).
- **"Beta" wording (D-29):** the listing "What's new" and the Terms still say beta; decide and keep them consistent.
- **Objectionable-content filter (LC-19, Apple 1.2):** not built.
- Per-country age (LC-01): only 18+ today; keep launch countries to 18+ markets until it ships.
- Apple/Play age-assurance laws in some US states (LC-26) if the US is in scope.

## 5. When AI is enabled (applies once the AI features are switched on)
Whether AI is on at launch depends on the GPU host (LC-45). The app already contains the AI screens; they appear only when the server runs `AI_PROVIDER=local` and the AI service is healthy. Decisions of 2026-11-22: local open-weights models on DrinkMe's own EU/EEA GPU host only (`AI_PROVIDER=local`; production accepts only `off` or `local`), scan photos processed in memory and never kept (no opt-in), OpenAI and any outside AI company never used, daily limits 20 scans / 10 recipe batches per user. Before switching it on (server first), do all of this:
1. `review-notes.md`: use AI paragraph (b). "Processed by our own server in the EU and not used to train models" is true with D-23 (EU/EEA host, provider still to be named) and D-21/D-24 (no photo kept, nothing used for training).
2. `play-data-safety.md` §9 and `apple-privacy-labels.md` "When AI is enabled": update the console answers.
3. `age-rating.md` §4: re-answer the AI-generated content questions.
4. Camera purpose string mentions scanning labels and barcodes (`expo-camera`: "DrinkMe uses the camera to scan bottle labels and barcodes.").
5. Listing: describe AI features only once they work in the store build (Apple 2.3); label them as AI; no promise of "personalised" or "instant" results (LC-44).
6. The AI transparency page is part of `docs/public` (`ai-transparency.html`); the AI notice must link to it and to the privacy policy (LC-43). Name the GPU host in privacy policy §5 and `internal/subprocessors.md` (LC-45).
