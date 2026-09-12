<!-- last-reviewed: 2026-09-12 round-93 -->
<!-- Canonical copy of the workspace operating rules (backed up from ACUTE_CODE/AGENTS.md). When this repo is opened as a ZCode workspace, this file loads as instructions. Paths written as "acute-code/" refer to THIS repo's root. -->
# ACUTE-CODE — Workspace Operating Rules

ACUTE-CODE (not "Forge") is a local-first, closed-source Windows desktop app: an extensible multi-agent engineering workbench. "Local-first" means all processing happens on-device; models are cloud APIs only (no local models in v1).

Stack (fixed, changes need owner approval): Tauri 2 (Rust) shell · React 18 + TypeScript UI (Tailwind, shadcn/ui, Zustand, TanStack Query) · Node/TS agent-core sidecar owning SQLite, serving localhost REST + SSE · Vercel AI SDK provider layer · pnpm workspaces.

## Working discipline

- **Spec before code.** No implementation code before the phase's spec is approved by the owner.
- **Phase gates.** Phases 0–6 each end with a report (deliverables, pass/fail acceptance checklist, ≤2-min demo, assumptions/ADRs, open questions) and explicit owner approval. Never start the next phase without it.
- **ADR discipline.** Every non-trivial decision gets `docs/decisions/NNN-*.md` (Context → Options → Decision → Consequences). Smaller-scope assumptions get `[ASSUMPTION]` tags and are surfaced in the next report.
- **Workflow.** `docs/runbooks/WORKFLOW.md` is the normative session spine (branch policy, gates, doc duties); `docs/README.md` indexes all documentation.
- **Sub-agent protocol (owner revision, 2026-08-23).** Sub-agents are an OPTIONAL tool, never a default. Dispatch one only when the task genuinely warrants it — e.g. large parallel research sweeps or exploration across many files — and the orchestrator first checks whether doing the work inline would be simpler and safer. Implementation work is normally done inline by the orchestrator; do not force dispatches, do not hand off work a sub-agent doesn't need to do. When a sub-agent IS used, it returns: what it did, artifacts, open questions; review failures go back to the producer.
- **Question protocol.** Batch questions once per phase, numbered, labeled `[BLOCKING]`/`[NON-BLOCKING]`, each with a recommended default, max 10. Check docs first — don't ask what's already answered.

## Hard rules

- License allowlist for dependencies: MIT, Apache-2.0, BSD, ISC, MPL-2.0. GPL/AGPL/LGPL forbidden (closed-source product). No open-source LICENSE file in the repo; nothing published to public registries.
- Secrets live only in the custody surface appropriate to the context (packaged app: Windows Credential Manager/DPAPI; owner launcher: local `credentials.txt` + isolated 0600 store; dev sandbox: 0600 files outside any repo) — never in the repo, logs, transcripts, error messages, or REST bodies. Details: `docs/runbooks/SECURITY.md`.
- The human-in-the-loop approval engine is the security boundary (no sandbox in v1): it must be complete, unbypassable, and never offers "always allow" for destructive categories.
- No telemetry or crash reporting unless the owner opts in.
- Performance budget: <700 MB idle (shell+UI+agent core), <2.5 GB with 5 agents, cold start <5 s. Max 5 concurrent agents, queued beyond.
- Orchestration defaults: single-agent mode by default; auto-team mode where a cheaper orchestrator model composes and delegates to a powerful worker; manual team as advanced option. See ADR-0001.
- Dev/testing runs against the owner's OpenAI-compatible API keys (no native Anthropic/OpenAI keys available); native adapters are built to spec and fixture-tested.

## Map

Product repo: `acute-code/` (this workspace). Documentation index: `docs/README.md`. `docs/specs/SPEC.md` = master requirements · `docs/architecture/` = design · `docs/decisions/` = ADRs · `docs/research/` = reference analyses · `docs/runbooks/` = SETUP/DEMO/plans · `docs/compliance/` = license audit · `docs/design/ui-direction.md` = owner's design language from demos. The owner will iterate on UI design during Phase 2+.

## Notifications & infrastructure

- **After every completed task or key milestone, notify the owner via ntfy.sh**: `curl -d "<short message, no secrets>" https://ntfy.sh/TASKISDONE`.
- **Heavy lifting goes to GitHub Actions** (ADR-0012): repo `testplay-byte/ACUTE-CODE` (PRIVATE), token in Windows Credential Manager via wincred helper (`git:https://testplay-byte@github.com`), remote URL embeds the username. Local cargo/builds only for debugging CI failures; `pnpm verify` locally is the fast pre-push gate.
- Provider API keys live in Windows Credential Manager under `ACUTE-CODE/provider/<providerId>`; dev testing uses OpenRouter (the free default `z-ai/glm-5.2:free`, R43+ — `stealth/ox-alpha` is dead).
