// ============================================================================
// Tidewar — hex-island conquest for 2-4 players.
// Cloudflare Worker (ES module, zero dependencies, no secrets).
//
// The pure game logic below (everything above the "WORKER / HTTP" section) is
// importable from Node for local testing: `import { createLobby, ... } from
// "./worker.js"`. None of it touches fetch/KV; the HTTP layer is a thin
// wrapper that loads/saves state.
// ============================================================================

// ----------------------------- constants -----------------------------------
export const RADIUS = 3;            // hex grid radius -> 37 cells
export const CELL_COUNT = 37;
export const MAX_TURNS = 120;      // total player-turns before sudden death
export const WIN_CELLS = 22;       // ~60% of 37 -> immediate domination win
export const MAX_ATTACKS = 2;      // attacks per turn
export const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]]; // axial neighbors
export const COLORS = ["#ff6b6b", "#4dabf7", "#51cf66", "#ffd43b"];
export const CORNERS = ["3,0", "0,3", "-3,3", "-3,0", "0,-3", "3,-3"];
const HOME_INDEX = { 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4] };
const CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SECRET_ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ----------------------------- hex utils -----------------------------------
export const cellKey = (q, r) => q + "," + r;
const KEY_RE = /^-?\d+,-?\d+$/;

let _allCells = null;
export function allCells() {
  if (!_allCells) {
    _allCells = [];
    for (let q = -RADIUS; q <= RADIUS; q++) {
      const lo = Math.max(-RADIUS, -q - RADIUS);
      const hi = Math.min(RADIUS, -q + RADIUS);
      for (let r = lo; r <= hi; r++) _allCells.push(cellKey(q, r));
    }
  }
  return _allCells;
}
const CELL_SET = new Set(allCells());

export function isValidCell(k) {
  return typeof k === "string" && KEY_RE.test(k) && CELL_SET.has(k);
}

export function neighborsOf(k) {
  const [q, r] = k.split(",").map(Number);
  const out = [];
  for (const [dq, dr] of DIRS) {
    const n = cellKey(q + dq, r + dr);
    if (CELL_SET.has(n)) out.push(n);
  }
  return out;
}

export function hexDistance(a, b) {
  const [aq, ar] = a.split(",").map(Number);
  const [bq, br] = b.split(",").map(Number);
  const dq = aq - bq, dr = ar - br;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

// ----------------------------- errors --------------------------------------
export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "GameError";
    this.status = status;
  }
}

// ----------------------------- small helpers -------------------------------
function randInt(n) {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  }
  return Math.floor(Math.random() * n);
}

export function makeCode(n = 6) {
  let s = "";
  for (let i = 0; i < n; i++) s += CODE_ALPHA[randInt(CODE_ALPHA.length)];
  return s;
}

function makeSecret(n = 16) {
  let s = "";
  for (let i = 0; i < n; i++) s += SECRET_ALPHA[randInt(SECRET_ALPHA.length)];
  return s;
}

export function ownedCells(game, playerId) {
  const out = [];
  for (const k of allCells()) if (game.cells[k].owner === playerId) out.push(k);
  return out;
}

export function countUnits(game, playerId) {
  let n = 0;
  for (const k of allCells()) if (game.cells[k].owner === playerId) n += game.cells[k].units;
  return n;
}

// max(2, floor(cells*3/4)) + leader bonus, NO CAP.
// Tuned 2026-10-16 (see README "balance notes"): sims showed that any purely
// proportional curve creates a symmetric 2-player endgame (19 vs 18) where
// every capture is affordably recaptured, stalling to the 120-turn cap -
// because a 1-cell lead only buys ~5% more income. The +4 leader bonus (strict
// cell lead, from 10 cells so the early race is undistorted) lets the leader
// afford two simultaneous garrisoned captures the trailer cannot fully
// recapture, compounding +1 cell/round and closing the game. The domination
// check happens at end of YOUR turn, so reaching 22 with a double-capture
// wins immediately - recapture is not a defense against it.
export function reinforcementCount(game, playerId) {
  const owned = ownedCells(game, playerId).length;
  let enemyMax = 0;
  for (const p of game.players) {
    if (p.id !== playerId) enemyMax = Math.max(enemyMax, ownedCells(game, p.id).length);
  }
  const base = Math.max(2, Math.floor((owned * 3) / 4));
  const bonus = owned >= 10 && owned > enemyMax ? 4 : 0;
  return base + bonus;
}

function playerName(game, id) {
  if (id === "neutral") return "wilds";
  const p = game.players.find((x) => x.id === id);
  return p ? p.name : id;
}

function addLog(game, action, player, detail) {
  game.log.push({
    turn: game.turn,
    player: player ? player.name : "—",
    action,
    detail: String(detail),
  });
}

// ----------------------------- lobby / join --------------------------------
export function createLobby(code, numPlayers) {
  if (!Number.isInteger(numPlayers) || numPlayers < 2 || numPlayers > 4) {
    throw new GameError("players must be an integer between 2 and 4", 400);
  }
  const cells = {};
  for (const k of allCells()) cells[k] = { owner: "neutral", units: 1 };
  const game = {
    code,
    numPlayers,
    players: [],
    cells,
    status: "lobby",
    currentPlayer: null,
    turn: 0,
    maxTurns: MAX_TURNS,
    pendingReinforcements: 0,
    attacksUsed: 0,
    winner: null,
    winReason: null,
    log: [],
    createdAt: new Date().toISOString(),
  };
  addLog(game, "lobby", null, `lobby ${code} created for ${numPlayers} players`);
  return game;
}

