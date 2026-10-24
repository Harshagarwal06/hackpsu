const test = require('node:test');
const assert = require('node:assert/strict');
const { GlassBridgeRound, stepsFor } = require('../src/glassBridge');

const OPTIONS = { steps: 3, chooseMs: 1000, revealMs: 200 };

// random() = 0.99 keeps players in the given order, makes every safe panel
// 'right', and pushes frozen players 'right' too.
function setup(t, { players = [['a', 'Ann'], ['b', 'Ben']], options = {}, random = () => 0.99 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const events = [];
  const round = new GlassBridgeRound({
    players: new Map(players),
    random,
    options: { ...OPTIONS, ...options },
    on: {
      start: (info) => events.push(['start', info]),
      state: (info) => events.push(['state', info]),
      jump: (info) => events.push(['jump', info]),
      over: (summary) => events.push(['over', summary]),
    },
  });
  return { round, events, tick: (ms) => t.mock.timers.tick(ms) };
}

const lastState = (events) => events.filter((e) => e[0] === 'state').at(-1)[1];
const over = (events) => events.find((e) => e[0] === 'over')?.[1];
const statuses = (events) => Object.fromEntries(over(events).results.map((r) => [r.id, r.status]));

test('bridge length scales with players, between 3 and 10', () => {
  assert.equal(stepsFor(1), 3);
  assert.equal(stepsFor(5), 6);
  assert.equal(stepsFor(40), 10);
});

test('first player goes first and only they can choose', (t) => {
  const { round, events } = setup(t);
  round.start();
  const s = lastState(events);
  assert.equal(s.phase, 'choosing');
  assert.equal(s.current, 'a');
  assert.equal(s.position, 0);
  assert.equal(round.choose('b', 'left'), false);
  assert.throws(() => round.choose('a', 'up'));
});

test('a safe jump moves you forward; crossing the last step ends it for everyone', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  for (let step = 0; step < 3; step++) {
    assert.equal(round.choose('a', 'right'), true);
    assert.equal(events.filter((e) => e[0] === 'jump').at(-1)[1].correct, true);
    tick(200);
  }
  assert.equal(over(events).reason, 'crossed');
  // The whole bridge is known, so Ben walks across too.
  assert.deepEqual(statuses(events), { a: 'finished', b: 'finished' });
});

test('a wrong jump eliminates you and the next player starts where you fell', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  round.choose('a', 'right'); // step 0 safe
  tick(200);
  round.choose('a', 'left'); // step 1 breaks
  assert.equal(lastState(events).players.find((p) => p.id === 'a').status, 'eliminated');
  tick(200);
  const s = lastState(events);
  assert.equal(s.current, 'b');
  assert.equal(s.position, 2); // steps 0 and 1 are both known now
  assert.deepEqual(s.revealed, ['right', 'right']);
});

test('freezing past the timer pushes you onto a random panel', (t) => {
  const { round, events, tick } = setup(t, { random: () => 0.99 });
  round.start();
  tick(1000);
  const jump = events.find((e) => e[0] === 'jump')[1];
  assert.equal(jump.forced, true);
  assert.equal(jump.side, 'right');
});

test('if everyone falls, nobody crosses', (t) => {
  const { round, events, tick } = setup(t, { options: { steps: 5 } });
  round.start();
  round.choose('a', 'left');
  tick(200);
  round.choose('b', 'left');
  tick(200);
  assert.equal(over(events).reason, 'done');
  assert.deepEqual(statuses(events), { a: 'eliminated', b: 'eliminated' });
  // Ann fell on step 1 (got past 0 steps), Ben walked across it and fell on step 2.
  assert.deepEqual(over(events).results.map((r) => [r.id, r.reached]), [['a', 0], ['b', 1]]);
});

test('crossing players have reached every step', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  for (let step = 0; step < 3; step++) {
    round.choose('a', 'right');
    tick(200);
  }
  assert.deepEqual(over(events).results.map((r) => [r.id, r.reached]), [['a', 3], ['b', 3]]);
});

test('the player on the bridge leaving hands the turn to the next player', (t) => {
  const { round, events } = setup(t);
  round.start();
  round.removePlayer('a');
  assert.equal(lastState(events).current, 'b');
  assert.equal(lastState(events).position, 0);
});

test('host stop ends it without eliminating anyone; cancel is silent', (t) => {
  const { round, events, tick } = setup(t);
  round.start();
  round.stop();
  assert.equal(over(events).reason, 'host');
  assert.deepEqual(statuses(events), { a: 'playing', b: 'playing' });
  const count = events.length;
  tick(5000);
  assert.equal(events.length, count);
});
