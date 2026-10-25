const test = require('node:test');
const assert = require('node:assert/strict');
const { TugOfWarRound } = require('../src/tugOfWar');

const OPTIONS = {
  countdownMs: 300,
  durationMs: 2000,
  tickMs: 100,
  staleMs: 400,
  maxForce: 25,
  pullRate: 0.1,
};

// random() = 0.99 keeps the input order, so with ids a,b,c,d the teams
// alternate: a pink, b teal, c pink, d teal.
function setup(t, { players = [['a', 'Ann'], ['b', 'Ben']], options = {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const events = [];
  const round = new TugOfWarRound({
    players: new Map(players),
    random: () => 0.99,
    options: { ...OPTIONS, ...options },
    on: {
      start: (info) => events.push(['start', info]),
      state: (info) => events.push(['state', info]),
      over: (summary) => events.push(['over', summary]),
    },
  });
  // Advance the clock one tick at a time, sending motion before each tick.
  const run = (ms, motion = {}) => {
    for (let i = 0; i < ms / 100; i++) {
      for (const [id, m] of Object.entries(motion)) round.handleMotion(id, m);
      t.mock.timers.tick(100);
    }
  };
  return { round, events, run };
}

const over = (events) => events.find((e) => e[0] === 'over')?.[1];
const lastState = (events) => events.filter((e) => e[0] === 'state').at(-1)[1];

test('needs at least 2 players', () => {
  assert.throws(() => new TugOfWarRound({ players: new Map([['a', 'Ann']]), on: {} }));
});

test('splits players into teams that differ by at most one', (t) => {
  const { round, events } = setup(t, {
    players: [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D'], ['e', 'E']],
  });
  round.start();
  const teams = events[0][1].teams;
  const pink = teams.filter((p) => p.team === 'pink').length;
  const teal = teams.filter((p) => p.team === 'teal').length;
  assert.equal(pink + teal, 5);
  assert.ok(Math.abs(pink - teal) <= 1);
});

const teamsOf = (round) => Object.fromEntries([...round.players.values()].map((p) => [p.id, p.team]));
const five = new Map([['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D'], ['e', 'E']]);

test('picked players go on their team; the rest fill the smaller team', () => {
  const round = new TugOfWarRound({
    players: five,
    picks: new Map([['a', 'teal'], ['b', 'teal'], ['c', 'teal']]),
    random: () => 0.99,
    on: {},
  });
  // Three picked Teal, so both unpicked players go to Pink (3 v 2).
  assert.deepEqual(teamsOf(round), { a: 'teal', b: 'teal', c: 'teal', d: 'pink', e: 'pink' });
});

test('picks can make lopsided teams on purpose', () => {
  const round = new TugOfWarRound({
    players: five,
    picks: new Map([['a', 'pink'], ['b', 'teal'], ['c', 'teal'], ['d', 'teal'], ['e', 'teal']]),
    on: {},
  });
  assert.deepEqual(teamsOf(round), { a: 'pink', b: 'teal', c: 'teal', d: 'teal', e: 'teal' });
});

test('picks for players not in the round are ignored; bad teams and one-sided picks are refused', () => {
  const two = new Map([['a', 'A'], ['b', 'B']]);
  const round = new TugOfWarRound({ players: two, picks: new Map([['gone', 'pink'], ['a', 'teal']]), on: {} });
  assert.deepEqual(teamsOf(round), { a: 'teal', b: 'pink' });
  assert.throws(() => new TugOfWarRound({ players: two, picks: new Map([['a', 'purple']]), on: {} }));
  assert.throws(() => new TugOfWarRound({ players: two, picks: new Map([['a', 'pink'], ['b', 'pink']]), on: {} }));
});

test('shaking during the countdown does nothing', (t) => {
  const { round, events, run } = setup(t);
  round.start();
  run(200, { a: 20 });
  assert.equal(lastState(events).rope, 0);
});

test('the stronger team pulls the rope across and wins', (t) => {
  const { round, events, run } = setup(t);
  round.start();
  run(300); // countdown
  run(1000, { a: 20, b: 5 }); // pink (a) pulls: 15 * 0.1 * 0.1 = 0.15 per tick
  const result = over(events);
  assert.equal(result.reason, 'pulled');
  assert.equal(result.winner, 'pink');
  assert.deepEqual(result.results.map((r) => [r.id, r.status]), [['a', 'won'], ['b', 'eliminated']]);
});

test('team strength is an average, so a bigger team has no free advantage', (t) => {
  const { round, events, run } = setup(t, { players: [['a', 'A'], ['b', 'B'], ['c', 'C']] });
  round.start(); // pink: a, c   teal: b
  run(300);
  run(500, { a: 10, b: 10, c: 10 });
  assert.equal(lastState(events).rope, 0);
});

test('readings are capped and stale readings count as zero', (t) => {
  const { round, events, run } = setup(t);
  round.start();
  run(300);
  run(100, { a: 1000 }); // capped at 25: 25 * 0.1 * 0.1 = 0.25
  assert.ok(Math.abs(lastState(events).rope - 0.25) < 1e-9);
  run(500); // a stops sending; after 400 ms its reading is stale
  const rope = lastState(events).rope;
  run(300);
  assert.equal(lastState(events).rope, rope);
});

test('when time runs out, the team ahead wins', (t) => {
  const { round, events, run } = setup(t, { options: { pullRate: 0.001 } });
  round.start();
  run(300);
  run(2000, { a: 3, b: 10 });
  const result = over(events);
  assert.equal(result.reason, 'time');
  assert.equal(result.winner, 'teal');
});

test('a dead-even finish has no winner and eliminates nobody', (t) => {
  const { round, events, run } = setup(t);
  round.start();
  run(300);
  run(2000);
  const result = over(events);
  assert.equal(result.winner, null);
  assert.ok(result.results.every((r) => r.status === 'playing'));
});

test('if a whole team leaves, the other team wins by forfeit', (t) => {
  const { round, events } = setup(t);
  round.start();
  round.removePlayer('b');
  const result = over(events);
  assert.equal(result.reason, 'forfeit');
  assert.equal(result.winner, 'pink');
});

test('host stop eliminates nobody', (t) => {
  const { round, events } = setup(t);
  round.start();
  round.stop();
  assert.equal(over(events).reason, 'host');
  assert.ok(over(events).results.every((r) => r.status === 'playing'));
});

test('cancel stops timers silently', (t) => {
  const { round, events, run } = setup(t);
  round.start();
  const count = events.length;
  round.cancel();
  run(3000);
  assert.equal(events.length, count);
});
