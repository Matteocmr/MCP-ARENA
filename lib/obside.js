// Client minimal pour l'API Obside Signals (lecture seule).
// La clé OBSIDE_SIGNALS_TOKEN reste côté serveur : elle n'est jamais renvoyée
// dans une réponse d'outil ni écrite dans les logs.

const API_BASE = (process.env.OBSIDE_API_BASE || "https://api.obside.com/v1").replace(/\/+$/, "");

// Sources suivies par défaut. Chaque entrée = mots qui doivent TOUS apparaître
// dans le nom de la source du catalogue (insensible à la casse).
// On peut forcer les identifiants exacts via MISTRAL_SOURCE_ID / KIMI_SOURCE_ID.
export const TRACKED = {
  mistral: { label: "Mistral Medium News", words: ["mistral", "medium", "news"], envId: "MISTRAL_SOURCE_ID" },
  kimi: { label: "Kimi K2T News", words: ["kimi", "k2t", "news"], envId: "KIMI_SOURCE_ID" },
};

export class ObsideError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function token() {
  const t = process.env.OBSIDE_SIGNALS_TOKEN;
  if (!t) throw new ObsideError("OBSIDE_SIGNALS_TOKEN n'est pas configurée sur le serveur.", 500);
  return t;
}

async function call(path, { auth = true, query } = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { Accept: "application/json" };
  if (auth) headers.Authorization = `Bearer ${token()}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new ObsideError(`API Obside injoignable (${e.name}).`, 502);
  }
  let body = null;
  try { body = await res.json(); } catch { /* corps non JSON */ }

  if (!res.ok || (body && body.success === false)) {
    const msg = body?.error?.message || body?.message || body?.error || `HTTP ${res.status}`;
    const hint = res.status === 401 ? " (clé Signals invalide ou révoquée)"
      : res.status === 403 ? " (abonnement Obside requis ou source non visible)"
      : res.status === 410 ? " (curseur expiré : repartir de 'beginning' ou 'now')"
      : res.status === 429 ? " (trop de requêtes, réessayer plus tard)" : "";
    throw new ObsideError(`Obside a répondu : ${typeof msg === "string" ? msg : JSON.stringify(msg)}${hint}`, res.status);
  }
  return body && "result" in body ? body.result : body;
}

// ---------- Catalogue ----------
let catalogCache = { at: 0, data: null };

function asList(result) {
  if (Array.isArray(result)) return result;
  for (const k of ["sources", "items", "data", "signal_sources"]) {
    if (Array.isArray(result?.[k])) return result[k];
  }
  return [];
}

export function sourceName(s) {
  return s?.name || s?.display_name || s?.title || s?.label || s?.agent_name || s?.agent?.name || "";
}

function searchableText(s) {
  return [sourceName(s), s?.agent_name, s?.agent?.name, s?.arena, s?.arena_name, s?.model, s?.description]
    .filter(Boolean).join(" ").toLowerCase();
}

export async function listSources({ force = false } = {}) {
  if (!force && catalogCache.data && Date.now() - catalogCache.at < 5 * 60 * 1000) return catalogCache.data;
  const data = asList(await call("/signal-sources", { auth: false }));
  catalogCache = { at: Date.now(), data };
  return data;
}

// Résout "mistral" | "kimi" | un identifiant exact -> { id, label, source }
export async function resolveSource(key) {
  const k = String(key || "").trim();
  const tracked = TRACKED[k.toLowerCase()];
  const sources = await listSources();

  if (tracked) {
    const forced = process.env[tracked.envId];
    if (forced) {
      return { key: k.toLowerCase(), id: forced, label: tracked.label, source: sources.find((s) => s.id === forced) || null };
    }
    const matches = sources.filter((s) => tracked.words.every((w) => searchableText(s).includes(w)));
    if (matches.length === 0) {
      throw new ObsideError(`Source « ${tracked.label} » introuvable dans le catalogue Obside. Utilise list_sources pour voir les noms exacts, puis renseigne ${tracked.envId}.`, 404);
    }
    if (matches.length > 1) {
      const names = matches.map((s) => `${sourceName(s)} [${s.id}]`).join(" ; ");
      throw new ObsideError(`Plusieurs sources correspondent à « ${tracked.label} » : ${names}. Renseigne ${tracked.envId} avec l'identifiant voulu.`, 409);
    }
    return { key: k.toLowerCase(), id: matches[0].id, label: tracked.label, source: matches[0] };
  }

  // Identifiant exact fourni
  const exact = sources.find((s) => s.id === k);
  if (!exact) throw new ObsideError(`Source « ${k} » inconnue. Utilise "mistral", "kimi" ou un id renvoyé par list_sources.`, 404);
  return { key: k, id: exact.id, label: sourceName(exact) || exact.id, source: exact };
}

// ---------- Événements ----------
function pageOf(result) {
  const events = Array.isArray(result) ? result
    : result?.events || result?.signals || result?.items || result?.data || [];
  return {
    events,
    next_cursor: result?.next_cursor ?? result?.cursor ?? null,
    has_more: Boolean(result?.has_more),
  };
}

export async function getSignalsPage(sourceId, { cursor = "beginning", limit = 50 } = {}) {
  return pageOf(await call("/signals", { query: { source_id: sourceId, cursor, limit } }));
}

