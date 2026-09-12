<!-- last-reviewed: 2026-09-12 round-94 -->
# Phase 1 Plan — Architecture & Repo Skeleton

Owner: Orchestrator · Planner artifact · 2026-08-22 · Prerequisite: Phase 0 APPROVED 2026-08-22

## Tasks

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | Record Phase 0 approval; this plan; ADR-0005 (dev tooling) | Orchestrator/Scribe | DONE |
| 2 | Install Rust (stable-msvc) + VS Build Tools 2022 (VCTools workload) | Orchestrator | IN PROGRESS (winget background) |
| 3 | `docs/architecture/ARCHITECTURE.md` — system overview, process/lifecycle model, module map, data flows, SQLite overview, event model, security model, performance notes, extension points | Architect sub-agent | DONE (2026-08-22) |
| 4 | `docs/architecture/api/API.md` — REST + WS contracts | Architect sub-agent | DONE (2026-08-22) |
| 5 | Design ADRs 0006–0011: Fastify, better-sqlite3, bearer-token auth, Node bundling [ASSUMPTION], append-only event log, in-process runners | Architect sub-agent | DONE (2026-08-22) |
| 6 | Repo skeleton per brief §5: pnpm workspace (root=frontend, agent-core, shared), tsconfig/eslint(v9 flat)/vitest, placeholder code + ≥1 test per package, vite build, static src-tauri scaffold, `scripts/license-audit.mjs`, `.github/workflows/ci.yml`, module READMEs | Developer sub-agent | DONE (agent died near completion; orchestrator finished integration: pnpm 11 allowBuilds fix, lockfile regen) |
| 7 | Local CI verification: `pnpm verify` (lint+typecheck+test+build+license-audit) green; `cargo check` in src-tauri once Rust lands | Orchestrator/Tester | pnpm verify GREEN 2026-08-22 (12/12 tests, build ok, license audit clean); cargo check pending Rust install |
| 8 | Review pass: architecture + skeleton against SPEC + brief §13 | Reviewer sub-agent | DONE — 3 blocking found (B1 types drift, B2 missing endpoints, B3 unverified cargo); B1+B2 fixed by producer re-dispatch + orchestrator reconciliation; report at `review-phase-1.md` |
| 9 | SETUP.md finalized; memory updated; git commit | Scribe | DONE (2026-08-22) |
| 10 | Phase 1 report → owner approval | Orchestrator | PENDING |

## Exit criterion

Owner approves ARCHITECTURE.md (+ API contracts) with CI green on the full skeleton.

## Notes

- Frontend dependency set stays minimal in Phase 1 (react, vite, typescript + tooling); Tailwind/shadcn/Zustand/TanStack land at Phase 2 with the UI work — sequencing within the fixed stack, not a scope change.
- The Tauri scaffold is written as static files; first `cargo check/build` happens when the Rust install completes (task 2). CI includes it from the start.
