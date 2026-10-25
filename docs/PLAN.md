# Squid Game: Phone Edition — Plan

HackPSU Fall 2026 · Target: **General Track: The Mystery Stack** ($1,500) + **Grand Prize**.

Live at **https://hackpsu-production.up.railway.app/host** (Railway, deployed from `main`).

## The pitch (say this in 10 seconds)

Everyone in the room joins on their phone. Three Squid Game rounds, all controlled by
moving your phone. Get eliminated and your phone screams. Last phone standing wins.

## How it hits the Mystery Stack rules

| Rule | How we hit it |
|------|---------------|
| Phone Motion is core | Every round is played only by moving the phone: freeze, shake, tilt. No buttons during play. |
| Rivalry | Live eliminations, team tug of war, one winner at the end. |
| Group Play (4+) | Built for a whole room: any number of phones join one room code. |

## The game

The host presses **Start Game**. Rounds run in order and only survivors play the next one.
Between rounds the big screen shows who is still in and who is out, and the host presses
**Next round** when the room is ready. The game ends on a winner screen after Glass Bridge,
or as soon as one player is left. If a round would knock out everyone who played it, nobody
is eliminated in that round (except on the bridge — see below).

### 1. Red Light, Green Light — "freeze"
- Five lights. GREEN lasts a random 2–5 s, RED lasts 3 s.
- GREEN: moving (above the host's movement limit) fills your bar. Fill it to cross the
  finish line and you're safe.
- RED: moving eliminates you, after a 0.5 s grace period that starts when **your own phone**
  shows red (it tells the server), capped at 1 s after red began. Network delay doesn't
  eat into your reaction time.
- Anyone who hasn't crossed when the lights run out is eliminated.

### 2. Tug of War — "shake"
- Survivors are split into two even random teams, Pink and Teal.
- 3 s countdown, then shake. Every 0.1 s the rope moves by the difference between the
  teams' **average** shake strength, so uneven team sizes stay fair. Each phone's reading is
  capped and readings older than 0.4 s count as zero.
- First team past their line wins; otherwise whoever is ahead after 30 s. The losing team is out.

### 3. Glass Bridge — "tilt"
- Players cross **one at a time** in a random order, like the show. The bridge has 3–10 steps
  (players + 1), each a left/right pair with one safe panel chosen at random by the server.
- On your turn, tilt the phone past 20° and hold for 1 s to jump. Freeze for 7 s and you're
  pushed onto a random panel.
- A wrong panel eliminates you and reveals that step; the next player walks across every
  known step. Once the whole bridge is revealed, everyone left crosses.
- If everyone falls, the player who got furthest wins.

## Host tools

- **QR code + room code** on the big screen; scanning opens the phone page with the code filled in.
- **Movement limit slider** to tune Red Light for the room, live, even mid-round.
- **End round** (nobody else is eliminated) and **End game**.
- **Practice rounds** (everyone plays, nothing counts). In practice Tug of War the host can tap
  players onto Pink or Teal ("judges vs. us"); the real game always uses random teams.
- **Kick** a player (✕ on their card): they leave the room, round and game, and can't auto-rejoin.

## Architecture

```
 Phones (player page)                Laptop on projector (host page)
 index.html + player.js              host.html + host.js
   │  motion ~10/s, tilt, "seen red"    │  room code + QR, players, rounds,
   │                                    │  slider, kick, team picks
   └──────────── Socket.IO ─────────────┘
                     │
               server.js — Node + Express + Socket.IO, hosted on Railway (HTTPS)
               src/rooms.js       rooms, players, rejoin keys
               src/redLight.js    src/tugOfWar.js    src/glassBridge.js
               src/game.js        survivors carry over between rounds
```

- **No build step.** Plain HTML/CSS/JS served from `public/`.
- **The server is the referee.** Phones only report readings; the server decides every
  elimination, so nobody can cheat by editing their page.
- **Reconnects.** Players and the host have a stable id and a private rejoin key kept in the
  browser tab. A phone that loses its connection rejoins automatically as the same player and
  is caught up on the running round; after a reload it offers one-tap Rejoin (iPhone needs the
  tap to re-enable motion). Players are dropped after 30 s away; a room closes after its host
  is gone for 60 s.
- **HTTPS** is required for motion sensors on phones. Production runs on Railway; a Cloudflare
  tunnel (see README) is for trying local changes on real phones.
- **Rooms live in server memory.** A redeploy or restart wipes every room — every push to `main`
  redeploys, so don't push mid-game.

## Status

| Item | Status |
|------|--------|
| Lobby, QR join, live motion bars | Done |
| Red Light, Tug of War, Glass Bridge | Done |
| Full game: survivors carry over, winner screen | Done |
| Reconnects, kick, practice team picks | Done |
| Permanent hosting (Railway) | Done |
| Automated tests | 68 passing (`npm test`) |
| Playtest on real phones (iPhone + Android, 4+ people) | **To do** — tune movement limit, Tug of War pull speed, tilt angle/hold |
| Backup demo video | **To do** |
| Devpost submission, screenshots, team names | **To do** |
| 60-second pitch rehearsal | **To do** |

## Demo script (aim for 3 minutes)

1. 10-second pitch.
2. Put the QR code on screen. Ask the judges to scan it with their own phones.
3. Practice Red Light for 20 seconds to show the idea (tune the slider if needed).
4. Practice Tug of War, judges vs. team (tap them onto teams first).
5. Start Game and play it through to the winner screen, or play one round and summarize.
6. One sentence on how it works: server is the referee, works on any phone, no app install,
   and phones that drop out rejoin by themselves.

## Risks and how we handle them

| Risk | Plan |
|------|------|
| iPhone blocks motion or tilt | HTTPS + the Join tap asks for both; a phone without tilt is warned and can still play the other rounds. Test on a real iPhone first. |
| Thresholds feel unfair | Tune the movement limit live with the slider; the Red Light grace counts from when each phone shows red. |
| Phones lag, lock or drop | They rejoin automatically as the same player; only 30 s away drops them. |
| Server restarts mid-game | Rooms are in memory, so a restart wipes the game. Don't push or redeploy during judging; turn off Railway app sleeping. |
| Demo fails live | Record a backup video with real people. |
| Name/branding | "Squid Game" is Netflix's property. Fine as a parody theme for a hackathon, but don't use their logo or official art. |
