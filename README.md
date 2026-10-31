# HeartSync

An original, no-account couples conversation game for one shared screen or a private two-device room. Each partner picks one of two choices; two-device choices remain hidden until both players have answered, then the app reveals the result and tracks how often the pair matched.

## Features

- Four original five-question decks: Everyday Spark, Wander Together, Cozy & Close, and Playful Chaos.
- Pass-the-phone mode with a private handoff between the two choices.
- Two-device rooms with short, high-entropy invite codes and six-hour automatic expiry.
- Socket.IO real-time room state, simultaneous answer reveal, shared round progression, and match score.
- Responsive, keyboard-friendly UI with no account requirement.

## Run it

Requires Node.js 20 or later.

```powershell
npm install
npm start
```

Open `http://localhost:3000`. To develop with automatic server restarts, use:

```powershell
npm run dev
```

For a two-device game, select **From anywhere**, enter a name, and share the generated URL. The guest opens that link, enters their name, and joins.

Without `UPSTASH_REDIS_URL`, local development uses an in-memory room store. It is suitable for one local Node process only. Set the variable locally to exercise the production Redis path.

## Test

```powershell
npm test
```

The suite tests expiry, production configuration validation, two-instance game flow, hidden first answers, simultaneous reveal, idempotent round progression, and token-based resume. Set `HEARTSYNC_TEST_REDIS_URL` to an Upstash TLS/TCP URL to run the Redis integration test; without it, that test is skipped.

## Architecture

- `public/`: dependency-light HTML, CSS and browser JavaScript; prompt decks live in `public/app.js`; `public/vendor/socket.io.min.js` is the vendored Socket.IO browser client (copied from `node_modules/socket.io/client-dist`, version-matched by a test).
- `server.js`: Express static host, shared Socket.IO initialization, authentication, and event handlers.
- `room-store.js`: authoritative Redis room lifecycle and atomic Lua mutations, plus the local-only memory fallback.
- `api/socket-io.js`: Vercel WebSocket Function export.
- `test/server.test.js`: Node test runner coverage.

## Redis and production multiplayer

Production requires `UPSTASH_REDIS_URL`, a TLS/TCP URL from the **TCP** connection panel of an Upstash Redis database (usually beginning `rediss://`). Do not use an Upstash REST URL or REST token for this variable. Copy `.env.example` to `.env.local` locally and set only that value; `.env.local` is ignored by Git.

At startup, production does not fall back to in-memory rooms. If `UPSTASH_REDIS_URL` is absent, the Function still boots, but every multiplayer operation fails with an explicit message (`UPSTASH_REDIS_URL is missing`) that the UI shows to the user, and the reason is logged server-side. With the variable present, the app uses Redis as the authoritative room store and `@socket.io/redis-adapter` with `ioredis` Pub/Sub clients to relay events between Function instances.

Each room and its resume-token record are created with the same absolute six-hour Redis TTL. Activity never extends that TTL. The server stores only a SHA-256 hash of an opaque, 256-bit resume token; the browser keeps the token in `localStorage` keyed by room code and sends it only in the Socket.IO auth handshake. Public room events never include that token or answer values before reveal.

## Vercel deployment

Required Vercel environment variable (Production and Preview):

- `UPSTASH_REDIS_URL` — Upstash Redis TLS/TCP URL (`rediss://...`) from the TCP connection panel. Not a REST URL.

`vercel.json` enables Fluid compute (required for WebSockets) and sets the Socket.IO Function `maxDuration` to 300 seconds (Hobby maximum). The client reconnects and re-syncs when that limit closes the socket.

1. Create an Upstash Redis database and copy its TLS/TCP connection URL.
2. In the Vercel project environment variables, add `UPSTASH_REDIS_URL` for Production and Preview.
3. Deploy this repository. Vercel serves `public/` statically and maps `api/socket-io.js` to `/api/socket-io`.
4. Confirm two-device play from two distinct browser sessions.

Vercel only routes the exact path `/api/socket-io` to the Function — subpaths such as `/api/socket-io/socket.io/...` return 404. Both sides therefore use `path: '/api/socket-io'`, and the Socket.IO browser client is served statically from `public/vendor/socket.io.min.js` instead of the Function's `/socket.io.js` endpoint. Socket.IO runs WebSocket-only because HTTP long-polling needs sticky sessions that serverless Functions cannot guarantee; cross-instance events travel through the Redis adapter.

The client is WebSocket-only and uses `/api/socket-io`.

## Operational limitations

- The Upstash free plan and Vercel Hobby limits are appropriate for a small prototype, not an SLA-backed production service.
- Function WebSocket connections periodically close at the platform duration limit; the client automatically reconnects and re-syncs its durable room state.
- Redis credentials must remain server-only. Do not expose `UPSTASH_REDIS_URL` in browser code.
- Add rate limiting, origin allowlisting, observability, and a privacy review before a public launch.
