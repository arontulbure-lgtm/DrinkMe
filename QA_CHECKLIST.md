# DrinkMe Mobile QA Checklist (Phase 2)

> Short English version. The full, current checklist (Romanian), with every flow, expected results and the map from each section to the automated server tests, is `D:\DrinkMeApp\QA_CHECKLIST.md`. Device steps with expected results: `docs/JOHN_TODO.md`, section 1. (auto: file) marks a line whose server side has a test in `server/test/`.

## Smoke Tests
- [ ] Launch app on iOS/Android, verify dark theme header flush with status bar.
- [ ] Authenticate with email/password (sign-in & sign-up) using Firebase test users; first run shows the age gate, the privacy notice and the name prompt, a relogin does not (auto: qa-flows).
- [ ] Forgot password: the same neutral confirmation for a real and an unknown email; about 60 s before sending again; wrong password and unknown email show the same sign-in error.
- [ ] Switch between tabs (Home, Explore, Scanner, Smart Bar, Profile) without crashes.
- [ ] Change app language from Profile ▸ Settings ▸ App language and confirm copy updates across home/auth flows.

## Home & Explore
- [ ] Home shows your own and your partners' posts (stories are off); Explore contains the discovery feed (auto: qa-flows).
- [ ] Explore chips: All, Non-alcoholic and one per category (Cocktail, Wine, Beer, Spirits, Mocktail, Coffee, Tea, Other) show only matching posts; search results (auto: categories, qa-flows).
- [ ] Pull-to-refresh on Home updates partner feed without duplicate requests.
- [ ] Cheers icon (two glasses) toggles state and count updates, also on rapid taps (auto: toggles, qa-flows).

## Posting & Interactions
- [ ] Create a post with required photo, name, description, rating, optional location and category; verify failure when photo missing (auto: categories, images).
- [ ] Edit your own post from its actions menu (text, rating, flag, category; not the image); it shows "edited" (auto: edit-post).
- [ ] Cheer / Save a drink from feed and ensure state persists after refresh (auto: qa-flows, toggles).
- [ ] Add a comment to a drink detail view, confirm it appears for other users, and notifications are created for the author, in the app's language (auto: qa-flows, notifications-i18n).
- [ ] Open drink detail, verify metadata and quick actions (like/save/scan).

## Smart Bar
- [ ] Add an inventory item (name + quantity) and remove it (auto: smart-bar).
- [ ] Switch to "Saved posts" tab, confirm saved drinks list updates after saving from feed.
- [ ] Saved posts show cheers count badge.

## Scanner & AI Flow
- [ ] AI is off for beta: the Scanner tab and the Smart Bar Recipes tab show a "Coming soon" preview (ro/en); the AI routes answer 503 `ai_disabled` (auto: ai-routes, qa-security).

## Profile & Partners
- [ ] Update profile fields (first name, last name, city, bio) and verify data refresh.
- [ ] Trigger logout dialog and ensure session clears.
- [ ] Search for a user in Explore, send a partner request, accept it on the other account, then remove; confirm partner feed + notification updates (auto: partners, qa-flows).

## Regression / Backend
- [ ] Run `npm run check` (typecheck + lint): 0 errors.
- [ ] Run the server tests: `cd server`, then `npm test` (about 14 minutes, port 5055, one run at a time). A new route must be in `ROUTE_MANIFEST` (`server/test/helpers/routes.js`) or `route-coverage.test.js` fails.
- [ ] Start the local server (`node server.js` in `server/`, with `NODE_ENV=development`) and verify `/healthz` answers and signed-in requests to `/api/drinks` and `/api/smart-bar` respond (auth required) (auto: qa-flows).
