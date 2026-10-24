# Squid Game: Phone Edition

A party game for HackPSU Fall 2026. Everyone joins on their phone, and every round is played
by moving the phone: freeze, shake, tilt. Get eliminated and your phone screams. Last phone standing wins.

Game design, timeline and demo script: [docs/PLAN.md](docs/PLAN.md).

## Play it

Live at **https://hackpsu-production.up.railway.app** (deployed on Railway from `main`).

1. Open **https://hackpsu-production.up.railway.app/host** on the laptop/projector.
2. Players scan the QR code on that screen, type a name and tap **Join & enable motion**.
3. Press **Start Game**.

Every push to `main` redeploys the server, and a redeploy wipes the current room — don't push mid-game.

## Run it locally

```bash
npm install
npm run dev
```

- Host screen (laptop on the projector): http://localhost:3000/host
- Player page: http://localhost:3000/

## Testing local changes on real phones (needs HTTPS)

Phones only share motion sensors with `https://` pages, so expose the local server through a tunnel
(the link changes each time and stops working if the laptop goes offline for a few minutes):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

It prints an `https://….trycloudflare.com` URL. Open `<that URL>/host` on the laptop and
`<that URL>/` on each phone. On iPhone, tapping **Join & enable motion** shows a permission prompt — tap Allow.

## Tests

```bash
npm test
```

## Layout

```
server.js          Express + Socket.IO server (the referee)
src/rooms.js       Rooms, players, rejoin keys (pure logic, unit tested)
src/redLight.js    Red Light, Green Light round
src/tugOfWar.js    Tug of War round
src/glassBridge.js Glass Bridge round
src/game.js        A full game: survivors carry over between rounds
public/index.html  Phone page        public/player.js
public/host.html   Big-screen page   public/host.js
public/style.css   Shared styles
test/              node:test tests
docs/PLAN.md       Game plan
```
