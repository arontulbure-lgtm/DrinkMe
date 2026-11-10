# What only John can do

Prepared by the autonomous run of 2026-10-30. Nothing here has been attempted. Each list is in the order to do it.
Values in angle brackets are placeholders: never paste real keys into this file or any other tracked file.

## 1. Device checks (do these first)

Start the backend (`cd server`, `node server.js`; `server/.env` must have `NODE_ENV=development`) and Metro (`npx expo start`). Use two phones or one phone plus an emulator when a step needs a second user.

### 1a. Sign-in, every provider

| # | Steps | Expected result |
|---|---|---|
| 1 | Fresh install, open the app | Sign-in screen. No feed is visible before signing in. |
| 2 | Email sign-up with a new address and a valid password | Age gate (18+), then the privacy notice, then the name prompt. After these, Home loads with no error. |
| 3 | Answer "no" at the age gate | No feed, no alcoholic content anywhere. The app explains why. |
| 4 | Sign out, sign in again with the same email and password | Goes straight to Home: age gate, notice and name are not asked again. |
| 5 | Sign in with a wrong password | A clear ro/en error. The app stays on the sign-in screen. |
| 6 | Sign up with an invalid email or a too-short password | A validation message before any network call. |
| 7 | Google sign-in on a development build (Expo Go only works through the auth.expo.io proxy) | Google consent screen, then the same first-run screens as step 2 for a new account. Your Google photo is shown as avatar. |
| 8 | Google sign-in with the same Gmail address you used for an email/password account | You land in the same account (same posts). The other device's session is logged out (expected: this is the takeover fix). |
| 9 | Apple sign-in (iOS only) | Not available yet: needs the $99 Apple Developer account. The button must not appear on Android. |
| 10 | Kill the app while signed in, reopen | Still signed in, Home loads. |
| 11 | Turn the backend off, reopen the app | Session error screen with Retry, not an empty feed. Retry after starting the backend works. |
| 12 | Sign out as user A, sign in as user B on the same phone | B never sees A's feed, profile or notifications, not even for a moment. |
| 13 | Delete account (Profile, Settings) | Confirmation, then signed out. Signing in again with the same account says the account was deleted. |

### 1b. Lists and images

| # | Steps | Expected result |
|---|---|---|
| 1 | Post a drink with a camera photo (alcoholic on) | Upload succeeds; the post shows on Home and Profile with the image. |
| 2 | Post a non-alcoholic drink with a gallery photo | Same, and the "non-alcoholic" label is right. |
| 3 | Post with a 12 MP photo as **avatar** | Either it uploads, or a clear "image too large" message. No crash. |
| 4 | Post a geotagged photo on iOS and on Android, then inspect the stored image (ask the next run to check it) | Tells us whether GPS data survives. Images are visible to other users. |
| 5 | Scroll Home past 20 posts | "Load more" appears and loads the next page without duplicates. |
| 6 | Explore: search a user (2+ letters), open their profile | Results show names, never email addresses. |
| 7 | Open a post, add a comment, delete it | Comment appears and disappears; the count updates. |
| 8 | Like and save a post, check Profile, Saved | Saved list shows it; unsaving removes it. |
| 9 | Partner request from A to B, accept on B | B gets a request, accepting adds both sides; A's partner feed shows B's posts. |
| 10 | Report a post from three different accounts | After the third report the post disappears for everyone except its author and you (admin). |
| 11 | Block a user | Their posts, comments and profile disappear for you, and yours for them. Blocked Users lists them; unblocking restores. |
| 12 | Switch language ro/en (Settings) | Every new screen (age gate, notice, verify email, report sheet, suspension message) is translated. |

## 2. Turn on email verification (`REQUIRE_VERIFIED_EMAIL`) for the closed beta

The takeover fix now works with the flag off. The flag adds "no access before the email is verified". Test on a real Firebase project before turning it on.

1. Firebase console, Authentication, Settings, User account linking: confirm "Link accounts that use the same email" (one account per email). Write down what it says.
2. Locally, add `REQUIRE_VERIFIED_EMAIL=true` to `server/.env` and restart the server. The log must not show `[auth] A token auth_time is ahead`.
3. Phone A: sign up with an email address you control. Expected: the Verify Email screen, and nothing else in the app works.
4. Tap Resend. Expected: a new email arrives and the button has a cooldown.
5. Tap "I verified" before clicking the link. Expected: a message that the email is not verified yet.
6. Click the link in the email, then tap "I verified". Expected: the age gate, then the normal first-run screens.
7. Kill and reopen the app. Expected: you stay signed in.
8. Takeover test, with a Gmail address you own and that has no DrinkMe account yet:
   1. Phone A: sign up with that Gmail address and any password. Do not verify.
   2. Phone B: sign in with Google using the same address.
   3. In the Firebase console, open that user. Expected: the same uid, and the providers list shows only Google (the password was removed). Write down the result either way.
   4. Phone A: pull to refresh, then try to sign in with the password. Expected: logged out, and the password no longer works.
9. Firebase console: disable the test user. On a phone signed in as that user, sign out and in again. Expected: refused.
10. On the Verify Email screen of a new unverified account, choose Delete account. Expected: the account is gone from the Firebase console and the app returns to sign-in.
11. If every step matched, keep the flag on for the closed beta and set it on the hosted server too. Every running app is signed out once when the flag goes on: tell the testers.

