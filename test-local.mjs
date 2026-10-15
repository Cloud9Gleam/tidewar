// Tidewar local test harness — Node 18+.
// 1. Unit-tests validation rules against the pure game logic imported from worker.js.
// 2. Simulates full 2-bot and 4-bot games to completion, checking invariants.
// 3. Exercises the full HTTP API (worker.fetch) with the in-memory KV fallback:
//    lobby -> join x2 -> move loop -> done, plus error-code checks.
// Run: node test-local.mjs
import worker, {
  GameError, allCells, createLobby, joinSeat, applyPlayerMoves,
  computeBotMoves, playBotTurn, autoplayBots, publicState,
  ownedCells, countUnits, neighborsOf, isValidCell,
} from "./worker.js";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; /* console.log("  ok:", label); */ }
  else { failed++; console.log("  FAIL:", label); }
}
function expectThrow(fn, label) {
  try { fn(); failed++; console.log("  FAIL (no throw):", label); }
  catch (e) { if (e instanceof GameError) passed++; else { failed++; console.log("  FAIL (wrong error):", label, e); } }
}

function checkInvariants(g, label) {
  const keys = allCells();
  ok(keys.length === 37, label + ": 37 cells");
  const seen = new Set(keys);
  ok(seen.size === 37, label + ": unique keys");
  for (const k of keys) {
    const c = g.cells[k];
    ok(c && Number.isInteger(c.units) && c.units >= 1, label + ": units>=1 int at " + k);
    ok(c.owner === "neutral" || g.players.some((p) => p.id === c.owner), label + ": valid owner at " + k);
  }
  const total = g.players.reduce((n, p) => n + ownedCells(g, p.id).length, 0)
    + ownedCells(g, "neutral").length;
  ok(total === 37, label + ": ownership sums to 37");
}

// ---------- 1. validation ----------
console.log("== validation ==");
{
  const g = createLobby("ABC123", 2);
  const a = joinSeat(g, "Alice", false);
  const b = joinSeat(g, "Rival", true);
  ok(g.status === "active", "game starts when full");
  ok(g.currentPlayer === a.id, "first player starts");
  ok(g.pendingReinforcements === 2, "2 reinforcements with 1 cell");
  ok(g.cells[a.home].owner === a.id && g.cells[a.home].units === 3, "home has 3 units");
  checkInvariants(g, "fresh game");

  expectThrow(() => applyPlayerMoves(g, b.id, [{ type: "pass" }]), "wrong turn rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "attack", from: a.home, to: "0,0", units: 1 }]),
    "attack before deploy rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "deploy", placements: [{ cell: a.home, units: 3 }] }]),
    "deploy wrong sum rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "deploy", placements: [{ cell: "9,9", units: 1 }] }]),
    "deploy bad coords rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "deploy", placements: [{ cell: b.home, units: 1 }] }]),
    "deploy to enemy cell rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "dance" }]), "unknown move type rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, []), "empty moves rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "pass" }]), "pass before deploy rejected");

  // valid deploy, then attack validation
  applyPlayerMoves(g, a.id, [{ type: "deploy", placements: [{ cell: a.home, units: 2 }] }]);
  ok(g.currentPlayer === b.id && g.turn === 1, "deploy ends turn, advances player");
  ok(g.pendingReinforcements === 2, "next player gets reinforcements");
  const nb = neighborsOf(a.home).find((n) => g.cells[n].owner !== a.id);
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "attack", from: a.home, to: nb, units: 99 }]),
    "overcommit rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "attack", from: a.home, to: a.home, units: 1 }]),
    "self-attack rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "attack", from: nb, to: a.home, units: 1 }]),
    "attack from enemy cell rejected");
  // find a non-adjacent cell
  const far = allCells().find((k) => !neighborsOf(a.home).includes(k) && k !== a.home);
  expectThrow(() => applyPlayerMoves(g, a.id, [{ type: "attack", from: a.home, to: far, units: 1 }]),
    "non-adjacent attack rejected");
  expectThrow(() => applyPlayerMoves(g, a.id, [
    { type: "attack", from: a.home, to: nb, units: 1 },
    { type: "deploy", placements: [{ cell: a.home, units: 1 }] },
  ]), "deploy-after-attack rejected");
}

// ---------- 2. full bot simulations ----------
function simGame(numPlayers, label) {
  const g = createLobby("SIM" + numPlayers, numPlayers);
  for (let i = 0; i < numPlayers; i++) joinSeat(g, "Bot" + (i + 1), true);
  let guard = 0;
  while (g.status === "active" && guard < 500) {
    playBotTurn(g);
    checkInvariants(g, label + " turn " + g.turn);
    guard++;
  }
  ok(g.status === "done", label + ": game finished");
  ok(g.turn <= 120, label + ": finished within 120 turns (took " + g.turn + ")");
  ok(!!g.winner, label + ": winner declared");
  ok(g.log.length > 0, label + ": non-empty log");
  console.log(`  ${label}: winner=${g.winner} reason=${g.winReason} turns=${g.turn} log=${g.log.length}`);
  return g;
}

console.log("== simulations ==");
const g2 = simGame(2, "2-bot");
const g4 = simGame(4, "4-bot");
ok(g2.turn >= 10, "2-bot game not trivially short (" + g2.turn + " turns)");

