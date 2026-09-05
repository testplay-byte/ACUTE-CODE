<!-- last-reviewed: 2026-09-05 round-66 -->
# ACUTE-CODE — Agent Handoff Document

**Last updated:** 2026-09-05 (round-66 DELIVERED + CLOSED OUT — the live-fire patch, closing the owner's 0.65.0 field report end to end): (1) **THE AGENT USES THE EMBEDDED BROWSER LIKE A USER** — `browser_control` grew to 15 actions (click / type with `submit:true` / press_key Enter→`form.requestSubmit` — the "typed a Google query but never submitted" fix / read_dom — a structured page outline / source html|css|scripts / wait_for_verification), all riding the existing eval bridge, one `JSON.stringify`-embedded script per action. (2) **BOT WALLS ARE OWNER-SOLVABLE** — navigate/read probe for captcha/Cloudflare/age gates (pure detector, priority + evidence); `wait_for_verification` opens a live countdown card in CHAT (Mark as done / Stop waiting → `POST /api/v1/browser-checkpoints/:id/resolve`, 15 s default / 60 s hard cap, resolved frame on every settle) and the tool re-probes + reports honestly. (3) **AGENT VIEWPORT CHANGES APPLY INSTANTLY** (the "had to nudge a number" fix): the new `browser-viewport` SSE frame + `agentViewportSeq` exits the panel's natural mode; the 4 s poll is the backfill. (4) **THE VISION SPLIT** — Settings → Image Analysis (mode + provider + model + its own key slot; migration 0025 seeds from the old computer-use rows) now serves computer-use screenshots, browser screenshots, AND the new always-registered `analyze_image` tool (TOOL_NAMES 25, migration 0026; ComputerUseTab keeps only a pointer). (5) **DEBUG MODE IS A POST-TURN CONTEXT-FREE ANALYST** — no more agent self-report (the R65 prompt section is removed): after a turn completes, a fresh no-tools model call receives the whole transcript (FULL tool results, 60 k head+tail cap) and streams its report live under the answer; persisted as `debug.report` which `assembleHistory` never feeds back. (6) **WINDOWS GOES ELEMENT-FIRST IN BIG APPS** — the UIA walk probes only 17 interactive ControlTypes (one 4-probe pass, was ≤8/node) and reaches 2400 elements (was 800), plus `find_elements {appRef, query}` (the 31st computer-use tool) so the agent SEARCHES the tree instead of screenshot-looping; the built-in skill teaches the loop. (7) **THE FLOATING MONITOR is top-center 460×56** (less tall, centered) with a decayed real-control live signal (6 s) — browser turns never show "agent is using your computer" (browser screenshots no longer record into the ring); the minimized settings sidebar shows the SETTINGS rail, not the projects nav. Verification: root 1807/1807 in 118 files (was 1686/110), agent-core 980/980 in 58 files, frontend 815/815 in 58, lint/typecheck/docs:check clean, version 0.66.0 ×4, the round's live check on the dev stack (Image Analysis tab + live glm-5.2:free session machine-verified). Full detail in `docs/ui-iterations/round-66.md` · **Closed out 2026-09-05 (tip `96cf8f6`):** the round's first push had shipped RED CI (two Windows-runner flakes — the countdown-tick boundary race + the real-OS-probe 5 s timeout; both made deterministic, no production code touched) — CI green (run 33952264863), tag **v0.66.0 RELEASED** (run 33952608589: launcher kit + NSIS installer, both draft-release assets verified), the public DASHBOARD truth-synced to 0.66.0, the canonical worklog entry restored · **What's next:** the owner's next live Windows run verifies the R66 surface on real hardware — Windows `find_elements` + the 2400-element Edge walk, the top-center mini window, the checkpoint flow on a REAL bot wall, the browser page actions in the native WebView2 (the sandbox pinned them by test only) — then the standing queue: browser-wall self-bypass (future), packaging/code-signing (SmartScreen), ratings-driven prompt tuning, multi-agent support · **Maintained by:** the orchestrator agent · **Audience:** any AI agent (or human) taking over development

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
7. `docs/decisions/` — ADRs 0001–0013 (never renumber; continue at 0014+).
8. `docs/runbooks/plan-phase-2.md` (what just finished) and `docs/research/README.md` (nine reference-project analyses + synthesis).

## 2. Product in one paragraph

ACUTE-CODE (NOT "Forge" — the brief's old codename) is a Windows desktop app: **Tauri 2 (Rust) shell + React 18/TS frontend + Node/TS sidecar ("agent-core") that exclusively owns SQLite (WAL) and serves localhost REST+WS**. "Local-first" = all processing on-device; LLMs are cloud APIs only. It orchestrates up to 5 concurrent agents (templates: Planner, Researcher, Coder, Reviewer, Tester) in three run modes — **single-agent (default)**, **auto-team** (cheap orchestrator model delegates to a powerful worker), **manual** (advanced). No sandbox in v1, so the **human-approval engine is the security boundary**. Providers: Anthropic/OpenAI/Google (fixture-tested only — no keys) + OpenRouter (live) + custom OpenAI-compatible. Owner runs it as a portable folder with an exe (ADR-0003). Budget: <700 MB idle, <2.5 GB with 5 agents, cold start <5 s.

## 3. Exact current state (2026-08-24, round-28 DELIVERED)

**Round 28 is COMPLETE — all 5 milestones delivered, 207 tests green (incl. 6 e2e vs the built dist), CI green, docs:check 0/0. The owner's 9 R28 directives are realized: (1) sidebar brand block removed + NAVIGATION/PROJECTS sections; (2) settings appearance contrast fix + Sun/Moon + swatch borders + 2-col grid; (3) chat screen complete redesign — chatFocusMode + ChatFocusLayout + ChatTopBar, chat on LEFT, no Explorer/Code panels in focus mode; (4) live streaming typing effect via useSidecarHealth (demo-mode auto-detect → SSE path) + caret-blink cursor + aria-live; (5) multi-turn agentic continuation — AGENTIC LOOP prompt section + outer loop (maxOuterLoops 5) + inverted continueIfUnfinished; (6) project indexing — codebase_index table + index_project 16th tool + CODEBASE AWARENESS prompt injection; (7) advanced search — search_code case_sensitive/whole_word/file_glob/max_results + CommandPalette ⌘K + POST /projects/:id/search; (8) in-app demo viewer — /demos route + DemoViewerScreen + sandboxed iframe; (9) documentation proper + manageable — DOC-STANDARDS.md + check-stale.mjs CI gate + REVIEW-CADENCE.md + ORCHESTRATOR-METHOD.md (the cognitive workflow doc). Plus K1+K2 (DASHBOARD screenshot publish infra + UI section), L (verify-round.mjs). **J2 (docs stamp backfill) — DELIVERED this session (commit 65246ca):** created `scripts/docs/stamp-all.mjs` (the tool DOC-STANDARDS §8 references but never existed), backfilled the `<!-- last-reviewed -->` stamp on 103 docs (docs:check 105 failures → 0), and hardened `check-stale.mjs` (indented-fence support — the real bug; inline-code skip for path+URL; template/placeholder/non-TLD URL guards; parallel `fetch`+retry replacing the sequential curl-spawn loop: 229 URLs 120s+ → 15s). See `docs/ui-iterations/round-28.md` for the full evidence (live batteries: MS-3 = 5 tool calls + Done. + file written; MS-4 = 318 files + 2384 symbols indexed in 124ms + symbol search match). The next agent picks up at: owner verdict on R28 (now with J2 closed + honest 207 test count — the prior "213 (207+6 e2e)" double-counted; 6 e2e are already in the 207), then Phase 3 orchestration upon explicit approval.**

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
├── AGENTS.md (workspace, ../)  operating rules — phase gates, question protocol, hard rules
├── launcher/               owner's one-click local-PC entry (round-11): ACUTE.bat (CRLF coordinator) + acute.sh + acute_launcher.py (rich-UI workhorse: auto-install, credentials.txt, update+restart, self-update) + credentials.example.txt — see docs/runbooks/LOCAL-PC-RUNNER.md
├── docs/
│   ├── agent/ORCHESTRATION-WORKLOG.md   session history snapshot (sandbox-resilience backup, refreshed each session)
│   ├── specs/SPEC.md           master requirements (F1–F11 features)
│   ├── architecture/ARCHITECTURE.md + api/API.md   design truth
│   ├── decisions/0001–0021 + TEMPLATE.md           ADRs (sequential, never reused)
│   ├── research/<9 projects>/  verified reference analyses + README synthesis
│   ├── design/ui-direction.md  owner's design language from his demos
│   ├── runbooks/SETUP.md, plan-phase-{0,1,2}.md, plan-ui-fidelity.md, review-phase-1.md, DEMO.md (later) · LOCAL-PC-RUNNER.md (one-click launcher) · AGENT-MEMORY.md (lessons) · SANDBOX-RESTORE.md (resume-after-wipe)
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
├── scripts/acute-desktop.mjs  local-PC runner used by ACUTE.bat/acute.sh: toolchain, update+restart, installs, key setup, launch
├── scripts/credential.ps1  read/write Windows Credential Manager entries (no secrets inside)
├── tests/e2e/              sidecar black-box E2E suite (6 tests vs built dist; skips when dist absent)
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

1. **Confirm you have current code**: `git log --oneline -1` → must be `65246ca` or newer (pull if behind). If your machine lacks push credentials, follow `docs/runbooks/SANDBOX-RESTORE.md` (round-28 layout: `/home/z/PROJECT/ACUTECODE` + per-repo credential helpers + token-in-URL clone per lesson #24).
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

## 9. What's next: owner verdict on R28 (J2 closed) — then Phase 3 — Orchestration engine (after owner approval)

**Round-28 (2026-08-24, DELIVERED):** the full plan was at `docs/ROUND-28-MASTER-PLAN.md` (1123 lines, v2 with 30 sub-agent review fixes applied). All 5 milestones delivered; see `docs/ui-iterations/round-28.md` for the complete evidence. The 13 workstreams A-M across 5 milestones were:
- **MS-1**: A1+A2 (governance + docs sync) + B (sidebar redesign — remove brand block) + C (settings appearance contrast fix)
- **MS-2**: D1+D2+D3 (chat screen complete redesign — chatFocusMode + ChatFocusLayout + AgentChatPanel modernization + streaming hook merged with E + composer wiring + DiffCard real diff + delete orphaned TopBar)
- **MS-3**: F (multi-turn agentic continuation — AGENTIC LOOP prompt section + inverted continueIfUnfinished + maxOuterLoops 5 + context/request guards)
- **MS-4**: G1+G2 (project indexing — 0007 codebase_index migration + index_project 16th tool + frontend CodebasePanel) + H (grep integration — search_code schema extension + CommandPalette ⌘K popover)
- **MS-5**: I (in-app demo viewer) + J1+J2 (docs management CI gate) + K1+K2 (dashboard screenshot zip uploads to DASHBOARD repo) + L (verify-round.mjs one-shot battery) + M (review cadence doc)

6 parallel sub-agents ran (6-a/6-b/6-c research + 6-d/6-e/6-f review); 30 fixes applied. See plan §0.1 v2 changelog for every fix. Owner verdicts gate each MS.

**Round-27 delivery (2026-08-24, owner-directed):** web tools (web_fetch + web_search) + critical deps-wiring fix (todo_write + checkpoints were silently dead in real turns — now live) + 14 web-tools unit tests + L4 live battery + L5 browser verification (19 screenshots) + demo project (YouTube-like app, 545 lines) built BY the agent + zip uploaded to GitHub release `round-27-testing`. Kilo Code parity achieved (15 tools, Cline-grade prompt, cost tracking, context-window management, checkpoint/revert, todo tracking).

**Round-14 delivery (2026-08-23, owner-directed):** the agentic coding system works for real — `/internal/dialog/folder` (sidecar opens the REAL OS folder dialog), tools `create_dir`/`delete_file`/`search_files`, demo-parity chat UI (TopBar with live AGENT picker + ⌘K file search + theme grid + Experimental freeform layout + To-Do). Live P1 proof: 6-tool turn + read-back + deletion-refusal. Three-pillar planning: `docs/research/n8n/` (automation pillar, additive).

**Round-11 delivery (2026-08-23, owner-directed redesign):** the round-10 `.bat` failed on the owner's PC (LF line endings — cmd.exe disintegration; lesson #16 in AGENT-MEMORY). Replaced per owner direction with `launcher/`: `ACUTE.bat` (tiny CRLF-verified coordinator — finds/installs Python) + `acute_launcher.py` (rich-terminal workhorse: toolchain auto-install via winget, `credentials.txt` local secrets file, clean-folder layout `ACUTE-CODE/` + `.acute/`, update-with-server-restart, OpenRouter key → Credential Manager, launcher SELF-UPDATE, boxed copyable errors, plain-text fallback). Fully tested on Linux incl. first-run, behind-update, status, live start (key `●` end-to-end) and failure paths; docs in `docs/runbooks/LOCAL-PC-RUNNER.md` + `launcher/README.md`. `scripts/acute-desktop.mjs` (round-10 node runner) remains as the advanced headless path. The owner runs the app on his PC with the launcher; M4 can be re-confirmed there. The full owner vision (three products) is recorded in `docs/architecture/PROJECT-MAP.md` §1/§6.

Phase 3 scope per SPEC §F3 + ADR-0001 (read `docs/research/README.md` synthesis §4 first — delegation-as-task-tool is the proven pattern): multi-agent run loop; shared message bus (typed pub/sub, MetaGPT pattern); Kanban task board events; **approval-gate engine live** (modal round-trip, audit log, denylist-supreme, 15-min deny-on-expiry default, remembered grants for non-destructive); the three run modes with auto-team composition; WS streaming (`@fastify/websocket` — first-message auth frame per ADR-0008; replaces today's refetch-after-turn). Exit demo (owner watches live): 3-agent coding task (Planner→Coder→Reviewer) + 2-agent research task.

**Also queued:** ratify Phase 2 assumptions (ADR list in the Phase 2 report — SPDX OR-expression audit parsing, failed-turn session semantics); `cargo-deny` license audit for Rust deps in CI; native provider adapters remain fixture-only until keys exist; approval-decision metadata wrapper type; `UsageRecord.costSource` provenance field.

## 10. Quick reference

- Verify pipeline: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm license:audit` (= `pnpm verify`).
- Live-test pattern: boot `ACUTE_TOKEN=t ACUTE_DB_PATH=<tmp> ACUTE_PROVIDER_OPENROUTER=$(read from Credential Manager) node agent-core/dist/main.js`, parse `ACUTE_READY {"port":N}` from stdout, curl with `Authorization: Bearer t`.
- The sidecar never lists keys (`hasKey` boolean only); unknown commands categorize to `confirm` (fail-closed); template agents can't be deleted (409).
- CI: `.github/workflows/ci.yml` — windows-latest, Node 24 + pnpm cache + Rust stable, runs `pnpm verify` + `cargo check`.

Good luck. The project is in a clean, fully verified state — everything claimed green was observed green.
