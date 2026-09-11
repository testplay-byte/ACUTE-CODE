<!-- last-reviewed: 2026-09-11 round-90 -->
# ADR-0008: Shell↔sidecar auth — spawn-time random bearer token on loopback

- **Status:** ACCEPTED (implementation-detail decision under the smaller-scope rule; surfaced per protocol)
- **Date:** 2026-08-21

## Context

The Tauri shell spawns the sidecar and the webview talks to it over localhost HTTP/WS (SPEC §3). Any other local process (or a webpage in another browser via CSRF-style requests, or DNS-rebinding) could otherwise reach the sidecar's privileged surface — it executes shell commands and reads agent data. Goose's precedent: UI mints a secret, passes it at spawn via env, daemon serves on an ephemeral loopback port; remote clients present `X-Secret-Key` (research/goose, "Spawn and handshake").

## Options considered

- **A. Random bearer token minted by the shell at spawn** — 256-bit value generated in Rust (`getrandom`, MIT OR Apache-2.0), passed via env var, required as `Authorization: Bearer` on every route except `GET /health`; sidecar binds `127.0.0.1` only.
- **B. Goose-style token in the WebSocket query string + header for REST** — one mechanism, but query strings leak into logs/proxies; rejected for our WS (goose itself accepts this tradeoff; we don't need to).
- **C. mTLS or TLS-cert pinning (goose remote mode)** — justified only for off-device cores; pure overhead for v1 loopback.
- **D. No auth ("it's only localhost")** — rejected: localhost is not an authentication boundary (any local process can hit an open port; browsers can be tricked into cross-origin POSTs).

## Decision

**Option A**, plus for WebSocket a **first-message auth frame** `{"type":"auth","token":…}` within 2 s (close `4401` otherwise), because browser `WebSocket` cannot set headers and we refuse query-string tokens (Option B's leak). CORS is a single-origin allowlist (Tauri webview origin + dev origin), no wildcard, no credentials. The webview receives `{port, token}` only via the Tauri command `sidecar_endpoint()` — never via URL, query, or persisted storage.

## Consequences

Every sidecar route except `/health` sits behind one Fastify pre-handler; the WS gateway enforces the auth frame before accepting subscriptions (ADR-0006). Token lifetime = process lifetime: a restart mints a new one, so stale tokens are useless. Secrets-handoff env vars are read once at boot and cleared from `process.env` after vault population so child MCP processes don't inherit them. Reversal cost: low — auth is one middleware + one frame; a future remote-core mode can layer TLS on top without changing the token model (goose's fingerprint-pinning becomes applicable then).
