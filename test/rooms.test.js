const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomStore, randomCode, publicPlayers } = require('../src/rooms');

// Codes come from the list given; tokens are numbered so tests can predict them.
function storeWithCodes(...codes) {
  let n = 0;
  return new RoomStore({ generateCode: () => codes.shift(), generateToken: (prefix) => `${prefix}${++n}` });
}

test('randomCode is 4 readable uppercase letters', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(randomCode(), /^[A-HJ-NP-Z]{4}$/);
  }
});

test('createRoom skips codes already in use and gives the host a key', () => {
  const store = storeWithCodes('AAAA', 'AAAA', 'BBBB');
  const a = store.createRoom('s-host1');
  assert.equal(a.code, 'AAAA');
  assert.equal(a.hostKey, 'h_1');
  assert.equal(store.createRoom('s-host2').code, 'BBBB');
  assert.throws(() => store.createRoom('s-host1'), { code: 'ALREADY_IN_ROOM' });
});

test('joinRoom gives a stable id and a rejoin key, accepts lowercase codes, trims names', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('s-host');
  const { room, player } = store.joinRoom(' abcd ', 's1', '  Harsh  ');
  assert.equal(room.code, 'ABCD');
  assert.equal(player.name, 'Harsh');
  assert.match(player.id, /^p_/);
  assert.match(player.key, /^k_/);
  assert.notEqual(player.id, 's1');
  assert.deepEqual(publicPlayers(room), [{ id: player.id, name: 'Harsh', connected: true }]);
});

test('joinRoom rejects unknown rooms, bad names and duplicate names', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('s-host');
  assert.throws(() => store.joinRoom('ZZZZ', 's1', 'A'), { code: 'ROOM_NOT_FOUND' });
  assert.throws(() => store.joinRoom('ABCD', 's1', '   '), { code: 'BAD_NAME' });
  assert.throws(() => store.joinRoom('ABCD', 's1', 'x'.repeat(17)), { code: 'BAD_NAME' });
  store.joinRoom('ABCD', 's1', 'Sam');
  assert.throws(() => store.joinRoom('ABCD', 's2', 'SAM'), { code: 'NAME_TAKEN' });
  assert.throws(() => store.joinRoom('ABCD', 's1', 'Other'), { code: 'ALREADY_IN_ROOM' });
});

test('updateMotion finds the player behind a socket and rejects bad readings', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('s-host');
  const { player } = store.joinRoom('ABCD', 's1', 'Sam');
  assert.equal(store.updateMotion('s1', 3.5).player.id, player.id);
  assert.throws(() => store.updateMotion('s1', -1), { code: 'BAD_MOTION' });
  assert.throws(() => store.updateMotion('s1', 'fast'), { code: 'BAD_MOTION' });
  assert.equal(store.updateMotion('stranger', 1), null);
  assert.equal(store.updateMotion('s-host', 1), null);
});

test('a disconnected player keeps their place and resumes on a new socket', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('s-host');
  const { room, player } = store.joinRoom('ABCD', 's1', 'Sam');
  const gone = store.disconnect('s1');
  assert.equal(gone.role, 'player');
  assert.equal(gone.player.id, player.id);
  assert.equal(room.players.get(player.id).connected, false);
  assert.equal(store.updateMotion('s1', 1), null);

  const back = store.resumePlayer('s2', 'abcd', player.key);
  assert.equal(back.player.id, player.id);
  assert.equal(back.player.connected, true);
  assert.equal(store.updateMotion('s2', 1).player.id, player.id);
  assert.throws(() => store.resumePlayer('s3', 'ABCD', 'k_wrong'), { code: 'UNKNOWN_PLAYER' });
});

test('a reload can resume before the old socket disconnects; the old socket is then ignored', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('s-host');
  const { player } = store.joinRoom('ABCD', 's1', 'Sam');
  store.resumePlayer('s2', 'ABCD', player.key);
  assert.equal(store.disconnect('s1'), null);
  assert.equal(store.playerOf('s2').player.connected, true);
});

test('removePlayer drops a player for good', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('s-host');
  const { room, player } = store.joinRoom('ABCD', 's1', 'Sam');
  store.joinRoom('ABCD', 's2', 'Alex');
  store.disconnect('s1');
  assert.equal(store.removePlayer('ABCD', player.id), true);
  assert.deepEqual([...room.players.values()].map((p) => p.name), ['Alex']);
  assert.throws(() => store.resumePlayer('s3', 'ABCD', player.key), { code: 'UNKNOWN_PLAYER' });
  assert.equal(store.removePlayer('ABCD', player.id), false);
});

test('the host resumes with their key; only the host can change the threshold', () => {
  const store = storeWithCodes('ABCD');
  const room = store.createRoom('s-host');
  store.joinRoom('ABCD', 's1', 'Sam');
  assert.equal(store.setThreshold('s-host', 3).threshold, 3);
  assert.throws(() => store.setThreshold('s1', 3), { code: 'NOT_HOST' });
  assert.throws(() => store.setThreshold('s-host', 0), { code: 'BAD_THRESHOLD' });
  assert.throws(() => store.setThreshold('s-host', 99), { code: 'BAD_THRESHOLD' });
  assert.throws(() => store.setThreshold('s-host', NaN), { code: 'BAD_THRESHOLD' });

  assert.equal(store.disconnect('s-host').role, 'host');
  assert.equal(room.hostConnected, false);
  assert.throws(() => store.hostedRoom('s-host'), { code: 'NOT_HOST' });
  assert.throws(() => store.resumeHost('s-new', 'ABCD', 'h_wrong'), { code: 'BAD_KEY' });
  assert.equal(store.resumeHost('s-new', 'ABCD', room.hostKey), room);
  assert.equal(room.hostConnected, true);
  assert.equal(store.hostedRoom('s-new'), room);
});

test('closeRoom removes the room and everyone in it', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('s-host');
  store.joinRoom('ABCD', 's1', 'Sam');
  store.closeRoom('ABCD');
  assert.equal(store.rooms.size, 0);
  assert.equal(store.playerOf('s1'), null);
  assert.throws(() => store.hostedRoom('s-host'), { code: 'NOT_HOST' });
});
