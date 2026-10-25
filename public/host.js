// Host screen (laptop on the projector): creates a room, shows players live,
// and runs the rounds and the game.

const METER_MAX = 15; // keep in sync with player.js

const socket = io();
const $ = (id) => document.getElementById(id);

let players = []; // [{ id, name }] from the server
const cards = new Map(); // player id -> { card, motion, progress, status }
const roundState = new Map(); // player id -> { status, progress } for the current/last round
let roundRunning = false;
let threshold = 0;

$('join-url').textContent = location.host;

// The doll and guards (art.js).
$('header-guards').innerHTML = guardSVG('circle') + guardSVG('triangle') + guardSVG('square');
$('banner-doll').innerHTML = dollSVG();
$('banner-guards').innerHTML = guardSVG('triangle') + guardSVG('square');
$('winner-guard-left').innerHTML = guardSVG('circle');
$('winner-guard-right').innerHTML = guardSVG('square');

function showError(err) {
  $('host-error').textContent = err ? err.message : '';
}

// This tab's room, kept across reloads and reconnects so the host can resume it.
const HOST_SESSION = 'sgpe-host';

function savedHost() {
  const raw = sessionStorage.getItem(HOST_SESSION);
  return raw ? JSON.parse(raw) : null;
}

function showRoom(res) {
  sessionStorage.setItem(HOST_SESSION, JSON.stringify({ code: res.code, key: res.key }));
  $('room-code').textContent = res.code;
  // The QR opens the phone page with this room's code filled in.
  const joinLink = `${location.origin}/?code=${res.code}`;
  $('qr').src = `/qr.svg?url=${encodeURIComponent(joinLink)}`;
  $('qr').onerror = () => showError({ message: 'Could not load the QR code. Players can still join with the link and code.' });
  $('qr-box').classList.remove('hidden');
  const slider = $('threshold');
  slider.min = res.minThreshold;
  slider.max = res.maxThreshold;
  setThreshold(res.threshold);
  slider.disabled = false;
  // Rounds that were running replay their start right after this; anything
  // that ended while we were away is cleared here.
  roundRunning = false;
  $('phase-banner').classList.add('hidden');
  showRoundView(null);
  updateButtons();
}

function createRoom() {
  players = [];
  game = null;
  renderPlayers();
  socket.emit('host:create', (res) => {
    if (!res.ok) return showError(res.error);
    showRoom(res);
  });
}

