// Profil de sortie : reconstitue chaque trade (ouverture -> clôture) d'une source,
// mesure gain/perte, MAE (pire écart contre la position) et MFE (meilleur écart en faveur),
// puis en déduit des niveaux SL / TP « implicites » qui collent au comportement réel du modèle.
import { makePriceStore, priceAt, excursion } from "./prices.js";

const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10000) / 100); // en %
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

function quantile(arr, q) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

const instKey = (inst = {}) => inst.canonical_asset_id || inst.exchange_pair_id || inst.venue_symbol || inst.symbol || "?";
const instLabel = (inst = {}) => inst.symbol || inst.venue_symbol || inst.base_symbol || "?";

// events : journal brut d'une source (tous types). Renvoie trades fermés + ouverts.
export function pairTrades(events) {
  const byTrade = new Map();
  const fills = [];
  for (const e of events) {
    const d = e.data || {};
    if (e.type === "order.filled") fills.push(e);
    if (!d.trade_id || (e.type !== "trade.opened" && e.type !== "trade.closed")) continue;
    const t = byTrade.get(d.trade_id) || { trade_id: d.trade_id };
    if (e.type === "trade.opened") {
      t.open = e; t.inst = d.instrument || t.inst; t.side = d.position_side || t.side;
    } else {
      t.close = e; t.inst = t.inst || d.instrument; t.side = t.side || d.position_side;
    }
    byTrade.set(d.trade_id, t);
  }
  // Prix exécutés éventuels via les ordres liés au trade
  for (const f of fills) {
    const d = f.data || {};
    const t = d.trade_id && byTrade.get(d.trade_id);
    if (!t || d.reference_price == null) continue;
    const isEntry = (t.side === "long" && d.side === "buy") || (t.side === "short" && d.side === "sell");
    if (isEntry && t.entryFill == null) t.entryFill = num(d.reference_price);
    if (!isEntry) t.exitFill = num(d.reference_price);
  }
  return [...byTrade.values()].filter((t) => t.open || t.close);
}

