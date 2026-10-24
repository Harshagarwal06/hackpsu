// A full game: the rounds run in order and only survivors play the next one.
// Rounds themselves live in their own files; this only tracks who is still in.

const ROUNDS = [
  { key: 'redlight', name: 'Red Light, Green Light' },
  { key: 'tug', name: 'Tug of War' },
  { key: 'bridge', name: 'Glass Bridge' },
];

class Game {
  // players: Map of id -> name
  constructor(players) {
    if (players.size < 2) throw new Error('A game needs at least 2 players.');
    this.alive = new Map(players);
    this.out = []; // [{ id, name, round }] in the order they went out
    this.stage = 0; // index of the next round to play
    this.phase = 'ready'; // ready -> playing -> intermission -> ... -> over
    this.note = '';
  }

  // Starts the next round. Returns its key and the players who take part.
  nextRound() {
    if (this.phase !== 'ready' && this.phase !== 'intermission') {
      throw new Error(`Can't start a round while the game is "${this.phase}".`);
    }
    this.phase = 'playing';
    this.note = '';
    return { key: ROUNDS[this.stage].key, players: new Map(this.alive) };
  }

  // Applies a finished round's results. 'eliminated' players are out, unless
  // that would knock out everyone who played. Then, if the round reports how
  // far each player got (Glass Bridge's `reached`), whoever got furthest stays
  // in; otherwise nobody is eliminated.
  roundOver(results) {
    if (this.phase !== 'playing') throw new Error('No game round is being played.');
    const played = results.filter((r) => this.alive.has(r.id));
    let eliminated = played.filter((r) => r.status === 'eliminated');
    const roundName = ROUNDS[this.stage].name;
    if (played.length > 0 && eliminated.length === played.length) {
      if (played.every((r) => typeof r.reached === 'number')) {
        const best = Math.max(...played.map((r) => r.reached));
        const furthest = played.filter((r) => r.reached === best);
        eliminated = played.filter((r) => r.reached < best);
        const names = furthest.map((r) => r.name).join(' and ');
        // A player who fell on step N (1-based) got past N - 1 steps.
        this.note = `Everyone fell, but ${names} got furthest (to step ${best + 1}) and ${furthest.length > 1 ? 'stay' : 'stays'} in.`;
      } else {
        eliminated = [];
        this.note = 'Nobody survived that round, so everyone who played gets another chance.';
      }
    }
    for (const r of eliminated) {
      this.alive.delete(r.id);
      this.out.push({ id: r.id, name: r.name, round: roundName });
    }
    this.stage++;
    this.phase = this.stage >= ROUNDS.length || this.alive.size <= 1 ? 'over' : 'intermission';
  }

  // A player left for good. Returns true if that changed the game (so the
  // new state needs sending); a finished game keeps its winners as they were.
  removePlayer(id) {
    if (this.phase === 'over' || !this.alive.delete(id)) return false;
    if (this.phase === 'intermission' && this.alive.size <= 1) this.phase = 'over';
    return true;
  }

  isActive() {
    return this.phase !== 'over';
  }

  state() {
    const list = (map) => [...map].map(([id, name]) => ({ id, name }));
    return {
      phase: this.phase,
      stage: this.stage,
      rounds: ROUNDS.map((r) => r.name),
      current: this.phase === 'playing' ? ROUNDS[this.stage].name : null,
      next: this.phase === 'ready' || this.phase === 'intermission' ? ROUNDS[this.stage].name : null,
      alive: list(this.alive),
      out: this.out,
      winners: this.phase === 'over' ? list(this.alive) : [],
      note: this.note,
    };
  }
}

module.exports = { Game, ROUNDS };