// Runs on the first connection and after every reconnect.
socket.on('connect', () => {
  const saved = savedHost();
  if (!saved) {
    createRoom();
    return;
  }
  socket.emit('host:resume', saved, (res) => {
    if (res.ok) {
      showError(null);
      showRoom(res);
      return;
    }
    sessionStorage.removeItem(HOST_SESSION);
    showError({ message: `Couldn't reconnect to room ${saved.code} (${res.error.message}). Started a new room.` });
    createRoom();
  });
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
// Practice Tug of War teams picked on the player cards: id -> 'pink' | 'teal'.
// Anyone not picked is placed randomly. The real game always uses random teams.
const teamPicks = new Map();
const NEXT_PICK = { random: 'pink', pink: 'teal', teal: 'random' };
const PICK_LABEL = { random: 'Team: random', pink: 'Team: Pink', teal: 'Team: Teal' };

$('tug-btn').addEventListener('click', () => {
  showError(null);
  socket.emit('host:start-tug', { teams: Object.fromEntries(teamPicks) }, (res) => showError(res.ok ? null : res.error));
});
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

// Team buttons only make sense between practice rounds.
function updateTeamPicks() {
  const show = !roundRunning && !(game && game.phase !== 'over');
  for (const [id, c] of cards) {
    const pick = teamPicks.get(id) || 'random';
    c.pick.classList.toggle('hidden', !show);
    c.pick.dataset.pick = pick;
    c.pick.textContent = PICK_LABEL[pick];
  }
}

function updateButtons() {
  updateTeamPicks();
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
let shownPot = null; // pot last shown, to tell when it grows

const won = (amount) => `₩${amount.toLocaleString('en-US')}`;
const pad = (n) => String(n).padStart(3, '0');

// "067 Ann" when we know the player's number.
function tag(id, name) {
  const p = players.find((q) => q.id === id);
  return p ? `${pad(p.number)} ${name}` : name;
}

// --- Sound (big screen) ---
// Browsers only allow audio after a click, so it starts on the host's first click.
let audio = null;
document.addEventListener('click', () => {
  if (audio) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audio = new Ctx();
  audio.resume();
});

function chaChing() {
  if (!audio) return;
  const t = audio.currentTime;
  for (const [delay, freq] of [[0, 1318], [0.09, 1760], [0.18, 2637]]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t + delay);
    gain.gain.setValueAtTime(0.25, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.35);
    osc.connect(gain).connect(audio.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 0.35);
  }
}

// --- Announcer (big screen voice) ---
// Calm, slow, formal delivery in the style of the show, using the voices
// already on this computer. A Korean voice speaks Korean lines with English
// subtitles; any other voice speaks the English lines. Like other sound, it
// only works after the host's first click (Start Game or Test voice counts).
const speech = 'speechSynthesis' in window ? window.speechSynthesis : null;
const VOICE_KEY = 'sgpe-voice';
const RATE = 0.85;
const PITCH = 0.9;
let announcerOn = Boolean(speech);
let voices = [];
let voice = null;
let voiceMemoryNote = ''; // set if this browser can't remember the choice

const isKorean = (v) => Boolean(v && v.lang.toLowerCase().startsWith('ko'));

function showAnnouncerButton() {
  const btn = $('announcer-btn');
  btn.disabled = !speech;
  btn.textContent = !speech ? 'Announcer: not supported here' : `Announcer: ${announcerOn ? 'on' : 'off'}`;
  $('voice-select').disabled = !speech;
  $('voice-test').disabled = !speech;
}

function showVoiceNote() {
  let note;
  if (!speech) note = '';
  else if (!voices.length) note = 'No voices found in this browser.';
  else if (isKorean(voice)) note = 'Korean lines, English subtitles.';
  else if (voices.some(isKorean)) note = 'English lines.';
  else note = 'English lines (no Korean voice on this computer).';
  $('voice-note').textContent = `${note} ${voiceMemoryNote}`.trim();
}

// Fills the voice list, Korean voices first, and picks the saved voice,
// else the first Korean one, else the browser's default.
function loadVoices() {
  if (!speech) return;
  voices = speech.getVoices().slice().sort(
    (a, b) => Number(isKorean(b)) - Number(isKorean(a)) || a.name.localeCompare(b.name),
  );
  const select = $('voice-select');
  select.replaceChildren();
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    select.append(opt);
  }
  let saved = null;
  try {
    saved = localStorage.getItem(VOICE_KEY);
  } catch (err) {
    voiceMemoryNote = `This browser can't remember the choice (${err.message}).`;
  }
  voice = voices.find((v) => v.voiceURI === saved) || voices.find(isKorean) || voices.find((v) => v.default) || voices[0] || null;
  if (voice) select.value = voice.voiceURI;
  showVoiceNote();
}

showAnnouncerButton();
if (speech) {
  loadVoices();
  // Chrome loads its voice list after the page; Safari has it right away.
  speech.addEventListener('voiceschanged', loadVoices);
}

$('announcer-btn').addEventListener('click', () => {
  announcerOn = !announcerOn;
  if (!announcerOn) speech.cancel();
  showAnnouncerButton();
});

$('voice-select').addEventListener('change', (e) => {
  voice = voices.find((v) => v.voiceURI === e.target.value) || null;
  try {
    localStorage.setItem(VOICE_KEY, e.target.value);
  } catch (err) {
    voiceMemoryNote = `This browser can't remember the choice (${err.message}).`;
  }
  showVoiceNote();
});

$('voice-test').addEventListener('click', () => {
  speak({ ko: '무궁화 꽃이 피었습니다', en: 'Green light.', sub: 'Green light. (The mugunghwa flower has bloomed.)' }, true);
  speak({ ko: '77번, 탈락.', en: 'Player zero seven seven, eliminated.', sub: 'Player 077: eliminated.' }, false);
});

// Big subtitles at the bottom of the projector for every line spoken.
let subtitleTimer = null;
function showSubtitle(ko, en) {
  $('subtitle-ko').textContent = ko;
  $('subtitle-en').textContent = en;
  $('subtitle').classList.remove('hidden');
  clearTimeout(subtitleTimer);
  subtitleTimer = setTimeout(() => $('subtitle').classList.add('hidden'), 4500);
}

// line: { ko, en, sub? } — sub is the English subtitle (defaults to en).
// urgent: cut off whatever is still being said (light changes must be on time).
function speak(line, urgent) {
  const korean = isKorean(voice);
  if (urgent) speech.cancel();
  const u = new SpeechSynthesisUtterance(korean ? line.ko : line.en);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = 'en-US';
  }
  u.rate = RATE;
  u.pitch = PITCH;
  speech.speak(u);
  showSubtitle(korean ? line.ko : '', line.sub || line.en);
}

