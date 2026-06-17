# DrinkMe Mobile – Modification Summary

_Last updated: MVP Hardening prep_

## MVP Hardening Updates
- Standardized on the TypeScript entrypoint (`App.tsx`), enabled NativeWind tooling, and expanded auth context to expose backend user ids for REST lookups.
- Refreshed client scripts (`npm run typecheck`, `npm run lint`), added `.env.example`, tightened `.gitignore`, and documented setup in the new root README.
- Rehomed the mock API under `server/` with ESM modules, helmet, rate limiting, CORS allowlist, request logging, health checks, and per-endpoint input validation.
- Introduced deployment scaffolding (`eas.json`, Dockerfile) plus server/package metadata and environment templates to support release builds.

## Infrastructure & Platform
- Centralized API client with automatic base URL resolution and token injection (`src/lib/api.ts`).
- Localization provider (AsyncStorage-backed) wrapping the app with multi-language support and language selector screen.
- Expo/Firebase auth bridge maps demo accounts (`alex|ana|dragos@drinkme.app`) to backend user ids for deterministic QA.

## Navigation & UI
- Dark theme enforced via custom navigation theme; SafeArea adjustments for notch devices.
- Tab stack registers auxiliary screens: drink detail, comment modal, recipe results, language settings, create post.
- Header actions include notification center with unread badge and modal feed (auto-cleanup after seven days).

## Feature Modules
- Home: partner-only feed, stories, cheer interactions, notification panel.
- Explore: global discovery list, user search with partner toggle, filters, trending & discovery cards.
- Drink Detail: hero media, cheers/save actions, threaded comments with composer.
- Create Post: mandatory photo picker + preview, form reset after submit.
- Smart Bar: saved posts show cheers badge; inventory CRUD wired to API.
- Profile: localization-aware stats, language chooser, drink partner count.

## Backend Stub (server.js)
- Mock data for drinks (images, partner flags), comments, notifications, drink partner graph.
- Endpoints: auth exchange, drinks CRUD (cheers, comments, save), partner management, notifications, smart bar.
- Notifications auto-prune (7 days), include types (cheer/comment/partner).

## Assets & Docs
- QA checklist expanded for language switching, comments, partner flows, notifications.
- Launch plan updated with Phase 2 compliance checklist.

## Testing Hooks
- `npm run check` (TypeScript) and local Express server for offline end-to-end validation.

> Keep this summary for future phases; once new work starts, append incremental notes rather than rewriting history.
