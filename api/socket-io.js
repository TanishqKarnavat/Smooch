const http = require('node:http');
const { createSocketServer } = require('../server');

// Vercel owns the listener. Exporting this HTTP server allows Vercel to handle
// WebSocket upgrades at /api/socket-io/socket.io without calling listen().
const server = http.createServer();
createSocketServer(server, { path: '/api/socket-io/socket.io' });

module.exports = server;