function announce(line, { urgent = false } = {}) {
  if (!announcerOn) return;
  speak(line, urgent);
}

const joinList = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const playerOf = (id) => players.find((q) => q.id === id);

// "77번" — how a number is read out in Korean.
function koCall(id) {
  const p = playerOf(id);
  return p ? `${p.number}번` : '참가자';
}

// "Player zero six seven": said digit by digit.
function enCall(id) {
  const p = playerOf(id);
  return p ? `Player ${String(p.number).padStart(3, '0').split('').join(' ')}` : 'A player';
}

// "Player 067 (Ann)" for subtitles.
function subCall(id) {
  const p = playerOf(id);
  return p ? `Player ${pad(p.number)} (${p.name})` : 'A player';
}

// Eliminations that land together (e.g. time running out) are announced together.
let pendingOut = [];
let pendingOutTimer = null;
function announceOut(id) {
  pendingOut.push(id);
  clearTimeout(pendingOutTimer);
  pendingOutTimer = setTimeout(() => {
    announce({
      ko: `${pendingOut.map(koCall).join(', ')}, 탈락.`,
      en: `${joinList(pendingOut.map(enCall))}, eliminated.`,
      sub: `${joinList(pendingOut.map(subCall))}: eliminated.`,
    });
    pendingOut = [];
  }, 300);
}

const millions = (amount) => `${(amount / 1_000_000).toLocaleString('en-US')} million won`;
// 200,000,000 → "2억 원"; amounts that aren't whole 억 are read as plain numbers.
const koWon = (amount) => (amount % 100_000_000 === 0
  ? `${amount / 100_000_000}억 원`
  : `${amount.toLocaleString('ko-KR')}원`);

function showPot(pot) {
  $('pot-amount').textContent = won(pot);
  if (shownPot !== null && pot > shownPot) {
    chaChing();
    const box = $('pot');
    box.classList.remove('grow');
    void box.offsetWidth; // restart the animation
    box.classList.add('grow');
  }
  shownPot = pot;
}

function showAwards(state) {
  const names = state.winners.map((w) => tag(w.id, w.name));
  const share = state.winners.length ? Math.floor(state.pot / state.winners.length) : 0;
  $('winner-prize').textContent = state.winners.length
    ? `${won(share)}${state.winners.length > 1 ? ' each' : ''}`
    : '';
  $('winner-names').textContent = names.join(' · ');
  const box = $('awards');
  box.replaceChildren();
  for (const a of state.awards) {
    const card = document.createElement('div');
    card.className = 'award';
    const title = document.createElement('div');
    title.className = 'award-title';
    title.textContent = a.title;
    const who = document.createElement('div');
    who.className = 'award-who';
    who.textContent = tag(a.id, a.name);
    const detail = document.createElement('div');
    detail.className = 'award-detail';
    detail.textContent = `${a.why}: ${a.detail}`;
    card.append(title, who, detail);
    box.append(card);
  }
}

// Called when any round starts. A practice round after a finished game is not
// part of it, so the game's Winner / Out labels and winner panel go away.
function roundStarting() {
  if (game && game.phase !== 'over') return;
  gameOut = new Map();
  gameWinners = new Set();
  $('winner-view').classList.add('hidden');
}

