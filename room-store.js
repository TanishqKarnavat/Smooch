const crypto = require('node:crypto');

const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_PLAYERS = 2;
const PREFIX = 'heartsync:';

function cleanName(value) {
  return String(value || 'Partner').trim().slice(0, 24) || 'Partner';
}

function newCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicRoom(room) {
  return {
    code: room.code,
    deck: room.deck,
    round: room.round,
    status: room.status,
    playerCount: room.players.length,
    players: room.players.map(({ id, name, avatar }) => ({ id, name, avatar })),
    submitted: Object.keys(room.answers),
    matchScore: room.matchScore,
    completedRounds: room.completedRounds,
    expiresAt: room.expiresAt
  };
}

function isExpired(room) {
  return !room || Date.now() >= room.expiresAt;
}

function ttlSeconds(room) {
  return Math.max(1, Math.ceil((room.expiresAt - Date.now()) / 1000));
}

class MemoryRoomStore {
  constructor(rooms = new Map(), roomTtlMs = ROOM_TTL_MS) {
    this.rooms = rooms;
    this.resumes = new Map();
    this.roomTtlMs = roomTtlMs;
  }

  scheduleExpiry(room) {
    const delay = Math.max(1, room.expiresAt - Date.now());
    const timer = setTimeout(() => {
      this.rooms.delete(room.code);
      for (const [hash, session] of this.resumes) if (session.code === room.code) this.resumes.delete(hash);
    }, delay);
    timer.unref?.();
  }

  async create({ name, avatar, deck }) {
    let code = newCode();
    while (this.rooms.has(code)) code = newCode();
    const player = { id: crypto.randomUUID(), name: cleanName(name), avatar: avatar || '💗' };
    const token = newToken();
    const room = {
      code, deck: deck || 'spark', round: 0, status: 'playing', players: [player],
      answers: {}, matchScore: 0, completedRounds: 0, expiresAt: Date.now() + this.roomTtlMs
    };
    this.rooms.set(code, room);
    this.resumes.set(tokenHash(token), { code, playerId: player.id, expiresAt: room.expiresAt });
    this.scheduleExpiry(room);
    return { room, player, resumeToken: token };
  }

  async get(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (isExpired(room)) {
      if (room) this.rooms.delete(room.code);
      return null;
    }
    return room;
  }

  async join({ code, name, avatar }) {
    const room = await this.get(code);
    if (!room) return { ok: false, error: 'That room has expired or does not exist.' };
    if (room.players.length >= MAX_PLAYERS) return { ok: false, error: 'This room already has two players.' };
    const player = { id: crypto.randomUUID(), name: cleanName(name), avatar: avatar || '💜' };
    const token = newToken();
    room.players.push(player);
    this.resumes.set(tokenHash(token), { code: room.code, playerId: player.id, expiresAt: room.expiresAt });
    return { ok: true, room, player, resumeToken: token };
  }

  async resume(token) {
    const session = this.resumes.get(tokenHash(token || ''));
    if (!session || Date.now() >= session.expiresAt) return null;
    const room = await this.get(session.code);
    const player = room?.players.find((candidate) => candidate.id === session.playerId);
    return player ? { room, player } : null;
  }

  async submit({ code, playerId, choice, expectedRound }) {
    const room = await this.get(code);
    if (!room || !room.players.some((player) => player.id === playerId)) return { ok: false, error: 'Your room has expired.' };
    if (![0, 1].includes(choice)) return { ok: false, error: 'Choose one of the two options.' };
    if (room.round !== expectedRound || room.status !== 'playing') return { ok: false, error: 'That round has already changed.', room };
    if (Object.hasOwn(room.answers, playerId)) return { ok: true, duplicate: true, waiting: room.players.length > Object.keys(room.answers).length, room };
    room.answers[playerId] = choice;
    if (Object.keys(room.answers).length < MAX_PLAYERS) return { ok: true, waiting: true, room };
    const [first, second] = room.players;
    const match = room.answers[first.id] === room.answers[second.id];
    room.status = 'revealed';
    room.completedRounds += 1;
    if (match) room.matchScore += 1;
    return { ok: true, revealed: true, match, answers: room.answers, room };
  }

