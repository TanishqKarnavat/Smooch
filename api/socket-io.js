const http = require('node:http');
const { createSocketServer } = require('../server');

// Vercel owns the listener. Exporting this HTTP server allows Vercel to handle
// WebSocket upgrade requests at /api/socket-io (the exact path routed to this
// Function — Vercel does not route subpaths, so the Socket.IO path and the
// client bundle location are both kept subpath-free).
//
// Transports: WebSocket only. Socket.IO's HTTP long-polling transport requires
// sticky sessions across invocations, which serverless Functions cannot
// guarantee; the Redis adapter relays events between instances instead.
const server = http.createServer((req, res) => {
  // engine.io only intercepts requests under its own path; answer anything
  // else (health probes, stray GETs) instead of hanging until the platform
  // times the invocation out.
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found. Socket.IO lives at /api/socket-io.' }));
});

try {
  createSocketServer(server, { path: '/api/socket-io' });
} catch (error) {
  // Misconfiguration (e.g. an unparseable UPSTASH_REDIS_URL) must not take the
  // whole Function down at require time with an opaque 500.
  console.error('[smooch] Socket.IO setup failed:', error);
  server.removeAllListeners('request');
  server.on('request', (_, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Realtime server failed to start. Check the Function logs.' }));
  });
}

module.exports = server;
