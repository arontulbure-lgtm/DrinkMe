DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# App Store Connect – "App Privacy" answers

Where: App Store Connect → your app → **App Privacy** → Get Started / Edit. Answer in the order below.
Derived from the code on branch `auto/run-2026-11-14` and from `docs/legal/internal/data-inventory.md` (file and line for each fact there). Build checked: release build with `STORIES_ENABLED` false (`src/screens/HomeScreen.tsx:30`). Since the AI merge (2026-11-23) the app's AI switches are on and the AI screens follow the server (`AI_PROVIDER=off` → "Coming soon" previews); the answers below are for a server with AI off, and the section "When AI is enabled" lists the changes for `AI_PROVIDER=local`. The development log bridge (`src/lib/devLogBridge.ts`) is development-only and is not in release builds.

Apple's definitions used (developer.apple.com/app-store/app-privacy-details – VERIFY at submission that wording has not changed): data is **collected** when it is sent off the device and kept longer than needed to answer the request in real time; **linked** when it is tied to the user's account or identity; **tracking** means linking with other companies' data for advertising or sharing with data brokers. Data handled by a **service provider** on our behalf (Google Firebase, hosting) counts as collected by us, not as tracking.

**If anything below changes (AI on, analytics, crash reporting, push notifications, ads), these answers must be redone before the release that ships it.**

## Step 1 – "Do you or your third-party partners collect data from this app?"
**Yes.**

## Step 2 – Data types collected

Tick exactly these. All are **Linked to the user: Yes**. **Used for tracking: No** for every type.

| Apple category → data type | What it is in DrinkMe | Source in code | Purposes to tick |
|---|---|---|---|
| Contact Info → **Name** | First and last name (display name; may be a nickname); name from Google/Apple at sign-in unless refused as reserved | User record `server/server.js` (data-inventory §2 "User"); name prompt `src/screens/OnboardingScreen.tsx` | App Functionality |
| Contact Info → **Email Address** | Sign-in email (Firebase Authentication), stored on the server for the owner only | data-inventory §1–2; `src/screens/AuthScreen.tsx` | App Functionality |
| User Content → **Photos or Videos** | Post photos and profile photo the user picks or takes (camera / photo library) | `src/screens/CreatePostScreen.tsx:276-305`, `src/screens/ProfileScreen.tsx:235-241` | App Functionality |
| User Content → **Other User Content** | Post text (drink name, description, rating, category, alcoholic flag, place name as text), comments, profile city and bio, Smart Bar list, report reasons and details, partner requests | data-inventory §2 (Post, Comment, Smart Bar item, Report, Drink partner) | App Functionality |
| Identifiers → **User ID** | Firebase uid used as the DrinkMe user id; the API token on the device carries it | data-inventory §2, §4 | App Functionality |
| Other Data → **Other Data Types** | Date of the 18+ confirmation (no birth date), privacy-notice and Terms version and acceptance time, moderation and suspension records, security log entries (ids and times) | data-inventory §2 ("User", "Audit log") | App Functionality |

Purpose notes:
- Apple's "App Functionality" includes authentication, security and fraud prevention, and moderation – that is all DrinkMe uses this data for.
- Do **not** tick Third-Party Advertising, Developer's Advertising or Marketing, Analytics, Product Personalization or Other Purposes. The feed is not personalised by profiling: it is ordered by time, or by cheer count for "trending" (`server/server.js` `GET /api/drinks`, about line 3600), and filtered by category, city text, the user's blocks and partners – the same for everyone, not based on a profile of the user. VERIFY with the developer before submission that no ranking by interests has been added.

