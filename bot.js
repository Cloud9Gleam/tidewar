#!/usr/bin/env node
// Tidewar sample bot — Node 18+, zero dependencies (uses global fetch).
//
// Usage: node bot.js <BASE_URL> [CODE] [NAME]
//
//   No CODE: creates a 2-player lobby, joins it as an API-driven seat
//            ("SampleBot"), and adds a second seat as a server-driven bot
//            (bot:true), then plays until the game ends.
//   CODE given: joins that lobby as an API-driven seat and plays.
//
// NOTE on seats: a seat joined with bot:true is played automatically by the
// server's built-in heuristic. Your own bot must join as a regular seat
// (no bot flag) so the server leaves its turns for you to play via the API.
// Strategy (documented in README.md): reinforce the border cell facing the
// weakest opposition, then make up to 2 attacks — only battles it can win
// (commit = target.units + 1), preferring neutral wilds, weakest first.

const BASE = (process.argv[2] || "").replace(/\/+$/, "");
const CODE_ARG = process.argv[3] ? process.argv[3].toUpperCase() : null;
const NAME = process.argv[4] || "SampleBot";

if (!BASE) {
  console.error("usage: node bot.js <BASE_URL> [CODE] [NAME]");
  process.exit(1);
}

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const keyOf = (q, r) => q + "," + r;

function neighbors(cellKeys, k) {
  const [q, r] = k.split(",").map(Number);
  const out = [];
  for (const [dq, dr] of DIRS) {
    const n = keyOf(q + dq, r + dr);
    if (cellKeys.has(n)) out.push(n);
  }
  return out;
}

function cmpTarget(a, b) {
  if (a.neutral !== b.neutral) return a.neutral ? -1 : 1;
  if (a.tu !== b.tu) return a.tu - b.tu;
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return a.c < b.c ? -1 : 1;
}

// Same heuristic the server uses for bot:true seats, computed client-side
// from the public state. Deploy: expansion cells (facing wilds) topped up to
// 3 units first, remainder stacked on the weakest-facing border cell. Attack:
// up to 2, weakest winnable target, wilds before enemies; minimum commit vs
// wilds and when at 20+ cells (double-capture wins immediately), otherwise a
// 7-unit garrison enemies can't cheaply recapture (the leader's +4 income
// bonus pays for two such captures per turn).
const CAPTURE_POWER = 3;
const GARRISON = 7;
const WIN_CELLS = 22;