// Parcourt le journal depuis le début (30 jours conservés) et garde les événements
// dont occurred_at est dans la fenêtre demandée. Plafonné pour rester rapide.
export async function getRecent(sourceId, { hours = 24, types, maxPages = 20 } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  let cursor = "beginning";
  const out = [];
  let pages = 0;
  let truncated = false;
  let lastCursor = null;
  while (true) {
    const page = await getSignalsPage(sourceId, { cursor, limit: 100 });
    pages++;
    for (const e of page.events) {
      const t = Date.parse(e.occurred_at || e.published_at || "");
      if (Number.isFinite(t) && t < since) continue;
      if (types?.length && !types.includes(e.type)) continue;
      out.push(e);
    }
    lastCursor = page.next_cursor || lastCursor;
    if (!page.has_more || !page.next_cursor) break;
    if (pages >= maxPages) { truncated = true; break; }
    cursor = page.next_cursor;
  }
  out.sort((a, b) => Date.parse(b.occurred_at || 0) - Date.parse(a.occurred_at || 0));
  return { events: out, next_cursor: lastCursor, truncated };
}

export async function getState(sourceId) {
  return call(`/signal-sources/${encodeURIComponent(sourceId)}/state`);
}

// ---------- Mise en forme ----------
export function summarizeEvent(e) {
  const d = e.data || {};
  const inst = d.instrument || {};
  return {
    id: e.id,
    type: e.type,
    occurred_at: e.occurred_at,
    published_at: e.published_at,
    symbol: inst.symbol || inst.venue_symbol || d.symbol || null,
    venue: inst.venue || null,
    side: d.side ?? null,                   // ordres : buy | sell
    position_side: d.position_side ?? null, // trades : long | short
    action: d.action ?? null,               // trades : open | close
    quantity: d.quantity ?? null,
    reference_price: d.reference_price ?? null,
    simulation: d.simulation ?? null,
    trade_id: d.trade_id ?? null,
    order_id: d.order_id ?? null,
    execution_status: d.execution_status ?? null,
    market: d.market_label || d.market || null,
    outcome: d.outcome_label || d.outcome || null,
    stake: d.stake ?? null,
    provider: d.provider ?? null,
    ...extractRisk(d),
    // Tous les autres champs envoyés par Obside, sans filtre, pour ne rien perdre.
    extra: Object.fromEntries(Object.entries(d).filter(([k]) => !KNOWN_KEYS.has(k))),
    raw: e,
  };
}

const KNOWN_KEYS = new Set([
  "instrument", "symbol", "side", "position_side", "action", "quantity", "reference_price",
  "simulation", "trade_id", "order_id", "execution_status", "market_label", "market",
  "outcome_label", "outcome", "stake", "provider",
]);

// Cherche TP / SL / levier où qu'ils soient dans l'objet (noms variables selon les sources).
const RISK_PATTERNS = {
  take_profit: /^(tp|take_?profit|take_?profit_?price|tp_?price|target|target_?price|targets|take_?profits|tp\d)$/i,
  stop_loss: /^(sl|stop|stop_?loss|stop_?loss_?price|sl_?price|stop_?price|invalidation)$/i,
  leverage: /^(leverage|lev)$/i,
};

export function extractRisk(obj) {
  const found = { take_profit: null, stop_loss: null, leverage: null };
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      for (const [name, re] of Object.entries(RISK_PATTERNS)) {
        if (found[name] === null && re.test(k) && v !== null && v !== undefined && v !== "") found[name] = v;
      }
      if (v && typeof v === "object" && k !== "instrument") walk(v, depth + 1);
    }
  };
  walk(obj, 0);
  return found;
}

function instrumentKey(t) {
  const inst = t?.instrument || t?.data?.instrument || {};
  return inst.canonical_asset_id || inst.base_symbol || inst.symbol || t?.symbol || null;
}

function instrumentLabel(t) {
  const inst = t?.instrument || t?.data?.instrument || {};
  return inst.symbol || inst.venue_symbol || inst.base_symbol || t?.symbol || "?";
}

function riskOf(t) {
  const r = extractRisk(t);
  return { entry: t?.reference_price ?? t?.entry_price ?? t?.data?.reference_price ?? null, ...r };
}

function sideOf(t) {
  return t?.position_side || t?.data?.position_side || (t?.side === "buy" ? "long" : t?.side === "sell" ? "short" : null);
}

// Compare les trades ouverts de deux sources : même actif + même sens = consensus.
export function computeConsensus(stateA, stateB) {
  const open = (s) => (s?.state?.open_trades || s?.open_trades || []);
  const a = open(stateA), b = open(stateB);
  const mapB = new Map();
  for (const t of b) {
    const k = instrumentKey(t);
    if (k) (mapB.get(k) || mapB.set(k, []).get(k)).push(t);
  }
  const agree = [], conflict = [], onlyA = [];
  const seenB = new Set();
  for (const t of a) {
    const k = instrumentKey(t);
    const others = (k && mapB.get(k)) || [];
    if (!others.length) { onlyA.push({ asset: instrumentLabel(t), side: sideOf(t), ...riskOf(t) }); continue; }
    seenB.add(k);
    const same = others.find((o) => sideOf(o) && sideOf(o) === sideOf(t));
    (same ? agree : conflict).push({
      asset: instrumentLabel(t),
      side_a: sideOf(t),
      side_b: same ? sideOf(same) : others.map(sideOf).join("/"),
      risk_a: riskOf(t),
      risk_b: same ? riskOf(same) : others.map(riskOf),
    });
  }
  const onlyB = b.filter((t) => !seenB.has(instrumentKey(t))).map((t) => ({ asset: instrumentLabel(t), side: sideOf(t), ...riskOf(t) }));
  return { agree, conflict, onlyA, onlyB };
}
