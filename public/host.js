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

$('start-btn').addEventListener('click', () => {
  showError(null);
  socket.emit('host:start-redlight', (res) => {
    if (!res.ok) return showError(res.error);
    roundState.clear();
    for (const p of players) roundState.set(p.id, { status: 'playing', progress: 0 });
    $('results').classList.add('hidden');
    $('tow-view').classList.add('hidden');
    renderPlayers();
  });
});

$('tug-btn').addEventListener('click', () => {
  showError(null);
  socket.emit('host:start-tug', (res) => {
    if (!res.ok) return showError(res.error);
    $('results').classList.add('hidden');
  });
});

$('end-btn').addEventListener('click', () => {
  socket.emit('host:end-round', (res) => showError(res.ok ? null : res.error));
});

function updateButtons() {
  const noRoom = $('room-code').textContent.includes('·');
  $('start-btn').disabled = roundRunning || players.length === 0 || noRoom;
  $('tug-btn').disabled = roundRunning || players.length < 2 || noRoom;
  $('end-btn').classList.toggle('hidden', !roundRunning);
}

const STATUS_LABEL = { playing: '', finished: '✓ Crossed', won: '✓ Won', eliminated: '✕ Eliminated' };

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
  const status = state ? state.status : 'playing';
  c.card.dataset.status = status;
  c.card.dataset.team = state?.team || '';
  c.status.textContent = STATUS_LABEL[status];
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
  $('tow-view').classList.remove('hidden');
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

socket.on('disconnect', () => {
  showError({ message: 'Lost connection to the server. Reload to start a new room (players must rejoin).' });
});
