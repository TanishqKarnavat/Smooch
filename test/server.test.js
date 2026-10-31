const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io: Client } = require('socket.io-client');
const Redis = require('ioredis');
const { buildServer, MemoryRoomStore, UnconfiguredRoomStore } = require('../server');
const { RedisRoomStore, tokenHash } = require('../room-store');
const vercelSocketFunction = require('../api/socket-io');

// Mirrors public/app.js: WebSocket-only transport against the exact path
// Vercel routes to api/socket-io.js (subpaths are NOT routed by Vercel).
const socketOptions = { path: '/api/socket-io', transports: ['websocket'] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const testRedisUrl = process.env.HEARTSYNC_TEST_REDIS_URL;

function memoryRelay() {
  const servers = new Set();
  return {
    add(io) { servers.add(io); },
    broadcast(roomCode, event, payload) { for (const io of servers) io.to(roomCode).emit(event, payload); }
  };
}

async function listening(options) {
  const instance = buildServer(options);
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return instance;
}

test('Vercel Socket.IO API Function exports an unstarted HTTP server', () => {
  assert.equal(typeof vercelSocketFunction.listen, 'function');
  assert.equal(vercelSocketFunction.listening, false);
});

test('vendored Socket.IO browser client matches the installed server version', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'socket.io.min.js'), 'utf8');
  const version = require('socket.io/package.json').version;
  assert.ok(bundle.includes(`Socket.IO v${version}`), `public/vendor/socket.io.min.js is stale (server is v${version})`);
  assert.equal(typeof globalThis.io, 'undefined'); // sanity: bundle must not be loaded here
});

