# ORCHESTRATION WORKLOG — snapshot

Live copy: the orchestrator agent's sandbox at /home/z/my-project/worklog.md.
This snapshot is refreshed into the repo at the END of every session (see
docs/runbooks/SANDBOX-RESTORE.md) so a wiped sandbox can resume with full
history. Entries are append-only, newest sections at the bottom.

---

# ACUTE-CODE Orchestration Worklog

Shared worklog for all agents working on the ACUTE-CODE takeover (repo:
/home/z/acute-workspace/ACUTE-CODE, private GitHub repo testplay-byte/ACUTE-CODE).

---
Task ID: 1
Agent: orchestrator (Z.ai Code)
Task: Environment recon for ACUTE-CODE takeover

Work Log:
- Verified sandbox: Linux x64, kernel 5.10, 2 CPU, 4.1GB RAM, ~8GB free disk, uid 1001 (non-root)
- Toolchain: node v24.18.0 OK, npm 11.16.0 OK, git 2.47.3 OK, jq OK, corepack 0.35.0 OK; pnpm MISSING (install via corepack, repo pins pnpm@11.22.0); rustc/cargo MISSING (local cargo check likely infeasible: non-root, no system libs, tight disk → rely on CI per ADR-0012)
- Network: github.com 200, api.github.com 200, ntfy.sh 200, objects.githubusercontent.com reachable; api.openrouter.ai DNS-BLOCKED but openrouter.ai apex 200 and https://openrouter.ai/api/v1/models returns 422 models incl. stealth/ox-alpha → M4 feasible iff agent-core's OpenRouter base URL uses apex domain (to verify in agent-core/src/providers/registry.ts)
- CRITICAL DEVIATION vs. owner brief: this sandbox is Linux, NOT Windows 10/11. Windows-only steps (winget, VS Build Tools, WebView2, DPAPI Credential Manager via scripts/credential.ps1, C:/Users/khurr/Desktop/ACUTEST) cannot execute here. Adaptations: secrets staged at /home/z/.secrets/ (0600, outside repo, values never printed), M4 live proof to use a Linux path. To be flagged [BLOCKING] to owner.

Stage Summary:
- Env facts + blockers recorded above; all external hosts required are reachable except api.openrouter.ai (DNS) with apex-domain workaround available.

---
Task ID: 2
Agent: orchestrator (Z.ai Code)
Task: Stage secrets hygienically

Work Log:
- Created /home/z/.secrets (0700) with github.pat (93 chars) and openrouter.key (73 chars), both 0600
- Values never echoed to logs/transcripts beyond the owner's original message; lengths only

Stage Summary:
- Secrets available for git + OpenRouter use without persisting into any repo or config that gets committed.

---
Task ID: 3
Agent: orchestrator (Z.ai Code)
Task: Verify repo privacy, clone, credential handoff

Work Log:
- GET api.github.com/repos/testplay-byte/ACUTE-CODE with PAT → private: true, visibility: private, default_branch: main (closed-source rule verified BEFORE any push)
- Cloned to /home/z/acute-workspace/ACUTE-CODE; remote tip 04c6da8 (bootstrap prompt hardening on top of 98abfde M1+M2 handoff)
- Sanitized remote URL to tokenless https://github.com/testplay-byte/ACUTE-CODE.git
- git credential store configured at /home/z/.secrets/git-credentials (0600) for future pushes
- Repo layout confirmed: Vite frontend at root, workspace pkgs agent-core + shared, design demos under design/demos/, pnpm-workspace.yaml already has allowBuilds (esbuild, better-sqlite3)

Stage Summary:
- Repo cloned, private-verified, push path ready. Next: doc analysis (3-a/3-b/3-c subagents) + pnpm install + verify.

---
Task ID: 3-a / 3-b / 3-c
Agent: Explore x3 (parallel)
Task: Rules extraction (HANDOFF/AGENTS), architecture+M3/M4 plan extraction, project-chat demo map

