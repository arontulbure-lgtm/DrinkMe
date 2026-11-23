# Device test sessions: Android emulator and iPhone

For John. How to run DrinkMe in Expo Go, on the Android emulator on this PC or on your iPhone over Wi-Fi, with every error captured, and then get a fix list.

What happens: one command starts the API server and Expo. The app sends its errors, failed requests, screen changes and your notes back to the PC (development builds only). Everything is saved in `logs/sessions/<date-time>/`, and new problems are printed live in the terminal. The checklist (section 4), the official account (section 5) and the triage (section 6) are the same on both.

| | Android emulator (section A) | iPhone (sections 1 to 2) |
|---|---|---|
| Command | `npm run test:android` | `npm run test:ios` |
| Expo Go | installed automatically (SDK 58) | App Store **Expo Go 58.x** (58.0.5 or later; runs only SDK 58, see 1c) |
| Network | inside this PC, nothing to set up | same Wi-Fi + firewall rules |

## A. Android emulator on this PC

### A1. What is installed (2026-11-13)
- **JDK 17** (Microsoft OpenJDK, `C:\Program Files\Microsoft\jdk-17…`, `JAVA_HOME` set by its installer). The old Java 8 is still there and still first on PATH; the Android tools use `JAVA_HOME`.
- **Android SDK** in `%LOCALAPPDATA%\Android\Sdk`: command-line tools, platform-tools (`adb`), the emulator, Android 15 (API 35) and the Google Play x86_64 system image. Only the Android SDK License Agreement was accepted.
- User environment: `ANDROID_HOME` and PATH entries for `platform-tools`, `emulator` and `cmdline-tools\latest\bin`. **Open a new terminal** for them to apply.
- **Emulator `DrinkMe_Pixel8`**: Pixel 8 screen, 4 GB RAM, 8 GB storage, hardware keyboard on, Google Play. It uses Windows' hypervisor (WHPX), which works here because Hyper-V is on; nothing else to enable.
- No Android Studio is needed. To remove everything later: delete `%LOCALAPPDATA%\Android`, `%USERPROFILE%\.android`, uninstall "Microsoft Build of OpenJDK 17" and remove the two user environment entries.

