# DrinkMe Mobile MVP

## Prerequisites
- Node.js 20+
- npm 10+
- Expo CLI (`npx expo --version`)

## Setup
1. Copy `.env.example` to `.env` and fill in the public Expo env vars (e.g. `EXPO_PUBLIC_API_URL`).
2. Install dependencies:
   ```bash
   npm install
   ```

## Running the App
```bash
npm start
```
Then follow the Expo prompts for iOS, Android, or web.

## Checks
```bash
npm run check        # typecheck + lint (client); same as npm run typecheck && npm run lint
```
Server tests are separate and slow (about 14 minutes, port 5055, one run at a time): `cd server`, then `npm test`. The client has no test framework yet.

## Running the Server
```bash
cd server
npm install
npm start
```
The Express API listens on `PORT` (default `5000`). `server/.env` must set `NODE_ENV=development` locally; otherwise production rules apply. Every variable, the routes and operations (backups, moderation, audit log) are in `server/README.md`.

## Building Mobile Clients
- Development build: `npx expo run:android` or `npx expo run:ios`
- Cloud build: `eas build -p android` (see `eas.json` for profiles)

## Environment Variables
### Client (`.env`)
- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_FIREBASE_API_KEY`
- `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `EXPO_PUBLIC_FIREBASE_PROJECT_ID`
- `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `EXPO_PUBLIC_FIREBASE_APP_ID`
- `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`

- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`

### Server (`server/.env`)
- `NODE_ENV`, `PORT`, `JWT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_KEY`, `CORS_ALLOWED_ORIGINS`, `ADMIN_USER_IDS`
- Optional: `OPENAI_API_KEY` (AI stays off unless `AI_ENABLED=true`). Full list: `server/README.md`.

## Privacy
Add a link to the production privacy policy before launch.
