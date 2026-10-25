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

// How long a disconnected player or host can be away and still resume.
const PLAYER_RECONNECT_MS = 30000;
const HOST_RECONNECT_MS = 60000;

// Socket.IO channels: everyone in a room, the room's host, one player.
const roomCh = (room) => room.code;
const hostCh = (room) => `host:${room.code}`;
const playerCh = (id) => `player:${id}`;

// roundOptions / tugOptions / bridgeOptions let tests run rounds with short timers;
// reconnectMs overrides both reconnect windows.
function createGameServer({ roundOptions, tugOptions, bridgeOptions, reconnectMs } = {}) {
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
  const timers = new Map(); // key -> timeout for players/hosts who are away

  // Runs a handler and turns RoomErrors into an { error } reply for the client
  // (via the ack, or a 'server:error' event when there is no ack).
  // Anything else is a bug: log it and tell the client something went wrong.
  // Returns true if the handler succeeded.
  function handle(socket, fn, ack) {
    try {
      const result = fn();
      if (typeof ack === 'function') ack({ ok: true, ...result });
      return true;
    } catch (err) {
      if (!(err instanceof RoomError)) console.error(`[${socket.id}]`, err);
      const error = err instanceof RoomError
        ? { code: err.code, message: err.message }
        : { code: 'SERVER_ERROR', message: 'Something went wrong on the server.' };
      if (typeof ack === 'function') ack({ ok: false, error });
      else socket.emit('server:error', error);
      return false;
    }
  }

  function startTimer(key, fn) {
    clearTimeout(timers.get(key));
    const t = setTimeout(() => {
      timers.delete(key);
      fn();
    }, reconnectMs ?? (key.startsWith('host:') ? HOST_RECONNECT_MS : PLAYER_RECONNECT_MS));
    t.unref(); // a pending reconnect window alone shouldn't keep the process running
    timers.set(key, t);
  }

  function stopTimer(key) {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  // Map of id -> name for everyone in the room.
  function allPlayers(room) {
    return new Map([...room.players.values()].map((p) => [p.id, p.name]));
  }

  function sendPlayers(room) {
    io.to(hostCh(room)).emit('room:players', publicPlayers(room));
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
        start: (info) => io.to(roomCh(room)).emit('rl:start', info),
        phase: (info) => io.to(roomCh(room)).emit('rl:phase', info),
        // Progress updates go only to the host and that player, not every phone.
        player: (id, state) => io.to([hostCh(room), playerCh(id)]).emit('rl:player', { id, ...state }),
        over: (summary) => {
          room.round = null;
          io.to(roomCh(room)).emit('rl:over', summary);
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
        start: (info) => io.to(roomCh(room)).emit('tow:start', info),
        state: (info) => io.to(roomCh(room)).volatile.emit('tow:state', info),
        over: (summary) => {
          room.round = null;
          io.to(roomCh(room)).emit('tow:over', summary);
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
        start: (info) => io.to(roomCh(room)).emit('gb:start', info),
        state: (info) => io.to(roomCh(room)).emit('gb:state', info),
        jump: (info) => io.to(roomCh(room)).emit('gb:jump', info),
        over: (summary) => {
          room.round = null;
          io.to(roomCh(room)).emit('gb:over', summary);
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
    io.to(roomCh(room)).emit('game:state', room.game ? room.game.state() : null);
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

  // Catches a reconnected screen up on the round in progress, as if it had
  // seen the round start. `playerId` is null for the host.
  function replayRound(room, socket, playerId) {
    const round = room.round;
    if (!round) return;
    const snap = round.snapshot();
    if (round instanceof RedLightRound) {
      socket.emit('rl:start', snap.start);
      socket.emit('rl:phase', snap.phase);
      for (const p of snap.players) {
        if (playerId === null || p.id === playerId) socket.emit('rl:player', p);
      }
    } else if (round instanceof TugOfWarRound) {
      socket.emit('tow:start', snap.start);
      socket.emit('tow:state', snap.state);
    } else if (round instanceof GlassBridgeRound) {
      socket.emit('gb:start', snap.start);
      socket.emit('gb:state', snap.state);
    }
  }

  // Sends a reconnected screen everything it missed: the game, then the round.
  function catchUp(room, socket, playerId) {
    if (room.game) socket.emit('game:state', room.game.state());
    replayRound(room, socket, playerId);
  }

  // Takes a player out of the room, round and game for good. Their socket
  // stops getting room events and their rejoin key stops working.
  function removeForGood(room, id) {
    stopTimer(`player:${room.code}:${id}`);
    io.in(playerCh(id)).socketsLeave([roomCh(room), playerCh(id)]);
    store.removePlayer(room.code, id);
    if (room.round) room.round.removePlayer(id);
    if (room.game?.removePlayer(id)) emitGame(room);
    sendPlayers(room);
  }

  // A player stayed away too long.
  function dropPlayer(room, id) {
    const player = room.players.get(id);
    if (!player || player.connected) return;
    removeForGood(room, id);
  }

  // The host stayed away too long: the room closes for everyone.
  function closeRoom(room) {
    if (room.round) room.round.cancel();
    for (const id of room.players.keys()) stopTimer(`player:${room.code}:${id}`);
    io.to(roomCh(room)).emit('room:closed');
    io.in(roomCh(room)).socketsLeave([roomCh(room), hostCh(room)]);
    for (const id of room.players.keys()) io.in(playerCh(id)).socketsLeave(playerCh(id));
    store.closeRoom(room.code);
  }

  function hostInfo(room) {
    return {
      code: room.code,
      key: room.hostKey,
      threshold: room.threshold,
      minThreshold: MIN_THRESHOLD,
      maxThreshold: MAX_THRESHOLD,
    };
  }

  function playerInfo(room, player) {
    return {
      id: player.id,
      key: player.key,
      code: room.code,
      name: player.name,
      roundRunning: Boolean(room.round),
      game: room.game ? room.game.state() : null,
    };
  }

  // The Glass Bridge round running in this player's room, or null.
  function bridgeRoundOf(socketId) {
    const found = store.playerOf(socketId);
    if (!found) throw new RoomError('NOT_IN_ROOM', 'Join a room first.');
    const round = found.room.round instanceof GlassBridgeRound ? found.room.round : null;
    return { ...found, round };
  }

  io.on('connection', (socket) => {
    socket.on('host:create', (ack) => {
      handle(socket, () => {
        const room = store.createRoom(socket.id);
        socket.join([roomCh(room), hostCh(room)]);
        return hostInfo(room);
      }, ack);
    });

    socket.on('host:resume', (payload, ack) => {
      let room;
      const ok = handle(socket, () => {
        room = store.resumeHost(socket.id, payload?.code, payload?.key);
        stopTimer(`host:${room.code}`);
        socket.join([roomCh(room), hostCh(room)]);
        return hostInfo(room);
      }, ack);
      if (!ok) return;
      socket.emit('room:players', publicPlayers(room));
      catchUp(room, socket, null);
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

    socket.on('host:kick', (id, ack) => {
      handle(socket, () => {
        const room = store.hostedRoom(socket.id);
        if (typeof id !== 'string' || !room.players.has(id)) {
          throw new RoomError('NO_PLAYER', 'That player is not in this room.');
        }
        io.to(playerCh(id)).emit('player:kicked');
        removeForGood(room, id);
        return {};
      }, ack);
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
        socket.join([roomCh(room), playerCh(player.id)]);
        sendPlayers(room);
        return playerInfo(room, player);
      }, ack);
    });

    socket.on('player:resume', (payload, ack) => {
      let room;
      let player;
      const ok = handle(socket, () => {
        ({ room, player } = store.resumePlayer(socket.id, payload?.code, payload?.key));
        stopTimer(`player:${room.code}:${player.id}`);
        socket.join([roomCh(room), playerCh(player.id)]);
        sendPlayers(room);
        return playerInfo(room, player);
      }, ack);
      if (!ok) return;
      replayRound(room, socket, player.id);
    });

    socket.on('player:motion', (value) => {
      handle(socket, () => {
        const found = store.updateMotion(socket.id, value);
        if (!found) return {};
        const { room, player } = found;
        io.to(hostCh(room)).volatile.emit('player:motion', { id: player.id, m: value });
        if (room.round) room.round.handleMotion(player.id, value);
        return {};
      });
    });

    // The phone is now showing RED; its grace period starts here.
    socket.on('rl:seen-red', () => {
      handle(socket, () => {
        const found = store.playerOf(socket.id);
        if (found?.room.round instanceof RedLightRound) found.room.round.seenRed(found.player.id);
        return {};
      });
    });

    socket.on('gb:choose', (side, ack) => {
      handle(socket, () => {
        const { player, round } = bridgeRoundOf(socket.id);
        if (!round) throw new RoomError('NO_ROUND', 'Glass Bridge is not running.');
        if (side !== 'left' && side !== 'right') throw new RoomError('BAD_SIDE', 'Pick left or right.');
        if (!round.choose(player.id, side)) throw new RoomError('NOT_YOUR_TURN', 'It is not your turn to jump.');
        return {};
      }, ack);
    });

    // Live tilt of the player on the bridge, shown on the big screen. A reading
    // that arrives just after the round or turn ended is out of date: dropped.
    socket.on('gb:lean', (gamma) => {
      handle(socket, () => {
        const { room, player, round } = bridgeRoundOf(socket.id);
        if (typeof gamma !== 'number' || !Number.isFinite(gamma)) throw new RoomError('BAD_TILT', 'Tilt must be a number.');
        if (round?.current === player.id) io.to(hostCh(room)).volatile.emit('gb:lean', { id: player.id, gamma });
        return {};
      });
    });

    socket.on('disconnect', () => {
      const gone = store.disconnect(socket.id);
      if (!gone) return;
      const { room } = gone;
      if (gone.role === 'host') {
        startTimer(`host:${room.code}`, () => {
          if (!room.hostConnected) closeRoom(room);
        });
      } else {
        sendPlayers(room);
        const id = gone.player.id;
        startTimer(`player:${room.code}:${id}`, () => dropPlayer(room, id));
      }
    });
  });

  // Stops pending reconnect timers (used by tests when shutting down).
  function stop() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return { app, httpServer, io, store, stop };
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
