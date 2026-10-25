// A full game: the rounds run in order and only survivors play the next one.
// Rounds themselves live in their own files; this only tracks who is still in.

const ROUNDS = [
  { key: 'redlight', name: 'Red Light, Green Light' },
  { key: 'tug', name: 'Tug of War' },
  { key: 'bridge', name: 'Glass Bridge' },
];

// Like the show's piggy bank: every elimination adds to the winners' prize.
const PRIZE_PER_ELIMINATION = 100_000_000;
// The Statue award needs enough red-light readings to mean something.
const MIN_RED_SAMPLES = 5;

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// One line for a player's result card, per round they played.
function describe(key, r) {
  if (key === 'redlight') {
    if (r.status === 'finished') return r.crossMs == null ? 'crossed the line' : `crossed the line in ${seconds(r.crossMs)}`;
    if (r.status === 'eliminated') return 'eliminated';
    return 'still in when the round was ended';
  }
  if (key === 'tug') {
    const outcome = { won: 'won', eliminated: 'lost', playing: 'no winner' }[r.status];
    const team = r.team === 'pink' ? 'Pink' : 'Teal';
    const shake = r.avgShake == null ? '' : `, average shake ${r.avgShake.toFixed(1)}`;
    return `Team ${team}, ${outcome}${shake}`;
  }
  if (r.status === 'finished') return 'crossed the bridge';
  if (r.status === 'eliminated') return `fell on step ${r.reached + 1}`;
  return 'still waiting when the round was ended';
}

// The result with the best score, ignoring results with no score (null or
// undefined: that stat wasn't recorded for this player).
function best(results, score, lowerIsBetter) {
  let top = null;
  let topScore = null;
  for (const r of results) {
    const s = score(r);
    if (s == null) continue;
    if (top === null || (lowerIsBetter ? s < topScore : s > topScore)) {
      top = r;
      topScore = s;
    }
  }
  return top;
}

class Game {
  // players: Map of id -> name
  constructor(players) {
    if (players.size < 2) throw new Error('A game needs at least 2 players.');
    this.alive = new Map(players);
    this.out = []; // [{ id, name, round }] in the order they went out
    this.stage = 0; // index of the next round to play
    this.phase = 'ready'; // ready -> playing -> intermission -> ... -> over
    this.note = '';
    this.history = []; // [{ key, name, results }] for each round played
    this.ending = null; // awards and result cards, worked out once the game is over
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
    this.history.push({ key: ROUNDS[this.stage].key, name: roundName, results: played });
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

  pot() {
    return this.out.length * PRIZE_PER_ELIMINATION;
  }

  // Awards for standout moments, and a result card for every player who
  // finished the game in it (winners and those knocked out).
  computeEnding() {
    const inGame = new Map([...this.alive, ...this.out.map((o) => [o.id, o.name])]);
    const roundResults = (key) => (this.history.find((h) => h.key === key)?.results || [])
      .filter((r) => inGame.has(r.id));
    const red = roundResults('redlight');
    const tug = roundResults('tug');
    const bridge = roundResults('bridge');

    const candidates = [
      ['statue', 'Statue', 'stillest during red lights',
        best(red, (r) => (r.status !== 'eliminated' && r.redSamples >= MIN_RED_SAMPLES ? r.redAvg : null), true),
        (r) => `average movement ${r.redAvg.toFixed(2)} on red`],
      ['speed', 'Speed Demon', 'first across the Red Light finish line',
        best(red, (r) => r.crossMs, true),
        (r) => `crossed in ${seconds(r.crossMs)}`],
      ['shake', 'Shake Machine', 'hardest shaker in Tug of War',
        best(tug, (r) => (r.avgShake > 0 ? r.avgShake : null), false),
        (r) => `average shake ${r.avgShake.toFixed(1)}`],
      ['glass', 'Glass Expert', 'most correct guesses on unknown panels',
        best(bridge, (r) => (r.correctNew > 0 ? r.correctNew : null), false),
        (r) => `guessed ${r.correctNew} unknown panel${r.correctNew === 1 ? '' : 's'} right`],
      ['daredevil', 'Daredevil', 'fastest jump on the bridge',
        best(bridge, (r) => r.fastestMs, true),
        (r) => `jumped in ${seconds(r.fastestMs)}`],
    ];
    const awards = candidates
      .filter(([, , , winner]) => winner)
      .map(([key, title, why, winner, detail]) => ({
        key, title, why, id: winner.id, name: inGame.get(winner.id), detail: detail(winner),
      }));

    const winnerIds = [...this.alive.keys()];
    const share = winnerIds.length ? Math.floor(this.pot() / winnerIds.length) : 0;
    const cards = [...inGame].map(([id, name]) => {
      const lines = [];
      for (const h of this.history) {
        const r = h.results.find((x) => x.id === id);
        if (r) lines.push(`${h.name}: ${describe(h.key, r)}`);
      }
      const out = this.out.find((o) => o.id === id);
      return {
        id,
        name,
        outcome: out ? 'out' : 'winner',
        outRound: out ? out.round : null,
        roundsSurvived: out ? lines.length - 1 : lines.length,
        prize: out ? 0 : share,
        lines,
        awards: awards.filter((a) => a.id === id).map((a) => a.title),
      };
    });
    return { awards, cards };
  }

  state() {
    const list = (map) => [...map].map(([id, name]) => ({ id, name }));
    if (this.phase === 'over' && !this.ending) this.ending = this.computeEnding();
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
      pot: this.pot(),
      awards: this.ending ? this.ending.awards : [],
      cards: this.ending ? this.ending.cards : [],
    };
  }
}

module.exports = { Game, ROUNDS, PRIZE_PER_ELIMINATION };
