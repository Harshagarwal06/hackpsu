const test = require('node:test');
const assert = require('node:assert/strict');
const { RedLightRound } = require('../src/redLight');

const OPTIONS = {
  cycles: 2,
  greenMinMs: 1000,
  greenMaxMs: 1000,
  redMs: 1000,
  graceMs: 300,
  finishSteps: 3,
  minStepGapMs: 80,
};

// Builds a round with fake timers and records every event it emits.
function setup(t, { threshold = 1, players = [['a', 'Ann'], ['b', 'Ben']], options = {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const events = [];
  const round = new RedLightRound({
    players: new Map(players),
    getThreshold: () => threshold,
    random: () => 0,
    options: { ...OPTIONS, ...options },
    on: {
      start: () => {},
      phase: (info) => events.push(['phase', info.phase, info.cycle]),
      player: (id, state) => events.push(['player', id, state.status, state.progress]),
      over: (summary) => events.push(['over', summary]),
    },
  });
  return { round, events, tick: (ms) => t.mock.timers.tick(ms) };
}

const statuses = (events) => {
  const over = events.find((e) => e[0] === 'over');
  return Object.fromEntries(over[1].results.map((r) => [r.id, r.status]));
};

test('cycles green and red, then eliminates whoever did not cross', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  tick(1000); // red 1
  tick(1000); // green 2
  tick(1000); // red 2
  tick(1000); // past last cycle -> time
  const phases = events.filter((e) => e[0] === 'phase').map((e) => `${e[1]}${e[2]}`);
  assert.deepEqual(phases, ['green1', 'red1', 'green2', 'red2']);
  const over = events.find((e) => e[0] === 'over')[1];
  assert.equal(over.reason, 'time');
  assert.deepEqual(statuses(events), { a: 'eliminated', b: 'eliminated' });
});

test('moving during green fills progress and crossing makes you safe', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  for (let i = 0; i < 3; i++) {
    round.handleMotion('a', 5);
    tick(100);
  }
  assert.deepEqual(events.filter((e) => e[0] === 'player' && e[1] === 'a').map((e) => e[2]),
    ['playing', 'playing', 'finished']);
  // Crossed players can't be eliminated during red.
  tick(1000); // red 1
  tick(300);
  round.handleMotion('a', 50);
  tick(700); // green 2
  tick(1000); // red 2
  tick(1000); // time
  assert.deepEqual(statuses(events), { a: 'finished', b: 'eliminated' });
});

test('motion below the threshold does not count as moving', (t) => {
  const { round, events, tick } = setup(t, { threshold: 2 });
  round.start();
  round.handleMotion('a', 1.9);
  tick(1000); // red
  tick(400); // past grace
  round.handleMotion('a', 2);
  assert.equal(events.filter((e) => e[0] === 'player').length, 0);
});

test('samples sent faster than allowed only earn one step', (t) => {
  const { round, events } = setup(t);
  round.start();
  for (let i = 0; i < 10; i++) round.handleMotion('a', 5);
  const steps = events.filter((e) => e[0] === 'player' && e[1] === 'a');
  assert.equal(steps.length, 1);
});

test('moving during red is allowed during the grace period, then eliminates', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  tick(1000); // red starts
  round.seenRed('a'); // phone shows red straight away
  tick(200);
  round.handleMotion('a', 5); // inside grace
  assert.equal(events.filter((e) => e[0] === 'player').length, 0);
  tick(100); // grace over
  round.handleMotion('a', 5);
  assert.deepEqual(events.at(-1), ['player', 'a', 'eliminated', 0]);
});

test('the grace period counts from when each phone shows red', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  tick(1000); // red starts on the server
  round.seenRed('a');
  tick(250); // Ben's phone is slow: it shows red 250 ms later
  round.seenRed('b');
  tick(100); // 350 ms after red: Ann's grace is over, Ben's is not
  round.handleMotion('a', 5);
  round.handleMotion('b', 5);
  assert.deepEqual(events.filter((e) => e[0] === 'player').map((e) => [e[1], e[2]]), [['a', 'eliminated']]);
  tick(200); // 300 ms after Ben's phone showed red
  round.handleMotion('b', 5);
  assert.deepEqual(events.filter((e) => e[0] === 'player').map((e) => [e[1], e[2]]), [['a', 'eliminated'], ['b', 'eliminated']]);
});

