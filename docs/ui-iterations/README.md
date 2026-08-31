<!-- last-reviewed: 2026-08-31 round-58 -->
# UI Iterations — Owner Review Rounds

This folder is the **dedicated tracking system for UI-fidelity work** (owner
directive, 2026-08-22): every owner review round gets a file here recording
what he verdicted, what changed, and how it was verified. Any agent picking
up the project can read this folder top-to-bottom and know exactly where the
UI stands and what is still open.

## How rounds work

1. The owner reviews the running UI (`pnpm dev` → http://localhost:5173/setup,
   or the desktop app) and sends verdicts per screen.
2. The orchestrator implements, verifies (screenshots at multiple viewports +
   code gates: typecheck / tests / build), and records a round file here.
3. A round is **CLOSED** only when the owner explicitly approves the screen.
   He gates progress one screen at a time — never batch-advance past a
   verdict, and never infer approval from praise of a different screen.

## Status board (wizard)

| Screen | Round history | Status |
|---|---|---|
| Welcome (step 0) | R1 port → R2 adaptable layouts | **APPROVED** (footer stays here only) |
| Pick your flavor (step 1) | R1 port → R3 two-half layout REJECTED → R4 demo-anatomy rebuild → R5 button polish | **APPROVED layout** (R4); R5 primary-button polish delivered, awaiting next look |
| Need a brain (step 2) | R1 port → R3 equal heights + accent selection → R5 bottom-button padding | **APPROVED** (R3: "proper, no huge issues"; R5 padding fix delivered) |
| Plug in your brain (step 3) | R1 port → R3 layout REJECTED → R5 padding/rail/key-gating → R6 live backend → R7 full-catalog expand + unified scroll | **APPROVED** (owner: "working properly… how they are meant to be") |
| Connection test | R8 honesty fix (one-token completion probe; garbage key/model honestly fail) | **DELIVERED** — live-verified |
| Dashboard / shell | R1–R2 restyle → R8 redo (topbar removed, sidebar restructure, Settings hub) | **IN REVIEW** — R8 delivered |
| Sidebar projects | R8 (local-first store + ProjectView) → R9 backend swap (`/api/v1/projects`, pick_folder Browse under Tauri, projects-store deleted) | **IN REVIEW** (R9) |
| Project chat (`/project/:id/chat`) | R9 port → R10 demo-parity → R11 fullscreen → R12 streaming + stats + borderless polish | + hamburger sidebar toggle + agent picker in header | (full TopBar: agent picker + file search + theme grid + Experimental freeform + To-Do panel; 7 tools) | **IN REVIEW** — R10 delivered, live-verified on P1 |
| Dashboard | Owner verdict: "way too simple / rigid" — redo queued | **QUEUED** — next round |
| Mono theme dark mode | R8 accentDark fix | **DELIVERED** — visually verified |
| All set (step 4) | R1 port → R3 theme-derived confetti | **APPROVED** ("perfect") |
| Dashboard / Agents / Sessions / Chat | R1–R2 theme-engine restyle | Approved in the Phase-2 walkthrough ("everything is working properly… UI looks much better"); further polish on request |
| **Round 16** (streaming) | SSE live streaming + per-reply stats + borderless tight chat UI + Nova→Acute rename + modern folder dialog + DESIGN-SYSTEM.md | **DELIVERED** — see ORCHESTRATION-WORKLOG (no round file written; lesson #33 sandbox-wipe mid-round codified ADR-0020 work-branch discipline) |
| **Round 17** (governance) | docs index/WORKFLOW/ROADMAP/TESTING/SECURITY + ADR backfill 0014–0021 + PILLARS.md blueprint + IMPLEMENTED-API truth doc + tool-name truth + allowlist enforcement | **DELIVERED** — see ORCHESTRATION-WORKLOG |
| **Round 18** (dashboard live) | Public DASHBOARD repo on GitHub Pages + plan section + browser-verified | **DELIVERED** — see ORCHESTRATION-WORKLOG |
| **Round 19** (model management) | Models table migration 0004 (pricing/context/thinking) + 6 new routes + ModelsProvidersTab replaces "API & Providers" tab | **DELIVERED** — see ORCHESTRATION-WORKLOG |
| **Round 20** (model fixes) | apiFormat column INSERT bug fix + Edit Model dialog + show/hide API key toggles + 30s test timeout + key save error display + live E2E battery | **DELIVERED** — see ORCHESTRATION-WORKLOG |
| **Round 21** (UI overhaul) | Wizard DNA design system (Space Grotesk font-black, 28px dot grid, accent glows, bentoShadow) + AppShell transparent main + Sidebar visual rebuild + Dashboard wizard container + StatCards solid accent icon tiles | **DELIVERED** — see ORCHESTRATION-WORKLOG |
| **Round 22** (sidebar redesign + chat cleanup) | Sidebar distinct surface + hamburger ON sidebar + nav/projects separated by divider + projects EXPANDABLE (sessions underneath) + TopBar COMPLETELY removed (owner: "makes the whole user experience bad") + chat-only full width + /sessions route REMOVED | **DELIVERED** — see ORCHESTRATION-WORKLOG |
| **Round 23** (sidebar behavior + chat polish + settings) | Project click = expand/collapse ONLY + sessions clickable sub-items + NewSessionButton per project + chat panel tightened (h-10 header, p-2.5 composer, 16px radii) + settings CONFIGURATION kicker + font-black H1 + solid-accent pill tabs | **DELIVERED** — see ORCHESTRATION-WORKLOG |
| **Round 24–25** (Kilo Code parity: tools + prompt + context + checkpoints) | 5 new tools (search_code, git_status/diff/log, run_command) + Cline-grade 150-line system prompt + cost tracking + code blocks w/ line numbers + 13th tool todo_write + context-window management + checkpoint system (migration 0005 file_snapshots) | **DELIVERED** — see ORCHESTRATION-WORKLOG (round files not written per lesson #33 gap) |
| **Round 26** (100 review items) | Stop button on busy + composer placeholder + settings max-width + traffic light size + loading skeletons + error recovery + agent picker empty state + retry button + sidebar empty state + divider visibility + exec safe list (40+ commands) + brand logo hover 180° rotation + aria-labels + focus-visible + 6 themes + dark/light toggle + Enter/Shift+Enter keyboard + GapHandle a11y | **DELIVERED** — see ORCHESTRATION-WORKLOG (split across R26/R26b/R26c/R26-final) |
| **Round 27** (web tools + deps fix + testing + demo) | web_fetch + web_search (15 tools total) + CRITICAL deps-wiring fix (todo_write + checkpoints now live in real turns) + 14 web-tools tests + L4 live battery + L5 browser verification (19 screenshots) + demo project (YouTube-like 545-line app) built BY the agent + zip uploaded to GitHub release | **DELIVERED** — see round-27.md |
| **Round 28** (UX + agentic-quality overhaul) | Master plan v2 (1123L, 13 workstreams A-M, 5 milestones, 30 sub-agent review fixes). MS-1 DELIVERED: A1+A2 governance + ORCHESTRATOR-METHOD.md (owner explicit ask) + K1 dashboard screenshot publish infra (publish-screenshots.mjs) + B sidebar redesign (brand block removed, NAVIGATION section header) + C settings appearance (getContrastText contrast fix + Sun/Moon icons + swatch borders + 2-col grid). 197 tests green, VLM-verified. R28 screenshots → DASHBOARD repo. | **DELIVERED** — see round-28.md |
| **Round 29** (showcase hub + ntfy close-out) | Next.js showcase mirror on the sandbox dev port so the product is visible in the Preview Pane; AGENT-MEMORY #39 corrected (ntfy IS the task-completion channel); round-29.zip published to DASHBOARD. | **DELIVERED** — ORCHESTRATION-WORKLOG R29 |
| **Round 34** (multi-step reliability + settings redesign) | Cline-parity tool feedback: tool results persisted (outputSummary, head+tail truncated, secret-scrubbed) and folded into the conversation via <tool_results> blocks — live-proven with a real 4-step build (math.js → test.js → verify → BUILD COMPLETE, files on disk, todos tracked). ToolRow output previews + TerminalCard stdout. Settings redesign: sidebar TRANSFORMS into the settings nav (back arrow + 4 sections + coming-soon slot); Appearance page (Interface Mode, theme grid, Density → chat padding, Sidebar Tint → accent mix with live mini-rail preview); Models & Providers master-detail per the owner's screenshot (provider list with status dots + detail pane with key/URL/test/model CRUD; PATCH/DELETE providers with agent-reference protection; 4 built-in seeds). Sub-agent plan review (17 findings) + code review (8 findings), all fixed. 217 tests + live battery ×2 + VLM. | **DELIVERED** — see round-34.md |
| **Round 33** (behavioral fixes + sidebar/logo system) | THE hello-loop fix: zero-tool iterations break the outer loop (live-proven — 'hello, how are you' = user+assistant only, no rounds); activity interleaved at the point tools ran (no ROUND pills, stats on final message only); live file-population view (auto-expanding diff with staggered line reveal); custom SVG AcuteLogo (hover-morphs to panel toggle) at sidebar top-left + collapse button top-right + generous section spacing + on-project + new-session button (no chevron/count) + renameable sessions (PATCH /sessions/:id full stack) + prominent Settings card + instant session-list updates + name-from-folder; chat panel fully headerless (Ctrl K labels on Windows); floating LOGO show-sidebar. Design Prompt 3 (settings restructure) delivered. 215 tests + live OpenRouter battery + VLM. | **DELIVERED** — see round-33.md |
| **Round 32** (owner-designed UI implementation) | Built from the owner's AI-designed screens (Acute-Ui-Screens.html): floating warm-tinted sidebar + separate white chat panel (12px gaps, radius 20/24); top navigation bar REMOVED (merged into one slim panel header with agent/model/⌘K/theme/panels); the ActivityBlock system — rounds timeline, file-change diff cards with real +N −M stats + Open pill + expandable green/red diff body, command terminal cards with traffic lights, web rows, "planning next round…" dividers, Detailed/Compact/Hidden customization; live streaming variant with writing… states; snapshot seq-resolution fix; composer focus ring. Empty state + component-sheet pills/tips/buttons/bubbles NOT implemented (owner dislikes). 213 tests + live OpenRouter battery + VLM verification. | **DELIVERED** — see round-32.md |
| **Round 30** (Windows bug fixes + session management + sidebar/chat redesign) | Owner's real-device feedback: FIXED the hijacked-SSE CORS drop behind "Failed to fetch" + no-streaming; FIXED the ignored ?session= param behind "all sessions are exactly the same"; ADDED DELETE /sessions/:id (full stack + hover trash in sidebar); selected-session highlight (accent bar); Demos nav removed; distinct accent-tinted sidebar surface (derived per-theme tokens); chat overhaul (hero empty state + suggestion chips, avatar+name assistant rows, auto-growing textarea composer). 212 tests, live browser battery with real OpenRouter streaming (0 CORS errors). | **DELIVERED** — see round-30.md |

## Round files

- [`round-01-02.md`](round-01-02.md) — initial port + adaptable-layout rounds
- [`round-03.md`](round-03.md) — owner verdict: PickFlavor & PlugBrain rejected, NeedBrain approved
- [`round-04.md`](round-04.md) — PickFlavor demo-anatomy rebuild (approved) + NeedBrain padding
- [`round-05.md`](round-05.md) — primary-button polish, PlugBrain full pass, live-key verification
- [`round-06.md`](round-06.md) — persistent dev backend (`pnpm dev:full`): fixes models list & test connection in the browser
- [`round-07.md`](round-07.md) — expand button lists the full catalog; PlugBrain scrolls as one unified flow
- [`round-08.md`](round-08.md) — honest connection test; dashboard/shell redo; Settings hub; mono dark; PROJECT-MAP + dev CLI
- [`round-15.md`](round-15.md) — model management (providers, models, pricing, keys, testing), dashboard v2 (light theme, multi-file), folder dialog .ps1 fix
- [`round-14.md`](round-14.md) — dashboard live on GitHub Pages (DASHBOARD repo, plan section, browser-verified)
- [`round-13.md`](round-13.md) — governance round: docs/ADRs/blueprints/workflow + tool-truth fixes + public dashboard (sub-agent audits)
- [`round-12.md`](round-12.md) — live streaming (SSE), per-reply stats + copy + ctx meter + model picker, borderless tight chat UI, drag fix, Nova→Acute, modern always-on-top folder dialog, DESIGN-SYSTEM.md, sandbox-wipe recovery via work branch
- [`round-11.md`](round-11.md) — owner Windows-verdict fixes: real folder dialog (2 methods + error surfacing), fullscreen chat with hamburger sidebar toggle, plug-and-play Nova agent seed, dialog centering fix, HTML-build live proof
- [`round-10.md`](round-10.md) — agentic coding system for real: OS folder picker, create_dir/delete_file/search_files, demo-parity chat UI (TopBar/To-Do/Experimental), live P1 proof incl. deletion refusal
- [`round-09.md`](round-09.md) — Agentic MVP M3 (project-chat UI port onto live data) + M4 (live ACUTEST run, files verified on disk) + live-call bug fix (`jsonSchema()` tool wrapping)
- **round-16** — streaming + polish (SSE live, per-reply stats, borderless chat, Nova→Acute, modern folder dialog, DESIGN-SYSTEM.md) — *no round file written; see ORCHESTRATION-WORKLOG + lesson #33 (sandbox-wipe mid-round codified ADR-0020)*
- **round-17** — governance round (docs index, WORKFLOW/ROADMAP/TESTING/SECURITY, ADR backfill 0014–0021, PILLARS.md, IMPLEMENTED-API, tool-name truth, public dashboard) — *no round file; see ORCHESTRATION-WORKLOG*
- **round-18** — dashboard live on GitHub Pages (DASHBOARD repo, plan section, browser-verified) — *no round file; see ORCHESTRATION-WORKLOG*
- **round-19** — model management (migration 0004 models table, 6 routes, ModelsProvidersTab) — *no round file; see ORCHESTRATION-WORKLOG*
- **round-20** — model management fixes (apiFormat INSERT bug, Edit Model dialog, show/hide key toggles, live E2E battery) — *no round file; see ORCHESTRATION-WORKLOG*
- **round-21** — UI overhaul (wizard DNA design system, AppShell transparent main, Sidebar visual rebuild, Dashboard wizard container, StatCards) — *no round file; see ORCHESTRATION-WORKLOG*
- **round-22** — sidebar redesign + chat cleanup (hamburger ON sidebar, projects expandable, TopBar COMPLETELY removed, /sessions route removed) — *no round file; see ORCHESTRATION-WORKLOG*
- **round-23** — sidebar behavior + chat polish + settings (project click = expand only, NewSessionButton, chat panel tightening, settings CONFIGURATION kicker) — *no round file; see ORCHESTRATION-WORKLOG*
- **round-24–25** — Kilo Code parity (5 new tools + Cline-grade prompt + cost tracking + context-window management + 13th tool todo_write + checkpoint system) — *no round file; see ORCHESTRATION-WORKLOG*
- **round-26** — 100 review items (stop button, composer placeholder, loading skeletons, error recovery, 6 themes, GapHandle a11y, etc.) — *no round file; see ORCHESTRATION-WORKLOG (split across R26/R26b/R26c/R26-final)*
- [`round-27.md`](round-27.md) — web tools (web_fetch + web_search) + critical deps-wiring fix + demo project built by the agent
- [`round-28.md`](round-28.md) — UX + agentic-quality overhaul (13 workstreams A-M, 5 milestones; MS-1: governance + sidebar + settings + screenshot infra)
- **round-28** (in progress) — UX + agentic-quality overhaul; see [`ROUND-28-MASTER-PLAN.md`](../ROUND-28-MASTER-PLAN.md)
- **round-29..42** — no round files (sessions/UI/security rounds; see ORCHESTRATION-WORKLOG + the gap note below — the round-file convention lapsed between 28 and 43)
- [`round-43.md`](round-43.md) — the owner's 9-item R42 verdict round (CI green again, free-model catalog + fallback chain, turn-error cards + retry, chat geometry, sub-agents settings, embedded proxy browser + browser_control, delegation made reachable via 0014)
- [`round-44.md`](round-44.md) — completing the agentic environment: agent memory (0015 + 3 tools + prompt injection + Memory tab), REAL DuckDuckGo web search, session search/fork/revert, sub-agent keys from credentials.txt, streaming terminal, VLM UI pass (2 real bugs fixed), MAINTENANCE.md — 471 tests
- [`round-45.md`](round-45.md) — finishing the agentic environment: security round CLOSED audit P0-3/P0-4/P0-5 (child-env allowlist, path-contained auto tier, web host gate + migration 0016), PTY terminal sessions (Run \| Shell toggle), packaging v1 (version 0.45.0 single-sourced + CHANGELOG + release workflow, launcher-kit artifact verified), TOOL_CATALOG drift guard, VLM pass (orphaned SessionsScreen routed at /sessions, mobile overlay drawer, wizard badge v0.45.0) — 565 tests
- [`round-46.md`](round-46.md) — agent intelligence depth: context compaction (model-summarized `context.compact` events replace the silent hard drop; fork/revert inherit), relevance-ranked memory (scored recall + ranked digest + dedup-on-save), provider-call 10-min timeout (live-battery find), checkpoint restore UI (the round-25 orphan closed + the loadDiff race fix), browser cookie persistence (migration 0017, per-profile jars, durable session cookies), terminal-session e2e (suite 8→12) — 622 tests
- [`round-47.md`](round-47.md) — provider management, clean + reliable: one provider API layer (the third HTTP plumbing layer deleted), slot + model-scoped connection tests with honest results, the served model catalog replacing every hand-copied duplicate (SubAgentsTab's 47-entry copy + AgentFormDialog's hardcoded list), enabled enforced at turn time (PROVIDER_DISABLED), raw-key route removed, key-pool slot-collision fix; launcher key scrub (the R44 real-keys leak) + the credentials-parser bug it exposed; version 0.47.0 — 683 tests
- [`round-48.md`](round-48.md) — the owner-test round (every fix from the owner's own Windows session): sub-agents at near-main-agent parity (ask-tier approvals through the parent's SSE with CODE attribution, abort propagation, deterministic 4-char codes, live per-step events, chat-style SubAgentPanel with a 1s clock, clickable live Delegated card), the browser flash-loop/ticket-401 fix (tickets rotate only at POST /browser/session), a real files explorer tab, sidebar polish (per-project colors + migration 0018, A_ logo + favicon, collapsed-rail fix, Sessions nav removed), the modern always-on-top Windows folder picker; version 0.48.0 — 752 tests
- [`round-49.md`](round-49.md) — the file-tools repair round (the owner's second Windows session): migration 0019 repairs the default agent allowlist that 0014+0015 narrowed from [] (= ALL tools) to exactly 5 tools (the root cause of "I have no write_file/list_dir" on BOTH main and sub-agents — fresh installs were never damaged, only pre-R43 databases), the embedded browser's blank-HTML fix (rewrites now ABSOLUTE against the sidecar origin — the injected <base href=upstream> was hijacking every CSS/JS/img request to the upstream site), nested sub-agents (depth-capped at 3) + the tool-intent nudge (one bounded correction when a model writes the tool call as text instead of calling it), the memory master switch (Settings → Advanced) + sub-agent digest isolation (stale memories were teaching agents wrong tool sets), the cat-face logo (sidebar + favicon + ico), Sessions fully removed (route + screen + orphaned hook); version 0.49.0 — 750 tests + a 5-check live battery (the owner's exact delegation scenario green end-to-end)
- [`round-50.md`](round-50.md) — the native-browser + composer round (the owner's third Windows session): a REAL embedded browser (one WebView2 child webview per tab inside the main window — Tauri multiwebview via Window::add_child + the unstable feature; no proxy, no tickets, shared persistent profile; the iframe stays as the non-Tauri fallback), sub-agents streaming their raw thinking/text LIVE through the parent's SSE (the owner's exact ask) + a bottom stats bar (time, tokens sent/received, tok/s, model) + 5-attempt provider retries (the "failed after three attempts" was the AI SDK default), the owner-spec chat composer (toolbar inside the box: Add Context — Windows multi-file picker + project files + @-mentions + drag-and-drop; permission modes full/ask/plan/editor enforced server-side with the denylist never bypassed; thinking levels Default/Low/High/Max injected as reasoning.effort; the provider-flyout model picker with Manage Models deep-link; the context donut with per-slice breakdown + REAL cache hit-rate + session costs from the new cached-token capture), and the Models & Providers rework (independent scrolling, catalog multi-select picker, per-model pricing config + two storage bugs fixed); version 0.50.0 — 930 tests + a live battery (thinkingLevel+attachment turn, context report, the delegation round with 308 live child frames)
- *(rounds 51–56: the board lapsed — the per-round evidence lives in `round-51.md` … `round-56.md`; one-line map: R51 the NSIS installer ships + composer polish · R52 command supervision (background jobs, the 10-minute hang fix) + sub-agents stoppable + the real Usage screen + plugin tools · R53 the connection round (stale-port, handshake race, ConnectionGate, watchdog) · R54 the reliability round (install verified on disk, engine retries + stderr, offline log tail) · R55 the engine-boot round (EISDIR verbatim-path crash + Credential-Manager namespace) · R56 the launch-choice round (app-or-site question + engine-failure recourse))*
- [`round-57.md`](round-57.md) — the engine-bundling round (the owner's fifth desktop session — the SITE half of the flow now works end-to-end, and the desktop engine's dying words finally arrived: ERR_MODULE_NOT_FOUND): the staged sidecar's node_modules was a pnpm LINK FARM (189 symlinks on POSIX = 189 junctions on the Windows build runner) that tauri-bundler + NSIS pack/extract does not preserve — the installed engine could not import its first package and died before its first log line, while every Linux check passed (Linux preserves links). Fixed structurally: `--config.node-linker=hoisted` stages a classic npm-style tree of REAL directories (301.5 MB → 124.6 MB), a ZERO-LINKS gate fails the staging if any symlink/junction appears (junctions report as symlinks via lstatSync — one walk, both OSes), and the release workflow now BOOTS the real staged engine with the real pinned node.exe on windows-latest (same env/handshake as the app) before `pnpm tauri build` can pack it — a dead engine can never ship again; no Rust/JS/launcher code changed, only the tree; version 0.57.0 — 1071/1071, staged-boot battery ACUTE_READY + /health 200 + /agents 200

- [`round-58.md`](round-58.md) — the desktop-polish round (the owner's eleventh Windows session — the FIRST fully-working desktop run, the R57 fix held): six parallel workstreams fixed every reported defect — the frameless window + integrated TitleBar, the browser panel's five bugs (async pop-out, system-browser opener, URL typing, honest readouts, profile copy), honest stops ("Stopped by user" + status reset + persisted partial + a Continue button), LIVE file-write preview (tool-input frames end-to-end), the session-regurgitation cap (last-8 tool results full, older stubbed), the thinking redesign (AI-glow rails gone), the 600ms hover-intent popover, the settings restructure (unconfigured group, preset fields hidden, disable switch, VISIBLE KEYS via a new reveal route, Sub-agents/Advanced dedupe, picker honoring model config), and the CLI chat harness (acute.mjs chat:stream family). 1169 + 631 tests, LIVE battery 5/5 (scripts/battery-r58.mjs), version 0.58.0.

## Running the UI with a live backend (dev)

Plain `pnpm dev` = UI only (no sidecar — model catalog and connection tests
cannot work). For the full live workflow run **`pnpm dev:full`**: sidecar on
127.0.0.1:5178 with the OpenRouter key from Credential Manager + vite. See
[`round-06.md`](round-06.md).

## Verification method (per round)

- Code gates: `pnpm typecheck` + onboarding vitest suite + `pnpm build`.
- Visual: ZCode in-app browser against the vite dev server at 1920×1080 and a
  tall viewport (~1080×1600); scroll-container overflow checked numerically
  (`scrollHeight` vs `clientHeight`) because screenshots blur edges.
- Live backend (when behavior depends on the sidecar): boot
  `agent-core/dist/main.js` with `ACUTE_TOKEN`/`ACUTE_DB_PATH`/
  `ACUTE_PROVIDER_OPENROUTER` env, point vite at it via
  `VITE_ACUTE_BASE_URL`/`VITE_ACUTE_TOKEN`, verify real catalog + connection
  test in the UI. See `round-05.md`.

## Round-file vs session-number decoupling (lesson from rounds 16–26)

The `round-NN.md` files go round-01-02 → round-15, then a **GAP** (no
round-16..round-26 files exist), then round-27.md. The actual session-by-session
history for R16–R26 lives in `docs/agent/ORCHESTRATION-WORKLOG.md` — those
rounds happened (streaming, governance, dashboard live, model management, UI
overhaul, sidebar redesign, Kilo parity, 100 review items) but the per-round
evidence files weren't written (sandbox-wipe mid-round-16 codified ADR-0020
work-branch discipline; subsequent rounds inherited the gap).

**Convention going forward (round 28+):** every round gets a `round-NN.md`
evidence file with screenshots + verify output + owner verdict. The
`scripts/verify-round.mjs` (Workstream L) will auto-generate the evidence-file
skeleton to make this trivial.
