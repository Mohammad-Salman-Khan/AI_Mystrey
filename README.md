# AI Mystery Room

A fictional, AI-generated investigation game. The React client talks to the Express API, and Gemini credentials stay on the server.

## Deploy to Render

This repository includes a Render Blueprint (`render.yaml`). It builds the React app and serves it from Express in production, so the client and API share one public URL.

1. Push this repository to a GitHub repository.
2. Create a MongoDB Atlas database. Create a database user, copy the connection string, and replace its username, password, and database name. URL-encode any special characters in the password. In Atlas Network Access, allow connections from your Render service. Prefer Render's published outbound IP ranges if available; otherwise Atlas may require a broader IP rule for a service with dynamic outbound IPs.
3. Create a Gemini API key in Google AI Studio.
4. In Render, choose **New → Blueprint**, connect the GitHub repository, and apply `render.yaml`.
5. In the new Render service's **Environment** page, set `MONGODB_URI` to the Atlas URI and `GEMINI_API_KEY` to your Gemini key. These are marked `sync: false`, so Render asks for them without saving them in this file.
6. Deploy. Render runs `npm ci && npm run build`, then `npm start`. Open the service URL; the API readiness endpoint is `<service-url>/api/v1/ready` and should return `{"status":"ready","database":"connected"}`.

Keep `MONGODB_URI` and `GEMINI_API_KEY` in Render's environment settings only. Do not commit `.env`. If Atlas SRV lookups fail from the host, set `DNS_SERVERS` in Render to a comma-separated list of DNS resolver IPs such as `8.8.8.8`; the server applies it before Mongoose loads.

## Run locally

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`, then set `MONGODB_URI` and `GEMINI_API_KEY`.
3. Run `npm ci` and `npm run dev` from the repository root.
4. Open `http://localhost:5173`.

Vite proxies `/api` requests to the local Express server. For a separate frontend host, set `VITE_API_BASE_URL` at build time to the deployed API's `/api/v1` URL and configure that API's `CLIENT_ORIGIN` to the frontend origin.

## Build and start

Run `npm run build` and then `npm start` from the repository root. In production, Express serves `client/dist` and provides the API on the same port. The host supplies `PORT`; local default is 4000. Set `NODE_ENV=production` to enable static client hosting.

Camera logs are text simulations; image generation is not configured.
