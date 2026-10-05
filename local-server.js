// Lancement local : OBSIDE_SIGNALS_TOKEN=... MCP_ACCESS_TOKEN=... node local-server.js
import http from "node:http";
import handler from "./lib/handler.js";

const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => handler(req, res)).listen(port, () => {
  console.log(`obside-signals-mcp sur http://localhost:${port}/mcp`);
});
