// Tests du profil de sortie (SL/TP implicites) avec de fausses API de prix.
import http from "node:http";
import assert from "node:assert/strict";

const M15 = 15 * 60e3;
const now = Math.floor(Date.now() / M15) * M15;
const T = (h) => now - h * 36e5; // il y a h heures, aligné sur 15 min
const iso = (ms) => new Date(ms).toISOString();

// Trades BTC (long) : [ouverture, clôture, plus bas, plus haut, prix de sortie]
const BTC = [
  { id: "b1", open: T(200), close: T(190), low: 97, high: 106, exit: 105 }, // +5 %, MAE -3 %
  { id: "b2", open: T(150), close: T(140), low: 98, high: 104, exit: 103 }, // +3 %, MAE -2 %
  { id: "b3", open: T(100), close: T(90), low: 94, high: 101, exit: 95 },   // -5 %
];
function btcCandle(t) {
  for (const w of BTC) {
    if (t === w.open) return [t, "100", String(w.high), String(w.low), "100"];
    if (t === w.close) return [t, String(w.exit), String(w.exit), String(w.exit), String(w.exit)];
  }
  return [t, "100", "100", "100", "100"];
}

// US500 (short) : entrée 5000, plus haut 5050 (MAE -1 %), sortie 4900 (+2 %)
const SPX = { id: "s1", open: T(60), close: T(50) };
function spxPrice(t) {
  if (t === SPX.open) return { o: 5000, h: 5050, l: 4990, c: 5000 };
  if (t === SPX.close) return { o: 4900, h: 4900, l: 4900, c: 4900 };
  return { o: 5000, h: 5000, l: 5000, c: 5000 };
}

const hits = [];
const prices = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  hits.push(u.pathname + "?" + (u.searchParams.get("symbol") || ""));
  res.setHeader("Content-Type", "application/json");
  if (u.pathname === "/api/v3/klines") {
    assert.equal(u.searchParams.get("symbol"), "BTCUSDT");
    const start = Math.ceil(+u.searchParams.get("startTime") / M15) * M15;
    const end = +u.searchParams.get("endTime");
    const rows = [];
    for (let t = start; t <= end && rows.length < 1000; t += M15) rows.push(btcCandle(t));
    return res.end(JSON.stringify(rows));
  }
  if (u.pathname.startsWith("/v8/finance/chart/")) {
    if (decodeURIComponent(u.pathname.split("/").pop()) !== "^GSPC") {
      return res.end(JSON.stringify({ chart: { result: null, error: { description: "No data found" } } }));
    }
    const p1 = +u.searchParams.get("period1") * 1000, p2 = +u.searchParams.get("period2") * 1000;
    const ts = [], o = [], h = [], l = [], c = [];
    for (let t = Math.ceil(p1 / M15) * M15; t <= p2; t += M15) {
      const k = spxPrice(t); ts.push(t / 1000); o.push(k.o); h.push(k.h); l.push(k.l); c.push(k.c);
    }
    return res.end(JSON.stringify({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c }] } }], error: null } }));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => prices.listen(0, r));
process.env.PRICE_BINANCE_BASE = `http://127.0.0.1:${prices.address().port}`;
process.env.PRICE_YAHOO_BASE = `http://127.0.0.1:${prices.address().port}`;

const { buildExitProfile } = await import("../lib/exits.js");
const { priceSymbols } = await import("../lib/prices.js");

const btcInst = { symbol: "BTC/USDT", base_symbol: "BTC", quote_symbol: "USDT", venue_symbol: "BTCUSDT", venue: "binance", canonical_asset_id: "asset-BTC" };
const spxInst = { symbol: "US 500", base_symbol: "US500", quote_symbol: "USD", venue_symbol: "US500", venue: "cfd", canonical_asset_id: "asset-SPX" };

const events = [];
for (const w of BTC) {
  events.push({ id: `${w.id}o`, type: "trade.opened", occurred_at: iso(w.open), data: { trade_id: w.id, position_side: "long", action: "open", reference_price: "100", instrument: btcInst } });
  events.push({ id: `${w.id}c`, type: "trade.closed", occurred_at: iso(w.close), data: { trade_id: w.id, position_side: "long", action: "close", reference_price: null, instrument: btcInst } });
}
events.push({ id: "s1o", type: "trade.opened", occurred_at: iso(SPX.open), data: { trade_id: "s1", position_side: "short", action: "open", reference_price: "5000", instrument: spxInst } });
events.push({ id: "s1c", type: "trade.closed", occurred_at: iso(SPX.close), data: { trade_id: "s1", position_side: "short", action: "close", reference_price: null, instrument: spxInst } });
// Trade encore ouvert
events.push({ id: "b4o", type: "trade.opened", occurred_at: iso(T(5)), data: { trade_id: "b4", position_side: "long", action: "open", reference_price: "100", instrument: btcInst } });

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("✓", name); };

