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

## Running the Server
```bash
cd server
npm install
npm start
```
The mock API listens on `PORT` (default `5000`). Configure additional values via `server/.env`.

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

### Server (`server/.env`)
- `PORT`
- `OPENAI_API_KEY`
- `CORS_ALLOWED_ORIGINS`

## Privacy
Add a link to the production privacy policy before launch.