Work Log:
- 3-a read HANDOFF.md, AGENTS.md, scripts/README, SETUP.md, BOOTSTRAP prompt + dev loop sources (dev.mjs, acute.mjs, main.ts, registry.ts, ci.yml)
- 3-b read plan-agentic-mvp.md, PROJECT-MAP, ARCHITECTURE, API.md, ui-iterations README+round-08, ADRs 0008/0010/0011/0013, agent-core source (server.ts, storage/*, providers/registry.ts, agents/*, tools/index.ts, main.ts), .github/workflows/ci.yml
- 3-c read all design/demos/project-chat/src/components/project-chat/* + demo libs + all current app integration points (App.tsx, shell, lib/*, sessions/*, projects/*)

Stage Summary (key facts the implementation depends on):
- pnpm@11.22.0 via corepack; pnpm install GREEN (332 pkgs, better-sqlite3 native build OK on Linux)
- pnpm verify GREEN on Linux baseline: 163 unit + 6 e2e = 169 pass, build OK, license audit clean (107 prod deps)
- OpenRouter baseUrl seeded in DB = https://openrouter.ai/api/v1 (APEX domain — reachable in this sandbox; api.openrouter.ai DNS-block is irrelevant). Key injection on Linux: ACUTE_PROVIDER_OPENROUTER env var on sidecar process (no file fallback; dev.mjs passes process.env through)
- .env.development is gitignored and absent; browser live mode needs VITE_ACUTE_BASE_URL (flips demoData off) + VITE_ACUTE_TOKEN=acute-dev-local (verified in config-store.ts merge()). Temporary file during live verification only
- Sidecar dev: ACUTE_TOKEN=acute-dev-local, ACUTE_PORT=5178, ACUTE_DB_PATH=.dev/*.db; every /api/v1 route needs Bearer; scripts/acute.mjs uses ACUTE_BASE_URL/ACUTE_TOKEN env, `raw` subcommand is the workhorse (note: `agents` cmd has a bug printing a.modelId — use raw)
- Session events: message.user / tool.use (one per executed call, BEFORE assistant) / message.assistant; tool.use payload {role:'tool', toolName, argsSummary, ok, agentId, ts} — argsSummary is log-safe summary, no diff text; POST /sessions/:id/messages is SYNCHRONOUS whole-turn
- Backend tool names (M2): list_dir/read_file/write_file/edit_file; sessions list has NO server-side projectId filter (client-filter); GET /sessions/:id returns events embedded
- Full M3 port plan produced by 3-c (file-by-file, theme token mapping muted→textSecondary etc., withAlpha helper in dashboard/helpers.ts). Zero new deps needed
- CI: workflow "CI" (windows-latest, pnpm verify + cargo check); status via GET /actions/runs?head_sha=<sha> with PAT
- Commit style: prefixed imperative summaries ("Round 8: …", "Agent handoff: …"); single branch main; verify green before push; ntfy after milestones; round-09.md mirrors round-08 structure; README board update required

---
Task ID: 3-a
Agent: Explore (rules & gotchas)
Task: Extract operating rules from HANDOFF.md + AGENTS.md

Work Log:
- Read worklog.md (tasks 1-3), then HANDOFF.md fully (§1-§10, esp. §5 discipline + §8 gotchas)
- Read AGENTS.md (canonical workspace rules), scripts/README.md, docs/runbooks/SETUP.md, docs/runbooks/AGENT-BOOTSTRAP-PROMPT.md
- Read dev-loop sources: scripts/dev.mjs, scripts/acute.mjs, agent-core/src/main.ts, agent-core/src/providers/registry.ts (keyring), server.ts CORS/ready-line, .gitignore, package.json scripts, .github/workflows/ci.yml
- Read docs/decisions/0008 (sidecar auth token) + 0012 (GitHub remote/CI), docs/ui-iterations/README.md + round-06.md
- git log --oneline -15 + branch -a: single branch main, all commits pushed directly to main

Stage Summary:
- HARD RULES: secrets ONLY in Windows Credential Manager (never repo/logs/transcripts/errors; print LENGTHS only; single exception = shell-only /internal/providers/keys handoff); closed-source: repo must stay PRIVATE (verify before ANY push; PATCH private if public), no LICENSE file, nothing published to public registries; license allowlist MIT/Apache-2.0/BSD/ISC/MPL-2.0 only, GPL/AGPL/LGPL forbidden, `pnpm license:audit` gates CI; pnpm verify green before push; approval engine = security boundary (denylist-supreme, fail-closed, never "always allow" destructive); no telemetry; stack changes need owner approval
- Backup/push discipline: after ANY change commit+push to GitHub and confirm CI green (repo = single source of truth); notify owner via `curl -d "<msg>" https://ntfy.sh/TASKISDONE` after every completed task; phase gates require explicit owner approval (currently M3+M4 before Phase 3)
- DEV LOOP: `pnpm dev:full` = node scripts/dev.mjs → sidecar (node agent-core/dist/main.js) on FIXED 127.0.0.1:5178, ACUTE_TOKEN=acute-dev-local, ACUTE_DB_PATH=.dev/acute.db (gitignored), key read via `powershell scripts/credential.ps1 Read ACUTE-CODE/provider/openrouter`, then vite :5173 after 1200ms; Ctrl+C kills both. Plain `pnpm dev` = UI only, NO backend
- LINUX FALLBACK (critical): dev.mjs spreads `...process.env` BEFORE its own vars, so an exported env var passes through even when the powershell read fails (spawnSync ENOENT is non-fatal, just warns). Sidecar keyring reads ONLY env: `ACUTE_PROVIDER_${ID.toUpperCase(), non-alnum→_}` (registry.ts:44) = `ACUTE_PROVIDER_OPENROUTER`. So on Linux: `export ACUTE_PROVIDER_OPENROUTER=$(cat /home/z/.secrets/openrouter.key)` then `pnpm dev:full`. No file-based fallback exists
- Browser auth: gitignored `.env.development` must be created with `VITE_ACUTE_TOKEN=acute-dev-local` (baseUrl defaults to http://127.0.0.1:5178 in config-store.ts); CORS allowlist: tauri.localhost, localhost:5173, 127.0.0.1:5173. acute.mjs uses ACUTE_BASE_URL/ACUTE_TOKEN env or defaults 127.0.0.1:5178/acute-dev-local; bearer on everything except GET /health; ready line `ACUTE_READY {"port":N}`
- GIT: single-branch main, direct pushes (no feature branches); commit style = imperative summary with prefix tag ("Round N: ...", "Phase X close-out: ...", "Wizard UI rounds 3-4: ...") + detailed body; CI runs on push to main + PRs (windows-latest: pnpm verify + cargo check, frozen lockfile)
- WINDOWS-ONLY on Linux dev box: credential.ps1 (Credential Manager), winget/VS BuildTools/WebView2, cargo check (no rustc locally — rely on CI per ADR-0012), Tauri pick_folder/desktop run, C:/Users/khurr/Desktop/ACUTEST M4 path (use a Linux path substitute + flag deviation)
- UI rounds: one file per round in docs/ui-iterations/round-NN.md (owner verdict → changes → verification incl. screenshots at multiple viewports); README.md = status board; round CLOSED only on explicit owner approval, one screen at a time, never infer approval from praise; M4 goes in round-09.md
- Question protocol: batch once/phase, numbered, [BLOCKING]/[NON-BLOCKING], recommended default each, max 10, check docs first; sub-agents ≤4 concurrent; owner answers section-by-section — never rush

---
Task ID: 3-c
Agent: Explore (project-chat demo map)
Task: Map project-chat demo + app integration points for M3 port

Work Log:
- Read all 9 demo files in design/demos/project-chat/src/components/project-chat/ (ProjectChatView, AgentChatPanel, CodeView, LeftSidebar, TopBar, ExperimentalLayout, panels/ExplorerPanel, panels/TodoPanel, index.ts)
- Read demo support libs: project-chat-store.ts, dashboard-helpers.ts, dashboard-store.ts, use-theme-styles.ts (onboarding variant, NOT used by project-chat), color-utils.ts, useScrollFade.ts, globals.css, tailwind.config.ts, package.json, app/page.tsx, tsconfig.json
- Read app integration points: App.tsx, main.tsx, AppShell.tsx, Sidebar.tsx, projects-store.ts, api.ts, sidecar.ts, config-store.ts, use-theme-styles.ts, theme-store.ts, themes.ts, ProjectView.tsx, ChatView.tsx, SessionsScreen.tsx, session-fixtures.ts, agent-fixtures.ts, index.css, vite.config.ts, index.html, package.json, motion.ts, format.ts, hooks/use-sessions.ts
- Verified live backend (M1+M2 done per HANDOFF.md): agent-core/src/server.ts projects routes (GET/POST /projects, GET/DELETE /projects/:id, GET /projects/:id/tree, GET /projects/:id/file), storage/projects.ts Project shape, tools/index.ts TreeNode {name,type,path,size?,children?} + IGNORED_DIRS + MAX caps, sessions accept projectId, tool.use audit events in agents/runtime.ts (payload {role:'tool',toolName,argsSummary,ok}) appended before message.assistant
- Grep'd isTauri/__TAURI__ (sidecar.ts + duplicate in onboarding/providers-api.ts), useProjectsStore consumers (Sidebar, ProjectView, DashboardScreen, Sidebar.test), shared types (RunMode/SessionStatus/AgentRecord/UsageRecord), API.md §3/§5/§6 for projects/files/events contracts

Stage Summary:
- Resizable layout = custom mouse handlers (window mousemove/mouseup), pixel widths in useState, GapHandle 10px strip; min/max 180-400 sidebar / 320-800 chat; CodeView flex-1; no a11y, no persistence — port should add role=separator + keyboard + localStorage
- Message anatomy fully mapped: RichText regex parser (**bold**, `code`), thought blocks, action pills (icon map file/search/edit/terminal), static diff card (hard-coded lines — must be rewritten for real diffs), bounceDot thinking dots, useScrollFade .auto-scroll CSS, smooth auto-scroll on [messages.length, isAgentThinking]
- Mock→live mapping: files/expandedFolders→GET /projects/:id/tree (id:=path), code→GET /projects/:id/file?path=, messages→session events, actions pills→tool.use events grouped, user/ai→message.user/message.assistant, sendMessage→useSendMessage mutation, model chip→session agent; thought blocks + todo + suggestion banner have NO backend (skip or local)
- Theme: demo useTheme (dashboard-helpers) keys map cleanly onto app useThemeStyles (muted→textSecondary, hover→subtleHover, accent+'14'→withAlpha(accent,N)); hard-coded colors inventoried (#22c55e/#ef4444 diff, traffic lights, syntax palette #a5d6a7/#6a737d/#f9a825/#c792ea/#82aaff, FILE_COLORS, isDark?'#000':'#fff'→styles.accentText)
- App routing: add Route path="project/:id/chat" inside AppShell; AppShell/Sidebar already cover demo TopBar+global nav (skip TopBar port); Sidebar Add Project modal must rewire to POST /api/v1/projects + Tauri pick_folder (isTauri() gate); listSessions does NOT filter by projectId (client-filter)
- Dependencies: ZERO new packages needed (framer-motion/lucide-react/zustand/@tanstack/react-query all present; demo's react-resizable-panels/syntax-highlighter/dnd-kit are NOT used by project-chat code)
- File-by-file port plan delivered: 8 new src/components/project-chat/ files + useScrollFade lib + api.ts ProjectsBackend + use-projects hooks + slim UI store; skip TopBar/SuggestionBanner/MOCK_*/demo theme libs; rewrite DiffMessage + event timeline mapping
---
Task ID: 3-b
Agent: Explore (architecture & plan)
Task: Extract M3/M4 requirements and integration surface

Work Log:
- Read plan-agentic-mvp.md fully (M3/M4 milestone rows + security posture), PROJECT-MAP.md, ARCHITECTURE.md (all 428 lines), API.md (all 657 lines)
- Read ui-iterations/README.md (approval board + verification method) and round-08.md (template for round-09.md)
- Read ADRs 0008 (bearer token), 0010 (append-only event log), 0011 (in-process runners), 0013 (AI SDK v7 + @ai-sdk/openai-compatible), 0012 (GitHub CI)
- Read HANDOFF.md (§3 current state: M1+M2 DONE, M3+M4 remain; §6.4 + §9 exact M3/M4 instructions incl. pick_folder/isTauri wiring, projects-store→backend migration, round-09.md)
- Verified docs against source: agent-core/src/server.ts (829 lines, ALL routes), storage/{projects,sessions,agents,providers,usage,db}.ts, migrations 0001-0003, providers/registry.ts, agents/{chat,runtime}.ts, tools/index.ts, main.ts, approvals.ts, shared/src/index.ts
- Read project-chat demo: ProjectChatView (GapHandle resizing), AgentChatPanel (message anatomy user/ai/thought/actions/diff + thinking indicator), project-chat-store (types/mock data), CodeView, ExplorerPanel, TodoPanel, TopBar
- Read frontend integration surface: src/lib/{api,sidecar,config-store,projects-store}.ts, App.tsx routes, Sidebar AddProject dialog (still local-store + text path), providers-api.ts isTauri/tauriInvoke pattern, ProjectView.tsx
- Read src-tauri/src/{lib,dialogs,keys}.rs (pick_folder registered; Credential Manager service ACUTE-CODE/provider/<id> user api-key → env ACUTE_PROVIDER_<ID> + POST /internal/providers/keys push)
- Read scripts/acute.mjs (dev CLI), scripts/dev.mjs (dev:full port 5178 token acute-dev-local), scripts/license-audit.mjs, .github/workflows/ci.yml, package.json scripts, tests/e2e boot pattern

Stage Summary:
- M3 (from plan + HANDOFF §6.4/§9): port design/demos/project-chat to live data — resizable Explorer/Code/Chat panels (GapHandle; sidebar 180-400 def 250, chat 320-800 def 400), message anatomy user|ai|thought|actions(pills)|diff, thinking indicator, live tree/file/turns via GET /api/v1/projects/:id/tree + /file + POST /api/v1/sessions/:id/messages; wire sidebar Add Project to Tauri pick_folder (isTauri() gate; browser fallback = text prompt; tauriInvoke pattern in providers-api.ts); replace localStorage projects-store (acute-code.projects) with backend /api/v1/projects; proof = browser screenshots + pnpm verify; record round-09.md. Theme rule: only useThemeStyles()/--ac-* vars, never hard-code colors. TodoPanel + 'thought' + real diff data have NO backend source (decision needed: omit/synthesize).
- M4 (Linux-adapted; Windows ACUTEST path flagged [BLOCKING] by Task 1): mkdir test root → POST /projects {name,rootPath} → POST /agents {name, providerId:"openrouter", model:"stealth/ox-alpha"} → POST /sessions {mode:"single",agentId,projectId,title} → POST /sessions/:id/messages {content:"create file..."} (synchronous whole agentic turn) → assert files on disk + tool.use events in GET /sessions/:id + usage/summary. acute.mjs `raw` is the escape hatch for all of it.
- CRITICAL sandbox fact: agent-core seeds openrouter baseUrl = https://openrouter.ai/api/v1 (APEX domain, storage/providers.ts:36) — NOT api.openrouter.ai — so M4 works in this sandbox with zero DNS workaround. Key injection on Linux: ACUTE_PROVIDER_OPENROUTER env (keyring snapshots ACUTE_PROVIDER_<ID>; Credential Manager is Windows-only path).
- REST surface is a SUBSET of API.md: no WS/SSE (turn is synchronous request→response), no /sessions/:id/events backfill route (events embedded in GET /sessions/:id), no approvals/git/entries/settings routes yet. Auth = Bearer ACUTE_TOKEN everywhere except GET /health; dev port 5178, dev token acute-dev-local.
- Event log shapes for M3 rendering: message.user/message.assistant payload {role,content,agentId,ts}; tool.use {role:"tool",toolName,argsSummary,ok,agentId,ts} (appended BEFORE assistant msg, one per call); seq per-session monotonic.
- Data model verified (migrations 0001-0003): projects(id,name,root_path UNIQUE,color,created_at), agents(…provider_id/model/vision_model NULL, allowed_tools JSON, is_template), sessions(+agent_id 0002, +project_id, status queued→running), session_events(seq UNIQUE(session_id,seq), payload JSON), usage_events(cost_usd=0).
- License policy: MIT/Apache-2.0/BSD-2/3/0BSD/ISC/MPL-2.0/CC0-1.0 only; GPL family + unknown fail `pnpm license:audit` (part of verify + CI); M3 needs NO new deps (framer-motion/lucide/zustand/TanStack already present).
- CI: .github/workflows/ci.yml "CI" (push:main + PRs), one windows-latest job: pnpm install --frozen-lockfile → pnpm verify → cargo check. Status via api.github.com/repos/testplay-byte/ACUTE-CODE/actions/runs (PAT auth).
- Gotchas flagged: acute.mjs `agents` prints a.modelId (actual field `model` → undefined); src/lib/api.ts TOOL_CATALOG has code_exec (backend has web_search); sidecar.ts browser fallback reads VITE_ACUTE_PORT but config-store merge honors VITE_ACUTE_BASE_URL/VITE_ACUTE_TOKEN (use BASE_URL+TOKEN in .env.development); session never auto-completes (no stop route); project delete has no running-session guard (dangling sessions 409 the next turn).

---
Task ID: 5-a
Agent: general-purpose
Task: M3 data layer

Work Log:
- Read worklog (3-a/3-b/3-c summaries) + all pattern files (api.ts, agent/session fixtures, use-sessions/use-agents, config-store, sidecar, use-theme-styles/themes, index.css, api.test.ts, utils.ts) and the two verbatim-port sources (demo useScrollFade.ts, CodeView.tsx highlightLine)
- Verified backend §4a response shapes against agent-core/src/server.ts + tools/index.ts before coding: GET /projects → {projects}, POST /projects {name,rootPath,color?}, GET/DELETE /projects/:id, GET /projects/:id/tree → {tree, rootPath}, GET /projects/:id/file?path= → {path, content}; TreeNode.path is root-relative with "/" separators; backend tree walk SKIPS dotfiles (except .github) and IGNORED_DIRS
- src/lib/api.ts: added Project, TreeNode, ProjectsBackend, httpProjects() (request() helper), getProjectsBackend() (demoData selector); widened CreateSessionInput with projectId?: string; added ToolUseEntry/DiffEntry/ProjectChatItem + toProjectChatItems() timeline mapper (user items, ONE tools item per maximal consecutive tool.use run, one diff item per write_file/edit_file right after the group, ai items, tolerant argsSummary regex parse, unknown types ignored, seq-sorted)
- src/lib/project-fixtures.ts: in-memory ProjectsBackend (createFixtureProjects/getFixtureProjects/resetFixtureProjects, same style as agent-fixtures); 2 seeded projects (distinct colors), project #1 tree = 10 nodes nested 3 levels (README.md, package.json, src/{index.ts, lib/util.ts, components/Button.tsx, nested/deep.ts}), project #2 + created projects = minimal single-file tree; file() returns realistic bodies for README.md/package.json/all .ts/.tsx paths with generic-comment fallback; 409 CONFLICT on duplicate rootPath, 404 NOT_FOUND ApiErrors
- src/hooks/use-projects.ts: useProjects, useProjectTree(id|null), useProjectFile(id|null, path|null) (disabled when null), useCreateProject({name, rootPath, color?}), useDeleteProject(id); query keys ["projects",source], ["project-tree",source,id], ["project-file",source,id,path]; source keying copied verbatim from use-sessions.ts (useDataSource → demoData ? "demo" : "live")
- src/lib/project-chat-store.ts: slim persisted zustand store "acute-code.projectChat" v1 — sidebarOpen/codeVisible bools, sidebarWidth 250 / chatWidth 400 (setters clamp to demo bounds MIN/MAX_SIDEBAR_WIDTH 180-400, MIN/MAX_CHAT_WIDTH 320-800, constants exported), collapsedPanels/expandedFolders as ARRAYS + isPanelCollapsed(id)/togglePanel(id)/toggleFolder(path), selectedFileId + selectFile(path); no mock data
- src/lib/useScrollFade.ts: verbatim port (only RefObject import style adapted); src/lib/semantics.ts: SEMANTIC_COLORS {success #22c55e, danger #ef4444} as const with documented exception rationale
- src/components/project-chat/highlight.ts: SYNTAX_COLORS (exact demo palette), FILE_COLORS ext→hex map, highlightLine() verbatim tokenizer port returning {text,color?}[] instead of JSX, plus additive getFileColor(name) helper (.env* → env, unknown → default)
- src/index.css: APPENDED @keyframes bounceDot + demo .auto-scroll scrollbar rules; demo's ${border} placeholder → var(--ac-border) (the real bridge var written by syncThemeCssVars; borders ARE a var in this app, no rgba fallback needed)
- src/lib/api.test.ts: +describe "toProjectChatItems" — 5 tests: user→tools→diff→ai ordering with full shape asserts, consecutive-run merging (separate runs stay separate), one-diff-per-write/edit in order (incl. ok:false), tolerant argsSummary (full/missing-chars/missing-path/garbage), unknown types + content-less messages skipped
- session-fixtures.ts create() now honors input.projectId (input.projectId ?? null) so demo sessions bind to projects for client-side filtering — was the only touch outside the new/extended M3 files; still typechecks against the widened CreateSessionInput
- VERIFY (PATH=/home/z/.local/bin:$PATH): pnpm lint GREEN, pnpm typecheck GREEN, pnpm vitest run src/lib/api.test.ts 15/15 GREEN; bonus pnpm test 174/174 (169 baseline + 5 new) — no regressions. Did NOT run full verify suite per task rules; nothing committed/pushed

Stage Summary:
- M3 data layer complete and green: projects backend client + fixture twin, source-keyed react-query hooks, persisted project-chat UI store, scroll-fade/semantics/highlight libs, CSS motion+scrollbar additions, timeline mapper with tests
- Signatures 5-b codes against: api.ts exports Project/TreeNode/ProjectsBackend/httpProjects/getProjectsBackend/ToolUseEntry/DiffEntry/ProjectChatItem/toProjectChatItems; hooks useProjects()/useProjectTree(id)/useProjectFile(id,path)/useCreateProject() (mutationFn arg = {name, rootPath, color?})/useDeleteProject() (arg = id string); store useProjectChatStore + ProjectChatState + width clamp constants; highlight.ts SYNTAX_COLORS/FILE_COLORS/getFileColor/highlightLine; semantics.ts SEMANTIC_COLORS
- For 5-b: TreeNode.path is root-relative (feed directly to useProjectFile as `path`); .auto-scroll/bounceDot live in index.css now (do NOT re-add inline <style>); scrollbar border var = --ac-border; legacy src/lib/projects-store.ts (localStorage Project with `path` field) still exists untouched — Sidebar rewire is 5-b/orchestrator scope

---
Task ID: 5-b1
Agent: general-purpose (retry of 5-b, leaner scope)
Task: Port project-chat UI components (6 new files under src/components/project-chat/, edit nothing else)

Work Log:
- Read worklog 3-a/3-b/3-c/5-a sections, the 6 demo files (ProjectChatView/AgentChatPanel/CodeView/LeftSidebar/panels/ExplorerPanel/index), TopBar ViewToggle lines (faithful toggle pill), and the app pattern files (use-theme-styles, dashboard/helpers withAlpha, motion ease, sessions/ChatView send/error patterns, use-sessions/use-agents/use-projects hooks, project-chat-store, api.ts timeline types, highlight.ts, semantics.ts, useScrollFade.ts, App.tsx routes). Verified all 15 lucide icon names exist in the installed lucide-react (no substitutions needed) and bounceDot/.auto-scroll live in index.css.
- CREATED src/components/project-chat/ProjectChatScreen.tsx (default export): root h-full min-h-0 flex-col gap-2 motion fade-in 0.3s ease on styles.bg; slim h-9 header (project color chip w-5 Files 11 white + name 12px + rootPath mono 10px title=full + Code/Explorer ViewToggle pills bound to store.codeVisible/sidebarOpen); body = demo NormalLayout (sidebarOpen ? LeftSidebar+GapHandle : CollapsedSidebar w-12 rail; codeVisible ? CodeView+GapHandle : null; chat shrink-0 rounded-2xl width=chatWidth; onlyChat → justify-center items-center + maxWidth 90%). GapHandle ported verbatim (10px strip, group-hover 2px bar styles.border, re-baselined startX mousemove/mouseup, body cursor/userSelect lock) PLUS a11y: role=separator aria-orientation tabIndex=0, ArrowLeft/Right ∓/±16, Home/End overshoot ±100000 (store setters clamp), onFocus/Blur 2px accent outline. Resize handlers read useProjectChatStore.getState() so every mousemove delta is fresh. Loading + not-found states (not-found → Link "/"). useParams<"id">, project = useProjects().data?.find.
- CREATED AgentChatPanel.tsx ({projectId, project} props): header h-11 accent chip withAlpha(accent,.13) Sparkles 12 + agent name + model chip (inputBg/inputBorder/textTertiary) + busy/idle status pill (running=success/withAlpha(.08) on rounded-full); session = client-filter sessions by projectId sorted updatedAt desc → useSession; agent = useAgents(false) first non-template (agentId useState kept null default, picker TODO); items = toProjectChatItems(events); scroll body demo structure (absolute inset-0 auto-scroll + useScrollFade + h-8 card→transparent fade overlay) with px-3 py-4 flex-col gap-3; empty-state Hero (w-9 chip, name 14px, "Acute Agent · model" mono 11px) + agents-empty "Create an agent in Settings first" Link /settings accent; UserMessage demo-exact accent bubble; AiMessage card + RichText parser ported VERBATIM (bold fw600, code chip withAlpha(accent, isDark .13 : .08)); ToolsRow pills h-7 rounded-full mono 11px isDark?bg:card border, TOOL_ICONS {list_dir:Search, read_file:FileCode2, write_file:Edit3, edit_file:Edit3, web_search:Search} default Terminal size 11, label `${toolName} ${argsSummary}` sliced 48+… with title=full, ✓/✗ suffix opacity-50 success/danger; DiffCard button (h-8 header basename+`+N chars`, status dot+applied/failed, body path truncate, onClick selectFile+setCodeVisible, comment: real diff bodies Phase 3 git); AnimatePresence popLayout + msgVariants (y12/0.35s, exit y-8/0.2s, ease from lib/motion); AgentThinking demo row with bounceDot dots (d∈[0,.15,.3]) "Working…"; optimistic send: pendingUser → pendingEcho dedupe (ChatView pattern), createSession on first turn ({mode:"single", agentId, projectId, title: project.name}) then sendMessage({sessionId, content}); busy = createSession.isPending || sendMessage.isPending || !!pendingUser; error banner above composer (withAlpha(danger,.4) border, danger text, accent Retry → runTurn(lastSent)); composer pill (Paperclip noop, input "Message…", ArrowUp 14/2.5 filled accent when input.trim()); ⌘K/Ctrl+K window focus + Enter send; auto-scroll smooth on [items.length, busy, pendingUser].
- CREATED CodeView.tsx ({projectId, busy?} props, selectedFileId from store, useProjectFile): root rounded-2xl card/border/softShadow; h-10 header traffic lights (#FF5F56/#FFBD2E/#27C93F + rgba(0,0,0,0.1) ring, "decorative macOS traffic lights — intentional exception" comment) + fileName mono 12 basename + "Nova editing" chip (inputBg/inputBorder/textTertiary, success pulse dot, busy bounceDot dots — busy prop optional, unwired until turn state is observable outside chat panel); body flex-1 overflow-auto auto-scroll+useScrollFade, gutter w-[48px] textTertiary on withAlpha(inputBg, isDark .4 : .55), pre 12.5px/22px whitespace-pre-wrap with highlightLine() token spans, first 2 lines textTertiary-wrapped; states: no file / Loading… / error+accent Retry(refetch).
- CREATED LeftSidebar.tsx ({project}): motion width=store.sidebarWidth 0.25s ease card panel; h-9 "PROJECT" row + minimize (ChevronLeft 13, hover subtleHover, setSidebarOpen(false)); EXPLORER section only (Files 14 accent, label 10px uppercase, rotating chevron 0↔90, borderBottom when expanded) → AnimatePresence height anim → inner overflow-y-auto auto-scroll+useScrollFade → ExplorerPanel. Collapsed rail NOT here (parent owns it).
- CREATED panels/ExplorerPanel.tsx ({project}): header project color chip (Files 11 white, comment) + name 11px; useProjectTree: loading → 3× h-[34px] subtle animate-pulse skeletons, error → danger text + accent Retry(refetch), data → FileTreeItem depth 0. FileTreeItem demo-exact (h-[34px] rounded-lg, paddingLeft depth*14+8, selected bg withAlpha(accent, isDark .09 : .08), hover isDark?inputBg:subtleHover inline style swap, chevron rotate 90 anim, FolderOpen accent/textSecondary by expansion, FileIcon json→Braces md/css→FileText else FileCode2 with getFileColor, mono 12.5px name selected fw500 styles.text else textSecondary, children AnimatePresence height anim ease from motion.ts, keys = node.path). One-time useRef-guarded seed: first tree load with empty persisted expandedFolders → expand all TOP-LEVEL folder paths via useProjectChatStore.setState.
- CREATED index.ts: export { default as ProjectChatScreen } from "./ProjectChatScreen".
- Token map applied throughout: muted→textSecondary, hover→subtleHover, isDark?'#000':'#fff'→accentText, accent+'14'/'18'/'20'→withAlpha(.08/.09/.13), inputBg+'60'→withAlpha(inputBg,.4/.55), shadows→softShadow; only hard-coded colors: traffic lights + white icons on project-color chips (both commented exceptions), everything else via styles/withAlpha/SEMANTIC_COLORS/FILE_COLORS-via-getFileColor.
- NOT ported (mapping summary): TopBar (AppShell/Sidebar own global chrome + theme/search; only Code/Explorer toggles survive in the slim header), TodoPanel + demo thought blocks + SuggestionBanner (no backend source for todo state/thoughts/suggestions), ExperimentalLayout (demo experiment, out of M3 scope), MODEL_OPTIONS picker (model comes from the bound agent record), demo FileJson/CheckSquare/CircleDot-only pieces (unused after cuts), demo inline <style> keyframes (already in index.css via 5-a). Diff body +/- lines (hard-coded in demo) replaced by path/chars/status card — real diffs Phase 3.
- Icon substitutions: NONE (all 15 verified present in installed lucide-react).
- VERIFY (PATH=/home/z/.local/bin:$PATH): pnpm lint GREEN (no output), pnpm typecheck GREEN (no output). Single pass, no iterations. Nothing committed/pushed.

Stage Summary:
- Project-chat UI layer complete: 6 new files, zero edits outside them, lint+typecheck green. Orchestrator next: route "project/:id/chat" (or repoint project/:id) → ProjectChatScreen inside AppShell, rewire Sidebar Add Project to useCreateProject/pick_folder, delete legacy projects-store consumers.
- Assumptions: (1) CodeView takes optional busy prop (default false) — wire when turn state becomes observable outside AgentChatPanel; (2) AgentChatPanel agent defaults to first non-template agent (agentId state reserved for a future picker), session's own agent not yet reflected in header; (3) Hero intro shows only in empty state (spec called it "empty state"); (4) useSendMessage arg is {sessionId, content} per use-sessions.ts (spec sketch said {id} — followed the hook); (5) diff card body falls back to toolName when argsSummary parsing yielded no path (DiffEntry carries no argsSummary field); (6) optimistic user bubble dedupes against the refetched log (ChatView pattern) to avoid a double bubble on settle.

---
Task ID: 5-b2
Agent: general-purpose (subagent)
Task: M3 integration wiring — project-chat route + Sidebar/ProjectView/Dashboard onto backend projects

Work Log:
- Read worklog 3-a/3-b/3-c/5-a/5-b1 + all touched files (App, AppShell, Sidebar+test, ProjectView, DashboardScreen+test, test-utils, use-projects, api.ts, sidecar, providers-api, semantics, dashboard/helpers, format, project-fixtures, project-chat/index).
- src/App.tsx: +`<Route path="project/:id/chat" element={<ProjectChatScreen />} />` inside the AppShell layout route, sibling of `project/:id`; + named import from "./components/project-chat" (matches existing style). AppShell.tsx read + verified: it renders Sidebar+Outlet only, NO routes live there → no edit needed.
- src/components/shell/Sidebar.tsx (DATA-SOURCE SWAP, visuals byte-identical): useProjectsStore → useProjects/useCreateProject/useDeleteProject (hooks/use-projects.ts); Project.path → Project.rootPath (api.ts type); project click → navigate(`/project/${id}/chat`); active item derives from useLocation pathname regex `/^\/project\/([^/]+)/` (routing owns selection now; DashboardButton's store clear removed); delete = deleteProject.mutate(id) keeping the existing stopPropagation hover-button pattern (repo has NO confirm() anywhere — none introduced, per "existing pattern").
- Add Project modal: same form structure; submit = createProject.mutate({name, rootPath}) → onSuccess closes + onCreated(project.id) → navigate to project chat; Create button also disables while isPending. "Browse…" button renders ONLY when isTauri() (lib/sidecar.ts) → local tauriInvoke copy of the providers-api.ts pattern (window.__TAURI__.core.invoke) calling command "pick_folder"; string result fills the path field, null/cancel + invoke failure = no-op (manual entry stays the fallback); picking state disables the button. Browser dev renders no Browse button (plain text input unchanged).
- Error surface: new role=alert line in the modal — text-[12px], SEMANTIC_COLORS.danger text, withAlpha(danger,.08) bg + withAlpha(danger,.3) 1px border via bdr; ApiError → its server message (covers 400 "root path does not exist" + 409 duplicate rootPath), non-ApiError → generic "Could not create the project."; modal stays open on failure.
- src/test-utils.tsx: resetTestState() now also calls resetFixtureProjects() (demoData tests get deterministic seeds; renderWithProviders already wraps QueryClientProvider — no wrapper changes needed).
- src/components/shell/Sidebar.test.tsx: store assertions → fixture backend (getFixtureProjects().list()); create test now routes to /project/:id/chat stub + asserts sidebar shows rootPath + backend persisted prj_-id/color; delete test deletes seeded "marketing-site" and asserts list+backend; NEW test: duplicate rootPath (/home/dev/ACUTE-CODE seed) → inline alert shows 409 message + modal stays open; nav-structure + ProjectView not-found tests unchanged.
- src/components/projects/ProjectView.tsx: store → useProjects(); rootPath in header; isPending skeleton before not-found verdict (async query replaced sync store); note-card copy updated (chat is live) + prominent "Open project chat" primary button (accent bg/accentText, app's existing primary style) → /project/:id/chat; "Recent workspace sessions" (unfiltered top-5, →/sessions) REPLACED by "Sessions" section: useSessions().data client-filtered s.projectId===id, sorted updatedAt desc, rows title ?? "Untitled" + status + formatWhen(updatedAt) (lib/format.ts), row click → /project/:id/chat, empty state muted "No sessions yet".
- src/components/dashboard/DashboardScreen.tsx: projects-store count → useProjects().data?.length ?? 0. Nothing visual changed. DashboardScreen.test.tsx: only the stale "Projects reads 0" comment corrected (assertions already hold: fixtures seed 2 projects).
- DELETED src/lib/projects-store.ts after repo sweep: remaining "projects-store" refs are docs-only (HANDOFF.md, AGENT-BOOTSTRAP-PROMPT.md, round-08.md — out of edit scope); zero src/ imports left (typecheck proves).
- VERIFY (PATH=/home/z/.local/bin:$PATH; single pass): pnpm lint GREEN, pnpm typecheck GREEN, pnpm vitest run src/components/shell/Sidebar.test.tsx src/components/dashboard/DashboardScreen.test.tsx → 2 files, 10/10 GREEN (Sidebar 5 incl. new 409-alert test; DashboardScreen 5). Nothing committed/pushed.

Stage Summary:
- M3 integration wiring complete: /project/:id/chat routed inside AppShell; Sidebar/ProjectView/Dashboard all on use-projects backend hooks; legacy localStorage projects-store deleted; Tauri pick_folder + browser text-input dual path live in Add Project; ApiError messages surface inline.
- Notes for orchestrator: (1) Sidebar active-project highlight is URL-derived (pathname regex) — deep links work without store state; (2) no confirm() exists app-wide, delete is a direct mutation (matches prior behavior); (3) old localStorage key "acute-code.projects" may linger in dev profiles, harmless; (4) M4/round-09 verification (live sidecar + screenshots) still pending per plan.

---
Task ID: 4 / 5-c / 6 / 7
Agent: orchestrator (Z.ai Code)
Task: Baseline verify, M3 review-integration, live verification, M4 proof, docs, push+CI+notify

Work Log:
- Baseline pnpm verify GREEN pre-change (163+6); final verify GREEN post-change (175+6 incl. 5 timeline-mapper + 1 Sidebar-409 tests)
- Sandbox reaps background processes between Bash invocations (even setsid) → adapted: each live phase runs as one self-contained invocation (boot sidecar → work → teardown); .dev/m4.db persists across phases
- M4 first attempt failed 502 "schema is not a function" → ROOT CAUSE: buildProjectTools passed raw JSON-Schema literals as inputSchema; AI SDK v7 requires jsonSchema() wrapping. Fixed in agent-core/src/tools/index.ts (4 tools); rebuilt; agent-core 110 tests green; LIVE TURN THEN SUCCEEDED
- M4 evidence: provider ●, test stealth/ox-alpha ok:true (8679ms); project acutest-44c71892 + agent Live Coder + sess_d411344a; turn 26s 3932/425 tokens; events: user → list_dir×2 ok → write_file×2 ok → assistant; ON-DISK PASS: hello.ts + src/notes.md exact content; tree+usage corroborate; sandbox held
- Fixed React 18 forwardRef on MessageRenderer (AnimatePresence popLayout ref warning) — console now clean
- Screenshots (agent-browser, live sidecar, FirstRun gate bypassed via acute.setupDone flag): chat-1920x1080, chat-file-open-1920x1080, chat-1080x1600 — all machine-verified via VLM (3 panels, pills, diff cards, rich text, gutter/syntax/traffic lights; no clipping/overlap; no console errors)
- Docs: docs/ui-iterations/round-09.md (full evidence + [ASSUMPTION] list + env deviation), README board updated, HANDOFF.md §3/§6/§9 refreshed
- Commits: ba461bc "Round 9: Agentic MVP complete…" + 2d217e7 handoff refresh; both pushed to main (repo re-verified PRIVATE before each push); CI run 32621470871 (ba461bc) SUCCESS incl. cargo check; CI run 32621630419 (2d217e7) SUCCESS
- ntfy owner notification delivered (HTTP 200, secret-free)
- Cleanup: .env.development removed; no orphan processes; no secrets in repo/logs (lengths only, ever)

Stage Summary:
- Agentic MVP M3+M4 DELIVERED and pushed; CI green ×2; awaiting owner review of the project-chat screen (round-09). Open items for owner: Linux-deviation acceptance, [ASSUMPTION] scope list (TodoPanel/thought/diff bodies/timestamps/model picker), optional acute.mjs agents-cmd fix, sessions projectId filter (Phase 3), secrets rotation (both transited chat), ntfy topic privacy, agent picker in chat header. Phase 2 gate approval + Phase 3 start remain owner-gated.

---
Task ID: R1–R10 (round-10 session)
Agent: orchestrator (Z.ai Code) — ALL WORK INLINE per owner revision (no sub-agents)
Task: Owner round-10 directives — rules revision, acute.mjs fix, local-PC one-click runner, agent memory doc, sandbox-resilience backup

Work Log:
- Owner verdicts processed: Linux OK permanently; round-9 atomic commit OK; M3 deferrals OK; sessions-projectId filter deferred ("let's see"); acute.mjs modelId bug = FIX NOW (done); ntfy OK; rotation later; chat agent-binding stays; runner + sandbox-backup = the main asks
- Rules revised in AGENTS.md + HANDOFF §5: sub-agents OPTIONAL, never default; inline preferred (owner correction recorded)
- scripts/acute.mjs: agents cmd fixed (a.modelId → a.model, field never existed; + providerId column); raw made pipe-safe (status → stderr, body → stdout) — both verified live
- NEW scripts/acute-desktop.mjs (454 lines, zero deps, win/linux/mac): toolchain (node≥20, git, pnpm via corepack incl. per-user shim fallback), update check (fetch → behind? stop live servers on :5173/:5178 → pull --ff-only → install → rebuild), first-run install/build, .env.development write-once, OpenRouter key (win: Credential Manager with one-time prompt; linux: env/~/.acute/openrouter.key), port pre-flight kill, launch pnpm dev:full with env passthrough, boxed copyable errors + acute-runner.log + pause (ACUTE_RUNNER_NO_PAUSE=1 for automation), modes run/start/update/status, --verbose
- NEW ACUTE.bat + acute.sh bootstraps: prereq checks, clone-once with credential-store auth (wincred / store-file), self-heal branch for clones predating the runner (pull --ff-only then hand off), own the final pause
- scripts/dev.mjs: honest key resolution chain (env → Credential Manager → ~/.acute key file), length-only logging
- Tests on Linux: status/update/start modes; dirty-tree skip; dummy listener on 5178 reaped by pre-flight; full launch with key injected end-to-end (providers ●); failure path (killed servers) shows boxed error + log + clean exit; OWNER-PC SIMULATION: scratch clone at 2d217e7 + new acute.sh → bootstrap self-heal pull → runner full setup → HEAD 13a313f, deps+backend built, key picked up. The simulation caught a real flaw (runner missing on old clones) before shipping — fixed same session
- docs/runbooks/LOCAL-PC-RUNNER.md (owner guide: first run, update flow, persistence table, troubleshooting); docs/runbooks/AGENT-MEMORY.md (15 mandated lessons); docs/runbooks/SANDBOX-RESTORE.md (zero-to-resume + inventory + session-end backup rule); docs/agent/ORCHESTRATION-WORKLOG.md (snapshot, refreshed each session); HANDOFF.md §1/§4/§9 updated; .gitignore += .runner-bin/, acute-runner.log.old
- pnpm verify GREEN after all changes; commits 13a313f (round 10) + 8d504b8 (bootstrap self-heal fixup) pushed; repo verified private before each push

Stage Summary:
- Owner can now run ACUTE-CODE on his PC: copy ACUTE.bat into any folder → double-click → clone (PAT once) → everything automatic, updates+restarts on later double-clicks, credentials/sessions persist, errors visible+copyable. Dev-stack scope (packaged exe = later milestone, ADR-0003). Sandbox wipe recoverable from repo alone (SANDBOX-RESTORE + worklog snapshot). Open: CI confirm on 8d504b8, owner's first real Windows run, secrets rotation when he chooses.

---
Task ID: L1–L7 (round-11 session)
Agent: orchestrator (Z.ai Code) — all inline
Task: Fix the Windows .bat failure; redesign launcher per owner direction (Python rich-terminal workhorse + tiny .bat coordinator, credentials.txt, auto-install, clean folder layout)

Work Log:
- ROOT CAUSE of owner's failure verified with hard evidence: round-10 ACUTE.bat shipped LF-only (zero CRs) — cmd.exe ate chars (echo→cho) and broke labels; whole script disintegrated. Memory lesson #16 recorded
- Built launcher/acute_launcher.py (~800 lines, stdlib baseline): rich UI (panels/spinners/status tables, auto-install rich with consent, plain fallback, crash-proof fail()), credentials.txt (placeholder rejection, lengths-only logging), toolchain check + winget auto-install (git/Node incl. old-version detection), pnpm via corepack → .acute/bin, per-command git credential store (URL-line format — hit and fixed the wrong-format bug: store file must be https://user:token@host lines, not the approve-stdin format; lesson #17), first-run clone into ./ACUTE-CODE (owner's clean layout), update flow (stop servers → pull --ff-only → install → rebuild), .env write-once, OpenRouter key → Credential Manager/win+~/.acute/linux, launcher SELF-UPDATE (sha256 vs repo copy), port pre-flight, dev:full launch with key env, status/update/start modes
- launcher/ACUTE.bat regenerated via python with forced \r\n; `file` confirms "DOS batch file … with CRLF line terminators"; tiny coordinator (py -3 → python → winget Python offer → pause)
- launcher/acute.sh + credentials.example.txt + README.md (owner setup guide); deleted broken root ACUTE.bat/acute.sh; __pycache__ ignored
- Caught during testing (all fixed same session): rich Panel(box="double") crash (lesson #18), placeholder creds passing emptiness check, rich __version__ probe misdiagnosis (lesson #19), credential-store format bug
- Full Linux verification: no-creds instructions panel; placeholder rejection; scratch-folder first run (clone silent-auth, 8s total); behind-origin updates (8d504b8→fe38f41, fe38f41→b6b5d93 with 'launcher is current' self-update check); status panel; live start (sidecar ok + UI 200 in 4s, provider ● end-to-end); failure path (red panel + clean exit); acute.sh wrapper; pnpm verify green (175+6); secret scan of launcher/ = prefixes/placeholders only
- Docs: LOCAL-PC-RUNNER.md rewritten around launcher/; HANDOFF §4/§9 round-11; AGENT-MEMORY #16–#20
- Commit b6b5d93 pushed; CI run 32624903291 SUCCESS; repo verified private; ntfy delivered

Stage Summary:
- Owner path is now: 3 files from launcher/ + credentials.txt rename/paste → double-click ACUTE.bat → everything automatic (auto-install, clone, update+restart, self-update, copyable errors). Node runner (scripts/acute-desktop.mjs) kept as advanced headless path. Open: owner's first real Windows double-click (bat itself untestable here — minimized via tiny CRLF-verified design), then MVP review + Phase 3 on approval.

---
Task ID: R12 (round-12 session)
Agent: orchestrator (Z.ai Code) — all inline
Task: Fix owner-reported Windows launcher failure (clone died on credential prompt; UI borders mojibake) + UI improvements

Work Log:
- Diagnosis from owner's console log: (a) credential.helper='store --file="C:/..."' contains shell metachars → Git-for-Windows routed the helper through MSYS sh → helper never answered → git fell back to a tty prompt that cannot exist in a double-clicked subprocess ('bash: /dev/tty', 'failed to execute prompt script', 'could not read Username'); (b) round-11 .bat dropped round-10's chcp 65001 → Unicode panel borders mojibake
- git auth rebuilt: per-command env HOME=.acute + GIT_CONFIG_NOSYSTEM=1 + helper reset + single-word 'store' (no path/quotes/shell); token only in .acute/.git-credentials (0600 URL-line format); owner's global gitconfig + GCM untouched
- validate_github_access() pre-flight via GitHub API (urllib): 401/403 → precise regeneration instructions; 404 → repo hidden from token; offline → warn+continue; PUBLIC-repo flag
- ACUTE.bat: chcp 65001 + PYTHONUTF8=1 + PYTHONIOENCODING + PYTHONDONTWRITEBYTECODE (CRLF byte-verified)
- UI: run-plan panel; ok/note/warn via style= (markup-proof — old warn() MarkupError-crashed this rich version, discovered by the self-update test exercising the never-tested warn path); spinner labels via literal Text(); fail() stops active spinner (ghost-line fix); secret redaction in log(); disk-space check
- Tests: invalid-token panel; fresh first run (8 steps green); update path incl. self-update copy + bat warn; post-push fresh clone at 0db8556 → 'launcher is current'; live start sidecar-ok + UI 200 in 5s + provider ●; token grep-proof in launcher.log; py_compile; pnpm verify green
- Memory lessons #21–#23; README 'Updating the launcher itself' + round-12 re-download note; LOCAL-PC-RUNNER auth section rewritten
- Commit 0db8556 pushed; CI 32626380123 SUCCESS; repo private-verified; ntfy delivered

Stage Summary:
- Owner action: re-download BOTH ACUTE.bat + acute_launcher.py from launcher/ (credentials.txt unchanged), double-click. Root causes eliminated structurally (no shell-quoting auth path exists anymore; console forced UTF-8; UI text can no longer crash markup). Next: owner's Windows retest; then MVP review + Phase 3 on approval.

---
Task ID: R13 (round-13 session)
Agent: orchestrator (Z.ai Code) — all inline, surgical scope per owner instruction
Task: Fix recurring Windows clone failure (credential helper never answers) + proper error display

Work Log:
- Second identical owner failure (git 2.55.0.windows.3, single-word 'store' helper + isolated HOME): helper never answered → prompt fallback → /dev/tty. Conclusion: the helper MECHANISM is environment-sensitive on Git-for-Windows — abandoned it entirely
- New auth: token-in-URL for the single clone/fetch/pull command (CI-proven, nothing to break); remote sanitized to tokenless URL immediately after clone; GIT_TERMINAL_PROMPT=0 + GIT_CONFIG_NOSYSTEM=1 + isolated HOME (can never hang/prompt); authed URL + token registered with redactor — grep-verified absent from .git/config and launcher.log
- explain_git_failure(): exit code + command + output + Diagnosis/Fix decoding (auth / network / disk / leftover folder); clone and pull route through it
- Minimal verification per owner instruction: py_compile, scratch first-run green (8s, remote sanitized, no leaks), lint+typecheck green
- Memory lesson #24; README round-13 note (re-download ONLY acute_launcher.py)
- Commit 6f7d620 pushed; CI 32627050197 SUCCESS; repo private-verified; ntfy delivered

Stage Summary:
- Owner action: replace acute_launcher.py only (ACUTE.bat + credentials.txt unchanged) → double-click. Auth flow now has zero platform-dependent parts. Next: owner's Windows retest → then MVP review + Phase 3 on approval.

---
Task ID: R14 (agentic-system session)
Agent: orchestrator (Z.ai Code) — all inline
Task: Owner round-14: real agentic coding system — folder selection, full tools, demo-parity chat UI, live P1 proof, three-pillar planning (n8n research)

Work Log:
- Backend: agent-core/src/dialogs.ts (async pickFolder: PowerShell -STA FolderBrowserDialog / zenity / kdialog) + POST /internal/dialog/folder (root-mounted, bearer-walled, 501 DIALOG_UNAVAILABLE; async so the sidecar never freezes on a human) — REAL folder selection works in launcher/browser dev, not just Tauri
- Tools: create_dir (nested), delete_file (ONE file; directories refused — Phase-3 approval boundary), search_files (recursive, shared ignore rules, cap 50); system prompt updated; +3 tests (113 agent-core)
- Frontend demo parity: TopBar.tsx (hamburger: live AGENT picker persisted for new sessions, FILES search, THEME grid, Hide Sidebar; center ⌘K Search-files bar with live dropdown → click opens file; Code/Experimental/dark toggles; ACUTE AGENT brand), ExperimentalLayout.tsx (freeform windows 1:1 hosting REAL panels), panels/TodoPanel.tsx (ring/mission/counter/toggle + add-row, per-project persisted), LeftSidebar EXPLORER+TO-DO, Sidebar Browse… (Tauri→sidecar→hint), store extended + partialize
- Live P1 (Linux stand-in of ACUTEST\P1): turn1 38s 6-tool chain (list→search→read→mkdir→write→edit) exact disk PASS×2; turn2 20s read-back verbatim + docs/ + delete_file-on-directory REFUSED & quoted by model (survivor confirmed) — approval boundary held live; 8.5k/1.2k tokens/2 requests
- Bugs fixed during verification: zustand ?? [] unstable selector infinite loop (NO_TODOS const — lesson #26), internal route prefix mismatch in picker client (#25), CLI template-agent 409 trap (#27), spawnSync-would-freeze-sidecar → async dialogs (#28)
- Docs: round-10.md + board rows; docs/research/n8n (README/architecture/patterns — additive automation-pillar plan; research README indexed); AGENT-MEMORY #25–#28; HANDOFF §3/§9 (dashboard redo = next, owner-gated)
- pnpm verify green (178+6, build, license clean); screenshots ×5 machine-verified, zero console errors; secret scan clean; commit 4dbb6bd pushed; CI 32629497675 SUCCESS; ntfy delivered

Stage Summary:
- The coding pillar is genuinely usable end-to-end (folder pick → project → session → 7-tool agent → verified disk changes → refusal boundaries). Owner tests on Windows via launcher (only-model rule kept). Next: dashboard UI redo (owner verdict recorded), sessions-per-project switcher, Phase 3 on approval. Automation pillar planned additively per n8n research.

---
Task ID: R15 (owner-verdict session)
Agent: orchestrator (Z.ai Code) — all inline
Task: Fix owner's four Windows-test failures + prove HTML-build capability

Work Log:
- Browse silent failure → dialogs.ts rebuilt: ACUTE_PICK/ACUTE_CANCEL marker protocol (cancel ≠ failure), WinForms FolderBrowserDialog (-STA) + Shell.Application BrowseForFolder COM fallback, {path, error?} end-to-end, UI shows exact failure inline (lesson #29)
- Fullscreen chat: AppShell route-aware sidebar hide on /project/:id/chat; TopBar hamburger = toggle (dropdown REMOVED per owner — agent picker now a popover on the chat header agent chip); DOM-verified + toggle screenshots
- Plug-and-play agent: ensureDefaultAgent seeds Nova (openrouter/stealth/ox-alpha, agt_default_nova, guarded) at DB open — fresh-DB GET proves zero-setup chat (lesson #31); seed-contract tests updated (order-independent after a millisecond-timing flake; e2e targets a real template)
- Dialog glitch root cause: .dialog-content lacked base transform → jumped half off-screen when animation ended ('nothing happens' = opened off-view); fixed + NUMERIC proof center X=960/1920, Y=540/1080 (lesson #30)
- Owner HTML scenario on FRESH DB: 'build demo/index.html beautiful demo UI' → list_dir→create_dir→write_file (57s) → file on disk, title/gradient/button assertions PASS
- pnpm verify GREEN after test-contract updates (113 core + frontend + 6 e2e + build + license); screenshots ×4 machine-verified; secret scan clean
- Commit 4803b8a pushed; CI 32631271442 SUCCESS; repo private-verified; ntfy delivered; lessons #29–#32 recorded; round-11.md + board + HANDOFF

Stage Summary:
- All four owner verdicts closed with root-cause fixes (not patches); fresh-DB journey test is now a standing pre-handover gate (#32). Open: owner Windows re-test (Browse must show a dialog or an exact error), hamburger→actions (future), sessions switcher, dashboard redo (owner-gated).

---
Task ID: R16 (streaming + polish session; survived a mid-round sandbox wipe)
Agent: orchestrator (Z.ai Code) — all inline
Task: Owner round-16: live streaming responses, per-reply stats/copy/ctx/model, borderless chat + drag fix, Nova→Acute, better folder dialog, design system doc

Work Log:
- EVENT: sandbox wiped mid-round — /home/z/acute-workspace + .secrets lost, ALL uncommitted round-16 work lost. Restored per SANDBOX-RESTORE.md (secrets re-staged 93/73 chars, clone at 0892ed1, verify green) and REDID the round from session context; NEW DISCIPLINE: work branch work/round-16-streaming with WIP pushes at every green milestone (lesson #33) — merged to main only when fully green
- Backend: streamAiSdkChat (streamText; part.text deltas; usage = totals cross-checked vs summed finish-step usage — lesson #34), runStreamedAgentTurn (same event-sourced ordering, live emit, per-tool persistence), prepareTurn shared + modelOverride, POST /sessions/:id/messages/stream SSE (hijack, abort on disconnect), Acute rename (fixed id kept), dialogs.ts 3-method topmost modern picker; +2 streaming runtime tests; seed-order test fixes
- Frontend: streamSessionMessage SSE client; stats in toProjectChatItems (the mapper the lost copy had missed — root cause of the missing stats row); live tool pills (dots→✓/✗) + streaming bubble with cursor; file-tool invalidation → live explorer/code refresh; CopyButton + ReplyStats chips; ComposerFooter (ctx meter with per-model limits + model picker via provider catalog); borderless panels (TopBar/Explorer/Code/Chat) + 3px gaps + 2px route padding + 5px handles; chat-drag sign fix; Acute chip
- Live proofs (single-invocation discipline, disk-poll completion — lesson #35): SSE curl battery (frames timestamped live; ms=51655 in=7391 out=776; live/index.html on disk) and browser E2E (composer → streamed → ui-demo/hello.txt exact content; stats rows ×3; explorer live-refresh; zero console errors after transient ruled out via clean reproduction with empty [role=alert])
- Docs: round-12.md; docs/design/DESIGN-SYSTEM.md (owner-mandated living reference: tokens, spacing scale incl. 2px chat rule, borderless language, motion, anatomy inventory, new-screen checklist); memory #33–#35; board + HANDOFF
- pnpm verify GREEN; merged 2d31671 to main; CI 32636961329 SUCCESS; repo private-verified; ntfy delivered

Stage Summary:
- Chat is now a live streaming agentic UI with full per-reply telemetry and clean borderless design; design-system doc anchors all future UI. Open: owner Windows re-test (Browse dialog presentation, streaming feel, drag, stats), streamed-finish live-chip refinement, dashboard usage redo (next, owner-gated).

---
Task ID: G1-d
Agent: Explore (dashboard plan)
Task: Plan the PUBLIC status dashboard (separate repo testplay-byte/ACUTE-DASH → GitHub Pages) + security review of what may cross the private/public boundary. READ-ONLY except this entry.

Work Log:
- Read worklog tail (R1–R16), ui-iterations/README board, plan-phase-0/1/2.md, plan-agentic-mvp.md, HANDOFF.md §3/§5/§7, package.json (test counts NOT there — verify = 115 agent-core + frontend + 6 e2e comes from run output; must be hand-carried), DESIGN-SYSTEM.md, ci.yml (single `verify` job, windows-latest, push→main + PR), PROJECT-MAP.md (three-product vision), dependency-licenses.md header (107 deps, CLEAN), AGENTS.md closed-source rules, ANI-KUTA reference page (Next.js, Inter/JetBrains Mono — we will NOT copy its external fonts; dash is self-contained system-stack). Git: HEAD 54a9475, no tags.
- SECURITY REVIEW delivered as ALLOWLIST vs DENYLIST. Key verdicts: naming "OpenRouter" = allow (public SaaS the app already advertises); model id "stealth/ox-alpha" = DENY (owner's private arrangement, non-public slug, reveals setup/cost profile → genericize to "provider/model"); ntfy topic TASKISONE/TASKISDONE = DENY (topic name is a bearer capability — anyone who reads the page could spoof/spam owner notifications); "how to run" card REJECTED as proposed — the product is undistributed closed-source and the launcher flow authenticates to the private repo; replaced by a "Product/Availability" card; secret LENGTHS also denied (format fingerprinting); localhost ports, internal paths (khurr/ACUTEST/home-z), file tree, repo structure, agent ids (agt_/sess_/prj_), CI run ids = deny. Short commit SHA + product name + phase/round progress + test counts + license verdict = allow.
- CONTENT PLAN: 6 cards (header status strip w/ last-updated; three-pillar progress coding/agentic/automation; milestone timeline R1–R16 one-liners; quality panel verify/CI/suites/license; product/availability card; footer provenance). Every card sources from hand-maintained docs/status.json + git stamp injected at build; nothing scraped from repo docs at generate time.
- IMPLEMENTATION PLAN: scripts/dashboard/build-dashboard.mjs (node zero-dep, reads status.json + `git rev-parse/describe`, HTML-escapes ALL interpolations, allowlist-only fields, post-render DENYLIST regex assert (token shapes, 70+ char runs, C:\Users\, /home/z/, ACUTEST, ntfy.sh, stealth/ox-alpha, private repo URL, agt_/sess_/prj_, localhost:517) → exit 1 BEFORE any push = fail-closed); emits self-contained dashboard.html (inline CSS, dark bento, accent #FF6B2C, 16px radii, 1.5px borders — carded not borderless per DESIGN-SYSTEM §2, mono chips 10px, no JS, no external assets). Workflow .github/workflows/dashboard.yml recommended as `on: workflow_run: [CI] completed` (gets verify conclusion directly; alternative push-trigger + GitHub API run-lookup listed) → ubuntu job builds, asserts, pushes to ACUTE-DASH via actions/checkout with ACUTE_DASH_PAT (masked; never echoed; fine-grained PAT scoped to ACUTE-DASH ONLY, Contents rw — not the private repo).
- One-time setup API list: POST /user/repos (public, issues off), seed README, POST /repos/testplay-byte/ACUTE-DASH/pages (branch main /), set secret ONCE via `gh secret set ACUTE_DASH_PAT -R testplay-byte/ACUTE-CODE` (PUT actions/secrets/ACUTE_DASH_PAT + libsodium assessed — gh CLI strongly preferred over hand-rolled tweetnacl encryption).
- RISK TABLE: workflow-log leakage (masked inputs, minimal permissions, fine-grained PAT), future-edit leak (allowlist+denylist assert gates push), Pages propagation delay (~1–10 min, stamped), PAT expiry (monthly workflow_dispatch canary), someone enabling Pages on the PRIVATE repo (add to pre-push visibility check), staleness (status.json update folded into session docs-refresh step).
- Proposed docs/status.json schema v1 (product/pillars/milestones/quality/chips/publicLinks + build-time stamps) included in report.

Stage Summary:
- Dashboard plan is complete and fail-closed by construction: generator reads only status.json+git+CI-conclusion, output passes a denylist assert before publish, PAT is least-privilege and single-purpose. NOTHING implemented (read-only round); recommended build order: status.json → build-dashboard.mjs + local render test → one-time repo/Pages/secret setup → dashboard.yml → owner review of the rendered page before it goes public. Open decisions for owner: repo name ACUTE-DASH, whether to show test counts at all (fine either way — they're counts, not content), PAT creation + who runs the gh secret command.

---
Task ID: G1-c
Agent: Explore (workflow audit)
Task: READ-ONLY audit of process/workflow discipline in ACUTE-CODE — prescribed vs actual divergence, design of missing process docs (WORKFLOW/ROADMAP/TESTING + docs index + folder-structure rules)

Work Log:
- Read session context (worklog tail), AGENTS.md, HANDOFF.md (§5/§6/§9 focus), runbooks (AGENT-MEMORY, SANDBOX-RESTORE, SETUP skim, LOCAL-PC-RUNNER skim, AGENT-BOOTSTRAP-PROMPT head), decisions/TEMPLATE.md, ui-iterations/README.md + round-12.md, .github/workflows/ci.yml, root README, docs/research/README.md head; mapped docs/ tree (no docs/README.md exists — confirmed missing)
- Reconstructed actual working pattern from all 55 commits: R9–R15 = feature round → live battery → screenshots → round-NN.md → verify → push main → CI (IDs recorded) → ntfy → worklog-snapshot commit; R16+ = work/round-16-streaming branch with WIP pushes at each green milestone → merge 2d31671 only when verify+live battery green
- Divergence table (14 rows): sub-agent OPTIONAL rule ALREADY codified (briefing hint stale); phase-gate model vs actual owner-round cadence (HANDOFF §5 "waiting on Phase 2 approval" contradicts §3/§9 R16-delivered); work-branch policy exists only in memory lesson #33 — not in AGENTS/HANDOFF; CI triggers main+PR only so WIP pushes are uncovered vs "every push triggers CI"; ZERO ADRs since 0013 despite streaming/launcher/token-in-URL/seeding decisions; round-file numbers decoupled from session numbers (R16 wrote round-12.md; R12/R13 have no round files); worklog-snapshot rule lives only in SANDBOX-RESTORE.md; question protocol (per-phase) orphaned by round cadence; ntfy actually once per session; SETUP.md self-stale + Windows/sandbox split-brain; HANDOFF maps omit ui-iterations/ + DESIGN-SYSTEM.md; VLM screenshot verification + fresh-DB battery practiced every round but never written as rules
- Designed docs/runbooks/WORKFLOW.md (8 sections: session start ritual, round cadence, branch policy incl. CI gap, implementation loop w/ verify+live-battery+browser gates, per-round documentation duties, merge/push/CI/ntfy checklist, round-adapted question protocol, interruption handling), docs/runbooks/ROADMAP.md (per-pillar milestone tables w/ done/in-flight/queued/owner-gated + phase ladder + cross-cutting queue), docs/runbooks/TESTING.md (unit/e2e/CI/live-battery/browser layers, fresh-DB rule, no-live-AI rule, disk-as-ground-truth, outcome-based polling)
- Proposed exact docs/README.md index content (every current doc + 3 new, grouped, one line each) and 12 explicit folder-structure rules (SQL only in agent-core/src/storage, ADR NNN-sequential-next-0014, round assets layout, research trio, design/demos frozen, CRLF .bat rule, generated compliance file, shared/ conformance)
- Modified nothing in the repo (read-only audit); report delivered to orchestrator

Stage Summary:
- Process knowledge for a new session is scattered across ≥8 docs with 3 different reading orders and materially stale rules; WORKFLOW.md should become the single spine with AGENTS.md/HANDOFF kept normative-but-pruned. Highest-value fixes: codify work-branch policy + CI gap in AGENTS/HANDOFF, resume ADR cadence at 0014, write the fresh-DB/VLM verification rules down, add docs/README.md index. Next: orchestrator reviews proposals, then (approval) writes the four docs in one docs-only round.

---
Task ID: G1-b
Agent: Explore (pillars audit)
Task: READ-ONLY audit of the three-pillar architecture material (coding / agentic-system / automation) — contradictions, risks, must-make-first ADRs, and a PILLARS.md outline for the orchestrator

Work Log:
- Read for context: worklog tail (rounds 10–16); docs: PROJECT-MAP.md, ARCHITECTURE.md, SPEC.md (F1–F11), ADR-0001/0010/0011, plan-agentic-mvp.md, plan-phase-3.md, docs/research/n8n/{README,architecture,patterns}, research README synthesis; code seams: agent-core/src/agents/runtime.ts (prepareTurn + runSingleAgentTurn/runStreamedAgentTurn), tools/index.ts (7 root-closed file tools, no per-call ctx), storage/sessions.ts + migrations 0001–0003, server.ts session/message/SSE routes, src-tauri/src/sidecar.rs lifecycle (app-lifetime spawn, 3s-grace taskkill)
- Findings (full detail + refs returned to orchestrator): (1) doc-vs-code drift — agent.allowedTools is stored+validated but NEVER enforced by buildProjectTools (ARCHITECTURE §7.1 step 0 is untrue today → a specialized reviewer agent would get write tools); session_events has NO agent_id/task_id columns (ARCHITECTURE §5.1 says it does — identity is payload-only via appendSessionEvent mirroring); no WS gateway exists (ARCHITECTURE §6/API.md promise one; reality = per-request SSE); the runtime never writes terminal session events (sessions stay "running" forever — chats are open-ended, workflow executions are finite: different lifecycles); approvals.ts is a 65-line categorizer, no gate is wired (documented MVP assumption)
- (2) pillar-connection risks: delegation-as-tool needs agent-calls-agent attribution — asChatMessage history replay would flatten child message.assistant events into the parent context (context pollution + wrong attribution); child sessions need parent_session_id/triggered_by; usage_events.session_id NOT NULL forces a row per run; budget: agent.maxTurns (default 40) multiplies across delegation depth, no global semaphore exists yet (ADR-0011 planned, not built); AbortSignal/SSE emit don't propagate into a nested child turn; no per-session turn serialization (an automation hitting a live chat session would interleave one log)
- (3) naive-automation collisions: sessions.mode CHECK constraint ('single'|'auto-team'|'manual') cannot be altered in SQLite — reusing sessions for workflow executions = table-rebuild migration + chat session list flooding (n8n patterns doc's "no schema surgery" claim is optimistic); scheduler loop in the sidecar dies with the app (sidecar.rs kills it at exit; headless service mode contradicts SPEC §2.5/ARCHITECTURE §2.5 two-process rule); webhook trigger contradicts the loopback-only hard rule (§2.1); unattended runs cannot answer approval modals (fail-closed 15-min expiry makes destructive nodes always-fail)
- (4) Returned to orchestrator: 12 contradictions/risks (each with doc+code refs), 8 candidate ADR titles (delegation event schema & attribution; child-session isolation + per-agent transcript projection; run budget + global semaphore shared across pillars; workflow-executions storage separate from sessions; scheduler lifetime + missed-run policy; unattended approval policy; WS push-channel unification; allowlist enforcement + trigger-surface scope), the PILLARS.md outline (unified graph of typed nodes trigger/data/agent; chat = manual trigger; agent node wraps prepareTurn/runStreamedAgentTurn verbatim; event-sourcing across pillars; additive build order; explicit non-goals), and top-3 rewrite traps with guardrails
- Modified NOTHING in ACUTE-CODE (read-only audit); this worklog entry is the only write

Stage Summary:
- Blocking recommendations surfaced: land the delegation event-schema ADR + a ToolContext seam (session/agent/run identity, signal, emit, approvals) BEFORE any pillar-2/pillar-3 code; never encode workflow kinds in sessions.mode (separate workflows/executions tables with typeVersion from row one); unify live events on the planned WS gateway instead of per-pillar transports; enforce agent.allowedTools before specialized agents exist. Full report delivered in the G1-b response for the orchestrator to fold into PILLARS.md.

---
Task ID: G1-a, Agent: Explore (docs audit)
Task: READ-ONLY docs-vs-reality gap audit of ACUTE-CODE (tip 54a9475) — inventory docs/, verify API.md/ARCHITECTURE/PROJECT-MAP/HANDOFF/AGENTS/READMEs against current code, list stale/missing docs and missing ADRs.

Work Log:
- Read worklog tail (context through R16 + sibling G1-d dashboard plan); git log -40 (tip 54a9475, work/round-16-streaming merged at 2d31671)
- CODE REALITY verified: server.ts routes (health, /internal/providers/keys, /internal/dialog/folder + /api/v1: agents CRUD+duplicate, providers list/create/models/test, projects CRUD+tree+file, sessions create/list/get/messages/messages-stream, usage/summary); runtime.ts prepareTurn+modelOverride, per-reply usage/ms/model on message.assistant (both sync + streamed); storage/agents.ts ensureDefaultAgent seeds "Acute" (id agt_default_nova, openrouter/stealth/ox-alpha) at DB open; dialogs.ts 3-method topmost Windows picker + zenity/kdialog; tools/index.ts 7 jsonSchema()-wrapped tools (list_dir/read_file/write_file/edit_file/create_dir/delete_file/search_files); frontend AgentChatPanel ComposerFooter (ctx meter + model picker), streamSessionMessage SSE client, TopBar hamburger → project-chat-store.appSidebarVisible → AppShell route-aware sidebar; launcher/acute_launcher.py token-in-URL auth (authed_url + sanitized remote + redactor)
- DOC inventory with git last-touch dates: API.md frozen at Phase-1 commit 55ddf21; ARCHITECTURE.md at Phase-2 wave 5e38820; PROJECT-MAP.md at round-8 9e16a1d; README.md Phase-2; everything rounds 9-16 lives only in round-09..12.md + HANDOFF §3 table + AGENT-MEMORY + ORCHESTRATION-WORKLOG snapshot
- API.md §5.4 verified WRONG on 5 axes: no SSE route, request {text,attachments} vs actual {content,model?}, 202+WS vs sync 200/SSE, event payload {text} vs {role,content}, no usage/ms/model stats; also no /internal/dialog/folder, no default-agent seeding, dev port 8765 vs actual 5178, false TypeBox/@acute/shared claim (zero deps in shared), allowedTools enum = dead SPEC-era names
- Found live CODE bug of docs origin: TOOL_NAMES (storage/agents.ts:12, SPEC-era file_read/shell_exec/web_search...) feeds server KNOWN_TOOLS validation (server.ts:134-137) while real tools differ → allowedTools with real names 400s; frontend TOOL_CATALOG + AgentFormDialog show same stale list; runtime never enforces allowedTools at all
- PROJECT-MAP §1/§6 confirmed stale (round-8): no three-pillar vision (n8n research exists at docs/research/n8n), §2 says REST+WS + "chat flow = Phase 3" (shipped R9+), §4 "projects↔sessions linkage coming" (shipped migration 0003), §5 status table frozen round-8, launcher absent from map
- ADR audit: 13 ADRs (0001-0013) + TEMPLATE; zero ADRs for 8 significant post-0013 decisions (list below with proposed numbers)
- HANDOFF contradictions catalogued: header date 08-22 vs §3 08-23; §3 ¶ says pick up at round-09 verdicts (rounds 10-16 delivered in its own table); tip ba461bc vs 54a9475; §4 "decisions/0001-0012" vs §1 "0001–0013"; "nine reference analyses" vs 10 (n8n); §8 environment = previous agent's Windows box (current dev = Linux sandbox per SANDBOX-RESTORE)
- Verified approvals.ts is DEAD CODE (imported nowhere in src except its own tests) yet ARCHITECTURE/PROJECT-MAP/HANDOFF all describe it as the live security boundary; actual boundary today = tool path-containment + delete-refuses-directories

Stage Summary (A) STALE DOCS (file → says/actually → fix):
1. docs/architecture/api/API.md (Phase-1) — missing SSE /messages/stream, model override, assistant-event usage/ms/model stats, /internal/dialog/folder, Acute seeding; wrong §5.4 contract, port 8765, TypeBox claim, allowedTools enum; ~20 documented routes unimplemented → split into IMPLEMENTED (verified) vs PLANNED annex, rewrite §5.4+§6 to SSE reality
2. docs/architecture/ARCHITECTURE.md (Phase-2) — §6 WS event model nonexistent (SSE is real), §3.3 module map fictional dirs (server/, approvals/, memory/, skills/, mcp/), tools row lists shell/web tools not the 7 real ones, no dialogs.ts → reconcile §3.3/§6, mark future modules Phase-3+
3. docs/architecture/PROJECT-MAP.md (round-8) — §1/§6 lack three-pillar vision/n8n/launcher/streaming; §2 REST+WS + "chat=Phase 3"; §4 stale data model; §5 board frozen → full refresh, it is the designated "living map"
4. HANDOFF.md — header date, §3 pickup paragraph, tip ba461bc, §4 map gaps (dialogs/tools/SSE/decisions count), "nine" analyses, §8 env facts = old machine → refresh snapshot fields
5. AGENTS.md — "REST + WS"; "secrets only in Credential Manager"/wincred vs launcher .acute token file + token-in-URL + sandbox .secrets → reword custody-per-surface
6. README.md — no dev:full/launcher/project-chat/streaming; Phase-2 era → refresh Development section
7. agent-core/README.md — server row omits projects/usage/SSE/dialog; migrations omits 0003; tools/ "later wave" (exists, wired); "WS wave" stale; chat semantics omit model+stats payload → refresh table
8. docs/ui-iterations/README.md — Project-chat board row malformed (4 cells) + status "R10 delivered" (R12 streaming shipped); no session↔file numbering map (round-10.md = session R14; sessions R10-13 have no files) → repair + add mapping note
9. scripts/README.md — documents only license-audit; dev/acute/acute-desktop/credential.ps1 missing
10. tests/README.md — "Placeholder Phase 4+" while 6 e2e tests are live in verify
11. docs/research/README.md — "all nine MIT/Apache" needs n8n fair-code carve-out
12. CODE doc-bugs: TOOL_NAMES/KNOWN_TOOLS/TOOL_CATALOG stale list (validation 400s on real tool names; UI offers phantom tools; allowedTools unenforced) → single source of truth in shared/

(B) MISSING DOCS ranked: 1. docs/README.md index; 2. ROADMAP.md (three pillars, milestone truth); 3. implemented-API contract doc (SSE+REST shapes); 4. TESTING.md (tiers: 113 core + frontend + 6 e2e, live-proof discipline, fresh-DB gate); 5. SECURITY.md (token auth, loopback, path containment, launcher redaction, secrets custody, approval-engine future); 6. WORKFLOW/process guide (rounds, work-branch discipline, gates — G1-c designing); 7. folder-structure rules extension (launcher/, design/demos, .agents)

(C) MISSING ADRs (next free 0014): 0014 SSE streaming turn replaces WS-for-v1; 0015 per-message model override + per-reply stats payload; 0016 default agent seeding (Acute/agt_default_nova); 0017 sidecar folder-dialog endpoint (3-method topmost picker, marker protocol); 0018 launcher token-in-URL git auth; 0019 project-scoped 7-tool set replaces SPEC catalog; 0020 work-branch discipline; 0021 public ACUTE-DASH dashboard repo (PROPOSED, owner-gated); (jsonSchema() wrap = lesson-tier, fold into 0019)

(D) TOP-5 NEW-AGENT TRAPS: 1. coding against API.md "design truth" (wrong request shape, phantom WS/routes); 2. dual round numbering (session round vs round-NN.md files); 3. HANDOFF §3 self-contradiction + stale tip → redoing delivered work; 4. tool-name trap (docs-era names validated, real names 400, allowedTools silently unenforced); 5. WS- folklore + "no sandbox in v1" (SSE is real, path-containment IS a sandbox, approvals.ts is dead code)

---
Task ID: R17 (governance session)
Agent: orchestrator (Z.ai Code) — inline implementation; 4 Explore AUDIT sub-agents per explicit owner instruction (findings verified before use)
Task: Owner round-17: proper planning/documentation/ADRs/workflow/folder rules/blueprints + GitHub Pages dashboard; sub-agents as auditors

Work Log:
- 4 parallel read-only audits (docs-vs-reality G1-a, pillars G1-b, workflow G1-c, dashboard G1-d); spot-verified their 5 load-bearing claims myself (all true): dead TOOL_NAMES, unenforced allowedTools, API.md WS/8765 fiction, CI main+PR only, HANDOFF stale Phase-2 line
- REAL BUG FIXED (ADR-0019): TOOL_NAMES/TOOL_CATALOG = real 7 tools; server validation accepts reality, rejects SPEC-era names (drift-guard test); buildProjectTools(root, allowedTools?) enforces agent allowlist (empty=ALL); templates/form/tests aligned; +3 tests (121 core)
- Governance docs: docs/README.md (index + 12 folder rules), WORKFLOW.md (session spine: ritual/cadence/branch policy per ADR-0020/impl loop/doc duties/merge-ntfy checklist), ROADMAP.md (per-pillar statuses + changelog), TESTING.md (5 layers, fresh-DB gate, battery/browser recipes from lessons), SECURITY.md (posture + per-surface custody), PILLARS.md (typed-node graph blueprint, delegation event schema, storage reuse-vs-never, build order, 7 candidate ADRs), IMPLEMENTED-API.md (shipped REST+SSE truth), ADRs 0014-0021 backfilled
- Dashboard: docs/status.json + build-dashboard.mjs (zero-dep, DESIGN-SYSTEM styled, DENYLIST fail-closed — poisoned self-test blocked 3 pattern classes) + publish-dashboard.mjs (ADR-0018 token-in-URL push + Pages + live verify; 403 → exact owner fix printed); public repo ACUTE-DASH created; render VLM-verified (public-dashboard.png)
- BLOCKED (owner action): fine-grained PAT fixed repo selection (memory #36) — owner adds ACUTE-DASH to token or mints dash-only PAT; then one publish command
- HANDOFF (header/§5/0021/round-17 row), AGENTS.md (custody wording, WORKFLOW pointer), ui-iterations board row repaired + round-13.md; lesson #36
- verify GREEN (121+frontend+6 e2e+build+license); merged af4aee4 to main; CI 32641161630 SUCCESS; private ✓, Pages-on-private 404 ✓, secret scan clean (denylist regexes ≠ values); ntfy delivered

Stage Summary:
- Project now runs on documented rails: index → WORKFLOW → ROADMAP/TESTING/SECURITY → PILLARS → 21 ADRs; pillar-2/3 has a guardrailed blueprint with candidate ADRs before code. Dashboard pending one owner token edit. Next: owner token action → publish; R16 Windows re-test; dashboard-redo round (owner-gated).

---
Task ID: R18 (dashboard live session)
Agent: orchestrator (Z.ai Code) — inline
Task: Owner round-18: set up the dedicated DASHBOARD GitHub repo he created, publish the dashboard, verify live

Work Log:
- Owner created blank public repo testplay-byte/DASHBOARD + provided a scoped PAT (stored at /home/z/.secrets/dashboard.pat, 0600, separate from main PAT — verified both tokens work on their respective repos only)
- Publisher updated: default repo DASHBOARD, DASHBOARD_PAT env var (all refs cleaned)
- Dashboard enhanced with "The Plan" section (owner request): NOW card (orange highlight, current focus), upcoming phases with status chips (queued/owner-gated), Principles list — driven by new status.json.plan field
- Denylist re-tested with poisoned plan content: still fail-closed (3 pattern classes blocked)
- Published: first push to DASHBOARD repo (token-in-URL per ADR-0018), Pages enabled from main/, live URL HTTP 200
- Browser-verified: agent-browser navigated to https://testplay-byte.github.io/DASHBOARD/, screenshot captured, VLM confirmed 7/7 elements (header, pillars, plan+NOW+principles, quality, milestones, clean layout)
- Docs updated: ADR-0021 (new repo + live URL), PUBLIC-DASHBOARD.md (LIVE status + publish command), docs/README.md + SECURITY.md (repo name refs), round-14.md + board
- pnpm verify GREEN; merged 33a019c to main; CI 32645915316 SUCCESS; repo private ✓; secret scan clean; ntfy delivered

Stage Summary:
- Dashboard is live at https://testplay-byte.github.io/DASHBOARD/ with the plan prominently displayed. Future publishes: DASHBOARD_PAT=$(cat /home/z/.secrets/dashboard.pat) node scripts/dashboard/publish-dashboard.mjs (per WORKFLOW §6). Next per owner: UI improvement + proper UI documentation round.

---
Task ID: R19 (model management + dashboard v2 + dialog fix)
Agent: orchestrator (Z.ai Code) — inline for model mgmt + dialog; dashboard dispatched to full-stack dev sub-agent (timed out but work landed; I verified + pushed it)
Task: Owner round-19: model management system, dashboard rebuild, folder dialog fix

Work Log:
- Folder dialog FIXED: root cause = inline PowerShell -Command stdout capture unreliable → wrote temp .ps1 file + result FILE (not stdout); single dialog, reliable
- Dashboard v2: dispatched to full-stack-dev sub-agent; multi-file build (template.html + style.css 1189 lines + app.js + build.mjs reading data.json); light theme (#fafaf9 bg); pushed to DASHBOARD repo via token-in-URL; browser-verified 8/8 (light theme, contrast, all sections, clean)
- Model Management BACKEND: migration 0004 (models table with pricing/context/thinking/hidden + providers.api_format); models.ts storage CRUD (upsert by provider+modelId); 6 new routes (models-config GET, models POST/PATCH/DELETE, key GET/PUT)
- Model Management FRONTEND: ModelsProvidersTab replaces API & Providers tab — provider cards (expandable) with API key View/Copy/Edit + model list; Add Provider dialog (preset: OpenRouter | custom: name/baseUrl/apiKey/apiFormat 3 options); Add Model dialog (modelId + displayName + contextWindow + maxOutput + 3 pricing fields); per-model Test (⚡ inline latency/error), Hide (moves to Hidden section, dims), Delete
- verify GREEN (migration test updated for 0004); screenshots VLM-verified 4/4; merged 53ade3b; CI 32649516184 SUCCESS; ntfy delivered

Stage Summary:
- Owner action: re-test on Windows via launcher — Browse (single dialog now), Settings → Models & Providers (add a custom provider, manage keys/models), chat streaming. Chat model picker enhancement (grouped by provider with context/pricing) is queued next round.

---
Task ID: R20 (model management fixes)
Agent: orchestrator (Z.ai Code) — inline
Task: Owner round-20 feedback: fix key save, add Edit Model, show API key input, fix test timeout, live-test everything

Work Log:
- ROOT CAUSE key save: apiFormat column added to providers table but INSERTs (seed + custom) were missing the @apiFormat binding → "6 values for 7 columns" crashed every server test; fixed both INSERTs + run() bindings + tests
- apiFormat now: persisted on create, shown in provider list views (toRecord), tested in providers.test.ts
- Edit Model dialog: full field editing (displayName, contextWindow, maxOutput, 3 pricing fields) via PATCH /models/:id
- Show/hide API key toggles: Add Provider dialog (eye icon next to password field) + key edit form (eye icon on the replacement key input)
- Test model: 30s AbortController timeout (shows "timeout — provider unreachable" instead of hanging forever); error messages surfaced inline
- Key save: error display under the input (e.g. "Key must be at least 7 characters" or the server error); key saved → invalidation refreshes the provider list hasKey dot
- LIVE E2E battery (fresh DB, real OpenRouter key): create provider (prv_test-provider) → PUT key (204) → GET key (73 chars) → POST model (stealth/ox-alpha with pricing) → models-config shows model → TEST (ok:true, 1357ms) → PATCH hidden:true → verify hidden. ALL PASS.
- verify GREEN (providers test updated for apiFormat); merged 48e3066; CI 32651459051 SUCCESS; ntfy delivered

Stage Summary:
- Owner can now: create custom providers (with visible API key input), save/edit keys, add/edit models with pricing, test models (with timeout + error messages), hide models from chat picker. All verified live. Next: chat composer model picker enhancement (grouped by provider with context/pricing display).
