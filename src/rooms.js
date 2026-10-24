// Room and player bookkeeping. Pure logic, no sockets, so it can be unit tested.

// No I or O so codes are easy to read off a projector.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
const MAX_NAME_LENGTH = 16;

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

class RoomStore {
  constructor({ generateCode = randomCode } = {}) {
    this.generateCode = generateCode;
    this.rooms = new Map(); // code -> room
    this.memberOf = new Map(); // socket id -> room code
  }

  createRoom(hostId) {
    if (this.memberOf.has(hostId)) {
      throw new RoomError('ALREADY_IN_ROOM', 'This connection is already in a room.');
    }
    let code = this.generateCode();
    let attempts = 0;
    while (this.rooms.has(code)) {
      attempts++;
      if (attempts > 100) {
        throw new RoomError('NO_FREE_CODE', 'Could not find a free room code.');
      }
      code = this.generateCode();
    }
    const room = { code, hostId, players: new Map() };
    this.rooms.set(code, room);
    this.memberOf.set(hostId, code);
    return room;
  }

  joinRoom(rawCode, playerId, rawName) {
    if (this.memberOf.has(playerId)) {
      throw new RoomError('ALREADY_IN_ROOM', 'You are already in a room.');
    }
    const code = String(rawCode ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', `No room with code "${code}".`);
    }
    const name = String(rawName ?? '').trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new RoomError('BAD_NAME', `Name must be 1-${MAX_NAME_LENGTH} characters.`);
    }
    for (const p of room.players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) {
        throw new RoomError('NAME_TAKEN', `"${name}" is already taken in this room.`);
      }
    }
    const player = { id: playerId, name, motion: 0, lastSeen: Date.now() };
    room.players.set(playerId, player);
    this.memberOf.set(playerId, code);
    return { room, player };
  }

  // Records the latest motion reading. Returns the room, or null if the
  // sender is not a player (e.g. a stale socket after leaving).
  updateMotion(playerId, value) {
    const room = this.roomOf(playerId);
    const player = room?.players.get(playerId);
    if (!player) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RoomError('BAD_MOTION', 'Motion must be a non-negative number.');
    }
    player.motion = value;
    player.lastSeen = Date.now();
    return room;
  }

  // Removes a socket from whatever room it is in.
  // Returns { room, wasHost } or null if it was not in a room.
  leave(socketId) {
    const room = this.roomOf(socketId);
    if (!room) return null;
    this.memberOf.delete(socketId);
    if (room.hostId === socketId) {
      for (const playerId of room.players.keys()) this.memberOf.delete(playerId);
      this.rooms.delete(room.code);
      return { room, wasHost: true };
    }
    room.players.delete(socketId);
    return { room, wasHost: false };
  }

  roomOf(socketId) {
    const code = this.memberOf.get(socketId);
    return code ? this.rooms.get(code) : undefined;
  }
}

function publicPlayers(room) {
  return [...room.players.values()].map(({ id, name }) => ({ id, name }));
}

module.exports = { RoomStore, RoomError, randomCode, publicPlayers, MAX_NAME_LENGTH };
