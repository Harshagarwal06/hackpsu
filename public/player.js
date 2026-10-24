// Phone page: join a room, then stream a "how much am I moving" number to the server.

const SEND_INTERVAL_MS = 100; // ~10 samples per second
const METER_MAX = 15; // m/s² that fills the meter

const socket = io();
const $ = (id) => document.getElementById(id);

let peakMotion = 0;
let lastGravity = null;

// iOS only lets a page read motion and tilt after the user taps something and agrees.
// This must be called directly from the tap handler: both permission requests
// start before the first await so they both count as part of the tap.
// Motion is required. Tilt (only used by Glass Bridge) is not: returns 'granted'
// or a reason it isn't available, which the caller shows to the player.
async function requestMotionPermission() {
  if (!window.isSecureContext) {
    throw new Error('Motion needs a secure (https://) link. Ask the host for the https link.');
  }
  if (typeof DeviceMotionEvent === 'undefined') {
    throw new Error('This browser has no motion sensor support.');
  }
  const motionAsk = typeof DeviceMotionEvent.requestPermission === 'function'
    ? DeviceMotionEvent.requestPermission()
    : Promise.resolve('granted');
  let tiltAsk;
  if (typeof DeviceOrientationEvent === 'undefined') {
    tiltAsk = Promise.resolve('not supported by this browser');
  } else if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    tiltAsk = DeviceOrientationEvent.requestPermission().catch((err) => err.message);
  } else {
    tiltAsk = Promise.resolve('granted');
  }
  const [motion, tilt] = await Promise.all([motionAsk, tiltAsk]);
  if (motion !== 'granted') {
    throw new Error('Motion permission was denied. Reload the page and tap Allow.');
  }
  return tilt;
}

// Left/right tilt in degrees (-90..90, negative = left), or null before the first reading.
let gamma = null;

// Movement strength for one sensor reading, in m/s².
// Prefers acceleration without gravity; otherwise uses the change in the
// with-gravity reading since the last event.
function motionMagnitude(event) {
  const a = event.acceleration;
  if (a && a.x != null && a.y != null && a.z != null) {
    return Math.hypot(a.x, a.y, a.z);
  }
  const g = event.accelerationIncludingGravity;
  if (!g || g.x == null) return 0;
  const prev = lastGravity;
  lastGravity = { x: g.x, y: g.y, z: g.z };
  if (!prev) return 0;
  return Math.hypot(g.x - prev.x, g.y - prev.y, g.z - prev.z);
}

function startStreamingMotion() {
  window.addEventListener('devicemotion', (event) => {
    peakMotion = Math.max(peakMotion, motionMagnitude(event));
  });
  window.addEventListener('deviceorientation', (event) => {
    if (event.gamma != null) gamma = event.gamma;
  });
  setInterval(() => {
    const m = Math.round(peakMotion * 100) / 100;
    peakMotion = 0;
    socket.emit('player:motion', m);
    $('my-meter').style.width = `${Math.min(m / METER_MAX, 1) * 100}%`;
    if (bridgeChoosing) bridgeTick();
  }, SEND_INTERVAL_MS);
}

function joinRoom(code, name) {
  return new Promise((resolve, reject) => {
    socket.emit('player:join', { code, name }, (res) => {
      if (res.ok) resolve(res);
      else reject(new Error(res.error.message));
    });
  });
}

// --- Sound -----------------------------------------------------------------
// Browsers only allow audio after a tap, so the context is created in the join tap.
let audio = null;

function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audio = new Ctx();
  audio.resume();
}

function tone(freqFrom, freqTo, seconds, type = 'square', volume = 0.3) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const t = audio.currentTime;
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, t);
  osc.frequency.exponentialRampToValueAtTime(freqTo, t + seconds);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + seconds);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + seconds);
}

// --- Keep the screen on ----------------------------------------------------
// If the screen locks, motion stops being sent. Not every browser supports this,
// so tell the player to keep the screen on themselves when it fails.
async function keepScreenOn() {
  if (!('wakeLock' in navigator)) {
    $('wake-note').textContent = 'Keep your screen on while playing.';
    return;
  }
  try {
    await navigator.wakeLock.request('screen');
    $('wake-note').textContent = '';
  } catch (err) {
    $('wake-note').textContent = `Keep your screen on while playing (${err.message}).`;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && myId) keepScreenOn();
});

