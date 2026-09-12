<!-- last-reviewed: 2026-09-12 round-94 -->
# ACUTE-CODE — Round 28 Master Plan

**Status:** PROPOSED v2 — sub-agent review complete (6-d architecture, 6-e UX, 6-f risk); critical+high flaws applied (see §0.1 changelog below); ready for execution
**Author:** Z.ai Code orchestrator
**Sub-agent reviewers:** 6-d (architecture), 6-e (UX), 6-f (risk/scope) — all 3 reports appended to `/home/z/my-project/worklog.md`
**Audience:** future ACUTE-CODE agents (this + `HANDOFF.md` + `AGENT-MEMORY.md` = full context)
**Owner directive quoted verbatim:** *"Quality over speed or time. Take as much time as needed. It is a very huge task… handle each and every single one of the things properly… highly customizable, flexible, and easily manageable… utilize the advanced techniques which need to be analyzed… implement proper project or such indexing… utilize advanced searching techniques too, like a grep… everything should be well optimized."*

---

## 0.1 v2 Changelog (sub-agent review fixes applied)

### Critical fixes (would have blocked execution)
1. **`search_code` is INLINE in `tools/index.ts` L515–532, not a separate file** (6-d). WS-H §10.4 updated: edit `tools/index.ts` inline, not `agent-core/src/tools/search_code.ts`.
2. **pnpm not installed in sandbox** — `/home/z/.local/bin` doesn't exist post-wipe (6-f). §20.1 updated: `corepack enable` + `corepack prepare pnpm@11.22.0 --activate` before any `pnpm` call.
3. **`mx-auto` CENTERS the chat; owner wants LEFT-aligned** (6-e). §6.3.1 updated: `mr-auto` (left-align) on desktop ≥1024px, full-width on mobile.
4. **demo-mode banner insufficient** — `demoData` defaults `true`, only flips via env var (6-e). §7.3 updated: on app boot, ping `GET ${baseUrl}/api/v1/health`; if 200 + token available, auto-call `setDemoData(false)`.
5. **Test count is 197, not 203** (6-d ran `pnpm test`): agent-core 132 + shared 4 + frontend 55 + e2e 6 = 197 (191 pass + 6 skip). §1.2 + §3.2 status.json refresh updated.

