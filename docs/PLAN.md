# Squid Game: Phone Edition — Plan

HackPSU Fall 2026 · Target: **General Track: The Mystery Stack** ($1,500) + **Grand Prize**.

## The pitch (say this in 10 seconds)

Everyone in the room joins on their phone. Three Squid Game rounds, all controlled by
moving your phone. Get eliminated and your phone screams. Last phone standing wins.

## How it hits the Mystery Stack rules

| Rule | How we hit it |
|------|---------------|
| Phone Motion is core | Every round is played only by moving the phone: freeze, shake, tilt. No buttons during play. |
| Rivalry | Eliminations, a live leaderboard, team tug-of-war, one winner at the end. |
| Group Play (4+) | Built for a whole room: any number of phones join one room code. |

## The rounds

### 1. Red Light, Green Light — "freeze"
- Big screen shows GREEN: players walk toward the judges' table holding their phone.
- Big screen shows RED (random timing, 2–5 s): any movement above a threshold for
  the next few seconds eliminates you. Your phone flashes red and plays a loud sound.
- Short grace period (~300 ms) after RED so reaction time is fair.
- Round ends after N cycles or when the host presses "Next round".

### 2. Tug of War — "shake"
- Survivors are split into two teams (shown on each phone in team color).
- Shake as hard as you can. Each team's combined shake energy pulls the rope on the
  big screen. Rope crosses the line → losing team is eliminated.

### 3. Glass Bridge — "tilt"
- Each step, every survivor tilts left or right to choose a glass panel, then locks it in.
- One side is tempered (safe), one breaks. Wrong choice → eliminated.
- Last survivors standing win. Confetti on the big screen.

## Architecture

```
 Phones (player page)                Laptop on projector (host page)
 index.html + player.js              host.html + host.js
   │  reads devicemotion /              │  shows room code, players,
   │  deviceorientation                 │  round state, eliminations
   │  sends small samples ~10/s         │
   └──────────── Socket.IO ─────────────┘
                     │
               server.js (Node + Express + Socket.IO)
               src/rooms.js — rooms, players (pure logic, unit tested)
               rounds logic lives on the server (server decides who is out)
```

- **No build step.** Plain HTML/CSS/JS served from `public/`.
- **The server is the referee.** Phones only report motion; the server decides
  eliminations, so nobody can cheat by editing their page.
- **HTTPS is required** for motion sensors on phones (iOS especially). Use a tunnel
  (see README) so every phone gets an `https://` URL.

## 24-hour timeline

| When | Goal |
|------|------|
| Hour 0–2 | Lobby works on **real iPhone + Android** through the tunnel. Motion bars move on the host screen. (Done in the initial setup — verify on phones.) |
| Hour 2–7 | Red Light, Green Light fully playable. Tune the movement threshold with 4+ real phones. |
| Hour 7–11 | Tug of War playable. |
| Hour 11–15 | Glass Bridge playable. |
| Hour 15–19 | Polish: Squid Game visual style, sounds, elimination animation, leaderboard, winner screen. |
| Hour 19–22 | Playtest with strangers. Fix whatever confuses them. Record a backup demo video. |
| Hour 22–24 | Devpost write-up, screenshots, 60-second pitch rehearsal. Feature freeze. |

Check the schedule for the **Devpost Creation Deadline** and create the Devpost page early.

## Who builds what (team of 3–4)

- **Server / game logic:** round state machines, elimination rules, thresholds.
- **Phone page:** motion reading, permission flow, team color, elimination screen + sound.
- **Host screen:** big-screen visuals, rope, bridge, leaderboard, winner screen.
- **Pitch / design (or shared):** Squid Game styling, sounds, Devpost, demo script.

## Demo script (aim for 3 minutes)

1. 10-second pitch.
2. Put the room code on screen. Ask the judges to join on their own phones.
3. Play one Red Light, Green Light cycle with the judges. Someone gets eliminated, their phone screams.
4. Quick Tug of War between judges and team.
5. Show the winner screen. One sentence on how it works (server is the referee, works on any phone, no app install).

## Risks and how we handle them

| Risk | Plan |
|------|------|
| iPhone blocks motion | Must be HTTPS + tap "Enable motion" (calls `DeviceMotionEvent.requestPermission()`). Test in hour 0. |
| Venue Wi-Fi blocks phone-to-laptop traffic | Tunnel gives a public `https://` URL, so phones don't need the same network. Have a phone hotspot as backup. |
| Thresholds feel unfair | Tune with real people; add a short grace period after RED. |
| Phones lag or drop | Server ignores players who stop sending for > 3 s instead of eliminating them. |
| Demo fails live | Record a backup video by hour 22. |
| Name/branding | "Squid Game" is Netflix's property. Fine as a parody theme for a hackathon, but don't use their logo or official art. |
