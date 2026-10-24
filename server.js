const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const {
  RoomStore, RoomError, publicPlayers, MIN_THRESHOLD, MAX_THRESHOLD,
} = require('./src/rooms');
const { RedLightRound } = require('./src/redLight');
const { TugOfWarRound } = require('./src/tugOfWar');
const { GlassBridgeRound } = require('./src/glassBridge');

// roundOptions / tugOptions / bridgeOptions let tests run rounds with short timers.
function createGameServer({ roundOptions, tugOptions, bridgeOptions } = {}) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const store = new RoomStore();

  // Runs a handler and turns RoomErrors into an { error } reply for the client
  // (via the ack, or a 'server:error' event when there is no ack).
  // Anything else is a bug: log it and tell the client something went wrong.
  function handle(socket, fn, ack) {
    try {
      const result = fn();
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      if (!(err instanceof RoomError)) console.error(`[${socket.id}]`, err);
      const error = err instanceof RoomError
        ? { code: err.code, message: err.message }
        : { code: 'SERVER_ERROR', message: 'Something went wrong on the server.' };
      if (typeof ack === 'function') ack({ ok: false, error });
      else socket.emit('server:error', error);
    }
  }

  function startRedLight(room) {
    if (room.round) throw new RoomError('ROUND_RUNNING', 'A round is already running.');
    if (room.players.size === 0) throw new RoomError('NO_PLAYERS', 'Wait for at least one player to join.');
    const names = new Map([...room.players.values()].map((p) => [p.id, p.name]));
    const round = new RedLightRound({
      players: names,
      getThreshold: () => room.threshold,
      options: roundOptions,
      on: {
        phase: (info) => io.to(room.code).emit('rl:phase', info),
        // Progress updates go only to the host and that player, not every phone.
        player: (id, state) => io.to([room.hostId, id]).emit('rl:player', { id, ...state }),
        over: (summary) => {
          room.round = null;
          io.to(room.code).emit('rl:over', summary);
        },
      },
    });
    room.round = round;
    round.start();
  }

  function startTugOfWar(room) {
    if (room.round) throw new RoomError('ROUND_RUNNING', 'A round is already running.');
    if (room.players.size < 2) throw new RoomError('NOT_ENOUGH_PLAYERS', 'Tug of War needs at least 2 players.');
    const names = new Map([...room.players.values()].map((p) => [p.id, p.name]));
    const round = new TugOfWarRound({
      players: names,
      options: tugOptions,
      on: {
        start: (info) => io.to(room.code).emit('tow:start', info),
        state: (info) => io.to(room.code).volatile.emit('tow:state', info),
        over: (summary) => {
          room.round = null;
          io.to(room.code).emit('tow:over', summary);
        },
      },
    });
    room.round = round;
    round.start();
  }

  function startGlassBridge(room) {
    if (room.round) throw new RoomError('ROUND_RUNNING', 'A round is already running.');
    if (room.players.size === 0) throw new RoomError('NO_PLAYERS', 'Wait for at least one player to join.');
    const names = new Map([...room.players.values()].map((p) => [p.id, p.name]));
    const round = new GlassBridgeRound({
      players: names,
      options: bridgeOptions,
      on: {
        start: (info) => io.to(room.code).emit('gb:start', info),
        state: (info) => io.to(room.code).emit('gb:state', info),
        jump: (info) => io.to(room.code).emit('gb:jump', info),
        over: (summary) => {
          room.round = null;
          io.to(room.code).emit('gb:over', summary);
        },
      },
    });
    room.round = round;
    round.start();
  }

  // The Glass Bridge round running in this player's room, or throws.
  function bridgeRoundOf(playerId) {
    const room = store.roomOf(playerId);
    if (!room || !room.players.has(playerId)) throw new RoomError('NOT_IN_ROOM', 'Join a room first.');
    if (!(room.round instanceof GlassBridgeRound)) throw new RoomError('NO_ROUND', 'Glass Bridge is not running.');
    return { room, round: room.round };
  }

  io.on('connection', (socket) => {
    socket.on('host:create', (ack) => {
      handle(socket, () => {
        const room = store.createRoom(socket.id);
        socket.join(room.code);
        return {
          code: room.code,
          threshold: room.threshold,
          minThreshold: MIN_THRESHOLD,
          maxThreshold: MAX_THRESHOLD,
        };
      }, ack);
    });

    socket.on('host:threshold', (value, ack) => {
      handle(socket, () => ({ threshold: store.setThreshold(socket.id, value).threshold }), ack);
    });

    socket.on('host:start-redlight', (ack) => {
      handle(socket, () => {
        startRedLight(store.hostedRoom(socket.id));
        return {};
      }, ack);
    });

    socket.on('host:start-tug', (ack) => {
      handle(socket, () => {
        startTugOfWar(store.hostedRoom(socket.id));
        return {};
      }, ack);
    });

    socket.on('host:start-bridge', (ack) => {
      handle(socket, () => {
        startGlassBridge(store.hostedRoom(socket.id));
        return {};
      }, ack);
    });

    socket.on('gb:choose', (side, ack) => {
      handle(socket, () => {
        const { round } = bridgeRoundOf(socket.id);
        if (side !== 'left' && side !== 'right') throw new RoomError('BAD_SIDE', 'Pick left or right.');
        if (!round.choose(socket.id, side)) throw new RoomError('NOT_YOUR_TURN', 'It is not your turn to jump.');
        return {};
      }, ack);
    });

    // Live tilt of the player on the bridge, shown on the big screen.
    socket.on('gb:lean', (gamma) => {
      handle(socket, () => {
        const { room, round } = bridgeRoundOf(socket.id);
        if (typeof gamma !== 'number' || !Number.isFinite(gamma)) throw new RoomError('BAD_TILT', 'Tilt must be a number.');
        if (round.current === socket.id) io.to(room.hostId).volatile.emit('gb:lean', { id: socket.id, gamma });
        return {};
      });
    });

    socket.on('host:end-round', (ack) => {
      handle(socket, () => {
        const room = store.hostedRoom(socket.id);
        if (!room.round) throw new RoomError('NO_ROUND', 'No round is running.');
        room.round.stop();
        return {};
      }, ack);
    });

    socket.on('player:join', (payload, ack) => {
      handle(socket, () => {
        const { room, player } = store.joinRoom(payload?.code, socket.id, payload?.name);
        socket.join(room.code);
        io.to(room.hostId).emit('room:players', publicPlayers(room));
        return { id: socket.id, code: room.code, name: player.name, roundRunning: Boolean(room.round) };
      }, ack);
    });

    socket.on('player:motion', (value) => {
      handle(socket, () => {
        const room = store.updateMotion(socket.id, value);
        if (!room) return {};
        io.to(room.hostId).volatile.emit('player:motion', { id: socket.id, m: value });
        if (room.round) room.round.handleMotion(socket.id, value);
        return {};
      });
    });

    socket.on('disconnect', () => {
      const left = store.leave(socket.id);
      if (!left) return;
      if (left.wasHost) {
        if (left.room.round) left.room.round.cancel();
        io.to(left.room.code).emit('room:closed');
      } else {
        if (left.room.round) left.room.round.removePlayer(socket.id);
        io.to(left.room.hostId).emit('room:players', publicPlayers(left.room));
      }
    });
  });

  return { app, httpServer, io, store };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { httpServer } = createGameServer();
  httpServer.listen(port, () => {
    console.log(`Host screen:  http://localhost:${port}/host`);
    console.log(`Player page:  http://localhost:${port}/`);
    console.log('Phones need HTTPS for motion — see README for the tunnel command.');
  });
}

module.exports = { createGameServer };
