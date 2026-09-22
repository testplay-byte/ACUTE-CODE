/**
 * Sidecar entry point. The Rust shell spawns `node agent-core/dist/main.js`
 * with ACUTE_TOKEN (bearer auth) and ACUTE_DB_PATH (SQLite location) in the
 * environment (ARCHITECTURE §2/§7); provider keys arrive as
 * ACUTE_PROVIDER_<ID> vars held only in the in-memory keyring.
 *
 * ACUTE_PORT (optional): bind a fixed port instead of an ephemeral one —
 * used only by the dev workflow (scripts/dev.mjs) so the browser UI can
 * expect a deterministic address; the shell always uses the ready-line port.
 *
 * ACUTE_HOST (optional, ROUND-106 R106-S1): set to a NON-LOOPBACK value at
 * boot to force-enable the DEVICE LINK (the TLS LAN listener the Android
 * companion pairs over — startServer persists deviceLink.enabled and boots
 * the listener; see server.ts's boot block). Loopback values mean nothing;
 * the persisted setting alone decides.
 */
import { startServer } from "./server.js";
// ROUND-45 (R45-b): SIGTERM/SIGINT must kill live terminal-session shells.
// The dev workflow (scripts/dev.mjs) stops the sidecar with sidecar.kill()
// = SIGTERM — Fastify's onClose hooks never run on a bare signal, so without
// this handler every persistent shell (bash/pty children) would be orphaned.
import { terminalSessionsDisposeAll } from "./terminal-sessions.js";
// ROUND-117 (R117-e): process-level crash handlers — an uncaughtException or
// unhandledRejection anywhere outside a route previously killed the sidecar
// with Node's default spew (no ring entry, no honest sidecar.log line). Now:
// scrub → diagnostics ring (best-effort) + sidecar.log → CONTROLLED exit(1)
// (the boot sweep recovers crash-orphaned `running` sessions on restart, so
// a clean death beats a zombie). lib/crash-handlers.ts owns the semantics;
// every effect is injected there and unit-tested in isolation.
import { installCrashHandlers } from "./lib/crash-handlers.js";
import { recordDiagnostic } from "./lib/diagnostics-sink.js";

const token = process.env.ACUTE_TOKEN;
const dbPath = process.env.ACUTE_DB_PATH;
if (!token || !dbPath) {
  console.error("ACUTE_TOKEN and ACUTE_DB_PATH are required");
  process.exit(1);
}

// R117-e: installed FIRST — before any async work — so even the startup
// window is covered. The ring sink is a no-op until startServer builds the
// server (lib/diagnostics-sink.ts's contract); sidecar.log + exit(1) fire
// regardless. The exit fn gives stderr a beat to flush when PIPED (the
// shell's sidecar.log): process.exit() truncates pending pipe writes, so
// exitCode is set immediately (nonzero even if the loop drains) and the
// unref'd timer is the forced exit once the log line has landed.
installCrashHandlers({
  record: (message) => recordDiagnostic("crash", message),
  log: (...args) => console.error(...args),
  exit: (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 250).unref();
  },
});

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
