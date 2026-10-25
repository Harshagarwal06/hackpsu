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
  const { httpServer, io } = createGameServer({ introMs: 0, reconnectMs: 50 });
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

  // The host doesn't come back within the reconnect window: the room closes.
  const closed = once(player, 'room:closed');
  host.close();
  await closed;
});

test('a player who drops out comes back as themselves, mid-round', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    roundOptions: { cycles: 1, greenMinMs: 5000, greenMaxMs: 5000 },
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
  const ann = await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });
  await emitWithAck(host, 'host:start-redlight');

  // Ann's phone loses its connection: the host sees her as away, not gone.
  const away = once(host, 'room:players');
  p1.disconnect();
  assert.deepEqual((await away).map((p) => [p.name, p.connected]), [['Ann', false], ['Ben', true]]);

  // She comes back on a new socket with her key: same id, round replayed.
  const p1b = connect(url);
  t.after(() => p1b.close());
  const start = once(p1b, 'rl:start');
  const phase = once(p1b, 'rl:phase');
  const back = await emitWithAck(p1b, 'player:resume', { code, key: ann.key });
  assert.equal(back.ok, true);
  assert.equal(back.id, ann.id);
  assert.equal(back.roundRunning, true);
  assert.deepEqual((await start).players.map((p) => p.name), ['Ann', 'Ben']);
  assert.equal((await phase).phase, 'green');

  // Her motion counts as hers again.
  const motion = once(host, 'player:motion');
  p1b.emit('player:motion', 1);
  assert.equal((await motion).id, ann.id);

  const stranger = connect(url);
  t.after(() => stranger.close());
  const wrongKey = await emitWithAck(stranger, 'player:resume', { code, key: 'k_nope' });
  assert.equal(wrongKey.error.code, 'UNKNOWN_PLAYER');
});

test('a player who stays away too long is dropped from the room and the game', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    reconnectMs: 50,
    roundOptions: { greenMinMs: 5000, greenMaxMs: 5000 },
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;
  const host = connect(url);
  const p1 = connect(url);
  const p2 = connect(url);
  const p3 = connect(url);
  t.after(() => {
    for (const s of [host, p1, p2, p3]) s.close();
    io.close();
  });

  const { code } = await emitWithAck(host, 'host:create');
  const ann = await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });
  await emitWithAck(p3, 'player:join', { code, name: 'Cal' });
  await emitWithAck(host, 'host:game-start');

  const gameUpdate = once(host, 'game:state');
  p1.disconnect();
  const state = await gameUpdate; // sent once the 50 ms window runs out
  assert.deepEqual(state.alive.map((p) => p.name), ['Ben', 'Cal']);
  const p1b = connect(url);
  t.after(() => p1b.close());
  const late = await emitWithAck(p1b, 'player:resume', { code, key: ann.key });
  assert.equal(late.error.code, 'UNKNOWN_PLAYER');
});

test('the host reconnects to the same room and sees the game it left', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    roundOptions: { greenMinMs: 5000, greenMaxMs: 5000 },
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

  const created = await emitWithAck(host, 'host:create');
  await emitWithAck(p1, 'player:join', { code: created.code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code: created.code, name: 'Ben' });
  await emitWithAck(host, 'host:game-start');

  let closed = false;
  p1.on('room:closed', () => { closed = true; });
  host.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(closed, false);

  const host2 = connect(url);
  t.after(() => host2.close());
  const players = once(host2, 'room:players');
  const game = once(host2, 'game:state');
  const start = once(host2, 'rl:start');
  const bad = await emitWithAck(host2, 'host:resume', { code: created.code, key: 'h_nope' });
  assert.equal(bad.error.code, 'BAD_KEY');
  const back = await emitWithAck(host2, 'host:resume', { code: created.code, key: created.key });
  assert.equal(back.ok, true);
  assert.equal(back.code, created.code);
  assert.equal((await players).length, 2);
  assert.equal((await game).phase, 'playing');
  assert.equal((await start).players.length, 2);
  // Host controls work again from the new connection.
  assert.equal((await emitWithAck(host2, 'host:end-round')).ok, true);
});