### A2. Run a session
```powershell
cd D:\DrinkMeApp\DrinkMeFinal
npm run emulator        # starts DrinkMe_Pixel8 in its own window and waits until Android has booted (about 1.5 min)
npm run test:android    # preflight, API server, Expo; installs Expo Go on the emulator and opens the app
```
- `npm run test:android` also offers to start the emulator if none is running.
- The preflight checks `adb`, the emulator and a booted device too. Metro uses port 8081 or the next free one: Docker holds 8081 on this PC, so you will usually see 8082 or 8083. That is fine.
- The script checks that the emulator reaches the API at the PC's Wi-Fi address. If it can't, it uses `http://10.0.2.2:5000` (the emulator's own name for this PC) and says so.
- The first start downloads and installs Expo Go (SDK 58) on the emulator, then builds the app (a minute or two). Later starts are faster.
- Leave the emulator window open between sessions; `npm run test:android` reuses it. Close it like a window when you are done for the day.
- Ctrl+C stops the server and Expo (the emulator keeps running). `npm run test:android -- --capture-metro` also saves Metro's output to `metro.log`.

### A3. Using the emulator
- **Typing:** click a field and type on the PC keyboard (hardware keyboard is on). The on-screen keyboard still opens and covers the lower half, as on a phone; Esc or the ⌄ key closes it. Paste: copy on the PC, then Ctrl+V in a field (the clipboard is shared).
- **First open:** Expo Go shows its own "developer menu" introduction sheet over the app; tap **Continue**, then the **X** on the menu. It can come back after Expo Go restarts.
- **Back:** Esc, or the ◁ button in the emulator's side toolbar. **Home:** the ○ button.
- **Dev menu** (reload, debugger): Ctrl+M in the emulator window, or `adb shell input keyevent 82`. **Reload:** press `r` twice quickly (RR) in the emulator window.
- **Test photos:** drag JPG/PNG files from Explorer onto the emulator window; they land in the Download folder and appear in the photo picker (Create Post → gallery). Or from a terminal: `adb push C:\path\photo.jpg /sdcard/Pictures/` then `adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/photo.jpg`.
- **Camera:** the emulator camera shows a virtual room you can move in (hold Alt and use WASD/mouse). Good enough to test the camera flow; use dragged photos for real images.
- **Screenshot into the session folder:** `adb exec-out screencap -p > logs\sessions\<date-time>\screen-1.png` (from Git Bash; in PowerShell use `cmd /c "adb exec-out screencap -p > logs\sessions\<date-time>\screen-1.png"`). The log-triage agent looks at PNGs in the folder.
- **Rotate:** Ctrl+Left/Right. **Location** for the location picker: emulator toolbar → ⋯ → Location.
- What the emulator cannot tell you: real performance, real camera quality, push notifications, Google sign-in (disabled in Expo Go, section 3).

## 1. iPhone one-time setup

### 1a. Same Wi-Fi
- The PC and the iPhone must be on the **same Wi-Fi network**. A guest network or "client isolation" (common in offices and hotels) blocks phone-to-PC traffic; use your home network or a phone hotspot with the PC connected to it.
- Turn off any VPN on the PC and on the phone during the session.

### 1b. Windows firewall (PowerShell **as administrator**, once)
Right-click Start → "Terminal (Admin)" or "Windows PowerShell (Admin)", then:

```powershell
# Your Wi-Fi network must be "Private"; rules below apply only to Private networks.
Get-NetConnectionProfile
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private   # only if it shows Public

New-NetFirewallRule -DisplayName "DrinkMe API (5000)"  -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "DrinkMe Metro (8081-8090)" -Direction Inbound -Protocol TCP -LocalPort 8081-8090 -Action Allow -Profile Private
```

(Metro moves to 8082 or higher when 8081 is taken, as Docker does on this PC. If you already made a rule for 8081 only, add this one too.)

If Windows ever shows "Windows Defender Firewall has blocked some features of Node.js", allow it on **Private** networks only.
To remove the rules later: `Remove-NetFirewallRule -DisplayName "DrinkMe API (5000)"` (and the same for Metro).

### 1c. Expo Go on the iPhone
- Install **Expo Go** from the App Store.
- **DrinkMe is on Expo SDK 58 (since 2026-11-23), the SDK the App Store Expo Go 58.x runs.** Expo Go supports only the newest SDK, so keep it updated in the App Store; an older Expo Go refuses the project. The preflight checks that the project is on SDK 58.
- **If Expo Go hangs on launch** ("Opening project…", "Could not connect" or a white screen that never loads, while Safari reaches `/healthz`): the router's DNS is a known cause, and the usual fix on this network. iPhone Settings → Wi-Fi → (i) next to your network → Configure DNS → Manual → remove the entries, add `1.1.1.1` and `8.8.8.8` → Save, then reopen Expo Go. Switch back to Automatic after testing if you like.
- The first time, iOS asks whether Expo Go may "find and connect to devices on your local network". Tap **Allow**. If you tapped "Don't Allow": iPhone Settings → Privacy & Security → Local Network → turn on Expo Go.

### 1d. Config files (you, not Claude Code)
- `server/.env` must contain `NODE_ENV=development` and `FIREBASE_SERVICE_ACCOUNT_KEY=./serviceAccount.json`, with the key file at `server/serviceAccount.json`.
- `.env` in the project root must have the six `EXPO_PUBLIC_FIREBASE_*` values.
- You do not need to change `EXPO_PUBLIC_API_URL`: the session command sets it to the PC's current Wi-Fi address for this run only.
- **Keep other secrets out of the root `.env`.** Expo loads every name in it into Metro, and only `EXPO_PUBLIC_` names reach the app. A key that belongs to something else (for example `ANTHROPIC_API_KEY`) should live in your user environment or a password manager instead. The session preflight shows a yellow **!** with the names (never values) when it finds one. Server secrets go in `server/.env`.

## 2. Run an iPhone session

Use PowerShell (not cmd.exe, where Ctrl+C asks "Terminate batch job (Y/N)?" over the summary):

```powershell
cd D:\DrinkMeApp\DrinkMeFinal
npm run test:ios
```

1. **Preflight.** A list of ✓/✗ checks: Node version (Expo SDK 58 needs 22.13+, 24.3+ or 26+), the project's Expo SDK (58, for the App Store Expo Go), port 5000 and a Metro port (8081 or the next free one), `server/.env` with `NODE_ENV=development`, the Firebase service account, the `EXPO_PUBLIC_FIREBASE_*` names, and the PC's Wi-Fi address. Three yellow reminders follow for the iPhone (things the PC cannot check): Expo Go 58.x on the same Wi-Fi, the firewall rule for TCP 5000 and 8081-8090 (section 1b, with the command), and the DNS fix (section 1c). No secret is ever printed. Fix any ✗ (each has a hint) and run it again. `npm run test:ios -- --preflight` runs only the checks.
2. **Quick network test.** On the iPhone, open Safari at `http://<the IP shown>:5000/healthz`. You should see `{"status":"ok"}`. If the page never loads, the firewall or the Wi-Fi is the problem (section 1).
3. **Scan the QR code** that Expo prints with the iPhone **Camera** app and tap the banner. It opens in Expo Go. The first load builds the app and takes a minute.
4. **Test.** Use the checklist in section 3. While you test, the terminal shows lines like:
   - `NEW ISSUE #3 [app] failed request: POST /api/drinks → 500 (CreatePost)`: a new kind of problem, printed once (repeats are counted, not reprinted).
   - `NOTE #1 (Home): …`: a note you typed.
5. **Notes.** A small purple **📝 Note** button floats at the bottom left (development builds only). Tap it whenever something looks wrong (layout, wrong text, slow screen) and describe it in a few words. The note is saved with the screen and time. Don't type passwords or personal data in notes.
6. **Stop** with **Ctrl+C** in the terminal. Server and Expo stop and the session folder path is printed.

Expo's keys keep working during the session: `r` reloads the app, `j` opens the debugger, `?` lists the rest. Shaking the phone opens the dev menu.

**Optional: `npm run test:ios -- --capture-metro`.** This also saves Metro's own output (bundling errors such as "Unable to resolve module") to `metro.log`. Expo then cannot draw its QR code or use its keys, so the script prints the QR code itself. Use this mode if the app fails to load at all, because nothing reaches the app log until the app starts.

If the PC has several network adapters and the wrong IP is picked: `npm run test:ios -- --ip 192.168.0.115`.

### What is saved (`logs/sessions/<date-time>/`, never committed)
| File | Content |
|---|---|
| `server.log` | API server output with times (emails, tokens and keys removed) |
| `client.jsonl` | from the app: errors, crashes, warnings, failed requests (method, path, status, duration; never bodies or tokens), screen changes, your notes. Emails, tokens and keys are removed before saving. |
| `metro.log` | only with `--capture-metro` |
| `live-issues.txt` | what the watcher printed |
| `session.json` | platform (ios or android), emulator, time, IP, API URL, Metro port, branch and commit |
| `*.png` | screenshots you save there (see A3) |

Logs and triage reports (`reports/test-sessions/`) stay on this PC and are never committed. They can still hold test account names and what you typed, so use throwaway test accounts, and delete a session folder and its report once its issues are fixed (at the latest after 30 days).

The app log route (`/__dev/client-log`) is switched on only while `npm run test:ios` or `npm run test:android` runs. A server started by hand (`node server.js`) does not have it. Anyone on the same Wi-Fi could write fake entries into the log during a session, so test on a network you trust.

## 3. What Expo Go cannot test
- **Google sign-in.** The button is disabled in Expo Go on purpose: Google does not accept Expo Go's `exp://` return address. It needs a development build.
- **Sign in with Apple.** Very likely not testable in Expo Go: the sign-in would be issued for Expo Go's app ID, not DrinkMe's (the app now sends a nonce; test it in a development or TestFlight build once Apple is enabled in Firebase).
- **Push notifications.** DrinkMe does not send push notifications yet, and Expo Go cannot show the real app's push setup anyway.
- Anything that depends on the real app ID or a native build: the app icon, the splash screen, the permission texts of a store build, deep links into `drinkme://`.

Use **email and password** accounts for everything below.

## 4. First-run checklist (email and password)
Adapted from `docs/JOHN_TODO.md` section 1. Write a 📝 note at each step whose result differs from "Expected". You need two email accounts you can read (for example two Gmail addresses, or one with `+test` added: `you+test@gmail.com`).

### 4a. Sign-in
| # | Steps | Expected |
|---|---|---|
| 1 | Open the app for the first time | Sign-in screen; no feed visible before signing in. |
| 2 | Sign up with a new email and a valid password | Age gate (18+), then the privacy notice, then the name prompt; then Home loads with no error. |
| 3 | At the age gate, look for a way past it without confirming | None: only "I am 18 or older", Log out and Delete account. |
| 4 | Sign out, sign in again with the same email and password | Straight to Home; gate, notice and name are not asked again. |
| 5 | Sign in with a wrong password, then with an email that has no account | Both: the same "Email or password is incorrect" (ro/en), never Firebase's English text. |
| 6 | Sign up with an invalid email or a too-short password | A validation message before any network call. |
| 7 | Kill Expo Go (swipe up) while signed in, reopen the project | Still signed in, Home loads. |
| 8 | Stop the session (Ctrl+C), reopen the app, then start the session again and tap Retry | Session error screen with Retry while the server is off, not an empty feed; Retry works after the restart. (Start a new session afterwards; this one ended.) |
| 9 | Sign out as A, sign in as B | B never sees A's feed, profile or notifications, not even for a moment. |
| 10 | "Forgot password?" with a real account's email, tap Send | Neutral confirmation; the reset email arrives in the app's language. |
| 11 | The same with an email that has no account | Exactly the same confirmation. |
| 12 | Tap Send again at once | The button waits about 60 s and shows the time left. |
| 13 | Forgot password with an invalid email, then with airplane mode on | Format message without a wait; network message, retry possible at once. |
| 14 | Complete the reset from the email, sign in with the new password | Works; the old password gets the step 5 message. |
| 15 | With A signed in on the phone, reset A's password from the email on the PC, then pull to refresh on the phone | The phone is signed out on its next request (a password reset now ends the older sessions). If it keeps working, note it. |
| 16 | Sign up with an email that already has an account | "Email already in use" (accepted). |
| 17 | VoiceOver on the sign-in screen and in forgot-password mode | Every field, link and button is read with a ro/en label. |
| 18 | Delete account (Profile → Settings) | Confirmation, then signed out; signing in again says the account was deleted. Do this last, with a throwaway account. |

### 4b. Lists, posts and images
| # | Steps | Expected |
|---|---|---|
| 1 | Post a drink with a camera photo (alcoholic on) | Upload works; the post shows on Home and Profile with the image. |
| 2 | Post a non-alcoholic drink with a gallery photo | Same, with the right "non-alcoholic" label. |
| 3 | Set a 12 MP photo as avatar | Uploads, or a clear "image too large"; no crash. |
| 4 | Scroll Home past 20 posts | "Load more" works without duplicates. |
| 5 | Explore: search a user (2+ letters), open the profile | Names only, never email addresses. |
| 6 | Open a post, add a comment, delete it | Appears, disappears, count updates. |
| 7 | Cheer and save a post, check Profile → Saved | Saved shows it; unsaving removes it. |
| 8 | Partner request A → B, accept on B (sign in as B on the same phone, or a second phone) | Both are partners; A's partner feed shows B's posts. |
| 9 | Block a user | Their content disappears both ways; unblocking restores it. |
| 10 | Switch the language to Romanian and go through every tab, Create Post, Smart Bar, the location picker and Edit Profile | No English left, apart from names and post text people typed. |
| 11 | VoiceOver over the icon-only buttons (cheer, save, comment, post menu, close, back, bell) | Each read with a ro/en name as a button. |

Moderation as admin (`docs/JOHN_TODO.md` section 1c) uses curl from the PC and can run in the same session.

## F. Firebase project
**The app's project is `drinkmeapp-a8fea`** (owner decision 2026-11-14). The older project `drinkme-b2269`, named in `CLAUDE.md` and older docs, is no longer used. Every session preflight prints a line `Firebase project: <id> (app and server)`, or a ✗ with both ids when the app and the server point to different projects.

**Users and UIDs:** <https://console.firebase.google.com/project/drinkmeapp-a8fea/authentication/users> (in general `console.firebase.google.com/project/<project-id>/authentication/users`). The "User UID" column is what `official:set` and `ADMIN_USER_IDS` need. Sign-in methods: `…/authentication/providers`. Project settings (web config, service accounts): `…/settings/general` and `…/settings/serviceaccounts/adminsdk`.

### F1. Switching the app and server to the project (once)
1. Firebase console → Project settings (gear) → **Your apps** → the Web app (create one if none: "</>" button, no hosting) → **SDK setup and configuration** → **Config**. Copy the `firebaseConfig = { … }` block into a file **`D:\DrinkMeApp\DrinkMeFinal\firebase-web-config.json`**. Either JSON or the pasted JavaScript block works; `measurementId` is ignored.
2. Project settings → **Service accounts** → **Generate new private key**. Save it as **`D:\DrinkMeApp\DrinkMeFinal\server\serviceAccount-drinkmeapp-a8fea.json`** (or anywhere outside the project folder).
3. Stop any running session, then:
   ```powershell
   cd D:\DrinkMeApp\DrinkMeFinal
   npm run firebase:configure -- firebase-web-config.json server\serviceAccount-drinkmeapp-a8fea.json
   ```
   It sets only the six `EXPO_PUBLIC_FIREBASE_*` lines in `.env` and the `FIREBASE_SERVICE_ACCOUNT_KEY` line in `server/.env` (to that file's path). It keeps a copy of each old file (`.env.before-firebase-<time>`), and prints only the two project ids and **MATCH**. It refuses, changing nothing, if the two files come from different projects or if a file inside the project folder would not be git-ignored. Both file names above are git-ignored, as are `server/serviceAccount*.json` and `*firebase-adminsdk*.json`.
4. `npm run official:check` → `drinkmeapp-a8fea` twice and **MATCH**.
5. Start a session. Sign up again in the app: accounts of the old project do not exist in the new one.

### F2. Old development data
`server/data/db.json` still holds users, posts and comments of `drinkme-b2269` accounts (on 2026-11-13: 2 users, 1 post). Those uids never sign in again, so that data is orphaned. Nothing reads it for the new accounts, apart from showing the old posts in feeds and search. Two options, both yours to run:
- **Keep it** (default): old test posts stay visible under their old names. Harmless for development; it never reaches production, which gets its own database (`docs/JOHN_TODO.md` section 4).
- **Start empty:** stop every session, then rename `server\data\db.json` to `db.json.old-project` in Explorer; the next server start creates an empty database. Renaming instead of deleting keeps it recoverable. Claude Code does not touch `server/data/`. Ask for a `dev:reset-db` command if you want this as one step with checks.

## G. Google sign-in setup
**State on 2026-11-14:** the Google provider is enabled in Firebase (`drinkmeapp-a8fea`). In Expo Go the button is disabled on purpose ("not available in Expo Go"), and that is correct: Expo Go cannot receive Google's answer for DrinkMe.

**The current code will not work in a development build either.** `AuthScreen.tsx` signs in through the browser with only the *Web* client ID and the return address `drinkme://`. Google accepts only https (or localhost) return addresses for a Web client, and swapping the code for tokens needs that client's secret, which must never ship in an app. So a development build would show a Google "redirect_uri_mismatch" or "invalid request" error. The fix needs your decision before code changes:
- **Recommended:** native Google sign-in with `@react-native-google-signin/google-signin` (free edition; Expo config plugin; works in development and store builds, not in Expo Go). It returns an ID token that goes to Firebase as `GoogleAuthProvider.credential(idToken)`, so the server side is unchanged. New dependency: needs your OK.
- Alternative without a new dependency: `expo-auth-session/providers/google` with separate Android and iOS client IDs. Google has turned custom return addresses off by default for new Android clients, so this is the more fragile path.

**Client IDs needed (all from project `drinkmeapp-a8fea`):**

| Client | Where it comes from | What it needs | Where it goes |
|---|---|---|---|
| **Web client ID** | Firebase → Authentication → Sign-in method → Google → **Web SDK configuration** → "Web client ID" (the same client shows in Google Cloud → APIs & Services → Credentials as "Web client (auto created by Google Service)") | nothing; created when Google was enabled | `.env`: `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (already read by `app.config.ts` → `extra.googleWebClientId`). **The current value belongs to the old project (`476694000030-…`); replace it.** It is the audience Firebase accepts for ID tokens. |
| **Android client** | Google Cloud console (project drinkmeapp-a8fea) → APIs & Services → Credentials → Create credentials → OAuth client ID → **Android** | package `com.aroncarola.drinkmefinal` + the **SHA-1** of the signing key: debug builds on this PC `keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -alias androiddebugkey -storepass android -keypass android` (needs a JDK, installed); EAS builds `eas credentials` → Android → SHA-1; Play Store later: Play Console → App integrity → App signing SHA-1 (one client or fingerprint each) | With the native library: nothing in code (Google matches package + SHA-1). With expo-auth-session: `.env` `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`. Also add the SHA-1 to the Android app in Firebase → Project settings → Your apps (add an Android app with that package if missing) |
| **iOS client** | Same page → OAuth client ID → **iOS** | bundle ID `com.aroncarola.drinkmefinal` | `.env` `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`; its "iOS URL scheme" (`com.googleusercontent.apps.…`) goes into `app.config.ts` (`iosUrlScheme` of the library's plugin). Needs the Apple Developer account for a device build anyway. |

Google Cloud also asks for the **OAuth consent screen** (app name, support email, privacy policy URL) before others than the test users can sign in. The privacy policy URL depends on where the legal pages are hosted (D-06, `docs/legal/OPEN_DECISIONS.md`).

## 5. Setting up the official DrinkMe account
Do this during a session (the emulator is easiest), with the email/password flow, after section F. The three `official:` commands read your `.env` files but print only what is shown below, never a key or any other line.

1. **Sign up in the app** with **drinkmesocialapp@gmail.com**: confirm 18+, accept the privacy notice, and **skip** the name prompt ("Later"). A name with "DrinkMe" in it is refused until step 5 (`name_reserved`); that is expected.
2. In a second PowerShell window (the session keeps running):
   ```powershell
   cd D:\DrinkMeApp\DrinkMeFinal
   npm run official:check
   ```
   It prints the Firebase project of the app (`EXPO_PUBLIC_FIREBASE_PROJECT_ID` in `.env`) and of the server's service account, then **MATCH** or **MISMATCH**. Both should be **drinkmeapp-a8fea**. On MISMATCH stop here: sign-in cannot work until `.env` and the service account point to the same project.
3. Find the account's uid:
   ```powershell
   npm run official:find -- drinkmesocialapp@gmail.com
   ```
   It prints `uid`, `email`, `created` and the next command, or "not found – sign up in the app first".
4. Make it official:
   ```powershell
   npm run official:set -- <the uid from step 3>
   ```
   It sets the `OFFICIAL_USER_IDS=<uid>` line in `server/.env` (adds it if missing; replaces an existing value, so it holds only this uid) and changes nothing else in the file. It refuses if that uid is also in `ADMIN_USER_IDS`, because an official account that is also an admin could no longer be suspended.
5. **Restart the session:** Ctrl+C in the session window, then `npm run test:android` (or `test:ios`). The server reads `OFFICIAL_USER_IDS` only at start. Check its output for `[official]` warnings (an official uid that is also an admin, or one that matches no user). Before the account posts, check for older accounts that already use the brand name and clear those names.
6. In the app, signed in as the official account: Profile → Edit Profile → name **DrinkMe** → Save. It is accepted now.
7. **Check the badge:** the profile header and your posts and comments show **Official** (Romanian: **Oficial**) next to the name. Sign in as another account (or look from another device): the badge shows there too, and that account still cannot take the name "DrinkMe".
8. No brand-partner post before the "Paid partnership" label exists (`docs/legal/CODE_GAPS_PLAN.md`, T-13/T-14).

## 6. After the session
Ask Claude Code: **"Run the log-triage agent on the latest test session."**
It reads the newest `logs/sessions/` folder and writes `reports/test-sessions/<date-time>.md`: a ranked table of problems (crash, error, warning, failed request, visual) with the screen, the steps before it and the source file, plus a fix list with one task per problem. Then ask Claude Code to fix the items you choose.

## 7. Scripted tests on the emulator (for Claude Code)
Used for the automated retest of 2026-11-14; you can run the same pieces by hand.
- `npm run testusers:create` makes test1..test3@drinkme.test in `drinkmeapp-a8fea`, with random passwords that are saved only in `logs/testusers.local.json` (git-ignored, never printed). `npm run testusers:reset` sets those passwords again. `npm run testusers:delete` deletes them, plus any `drinkmesocialapp+e2e…@gmail.com` account made by an automated sign-up, and never any other account. Their data on the development server stays until deleted in the app.
- `node scripts/adb-ui.mjs dump | tap "<text>" | type "<text>" | typepw <email> | swipe up | wait "<text>" | shot <file>` drives the app over adb (uiautomator). In Git Bash set `MSYS_NO_PATHCONV=1` before passing `/regex/` patterns.
- `npm run firebase:auth-check` prints the project's Auth settings (Email/Password, enumeration protection, password policy, authorized domains, email sender) without any key; `-- --enable-enumeration-protection` turns that protection on if it is off.
- An in-app sign-up must use an allowed email domain (gmail.com, outlook.com, …; see `AuthScreen.tsx`). Automated runs use `drinkmesocialapp+e2e…@gmail.com`, which lands in the official mailbox.
- Known limit: auto-hide after 3 reports cannot be shown with fresh accounts (reporters must be 48 h old); the server tests cover it.
