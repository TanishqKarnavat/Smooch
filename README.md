# HeartSync

An original, no-account couples conversation game for one shared screen or a private two-device room. Each partner picks one of two choices; two-device choices remain hidden until both players have answered, then the app reveals the result and tracks how often the pair matched.

## Features

- Four original five-question decks: Everyday Spark, Wander Together, Cozy & Close, and Playful Chaos.
- Pass-the-phone mode with a private handoff between the two choices.
- Two-device rooms with short, high-entropy invite codes and six-hour automatic expiry.
- Socket.IO real-time room state, simultaneous answer reveal, shared round progression, and match score.
- Responsive, keyboard-friendly UI with no account or database requirement.

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

For a two-device game, select **From anywhere**, enter a name, and share the generated URL. The guest opens that link, enters their name, and joins. Both devices must reach the same server; for internet deployment, host it behind HTTPS and set the public URL normally.

## Test

```powershell
npm test
```

The suite tests room creation and validation plus an end-to-end Socket.IO create/join/hidden-submit/reveal/next-round flow.

## Architecture

- `public/`: dependency-light HTML, CSS and browser JavaScript; prompt decks live in `public/app.js`.
- `server.js`: Express static host, Socket.IO event handlers, in-memory room lifecycle, and `/health` endpoint.
- `test/server.test.js`: Node test runner coverage.

Rooms are deliberately in memory for a frictionless demo. They disappear whenever the server restarts, and are invalidated after six hours. For production, replace the `Map` with Redis (including a TTL), use a Socket.IO Redis adapter for multi-instance delivery, add rate limiting, and set a precise CORS origin list.