test('practice Tug of War uses the host\'s team picks; the real game ignores them', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    tugOptions: { countdownMs: 5000 },
    roundOptions: { greenMinMs: 5000, greenMaxMs: 5000 },
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;
  const host = connect(url);
  const phones = [connect(url), connect(url), connect(url)];
  t.after(() => {
    for (const s of [host, ...phones]) s.close();
    io.close();
  });

  const { code } = await emitWithAck(host, 'host:create');
  const [ann, ben, cal] = await Promise.all(
    ['Ann', 'Ben', 'Cal'].map((name, i) => emitWithAck(phones[i], 'player:join', { code, name })),
  );

  // Mistakes are refused with a clear reason.
  const bad = await emitWithAck(host, 'host:start-tug', { teams: { [ann.id]: 'purple' } });
  assert.equal(bad.error.code, 'BAD_TEAMS');
  const oneSided = await emitWithAck(host, 'host:start-tug', {
    teams: { [ann.id]: 'pink', [ben.id]: 'pink', [cal.id]: 'pink' },
  });
  assert.equal(oneSided.error.code, 'ONE_TEAM');

  // "Judges vs us": Ann alone on Teal, Ben picked Pink, Cal left to chance
  // (joins the smaller team, Pink is 1 v Teal 1, tie goes to Pink).
  const started = once(host, 'tow:start');
  const ok = await emitWithAck(host, 'host:start-tug', {
    teams: { [ann.id]: 'teal', [ben.id]: 'pink', p_gone: 'teal' },
  });
  assert.equal(ok.ok, true);
  const teams = Object.fromEntries((await started).teams.map((m) => [m.name, m.team]));
  assert.deepEqual(teams, { Ann: 'teal', Ben: 'pink', Cal: 'pink' });
  await emitWithAck(host, 'host:end-round');

  // The real game has no way to pass picks: Start Game takes no payload.
  await emitWithAck(host, 'host:game-start');
  const gameTug = await emitWithAck(host, 'host:start-tug', { teams: { [ann.id]: 'teal' } });
  assert.equal(gameTug.error.code, 'ROUND_RUNNING');
});

test('the host can kick a player out of the room and the game', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    roundOptions: { greenMinMs: 5000, greenMaxMs: 5000 },
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;
  const host = connect(url);
  const p1 = connect(url);
  const p2 = connect(url);
  const p3 = connect(url);
  t.after(() => {
    for (const s of [host, p1, p2, p3]) s.close();
    io.close();
  });

  const { code } = await emitWithAck(host, 'host:create');
  const ann = await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });
  await emitWithAck(p3, 'player:join', { code, name: 'Cal' });
  await emitWithAck(host, 'host:game-start');

  // Only the host can kick, and only someone in the room.
  assert.equal((await emitWithAck(p2, 'host:kick', ann.id)).error.code, 'NOT_HOST');
  assert.equal((await emitWithAck(host, 'host:kick', 'p_nobody')).error.code, 'NO_PLAYER');

  const kicked = once(p1, 'player:kicked');
  const players = once(host, 'room:players');
  const game = once(host, 'game:state');
  assert.equal((await emitWithAck(host, 'host:kick', ann.id)).ok, true);
  await kicked;
  assert.deepEqual((await players).map((p) => p.name), ['Ben', 'Cal']);
  assert.deepEqual((await game).alive.map((p) => p.name), ['Ben', 'Cal']);

  // Ann's phone no longer gets room events, and her rejoin key is dead.
  // (Ending the round sends game:state to everyone still in the room.)
  let leaked = false;
  p1.on('game:state', () => { leaked = true; });
  const ben = once(p2, 'game:state');
  await emitWithAck(host, 'host:end-round');
  await ben;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(leaked, false);
  const p1b = connect(url);
  t.after(() => p1b.close());
  const back = await emitWithAck(p1b, 'player:resume', { code, key: ann.key });
  assert.equal(back.error.code, 'UNKNOWN_PLAYER');
});

