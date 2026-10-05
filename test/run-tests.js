// Tests de bout en bout avec une fausse API Obside (aucun appel réseau réel).
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const OBSIDE_TOKEN = "test-obside-secret-123";
const ACCESS = "test-access-token-456";
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const inst = (sym, base) => ({ symbol: sym, base_symbol: base, quote_symbol: "USDT", canonical_asset_id: `asset-${base}`, exchange_pair_id: `pair-${base}`, venue: "binance", venue_symbol: sym.replace("/", "") });

const SOURCES = [
  { id: "src_mistral", name: "Mistral Medium News", domain: "trading", mode: "paper" },
  { id: "src_kimi", name: "Kimi K2T News", domain: "trading", mode: "paper" },
  { id: "src_other", name: "GPT Something", domain: "trading", mode: "paper" },
];
const EVENTS = {
  src_mistral: [
    { id: "e1", schema_version: "1", source_id: "src_mistral", type: "trade.opened", occurred_at: iso(3 * 864e5), published_at: iso(3 * 864e5), data: { position_side: "long", action: "open", instrument: inst("BTC/USDT", "BTC"), quantity: "0.1", reference_price: "60000", simulation: "paper", trade_id: "t1" } },
    { id: "e2", schema_version: "1", source_id: "src_mistral", type: "trade.opened", occurred_at: iso(2 * 36e5), published_at: iso(2 * 36e5), data: { position_side: "short", action: "open", instrument: inst("ETH/USDT", "ETH"), quantity: "1", reference_price: "3000", simulation: "paper", trade_id: "t2" } },
    { id: "e3", schema_version: "1", source_id: "src_mistral", type: "order.filled", occurred_at: iso(1 * 36e5), published_at: iso(1 * 36e5), data: { side: "buy", instrument: inst("SOL/USDT", "SOL"), quantity: "5", reference_price: "150", simulation: "paper", order_id: "o3" } },
  ],
  src_kimi: [
    { id: "k1", schema_version: "1", source_id: "src_kimi", type: "trade.opened", occurred_at: iso(5 * 36e5), published_at: iso(5 * 36e5), data: { position_side: "long", action: "open", instrument: inst("BTC/USDT", "BTC"), simulation: "paper", trade_id: "kt1" } },
  ],
};
const STATE = {
  src_mistral: { open_trades: [{ trade_id: "t1", position_side: "long", instrument: inst("BTC/USDT", "BTC") }, { trade_id: "t2", position_side: "short", instrument: inst("ETH/USDT", "ETH") }, { trade_id: "t9", position_side: "long", instrument: inst("XRP/USDT", "XRP") }], pending_orders: [], open_bets: [], holdings: [] },
  src_kimi: { open_trades: [{ trade_id: "kt1", position_side: "long", instrument: inst("BTC/USDT", "BTC") }, { trade_id: "kt2", position_side: "long", instrument: inst("ETH/USDT", "ETH") }, { trade_id: "kt3", position_side: "short", instrument: inst("DOGE/USDT", "DOGE") }], pending_orders: [], open_bets: [], holdings: [] },
};

let lastAuthSeen = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (u.pathname === "/v1/signal-sources") return send(200, { success: true, result: SOURCES });
  lastAuthSeen.push(req.headers.authorization);
  if (req.headers.authorization !== `Bearer ${OBSIDE_TOKEN}`) return send(401, { success: false, error: { message: "unauthorized" } });
  if (u.pathname === "/v1/signals") {
    const sid = u.searchParams.get("source_id");
    const cursor = u.searchParams.get("cursor");
    const limit = Number(u.searchParams.get("limit"));
    const all = EVENTS[sid] || [];
    if (cursor === "now") return send(200, { success: true, result: { events: [], next_cursor: `c:${sid}:${all.length}`, has_more: false } });
    const start = cursor === "beginning" ? 0 : Number(cursor.split(":")[2]);
    const page = all.slice(start, start + limit);
    const end = start + page.length;
    return send(200, { success: true, result: { events: page, next_cursor: `c:${sid}:${end}`, has_more: end < all.length } });
  }
  const m = u.pathname.match(/^\/v1\/signal-sources\/([^/]+)\/state$/);
  if (m) return send(200, { success: true, result: { source_id: m[1], as_of: new Date(now).toISOString(), cursor: "c", state: STATE[m[1]] } });
  send(404, { success: false, error: { message: "not found" } });
});

await new Promise((r) => mock.listen(0, r));
process.env.OBSIDE_API_BASE = `http://127.0.0.1:${mock.address().port}/v1`;
process.env.OBSIDE_SIGNALS_TOKEN = OBSIDE_TOKEN;
process.env.MCP_ACCESS_TOKEN = ACCESS;

