# Autonomous run log: 2026-10-30

Branch: `auto/run-2026-10-30` (nothing committed or pushed; review with `git diff main`).

## Summary for John
**Status: finished on 2026-11-10, as instructed: T1-7, T1-8, T1-11, then Tier 2. Tiers 1 and 2 and their docs are done. Nothing is committed.**

- **Done:** T1-1 to T1-11; T2-1 to T2-15; Tier 1 and Tier 2 docs. Server tests went from none to 975, all passing on the final code. Typecheck and lint errors are gone.
- **Biggest risk: none of the client work has run on a device,** and the client has no automated tests. Every sign-in passes through rewritten code (T2-9), and lists and images were rewritten (T2-10). Test those first. Real Firebase and OpenAI were never called; only stubs were.
- **Before your next server start:** check `server/.env` has `NODE_ENV=development`. The first start migrates your database once (see Commands for John).
- **Do not turn on yet:** `REQUIRE_VERIFIED_EMAIL` (reviewed and mutation-tested on stubs; still needs a real Firebase test; a takeover stays open while it is off, see T2-7); `AI_ENABLED` (conditions under Decisions).
- **Blocked on you:** multer upgrade and committing the lockfiles; root dependency updates; key rotation; real database, hosting and HTTPS; Docker image never built; store policy checks; legal review of the privacy notice.
- **Decisions waiting for you:** see "Decisions for John before launch": who reviews reports, suspending offenders, logged-out reads, backup retention, email enforcement.
- **External docs are out of date** (`DEPLOY.md`, `SECURITY.md`, `BETA_CHECKLIST.md`, `QA_CHECKLIST.md`, `TECHNICAL_REFERENCE.md` in `D:\DrinkMeApp\`). They were off limits; the corrections are listed under "External docs to correct". Use `server/README.md` meanwhile.
- **Next, your call:** device checks on sign-in, then lists and images; then commit (`git add CLAUDE.md .claude/` too, as they are untracked); then Tiers 3 to 6, which need your instruction.

## Done
- **Task J (T4-3, forgot password; AuthScreen in ro/en): done, committed.** "Forgot password?" in sign-in mode (inline reset mode reusing the email field) calls `sendPasswordResetEmail` (in the app's language) via `AuthContext.sendPasswordReset`. The same neutral confirmation for a real account, an unknown one and a disabled one; neutral messages for invalid email, network and too many requests; a 60 s cooldown (survives remounts, resets on restart) after every outcome except invalid email and network, so a timed-out request cannot lead to a second email. Shared mapper `src/lib/authErrors.ts`: wrong password, unknown email and invalid credential give one "Email or password is incorrect" message; social sign-in never shows that text; cancellations show nothing; raw Firebase text is never shown (the old alerts showed it). Every AuthScreen string is now `auth.*` in ro and en. Accessibility: announcements, labels, 44 px links, email autofill. Reviews: no BLOCKER; one fix loop. Typecheck 0; lint 14 warnings (the Google effect warning is now a documented disable). Pure helpers checked with a scratch script outside the repo (no client test framework yet). Not run on a device; device checks go into `docs/JOHN_TODO.md` in task N.
  - **For John (security review, Firebase Console, not code):** (1) confirm Email enumeration protection is on for drinkme-b2269, or the public API key still lets anyone check which emails exist; (2) set a password policy (8+ characters, uppercase, digit, special) with enforcement, since Firebase's hosted reset page otherwise accepts 6 characters (may need the Identity Platform upgrade); (3) restrict the Firebase web API key to Identity Toolkit and Token Service, and move App Check (SEC-I) before the public launch: the app cooldown is not a security control, and scripted resets could use up the shared email quota; (4) sign-up still says when an email is taken (Firebase does not hide it; accepted). (5) **Now more urgent:** a password reset still does not end the 30-day server JWT, and reset is the recovery path users will reach for after a compromise. Fix when approved: on sign-in, `getUser(uid)` and bump `sessionGen` when `tokensValidAfterTime` is newer than the stored value. (6) Device test for the pre-registration takeover: phone A signs up with an email it does not own; the owner gets "email in use", resets, signs in; phone A must be logged out on its next request.
- **Task H (T6-1, audit log): done, committed.** 8 actions (`ack.age_confirmed`, `ack.privacy_accepted`, `auth.session_revoked`, `account.deletion_requested`, `account.deletion_completed`, `admin.report_resolved` with `resolvedCount`, `admin.user_suspended`, `admin.user_unsuspended`); ids, time and a whitelisted meta only (no IP, email or free text). Kept 90 days, pruned at load and daily. **Lead decision (security review):** two budgets, so users cannot push admin entries out: user entries capped at 15,000 (evicted among themselves), admin entries and completed deletions at 20,000. Entries are rebuilt from the whitelist at load. `GET /api/admin/audit?action=&limit=&before=` (admins, newest first, paged). Exact rollback on a failed save. Account deletion: the user's own entries are **deleted** (lead decision, data minimisation; a deviation from the spec's "anonymised"), admin entries about or by them get the same `deleted-<hex>` id as their open reports; that id is now made once and kept on the pending deletion entry, so a retried cascade keeps reports and audit matching. Privacy notice sentence (ro, en) in the unreleased version 2. Reviews: no BLOCKER; one fix loop. `audit-log.test.js` (21); full run 1165 of 1165; typecheck 0; lint 15 warnings. Each mutation now writes up to about 3 to 4 MB more JSON at the full cap: one more reason for DATA-1.
- **Note on task G:** splitting the shared files between G and H by diff hunks misplaced the notification helpers in 7051e84 (a ReferenceError on `GET /api/notifications`, and a broken types file). The code review caught it; fixed in bb639d5 and verified on a clean checkout (typecheck 0, `notifications-i18n.test.js` 16 of 16).
- **Task G (notifications in ro/en): done, committed (7051e84).** `GET /api/notifications` adds `params` (`actorName`, `drinkName`, `variant` for partner entries) worked out on each read, so renamed or deleted actors and posts show correctly. `drinkName` is only filled for the reader's own post that they may still see (review finding: an id alone must not reveal another post's name); a hidden or blocked actor shows as "Someone". The stored English `message` stays for older app versions and unknown types. Client: `getNotificationText` in Home builds the text from `notifications.*` templates (ro, en); `t()` now replaces placeholders in one pass, so user text such as `$&` or `{{drink}}` in a name is inserted as-is. `notifications-i18n.test.js` (16). Reviews: no BLOCKER; one fix loop (the ownership check).
- **Task F (T4-6, edit post): done, committed.** `PUT /api/drinks/:id`: gate, auth, suspension (403), ownership (404 if blocked or hidden, else 403), 409 `hidden_pending_review` on the owner's auto-hidden post, validation (plain text, rating 0 to 5, boolean flag, category checked against the resulting flag; `category_required` when a flip leaves a mismatched category), growth guard (507), no-op without a save, rollback on failed save. Image not editable, no edit history, no daily cap. **Lead decision on moderation evidence (both reviewers):** owners may still edit reported posts (refusing would reveal a report), but the first edit after an open report stores the reported content as `targetSnapshot` on that report, removed on resolve or account deletion; admins also see `editedAfterReport`, the category and the rating. A deleted post's open report keeps its snapshot until resolved. Client: Edit in the post actions sheet, CreatePost edit mode (prefill from cache, background refresh while the form is untouched, sends only changed fields, per-error ro/en messages), "edited" labels. Reviews: no BLOCKER; one fix loop. `edit-post.test.js` (42); full run 1128 of 1128; typecheck 0; lint 15 warnings. The privacy notice gets one sentence on the snapshot in task N (version 2 still unreleased).
- **Task E (drink categories; Explore filters were always empty): done, committed.** Optional `category` on `POST /api/drinks` (alcoholic: cocktail, wine, beer, spirits; non-alcoholic: mocktail, coffee, tea, other), consistent with `isAlcoholic` or 400, stored as `tags: [category]`; `isAlcoholic` must now be a boolean when sent (400 otherwise). `GET /api/drinks?category=` filters after visibility and before paging; works with discover and trending; `alcoholic=false` plus an alcoholic category is 400. Client: category picker in CreatePost that follows the alcoholic toggle; Explore chips for every category (incl. Other, lead decision) queried on the server, each with its own cache; shared `categories.*` labels (ro, en) in CreatePost, DrinkDetail and Explore; a server test keeps the client and server category lists equal. Old posts (`tags: []`) show only under All and Non-alcoholic. Reviews: no BLOCKER, no security SHOULD-FIX; one fix loop. `categories.test.js` (10); full run 1086 of 1086; typecheck 0; lint 15 warnings.
- **Task D (T4-5, optimistic cheer and save; empty `onCheer` fixed): done, committed.** Server: optional `{ cheered }` / `{ saved }` body sets the state (idempotent; no body still toggles; non-boolean 400); a failed save now rolls back set, count and notification; **one cheer notification per cheerer and post per 7 days** (security review reproduced 12 notifications a second from off/on cycling; the lead chose to de-duplicate). Client: `useDrinkToggles` (with `drinkToggleChains.ts`) replaces five copies; optimistic updates across all cached lists, requests serialized per post via mutation scopes, last-settled-wins rollback, reset together with the query cache, cancelled refetches re-run after the chain settles, Load more never cancelled. Cheer now works on Profile (Posts, Saved) and Smart Bar Saved. Reviews: no BLOCKER; one fix loop (stuck chain after sign-out, mixed-result follow-up, cancelled pagination). `toggles.test.js` (15); full run 1076 of 1076; typecheck 0; lint 15 warnings. Device checks needed: rapid taps, tapping during refresh and Load more, logging out with a request queued.
- **Tasks C and I (T4-4, T4-1, T4-2): done, committed.** Typed navigation (`src/navigation/types.ts`, global `RootParamList`, no `any` on navigation props). Behaviour change accepted by the lead: four buttons that navigated into a tab by name from a stack screen did nothing in React Navigation 7 and now work through `navigate('Main', { screen })` (Scanner from CreatePost and DrinkDetail, own row in PartnersList, own author on UserProfile). ErrorBoundary inside LocalizationProvider, wrapping auth and navigation; "Try again" clears the React Query cache (avoids a crash loop on bad cached data) and remounts; logs error name and component stack only. PartnersList: pull-to-refresh, inline refresh error over cached rows. Code review: no BLOCKER, one fix loop. Typecheck 0, lint 15 warnings. Not run on a device.
- **Tasks A and B (T3-1, T3-3, Windows EPERM): done, committed.**
  - `qa-security.test.js` (9): one test per line of the QA security section. `qa-flows.test.js` (13): closes the server-side gaps from mapping both QA checklists against the API (relogin keeps onboarding state, partner feed, cheers and save persistence, comments seen by others, stories empty, mark read, search by city, trending without own posts, rating bounds, remove partner, empty partner list). No real bug found.
  - The API-vs-QA table is in the developer's report; summary: every server-side flow now maps to a test file. Client-only flows: register validation, session error screen, pull-to-refresh, Places picker, language switch, image picker, performance.
  - Noticed, not changed: a comment over 500 characters gets 400 while long post text is cut (pinned by a test); `D:\DrinkMeApp\QA_CHECKLIST.md` still has an age-gate "Nu" line and the project `QA_CHECKLIST.md` is stale (task N).
  - EPERM: rename and read retry 6 times (25 to 400 ms, at most about 0.8 s, failure path only) with one log line of code and count. Lead review (light): sound; the lead also made the save-failure log print the error code instead of Node's message, which contained paths. The flaky deletion test passed 10 of 10 isolated runs. Full run 1061 of 1061; typecheck 0; lint 15 warnings.
- **Item 6, John's moderation and backup decisions (D2): done, committed (937ccb0).**
  - Admin queue: `GET /api/admin/reports` (oldest first) adds `ageHours`, `overdue` (over 24 h), `openReporterCount`, `autoHideReporterCount`, `autoHidden`, and `overdueCount`. Admins = `ADMIN_USER_IDS`.
  - Auto-hide: 3 distinct open reporters hide a post, comment or profile from everyone but the owner (with a ro/en notice) and admins, with the same 404 as a missing item, on every list, detail, search and `/media` route. It is derived from open reports, so resolving unhides. **Lead decision (Sybil):** a reporter counts only if their account is 48 h old and has accepted the notice; other reports still reach the queue. Legacy users without `createdAt` count as old enough.
  - Suspensions: `POST /api/admin/users/:id/suspend` (`reason`, `permanent`), `/unsuspend` (`void`), and `suspend: true` on resolve. 7 days first, permanent on any later non-voided one. Admins cannot be suspended. A suspended user gets 403 `account_suspended` (with `until`) on posting, comments, partner requests (send and accept), profile and avatar edits and reports; reading, cheers, saves, blocks, deletion and logout still work. A banner on Home and Profile. **Lead decisions:** suspending someone already suspended gives 409 `already_suspended` (both reviewers reproduced a double tap turning into a permanent ban), and escalation needs `permanent: true`; `void` on unsuspend for a mistaken suspension.
  - Backups: in-server copies kept 21 days + 7-day recovery hold, with a hard 30-day ceiling even during the hold; `CORRUPT_BACKUP_RETENTION_DAYS` capped at 21. App text says deleted accounts leave "our backups" within 30 days (ro, en); the privacy notice mentions moderation, kept open reports (anonymised) and suspension history. `server/README.md`: host and volume snapshots must be kept 30 days or less, and `npm run backup` must run daily.
  - Deleted reporters: their open reports stay under an anonymous `deleted-<hex>` id with no details; resolved ones are removed. **Lead decision:** acceptable, as no personal data is left.
  - Tests: `moderation-decisions.test.js` (31). Final full run 1037 of 1037; typecheck 0; lint 15 warnings.
  - Reviews: no BLOCKER from either reviewer; one fix loop for the should-fix items.
  - For John: ban evasion by deleting the account and signing up again (needs a stored email hash or similar, a legal question); nothing alerts anyone about the 24 h target and there is no admin screen yet (use the API, see `server/README.md`); `PRIVACY_NOTICE_VERSION` stays 2, assuming nobody accepted v2 since 2f05704.
  - Flaky test: "Firebase mode: a cascade that fails ... the sign-in branch finishes it" in `account-deletion.test.js` failed 3 of 6 isolated runs on this Windows machine (rename `EPERM` while the test polls `db.json`), and passed in every full run. The same `EPERM` could hit a real Windows server if something holds `db.json` open (antivirus, an editor): the save then fails with 503 and rolls back. Linux hosts are not affected. Fix candidates: retry the rename a few times in `saveDb`.
- **Item 5 + decision "no logged-out reads" (D1): done, committed (2f05704).**
  - Takeover closed with the flag off: a per-user `sessionGen` in the JWT (`sg`, left out when 0, so existing tokens stay valid). A strong verified sign-in (not stale, email verified, and federated or a password sign-in within 5 minutes) bumps it when the stored state is unverified or on the first federated sign-in (`federatedVerifiedAt`), which kills every earlier JWT. The auth floor (`verifiedAuthFloor`) is now set and checked with the flag off too: a password token from before it gets 403 `sign_in_again`. Accounts are matched by Firebase uid only; nothing looks up or links by email.
  - Gate: one middleware, `requireSignedInAdult`, on `/api` and `/media`. Logged out: 401. Signed in but not 18+: 403 `age_required`. Exempt: `POST /api/auth/mobile`, `POST /api/account/delete-unverified`, `/healthz`, and for the caller's own uid only: `GET`/`PUT /api/users/:id`, `POST /api/users/:id/acknowledgements`, `POST /api/users/:id/delete-account`. The privacy notice text is updated in ro and en, and `PRIVACY_NOTICE_VERSION` is now 2, so existing users see it once.
  - Client: `api.ts` gets a stale-token handler (a 401 on the current token triggers one re-exchange); the AuthContext stored-token check now uses the own-profile route.
  - Tests: new `account-takeover.test.js` (14) and `sign-in-gate.test.js` (11); 20 files updated for the gate. Full run 997 of 998; the one failure was a clock-jitter bound in `account-deletion.test.js` (server clock 7 ms ahead of the test), which got 1 s of slack and then passed 60 of 60. Typecheck 0, lint 16 warnings.
  - Developer's deliberate deviations: the bump is not rolled back on a failed save (a rollback would revive the attacker's JWT); the floor is also set on a new user's strong sign-in (closes the case where the owner's Google sign-in creates the record).
  - Lead decisions on its open questions: a user who declines the age gate gets a screen with Confirm, Log out and Delete account (done in D2). Unconfirmed users cannot delete their own posts or comments, as John's rule says; account deletion stays open to them.
  - Reviews: loop 1 had 3 BLOCKERs: a reproduced race where the attacker refreshing more often made the owner's Google token count as stale (no bump), plus declining the age gate leading into a broken app and untrue age-gate text. All were fixed: federated sign-ins decide from raw claims; the age gate is hard (Confirm, Log out, Delete account; shared DeleteAccountModal); the 401 handler also covers explicit headers. Loop 2 (no BLOCKER): the floor is checked before the flag-on unverified branch (a replay could log the owner out repeatedly, reproduced as V8); the federated floor is iat + 1; a throttled rebuild no longer leaves the app without a token. Security re-review: probes V1 to V8 all end with the attacker refused. Final: 1003 of 1003, typecheck 0, lint 16 warnings.
  - Logged, not fixed: restoring an older db.json lowers sessionGen, so old JWTs work again until the owner's next exchange (bump all users after a restore; README runbook). The floor is password-only: if Firebase lets an attacker link another provider with a different email before the relink, it passes; check on the real project before enabling more providers. `src/components/AgeGateBanner.tsx` is now unused: delete with John's OK.
  - Known effects: existing Google users get one bump at their first sign-in after deploy (other devices re-exchange automatically); admins need the 18+ confirmation too; only the Firebase stub was used.
- **T2-7: email verification behind a flag, default off.**
  - Files: `server/server.js`, `server/test/email-verification.test.js` (new), `server/test/helpers/firebase-auth-stub-preload.js`; client: `src/screens/VerifyEmailScreen.tsx` (new), `src/context/AuthContext.tsx`, `LocalizationContext.tsx`, `src/navigation/AppNavigator.tsx`.
  - `REQUIRE_VERIFIED_EMAIL` is on only when exactly `true`. **Left off, for John to decide.** Off: users see no change, apart from older tokens no longer being able to change a stored email or verified state. On: unverified accounts get no JWT and lose existing access; JWTs without the new `ev` claim stop working; sign-in checks revocation; an old password session cannot get a JWT once the owner has verified; `POST /api/account/delete-unverified` and a delete action on the verify screen let an unverified user delete their account.
  - Verification: `npm test` 975 of 975 pass, exit 0 (re-run by the lead on the final code, after the pause too); `server/data` holds only `db.json`, unchanged by stat; typecheck 0 errors, lint 16 warnings. Port collisions in the developer's earlier runs were most likely the lead's overlapping test run, which was discarded.
  - Reviews: first pass, no BLOCKER in the code review, and sign-in is unchanged with the flag off (by reading; the client has no tests). Security review found 4 BLOCKERs for turning the flag on, all fixed in loop 1; its re-review confirmed 2 fixed and reproduced 2 more on the stub, both fixed in loop 2: a kept password token getting a JWT after the owner's sign-in, and a stale token deleting a verified owner's account.
  - Finished after the pause: the loop 2 re-review confirmed both fixes by a 70-check probe with no new findings, and found flag-off behaviour and the earlier fixes intact. Lead mutation run on a scratch copy: 15 of 17 failed `email-verification.test.js`. Of the 2 that passed: removing the post-wait deletion re-check is caught by `account-deletion.test.js` (confirmed by running it); setting the floor from the latest token instead of `Math.max` behaves the same in practice, because the floor only moves from a current token.
  - Not run: real Firebase: `auth_time` on refresh, the Google relink, revocation, `getUser`. Device checks with the flag on: sign up, verify, enter; Resend and cooldown; kill and reopen; a wrong "I verified"; the sign-in-again alert; a second device; delete from the verify screen; Google on a development build. Flag off: the screen never appears.
  - **Rollout note:** turning it on logs out every JWT without `ev`, so running apps act logged out until their next session. Password users without a stored verified state, including existing verified ones signed in more than 5 minutes ago, are asked to sign in again once. Sign-in gains a Firebase call and fails during a Firebase outage. A server clock running behind refuses password users; look for `[auth] A token auth_time is ahead`.
  - Known gaps: **an attacker who completes a verified password sign-in before the owner keeps a working JWT after a later Google relink,** since a JWT holds no `auth_time`; closing it needs an auth generation in the JWT, a larger change. The 5-minute window is a judgement call: many password users will be asked to sign in again once after opening the email. A full database gives a new unverified user 507 before 403. Stored-unverified users' public posts stay visible. Apple's `email_verified` is unverified. `$&` in an email displays wrongly through `t`.
- **T2-11: privacy notice and name prompt.**
  - Files: `server/server.js`, `server/test/onboarding.test.js` (new), fixtures in `harness`, `auth`, `account-deletion`, `email-exposure`, `images`, `media-pages` tests; client: `src/screens/OnboardingScreen.tsx` (new), `AgeGateScreen.tsx`, `EditProfileScreen.tsx`, `src/navigation/AppNavigator.tsx`, `src/context/AuthContext.tsx`, `LocalizationContext.tsx`, `src/lib/drinkCache.ts`, `src/types/api.ts`.
  - After sign-in: age gate, notice, then a name prompt if needed. The notice cannot be skipped; the name can be postponed to the next launch. New accounts stay hidden, and out of search, until the notice is accepted, so someone who logs out there was never public. **The notice is a client-side gate:** a custom client can use the API without it, though its account stays hidden. A form opened earlier can no longer publish an email prefix, and profile edits now roll back on a failed save.
  - The spec's notice text was false about alcoholic posts, so it was rewritten and extended (moderators, partners of partners, cheers). Each sentence was checked against the running server. The final text is in `LocalizationContext.tsx` under `onboarding.privacy*`.
  - Verification: `npm test` 899 of 899 pass, exit 0 (re-run by the lead); `server/data` holds only `db.json`, unchanged by stat; typecheck 0 errors, lint 16 warnings.
  - Lead mutation run on a scratch copy: 7 of 10 failed the tests. The other 3 behave the same as the real code, so they are not test gaps: pending users have blank fields, so search cannot match them anyway; a blank name reaches the same result through the other branch; refusing older notice versions cannot differ while the version is 1.
  - Reviews: code and security, no BLOCKERs; SHOULD-FIX items applied.
  - **Needs John: the notice is not legal advice and no lawyer has reviewed it.**
  - Not run, device checks for John: new email sign-up (notice and name); Google sign-in (notice only); returning users not re-asked; declining age still shows the notice; Later, including after logout; failed and hung saves; a long notice on a small screen; a masked legacy user.
  - Known gaps: leaving at the notice keeps the account record, including the email, on the server: deleting it means accepting first. An existing account that logs out at the notice stays public. Edit Profile cannot set a name equal to the email prefix, and shows its normal success alert while keeping the old name. The partner sentence is untrue with `PARTNER_CONSENT_REQUIRED=false`. Avatars ignore blocks; a by-id 403 reveals that a post is alcoholic. No acknowledgement history once the version rises.
- **T2-5: account deletion, including the Firebase user, and backup retention.**
  - Files: `server/server.js`, `server/test/account-deletion.test.js` (new), `server/test/helpers/firebase-auth-stub-preload.js`, `db-fault-preload.js`, `persistence.test.js` (fixture); client: `src/context/AuthContext.tsx`, `LocalizationContext.tsx`, `src/lib/api.ts`, `src/navigation/AppNavigator.tsx`, `src/screens/EditProfileScreen.tsx`, `src/types/api.ts`.
  - Edit Profile has a Delete Account flow with a typed confirmation. `POST /api/users/:id/delete-account` needs the JWT, ownership and a fresh Firebase token; password accounts must have signed in within 5 minutes. A saved pending entry comes first, so a crash cannot lose the request; a startup and 15-minute retry finish the job. The cascade removes the user from every stored collection, and a search of the saved file for the uid, name and email finds nothing (checked by a test and independently by a reviewer). A 1-hour tombstone stops a cached token bringing the person back. Backups (`.corrupt-*`, `.pre-migration-*`) now expire after 30 days, **reversing T1-10's "never deleted"**, with a 7-day hold after a lost or empty start.
  - **Wording decision:** the warning says backups go "within 40 days", not the spec's 30, because the hold can add 7 days and a purge can wait for a healthy start. John can tighten it after legal review.
  - Verification: `npm test` 855 of 855 pass, exit 0 (re-run by the lead); `server/data` holds only `db.json`, unchanged by stat; typecheck 0 errors, lint 16 warnings. Lead mutation runs on scratch copies: 15 of 15 on the first pass, including every retention safeguard; 8 of 10 applied mutants on the fixes, plus one that never applied. Of the 2 that passed: a tombstone that never expires is not a real gap, since a token from before the deletion has expired by then; the clamp on a future hold date now has a test, and that mutant then failed it. A second new test pins the 7-day hold default; its mutant was not run. Those 2 tests passed in `account-deletion.test.js` run alone (60 of 60, by the developer); the next full run should show them.
  - Reviews: 1 BLOCKER, reproduced and confirmed fixed: an upload in progress during deletion recreated a public post under the deleted account. A sign-in race with the same effect was reproduced in re-review and fixed. SHOULD-FIX items applied.
  - Not run: **no real Firebase call,** so `deleteUser`, `getUser`, `checkRevoked`, `auth_time` and the service account's permissions are unverified. Device checks for John: full flow for password and Google, wrong password, offline, a lost response ending at the "deleted" notice, hung server, the modal with the keyboard on both platforms.
  - **What code cannot delete; state this in the privacy docs:** a person's data stays in `.corrupt-*` and `.pre-migration-*` copies until they expire; restoring a backup brings deleted accounts back, and an operator must repeat the deletions; a corrupt start loses pending deletions; host snapshots and hand-made copies are out of reach; older request logs can hold the uid in URLs; a crash can leave a `.tmp-*` file until the next good load; copies on other phones and in image caches stay until they refresh; Google-hosted photos are outside this system; text others wrote that mentions the person stays; older notifications using a previous name stay until they expire; the uid stays in a tombstone for up to about 1 hour 15 minutes.
  - Known gaps: Google and Apple accounts refresh a token rather than re-authenticate. While a cascade keeps failing, remaining posts and comments can still appear in lists. A report the person filed is removed even if it was valid. An older server version running on a newer file would drop pending deletions. **`DB_FILE` needs its own directory.** Restoring a file without `recoveryStartedAt` ends a hold, so move wanted backups first.
- **T2-13: partner consent and private partner lists.**
  - Files: `server/server.js`, `server/test/partners.test.js` (new), fixtures in `email-exposure`, `null-user`, `storage-limits`, `persistence`, `auth`, `harness`, `production-guard` tests; client: `src/lib/usePartnerAction.ts` (new), `src/lib/api.ts`, `drinkCache.ts`, `src/types/api.ts`, `LocalizationContext.tsx`, `PartnersListScreen` (rewritten), `ExploreScreen`, `ProfileScreen`, `HomeScreen`.
  - Nobody becomes a partner without both sides agreeing. `POST` asks, or accepts if the other side already asked; it no longer removes anyone. New routes remove, cancel, list, accept and decline. Partner lists are limited to the owner and their partners. Limits: 50 pending, 100 new requests per day; requests expire after 90 days. Existing partnerships stay.
  - **Reversible product decision:** `PARTNER_CONSENT_REQUIRED=false` restores instant add. It is an emergency rollback only: with it off, anyone can add themselves and read a partner list, the links remain after turning it back on, and a privacy notice saying lists are private is then untrue. The server logs a warning when it is off under production rules.
  - Verification: `npm test` 797 of 797 pass, exit 0 (re-run by the lead, after the final client-only fix); `server/data/db.json` unchanged by stat; typecheck 0 errors, lint 16 warnings. Lead mutation run on a scratch copy: 6 of 6. Live security probe: no consent bypass with the flag on, and a partnership gives no access to age-hidden posts.
  - Reviews: code and security, no BLOCKERs; SHOULD-FIX items applied.
  - Not run, device checks for John: request, accept, decline and cancel between two accounts; all four button states; remove confirmation; Requests section and private state; narrow phones.
  - Known gaps: incoming requests have no cap or paging, though each sender is limited. A declined user can ask again straight away; block is the remedy. A notification stays after a cancel or decline until it expires. Notification text is English only. Notifications are not tappable, so requests are reached through the Profile stat.
- **T2-3: report content, block users, operator moderation.**
  - Files: `server/server.js`, `server/test/moderation.test.js` (new), `persistence.test.js` (fixture), `production-guard.test.js`; client: `src/components/PostActionsSheet.tsx`, `ReportSheet.tsx` (new), `CommentDrawer.tsx`, `src/screens/BlockedUsersScreen.tsx` (new), `DrinkDetail`, `Profile`, `EditProfile`, `Home`, `Explore`, `SmartBar` screens, `src/navigation/AppNavigator.tsx`, `src/lib/api.ts`, `drinkCache.ts`, `src/types/api.ts`, `LocalizationContext.tsx`.
  - Every post, comment and other user's profile can be reported, with 6 reasons and 20 reports per day. Blocks work both ways on every signed-in route, and a blocked viewer gets the same 404 as for a missing post. Comment authors and post owners can delete comments. Operators in `ADMIN_USER_IDS` can list reports, dismiss them, remove a post or comment, or clear a profile, through the API only (no admin screen). Resolved reports lose their details at once and their reporter id after 30 days.
  - Verification: `npm test` 742 of 742 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck 0 errors, lint 16 warnings. Lead mutation run on a scratch copy, on the first pass: 12 of 12. Live security probe: no block bypass, reporter leak, email leak, admin bypass or comment IDOR; failed saves restored state.
  - Reviews: code and security, no BLOCKERs; SHOULD-FIX items applied.
  - **Needs John:** set `ADMIN_USER_IDS` and actually review reports, or the policy requirement is only met on paper. See Decisions for John.
  - Not run, device checks for John: report and block from a post, a comment and a profile; closing the sheet mid-request; the Blocked Users list and unblock; feeds after a block; a reported post staying out of Trending; deleting comments. The new Romanian strings deserve a native check.
  - Known gaps: logged-out reads stay public, so a block does not stop viewing while signed out. `/media/avatars` stays public. Notifications from before this change stay visible after a block until they expire. `cheersCount` includes cheers from a blocked user. No client field for report details. Moderation has no screen. The prune on resolve has no test of its own, since tests have no clock control.
- **T2-2: age gate enforced on the server.**
  - Files: `server/server.js`, `server/test/age-gate.test.js` (new), fixtures in most test files (posts marked `isAlcoholic: false` or users confirmed, because those suites are not about the gate); client: `src/screens/AgeGateScreen.tsx` (new), `src/components/AgeGateBanner.tsx` (new), `src/lib/useConfirmAge.ts` (new), `src/lib/api.ts`, `drinkCache.ts`, `src/types/api.ts`, `src/context/AuthContext.tsx`, `LocalizationContext.tsx`, `src/navigation/AppNavigator.tsx`, `CommentDrawer.tsx`, and `CreatePost`, `DrinkDetail`, `Home`, `Explore`, `Profile`, `SmartBar`, `Scanner` screens.
  - Only a timestamp is stored, no birth date. Unconfirmed and logged-out viewers get no alcoholic post text, image, comment or AI recipe. A post without a flag counts as alcoholic. Notifications that name an alcoholic post hide the name until the user confirms. Non-alcoholic content stays fully usable. Alcohol wording and the Cocktail, Wine and Beer chips are hidden until confirmed.
  - AI: unconfirmed users always get mocktail instructions, the mocktail filter and an alcohol denylist, whatever flags the client sends. **This closes only the age condition for enabling AI; the others stay (see T1-8 Decisions).**
  - Verification: `npm test` 661 of 661 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck 0 errors, lint 16 warnings. Lead mutation run on a scratch copy, on the first pass: 13 of 13. Live security probe with logged-out, garbage, expired, forged and unconfirmed viewers across every post route: no leak.
  - Reviews: code and security, no BLOCKERs; SHOULD-FIX items applied.
  - Not run, device checks for John: gate, decline and its return next launch; banner on Home, Explore, own Profile and Smart Bar Saved; late confirm; locked toggle on CreatePost; neutral wording in both languages. The new Romanian strings deserve a native check.
  - **External, needs John:** check current App Store and Google Play alcohol rules and age rating before release.
  - **Behaviour to expect:** all existing users start unconfirmed, so their own alcoholic posts disappear from their profile until they confirm. Legacy posts without a flag count as alcoholic.
  - Known gaps: age is self-declared and a poster can mislabel a post. The AI denylist is a safety net, not a guarantee: words such as "ale" or "port" are left out, and "non-alcoholic beer" is dropped. Images already cached on a device stay viewable. Profile and Smart Bar Saved show a generic error on `age_required`, reachable only with a stale card. A hidden post's 403 reveals that the id exists.
- **T2-4: delete own post, without resetting limits.**
  - Files: `server/server.js`, `server/test/delete-post.test.js` (new), `server/test/persistence.test.js` (fixture); client: `src/components/PostActionsSheet.tsx` (new), `DrinkPostCard.tsx`, `CommentDrawer.tsx`, `src/lib/api.ts`, `drinkCache.ts`, `src/context/LocalizationContext.tsx`, `HomeScreen`, `ExploreScreen`, `ProfileScreen`, `SmartBarScreen`, `DrinkDetailScreen`.
  - `DELETE /api/drinks/:id` removes the post, its comments, cheers, saves and cached image. A failed save restores everything and returns 503. Daily limits now read stored events, so deleting resets nothing; the lifetime and total image limits are freed, closing the T1-7 gap. Only a plain positive integer now names a post on every drink route.
  - Verification: `npm test` 548 of 548 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck 0 errors, lint 16 warnings. Lead mutation run on a scratch copy, before the small fix pass: 14 of 14.
  - Reviews: code and security, no BLOCKERs; SHOULD-FIX items applied.
  - Not run, device checks for John: delete from each screen; sheet layout; long location with the menu; failed delete and retry; deleting while a list is loading; a late 404 after leaving a post. The delete menu on the detail screen cannot be reached today, because the only route there is Explore's trending list, which excludes your own posts.
  - Known gaps: a Load more or refresh in flight during a delete is dropped and must be repeated. Deleting your post also refetches cached profile lists of other users. A 404 on opening a post leaves it in cached lists until a refetch. Expired limit events of an inactive user stay in the file until a restart. Devices may keep a deleted image in their own cache for up to a day; the server returns 404 at once.
- **T2-10: lists are paged, and images left the JSON responses.**
  - Files: `server/server.js`, `server/test/media-pages.test.js` (new), fixtures in `images`, `storage-limits`, `auth`, `plain-text`, `saved-drinks`, `null-user`, `persistence`, `harness`, `email-exposure`, `production-guard` tests; client: `src/lib/api.ts`, `src/lib/drinkCache.ts` (new), `src/types/api.ts`, `src/context/AuthContext.tsx`, `LocalizationContext.tsx`, `src/components/DrinkPostCard.tsx`, `CommentDrawer.tsx`, `LoadMoreButton.tsx` (new), `ListLoadState.tsx` (new), and `HomeScreen`, `ExploreScreen`, `ProfileScreen`, `DrinkDetailScreen`, `PartnersListScreen`, `CreatePostScreen`, `SmartBarScreen`, `EditProfileScreen`.
  - Five list routes return `{ items, nextCursor }`, up to 50 per page. Images are served from `/media` with a bounded cache and our own ETag. The JWT goes only to our own server. The T1-7 failure (a comments request returning 500) is covered by a test and returns under 256 KB. Avatars are accepted only from the verified token and `lh3` to `lh6.googleusercontent.com`; other stored hosts now show the initial. Explore search runs on the server with at least 2 characters. Failed lists show an error with retry instead of "empty".
  - Verification: `npm test` 527 of 527 pass, exit 0 (re-run by the lead), then the one exact-page assertion the lead added passes in `media-pages.test.js`; `server/data/db.json` unchanged by stat; typecheck 0 errors, lint 16 warnings. Lead mutation run on a scratch copy: 11 of 15 failed the tests. Of the 4 that passed: the cursor off-by-one was a real gap, now tested and caught; the other 3 were not gaps (Express already answers 304 from the ETag; a badly written mutant equal to the real code; a default constant that tests override).
  - Reviews: code and security, no BLOCKERs; SHOULD-FIX items applied except those below. The 4.2 second `/healthz` stall was not re-measured after adding the cache.
  - Not run, device checks for John, **second priority after sign-in:** images load on iOS and Android; a Google photo request carries no `Authorization`, especially when a view switches from a `/media` image (Android header reuse was handled from reading its source); Load more, search past page 1, cheer and save across pages, new post at the top; error states with the backend stopped.
  - Known gaps: `/media` stays public until T2-2 and T2-3, **so do not deploy between these items.** Cycling through more 7 MB images than fit in 64 MB still decodes repeatedly, limited only by 600 requests per 15 minutes per IP (no byte budget; a full-window estimate of 4.2 GB per IP, not run). `decorateDrink` spreads the stored record, so a legacy extra field would reach JSON. Partner toggles and comment posting still refetch all loaded pages. `/api/drink-partners` and `/api/users/:id/partners` stay unbounded without image bytes. Explore's Cocktail, Wine and Beer chips stay empty.
- **T2-12: own posts and comments use your current profile.**
  - Files: `src/screens/ProfileScreen.tsx`, `EditProfileScreen.tsx`, `DrinkDetailScreen.tsx`, `src/components/CommentDrawer.tsx`.
  - Applied on Profile Posts and Saved, the comment drawer and the detail screen, matched on the author's id, so others' posts in Saved keep their author. Edit Profile updates the profile and cached data straight away.
  - Verification: typecheck 0 errors; lint 16 warnings (new baseline; re-run by the lead); `email-exposure.test.js` 27 of 27 (run by the developer). Not run on a device.
  - Reviews: reviewed together with T2-10, which rewrites the same screens.
  - Known gaps: the detail screen's comment list shows an initial, not an avatar image, as before. Stored notifications keep an old name.
- **T2-6: text stored as typed, one-time migration of old data.**
  - Files: `server/server.js`, `server/test/plain-text.test.js` (new), `server/test/helpers/db-fault-preload.js`, fixtures in `auth.test.js`, `smart-bar.test.js`, `email-exposure.test.js`, `persistence.test.js`, `storage-limits.test.js`, `null-user.test.js`.
  - Apostrophes and other characters no longer show as `&#x27;`. Text is no longer HTML-escaped, deliberately, because the only client is React Native `<Text>`, which does not parse HTML: **any future web client must encode on output.** Bidi overrides and C1 control characters are now stripped. A non-string optional field is stored as null.
  - Migration: an existing DB without the new version key is backed up to `.pre-migration-<timestamp>` (verified, and identical copies are not repeated), then decoded once, then saved. A backup or decode failure stops startup with the file unchanged. Email-derived names stay masked.
  - Verification: `npm test` 476 of 476 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck and lint at the new baseline. Lead mutation run on a scratch copy: 13 of 13. A first run was discarded when its control failed: `email-exposure.test.js` reads client source, which the scratch copy lacked.
  - Reviews: code and security, no BLOCKERs. Reproduced and fixed: a stale form resending an old cut name could publish email-derived text. SHOULD-FIX items applied.
  - Not run: **the migration has never run against your real `db.json`** (off limits; 615 bytes by stat, so small).
  - Known gaps: raw text saved before sanitizing existed that ends in `&` or an entity prefix loses that ending outside Smart Bar (`Gin &` becomes `Gin `); the backup keeps the original. A legacy notification can keep a partial entity mid-message until it expires in 7 days. A form opened before the migration can store `lastName`, `city` or `bio` with literal entities. Rolling back to old code and forward again can double-decode. Backups hold personal data until T2-5's retention exists. Already-stored text keeps bidi characters.
- **T2-9: sign-in race fixed; errors no longer look like an empty app.**
  - Files: `src/context/AuthContext.tsx`, `src/screens/SessionErrorScreen.tsx` (new), `src/navigation/AppNavigator.tsx`, `src/screens/HomeScreen.tsx`, `src/lib/api.ts`, `src/context/LocalizationContext.tsx`.
  - The main app opens only with a valid JWT and a loaded profile. Failures show an error screen with Retry and Log out. Home's empty state appears only after a successful load. The T1-5 gap (fallback profile) is closed. A stored JWT is only used after the server accepts it for this user, tested on saved-drinks because the profile route answers 200 even for a dead token. A user the server refuses (401 or 403) loses the stored JWT. Each session step times out at 15 seconds, so the spinner lasts about 60 seconds at most, with no Log out during it.
  - Verification: typecheck 0 errors, lint 17 warnings (re-run by the lead). **No client test framework exists, so behaviour was checked by reading only.**
  - Reviews: code and security, no BLOCKERs; SHOULD-FIX items applied.
  - Not run, device checks for John, **highest priority of this run because every sign-in passes through this code:** email and Google sign-in (Google needs a development build), user with no name, returning user's cold start, backend down then Retry, Log out from the error screen in airplane mode, failed exchange with a valid and with an expired stored JWT, rapid logout then login, backend stopped while on Home.
  - Known gaps: no handling of a 401 mid-session: if a JWT expires while the app stays open, requests fail until a restart. The JWT check downloads the whole saved list until T2-10. An exchange 401 shows "check your connection". Local development without a Firebase key now stops at the error screen, unless `ALLOW_INSECURE_DEV_AUTH=true`.
- **T2-8: cache cleared when the user changes.**
  - Files: `src/context/AuthContext.tsx`, plus guards in `CreatePostScreen.tsx`, `DrinkDetailScreen.tsx`, `ProfileScreen.tsx`, `HomeScreen.tsx`, `ExploreScreen.tsx`, `SmartBarScreen.tsx`.
  - Cancels queries and clears the cache in the same tick as the user change. Responses to the earlier user's actions are dropped, which needed guards in screens because cancelling does not stop mutations.
  - Verification and reviews: as T2-9. Not run, device check: A signs in and opens every tab, logs out, B signs in on a slow network; B sees none of A's data.
  - Known gaps: the native image cache is not cleared.
- **T2-14: DB size guard measures bytes; Smart Bar capped.**
  - Files: `server/server.js`, `server/test/storage-limits.test.js`, `src/screens/SmartBarScreen.tsx`, `src/context/LocalizationContext.tsx`.
  - The guard (450 million bytes) now uses the same unit as the startup failure point (536,870,888 bytes, measured). Smart Bar allows 500 items per user (429 `smart_bar_limit`); larger existing lists keep their items and can delete. A half emoji at a text cut is dropped.
  - Verification: `npm test` 441 of 441 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat. The earlier reproduction no longer reaches an unloadable file. With default limits, the largest single write ended at 459.77 million bytes, about 77 million below the failure point, and the server restarted on it. 6 of 6 broken copies failed the tests (run by the developer on scratch copies).
  - Reviews: security confirmation, no BLOCKER; comment NIT applied. No separate code review, because the change is small and the security check read the same lines.
  - Not run on a device: the Smart Bar limit message. The ro and en strings hardcode 500.
  - Known gaps: a save holds the text and its bytes in memory, about twice the DB size at peak near the limit (not measured).
- **T2-1: baseline typecheck and lint errors fixed.**
  - Files: `tsconfig.json` (excludes `agents`), `src/navigation/AppNavigator.tsx` (removed the invalid `presentation: 'fullScreenModal'` on CreatePost), `metro-proxy.js` (`/* global Buffer */`).
  - Verification: `npm run typecheck` 0 errors, exit 0; `npm run lint` 17 problems (0 errors, 17 warnings). **New baseline from here on.** The stack source was read: the invalid value matched none of its modal checks, so CreatePost should still open as before.
  - Not run, device check for John: CreatePost opens and closes as before.
  - Known gaps: `agents/` is no longer type-checked.
- **T2-15: Explore error messages un-swapped.**
  - Files: `src/screens/ExploreScreen.tsx`. Save failure now shows the save message, partner failure the partner message.
  - Verification: typecheck and lint as above. Not run on a device.
- **T1-11: Docker files.**
  - Files: `Dockerfile`, `.dockerignore`.
  - `.dockerignore` is an allowlist: only `server/package.json`, `server/package-lock.json` and `server/server.js` enter the build. The image uses Node 22, `npm ci --omit=dev`, a non-root user, `NODE_ENV=production` and `PORT=8080`.
  - Verification: `npm ci --omit=dev --dry-run` ran without error. Two reviewers checked the allowlist by reasoning. A code reviewer ran the server outside Docker with a matching env: it refuses to start without secrets and `ALLOW_EMPTY_DB`, then starts with them. **The image was never built, because Docker is not installed here.**
  - Reviews: no BLOCKERs. `NODE_ENV` NIT applied.
  - To deploy with it: pass the Firebase key as JSON in `FIREBASE_SERVICE_ACCOUNT_KEY`; mount a volume writable by uid 1000 at `/app/server/data`, or set an absolute `DB_FILE`; set `ALLOW_EMPTY_DB=true` for the first start only, then remove it; set `TRUST_PROXY_HOPS` to the real hop count; never set `DEBUG=true` in production, since the OpenAI SDK may log request bodies (inferred, not exercised); never pass secrets with `--build-arg`.
  - Known gaps: base image tag `node:22-alpine` moves, no `HEALTHCHECK`. `D:\DrinkMeApp\DEPLOY.md` still describes `railway up` from `server/` and an incomplete variable list; it is off limits for this run, so use the list above. Any deploy from git ships the old lockfile until the updated one is committed (see BLOCKED).
- **T1-8: AI routes hardened and off by default.**
  - Files: `server/server.js`, `server/test/ai-routes.test.js`, `server/test/helpers/openai-stub-preload.js`, `server/test/images.test.js` (2 tests moved).
  - AI runs only with `AI_ENABLED=true` exactly. Disabled routes return 503 after auth and before any upload is read. Uploads are checked by bytes (JPEG, PNG, WebP). Prompt input is validated, output is capped, 20 requests per hour per user, `store: false`. Upstream errors become a generic 502, and only the app's own error messages reach clients, on every route.
  - Verification: `npm test` 433 of 433 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck and lint match the baseline. Lead mutation runs on scratch copies: 26 of 26, then 14 of 14. The real SDK is tested against a local mock.
  - Reviews: 2 BLOCKERs. Non-alcoholic input getting alcoholic recipes is fixed and confirmed by security re-review. The missing age gate is a condition for enabling AI (see Decisions, T2-2). SHOULD-FIX items applied except those below.
  - Not run: **no real OpenAI call**, so OpenAI's acceptance of this exact request is unconfirmed.
  - Known gaps: `SmartBarScreen.tsx:142` does not send `nonAlcoholicOnly` yet (unreachable while the client flag is off; add it before enabling AI). Prompt injection stays possible, with low impact: no tools, no stored output, and output only reaches the caller. A recipe the model labels a mocktail is trusted. "1/2 oz" parses as 1. Curly quotes pass the prompt cleaner. More than 50 selected inventory items returns 400.
- **T1-7: image validation, storage limits, failed saves reported.**
  - Files: `server/server.js`, `server/test/images.test.js`, `server/test/storage-limits.test.js`, `server/test/helpers/db-fault-preload.js`, fixture changes in `server/test/persistence.test.js`, `harness.test.js`, `saved-drinks.test.js`, `email-exposure.test.js`; client: `src/lib/api.ts`, `src/context/LocalizationContext.tsx`, `src/screens/ProfileScreen.tsx`, `CreatePostScreen.tsx`, `DrinkDetailScreen.tsx`, `SmartBarScreen.tsx`, `src/components/CommentDrawer.tsx`.
  - Images: type comes from the bytes, never from the client. Avatars take JPEG, PNG or WebP up to 2 MB; posts also take HEIC, up to 7 MB. Base64 is strict. Avatar ownership is checked before the upload is read.
  - Requests: rate limits run before body parsing; the default body limit is 100 KB, with larger limits only on the two image routes, after auth. Malformed uploads and JSON return 400.
  - Saves: a failed save returns 503, and creates are rolled back. Limits on images and text are under Decisions.
  - Client: clear ro and en messages for too large, wrong format, daily limit and storage full.
  - Verification: `npm test` 330 of 330 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck and lint match the baseline. Lead mutation runs on scratch copies: 21 of 23 (first pass), then 17 of 17, 15 of 15 and 12 of 13. Of the 2 first-pass misses, the JPEG third-byte check now fails with a new test; `files: 1` is redundant because `single()` already enforces it. The 13th loop-3 miss is the notification guard, which cannot be reached over HTTP because every path to it already returns 507. An earlier mutation run was discarded: its control failed because a reviewer's tests were using the same port.
  - Reviews: 3 BLOCKERs across 3 fix loops (image storage, avatar dead end, text and post growth past the guard), all confirmed fixed. The final security check found a route-by-route growth limit holds, by a run plus arithmetic.
  - Not run: nothing on the client was run on a device; multer 2 not tested (not installed).
  - Known gaps: the 100 MB lifetime image quota cannot be freed until posts can be deleted (T2-4). Only signature bytes are checked, so a valid header followed by other data passes (needs re-encoding, SEC-E). AVIF with major brand `mif1` is accepted as HEIC. Toggles and profile edits are not rolled back after a 503. At the size guard, every save still blocks the server for over a second (DATA-1). The size guard's bytes-versus-characters problem is T2-14, and it is not fixed yet.
- **T1-9: Smart Bar input sanitized, no dummy items for new users.**
  - Files: `server/server.js`, `server/test/smart-bar.test.js`.
  - Name, quantity and unit are type-checked, sanitized and cut to 120, 60 and 60 characters. Invalid or empty values return 400. New users start empty; items already stored for existing users stay.
  - Verification after the VS Code restart: the exact fix list from the interrupted session was not recorded, so the item was re-verified rather than trusted. 17 deliberately broken server copies were run, and all 17 now fail the tests. Against the old tests, 12 were run: 11 failed and 1 passed (id reuse after deleting a middle item). The other 5 (save on add, save on delete, logged-out access on 3 routes) were only run after 3 tests were added for these gaps, so the old tests' result for them is unknown. `npm test` 229 of 229 pass, exit 0; `server/data/db.json` unchanged by stat.
  - Reviews: no BLOCKERs before the interruption. The new tests only add coverage, so no re-review was run.
  - Known gaps: no limit on the number of items per user.
- **T1-4: saved-drinks access bug, plus sign-in name rules.**
  - Files: `server/server.js`, `server/test/saved-drinks.test.js`, `server/test/auth.test.js`.
  - `GET /api/users/:userId/saved-drinks` now returns 403 for anyone but the owner. The client only requests the signed-in user's own list.
  - Name rules: a new user's name is the verified token name, or else the request `displayName`. A value containing `@` is never stored, and a request name matching the email prefix leaves the name empty. Sign-in never refills an existing user's name. Owner responses use a `toOwnerUser` allowlist.
  - Verification: `npm test` 218 of 218 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck and lint match the baseline. All 8 deliberately broken copies of the saved-drinks route failed the tests.
  - Reviews: one BLOCKER (the unrequested `retiredEmailPrefixes` field) removed in fix loop 1 and confirmed by security re-review. The real `db.json` cannot hold that field, because it was last modified on 2026-06-16.
  - Known gaps: an owner can still deliberately set a public name equal to their email prefix through Edit Profile, which is treated as their choice.
- **T1-5: other users' emails no longer exposed.**
  - Files: `server/server.js`, `server/test/email-exposure.test.js`, `server/test/auth.test.js`, `server/test/null-user.test.js`, `server/test/harness.test.js`, `src/types/api.ts`, `src/context/LocalizationContext.tsx`, `src/screens/ExploreScreen.tsx`, `src/screens/PartnersListScreen.tsx`, `src/screens/DrinkDetailScreen.tsx`, `src/screens/ProfileScreen.tsx`, `src/screens/EditProfileScreen.tsx`, `src/components/CommentDrawer.tsx`, `src/components/DrinkPostCard.tsx`, `src/components/StoriesSection.tsx`.
  - Other users now get an allowlisted public profile. Email and `emailVerified` are returned only to the owner. Names derived from an email are hidden, and search no longer matches emails. Search terms no longer reach request logs. New users start with empty city and bio, not "Bucharest".
  - Client: another user's profile has loading and error states and never shows the viewer's data. Explore shows a hint below 2 characters. Edit Profile disables Save until the profile has loaded.
  - Verification: `npm test` 191 of 191 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck and lint match the baseline.
  - Reviews: no BLOCKERs; 28 of 29 server defects caught, and the miss is the empty stories route. SHOULD-FIX items applied.
  - Not run, device checks for John: fresh login then Profile and Edit Profile; backend down during login; another user's profile (loading, error with retry, masked name); empty city and bio on Profile, Explore and PartnersList; `@` hint in Explore.
  - Known gaps: if the token exchange fails, the owner can see their public view for that session (moved to T2-9). Explore can show "DrinkMe user" for a masked user who has a public last name.
- **T1-6: search and feed auth, state writes on logged-out reads.**
  - Files: `server/server.js`, `server/test/null-user.test.js`, `server/test/production-guard.test.js`.
  - `/api/users/search` and `/api/drinks/partners` now require auth. Search needs at least 2 characters, returns at most 50 results and is limited per account. Logged-out reads no longer write state (partner key, comment entries). Tokens for unknown users count as logged out. `trust proxy` now comes from `TRUST_PROXY_HOPS`.
  - Verification: `npm test` 161 of 161 pass, exit 0 (re-run by the lead). `server/data/db.json` unchanged by stat; typecheck and lint match the baseline.
  - Reviews: no BLOCKERs; 15 of 16 broken server copies failed the tests, and the miss (expired tokens) now has a test.
  - Known gaps: a non-numeric comment key holding comments stays stored but unreachable, kept so no data is lost. If the DB is lost while the app is open, requests get 401 until the next launch.
- **T1-3: sign-in input trust.**
  - Files: `server/server.js`, `server/test/auth.test.js`, `server/test/helpers/firebase-auth-stub-preload.js` (test-only), `server/test/production-guard.test.js`.
  - In Firebase mode, the email now comes only from the verified token, and a forged stored email is corrected at login. `uid`, `idToken`, `displayName` and `photoURL` are validated. An uploaded avatar is no longer overwritten by the provider photo at each login.
  - Verification: `npm test` 137 of 137 pass, exit 0 (re-run by the lead). `server/data/db.json` unchanged by stat; typecheck and lint match the baseline.
  - Reviews: no BLOCKERs; 13 of 13 deliberately broken server copies failed the tests; SHOULD-FIX items applied.
  - Known gaps: real Firebase sign-in not run. Stored bad avatars and names from before this change are not cleaned up. A token email is stored as given.
- **T1-2: production startup guard.**
  - Files: `server/server.js`, `server/test/production-guard.test.js`, `server/test/helpers/harness.js`, `server/test/helpers/db-fault-preload.js`, `server/test/persistence.test.js`.
  - The server now refuses to start in production without a strong `JWT_SECRET` and working Firebase Admin. It also refuses a wrong or corrupt `DB_FILE`. The hardcoded secret is gone, and JWTs are pinned to HS256.
  - Also includes the T1-10 follow-up: backups are written, fsynced and verified by SHA-256.
  - Verification: `node --check` OK; `npm test` 77 of 77 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck and lint match the baseline.
  - Reviews: one BLOCKER fixed in fix loop 1 and confirmed by security re-review.
  - Known gaps: the production default-path DB check and blank `DB_FILE` are untested, because the harness refuses both. Startup with the real `server/.env` was not run. A real Firebase sign-in was not tested. A foreign JSON file that happens to contain a known key such as `drinks` would still pass the shape check.
- **T1-10: atomic saves and safe DB loading.**
  - Files: `server/server.js`, `server/test/persistence.test.js`, `server/test/helpers/db-fault-preload.js` (test-only).
  - Saves: temp file with random name, mode 0600, fsync, then rename, with retries on Windows lock errors.
  - Loads: the server starts empty only when no file exists, or after backing up a file that was read but holds invalid data. Every other failure stops the server with a FATAL log and writes nothing.
  - Verification: `node --check` OK; `npm test` 26 of 26 pass, exit 0 (re-run by the lead); `server/data/db.json` unchanged by stat; typecheck and lint match the baseline.
  - Reviews: one BLOCKER fixed in fix loop 1 and confirmed by re-review. Compatibility with the older `saveDb` format was checked by reading the code.
  - Known gaps: the new validation was not run against your real `db.json`, because that file is off limits. On your next real start, look for `[db] Loaded`, not `[db] Failed to load`. If it fails, your data is in `server/data/db.json.corrupt-*`. A test cannot yet force a crash mid-write, so atomicity is confirmed by reading the code. File modes do nothing on Windows.
- **T1-1: configurable DB path and test harness.**
  - Files: `server/server.js`, `server/package.json` (`test` script only), `server/test/helpers/harness.js`, `server/test/harness.test.js`, `.gitignore` (now ignores `server/data/`).
  - Also added: `HOST` env var (default `0.0.0.0`) and the effective DB path in the `[db]` log lines.
  - Verification: `node --check` OK; `npm test` 5 of 5 pass, exit 0; `server/data/db.json` unchanged by stat; typecheck and lint match the baseline.
  - Reviews: no BLOCKERs; SHOULD-FIX items applied in one fix loop.
  - Known gaps: no dedicated test for the stdout wait, the cleanup error path or the `HOST` default. A dangling junction inside temp would pass the harness allow-list. `server/**` is ignored by ESLint, so test files are unlinted.

## In progress
**Session 3, resumed 2026-11-10 on John's instructions** (answers to the open points, then Tiers 3 to 6). John now allows: commits on this branch (never main, never push); patch and minor root updates (pins untouched); editing the five external docs; Docker; implementing his decisions.

- **Item 1, multer: done, pending the full test run.** John's install had not landed (package.json, lockfile and node_modules were all still 1.4.5-lts.2), so the run installed `multer@^2.5.0` in `server/` as his answer intended: `npm ls multer` shows 2.5.0. Code needs no change (memoryStorage, MulterError and LIMIT_FILE_SIZE are unchanged in 2.x). `npm audit` in `server/`: 6 moderate, all transitive inside `@google-cloud/firestore-api` (gaxios, gcp-metadata, glob, google-gax, minimatch, rimraf); `npm audit fix` without --force cannot move them. Firestore is never imported, so they are not reachable. Accepted.
- **Item 3, root dependencies: done.** `npx expo install --check` asked for `expo ~54.0.37` and `expo-constants ~18.0.14`, installed with `npx expo install` (expo resolved to 54.0.38). Transitive security group from Commands for John updated with `npm update <names>`; React Navigation minor update (native 7.5.1, stack 7.12.1) for its high advisory; `npm update expo-font` plus `npm dedupe` removed a duplicate expo-font that expo-doctor flagged. Root audit 46 to 33 (critical 3 to 0, high 15 to 9). Pins unchanged by `npm ls`: reanimated 4.1.7, worklets 0.5.1, expo-auth-session 7.0.11, expo-apple-authentication 8.0.8. package.json changed only on the two Expo lines. Typecheck 0 errors, lint 16 warnings (as before). `npx expo install --check`: up to date. expo-doctor 17 of 18: `@types/react-native` should not be installed directly (pre-existing; removing it is an uninstall, so listed below).
  - **Majors not installed (for John):** firebase 12 to 13 (the high advisories are in @firebase/firestore, never imported; audit's own fix is a downgrade to 9.14); expo and every expo-* package to SDK 58 (an SDK upgrade, breaks the pins); react-native 0.88; @babel/core 8; eslint 10 and eslint-config-expo 58; typescript 7; tailwindcss 4; react-native-gesture-handler 3; @react-native-async-storage/async-storage 3; dotenv 18; @types/node 26.
  - Not updated although in range: firebase 12.19 (auth code, needs device checks, fixes no reachable advisory); react-native-worklets 0.5.2 (pinned). Remaining highs: @firebase/firestore and grpc (not imported); `@jackchen_me/open-multi-agent` with its zod and openai (dev only, see BLOCKED); postcss and image-size (build tooling, the fix is an Expo 52 downgrade). To remove when John agrees: `npm uninstall @types/react-native`.
- **Item 4, Docker: done.** `docker build -t drinkme-server:autorun .` OK (400 MB). The image holds only server.js, the package files and node_modules, with multer 2.5.0. A production start without secrets refuses with the expected FATAL line. A development start (`NODE_ENV=development`, `ALLOW_INSECURE_DEV_AUTH=true`, random JWT_SECRET, no service account) on port 8099 answered `/healthz` with `{"status":"ok"}`; the container was stopped and removed. Not tested: a production start with a real service account. The image `drinkme-server:autorun` stays local (`docker image rm drinkme-server:autorun` removes it).
- **Item 2, .gitignore:** added `*firebase-adminsdk*.json`, `**/serviceAccount*.json`, `server/backups/` and `.claude/worktrees/`. `git check-ignore` confirms .env, server/.env, server/serviceAccount.json, server/data/db.json and an adminsdk file name are ignored. None was ever in git history; nothing was staged.
- **Item 8: done.** `docs/JOHN_TODO.md`: device checks (sign-in for every provider first, then lists and images, with expected results), the real-Firebase test steps for `REQUIRE_VERIFIED_EMAIL`, key rotation, hosting and database, store accounts and policy (including Apple 4.8: Sign in with Apple is required on iOS when Google sign-in is offered), legal review. New finding: the root `.env` defines `ANTHROPIC_API_KEY` (name seen in Expo's env output; the file was not read). It is not bundled (no EXPO_PUBLIC_ prefix) but does not belong there.
- **Not committed by this run:** `memory.md`, `codex.memory.md`, `agents/`, `.vscode/`, `.claude/worktrees/`. This run did not make them and they are not in John's commit list.
- Next: commits, then items 5 and 6, then 7, then Tiers 3 to 6.

## Final state (2026-11-10)
`npm test` 975 of 975 pass, 0 fail, exit 0, run on the final code. `npm run typecheck` 0 errors. `npm run lint` 16 problems (0 errors, 16 warnings). `node --check server/server.js` OK. `server/data` holds only `db.json`, unchanged by stat since 2026-06-16. Nothing committed: branch `auto/run-2026-10-30` is still at `561f4ce`.

## External docs to correct (off limits for this run; John decides)
- `D:\DrinkMeApp\SECURITY.md`: UID mismatch returns 401, not 403. Uploads are checked by byte signature, posts up to 7 MB and avatars 2 MB, not "multer 8 MB". The JSON limit is 100 KB by default, 10 MB only on `POST /api/drinks` and 3 MB on avatars. SEC-A is now plain-text storage, so a web client must encode on output. SEC-G is done, via `POST /api/users/:id/delete-account`. Missing entries: server-side age gate, reports, blocks and moderation, partner consent, backup retention, `REQUIRE_VERIFIED_EMAIL` off with the takeover gap open, multer 1.x DoS.
- `D:\DrinkMeApp\DEPLOY.md`: `railway up` from `server/` no longer matches the root Dockerfile build. Variables missing: `FIREBASE_SERVICE_ACCOUNT_KEY` as JSON, `TRUST_PROXY_HOPS`, `ADMIN_USER_IDS`, `ALLOW_EMPTY_DB` (first deploy only), `DB_FILE` and a volume, `CORRUPT_BACKUP_RETENTION_DAYS`. It sets `OPENAI_API_KEY` without `AI_ENABLED`, and `PORT=5000` while the image uses 8080. "db.json resets, acceptable for beta" ignores that production refuses to start without a database file. Old path `C:\Users\Aron\DrinkMeFinal`. Says `serviceAccount.json` instead of the JSON variable.
- `D:\DrinkMeApp\BETA_CHECKLIST.md`: FEAT-2 (delete post) and FEAT-4 (report and block) are done. Missing: age gate, account deletion, privacy notice, partner consent, email verification (off), paging.
- `D:\DrinkMeApp\QA_CHECKLIST.md`: the feed is paged, and alcoholic posts are hidden until the age gate is confirmed. Partners now go request, accept, then feed. A `.pdf` upload gets 400 from the signature check. Missing flows: age gate, notice, name prompt, report and block, Blocked Users, delete post and comment, delete account, partner requests, Load more, session error screen, verify email.
- `D:\DrinkMeApp\TECHNICAL_REFERENCE.md`: lists CreatePost as `fullScreenModal`; lists routes that do not exist (`POST /api/drink-partners`, `PUT /api/drinks/:id`, `GET /api/notifications/count`, `PATCH /api/notifications/read-all`, `PUT /api/smart-bar/:id`, `?userId=` on `/api/drinks`); misses all new routes.

## Baseline before any change
- `npm run typecheck`: 2 errors, `agents/orchestrator.ts:2` (TS5097) and `src/navigation/AppNavigator.tsx:114` (TS2322).
- `npm run lint`: 19 problems (2 errors, 17 warnings). Both errors are in `metro-proxy.js` (`Buffer` undefined).
- `node --check server/server.js`: OK.
- `git` and `node` are not on this session's PATH. Commands use `/c/Program Files/nodejs` and `/c/Program Files/Git/cmd`, added per command. System settings were not changed.

## Backlog (code only, in priority order)
### Tiers 3 to 6: adopted plan (planner spec, approved by the lead on 2026-11-11)
Developer tasks, one at a time; the full server suite after every server task:

| # | Task | Items | Security review |
|---|---|---|---|
| A | QA security tests (`qa-security.test.js`) and an API-vs-QA review table | T3-1, T3-3 | no |
| B | saveDb/read retry backoff (6 tries, 25 to 400 ms) and the flaky deletion test | EPERM | light |
| C | Typed navigation (`src/navigation/types.ts`; fixes the `PartnersList` param mismatch) | T4-4 | no |
| D | Idempotent cheer/save with server rollback; shared `useDrinkToggles` with optimistic updates; empty `onCheer` on Profile and SmartBar fixed | T4-5 | yes |
| E | Drink category (`tags: [category]`) and server-side Explore filters | found earlier | yes |
| F | Edit post, `PUT /api/drinks/:id` (no image change; 409 while auto-hidden; suspension, ownership, age and size rules; `editedAt`) | T4-6 | yes |
| G | Notifications rendered in ro/en at read time (`params`) | found earlier | yes |
| H | Audit log: GDPR-minimal, 90 days, 20,000 cap, covered by account deletion, `GET /api/admin/audit` | T6-1 | yes |
| I | Error boundary; PartnersList refresh error | T4-1, T4-2 | no |
| J | Forgot password (Firebase web SDK, neutral message, 60 s cooldown); AuthScreen localization and Firebase error-code mapping | T4-3 | yes |
| K | Remaining hardcoded strings; shared `formatTimeAgo` | found earlier | no |
| L | Lint warnings to 0 without behaviour change | T4-7 | no |
| M | Route-coverage guard and gap tests | T5-1 | no |
| N | Docs: `npm run check` and QA checklists, jest-expo proposal in this log, skills, README, external docs | T3-2, T5-2 | no |

- **T6-2 (weekly top 10) dropped:** cheers have no timestamps (new personal data needed), cheers can be inflated by fake accounts, a ranked chart of alcoholic posts needs a store-policy and product decision, and the cheap version is just trending with a date window. If John wants it: `?since=7d` on trending, with his OK.
- Defaults adopted: image not editable; no edit history; edits allowed while a post has reports below the hide threshold (refusing would tell the owner they were reported); categories `cocktail`, `wine`, `beer`, `spirits` / `mocktail`, `coffee`, `tea`, `other`; audit retention 90 days; notice sentences go into the unreleased version 2.
- **Open for John:** a password reset does not end the 30-day server JWT. Ending it needs a `tokensValidAfterTime` check (one Firebase call per sign-in) and a `sessionGen` bump.

### Tier 1: security and npm audit
| ID | Item | Source |
|---|---|---|
| T1-1 | Configurable DB file path (`DB_FILE` env), plus `node:test` harness on a separate port with temp data | Run prerequisite |
| T1-2 | Production guard: refuse to start without `JWT_SECRET` or Firebase Admin; remove the hardcoded secret fallback and client-uid trust in production | `server.js:18`, `:476` |
| T1-3 | `/api/auth/mobile`: use the verified token email, not the request body; validate `displayName` and `photoURL` | `server.js:458`, `:482` |
| T1-4 | Saved-drinks IDOR: any signed-in user can read another user's saved posts | `server.js:745` |
| T1-5 | Stop exposing other users' emails (search, profile, partners, feed, comments) and update client fallbacks | `server.js:504`, `:510`, `:433` |
| T1-6 | Search is unauthenticated, and null-user requests write a `null` key into partner state | `server.js:491`, `:521`, `:613` |
| T1-7 | Avatar: allow JPEG/PNG/WebP only with magic-byte check; tighten `validateImage` raw base64 path | Audit finding, `server.js:552`, `:386` |
| T1-8 | Server-side AI flag: AI routes return 503 before multer runs; `upload.single`; MIME allowlist; AI stays disabled | Audit finding, `server.js:879` |
| T1-9 | Smart Bar inputs not sanitized; dummy items seeded for every new user | `server.js:780`, `:322` |
| T1-10 | Atomic `saveDb` (temp file, then rename) | DATA-1 mitigation |
| T1-11 | `.dockerignore` (keeps secrets out of images); Dockerfile Node 22, `--omit=dev` | Audit finding |

### Tier 2: beta blockers and bugs
| ID | Item | Source |
|---|---|---|
| T2-14 | **Fix before any deployment; do first in Tier 2.** The DB size guard counts characters, but startup fails on bytes: a DB with non-ASCII text can save normally past 536.87M bytes, then the server refuses to start until the file is repaired by hand (reproduced; file stays intact). Guard on bytes. Also: cap Smart Bar items per user (about 500), and drop a half emoji at the text cut rather than storing U+FFFD. Not done in T1-7 because that item used its 3 fix loops | T1-7 final security check |
| T2-15 | `ExploreScreen.tsx` appears to swap two error keys: save uses `partnerFailed` (about line 201), partner uses `saveFailed` (about line 220). From a grep, not run | T1-7 developer |
| T2-1 | Fix baseline typecheck and lint errors | Baseline above |
| T2-2 | Age gate, stored and enforced on the server. Must also cover AI recipes: without confirmation, recipe routes return mocktails only | Alcohol policy rule 1, T1-8 reviews |
| T2-3 | Report content and block user | Alcohol policy rule 4, FEAT-4 |
| T2-4 | Delete own post, server and client (docs list the route, code has none). Deleting must not reset the post limits, which are derived from existing posts: keep lightweight per-user post timestamps | FEAT-2, T1-7 re-review |
| T2-5 | Account deletion, including Firebase user | SEC-G, policy rule 6 |
| T2-6 | `validator.escape` output shown literally in RN (`&#x27;`), and `slice` can cut an entity in half. T1-3 extends this to sign-in names | `server.js:140` |
| T2-8 | Clear the React Query cache on logout. User B signing in on the same device can see user A's cached feed for up to 2 minutes (from a code read, not run) | T1-6 code review |
| T2-9 | First sign-in race: `setServerUserId` runs before the JWT exchange, so a returning user can see a false empty feed. Home also shows a failed feed as an empty one; add an error state with retry. Also: any failed token exchange, including a 507, leaves the user looking signed in with no JWT. Add a session error with retry (`AuthContext.tsx:90`, `:137`) | T1-6 code review, T1-7 re-review |
| T2-10 | Paginate `GET /api/drinks` and other feeds, and comments. Today one logged-out request returns every post with its base64 image and author. Avatars repeat on every item: 224 comments by 8 accounts with 2 MB avatars made a logged-out comments request return 500 (run). Also stop repeating data-URL avatars. Needs a client change. Do this before any public deployment | T1-6 security review, T1-7 re-review |
| T2-11 | After sign-up: prompt for a name (email sign-ups now start without one and appear as "DrinkMe user") and show a privacy notice saying what is public | T1-5 reviews |
| T2-12 | Own posts and comments on Profile and Saved should use the signed-in user's `profile` as author, matching Home and Explore | T1-5 code review |
| T2-13 | Partner list is readable without login, and `POST /api/drink-partners/:targetId` adds both sides without the target's consent. Restrict the list to the owner and their partners, handle 403 on the client, and add a request-and-accept step. Product decision taken as the safest option; John can reverse it | T1-4 security review, policy rule 6 |
| T2-7 | Email verification for password accounts, on client and server. Without it, an attacker could register someone's address first and keep a valid 30-day JWT if the owner later signs in with Google (not tested against Firebase). Needs a sign-up step, so build it behind a flag and let John decide on enforcing it before public launch | T1-3 security review |

### Tier 3: QA checklist gaps
| ID | Item | Source |
|---|---|---|
| T3-1 | Automate the QA security section (401, 403, long text, non-image upload) | `D:\DrinkMeApp\QA_CHECKLIST.md` |
| T3-2 | Project `QA_CHECKLIST.md` references `npm run check`, which does not exist | Project QA checklist |
| T3-3 | Review API behavior against remaining QA flows | QA checklists |

### Tier 4: robustness and UX
| ID | Item | Source |
|---|---|---|
| T4-1 | Global error boundary | ROB-1 |
| T4-2 | PartnersList error state | ROB-3 |
| T4-3 | Forgot password | FEAT-1 |
| T4-4 | Typed navigation props | ARCH-3 |
| T4-5 | Optimistic like and save | FEAT-7 |
| T4-6 | Edit post | FEAT-3 |
| T4-7 | Clean up remaining lint warnings | Baseline above |

### Tier 5: test coverage
- T5-1: `node:test` coverage for every API route.
- T5-2: jest-expo tests as a written proposal in this log (no files added).

### Tier 6: small future-release items
- T6-1: Audit log for sensitive actions (SEC-H).
- T6-2: Top 10 weekly endpoint, only if it stays small and low-risk.

## npm audit results (security-reviewer)
Run on Node 22.23.4 and npm 10.9.9, read-only. Bundle reachability comes from static analysis, not a built bundle.

| Tree | Critical | High | Moderate | Low | Total |
|---|---|---|---|---|---|
| Root, all deps | 4 | 20 | 11 | 9 | 44 |
| Root, `--omit=dev` | 4 | 16 | 9 | 8 | 37 |
| Server, working tree | 0 | 0 | 0 | 0 | 0 (false negative, see multer) |
| Server, committed lockfile | 1 | 7 | 9 | 0 | 17 |

Re-run read-only during Tier 2, without this run installing anything: root, all deps 74 (4 critical, 20 high, 47 moderate, 3 low); server, working tree 6 moderate, all transitive (`gaxios`, `gcp-metadata`, `glob`, `google-gax`, `minimatch`, `rimraf`). These 6 were not triaged for reachability, and neither were the additional root moderates. The triage below is from the first run.

**Affects DrinkMe**
- `multer@1.4.5-lts.2`: 10 high DoS advisories that `npm audit` misses because of the prerelease-style version. Reachable by any signed-up user at `server.js:542` and `:879`. Fix: `multer@^2.5.0`.

**Conditional**
- Committed `server/package-lock.json`: any deploy built from git ships the 17 vulnerabilities until an updated lockfile is committed.
- `ws`, `compression`: LAN attacker while Metro runs. Stop Metro on untrusted networks.
- `decode-uri-component`: only if a navigation `linking` config is added. Update React Navigation first.

**Not affected in the shipped app**
- `protobufjs`, `@grpc/grpc-js`, `websocket-driver`: Firestore and Database code is never imported.
- `shell-quote`, `tar`, `undici`, `node-forge`, `@xmldom/xmldom`, and other build or dev tooling.

**Accepted risk (no safe fix in range):** `postcss`, `image-size`, `deepmerge`, part of `@grpc/grpc-js`, `esbuild`, `zod`.

**Do not apply:** `npm audit fix --force`, or a bare `npm update`. Audit's suggested fixes (`expo@51`, `expo-constants@58`, `expo-auth-session@58`) break SDK 54 or the pins. Bare `npm update` can move `react-native-worklets`, because `package.json` has `^0.5.1`.

## BLOCKED (needs John)
| What | Why | Tried | Action for John |
|---|---|---|---|
| multer upgrade | Needs an install | Reviewed only; code stays compatible with both versions where possible | Run the multer commands below, then retest avatar upload |
| Uncommitted `package-lock.json` and `server/package-lock.json` | Not made by this run. They were modified before it started, and they are what makes the server audit clean | Left untouched | Review and commit them with the multer change |
| Root dependency bumps | Needs `npm update` | Commands prepared | Run the root commands below |
| `@jackchen_me/open-multi-agent` in root devDependencies | Dependency change; source of the `zod` and `openai` findings | Not changed | Move it to a separate `agents/package.json` |
| Remove NativeWind and Tailwind (ARCH-2) | Needs uninstall | Not changed | Decide, then `npm uninstall nativewind tailwindcss` and check `babel.config.js` and `tailwind.config.js` |
| `react-native-worklets` is `^0.5.1`, rule says `0.5.1` | Version change is off limits for this run | Not changed | Decide whether to pin it exactly |
| Avatar resizing with `expo-image-manipulator` | New dependency. It is the only reliable way to keep camera photos under the 2 MB avatar cap | `quality: 0.5` applied as a best-effort fix | Decide whether to install it; test a 12 MP Android photo as an avatar either way |
| Do posted photos keep GPS location? | Needs a real geotagged photo on a phone. Images are public, so GPS data would expose home locations (GDPR) | Not verified: the picker's EXIF behaviour was not confirmed | Post a geotagged photo on iOS and Android and inspect the stored image. If GPS survives, tell the next run to strip it |
| OpenAI key rotation, Maps key restriction (SEC-C, SEC-6, SEC-7) | External console | Not attempted | Rotate and restrict in the consoles |
| Real database, deploy, HTTPS, Cloudinary (DATA-1, INFRA-1, SEC-D, SEC-E) | External accounts | Not attempted | Choose providers and create accounts |
| Apple Sign-In, App Check, billing, native Firebase files, EAS builds (FB-3, FB-6, GP-2, GP-3, CFG-3) | External consoles and payment | Not attempted | Complete in the consoles |
| Manual device checks in the QA checklists | Needs a phone | Not attempted | Run after reviewing the diff |
| Literal key values in `D:\DrinkMeApp\` docs | Those docs are off limits for this run, apart from marking items done | Not changed | Replace values with placeholders |

## Decisions for John before launch (run defaults apply until then)
- Who reviews reports, and through what contact route? No default exists: the code only provides the tools (T2-3). Settle this before any store release.
- Should a repeat offender be suspendable? Not built: an operator can remove a post or comment and clear a profile, but the account keeps working. A reviewer recalls, from memory and unchecked, that Apple guideline 1.2 expects offending users to be removed. Check it before release.
- Should logged-out users keep reading profiles and non-alcoholic posts? Default: yes. It weakens blocks, and the privacy notice discloses it.
- Is 30-day backup retention acceptable (T2-5)? Default: 30 days, with users told "within 40 days". It reverses T1-10's "backups are never deleted", and recovery from a corrupt DB must then happen within 30 days. **Your migration backup from the first start also expires after 30 days.**
- When should `REQUIRE_VERIFIED_EMAIL` be turned on (T2-7)? Default: off. **With it off, the takeover stays fully open** in the stub: someone registering another person's address keeps a working JWT after the owner signs in with Google, can read the owner's email and edit the profile for up to 30 days. Enforce before public launch, or approve invalidating such JWTs with the flag off too. First test on a real Firebase project whether a Google relink removes the password and revokes its refresh tokens, and check the "one account per email" console setting.
- Should a lawyer review the privacy notice? The text is not legal advice and was not reviewed by one.

## Rule breaches
- **T2-14 security reviewer ran one recursive search on `server/` with a file glob,** against its brief. The glob could match `server/data/db.json` and `server/serviceAccount.json`. Both are gitignored and ripgrep skips ignored files by default, so they were most likely not scanned, but this cannot be proven. The 50 lines returned came only from `server.js` and `server/test/`, so no content from either file reached any report. `db.json` is unchanged by stat.
- **T1-7 developer briefly edited the real `server/server.js` for a mutation run,** then restored it and confirmed the bytes matched with `cmp`. No listed rule was broken and a security re-review found no leftover change, but there is no git baseline for this uncommitted file, so later mutation runs use scratch copies only.
- **T1-5 developer read `server/data/db.json`.** It ran `grep -rnE "leakcheck" server/data | wc -l` as a verification step, which read the real file's contents, against the brief and your instruction not to touch that file. Only the count `0` was output, so no contents reached the logs. The file's size and modified time are unchanged. The command was unnecessary and its result is not used as evidence. Later briefs now forbid any recursive search that includes `server/data`.

## Decisions/assumptions
- T1-8 decisions:
  - **Do not set `AI_ENABLED=true` anywhere real users can reach until all of these are done:** the age gate covers AI recipes (T2-2; both reviewers rated its absence a BLOCKER once AI is on, and this run kept it as a condition because AI ships off and the gap is app-wide); a global daily AI cap and a hard monthly budget in the OpenAI dashboard (estimated exposure is about $58 per month per user, about $1,150 per month per IP at the limits, not run, prices from memory); a privacy disclosure and data agreement for photos sent to OpenAI; one real OpenAI call, since only a local mock has been used; a rebuilt scanner screen (`ScannerScreen.tsx:103` returns null when AI is on).
  - Recipe content: non-alcoholic input now gets mocktails only. Other requests include at least one mocktail. An unknown product counts as alcoholic.
  - HEIC is refused for AI scans, based on the reviewer's and developer's memory of OpenAI's accepted formats, not checked against current docs.
- T1-7 decisions (limit values are proposals, not tested against real usage; John can change them):
  - Storage limits: new images are refused above 200 MB in total (507), above 100 MB per user for all time (507), and above 20 posts or 50 MB per user per rolling 24 hours (429). Non-image actions keep working. Lowered from 300 MB because at that size every save blocks the whole server for about 1.5 s (measured). Bytes here means stored data-URL length, so about three quarters of that in image data.
  - Text limits: growth routes (comment, Smart Bar add, new user) return 507 once the saved DB passes 450 million characters; each user keeps the newest 200 notifications; 200 comments per user per rolling 24 hours; control characters are stripped from text, newlines kept. Existing users' sign-in and toggles keep working at the limit.
  - The post image cap drops from 8 MB to 7 MB. 8 MB could never be reached, because the 10 MB JSON limit stops it first.
  - After a failed save, creates are rolled back (post, avatar, comment, Smart Bar add), because they cause duplicates and memory growth. Toggles and profile edits are not rolled back: a retry of like, save or partner can undo the change. This is accepted until DATA-1.
  - Avatars: picker quality lowered to 0.5, with clear ro and en errors. This is best effort; only resizing guarantees the size, and that needs a new dependency.
  - T2-10 (pagination) should come before any public deployment: one avatar repeats on every feed post, so an estimated 190 tiny posts could produce a feed of about 530 MB (not run).
- The planner specs each tier as one document, and each backlog item then gets its own developer and review cycle. Reason: the items share `server/server.js` and must be done in sequence.
- Pre-existing uncommitted and untracked files are not part of this run. To revert a failed item, only that item's own edits are undone, never `git checkout --` on a file that had earlier changes.
- The docs-writer runs once at the end of each tier rather than after each item, because items in a tier change the same doc sections. Tier 1 docs are done: `server/README.md`, `CLAUDE.md` and both project skills now match the code, including several routes that were listed but do not exist, and others that were missing. `CLAUDE.md` and `.claude/` are untracked, so `git diff main` does not show these edits: `git add` them when you commit. The T2-14 size guard and Smart Bar cap go in the Tier 2 docs pass.
- T1-1 tests assume `server/.env` does not set `DB_FILE`; that file was not read. If it did, a normal server start would use that path.
- T1-4 follow-up decisions:
  - A developer added a stored `retiredEmailPrefixes` field that was not requested. Security review rated it a BLOCKER under GDPR data minimization, so it is being removed.
  - Sign-in no longer refills an existing user's empty name from the provider. Such a user appears as "DrinkMe user" until they edit their profile (T2-11 covers the prompt).
- T1-5 decisions:
  - Old notifications stored before this change can still contain a sender's email or email prefix. They are not rewritten and expire after 7 days. Nothing is deployed, so this is accepted. Before sharing an existing DB with other people, wait 7 days.
  - Stories are verified by reading the code only: `stories` is always empty, so a test cannot exercise that route.
  - Logged-out access to `GET /api/users/:id` stays, like the partner graph. Decide on both before public launch.
- T1-6 decisions:
  - `TRUST_PROXY_HOPS` defaults to 0, replacing the hardcoded 1. **Before deploying**, set it to the real hop count of the host (not verified for Railway or Render), or all users behind the proxy will share one rate-limit bucket.
  - Tokens for a uid not in the database now count as logged out. The client re-exchanges its token on launch.
  - User search needs at least 2 characters, with 60 searches per 15 minutes per account.
  - The global limit of 100 requests per 15 minutes per IP is unchanged but looks tight for normal app use and for users sharing an IP. Check it during beta.
- T1-3 decisions:
  - Provider avatars are accepted only from Google's photo hosts (`*.googleusercontent.com`), because other users' phones load these URLs. Apple sign-in is not enabled, so no Apple host is listed. Check this against real Google sign-ins.
  - The old public default `JWT_SECRET` is refused in every environment. If `server/.env` still has it, the local server will not start until you replace it.
  - `user.emailVerified` is stored but does not block sign-in yet (see T2-7).
- T1-2 hardening decisions:
  - Any `NODE_ENV` other than `development` or `test` counts as production, including unset. If your local `server/.env` does not set one of those (not read), the local server will apply production rules.
  - Client-uid sign-in without Firebase now needs `ALLOW_INSECURE_DEV_AUTH=true`, even in development.
  - In production, a corrupt DB exits after backing up, unless `ALLOW_EMPTY_DB=true`.
  - JWT algorithm pinned to HS256. `issuer` was not added, because it would log out existing users.
- Tier 1 spec assumptions, approved by the lead:
  - `GET /api/users/:id`, `/api/users/:id/partners`, drink GETs and comment GETs stay public but without email. The social graph therefore stays publicly readable; requiring sign-in there is a follow-up for John to decide.
  - `/api/drinks/partners` returns 401 when logged out. UID mismatch stays 401, as in the code (the backend skill says 403).
  - Dummy Smart Bar items already stored for existing users stay; new users start empty.
  - HEIC stays allowed for posts and is rejected for avatars. An uploaded avatar takes priority over the provider photo at login.
  - AI upload field is named `image`. Re-enabling AI will need both the client flag and a new `AI_ENABLED` server env var.
  - Production `JWT_SECRET` minimum is 32 characters. Tests use `node:test` and `fetch` only. `server/package.json` gets a `test` script and nothing else.
- The security-reviewer asked five questions, and I chose the safest answer to each. Dockerfile and git deploys are both hardened; the lockfiles stay as they are; ngrok stays; the worklets range stays; NativeWind stays.

## Commands for John to run
Before the next local backend run, check that `server/.env` contains `NODE_ENV=development` (this run did not read the file), and start the server from the `server/` folder. Otherwise it applies production rules and may refuse to start. Add `ALLOW_INSECURE_DEV_AUTH=true` only if running without a Firebase key. Then confirm the log shows `[db] Loaded`. The first start also migrates your existing database once, so expect `[db] Migrated to schema version 2 (plain text). Previous file saved to ...pre-migration-<timestamp>` just before it. Keep that backup until you have checked the app. Do not go back to older code afterwards without restoring it.

In `D:\DrinkMeApp\DrinkMeFinal\server`:
```
npm install multer@^2.5.0
npm ls multer
node server.js
```
`npm audit` cannot confirm this fix, so check the version with `npm ls multer`.

In `D:\DrinkMeApp\DrinkMeFinal`, one group at a time:
```
npm update expo
npm update tar undici node-forge compression shell-quote ws @xmldom/xmldom js-yaml brace-expansion browserslist baseline-browser-mapping source-map-js postcss-selector-parser nanoid protobufjs @protobufjs/utf8 @grpc/grpc-js websocket-driver form-data @babel/core @humanfs/node
```
Optional and riskiest, so test every screen afterwards:
```
npm update @react-navigation/native @react-navigation/stack @react-navigation/bottom-tabs
```
After each group:
```
npm ls react-native-reanimated react-native-worklets expo-auth-session expo-apple-authentication expo react-native react
npm run typecheck
npx expo-doctor
npx expo start
git diff package.json
```
`git diff package.json` should show no changes.