test('in a game, Glass Bridge uses the earned turn order; practice does not', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    roundOptions: { greenMinMs: 5000, greenMaxMs: 5000 },
    bridgeOptions: { chooseMs: 5000 },
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
  await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });

  const practice = once(host, 'gb:start');
  await emitWithAck(host, 'host:start-bridge');
  assert.equal((await practice).earned, false);
  await emitWithAck(host, 'host:end-round');

  await emitWithAck(host, 'host:game-start');
  for (let i = 0; i < 2; i++) {
    const next = once(host, 'game:state');
    await emitWithAck(host, 'host:end-round');
    await next;
    if (i === 0) await emitWithAck(host, 'host:game-next');
  }
  const bridge = once(host, 'gb:start');
  await emitWithAck(host, 'host:game-next');
  const start = await bridge;
  assert.equal(start.earned, true);
  assert.deepEqual(start.order.map((p) => p.name).sort(), ['Ann', 'Ben']);
});

test('every round opens with a briefing: rules, then a countdown, then the round', async (t) => {
  const { httpServer, io } = createGameServer({
    introMs: 300,
    roundOptions: { greenMinMs: 5000, greenMaxMs: 5000 },
    tugOptions: { countdownMs: 300 },
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
  const ann = await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });

  // Practice Red Light: the briefing comes first; the round starts after it.
  const intro = once(p1, 'round:intro');
  const started = once(p1, 'rl:start');
  const t0 = Date.now();
  await emitWithAck(host, 'host:start-redlight');
  const info = await intro;
  assert.equal(info.title, 'Practice · Red Light, Green Light');
  assert.deepEqual(info.rules, ['Green: move to fill your bar.', 'Red: freeze, or you are out.']);
  assert.equal(info.ms, 300);
  assert.equal(info.players.length, 2);
  assert.ok(info.players.includes(ann.id));
  await started;
  assert.ok(Date.now() - t0 >= 250, 'the round starts only after the countdown');
  // Blocked while running, then ended.
  assert.equal((await emitWithAck(host, 'host:start-tug')).error.code, 'ROUND_RUNNING');
  await emitWithAck(host, 'host:end-round');

  // Ending during the briefing cancels the round: it never starts.
  let lateStart = false;
  p1.on('rl:start', () => { lateStart = true; });
  const over = once(p1, 'rl:over');
  await emitWithAck(host, 'host:start-redlight');
  await emitWithAck(host, 'host:end-round');
  assert.equal((await over).reason, 'host');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(lateStart, false);

  // A phone that reconnects during the briefing sees the rest of the countdown.
  const replay = new Promise((resolve) => {
    p1.once('round:intro', () => {
      const p1b = connect(url);
      t.after(() => p1b.close());
      p1.disconnect();
      p1b.once('round:intro', resolve);
      p1b.emit('player:resume', { code, key: ann.key }, () => {});
    });
  });
  await emitWithAck(host, 'host:start-bridge');
  const again = await replay;
  assert.equal(again.key, 'bridge');
  assert.ok(again.ms <= 300);
  await emitWithAck(host, 'host:end-round');

  // Tug of War: its countdown is the briefing, so teams arrive with it.
  const tugIntro = once(p2, 'round:intro');
  const tugStart = once(p2, 'tow:start');
  await emitWithAck(host, 'host:start-tug');
  assert.equal((await tugIntro).ms, 300);
  assert.equal((await tugStart).teams.length, 2);
  await emitWithAck(host, 'host:end-round');
});