test('production without an Upstash Redis URL degrades clearly, never to memory', async () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = '1';
  const instance = buildServer();
  try {
    assert.ok(instance.store instanceof UnconfiguredRoomStore, 'must not use the in-memory store in production');
    await assert.rejects(() => instance.store.create({ name: 'A' }), /UPSTASH_REDIS_URL is missing/);
  } finally {
    instance.io.close();
    await new Promise((resolve) => instance.server.close(resolve));
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

test('Vercel Function export answers plain HTTP and serves a full socket game', async (t) => {
  await new Promise((resolve) => vercelSocketFunction.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${vercelSocketFunction.address().port}`;

  // Non-upgrade requests must get a prompt JSON answer, not a platform timeout.
  const probe = await fetch(`${url}/`);
  assert.equal(probe.status, 404);
  assert.equal((await probe.json()).ok, false);

  const a = Client(url, socketOptions);
  const b = Client(url, socketOptions);
  // Teardown order matters: close WebSocket clients first (Node's
  // closeAllConnections does not destroy upgraded connections), then idle
  // HTTP sockets, and only then wait for the server to close.
  t.after(async () => {
    a.close(); b.close();
    await wait(25);
    vercelSocketFunction.closeAllConnections?.();
    await new Promise((resolve) => vercelSocketFunction.close(resolve));
  });
  await Promise.all([once(a, 'connect'), once(b, 'connect')]);

  const made = await emit(a, 'room:create', { name: 'A', deck: 'cozy' });
  assert.equal(made.ok, true);
  assert.match(made.room.code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.ok(made.resumeToken.length > 30);

  const joined = await emit(b, 'room:join', { code: made.room.code, name: 'B' });
  assert.equal(joined.ok, true);
  assert.equal(joined.room.players.length, 2);

  const revealA = once(a, 'answer:reveal');
  const first = await emit(a, 'answer:submit', { choice: 1, expectedRound: 0 });
  assert.equal(first.waiting, true);
  const second = await emit(b, 'answer:submit', { choice: 1, expectedRound: 0 });
  assert.equal(second.revealed, true);
  const event = await revealA;
  assert.equal(event.match, true);
  assert.equal(event.room.matchScore, 1);

  const next = await emit(a, 'round:next', { expectedRound: 0 });
  assert.equal(next.advanced, true);
});

test('memory fallback expires rooms without a later room access', async () => {
  const store = new MemoryRoomStore(new Map(), 10);
  const created = await store.create({ name: 'A' });
  await wait(25);
  assert.equal(store.rooms.has(created.room.code), false);
});

test('Redis integration: room lifecycle mutations are atomic', { skip: !testRedisUrl }, async (t) => {
  const redis = new Redis(testRedisUrl, { lazyConnect: true });
  const store = new RedisRoomStore(redis);
  const cleanup = new Set();
  t.after(async () => { await Promise.all([...cleanup].map((key) => redis.del(key))); await redis.quit(); });
  await redis.connect();

  const made = await store.create({ name: 'A', avatar: '🌙', deck: 'wander' });
  cleanup.add(store.roomKey(made.room.code));
  cleanup.add(store.resumeKey(tokenHash(made.resumeToken)));
  assert.equal((await store.get(made.room.code)).players.length, 1);

  const joined = await store.join({ code: made.room.code, name: 'B', avatar: '🧸' });
  assert.equal(joined.ok, true);
  cleanup.add(store.resumeKey(tokenHash(joined.resumeToken)));
  assert.equal((await store.get(made.room.code)).players.length, 2);

  const first = await store.submit({ code: made.room.code, playerId: made.player.id, choice: 1, expectedRound: 0 });
  assert.equal(first.waiting, true);
  const duplicateAnswer = await store.submit({ code: made.room.code, playerId: made.player.id, choice: 1, expectedRound: 0 });
  assert.equal(duplicateAnswer.duplicate, true);
  assert.equal((await store.get(made.room.code)).status, 'playing');

  const second = await store.submit({ code: made.room.code, playerId: joined.player.id, choice: 1, expectedRound: 0 });
  assert.equal(second.revealed, true);
  assert.equal(second.match, true);
  assert.equal(second.room.matchScore, 1);
  assert.equal(second.room.completedRounds, 1);

  const [advanceOne, advanceTwo] = await Promise.all([
    store.next({ code: made.room.code, playerId: made.player.id, expectedRound: 0 }),
    store.next({ code: made.room.code, playerId: joined.player.id, expectedRound: 0 })
  ]);
  assert.equal([advanceOne.advanced, advanceTwo.advanced].filter(Boolean).length, 1);
  assert.equal([advanceOne.duplicate, advanceTwo.duplicate].filter(Boolean).length, 1);
  const room = await store.get(made.room.code);
  assert.equal(room.round, 1);
  assert.equal(room.status, 'playing');
  assert.deepEqual(room.answers, {});
});

test('two instances share atomic game state and relay private/reveal events', async (t) => {
  const store = new MemoryRoomStore();
  const relay = memoryRelay();
  const one = await listening({ store, broadcast: relay.broadcast.bind(relay) });
  const two = await listening({ store, broadcast: relay.broadcast.bind(relay) });
  relay.add(one.io); relay.add(two.io);
  const a = Client(`http://127.0.0.1:${one.server.address().port}`, socketOptions);
  const b = Client(`http://127.0.0.1:${two.server.address().port}`, socketOptions);
  t.after(async () => {
    a.close(); b.close(); one.io.close(); two.io.close();
    await Promise.all([new Promise((resolve) => one.server.close(resolve)), new Promise((resolve) => two.server.close(resolve))]);
  });
  await Promise.all([once(a, 'connect'), once(b, 'connect')]);
  const made = await emit(a, 'room:create', { name: 'A', deck: 'wander' });
  assert.equal(made.ok, true);
  assert.equal(made.resumeToken.length > 30, true);
  assert.equal(JSON.stringify(made.room).includes(made.resumeToken), false);
  const joined = await emit(b, 'room:join', { code: made.room.code, name: 'B' });
  assert.equal(joined.ok, true);

  const noReveal = once(a, 'answer:reveal').then(() => 'revealed');
  const first = await emit(a, 'answer:submit', { choice: 0, expectedRound: 0 });
  assert.equal(first.waiting, true);
  const duplicateAnswer = await emit(a, 'answer:submit', { choice: 0, expectedRound: 0 });
  assert.equal(duplicateAnswer.duplicate, true);
  assert.equal(await Promise.race([noReveal, wait(30).then(() => 'private')]), 'private');

  const revealA = once(a, 'answer:reveal');
  const revealB = once(b, 'answer:reveal');
  const second = await emit(b, 'answer:submit', { choice: 0, expectedRound: 0 });
  assert.equal(second.revealed, true);
  const [eventA, eventB] = await Promise.all([revealA, revealB]);
  assert.equal(eventA.match, true);
  assert.deepEqual(eventA, eventB);
  assert.equal(eventA.room.matchScore, 1);
  assert.equal(eventA.room.completedRounds, 1);

  const [nextA, nextB] = await Promise.all([
    emit(a, 'round:next', { expectedRound: 0 }),
    emit(b, 'round:next', { expectedRound: 0 })
  ]);
  assert.equal([nextA.advanced, nextB.advanced].filter(Boolean).length, 1);
  assert.equal([nextA.duplicate, nextB.duplicate].filter(Boolean).length, 1);
  assert.equal((await store.get(made.room.code)).round, 1);

  a.close();
  const recovered = Client(`http://127.0.0.1:${one.server.address().port}`, { ...socketOptions, auth: { resumeToken: made.resumeToken } });
  t.after(() => recovered.close());
  const synced = once(recovered, 'room:sync');
  await once(recovered, 'connect');
  const sync = await synced;
  assert.equal(sync.player.id, made.player.id);
  assert.equal(sync.room.round, 1);
  assert.equal(sync.room.matchScore, 1);
});
