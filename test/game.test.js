const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../src/game');

const players = (...names) => new Map(names.map((n) => [n.toLowerCase(), n]));
const result = (id, status) => ({ id, name: id.toUpperCase(), status });

test('needs at least 2 players', () => {
  assert.throws(() => new Game(players('Ann')));
});

test('rounds run in order and only survivors play the next one', () => {
  const game = new Game(players('Ann', 'Ben', 'Cal', 'Dee'));
  const r1 = game.nextRound();
  assert.equal(r1.key, 'redlight');
  assert.deepEqual([...r1.players.keys()], ['ann', 'ben', 'cal', 'dee']);
  game.roundOver([result('ann', 'finished'), result('ben', 'eliminated'), result('cal', 'finished'), result('dee', 'finished')]);
  assert.equal(game.phase, 'intermission');
  assert.equal(game.state().next, 'Tug of War');

  const r2 = game.nextRound();
  assert.equal(r2.key, 'tug');
  assert.deepEqual([...r2.players.keys()], ['ann', 'cal', 'dee']);
  game.roundOver([result('ann', 'won'), result('cal', 'eliminated'), result('dee', 'won')]);

  const r3 = game.nextRound();
  assert.equal(r3.key, 'bridge');
  game.roundOver([result('ann', 'eliminated'), result('dee', 'finished')]);
  const s = game.state();
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.winners, [{ id: 'dee', name: 'Dee' }]);
  assert.deepEqual(s.out.map((o) => [o.id, o.round]), [
    ['ben', 'Red Light, Green Light'],
    ['cal', 'Tug of War'],
    ['ann', 'Glass Bridge'],
  ]);
});

test('the game ends early when only one player is left', () => {
  const game = new Game(players('Ann', 'Ben'));
  game.nextRound();
  game.roundOver([result('ann', 'finished'), result('ben', 'eliminated')]);
  assert.equal(game.phase, 'over');
  assert.deepEqual(game.state().winners, [{ id: 'ann', name: 'Ann' }]);
});

test('a round that would knock out everyone eliminates nobody', () => {
  const game = new Game(players('Ann', 'Ben'));
  game.nextRound();
  game.roundOver([result('ann', 'eliminated'), result('ben', 'eliminated')]);
  assert.equal(game.alive.size, 2);
  assert.match(game.state().note, /another chance/);
  assert.equal(game.phase, 'intermission');
});

test('if everyone falls on the bridge, whoever got furthest wins', () => {
  const game = new Game(players('Ann', 'Ben', 'Cal'));
  game.nextRound();
  game.roundOver([result('ann', 'finished'), result('ben', 'finished'), result('cal', 'finished')]);
  game.nextRound();
  game.roundOver([result('ann', 'won'), result('ben', 'won'), result('cal', 'playing')]);
  game.nextRound();
  game.roundOver([
    { id: 'ann', name: 'Ann', status: 'eliminated', reached: 0 },
    { id: 'ben', name: 'Ben', status: 'eliminated', reached: 2 },
    { id: 'cal', name: 'Cal', status: 'eliminated', reached: 1 },
  ]);
  const s = game.state();
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.winners, [{ id: 'ben', name: 'Ben' }]);
  assert.match(s.note, /Ben got furthest \(to step 3\) and stays in/);
  assert.deepEqual(s.out.map((o) => o.id), ['ann', 'cal']);
});

test('players still "playing" (host ended the round) stay in', () => {
  const game = new Game(players('Ann', 'Ben'));
  game.nextRound();
  game.roundOver([result('ann', 'playing'), result('ben', 'playing')]);
  assert.equal(game.alive.size, 2);
  assert.equal(game.state().note, '');
});

test('results for players who already left are ignored', () => {
  const game = new Game(players('Ann', 'Ben', 'Cal'));
  game.nextRound();
  game.removePlayer('cal');
  game.roundOver([result('ann', 'finished'), result('ben', 'eliminated'), result('cal', 'eliminated')]);
  assert.deepEqual(game.out.map((o) => o.id), ['ben']);
});

