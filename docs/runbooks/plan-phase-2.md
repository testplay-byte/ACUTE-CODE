# Phase 2 Plan — Core Skeleton

Owner: Orchestrator · Planner artifact · 2026-08-22 · Prerequisite: Phase 1 APPROVED 2026-08-22 (cargo check green; CI live on GitHub Actions)

**Exit criterion:** the owner creates an agent in the UI and completes one conversation with it (single-agent mode, live OpenRouter round trip).

## Waves (max 2 sub-agents concurrent; heavy builds on GitHub Actions per ADR-0012)

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | **Wave 1a — Sidecar core**: Fastify 5 server (ADR-0006) with bearer-token auth middleware (ADR-0008), stdout ready-line + ephemeral port, `/health`, agents CRUD + duplicate per API.md §4, better-sqlite3 (ADR-0007) with numbered migrations + schema v1 (agents, providers, sessions, session_events, usage_events, approvals, audit_log, settings), integration tests | Developer A | DISPATCHED |
| 2 | **Wave 1b — Frontend foundation**: Tailwind + shadcn/ui + Zustand + TanStack Query wiring; theme system + motion variants ported from design demos (docs/design/ui-direction.md); app shell (sidebar+topbar); Agent Registry screen (list/editor/templates) against a typed API client with msw-free fixture tests | Developer B | DISPATCHED |
| 3 | **Wave 2a — Providers + chat**: Vercel AI SDK provider layer (openai-compatible adapter first — OpenRouter live), provider manager (keys from Credential Manager via shell-injected env), model listing, single-agent chat loop with streaming WS events + usage telemetry rows | Developer | PENDING |
| 4 | **Wave 2b — Shell integration**: Rust spawns sidecar (token via env, ready-line parse, health poll, shutdown), frontend boots against live sidecar | Developer | PENDING |
| 5 | **Wave 3 — E2E + demo**: owner-facing demo path (create agent → chat round trip), DEMO.md, perf baseline (cold start, idle RAM) | Tester + Orchestrator | PENDING |
| 6 | Reviewer pass; Scribe: docs/ADRs/SETUP; commit + push (CI green) | Reviewer/Scribe | PENDING |

## Constraints & notes

- Keys: OpenRouter key is in Credential Manager (`ACUTE-CODE/provider/openrouter`); usable test model is limited to **"ox Alpha"** (resolve its exact OpenRouter model id via the models API at first live test). Native Anthropic/OpenAI adapters are fixture-tested only (no keys).
- UI follows docs/design/ui-direction.md; owner will iterate on design ("there might be some adjusting") — build for easy restyling.
- Frontend dev-data contract = API.md; no prisma, no Next.js.
- Every wave: `pnpm verify` green locally before push; CI is authoritative.
