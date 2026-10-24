// Host screen (laptop on the projector): creates a room and shows players live.

const METER_MAX = 15; // keep in sync with player.js

const socket = io();
const $ = (id) => document.getElementById(id);
const meters = new Map(); // player id -> meter element

$('join-url').textContent = location.host;

socket.emit('host:create', (res) => {
  if (!res.ok) {
    $('host-error').textContent = res.error.message;
    return;
  }
  $('room-code').textContent = res.code;
});

socket.on('room:players', (players) => {
  $('count').textContent = players.length;
  const list = $('players');
  list.replaceChildren();
  meters.clear();
  for (const p of players) {
    const card = document.createElement('div');
    card.className = 'player-card';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name;
    const meter = document.createElement('div');
    meter.className = 'meter';
    const fill = document.createElement('div');
    meter.append(fill);
    card.append(name, meter);
    list.append(card);
    meters.set(p.id, fill);
  }
});

socket.on('player:motion', ({ id, m }) => {
  const fill = meters.get(id);
  if (fill) fill.style.width = `${Math.min(m / METER_MAX, 1) * 100}%`;
});

socket.on('disconnect', () => {
  $('host-error').textContent = 'Lost connection to the server. Reload to start a new room (players must rejoin).';
});