function decideMoves(s, pid) {
  const pending = s.pendingReinforcements;
  const cells = s.cells;
  const cellKeys = new Set(Object.keys(cells));
  const owned = Object.keys(cells).filter((k) => cells[k].owner === pid).sort();
  if (owned.length === 0) throw new Error("bot has no cells");
  const killMode = owned.length >= WIN_CELLS - 2;

  const borders = [];
  for (const c of owned) {
    let wN = Infinity, wE = Infinity;
    for (const n of neighbors(cellKeys, c)) {
      const t = cells[n];
      if (t.owner === "neutral") wN = Math.min(wN, t.units);
      else if (t.owner !== pid) wE = Math.min(wE, t.units);
    }
    if (wN === Infinity && wE === Infinity) continue;
    borders.push({ c, wN, wE, weakest: Math.min(wN, wE) });
  }
  if (borders.length === 0) {
    return [
      { type: "deploy", placements: [{ cell: owned[0], units: pending }] },
      { type: "pass" },
    ];
  }

  const simUnits = {};
  for (const c of owned) simUnits[c] = cells[c].units;
  const placements = [];
  let left = pending;
  const expanders = borders
    .filter((b) => b.wN < Infinity)
    .sort((a, b) => a.wN - b.wN || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
  for (const b of expanders) {
    if (left <= 0) break;
    const give = Math.min(left, Math.max(0, CAPTURE_POWER - simUnits[b.c]));
    if (give > 0) {
      placements.push({ cell: b.c, units: give });
      simUnits[b.c] += give;
      left -= give;
    }
  }
  if (left > 0) {
    const stack = borders.slice().sort((a, b) => a.weakest - b.weakest || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0))[0];
    placements.push({ cell: stack.c, units: left });
    simUnits[stack.c] += left;
  }
  const moves = [{ type: "deploy", placements }];

  const units = {};
  const owner = {};
  for (const k of cellKeys) {
    units[k] = cells[k].units;
    owner[k] = cells[k].owner;
  }
  for (const p of placements) units[p.cell] += p.units;
  const pool = owned.slice();
  const attacks = [];
  for (let a = 0; a < 2; a++) {
    let best = null;
    for (const c of pool) {
      if (owner[c] !== pid || units[c] < 2) continue;
      for (const n of neighbors(cellKeys, c)) {
        if (owner[n] === pid) continue;
        const t = units[n];
        const neutral = owner[n] === "neutral";
        let need = t + 1;
        if (!neutral && !killMode) need = Math.min(units[c] - 1, t + GARRISON);
        if (need > units[c] - 1) continue;
        if (need <= t) continue;
        const cand = { c, n, need, neutral, tu: t };
        if (!best || cmpTarget(cand, best) < 0) best = cand;
      }
    }
    if (!best) break;
    attacks.push({ type: "attack", from: best.c, to: best.n, units: best.need });
    units[best.c] -= best.need;
    const oldT = units[best.n];
    owner[best.n] = pid;
    units[best.n] = best.need - oldT;
    if (!pool.includes(best.n)) pool.push(best.n);
  }
  moves.push(...(attacks.length ? attacks : [{ type: "pass" }]));
  return moves;
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

async function get(path) {
  const res = await fetch(BASE + path);
  const data = await res.json();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nameOf = (s, id) => {
  const p = s.players.find((x) => x.id === id);
  return p ? p.name : id;
};

function printStandings(s) {
  console.log("--- final standings ---");
  const rows = s.players
    .map((p) => ({ ...p }))
    .sort((a, b) => b.cells - a.cells || b.units - a.units);
  for (const p of rows) {
    console.log(`  ${p.name}${p.bot ? " [bot]" : ""}: ${p.cells} cells, ${p.units} units${p.eliminated ? " (eliminated)" : ""}`);
  }
}

async function main() {
  let code = CODE_ARG;
  let me;
  if (!code) {
    const lobby = await post("/api/lobby", { players: 2 });
    code = lobby.code;
    console.log(`created lobby ${code}`);
    me = await post("/api/join", { code, name: NAME });
    console.log(`joined as ${me.playerId} (${NAME}), home ${me.home}`);
    const rival = await post("/api/join", { code, name: "RivalBot", bot: true });
    console.log(`rival server-bot seat: ${rival.playerId} (plays automatically)`);
  } else {
    me = await post("/api/join", { code, name: NAME });
    console.log(`joined lobby ${code} as ${me.playerId} (${NAME}), home ${me.home}`);
  }

  let seenLog = 0;
  const printNewLog = async () => {
    const { log } = await get("/api/log?code=" + code);
    for (let i = seenLog; i < log.length; i++) {
      const e = log[i];
      console.log(`[T${e.turn}] ${e.player}: ${e.detail}`);
    }
    seenLog = log.length;
  };

  for (;;) {
    const s = await get("/api/state?code=" + code);
    if (s.status === "done") {
      await printNewLog();
      console.log(`\nGAME OVER — winner: ${nameOf(s, s.winner)} (${s.winReason}), ${s.turn} turns`);
      printStandings(s);
      return;
    }
    if (s.status !== "active") {
      await sleep(1500);
      continue;
    }
    if (s.currentPlayer === me.playerId) {
      const moves = decideMoves(s, me.playerId);
      const short = moves
        .map((m) =>
          m.type === "deploy"
            ? `deploy ${m.placements.map((p) => `${p.cell}+${p.units}`).join(",")}`
            : m.type === "attack"
              ? `attack ${m.from}->${m.to} x${m.units}`
              : "pass"
        )
        .join(" | ");
      console.log(`-- my turn (T${s.turn}, +${s.pendingReinforcements}): ${short}`);
      const { state } = await post("/api/move", {
        code,
        playerId: me.playerId,
        secret: me.secret,
        moves,
      });
      await printNewLog();
      if (state.status === "done") {
        console.log(`\nGAME OVER — winner: ${nameOf(state, state.winner)} (${state.winReason}), ${state.turn} turns`);
        printStandings(state);
        return;
      }
    } else {
      await sleep(1000);
    }
  }
}

main().catch((e) => {
  console.error("bot error:", e.message);
  process.exit(1);
});
