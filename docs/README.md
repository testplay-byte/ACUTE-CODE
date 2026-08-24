<!-- last-reviewed: 2026-08-24 round-33 -->
# ACUTE-CODE — Documentation Index

One line per document. **Reading order for a new session:** `HANDOFF.md` →
`docs/runbooks/WORKFLOW.md` → `docs/runbooks/AGENT-MEMORY.md` → the runbook
for the task at hand. Generated files are marked; everything else is
hand-maintained. If a doc contradicts the code, the code wins for facts —
file the discrepancy and fix the doc in the same round.

## Process & memory
- [`runbooks/WORKFLOW.md`](runbooks/WORKFLOW.md) — **the session spine**: start ritual, branch policy, verification gates, per-round documentation duties, push/CI/ntfy checklist
- [`runbooks/ROADMAP.md`](runbooks/ROADMAP.md) — milestones per pillar with status (`done / in-flight / queued / owner-gated`); the single place HANDOFF §9 points to
- [`runbooks/TESTING.md`](runbooks/TESTING.md) — the five verification layers, the fresh-DB rule, live-battery and browser-verification recipes
- [`runbooks/SECURITY.md`](runbooks/SECURITY.md) — security posture: bearer/loopback, tool path containment, secrets custody per surface, launcher redaction
- [`runbooks/AGENT-MEMORY.md`](runbooks/AGENT-MEMORY.md) — numbered lessons (mistake → root cause → rule); read before any session; append-only
- [`agent/ORCHESTRATION-WORKLOG.md`](agent/ORCHESTRATION-WORKLOG.md) — session-by-session history (snapshot of the live worklog, refreshed each session)
- [`runbooks/SANDBOX-RESTORE.md`](runbooks/SANDBOX-RESTORE.md) — zero-to-resumed procedure after a sandbox wipe + the session-end backup rule
- [`runbooks/AGENT-BOOTSTRAP-PROMPT.md`](runbooks/AGENT-BOOTSTRAP-PROMPT.md) — the paste-once prompt to bootstrap a fresh agent
- [`runbooks/LOCAL-PC-RUNNER.md`](runbooks/LOCAL-PC-RUNNER.md) — the owner's one-double-click launcher
- [`runbooks/PUBLIC-DASHBOARD.md`](runbooks/PUBLIC-DASHBOARD.md) — the public status dashboard (separate repo), its allow/deny lists and publish flow

## Requirements & architecture
- [`specs/SPEC.md`](specs/SPEC.md) — master requirements (F1–F11), owner-approved
- [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) — system design truth (topology, lifecycles, key hand-off) — *partially historical; see IMPLEMENTED-API for the shipped surface*
- [`architecture/api/IMPLEMENTED-API.md`](architecture/api/IMPLEMENTED-API.md) — **the REST + SSE surface as actually shipped** (verified against code)
- [`architecture/api/API.md`](architecture/api/API.md) — the full 52-operation *planned* contract (aspirational since Phase 1; WS/planned routes live here, NOT in IMPLEMENTED-API)
- [`architecture/PROJECT-MAP.md`](architecture/PROJECT-MAP.md) — the product map & naming rules
- [`architecture/PILLARS.md`](architecture/PILLARS.md) — the three-pillar blueprint (coding / agentic system / automation) and how they interconnect additively
- [`decisions/`](decisions/) — ADRs 0001–0021 + `TEMPLATE.md`; sequential, never renumbered; next = 0022

## Design
- [`design/ui-direction.md`](design/ui-direction.md) — the owner's design language, derived from his demos
- [`design/DESIGN-SYSTEM.md`](design/DESIGN-SYSTEM.md) — living UI reference: tokens, spacing, borderless chat language, motion, anatomy, new-screen checklist
- `design/demos/` — the owner's original demos (frozen reference; never imported by product code)

## UI iteration rounds
- [`ui-iterations/README.md`](ui-iterations/README.md) — the round method + per-screen status board (owner directive 2026-08-22)
- `ui-iterations/round-NN.md` + `assets/round-NN/` — one file per owner review round with screenshots and verification evidence

## Plans & reviews (historical once the phase closes)
- `runbooks/plan-phase-0/1/2/3.md`, `plan-ui-fidelity.md`, `plan-agentic-mvp.md` — intent documents
- `runbooks/review-phase-1.md`, `review-phase-2.md` — phase close-out reports
- `runbooks/SETUP.md` — Phase-0 environment snapshot (current environment facts live in HANDOFF §8 + SANDBOX-RESTORE)
- `runbooks/DEMO.md` — demo script

## Research
- [`research/README.md`](research/README.md) — index + synthesis of the 10 reference analyses (incl. n8n for the automation pillar)
- `research/<project>/` — per project: `README.md` + `architecture.md` + `patterns-for-acute-code.md`

## Status & compliance
- [`status.json`](status.json) — hand-maintained input for the public dashboard (schema `acute-status/1`)
- [`compliance/dependency-licenses.md`](compliance/dependency-licenses.md) — **generated** by `pnpm license:audit`; never hand-edit

## Folder-structure rules (binding)
1. SQL lives only in `agent-core/src/storage/`; migrations in `src/storage/migrations/` are numbered and append-only (never edit an applied migration).
2. Unit tests: `agent-core/tests/*.test.ts` (AI SDK mocked — never live calls) and frontend suites in `src/`. Black-box E2E: `tests/e2e/` (runs against built dist).
3. `shared/` holds canonical domain types; product code conforms, never duplicates.
4. ADRs: `docs/decisions/NNN-kebab-slug.md`, zero-padded, strictly sequential, via `TEMPLATE.md`.
5. Rounds: `docs/ui-iterations/round-NN.md` (next free number; session number ≠ file number — record the mapping inside the file); screenshots in `assets/round-NN/`.
6. Research: one folder per project, always the README/architecture/patterns trio; indexed in `research/README.md`.
7. `design/demos/` is frozen owner reference — lint-excluded, never imported.
8. Scripts: repo tooling in `scripts/` (stdout = data, stderr = diagnostics). `launcher/` is owner-facing; `.bat` files must be CRLF-verified and tiny coordinators only.
9. Generated files are marked and never hand-edited.
10. Nothing secret in the repo, ever; `.dev/` DBs and `.env*` are gitignored; `.env.development` is deleted before any verify/commit.
