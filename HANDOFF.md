# ACUTE-CODE — Agent Handoff Document

**Last updated:** 2026-08-22 (Phase 2 close-out pushed, CI green) · **Maintained by:** the orchestrator agent · **Audience:** any AI agent (or human) taking over development

You are picking up **ACUTE-CODE**, a local-first, closed-source multi-agent engineering workbench for Windows. This file gives you everything needed to continue: state, rules, environment, gotchas, and next steps. It contains **no secrets** — secrets live only in Windows Credential Manager (§7).

**This repository is self-contained.** You received the repo URL + credentials and cloned it — everything you need is in this tree: the operating rules (`AGENTS.md` at repo root), the orchestrator's workflow skills (`.agents/skills/` — they become invocable if you open this repo as your workspace), the owner's UI design demos (`design/demos/`), and all product code and docs. Clone → read §1 → work.

---

## 1. Read this first (in order)

1. This file, fully.
2. `AGENTS.md` (workspace root, one level above the repo) — the operating rules. If you only have the repo, the same rules are condensed in §5 below.
3. `docs/specs/SPEC.md` — master requirements (owner-approved).
4. `docs/architecture/ARCHITECTURE.md` + `docs/architecture/api/API.md` — the design truth (52 API operations).
5. `docs/decisions/` — ADRs 0001–0013 (never renumber; continue at 0014+).
6. `docs/runbooks/plan-phase-2.md` (what just finished) and `docs/research/README.md` (nine reference-project analyses + synthesis).

## 2. Product in one paragraph

