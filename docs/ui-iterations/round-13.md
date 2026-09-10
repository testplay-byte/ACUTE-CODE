<!-- last-reviewed: 2026-09-10 round-83 -->
# Round 13 — Governance: planning, documentation, ADRs, workflow, blueprints, public dashboard (2026-08-23)

**Owner direction:** "we have not set up our proper planning… proper
documentation… proper ADRs… let's create proper blueprints… a proper folder
structure and rules… utilize multiple sub-agents to analyze your work… don't
trust sub-agents blindly" + a visual GitHub Pages dashboard (style ref: the
owner's ANI-KUTA site). Session number R17; round file 13 (mapping noted per
WORKFLOW).

## 1. Sub-agent audits (4, per owner instruction — findings VERIFIED first)

Four read-only Explore auditors ran in parallel (docs-vs-reality, pillars
architecture, workflow discipline, dashboard security). Their five
load-bearing claims were spot-verified against code before acting — all
true: dead `TOOL_NAMES` list (real tool names 400'd), `allowedTools` never
enforced, API.md documents a WS gateway + port 8765 that don't exist, CI
runs main+PR only, HANDOFF §5 still awaited Phase-2 approval. Full reports:
worklog G1-a…G1-d.

## 2. Real product bug fixed (found by the audit — ADR-0019)

Tool-name truth: `TOOL_NAMES`/frontend `TOOL_CATALOG` now equal the REAL
7-tool set; server validation accepts reality and rejects SPEC-era names;
`buildProjectTools(root, allowedTools?)` enforces the agent allowlist
(empty = ALL); template seeds + form defaults aligned; drift-guard tests
pin both catalogs. (A reviewer agent can now honestly be denied write
access — precondition for delegation.)

## 3. Governance documentation (the ask)

- **`docs/README.md`** — the documentation index + binding folder-structure
  rules (12 rules).
- **`docs/runbooks/WORKFLOW.md`** — the session spine: start ritual, round
  cadence, branch policy (ADR-0020), implementation loop, per-round
  documentation duties, merge/CI/ntfy checklist, question protocol.
- **`docs/runbooks/ROADMAP.md`** — per-pillar milestones with statuses
  (done/in-flight/queued/owner-gated) + changelog; HANDOFF §9 points here.
- **`docs/runbooks/TESTING.md`** — the five verification layers with
  mandatory-when rules, the fresh-DB journey gate, live-battery and
  browser-verification recipes (promoted from 35 memory lessons).
- **`docs/runbooks/SECURITY.md`** — posture: loopback+bearer, path
  containment, allowlist, per-surface secrets custody, dashboard denylist,
  known gaps.
- **`docs/architecture/PILLARS.md`** — the three-pillar blueprint: one
  typed-node graph (chat = manual trigger; agent node = the existing turn
  runtime; specialized agents = delegate tool with child sessions),
  event-sourcing across pillars, storage reuse-vs-added (never
  `sessions.mode`), budget/concurrency, scheduler lifetime, additive build
  order, non-goals, and the 7 candidate ADRs required before pillar-2/3 code.
- **`docs/architecture/api/IMPLEMENTED-API.md`** — the shipped REST+SSE
  surface, verified against code (API.md now clearly aspirational).
- **ADRs 0014–0021** backfilled (SSE streaming, model override+stats,
  default agent, folder dialog, token-in-URL, tool truth, work branches,
  public dashboard) — 21 total, sequential.
- Refreshed: HANDOFF (state/header/§5), AGENTS.md (custody wording, map,
  workflow pointer), ui-iterations board (malformed row repaired).

## 4. Public dashboard (ADR-0021)

Built + security-proven: `docs/status.json` (hand-curated) →
`scripts/dashboard/build-dashboard.mjs` (zero-dep, self-contained dark-bento
page matching DESIGN-SYSTEM, **fail-closed DENYLIST** — poisoned-input
self-test blocked: private-model-id/ntfy-topic/port patterns all rejected) →
`scripts/dashboard/publish-dashboard.mjs` (token-in-URL push per ADR-0018 +
Pages enable + live-URL verify). Render VLM-verified: pillars/quality/
milestones all clean (screenshot `assets/round-13/public-dashboard.png`).
**Blocked on one owner action:** the public repo `ACUTE-DASH` exists, but
fine-grained PATs have fixed repo selection (memory #36) — owner adds the
repo to the token (or mints a dash-only PAT), then one command publishes;
the publisher prints exact instructions on 403.

## Verification

`pnpm verify` green (121 agent-core incl. 3 new drift/allowlist tests;
frontend; 6 e2e; build; license audit). Sub-agent reports verified before
use; work-branch flow per ADR-0020. Live URL pending the owner token action.

**Status: delivered (governance + blueprints + ADRs + workflow + tool-truth
fix + dashboard-ready); awaiting owner token action for the public URL.**
