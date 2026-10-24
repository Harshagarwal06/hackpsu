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
    renderPlayers();
  });
});

$('end-btn').addEventListener('click', () => {
  socket.emit('host:end-round', (res) => showError(res.ok ? null : res.error));
});

function updateButtons() {
  $('start-btn').disabled = roundRunning || players.length === 0 || $('room-code').textContent.includes('·');
  $('end-btn').classList.toggle('hidden', !roundRunning);
}

const STATUS_LABEL = { playing: '', finished: '✓ Crossed', eliminated: '✕ Eliminated' };

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
  c.status.textContent = STATUS_LABEL[status];
  c.progress.parentElement.classList.toggle('hidden', !state);
  c.progress.style.width = `${(state ? state.progress : 0) * 100}%`;
}

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
  const crossed = results.filter((r) => r.status === 'finished').map((r) => r.name);
  const out = results.filter((r) => r.status === 'eliminated').map((r) => r.name);
  const still = results.filter((r) => r.status === 'playing').map((r) => r.name);
  const heading = reason === 'host' ? 'Round ended by host' : 'Round over';
  const box = $('results');
  box.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = heading;
  box.append(h);
  for (const [label, names] of [['Crossed', crossed], ['Still in', still], ['Eliminated', out]]) {
    if (names.length === 0) continue;
    const line = document.createElement('p');
    line.textContent = `${label}: ${names.join(', ')}`;
    box.append(line);
  }
  box.classList.remove('hidden');
});

socket.on('disconnect', () => {
  showError({ message: 'Lost connection to the server. Reload to start a new room (players must rejoin).' });
});