export function joinSeat(game, name, bot) {
  if (!game || game.status !== "lobby") throw new GameError("lobby is not open", 400);
  if (game.players.length >= game.numPlayers) throw new GameError("lobby is full", 400);
  const idx = game.players.length;
  const id = "p" + (idx + 1);
  const clean =
    typeof name === "string" && name.trim()
      ? name.trim().slice(0, 24)
      : (bot ? "Bot " : "Player ") + (idx + 1);
  const home = CORNERS[HOME_INDEX[game.numPlayers][idx]];
  const player = {
    id,
    name: clean,
    color: COLORS[idx % COLORS.length],
    bot: !!bot,
    secret: makeSecret(16),
    home,
    eliminated: false,
  };
  game.players.push(player);
  game.cells[home] = { owner: id, units: 3 };
  addLog(game, "join", player, `joined at ${home}${player.bot ? " (bot seat)" : ""}`);
  if (game.players.length === game.numPlayers) startGame(game);
  return player;
}

function startGame(game) {
  game.status = "active";
  game.currentPlayer = game.players[0].id;
  game.attacksUsed = 0;
  game.pendingReinforcements = reinforcementCount(game, game.currentPlayer);
  addLog(
    game,
    "start",
    null,
    `game started — ${game.players.map((p) => p.name).join(" vs ")}`
  );
}

// ----------------------------- move application ----------------------------
function applyDeploy(game, player, m) {
  const placements = m.placements;
  if (!Array.isArray(placements) || placements.length === 0) {
    throw new GameError("deploy needs a non-empty placements array", 400);
  }
  let total = 0;
  for (const pl of placements) {
    if (!pl || !isValidCell(pl.cell)) throw new GameError("bad cell in placements", 400);
    if (!Number.isInteger(pl.units) || pl.units < 1) {
      throw new GameError("placement units must be a positive integer", 400);
    }
    if (game.cells[pl.cell].owner !== player.id) {
      throw new GameError("can only deploy to your own cells", 400);
    }
    total += pl.units;
  }
  if (total !== game.pendingReinforcements) {
    throw new GameError(
      `must deploy exactly ${game.pendingReinforcements} units (got ${total})`,
      400
    );
  }
  for (const pl of placements) game.cells[pl.cell].units += pl.units;
  addLog(
    game,
    "deploy",
    player,
    `deployed ${total} → ${placements.map((p) => `${p.cell} (+${p.units})`).join(", ")}`
  );
  game.pendingReinforcements = 0;
}

function applyAttack(game, player, m) {
  const from = m.from, to = m.to, k = m.units;
  if (!isValidCell(from) || !isValidCell(to)) throw new GameError("bad attack coordinates", 400);
  const A = game.cells[from];
  const T = game.cells[to];
  if (A.owner !== player.id) throw new GameError("attack must start from your own cell", 400);
  if (T.owner === player.id) throw new GameError("cannot attack your own cell", 400);
  if (hexDistance(from, to) !== 1) throw new GameError("target is not adjacent", 400);
  if (A.units < 2) throw new GameError("need at least 2 units in the source cell to attack", 400);
  if (!Number.isInteger(k) || k < 1 || k > A.units - 1) {
    throw new GameError(`commit between 1 and ${A.units - 1} units`, 400);
  }
  const defenderId = T.owner;
  const defenderUnits = T.units;
  const defenderName = playerName(game, defenderId);
  A.units -= k;
  let detail;
  let captured = false;
  if (k > T.units) {
    const remaining = k - T.units;
    T.owner = player.id;
    T.units = remaining;
    captured = true;
    detail = `${from} → ${to} with ${k}: CAPTURED from ${defenderName} (${defenderUnits} defended, ${remaining} remain)`;
  } else {
    const lost = Math.min(k, T.units - 1); // defender keeps >= 1
    T.units -= lost;
    detail = `${from} → ${to} with ${k}: repelled by ${defenderName} (defender lost ${lost}, keeps ${T.units})`;
  }
  addLog(game, "attack", player, detail);
  game.attacksUsed += 1;
  if (captured && defenderId !== "neutral") {
    if (ownedCells(game, defenderId).length === 0) {
      const dp = game.players.find((p) => p.id === defenderId);
      if (dp) dp.eliminated = true;
      addLog(game, "eliminate", null, `${defenderName} has been eliminated`);
    }
    checkLastStanding(game);
  }
}

function checkLastStanding(game) {
  if (game.status !== "active") return;
  const alive = game.players.filter((p) => ownedCells(game, p.id).length > 0);
  if (alive.length === 1) {
    finishGame(game, alive[0].id, "last_standing");
  }
}

function finishGame(game, winnerId, reason) {
  game.status = "done";
  game.winner = winnerId;
  game.winReason = reason;
  const p = game.players.find((x) => x.id === winnerId);
  addLog(game, "win", p || null, `${p ? p.name : winnerId} wins by ${reason}`);
}

function decideByScore(game) {
  const scored = game.players.map((p) => ({
    id: p.id,
    cells: ownedCells(game, p.id).length,
    units: countUnits(game, p.id),
  }));
  scored.sort((a, b) => b.cells - a.cells || b.units - a.units || (a.id < b.id ? -1 : 1));
  finishGame(game, scored[0].id, "turn_cap");
}

function endTurn(game) {
  game.turn += 1;
  // domination check at end of turn
  for (const p of game.players) {
    if (ownedCells(game, p.id).length >= WIN_CELLS) {
      finishGame(game, p.id, "domination");
      return;
    }
  }
  checkLastStanding(game);
  if (game.status !== "active") return;
  if (game.turn >= game.maxTurns) {
    decideByScore(game);
    return;
  }
  // advance to next non-eliminated player
  const order = game.players.map((p) => p.id);
  let i = order.indexOf(game.currentPlayer);
  let next = game.currentPlayer;
  for (let n = 0; n < order.length; n++) {
    i = (i + 1) % order.length;
    const pid = order[i];
    if (ownedCells(game, pid).length > 0) {
      next = pid;
      break;
    }
  }
  game.currentPlayer = next;
  game.attacksUsed = 0;
  game.pendingReinforcements = reinforcementCount(game, next);
}

