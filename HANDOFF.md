<!-- last-reviewed: 2026-09-11 round-89 -->
# ACUTE-CODE — Agent Handoff Document

**Last updated:** 2026-09-11 (round-89 DELIVERED: the owner's-verdict round — the full v0.86.0 walkthrough answered, v0.86.0 → v0.87.0. THE ABOUT/RESET FIXES: the update check runs server-side with the launcher's saved ~/.acute/github.pat (the private-repo HTTP 404 is gone), the Releases button opens the OS browser via open_external_url, and the reset now clears acute.setupDone so the app boots the SETUP WIZARD after "Reset everything" — even across a full close+reopen. THE PROVIDER IDENTITY RULES: the display NAME is the uniqueness key (the owner's "only the provider name should be different"), a keyless seeded row is ADOPTED in place when its preset is re-added (the "provider NVIDIA already exists" fresh-reset bug — the boot seed re-creates the five keyless built-ins), same-type adds derive fresh prv_<name> ids (ten OpenRouters live side by side), presets carry their API format as a read-only summary, the chat model picker lists only ADDED (hasKey) providers, and the LAST-USED MODEL (a global acute.lastModel written by every pick + every send) becomes the next chats' default. THE MODELS UI OVERHAUL: clean human model names (cleanModelName — "meta-llama/llama-3.3-70b-instruct:free" → "Llama 3.3 70b Instruct"), themed SVG capability chips (one color + icon per modality), formatTokenCount (1000000 → 1M) everywhere, the model card's dedicated details strip (Context | Input | Output | Cache read), and the test result expanding its OWN bordered section below the card (auto-collapse 5s unless read). LAYOUT HONESTY: the right sidebar's stored width clamps against the LIVE container cap (the absolute 760 ceiling silently raised the chat's minimum as the window widened — the "cannot shrink as much as before" verdict), the model pill collapses to LOGO-ONLY at the floor, the reading column's padding steps down 24→16→10px, and the bubbles can no longer overflow the card. THE AGENT HANDS (agent-core browser-hands.ts, NEW): a branded in-page SVG cursor that travels HUMAN BEZIER PATHS (bow + micro-jitter + ease) to every target, REAL pointer events at exact page coordinates (left/right/double/drag), word-by-word typing at ~150 WPM via execCommand insertText (React-visible; newlines are REAL newlines — Shift+Enter semantics, submit stays explicit, 600-char cap), smooth rAF scrolling, the JOB PROTOCOL (window.__acuteJob started by one eval; the BrowserPanel's NEW evalJob action polls every 120ms ≤25s — zero Rust changes), the 1440×900 default viewport actually APPLYING on mount (the per-tab persisted natural flag, default false), the GEOMETRIC overlay guard (the watcher records overlay rects; the webview hides only when one intersects the panel's page area — menus away from the browser no longer pause it), and the browser tool's SEARCH-FIRST + read_dom-first prompt discipline. The TodoFloat is frosted glass (backdrop blur). Full pipeline green: frontend 2,885 + agent-core 1,892 tests, e2e 12/12, license audit clean. The owner's TEST CHECKLIST lives in round-89.md §6.) · **Maintained by:** the orchestrator agent · **Audience:** any AI agent (or human) taking over development

You are picking up **ACUTE-CODE**, a local-first, closed-source multi-agent engineering workbench for Windows. This file gives you everything needed to continue: state, rules, environment, gotchas, and next steps. It contains **no secrets** — secrets live only in Windows Credential Manager (§7).

**This repository is self-contained.** You received the repo URL + credentials and cloned it — everything you need is in this tree: the operating rules (`AGENTS.md` at repo root), the orchestrator's workflow skills (`.agents/skills/` — they become invocable if you open this repo as your workspace), the owner's UI design demos (`design/demos/`), and all product code and docs. Clone → read §1 → work.

---

## 1. Read this first (in order)

1. This file, fully.
2. `docs/README.md` (the documentation index) + `docs/runbooks/WORKFLOW.md` (the session spine) — then `AGENTS.md` (workspace root, one level above the repo) — the operating rules. If you only have the repo, the same rules are condensed in §5 below.
3. `docs/runbooks/AGENT-MEMORY.md` — lessons learned & standing rules (READ BEFORE WORKING; owner-mandated 2026-08-23).
4. `docs/agent/ORCHESTRATION-WORKLOG.md` — session-by-session history; where the last session ended. Sandbox wiped? `docs/runbooks/SANDBOX-RESTORE.md` is the zero-to-resumed procedure.
5. `docs/specs/SPEC.md` — master requirements (owner-approved).
6. `docs/architecture/ARCHITECTURE.md` + `docs/architecture/api/API.md` — the design truth (52 API operations).
7. `docs/decisions/` — ADRs 0001–0029 (never renumber; continue at 0030+).
8. `docs/runbooks/plan-phase-2.md` (what just finished) and `docs/research/README.md` (nine reference-project analyses + synthesis).

## 2. Product in one paragraph

ACUTE-CODE (NOT "Forge" — the brief's old codename) is a Windows desktop app: **Tauri 2 (Rust) shell + React 18/TS frontend + Node/TS sidecar ("agent-core") that exclusively owns SQLite (WAL) and serves localhost REST+SSE (the WS gateway of the Phase-1 design was never built — SSE per-turn streams are the shipped surface)**. "Local-first" = all processing on-device; LLMs are cloud APIs only. It orchestrates up to 5 concurrent agents (templates: Planner, Researcher, Coder, Reviewer, Tester) in three run modes — **single-agent (default)**, **auto-team** (cheap orchestrator model delegates to a powerful worker), **manual** (advanced). No sandbox in v1, so the **human-approval engine is the security boundary**. Providers: Anthropic/OpenAI/Google (fixture-tested only — no keys) + OpenRouter (live) + custom OpenAI-compatible. Owner runs it as a portable folder with an exe (ADR-0003). Budget: <700 MB idle, <2.5 GB with 5 agents, cold start <5 s.

## 3. Exact current state (2026-09-10, round-86 DELIVERED — the verification + SSE-extraction round; v0.84.0)

**R86 is DELIVERED** (the owner's task-list session): the R85 claims re-verified with three parallel sweeps; **the SSE route extracted** (`agent-core/src/routes/sse.ts` — the 476-line streamed turn route moved verbatim with a byte-identical round-trip verifier; server.ts 2,439 → 1,913; eleven single-consumer imports pruned; registration order preserved; verified lint/typechecks/2,825-tests/build/e2e-12/12/license-audit + a live boot smoke); the branch cleanup done (six stale branches deleted — only `main` remains; the superseded r61 cua-helper line's tips recorded in round-86.md §4b); the stuck v0.83.0 draft release PUBLISHED; the DASHBOARD's stale plan section truth-synced. **The minimum commit to verify from is the R86 push on top of `2ff8b88`** (R85 docs close-out). Full evidence: `docs/ui-iterations/round-86.md`.

**The next queue (R87+):** the owner's scoping decision — (a) Wave 2-b, the turn-loop harness extraction (still risk #1: the 378-line sync/streamed duplication + prepareTurn's 10 positional args), (b) the remaining server.ts split — **51 routes** (terminal 8, MCP 6, computer-use 9, diagnostics 2, approvals 2, vision 3 + the 21-route unnamed tail; the SSE domain, the hardest, shipped in R86), (c) Wave 3, the frontend seams (the api.ts split — 85 importing files, the stream-event handler registry, the AgentChatPanel/ModelsProvidersTab decompositions, deleting the 559-line dead sessions/ directory), then the standing items (external plugin ctx enrichment, ratings-driven prompt tuning, edit-linting, installer code-signing, the Files-tab polish, agent web-app-testing tools) and the DeepSeek round-2 candidates (C2 per-tool timeoutMs is the top pick). Known residuals that remain: the NVIDIA NIM EOL'd functions (nothing code-side can do), the sync-path child turn.error generic text (pre-existing, out of scope).

| Item | State |
|---|---|
| Phases 0–2 | **DONE, owner-approved** (Phase-2 report in `docs/runbooks/review-phase-2.md`) |
| UI fidelity | Wizard rounds 1–7 APPROVED; round 8 (shell/dashboard/Settings/mono) delivered — owner reviewing |
| Round-16 (streaming + polish) | **DELIVERED** — SSE live streaming (text deltas + tool pills as they happen), per-reply stats (ms/in/out/tok/s) + copy buttons + ctx meter + per-send model picker, borderless tight chat UI + chat-drag fix, default agent renamed **Acute**, modern always-on-top folder dialog, `docs/design/DESIGN-SYSTEM.md`, work-branch WIP discipline (`round-12.md`) |
| Round-27 (web tools + deps fix) | **DELIVERED** — web_fetch + web_search (Kilo/Cline parity, 15 tools total); CRITICAL deps-wiring fix (todo_write + checkpoints were silently dead in real turns — now live); 14 web-tools unit tests (211 total); L4 live battery + L5 browser verification + VLM-verified screenshots; demo project (YouTube-like app, 545 lines) built BY the agent; zip uploaded to GitHub release `round-27-testing` |
| Round-17 (governance) | **DELIVERED** — docs index/WORKFLOW/ROADMAP/TESTING/SECURITY, ADR backfill 0014–0021, PILLARS.md blueprint, IMPLEMENTED-API truth doc, tool-name truth + allowlist enforcement (real bug fixed), public dashboard built (owner token action pending) |
| Round-15 (owner verdicts) | **DELIVERED** — folder dialog 2-method + error surfacing, fullscreen chat (hamburger toggles app sidebar), plug-and-play Nova agent seed (fresh DB chats out of the box), dialog centering fix (numeric proof), owner HTML scenario live-proven (`round-11.md`) |
| Round-14 (agentic system) | **DELIVERED** (OS folder-picker endpoint, 7 file tools incl. create_dir/delete-refusal/search_files, demo-parity chat UI with TopBar agent-picker/search/theme/experimental + To-Do, live P1 proof) — `round-10.md`; dashboard redo QUEUED next |
| Agentic MVP | **M1–M4 DONE** (migration 0003, `/api/v1/projects` CRUD + `/tree` + `/file`, file tools sandboxed to project root, `tool.use` audit events, Tauri `pick_folder`; M3 project-chat UI at `/project/:id/chat` + Add Project on backend + `projects-store.ts` deleted; M4 live run verified on disk) — **awaiting owner review** (`round-09.md`) |
| Tests | `pnpm verify` green: lint + typecheck + **207 tests** (incl. 6 sidecar-E2E vs the built dist) + build + license audit (107 prod deps, CLEAN); `cargo check` green on CI |
| Dev stack | `pnpm dev:full` = sidecar on 127.0.0.1:5178 (OpenRouter key auto-read from Credential Manager) + vite. Plain `pnpm dev` = UI only, NO backend. Dev CLI: `node scripts/acute.mjs <cmd>` |
| **Git remote** | `https://github.com/testplay-byte/ACUTE-CODE` (PRIVATE — verify before any push). **Fully synced: code tip = `65246ca` (Round 28 J2 docs-stamp-backfill + check-stale hardening, on top of `23ed35b` Round 28 close-out)**, CI GREEN. Clone and confirm `git log --oneline -1` shows `65246ca` or newer. |
| Working copy (previous agent) | `C:\Users\khurr\Desktop\ZCODE\ACUTE_CODE\acute-code` (branch `main`) — the new agent clones fresh from GitHub into `/home/z/PROJECT/ACUTECODE` (Linux sandbox) per `docs/runbooks/SANDBOX-RESTORE.md` (round-28 layout) |
| Design demos (owner's) | **Backed up in-repo at `design/demos/`** — `acute-agent-ui` (wizard, DONE), `acute-agent-dashboard` (dashboard), `project-chat` (the coding UI to port for M3 — the normative spec) |

## 4. Repo map (every path has a purpose — anti-drift rule §13)

```
acute-code/
├── HANDOFF.md              ← this file
├── AGENTS.md               operating rules (repo copy; the workspace original sits one level above) — phase gates, question protocol, hard rules
├── launcher/               owner's one-click local-PC entry (round-11): ACUTE.bat (CRLF coordinator) + acute.sh + acute_launcher.py (rich-UI workhorse: auto-install, update+restart, self-update; R87: the GitHub token is asked once + saved at .acute/github.pat, provider keys are saved in-app only — credentials.txt is GONE) — see docs/runbooks/LOCAL-PC-RUNNER.md
├── docs/
│   ├── agent/ORCHESTRATION-WORKLOG.md   session history snapshot (sandbox-resilience backup, refreshed each session; R76-R81 backfilled R85)
│   ├── specs/SPEC.md           master requirements (F1–F11 features)
│   ├── architecture/ARCHITECTURE.md + api/API.md   design truth · MODULARITY-ASSESSMENT.md (the R80.5/R85 structure audits)
│   ├── decisions/0001–0029 + TEMPLATE.md          ADRs (sequential, never reused; next = 0030)
│   ├── research/<9 projects>/  verified reference analyses + README synthesis + deepseek-harness-notes (R51) — the round-2 deep study lives in agent-ctx/research/
│   ├── design/ui-direction.md  owner's design language from his demos
│   ├── runbooks/  SETUP, WORKFLOW (the session spine), MAINTENANCE (recipes), MODULE-BOUNDARIES (the editing contract), EXTENSIBILITY, TESTING, SECURITY, AGENT-MEMORY (lessons), SANDBOX-RESTORE, ROADMAP, CONTEXT-METER + the phase plans
│   ├── ui-iterations/round-NN.md  per-round evidence files (1–85) + README board
│   └── compliance/dependency-licenses.md  generated by the audit — do not hand-edit
├── agent-core/             Node sidecar — owns SQLite; Fastify 5; the ONLY SQL lives in src/storage/ (known legacy exceptions documented in MODULE-BOUNDARIES §2)
│   ├── src/main.ts         entry: reads ACUTE_TOKEN + ACUTE_DB_PATH env → startServer
│   ├── src/server.ts       the ASSEMBLER (buildServer) + the 51 not-yet-extracted routes (terminal, MCP, computer-use, diagnostics, approvals, vision + the notifications/jobs/checkpoints/dialogs/plugins groups)
│   ├── src/routes/         13 domain route modules — sessions/providers/agents/projects/models/settings/attachments/memory/skills/modes/ratings/usage + sse.ts (R86, the streamed turn route; the final-phase domain of the R84 split) + context.ts + helpers.ts
│   ├── src/storage/        better-sqlite3 (WAL), 31 numbered migrations in src/storage/migrations/ (next = 0032+)
│   ├── src/providers/      keyring (env ACUTE_PROVIDER_<ID>), model listing w/ cache
│   ├── src/agents/         chat seam (aiSdkChat) + the turn runtime (runtime.ts — the Wave-2b target) + orchestrator + sub-roles leaf + prompts/prompt-registry + modes + skills glue
│   ├── src/tools/          ADR-0025 plugin registry: plugins/*.ts (14 registered) + registry.ts (loader/catalog incl. external .mjs) + index.ts (ToolDeps — the sanctioned seam)
│   ├── src/computer/       desktop automation (dispatch.ts 2,447 — the largest backend file)
│   ├── src/mcp/            MCP client manager (stdio JSON-RPC)
│   ├── src/browser-proxy.ts browser subsystem (fenced)
│   └── tests/              vitest; AI SDK mocked — NEVER live calls in tests
├── shared/                 canonical domain types (RunMode "single"|"auto-team"|"manual", AgentRecord, …) — code conforms to these
├── src/                    React 18 frontend (root package). Shell + Agents registry + project-chat + settings + right-sidebar + 13 Zustand stores, theme system, demo-data fixture mode
├── src-tauri/              Rust shell. src/sidecar.rs = lifecycle: token mint, spawn, ready-line, health poll, shutdown (taskkill fallback), Credential-Manager key injection
├── scripts/               license-audit (fails on GPL), acute.mjs dev CLI, docs/ (check-stale + stamp-all), battery scripts, dashboard publish
├── tests/e2e/              sidecar black-box E2E suite (12 tests vs built dist; skips when dist absent)
└── .github/workflows/ci.yml  windows-latest: pnpm verify + cargo check (heavy builds belong HERE, not the owner's PC — ADR-0012)
```

## 5. Operating discipline (violating these gets work rejected)

- **Phase gates & rounds.** Phases 0–6 each end with an owner report and explicit approval; between gates, owner VERDICT ROUNDS are the working cadence (one round = one cycle, `docs/ui-iterations/round-NN.md`; he gates one screen at a time). Phase 3 is owner-gated. The full process lives in `docs/runbooks/WORKFLOW.md` (branch policy, verification gates, per-round doc duties, push/CI/ntfy checklist) — follow it.
- **Spec before code.** No implementation outside the approved SPEC/ARCHITECTURE. Scope changes need an ADR (STATUS: PROPOSED) + owner approval.
- **ADR discipline.** Every non-trivial decision → `docs/decisions/NNN-*.md` (Context → Options → Decision → Consequences). Smaller-scope assumptions → tag `[ASSUMPTION]`, surface in the next report.
- **Sub-agent protocol (owner revision, 2026-08-23).** Sub-agents are an OPTIONAL tool, never a default: dispatch only when the task genuinely warrants it (large parallel research sweeps, exploration across many files) and prefer doing the work inline whenever that is simpler and safer. Focused fixes and normal implementation are done inline by the orchestrator. When a sub-agent IS used it returns: what it did / artifacts / open questions; review failures go back to the producer.
- **Question protocol.** Batch once per phase, numbered, `[BLOCKING]`/`[NON-BLOCKING]`, each with a recommended default, max 10. Check docs before asking.
- **Hard rules.** Dependency licenses: MIT/Apache-2.0/BSD/ISC/MPL-2.0 ONLY — GPL/AGPL/LGPL forbidden (closed source); no LICENSE file; nothing published to public registries. Secrets ONLY in Windows Credential Manager — never in repo/logs/transcripts/errors. No telemetry. The approval engine is security-critical: complete, unbypassable, denylist-supreme, fail-closed, no "always allow" for destructive categories.
- **Owner communication.** Notify via **ntfy.sh** after every completed task/key milestone: `curl -d "<short, secret-free message>" https://ntfy.sh/TASKISDONE`. He communicates in long section-by-section messages; answer completely; **never rush or skip** ("do not rush anything"). **Test everything hands-on yourself** — he expects the orchestrator to run the app, not just dispatch a Tester. He will iterate on UI design ("adjusting here and there") — build for easy restyling.

## 6. First tasks for you, in order

1. **Confirm you have current code**: `git log --oneline -1` → must be `c38bc8b` (R84 close-out, v0.83.0) or the R85 docs commit on top of it (pull if behind). If your machine lacks push credentials, follow `docs/runbooks/SANDBOX-RESTORE.md` (round-28 layout: `/home/z/PROJECT/ACUTECODE` + per-repo credential helpers + token-in-URL clone per lesson #24).
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
| OpenRouter API key (dev) | Windows Credential Manager on the owner's machine: `ACUTE-CODE/provider/openrouter` (user "api-key"). On a fresh machine: ask the owner for the key and store it with `powershell -File scripts/credential.ps1 Write "ACUTE-CODE/provider/openrouter" "api-key" "<key>"`. | Model: the free default `z-ai/glm-5.2:free` (R43+; `stealth/ox-alpha` is dead — see WORKFLOW §4.6). |
| GitHub PAT | The owner hands it to you directly. Store per §6 (wincred) before pushing. | If the remote appears PUBLIC, PATCH it private before pushing anything. |

The Rust shell reads provider keys from Credential Manager at spawn and injects them as `ACUTE_PROVIDER_<ID>` env into the sidecar (`src-tauri/src/sidecar.rs`). For CLI/live testing read them with `scripts/credential.ps1` into a shell variable — **never echo the value** (printing only its length is the established pattern). API keys never appear in SQLite, REST bodies, logs, or test fixtures.

## 8. Environment facts

**Two environments matter:** (a) the **Linux sandbox** where the orchestrator agent runs (this is where dev + live tests happen), and (b) the **owner's Windows 10 x64 machine** (where the launcher + packaged app run). Both are documented in `docs/runbooks/SANDBOX-RESTORE.md` (the canonical env reference — read that first).

**Linux sandbox (current dev environment):**
- Linux x64, ~2 CPUs / 4 GB RAM / ~8 GB disk; non-root user `z` (uid 1001).
- Toolchain: Node 24.18 (`/usr/bin/node`), pnpm 11.22 (via `corepack enable` — NOT pre-installed post-wipe, lesson 6-f finding), git 2.47, jq, corepack 0.35.
- No Rust toolchain: `cargo check` happens on CI only (ADR-0012).
- `api.openrouter.ai` DNS-blocked; use apex `https://openrouter.ai/api/v1` (already seeded in DB).
- Background processes die between shell invocations (lesson #4): live tests run as ONE self-contained invocation.
- CI takes ~4–6 minutes (windows-latest + cargo) — a Bash timeout that kills a polling loop is NOT a CI failure.

**Owner's Windows 10 x64, 8 GB RAM (where the launcher runs):**
- Installed: Node 24.18, pnpm 11.22 (`npm i -g pnpm`), git 2.55, WebView2 151.x, Rust 1.98 stable-msvc, VS Build Tools 17.14.
- Owner runs the app via `launcher/ACUTE.bat` (Python rich-UI workhorse + tiny CRLF-verified coordinator; token-in-URL auth per lesson #24).

**Hard-won gotchas (each cost real debugging time):**
- `pnpm 11` blocks dependency postinstall scripts; allow them in `pnpm-workspace.yaml` `allowBuilds:` (currently `esbuild`, `better-sqlite3`). A stale blocked state breaks EVERY `pnpm <script>` — fix by deleting `pnpm-lock.yaml` + `node_modules` and reinstalling.
- `cmd | tail` hides exit codes — always check `${PIPESTATUS[0]}`.
- Node ESM: relative imports inside `agent-core/src` MUST end `.js` (extensionless passes vitest but the built dist won't boot).
- Sub-agent failures: "user concurrency limit exceeded" (max 2 running) and transient "Model request failed"/"captcha verify failed" — just retry; keep dispatches small; if an agent dies at 95%, finish the integration yourself.
- Tauri on Windows needs `src-tauri/icons/icon.ico` even with bundling disabled.
- Git Bash kills don't always take node children down — check `tasklist` for orphans after sidecar tests (`taskkill //F //PID <pid>`).

## 9. What's next: the owner's R87 scoping decision — the modularity roadmap (post-R86)

The R80.5 audit's roadmap was refreshed by R85 (`docs/architecture/MODULARITY-ASSESSMENT.md` §10) and advanced by R86 (the SSE domain extracted). In priority order:

- **Wave 2-b — the turn-loop harness extraction (risk #1)**: the sync/streamed
  runners share 378 byte-identical lines (78% of the sync runner); shared retry
  ladder / loop guard / overflow recovery / error classification helpers used by
  BOTH runners, plus `prepareTurn`'s 10 positional args → an options object.
- **Finish the server.ts split**: 51 routes remain (terminal 8, MCP 6, computer-use
  9, diagnostics 2, approvals 2, vision 3 + the 21-route unnamed tail —
  notifications ×7, jobs ×4, checkpoints/snapshots ×4, dialogs ×2, plugins,
  index, keys, health). The SSE domain — the hardest, 476 lines of concurrency
  logic — shipped in R86 (`routes/sse.ts`); the rest is mechanical on the proven
  pattern.
- **Wave 3 — the frontend seams**: the api.ts split (3,959 lines/85 importing files →
  transport/types/sse/view-models with a barrel), the stream-event handler registry
  (the 687-line handleStreamEvent → event-type → handler map), the
  AgentChatPanel/ModelsProvidersTab decompositions, deleting the 559-line dead
  sessions/ directory, the external-plugin execute-time wrapper.
- **Wave 1 leftovers**: move the 22 leaked SQL statements into storage/ (approvals ×11),
  kill the benign registry↔mcp 2-cycle, delete the dead sessions/ code, wire-or-delete
  ReminderBudget, make docs:check blocking once the stamp ceremony is automated.
- **The DeepSeek round-2 candidates** (agent-ctx/research/deepseek-harness-round2.md):
  C2 per-tool declared timeoutMs with structured TOOL_TIMEOUT results (top pick),
  C3 mode-policy-as-folded-events + cache-stable narration, C4 tool-result spill.
- **The standing queue**: external plugin ctx enrichment, ratings-driven prompt
  tuning, edit-linting, installer code-signing, the Files-tab polish, agent
  web-app-testing tools.

Historical context: the Phase-3 orchestration engine (SPEC §F3 + ADR-0001) largely
SHIPPED across R36–R79 (delegation with task_id/background/resume, semaphores, the
approval engine ADR-0024, the three run modes); the PILLARS §7-4/5/6 pillars
(workflows/scheduler/canvas) remain unbuilt and owner-gated. The full owner vision
(three products) is recorded in `docs/architecture/PROJECT-MAP.md` §1/§6.

## 10. Quick reference

- Verify pipeline: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e && pnpm license:audit` (= `pnpm verify`; CI additionally runs `pnpm docs:check` first).
- Live-test pattern: boot `ACUTE_TOKEN=t ACUTE_DB_PATH=<tmp> ACUTE_PROVIDER_OPENROUTER=$(read from Credential Manager) node agent-core/dist/main.js`, parse `ACUTE_READY {"port":N}` from stdout, curl with `Authorization: Bearer t`.
- The sidecar never lists keys (`hasKey` boolean only); unknown commands categorize to `confirm` (fail-closed); template agents can't be deleted (409).
- CI: `.github/workflows/ci.yml` — windows-latest, Node 24 + pnpm cache + Rust stable, runs `pnpm verify` + `cargo check`.

Good luck. The project is in a clean, fully verified state — everything claimed green was observed green.
