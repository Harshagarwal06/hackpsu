# Squid Game: Phone Edition

A party game for HackPSU Fall 2026. Everyone joins on their phone, and every round is played
by moving the phone: freeze, shake, tilt. Get eliminated and your phone screams. Last phone standing wins.

Game design, timeline and demo script: [docs/PLAN.md](docs/PLAN.md).

## Run it

```bash
npm install
npm run dev
```

- Host screen (laptop on the projector): http://localhost:3000/host
- Player page: http://localhost:3000/

## Playing on real phones (needs HTTPS)

Phones only share motion sensors with `https://` pages, so expose the local server through a tunnel:

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
src/rooms.js       Rooms and players (pure logic, unit tested)
public/index.html  Phone page        public/player.js
public/host.html   Big-screen page   public/host.js
public/style.css   Shared styles
test/              node:test tests
docs/PLAN.md       Game plan
```