// domination sanity: a scripted rush should be able to hit 22 cells
{
  const g = createLobby("RUSH", 2);
  const a = joinSeat(g, "A", false), b = joinSeat(g, "B", false);
  // cheat: give A 21 extra cells directly, then A plays a turn -> domination
  const neutrals = ownedCells(g, "neutral").slice(0, 21);
  for (const k of neutrals) g.cells[k] = { owner: a.id, units: 2 };
  const pend = g.pendingReinforcements;
  applyPlayerMoves(g, a.id, [
    { type: "deploy", placements: [{ cell: a.home, units: pend }] },
    { type: "pass" },
  ]);
  ok(g.status === "done" && g.winner === a.id && g.winReason === "domination", "domination win triggers at 22 cells");
}

// ---------- 3. HTTP API end-to-end (in-memory KV fallback) ----------
console.log("== http api ==");
const ENV = {}; // no TIDEWAR binding -> in-memory Map
async function req(method, path, body) {
  const r = await worker.fetch(
    new Request("http://localhost" + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
    ENV
  );
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, data, headers: r.headers };
}

{
  // UI page
  const page = await worker.fetch(new Request("http://localhost/"), ENV);
  ok(page.status === 200 && (page.headers.get("content-type") || "").includes("text/html"), "GET / serves HTML");
  const html = await page.text();
  ok(html.includes("TIDEWAR") && html.includes("<svg"), "HTML contains game UI");

  // bad lobby
  let r = await req("POST", "/api/lobby", { players: 5 });
  ok(r.status === 400, "lobby rejects players=5");
  r = await req("POST", "/api/lobby", {});
  ok(r.status === 400, "lobby rejects missing players");

  r = await req("POST", "/api/lobby", { players: 2 });
  ok(r.status === 200 && /^[A-Z2-9]{6}$/.test(r.data.code), "lobby returns 6-char code: " + r.data.code);
  const code = r.data.code;

  r = await req("GET", "/api/state?code=" + code);
  ok(r.status === 200 && r.data.status === "lobby", "state shows lobby");
  ok(r.headers.get("access-control-allow-origin") === "*", "CORS header present");
  ok(r.data.players.length === 0, "no players yet");

  r = await req("POST", "/api/join", { code: "ZZZZZZ", name: "X" });
  ok(r.status === 404, "join unknown code -> 404");
  r = await req("POST", "/api/join", { code, name: "Human" });
  ok(r.status === 200 && r.data.playerId === "p1" && r.data.secret, "join p1 ok");
  const p1 = r.data;
  r = await req("POST", "/api/join", { code, name: "RivalBot", bot: true });
  ok(r.status === 200 && r.data.playerId === "p2", "join p2 (bot) ok");
  r = await req("POST", "/api/join", { code, name: "Extra" });
  ok(r.status === 400, "join full lobby -> 400");

  r = await req("GET", "/api/state?code=" + code);
  ok(r.data.status === "active", "game active after 2 joins");
  ok(r.data.players.every((p) => !("secret" in p)), "state never leaks secrets");

  // move auth
  let m = await req("POST", "/api/move", { code, playerId: "p1", secret: "wrong", moves: [{ type: "pass" }] });
  ok(m.status === 403, "bad secret -> 403");
  m = await req("POST", "/api/move", { code: "ZZZZZZ", playerId: "p1", secret: p1.secret, moves: [{ type: "pass" }] });
  ok(m.status === 404, "move unknown code -> 404");

  // play the whole game through HTTP: p1 driven externally with the same
  // heuristic (public state has everything it needs); p2 is a server bot.
  let turns = 0;
  for (;;) {
    const s = (await req("GET", "/api/state?code=" + code)).data;
    if (s.status === "done") break;
    if (s.status !== "active") throw new Error("unexpected status " + s.status);
    if (s.currentPlayer !== "p1") throw new Error("expected p1 turn, server should have autoplayed p2");
    const moves = computeBotMoves(s, "p1"); // works on public state shape
    const res = await req("POST", "/api/move", { code, playerId: "p1", secret: p1.secret, moves });
    ok(res.status === 200, "move accepted (turn " + s.turn + ")");
    if (res.status !== 200) { console.log("   move error:", JSON.stringify(res.data)); break; }
    if (++turns > 200) throw new Error("http game did not finish");
  }
  const fin = (await req("GET", "/api/state?code=" + code)).data;
  ok(fin.status === "done" && !!fin.winner, "http game finished with winner: " + fin.winner + " in " + fin.turn + " turns");
  const log = (await req("GET", "/api/log?code=" + code)).data;
  ok(Array.isArray(log.log) && log.log.length > 0, "full log retrievable (" + log.log.length + " events)");
  m = await req("POST", "/api/move", { code, playerId: "p1", secret: p1.secret, moves: [{ type: "pass" }] });
  ok(m.status === 400, "move after game over -> 400");

  // two server bots: game should autoplay to completion during the 2nd join
  r = await req("POST", "/api/lobby", { players: 2 });
  const code2 = r.data.code;
  await req("POST", "/api/join", { code: code2, name: "B1", bot: true });
  const j2 = await req("POST", "/api/join", { code: code2, name: "B2", bot: true });
  ok(j2.status === 200, "2nd bot join ok");
  const s2 = (await req("GET", "/api/state?code=" + code2)).data;
  ok(s2.status === "done" && !!s2.winner, "all-bot game autoplays to completion on join (" + s2.turn + " turns)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
