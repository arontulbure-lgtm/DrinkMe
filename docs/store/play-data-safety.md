DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Google Play Console – Data safety, Target audience, Content declarations

Where: Play Console → your app → **Policy → App content**. Fill the sections in this order: Privacy policy → App access → Ads → Content rating (see `age-rating.md`) → Target audience and content → Data safety → Government apps (No) → Financial features (none) → Health (none).
Facts come from the code on branch `auto/run-2026-11-14` via `docs/legal/internal/data-inventory.md`, re-checked on `auto/launch-2026-11-17` on 2026-11-22 (AI off, App Check off, Terms acceptance recorded). Google Play policies were **not** fetched in full for this draft except the Tobacco and Alcohol policy (support.google.com/googleplay/android-developer/answer/9878810, read 2026-11-16) – VERIFY each question's wording in the console.

## 1. Privacy policy
URL: `[BASE_URL]/en/privacy.html`

## 2. App access
"All or some functionality is restricted" → **Yes**: sign-in and an 18+ confirmation are required. Give the reviewer a test account (email + password) that has already confirmed 18+ and accepted the privacy notice, and these instructions:
> Sign in with the account below. DrinkMe is for adults 18+ only; the test account has already confirmed its age. Posts need a photo: use any photo from the gallery.

(Test users can be created with the scripts in `docs/DEVICE_TEST_SESSION.md` – do not reuse a personal account.)

## 3. Ads
"Does your app contain ads?" → **No.** (No ads SDK in `package.json`.)

## 4. Target audience and content
| Question | Answer | Reason |
|---|---|---|
| Target age groups | **18 and over only** | Alcohol content; 18+ gate enforced on the server before any content (`requireSignedInAdult`, data-inventory §3); Terms §3 |
| Could the app unintentionally appeal to children? | **No** | Drink photos and reviews for adults; no characters, games or child-oriented design |
| Store listing presence for children | Not applicable (no under-18 group selected) | — |
| Committed to the Families policy | **No** | Not designed for children |

Note: the app currently applies one 18+ gate everywhere. Countries with a higher drinking age (US 21, JP 20, KR 19, …) rely on the Terms only until the per-country age check ships (LC-01, decision D-02). If the first release is Romania/EU only (D-02 recommended option a), restrict **Countries/regions** in Production → Countries to those markets.

## 5. Alcohol and restricted content (no separate form – declare honestly in Content rating and check the listing)
- DrinkMe does **not** sell, deliver or facilitate the sale of alcohol or tobacco (Terms §2; Community Guidelines §1 "No selling").
- Content encouraging excessive, binge or competitive drinking, drinking games, drink-driving or alcohol with minors is forbidden (Community Guidelines §1) and can be reported with the reason "dangerous drinking" or "underage" (Terms §8).
- Store listing and screenshots follow `listing.en.md` §6.
- If the console shows a "Restricted content / alcohol" or "age-restricted content" declaration, answer: app references alcohol, user-generated content about drinks; no sales; adults 18+ only. VERIFY the current console wording.

## 6. Data safety form

### 6.1 Data collection and security (overview questions)
| Question | Answer | Reason |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | Account, photos, user content |
| Is all of the user data collected by your app encrypted in transit? | **Yes – only once the API runs over HTTPS** (SEC-D, decided at hosting). Firebase and Google Places already use HTTPS. **Do not submit "Yes" while `EXPO_PUBLIC_API_URL` is an `http://` address.** | VERIFY at submission |
| Which ways can users request that their data is deleted? | **"Users can request that data be deleted"** + in-app deletion | Edit Profile → Delete account (`src/screens/EditProfileScreen.tsx:168`, `src/components/DeleteAccountModal.tsx`), also on the age gate (`src/screens/AgeGateScreen.tsx:75`); email path on the web page |
| Delete account URL | `[BASE_URL]/en/account-deletion.html` | Page explains the in-app path and the email request path, what is deleted and what is kept (backups ≤ 30 days) |
| Can users request that some data be deleted without deleting the account? | **Yes** (optional field) | Users can delete posts, comments, cheers, saves, Smart Bar items, partners and blocks in the app |

### 6.2 Data types
For every type below: **Shared: No** (Google Firebase, Google Maps Platform and the hosting provider are service providers acting for us, which Play does not count as "sharing"; no data goes to third parties for their own purposes). **Processed ephemerally: No** unless stated.

