<!-- last-reviewed: 2026-08-25 round-35 -->
# ADR-0006: Sidecar HTTP framework — Fastify

- **Status:** ACCEPTED (implementation-detail decision under the smaller-scope rule; surfaced per protocol)
- **Date:** 2026-08-21

## Context

The sidecar serves localhost REST + one WebSocket endpoint to the Tauri webview (SPEC §3 "IPC" row; `docs/architecture/api/API.md`). The stack table fixes Node/TS but not the framework. Constraints: (1) REST with schema validation from the single `@acute/shared` TypeBox source; (2) WebSocket in the same process with per-connection auth frames and subscription state; (3) license allowlist MIT/Apache-2.0/BSD/ISC/MPL-2.0 (SPEC §6); (4) cold-start contribution must stay inside the <5 s budget (SPEC §5); (5) must run on the Node 24 baseline (ADR-0002), no edge runtimes.

## Options considered

- **A. Fastify 5 (MIT)** — mature plugin architecture; native JSON-Schema validation on routes (pairs directly with TypeBox's `Kind`/schema output); `@fastify/websocket` (MIT) wraps `ws` (MIT) with per-route hooks; schema-based serialization is fast; large maintenance surface, first-class TypeScript types; hooks for redaction middleware and graceful close.
- **B. Hono (MIT)** — fastest cold start, tiny, pleasant router; but its Node WS story is the weakest part (`@hono/node-ws` is comparatively young, edge-first priorities), no equivalent of route-level schema validation + serialization, smaller Node-server track record for long-lived stateful connections.
- **C. Express (MIT)** — ubiquitous, everything documented; but callback-era design, no built-in validation, `express-ws` is a routing hack, weakest throughput of the three, and the ecosystem is migrating away rather than toward it.

## Decision

**Fastify 5** (Option A), with `@fastify/websocket`, `@fastify/cors` (single-origin allowlist), and **TypeBox (MIT)** as the validation layer so `@acute/shared` schemas drive both compile-time types and runtime validation in one artifact (opencode's single protocol-schema source, research/opencode).

Licenses verified: fastify MIT · @fastify/websocket MIT · @fastify/cors MIT · ws MIT · @sinclair/typebox MIT — all inside the allowlist; recorded in `docs/compliance/dependency-licenses.md` when installed.

## Consequences

Route files live only in `agent-core/src/server/`; they stay thin (validate → delegate to a module → return) so the framework never becomes load-bearing for product logic. WebSocket auth-by-first-message (ADR-0008) is implemented as a pre-handler on the `/ws` route. Startup cost of Fastify + plugins is well under the budget (~50–100 ms measured at Phase 2). Reversal cost: low-moderate — REST routes are thin adapters over module functions; only the WS gateway would need porting.