export function applyPlayerMoves(game, playerId, moves) {
  if (!game || game.status !== "active") throw new GameError("game is not active", 400);
  if (game.currentPlayer !== playerId) throw new GameError("not your turn", 400);
  const player = game.players.find((p) => p.id === playerId);
  if (!player) throw new GameError("unknown player", 400);
  if (player.eliminated || ownedCells(game, playerId).length === 0) {
    throw new GameError("you are eliminated", 400);
  }
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new GameError("moves must be a non-empty array", 400);
  }
  for (let i = 0; i < moves.length; i++) {
    if (game.status !== "active") break; // game ended mid-turn (last standing)
    const m = moves[i];
    if (!m || typeof m.type !== "string") throw new GameError(`move ${i}: missing type`, 400);
    if (m.type === "deploy") {
      if (i !== 0) throw new GameError("deploy must be the first move of your turn", 400);
      if (game.pendingReinforcements <= 0) throw new GameError("no reinforcements to deploy", 400);
      applyDeploy(game, player, m);
    } else if (m.type === "attack") {
      if (game.pendingReinforcements > 0) {
        throw new GameError("deploy your reinforcements before attacking", 400);
      }
      if (game.attacksUsed >= MAX_ATTACKS) {
        throw new GameError(`max ${MAX_ATTACKS} attacks per turn`, 400);
      }
      applyAttack(game, player, m);
    } else if (m.type === "pass") {
      if (game.pendingReinforcements > 0) {
        throw new GameError("deploy your reinforcements before passing", 400);
      }
      addLog(
        game,
        "pass",
        player,
        game.attacksUsed === 0 ? "passed without attacking" : `ended turn after ${game.attacksUsed} attack(s)`
      );
      endTurn(game);
      return;
    } else {
      throw new GameError(`move ${i}: unknown type "${m.type}"`, 400);
    }
  }
  if (game.status === "active") endTurn(game); // moves exhausted -> implicit pass
}

// ----------------------------- built-in bot --------------------------------
// Deterministic heuristic used server-side for bot:true seats.
// Strategy (tuned 2026-10-16, see README "balance notes"):
//   DEPLOY: expansion first - top up border cells facing neutral wilds to 3
//   units (enough to capture with k=2), weakest wild first; then stack ALL
//   remaining reinforcements on the single border cell facing the weakest foe
//   (breakthrough / kill push). Never feeds a futile 1-for-1 trade while
//   wilds are still available.
//   ATTACK (up to 2): weakest winnable target, wilds before enemies. Commit:
//   minimum (target.units+1) vs wilds and in kill mode (a double-capture wins
//   immediately); sticky garrison vs enemies otherwise - the leader's income
//   bonus pays for two simultaneous garrisoned captures the trailer cannot
//   fully recapture, compounding the lead into a domination win.
//   Passes if nothing is winnable.
function cmpTarget(a, b) {
  if (a.neutral !== b.neutral) return a.neutral ? -1 : 1;
  if (a.tu !== b.tu) return a.tu - b.tu;
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return a.c < b.c ? -1 : 1;
}

const CAPTURE_POWER = 3; // units a cell needs to take a 1-unit wild with k=2
const GARRISON = 7;      // leftover left on enemy captures (costs trailer 8/cell to recapture)

export function computeBotMoves(game, playerId) {
  const pending = game.pendingReinforcements;
  if (!Number.isInteger(pending) || pending <= 0) {
    throw new GameError("bot has no reinforcements to deploy", 400);
  }
  const owned = ownedCells(game, playerId).sort();
  if (owned.length === 0) throw new GameError("bot has no cells", 400);
  const myCells = owned.length;
  const killMode = myCells >= WIN_CELLS - 2; // 20+: double-capture wins now

  // classify border cells
  const borders = [];
  for (const c of owned) {
    let wN = Infinity, wE = Infinity;
    for (const n of neighborsOf(c)) {
      const t = game.cells[n];
      if (t.owner === "neutral") wN = Math.min(wN, t.units);
      else if (t.owner !== playerId) wE = Math.min(wE, t.units);
    }
    if (wN === Infinity && wE === Infinity) continue;
    borders.push({ c, wN, wE, weakest: Math.min(wN, wE) });
  }
  if (borders.length === 0) {
    // nowhere to expand (shouldn't happen mid-game): stack on first cell, pass
    return [
      { type: "deploy", placements: [{ cell: owned[0], units: pending }] },
      { type: "pass" },
    ];
  }

  // deploy: expansion cells (facing wilds) topped up to capture power first,
  // then everything remaining stacks on the weakest-facing border cell.
  const simUnits = {};
  for (const c of owned) simUnits[c] = game.cells[c].units;
  const placements = [];
  let left = pending;
  const expanders = borders
    .filter((b) => b.wN < Infinity)
    .sort((a, b) => a.wN - b.wN || (a.c < b.c ? -1 : 1));
  for (const b of expanders) {
    if (left <= 0) break;
    const need = Math.max(0, CAPTURE_POWER - simUnits[b.c]);
    const give = Math.min(left, need);
    if (give > 0) {
      placements.push({ cell: b.c, units: give });
      simUnits[b.c] += give;
      left -= give;
    }
  }
  if (left > 0) {
    const stack = borders
      .slice()
      .sort((a, b) => a.weakest - b.weakest || (a.c < b.c ? -1 : 1))[0];
    placements.push({ cell: stack.c, units: left });
    simUnits[stack.c] += left;
  }

  const moves = [{ type: "deploy", placements }];

  // simulate on a copy so the two attacks chain correctly
  const units = {};
  const owner = {};
  for (const k of allCells()) {
    units[k] = game.cells[k].units;
    owner[k] = game.cells[k].owner;
  }
  for (const p of placements) units[p.cell] += p.units;
  const pool = owned.slice();
  const attacks = [];
  for (let a = 0; a < MAX_ATTACKS; a++) {
    let best = null;
    for (const c of pool) {
      if (owner[c] !== playerId || units[c] < 2) continue;
      for (const n of neighborsOf(c)) {
        if (owner[n] === playerId) continue;
        const t = units[n];
        const neutral = owner[n] === "neutral";
        // commit size: minimum vs wilds and in kill mode (need 2 captures to
        // win NOW); sticky garrison vs enemies otherwise. The leader's income
        // bonus pays for two simultaneous garrisoned captures the trailer
        // cannot fully recapture, compounding the lead.
        let need = t + 1;
        if (!neutral && !killMode) need = Math.min(units[c] - 1, t + GARRISON);
        if (need > units[c] - 1) continue; // must keep >= 1 behind
        if (need <= t) continue; // must actually win
        const cand = { c, n, need, neutral, tu: t };
        if (!best || cmpTarget(cand, best) < 0) best = cand;
      }
    }
    if (!best) break;
    attacks.push({ type: "attack", from: best.c, to: best.n, units: best.need });
    units[best.c] -= best.need;
    const oldT = units[best.n];
    owner[best.n] = playerId;
    units[best.n] = best.need - oldT;
    if (!pool.includes(best.n)) pool.push(best.n);
  }
  if (attacks.length === 0) moves.push({ type: "pass" });
  else moves.push(...attacks);
  return moves;
}

