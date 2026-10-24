// End-to-end check of the socket flow: host creates a room, a player joins,
// motion reaches the host, and the room closes when the host leaves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createGameServer } = require('../server');

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function emitWithAck(socket, event, ...args) {
  return new Promise((resolve) => socket.emit(event, ...args, resolve));
}

test('host + player socket flow', async (t) => {
  const { httpServer, io } = createGameServer();
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;
  const host = connect(url);
  const player = connect(url);
  t.after(() => {
    host.close();
    player.close();
    io.close();
  });

  const created = await emitWithAck(host, 'host:create');
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z]{4}$/);

  const bad = await emitWithAck(player, 'player:join', { code: 'QQQQ', name: 'Sam' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'ROOM_NOT_FOUND');

  const playersUpdate = once(host, 'room:players');
  const joined = await emitWithAck(player, 'player:join', { code: created.code, name: 'Sam' });
  assert.equal(joined.ok, true);
  assert.deepEqual((await playersUpdate).map((p) => p.name), ['Sam']);

  const motion = once(host, 'player:motion');
  player.emit('player:motion', 4.2);
  assert.equal((await motion).m, 4.2);

  const motionError = once(player, 'server:error');
  player.emit('player:motion', -5);
  assert.equal((await motionError).code, 'BAD_MOTION');

  const closed = once(player, 'room:closed');
  host.close();
  await closed;
});

test('serves the player and host pages', async (t) => {
  const { httpServer, io } = createGameServer();
  await new Promise((resolve) => httpServer.listen(0, resolve));
  t.after(() => io.close());
  const base = `http://localhost:${httpServer.address().port}`;
  for (const path of ['/', '/host', '/player.js', '/host.js', '/socket.io/socket.io.js']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, `${path} should return 200`);
  }
});
