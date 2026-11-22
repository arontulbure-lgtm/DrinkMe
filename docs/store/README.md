DRAFT v0.1 – 2026-11-16 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Store submission kit – what to paste where

Covers `docs/JOHN_TODO.md` §5. Files in this folder:

| File | Use |
|---|---|
| `listing.en.md`, `listing.ro.md` | Name, subtitle, short/full description, keywords, promo text, category, URLs, screenshot rules |
| `apple-privacy-labels.md` | App Store Connect → App Privacy, answer by answer |
| `play-data-safety.md` | Play Console → App content: Data safety, Target audience, App access, Ads, alcohol notes |
| `age-rating.md` | Apple age-rating questionnaire and Play/IARC content rating |
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
6. App Review Information: test account + notes:
   > DrinkMe is a social app about drinks, alcoholic and non-alcoholic, for adults 18+. After sign-in the user must confirm they are 18 or older before any content is shown. User-generated content: users can report posts, comments and profiles (6 reasons) and block users; reports are reviewed by a moderator within 24 hours, and content reported by 3 different users is hidden until reviewed; offending users are suspended. Account deletion: Edit Profile → Delete account. Contact: drinkmesocialapp@gmail.com. DrinkMe does not sell alcohol. AI features are disabled in this version.
7. Submit.

## 3. Google Play – Play Console, in order
1. Create app: name **DrinkMe**, default language, App (not game), Free; accept the declarations.
2. Policy → App content: everything in `play-data-safety.md` (privacy policy, app access, ads, content rating per `age-rating.md` §2, target audience **18+ only**, data safety with the deletion URL `[BASE_URL]/en/account-deletion.html`).
3. Store presence → Main store listing (en + ro translation): title, short and full description, graphics (icon 512×512, feature graphic 1024×500, phone screenshots), category Food & Drink, contact email.
4. Testing: Play requires closed testing with a minimum number of testers for a period before production for new personal developer accounts – VERIFY the current numbers in the console.
5. Production → Countries per D-02 → release.

## 4. Open points before submission (VERIFY)
- **Unfinished features on screen:** the Scanner tab ("AI Scanner – Coming soon") and the Smart Bar "Recipes" tab ("Coming soon") are visible in the app. Apple 2.1 (app completeness) can reject placeholder screens. Ask the planner whether to hide them in store builds (rule: never delete AI features – a flag that hides the tab keeps them).
- **Home-screen name:** `app.config.ts` has `name: "DrinkMeFinal"`; the store name is DrinkMe. Users would see "DrinkMeFinal" under the icon. Change before the first store build (developer task, ask first – slug change may affect EAS).
- **Unused iOS permission text:** `app.config.ts` declares `NSPhotoLibraryAddUsageDescription` ("DrinkMe saves drink photos to your library"), but no code saves photos to the library (no `expo-media-library`). Remove it or make it true – an inaccurate purpose string can be a 5.1.1 rejection.
- **In-app legal links and contact (LC-04, LC-05, T-01/T-02):** Apple 1.2 asks for published contact information for UGC apps; the store listing gives the email, but the app has no "Contact" or legal links yet.
- **Terms acceptance (LC-03):** Play UGC policy expects users to accept terms before posting; the Terms step (T-06/T-07) is not built yet.
- **Objectionable-content filter (LC-19, Apple 1.2):** not built.
- Per-country age (LC-01): only 18+ today; keep launch countries to 18+ markets until it ships.
- Apple/Play age-assurance laws in some US states (LC-26) if the US is in scope.
