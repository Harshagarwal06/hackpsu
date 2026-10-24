// Host screen (laptop on the projector): creates a room, shows players live,
// and runs Red Light, Green Light.

const METER_MAX = 15; // keep in sync with player.js

const socket = io();
const $ = (id) => document.getElementById(id);

let players = []; // [{ id, name }] from the server
const cards = new Map(); // player id -> { card, motion, progress, status }
const roundState = new Map(); // player id -> { status, progress } for the current/last round
let roundRunning = false;
let threshold = 0;

$('join-url').textContent = location.host;

function showError(err) {
  $('host-error').textContent = err ? err.message : '';
}

socket.emit('host:create', (res) => {
  if (!res.ok) return showError(res.error);
  $('room-code').textContent = res.code;
  // The QR opens the phone page with this room's code filled in.
  const joinLink = `${location.origin}/?code=${res.code}`;
  $('qr').src = `/qr.svg?url=${encodeURIComponent(joinLink)}`;
  $('qr').addEventListener('error', () => showError({ message: 'Could not load the QR code. Players can still join with the link and code.' }));
  $('qr-box').classList.remove('hidden');
  const slider = $('threshold');
  slider.min = res.minThreshold;
  slider.max = res.maxThreshold;
  setThreshold(res.threshold);
  slider.disabled = false;
  updateButtons();
});

function setThreshold(value) {
  threshold = value;
  $('threshold').value = value;
  $('threshold-value').textContent = value.toFixed(1);
  for (const { marker } of cards.values()) {
    marker.style.left = `${Math.min(threshold / METER_MAX, 1) * 100}%`;
  }
}

$('threshold').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  setThreshold(value);
  socket.emit('host:threshold', value, (res) => showError(res.ok ? null : res.error));
});

// Sends a host command; shows its error if it fails.
function command(event) {
  showError(null);
  socket.emit(event, (res) => showError(res.ok ? null : res.error));
}

$('start-btn').addEventListener('click', () => command('host:start-redlight'));
$('tug-btn').addEventListener('click', () => command('host:start-tug'));
$('bridge-btn').addEventListener('click', () => command('host:start-bridge'));
$('game-btn').addEventListener('click', () => command('host:game-start'));
$('next-btn').addEventListener('click', () => command('host:game-next'));
$('endgame-btn').addEventListener('click', () => command('host:game-end'));

// Shows one round's big-screen view (or none), hiding the others and the
// previous round's results.
function showRoundView(id) {
  for (const view of ['tow-view', 'gb-view']) $(view).classList.toggle('hidden', view !== id);
  $('results').classList.add('hidden');
}

$('end-btn').addEventListener('click', () => {
  socket.emit('host:end-round', (res) => showError(res.ok ? null : res.error));
});

function updateButtons() {
  const noRoom = $('room-code').textContent.includes('·');
  const gameActive = Boolean(game && game.phase !== 'over');
  const busy = roundRunning || gameActive || noRoom;
  $('start-btn').disabled = busy || players.length === 0;
  $('tug-btn').disabled = busy || players.length < 2;
  $('bridge-btn').disabled = busy || players.length === 0;
  $('game-btn').disabled = busy || players.length < 2;
  $('game-btn').textContent = game?.phase === 'over' ? 'New Game' : 'Start Game';
  $('game-btn').classList.toggle('hidden', gameActive);
  const canNext = game?.phase === 'intermission' && !roundRunning;
  $('next-btn').classList.toggle('hidden', !canNext);
  if (canNext) $('next-btn').textContent = `Next round: ${game.next}`;
  $('end-btn').classList.toggle('hidden', !roundRunning);
  $('endgame-btn').classList.toggle('hidden', !game || roundRunning);
}

// --- Game (rounds in a row, survivors carry over) ----------------------------

let game = null; // last game:state, or null when there is no game
let gameOut = new Map(); // id -> round they went out in
let gameWinners = new Set();