  async next({ code, playerId, expectedRound }) {
    const room = await this.get(code);
    if (!room || !room.players.some((player) => player.id === playerId)) return { ok: false, error: 'Your room has expired.' };
    if (room.round !== expectedRound) return { ok: true, duplicate: true, room };
    if (room.status !== 'revealed') return { ok: false, error: 'Wait for both answers before continuing.', room };
    room.round += 1;
    room.status = 'playing';
    room.answers = {};
    return { ok: true, advanced: true, room };
  }
}

const JOIN_SCRIPT = `
local function encode_room(room)
  local encoded = cjson.encode(room)
  return string.gsub(encoded, '"answers":%[%]', '"answers":{}')
end
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ok=false,error='That room has expired or does not exist.'}) end
local room = cjson.decode(raw)
if #room.players >= 2 then return cjson.encode({ok=false,error='This room already has two players.'}) end
table.insert(room.players, {id=ARGV[1],name=ARGV[2],avatar=ARGV[3]})
redis.call('SET', KEYS[1], encode_room(room), 'KEEPTTL')
return '{"ok":true,"room":' .. encode_room(room) .. '}'`;

const SUBMIT_SCRIPT = `
local function encode_room(room)
  local encoded = cjson.encode(room)
  return string.gsub(encoded, '"answers":%[%]', '"answers":{}')
end
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'Your room has expired.'} end
local room = cjson.decode(raw)
if room.round ~= tonumber(ARGV[2]) or room.status ~= 'playing' then return {0, 'That round has already changed.', cjson.encode(room)} end
local known = false
for _, player in ipairs(room.players) do if player.id == ARGV[1] then known = true end end
if not known then return {0, 'Your room has expired.'} end
if room.answers[ARGV[1]] ~= nil then return {2, cjson.encode(room)} end
room.answers[ARGV[1]] = tonumber(ARGV[3])
local count = 0
for _ in pairs(room.answers) do count = count + 1 end
if count < 2 then local roomJson = encode_room(room); redis.call('SET', KEYS[1], roomJson, 'KEEPTTL'); return {1, roomJson} end
local match = room.answers[room.players[1].id] == room.answers[room.players[2].id]
room.status = 'revealed'
room.completedRounds = room.completedRounds + 1
if match then room.matchScore = room.matchScore + 1 end
local roomJson = encode_room(room)
redis.call('SET', KEYS[1], roomJson, 'KEEPTTL')
return {3, roomJson, cjson.encode(room.answers), match and 1 or 0}`;

const NEXT_SCRIPT = `
local function encode_room(room)
  local encoded = cjson.encode(room)
  return string.gsub(encoded, '"answers":%[%]', '"answers":{}')
end
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'Your room has expired.'} end
local room = cjson.decode(raw)
local known = false
for _, player in ipairs(room.players) do if player.id == ARGV[1] then known = true end end
if not known then return {0, 'Your room has expired.'} end
if room.round ~= tonumber(ARGV[2]) then return {2, cjson.encode(room)} end
if room.status ~= 'revealed' then return {0, 'Wait for both answers before continuing.', cjson.encode(room)} end
room.round = room.round + 1
room.status = 'playing'
room.answers = {}
local roomJson = encode_room(room)
redis.call('SET', KEYS[1], roomJson, 'KEEPTTL')
return {1, roomJson}`;