// --- Screens ---------------------------------------------------------------
let myId = null;
let myStatus = 'playing';
let inRound = false; // true while this player is taking part in a round

function showScreen(screen, word, hint) {
  document.body.dataset.screen = screen;
  $('lobby-view').classList.toggle('hidden', screen !== 'lobby');
  $('game-view').classList.toggle('hidden', screen === 'lobby');
  $('big-word').textContent = word || '';
  $('game-hint').textContent = hint || '';
}

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('join-error').textContent = '';
  $('join-btn').disabled = true;
  try {
    unlockAudio();
    keepScreenOn();
    const tilt = await requestMotionPermission();
    if (tilt !== 'granted') {
      $('tilt-note').textContent = `Tilt isn't available (${tilt}), so you can't pick a side in Glass Bridge.`;
    }
    const res = await joinRoom($('code').value, $('name').value);
    myId = res.id;
    $('me').textContent = res.name;
    $('room').textContent = res.code;
    if (res.roundRunning) {
      $('lobby-status').textContent = 'A round is in progress. You will play the next one.';
    }
    $('join-view').classList.add('hidden');
    $('motion-meter').classList.remove('hidden');
    showScreen('lobby');
    if (res.game) applyGame(res.game);
    startStreamingMotion();
  } catch (err) {
    $('join-error').textContent = err.message;
    $('join-btn').disabled = false;
  }
});

socket.on('rl:start', ({ players: list }) => {
  if (!myId || !list.some((p) => p.id === myId)) return;
  inRound = true;
  myStatus = 'playing';
  hideRoundWidgets();
  $('my-progress').style.width = '0%';
  $('progress-meter').classList.remove('hidden');
});

socket.on('rl:phase', ({ phase }) => {
  if (!inRound || myStatus !== 'playing') return;
  if (phase === 'green') {
    showScreen('green', 'GREEN LIGHT', 'Move! Fill your bar to cross the line.');
    tone(440, 660, 0.2, 'sine');
  } else {
    showScreen('red', 'RED LIGHT', 'FREEZE. Don\'t move.');
    tone(220, 110, 0.4, 'sawtooth');
  }
});

socket.on('rl:player', ({ id, status, progress }) => {
  if (id !== myId) return;
  $('my-progress').style.width = `${progress * 100}%`;
  if (status === myStatus) return;
  myStatus = status;
  if (status === 'eliminated') {
    showScreen('eliminated', 'ELIMINATED', 'You moved. Watch the big screen.');
    tone(900, 60, 1.5, 'sawtooth', 0.6);
    if (navigator.vibrate) navigator.vibrate([400, 100, 400]);
  } else if (status === 'finished') {
    showScreen('finished', 'YOU CROSSED', 'Safe! Wait for the others.');
    tone(523, 1046, 0.5, 'sine');
  }
});

// Common end-of-round handling. Returns this player's result, or null if they
// weren't in the round.
function roundOver(results) {
  if (!myId) return null;
  const wasIn = inRound;
  inRound = false;
  if (!wasIn) {
    // Joined mid-round or sat it out: they can play the next one.
    $('lobby-status').textContent = 'Waiting for the host to start the next round.';
    return null;
  }
  return results.find((r) => r.id === myId) || null;
}

socket.on('rl:over', ({ results }) => {
  const me = roundOver(results);
  if (!me) return;
  const word = { finished: 'YOU SURVIVED', eliminated: 'ELIMINATED', playing: 'ROUND ENDED' }[me.status];
  showScreen(me.status === 'eliminated' ? 'eliminated' : 'finished', word, 'Waiting for the next round.');
});

// --- Tug of War --------------------------------------------------------------
let myTeam = null;
let towPhase = null;