socket.on('game:state', (state) => {
  game = state;
  gameOut = new Map((state?.out || []).map((o) => [o.id, o.round]));
  gameWinners = new Set((state?.winners || []).map((w) => w.id));
  $('game-view').classList.toggle('hidden', !state);
  $('winner-view').classList.toggle('hidden', state?.phase !== 'over');
  if (state) {
    const total = state.rounds.length;
    const status = {
      playing: `Round ${state.stage + 1} of ${total}: ${state.current}`,
      intermission: `Round ${state.stage} of ${total} done · Up next: ${state.next}`,
      over: 'Game over',
    }[state.phase];
    $('game-status').textContent = status;
    $('game-note').textContent = state.note;
    $('game-alive').textContent = `Still in (${state.alive.length}): ${state.alive.map((p) => p.name).join(', ') || 'nobody'}`;
    $('game-out').textContent = state.out.length
      ? `Out: ${state.out.map((o) => `${o.name} (${o.round})`).join(', ')}`
      : '';
    if (state.phase === 'over') {
      const names = state.winners.map((w) => w.name);
      $('winner-label').textContent = names.length > 1 ? 'WINNERS' : names.length ? 'WINNER' : 'NO WINNER';
      $('winner-names').textContent = names.join(' · ');
      showRoundView(null);
      $('results').classList.add('hidden');
    }
    if (state.phase === 'playing') $('results').classList.add('hidden');
  }
  for (const id of cards.keys()) applyRoundState(id);
  updateButtons();
});

const STATUS_LABEL = {
  playing: '',
  waiting: '',
  onBridge: '▶ On the bridge',
  finished: '✓ Crossed',
  won: '✓ Won',
  eliminated: '✕ Eliminated',
};

