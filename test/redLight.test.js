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
  tick(200);
  round.handleMotion('a', 5); // inside grace
  assert.equal(events.filter((e) => e[0] === 'player').length, 0);
  tick(100); // grace over
  round.handleMotion('a', 5);
  assert.deepEqual(events.at(-1), ['player', 'a', 'eliminated', 0]);
});

test('round ends early once nobody is still playing', (t) => {
  const { round, events, tick } = setup(t, { players: [['a', 'Ann']] });
  round.start();
  tick(1000); // red
  tick(300); // grace over
  round.handleMotion('a', 5);
  const over = events.find((e) => e[0] === 'over')[1];
  assert.equal(over.reason, 'done');
  // No more phases after the round is over.
  const phasesBefore = events.filter((e) => e[0] === 'phase').length;
  tick(10_000);
  assert.equal(events.filter((e) => e[0] === 'phase').length, phasesBefore);
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
