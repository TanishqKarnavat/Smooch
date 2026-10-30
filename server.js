const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_PLAYERS = 2;
const rooms = new Map();

function code() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

function publicRoom(room) {
  return {
    code: room.code,
    deck: room.deck,
    round: room.round,
    playerCount: room.players.size,
    players: [...room.players.values()].map(({ id, name, avatar }) => ({ id, name, avatar })),
    submitted: [...room.answers.keys()],
    status: room.answers.size === MAX_PLAYERS ? 'revealed' : 'playing'
  };
}

function createRoom({ name, avatar, deck }) {
  let roomCode = code();
  while (rooms.has(roomCode)) roomCode = code();
  const player = { id: crypto.randomUUID(), name: cleanName(name), avatar: avatar || '💗' };
  const room = { code: roomCode, deck: deck || 'spark', round: 0, players: new Map([[player.id, player]]), answers: new Map(), createdAt: Date.now() };
  rooms.set(roomCode, room);
  return { room, player };
}

function cleanName(value) {
  return String(value || 'Partner').trim().slice(0, 24) || 'Partner';
}

function findRoom(roomCode) {
  const room = rooms.get(String(roomCode || '').toUpperCase());
  if (!room || Date.now() - room.createdAt > ROOM_TTL_MS) {
    if (room) rooms.delete(room.code);
    return null;
  }
  return room;
}

function attachRealtime(io) {
  io.on('connection', (socket) => {
    socket.on('room:create', (payload, done) => {
      const { room, player } = createRoom(payload || {});
      socket.join(room.code);
      socket.data.playerId = player.id;
      socket.data.roomCode = room.code;
      done?.({ ok: true, room: publicRoom(room), player });
    });

    socket.on('room:join', (payload, done) => {
      const room = findRoom(payload?.code);
      if (!room) return done?.({ ok: false, error: 'That room has expired or does not exist.' });
      if (room.players.size >= MAX_PLAYERS) return done?.({ ok: false, error: 'This room already has two players.' });
      const player = { id: crypto.randomUUID(), name: cleanName(payload?.name), avatar: payload?.avatar || '💜' };
      room.players.set(player.id, player);
      socket.join(room.code);
      socket.data.playerId = player.id;
      socket.data.roomCode = room.code;
      const state = publicRoom(room);
      io.to(room.code).emit('room:update', state);
      done?.({ ok: true, room: state, player });
    });

    socket.on('answer:submit', (payload, done) => {
      const room = findRoom(socket.data.roomCode);
      if (!room || !room.players.has(socket.data.playerId)) return done?.({ ok: false, error: 'Your room has expired.' });
      if (![0, 1].includes(payload?.choice)) return done?.({ ok: false, error: 'Choose one of the two options.' });
      room.answers.set(socket.data.playerId, payload.choice);
      if (room.answers.size < MAX_PLAYERS) {
        socket.to(room.code).emit('room:update', publicRoom(room));
        return done?.({ ok: true, waiting: true });
      }
      const answers = [...room.answers.entries()].map(([playerId, choice]) => ({ playerId, choice }));
      const match = answers[0].choice === answers[1].choice;
      io.to(room.code).emit('answer:reveal', { answers, match, room: publicRoom(room) });
      done?.({ ok: true, waiting: false });
    });

    socket.on('round:next', (_, done) => {
      const room = findRoom(socket.data.roomCode);
      if (!room || !room.players.has(socket.data.playerId)) return done?.({ ok: false, error: 'Your room has expired.' });
      room.round += 1;
      room.answers.clear();
      const state = publicRoom(room);
      io.to(room.code).emit('round:next', state);
      done?.({ ok: true, room: state });
    });
  });
}

function buildServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));
  app.get('*splat', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: true } });
  attachRealtime(io);
  return { app, server, io };
}

if (require.main === module) {
  const { server } = buildServer();
  server.listen(process.env.PORT || 3000, () => console.log('HeartSync is ready at http://localhost:3000'));
}

module.exports = { buildServer, rooms, createRoom, findRoom, publicRoom, cleanName };