test('a phone that never confirms red gets its grace from the 1 second cap', (t) => {
  const { round, events, tick } = setup(t, { options: { redMs: 3000 } });
  round.start();
  tick(1000); // red starts; Ann's phone never says it saw it
  tick(1200); // 1000 ms cap + 200 ms: still inside the 300 ms grace
  round.handleMotion('a', 5);
  assert.equal(events.filter((e) => e[0] === 'player').length, 0);
  tick(100);
  round.handleMotion('a', 5);
  assert.deepEqual(events.at(-1), ['player', 'a', 'eliminated', 0]);
});

test('seeing red only counts during red, once per light', (t) => {
  const { round, tick } = setup(t);
  round.start();
  round.seenRed('a'); // green: ignored
  tick(1000); // red
  assert.equal(round.players.get('a').redSeenAt, null);
  round.seenRed('a');
  const first = round.players.get('a').redSeenAt;
  tick(50);
  round.seenRed('a');
  assert.equal(round.players.get('a').redSeenAt, first);
});

test('round ends early once nobody is still playing', (t) => {
  const { round, events, tick } = setup(t, { players: [['a', 'Ann']] });
  round.start();
  tick(1000); // red
  round.seenRed('a');
  tick(300); // grace over
  round.handleMotion('a', 5);
  const over = events.find((e) => e[0] === 'over')[1];
  assert.equal(over.reason, 'done');
  // No more phases after the round is over.
  const phasesBefore = events.filter((e) => e[0] === 'phase').length;
  tick(10_000);
  assert.equal(events.filter((e) => e[0] === 'phase').length, phasesBefore);
});

test('results report crossing time and average movement on red', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  for (let i = 0; i < 3; i++) {
    round.handleMotion('a', 5); // Ann crosses after 3 steps, 200 ms in
    tick(100);
  }
  tick(700); // red
  round.seenRed('b');
  round.handleMotion('b', 0.5);
  round.handleMotion('b', 0.25);
  round.stop();
  const results = Object.fromEntries(events.find((e) => e[0] === 'over')[1].results.map((r) => [r.id, r]));
  assert.equal(results.a.crossMs, 200);
  assert.equal(results.b.crossMs, null);
  assert.equal(results.b.redAvg, 0.375);
  assert.equal(results.b.redSamples, 2);
  assert.equal(results.a.redAvg, null);
});

test('host stop ends the round without eliminating anyone', (t) => {
  const { round, events } = setup(t);
  round.start();
  round.stop();
  assert.deepEqual(statuses(events), { a: 'playing', b: 'playing' });
  assert.equal(events.at(-1)[1].reason, 'host');
});

test('a player leaving mid-round is dropped; last one leaving ends it', (t) => {
  const { round, events } = setup(t);
  round.start();
  round.removePlayer('a');
  assert.equal(events.some((e) => e[0] === 'over'), false);
  round.removePlayer('b');
  assert.equal(events.at(-1)[1].reason, 'done');
});

test('cancel stops timers silently', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  const count = events.length;
  round.cancel();
  tick(10_000);
  assert.equal(events.length, count);
});

test('the threshold is read live, so the host can change it mid-round', (t) => {
  let threshold = 10;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const events = [];
  const round = new RedLightRound({
    players: new Map([['a', 'Ann']]),
    getThreshold: () => threshold,
    random: () => 0,
    options: OPTIONS,
    on: { start() {}, phase() {}, player: (id, s) => events.push(s.status), over() {} },
  });
  round.start();
  round.handleMotion('a', 5);
  assert.equal(events.length, 0);
  threshold = 1;
  round.handleMotion('a', 5);
  assert.deepEqual(events, ['playing']);
});
