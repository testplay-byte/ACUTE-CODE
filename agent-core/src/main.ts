/**
 * Sidecar entry point. The Rust shell spawns `node agent-core/dist/main.js`
 * with ACUTE_TOKEN (bearer auth) and ACUTE_DB_PATH (SQLite location) in the
 * environment (ARCHITECTURE §2/§7); provider keys arrive as
 * ACUTE_PROVIDER_<ID> vars held only in the in-memory keyring.
 *
 * ACUTE_PORT (optional): bind a fixed port instead of an ephemeral one —
 * used only by the dev workflow (scripts/dev.mjs) so the browser UI can
 * expect a deterministic address; the shell always uses the ready-line port.
 */
import { startServer } from "./server.js";
// ROUND-45 (R45-b): SIGTERM/SIGINT must kill live terminal-session shells.
// The dev workflow (scripts/dev.mjs) stops the sidecar with sidecar.kill()
// = SIGTERM — Fastify's onClose hooks never run on a bare signal, so without
// this handler every persistent shell (bash/pty children) would be orphaned.
import { terminalSessionsDisposeAll } from "./terminal-sessions.js";

const token = process.env.ACUTE_TOKEN;
const dbPath = process.env.ACUTE_DB_PATH;
if (!token || !dbPath) {
  console.error("ACUTE_TOKEN and ACUTE_DB_PATH are required");
  process.exit(1);
}

const fixedPort = Number(process.env.ACUTE_PORT ?? 0);
startServer({ port: Number.isInteger(fixedPort) && fixedPort > 0 ? fixedPort : 0, token, dbPath }).catch((error: unknown) => {
  console.error("sidecar failed to start:", error);
  process.exit(1);
});

// Kill signal handling: dispose terminal sessions FIRST (the kill signals
// are sent synchronously), then exit. Replaces node's default immediate
// exit so no shell children survive the sidecar.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    try {
      terminalSessionsDisposeAll();
    } catch {
      /* best-effort — we are exiting anyway */
    }
    process.exit(0);
  });
}
