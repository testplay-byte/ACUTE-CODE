/**
 * Sidecar entry point. The Rust shell spawns `node agent-core/dist/main.js`
 * with ACUTE_TOKEN (bearer auth) and ACUTE_DB_PATH (SQLite location) in the
 * environment (ARCHITECTURE §2/§7); provider keys arrive as
 * ACUTE_PROVIDER_<ID> vars held only in the in-memory keyring.
 */
import { startServer } from "./server.js";

const token = process.env.ACUTE_TOKEN;
const dbPath = process.env.ACUTE_DB_PATH;
if (!token || !dbPath) {
  console.error("ACUTE_TOKEN and ACUTE_DB_PATH are required");
  process.exit(1);
}

startServer({ port: 0, token, dbPath }).catch((error: unknown) => {
  console.error("sidecar failed to start:", error);
  process.exit(1);
});
