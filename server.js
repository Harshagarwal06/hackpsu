const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const {
  RoomStore, RoomError, publicPlayers, MIN_THRESHOLD, MAX_THRESHOLD,
} = require('./src/rooms');
const { RedLightRound } = require('./src/redLight');
const { TugOfWarRound } = require('./src/tugOfWar');
const { GlassBridgeRound } = require('./src/glassBridge');
const { Game } = require('./src/game');

// roundOptions / tugOptions / bridgeOptions let tests run rounds with short timers.
function createGameServer({ roundOptions, tugOptions, bridgeOptions } = {}) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  // QR code (SVG) for the join link shown on the host screen.
  app.get('/qr.svg', async (req, res) => {
    const url = req.query.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || url.length > 300) {
      res.status(400).type('text/plain').send('Pass ?url= with an http(s) link of at most 300 characters.');
      return;
    }
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    res.type('image/svg+xml').send(svg);
  });

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

  // Map of id -> name for everyone in the room.
  function allPlayers(room) {
    return new Map([...room.players.values()].map((p) => [p.id, p.name]));
  }

  // Each round starter takes the players who take part, and an optional
  // callback that runs after the round's results have been sent.

  function startRedLight(room, names, afterOver) {
    if (names.size === 0) throw new RoomError('NO_PLAYERS', 'Wait for at least one player to join.');
    const round = new RedLightRound({
      players: names,
      getThreshold: () => room.threshold,
      options: roundOptions,
      on: {
        start: (info) => io.to(room.code).emit('rl:start', info),
        phase: (info) => io.to(room.code).emit('rl:phase', info),
        // Progress updates go only to the host and that player, not every phone.
        player: (id, state) => io.to([room.hostId, id]).emit('rl:player', { id, ...state }),
        over: (summary) => {
          room.round = null;
          io.to(room.code).emit('rl:over', summary);
          afterOver?.(summary);
        },
      },
    });
    room.round = round;
    round.start();
  }

  function startTugOfWar(room, names, afterOver) {
    if (names.size < 2) throw new RoomError('NOT_ENOUGH_PLAYERS', 'Tug of War needs at least 2 players.');
    const round = new TugOfWarRound({
      players: names,
      options: tugOptions,
      on: {
        start: (info) => io.to(room.code).emit('tow:start', info),
        state: (info) => io.to(room.code).volatile.emit('tow:state', info),
        over: (summary) => {
          room.round = null;
          io.to(room.code).emit('tow:over', summary);
          afterOver?.(summary);
        },
      },
    });
    room.round = round;
    round.start();
  }

  function startGlassBridge(room, names, afterOver) {
    if (names.size === 0) throw new RoomError('NO_PLAYERS', 'Wait for at least one player to join.');
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
          afterOver?.(summary);
        },
      },
    });
    room.round = round;
    round.start();
  }

  const STARTERS = { redlight: startRedLight, tug: startTugOfWar, bridge: startGlassBridge };

  // Practice rounds: everyone plays and nothing carries over.
  function startPractice(room, key) {
    if (room.round) throw new RoomError('ROUND_RUNNING', 'A round is already running.');
    if (room.game?.isActive()) throw new RoomError('GAME_RUNNING', 'Finish or end the game first.');
    STARTERS[key](room, allPlayers(room));
  }

  function emitGame(room) {
    io.to(room.code).emit('game:state', room.game ? room.game.state() : null);
  }

  // Starts the game's next round with only the players still in.
  function startGameRound(room) {
    if (room.round) throw new RoomError('ROUND_RUNNING', 'A round is already running.');
    const { key, players } = room.game.nextRound();
    emitGame(room);
    STARTERS[key](room, players, (summary) => {
      room.game.roundOver(summary.results);
      emitGame(room);
    });
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
        startPractice(store.hostedRoom(socket.id), 'redlight');
        return {};
      }, ack);
    });

    socket.on('host:start-tug', (ack) => {
      handle(socket, () => {
        startPractice(store.hostedRoom(socket.id), 'tug');
        return {};
      }, ack);
    });

    socket.on('host:start-bridge', (ack) => {
      handle(socket, () => {
        startPractice(store.hostedRoom(socket.id), 'bridge');
        return {};
      }, ack);
    });

    socket.on('host:game-start', (ack) => {
      handle(socket, () => {
        const room = store.hostedRoom(socket.id);
        if (room.round) throw new RoomError('ROUND_RUNNING', 'A round is already running.');
        if (room.game?.isActive()) throw new RoomError('GAME_RUNNING', 'A game is already running.');
        if (room.players.size < 2) throw new RoomError('NOT_ENOUGH_PLAYERS', 'A game needs at least 2 players.');
        room.game = new Game(allPlayers(room));
        startGameRound(room);
        return {};
      }, ack);
    });

    socket.on('host:game-next', (ack) => {
      handle(socket, () => {
        const room = store.hostedRoom(socket.id);
        if (room.game?.phase !== 'intermission') throw new RoomError('NO_NEXT_ROUND', 'There is no next round to start.');
        startGameRound(room);
        return {};
      }, ack);
    });

    socket.on('host:game-end', (ack) => {
      handle(socket, () => {
        const room = store.hostedRoom(socket.id);
        if (!room.game) throw new RoomError('NO_GAME', 'No game is running.');
        if (room.round) throw new RoomError('ROUND_RUNNING', 'End the current round first.');
        room.game = null;
        emitGame(room);
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
        return {
          id: socket.id,
          code: room.code,
          name: player.name,
          roundRunning: Boolean(room.round),
          game: room.game ? room.game.state() : null,
        };
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
        if (left.room.game) {
          left.room.game.removePlayer(socket.id);
          emitGame(left.room);
        }
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
