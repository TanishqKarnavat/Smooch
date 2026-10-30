const test = require('node:test');
const assert = require('node:assert/strict');
const { io: Client } = require('socket.io-client');
const { buildServer, createRoom, findRoom, publicRoom, cleanName, rooms } = require('../server');

test('a private room is created with clean public state', () => {
  rooms.clear();
  const { room, player } = createRoom({ name: '  Alex  ', avatar: '🌙', deck: 'cozy' });
  assert.equal(player.name, 'Alex');
  assert.equal(room.deck, 'cozy');
  assert.match(room.code, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  const publicState = publicRoom(room);
  assert.equal(publicState.playerCount, 1);
  assert.equal(publicState.status, 'playing');
  assert.equal(publicState.players[0].id, player.id);
  assert.equal(findRoom(room.code), room);
});

test('names are bounded and room codes are unique', () => {
  rooms.clear();
  assert.equal(cleanName(' '.repeat(10)), 'Partner');
  assert.equal(cleanName('x'.repeat(30)).length, 24);
  const a = createRoom({ name: 'A' }).room;
  const b = createRoom({ name: 'B' }).room;
  assert.notEqual(a.code, b.code);
});

test('real-time room reveals only after both players submit and advances together', async (t) => {
  const { server, io } = buildServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const a = Client(endpoint, { transports: ['websocket'] });
  const b = Client(endpoint, { transports: ['websocket'] });
  t.after(async () => { a.close(); b.close(); io.close(); await new Promise(resolve => server.close(resolve)); rooms.clear(); });
  await Promise.all([new Promise(resolve => a.on('connect', resolve)), new Promise(resolve => b.on('connect', resolve))]);
  const emit = (socket, event, payload) => new Promise(resolve => socket.emit(event, payload, resolve));
  const made = await emit(a, 'room:create', { name: 'A', deck: 'wander' });
  const joined = await emit(b, 'room:join', { code: made.room.code, name: 'B' });
  assert.equal(joined.room.playerCount, 2);
  const revealed = new Promise(resolve => a.once('answer:reveal', resolve));
  assert.equal((await emit(a, 'answer:submit', { choice: 1 })).waiting, true);
  await emit(b, 'answer:submit', { choice: 1 });
  const result = await revealed;
  assert.equal(result.match, true);
  assert.equal(result.answers.length, 2);
  const advanced = new Promise(resolve => b.once('round:next', resolve));
  await emit(a, 'round:next', {});
  assert.equal((await advanced).round, 1);
});