function renderPlayers() {
  $('count').textContent = players.length;
  const list = $('players');
  list.replaceChildren();
  cards.clear();
  for (const p of players) {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <div class="card-top"><span class="name"></span><span class="status"></span></div>
      <div class="meter motion"><div></div><span class="marker"></span></div>
      <div class="meter progress"><div></div></div>`;
    card.querySelector('.name').textContent = p.name;
    list.append(card);
    cards.set(p.id, {
      card,
      motion: card.querySelector('.motion > div'),
      marker: card.querySelector('.marker'),
      progress: card.querySelector('.progress > div'),
      status: card.querySelector('.status'),
    });
    applyRoundState(p.id);
  }
  setThreshold(threshold);
  updateButtons();
}

function applyRoundState(id) {
  const c = cards.get(id);
  if (!c) return;
  const state = roundState.get(id);
  let status = state ? state.status : 'playing';
  let label = STATUS_LABEL[status];
  // The game's verdict wins over a single round's.
  if (gameWinners.has(id)) {
    status = 'won';
    label = '👑 Winner';
  } else if (gameOut.has(id) && (!state || state.status === 'eliminated')) {
    status = 'eliminated';
    label = `✕ Out · ${gameOut.get(id)}`;
  }
  c.card.dataset.status = status;
  c.card.dataset.team = state?.team || '';
  c.status.textContent = label;
  // Only Red Light has a progress bar.
  const hasProgress = state?.progress !== undefined;
  c.progress.parentElement.classList.toggle('hidden', !hasProgress);
  c.progress.style.width = `${(hasProgress ? state.progress : 0) * 100}%`;
}

function showResults(heading, groups) {
  const box = $('results');
  box.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = heading;
  box.append(h);
  for (const [label, names] of groups) {
    if (names.length === 0) continue;
    const line = document.createElement('p');
    line.textContent = `${label}: ${names.join(', ')}`;
    box.append(line);
  }
  box.classList.remove('hidden');
}

const namesWith = (results, status) => results.filter((r) => r.status === status).map((r) => r.name);

socket.on('room:players', (list) => {
  players = list;
  renderPlayers();
});

socket.on('player:motion', ({ id, m }) => {
  const c = cards.get(id);
  if (c) c.motion.style.width = `${Math.min(m / METER_MAX, 1) * 100}%`;
});

socket.on('rl:start', ({ players: inRound }) => {
  roundRunning = true;
  roundState.clear();
  for (const p of inRound) roundState.set(p.id, { status: 'playing', progress: 0 });
  $('results').classList.add('hidden');
  showRoundView(null);
  renderPlayers();
});

socket.on('rl:phase', ({ phase, cycle, cycles }) => {
  roundRunning = true;
  updateButtons();
  const banner = $('phase-banner');
  banner.classList.remove('hidden');
  banner.dataset.phase = phase;
  $('phase-text').textContent = phase === 'green' ? 'GREEN LIGHT' : 'RED LIGHT';
  $('phase-cycle').textContent = `Light ${cycle} of ${cycles}`;
});

socket.on('rl:player', ({ id, status, progress }) => {
  roundState.set(id, { status, progress });
  applyRoundState(id);
});

socket.on('rl:over', ({ reason, results }) => {
  roundRunning = false;
  updateButtons();
  $('phase-banner').classList.add('hidden');
  for (const r of results) {
    const prev = roundState.get(r.id);
    roundState.set(r.id, { status: r.status, progress: prev ? prev.progress : 0 });
    applyRoundState(r.id);
  }
  showResults(reason === 'host' ? 'Round ended by host' : 'Round over', [
    ['Crossed', namesWith(results, 'finished')],
    ['Still in', namesWith(results, 'playing')],
    ['Eliminated', namesWith(results, 'eliminated')],
  ]);
});

// --- Tug of War ------------------------------------------------------------

socket.on('tow:start', ({ teams }) => {
  roundRunning = true;
  updateButtons();
  roundState.clear();
  for (const t of teams) roundState.set(t.id, { status: 'playing', team: t.team });
  renderPlayers();
  for (const team of ['pink', 'teal']) {
    $(`names-${team}`).textContent = teams.filter((t) => t.team === team).map((t) => t.name).join(', ');
  }
  $('tow-view').dataset.winner = '';
  $('tow-big').textContent = 'GET READY';
  $('tow-timer').textContent = '';
  $('knot').style.left = '50%';
  showRoundView('tow-view');
});

socket.on('tow:state', ({ phase, rope, force, msLeft }) => {
  // rope: +1 = Pink wins (left), -1 = Teal wins (right).
  $('knot').style.left = `${50 - rope * 50}%`;
  $('force-pink').style.width = `${Math.min(force.pink / METER_MAX, 1) * 100}%`;
  $('force-teal').style.width = `${Math.min(force.teal / METER_MAX, 1) * 100}%`;
  $('tow-big').textContent = phase === 'countdown' ? 'GET READY' : 'SHAKE!';
  $('tow-timer').textContent = `${Math.ceil(msLeft / 1000)}s`;
});

socket.on('tow:over', ({ reason, winner, results }) => {
  roundRunning = false;
  updateButtons();
  for (const r of results) {
    roundState.set(r.id, { status: r.status, team: r.team });
    applyRoundState(r.id);
  }
  $('tow-view').dataset.winner = winner || '';
  $('tow-big').textContent = winner ? `${winner.toUpperCase()} WINS` : 'NO WINNER';
  $('tow-timer').textContent = '';
  const heading = {
    pulled: `${winner?.toUpperCase()} pulled it across!`,
    time: winner ? `Time! ${winner.toUpperCase()} was ahead` : 'Time! Dead even',
    forfeit: winner ? `${winner.toUpperCase()} wins: the other team left` : 'Everyone left',
    host: 'Round ended by host',
  }[reason];
  showResults(heading, [
    ['Won', namesWith(results, 'won')],
    ['Still in', namesWith(results, 'playing')],
    ['Eliminated', namesWith(results, 'eliminated')],
  ]);
});

// --- Glass Bridge ------------------------------------------------------------

let gbState = null; // last gb:state
let gbLastJump = null; // last gb:jump, highlighted on the bridge
let gbDeadline = 0;
let gbCountdown = null;

const nameOf = (id) => gbState?.players.find((p) => p.id === id)?.name || players.find((p) => p.id === id)?.name || '';

function renderBridge() {
  const { steps, revealed, position, current } = gbState;
  const bridge = $('bridge');
  bridge.replaceChildren();
  const labels = document.createElement('div');
  labels.className = 'bridge-step row-labels';
  labels.innerHTML = '<div class="panel-label">LEFT</div><div class="panel-label">RIGHT</div>';
  bridge.append(labels);
  for (let i = 0; i < steps; i++) {
    const col = document.createElement('div');
    col.className = 'bridge-step';
    if (current && i === position) col.classList.add('next');
    for (const side of ['left', 'right']) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      if (i < revealed.length) panel.classList.add(revealed[i] === side ? 'safe' : 'broken');
      if (gbLastJump && gbLastJump.step === i && gbLastJump.side === side) {
        panel.classList.add('jumped', gbLastJump.correct ? 'ok' : 'crash');
      }
      col.append(panel);
    }
    const label = document.createElement('div');
    label.className = 'step-num';
    label.textContent = i + 1;
    col.append(label);
    bridge.append(col);
  }
}

function setNeedle(gamma) {
  const clamped = Math.max(-45, Math.min(45, gamma));
  $('tilt-needle').style.left = `${50 + (clamped / 45) * 50}%`;
}

function updateCountdown() {
  if (!gbState || gbState.phase !== 'choosing') return;
  const secs = Math.max(0, Math.ceil((gbDeadline - Date.now()) / 1000));
  $('gb-sub').textContent = `Step ${gbState.position + 1} of ${gbState.steps} · ${secs}s to jump`;
}

socket.on('gb:start', ({ order }) => {
  roundRunning = true;
  updateButtons();
  roundState.clear();
  for (const p of order) roundState.set(p.id, { status: 'waiting' });
  renderPlayers();
  gbLastJump = null;
  $('gb-big').textContent = 'GLASS BRIDGE';
  $('gb-sub').textContent = '';
  setNeedle(0);
  showRoundView('gb-view');
  clearInterval(gbCountdown);
  gbCountdown = setInterval(updateCountdown, 250);
});

socket.on('gb:state', (state) => {
  const previousCurrent = gbState?.current;
  gbState = state;
  for (const p of state.players) {
    roundState.set(p.id, { status: p.status });
    applyRoundState(p.id);
  }
  if (state.phase === 'choosing') {
    gbDeadline = Date.now() + state.msLeft;
    $('gb-big').textContent = `${nameOf(state.current).toUpperCase()}'S TURN`;
    if (state.current !== previousCurrent) setNeedle(0);
    updateCountdown();
  }
  const waiting = state.players.filter((p) => p.status === 'waiting').map((p) => p.name);
  $('gb-queue').textContent = waiting.length ? `Next up: ${waiting.join(', ')}` : '';
  renderBridge();
});

