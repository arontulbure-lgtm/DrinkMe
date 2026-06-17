# DrinkMe Mock API Server

## Prerequisites
- Node.js 20+

## Setup
```bash
cd server
npm install
```

## Running
```bash
npm start
```

The server listens on `PORT` (default `5000`). Configure environment variables in `.env` (see `.env.example`).

## Environment Variables
- `PORT`: Port to listen on.
- `OPENAI_API_KEY`: Required for AI detection and recipe generation.
- `CORS_ALLOWED_ORIGINS`: Comma-separated production allowlist origins.
