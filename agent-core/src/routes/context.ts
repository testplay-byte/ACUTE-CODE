// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the typed shared context every domain route module
// (routes/<domain>.ts) receives from buildServer. ONE interface, built once
// per server; each register function destructures only the fields its domain
// uses. Extracted from server.ts in R84 — behavior-identical, test-guarded.
// The browser routes keep their own registerBrowserRoutes(scope, token, db)
// signature (the in-repo pattern this split follows); no domain module
// currently destructures `token` (the app-level bearer wall owns auth).
// ─────────────────────────────────────────────────────────────────────────────
import type { SqliteDatabase } from "../storage/db.js";
import type { ProviderKeyring } from "../providers/registry.js";
import type { ChatFn } from "../agents/chat.js";

/** One ring row — deliberately the fields the console renders, nothing else. */
export interface SidecarDiagnosticError {
  id: string;
  /** ISO timestamp of the failure. */
  ts: string;
  source: "sidecar";
  /** Capture point — "http" (fastify error handler) today. */
  kind: string;
  /** Always ≥ 500 — see the 4xx-exclusion decision in recordDiagnosticError. */
  statusCode: number;
  /** The error code (fastify FST_* code or the envelope code). */
  code: string;
  /** Scrubbed, length-bounded error message. */
  message: string;
  /** HTTP method of the failing request. */
  method: string;
  /** Request path with the query string STRIPPED (query params can carry data). */
  url: string;
  /** Frontend-parity field (the bus's AppError carries count) — always 1 here. */
  count: number;
}

/** Ring cap — matches the frontend bus ring (src/lib/error-bus.ts). */
export const DIAGNOSTICS_RING_CAP = 200;

export interface RouteContext {
  /** Per-spawn bearer token (the app-level wall; see routes/context.ts header). */
  token: string;
  /** The server's SQLite handle. */
  db: SqliteDatabase;
  /** In-memory provider keyring (keys + key-pool slots). */
  keyring: ProviderKeyring;
  /** Chat function used by session turns (buildServer-injected; tests drive fakes). */
  chat: ChatFn;
  /**
   * CORS headers for an allow-listed request Origin. SSE routes must write
   * them via res.writeHead AFTER reply.hijack() — headers set through
   * reply.header() are dropped once the reply is hijacked (the ROUND-30
   * "Failed to fetch" lesson).
   */
  corsHeadersFor: (origin: unknown) => Record<string, string>;
  /**
   * R59-E: the per-buildServer diagnostics error ring. The app-level error
   * handler captures into it; routes/diagnostics.ts serves/clears it.
   */
  diagnosticsRing: SidecarDiagnosticError[];
}