## 3. Key rotation and restriction

### OpenAI key
1. platform.openai.com, API keys: create a new secret key for "drinkme-server".
2. Put it in `server/.env` as `OPENAI_API_KEY=<new key>` (and later in the host's variables). Never in the app's `.env`.
3. Revoke the old key in the same page.
4. Limits page: set a hard monthly budget (for example $20) and an email alert at 50%.
5. AI stays off (`AI_ENABLED` unset) until the conditions in the run log under "T1-8 decisions" are met.

### Google Maps key (`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`)
This key is inside the app bundle, so anyone can extract it. Restriction limits the damage.
1. console.cloud.google.com, APIs and Services, Credentials, open the key.
2. API restrictions: allow only "Places API" (and "Places API (New)" if the app uses it).
3. Application restrictions: the app calls Places through plain HTTPS, not the Maps SDK, so an Android/iOS app restriction only works if each request sends `X-Android-Package` and `X-Android-Cert` (Android) or `X-Ios-Bundle-Identifier` (iOS). Ask the next run to add these headers after the first EAS build gives you the SHA-1, then turn on the restriction. The safer long-term fix is to call Places from the server.
4. Quotas: cap Places requests per day (for example 1,000) so a leaked key cannot run up a bill.
5. Billing: set a budget alert.

### Other keys
1. The Firebase web API key and Maps key appear in plain text in `D:\DrinkMeApp\CLAUDE.md`. Replace them with placeholders there.
2. The app's root `.env` also defines `ANTHROPIC_API_KEY`. The app never uses it and it is not bundled (no `EXPO_PUBLIC_` prefix), but it does not belong there: move it out and rotate it if that file was ever shared.
3. `JWT_SECRET`: generate a separate one for the hosted server (`node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"`). Never reuse the local one.

## 4. Real database, hosting and HTTPS

1. Choose a host that builds the root `Dockerfile` (Railway or Render). HTTPS comes with the host's domain.
2. Create a persistent volume and set `DB_FILE=/data/db/db.json` (its own folder on the volume).
3. Set the variables: `NODE_ENV=production`, `JWT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_KEY` (the whole JSON as one value), `CORS_ALLOWED_ORIGINS`, `ADMIN_USER_IDS=<your uid>`, `TRUST_PROXY_HOPS` (1 on most hosts: check with the host's docs), and `ALLOW_EMPTY_DB=true` for the very first start only. Leave `AI_ENABLED` and `REQUIRE_VERIFIED_EMAIL` unset until decided.
4. Deploy, then open `https://<host>/healthz`. Expected: `{"status":"ok"}`.
5. Remove `ALLOW_EMPTY_DB` and redeploy.
6. Backups: schedule `npm run backup` once a day on the host (cron job or scheduled service) with `BACKUP_DIR` on a second volume or storage bucket. Check the next day that a file appeared under `daily/`. See `server/README.md`, "Backups".
7. Set `EXPO_PUBLIC_API_URL=https://<host>` for the build profile in `eas.json`.
8. Real database (DATA-1): before passing about 1,000 users, ask the next run to move from the JSON file to Postgres (Railway, Render or Supabase). Choose the provider and create the database; the code change is the run's job.

## 5. Store accounts and policy checks

1. Apple Developer Program ($99/year) and Google Play Console ($25 once), both under the same legal name as the privacy policy.
2. **Apple guideline 4.8:** an iOS app with Google sign-in must also offer Sign in with Apple (or an equivalent). Enable Apple in Firebase once you have the account and ask the next run to finish it.
3. Age rating: answer the questionnaires with "frequent alcohol references" (expect 17+ on iOS, Mature/18+ on Play). Set the Play target audience to 18+ only.
4. Apple 1.2 (user-generated content): report, block, a way to contact you, and removal of offenders are all built. Put a support email in the store listing and in the app.
5. Play "Alcohol" and Apple 1.4.3 rules: no encouraging excessive drinking, no sales. Check the store screenshots and description for this.
6. Account deletion: in-app deletion is built; Play also needs a web page or email for deletion requests. Add the URL in the Data safety form.
7. Privacy policy URL: host the privacy text (the in-app notice plus the backup and retention rules from `server/README.md`) on a public page.
8. Fill in Apple privacy labels and the Play Data safety form: email, name, photos, user content, user id; used for app functionality; not sold; deletion available.
9. First EAS build: `eas build --profile preview`; send the SHA-1 to the Maps key step above.

## 6. Legal review

1. Give a lawyer the in-app privacy notice (`src/context/LocalizationContext.tsx`, keys `onboarding.privacy*`, ro and en) and `server/README.md`, "Backups" and "Account deletion".
2. Ask specifically about: GDPR basis and retention (30 days in backups), the 18+ self-declaration as age verification, alcohol advertising rules in Romania for user posts, Terms of Use (none exist yet), and data processors (Google/Firebase; OpenAI if AI is turned on).
3. Ask for a Terms of Use text and a hosted privacy policy based on the notice.
4. Register as a data controller where required, and keep a record of processing.
