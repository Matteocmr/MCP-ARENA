import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TRACKED, ObsideError, listSources, sourceName, resolveSource,
  getSignalsPage, getRecent, getState, summarizeEvent, computeConsensus,
} from "./obside.js";

const EVENT_TYPES = ["trade.opened", "trade.closed", "order.submitted", "order.filled", "order.canceled", "bet.placed", "bet.settled"];
const sourceArg = z.string().describe('"mistral" (Mistral Medium News), "kimi" (Kimi K2T News), ou un identifiant exact renvoyé par list_sources');

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({
  isError: true,
  content: [{ type: "text", text: e instanceof ObsideError ? e.message : "Erreur interne du serveur MCP." }],
});

async function guard(fn) {
  try { return ok(await fn()); }
  catch (e) {
    if (!(e instanceof ObsideError)) console.error("[obside-mcp] erreur inattendue:", e?.name, e?.message);
    return fail(e);
  }
}

const compact = (events, includeRaw) =>
  events.map((e) => { const s = summarizeEvent(e); if (!includeRaw) delete s.raw; return s; });

export function createServer() {
  const server = new McpServer(
    { name: "obside-signals", version: "1.0.0" },
    {
      instructions:
        "Lecture seule des signaux de l'arène Obside pour Mistral Medium News et Kimi K2T News. " +
        "Ce serveur ne passe aucun ordre. Les quantités et prix sont ceux de la source (pas une taille d'ordre). " +
        "Ordres : side buy|sell. Trades : position_side long|short + action open|close — ne jamais déduire buy/sell du nom de l'événement. " +
        "Pour suivre en continu : appeler get_signals avec cursor=\"now\" une première fois, conserver next_cursor, puis le repasser aux appels suivants.",
    },
  );

  server.registerTool("list_sources", {
    title: "Lister les sources Obside",
    description: "Catalogue public des sources de signaux Obside, avec les deux sources suivies (Mistral Medium News, Kimi K2T News) et leurs identifiants résolus. Paramètre search optionnel pour filtrer par nom.",
    inputSchema: { search: z.string().optional().describe("Texte à chercher dans le nom de la source") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ search }) => guard(async () => {
    const all = await listSources({ force: true });
    const q = (search || "").toLowerCase();
    const sources = all
      .filter((s) => !q || JSON.stringify(s).toLowerCase().includes(q))
      .map((s) => ({ id: s.id, name: sourceName(s), domain: s.domain ?? null, mode: s.mode ?? s.kind ?? s.visibility ?? null }));
    const tracked = {};
    for (const key of Object.keys(TRACKED)) {
      try { const r = await resolveSource(key); tracked[key] = { id: r.id, name: r.source ? sourceName(r.source) : r.label }; }
      catch (e) { tracked[key] = { error: e.message }; }
    }
    return { tracked, count: sources.length, sources };
  }));

  server.registerTool("get_signals", {
    title: "Lire une page de signaux",
    description: 'Lit le journal d\'événements d\'une source, page par page. cursor="beginning" = historique conservé (30 jours), cursor="now" = point de départ pour ne suivre que les futurs signaux, sinon le next_cursor renvoyé par l\'appel précédent.',
    inputSchema: {
      source: sourceArg,
      cursor: z.string().default("beginning").describe('"beginning", "now" ou un next_cursor précédent'),
      limit: z.number().int().min(1).max(100).default(50),
      include_raw: z.boolean().default(false).describe("Inclure l'événement brut complet"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ source, cursor, limit, include_raw }) => guard(async () => {
    const src = await resolveSource(source);
    const page = await getSignalsPage(src.id, { cursor, limit });
    return {
      source: { key: src.key, id: src.id, name: src.label },
      count: page.events.length,
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      events: compact(page.events, include_raw),
    };
  }));

  server.registerTool("get_recent_signals", {
    title: "Signaux récents",
    description: "Signaux des X dernières heures pour une source, ou pour les deux (source=\"both\"), du plus récent au plus ancien. Filtre optionnel par type d'événement.",
    inputSchema: {
      source: z.string().default("both").describe('"mistral", "kimi", "both" ou un identifiant exact'),
      hours: z.number().min(0.1).max(720).default(24),
      types: z.array(z.enum(EVENT_TYPES)).optional().describe("Ex. [\"trade.opened\",\"trade.closed\"]"),
      include_raw: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ source, hours, types, include_raw }) => guard(async () => {
    const keys = source === "both" ? Object.keys(TRACKED) : [source];
    const results = {};
    for (const k of keys) {
      const src = await resolveSource(k);
      const r = await getRecent(src.id, { hours, types });
      results[src.key] = {
        id: src.id, name: src.label, count: r.events.length,
        truncated: r.truncated, events: compact(r.events, include_raw),
      };
    }
    return { window_hours: hours, sources: results };
  }));

  server.registerTool("get_source_state", {
    title: "État actuel d'une source",
    description: "Positions/trades ouverts, ordres en attente, paris ouverts et poids observés d'une source à l'instant T. Inspection seulement : ne pas exécuter automatiquement.",
    inputSchema: { source: sourceArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ source }) => guard(async () => {
    const src = await resolveSource(source);
    const state = await getState(src.id);
    return { source: { key: src.key, id: src.id, name: src.label }, ...state };
  }));

  server.registerTool("get_consensus", {
    title: "Consensus Mistral × Kimi",
    description: "Compare les trades ouverts de Mistral Medium News et Kimi K2T News : actifs où les deux sont dans le même sens (consensus), en sens opposé (conflit), ou ouverts par un seul.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, () => guard(async () => {
    const [m, k] = await Promise.all([resolveSource("mistral"), resolveSource("kimi")]);
    const [sm, sk] = await Promise.all([getState(m.id), getState(k.id)]);
    const c = computeConsensus(sm, sk);
    return {
      as_of: { mistral: sm?.as_of ?? null, kimi: sk?.as_of ?? null },
      consensus: c.agree,
      conflicts: c.conflict,
      only_mistral: c.onlyA,
      only_kimi: c.onlyB,
      note: "Basé sur les trades ouverts observés. Le snapshot n'est pas atomique entre les deux sources.",
    };
  }));

  return server;
}
