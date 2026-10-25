// Glass Bridge. Players take turns crossing a bridge of glass pairs.
//
// Each step has a left and a right panel; one is safe, the other breaks.
// On your turn you tilt your phone to pick a side (the phone sends the choice).
// A wrong panel eliminates you. Either way that step is now known, so the next
// player walks straight across every revealed step and starts guessing where
// the last one stopped. Once every step is revealed, everyone left crosses.

const DEFAULT_OPTIONS = {
  steps: null, // null = scale with the number of players (see stepsFor)
  chooseMs: 7000, // time to pick a side before being pushed onto a random one
  revealMs: 2000, // pause after a jump so everyone sees what happened
};

const SIDES = ['left', 'right'];

// About one fall per player on average keeps a few survivors.
function stepsFor(playerCount) {
  return Math.max(3, Math.min(10, playerCount + 1));
}

class GlassBridgeRound {
  // players: Map of id -> name
  // order: ids in turn order (first to last); omitted = random order
  // on: { start(info), state(info), jump(info), over(summary) }
  constructor({ players, order = null, on, random = Math.random, options = {} }) {
    if (players.size < 1) throw new Error('Glass Bridge needs at least 1 player.');
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.on = on;
    this.random = random;
    this.steps = this.opts.steps ?? stepsFor(players.size);
    this.safe = Array.from({ length: this.steps }, () => SIDES[random() < 0.5 ? 0 : 1]);
    this.revealed = 0; // steps 0..revealed-1 are known to everyone
    this.phase = 'idle';
    this.current = null; // id of the player on the bridge
    this.position = 0; // step the current player is about to jump to
    this.deadline = 0;
    this.timer = null;

    let ids;
    if (order) {
      const same = order.length === players.size && order.every((id) => players.has(id));
      if (!same) throw new Error('The turn order must list every player exactly once.');
      ids = [...order];
    } else {
      ids = [...players.keys()];
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
    }
    this.earnedOrder = Boolean(order);
    // reached: how many steps the player got past (the step they fell on, or
    // all of them if they crossed). Falls always happen on a new step, so two
    // players who fell never have the same value.
    // correctNew: correct guesses on panels nobody had revealed yet;
    // fastestMs: quickest jump the player chose themselves (for awards).
    this.players = new Map(ids.map((id) => [id, {
      id, name: players.get(id), status: 'waiting', reached: 0, correctNew: 0, fastestMs: null,
    }]));
  }

  start() {
    if (this.phase !== 'idle') throw new Error('Round already started.');
    this.on.start(this.startInfo());
    this.nextTurn();
  }

  nextTurn() {
    const next = [...this.players.values()].find((p) => p.status === 'waiting');
    if (!next) {
      this.finish('done');
      return;
    }
    if (this.revealed >= this.steps) {
      this.finish('crossed');
      return;
    }
    this.current = next.id;
    next.status = 'onBridge';
    this.position = this.revealed; // walk across every known step
    this.beginStep();
  }

  beginStep() {
    this.phase = 'choosing';
    this.deadline = Date.now() + this.opts.chooseMs;
    this.emitState();
    this.timer = setTimeout(() => {
      const side = SIDES[this.random() < 0.5 ? 0 : 1];
      this.jump(this.current, side, true);
    }, this.opts.chooseMs);
  }

  // The current player picked a side. Returns false if it wasn't their move.
  choose(id, side) {
    if (this.phase !== 'choosing' || id !== this.current) return false;
    if (!SIDES.includes(side)) throw new Error(`Side must be "left" or "right", got "${side}".`);
    this.jump(id, side, false);
    return true;
  }

  jump(id, side, forced) {
    clearTimeout(this.timer);
    this.phase = 'revealing';
    const step = this.position;
    const correct = side === this.safe[step];
    const unknown = step === this.revealed;
    if (unknown) this.revealed++;
    const p = this.players.get(id);
    if (!forced) {
      const ms = Date.now() - (this.deadline - this.opts.chooseMs);
      p.fastestMs = p.fastestMs === null ? ms : Math.min(p.fastestMs, ms);
    }
    // Being pushed onto a panel isn't a guess, so only chosen jumps count.
    if (correct && unknown && !forced) p.correctNew++;
    this.on.jump({ id, name: p.name, step, side, correct, forced });

    if (correct) {
      this.position++;
      p.reached = this.position;
      if (this.position >= this.steps) p.status = 'finished';
    } else {
      p.status = 'eliminated';
      p.reached = step;
      this.current = null;
    }
    this.emitState();

    this.timer = setTimeout(() => {
      if (p.status === 'onBridge') this.beginStep();
      else if (p.status === 'finished') this.finish('crossed');
      else this.nextTurn();
    }, this.opts.revealMs);
  }

  // Players don't use shaking in this round.
  handleMotion() {}

  // A player disconnected. If it was their turn, the next player goes.
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.phase === 'over' || id !== this.current) {
      if (this.phase !== 'over') this.emitState();
      return;
    }
    clearTimeout(this.timer);
    this.current = null;
    this.nextTurn();
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

  emitState() {
    this.on.state(this.stateInfo());
  }

  // earned: the order comes from earlier rounds rather than chance.
  startInfo() {
    return {
      steps: this.steps,
      order: [...this.players.values()].map(({ id, name }) => ({ id, name })),
      earned: this.earnedOrder,
    };
  }

  // Everything a reconnecting screen needs to catch up.
  snapshot() {
    return { start: this.startInfo(), state: this.stateInfo() };
  }

  stateInfo() {
    return {
      phase: this.phase,
      steps: this.steps,
      revealed: this.safe.slice(0, this.revealed),
      current: this.current,
      position: this.position,
      msLeft: this.phase === 'choosing' ? Math.max(0, this.deadline - Date.now()) : 0,
      players: [...this.players.values()].map(({ id, name, status }) => ({ id, name, status })),
    };
  }

  finish(reason) {
    if (this.phase === 'over') return;
    clearTimeout(this.timer);
    this.phase = 'over';
    this.current = null;
    const results = [...this.players.values()].map(({ id, name, status, reached, correctNew, fastestMs }) => {
      let final = status;
      if (status === 'waiting' || status === 'onBridge') {
        // With the whole bridge revealed, everyone left walks across.
        final = reason === 'crossed' ? 'finished' : 'playing';
      }
      return {
        id, name, status: final, reached: final === 'finished' ? this.steps : reached, correctNew, fastestMs,
      };
    });
    this.on.over({ reason, steps: this.steps, revealed: this.safe.slice(0, this.revealed), results });
  }
}

module.exports = { GlassBridgeRound, DEFAULT_OPTIONS, SIDES, stepsFor };
