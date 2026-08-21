/**
 * Placeholder sidecar HTTP server. The real REST/WebSocket API
 * (docs/architecture/api/) replaces the body of createServer in Phase 2;
 * the GET /health contract stays as the shell's liveness probe.
 */
import { createServer as createHttpServer, type Server } from "node:http";

export const VERSION = "0.1.0";

export function createServer(): Server {
  return createHttpServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", app: "acute-code" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
}
