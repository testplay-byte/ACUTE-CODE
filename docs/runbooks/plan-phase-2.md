<!-- last-reviewed: 2026-09-07 round-75 -->
# Phase 2 Plan — Core Skeleton

Owner: Orchestrator · Planner artifact · 2026-08-22 · Prerequisite: Phase 1 APPROVED 2026-08-22 (cargo check green; CI live on GitHub Actions)

**Exit criterion:** the owner creates an agent in the UI and completes one conversation with it (single-agent mode, live OpenRouter round trip).

## Waves (max 2 sub-agents concurrent; heavy builds on GitHub Actions per ADR-0012)

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | **Wave 1a — Sidecar core**: Fastify server, bearer auth, ready-line, agents CRUD, better-sqlite3 migrations + seeds | Developer A + Orchestrator fixes | DONE (verify green, live smoke test) |
| 2 | **Wave 1b — Frontend foundation**: Tailwind/shadcn/Zustand/TanStack, theme system, app shell, Agent Registry | Developer B | DONE |
| 3 | **Wave 2a — Providers + chat**: AI SDK v7 openai-compatible, keyring via env, model listing, single-agent chat + usage telemetry | Developer C + Orchestrator (main.js entry, db-dir fix) | DONE (LIVE OpenRouter round trip PASSED on stealth/ox-alpha) |
| 4 | **Wave 2b — Shell integration**: Rust spawns sidecar (token, ready-line, health poll, shutdown), provider keys Credential Manager → env (keyring crate) | Developer D + Orchestrator | DONE (cargo check green, spawn contract test PASSED) |
| 5 | **Wave 3 — Chat UI + E2E**: sessions screen, chat view, error banners, fixtures; orchestrator hands-on live + contract tests | Developer E + Orchestrator | DONE (107/107 tests) |
| 6 | Reviewer pass; Scribe: docs/ADRs/SETUP; commit + push (CI green) | Reviewer/Scribe | commit DONE (455bc7c/774f441/be13e95 + keyring); push/CI BLOCKED on expired GitHub PAT |

## Constraints & notes

- Keys: OpenRouter key is in Credential Manager (`ACUTE-CODE/provider/openrouter`); usable test model is limited to **"ox Alpha"** (resolve its exact OpenRouter model id via the models API at first live test). Native Anthropic/OpenAI adapters are fixture-tested only (no keys).
- UI follows docs/design/ui-direction.md; owner will iterate on design ("there might be some adjusting") — build for easy restyling.
- Frontend dev-data contract = API.md; no prisma, no Next.js.
- Every wave: `pnpm verify` green locally before push; CI is authoritative.
