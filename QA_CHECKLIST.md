# DrinkMe Mobile QA Checklist (Phase 2)

## Smoke Tests
- [ ] Launch app on iOS/Android, verify dark theme header flush with status bar.
- [ ] Authenticate with email/password (sign-in & sign-up) using Firebase test users.
- [ ] Switch between tabs (Home, Explore, Scanner, Smart Bar, Profile) without crashes.
- [ ] Change app language from Profile ▸ Settings ▸ App language and confirm copy updates across home/auth flows.

## Home & Explore
- [ ] Home shows only drink partners feed (stories + posts); Explore contains discovery feed.
- [ ] Validate Explore quick filters (All/Cocktails/Wine/Beer/Non-alcoholic) and search results.
- [ ] Pull-to-refresh on Home updates partner feed without duplicate requests.
- [ ] Cheers icon (two glasses) toggles state and count updates.

## Posting & Interactions
- [ ] Create a post with required photo, name, description, rating, optional location; verify failure when photo missing.
- [ ] Cheer / Save a drink from feed and ensure state persists after refresh.
- [ ] Add a comment to a drink detail view, confirm it appears for other users, and notifications are created for the author.
- [ ] Open drink detail, verify metadata and quick actions (like/save/scan).

## Smart Bar
- [ ] Add an inventory item (name + quantity) and remove it.
- [ ] Switch to "Saved posts" tab, confirm saved drinks list updates after saving from feed.
- [ ] Saved posts show cheers count badge.

## Scanner & AI Flow
- [ ] Pick image from gallery; app requests permission once and handles denial gracefully.
- [ ] Ensure modal appears on successful detection and recipe generation navigates to results.
- [ ] Test recipe modal dismissal and scanner reset button.

## Profile & Partners
- [ ] Update profile fields (first name, last name, city, bio) and verify data refresh.
- [ ] Trigger logout dialog and ensure session clears.
- [ ] Search for a user in Explore, add/remove as drink partner, and confirm partner feed + notification updates.

## Regression / Backend
- [ ] Run `npm run check` to validate TypeScript builds cleanly.
- [ ] Start local Express stub (`node server.js`) and verify endpoints respond (`/api/drinks`, `/api/smart-bar`).
