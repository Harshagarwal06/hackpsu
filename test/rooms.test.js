const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomStore, randomCode } = require('../src/rooms');

function storeWithCodes(...codes) {
  return new RoomStore({ generateCode: () => codes.shift() });
}

test('randomCode is 4 readable uppercase letters', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(randomCode(), /^[A-HJ-NP-Z]{4}$/);
  }
});

test('createRoom skips codes already in use', () => {
  const store = storeWithCodes('AAAA', 'AAAA', 'BBBB');
  assert.equal(store.createRoom('host1').code, 'AAAA');
  assert.equal(store.createRoom('host2').code, 'BBBB');
});

test('joinRoom accepts lowercase codes and trims names', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('host');
  const { room, player } = store.joinRoom(' abcd ', 'p1', '  Harsh  ');
  assert.equal(room.code, 'ABCD');
  assert.equal(player.name, 'Harsh');
  assert.equal(room.players.size, 1);
});

test('joinRoom rejects unknown rooms, bad names and duplicate names', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('host');
  assert.throws(() => store.joinRoom('ZZZZ', 'p1', 'A'), { code: 'ROOM_NOT_FOUND' });
  assert.throws(() => store.joinRoom('ABCD', 'p1', '   '), { code: 'BAD_NAME' });
  assert.throws(() => store.joinRoom('ABCD', 'p1', 'x'.repeat(17)), { code: 'BAD_NAME' });
  store.joinRoom('ABCD', 'p1', 'Sam');
  assert.throws(() => store.joinRoom('ABCD', 'p2', 'SAM'), { code: 'NAME_TAKEN' });
  assert.throws(() => store.joinRoom('ABCD', 'p1', 'Other'), { code: 'ALREADY_IN_ROOM' });
});

test('updateMotion stores valid readings and rejects bad ones', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('host');
  store.joinRoom('ABCD', 'p1', 'Sam');
  const room = store.updateMotion('p1', 3.5);
  assert.equal(room.players.get('p1').motion, 3.5);
  assert.throws(() => store.updateMotion('p1', -1), { code: 'BAD_MOTION' });
  assert.throws(() => store.updateMotion('p1', 'fast'), { code: 'BAD_MOTION' });
  assert.equal(store.updateMotion('stranger', 1), null);
});

test('player leaving removes only that player', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('host');
  store.joinRoom('ABCD', 'p1', 'Sam');
  store.joinRoom('ABCD', 'p2', 'Alex');
  const left = store.leave('p1');
  assert.equal(left.wasHost, false);
  assert.deepEqual([...left.room.players.keys()], ['p2']);
  assert.equal(store.leave('p1'), null);
});

test('host leaving closes the room for everyone', () => {
  const store = storeWithCodes('ABCD');
  store.createRoom('host');
  store.joinRoom('ABCD', 'p1', 'Sam');
  const left = store.leave('host');
  assert.equal(left.wasHost, true);
  assert.equal(store.rooms.size, 0);
  assert.equal(store.roomOf('p1'), undefined);
});