export function playBotTurn(game) {
  const pid = game.currentPlayer;
  let moves;
  try {
    moves = computeBotMoves(game, pid);
  } catch (e) {
    // defensive fallback: deploy everything to the first owned cell, pass
    const owned = ownedCells(game, pid).sort();
    moves = [
      { type: "deploy", placements: [{ cell: owned[0], units: game.pendingReinforcements }] },
      { type: "pass" },
    ];
  }
  applyPlayerMoves(game, pid, moves);
}

function isBotSeat(game, pid) {
  const p = game.players.find((x) => x.id === pid);
  return !!p && p.bot;
}

// Play consecutive bot seats until the next human seat or game end.
export function autoplayBots(game, cap = 1000) {
  let n = 0;
  while (game.status === "active" && isBotSeat(game, game.currentPlayer) && n < cap) {
    playBotTurn(game);
    n++;
  }
  return n;
}

// ----------------------------- public state --------------------------------
export function publicState(game) {
  return {
    code: game.code,
    status: game.status,
    numPlayers: game.numPlayers,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      bot: p.bot,
      home: p.home,
      eliminated: p.eliminated,
      cells: ownedCells(game, p.id).length,
      units: countUnits(game, p.id),
    })),
    currentPlayer: game.currentPlayer,
    turn: game.turn,
    maxTurns: game.maxTurns,
    pendingReinforcements: game.pendingReinforcements,
    attacksUsed: game.attacksUsed,
    cells: game.cells,
    winner: game.winner,
    winReason: game.winReason,
    log: game.log.slice(-30),
  };
}

// ----------------------------- WORKER / HTTP -------------------------------
const memStore = new Map(); // fallback when the TIDEWAR KV binding is missing

function deepCopy(o) {
  return JSON.parse(JSON.stringify(o));
}

async function loadGame(env, code) {
  if (env.TIDEWAR) {
    const v = await env.TIDEWAR.get("tidewar:" + code, "json");
    return v || null;
  }
  const v = memStore.get(code);
  return v ? deepCopy(v) : null;
}

async function saveGame(env, game) {
  if (env.TIDEWAR) {
    await env.TIDEWAR.put("tidewar:" + game.code, JSON.stringify(game));
  } else {
    memStore.set(game.code, deepCopy(game));
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    throw new GameError("invalid JSON body", 400);
  }
}

async function uniqueCode(env) {
  for (let i = 0; i < 20; i++) {
    const code = makeCode(6);
    if (!(await loadGame(env, code))) return code;
  }
  throw new GameError("could not allocate a lobby code, try again", 500);
}

async function handleLobby(request, env) {
  const body = await readJson(request);
  const numPlayers = body.players;
  const code = await uniqueCode(env);
  const game = createLobby(code, numPlayers); // validates 2-4
  await saveGame(env, game);
  return json({ code });
}

async function handleJoin(request, env) {
  const body = await readJson(request);
  const code = typeof body.code === "string" ? body.code.toUpperCase().trim() : "";
  const game = await loadGame(env, code);
  if (!game) return json({ error: "unknown lobby code" }, 404);
  const player = joinSeat(game, body.name, body.bot); // throws GameError on full/closed
  autoplayBots(game); // in case the game starts on a bot seat
  await saveGame(env, game);
  return json({ playerId: player.id, secret: player.secret, color: player.color, home: player.home });
}

async function handleState(request, env) {
  const code = new URL(request.url).searchParams.get("code") || "";
  const game = await loadGame(env, code.toUpperCase().trim());
  if (!game) return json({ error: "unknown lobby code" }, 404);
  return json(publicState(game));
}

async function handleLog(request, env) {
  const code = new URL(request.url).searchParams.get("code") || "";
  const game = await loadGame(env, code.toUpperCase().trim());
  if (!game) return json({ error: "unknown lobby code" }, 404);
  return json({ code: game.code, log: game.log });
}

