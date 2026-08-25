<!-- last-reviewed: 2026-08-25 round-36 -->
# Phase 2 Review — Core Skeleton (End-of-Phase Report)

**Date:** 2026-08-22 · **Repo tip at reporting:** `3265ddd` (CI: success) · **Status:** awaiting explicit owner gate approval for Phase 3

---

## 1. Deliverables

| Deliverable | Where |
|---|---|
| **Node/TS agent-core sidecar** — Fastify 5 server, bearer-token auth wall, ready-line protocol, agents/providers/sessions/usage REST, better-sqlite3 (WAL) with numbered migrations + 5 seeded template agents, provider keyring via env injection, model listing with cache, live connection test probe, AI SDK v7 chat seam + single-agent turn runtime, fail-closed approval categorizer | `agent-core/src/` |
| **Canonical domain types** — AgentRecord (providerId, visionModel), RunMode `"single"\|"auto-team"\|"manual"`, SessionStatus, ApprovalDecision, MemoryPolicy, UsageRecord | `shared/src/index.ts` |
| **Rust shell integration** — sidecar lifecycle (256-bit token mint → spawn → `ACUTE_READY` parse → health poll → graceful shutdown w/ taskkill fallback), Windows Credential Manager key read + env injection (`keyring` crate) | `src-tauri/src/sidecar.rs`, `src-tauri/src/keys.rs` |
| **React frontend** — theme engine (table-driven Nova/Bento starters + CSS-var bridge), app shell, Agents registry CRUD, Sessions chat with streaming-style turn rendering + usage lines + error banners, Dashboard with real usage data, first-run setup wizard (4 steps incl. Plug-your-brain provider flow), demo-data fixture mode | `src/` |
| **Sidecar black-box E2E suite** — 6 tests against the built dist over real HTTP (health/auth/migration-seed/CRUD/session-create/provider-test) | `tests/e2e/sidecar.e2e.test.mjs` |
| **License audit hardened** — now walks ALL workspace packages (root + agent-core + shared); parses SPDX OR-expressions; report regenerated at 107 prod deps, CLEAN | `scripts/license-audit.mjs`, `docs/compliance/dependency-licenses.md` |
| **Docs & ADRs** — ARCHITECTURE + API reconciled to built reality; SETUP/DEMO runbooks; ADRs 0006–0013; superseded ADR-0004 draft removed (one file per number again) | `docs/` |

## 2. Acceptance checklist

Phase exit criterion (**plan-phase-2.md**): *the owner creates an agent in the UI and completes one conversation with it.*

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Owner creates an agent in the UI and completes a live conversation | **PASS** | Owner walkthrough: "Everything is working properly… UI looks much better"; reply came from `stealth/ox-alpha` via his OpenRouter key |
| 2 | Live provider round trip (no mocks) | **PASS** | Scripted round trip: model replied exactly `ACUTE-CODE LIVE ROUND TRIP OK`; usage 113→46 tok recorded in SQLite |
| 3 | Shell spawns sidecar securely | **PASS** | Spawn contract test: env token → ready line → auth wall rejects unauthenticated → Credential-Manager key injected as env only |
| 4 | SQLite migrations + template seeds on first boot | **PASS** | Fresh-DB E2E asserts 5 templates present; `%APPDATA%\acute-code\acute.db` created on owner's machine |
| 5 | Full verify pipeline green locally | **PASS** | `pnpm verify` exit 0: lint + typecheck + **143 unit tests** + build + license audit + **6 E2E tests** |
| 6 | CI green on GitHub | **PASS** | Actions run on `3265ddd`: completed **success** (verify + cargo check) |
| 7 | License policy enforced across all shipped JS deps | **PASS** | Workspace-wide audit: **107 production dependencies, CLEAN** (gap fixed this close-out: audit previously covered only the frontend root package) |
| 8 | `cargo check` green (shell compiles) | **PASS** | CI job success; local check green earlier |
| 9 | UI fidelity acceptable to owner | **PASS** | Two polish rounds delivered and approved ("everything looks quite good to me now… properly adaptable") |

## 3. Demo instructions