const { default: handler } = await import("../lib/handler.js");
const app = http.createServer((req, res) => handler(req, res));
await new Promise((r) => app.listen(0, r));
const base = `http://127.0.0.1:${app.address().port}`;

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("✓", name); };
const parse = (r) => JSON.parse(r.content[0].text);
const noSecret = (r) => assert.ok(!JSON.stringify(r).includes(OBSIDE_TOKEN), "la clé Obside ne doit jamais sortir");

await test("santé publique sans secret", async () => {
  const r = await fetch(`${base}/health`).then((x) => x.json());
  assert.equal(r.ok, true);
  assert.deepEqual(r.configured, { obside_token: true, access_token: true });
  assert.ok(!JSON.stringify(r).includes(OBSIDE_TOKEN));
});

await test("refus sans jeton / mauvais jeton", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: h, body })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { ...h, Authorization: "Bearer nope" }, body })).status, 401);
});

const client = new Client({ name: "test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${ACCESS}` } } }));

await test("liste des outils", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_consensus", "get_recent_signals", "get_signals", "get_source_state", "list_sources"]);
});

await test("list_sources résout Mistral et Kimi", async () => {
  const r = await client.callTool({ name: "list_sources", arguments: {} }); noSecret(r);
  const d = parse(r);
  assert.equal(d.tracked.mistral.id, "src_mistral");
  assert.equal(d.tracked.kimi.id, "src_kimi");
  assert.equal(d.count, 3);
});

await test("get_signals pagination", async () => {
  const p1 = parse(await client.callTool({ name: "get_signals", arguments: { source: "mistral", limit: 2 } }));
  assert.equal(p1.count, 2); assert.equal(p1.has_more, true);
  assert.equal(p1.events[0].symbol, "BTC/USDT"); assert.equal(p1.events[0].position_side, "long");
  assert.equal(p1.events[0].raw, undefined);
  const p2 = parse(await client.callTool({ name: "get_signals", arguments: { source: "mistral", cursor: p1.next_cursor, limit: 2 } }));
  assert.equal(p2.count, 1); assert.equal(p2.has_more, false); assert.equal(p2.events[0].side, "buy");
});

await test("get_signals cursor=now", async () => {
  const d = parse(await client.callTool({ name: "get_signals", arguments: { source: "kimi", cursor: "now" } }));
  assert.equal(d.count, 0); assert.ok(d.next_cursor);
});

await test("get_recent_signals 24h sur les deux sources", async () => {
  const d = parse(await client.callTool({ name: "get_recent_signals", arguments: { hours: 24 } }));
  assert.equal(d.sources.mistral.count, 2); // e1 a 3 jours -> exclu
  assert.deepEqual(d.sources.mistral.events.map((e) => e.id), ["e3", "e2"]); // plus récent d'abord
  assert.equal(d.sources.kimi.count, 1);
});

await test("filtre par type", async () => {
  const d = parse(await client.callTool({ name: "get_recent_signals", arguments: { source: "mistral", hours: 720, types: ["order.filled"] } }));
  assert.deepEqual(d.sources.mistral.events.map((e) => e.id), ["e3"]);
});

await test("get_source_state", async () => {
  const d = parse(await client.callTool({ name: "get_source_state", arguments: { source: "kimi" } }));
  assert.equal(d.state.open_trades.length, 3);
});

await test("get_consensus", async () => {
  const d = parse(await client.callTool({ name: "get_consensus", arguments: {} }));
  assert.deepEqual(d.consensus.map((c) => c.asset), ["BTC/USDT"]);
  assert.deepEqual(d.conflicts.map((c) => c.asset), ["ETH/USDT"]);
  assert.deepEqual(d.only_mistral.map((c) => c.asset), ["XRP/USDT"]);
  assert.deepEqual(d.only_kimi.map((c) => c.asset), ["DOGE/USDT"]);
});

await test("source inconnue -> erreur propre", async () => {
  const r = await client.callTool({ name: "get_signals", arguments: { source: "inexistante" } });
  assert.equal(r.isError, true); noSecret(r);
});

await test("clé Obside invalide -> message clair sans fuite", async () => {
  process.env.OBSIDE_SIGNALS_TOKEN = "mauvaise";
  const r = await client.callTool({ name: "get_signals", arguments: { source: "mistral" } });
  process.env.OBSIDE_SIGNALS_TOKEN = OBSIDE_TOKEN;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /invalide ou révoquée/);
});

await test("la clé Obside n'est envoyée qu'à Obside, en Bearer", async () => {
  assert.ok(lastAuthSeen.every((h) => h?.startsWith("Bearer ")));
});

await client.close();
app.close(); mock.close();
console.log(`\n${passed} tests OK`);
