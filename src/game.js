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
  // that would knock out everyone who played, in which case nobody is.
  roundOver(results) {
    if (this.phase !== 'playing') throw new Error('No game round is being played.');
    const played = results.filter((r) => this.alive.has(r.id));
    const eliminated = played.filter((r) => r.status === 'eliminated');
    const roundName = ROUNDS[this.stage].name;
    if (played.length > 0 && eliminated.length === played.length) {
      this.note = 'Nobody survived that round, so everyone who played gets another chance.';
    } else {
      for (const r of eliminated) {
        this.alive.delete(r.id);
        this.out.push({ id: r.id, name: r.name, round: roundName });
      }
    }
    this.stage++;
    this.phase = this.stage >= ROUNDS.length || this.alive.size <= 1 ? 'over' : 'intermission';
  }

  // A player disconnected.
  removePlayer(id) {
    if (!this.alive.delete(id)) return;
    if (this.phase === 'intermission' && this.alive.size <= 1) this.phase = 'over';
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
