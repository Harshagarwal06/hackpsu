// Phone page: join a room, then stream a "how much am I moving" number to the server.

const SEND_INTERVAL_MS = 100; // ~10 samples per second
const METER_MAX = 15; // m/s² that fills the meter

const socket = io();
const $ = (id) => document.getElementById(id);

let peakMotion = 0;
let lastGravity = null;

// iOS only lets a page read motion after the user taps something and agrees.
// This must be called directly from the tap handler, before any await.
async function requestMotionPermission() {
  if (!window.isSecureContext) {
    throw new Error('Motion needs a secure (https://) link. Ask the host for the https link.');
  }
  if (typeof DeviceMotionEvent === 'undefined') {
    throw new Error('This browser has no motion sensor support.');
  }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const result = await DeviceMotionEvent.requestPermission();
    if (result !== 'granted') {
      throw new Error('Motion permission was denied. Reload the page and tap Allow.');
    }
  }
}

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
  setInterval(() => {
    const m = Math.round(peakMotion * 100) / 100;
    peakMotion = 0;
    socket.emit('player:motion', m);
    $('my-meter').style.width = `${Math.min(m / METER_MAX, 1) * 100}%`;
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
let inRound = false;
let sittingOut = false; // joined while a round was already running

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
    await requestMotionPermission();
    const res = await joinRoom($('code').value, $('name').value);
    myId = res.id;
    $('me').textContent = res.name;
    $('room').textContent = res.code;
    if (res.roundRunning) {
      sittingOut = true;
      $('lobby-status').textContent = 'A round is in progress. You will play the next one.';
    }
    $('join-view').classList.add('hidden');
    $('motion-meter').classList.remove('hidden');
    showScreen('lobby');
    startStreamingMotion();
  } catch (err) {
    $('join-error').textContent = err.message;
    $('join-btn').disabled = false;
  }
});

socket.on('rl:phase', ({ phase }) => {
  if (!myId || sittingOut) return;
  if (!inRound) {
    // First light of a new round.
    inRound = true;
    myStatus = 'playing';
    $('my-progress').style.width = '0%';
  }
  if (myStatus !== 'playing') return;
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

socket.on('rl:over', ({ results }) => {
  if (!myId) return;
  inRound = false;
  if (sittingOut) {
    // Joined mid-round: they play the next one.
    sittingOut = false;
    $('lobby-status').textContent = 'Waiting for the host to start the next round.';
    return;
  }
  const me = results.find((r) => r.id === myId);
  if (!me) return;
  const word = { finished: 'YOU SURVIVED', eliminated: 'ELIMINATED', playing: 'ROUND ENDED' }[me.status];
  showScreen(me.status === 'eliminated' ? 'eliminated' : 'finished', word, 'Waiting for the next round.');
});

socket.on('room:closed', () => {
  $('status-error').textContent = 'The host closed the room. Reload to join a new one.';
});

socket.on('server:error', (error) => {
  $('status-error').textContent = error.message;
});

socket.on('disconnect', () => {
  $('status-error').textContent = 'Lost connection to the server. Reload to rejoin.';
});
