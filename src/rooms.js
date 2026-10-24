// Room and player bookkeeping. Pure logic, no sockets, so it can be unit tested.
//
// Players and hosts are identified by a stable id and a private rejoin key,
// not by their socket: a phone that loses its connection (screen lock, Wi-Fi
// blip, page reload) comes back on a new socket and resumes with its key.

const crypto = require('node:crypto');

// No I or O so codes are easy to read off a projector.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
const MAX_NAME_LENGTH = 16;
// Sensitivity threshold in m/s²: motion above this counts as "moving".
const DEFAULT_THRESHOLD = 1.5;
const MIN_THRESHOLD = 0.1;
const MAX_THRESHOLD = 15;

class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  }
  return code;
}

function randomToken(prefix) {
  return prefix + crypto.randomBytes(12).toString('base64url');
}

class RoomStore {
  constructor({ generateCode = randomCode, generateToken = randomToken } = {}) {
    this.generateCode = generateCode;
    this.generateToken = generateToken;
    this.rooms = new Map(); // code -> room
    this.sockets = new Map(); // socket id -> { code, role: 'host' | 'player', id }
  }

  createRoom(socketId) {
    this.assertFree(socketId);
    let code = this.generateCode();
    let attempts = 0;
    while (this.rooms.has(code)) {
      attempts++;
      if (attempts > 100) {
        throw new RoomError('NO_FREE_CODE', 'Could not find a free room code.');
      }
      code = this.generateCode();
    }
    const room = {
      code,
      hostKey: this.generateToken('h_'),
      hostSocketId: socketId,
      hostConnected: true,
      players: new Map(), // player id -> { id, key, name, socketId, connected }
      threshold: DEFAULT_THRESHOLD,
      round: null,
      game: null,
    };
    this.rooms.set(code, room);
    this.sockets.set(socketId, { code, role: 'host' });
    return room;
  }

  // The host's page reconnected (or reloaded) with its key.
  resumeHost(socketId, rawCode, key) {
    this.assertFree(socketId);
    const room = this.findRoom(rawCode);
    if (typeof key !== 'string' || key !== room.hostKey) {
      throw new RoomError('BAD_KEY', 'That is not the host key for this room.');
    }
    // A reload can arrive before the old socket's disconnect does.
    this.sockets.delete(room.hostSocketId);
    room.hostSocketId = socketId;
    room.hostConnected = true;
    this.sockets.set(socketId, { code: room.code, role: 'host' });
    return room;
  }

  joinRoom(rawCode, socketId, rawName) {
    this.assertFree(socketId);
    const room = this.findRoom(rawCode);
    const name = String(rawName ?? '').trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new RoomError('BAD_NAME', `Name must be 1-${MAX_NAME_LENGTH} characters.`);
    }
    for (const p of room.players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) {
        throw new RoomError('NAME_TAKEN', `"${name}" is already taken in this room.`);
      }
    }
    const player = {
      id: this.generateToken('p_'),
      key: this.generateToken('k_'),
      name,
      socketId,
      connected: true,
    };
    room.players.set(player.id, player);
    this.sockets.set(socketId, { code: room.code, role: 'player', id: player.id });
    return { room, player };
  }

  // A player's phone reconnected (or reloaded) with its rejoin key.
  resumePlayer(socketId, rawCode, key) {
    this.assertFree(socketId);
    const room = this.findRoom(rawCode);
    const player = typeof key === 'string'
      ? [...room.players.values()].find((p) => p.key === key)
      : undefined;
    if (!player) {
      throw new RoomError('UNKNOWN_PLAYER', 'You are no longer in this room.');
    }
    this.sockets.delete(player.socketId);
    player.socketId = socketId;
    player.connected = true;
    this.sockets.set(socketId, { code: room.code, role: 'player', id: player.id });
    return { room, player };
  }

  // A socket closed. Marks its host or player as disconnected (they can still
  // resume) and returns { room, role, player } — or null if it was not in a room
  // or had already been replaced by a newer socket.
  disconnect(socketId) {
    const entry = this.sockets.get(socketId);
    if (!entry) return null;
    this.sockets.delete(socketId);
    const room = this.rooms.get(entry.code);
    if (!room) return null;
    if (entry.role === 'host') {
      room.hostConnected = false;
      return { room, role: 'host', player: null };
    }
    const player = room.players.get(entry.id);
    if (!player) return null;
    player.connected = false;
    return { room, role: 'player', player };
  }

  // Removes a player for good (they stayed away too long).
  removePlayer(code, id) {
    const room = this.rooms.get(code);
    const player = room?.players.get(id);
    if (!player) return false;
    room.players.delete(id);
    this.sockets.delete(player.socketId);
    return true;
  }

  // Closes a room for good (its host stayed away too long).
  closeRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    this.sockets.delete(room.hostSocketId);
    for (const p of room.players.values()) this.sockets.delete(p.socketId);
    this.rooms.delete(code);
  }

  // Returns { room, player } for a connected player's socket, or null.
  playerOf(socketId) {
    const entry = this.sockets.get(socketId);
    if (!entry || entry.role !== 'player') return null;
    const room = this.rooms.get(entry.code);
    const player = room?.players.get(entry.id);
    return player ? { room, player } : null;
  }

  // Records a motion reading. Returns { room, player }, or null if the sender
  // is not a player (e.g. a socket that was replaced by a reconnect).
  updateMotion(socketId, value) {
    const found = this.playerOf(socketId);
    if (!found) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RoomError('BAD_MOTION', 'Motion must be a non-negative number.');
    }
    return found;
  }

  // Returns the room this socket hosts, or throws if it is not a host.
  hostedRoom(socketId) {
    const entry = this.sockets.get(socketId);
    const room = entry?.role === 'host' ? this.rooms.get(entry.code) : undefined;
    if (!room) {
      throw new RoomError('NOT_HOST', 'Only the host can do that.');
    }
    return room;
  }

  setThreshold(socketId, value) {
    const room = this.hostedRoom(socketId);
    if (typeof value !== 'number' || !(value >= MIN_THRESHOLD && value <= MAX_THRESHOLD)) {
      throw new RoomError('BAD_THRESHOLD', `Sensitivity must be between ${MIN_THRESHOLD} and ${MAX_THRESHOLD}.`);
    }
    room.threshold = value;
    return room;
  }

  assertFree(socketId) {
    if (this.sockets.has(socketId)) {
      throw new RoomError('ALREADY_IN_ROOM', 'This connection is already in a room.');
    }
  }

  findRoom(rawCode) {
    const code = String(rawCode ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', `No room with code "${code}".`);
    }
    return room;
  }
}

function publicPlayers(room) {
  return [...room.players.values()].map(({ id, name, connected }) => ({ id, name, connected }));
}

module.exports = {
  RoomStore,
  RoomError,
  randomCode,
  publicPlayers,
  MAX_NAME_LENGTH,
  DEFAULT_THRESHOLD,
  MIN_THRESHOLD,
  MAX_THRESHOLD,
};
