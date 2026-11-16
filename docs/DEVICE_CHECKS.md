# Device check results (JOHN_TODO section 1 and 2)

Android emulator (DrinkMe_Pixel8, Android 15, Expo Go 54) against the development server and Firebase project drinkmeapp-a8fea, scripted with `scripts/adb-ui.mjs`, `npm run testusers:*` and `npm run testapi`. Test users only; all deleted after each run. PASS = matched the expected result; NEEDS-JOHN = needs a real phone, Google/Apple sign-in, a console, or a second physical device.

## 1a. Sign-in
| # | Result | Date | Evidence / note |
|---|---|---|---|
| 1 | PASS | 2026-11-14 | sign-in screen first, no feed |
| 2 | PASS | 2026-11-14 | sign-up → 18+ gate → privacy notice → name → Home |
| 3 | PASS (gate) / NEEDS-JOHN (Log out, Delete from the gate) | 2026-11-14 | gate shows only "I am 18 or older", Log out, Delete account; the two alternatives were not tapped |
| 4 | PASS | 2026-11-14 | signing in again goes straight to Home |
| 5 | PASS | 2026-11-16 | wrong password and unknown email both "Email or password is incorrect." |
| 6 | PASS | 2026-11-16 | invalid email / short password: validation messages, no network call |
| 7, 8, 20 | NEEDS-JOHN | | Google sign-in needs a development build (docs/DEVICE_TEST_SESSION.md section G) |
| 9 | NEEDS-JOHN | | Apple sign-in needs the Apple Developer account |
| 10 | PASS | 2026-11-14 | reopening the app keeps the session |
| 11 | NEEDS-JOHN | | backend off → session error screen; not run (would stop the shared session) |
| 12 | PASS | 2026-11-14 | switching accounts showed only the new account's data |
| 13 | PASS | 2026-11-14 | in-app deletion; user gone from Firebase |
| 14 | PASS | 2026-11-14 | neutral reset confirmation |
| 15 | PASS | 2026-11-16 | same confirmation for an email without an account |
| 16 | PASS | 2026-11-16 | cooldown "Send again in 45s" |
| 17 | PASS (invalid email) / NEEDS-JOHN (airplane mode) | 2026-11-16 | format message, no wait |
| 18 | PASS | 2026-11-16 | reset through the reset link (`testapi reset-password`), new password signs in (server tests: old sessions end) |
| 19 | PASS | 2026-11-16 | "An account with this email already exists…" |
| 21 | PARTLY | 2026-11-14 | labels present in uiautomator dumps (buttons, fields, links have ro/en descriptions); a TalkBack/VoiceOver pass is John's |
| 22 | PASS | 2026-11-14 | keyboard Send/Go submits (forgot password, sign-in) |
| 23 | NEEDS-JOHN | | two phones; server behaviour covered by password-reset-session tests |

## 1b. Lists and images
| # | Result | Date | Evidence / note |
|---|---|---|---|
| 1, 2 | PASS | 2026-11-14 | post with a gallery photo, image shown on Home, Profile, detail (camera flow: virtual scene only) |
| 3 | PASS (server) | 2026-11-16 | 12 MP avatar (36 MB) refused: 413 "Payload too large"; the app's message for it not seen on screen |
| 4 | NEEDS-JOHN | | needs a real geotagged phone photo |
| 5 | PARTLY | 2026-11-16 | 20 items per page with nextCursor; a 21st post could not be made the same day (20 posts/day limit); pagination covered by server tests |
| 6 | PASS | 2026-11-14 | user search shows names, never emails |
| 7 | PASS | 2026-11-14 / 2026-11-16 | comment appears (app) and is deleted (API 204, list empty) |
| 8 | PASS | 2026-11-14 | cheer and save, Saved list; detail shows the state since 75d1097 |
| 9 | PASS | 2026-11-14 | partner request and accept |
| 10 | PASS (reports) / covered by tests (hide) | 2026-11-14 | 3 reports from new accounts do not hide (48 h rule, as designed) |
| 11 | PASS | 2026-11-14 | block hides content both ways |
| 12, 13 | PASS | 2026-11-14 | Romanian on Profile, posts, dates; full screen-by-screen sweep not done |
| 14 | NEEDS-JOHN | | needs posts older than 7 days |
| 15 | PARTLY | 2026-11-14 | icon-only buttons have ro/en descriptions in dumps (Cheers, Comment, Save, Post options, Close, Back, Activity) |

## 1c. Moderation as admin (temporary admin test user, session-only ADMIN_USER_IDS)
| # | Result | Date | Evidence |
|---|---|---|---|
| 1 | PASS | 2026-11-16 | queue with ageHours, overdue, openReporterCount, autoHideReporterCount, autoHidden, overdueCount |
| 2 | PASS | 2026-11-16 | non-admin 403 |
| 3 | PASS | 2026-11-16 | dismiss 200, again 409 |
| 4 | PASS | 2026-11-16 | remove_content + suspend: removed, suspension applied |
| 5 | PASS | 2026-11-16 | suspended: post, comment, partner request, profile edit, report all 403 account_suspended; reading and cheers work |
| 6 | PASS | 2026-11-16 | already suspended → 409 already_suspended |
| 7 | PASS | 2026-11-16 | unsuspend with void |
| 8 | PASS | 2026-11-16 | own uid → 403 cannot_suspend_admin |

## 2. Email verification (`REQUIRE_VERIFIED_EMAIL=true`, separate development server, temporary database)
| # | Result | Date | Evidence |
|---|---|---|---|
| 1 | NEEDS-JOHN | | console: account linking setting |
| 2 | PASS | 2026-11-16 | no "auth_time is ahead" warning |
| 3 | PASS (server) | 2026-11-16 | unverified sign-in → 403 email_not_verified (the Verify Email screen itself not shown on a device) |
| 4 | NEEDS-JOHN | | Resend email + cooldown (app button) |
| 5 | PASS (server) | 2026-11-16 | "I verified" before the link → still 403 |
| 6 | PASS | 2026-11-16 | after the verification link: sign-in works, next is the age gate (age_required) |
| 7 | PASS | 2026-11-14 | session survives a restart (flag off) |
| 8 | NEEDS-JOHN | | Google takeover test |
| 9 | PASS | 2026-11-16 | disabled user cannot sign in (USER_DISABLED) |
| 10 | PASS | 2026-11-16 | delete from the Verify Email screen: 200, user gone from Firebase |
| 11 | NEEDS-JOHN | | decide and set the flag on the hosted server |