test('in a game, briefings say which round it is and explain the earned bridge order', async (t) => {
  const { httpServer, io } = createGameServer({
    introMs: 0,
    roundOptions: { greenMinMs: 5000, greenMaxMs: 5000 },
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
  await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });
  const titles = [];
  const rules = [];
  host.on('round:intro', (info) => { titles.push(info.title); rules.push(info.rules); });
  await emitWithAck(host, 'host:game-start');
  for (let i = 0; i < 2; i++) {
    const next = once(host, 'game:state');
    await emitWithAck(host, 'host:end-round');
    await next;
    const intro = once(host, 'round:intro');
    await emitWithAck(host, 'host:game-next');
    await intro;
  }
  assert.deepEqual(titles, [
    'Round 1 · Red Light, Green Light',
    'Round 2 · Tug of War',
    'Round 3 · Glass Bridge',
  ]);
  assert.equal(rules[2].at(-1), 'Best players from earlier rounds cross last.');
});

test('a finished game is not re-sent when a player leaves afterwards', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    reconnectMs: 30,
    roundOptions: { cycles: 1, greenMinMs: 5000, greenMaxMs: 5000 },
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
  await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });
  await emitWithAck(host, 'host:game-start');
  // Ending each round keeps everyone in, so the game runs to the end.
  for (let i = 0; i < 3; i++) {
    const next = once(host, 'game:state');
    await emitWithAck(host, 'host:end-round');
    const s = await next;
    if (s.phase === 'intermission') await emitWithAck(host, 'host:game-next');
  }

  let resent = 0;
  host.on('game:state', () => { resent++; });
  const dropped = once(host, 'room:players');
  p1.disconnect();
  await dropped;
  await new Promise((resolve) => setTimeout(resolve, 100)); // past the 30 ms window
  assert.equal(resent, 0);
});

test('Red Light, Green Light over sockets', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
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

  // Wait for red, Ann's phone says it shows red, then Ann moves.
  await new Promise((resolve) => {
    p1.on('rl:phase', (info) => { if (info.phase === 'red') resolve(); });
  });
  p1.emit('rl:seen-red');
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

test('Tug of War over sockets', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    tugOptions: { countdownMs: 50, durationMs: 5000, pullRate: 1 },
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
  await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  const lonely = await emitWithAck(host, 'host:start-tug');
  assert.equal(lonely.error.code, 'NOT_ENOUGH_PLAYERS');
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });

  const started = once(p1, 'tow:start');
  assert.equal((await emitWithAck(host, 'host:start-tug')).ok, true);
  const { teams } = await started;
  const teamOf = Object.fromEntries(teams.map((m) => [m.name, m.team]));
  assert.notEqual(teamOf.Ann, teamOf.Ben);

  // Ann shakes hard every 50 ms until the round ends.
  const done = once(host, 'tow:over');
  const shaking = setInterval(() => p1.emit('player:motion', 20), 50);
  const summary = await done;
  clearInterval(shaking);
  assert.equal(summary.reason, 'pulled');
  assert.equal(summary.winner, teamOf.Ann);
  assert.deepEqual(summary.results.map((r) => [r.name, r.status]).sort(), [['Ann', 'won'], ['Ben', 'eliminated']]);
});

test('Glass Bridge over sockets', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
    bridgeOptions: { steps: 2, chooseMs: 5000, revealMs: 50 },
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
  await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });

  const noRound = await emitWithAck(p1, 'gb:choose', 'left');
  assert.equal(noRound.error.code, 'NO_ROUND');

  const firstState = once(host, 'gb:state');
  const { order } = await new Promise((resolve) => {
    host.once('gb:start', resolve);
    host.emit('host:start-bridge', () => {});
  });
  const state = await firstState;
  const sockets = { Ann: p1, Ben: p2 };
  const first = sockets[order[0].name];
  const second = sockets[order[1].name];
  assert.equal(state.current, order[0].id);

  const wrongTurn = await emitWithAck(second, 'gb:choose', 'left');
  assert.equal(wrongTurn.error.code, 'NOT_YOUR_TURN');
  const badSide = await emitWithAck(first, 'gb:choose', 'up');
  assert.equal(badSide.error.code, 'BAD_SIDE');

  // The live lean of the player on the bridge reaches the host.
  const lean = once(host, 'gb:lean');
  first.emit('gb:lean', -30);
  assert.deepEqual(await lean, { id: order[0].id, gamma: -30 });

  // The first player jumps until they cross or fall, then the second player
  // plays the rest; the round must end either way.
  const done = once(host, 'gb:over');
  host.on('gb:state', (s) => {
    if (s.phase !== 'choosing') return;
    const mover = s.current === order[0].id ? first : second;
    mover.emit('gb:choose', 'left', () => {});
  });
  first.emit('gb:choose', 'left', () => {});
  const summary = await done;
  assert.ok(['crossed', 'done'].includes(summary.reason));
  assert.equal(summary.results.length, 2);
  assert.equal(summary.revealed.length > 0, true);
});

