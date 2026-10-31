const path = require('node:path');
const http = require('node:http');
const express = require('express');
const Redis = require('ioredis');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { MemoryRoomStore, RedisRoomStore, createRoomStore, publicRoom, cleanName } = require('./room-store');

// Local development deliberately uses this map only when no Redis URL is set.
const rooms = new Map();

function redisUrl(options) {
  const url = options.redisUrl || process.env.UPSTASH_REDIS_URL;
  const trimmed = url && String(url).trim();
  return trimmed || undefined;
}

function createRedisClient(url) {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: 15000,
    keepAlive: 10000
  });
  client.on('error', (error) => console.error('Redis connection error:', error.message));
  return client;
}

// Production must never silently fall back to in-memory rooms: a second
// player would land on a different Function instance and could never join.
// Instead, every operation fails with an actionable message that the UI
// surfaces as a toast, and the reason is logged server-side.
class UnconfiguredRoomStore {
  constructor(reason) { this.reason = reason; }
  async create() { throw new Error(this.reason); }
  async get() { return null; }
  async join() { return { ok: false, error: this.reason }; }
  async resume() { return null; }
  async submit() { return { ok: false, error: this.reason }; }
  async next() { return { ok: false, error: this.reason }; }
}

function resolveStore(options) {
  if (options.store) return options.store;
  const url = redisUrl(options);
  if (url) return new RedisRoomStore(options.redis || createRedisClient(url));
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    const reason = 'Multiplayer storage is not configured on this server (UPSTASH_REDIS_URL is missing).';
    console.error(`[smooch] ${reason} Set UPSTASH_REDIS_URL in the deployment environment.`);
    return new UnconfiguredRoomStore(reason);
  }
  return createRoomStore({ localRooms: rooms });
}

function createSocketServer(server, options = {}) {
  const store = resolveStore(options);
  const io = new Server(server, {
    cors: { origin: true },
    // Must stay equal to the exact path Vercel routes to api/socket-io.js.
    // Vercel does not route subpaths (e.g. /api/socket-io/socket.io/...) to
    // the Function, so the Socket.IO path deliberately has no subpath, and
    // the client bundle is served statically from public/vendor/.
    path: options.path || '/api/socket-io',
    transports: ['websocket']
  });
  const broadcast = options.broadcast || ((roomCode, event, payload) => io.to(roomCode).emit(event, payload));

  const url = redisUrl(options);
  if (url && !options.disableRedisAdapter) {
    const pubClient = options.pubClient || createRedisClient(url);
    const subClient = options.subClient || pubClient.duplicate();
    if (!options.subClient) subClient.on('error', (error) => console.error('Redis connection error:', error.message));
    io.adapter(createAdapter(pubClient, subClient));
  }

  const bindPlayer = (socket, room, player) => {
    socket.data.playerId = player.id;
    socket.data.roomCode = room.code;
    socket.join(room.code);
  };
  const currentPlayer = async (socket) => {
    const room = await store.get(socket.data.roomCode);
    const player = room?.players.find((candidate) => candidate.id === socket.data.playerId);
    return player ? { room, player } : null;
  };
  const replyError = (done, error) => done?.({ ok: false, error: error.message || 'Something went wrong. Please try again.' });

  io.on('connection', (socket) => {
    const resumeToken = socket.handshake.auth?.resumeToken;
    if (resumeToken) {
      void store.resume(resumeToken).then((session) => {
        if (!session) return socket.emit('room:expired');
        bindPlayer(socket, session.room, session.player);
        socket.emit('room:sync', { room: publicRoom(session.room), player: session.player });
      }).catch((error) => socket.emit('room:error', { error: error.message }));
    }

    socket.on('room:create', async (payload, done) => {
      try {
        const { room, player, resumeToken: token } = await store.create(payload || {});
        bindPlayer(socket, room, player);
        done?.({ ok: true, room: publicRoom(room), player, resumeToken: token });
      } catch (error) { replyError(done, error); }
    });

    socket.on('room:join', async (payload, done) => {
      try {
        const result = await store.join(payload || {});
        if (!result.ok) return done?.(result);
        bindPlayer(socket, result.room, result.player);
        const state = publicRoom(result.room);
        broadcast(result.room.code, 'room:update', state);
        done?.({ ok: true, room: state, player: result.player, resumeToken: result.resumeToken });
      } catch (error) { replyError(done, error); }
    });

    socket.on('room:sync', async (_, done) => {
      try {
        const session = await currentPlayer(socket);
        if (!session) return done?.({ ok: false, error: 'Your room has expired.' });
        const state = { room: publicRoom(session.room), player: session.player };
        socket.emit('room:sync', state);
        done?.({ ok: true, ...state });
      } catch (error) { replyError(done, error); }
    });

    socket.on('answer:submit', async (payload, done) => {
      try {
        const result = await store.submit({
          code: socket.data.roomCode, playerId: socket.data.playerId,
          choice: payload?.choice, expectedRound: payload?.expectedRound
        });
        if (!result.ok) return done?.({ ...result, room: result.room && publicRoom(result.room) });
        const state = publicRoom(result.room);
        if (result.revealed) {
          const answers = Object.entries(result.answers).map(([playerId, choice]) => ({ playerId, choice }));
          broadcast(result.room.code, 'answer:reveal', { answers, match: result.match, room: state });
        } else if (!result.duplicate) {
          socket.to(result.room.code).emit('room:update', state);
        }
        done?.({ ...result, room: state });
      } catch (error) { replyError(done, error); }
    });

    socket.on('round:next', async (payload, done) => {
      try {
        const result = await store.next({
          code: socket.data.roomCode, playerId: socket.data.playerId, expectedRound: payload?.expectedRound
        });
        if (!result.ok) return done?.({ ...result, room: result.room && publicRoom(result.room) });
        const state = publicRoom(result.room);
        if (result.advanced) broadcast(result.room.code, 'round:next', state);
        done?.({ ...result, room: state });
      } catch (error) { replyError(done, error); }
    });
  });

  return { io, store };
}

function buildServer(options = {}) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (_, res) => res.json({ ok: true, storage: redisUrl(options) ? 'redis' : 'memory' }));
  app.get('*splat', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  const server = http.createServer(app);
  const realtime = createSocketServer(server, options);
  return { app, server, ...realtime };
}

if (require.main === module) {
  const { server } = buildServer();
  server.listen(process.env.PORT || 3000, () => console.log('HeartSync is ready at http://localhost:3000'));
}

module.exports = { buildServer, createSocketServer, rooms, MemoryRoomStore, UnconfiguredRoomStore, cleanName, publicRoom };