export async function buildExitProfile(events, { openTrades = [], now = Date.now() } = {}) {
  const trades = pairTrades(events);
  const prices = makePriceStore();
  const times = events.map((e) => Date.parse(e.occurred_at)).filter(Number.isFinite);
  const from = (times.length ? Math.min(...times) : now - 30 * 864e5) - 3600e3;

  const closed = [];
  const skipped = [];
  const priceSources = {};

  for (const t of trades) {
    if (!t.open || !t.close) continue; // ouvert avant la fenêtre ou encore en cours
    const tOpen = Date.parse(t.open.occurred_at), tClose = Date.parse(t.close.occurred_at);
    const { source, candles, error } = await prices(t.inst, from, now);
    if (source) priceSources[instLabel(t.inst)] = source;

    const entry = num(t.open.data?.reference_price) ?? t.entryFill ?? priceAt(candles, tOpen);
    let exit = num(t.close.data?.reference_price) ?? t.exitFill ?? null;
    let exitSource = exit != null ? "obside" : null;
    if (exit == null) { exit = priceAt(candles, tClose); exitSource = exit != null ? "historique" : null; }

    if (entry == null || exit == null || !t.side) {
      skipped.push({ trade_id: t.trade_id, asset: instLabel(t.inst), reason: error || "prix d'entrée ou de sortie introuvable" });
      continue;
    }
    const dir = t.side === "short" ? -1 : 1;
    const ret = dir * (exit - entry) / entry;
    const ex = excursion(candles, tOpen, tClose, entry, exit);
    const mae = Math.min(0, dir === 1 ? (ex.low - entry) / entry : (entry - ex.high) / entry);
    const mfe = Math.max(0, dir === 1 ? (ex.high - entry) / entry : (entry - ex.low) / entry);
    closed.push({
      trade_id: t.trade_id, asset: instLabel(t.inst), key: instKey(t.inst), side: t.side,
      opened_at: t.open.occurred_at, closed_at: t.close.occurred_at,
      duration_h: Math.round((tClose - tOpen) / 36e5 * 10) / 10,
      entry, exit, exit_price_source: exitSource,
      return_pct: pct(ret), mae_pct: pct(mae), mfe_pct: pct(mfe),
      excursion_measured: ex.candles > 0,
      _r: ret, _mae: mae, _mfe: mfe,
    });
  }

  const summarize = (list) => {
    const wins = list.filter((x) => x._r > 0), losses = list.filter((x) => x._r <= 0);
    // SL implicite : assez large pour ne pas couper les trades que le modèle a fini par gagner
    // (90e percentile du pire écart subi par les gagnants), sans être plus serré que ses pertes typiques.
    const winMae = wins.map((x) => -x._mae);
    const lossAbs = losses.map((x) => -x._r);
    const slA = quantile(winMae, 0.9);
    const slB = quantile(lossAbs, 0.5);
    const sl = slA != null && slB != null ? Math.max(slA, slB) : slA ?? slB;
    // TP implicite : gain médian réellement encaissé par le modèle sur ses gagnants
    const tp = quantile(wins.map((x) => x._r), 0.5);
    return {
      trades: list.length,
      win_rate_pct: list.length ? Math.round((wins.length / list.length) * 1000) / 10 : null,
      avg_return_pct: pct(list.length ? list.reduce((s, x) => s + x._r, 0) / list.length : null),
      median_win_pct: pct(tp),
      median_loss_pct: pct(quantile(losses.map((x) => x._r), 0.5)),
      worst_loss_pct: pct(losses.length ? Math.min(...losses.map((x) => x._r)) : null),
      winners_mae_p50_pct: pct(-(quantile(winMae, 0.5) ?? NaN)),
      winners_mae_p90_pct: pct(-(slA ?? NaN)),
      winners_mfe_p50_pct: pct(quantile(wins.map((x) => x._mfe), 0.5)),
      median_duration_h: quantile(list.map((x) => x.duration_h), 0.5),
      implied_stop_loss_pct: pct(sl),
      implied_take_profit_pct: pct(tp),
      reliability: list.length >= 20 ? "correcte" : list.length >= 8 ? "faible" : "insuffisante (moins de 8 trades)",
      _sl: sl, _tp: tp,
    };
  };

  const overall = summarize(closed);
  const byAssetMap = new Map();
  for (const c of closed) (byAssetMap.get(c.key) || byAssetMap.set(c.key, []).get(c.key)).push(c);
  const byAsset = {};
  const assetStats = new Map();
  for (const [k, list] of byAssetMap) {
    const s = summarize(list);
    assetStats.set(k, s);
    const { _sl, _tp, ...pub } = s;
    byAsset[list[0].asset] = pub;
  }

  // Niveaux suggérés pour les positions actuellement ouvertes
  const openWithEntries = new Map(trades.filter((t) => t.open && !t.close).map((t) => [t.trade_id, t]));
  const open = [];
  for (const ot of openTrades) {
    const inst = ot.instrument || ot.data?.instrument || openWithEntries.get(ot.trade_id)?.inst || {};
    const side = ot.position_side || openWithEntries.get(ot.trade_id)?.side;
    const ev = openWithEntries.get(ot.trade_id);
    const entry = num(ot.reference_price) ?? num(ot.entry_price) ?? num(ev?.open?.data?.reference_price) ?? ev?.entryFill ?? null;
    const a = assetStats.get(instKey(inst));
    const useAsset = a && a.trades >= 8;
    const sl = useAsset ? a._sl : overall._sl;
    const tp = useAsset ? a._tp : overall._tp;
    const dir = side === "short" ? -1 : 1;
    open.push({
      trade_id: ot.trade_id ?? null, asset: instLabel(inst), side: side ?? null,
      opened_at: ev?.open?.occurred_at ?? ot.opened_at ?? null, entry,
      based_on: useAsset ? `historique ${instLabel(inst)} (${a.trades} trades)` : `historique global (${overall.trades} trades)`,
      stop_loss_pct: pct(sl), take_profit_pct: pct(tp),
      stop_loss_price: entry != null && sl != null ? +(entry * (1 - dir * sl)).toPrecision(8) : null,
      take_profit_price: entry != null && tp != null ? +(entry * (1 + dir * tp)).toPrecision(8) : null,
    });
  }

  const { _sl, _tp, ...overallPub } = overall;
  return {
    method: "Niveaux déduits du comportement passé (30 jours max), pas des ordres du modèle. SL = max(90e percentile du pire écart des trades gagnants, perte médiane). TP = gain médian des trades gagnants.",
    overall: overallPub,
    by_asset: byAsset,
    open_trades_levels: open,
    trades: closed.map(({ _r, _mae, _mfe, key, ...rest }) => rest),
    skipped,
    price_sources: priceSources,
  };
}
