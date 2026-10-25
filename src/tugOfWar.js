// Tug of War. Players are split into two teams; shaking pulls the rope.
//
// The rope position runs from -1 (Teal wins) to +1 (Pink wins). Every tick the
// rope moves by the difference between the teams' AVERAGE shake strength, so a
// bigger team has no built-in advantage. If time runs out, the team on whose
// side the rope is wins.

const DEFAULT_OPTIONS = {
  countdownMs: 5000, // doubles as the round's 5-second briefing
  durationMs: 30000,
  tickMs: 100,
  staleMs: 400, // a reading older than this counts as not shaking
  maxForce: 25, // m/s² cap per player, so faked huge readings don't help
  pullRate: 0.03, // rope movement per second, per m/s² of average difference
};

const TEAMS = ['pink', 'teal'];

class TugOfWarRound {
  // players: Map of id -> name
  // picks: Map of id -> 'pink' | 'teal' for players the host put on a team
  // on: { start(info), state(info), over(summary) }
  constructor({ players, picks = new Map(), on, random = Math.random, options = {} }) {
    if (players.size < 2) throw new Error('Tug of War needs at least 2 players.');
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.on = on;
    this.phase = 'idle';
    this.rope = 0;
    this.timer = null;
    this.ticker = null;
    this.pullStartedAt = 0;

    // Picked players go on their team. Everyone else is shuffled and each
    // joins the smaller team (Pink on a tie), so with no picks the teams
    // differ in size by at most one.
    const size = { pink: 0, teal: 0 };
    const teamOf = new Map();
    for (const [id, team] of picks) {
      if (!players.has(id)) continue;
      if (!TEAMS.includes(team)) throw new Error(`Team must be "pink" or "teal", got "${team}".`);
      teamOf.set(id, team);
      size[team]++;
    }
    const rest = [...players.keys()].filter((id) => !teamOf.has(id));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    for (const id of rest) {
      const team = size.teal < size.pink ? 'teal' : 'pink';
      teamOf.set(id, team);
      size[team]++;
    }
    if (size.pink === 0 || size.teal === 0) {
      throw new Error('Tug of War needs at least one player on each team.');
    }
    this.players = new Map();
    for (const id of players.keys()) {
      // forceSum/forceCount: shake readings while pulling (for awards).
      this.players.set(id, {
        id, name: players.get(id), team: teamOf.get(id), force: 0, seenAt: 0, forceSum: 0, forceCount: 0,
      });
    }
  }

  start() {
    if (this.phase !== 'idle') throw new Error('Round already started.');
    this.phase = 'countdown';
    this.on.start({
      teams: [...this.players.values()].map(({ id, name, team }) => ({ id, name, team })),
      countdownMs: this.opts.countdownMs,
    });
    this.emitState();
    this.timer = setTimeout(() => this.startPulling(), this.opts.countdownMs);
  }

  startPulling() {
    this.phase = 'pull';
    this.pullStartedAt = Date.now();
    this.emitState();
    this.ticker = setInterval(() => this.tick(), this.opts.tickMs);
  }

  handleMotion(id, m) {
    const p = this.players.get(id);
    if (!p) return;
    p.force = Math.min(m, this.opts.maxForce);
    p.seenAt = Date.now();
    if (this.phase === 'pull') {
      p.forceSum += p.force;
      p.forceCount++;
    }
  }

  // Average shake strength per team, counting stale readings as zero.
  teamForces() {
    const now = Date.now();
    const sum = { pink: 0, teal: 0 };
    const count = { pink: 0, teal: 0 };
    for (const p of this.players.values()) {
      count[p.team]++;
      if (this.phase === 'pull' && now - p.seenAt <= this.opts.staleMs) sum[p.team] += p.force;
    }
    return {
      pink: count.pink ? sum.pink / count.pink : 0,
      teal: count.teal ? sum.teal / count.teal : 0,
    };
  }

  tick() {
    const force = this.teamForces();
    this.rope += (force.pink - force.teal) * this.opts.pullRate * (this.opts.tickMs / 1000);
    this.rope = Math.max(-1, Math.min(1, this.rope));
    this.emitState(force);
    if (this.rope >= 1) this.finish('pulled', 'pink');
    else if (this.rope <= -1) this.finish('pulled', 'teal');
    else if (Date.now() - this.pullStartedAt >= this.opts.durationMs) {
      this.finish('time', this.rope > 0 ? 'pink' : this.rope < 0 ? 'teal' : null);
    }
  }

  emitState(force = this.teamForces()) {
    this.on.state(this.stateInfo(force));
  }

  stateInfo(force = this.teamForces()) {
    const msLeft = this.phase === 'pull'
      ? Math.max(0, this.opts.durationMs - (Date.now() - this.pullStartedAt))
      : this.opts.durationMs;
    return { phase: this.phase, rope: this.rope, force, msLeft };
  }

  // Everything a reconnecting screen needs to catch up.
  snapshot() {
    return {
      start: {
        teams: [...this.players.values()].map(({ id, name, team }) => ({ id, name, team })),
        countdownMs: this.opts.countdownMs,
      },
      state: this.stateInfo(),
    };
  }

  // A player disconnected. If their team is now empty, the other team wins.
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.phase === 'over') return;
    const left = new Set([...this.players.values()].map((q) => q.team));
    if (left.size === 1) this.finish('forfeit', [...left][0]);
    else if (left.size === 0) this.finish('forfeit', null);
  }

  // Host pressed "End round": nobody is eliminated.
  stop() {
    this.finish('host', null);
  }

  // Room is gone: stop timers without telling anyone.
  cancel() {
    this.clearTimers();
    this.phase = 'over';
  }

  clearTimers() {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
  }

  finish(reason, winner) {
    if (this.phase === 'over') return;
    this.clearTimers();
    this.phase = 'over';
    const results = [...this.players.values()].map(({ id, name, team, forceSum, forceCount }) => ({
      id,
      name,
      team,
      status: winner === null ? 'playing' : team === winner ? 'won' : 'eliminated',
      avgShake: forceCount ? forceSum / forceCount : null,
    }));
    this.on.over({ reason, winner, results });
  }
}

module.exports = { TugOfWarRound, DEFAULT_OPTIONS, TEAMS };
