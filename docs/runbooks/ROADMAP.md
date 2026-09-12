<!-- last-reviewed: 2026-09-12 round-94 -->
# ROADMAP — milestones per pillar

Statuses: `done` · `in-flight` · `queued` · `owner-gated` (do not start
without an explicit owner verdict). Refreshed every round; HANDOFF §9 points
here. Last refreshed: round-85 (2026-09-10, the structure re-assessment —
unfrozen from a round-75 freeze); the per-round truth lives in `CHANGELOG.md` +
`ui-iterations/README.md`.

## Phase ladder

| Phase | Scope | Status |
|---|---|---|
| P0 | Research (10 reference analyses) | **done** (owner-approved) |
| P1 | Architecture skeleton + sidecar + CI | **done** |
| P2 | App + UI (wizard rounds 1–7 approved, R8 shell) | **done**; Phase-2 ADR ratifications still queued |
| MVP | Agentic coding M1–M4 (projects, tools, chat UI, live proof) | **done** (rounds 9–16); owner review continuing |
| P3 | Orchestration engine (see SPEC F3 + `PILLARS.md` §7 steps ②③) | **shipped progressively** (delegation + sub-agents R36–R43, approval engine ADR-0024 R37, streamed children R50, stop/replay R58 — the Kanban bus/auto-team topology of SPEC §F3 remains queued) |
| P4+ | Packaging/exe, distribution | queued (ADR-0003 direction) |

## Pillar 1 — Coding workbench (the product's core loop)

- done: setup wizard (R1–R7) · shell/Settings hub (R8) · project-chat on live
  data (R9) · 7 sandboxed file tools + demo-parity UI (R14) · fullscreen chat
  + OS folder dialog + plug-and-play agent (R15) · **SSE live streaming,
  per-reply stats, ctx meter + model picker, borderless redesign** (R16) ·
  design system (R16) · tool-name truth + allowlist enforcement (R17) ·
  model management (R19-R20) · Kilo-parity toolset (R24-R27) · the R70-R73
  agent brain + skills + modes stack · the R77-R80 field-report + reliability
  rounds · the R81 unified operating modes · the R82 models/providers
  hardening · the R83 honest token/context metering
- queued (structural, per the R85 audit): the frontend seams (Wave 3 — the
  api.ts split, the stream-event handler registry, the god-component
  decompositions) · sessions-per-project list/switcher · code panel syntax
  themes
- **owner-gated**: dashboard/home redo (owner verdict: "way too simple / rigid")

## Pillar 2 — Agentic system (multi-agent orchestration)

- done: design groundwork (`PILLARS.md`, `research/` synthesis, ADR-0001/0011);
  delegation-as-tool + child sessions + approval round-trip + 5-slot
  semaphore (R36–R52); the R71–R75 reliability layers (error classification,
  overflow recovery, the retry ladder, mode enforcement); **delegate_task
  task_id/background/resume SHIPPED (R79, ADR-0028)**; the unified modes
  (R81, ADR-0029); the R84 modularity round (the 25-file SCC dead + the
  server.ts split, 57%)
- queued: Wave 2-b the turn-loop harness extraction (risk #1 per R85) ·
  finishing the server.ts split (52 routes) · the R86+ scoping decision ·
  SSE push (WS never shipped)

## Pillar 3 — Automation platform (n8n class)

- done: n8n research trio (`research/n8n/`) · blueprint (`PILLARS.md` §7)
- queued (owner-gated): workflows table + manual runs → data nodes → agent
  nodes → schedule trigger → canvas UI (PILLARS §7 steps ④–⑦; zero code yet)

## Cross-cutting

- done (R19): model management (providers, models, pricing, keys, testing, hiding) + dashboard v2 (light, multi-file, GH Pages) + folder dialog .ps1 fix
- done (R17): governance docs (WORKFLOW/ROADMAP/TESTING/SECURITY/docs index),
  ADR backfill 0014–0021, IMPLEMENTED-API, PILLARS.md, public dashboard
- done (R85): the structure re-assessment — the R80.5/R85 modularity audits
  + all normative docs re-synced to the post-R84 reality
- queued: Phase-2 ADR ratifications · cargo-deny for Rust deps in CI ·
  native provider adapters stay fixture-only until keys · approval-decision
  metadata wrapper · `UsageRecord.costSource` · API.md reconciliation to
  planned-vs-implemented split (started; finish when touching routes) ·
  the Wave-1 leftovers (22 SQL leaks into storage/, the benign registry↔mcp
  2-cycle, the 559-line dead sessions/ directory, ReminderBudget,
  docs:check gating) · the DeepSeek round-2 candidates (C2 per-tool timeoutMs
  the top pick)

## Changelog (one line per round, newest first)

- R18–R75: see `CHANGELOG.md` (one entry per version) and `docs/README.md`'s
  round index — this list is not duplicated here by design.
- R17: governance round — docs/ADRs/blueprints/dashboard + tool-truth fixes
- R16: live streaming + stats + borderless chat + Acute rename + design system
- R15: owner-verdict fixes — dialog, fullscreen, plug-and-play, centering
- R14: agentic coding system (folder picker, 7 tools, demo-parity, P1 proof)
- R11–13: launcher (CRLF, auth, token-in-URL) working on the owner's PC
- R10: project-chat port (M3) + live ACUTEST proof (M4)
- R8: shell redo, Settings hub, honest connection test
- R1–R7: setup wizard, owner-approved screen by screen