async function handleMove(request, env) {
  const body = await readJson(request);
  const code = typeof body.code === "string" ? body.code.toUpperCase().trim() : "";
  const game = await loadGame(env, code);
  if (!game) return json({ error: "unknown lobby code" }, 404);
  const player = game.players.find((p) => p.id === body.playerId);
  if (!player) return json({ error: "unknown player" }, 400);
  if (player.secret !== body.secret) return json({ error: "bad secret" }, 403);
  applyPlayerMoves(game, body.playerId, body.moves); // throws GameError -> 400
  autoplayBots(game); // play consecutive bot seats' turns
  await saveGame(env, game);
  return json({ state: publicState(game) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      if ((path === "/" || path === "/index.html") && request.method === "GET") {
        return new Response(GAME_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/api/lobby" && request.method === "POST") return await handleLobby(request, env);
      if (path === "/api/join" && request.method === "POST") return await handleJoin(request, env);
      if (path === "/api/state" && request.method === "GET") return await handleState(request, env);
      if (path === "/api/log" && request.method === "GET") return await handleLog(request, env);
      if (path === "/api/move" && request.method === "POST") return await handleMove(request, env);
      if (path.startsWith("/api/")) return json({ error: "unknown endpoint" }, 404);
      return new Response("not found", { status: 404 });
    } catch (e) {
      const status = e instanceof GameError ? e.status : 500;
      return json({ error: e instanceof Error ? e.message : "internal error" }, status);
    }
  },
};

// ----------------------------- game UI (single page) -------------------------
const GAME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tidewar &mdash; hex-island conquest</title>
<style>
  :root { --bg:#0b1622; --panel:#101d2c; --line:#23405c; --txt:#e8f1f8; --dim:#8fa9c2; --acc:#4dabf7; --gold:#ffd43b; }
  * { box-sizing: border-box; }
  body { margin:0; background: radial-gradient(1200px 600px at 50% -10%, #123049 0%, var(--bg) 60%); color:var(--txt);
         font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; min-height:100vh; }
  header { text-align:center; padding:22px 12px 6px; }
  header h1 { margin:0; font-size:34px; letter-spacing:2px; }
  header p { margin:6px 0 0; color:var(--dim); font-size:14px; }
  #app { max-width:1080px; margin:0 auto; padding:14px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; }
  #lobbyPanel { max-width:520px; margin:18px auto; }
  #lobbyPanel h2 { margin-top:0; }
  .row { display:flex; gap:8px; margin:10px 0; flex-wrap:wrap; }
  input[type=text], select { background:#0b1622; color:var(--txt); border:1px solid var(--line); border-radius:8px;
    padding:9px 10px; font-size:15px; }
  input[type=text] { flex:1; min-width:140px; }
  .btn { background:#2563eb; color:#fff; border:0; border-radius:8px; padding:9px 16px; font-size:15px; cursor:pointer; }
  .btn:hover { background:#1d4ed8; }
  .btn:disabled { background:#33475e; color:#8fa9c2; cursor:default; }
  .btn.ghost { background:transparent; border:1px solid var(--line); color:var(--txt); }
  .btn.warn { background:#b45309; } .btn.warn:hover { background:#92400e; }
  #lobbyMsg { color:var(--gold); min-height:20px; font-size:14px; }
  #gamePanel { display:flex; gap:14px; align-items:flex-start; }
  #boardWrap { position:relative; flex:1; min-width:0; }
  #board { width:100%; height:auto; display:block; }
  #board polygon { stroke:#0b1622; stroke-width:2; cursor:pointer; transition:filter .12s; }
  #board polygon:hover { filter:brightness(1.3); }
  #board polygon.mine { stroke:#ffffff; stroke-width:2.5; }
  #board polygon.src { stroke:var(--gold); stroke-width:3.5; }
  #board polygon.tgt { stroke:#ff6b6b; stroke-width:3.5; cursor:crosshair; }
  #board polygon.sel { stroke:#ffffff; stroke-width:4; }
  #board text { pointer-events:none; user-select:none; font-weight:700; }
  aside { width:320px; flex-shrink:0; display:flex; flex-direction:column; gap:12px; }
  #turnInfo { font-size:16px; font-weight:600; }
  #turnInfo .you { color:var(--gold); }
  .ctl { font-size:14px; color:var(--dim); }
  .ctl b { color:var(--txt); }
  #logPanel ul { list-style:none; margin:8px 0 0; padding:0; max-height:230px; overflow-y:auto; font-size:12.5px; }
  #logPanel li { padding:4px 2px; border-bottom:1px solid #16283c; color:#c6d8e8; }
  #logPanel li .t { color:var(--dim); margin-right:6px; }
  #banner { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    background:rgba(5,10,18,.72); border-radius:12px; z-index:5; }
  #banner div { text-align:center; background:var(--panel); border:1px solid var(--gold); border-radius:14px; padding:26px 40px; }
  #banner h2 { margin:0 0 8px; font-size:30px; }
  #gameMsg { color:var(--gold); min-height:18px; font-size:13px; }
  table.scores { width:100%; border-collapse:collapse; font-size:14px; }
  table.scores td { padding:5px 4px; border-bottom:1px solid #16283c; }
  .dot { display:inline-block; width:12px; height:12px; border-radius:50%; margin-right:7px; vertical-align:baseline; }
  .elim { text-decoration:line-through; color:var(--dim); }
  input[type=range] { width:100%; }
  .hint { font-size:12.5px; color:var(--dim); margin-top:8px; line-height:1.5; }
  @media (max-width: 860px) { #gamePanel { flex-direction:column; } aside { width:100%; } }
</style>
</head>
<body>
<header>
  <h1>&#127754; TIDEWAR</h1>
  <p>hex-island conquest &middot; 2&ndash;4 players &middot; deploy, attack, conquer 60% of the isles</p>
</header>
<div id="app">
  <section id="lobbyPanel" class="panel">
    <h2>Set sail</h2>
    <div class="row">
      <input type="text" id="nameInput" maxlength="24" placeholder="Your captain name">
      <select id="playersSelect">
        <option value="2">2 players</option>
        <option value="3">3 players</option>
        <option value="4">4 players</option>
      </select>
    </div>
    <div class="row">
      <button class="btn" id="createBtn">Create lobby</button>
    </div>
    <div class="row">
      <input type="text" id="codeInput" maxlength="6" placeholder="Lobby code (e.g. KX7Q2M)" style="text-transform:uppercase">
      <button class="btn ghost" id="joinBtn">Join</button>
      <button class="btn ghost" id="watchBtn">Watch</button>
    </div>
    <div class="row" id="resumeRow" style="display:none">
      <button class="btn" id="resumeBtn"></button>
      <button class="btn ghost" id="leaveBtn">Forget session</button>
    </div>
    <div id="lobbyMsg"></div>
    <div class="hint">No login, no install. Create a lobby, share the 6-letter code, and play.
    Empty seats can be filled by bots via the API (<span style="font-family:monospace">bot:true</span> on join) &mdash;
    they play automatically.</div>
  </section>

  <section id="gamePanel" style="display:none">
    <div id="boardWrap" class="panel">
      <svg id="board" role="img" aria-label="game board"></svg>
      <div id="banner" style="display:none"><div><h2 id="bannerTitle"></h2><div id="bannerSub"></div></div></div>
    </div>
    <aside>
      <div class="panel">
        <div id="turnInfo">Connecting&hellip;</div>
        <div class="ctl" id="phaseInfo" style="margin-top:6px"></div>
        <div id="deployCtl" style="margin-top:10px; display:none">
          <div class="ctl" id="deployInfo"></div>
          <div class="row">
            <button class="btn" id="deployBtn">Deploy</button>
            <button class="btn ghost" id="deployClearBtn">Clear</button>
          </div>
        </div>
        <div id="attackCtl" style="margin-top:10px; display:none">
          <div class="ctl" id="attackInfo">Select one of your cells with 2+ units, then an adjacent target.</div>
          <div class="row" style="align-items:center">
            <span class="ctl">Commit:</span>
            <b id="kVal" style="min-width:34px; text-align:center"></b>
            <input type="range" id="kSlider" min="1" max="1" value="1" style="flex:1">
          </div>
          <div class="row">
            <button class="btn warn" id="attackBtn" disabled>Attack</button>
            <button class="btn ghost" id="endTurnBtn">End turn</button>
          </div>
        </div>
        <div id="gameMsg"></div>
      </div>
      <div class="panel">
        <b>Scores</b>
        <table class="scores" id="scores"></table>
      </div>
      <div class="panel" id="logPanel">
        <b>Match log</b>
        <ul id="logList"></ul>
      </div>
      <div class="panel">
        <div class="row">
          <button class="btn ghost" id="backBtn">Leave match</button>
        </div>
        <div class="hint" id="codeHint"></div>
      </div>
    </aside>
  </section>
</div>
<script>
"use strict";
var HEX_SIZE = 30;
var SQRT3 = Math.sqrt(3);
var R = 3;

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

var session = null;
try { session = JSON.parse(localStorage.getItem("tidewar") || "null"); } catch (e) { session = null; }
var G = null;
var placements = {};   // deploy phase: cell -> units (client-side)
var selFrom = null, selTo = null;
var pollTimer = null;

// ---- hex geometry (pointy-top, axial) ----
var CELLS = [];
(function () {
  for (var q = -R; q <= R; q++) {
    var lo = Math.max(-R, -q - R), hi = Math.min(R, -q + R);
    for (var r = lo; r <= hi; r++) CELLS.push({ k: q + "," + r, q: q, r: r });
  }
  CELLS.forEach(function (c) {
    c.x = HEX_SIZE * SQRT3 * (c.q + c.r / 2);
    c.y = HEX_SIZE * 1.5 * c.r;
  });
})();
var VB = (function () {
  var xs = CELLS.map(function (c) { return c.x; }), ys = CELLS.map(function (c) { return c.y; });
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  return (minX - 44) + " " + (minY - 44) + " " + (maxX - minX + 88) + " " + (maxY - minY + 88);
})();

function hexPoints(x, y) {
  var pts = [];
  for (var i = 0; i < 6; i++) {
    var a = Math.PI / 180 * (60 * i - 30);
    pts.push((x + HEX_SIZE * 0.94 * Math.cos(a)).toFixed(1) + "," + (y + HEX_SIZE * 0.94 * Math.sin(a)).toFixed(1));
  }
  return pts.join(" ");
}
function hexDist(a, b) {
  var pa = a.split(","), pb = b.split(",");
  var dq = +pa[0] - +pb[0], dr = +pa[1] - +pb[1];
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}
function neighbors(k) {
  var out = [];
  for (var i = 0; i < CELLS.length; i++) if (hexDist(k, CELLS[i].k) === 1) out.push(CELLS[i].k);
  return out;
}

// ---- api ----
function api(path, opts) {
  return fetch(path, opts).then(function (res) {
    return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
  });
}
function lobbyMsg(t) { el("lobbyMsg").textContent = t; }
function gameMsg(t) { el("gameMsg").textContent = t; }

// ---- lobby ----
function saveSession() { try { localStorage.setItem("tidewar", JSON.stringify(session)); } catch (e) {} }
function clearSession() { session = null; try { localStorage.removeItem("tidewar"); } catch (e) {} }

el("createBtn").addEventListener("click", function () {
  var name = el("nameInput").value.trim();
  var players = parseInt(el("playersSelect").value, 10);
  lobbyMsg("Creating lobby...");
  api("/api/lobby", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ players: players }) }).then(function (res) {
    if (!res.ok) { lobbyMsg("Error: " + (res.body.error || res.status)); return; }
    joinCode(res.body.code, name, false);
  }).catch(function (e) { lobbyMsg("Network error: " + e.message); });
});

el("joinBtn").addEventListener("click", function () {
  var code = el("codeInput").value.trim().toUpperCase();
  if (!code) { lobbyMsg("Enter a lobby code first."); return; }
  joinCode(code, el("nameInput").value.trim(), false);
});
el("watchBtn").addEventListener("click", function () {
  var code = el("codeInput").value.trim().toUpperCase();
  if (!code) { lobbyMsg("Enter a lobby code first."); return; }
  session = { code: code, watch: true };
  enterGame();
});
function joinCode(code, name, isBot) {
  lobbyMsg("Joining " + code + "...");
  api("/api/join", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code, name: name || undefined, bot: !!isBot }) }).then(function (res) {
    if (!res.ok) { lobbyMsg("Error: " + (res.body.error || res.status)); return; }
    session = { code: code, playerId: res.body.playerId, secret: res.body.secret,
                name: name || res.body.playerId, color: res.body.color };
    if (name) el("nameInput").value = name;
    saveSession();
    enterGame();
  }).catch(function (e) { lobbyMsg("Network error: " + e.message); });
}
el("leaveBtn").addEventListener("click", function () { clearSession(); renderResume(); lobbyMsg(""); });
el("backBtn").addEventListener("click", function () {
  stopPolling();
  el("gamePanel").style.display = "none";
  el("lobbyPanel").style.display = "block";
  renderResume();
});
function renderResume() {
  if (session && session.code && !session.watch) {
    el("resumeRow").style.display = "flex";
    el("resumeBtn").textContent = "Resume as " + (session.name || session.playerId) + " in " + session.code;
    el("resumeBtn").onclick = enterGame;
  } else {
    el("resumeRow").style.display = "none";
  }
}

// ---- game ----
function enterGame() {
  el("lobbyPanel").style.display = "none";
  el("gamePanel").style.display = "flex";
  el("codeHint").textContent = "Lobby code: " + session.code + " — share it with other players.";
  placements = {}; selFrom = null; selTo = null;
  refresh();
  stopPolling();
  pollTimer = setInterval(refresh, 2500);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function refresh() {
  api("/api/state?code=" + encodeURIComponent(session.code)).then(function (res) {
    if (!res.ok) { gameMsg("Error: " + (res.body.error || res.status)); return; }
    G = res.body;
    if (!(isMyTurn() && G.pendingReinforcements > 0)) placements = {};
    render();
  }).catch(function (e) { gameMsg("Network error: " + e.message); });
}

function isMyTurn() {
  return !!(G && session && !session.watch && G.status === "active" &&
             G.currentPlayer === session.playerId);
}
function myPlayer() {
  if (!G || !session) return null;
  for (var i = 0; i < G.players.length; i++) if (G.players[i].id === session.playerId) return G.players[i];
  return null;
}
function ownerColor(owner) {
  if (owner === "neutral") return "#24394f";
  for (var i = 0; i < G.players.length; i++) if (G.players[i].id === owner) return G.players[i].color;
  return "#24394f";
}
function playerById(id) {
  for (var i = 0; i < G.players.length; i++) if (G.players[i].id === id) return G.players[i];
  return null;
}
function isHomeCell(k) {
  for (var i = 0; i < G.players.length; i++) if (G.players[i].home === k) return true;
  return false;
}
function placedTotal() {
  var t = 0;
  for (var k in placements) t += placements[k];
  return t;
}

function render() {
  if (!G) return;
  renderBoard();
  renderScores();
  renderLog();
  renderTurn();
  var done = G.status === "done";
  el("banner").style.display = done ? "flex" : "none";
  if (done) {
    var w = playerById(G.winner);
    el("bannerTitle").textContent = w ? w.name + " wins!" : "Game over";
    var reason = { domination: "controlled 60% of the isles", last_standing: "last captain standing",
                   turn_cap: "most territory after 120 turns" }[G.winReason] || G.winReason || "";
    el("bannerSub").textContent = reason;
  }
}

function renderBoard() {
  var deployPhase = isMyTurn() && G.pendingReinforcements > 0;
  var attackPhase = isMyTurn() && G.pendingReinforcements === 0 && G.status === "active";
  var me = session && session.playerId;
  var validTargets = {};
  if (attackPhase && selFrom) {
    neighbors(selFrom).forEach(function (n) {
      if (G.cells[n].owner !== me) validTargets[n] = true;
    });
  }
  var svg = '<svg id="board" viewBox="' + VB + '" role="img" aria-label="game board">';
  CELLS.forEach(function (c) {
    var cell = G.cells[c.k];
    var cls = "";
    if (me && cell.owner === me) cls = "mine";
    if (attackPhase && selFrom === c.k) cls = "sel";
    else if (attackPhase && cell.owner === me && cell.units >= 2) cls = "src";
    else if (attackPhase && validTargets[c.k]) cls = "tgt";
    var fill = ownerColor(cell.owner);
    var txtColor = cell.owner === "neutral" ? "#cfe3f5" : "#0b1622";
    var shown = cell.units + (placements[c.k] || 0);
    svg += '<g data-cell="' + c.k + '"><polygon class="' + cls + '" points="' + hexPoints(c.x, c.y) +
           '" fill="' + fill + '"/>';
    if (isHomeCell(c.k)) {
      svg += '<text x="' + c.x.toFixed(1) + '" y="' + (c.y - 12).toFixed(1) + '" text-anchor="middle" font-size="11" fill="' + txtColor + '">&#9733;</text>';
    }
    svg += '<text x="' + c.x.toFixed(1) + '" y="' + (c.y + 7).toFixed(1) + '" text-anchor="middle" font-size="17" fill="' + txtColor + '">' + shown + "</text></g>";
  });
  svg += "</svg>";
  var wrap = el("boardWrap");
  var old = el("board");
  var tmp = document.createElement("div");
  tmp.innerHTML = svg;
  var fresh = tmp.firstChild;
  fresh.addEventListener("click", onBoardClick);
  wrap.replaceChild(fresh, old);
  void deployPhase;
}

function renderScores() {
  var rows = G.players.map(function (p) {
    var cls = p.eliminated ? ' class="elim"' : "";
    var you = session && p.id === session.playerId ? " (you)" : "";
    var bot = p.bot ? " &#129302;" : "";
    var turn = G.status === "active" && G.currentPlayer === p.id ? " &#9654;" : "";
    return "<tr" + cls + "><td><span class='dot' style='background:" + p.color + "'></span>" +
      esc(p.name) + you + bot + turn + "</td><td style='text-align:right'>" + p.cells +
      " cells</td><td style='text-align:right'>" + p.units + " units</td></tr>";
  });
  el("scores").innerHTML = rows.join("");
}

function renderLog() {
  var items = G.log.slice(-15).map(function (e) {
    return "<li><span class='t'>T" + e.turn + "</span><b>" + esc(e.player) + "</b> " + esc(e.detail) + "</li>";
  });
  el("logList").innerHTML = items.join("");
  var ul = el("logList");
  ul.scrollTop = ul.scrollHeight;
}

function renderTurn() {
  var ti = el("turnInfo"), pi = el("phaseInfo");
  el("deployCtl").style.display = "none";
  el("attackCtl").style.display = "none";
  if (G.status === "lobby") {
    ti.innerHTML = "Waiting for players (" + G.players.length + "/" + G.numPlayers + ")&hellip;";
    pi.textContent = "Share the code so others can join.";
    return;
  }
  if (G.status === "done") {
    var w = playerById(G.winner);
    ti.innerHTML = "Game over &mdash; <span class='you'>" + esc(w ? w.name : "?") + "</span> wins";
    pi.textContent = "";
    return;
  }
  var cp = playerById(G.currentPlayer);
  var cname = cp ? cp.name : "?";
  if (isMyTurn()) {
    ti.innerHTML = "<span class='you'>Your turn</span> &middot; turn " + G.turn + "/" + G.maxTurns;
    if (G.pendingReinforcements > 0) {
      var rem = G.pendingReinforcements - placedTotal();
      pi.innerHTML = "Deploy <b>" + G.pendingReinforcements + "</b> reinforcements on your cells (" + rem + " left).";
      el("deployCtl").style.display = "block";
      el("deployInfo").textContent = "Click your highlighted cells to place units. " + rem + " remaining.";
      el("deployBtn").disabled = rem !== 0;
    } else {
      pi.innerHTML = "Attack up to <b>" + (2 - G.attacksUsed) + "</b> more time(s), or end your turn.";
      el("attackCtl").style.display = "block";
      updateAttackCtl();
    }
  } else {
    ti.innerHTML = "Turn " + G.turn + "/" + G.maxTurns + " &mdash; waiting for <b>" + esc(cname) + "</b>" +
      (cp && cp.bot ? " &#129302;" : "");
    pi.textContent = G.pendingReinforcements > 0 ? "" : "";
  }
  gameMsg("");
}

function updateAttackCtl() {
  var info = "Select one of your cells with 2+ units, then an adjacent target.";
  if (selFrom) {
    var A = G.cells[selFrom];
    info = "From <b>" + selFrom + "</b> (" + A.units + " units). ";
    if (selTo) {
      var T = G.cells[selTo];
      var need = T.units + 1, maxK = A.units - 1;
      info += "Target <b>" + selTo + "</b> (" + T.units + " defending). " +
        (need <= maxK ? "Commit " + need + "+ to capture." : "You cannot beat it from here.");
      var slider = el("kSlider");
      slider.min = 1; slider.max = maxK;
      slider.value = need <= maxK ? need : maxK;
      el("kVal").textContent = slider.value;
      el("attackBtn").disabled = !(need <= maxK);
    } else {
      info += "Now click an adjacent enemy or wild cell.";
      el("attackBtn").disabled = true;
    }
  } else {
    el("attackBtn").disabled = true;
  }
  el("attackInfo").innerHTML = info;
}

function onBoardClick(e) {
  var g = e.target.closest ? e.target.closest("[data-cell]") : null;
  if (!g || !isMyTurn()) return;
  var k = g.getAttribute("data-cell");
  var cell = G.cells[k];
  var me = session.playerId;
  if (G.pendingReinforcements > 0) {
    // deploy phase
    if (cell.owner !== me) return;
    if (placedTotal() >= G.pendingReinforcements) return;
    placements[k] = (placements[k] || 0) + 1;
    selFrom = null; selTo = null;
    render();
    return;
  }
  // attack phase
  if (cell.owner === me) {
    if (cell.units >= 2) { selFrom = k; selTo = null; }
    else { gameMsg("That cell needs at least 2 units to attack from."); return; }
  } else if (selFrom && hexDist(selFrom, k) === 1) {
    selTo = k;
  } else if (selFrom) {
    gameMsg("Target must be adjacent to " + selFrom + ".");
    return;
  } else return;
  gameMsg("");
  render();
}

el("deployClearBtn").addEventListener("click", function () { placements = {}; render(); });
el("deployBtn").addEventListener("click", function () {
  var arr = [];
  for (var k in placements) arr.push({ cell: k, units: placements[k] });
  gameMsg("Deploying...");
  el("deployBtn").disabled = true;
  api("/api/move", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: session.code, playerId: session.playerId, secret: session.secret,
      moves: [{ type: "deploy", placements: arr }] }) }).then(function (res) {
    if (!res.ok) { gameMsg("Error: " + (res.body.error || res.status)); el("deployBtn").disabled = false; return; }
    G = res.body.state; placements = {}; selFrom = null; selTo = null;
    render();
  }).catch(function (e) { gameMsg("Network error: " + e.message); el("deployBtn").disabled = false; });
});

el("kSlider").addEventListener("input", function () { el("kVal").textContent = el("kSlider").value; });
el("attackBtn").addEventListener("click", function () {
  if (!selFrom || !selTo) return;
  var k = parseInt(el("kSlider").value, 10);
  gameMsg("Attacking...");
  el("attackBtn").disabled = true;
  api("/api/move", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: session.code, playerId: session.playerId, secret: session.secret,
      moves: [{ type: "attack", from: selFrom, to: selTo, units: k }] }) }).then(function (res) {
    if (!res.ok) { gameMsg("Error: " + (res.body.error || res.status)); render(); return; }
    G = res.body.state; selFrom = null; selTo = null;
    render();
  }).catch(function (e) { gameMsg("Network error: " + e.message); render(); });
});

el("endTurnBtn").addEventListener("click", function () {
  gameMsg("Ending turn...");
  api("/api/move", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: session.code, playerId: session.playerId, secret: session.secret,
      moves: [{ type: "pass" }] }) }).then(function (res) {
    if (!res.ok) { gameMsg("Error: " + (res.body.error || res.status)); return; }
    G = res.body.state; selFrom = null; selTo = null;
    render();
  }).catch(function (e) { gameMsg("Network error: " + e.message); });
});

document.addEventListener("DOMContentLoaded", function () {
  renderResume();
  if (session && session.code) {
    // auto-resume only the board in watch mode; players click Resume to play
    if (session.watch) enterGame();
  }
});
</script>
</body>
</html>`;