### Choices to confirm (VERIFY)
- **Cheers, saves, blocks:** treated here as part of "Other User Content" (the user creates them; they are stored to provide the feature, not to measure usage). An alternative reading puts them under Usage Data → Product Interaction. Recommendation: keep as Other User Content; if App Review asks, adding Product Interaction (App Functionality, linked, not tracking) is harmless.
- **Profile city:** free text the user types, not derived from the device. Declared as Other User Content, **not** as Location. VERIFY.
- **Server request logs:** since T-05 they hold no IP address, user agent or referrer; IP is used only in memory for rate limits (≤ 15 minutes) and never to derive location. Not declared. Becomes "Coarse Location" if IP geolocation is ever added.
- **Terms acceptance (version, date) and the App Check token:** the Terms record is part of the account ("Other Data Types", App Functionality). App Check is off at launch; if switched on with App Attest/DeviceCheck, our server receives an app attestation token and keeps only counts – VERIFY then whether Apple expects a declaration (recommended: none, no new data type).
- **Search queries (Explore, user search):** sent to our server to answer the request and not stored (query strings are removed from logs, `server/server.js:245-248`) – not "collected" under Apple's definition, so **Search History is not declared**.
- **Google Places (place search in Create Post):** the phone sends the search text and the selected place id straight to Google Maps Platform (`src/components/LocationPickerModal.tsx:66`, `:110`). Google acts under the Maps Platform terms. Recommendation: not declared as a separate type (the chosen place name is stored only as post text, already under Other User Content). VERIFY with the lawyer whether Google's own retention of Places requests makes Google a "third-party partner" for this purpose; if yes, add User Content → Other User Content (already ticked) – no new type is needed because no coordinates are sent by the app, and since d25b861 the app no longer requests coordinates from Google at all (`src/components/LocationPickerModal.tsx:111-131`).
- **Support emails** sent to drinkmesocialapp@gmail.com are outside the app – not declared (Apple's label covers data collected through the app). If an in-app "Contact" form is added later, declare User Content → Customer Support.

## Step 3 – Not collected (leave unticked)

| Category | Why not |
|---|---|
| Health & Fitness | No health data is asked for (alcohol posts are user content; see the DPIA screening) |
| Financial Info, Purchases | Free app, no payments, no in-app purchases |
| Location (Precise, Coarse) | No location permission is requested (`app.config.ts` has none; no `expo-location`); place names are typed/selected text |
| Sensitive Info | Not asked for |
| Contacts | No contacts access |
| Phone Number, Physical Address, Other Contact Info | Not asked for |
| Audio Data, Gameplay Content | None |
| Customer Support (in app) | No in-app support form |
| Browsing History, Search History | Not stored (see above) |
| Device ID | No advertising or vendor identifier is read; no analytics SDK |
| Purchase History | None |
| Usage Data (Product Interaction, Advertising Data, Other Usage Data) | No analytics SDK (`package.json`: no analytics, Sentry or ads packages) |
| Diagnostics (Crash Data, Performance Data, Other Diagnostic Data) | No crash-reporting SDK in release builds |
| Surroundings, Body | None |

## Step 4 – Tracking
"Do you or your third-party partners use data for tracking purposes?" → **No.**
No App Tracking Transparency prompt is needed (no `NSUserTrackingUsageDescription` in `app.config.ts`).

## Step 5 – Privacy Policy URL
`[BASE_URL]/en/privacy.html` (App Store Connect → App Information → Privacy Policy URL). Optional "User Privacy Choices URL": `[BASE_URL]/en/account-deletion.html`.

## Step 6 – Check against the policy
These answers match the Privacy Policy §2 ("What we collect") and the statement "We do not collect your precise location, contacts, birth date or payment details, and we do not use advertising or analytics trackers" (`docs/legal/privacy-policy.md`). Keep them in sync: a change to one needs a change to the other.

## When AI is enabled (applies once the AI features are switched on)
Applies when the server switches on the scanner and AI recipes (`AI_PROVIDER=local`); facts in Privacy Policy §5a. Decisions of 2026-11-22: local open-weights models on DrinkMe's own EU/EEA GPU host only (`AI_PROVIDER=local`; production accepts only `off` or `local`), scan photos processed in memory and never kept (no opt-in), OpenAI and any outside AI company never used, daily limits 20 scans / 10 recipe batches per user. Redo the label before switching it on:
- **User Content → Photos or Videos:** already declared (App Functionality) for post and profile photos. Scan photos are processed in real time and never kept – Apple lets such data be left out, so nothing new. If a photo opt-in is ever offered, redo this item first.
- **Usage counters:** daily AI counters (deleted after one day) are used only for limits – App Functionality; no new type expected (VERIFY whether Apple wants "Other Usage Data").
- **User Content → Other User Content:** add saved AI recipes, AI basics and reports about AI answers (App Functionality).
- **Barcode:** only the number goes to Open Food Facts from our server – nothing new to declare.
- **Guideline 5.1.2(i)** (sharing personal data with third-party AI needs clear disclosure and explicit permission – VERIFY current text): the photo goes only to our own model on our own EU/EEA server – not third-party AI; the AI notice is still accepted before first use. OpenAI and any outside AI company are excluded (D-26); the code path is removed.
- **Camera purpose string:** must mention scanning labels and barcodes (`expo-camera`: "DrinkMe uses the camera to scan bottle labels and barcodes.").
- **Guideline 1.2 / 4.7-style AI output:** report action on AI answers is built (`POST /api/ai/report`, LC-39).