socket.on('tow:start', ({ teams }) => {
  const mine = myId && teams.find((t) => t.id === myId);
  if (!mine) return;
  inRound = true;
  myTeam = mine.team;
  towPhase = 'countdown';
  hideRoundWidgets();
  $('my-rope').classList.remove('hidden');
  $('my-knot').style.left = '50%';
  showScreen(myTeam, 'GET READY', `You're on Team ${myTeam.toUpperCase()}. Shake when it says SHAKE!`);
});

socket.on('tow:state', ({ phase, rope }) => {
  if (!myTeam) return;
  // Your team's side is always on the left of your screen.
  const mySide = myTeam === 'pink' ? rope : -rope;
  $('my-knot').style.left = `${50 - mySide * 50}%`;
  if (phase !== 'pull') return;
  if (towPhase !== 'pull') {
    towPhase = 'pull';
    tone(330, 880, 0.3, 'square');
  }
  const hint = mySide > 0.05 ? 'Winning! Keep shaking!' : mySide < -0.05 ? 'Losing! SHAKE HARDER!' : 'Dead even. SHAKE!';
  showScreen(myTeam, 'SHAKE!', hint);
});

socket.on('tow:over', ({ results }) => {
  const me = roundOver(results);
  myTeam = null;
  towPhase = null;
  if (!me) return;
  $('my-rope').classList.add('hidden');
  if (me.status === 'won') {
    showScreen('finished', 'YOUR TEAM WON', 'Waiting for the next round.');
    tone(523, 1046, 0.5, 'sine');
  } else if (me.status === 'eliminated') {
    showScreen('eliminated', 'ELIMINATED', 'Your team lost the tug of war.');
    tone(900, 60, 1.5, 'sawtooth', 0.6);
    if (navigator.vibrate) navigator.vibrate([400, 100, 400]);
  } else {
    showScreen('finished', 'ROUND ENDED', 'Waiting for the next round.');
  }
});

// --- Glass Bridge ------------------------------------------------------------
const TILT_DEG = 20; // lean at least this far to pick a side
const HOLD_MS = 1000; // hold the lean this long to jump

let inBridge = false;
let bridgeChoosing = false;
let holdSide = null;
let holdStart = 0;

function setPads(side, fraction) {
  for (const s of ['left', 'right']) {
    $(`pad-${s}`).querySelector('.pad-fill').style.height = s === side ? `${fraction * 100}%` : '0%';
  }
}

// Runs every sample while it's this player's turn: send the lean, and jump
// once a side has been held long enough.
function bridgeTick() {
  if (gamma == null) return;
  socket.emit('gb:lean', Math.round(gamma));
  const side = gamma <= -TILT_DEG ? 'left' : gamma >= TILT_DEG ? 'right' : null;
  const now = Date.now();
  if (side !== holdSide) {
    holdSide = side;
    holdStart = now;
  }
  const held = side ? Math.min((now - holdStart) / HOLD_MS, 1) : 0;
  setPads(side, held);
  if (side && held >= 1) {
    bridgeChoosing = false;
    socket.emit('gb:choose', side, (res) => {
      if (!res.ok) $('status-error').textContent = res.error.message;
    });
  }
}

function hideRoundWidgets() {
  $('progress-meter').classList.add('hidden');
  $('my-rope').classList.add('hidden');
  $('jump-pads').classList.add('hidden');
}

socket.on('gb:start', ({ order }) => {
  if (!myId || !order.some((p) => p.id === myId)) return;
  inRound = true;
  inBridge = true;
  hideRoundWidgets();
  showScreen('bridge', 'GLASS BRIDGE', 'Take turns crossing. Watch the big screen.');
});