socket.on('gb:lean', ({ id, gamma }) => {
  if (gbState && id === gbState.current) setNeedle(gamma);
});

socket.on('gb:jump', (jump) => {
  gbLastJump = jump;
  $('gb-big').textContent = jump.correct ? 'SAFE!' : 'CRASH!';
  const how = jump.forced ? `${jump.name} froze and was pushed ${jump.side}` : `${jump.name} jumped ${jump.side}`;
  $('gb-sub').textContent = jump.correct ? `${how}. Tempered glass!` : `${how}. The glass shattered.`;
});

socket.on('gb:over', ({ reason, results }) => {
  roundRunning = false;
  updateButtons();
  clearInterval(gbCountdown);
  for (const r of results) {
    roundState.set(r.id, { status: r.status });
    applyRoundState(r.id);
  }
  if (gbState) {
    gbState = { ...gbState, current: null };
    renderBridge();
  }
  const survivors = namesWith(results, 'finished');
  $('gb-big').textContent = reason === 'host' ? 'ROUND ENDED' : survivors.length ? 'BRIDGE CROSSED' : 'NOBODY MADE IT';
  $('gb-queue').textContent = '';
  showResults(reason === 'host' ? 'Round ended by host' : 'Glass Bridge over', [
    ['Crossed', survivors],
    ['Still in', namesWith(results, 'playing')],
    ['Eliminated', namesWith(results, 'eliminated')],
  ]);
});

socket.on('disconnect', () => {
  showError({ message: 'Lost connection to the server. Reload to start a new room (players must rejoin).' });
});