socket.on('game:state', (state) => {
  if (state?.phase === 'over' && game && game.phase !== 'over') {
    // The game just ended (not a reload showing an old result): announce
    // the winners and their prize.
    const ids = state.winners.map((w) => w.id);
    if (ids.length) {
      const share = Math.floor(state.pot / ids.length);
      const each = ids.length > 1 ? ' each' : '';
      const verb = ids.length > 1 ? 'win' : 'wins';
      announce({
        ko: `${ids.map(koCall).join(', ')}, 우승.${state.pot ? ` 상금 ${koWon(share)}.` : ''}`,
        en: `${joinList(ids.map(enCall))} ${verb}.${state.pot ? ` Prize: ${millions(share)}${each}.` : ''}`,
        sub: `${joinList(ids.map(subCall))} ${verb}.${state.pot ? ` Prize: ${won(share)}${each}.` : ''}`,
      });
    } else {
      announce({ ko: '게임 종료. 우승자 없음.', en: 'Game over. Nobody won.' });
    }
  }
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
    showPot(state.pot);
    $('game-alive').textContent = `Still in (${state.alive.length}): ${state.alive.map((p) => tag(p.id, p.name)).join(', ') || 'nobody'}`;
    $('game-out').textContent = state.out.length
      ? `Out: ${state.out.map((o) => `${tag(o.id, o.name)} (${o.round})`).join(', ')}`
      : '';
    if (state.phase === 'over') {
      const count = state.winners.length;
      $('winner-label').textContent = count > 1 ? 'WINNERS' : count ? 'WINNER' : 'NO WINNER';
      showAwards(state);
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
  // Forget team picks for players who have left.
  for (const id of teamPicks.keys()) {
    if (!players.some((p) => p.id === id)) teamPicks.delete(id);
  }
  for (const p of players) {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <div class="card-top"><span class="name"></span><span class="status"></span><button class="kick" type="button">✕</button></div>
      <div class="meter motion"><div></div><span class="marker"></span></div>
      <div class="meter progress"><div></div></div>
      <button class="team-pick" type="button"></button>`;
    const pick = card.querySelector('.team-pick');
    pick.title = 'Tap to choose this player\'s team for practice Tug of War';
    pick.addEventListener('click', () => {
      const next = NEXT_PICK[teamPicks.get(p.id) || 'random'];
      if (next === 'random') teamPicks.delete(p.id);
      else teamPicks.set(p.id, next);
      updateTeamPicks();
    });
    card.querySelector('.name').textContent = `${pad(p.number)} ${p.name}${p.connected ? '' : ' · away'}`;
    const kick = card.querySelector('.kick');
    kick.title = `Remove ${p.name}`;
    kick.setAttribute('aria-label', `Remove ${p.name} from the room`);
    kick.addEventListener('click', () => {
      if (!confirm(`Remove ${p.name} from the room?`)) return;
      showError(null);
      socket.emit('host:kick', p.id, (res) => showError(res.ok ? null : res.error));
    });
    list.append(card);
    cards.set(p.id, {
      card,
      motion: card.querySelector('.motion > div'),
      marker: card.querySelector('.marker'),
      progress: card.querySelector('.progress > div'),
      status: card.querySelector('.status'),
      pick,
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

// --- Round briefing: rules and a countdown before every round ---
// Korean lines for the announcer; the English comes from the rules themselves.
const INTRO_KO = {
  redlight: '무궁화 꽃이 피었습니다 게임. 초록불에 움직이고, 빨간불에 멈추세요.',
  tug: '줄다리기. 있는 힘껏 흔드세요.',
  bridge: '징검다리 건너기. 왼쪽이나 오른쪽으로 기울여서 건너세요.',
};
let introTimer = null;

function hideIntro() {
  clearInterval(introTimer);
  $('intro-view').classList.add('hidden');
}

socket.on('round:intro', (info) => {
  roundStarting();
  roundRunning = true;
  updateButtons();
  $('results').classList.add('hidden');
  $('phase-banner').classList.add('hidden');
  showRoundView(null);
  $('intro-title').textContent = info.title;
  const list = $('intro-rules');
  list.replaceChildren();
  for (const rule of info.rules) {
    const li = document.createElement('li');
    li.textContent = rule;
    list.append(li);
  }
  $('intro-view').classList.remove('hidden');
  const endsAt = Date.now() + info.ms;
  const tick = () => {
    const secs = Math.ceil((endsAt - Date.now()) / 1000);
    if (secs <= 0) hideIntro();
    else $('intro-count').textContent = secs;
  };
  clearInterval(introTimer);
  tick();
  introTimer = setInterval(tick, 200);
  const roundName = info.title.split(' · ').at(-1);
  announce({ ko: INTRO_KO[info.key], en: `${roundName}. ${info.rules.join(' ')}`, sub: info.rules.join(' ') }, { urgent: true });
});

socket.on('rl:start', ({ players: inRound }) => {
  roundStarting();
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
  setDollFacing($('banner-doll').querySelector('.doll'), phase === 'red');
  announce(phase === 'green'
    ? { ko: '무궁화 꽃이 피었습니다', en: 'Green light.', sub: 'Green light. (The mugunghwa flower has bloomed.)' }
    : { ko: '멈추세요.', en: 'Red light. Stop.', sub: 'Red light! Stop.' }, { urgent: true });
});

socket.on('rl:player', ({ id, status, progress }) => {
  if (status === 'eliminated' && roundState.get(id)?.status !== 'eliminated') announceOut(id);
  roundState.set(id, { status, progress });
  applyRoundState(id);
});

socket.on('rl:over', ({ reason, results }) => {
  hideIntro(); // in case the host ended it during the briefing
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
  roundStarting();
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
  towPulling = false;
});

let towPulling = false; // whether "Pull!" has been announced this round

socket.on('tow:state', ({ phase, rope, force, msLeft }) => {
  if (phase === 'pull' && !towPulling) {
    towPulling = true;
    announce({ ko: '당기세요!', en: 'Pull!' }, { urgent: true });
  }
  // rope: +1 = Pink wins (left), -1 = Teal wins (right).
  $('knot').style.left = `${50 - rope * 50}%`;
  $('force-pink').style.width = `${Math.min(force.pink / METER_MAX, 1) * 100}%`;
  $('force-teal').style.width = `${Math.min(force.teal / METER_MAX, 1) * 100}%`;
  $('tow-big').textContent = phase === 'countdown' ? 'GET READY' : 'SHAKE!';
  $('tow-timer').textContent = `${Math.ceil(msLeft / 1000)}s`;
});

socket.on('tow:over', ({ reason, winner, results }) => {
  hideIntro();
  roundRunning = false;
  updateButtons();
  for (const r of results) {
    roundState.set(r.id, { status: r.status, team: r.team });
    applyRoundState(r.id);
  }
  $('tow-view').dataset.winner = winner || '';
  $('tow-big').textContent = winner ? `${winner.toUpperCase()} WINS` : 'NO WINNER';
  $('tow-timer').textContent = '';
  if (reason !== 'host') {
    announce(winner
      ? { ko: `${winner === 'pink' ? '핑크' : '청록'} 팀 승리.`, en: `Team ${winner === 'pink' ? 'Pink' : 'Teal'} wins.` }
      : { ko: '승자 없음.', en: 'No winner.' });
  }
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

socket.on('gb:start', ({ order, earned }) => {
  roundStarting();
  $('gb-order-note').textContent = earned
    ? 'Turn order is earned: whoever did best in Red Light and Tug of War crosses last.'
    : '';
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
  gbTurnCalled = null;
});

let gbTurnCalled = null; // player whose turn was last announced

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
    if (state.current !== gbTurnCalled) {
      gbTurnCalled = state.current;
      announce({
        ko: `${koCall(state.current)}, 차례입니다.`,
        en: `${enCall(state.current)}, your turn.`,
        sub: `${subCall(state.current)}, your turn.`,
      });
    }
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
  announce(jump.correct
    ? { ko: '통과.', en: 'Safe.' }
    : { ko: `${koCall(jump.id)}, 탈락.`, en: `${enCall(jump.id)}, eliminated.`, sub: `${subCall(jump.id)}: eliminated.` },
  { urgent: true });
});

socket.on('gb:over', ({ reason, results }) => {
  hideIntro();
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
  showError({ message: 'Lost connection to the server. Reconnecting to the same room…' });
});