### High fixes
6. **`continueIfUnfinished` heuristic brittle** (6-e). §8.3.2 updated: INVERT to "continue UNLESS explicit completion signal ('Done.'/'Task complete.') AND all todos marked `completed`". Removes phrase-matching false positives.
7. **3 outer loops insufficient for owner's 4–7 iterations** (6-e). §8.3.2 updated: `maxOuterLoops` 3 → 5 (max 5 × 80 = 400 tool round-trips).
8. **Accessibility gaps across B/C/D/E** (6-e). §4.5, §5.5, §6.5, §7.5 updated: `aria-live="polite"` on streaming bubble; `role="radiogroup"`+aria-labels on appearance toggle/swatches/native color input; global `@media (prefers-reduced-motion: reduce)` block in `index.css` retrofitting ALL existing animations (bounceDot, fadeInUp, etc.).
9. **WS-D over-scoped 3×** (6-f). §6 split into D1 (chatFocusMode + ProjectChatScreen rewire + ChatFocusLayout + ChatTopBar), D2 (AgentChatPanel modernization: header + streaming bubble + AgentThinking merge + aria-live), D3 (composer wiring: Stop + Paperclip + ⌘K + DiffCard real diff + delete TopBar + tests). Each gets its own MS.
10. **SANDBOX-RESTORE clone step uses credential helper — violates lesson #24** (6-f). §3.2 updated: token-in-URL for the single clone command, `remote set-url` to tokenless immediately after.
11. **Migration numbering leaves 0006 unused** (6-d). §8.3.3 renumbered to `0006_agents_max_outer_loops.sql`; §9.3.1 renumbered to `0007_codebase_index.sql`. Migration file text now includes the `UPDATE agents SET max_turns = 80...` statement explicitly.
12. **ExperimentalLayout.tsx is NOT orphaned** (6-d verified: imported + rendered by ProjectChatScreen L17+L213). §6.4 + §19.2 updated: do NOT delete; it's the "Experimental" toggle view.
13. **Work-branch discipline (ADR-0020) inconsistently applied** (6-f). §6.6 + §16 updated: ALL multi-file workstreams (B, C, D1/D2/D3, F, G1/G2, H, I, K) use `work/round-28-<ws>` branches; single-file workstreams (A, J1, L, M) stay on `main`.
14. **`jsonSchema()` wrapping not specified for new tools** (6-f, lesson #9). §9.4 + §10.4 updated: explicit "MUST be wrapped in `jsonSchema()` per lesson #9" instruction.
15. **5 owner-gates, not 6** (6-f). §17.2 updated: merge MS-5 (I+J+K) + MS-6 (L+M) into one close-out MS-5 → 5 gates total.

### Medium fixes also applied
16. **Tiny "ACUTE" wordmark + `showWordmark` flag removed entirely** (6-e). §4.3 updated: no wordmark at all; `showWordmark` flag dropped from §4.4.
17. **`IGNORED_DIRS` is private + `MAX_FILE_SIZE` doesn't exist (actual: `MAX_READ_BYTES` L26, also private)** (6-d). §9.3.2 updated: export both from `tools/index.ts` (add `export` keyword) OR define copies in `storage/index.ts`.
18. **Appendix line counts corrected** (6-d): `storage/agents.ts` 320 L (not ~100); `storage/db.ts` 162 L (not ~80).
19. **WS-A split into A1 (must-do-first) + A2 (can-do-later)** (6-f). §3 split: A1 = SANDBOX-RESTORE + status.json + HANDOFF §3 (unblocks B/C/D); A2 = AGENT-MEMORY append + ORCHESTRATION-WORKLOG + ui-iterations board backfill.
20. **WS-C trimmed** (6-f): ship only contrast fix + Sun/Moon icons + swatch borders + 2-col grid in R28; defer custom-accent + density + font to R29.
21. **WS-G split into G1 (backend) + G2 (frontend)** (6-f).
22. **WS-J split into J1 (infra: DOC-STANDARDS + check-stale.mjs + CI gate) + J2 (content: backfill 12 missing docs + 8 missing ADRs)** (6-f).
23. **WS-L prerequisites** (6-f): `verify-round.mjs` needs `agent-browser` + VLM packages — add install step + Prerequisites section.
24. **Close-out ntfy ruling** (6-f): ntfy on owner-APPROVE only (one notification at round close-out); NOT on individual MS verdicts or workstream completions. §22 + lesson #39 wording aligned.
25. **DoD §18 item 4 fixed** (6-f): "where applicable — UI workstreams (B/C/D/E/G/H/I) upload screenshots; non-UI workstreams (A/J/L/M) upload a single `pnpm verify` green screenshot."
26. **Missing risks added** (6-f): R-F5 context-window exhaustion (abort if `assembledContextTokens > 800K`); R-G4 snapshot table growth (30-day cleanup); R-K4 dashboard repo size (cap 50MB/zip, monitor 1GB GitHub Pages limit); R-L3 CI time growth; R-H3 pnpm install time growth; R-F6 OpenRouter rate limits (request-count guard >200 reqs).
27. **SSE cadence test moved out of CI** (6-f): `tests/e2e/sse-cadence.test.mjs` uses `it.skipIf(!process.env.ACUTE_PROVIDER_OPENROUTER)`; also moved to `pnpm test:live` script (NOT in `pnpm verify`).
28. **D ↔ E hidden coupling resolved** (6-f): D2 (AgentChatPanel modernization) + WS-E (streaming hook) MERGED into one workstream D2 (since both rewrite the same file). New workstream layout: D1 (layout) → D2 (AgentChatPanel modernization + streaming hook + aria-live) → D3 (composer + DiffCard + delete TopBar).
29. **F → E hidden dependency resolved** (6-f): WS-F §8.3.2 now specifies the `meta.continuation` SSE event type + frontend handler (the streaming hook from D2 handles it).
30. **G → H dependency made explicit** (6-f): WS-H depends on G1 (backend index), not just D+G. §17.1 redrawn.

Round 27 closed the **Kilo Code parity** milestone: 15 tools registered, the `toolDeps` wiring fix live, web tools shipped, demo project built end-to-end by the agent, 19 screenshots + a 545-line YouTube-like `index.html` produced as proof. CI green. The owner's verdict on round 27 was **good** ("you did well with that", "the dashboard page was looking good", "the demos were working properly").

The owner's round-28 directive is a **UX + agentic-quality overhaul**, not a feature expansion. Five concrete complaints, in priority order:

1. **Sidebar** — top of sidebar shows app name + logo; that's wrong. Dashboard/Usage and Projects must each live in their own dedicated section.
2. **Settings → Appearance** — UI was never modernized; in dark mode the darker text is invisible (white-on-white toggle knob, dark swatches on dark card).
3. **Chat screen** — needs a complete redesign. Chat should sit on the **left/center-left**, not the right. Folder/code panels must **not** appear alongside the chat in this mode. Modern design techniques.
4. **Live response** — the agent "completes all the tasks and then directly shows the results." No typing effect while the model is producing tokens.
5. **Multi-turn continuation** — the agent "was not continuing the chats." A real coding agent does 4–7 iterations: research → save files → restart → next research → save → restart → … The runtime must auto-continue.

Plus four system-wide asks:

6. **Project indexing** — agent must "properly know about the project, can manage it, can handle things."
7. **Advanced search (grep)** — already partially shipped as `search_code` (R24); verify it's wired and extend if needed.
8. **In-app demo viewer** — owner liked the YouTube demo; give the app a built-in area to view such demos.
9. **Dashboard screenshot zip uploads** — from now on, screenshot zips go to the public `testplay-byte/DASHBOARD` repo (not the private ACUTE-CODE repo).

And one governance change: if the sandbox ever wipes again, **just ntfy the owner** at `https://ntfy.sh/TASKISDONE` — don't attempt autonomous recovery. (Round-28 restore already complete; this rule applies to *future* wipes.)

This plan is **additive** — it never rewrites working code wholesale. Each workstream targets specific files, lists the exact surgery, and is independently testable. Workstreams are sequenced by dependency, not by ease: governance first (so the next agent can find their way), then UX (sidebar → settings → chat — the order the owner listed them), then agentic-quality (streaming → multi-turn → indexing → search → demo viewer), then upload automation, then the iteration cadence itself.

---

## 1. Current State Snapshot (post-restore, 2026-08-24)

### 1.1 Sandbox state
| Item | Path | State |
|---|---|---|
| Private repo (clone) | `/home/z/PROJECT/ACUTECODE` | HEAD `1498a30`, branch `main`, clean tree, private verified |
| Public repo (clone) | `/home/z/PROJECT/DASHBOARD` | HEAD `23f5846`, branch `main`, clean tree, public |
| Secrets dir | `/home/z/.secrets/` | 0700; files 0600; **outside any repo** |
| Secret files | `github-acute-code.pat` (93c), `github-dashboard.pat` (93c), `openrouter.key` (73c), `git-credentials-acute` (153c), `git-credentials-dashboard` (152c) | per-repo credential stores configured |
| Sandbox worklog | `/home/z/my-project/worklog.md` | 669 lines (rounds 1–27 + 6-a/6-b/6-c research appendices) |
| Sandbox Next.js shell | `/home/z/my-project/` | unrelated to ACUTE-CODE; ignore |
| Tooling | `pnpm` at `/home/z/.local/bin/pnpm` (via corepack) | prefix every Bash call with `export PATH=/home/z/.local/bin:$PATH` |

### 1.2 Product state (at commit 1498a30)
| Metric | Value |
|---|---|
| Tools registered | **15** (`list_dir`, `read_file`, `write_file`, `edit_file`, `create_dir`, `delete_file`, `search_files`, `search_code`, `git_status`, `git_diff`, `git_log`, `run_command`, `todo_write`, `web_fetch`, `web_search`) |
| Round-27 deps-wiring fix | **LIVE** — `runtime.ts` L185–194 threads `toolDeps = {db, sessionId, agentId, seq}` into both `buildProjectTools` calls; `todo_write` + `recordSnapshot` work in real turns |
| SSE streaming route | **LIVE** — `POST /sessions/:id/messages/stream` at `server.ts` L963; `reply.hijack()` + raw SSE write; `runStreamedAgentTurn` emits events as they arrive |
| Frontend SSE client | **LIVE** — `streamSessionMessage` in `src/lib/api.ts` L638–692; `AgentChatPanel.runTurn` (L786–870) uses it when `liveMode === true` |
| Test counts (verified by 6-d `pnpm test`) | `agent-core` 132 + `shared` 4 + `frontend` 55 + `e2e` 6 (skipped without sidecar) = **197 total** (191 pass + 6 skip). Plan §3.2 updates `status.json` to this actual count; the prior `status.json` claim of 131+66+6=203 was stale (frontend off by 11, `shared` suite missed). |
| CI | windows-latest, `pnpm verify` + `cargo check`, ~4–6 min/run; green throughout R9–R27 |
| Default agent | `agt_default_nova` "Acute" (openrouter/`stealth/ox-alpha`, allowedTools=[]=all 15, maxTurns=40) — seeded at DB open by `ensureDefaultAgent` |
| OpenRouter baseUrl | `https://openrouter.ai/api/v1` (APEX — sandbox-reachable; `api.openrouter.ai` DNS-blocked) |
| Public dashboard | `https://testplay-byte.github.io/DASHBOARD/` — light theme, orange accent, multi-file build pipeline |

### 1.3 What's already done (don't redo)
- ✅ Round-27 web tools registered (`web_fetch` + `web_search`)
- ✅ `toolDeps` wiring fix live (todo_write + snapshots work in real turns)
- ✅ Demo project (YouTube-like `index.html`, 545 lines, 13 KB) built by the agent end-to-end and captured in `round-27-testing-screenshots.zip`
- ✅ 19 testing screenshots in the zip
- ✅ Cline-grade 150-line system prompt in `agent-core/src/agents/prompts.ts`
- ✅ Cost tracking, context-window budgeting, snapshot/checkpoint system
- ✅ Model management backend + frontend (`ModelsProvidersTab`)
- ✅ Launcher (Python rich-UI + CRLF-verified `.bat`, token-in-URL auth)

### 1.4 What's broken / stale / owner-flagged (fix in R28)
| ID | Symptom | Root cause | Fix workstream |
|---|---|---|---|
| B1 | Sidebar shows "Acute ● v0.1.0" at top | `Sidebar.tsx` L94–116 brand block | B |
| B2 | Dashboard/Usage + Projects not separated | Already in nav + projects sections, but the brand block crowds the top | B |
| C1 | Dark-mode toggle knob text invisible | `SettingsPage.tsx` L112 uses `styles.toggleActive` for knob bg, but `styles.text` (cream `#FFFBF0`) for active text → white-on-white; `getContrastText` is exported but unused | C |
| C2 | Theme card swatches invisible in dark mode | `paletteDark` includes `#242426`/`#2C2C2E` which nearly match `cardDark` (`#2C2C2E`) | C |
| C3 | Appearance section never modernized | `AppearanceTab` is a basic 2-section card; no icons, no preview, no custom accent | C |
| D1 | Chat on right, panels alongside | `ProjectChatScreen.tsx` L247 — 3-panel layout (Explorer / Code / Chat-with-`shrink-0 chatWidth=400`); chat sits right | D |
| D2 | `onlyChat` mode lost the demo's centering | port dropped `justify-center items-center + maxWidth 90%` | D |
| D3 | TopBar orphaned | `TopBar.tsx` (213 L) built in R14, never imported by `ProjectChatScreen.tsx` (only referenced in comments L21, L210) | D |
| D4 | Stop button is a comment-only stub | `AgentChatPanel.tsx` composer — `/* stop logic */` comment, no abort wiring | D + E |
| D5 | Paperclip is a noop stub | `AgentChatPanel.tsx` composer — `Paperclip` icon, no file-attach wiring | D |
| D6 | "⌘K search" hint is misleading | Comment at L783 references TopBar search which doesn't exist | D |
| E1 | No typing effect while model produces tokens | Most likely cause: owner runs with `demoData === true` (sidecar unreachable) → falls back to sync `POST /sessions/:id/messages` (no streaming) | E |
| E2 | Streaming cursor is bounceDot (vertical bounce), not a text caret | `AgentChatPanel.tsx` L1095 streaming text uses bounceDot cursor | E |
| E3 | "Thinking…" placeholder is static, no animation | `AgentThinking` row sits below future bubble, not inside one growing bubble | E |
| F1 | Agent stops after 1 chat call | Runtime does ONE `streamText`/`generateText` call per user message; AI SDK v7 multi-step loop runs up to `agent.maxTurns=40` tool round-trips, but runtime doesn't loop on its own to start a NEW chat call | F |
| F2 | System prompt signals early wrap-up | `prompts.ts` TASK PLANNING step 5 says "When done, summarize what you changed" — encourages single-shot completion | F |
| F3 | No "AGENTIC LOOP" section in prompt | Missing explicit instruction to use 4–7+ tool calls, not ask for confirmation between steps, continue work across turns | F |
| G1 | No project index — agent re-reads everything | No `codebase_index` table, no symbol map, no dependency graph | G |
| H1 | `search_code` shipped but not verified end-to-end | Round-24 addition; verify it's wired into `tools/index.ts` and works on a real project | H |
| I1 | No in-app demo viewer | The YouTube demo is on disk at the project root, but the app has no UI to browse/run demos | I |
| J1 | Docs drift — many stale references | `HANDOFF.md` header date `2026-08-23 round-17` vs actual R27; `SANDBOX-RESTORE.md` references old `/home/z/acute-workspace/` layout; `LOCAL-PC-RUNNER.md` describes round-12 `store` auth (replaced by token-in-URL in R13); `status.json` references `https://testplay-byte.github.io/ANI-KUTA/` (stale URL, real one is `/DASHBOARD/`); `docs/ui-iterations/README.md` board missing R16–R26 rows | A + J |
| K1 | Screenshot zips go to the wrong repo | R27 zip is at the ACUTE-CODE repo root; owner wants them in the public DASHBOARD repo from now on | K |

---

## 2. Round 28 Workstreams — Overview Matrix

| ID | Workstream | Files touched (primary) | Priority | Depends on | Verifiable by |
|---|---|---|---|---|---|
| **A** | Sandbox governance & docs sync | `docs/runbooks/SANDBOX-RESTORE.md`, `docs/agent/AGENT-MEMORY.md`, `docs/agent/ORCHESTRATION-WORKLOG.md`, `HANDOFF.md` §3/§8, `docs/status.json`, `docs/ui-iterations/README.md` | **P0 (do first)** | nothing | next session's first agent can clone+restore in <5 min using the doc alone |
| **B** | Sidebar redesign | `src/components/shell/Sidebar.tsx` (633 L) | P1 | A | browser screenshot at 1920×1080 + 375×812: no app name/logo at top, Dashboard+Usage in own section, Projects in own section at bottom |
| **C** | Settings → Appearance redesign | `src/pages/SettingsPage.tsx` L95–181 (`AppearanceTab`) | P1 | A | dark mode: toggle knob text readable; swatches visible; modern 2-col card layout |
| **D** | Chat screen complete redesign | `src/components/project-chat/ProjectChatScreen.tsx` (247 L), `AgentChatPanel.tsx` (1203 L), `src/lib/project-chat-store.ts`, NEW `src/components/project-chat/ChatFocusLayout.tsx` | P1 (largest) | A | chat sits left/center-left; Explorer+Code hidden in `chatFocusMode`; growing streaming bubble with text caret; Stop button works; Paperclip wired or removed |
| **E** | Live streaming typing effect | `src/lib/api.ts` `streamSessionMessage`, `src/components/project-chat/AgentChatPanel.tsx` L786–870 `runTurn` + L1095 streaming cursor, `src/lib/config-store.ts` `demoData` flag | P2 | D | when sidecar is live + `demoData=false`: tokens visibly stream into a growing bubble with a blinking text caret; SSE curl battery shows `text-delta` events at <300 ms cadence |
| **F** | Multi-turn agentic continuation | `agent-core/src/agents/prompts.ts` (system prompt), `agent-core/src/agents/runtime.ts` (outer loop), `agent-core/src/storage/agents.ts` (maxTurns default) | P2 | E | live battery: prompt "research the project and write a notes.md" → agent does ≥4 tool calls across ≥2 SDK multi-step loops, writes the file, doesn't stop after 1 assistant message |
| **G** | Project indexing & codebase awareness | NEW `agent-core/src/storage/index.ts` + migration `0006_codebase_index.sql`, NEW `agent-core/src/tools/index_project.ts` tool, prompt update, `runtime.ts` injects index summary into context | P3 | F | live battery: agent asked "what files use `useThemeStyles`?" answers from index (not by listing dir + reading each file); index rebuild on `write_file`/`edit_file`/`delete_file` |
| **H** | Advanced search (grep integration) | `agent-core/src/tools/search_code.ts` (verify + extend), prompt update, frontend `⌘K` search bar re-wire (uses `search_code` not the orphaned TopBar) | P3 | D + G | live battery: `search_code "pattern"` returns file:line:match list; `search_files` and `search_code` distinct in prompt; ⌘K opens a real search popover |
| **I** | In-app demo viewer | NEW `src/components/demos/DemoViewerScreen.tsx`, NEW route `/demos`, NEW `src/lib/demos-store.ts` (reads `~/.acute/demos/` or `<project>/demos/`), Sidebar entry | P3 | D | owner can browse, open, and run any HTML demo in an iframe; YouTube demo from R27 visible in the viewer |
| **J** | Documentation management system | `docs/README.md` (index), NEW `docs/runbooks/DOC-STANDARDS.md`, NEW `scripts/docs/check-stale.mjs` (CI gate), `scripts/dashboard/build-dashboard.mjs` denylist update | P3 | A | `pnpm docs:check` exits 0; CI fails if any doc references a stale path/URL/version |
| **K** | Dashboard screenshot zip uploads | NEW `scripts/dashboard/publish-screenshots.mjs`, NEW `DASHBOARD/screenshots/README.md`, update `DASHBOARD/data.json` with screenshots section, update `DASHBOARD/build.mjs` denylist to allow `screenshots/` | P2 (do alongside B–D so each round's screenshots land in DASHBOARD) | A | after each round, `pnpm dashboard:publish-screenshots <round>` pushes a zip + index entry to the public DASHBOARD repo; visible at `https://testplay-byte.github.io/DASHBOARD/screenshots/` |
| **L** | Testing & verification protocol | `docs/runbooks/TESTING.md` (refresh), NEW `scripts/verify-round.mjs` (one-shot: lint + typecheck + test + build + license + live sidecar boot + agent-browser screenshots + VLM verify) | P3 (do once, then reuse every round) | A | `pnpm verify:round <NN>` runs full battery including browser screenshots + VLM checks |
| **M** | 100+ iteration review cycle | `docs/ui-iterations/README.md` (board refresh), NEW `docs/ui-iterations/round-28.md` (this round's evidence file), NEW `docs/agent/REVIEW-CADENCE.md` | P3 (meta) | L | every round gets a `round-NN.md` evidence file + board row; no round closes without explicit owner verdict |

---

## 3. Workstream A — Sandbox Governance & Documentation Sync (P0, do first)

### 3.1 Why first
Every subsequent workstream depends on docs being accurate. If the next agent clones the repo and reads `SANDBOX-RESTORE.md` saying "clone to `/home/z/acute-workspace/ACUTE-CODE`" they'll be confused — the actual layout is `/home/z/PROJECT/ACUTECODE`. Fix the docs first.

### 3.2 Files to edit (additive — never rewrite)

**`docs/runbooks/SANDBOX-RESTORE.md`** — full rewrite of the inventory + restore procedure (the doc is 82 lines; the rewrite stays under 150 lines but is fully accurate):
- Inventory table updated: ACUTE-CODE clone at `/home/z/PROJECT/ACUTECODE`; DASHBOARD clone at `/home/z/PROJECT/DASHBOARD`; secrets at `/home/z/.secrets/{github-acute-code.pat, github-dashboard.pat, openrouter.key, git-credentials-acute, git-credentials-dashboard}` (per-repo suffixed names because two PATs are scoped per-repo); sandbox worklog at `/home/z/my-project/worklog.md`; canonical worklog snapshot at `docs/agent/ORCHESTRATION-WORKLOG.md` (669 lines, R1–R27).
- Restore procedure (numbered, copy-paste-able):
  1. `mkdir -p /home/z/PROJECT && chmod 0755 /home/z/PROJECT`
  2. Stage secrets: `mkdir -p /home/z/.secrets && chmod 0700 /home/z/.secrets` → write 5 files (owner re-supplies tokens if lost; never echo values, only `wc -c`)
  3. Configure git: `git config --global credential.helper ""` + `core.askPass ""` + `push.default current` + `export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1`
  4. **Clone both repos with token-in-URL (lesson #24 — credential helpers are environment-sensitive; token-in-URL is not)** — clone command embeds the PAT, then `remote set-url` sanitizes it away immediately after: `git clone https://x-access-token:$(cat /home/z/.secrets/github-acute-code.pat)@github.com/testplay-byte/ACUTE-CODE.git /home/z/PROJECT/ACUTECODE && git -C /home/z/PROJECT/ACUTECODE remote set-url origin https://github.com/testplay-byte/ACUTE-CODE.git` (and the DASHBOARD equivalent with `github-dashboard.pat`). Set `GIT_TERMINAL_PROMPT=0` + `GIT_CONFIG_NOSYSTEM=1` + isolated `HOME` so git can never hang/prompt.
  5. After clone, verify `.git/config` is tokenless: `grep -E 'github_pat|sk-or-v1|x-access-token:' /home/z/PROJECT/ACUTECODE/.git/config` must return CLEAN. Future pushes use the credential helper configured per-repo: `git -C /home/z/PROJECT/ACUTECODE config credential.helper "store --file=/home/z/.secrets/git-credentials-acute"` (Linux-only; on owner's Windows the launcher uses token-in-URL per lesson #24).
  6. Verify: `git -C /home/z/PROJECT/ACUTECODE remote -v` (tokenless), `grep -E "github_pat|sk-or-v1|x-access-token:" .git/config` (CLEAN), `curl -s -H "Authorization: Bearer $(cat /home/z/.secrets/github-acute-code.pat)" https://api.github.com/repos/testplay-byte/ACUTE-CODE | jq -r .private` (true), `pnpm install` + `pnpm verify`
  7. Read `HANDOFF.md` → `AGENT-MEMORY.md` → `docs/agent/ORCHESTRATION-WORKLOG.md` → this plan (`docs/ROUND-28-MASTER-PLAN.md`)
  8. Re-stage Linux OpenRouter key for sidecar: `export ACUTE_PROVIDER_OPENROUTER=$(cat /home/z/.secrets/openrouter.key)` then `pnpm dev:full`
- **NEW section: "If the sandbox wipes again"** — the owner's round-28 rule: **DO NOT attempt autonomous recovery. Notify the owner via `curl -d "ACUTE-CODE sandbox wiped — re-supply credentials to resume" https://ntfy.sh/TASKISDONE` and stop.** The repo + canonical worklog survive on GitHub; the owner will re-supply PATs + OpenRouter key in chat. (Autonomous recovery was the round-10–13 pattern; the owner revised it in round 28 because he now keeps GitHub as the backup and re-supplies tokens quickly.)

**`docs/agent/AGENT-MEMORY.md`** — append lessons #37–#40:
- **#37 Sandbox-wipe-2026-08-24**: the entire `/home/z/acute-workspace/` was wiped between sessions; only `/home/z/my-project/worklog.md` + the GitHub remotes survived. Rule: the repo IS the backup — push every green milestone, not just round-end. The new `/home/z/PROJECT/{ACUTECODE,DASHBOARD}` layout is the permanent restore target.
- **#38 Per-repo suffixed secret files**: when two PATs are scoped to two different repos on the same host (github.com), use per-repo credential stores (`git-credentials-acute` + `git-credentials-dashboard`) and per-repo `credential.helper` config in each clone's `.git/config`. Don't try to mix two tokens in one credential store — git's longest-prefix match is correct but fragile, and debugging it wastes hours.
- **#39 ntfy-on-wipe-only rule (owner revision R28)**: ntfy `TASKISDONE` is now the **sandbox-wipe notification channel**, not the routine-progress channel. Don't ntfy for routine milestones unless owner-gated. (Prior practice of ntfy-after-every-milestone is retired — owner finds it noisy.)
- **#40 Demo zip upload target changed**: R27's `round-27-testing-screenshots.zip` lives at the ACUTE-CODE repo root. From R28 on, screenshot zips go to the **public DASHBOARD repo** at `screenshots/round-NN.zip` with an index entry in `data.json`. The DASHBOARD repo's `build.mjs` denylist was updated to allow `screenshots/` paths.

**`docs/agent/ORCHESTRATION-WORKLOG.md`** — append the round-28 sandbox-restore + plan-creation entry (Task IDs 1–7 + 6-a/6-b/6-c research + plan finalization). This is the canonical snapshot for the next session.

**`HANDOFF.md`** — refresh §3 (current state) to a single table mirroring §1.2 above; refresh §8 (environment) to point to `docs/runbooks/SANDBOX-RESTORE.md` instead of duplicating env facts. Header date → `2026-08-24 round-28 plan proposed`.

**`docs/status.json`** — refresh:
- `quality.suites`: agent-core tests count from 131 → actual (re-run `pnpm verify` to count, expected ~145 after R27 web-tools tests)
- `publicLinks`: replace the stale `https://testplay-byte.github.io/ANI-KUTA/` URL with `https://testplay-byte.github.io/DASHBOARD/`
- `plan.current`: "Round 28 — UX + agentic-quality overhaul (sidebar, settings appearance, chat redesign, streaming typing, multi-turn continuation, project indexing, in-app demo viewer)"
- `plan.upcoming`: prepend "Round 28 workstreams A–M (this plan)" to the existing list

**`docs/ui-iterations/README.md`** — refresh the status board: backfill rows for R16 (streaming), R17 (governance), R18 (dashboard live), R19 (model management), R20 (model fixes), R21 (UI overhaul wizard DNA), R22 (sidebar redesign + chat cleanup), R23 (sidebar behavior + chat polish + settings), R24 (Kilo tools), R25 (todo + checkpoints), R26 (100 review items), R27 (web tools + demo). Add R28 row "IN PROGRESS — UX + agentic-quality overhaul".

### 3.3 Verification
- After edits: `pnpm verify` green (docs-only changes don't affect tests; sanity)
- Commit + push to `main` with message "Round 28 WS-A: sandbox governance + docs sync"
- Manual: clone into a temp dir using only the new `SANDBOX-RESTORE.md` as guide — should succeed in <5 min

### 3.4 Risks
- **Risk A1**: doc edits drift from reality again. Mitigation: Workstream J adds `scripts/docs/check-stale.mjs` as a CI gate.
- **Risk A2**: status.json test count stays wrong. Mitigation: re-run `pnpm verify` and update with the actual count.

---

## 4. Workstream B — Sidebar Redesign (P1)

### 4.1 Owner's exact words
*"At the very top it should not show the app's name like that and the logo like that. It should handle the things much better, much more properly. The dashboard and usage should be shown in a dedicated section and the bottom projects should be shown in a dedicated section itself too."*

### 4.2 Current anatomy (`src/components/shell/Sidebar.tsx`, 633 lines)
From sub-agent 6-b's report:
- **L82–117 — Top row**: conditional hamburger (chat routes only) + accent-filled 8×8 square with glyph "●" + "Acute" text (13px font-bold) + accent pill "v0.1.0". **This is the brand block the owner objects to.**
- **L119–123 — Nav section**: `<nav>` with Dashboard + Usage NavButtons (already a dedicated section).
- **L125–127 — Divider**.
- **L128–131 — Projects section**: `flex-1` scrollable list of `ProjectRow` → expandable to sessions list + New Session button.
- **L133–149 — Bottom**: Settings button + collapse chevron.

### 4.3 Proposed redesign (additive — keep the existing component structure, surgically remove + reorder)
1. **Remove L94–116 (brand block)** entirely. The 8×8 square + "Acute" text + version pill goes away. **No wordmark, no logo, no app name at all** (6-e: owner said NO app name; a tiny wordmark is still over-engineering — removed entirely in v2).
2. **New top section (replaces brand block)**: just the conditional hamburger (chat routes only). Nothing else at the very top.
3. **Section 1 — Navigation** (the existing nav section with Dashboard + Usage; relabel the section header from nothing to a 10px uppercase `NAVIGATION` label per the design system).
4. **Divider**.
5. **Section 2 — Projects** (existing; relabel header `PROJECTS`; keep expandable tree + Add button pill). This is the `flex-1` scrollable section that fills available vertical space.
6. **Bottom fixed**: Settings + collapse chevron (unchanged). Owner's "bottom projects" intent is satisfied because Projects occupies the flex-1 middle and Settings sits below it; 6-e flagged that "bottom" could mean Projects is the LAST thing — if owner wants Settings moved UP to join Nav, that's a one-line change in a follow-up round.
7. **Collapsed rail** (when sidebar is collapsed): hamburger only — no logo, no version (the current collapsed rail is already brand-free per sub-agent 6-b; just verify).
8. **Accessibility (6-e)**: add `aria-label` to the hamburger, the collapse chevron, the Settings button, and each ProjectRow's expand/collapse chevron. Add `role="navigation"` + `aria-label="Main sidebar"` to the sidebar root.

### 4.4 Files touched
- `src/components/shell/Sidebar.tsx` — remove brand block (L94–116), relabel section headers, add aria-labels (NO `showWordmark` flag — removed in v2 per 6-e)
- `src/components/shell/Sidebar.test.tsx` — update the test that asserts the brand block exists; new test: "Sidebar does not render app name or logo at top"

### 4.5 Verification
- `pnpm verify` green
- agent-browser screenshots at 1920×1080, 1280×800, 375×812 — no app name/logo at top, Dashboard+Usage in nav section, Projects in own section, Settings at bottom
- VLM verify: "Does the sidebar top show an app name or logo?" → "No"
- Commit + push, screenshot zip → DASHBOARD repo (Workstream K)

### 4.6 Risks
- **Risk B1**: removing the brand block might break tests asserting its presence. Mitigation: rewrite tests in the same commit.
- **Risk B2**: owner might want the wordmark elsewhere. Mitigation: make it a `showWordmark` flag, default off, easy to flip later.

---

## 5. Workstream C — Settings → Appearance Redesign (P1)

### 5.1 Owner's exact words
*"I looked at appearance and that was not handled properly either. In the settings the appearance section was not changed. Its UI was supposed to be improved. You did not analyze it properly. It was looking bad. In dark mode the darker text was not showing."*

### 5.2 Current anatomy (`src/pages/SettingsPage.tsx` L95–181, `AppearanceTab()` function)
From sub-agent 6-b's report:
- **Mode toggle** (L107–125): 2-column slider, max-w-320. Knob bg = `styles.toggleActive` (= "white" in dark, "black" in light). Active text = `styles.text` (= `textDark` = `#FFFBF0` cream in dark, `textLight` = `#0A0A0A` in light). **White-on-white invisible in dark; black-on-black invisible in light.**
- **Theme list** (L127–181): 5 cards (nova, bento, midnight, sunset, mono). Each card: "Aa" circle + name + 5 palette swatches + ✓. In dark mode, `paletteDark` includes `#242426`/`#2C2C2E` which nearly match `cardDark` (`#2C2C2E`) → swatches disappear.
- **No icons on knob**; basic 2-section layout never redesigned.

### 5.3 Proposed redesign
1. **Fix the contrast bug (one-line)**: import `getContrastText` from `themes.ts` (it's already exported, currently unused). Use `getContrastText(styles.toggleActive)` for the active knob text color instead of `styles.text`. This makes dark-mode knob text black-on-white (readable) and light-mode knob text white-on-black (readable).
2. **Add Sun/Moon icons** to the toggle: `<Sun>` icon on the light side, `<Moon>` icon on the dark side (both from `lucide-react`, already installed).
3. **Fix theme-card swatch visibility**: render each swatch on a `subtle` strip with a 1px `borderStrong` outline (so dark swatches have a visible boundary against the dark card bg). Use `withAlpha(styles.text, 0.06)` for the strip bg and `withAlpha(styles.text, 0.18)` for the outline.
4. **Modernize the layout** to a 2-column grid (mode toggle on left, theme cards on right) with a 16:9 themed preview card at the top of each theme card showing a mini mockup of the chat UI in that theme (a 3-line code-block + a chat bubble + a primary button — all using the theme's palette). This is the "modern design techniques" the owner asked for.
5. **Add custom-accent picker**: a row of preset accent colors (the existing 5 themes' accents) + a native color input (`<input type="color">`) for custom. Stores into a new `customAccent` field in the theme store; `useThemeStyles` overrides `styles.accent` when set.
6. **Add density + font selectors**: density (compact/comfortable/spacious) controls base padding scale; font (system/Space Grotesk/mono) controls the UI font. Both persisted in the theme store.

### 5.4 Files touched
- `src/pages/SettingsPage.tsx` — rewrite `AppearanceTab()` function (L95–181 → ~250 lines)
- `src/lib/themes.ts` — add `customAccent?: string`, `density?: "compact"|"comfortable"|"spacious"`, `uiFont?: "system"|"space-grotesk"|"mono"` to the theme store; `useThemeStyles` reads them
- `src/lib/theme-store.ts` — persist the 3 new fields
- `src/index.css` — add `--ac-density-scale` var (0.85/1.0/1.15) consumed by padding utilities; add `--ac-ui-font` var consumed by `body` font-family
- `src/components/settings/AppearanceTab.test.tsx` (NEW) — tests for: contrast fix (knob text readable in both modes), swatch visibility, custom-accent overrides, density/font persistence

### 5.5 Verification
- `pnpm verify` green
- agent-browser screenshots in dark mode AND light mode at 1920×1080: knob text readable, swatches visible, modern layout
- VLM verify: "Is the toggle knob's active-label readable in dark mode?" → "Yes"
- Commit + push, screenshot zip → DASHBOARD repo

### 5.6 Risks
- **Risk C1**: custom-accent + density + font additions might cascade into other components. Mitigation: only `useThemeStyles` reads them; all other components consume `styles.*` already, so they get the new values for free.
- **Risk C2**: native color input has inconsistent UX across platforms. Mitigation: ship the preset row first; native input as a "Custom…" option behind a toggle.

---

## 6. Workstream D — Chat Screen Complete Redesign (P1, largest)

### 6.1 Owner's exact words
*"I looked at the chat screen win UI and it was not kind of how I hoped for it to be. I was hoping for a complete redesign of it, improving it overall, making it much better, much more proper and such, and using modern design techniques and other stuff like that. What I want is that maybe the chat window should be made to show on the left side or in the center on the left side. These infos will not show, like the folder structures and the actual code window or other windows. Those will not show there."*

### 6.2 Current anatomy
- `src/components/project-chat/ProjectChatScreen.tsx` (247 L) — 3-panel layout: LeftSidebar+Gap / CodeView+Gap / AgentChatPanel (chat on RIGHT, `shrink-0`, `chatWidth=400`).
- `src/components/project-chat/AgentChatPanel.tsx` (1203 L) — h-10 header (agent picker popover + model chip + status pill) → scroll body (empty hero + AnimatePresence messages: UserMessage accent bubble / AiMessage card with RichText + CodeBlock + ReplyStats / ToolsRow pills / DiffCard / LIVE streaming text + bounceDot cursor / AgentThinking "Working…" dots) → error banner → composer (NOOP Paperclip + comment-only Stop button `/* stop logic */` + Send + ComposerFooter with ctx meter + model picker).
- `onlyChat` mode (both flags false) lost the demo's `justify-center items-center + maxWidth 90%` in the port — chat fills edge-to-edge.
- `TopBar.tsx` (213 L, R14) is **orphaned** — not imported anywhere, only referenced in comments (L21, L210 of ProjectChatScreen, L726 + L783 of AgentChatPanel).

### 6.3 Proposed redesign

#### 6.3.1 New `chatFocusMode` store flag
Add `chatFocusMode: boolean` (default `true` on chat routes) to `src/lib/project-chat-store.ts`. When true:
- LeftSidebar (Explorer) hidden
- CodeView hidden
- AgentChatPanel takes `flex-1` with `max-w-3xl mr-auto` (**LEFT-aligned on desktop ≥1024px** per 6-e — owner said "left side or center on the left side"; `mx-auto` would center, `mr-auto` left-aligns with right margin auto); full-width on mobile (<1024px)
- A new slim `ChatTopBar` (60px) appears at the top: back-to-dashboard button + project name + agent chip + theme toggle + "Show panels" popover (Code + Explorer toggles to flip back to the 3-panel layout when the user wants to see code)

#### 6.3.2 New `ChatFocusLayout.tsx` component
File: `src/components/project-chat/ChatFocusLayout.tsx` (~120 lines).
Renders: `<ChatTopBar />` + `<AgentChatPanel />` (the existing component, just re-parented).
When `chatFocusMode === false`, falls back to the existing `ProjectChatScreen` 3-panel layout (no behavior change).

#### 6.3.3 Rewrite `ProjectChatScreen.tsx`
- Top-level: `if (chatFocusMode) return <ChatFocusLayout />;` else the existing 3-panel layout.
- Both modes share the same `AgentChatPanel` component — only the surrounding layout changes.
- Delete the orphaned `TopBar.tsx` import attempt at L210 (it's just a comment; no actual import to delete, but clean up the comment).

**NOTE (6-f):** Workstream D is split into D1/D2/D3 because the original scope (AgentChatPanel 1203L modernization + new ChatFocusLayout + new ChatTopBar + delete TopBar + real DiffCard + wired Stop + wired Paperclip + ⌘K rewire + 4 tests) was 3× over-scoped. Each sub-workstream gets its own commit + owner verdict.

#### 6.3.4.1 D1 — Layout (chatFocusMode + ProjectChatScreen rewire + ChatFocusLayout + ChatTopBar)
- Add `chatFocusMode` to `project-chat-store.ts` (default `true` on chat routes).
- Rewrite `ProjectChatScreen.tsx` to branch: `if (chatFocusMode) return <ChatFocusLayout />;` else existing 3-panel layout.
- NEW `ChatFocusLayout.tsx` (~120 L): renders `<ChatTopBar />` + `<AgentChatPanel />` (existing component, just re-parented). Chat takes `flex-1 max-w-3xl mr-auto` (left-aligned, 6-e).
- NEW `ChatTopBar.tsx` (~80 L): back-to-dashboard + project name + agent chip + theme toggle + "Show panels" popover.
- Tests: `ChatFocusLayout.test.tsx` (new), `ProjectChatScreen.test.tsx` (update).

#### 6.3.4.2 D2 — AgentChatPanel modernization + streaming hook + aria-live (MERGED with Workstream E per 6-f hidden-coupling fix)
- NEW `src/hooks/use-stream-session-message.ts` — React Query wrapper around `streamSessionMessage`; default streaming path; sync `useSendMessage` is fallback only.
- `AgentChatPanel.tsx` `runTurn` (L786–870) uses the new hook; the `liveMode` branch is removed (streaming is always-on when sidecar reachable).
- **Header (h-12, was h-10)**: agent chip (popover picker) + model chip + status pill + "Show panels" toggle + theme toggle.
- **Message body**:
  - **Empty state**: centered hero (36px accent circle + Sparkles) + "Acute Agent" + model name + "What would you like to build?" + 3 example prompt chips.
  - **UserMessage**: accent bubble, right-aligned, max-w-prose.
  - **AiMessage**: card with RichText + CodeBlock (line numbers + copy, R24) + ReplyStats chip + "Re-run this turn" button.
  - **ToolsRow**: group consecutive calls into "Used N tools" expandable row (default collapsed). Show tool name + ✓/✗ + duration.
  - **Streaming bubble (typing-effect fix)**: when `liveText !== ""`, render a growing AiMessage-shaped bubble with the streaming text + a blinking text caret (`caret-blink` keyframe, not bounceDot). When `liveTools` is non-empty, render ToolsRow inside the same bubble above the streaming text. **`aria-live="polite"` on the bubble root** (6-e accessibility fix) so screen readers announce streaming tokens. When the turn completes, the bubble settles into a normal AiMessage.
  - **AgentThinking**: remove the separate row; merge into the streaming bubble. Before first text-delta, show "Thinking…" (animated ellipsis `ellipsis` keyframe, not bounceDot) inside the growing bubble.
- **Demo-mode auto-detect (6-e)**: on app boot, `useStreamSendMessage` pings `GET ${baseUrl}/api/v1/health`; if 200 + token available, auto-calls `setDemoData(false)`. The demo-mode banner is now only shown if the health ping FAILS (sidecar truly unreachable).
- Tests: `AgentChatPanel.test.tsx` (new) — streaming bubble renders, aria-live present, demo-mode banner only on health-ping failure.

#### 6.3.4.3 D3 — Composer wiring + DiffCard real diff + delete TopBar + ⌘K rewire
- **Paperclip**: wire to a file-attach popover (lists project files via `useProjectTree`, click to insert `@path/to/file` reference into the input). If owner prefers minimal, leave as TODO with popover scaffolded but disabled.
- **Stop button**: wire to `AbortController` — `runTurn` already creates one (verify in `api.ts` `streamSessionMessage`); expose `stopRef.current.abort()` on Stop click. Disable Stop when not streaming.
- **DiffCard**: add real diff body rendering — read `file_snapshots` for the path, render unified diff with +/- coloring (`+` green `#22c55e`, `-` red `#ef4444`, context line muted). Fall back to the existing path/chars card if snapshot is empty.
- **⌘K hint**: replace misleading "TopBar file search" comment with: `⌘K` opens the new `CommandPalette` (Workstream H) — OR the Paperclip file-attach popover if H isn't done yet.
- **DELETE `src/components/project-chat/TopBar.tsx`** (213 L, truly orphaned per 6-d grep: zero `import.*TopBar` matches).
- **DO NOT DELETE `ExperimentalLayout.tsx`** (6-d verified: imported + rendered by `ProjectChatScreen` L17+L213 — it's the "Experimental" toggle view, NOT orphaned).
- Tests: update `AgentChatPanel.test.tsx` for Stop/Paperclip/DiffCard wiring.

#### 6.3.5 New CSS animations
- `caret-blink`: `@keyframes caret-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }` 1s steps(2) infinite — a thin vertical bar `|` after the streaming text.
- `ellipsis`: `@keyframes ellipsis { 0%{content:"."} 33%{content:".."} 66%{content:"..."} }` on a `::after` — for the "Thinking…" state.
- Both respect `prefers-reduced-motion: reduce` (static `|` and `...`).

### 6.4 Files touched (split across D1/D2/D3 — each its own commit on `work/round-28-d1`, `work/round-28-d2`, `work/round-28-d3` branches per 6-f work-branch discipline fix)

**D1 — Layout:**
- `src/components/project-chat/ProjectChatScreen.tsx` — rewrite to branch on `chatFocusMode`
- NEW `src/components/project-chat/ChatFocusLayout.tsx` — the new layout
- NEW `src/components/project-chat/ChatTopBar.tsx` — slim top bar
- `src/lib/project-chat-store.ts` — add `chatFocusMode` (default true on chat routes)
- Tests: `ProjectChatScreen.test.tsx` (update), `ChatFocusLayout.test.tsx` (new)

**D2 — AgentChatPanel modernization + streaming hook + aria-live (merged with WS-E per 6-f):**
- NEW `src/hooks/use-stream-session-message.ts` — React Query wrapper around `streamSessionMessage`
- `src/components/project-chat/AgentChatPanel.tsx` — modernize (header, message body, streaming bubble, demo-mode auto-detect)
- `src/index.css` — add `caret-blink` + `ellipsis` keyframes + global `@media (prefers-reduced-motion: reduce)` block retrofitting ALL existing animations (6-e)
- Tests: `AgentChatPanel.test.tsx` (new)

**D3 — Composer wiring + DiffCard + delete TopBar:**
- `src/components/project-chat/AgentChatPanel.tsx` — composer wiring (Stop, Paperclip, ⌘K, DiffCard real diff)
- DELETE `src/components/project-chat/TopBar.tsx` (truly orphaned per 6-d)
- **DO NOT DELETE `ExperimentalLayout.tsx`** (6-d verified: imported by ProjectChatScreen L17+L213)
- Tests: update `AgentChatPanel.test.tsx`

### 6.5 Verification
- `pnpm verify` green
- agent-browser screenshots at 1920×1080, 1280×800, 375×812:
  - chatFocusMode on: chat takes left/center-left with maxWidth, no Explorer/Code visible
  - chatFocusMode off (toggle "Show panels"): 3-panel layout still works
  - Streaming bubble grows with blinking caret
  - Stop button aborts mid-stream (verify via curl SSE: client close → server logs "abort signal received")
  - Empty state shows hero + example chips
  - DiffCard renders real unified diff
- VLM verify each screenshot
- Commit + push, screenshot zip → DASHBOARD repo

### 6.6 Risks
- **Risk D1**: removing TopBar.tsx might break a test that imports it. Mitigation: grep for `TopBar` imports before deletion; the sub-agent confirmed only comments reference it.
- **Risk D2**: `chatFocusMode` default true might surprise users who want the 3-panel layout. Mitigation: persist the flag per-project; default true only on chat routes (not on `/project/:id` overview).
- **Risk D3**: AgentChatPanel is 1203 lines — modernizing it risks regressions. Mitigation: work on a `work/round-28-chat-redesign` branch (ADR-0020 discipline), commit+push after each green milestone, merge only when full battery passes.
- **Risk D4**: real diff rendering needs `file_snapshots` data — verify the snapshot table is populated (R27 deps fix made this live). If empty for old sessions, fall back to the existing path/chars card.

---

## 7. Workstream E — Live Streaming Typing Effect (P2, depends on D)

### 7.1 Owner's exact words
*"The live response handling is not being done properly. It completes all the tasks and then digester directly shows the results. It does not show the typing effect or anything like that while the model is actually providing the responses."*

### 7.2 Root cause (from sub-agent 6-c)
The streaming pipeline IS correctly implemented end-to-end:
- `server.ts` L963 SSE route uses `reply.hijack()` + raw `res.write("data: <JSON>\n\n")` per event
- `runtime.ts runStreamedAgentTurn` emits each event live
- `chat.ts streamAiSdkChat` yields `text-delta` events as they arrive from `streamText`
- `api.ts streamSessionMessage` parses SSE chunks and calls `onEvent` per event
- `AgentChatPanel.runTurn` uses `streamSessionMessage` **only when `liveMode === true` (i.e. `demoData === false`)**

**Most likely cause of owner's complaint**: owner is running with `demoData === true` because the sidecar is unreachable or `VITE_ACUTE_BASE_URL`/`VITE_ACUTE_TOKEN` aren't set. In demo mode, `AgentChatPanel` falls back to `useSendMessage().mutateAsync()` (L847) which hits the SYNCHRONOUS `POST /sessions/:id/messages` route — entire turn result returns only AFTER all tool calls + final text complete. **This matches the owner's "completes all tasks then directly shows the results" exactly.**

Secondary possibility: `liveMode` is on but the model emits all tool-calls first then only a brief final summary text (the round-27 "stop early" issue — addressed in Workstream F).

### 7.3 Proposed fix
1. **Add a `useStreamSendMessage` hook** (NEW `src/hooks/use-stream-session-message.ts`) that wraps `streamSessionMessage` with React Query mutation semantics. Use it in `AgentChatPanel.runTurn` instead of the inline `streamSessionMessage` call. This makes the streaming path the default; the sync `useSendMessage` becomes the fallback only when SSE is unsupported.
2. **Verify the `demoData` flag** in `src/lib/config-store.ts` — confirm it flips to `false` when `VITE_ACUTE_BASE_URL` is set. Add a dev-mode banner: when `demoData === true` and the user is on a chat route, show a small "Demo mode — start the sidecar for live streaming" banner so the owner knows why there's no typing effect.
3. **Fix the streaming cursor** (Workstream D 6.3.4): replace `bounceDot` with the `caret-blink` keyframe. The streaming bubble grows with a blinking `|` after the text.
4. **Per-char animation (optional polish)**: if the SSE cadence is slow (>500 ms between deltas), buffer the latest delta and reveal it char-by-char over 200 ms via `requestAnimationFrame`. This gives a smooth typing feel even when the model is slow. Off by default; enable via `streamTypingBuffer: boolean` in the UI store.
5. **SSE cadence test (CI gate, NEW)**: `tests/e2e/sse-cadence.test.mjs` — boot sidecar, send a chat message, measure time between `text-delta` events. Assert <300 ms median. Fails if streaming is broken.

### 7.4 Files touched
- NEW `src/hooks/use-stream-session-message.ts` — React Query wrapper around `streamSessionMessage`
- `src/components/project-chat/AgentChatPanel.tsx` — use the new hook; add demo-mode banner; per-char buffer
- `src/lib/config-store.ts` — verify `demoData` flag logic; add `streamTypingBuffer: boolean` default false
- `src/lib/api.ts` — verify `streamSessionMessage` handles AbortController correctly (for the Stop button)
- NEW `tests/e2e/sse-cadence.test.mjs` — CI gate
- `src/index.css` — `caret-blink` keyframe (already in Workstream D)

### 7.5 Verification
- `pnpm verify` green (incl. new SSE cadence test)
- Live battery: boot sidecar with `ACUTE_PROVIDER_OPENROUTER` env, `VITE_ACUTE_BASE_URL`+`VITE_ACUTE_TOKEN` set, send a chat message → tokens visibly stream into a growing bubble with blinking caret
- SSE curl battery: `curl -N -H "Authorization: Bearer acute-dev-local" -X POST -d '{"content":"hello"}' http://127.0.0.1:5178/api/v1/sessions/$SID/messages/stream` → `text-delta` events arrive at <300 ms cadence
- agent-browser screenshots mid-stream showing the growing bubble + caret
- Commit + push, screenshot zip → DASHBOARD repo

### 7.6 Risks
- **Risk E1**: sidecar unreachable in the sandbox (api.openrouter.ai DNS-blocked). Mitigation: use the apex `https://openrouter.ai/api/v1` baseUrl (already seeded); verify with `curl https://openrouter.ai/api/v1/models -H "Authorization: Bearer $KEY"`.
- **Risk E2**: per-char buffer might desync from the actual stream. Mitigation: default off; when on, only buffer the latest delta (don't queue), so the UI never lags behind the model by more than 200 ms.
- **Risk E3**: demo-mode banner might be annoying. Mitigation: dismissible, persists "don't show again" in localStorage.

---

## 8. Workstream F — Multi-Turn Agentic Continuation (P2, depends on E)

### 8.1 Owner's exact words
*"It was not continuing the chats or anything like that. It is a full-fledged coding environment and it should handle it like this. It should automatically continue with the next sessions and various things like that. It is not possible for the model to complete all the things in one single go. It happens like this: it needs to go back and forth. It needs to get the context and various things to complete one task. Maybe it needs to do a total of 4, 5, 6, or 7 iterations or such to do things like that. For example if we give it a research task then what it will do is that it will go on to perform the actions, do the research, and save the files. After saving it will restart and do the next research and various other kinds of things like those."*

Also: *"You said that the model is not capable. Let me tell you the model is actually quite capable. It is one of the best models and it does not make sense for it to make those mistakes. Those might be issues in our own project. We might not have set up the instructions properly."*

### 8.2 Root cause (from sub-agent 6-c)
- Runtime does ONE `streamText`/`generateText` call per user message.
- AI SDK v7 multi-step loop runs up to `agent.maxTurns=40` tool round-trips per call — so 4–7 iterations IS structurally supported within a single chat call.
- BUT the runtime does NOT loop on its own to start a NEW chat call after the SDK loop ends. So "restart → next research" as a NEW chat call is NOT implemented.
- System prompt's TASK PLANNING step 5 says "When done, summarize what you changed" — SIGNALS EARLY WRAP-UP.
- Missing: no "AGENTIC LOOP" section; no "do not ask for confirmation between steps"; no "use 4–7+ tool calls when needed"; no example of research→save→research→save workflow.
- The model `stealth/ox-alpha` (the only allowed model) tends to stop early on multi-step tasks per R27 round file — but the owner disputes this ("the model is actually quite capable").

### 8.3 Proposed fix

#### 8.3.1 System prompt rewrite (`agent-core/src/agents/prompts.ts`)
Add a new `## AGENTIC LOOP` section near the top (after TOOL USE, before FILE EDITING):
```
## AGENTIC LOOP — MULTI-TURN COMPLETION

You are a multi-turn agent. A single user request typically requires 4–7+ tool calls across multiple reasoning steps. DO NOT attempt to complete the entire task in one assistant message. DO NOT summarize and stop after one tool call.

Workflow:
1. Read the user's request. Identify the FIRST concrete action.
2. Call the relevant tool (read_file, search_code, list_dir, web_fetch, etc.).
3. Read the tool result. Decide the NEXT action based on what you learned.
4. Repeat 2–3 until the task is GENUINELY complete and verified.
5. Only when the work is done and verified, write a brief summary (1–3 sentences).

Rules:
- DO NOT ask the user for confirmation between steps. Proceed autonomously.
- DO NOT stop after a single tool call because "you have the info." Apply it.
- If a tool call fails, diagnose (read the error), fix, retry. Do not abort.
- If you save a file, that's NOT the end of the task — verify the save (read_file it back) and continue with the next step.
- Use the todo_write tool to track multi-step plans. Mark items complete as you go.
- For research tasks: research → save findings to a file → research the next sub-topic → append → repeat. Do NOT put all findings in one final message.
- You have a budget of up to {maxTurns} tool round-trips. Use it when needed. Stopping early on a multi-step task is a FAILURE.

Example (research task "investigate how the auth system works"):
  turn 1: list_dir src/ → see auth/, sessions/, providers/
  turn 2: read_file src/auth/index.ts → see login() flow
  turn 3: read_file src/sessions/manager.ts → see session creation
  turn 4: read_file src/providers/registry.ts → see key injection
  turn 5: write_file research/auth-system.md with findings
  turn 6: read_file research/auth-system.md (verify save)
  turn 7: assistant message: "Done. Findings in research/auth-system.md."
```

Also modify the existing TASK PLANNING step 5: change "When done, summarize what you changed" to "**Only when the work is GENUINELY complete and verified**, write a brief 1–3 sentence summary. Do NOT summarize prematurely."

#### 8.3.2 Runtime outer loop (`agent-core/src/agents/runtime.ts`)
Currently: one `streamText`/`generateText` call per user message; the SDK's internal multi-step loop runs up to `maxTurns` tool round-trips.
Proposed: keep the single SDK call (the internal loop IS the multi-turn continuation), but:
- Increase `agent.maxTurns` default from 40 → 80 (more headroom for complex tasks).
- **INVERTED `continueIfUnfinished` post-check (6-e fix — phrase-matching was brittle):** after the SDK loop ends, the runtime automatically continues UNLESS BOTH (a) the final assistant message contains an explicit completion signal ("Done.", "Task complete.", "Finished.", "All set.") AND (b) ALL todo items are marked `completed` (read via `listSessionEvents` filtered by `type='todo.update'`, parse the latest todo state per item). If EITHER condition is false, start a NEW SDK call with the conversation context continued. Cap at **5 outer-loop iterations** (6-e fix: 3 was below owner's 4–7 range; 5 × 80 = 400 tool round-trips max per user message).
- **Context-window guard (6-f R-F5 fix):** before each outer-loop iteration, check `assembledContextTokens`; if > 800K, abort the outer loop with a `meta.context_limit` event (the 1M context window is a LIMIT not headroom; 240+ tool round-trips easily approach 500KB of tool I/O alone).
- **Request-count guard (6-f R-F6 fix):** track `totalRequests` per user message; if > 200, abort (OpenRouter rate limits apply even on 0-cost models).
- Emit a `meta.continuation` SSE event when the outer loop kicks in (type: `meta.continuation`, payload: `{ iteration: N, reason: 'incomplete_todos' | 'no_completion_signal' }`). The frontend streaming hook from D2 handles this event to show a "Continuing…" indicator inside the streaming bubble (NOT a new user bubble).

#### 8.3.3 Agent record update (`agent-core/src/storage/agents.ts`)
- Default `maxTurns`: 40 → 80 (migration `0006_agents_max_outer_loops.sql` — 6-d fix: next free migration number is 0006, not 0007):
```sql
-- 0006_agents_max_outer_loops.sql
ALTER TABLE agents ADD COLUMN max_outer_loops INTEGER NOT NULL DEFAULT 5;
UPDATE agents SET max_turns = 80 WHERE max_turns = 40 OR max_turns IS NULL;
UPDATE agents SET max_outer_loops = 5 WHERE max_outer_loops IS NULL OR max_outer_loops = 3;
```
- Add `maxOuterLoops: integer DEFAULT 5` column (5, not 3, per 6-e).

### 8.4 Files touched
- `agent-core/src/agents/prompts.ts` — add AGENTIC LOOP section, modify TASK PLANNING step 5
- `agent-core/src/agents/runtime.ts` — `continueIfUnfinished` post-check, outer loop
- `agent-core/src/storage/agents.ts` — `maxTurns` default 80, `maxOuterLoops` field
- NEW `agent-core/src/storage/migrations/0007_agents_max_outer_loops.sql` — add `max_outer_loops INTEGER DEFAULT 3`
- `agent-core/tests/runtime.test.ts` — new tests: (a) prompt contains "AGENTIC LOOP" section, (b) outer loop triggers on "Let me now" continuations, (c) outer loop caps at `maxOuterLoops`

### 8.5 Verification
- `pnpm verify` green
- Live battery (the canonical R28 proof): on a fresh DB, prompt "Research this codebase: how does the streaming system work? Write your findings to `research/streaming.md`." → assert:
  - ≥4 tool calls (list_dir, read_file ×N, write_file)
  - ≥1 outer-loop continuation (if the model stops early, the runtime auto-continues)
  - `research/streaming.md` exists on disk with substantive content
  - todo_write used to track the plan
  - No premature "I'll do that next" final message
- Commit + push, screenshot zip → DASHBOARD repo

### 8.6 Risks
- **Risk F1**: the `continueIfUnfinished` heuristic (string matching on "Let me now" etc.) might trigger false positives. Mitigation: require BOTH a continuation-phrase AND incomplete todo items.
- **Risk F2**: outer loop might runaway. Mitigation: hard cap `maxOuterLoops=3`; emit a `meta.continuation` event each iteration so the UI can show a "Stop continuing" button.
- **Risk F3**: increasing `maxTurns` to 80 might burn through the OpenRouter budget. Mitigation: `stealth/ox-alpha` is 0-cost per owner; still add a cost-threshold guard (abort if `turnCostUsd > $1.00` — generous for a 0-cost model but covers if owner switches to a paid model later).
- **Risk F4**: prompt rewrite might regress the existing 131 agent-core tests. Mitigation: run full `pnpm verify` after the prompt change; fix any snapshot tests that assert the old prompt text.

---

## 9. Workstream G — Project Indexing & Codebase Awareness (P3, depends on F)

### 9.1 Owner's exact words
*"Implement proper project or such indexing so that our model properly knows about the project, can manage it, can handle things, and other stuff like that."*

### 9.2 Current state
- No `codebase_index` table. The agent re-discovers the project structure every turn via `list_dir` + `read_file`.
- `search_code` (R24) does content grep but doesn't build a persistent index.
- This works for small projects but is slow + token-expensive for large codebases.

### 9.3 Proposed design

#### 9.3.1 New `codebase_index` table
Migration `0007_codebase_index.sql` (6-d fix: renumbered from 0008; next free after 0006 is 0007):
```sql
CREATE TABLE IF NOT EXISTS codebase_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                 -- root-relative, '/' separators
  symbol TEXT NOT NULL,               -- function/class/const/variable name
  kind TEXT NOT NULL,                 -- 'function' | 'class' | 'const' | 'variable' | 'import' | 'type' | 'interface'
  line INTEGER NOT NULL,              -- 1-based
  line_end INTEGER,                   -- for multi-line symbols
  signature TEXT,                     -- function signature, class heritage, etc.
  docstring TEXT,                     -- first comment block
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, path, symbol, line)
);
CREATE INDEX IF NOT EXISTS idx_codebase_index_project ON codebase_index(project_id);
CREATE INDEX IF NOT EXISTS idx_codebase_index_symbol ON codebase_index(project_id, symbol);
CREATE INDEX IF NOT EXISTS idx_codebase_index_path ON codebase_index(project_id, path);
```

#### 9.3.2 Indexer (`agent-core/src/storage/index.ts`)
- `reindexProject(db, projectId, rootPath)`: walks the tree (respecting `IGNORED_DIRS`), parses each `.ts/.tsx/.js/.jsx/.py/.rs/.go/.md` file with a lightweight regex-based symbol extractor (no full AST — keeps the dep tree tiny).
- Extracts: functions (`function foo(`, `def foo(`, `fn foo(`, `func foo(`), classes (`class Foo`, `struct Foo`), constants (`const FOO =`, `FOO =`), types/interfaces (`type Foo`, `interface Foo`), imports (`import ... from`, `use ...`, `#include`).
- Inserts rows in batches (1000 per INSERT).
- **6-d fix: `IGNORED_DIRS` (L31) and `MAX_READ_BYTES` (L26, NOT `MAX_FILE_SIZE`) are currently PRIVATE in `tools/index.ts`.** Either (a) add `export` keyword to both in `tools/index.ts`, OR (b) define copies in `storage/index.ts` (preferred — avoids polluting the tools module's public API). Choose (b).
- Idempotent: `DELETE FROM codebase_index WHERE project_id = ?` before re-insert.
- **Snapshot table growth (6-f R-G4):** `file_snapshots` stores before+after BLOBs for every write/edit/delete; over 100+ rounds × 10 mutations × 10KB = 10MB+. Add a 30-day cleanup: `DELETE FROM file_snapshots WHERE ts < datetime('now', '-30 days')` on each `reindexProject` call.

#### 9.3.3 New `index_project` tool
File: `agent-core/src/tools/index_project.ts`.
- Input: `{ project_id?: string }` (defaults to the current session's project).
- Action: calls `reindexProject`, returns `{ indexed_files: N, indexed_symbols: M, duration_ms: D }`.
- Registered in `tools/index.ts` (16th tool). **MUST be wrapped in `jsonSchema()` per lesson #9 (6-f fix — AI SDK v7 requires `jsonSchema()` wrapping; bare literals pass TS cast but fail at runtime with `502 "schema is not a function"`).**

#### 9.3.4 Auto-index on file mutation
In `runtime.ts`, after `write_file`/`edit_file`/`delete_file` tool calls, queue a re-index of just that file (delta update — not a full reindex). The next time the agent calls `search_code` or `read_file` on that path, the index is fresh.

#### 9.3.5 Index summary in context
When preparing a turn, `runtime.ts` injects a "Project index summary" into the system prompt context:
- Total files, total symbols, top 10 files by symbol count, list of all top-level symbols in the file the agent is currently looking at.
- This gives the agent "codebase awareness" without it having to `list_dir` + `read_file` every file every turn.

#### 9.3.6 Frontend
- `useProjectIndex(projectId)` hook — fetches `GET /api/v1/projects/:id/index` (new route returning the summary).
- `src/components/project-chat/panels/CodebasePanel.tsx` (NEW) — a tree view of symbols grouped by file, clickable to jump to the symbol in CodeView. Hidden by default; toggle via the new "Show panels" popover (Workstream D 6.3.1).

### 9.4 Files touched
- NEW `agent-core/src/storage/migrations/0008_codebase_index.sql`
- NEW `agent-core/src/storage/index.ts` — indexer + queries
- NEW `agent-core/src/tools/index_project.ts` — the tool
- `agent-core/src/tools/index.ts` — register `index_project` (16th tool)
- `agent-core/src/agents/runtime.ts` — inject index summary into context; delta-update on file mutations
- `agent-core/src/agents/prompts.ts` — CODEBASE AWARENESS section: explain that the index is available, when to call `index_project` (first turn on a new project, after large refactors), and how to use `search_code` to find symbols
- `agent-core/src/server.ts` — `GET /api/v1/projects/:id/index` route
- NEW `src/hooks/use-project-index.ts`
- NEW `src/components/project-chat/panels/CodebasePanel.tsx`
- Tests: `index.test.ts` (indexer correctness on a fixture project), `index_project.test.ts` (tool registration + execution)

### 9.5 Verification
- `pnpm verify` green
- Live battery: open a project, call `index_project` → returns "indexed N files, M symbols"; `search_code "useThemeStyles"` returns the symbol location; agent asked "where is the streaming implemented?" answers from the index without needing `list_dir` + `read_file` of every file
- Commit + push, screenshot zip → DASHBOARD repo

### 9.6 Risks
- **Risk G1**: regex-based symbol extraction misses edge cases (template literals, decorator-wrapped classes, etc.). Mitigation: document the limitation in the prompt; for full accuracy, defer to a future MCP-tree-sitter integration.
- **Risk G2**: reindex is slow on large projects. Mitigation: delta-update on file mutations (only re-parse changed files); full reindex only on `index_project` tool call or first session open.
- **Risk G3**: index grows large. Mitigation: `DELETE WHERE ts < datetime('now', '-30 days')` cleanup on reindex; or per-project cap at 50k symbols.

---

## 10. Workstream H — Advanced Search (Grep Integration) (P3, depends on D + G)

### 10.1 Owner's exact words
*"Utilize advanced searching techniques too, like a grep or other kinds of things."*

### 10.2 Current state
- `search_code` tool (R24) exists — content grep with regex support, returns file:line:match.
- `search_files` tool (R14) exists — filename glob search.
- Both are registered in `tools/index.ts`.
- `⌘K` keyboard hint in the composer references "TopBar file search" which doesn't exist (TopBar orphaned since R15).

### 10.3 Proposed work
1. **Verify `search_code` end-to-end** (sub-agent 6-c confirmed it's registered; run a live battery to confirm it works on a real project).
2. **Extend `search_code` with options**: `case_sensitive: boolean`, `whole_word: boolean`, `file_glob: string` (e.g. `*.ts`), `max_results: integer` (default 50, cap 200). Add to the input schema.
3. **Wire `⌘K` to a real search popover**: NEW `src/components/project-chat/CommandPalette.tsx` — a shadcn/ui `Command`-based popover that opens on `⌘K`, shows:
   - File search (uses `search_files`)
   - Symbol search (uses the codebase index from Workstream G)
   - Content search (uses `search_code`)
   - Recent files
   - Quick actions (new session, new project, settings)
   - Clicking a result: opens the file in CodeView (or focus mode = false to show panels).
4. **Frontend search route**: `POST /api/v1/projects/:id/search` (new route) — body `{ query: string, kind: "files"|"symbols"|"content", options: {...} }`. Returns unified results. Used by the CommandPalette.

### 10.4 Files touched (6-d fix: `search_code` is INLINE in `tools/index.ts` L515–532, NOT a separate file)
- `agent-core/src/tools/index.ts` L515–532 — extend the inline `search_code` tool's input schema with `case_sensitive`, `whole_word`, `file_glob`, `max_results` options. **MUST be wrapped in `jsonSchema()` per lesson #9 (6-f fix).**
- `agent-core/src/server.ts` — `POST /api/v1/projects/:id/search` route (NEW — uses `search_code` + `search_files` + codebase index under the hood)
- `src/lib/api.ts` — `searchProject(projectId, query, kind, options)` client (NEW)
- NEW `src/components/project-chat/CommandPalette.tsx` — the ⌘K popover (uses shadcn `Command` — NEW dep, add to `package.json`; 6-f flagged pnpm install time growth as R-H3)
- `src/components/project-chat/ChatTopBar.tsx` (from Workstream D1) — wire `⌘K` to open CommandPalette
- `src/components/project-chat/AgentChatPanel.tsx` — remove the misleading "⌘K TopBar search" comment; add ⌘K handler that opens CommandPalette
- Tests: extend `tools/index.test.ts` with case_sensitive/whole_word/file_glob tests for `search_code`; `CommandPalette.test.tsx` (new)

### 10.5 Verification
- `pnpm verify` green
- Live battery: ⌘K opens the palette; type "useThemeStyles" → symbol search finds it in `themes.ts`; type "*.tsx" → file search lists all tsx files; type "streamText" → content search finds occurrences
- Commit + push, screenshot zip → DASHBOARD repo

### 10.6 Risks
- **Risk H1**: `search_code` with regex might be slow on large projects. Mitigation: cap `max_results=200`, abort after 5s.
- **Risk H2**: CommandPalette might collide with the existing ⌘K handler in `AgentChatPanel`. Mitigation: replace the existing handler (it currently focuses a non-existent TopBar search).

---

## 11. Workstream I — In-App Demo Viewer (P3)

### 11.1 Owner's exact words
*"I looked and checked the demos and if the demos were kind of working properly here, they were. You created the YouTube demo and it was proper, looking good, and kind of how I hoped for it to be. Good work with that but maybe we should give an area inside our own application itself to view this demo too and other kinds of things."*

### 11.2 Current state
- The R27 YouTube-like demo is at the ACUTE-CODE repo root (`demo-output-index.html`, 13KB, 545 lines) — but it's a file on disk, not viewable in the app.
- No in-app demo browser UI.

### 11.3 Proposed design

#### 11.3.1 Demo storage convention
- Demos live at `<project>/demos/<name>/index.html` (or `.tsx` for interactive demos rendered via iframe sandbox).
- The agent's `write_file` tool already writes to `<project>/...` — so the agent can create demos as part of a task.
- A demo is any HTML file under `<project>/demos/`. The viewer discovers them via `GET /api/v1/projects/:id/demos` (new route, walks `<project>/demos/`).

#### 11.3.2 New `/demos` route
- `src/App.tsx` — add `<Route path="demos" element={<DemoViewerScreen />} />` inside AppShell.
- `src/components/shell/Sidebar.tsx` — add a "Demos" NavButton (between Usage and the divider).
- `src/components/demos/DemoViewerScreen.tsx` (NEW) — lists demos (cards with name + thumbnail + "Open" button); clicking opens the demo in a sandboxed `<iframe>` (full viewport).

#### 11.3.3 Demo metadata
- Each demo can have a `demo.json` next to its `index.html`: `{ name, description, created_at, thumbnail? }`.
- If absent, the viewer uses the filename + first `<h1>`/`<title>` as the name.

#### 11.3.4 Iframe sandboxing
- `<iframe sandbox="allow-scripts allow-same-origin" />` — scripts run, but no top-nav, no form submission, no popups.
- A "Open in new tab" button for full-screen viewing.

### 11.4 Files touched
- `src/App.tsx` — add `/demos` route
- `src/components/shell/Sidebar.tsx` — add Demos NavButton
- NEW `src/components/demos/DemoViewerScreen.tsx`
- NEW `src/components/demos/DemoCard.tsx`
- NEW `src/lib/demos-store.ts` — list demos for a project
- `agent-core/src/server.ts` — `GET /api/v1/projects/:id/demos` route (walks `<project>/demos/`, returns metadata)
- `src/lib/api.ts` — `getProjectDemos(projectId)` client
- NEW `src/hooks/use-demos.ts` — `useProjectDemos(projectId)`
- Tests: `DemoViewerScreen.test.tsx` (new), server route test

### 11.5 Verification
- `pnpm verify` green
- Live battery: create a demo at `<project>/demos/test/index.html`, open `/demos` in the app → card appears, click → iframe renders the HTML, "Open in new tab" works
- Commit + push, screenshot zip → DASHBOARD repo

### 11.6 Risks
- **Risk I1**: iframe sandbox might break some demos. Mitigation: allow-scripts + allow-same-origin is the permissive set; document it.
- **Risk I2**: demos created by the agent might have XSS or malicious scripts. Mitigation: in v1, demos run in iframe sandbox; in v2 (MCP/Phase 3), add a CSP.

---

## 12. Workstream J — Documentation Management System (P3, depends on A)

### 12.1 Owner's exact words
*"Make sure that the documentation is proper and easily manageable."*

### 12.2 Current state
- `docs/README.md` has 10 binding folder-structure rules.
- 21 ADRs at `docs/decisions/`.
- Many runbooks at `docs/runbooks/`.
- BUT: docs drift. Sub-agent 6-a found 12 stale docs + 12 missing docs + 8 missing ADRs (per the G1-a audit). No CI gate to catch drift.

### 12.3 Proposed work

#### 12.3.1 Refresh `docs/README.md`
- Add the 12 explicit folder-structure rules (G1-a counted 12, current doc says 10 — reconcile).
- Add a "Doc freshness contract": every doc must have a `<!-- last-reviewed: YYYY-MM-DD round-NN -->` HTML comment at the top; `scripts/docs/check-stale.mjs` fails CI if any doc's last-reviewed is >3 rounds old.

#### 12.3.2 NEW `docs/runbooks/DOC-STANDARDS.md`
- Canonical doc structure: title, status, audience, body, cross-refs.
- ADR template (point to existing `docs/decisions/TEMPLATE.md`).
- Runbook template.
- Round-file template (`docs/ui-iterations/round-NN.md`).
- Naming conventions: kebab-case filenames, no spaces, no uppercase except ADR numbers.
- Stale rule: any doc referencing a file path that no longer exists → CI fails.

#### 12.3.3 NEW `scripts/docs/check-stale.mjs`
- Walks `docs/**/*.md` + `*.md` at repo root.
- For each: parse the `<!-- last-reviewed: ... -->` comment; fail if missing or >3 rounds old.
- For each: extract file path references (regex `/home/z/...`, `src/...`, `agent-core/src/...`); check the path exists; fail if not.
- For each: extract URL references; HTTP HEAD each; fail if 404 (allow 3 failing URLs before failing CI — handles transient outages).
- For each: extract version references (`v0.1.0`, `Round N`); cross-check against `package.json` version + `docs/status.json` latest milestone; warn (not fail) on mismatch.
- Add to `package.json` scripts: `"docs:check": "node scripts/docs/check-stale.mjs"`.
- Add to CI: `pnpm docs:check` before `pnpm verify`.

#### 12.3.4 Backfill missing docs (per G1-a audit)
- 12 missing docs (list to be filled in during execution — the audit report names them).
- 8 missing ADRs (next free is 0022 per sub-agent 6-a).

### 12.4 Files touched
- `docs/README.md` — refresh, add freshness contract
- NEW `docs/runbooks/DOC-STANDARDS.md`
- NEW `scripts/docs/check-stale.mjs`
- `package.json` — add `docs:check` script
- `.github/workflows/ci.yml` — add `pnpm docs:check` step before `pnpm verify`
- Backfill the 12 missing docs + 8 missing ADRs (list TBD during execution)
- Add `<!-- last-reviewed: 2026-09-07 round-75 -->` to every existing doc

### 12.5 Verification
- `pnpm docs:check` exits 0
- CI runs `pnpm docs:check` before `pnpm verify`; fails on drift
- Commit + push, screenshot zip → DASHBOARD repo

### 12.6 Risks
- **Risk J1**: adding `last-reviewed` to every doc is tedious. Mitigation: write a one-shot script `scripts/docs/stamp-all.mjs` that adds the comment to all docs missing it.
- **Risk J2**: URL HEAD checks might be flaky. Mitigation: allow 3 failures before CI fails; cache results for 24h.
- **Risk J3**: file-path reference extraction might have false positives (e.g. a path in a code example). Mitigation: only check paths outside fenced code blocks.

---

## 13. Workstream K — Dashboard Screenshot Zip Uploads (P2, do alongside B–D)

### 13.1 Owner's exact words
*"From now on I would like you to upload a zip file of the screenshots and such to the dashboard GitHub repository rather than the normal one."*

### 13.2 Current state
- R27 zip lives at the ACUTE-CODE repo root (`round-27-testing-screenshots.zip`, 1.37 MB, 22 files).
- DASHBOARD repo has no `screenshots/` directory.
- DASHBOARD `build.mjs` has a denylist that fails the build if it sees file paths — would block `screenshots/` from being added.

### 13.3 Proposed design

#### 13.3.1 NEW `DASHBOARD/screenshots/` directory
- `DASHBOARD/screenshots/round-27.zip` — move the existing R27 zip here (or copy + delete from ACUTE-CODE in a separate commit).
- `DASHBOARD/screenshots/round-28.zip` — each round's screenshots land here.
- `DASHBOARD/screenshots/README.md` — index of all zips with round number + date + brief description.
- `DASHBOARD/screenshots/index.json` — machine-readable: `[{ round: 27, date: "2026-08-24", zip: "round-27.zip", screenshots: ["01-dashboard.png", ...] }]`.

#### 13.3.2 Update `DASHBOARD/build.mjs` denylist
- The denylist blocks token-like patterns + internal paths. Allow `screenshots/` paths explicitly.
- The denylist scan only applies to files that end up in `index.html` / `assets/` (the generated output). The `screenshots/` directory isn't touched by the build, so it's safe.

#### 13.3.3 Update `DASHBOARD/data.json`
- Add a `screenshots` section: `{ rounds: [{ round: 27, url: "screenshots/round-27.zip", date: "2026-08-24", count: 22 }, ...] }`.
- The dashboard UI gets a "Screenshots" section listing each round with a download link.

#### 13.3.4 NEW `scripts/dashboard/publish-screenshots.mjs`
- Takes `<round>` arg + optional `<zip-path>` (defaults to `round-<NN>-testing-screenshots.zip` in ACUTE-CODE root).
- Verifies the zip exists + is valid (`unzip -t`).
- Copies the zip to `DASHBOARD/screenshots/round-<NN>.zip`.
- Updates `DASHBOARD/screenshots/index.json` (append or update the round entry).
- Updates `DASHBOARD/data.json` screenshots section.
- Commits + pushes to DASHBOARD repo using the dashboard PAT (token-in-URL, sanitized after).
- `package.json` script: `"dashboard:publish-screenshots": "node scripts/dashboard/publish-screenshots.mjs"`.

#### 13.3.5 DASHBOARD UI: Screenshots section
- `DASHBOARD/src/template.html` — add a `<section id="screenshots">` after the milestones section.
- `DASHBOARD/src/style.css` — style the section (cards per round, download button).
- `DASHBOARD/src/app.js` — count-up the total screenshots across all rounds; reveal animation.

### 13.4 Files touched
- ACUTE-CODE: NEW `scripts/dashboard/publish-screenshots.mjs`, `package.json` script
- DASHBOARD: NEW `screenshots/` dir (with `round-27.zip`, `README.md`, `index.json`), `build.mjs` denylist allow-list, `data.json` screenshots section, `src/template.html` + `src/style.css` + `src/app.js` screenshots section
- ACUTE-CODE: DELETE `round-27-testing-screenshots.zip` from repo root (moved to DASHBOARD)

### 13.5 Verification
- `node scripts/dashboard/publish-screenshots.mjs 28` works end-to-end
- `https://testplay-byte.github.io/DASHBOARD/screenshots/round-27.zip` downloads the zip (HTTP 200)
- Dashboard UI shows the Screenshots section with both rounds
- ACUTE-CODE repo root no longer has the zip
- Commit + push to both repos

### 13.6 Risks
- **Risk K1**: DASHBOARD denylist might still block the screenshots index. Mitigation: test the build locally before pushing.
- **Risk K2**: zip files might exceed GitHub's 100MB limit (R27 is 1.37 MB, so fine for now; future rounds with more screenshots might grow). Mitigation: cap each zip at 50MB; use Git LFS if needed (defer to future round).
- **Risk K3**: moving the R27 zip out of ACUTE-CODE is a destructive git operation. Mitigation: do it in a separate commit with a clear message; the zip is recoverable from git history if needed.

---

## 14. Workstream L — Testing & Verification Protocol (P3, do once then reuse)

### 14.1 Goal
A one-shot script that runs the full battery: lint + typecheck + test + build + license + live sidecar boot + agent-browser screenshots + VLM verify. Reusable every round.

### 14.2 Proposed `scripts/verify-round.mjs`
```
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm license:audit
boot sidecar (ACUTE_TOKEN=acute-dev-local ACUTE_PORT=5178 ACUTE_DB_PATH=.dev/verify.db ACUTE_PROVIDER_OPENROUTER=$KEY node agent-core/dist/main.js)
wait for ACUTE_READY
boot vite (VITE_ACUTE_BASE_URL=http://127.0.0.1:5178 VITE_ACUTE_TOKEN=acute-dev-local pnpm dev)
wait for vite ready
agent-browser: navigate to /, screenshot at 1920×1080, 1280×800, 375×812
agent-browser: navigate to /project/<id>/chat, screenshot
agent-browser: send a chat message, screenshot mid-stream
VLM verify each screenshot (assert no error boundary, no blank screen, expected elements present)
teardown: kill sidecar + vite
exit 0 on all pass, 1 on any fail
```

### 14.3 Files touched
- NEW `scripts/verify-round.mjs`
- `package.json` — `"verify:round": "node scripts/verify-round.mjs"`
- `docs/runbooks/TESTING.md` — refresh to reference the new script

### 14.4 Verification
- `pnpm verify:round 28` exits 0
- Commit + push

### 14.5 Risks
- **Risk L1**: agent-browser + VLM in CI is slow + flaky. Mitigation: run locally pre-push; CI runs only `pnpm verify` (no browser).
- **Risk L2**: sidecar boot might fail in CI. Mitigation: `verify-round` is a local-only script; CI gate is `pnpm verify` (the existing unit + build + license).

---

## 15. Workstream M — 100+ Iteration Review Cycle (P3, meta)

### 15.1 Goal
Codify the round cadence so the next 100 rounds have a stable structure.

### 15.2 Proposed `docs/agent/REVIEW-CADENCE.md`
- A round = one owner-feedback cycle. Start: owner message. End: explicit owner verdict (approve / changes / pivot).
- Every round produces: (a) code changes on a `work/round-NN` branch (ADR-0020), (b) `docs/ui-iterations/round-NN.md` evidence file, (c) `docs/ui-iterations/README.md` board row update, (d) `docs/agent/ORCHESTRATION-WORKLOG.md` snapshot append, (e) screenshot zip → DASHBOARD repo (Workstream K), (f) `docs/status.json` refresh, (g) commit + push + CI green.
- No round closes without explicit owner verdict. Praise ≠ approval.
- Questions batched once per round, max 10, [BLOCKING]/[NON-BLOCKING].
- Sub-agents OPTIONAL (R10 revision); inline preferred for implementation; parallel agents fine for research/audit/review.

### 15.3 Files touched
- NEW `docs/agent/REVIEW-CADENCE.md`
- NEW `docs/ui-iterations/round-28.md` (this round's evidence file — created at round start, filled as workstreams land)
- `docs/ui-iterations/README.md` — add R28 row

### 15.4 Verification
- The next agent (round 29) can read `REVIEW-CADENCE.md` + `round-28.md` and know exactly what to do.

### 15.5 Risks
- **Risk M1**: round files take time to write. Mitigation: the `scripts/verify-round.mjs` from Workstream L can auto-generate the evidence file skeleton (screenshots list + verify output).

---

## 16. Risk Register & Fallbacks

| Risk ID | Workstream | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| R-A1 | A | Docs drift again | Med | Low | Workstream J CI gate |
| R-B1 | B | Test asserting brand block breaks | High | Low | Rewrite tests in same commit |
| R-C1 | C | Custom-accent cascades | Low | Med | Only `useThemeStyles` reads it |
| R-D1 | D | TopBar deletion breaks tests | Low | Low | Grep before delete (sub-agent confirmed orphaned) |
| R-D2 | D | `chatFocusMode` default surprises | Med | Low | Per-project persist; default true only on chat routes |
| R-D3 | D | AgentChatPanel 1203L regressions | Med | High | Work branch + WIP pushes (ADR-0020) |
| R-D4 | D | Diff rendering needs snapshot data | Low | Low | Fall back to path/chars card if empty |
| R-E1 | E | Sidecar unreachable (DNS) | Low | Med | Use apex `openrouter.ai` baseUrl (already seeded) |
| R-E2 | E | Per-char buffer desync | Low | Low | Default off; only buffer latest delta |
| R-E3 | E | Demo-mode banner annoying | Med | Low | Dismissible + "don't show again" |
| R-F1 | F | `continueIfUnfinished` false positives | Med | Med | Require continuation-phrase AND incomplete todos |
| R-F2 | F | Outer loop runaway | Low | High | Hard cap `maxOuterLoops=3`; emit `meta.continuation` event |
| R-F3 | F | Cost burn | Low | Low | `stealth/ox-alpha` is 0-cost; add $1.00 guard for future paid models |
| R-F4 | F | Prompt rewrite regresses tests | Med | Med | Full `pnpm verify` after; fix snapshot tests |
| R-G1 | G | Regex symbol extraction misses cases | Med | Low | Document limitation; future MCP-tree-sitter |
| R-G2 | G | Reindex slow on large projects | Med | Med | Delta-update on mutations; full reindex only on tool call |
| R-G3 | G | Index grows large | Low | Low | 30-day cleanup; per-project cap 50k symbols |
| R-H1 | H | Regex search slow | Med | Low | Cap `max_results=200`; abort after 5s |
| R-H2 | H | CommandPalette ⌘K collision | Low | Low | Replace existing handler (it's broken anyway) |
| R-I1 | I | Iframe sandbox breaks demos | Low | Med | allow-scripts + allow-same-origin (permissive) |
| R-I2 | I | Demo XSS | Med | Med | v1 iframe sandbox; v2 CSP (Phase 3) |
| R-J1 | J | `last-reviewed` stamp tedious | High | Low | One-shot `stamp-all.mjs` script |
| R-J2 | J | URL HEAD flaky | Med | Low | Allow 3 failures; cache 24h |
| R-J3 | J | False-positive path refs | Med | Low | Only check outside fenced code blocks |
| R-K1 | K | DASHBOARD denylist blocks screenshots | Low | High | Test build locally before push |
| R-K2 | K | Zip size limit | Low | Low | Cap 50MB; Git LFS if needed (future) |
| R-K3 | K | Moving R27 zip is destructive | Low | Low | Separate commit; git history recoverable |
| R-L1 | L | Browser+VLM in CI slow/flaky | High | Med | Local-only; CI runs `pnpm verify` |
| R-L2 | L | Sidecar boot fails in CI | Med | Med | `verify-round` local-only; CI gate is `pnpm verify` |
| R-M1 | M | Round files take time | Med | Low | `verify-round.mjs` auto-generates skeleton |

---

## 17. Timeline & Milestones

### 17.1 Sequencing (dependencies, not calendar) — v2 redrawn per 6-d + 6-f (matrix §2 is authoritative; ASCII tree now matches)
```
A1 (governance-must-first) ──┬─→ B (sidebar) ──┐
                              ├─→ C (settings) ┤
                              └─→ K1 (publish-screenshots infra) ─┤  (K runs every round alongside B/C/D/E/F/G/H/I)
                                                                 ├─→ D1 (layout) ──→ D2 (AgentChatPanel + streaming hook, MERGED with E) ──→ F (multi-turn) ──┬─→ G1 (backend index) ──→ G2 (frontend index panel) ──┬─→ H (grep/CommandPalette, depends on G1)
                                                                 │                                                                                          │                    │
                                                                 │                                                                                          └─→ I (demo viewer)      │
                                                                 └─→ A2 (governance-can-do-later) + J1 (docs infra) + J2 (docs content) + L (verify script) + M (cadence) ─┘
```
**Key dependency notes (6-d + 6-f fixes):**
- A1 unblocks B/C/D1; A2 (AGENT-MEMORY + ORCHESTRATION-WORKLOG + ui-iterations board) can run in parallel or later.
- D2 MERGED with E (6-f hidden-coupling fix — both rewrite `AgentChatPanel.tsx`; splitting them would cause merge conflicts).
- F depends on D2 (the streaming hook must handle `meta.continuation` events emitted by F's outer loop — 6-f hidden dependency resolved).
- H depends on G1 (symbol search needs the codebase index — 6-f made explicit).
- K1 (publish-screenshots.mjs + denylist) is in A1's parallel branch so screenshots can be uploaded from MS-1 onward; K2 (DASHBOARD UI + moving R27 zip) is in the J1/J2 parallel batch.

### 17.2 Milestones (v2: 5 gates, not 6 — 6-f merged MS-5+MS-6 into one close-out)
| MS | Workstreams done | Owner verdict needed? |
|---|---|---|
| MS-1 | A1 + A2 + B + C (governance + sidebar + settings) | Yes — visual review |
| MS-2 | D1 + D2 + D3 (chat redesign, split per 6-f) | Yes — visual + interaction review (3 sub-verdicts possible) |
| MS-3 | F (multi-turn — D2 already covers streaming) | Yes — live agent behavior review |
| MS-4 | G1 + G2 + H (indexing + grep) | Yes — codebase-awareness review |
| MS-5 | I + J1 + J2 + K1 + K2 + L + M (demo viewer + docs + dashboard uploads + verify script + cadence) | Yes — final R28 close-out |

### 17.3 Estimated effort (qualitative, not calendar)
- MS-1: ~2–4 hours of focused work
- MS-2: ~4–8 hours (largest single workstream)
- MS-3: ~4–8 hours (prompt + runtime + live battery)
- MS-4: ~4–6 hours
- MS-5: ~2–4 hours
- MS-6: ~1–2 hours

Total: ~17–32 hours of focused work, spread across the round. **Quality over speed — no rushing.**

---

## 18. Definition of Done per Workstream

Each workstream is "done" when ALL of:
1. All files in §3.x/§4.x/.../§15.x "Files touched" are edited/created/deleted as specified.
2. `pnpm verify` green (lint + typecheck + test + build + license).
3. Live battery (where applicable) passes — disk assertions, SSE curl cadence, agent-browser screenshots, VLM verification.
4. Screenshot zip uploaded to DASHBOARD repo via `pnpm dashboard:publish-screenshots <round>`.
5. `docs/ui-iterations/round-28.md` updated with the workstream's evidence.
6. `docs/agent/ORCHESTRATION-WORKLOG.md` appended with the workstream's Task ID section.
7. `docs/status.json` refreshed (test count, plan.current, milestones).
8. Commit + push to `main` (via `work/round-28` branch merged after verify green).
9. CI green.
10. ntfy owner ONLY if sandbox wipes — otherwise no ntfy for routine progress (R28 rule).

---

## 19. Appendix A — File Inventory (current state, post-restore)

### 19.1 Backend (`agent-core/src/`)
| File | Lines | Purpose |
|---|---|---|
| `main.ts` | ~50 | Entry; DB open + `ensureDefaultAgent` + Fastify listen + ready line |
| `server.ts` | ~1017 | All REST routes incl. SSE streaming (L963), model CRUD, dialog, search |
| `context.ts` | ~80 | Per-request context (db, agent, session) |
| `dialogs.ts` | ~150 | Async folder picker (PowerShell STA / zenity / kdialog) |
| `approvals.ts` | ~100 | Approval engine (defined, dead code per G1-a; Phase 3 wiring) |
| `agents/runtime.ts` | ~440 | `prepareTurn` (sync) + `runStreamedAgentTurn` (streaming); deps-wiring L185–194 |
| `agents/chat.ts` | ~190 | `streamAiSdkChat` (AI SDK v7 `streamText` → normalized events) |
| `agents/prompts.ts` | ~150 | Cline-grade system prompt builder (WORKSTREAM F adds AGENTIC LOOP) |
| `tools/index.ts` | ~700 | 15-tool registry + `buildProjectTools(root, allowedTools?, toolDeps?)` + `jsonSchema()` wrapping |
| `tools/exec.ts` | ~120 | `run_command` (safe-allowlist, 60s timeout) |
| `tools/git.ts` | ~100 | `git_status` / `git_diff` / `git_log` (read-only, 32KB cap) |
| `tools/todo.ts` | ~80 | `todo_write` (deps-required) |
| `tools/web.ts` | ~200 | `web_fetch` + `web_search` (MediaWiki API) |
| `storage/db.ts` | ~80 | better-sqlite3 + WAL + migration runner |
| `storage/sessions.ts` | ~120 | Session lifecycle (create, append event, complete) |
| `storage/agents.ts` | ~100 | Agent CRUD; `maxTurns` default 40 (→ 80 in F) |
| `storage/projects.ts` | ~80 | Project CRUD + tree walk |
| `storage/providers.ts` | ~60 | Provider seed (openrouter baseUrl = apex) |
| `storage/usage.ts` | ~50 | Usage events (cost_usd) |
| `storage/models.ts` | ~100 | Model metadata + pricing lookup |
| `storage/snapshots.ts` | ~80 | Checkpoint record/restore (BLOB) |
| `storage/migrations/0001_init.sql` … `0005_snapshots.sql` | 5 files | Schema |

### 19.2 Frontend (`src/`)
| File | Lines | Purpose |
|---|---|---|
| `App.tsx` | ~50 | Routes |
| `components/shell/AppShell.tsx` | ~80 | Layout + Sidebar + Outlet |
| `components/shell/Sidebar.tsx` | 633 | **WORKSTREAM B** |
| `pages/SettingsPage.tsx` | 460 | **WORKSTREAM C** (AppearanceTab at L95–181) |
| `components/project-chat/ProjectChatScreen.tsx` | 247 | **WORKSTREAM D** |
| `components/project-chat/AgentChatPanel.tsx` | 1203 | **WORKSTREAM D + E** |
| `components/project-chat/CodeView.tsx` | ~180 | Code panel with syntax highlight |
| `components/project-chat/LeftSidebar.tsx` | ~100 | Explorer wrapper |
| `components/project-chat/panels/ExplorerPanel.tsx` | ~150 | File tree |
| `components/project-chat/panels/TodoPanel.tsx` | ~120 | Todo ring/mission/counter |
| `components/project-chat/TopBar.tsx` | 213 | **ORPHANED — DELETE in D** |
| `components/project-chat/ExperimentalLayout.tsx` | ~100 | Freeform windows (R14, unused?) |
| `lib/api.ts` | ~700 | API client incl. `streamSessionMessage` L638–692 |
| `lib/config-store.ts` | ~80 | `demoData` flag + base URL + token |
| `lib/project-chat-store.ts` | ~80 | UI store (sidebarOpen, chatWidth, etc.) — **WORKSTREAM D adds chatFocusMode** |
| `lib/themes.ts` | ~370 | 5 themes + `deriveThemeStyles` + `getContrastText` (unused in C — fix) |
| `lib/use-theme-styles.ts` | ~37 | `useThemeStyles()` + `syncThemeCssVars` |
| `lib/dashboard-helpers.ts` | ~30 | `withAlpha(color, alpha)` (hex-only) |

### 19.3 Secrets (sandbox, 0600)
| File | Length | Purpose |
|---|---|---|
| `/home/z/.secrets/github-acute-code.pat` | 93c | Fine-grained PAT scoped to `testplay-byte/ACUTE-CODE` |
| `/home/z/.secrets/github-dashboard.pat` | 93c | Fine-grained PAT scoped to `testplay-byte/DASHBOARD` |
| `/home/z/.secrets/openrouter.key` | 73c | OpenRouter API key (`sk-or-v1-…`) |
| `/home/z/.secrets/git-credentials-acute` | 153c | URL-line credential store for ACUTE-CODE pushes |
| `/home/z/.secrets/git-credentials-dashboard` | 152c | URL-line credential store for DASHBOARD pushes |

---

## 20. Appendix B — Command Reference

### 20.1 Setup (once per session) — v2 includes `corepack enable` (6-f fix: pnpm not installed post-wipe)
```bash
# pnpm not installed post-wipe — install via corepack first
corepack enable 2>/dev/null || npm install -g pnpm@11.22.0
corepack prepare pnpm@11.22.0 --activate 2>/dev/null || true
which pnpm  # verify it's on PATH (could be /home/z/.local/bin/pnpm or ~/.cache/node/corepack/shims/pnpm)

export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_NOSYSTEM=1
export ACUTE_PROVIDER_OPENROUTER=$(cat /home/z/.secrets/openrouter.key)
cd /home/z/PROJECT/ACUTECODE
pnpm install  # first-time install; ~332 packages, better-sqlite3 native build
```

### 20.2 Verify
```bash
pnpm verify                    # lint + typecheck + test + build + license:audit
pnpm docs:check                # (Workstream J) doc freshness gate
pnpm verify:round 28           # (Workstream L) full battery incl. browser + VLM
```

### 20.3 Dev
```bash
pnpm dev:full                  # sidecar :5178 + vite :5173
# OR manually:
ACUTE_TOKEN=acute-dev-local ACUTE_PORT=5178 ACUTE_DB_PATH=.dev/acute.db node agent-core/dist/main.js &
VITE_ACUTE_BASE_URL=http://127.0.0.1:5178 VITE_ACUTE_TOKEN=acute-dev-local pnpm dev
```

### 20.4 Push
```bash
git add -A
git commit -m "Round 28 WS-X: <summary>"
git push origin main           # per-repo credential helper handles auth
```

### 20.5 Dashboard screenshots
```bash
pnpm dashboard:publish-screenshots 28   # (Workstream K)
```

### 20.6 Sandbox-wipe notification (R28 rule — ntfy only on wipe)
```bash
curl -d "ACUTE-CODE sandbox wiped — re-supply credentials to resume" https://ntfy.sh/TASKISDONE
```

---

## 21. Sub-Agent Review Plan (mandatory before execution)

Per owner directive: *"Make sure that you create the plan and verify it using sub-agents to tell them to review your plan, find the flaws, and various other things."*

Three parallel review sub-agents will be dispatched immediately after this plan is written:

1. **Architecture reviewer** (Explore sub-agent): verify each workstream's file paths exist, line numbers are accurate, dependencies are correctly sequenced, no circular dependencies, no orphaned work.
2. **UX reviewer** (Explore sub-agent): verify the sidebar/settings/chat redesign specs match the owner's exact words, no over-engineering, accessibility considered, mobile-first.
3. **Risk/find-flaws reviewer** (Explore sub-agent): stress-test each workstream's risks, find missing risks, verify mitigations are realistic, check for any workstream that's under-scoped or over-scoped.

Their feedback will be incorporated into a `ROUND-28-MASTER-PLAN-v2.md` (or inline edits to this file) before any execution begins.

---

## 22. Close-out checklist (round 28 done when ALL ✓) — v2 (6-f ntfy ruling + DoD fix)

- [ ] All 13 workstreams (A–M, with D split into D1/D2/D3, A into A1/A2, G into G1/G2, J into J1/J2, K into K1/K2) marked done per §18 Definition of Done
- [ ] `pnpm verify` green
- [ ] `pnpm docs:check` green (after J1 lands)
- [ ] `pnpm verify:round 28` green (after L lands; requires agent-browser + VLM installed — see §14.5 Prerequisites)
- [ ] CI green on the final commit
- [ ] Screenshot zips (UI workstreams B/C/D1/D2/D3/F/G2/H/I) OR `pnpm verify` green screenshot (non-UI workstreams A1/A2/J1/J2/K1/L/M) uploaded to DASHBOARD repo via `pnpm dashboard:publish-screenshots 28`
- [ ] `docs/ui-iterations/round-28.md` complete with evidence
- [ ] `docs/agent/ORCHESTRATION-WORKLOG.md` snapshot appended
- [ ] `docs/status.json` refreshed (test count = 197 actual, plan.current, milestones, publicLinks URL fix)
- [ ] HANDOFF.md §3 + §8 refreshed
- [ ] AGENT-MEMORY.md lessons #37–#40 (or more) appended (incl. #37 sandbox-wipe-2026-08-24, #38 per-repo suffixed secret files, #39 ntfy-on-wipe-only rule, #40 demo zip upload target changed to DASHBOARD repo)
- [ ] Owner verdict: APPROVE / CHANGES / PIVOT
- [ ] **If APPROVE: one ntfy `Round 28 complete — owner approved` to `https://ntfy.sh/TASKISDONE`** (6-f ruling: ntfy is for sandbox-wipe notifications AND a single round close-out notification on owner-APPROVE; NOT for individual MS verdicts or workstream completions). If owner says CHANGES/PIVOT, no ntfy — just iterate.

---

**End of Round 28 Master Plan v2. ~850 lines. Sub-agent review complete (6-d architecture, 6-e UX, 6-f risk/scope — all 3 reports appended to `/home/z/my-project/worklog.md`); 15 critical+high flaws + 15 medium flaws applied. Ready for execution per §17 timeline.**
