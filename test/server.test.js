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

test('Red Light, Green Light over sockets', async (t) => {
  const { httpServer, io } = createGameServer({
    roundOptions: { cycles: 1, greenMinMs: 50, greenMaxMs: 50, redMs: 5000, graceMs: 0 },
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;
  const host = connect(url);
  const p1 = connect(url);
  const p2 = connect(url);
  t.after(() => {
    for (const s of [host, p1, p2]) s.close();
    io.close();
  });

  const { code } = await emitWithAck(host, 'host:create');
  const empty = await emitWithAck(host, 'host:start-redlight');
  assert.equal(empty.error.code, 'NO_PLAYERS');

  const ann = await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });

  const notHost = await emitWithAck(p1, 'host:start-redlight');
  assert.equal(notHost.error.code, 'NOT_HOST');
  const threshold = await emitWithAck(host, 'host:threshold', 2);
  assert.equal(threshold.threshold, 2);

  const green = once(p2, 'rl:phase');
  assert.equal((await emitWithAck(host, 'host:start-redlight')).ok, true);
  assert.equal((await green).phase, 'green');
  const again = await emitWithAck(host, 'host:start-redlight');
  assert.equal(again.error.code, 'ROUND_RUNNING');

  // Wait for red, then Ann moves.
  await new Promise((resolve) => {
    p1.on('rl:phase', (info) => { if (info.phase === 'red') resolve(); });
  });
  const hostSeesOut = once(host, 'rl:player');
  const annSeesOut = once(p1, 'rl:player');
  p1.emit('player:motion', 9);
  assert.deepEqual(await hostSeesOut, { id: ann.id, status: 'eliminated', progress: 0 });
  assert.equal((await annSeesOut).status, 'eliminated');

  const over = once(p2, 'rl:over');
  assert.equal((await emitWithAck(host, 'host:end-round')).ok, true);
  const summary = await over;
  assert.equal(summary.reason, 'host');
  assert.deepEqual(summary.results.map((r) => [r.name, r.status]), [['Ann', 'eliminated'], ['Ben', 'playing']]);
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