function parseJsonReply(value, operation) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Redis ${operation} script returned an invalid response.`);
  }
  return value.map((item) => Buffer.isBuffer(item) ? item.toString('utf8') : item);
}

class RedisRoomStore {
  constructor(redis) { this.redis = redis; }
  roomKey(code) { return `${PREFIX}room:${String(code).toUpperCase()}`; }
  resumeKey(hash) { return `${PREFIX}resume:${hash}`; }

  async create({ name, avatar, deck }) {
    for (let attempts = 0; attempts < 5; attempts += 1) {
      const code = newCode(); const player = { id: crypto.randomUUID(), name: cleanName(name), avatar: avatar || '💗' };
      const resumeToken = newToken(); const expiresAt = Date.now() + ROOM_TTL_MS;
      const room = { code, deck: deck || 'spark', round: 0, status: 'playing', players: [player], answers: {}, matchScore: 0, completedRounds: 0, expiresAt };
      const created = await this.redis.set(this.roomKey(code), JSON.stringify(room), 'EX', ttlSeconds(room), 'NX');
      if (created === 'OK') {
        await this.redis.set(this.resumeKey(tokenHash(resumeToken)), JSON.stringify({ code, playerId: player.id }), 'EX', ttlSeconds(room));
        return { room, player, resumeToken };
      }
    }
    throw new Error('Could not allocate a private room. Please try again.');
  }

  async get(code) { const raw = await this.redis.get(this.roomKey(code)); return raw ? JSON.parse(raw) : null; }

  async join({ code, name, avatar }) {
    const normalizedCode = String(code || '').toUpperCase(); const player = { id: crypto.randomUUID(), name: cleanName(name), avatar: avatar || '💜' };
    const result = JSON.parse(await this.redis.eval(JOIN_SCRIPT, 1, this.roomKey(normalizedCode), player.id, player.name, player.avatar));
    if (!result.ok) return result;
    const resumeToken = newToken();
    const seconds = await this.redis.ttl(this.roomKey(normalizedCode));
    if (seconds <= 0) return { ok: false, error: 'That room has expired or does not exist.' };
    await this.redis.set(this.resumeKey(tokenHash(resumeToken)), JSON.stringify({ code: normalizedCode, playerId: player.id }), 'EX', seconds);
    return { ok: true, room: result.room, player, resumeToken };
  }

  async resume(token) {
    if (!token) return null;
    const raw = await this.redis.get(this.resumeKey(tokenHash(token)));
    if (!raw) return null;
    const session = JSON.parse(raw); const room = await this.get(session.code);
    const player = room?.players.find((candidate) => candidate.id === session.playerId);
    return player ? { room, player } : null;
  }

  async submit({ code, playerId, choice, expectedRound }) {
    if (![0, 1].includes(choice)) return { ok: false, error: 'Choose one of the two options.' };
    const [status, roomJson, answersJson, match] = parseJsonReply(
      await this.redis.eval(SUBMIT_SCRIPT, 1, this.roomKey(code), playerId, String(expectedRound), String(choice)),
      'submit'
    );
    if (Number(status) === 0) return { ok: false, error: roomJson, room: answersJson && JSON.parse(answersJson) };
    const room = JSON.parse(roomJson);
    if (Number(status) === 1) return { ok: true, waiting: true, room };
    if (Number(status) === 2) return { ok: true, duplicate: true, waiting: room.players.length > Object.keys(room.answers).length, room };
    if (Number(status) === 3) return { ok: true, revealed: true, match: Number(match) === 1, answers: JSON.parse(answersJson), room };
    throw new Error('Redis submit script returned an unknown status.');
  }

  async next({ code, playerId, expectedRound }) {
    const [status, roomJson, errorRoomJson] = parseJsonReply(
      await this.redis.eval(NEXT_SCRIPT, 1, this.roomKey(code), playerId, String(expectedRound)),
      'next'
    );
    if (Number(status) === 0) return { ok: false, error: roomJson, room: errorRoomJson && JSON.parse(errorRoomJson) };
    const room = JSON.parse(roomJson);
    if (Number(status) === 1) return { ok: true, advanced: true, room };
    if (Number(status) === 2) return { ok: true, duplicate: true, room };
    throw new Error('Redis next script returned an unknown status.');
  }
}

function createRoomStore({ redis, localRooms } = {}) {
  if (redis) return new RedisRoomStore(redis);
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    throw new Error('UPSTASH_REDIS_URL is required for multiplayer in production.');
  }
  return new MemoryRoomStore(localRooms);
}

module.exports = { ROOM_TTL_MS, MemoryRoomStore, RedisRoomStore, createRoomStore, publicRoom, cleanName, tokenHash };
