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

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('join-error').textContent = '';
  $('join-btn').disabled = true;
  try {
    await requestMotionPermission();
    const res = await joinRoom($('code').value, $('name').value);
    $('me').textContent = res.name;
    $('room').textContent = res.code;
    $('join-view').classList.add('hidden');
    $('lobby-view').classList.remove('hidden');
    startStreamingMotion();
  } catch (err) {
    $('join-error').textContent = err.message;
    $('join-btn').disabled = false;
  }
});

socket.on('room:closed', () => {
  $('lobby-error').textContent = 'The host closed the room. Reload to join a new one.';
});

socket.on('server:error', (error) => {
  $('lobby-error').textContent = error.message;
});

socket.on('disconnect', () => {
  $('lobby-error').textContent = 'Lost connection to the server. Reload to rejoin.';
});