test('a full game: survivors carry over and the game ends with a winner', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0,
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
  await emitWithAck(p1, 'player:join', { code, name: 'Ann' });
  const tooFew = await emitWithAck(host, 'host:game-start');
  assert.equal(tooFew.error.code, 'NOT_ENOUGH_PLAYERS');
  await emitWithAck(p2, 'player:join', { code, name: 'Ben' });

  const playing = once(p1, 'game:state');
  const rlStart = once(p1, 'rl:start');
  assert.equal((await emitWithAck(host, 'host:game-start')).ok, true);
  const first = await playing;
  assert.equal(first.phase, 'playing');
  assert.equal(first.current, 'Red Light, Green Light');
  assert.deepEqual((await rlStart).players.map((p) => p.name), ['Ann', 'Ben']);

  // Practice rounds and a second game are blocked while the game runs.
  assert.equal((await emitWithAck(host, 'host:start-tug')).error.code, 'ROUND_RUNNING');
  assert.equal((await emitWithAck(host, 'host:game-start')).error.code, 'ROUND_RUNNING');

  // Ann moves during red and is eliminated; the host ends the round, Ben stays in.
  await new Promise((resolve) => {
    p1.on('rl:phase', (info) => { if (info.phase === 'red') resolve(); });
  });
  p1.emit('rl:seen-red');
  const annOut = once(p1, 'rl:player');
  p1.emit('player:motion', 9);
  await annOut;
  const final = once(p2, 'game:state');
  await emitWithAck(host, 'host:end-round');
  const state = await final;
  assert.equal(state.phase, 'over');
  assert.deepEqual(state.winners.map((w) => w.name), ['Ben']);
  assert.deepEqual(state.out.map((o) => [o.name, o.round]), [['Ann', 'Red Light, Green Light']]);

  // The game is over, so practice rounds work again.
  assert.equal((await emitWithAck(host, 'host:game-next')).error.code, 'NO_NEXT_ROUND');
  const ended = once(p1, 'game:state');
  assert.equal((await emitWithAck(host, 'host:game-end')).ok, true);
  assert.equal(await ended, null);
});

test('serves the player and host pages', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0 });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  t.after(() => io.close());
  const base = `http://localhost:${httpServer.address().port}`;
  for (const path of ['/', '/host', '/player.js', '/host.js', '/socket.io/socket.io.js']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, `${path} should return 200`);
  }
});

test('serves a QR code for http(s) join links only', async (t) => {
  const { httpServer, io } = createGameServer({ introMs: 0 });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  t.after(() => io.close());
  const base = `http://localhost:${httpServer.address().port}`;

  const ok = await fetch(`${base}/qr.svg?url=${encodeURIComponent('https://example.com/?code=ABCD')}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await ok.text(), /^<svg/);

  for (const bad of ['', '?url=javascript:alert(1)', `?url=https://x.com/${'a'.repeat(300)}`]) {
    const res = await fetch(`${base}/qr.svg${bad}`);
    assert.equal(res.status, 400, `"${bad.slice(0, 30)}" should be rejected`);
  }
});