await test("correspondance des symboles de prix", async () => {
  assert.deepEqual(priceSymbols(btcInst), { binance: "BTCUSDT", yahoo: "BTC-USD" });
  assert.deepEqual(priceSymbols(spxInst), { yahoo: "^GSPC" });
  assert.deepEqual(priceSymbols({ symbol: "Gold", venue_symbol: "GOLD", base_symbol: "XAU", quote_symbol: "USD" }), { yahoo: "GC=F" });
  assert.deepEqual(priceSymbols({ symbol: "EUR/USD", venue_symbol: "EURUSD", base_symbol: "EUR", quote_symbol: "USD" }), { yahoo: "EURUSD=X" });
  assert.deepEqual(priceSymbols({ symbol: "NVIDIA Corp", venue_symbol: "NVDA", base_symbol: "NVDA", quote_symbol: "USD", venue: "nasdaq" }), { yahoo: "NVDA" });
});

const p = await buildExitProfile(events, { openTrades: [{ trade_id: "b4", position_side: "long", instrument: btcInst, reference_price: "100" }], now });

await test("reconstitution des trades fermés avec prix de sortie historique", async () => {
  assert.equal(p.trades.length, 4);
  const b1 = p.trades.find((t) => t.trade_id === "b1");
  assert.equal(b1.exit, 105); assert.equal(b1.exit_price_source, "historique");
  assert.equal(b1.return_pct, 5); assert.equal(b1.mae_pct, -3); assert.equal(b1.mfe_pct, 6);
  const s1 = p.trades.find((t) => t.trade_id === "s1");
  assert.equal(s1.return_pct, 2); assert.equal(s1.mae_pct, -1); // short : la hausse est l'écart défavorable
  assert.equal(p.skipped.length, 0);
});

await test("statistiques et SL/TP implicites", async () => {
  assert.equal(p.overall.trades, 4);
  assert.equal(p.overall.win_rate_pct, 75);
  assert.equal(p.overall.median_win_pct, 3);       // gains 2, 3, 5
  assert.equal(p.overall.median_loss_pct, -5);
  assert.equal(p.overall.implied_take_profit_pct, 3);
  assert.equal(p.overall.implied_stop_loss_pct, 5); // max(p90 MAE gagnants = 2.8, perte médiane = 5)
  assert.match(p.overall.reliability, /insuffisante/);
  assert.equal(p.by_asset["BTC/USDT"].trades, 3);
});

await test("niveaux appliqués à la position ouverte", async () => {
  const o = p.open_trades_levels[0];
  assert.equal(o.trade_id, "b4"); assert.equal(o.entry, 100);
  assert.equal(o.stop_loss_price, 95); assert.equal(o.take_profit_price, 103);
  assert.match(o.based_on, /global/);
});

await test("une seule requête de prix par actif", async () => {
  assert.equal(hits.filter((h) => h.startsWith("/api/v3/klines")).length, 1);
  assert.equal(hits.filter((h) => h.startsWith("/v8/")).length, 1); // US500 uniquement (BTC servi par Binance)
});

await test("actif sans données de prix -> ignoré proprement", async () => {
  const bad = { symbol: "ZZZ", venue_symbol: "ZZZ", base_symbol: "ZZZ", quote_symbol: "USD", venue: "nasdaq" };
  const r = await buildExitProfile([
    { id: "z1", type: "trade.opened", occurred_at: iso(T(10)), data: { trade_id: "z", position_side: "long", reference_price: "10", instrument: bad } },
    { id: "z2", type: "trade.closed", occurred_at: iso(T(9)), data: { trade_id: "z", position_side: "long", reference_price: null, instrument: bad } },
  ], { now });
  assert.equal(r.trades.length, 0); assert.equal(r.skipped.length, 1);
});

prices.close();
console.log(`\n${passed} tests profil de sortie OK`);
