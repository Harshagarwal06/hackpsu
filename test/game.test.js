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

test('rounds can only start between rounds', () => {
  const game = new Game(players('Ann', 'Ben'));
  game.nextRound();
  assert.throws(() => game.nextRound());
  assert.throws(() => new Game(players('Ann', 'Ben')).roundOver([]));
});