socket.on('gb:state', ({ phase, current, position, steps, players: list }) => {
  if (!inBridge) return;
  const me = list.find((p) => p.id === myId);
  if (!me) return;
  if (me.status === 'waiting') {
    const place = list.filter((p) => p.status === 'waiting').findIndex((p) => p.id === myId) + 1;
    const hint = place === 1 ? "You're next! Get ready to tilt." : `You're #${place} in line. Watch the big screen.`;
    showScreen('bridge', 'WAIT', hint);
  } else if (me.status === 'onBridge' && current === myId && phase === 'choosing') {
    if (!bridgeChoosing) {
      // A new step: start the hold from scratch.
      tone(440, 880, 0.25, 'sine');
      holdSide = null;
      setPads(null, 0);
    }
    bridgeChoosing = true;
    $('jump-pads').classList.remove('hidden');
    showScreen('bridge', 'YOUR TURN', `Step ${position + 1} of ${steps}. Tilt left or right and HOLD to jump.`);
  } else {
    bridgeChoosing = false;
    $('jump-pads').classList.add('hidden');
  }
});

socket.on('gb:jump', ({ id, side, correct, forced }) => {
  if (!inBridge || id !== myId) return;
  bridgeChoosing = false;
  $('jump-pads').classList.add('hidden');
  const how = forced ? `You froze and got pushed ${side}.` : `You jumped ${side}.`;
  if (correct) {
    showScreen('green', 'SAFE!', `${how} Tempered glass.`);
    tone(523, 1046, 0.4, 'sine');
  } else {
    showScreen('eliminated', 'ELIMINATED', `${how} The glass shattered.`);
    tone(1200, 40, 1.5, 'sawtooth', 0.6);
    if (navigator.vibrate) navigator.vibrate([400, 100, 400]);
  }
});

socket.on('gb:over', ({ results }) => {
  inBridge = false;
  bridgeChoosing = false;
  const me = roundOver(results);
  if (!me) return;
  $('jump-pads').classList.add('hidden');
  if (me.status === 'finished') {
    showScreen('finished', 'YOU CROSSED', 'You made it across the bridge.');
    tone(523, 1046, 0.5, 'sine');
  } else if (me.status === 'eliminated') {
    showScreen('eliminated', 'ELIMINATED', 'Waiting for the next round.');
  } else {
    showScreen('finished', 'ROUND ENDED', 'Waiting for the next round.');
  }
});

// --- Game (rounds in a row) ------------------------------------------------
// The game decides what this phone shows between rounds. During a round the
// round's own events drive the screen, so 'playing' only matters for players
// who are out or joined late.
function applyGame(game) {
  if (!myId) return;
  if (!game) {
    if (!inRound) {
      showScreen('lobby');
      $('lobby-status').textContent = 'Waiting for the host to start.';
    }
    return;
  }
  const alive = game.alive.some((p) => p.id === myId);
  const out = game.out.find((o) => o.id === myId);
  if (game.phase === 'over') {
    if (game.winners.some((w) => w.id === myId)) {
      const others = game.winners.filter((w) => w.id !== myId).map((w) => w.name);
      let hint = 'Last one standing. Take a bow.';
      if (others.length) hint = `You share the win with ${others.join(', ')}.`;
      else if (game.note) hint = game.note; // e.g. won by getting furthest on the bridge
      showScreen('winner', 'YOU WON', hint);
      tone(523, 1046, 0.3, 'sine');
      setTimeout(() => tone(659, 1318, 0.3, 'sine'), 300);
      setTimeout(() => tone(784, 1568, 0.6, 'sine'), 600);
    } else if (alive || out) {
      const names = game.winners.map((w) => w.name).join(', ') || 'nobody';
      showScreen('eliminated', 'GAME OVER', `Winner: ${names}`);
    }
  } else if (out) {
    if (!inRound) showScreen('eliminated', "YOU'RE OUT", `Out in ${out.round}. Watch the big screen.`);
  } else if (alive) {
    if (game.phase === 'intermission') {
      showScreen('finished', "YOU'RE STILL IN", `Next: ${game.next}. Get ready!`);
    }
  } else {
    // Joined after the game started.
    $('lobby-status').textContent = 'A game is in progress. You can play the next one.';
  }
}

socket.on('game:state', applyGame);

socket.on('room:closed', () => {
  $('status-error').textContent = 'The host closed the room. Reload to join a new one.';
});

socket.on('server:error', (error) => {
  $('status-error').textContent = error.message;
});

socket.on('disconnect', () => {
  $('status-error').textContent = 'Lost connection to the server. Reload to rejoin.';
});
