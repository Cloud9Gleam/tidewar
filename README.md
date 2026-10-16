# Tidewar — hex-island conquest for 2–4 players

**Play now (no install, no login):** https://tidewar.1040931305.workers.dev
(Alias: https://tidewar.n1netw3n.live/)


A complete multiplayer strategy game: a Cloudflare Worker serves a playable
browser UI and a JSON API for bots. Conquer 60% of the 37-isle hex map before
your rivals do.

## Rules

On a radius-3 hex grid (37 cells, axial coords like `"3,-1"`), 2–4 players each
start on a far-apart home isle with 3 units; all other isles are neutral wilds
with 1 unit. Players rotate turns; on your turn you first deploy reinforcements
(`max(2, floor(cells*3/4))`, plus a +4 bonus if you strictly lead the cell
count from 10 cells on) to your own isles in a single step, then make up to 2
attacks or pass. An attack commits k units (1 ≤ k ≤ source.units−1) from one of
your isles (2+ units) against an adjacent isle: if k beats the defenders you
capture it keeping `k − defenders` units there, otherwise you lose all k and
the defender only loses `min(k, defenders−1)` (always keeps ≥ 1). You win
immediately at end of your turn with ≥ 22 isles (60%), or by being the last
captain holding ≥ 1 isle; after 120 total turns the most isles wins (tie →
most units). Wiped-out players are skipped.

## How to run

### Deploy the Worker

```bash
npx wrangler kv:namespace create TIDEWAR   # paste the id into wrangler.toml
npx wrangler deploy
```

This publishes two things: the human UI at `GET /` and the JSON API under
`/api/*`. Your `https://tidewar.<you>.workers.dev` URL is the public game
URL — no login, no install, just open it, create a lobby, share the code.

The Worker also runs **without** the KV binding (in-memory fallback), which is
how the included test suite exercises the full HTTP API locally — but state
won't survive restarts that way, so bind KV for production.

### Play in the browser

Open the workers.dev URL → enter a captain name → **Create lobby** (2/3/4
players) → share the 6-character code. On your turn: click your isles to place
reinforcements, then click a 2+ unit isle and an adjacent target, pick how many
units to commit with the slider, and attack — or end your turn. The board
polls for updates, shows a live match log, scores, and a win banner.

### Run the sample bot

```bash
node bot.js https://tidewar.<you>.workers.dev
# or join an existing lobby: node bot.js <BASE_URL> <CODE> [NAME]
```

`bot.js` (Node 18+, zero dependencies) creates a 2-player lobby, joins as an
API-driven seat, adds a server-driven bot opponent, and plays turn-by-turn
until someone wins, printing the log.

## API

All `/api/*` routes allow CORS (`*`). Errors are JSON `{error: "..."}` with a
suitable status (400 validation, 403 bad secret, 404 unknown code).

### POST /api/lobby → `{code}`

```bash
curl -X POST $BASE/api/lobby -H 'content-type: application/json' \
  -d '{"players":2}'
# {"code":"KX7Q2M"}
```

### POST /api/join → `{playerId, secret, color, home}`

```bash
curl -X POST $BASE/api/join -H 'content-type: application/json' \
  -d '{"code":"KX7Q2M","name":"Alice"}'
# {"playerId":"p1","secret":"...","color":"#ff6b6b","home":"3,0"}
```

Pass `"bot": true` to add a **server-driven** seat: the built-in heuristic
plays its turns automatically. Your own bot must join as a regular seat (no
`bot` flag) so the server leaves its turns for you. The game starts when all
seats are filled; keep the `secret` — it authenticates your moves.

### GET /api/state?code=CODE → public state

Players (no secrets), cells (`{"q,r": {"owner": playerId|"neutral", "units"}}`),
`currentPlayer`, `turn`/`maxTurns`, `pendingReinforcements`, `attacksUsed`,
`winner`/`winReason`, and the last 30 log events.

### POST /api/move → `{state}`

```bash
curl -X POST $BASE/api/move -H 'content-type: application/json' -d '{
  "code":"KX7Q2M","playerId":"p1","secret":"...",
  "moves":[
    {"type":"deploy","placements":[{"cell":"3,0","units":2}]},
    {"type":"attack","from":"3,0","to":"2,0","units":2},
    {"type":"attack","from":"2,0","to":"2,-1","units":2}
  ]}'
```

Moves apply in order and are validated strictly: deploy must come first and
spend exactly `pendingReinforcements`; at most 2 attacks; `pass` (or running
out of moves) ends the turn. Wrong turn / bad coords / bad unit counts →
400 with an explanation. After your turn, the server automatically plays any
consecutive `bot:true` seats until the next human seat or game end, so one
POST can advance several turns — the returned `state` reflects all of it.

You may also send a turn incrementally (deploy in one POST, attacks in later
POSTs) — the UI does this.

### GET /api/log?code=CODE → `{code, log}`

Full event log `[{turn, player, action, detail}]` for replays.

## Bot strategy

Both the server's `bot:true` seats and `bot.js` use the same deterministic
heuristic (no randomness, fast):

1. **Deploy** — expansion first: border isles facing neutral wilds are topped
   up to 3 units (enough to take a wild with k=2), weakest wild first; all
   remaining reinforcements stack on the single border isle facing the weakest
   foe (breakthrough push).
2. **Attack** (up to 2) — weakest winnable target, wilds before enemies, and
   only battles it can win. Commit is minimum (`target.units+1`) vs wilds and
   when holding ≥ 20 isles (a double-capture wins on the spot); otherwise it
   overcommits to leave a 7-unit garrison the enemy cannot cheaply recapture.
3. **Pass** if nothing winnable.

## Balance notes (from simulation)

Simulated bot-vs-bot games: **2-player ends by domination in ~51 turns**;
4-player ends by domination in ~116 player-turns (≈29 rounds each) with
eliminations happening. Two tunings were needed to get there, both within the
allowed levers:

- **Reinforcements** are `max(2, floor(cells*3/4))` uncapped, plus **+4/turn
  for the strict cell leader from 10 cells**. Sims showed any low cap (5, then
  8) produces a symmetric endgame where every capture is affordably recaptured,
  stalling to the 120-turn cap — a 1-cell lead only buys ~5% more income. The
  leader bonus pays for two simultaneous garrisoned captures the trailer
  cannot fully answer, so leads compound into wins instead of trench warfare.
- **The bot** prioritizes wilds over futile 1-for-1 trades (an early version
  stacked everything on a contested cell while 18 wilds sat untouched) and
  garrisons mid-game captures so they stick.

No dominant rush exists: all-in early attacks leave the source at 1 unit and
stall against the defender-keeps-1 rule, while turtling cedes the wild race —
the winning play is winning the expansion race, then converting the lead.

## Repo structure

```
tidewar/
  worker.js      # the whole game: pure logic (importable) + HTTP API + embedded UI
  bot.js         # sample API bot (Node 18+, zero deps)
  test-local.mjs # validation tests + full bot simulations + HTTP API end-to-end
  wrangler.toml  # deploy config (KV binding TIDEWAR)
  README.md
```

## Honest notes

- Game state is **server-side** (KV `TIDEWAR`, key `tidewar:<CODE>`); the
  browser and bots are thin clients. Seat `secret`s gate moves — no accounts.
- Concurrent moves on the same turn are last-write-wins (turn validation
  rejects the loser); fine for a casual game, not for money.
- No secrets, keys, or tokens anywhere in this code.
