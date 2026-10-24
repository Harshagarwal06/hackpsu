// Red Light, Green Light. The server runs one of these per room while the round is on.
//
// GREEN: moving (motion above the threshold) fills your progress bar. Fill it to
//        cross the finish line and you are safe.
// RED:   after a short grace period, moving above the threshold eliminates you.
// When the last cycle ends, anyone who has not crossed is eliminated (time's up).

const DEFAULT_OPTIONS = {
  cycles: 5,
  greenMinMs: 2000,
  greenMaxMs: 5000,
  redMs: 3000,
  graceMs: 500, // time to react after RED before movement counts
  finishSteps: 60, // moving samples needed to cross (~6 s of movement at 10 samples/s)
  minStepGapMs: 80, // a phone can't earn steps faster than it is meant to send samples
};

class RedLightRound {
  // players: Map of id -> name
  // getThreshold: () => current sensitivity threshold (the host can change it mid-round)
  // on: { start(info), phase(info), player(id, state), over(results) }
  constructor({ players, getThreshold, on, random = Math.random, options = {} }) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.getThreshold = getThreshold;
    this.on = on;
    this.random = random;
    this.phase = 'idle';
    this.cycle = 0;
    this.timer = null;
    this.redStartedAt = 0;
    this.players = new Map();
    for (const [id, name] of players) {
      this.players.set(id, { id, name, status: 'playing', steps: 0, lastStepAt: 0 });
    }
  }

  start() {
    if (this.phase !== 'idle') throw new Error('Round already started.');
    this.on.start({ players: [...this.players.values()].map(({ id, name }) => ({ id, name })) });
    this.toGreen();
  }

  toGreen() {
    this.cycle++;
    if (this.cycle > this.opts.cycles) {
      this.finish('time');
      return;
    }
    this.phase = 'green';
    this.emitPhase();
    const { greenMinMs, greenMaxMs } = this.opts;
    const ms = greenMinMs + this.random() * (greenMaxMs - greenMinMs);
    this.timer = setTimeout(() => this.toRed(), ms);
  }

  toRed() {
    this.phase = 'red';
    this.redStartedAt = Date.now();
    this.emitPhase();
    this.timer = setTimeout(() => this.toGreen(), this.opts.redMs);
  }

  emitPhase() {
    this.on.phase({ phase: this.phase, cycle: this.cycle, cycles: this.opts.cycles });
  }

  handleMotion(id, m) {
    const p = this.players.get(id);
    if (!p || p.status !== 'playing') return;
    const now = Date.now();
    const moving = m > this.getThreshold();

    if (this.phase === 'green' && moving && now - p.lastStepAt >= this.opts.minStepGapMs) {
      p.steps++;
      p.lastStepAt = now;
      if (p.steps >= this.opts.finishSteps) p.status = 'finished';
      this.emitPlayer(p);
      if (p.status === 'finished') this.endIfNobodyPlaying();
    } else if (this.phase === 'red' && moving && now - this.redStartedAt >= this.opts.graceMs) {
      p.status = 'eliminated';
      this.emitPlayer(p);
      this.endIfNobodyPlaying();
    }
  }

  // A player disconnected mid-round.
  removePlayer(id) {
    if (!this.players.delete(id)) return;
    this.endIfNobodyPlaying();
  }

  // Host pressed "End round": nobody else is eliminated.
  stop() {
    this.finish('host');
  }

  // Room is gone: stop timers without telling anyone.
  cancel() {
    clearTimeout(this.timer);
    this.phase = 'over';
  }

  endIfNobodyPlaying() {
    if (this.phase === 'over') return;
    for (const p of this.players.values()) {
      if (p.status === 'playing') return;
    }
    this.finish('done');
  }

  finish(reason) {
    if (this.phase === 'over') return;
    clearTimeout(this.timer);
    this.phase = 'over';
    if (reason === 'time') {
      for (const p of this.players.values()) {
        if (p.status === 'playing') {
          p.status = 'eliminated';
          this.emitPlayer(p);
        }
      }
    }
    const results = [...this.players.values()].map(({ id, name, status }) => ({ id, name, status }));
    this.on.over({ reason, results });
  }

  emitPlayer(p) {
    this.on.player(p.id, { status: p.status, progress: Math.min(p.steps / this.opts.finishSteps, 1) });
  }
}

module.exports = { RedLightRound, DEFAULT_OPTIONS };
