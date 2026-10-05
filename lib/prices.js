// Historique de prix public (sans clé) pour reconstituer prix de sortie, MAE et MFE.
// - Crypto (paires USDT/USDC) : Binance data API (bougies 15 min)
// - Le reste (indices, or, forex, actions) + secours crypto : Yahoo Finance (bougies 5 min, 60 jours max)

const YAHOO = (process.env.PRICE_YAHOO_BASE || "https://query1.finance.yahoo.com").replace(/\/+$/, "");
const BINANCE = (process.env.PRICE_BINANCE_BASE || "https://data-api.binance.vision").replace(/\/+$/, "");

const FIAT = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "MXN", "ZAR", "TRY", "SGD", "HKD", "CNH", "PLN"]);
const STABLE = new Set(["USDT", "USDC", "BUSD", "FDUSD"]);

// Indices / matières premières : symbole Obside normalisé -> symbole Yahoo
const SPECIAL = {
  US500: "^GSPC", SPX500: "^GSPC", SPX: "^GSPC", SP500: "^GSPC",
  US100: "^NDX", NAS100: "^NDX", USTEC: "^NDX", NDX: "^NDX",
  US30: "^DJI", DJ30: "^DJI", WALLSTREET: "^DJI",
  US2000: "^RUT", RUSSELL2000: "^RUT",
  GER40: "^GDAXI", DE40: "^GDAXI", GER30: "^GDAXI",
  FRA40: "^FCHI", UK100: "^FTSE", JP225: "^N225", EU50: "^STOXX50E", HK50: "^HSI",
  GOLD: "GC=F", XAUUSD: "GC=F", SILVER: "SI=F", XAGUSD: "SI=F",
  OIL: "CL=F", WTI: "CL=F", USOIL: "CL=F", CRUDE: "CL=F", BRENT: "BZ=F", UKOIL: "BZ=F",
  NATGAS: "NG=F", NGAS: "NG=F", COPPER: "HG=F", VIX: "^VIX",
};

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function userMap() {
  try { return JSON.parse(process.env.PRICE_SYMBOL_MAP || "{}"); } catch { return {}; }
}

// instrument Obside -> { binance?: "BTCUSDT", yahoo: "BTC-USD" }
export function priceSymbols(inst = {}) {
  const base = norm(inst.base_symbol);
  const quote = norm(inst.quote_symbol);
  const venueSym = norm(inst.venue_symbol);
  const sym = norm(inst.symbol);
  const custom = userMap();
  for (const k of [inst.venue_symbol, inst.symbol, venueSym, sym]) {
    if (k && custom[k]) return { yahoo: custom[k] };
  }
  if (SPECIAL[venueSym]) return { yahoo: SPECIAL[venueSym] };
  if (SPECIAL[sym]) return { yahoo: SPECIAL[sym] };
  if (SPECIAL[base]) return { yahoo: SPECIAL[base] };

  if (base && quote && FIAT.has(base) && FIAT.has(quote)) return { yahoo: `${base}${quote}=X` };
  if (base && (STABLE.has(quote) || (quote === "USD" && !FIAT.has(base) && (inst.venue || "").toLowerCase().match(/binance|bybit|okx|coinbase|kraken|hyperliquid|crypto/)))) {
    return { binance: `${base}${STABLE.has(quote) ? quote : "USDT"}`, yahoo: `${base}-USD` };
  }
  // Action / ETF : le ticker est en général le symbole de place
  const ticker = String(inst.venue_symbol || inst.base_symbol || inst.symbol || "").toUpperCase().replace(/\s+/g, "");
  return ticker ? { yahoo: ticker } : {};
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (obside-signals-mcp)", Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Bougies { t (ms), o, h, l, c } triées
async function yahooCandles(symbol, fromMs, toMs) {
  const p1 = Math.floor(Math.max(fromMs, Date.now() - 59 * 864e5) / 1000);
  const p2 = Math.floor(toMs / 1000);
  const url = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&period1=${p1}&period2=${p2}&includePrePost=true`;
  const j = await getJson(url);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(j?.chart?.error?.description || "aucune donnée");
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  (r.timestamp || []).forEach((ts, i) => {
    const c = q.close?.[i], h = q.high?.[i], l = q.low?.[i], o = q.open?.[i];
    if ([c, h, l].every((v) => typeof v === "number")) out.push({ t: ts * 1000, o: o ?? c, h, l, c });
  });
  return out;
}

async function binanceCandles(symbol, fromMs, toMs) {
  const out = [];
  let start = fromMs;
  for (let i = 0; i < 12 && start < toMs; i++) {
    const url = `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&startTime=${start}&endTime=${toMs}&limit=1000`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const k of rows) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    start = rows[rows.length - 1][0] + 1;
    if (rows.length < 1000) break;
  }
  if (!out.length) throw new Error("aucune donnée");
  return out;
}

// Cache par exécution : une seule requête par actif
export function makePriceStore() {
  const cache = new Map();
  return async function candlesFor(inst, fromMs, toMs) {
    const syms = priceSymbols(inst);
    const key = `${syms.binance || ""}|${syms.yahoo || ""}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const errors = [];
        if (syms.binance) {
          try { return { source: `binance:${syms.binance}`, candles: await binanceCandles(syms.binance, fromMs, toMs) }; }
          catch (e) { errors.push(`binance ${syms.binance}: ${e.message}`); }
        }
        if (syms.yahoo) {
          try { return { source: `yahoo:${syms.yahoo}`, candles: await yahooCandles(syms.yahoo, fromMs, toMs) }; }
          catch (e) { errors.push(`yahoo ${syms.yahoo}: ${e.message}`); }
        }
        return { source: null, candles: [], error: errors.join(" ; ") || "symbole non reconnu" };
      })());
    }
    return cache.get(key);
  };
}

// Prix de clôture de la bougie contenant (ou précédant) l'instant t
export function priceAt(candles, t) {
  let best = null;
  for (const k of candles) { if (k.t <= t) best = k; else break; }
  return best ? best.c : null;
}

// Plus haut / plus bas entre l'entrée et la sortie (bougies démarrant après l'entrée,
// pour ne pas compter les mouvements d'avant l'ouverture). Les prix d'entrée et de
// sortie sont inclus.
export function excursion(candles, fromT, toT, entry, exit) {
  let hi = Math.max(entry, exit ?? entry), lo = Math.min(entry, exit ?? entry);
  let n = 0;
  for (const k of candles) {
    if (k.t < fromT) continue;
    if (k.t >= toT) break;
    hi = Math.max(hi, k.h); lo = Math.min(lo, k.l); n++;
  }
  return { high: hi, low: lo, candles: n };
}
