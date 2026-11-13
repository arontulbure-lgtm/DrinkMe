# iPhone test session with Expo Go

For John. How to run DrinkMe on your iPhone from this PC over Wi-Fi, with every error captured, and then get a fix list.

What happens: one command starts the API server and Expo. The app on your phone sends its errors, failed requests, screen changes and your notes back to the PC (development builds only). Everything is saved in `logs/sessions/<date-time>/`, and new problems are printed live in the terminal.

## 1. One-time setup

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
New-NetFirewallRule -DisplayName "DrinkMe Metro (8081)" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow -Profile Private
```

If Windows ever shows "Windows Defender Firewall has blocked some features of Node.js", allow it on **Private** networks only.
To remove the rules later: `Remove-NetFirewallRule -DisplayName "DrinkMe API (5000)"` (and the same for Metro).

### 1c. Expo Go on the iPhone
- Install **Expo Go** from the App Store.
- **Check the SDK first.** Expo Go on iOS runs only the newest Expo SDK, and the App Store has no older versions. DrinkMe is on **SDK 54** (we decided not to upgrade). If Expo Go says the project is incompatible, or asks for a newer SDK, Expo Go cannot be used. Tell Claude Code; the alternative is a development build (needs the Apple Developer account, see `docs/JOHN_TODO.md` section 5).
- The first time, iOS asks whether Expo Go may "find and connect to devices on your local network". Tap **Allow**. If you tapped "Don't Allow": iPhone Settings → Privacy & Security → Local Network → turn on Expo Go.

### 1d. Config files (you, not Claude Code)
- `server/.env` must contain `NODE_ENV=development` and `FIREBASE_SERVICE_ACCOUNT_KEY=./serviceAccount.json`, with the key file at `server/serviceAccount.json`.
- `.env` in the project root must have the six `EXPO_PUBLIC_FIREBASE_*` values.
- You do not need to change `EXPO_PUBLIC_API_URL`: the session command sets it to the PC's current Wi-Fi address for this run only.

## 2. Run a session

```powershell
cd D:\DrinkMeApp\DrinkMeFinal
npm run test:ios
```

1. **Preflight.** A list of ✓/✗ checks: Node version, ports 5000 and 8081 free, `server/.env` with `NODE_ENV=development`, the Firebase service account, the `EXPO_PUBLIC_FIREBASE_*` names, and the PC's Wi-Fi address. No secret is ever printed. Fix any ✗ (each has a hint) and run it again. `npm run test:ios -- --preflight` runs only the checks.
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
| `server.log` | API server output with times |
| `client.jsonl` | from the app: errors, crashes, warnings, failed requests (method, path, status, duration; never bodies or tokens), screen changes, your notes. Emails, tokens and keys are removed before saving. |
| `metro.log` | only with `--capture-metro` |
| `live-issues.txt` | what the watcher printed |
| `session.json` | time, IP, branch and commit |

## 3. What Expo Go cannot test
- **Google sign-in.** The button is disabled in Expo Go on purpose: Google does not accept Expo Go's `exp://` return address. It needs a development build.
- **Sign in with Apple.** Very likely not testable. It is not enabled in Firebase (needs the $99 Apple Developer account), and in Expo Go the sign-in would be issued for Expo Go's app ID, not DrinkMe's.
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

## 5. Setting up the official DrinkMe account
Do this during a session, with the email/password flow:
1. In the app, sign up with **drinkmesocialapp@gmail.com**, confirm 18+, accept the privacy notice, and **skip** the name prompt.
2. In the Firebase console → Authentication → Users, copy that account's **User UID**.
3. Stop the session (Ctrl+C). In `server/.env`, set `OFFICIAL_USER_IDS=<that uid>`. Never also put this uid in `ADMIN_USER_IDS` (an official account that is also an admin could no longer be suspended).
4. Start `npm run test:ios` again. Check the server output for `[official]` warnings, and for any older account that already uses the brand name; clear those names first.
5. In the app (signed in as the official account), Edit Profile → set the name **DrinkMe**. Posts and the profile now show the Official badge.
6. No brand-partner post before the "Paid partnership" label exists (`docs/legal/CODE_GAPS_PLAN.md`, T-13/T-14).

## 6. After the session
Ask Claude Code: **"Run the log-triage agent on the latest test session."**
It reads the newest `logs/sessions/` folder and writes `reports/test-sessions/<date-time>.md`: a ranked table of problems (crash, error, warning, failed request, visual) with the screen, the steps before it and the source file, plus a fix list with one task per problem. Then ask Claude Code to fix the items you choose.
