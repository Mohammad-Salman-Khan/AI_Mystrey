# AI Mystery Room

A fictional, AI-generated investigation game. The React client talks only to the Express API; Gemini credentials stay on the server.

## Run locally

1. Install Node.js 20+ and MongoDB.
2. Copy `.env.example` to `.env` and add a Google Gemini API key.
3. Run `npm install`, then `npm run dev` from the repository root.
4. Open `http://localhost:5173`.

Set `GEMINI_API_KEY` and `MONGODB_URI` to enable case generation and persistence. If Node's default resolver cannot resolve Atlas SRV records, set `DNS_SERVERS=8.8.8.8` (or a comma-separated resolver list); the API applies it before loading Mongoose. Image generation is not configured. Camera logs are text simulations and are labeled accordingly.

## Build

Run `npm run build` from the root. The API listens on port 4000 by default; Vite serves the client on port 5173.