| Play category → type | Collected | Required or optional | Purposes | Notes / code |
|---|---|---|---|---|
| Personal info → **Name** | Yes | Required (a display name is asked for at onboarding; may be a nickname) | App functionality; Account management | `src/screens/OnboardingScreen.tsx`; User record |
| Personal info → **Email address** | Yes | Required | Account management; App functionality; Fraud prevention, security and compliance | Firebase Authentication; owner-only on the server |
| Personal info → **User IDs** | Yes | Required | Account management; App functionality; Fraud prevention, security and compliance | Firebase uid; audit log keeps ids only (90 days) |
| Personal info → **Other info** | Yes | Optional | App functionality | Profile city and bio; date of the 18+ confirmation (no birth date) |
| Photos and videos → **Photos** | Yes | Optional (only when the user posts or sets a profile photo) | App functionality | `src/screens/CreatePostScreen.tsx:276-305`, `src/screens/ProfileScreen.tsx:235-241`; videos are not supported |
| App activity → **Other user-generated content** | Yes | Optional | App functionality | Posts (text, rating, category, place name), comments, Smart Bar list, reports (reason + details) |
| App activity → **Other actions** | Yes | Optional | App functionality | Cheers, saves, drink-partner requests and links, blocks |
| App activity → **In-app search history** | Yes, **processed ephemerally: Yes** | Optional | App functionality | Explore/user search text is sent to our server only to answer the request; not stored, removed from logs (`server/server.js:245-248`). Place search text goes from the phone to Google Places (`src/components/LocationPickerModal.tsx:66`) – VERIFY with the lawyer whether to declare it here only (recommended) |

Purposes **not** ticked for any type: Analytics, Developer communications, Advertising or marketing, Personalization.

### 6.3 Not collected (leave unticked)
Location (approximate and precise – no location permission; place names are text), Financial info, Health and fitness, Messages (no direct messaging; comments are public user content), Audio, Files and docs, Calendar, Contacts, App info and performance (no crash logs or diagnostics SDK in release builds; `devLogBridge` is development-only), Device or other IDs (no advertising ID; VERIFY that no dependency adds `com.google.android.gms.permission.AD_ID` to the merged Android manifest after the first EAS build), Web browsing, Installed apps, Personal info → Address / Phone number / Race and ethnicity / Political or religious beliefs / Sexual orientation.

Server request logs contain **no IP address, user agent or referrer** in production (T-05); IP addresses are used only in memory for rate limits (≤ 15 minutes) and never for location. Nothing to declare; if IP geolocation is ever added, declare Approximate location.

Terms acceptance (version and date) and App Check: the Terms record is part of the account (covered by "User IDs"/"Other info" purposes Account management, App functionality). App Check is off at launch; if it is switched on with Play Integrity, VERIFY whether Google expects any Data safety entry for Play Integrity (Google's own SDK guidance) – recommended reading: no new data type, because our server receives only an app attestation token and keeps only counts.

### 6.4 Security practices shown on the listing
- Data encrypted in transit: see 6.1 (only after HTTPS).
- Users can request deletion: Yes.
- Independent security review (MASA): **No** (not done).
- Committed to Families policy: **No**.

## 7. Other App content declarations
| Section | Answer |
|---|---|
| News app | No |
| COVID-19 contact tracing | No |
| Government app | No |
| Financial features | None |
| Health apps | No (not a health app; the Age and Alcohol Policy only points to help lines) |
| Data safety → "account creation" | Users can create an account in the app (email, Google; Apple only on iOS) |
| Photo and video permissions declaration (if the console asks, because of `READ_MEDIA_IMAGES`) | The app uses the system photo picker / camera only when the user adds a photo. VERIFY after the first EAS build which media permissions `expo-image-picker` adds to the Android manifest; if only the Android Photo Picker is used, no declaration is needed |

## 8. Keep in sync
These answers match `docs/legal/privacy-policy.md` v0.4 §2, §5 and §8 and `apple-privacy-labels.md`. Turning on AI (§9), analytics, crash reporting, push notifications or ads changes this form and the policy **before** release.

## 9. When AI is enabled (separate release – not v1.0.0)
Applies only to the release that switches on the scanner and AI recipes (PR #4, `AI_PROVIDER=local`). Privacy Policy §5a describes the processing. Changes to the answers above:

| Item | Change | Notes |
|---|---|---|
| Photos and videos → **Photos** | Add the scanner as a source. Default flow: photo processed in memory on our own AI server and discarded → **processed ephemerally** for that flow. If "Help improve the scanner" is offered (D-22), photos of opted-in users are stored up to 90 days → Photos stays **Collected, not ephemeral**; purposes **App functionality** and **Analytics** (closest Play purpose for testing and improving the scanner – VERIFY the definitions in the console) | Optional: Yes. Shared: No (our own AI service; the GPU host is a service provider). If D-22 (a) hides the opt-in, the existing "Photos – App functionality" entry already covers it |
| App activity → **Other user-generated content** | Add saved AI recipes, AI basics, reports about AI answers | App functionality; reports also Fraud prevention, security and compliance |
| Barcode lookup | Nothing new: only the barcode number goes to Open Food Facts, from our server, without any user data | Not "sharing" of user data |
| Deletion | Account deletion also deletes saved recipes, AI settings and kept photos; turning the opt-in off deletes kept photos | Mention on the deletion page (already drafted) |
| **AI-Generated Content policy** | In-app reporting of offensive AI output is required: built in PR #4 (Report on recipe detail and scan result → `POST /api/ai/report`) | John reviews these reports (LC-39) |
| Content rating | Re-answer IARC questions about AI-generated content if asked (`age-rating.md` §4) | — |
| Camera permission | `expo-camera` added by PR #4 (no audio) | Photo and video permissions declaration only if the console asks |
If `AI_PROVIDER=openai` were ever used (not planned, D-26), photos would be **shared** with OpenAI → Shared: Yes, plus a new consent step – do not ship without redoing this form.