test('if players leave during an intermission and one is left, they win', () => {
  const game = new Game(players('Ann', 'Ben', 'Cal'));
  game.nextRound();
  game.roundOver([result('ann', 'finished'), result('ben', 'finished'), result('cal', 'eliminated')]);
  game.removePlayer('ben');
  assert.equal(game.phase, 'over');
  assert.deepEqual(game.state().winners, [{ id: 'ann', name: 'Ann' }]);
});

test('the prize pot grows by 100,000,000 per elimination', () => {
  const game = new Game(players('Ann', 'Ben', 'Cal'));
  assert.equal(game.state().pot, 0);
  game.nextRound();
  game.roundOver([result('ann', 'finished'), result('ben', 'eliminated'), result('cal', 'finished')]);
  assert.equal(game.state().pot, 100_000_000);
});

test('a finished game hands out awards and a result card per player', () => {
  const game = new Game(players('Ann', 'Ben', 'Cal', 'Dee'));
  game.nextRound();
  game.roundOver([
    { id: 'ann', name: 'Ann', status: 'finished', crossMs: 9000, redAvg: 0.4, redSamples: 30 },
    { id: 'ben', name: 'Ben', status: 'finished', crossMs: 7300, redAvg: 1.1, redSamples: 30 },
    { id: 'cal', name: 'Cal', status: 'finished', crossMs: 8000, redAvg: 0.2, redSamples: 3 }, // too few readings for Statue
    { id: 'dee', name: 'Dee', status: 'eliminated', crossMs: null, redAvg: 0.1, redSamples: 30 }, // out: can't be Statue
  ]);
  game.nextRound();
  game.roundOver([
    { id: 'ann', name: 'Ann', team: 'pink', status: 'won', avgShake: 12.5 },
    { id: 'ben', name: 'Ben', team: 'teal', status: 'eliminated', avgShake: 19.25 },
    { id: 'cal', name: 'Cal', team: 'pink', status: 'won', avgShake: 3 },
  ]);
  game.nextRound();
  game.roundOver([
    { id: 'ann', name: 'Ann', status: 'finished', reached: 4, correctNew: 2, fastestMs: 2100 },
    { id: 'cal', name: 'Cal', status: 'eliminated', reached: 1, correctNew: 1, fastestMs: 900 },
  ]);
  const s = game.state();
  assert.equal(s.phase, 'over');
  assert.equal(s.pot, 300_000_000);

  const award = Object.fromEntries(s.awards.map((a) => [a.key, [a.name, a.detail]]));
  assert.deepEqual(award, {
    statue: ['Ann', 'average movement 0.40 on red'],
    speed: ['Ben', 'crossed in 7.3 s'],
    shake: ['Ben', 'average shake 19.3'],
    glass: ['Ann', 'guessed 2 unknown panels right'],
    daredevil: ['Cal', 'jumped in 0.9 s'],
  });

  const card = Object.fromEntries(s.cards.map((c) => [c.id, c]));
  assert.deepEqual(card.ann, {
    id: 'ann',
    name: 'Ann',
    outcome: 'winner',
    outRound: null,
    roundsSurvived: 3,
    prize: 300_000_000,
    lines: [
      'Red Light, Green Light: crossed the line in 9.0 s',
      'Tug of War: Team Pink, won, average shake 12.5',
      'Glass Bridge: crossed the bridge',
    ],
    awards: ['Statue', 'Glass Expert'],
  });
  assert.equal(card.dee.outcome, 'out');
  assert.equal(card.dee.outRound, 'Red Light, Green Light');
  assert.equal(card.dee.roundsSurvived, 0);
  assert.equal(card.dee.prize, 0);
  assert.deepEqual(card.cal.lines.at(-1), 'Glass Bridge: fell on step 2');
  assert.deepEqual(card.cal.awards, ['Daredevil']);
});

test('awards with no qualifying player are left out', () => {
  const game = new Game(players('Ann', 'Ben'));
  game.nextRound();
  game.roundOver([result('ann', 'finished'), result('ben', 'eliminated')]);
  assert.deepEqual(game.state().awards, []);
  assert.equal(game.state().cards.length, 2);
});

test('rounds can only start between rounds', () => {
  const game = new Game(players('Ann', 'Ben'));
  game.nextRound();
  assert.throws(() => game.nextRound());
  assert.throws(() => new Game(players('Ann', 'Ben')).roundOver([]));
});
