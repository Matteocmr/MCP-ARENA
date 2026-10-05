import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

function authorized(req) {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return { ok: false, status: 500, msg: "MCP_ACCESS_TOKEN non configuré sur le serveur." };
  const h = req.headers["authorization"] || "";
  const given = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, msg: "Jeton d'accès invalide." };
  return { ok: true };
}

function jsonError(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="obside-signals-mcp"');
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
}

async function readBody(req) {
  if (req.body !== undefined) {
    return typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

// Handler Node (req, res) — utilisé tel quel par Vercel et par le serveur local.
export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");

  // Petit point de santé public (ne révèle aucun secret)
  if (req.method === "GET" && (url.pathname === "/" || url.pathname.endsWith("/health"))) {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: true, service: "obside-signals-mcp", mcp_path: "/mcp",
      configured: { obside_token: Boolean(process.env.OBSIDE_SIGNALS_TOKEN), access_token: Boolean(process.env.MCP_ACCESS_TOKEN) },
    }));
  }

  const auth = authorized(req);
  if (!auth.ok) return jsonError(res, auth.status, auth.msg);

  if (req.method !== "POST") {
    // Mode sans état : pas de flux SSE GET ni de session à fermer.
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end();
  }

  let body;
  try { body = await readBody(req); }
  catch { return jsonError(res, 400, "Corps JSON invalide."); }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("[obside-mcp] échec requête:", e?.name, e?.message);
    if (!res.headersSent) jsonError(res, 500, "Erreur interne.");
  }
}