ACUTE-CODE (NOT "Forge" — the brief's old codename) is a Windows desktop app: **Tauri 2 (Rust) shell + React 18/TS frontend + Node/TS sidecar ("agent-core") that exclusively owns SQLite (WAL) and serves localhost REST+WS**. "Local-first" = all processing on-device; LLMs are cloud APIs only. It orchestrates up to 5 concurrent agents (templates: Planner, Researcher, Coder, Reviewer, Tester) in three run modes — **single-agent (default)**, **auto-team** (cheap orchestrator model delegates to a powerful worker), **manual** (advanced). No sandbox in v1, so the **human-approval engine is the security boundary**. Providers: Anthropic/OpenAI/Google (fixture-tested only — no keys) + OpenRouter (live) + custom OpenAI-compatible. Owner runs it as a portable folder with an exe (ADR-0003). Budget: <700 MB idle, <2.5 GB with 5 agents, cold start <5 s.

## 3. Exact current state (2026-08-23, agent-handoff snapshot)

**The setup wizard is COMPLETE and owner-approved (UI rounds 1–7, all logged in `docs/ui-iterations/`). Rounds 8 redid the shell (topbar deleted; sidebar = Dashboard/PROJECTS/Usage/Settings; Settings hub with Appearance/Agents/API/Advanced) and fixed the connection test to be honest. The Agentic Coding MVP (`docs/runbooks/plan-agentic-mvp.md`) is now feature-complete pending owner review: M1 (projects backend + REST + tree/file endpoints), M2 (path-sandboxed file tools wired into the agent turn loop), M3 (project-chat UI ported onto live data at `/project/:id/chat`) and M4 (live ACUTEST run — files verified on disk) are all delivered and recorded in `docs/ui-iterations/round-09.md`. The M4 live run also exposed and fixed a latent M2-era bug: tool schemas must be wrapped in `jsonSchema()` for AI SDK v7 (`agent-core/src/tools/index.ts`). The next agent picks up at: owner review verdicts on the project-chat screen, then Phase 3 upon explicit approval.**

| Item | State |
|---|---|
| Phases 0–2 | **DONE, owner-approved** (Phase-2 report in `docs/runbooks/review-phase-2.md`) |
| UI fidelity | Wizard rounds 1–7 APPROVED; round 8 (shell/dashboard/Settings/mono) delivered — owner reviewing |
| Agentic MVP | **M1–M4 DONE** (migration 0003, `/api/v1/projects` CRUD + `/tree` + `/file`, file tools sandboxed to project root, `tool.use` audit events, Tauri `pick_folder`; M3 project-chat UI at `/project/:id/chat` + Add Project on backend + `projects-store.ts` deleted; M4 live run verified on disk) — **awaiting owner review** (`round-09.md`) |
| Tests | `pnpm verify` green: lint + typecheck + **175 unit + 6 sidecar-E2E** + build + license audit (107 prod deps, CLEAN); `cargo check` green on CI |
| Dev stack | `pnpm dev:full` = sidecar on 127.0.0.1:5178 (OpenRouter key auto-read from Credential Manager) + vite. Plain `pnpm dev` = UI only, NO backend. Dev CLI: `node scripts/acute.mjs <cmd>` |
| **Git remote** | `https://github.com/testplay-byte/ACUTE-CODE` (PRIVATE — verify before any push). **Fully synced: remote tip = `98abfde`, CI GREEN**. Clone and confirm `git log --oneline -1` shows `98abfde` or newer. |
| Working copy (previous agent) | `C:\Users\khurr\Desktop\ZCODE\ACUTE_CODE\acute-code` (branch `main`) — the new agent clones fresh from GitHub |
| Design demos (owner's) | **Backed up in-repo at `design/demos/`** — `acute-agent-ui` (wizard, DONE), `acute-agent-dashboard` (dashboard), `project-chat` (the coding UI to port for M3 — the normative spec) |

## 4. Repo map (every path has a purpose — anti-drift rule §13)

```
acute-code/
├── HANDOFF.md              ← this file
├── AGENTS.md (workspace, ../)  operating rules — phase gates, question protocol, hard rules
├── docs/
│   ├── specs/SPEC.md           master requirements (F1–F11 features)
│   ├── architecture/ARCHITECTURE.md + api/API.md   design truth
│   ├── decisions/0001–0012 + TEMPLATE.md           ADRs (sequential, never reused)
│   ├── research/<9 projects>/  verified reference analyses + README synthesis
│   ├── design/ui-direction.md  owner's design language from his demos
│   ├── runbooks/SETUP.md, plan-phase-{0,1,2}.md, plan-ui-fidelity.md, review-phase-1.md, DEMO.md (later)
│   └── compliance/dependency-licenses.md  generated by the audit — do not hand-edit
├── agent-core/             Node sidecar — owns SQLite; Fastify 5; the ONLY SQL lives in src/storage/
│   ├── src/main.ts         entry: reads ACUTE_TOKEN + ACUTE_DB_PATH env → startServer
│   ├── src/server.ts       routes (health, agents, providers, sessions), bearer auth, error envelope
│   ├── src/storage/        better-sqlite3 (WAL), numbered migrations in src/storage/migrations/
│   ├── src/providers/      keyring (env ACUTE_PROVIDER_<ID>), model listing w/ cache
│   ├── src/agents/         chat seam (aiSdkChat) + single-agent turn runtime
│   ├── src/approvals.ts    fail-closed categorize() (denylist → destructive → safelist → confirm)
│   └── tests/              vitest; AI SDK mocked — NEVER live calls in tests
├── shared/                 canonical domain types (RunMode "single"|"auto-team"|"manual", AgentRecord, …) — code conforms to these
├── src/                    React 18 frontend (root package). Shell + Agents registry + Sessions chat, theme system, demo-data fixture mode
├── src-tauri/              Rust shell. src/sidecar.rs = lifecycle: token mint, spawn, ready-line, health poll, shutdown (taskkill fallback), Credential-Manager key injection
├── scripts/license-audit.mjs  fails on GPL/unknown; walks ALL workspace packages (root+agent-core+shared); parses SPDX OR expressions
├── scripts/credential.ps1  read/write Windows Credential Manager entries (no secrets inside)
├── tests/e2e/              sidecar black-box E2E suite (6 tests vs built dist; skips when dist absent)
└── .github/workflows/ci.yml  windows-latest: pnpm verify + cargo check (heavy builds belong HERE, not the owner's PC — ADR-0012)
```

## 5. Operating discipline (violating these gets work rejected)

- **Phase gates.** Phases 0–6 each end with an owner report (deliverables, pass/fail acceptance checklist, ≤2-min demo, assumptions/ADRs, open questions) and explicit approval. **Never start the next phase without approval.** Currently waiting on: explicit Phase 2 gate approval → Phase 3.
- **Spec before code.** No implementation outside the approved SPEC/ARCHITECTURE. Scope changes need an ADR (STATUS: PROPOSED) + owner approval.
- **ADR discipline.** Every non-trivial decision → `docs/decisions/NNN-*.md` (Context → Options → Decision → Consequences). Smaller-scope assumptions → tag `[ASSUMPTION]`, surface in the next report.
- **Sub-agent protocol.** The orchestrator dispatches Researcher/Planner/Architect/Developer/Reviewer/Tester/Scribe sub-agents and integrates; it doesn't hand-write large implementation code (focused fixes may be done inline — owner prefers that for small tasks). Every sub-agent returns: what it did / artifacts / open questions. Review failures go back to the producer. **Concurrency: a burst of 9 gets trimmed by the platform; 4 concurrent dispatches verified working — launch in small batches (≤4), prefer inline work unless the task is big.**
- **Question protocol.** Batch once per phase, numbered, `[BLOCKING]`/`[NON-BLOCKING]`, each with a recommended default, max 10. Check docs before asking.
- **Hard rules.** Dependency licenses: MIT/Apache-2.0/BSD/ISC/MPL-2.0 ONLY — GPL/AGPL/LGPL forbidden (closed source); no LICENSE file; nothing published to public registries. Secrets ONLY in Windows Credential Manager — never in repo/logs/transcripts/errors. No telemetry. The approval engine is security-critical: complete, unbypassable, denylist-supreme, fail-closed, no "always allow" for destructive categories.
- **Owner communication.** Notify via **ntfy.sh** after every completed task/key milestone: `curl -d "<short, secret-free message>" https://ntfy.sh/TASKISDONE`. He communicates in long section-by-section messages; answer completely; **never rush or skip** ("do not rush anything"). **Test everything hands-on yourself** — he expects the orchestrator to run the app, not just dispatch a Tester. He will iterate on UI design ("adjusting here and there") — build for easy restyling.

## 6. First tasks for you, in order

1. **Confirm you have current code**: `git log --oneline -1` → must be `98abfde` or newer (pull if behind). If your machine lacks push credentials, store the PAT the owner gives you:
   ```bash
   git config --global credential.https://github.com.helper ""          # clear inherited GCM for this host
   git config --global credential.https://github.com.helper wincred     # GCM itself special-cases github.com to OAuth and silently discards PATs — wincred works
   printf "protocol=https\nhost=github.com\nusername=testplay-byte\npassword=<THE_PAT>\n\n" | git credential approve
   ```
   Keep the remote in the username-embedded form (`https://testplay-byte@github.com/testplay-byte/ACUTE-CODE.git`) — username-scoped lookup is what makes wincred reliable. (On the owner's machine the PAT may already be stored — test with a `git pull` first.)
2. **Verify repo visibility is PRIVATE** (`curl -H "Authorization: Bearer <PAT>" https://api.github.com/repos/testplay-byte/ACUTE-CODE | grep private`) — closed-source product; if public, `PATCH` it `{"private":true}` before pushing.
3. **Confirm the environment** (§8) and run `pnpm verify` + `cargo check` yourself — you must see green with your own eyes. Every push triggers CI; keep it green.
4. **Pick up after the owner's round-09 verdicts** (`docs/ui-iterations/round-09.md`): M3+M4 are delivered — the project-chat screen (`/project/:id/chat`), the Add Project rewire (`pick_folder` under Tauri, browser text fallback) and the live ACUTEST proof are all recorded there with screenshots and the `[ASSUMPTION]` scope list (TodoPanel / thought blocks / real diff bodies deferred). The owner tests everything himself and gates UI one screen at a time; never infer approval from praise.
5. After the MVP: **Phase 3 orchestration** (§9) — only on explicit owner approval.

## 7. Secrets (exact locations — never write them anywhere else)

| Secret | Where | Notes |
|---|---|---|
| OpenRouter API key (dev) | Windows Credential Manager on the owner's machine: `ACUTE-CODE/provider/openrouter` (user "api-key"). On a fresh machine: ask the owner for the key and store it with `powershell -File scripts/credential.ps1 Write "ACUTE-CODE/provider/openrouter" "api-key" "<key>"`. | Single allowed model: `stealth/ox-alpha` (the owner calls it "ox Alpha"; 1M ctx, 0-cost). Do NOT test other models on his key. |
| GitHub PAT | The owner hands it to you directly. Store per §6 (wincred) before pushing. | If the remote appears PUBLIC, PATCH it private before pushing anything. |

The Rust shell reads provider keys from Credential Manager at spawn and injects them as `ACUTE_PROVIDER_<ID>` env into the sidecar (`src-tauri/src/sidecar.rs`). For CLI/live testing read them with `scripts/credential.ps1` into a shell variable — **never echo the value** (printing only its length is the established pattern). API keys never appear in SQLite, REST bodies, logs, or test fixtures.

## 8. Environment facts (this machine — Windows 10 x64, 8 GB RAM)

- **Installed:** Node 24.18, pnpm 11.22 (`npm i -g pnpm`), git 2.55, WebView2 151.x, Rust 1.98 stable-msvc (`%USERPROFILE%\.cargo\bin` — export PATH in Git Bash shells), VS Build Tools 17.14 (VCTools).
- **Everyday:** repo root → `pnpm install`, `pnpm verify` (the local gate = exactly CI), `pnpm dev` (Vite UI only). Rust: `cargo check --manifest-path src-tauri/Cargo.toml` — full builds belong on GitHub Actions (ADR-0012; the owner corrected us once for compiling locally).

**Hard-won gotchas (each cost real debugging time):**
- `pnpm 11` blocks dependency postinstall scripts; allow them in `pnpm-workspace.yaml` `allowBuilds:` (currently `esbuild`, `better-sqlite3`). A stale blocked state breaks EVERY `pnpm <script>` — fix by deleting `pnpm-lock.yaml` + `node_modules` and reinstalling.
- `cmd | tail` hides exit codes — always check `${PIPESTATUS[0]}`.
- Node ESM: relative imports inside `agent-core/src` MUST end `.js` (extensionless passes vitest but the built dist won't boot).
- Sub-agent failures: "user concurrency limit exceeded" (max 2 running) and transient "Model request failed"/"captcha verify failed" — just retry; keep dispatches small; if an agent dies at 95%, finish the integration yourself.
- Tauri on Windows needs `src-tauri/icons/icon.ico` even with bundling disabled.
- Git Bash kills don't always take node children down — check `tasklist` for orphans after sidecar tests (`taskkill //F //PID <pid>`).

## 9. What's next: owner review of the MVP (round-09), then Phase 3 — Orchestration engine (after owner approval)

**IMMEDIATE:** the owner reviews the delivered project-chat screen + round-09 assumptions; the M4 loop can be re-confirmed on Windows/`C:/Users/khurr/Desktop/ACUTEST` at his convenience (identical code path — the takeover agent ran it from a Linux sandbox with the key via `ACUTE_PROVIDER_OPENROUTER` env and a substituted ACUTEST path; deviations are documented in round-09 §Environment note). The full owner vision (three products: coding env + agentic system + n8n-class automations) is recorded in `docs/architecture/PROJECT-MAP.md` §1/§6.

Phase 3 scope per SPEC §F3 + ADR-0001 (read `docs/research/README.md` synthesis §4 first — delegation-as-task-tool is the proven pattern): multi-agent run loop; shared message bus (typed pub/sub, MetaGPT pattern); Kanban task board events; **approval-gate engine live** (modal round-trip, audit log, denylist-supreme, 15-min deny-on-expiry default, remembered grants for non-destructive); the three run modes with auto-team composition; WS streaming (`@fastify/websocket` — first-message auth frame per ADR-0008; replaces today's refetch-after-turn). Exit demo (owner watches live): 3-agent coding task (Planner→Coder→Reviewer) + 2-agent research task.

**Also queued:** ratify Phase 2 assumptions (ADR list in the Phase 2 report — SPDX OR-expression audit parsing, failed-turn session semantics); `cargo-deny` license audit for Rust deps in CI; native provider adapters remain fixture-only until keys exist; approval-decision metadata wrapper type; `UsageRecord.costSource` provenance field.

## 10. Quick reference

- Verify pipeline: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm license:audit` (= `pnpm verify`).
- Live-test pattern: boot `ACUTE_TOKEN=t ACUTE_DB_PATH=<tmp> ACUTE_PROVIDER_OPENROUTER=$(read from Credential Manager) node agent-core/dist/main.js`, parse `ACUTE_READY {"port":N}` from stdout, curl with `Authorization: Bearer t`.
- The sidecar never lists keys (`hasKey` boolean only); unknown commands categorize to `confirm` (fail-closed); template agents can't be deleted (409).
- CI: `.github/workflows/ci.yml` — windows-latest, Node 24 + pnpm cache + Rust stable, runs `pnpm verify` + `cargo check`.

Good luck. The project is in a clean, fully verified state — everything claimed green was observed green.
