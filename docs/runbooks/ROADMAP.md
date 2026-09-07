<!-- last-reviewed: 2026-09-07 round-75 -->
# ROADMAP — milestones per pillar

Statuses: `done` · `in-flight` · `queued` · `owner-gated` (do not start
without an explicit owner verdict). Refreshed every round; HANDOFF §9 points
here. Last refreshed: round-17 (2026-08-23).

## Phase ladder

| Phase | Scope | Status |
|---|---|---|
| P0 | Research (10 reference analyses) | **done** (owner-approved) |
| P1 | Architecture skeleton + sidecar + CI | **done** |
| P2 | App + UI (wizard rounds 1–7 approved, R8 shell) | **done**; Phase-2 ADR ratifications still queued |
| MVP | Agentic coding M1–M4 (projects, tools, chat UI, live proof) | **done** (rounds 9–16); owner review continuing |
| P3 | Orchestration engine (see SPEC F3 + `PILLARS.md` §7 steps ②③) | **owner-gated** |
| P4+ | Packaging/exe, distribution | queued (ADR-0003 direction) |

## Pillar 1 — Coding workbench (the product's core loop)

- done: setup wizard (R1–R7) · shell/Settings hub (R8) · project-chat on live
  data (R9) · 7 sandboxed file tools + demo-parity UI (R14) · fullscreen chat
  + OS folder dialog + plug-and-play agent (R15) · **SSE live streaming,
  per-reply stats, ctx meter + model picker, borderless redesign** (R16) ·
  design system (R16) · tool-name truth + allowlist enforcement (R17)
- in-flight: owner Windows re-test of R16 (Browse dialog presentation,
  streaming feel, drag direction, stats/pickers)
- queued: sessions-per-project list/switcher · streamed-finish live chips ·
  code panel syntax themes
- **owner-gated**: dashboard/home redo (owner verdict: "way too simple / rigid")

## Pillar 2 — Agentic system (multi-agent orchestration)

- done: design groundwork (`PILLARS.md`, `research/` synthesis, ADR-0001/0011)
- in-flight: blueprint + candidate-ADR list for delegation (round-17)
- owner-gated: implementation (Phase 3): delegate tool in chat → child
  sessions → approval engine → WS push channel → run modes

## Pillar 3 — Automation platform (n8n class)

- done: n8n research trio (`research/n8n/`)
- in-flight: blueprint (`PILLARS.md` §7 build order steps ④–⑦)
- queued (after P3): workflows table + manual runs → data nodes → agent
  nodes → schedule trigger → canvas UI

## Cross-cutting

- done (R19): model management (providers, models, pricing, keys, testing, hiding) + dashboard v2 (light, multi-file, GH Pages) + folder dialog .ps1 fix

- done (R17): governance docs (WORKFLOW/ROADMAP/TESTING/SECURITY/docs index),
  ADR backfill 0014–0021, IMPLEMENTED-API, PILLARS.md, public dashboard
- queued: Phase-2 ADR ratifications · cargo-deny for Rust deps in CI ·
  native provider adapters stay fixture-only until keys · approval-decision
  metadata wrapper · `UsageRecord.costSource` · API.md reconciliation to
  planned-vs-implemented split (started; finish when touching routes)

## Changelog (one line per round, newest first)

- R17: governance round — docs/ADRs/blueprints/dashboard + tool-truth fixes
- R16: live streaming + stats + borderless chat + Acute rename + design system
- R15: owner-verdict fixes — dialog, fullscreen, plug-and-play, centering
- R14: agentic coding system (folder picker, 7 tools, demo-parity, P1 proof)
- R11–13: launcher (CRLF, auth, token-in-URL) working on the owner's PC
- R10: project-chat port (M3) + live ACUTEST proof (M4)
- R8: shell redo, Settings hub, honest connection test
- R1–R7: setup wizard, owner-approved screen by screen
