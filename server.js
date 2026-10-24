const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { RoomStore, RoomError, publicPlayers } = require('./src/rooms');

function createGameServer() {
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

  io.on('connection', (socket) => {
    socket.on('host:create', (ack) => {
      handle(socket, () => {
        const room = store.createRoom(socket.id);
        return { code: room.code };
      }, ack);
    });

    socket.on('player:join', (payload, ack) => {
      handle(socket, () => {
        const { room, player } = store.joinRoom(payload?.code, socket.id, payload?.name);
        io.to(room.hostId).emit('room:players', publicPlayers(room));
        return { code: room.code, name: player.name };
      }, ack);
    });

    socket.on('player:motion', (value) => {
      handle(socket, () => {
        const room = store.updateMotion(socket.id, value);
        if (room) io.to(room.hostId).volatile.emit('player:motion', { id: socket.id, m: value });
        return {};
      });
    });

    socket.on('disconnect', () => {
      const left = store.leave(socket.id);
      if (!left) return;
      if (left.wasHost) {
        for (const playerId of left.room.players.keys()) {
          io.to(playerId).emit('room:closed');
        }
      } else {
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