See `docs/runbooks/DEMO.md` — ≤2 minutes: `cargo run` in `src-tauri/`, create an agent (provider `openrouter`, model `stealth/ox-alpha`), send a message, watch the live reply with its token-usage line.

## 4. Performance vs budget

| Metric | Target | Measured |
|---|---|---|
| Cold start | <5 s | **Not yet instrumented.** Owner's walkthrough felt instant after first build, but no stopwatch numbers recorded. |
| Idle memory (shell+UI+sidecar) | <700 MB | Not yet instrumented. |
| Memory with 5 agents | <2.5 GB | Not applicable yet (multi-agent lands in Phase 3). |

Instrumented measurement is queued as open question Q1 below (recommended: capture at Phase 3 kickoff with a repeatable script).

## 5. Assumptions & ADRs accepted this phase

| ADR | One-liner |
|---|---|
| 0006 | Fastify 5 as the sidecar HTTP framework |
| 0007 | better-sqlite3 (synchronous, WAL) as the sole SQL layer |
| 0008 | Per-launch bearer token minted by the shell, injected via env |
| 0009 | **[ASSUMPTION]** Sidecar ships as bundled Node (SEA-style single executable) pending packaging spike in Phase 5 |
| 0010 | Append-only session event log (messages immutable; failures recorded, never rewritten) |
| 0011 | Agent runners execute in-process inside the sidecar |
| 0012 | Heavy builds/CI run on GitHub Actions; local builds only for debugging/demos |
| 0013 | **[ASSUMPTION]** Vercel AI SDK v7 with `@ai-sdk/openai-compatible` is the only provider path in v1; native Anthropic/OpenAI adapters are fixture-tested until keys exist |

Also ratified-by-use (smaller scope, tagged in code/docs): SPDX OR-expression parsing in the license audit; failed-turn sessions stay resumable and are never silently rewritten; `shouldRunSetup()` treats a missing flag as "wizard not yet done" (key state shown inside the wizard rather than gating it).

## 6. Deferred & known issues

- **WS streaming deferred to Phase 3** (per plan): today the chat view refetches after each turn instead of streaming over the websocket; API contract for WS already documented (ADR-0008 first-message auth frame).
- **Native provider adapters are fixture-only** — dev/testing runs on OpenRouter (`stealth/ox-alpha` only) per owner directive.
- **Rust-side license audit (cargo-deny) not yet in CI** — JS audit is complete; Rust crates spot-checked manually so far. Queued for Phase 3 CI.
- **Approval-gate modal round-trip is Phase 3 work** — the fail-closed categorizer exists and is tested; the interactive approval UI does not exist yet.
- **Performance instrumentation missing** (see §4).
- Cosmetic: vite chunk-size warning (>500 kB vendor chunk) — harmless for a Tauri-bundled app; revisit at packaging phase.

## 7. Open questions

1. **[NON-BLOCKING] When should we capture formal perf numbers?** (a) Phase 3 kickoff with a repeatable measure script committed to the repo, or (b) before you sign this gate. *Recommended default: (a)* — nothing in Phase 2 scope depends on them.
2. **[NON-BLOCKING] Ratify [ASSUMPTION] ADR-0009** (bundled-Node sidecar, final packaging proof deferred to Phase 5). *Default: ratify.*
3. **[NON-BLOCKING] Ratify [ASSUMPTION] ADR-0013** (AI SDK v7 openai-compatible as v1's only live provider path). *Default: ratify.*
4. **[NON-BLOCKING] Add cargo-deny (Rust dependency license audit) to CI in Phase 3?** *Default: yes* — closes the last licensing blind spot.
5. **[BLOCKING] Approve the Phase 2 gate and authorize starting Phase 3 (Orchestration Engine)?** Scope preview: multi-agent run loop, shared message bus, task board events, live approval-gate modal + audit log, auto-team composition, WS streaming. Exit demo: 3-agent coding task (Planner→Coder→Reviewer) + 2-agent research task, watched live.

---

*Report facts as measured: all PASS rows above were observed green this session (`pnpm verify` exit 0; GitHub Actions run `3265ddd` = success; live round trip transcript in session log).*
