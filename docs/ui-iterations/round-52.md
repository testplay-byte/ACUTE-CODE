<!-- last-reviewed: 2026-08-30 round-52 -->
# Round 52 — Command supervision (background jobs + the hang fix + live terminal output) · sub-agents stoppable & supervised (the shared turn registry + the heartbeat watchdog) · the REAL in-app Usage screen · the plugin-based tool system (ADR-0025) · the model-flyout hover bridge

**Date:** 2026-08-30 · **Branch:** `main` · **Version:** 0.52.0 · **Owner directives:** the fifth Windows test session's feedback — "complete all the remaining things and handle the things properly."

**Every workstream traces to the owner's exact reports:**

- (HUGE) "Ran `taskkill /F /PID 16132` → ✓ SUCCESS. Ran `start /B node server.js > server.log 2>&1` → … running…" — **stuck for 10+ minutes**, the agent never checked, never continued. → workstream A.
- "If the subagent or agents are taking up way too much time then the main agent can take a look at the subagents stats… and take proper steps." → workstream B.
- "After running the commands, it should actually show the terminal interface of those commands too." → workstreams A + C.
- "I should be given options to stop the sub-agents in a similar way too." → workstream B.
- "I requested you to properly handle the Usage screen section 2 but you apparently did not implement the usage properly" (the in-app /usage route was still PlaceholderPage). → workstream C.
- "When I tried to go to the models, it closed the model menu very quickly" (the provider→models flyout gap). → workstream D.
- "I am thinking about going with a plug-in-based system, just like how DeepSeek harness is." → workstream E.

---

## The workstreams

### A — Command supervision: background jobs + the hang fix (exec.ts + lib/background-jobs.ts)

- **Root cause of the 10-minute hang:** `spawn(cmd, {shell: true})` resolves Node's `close` event only when the stdio PIPES close. A `start /B` grandchild INHERITS those pipe handles and holds them for its whole lifetime → `close` never fires → the tool promise never resolves → the turn stalls forever (the 60s spawn timeout killed the shell but not the pipe holders).
- **The new contract in `run_command`:** `exit` and `close` tracked separately. Shell exits + pipes still open past a grace (2.5s; 1s for commands that visibly launch background processes — `start`, `nohup`, trailing `&`) → a **background job** is registered and the call RESOLVES IMMEDIATELY with the exit code, captured output, the job id, and exact `job_status`/`job_stop` polling instructions ("Do NOT run this command again").
- **The hard watchdog:** a shell that never exits within `timeoutMs` (default 60s) gets its process TREE killed (`taskkill /T /F` on Windows) and the call resolves as `[timeout]` with the partial output — the close-never-fires trap can no longer stall a turn, ever.
- **The registry** (`lib/background-jobs.ts`, NEW): pipe watcher keeps tailing the orphaned pipe into an 8KB ring buffer (pipe-open = liveness), `> logFile` parsing for on-demand log tails (2KB served per status call), best-effort stop (tree-kill a live shell pid; pgrep/PowerShell command-line match for the grandchildren; Windows taskkill trees), caps (100 jobs / 12h prune). New tools **`job_status`** (inspect + list) and **`job_stop`** ride the same plugin; REST: `GET /jobs`, `GET /jobs/:id`, `GET /projects/:id/jobs`, `POST /jobs/:id/stop`.
- **The Unix `&` gap (found LIVE in this round's battery):** `node … > server.log 2>&1 &` closes the pipes the instant the shell exits (the grandchild redirected everything to the file) — the old code resolved silently with "(no output)" and NO job: the agent lost track of the process entirely. Fix: background launches spawn `detached: true` (the shell becomes a POSIX process-group leader; the grandchild stays in the group), a clean-exiting `&` launch registers a **detached job** whose liveness is the synchronous group probe `kill(-pid, 0)` (probe-verified: leader dead + member alive → alive; group empty → dead), output comes from the log-file tail, `job_stop` kills the whole group; a NON-zero shell exit (the launch itself failed) reports a normal failure instead of a phantom job. Tests +2 (the detached round-trip incl. group kill; the failed-launch counter-case).
- **Live terminal output** (owner: "show the terminal interface"): `run_command` emits batched (~400ms) `tool-output` SSE frames while the command runs; the stream-store appends them to the in-flight entry and strips them when the result settles; the UI renders a compact live tail (last ~10 lines, stick-to-bottom) under the running command pill — in the chat working section, the expanded command detail, and the sub-agent panel's tool rows.
- **Prompt discipline** (prompts.ts TERMINAL section): launch detached, VERIFY with `job_status` immediately after starting, poll between steps, `job_stop` for cleanup, never re-run the launcher, never block.

### B — Sub-agent supervision + manual stop (turn-registry + orchestrator)

- **The shared turn registry** (`lib/turn-registry.ts`, NEW): the server's private `activeTurns` map moved HERE so the orchestrator can register each running CHILD — `POST /sessions/:id/stop` now aborts a sub-agent exactly like a main turn (the owner's requirement). Stopping a child aborts ONLY that child; the parent keeps running and receives an honest "Sub-agent was STOPPED BY THE OWNER mid-task" report through the delegate_task result. Registration carries a reason (`owner` | `stall`) so the orchestrator can tell the two apart.
- **The child supervisor** (orchestrator.ts): while a child runs, a sampler emits `subagent-status` frames with a `watch` payload every 15s (default, `settings.orchestration.childWatchdogMs`) — `lastActivity` (the last tool call or message kind), `lastEventAgeMs`, `toolCount`, `todosDone/Total`, `elapsedMs`, and the `stalled` flag. A child with no events for 5 minutes (default, `childStallTimeoutMs`) is aborted with reason `stall` and the parent receives "STALLED — no activity for Nm; the supervisor stopped it". Terminal frames carry a human `detail` ("stopped by the owner" / "stalled — …") so the UI shows WHY.
- **The UI** (SubAgentPanel): a **Stop button** on the panel header while the polled detail confirms the child is queued/running (guarded so settled children never flash one), a "stopping" chip while the abort settles; the **WatchLine** (last activity · elapsed · tools · ✓ todos) under the header, amber when stalled ("no activity for Ns — supervisor watching"); the detail strip replaces the bare failed status. The two knobs (heartbeat cadence, stall timeout) are editable in Settings → Sub-agents (a new supervision card, ms↔s/min conversion at the boundary, dirty-only PUTs).

### C — The real Usage screen (/usage was PlaceholderPage)

- **`GET /usage/detailed`** (storage/usage.ts `getDetailedUsage`): a faithful port of export-usage.mjs's aggregation with a documented PRIVATE shape (raw ids/titles/roles — no hashing/redaction: only the public export redacts): per-session token/model rows, tool-use counts (with failures), last-activity math, dominant model, sub-agent counts, per-project rollups + a synthetic unassigned group, global totals/tools/models; `?days=1..90` (default 30) scopes ONLY the zero-filled activity series — totals mirror the owner-approved public page.
- **`UsageScreen.tsx`** (NEW, wizard-DNA): hero + 7/14/30/90 segmented range control; overview StatCards (Tokens/Requests/Sessions+sub-agents/Tool calls); the activity chart (TokenBarChart port with a dynamic day label + scrollable pane so 90 days never breaks 375px); the tool leaderboard (top 8, failures in danger red); model cards (mono id, calls bar, sent/received/cached/cost); the **projects → sessions drill-down** — collapsible project cards, session rows with status/model/duration/tokens/requests/tool-breakdown tooltips, sub-agent children NESTED under their parent with an indented "sub-agent · role" badge (orphans still render; 20 visible + Show-all inside a max-h-96 scroll), click-through deep-links to each chat (sub-agent rows open their PARENT's chat).
- Tests: usage.test.ts +6 (aggregation incl. children-under-parents, route shape, 401/400 walls) + UsageScreen.test.tsx 4 (render, drill-down + nested badge + deep-link, range refetch, empty state).

### D — The model-selector flyout hover bridge (52-a)

The provider row's `onMouseLeave` closed the flyout INSTANTLY — the fixed flyout sits ~18px from the row (popover padding + margin), so crossing the dead zone unmounted it before the pointer arrived. The fix mirrors the R51-c ContextDonut bridge: leave schedules a 220ms close, entering the flyout cancels it, leaving the flyout re-schedules; close/scroll/outside-click clear the timer. The stale "DOM child keeps it open" claim was annotated, not deleted (round-history convention). Tests +2 (grace keeps it open; enter cancels + re-leave re-schedules).

### E — The plugin-based tool system (ADR-0025)

Every built-in tool group moved VERBATIM into `tools/plugins/*.ts` (filesystem, search, git, exec+jobs, web, browser, memory, todo, delegation) behind `tools/registry.ts`'s `PluginDefinition`/`ToolDefinition`; `buildProjectTools` assembles through the registry with IDENTICAL semantics (ADR-0019 allowlist, memory switch, delegation gating); **the catalog is COMPUTED from the declarations** (the R44 TOOL_CATALOG drift, structuralized away). External `.mjs` plugins load from `~/.acute/plugins/` (default) and `<project>/.acute/plugins/` (opt-in `tools.externalPlugins = "off"|"user"|"all"`), with name-grammar validation, caps (32/64), built-in-wins collisions, and fail-soft loading. **The dynamic-import fix (found while gating):** vitest's vite-node runner rewrites `import()` (absolute paths fail) and `new Function("return import()")` dies with "A dynamic import callback was not specified" — the escape hatch is Node ≥22.12 `require(esm)` via `createRequire` (probe-verified under vitest 3.2; CI pins Node 24; the bundled sidecar Node is 24.20). Tests 8 (plugin grammar, catalog coverage incl. the TOOL_NAMES seed, allowlist semantics, external loading + execution, collision-dropping, fail-soft, the REAL scope matrix via HOME/USERPROFILE override).

### Also fixed in the round's live battery

- **CORS `http://[::1]:5173`**: the IPv6 loopback literal origin was missing from the allowlist — every preflight died 401 and the webapp silently fell back to demo data (vite binds ::1 on some hosts).
- The pnpm v10 dep-status check + unapproved-build-scripts error in the sandbox (workaround: invoke `node_modules/.bin` directly; no repo change).

---

## Evidence

- **Gates (re-run at the tip after every fix):** lint clean; typecheck clean (root + agent-core); **full suite 1035/1035 in 73 files** (was 978/69 at R51 — +57, all additive: supervision 14, plugin registry 8, usage 10, UI suites 22, hover bridge 2, detached jobs 2...).
- **Live battery (all against the REAL model via the dev sidecar):**
  1. The owner's exact Unix-shaped trap — `node … > server.log 2>&1 &` → the call resolved in ~1s WITH a job id (the pre-fix run showed the silent "(no output)" + "no background jobs tracked" — the bug reproduced live, then verified fixed).
  2. The agent FOLLOWED the new discipline unprompted: called `job_status` immediately → "j04bc08da RUNNING 13s".
  3. `POST /jobs/:id/stop` → the process group died, the job flipped exited, honest "already exited (code 0)" on the second call.
  4. A REAL delegation: heartbeat watch frames every 15s (lastActivity evolving "waiting for its first model response" → "list_dir path:" → "wrote an assistant message", todosDone/Total, elapsedMs) → completed → the parent summarized the child's report.
  5. A mid-flight child STOP: `POST /sessions/{child}/stop` → `{"ok":true,"stopped":true}` → the child's terminal frame carried `detail: "stopped by the owner"` → the parent's delegate_task result reported the stop honestly.
  6. **In the browser (agent-browser):** the wizard → the Usage screen rendering REAL data (283K tokens, 25 tool calls, the leaderboard, model card, the drill-down with nested sub-agent rows, session deep-links); the Terminal panel's Background-jobs section (live job row + age + Stop button → click → exited + "exit 0"); a UI-driven delegation → the SubAgentPanel with the Stop button + RUNNING + elapsed timer + todo checklist → **clicked Stop → "FAILED / stopped by the owner"** in the panel.
- **CI:** run watched to SUCCESS after the push (see HANDOFF for the run id).

## Honest limitations & what needs the owner's Windows machine

- The pipe-held job path (`start /B …`, the owner's exact case) is unit-tested cross-platform (a node-spawns-node pipe-holder) but the REAL Windows `start /B` shape can only be exercised on the owner's machine — the fix's mechanism (exit+close split, grace, registry) is live-proven on the POSIX equivalents.
- The detached-job liveness probe is POSIX-only by design (Windows has no process groups; the pipe-held path governs there) and returns false on win32.
- Watch frames only render in the UI for turns the UI itself drives (the stream-store consumes the UI's own SSE connection) — curl-driven turns update the DB and the polled views, not the live cards. Expected, unchanged from R48.
- The heartbeat cadence is 15s by default — a sub-agent whose model response takes longer than the STALL timeout (5min) is stopped; the free-model first response observed in the battery took 60s (fine), but a very slow provider could brush against it (the knob exists in Settings → Sub-agents).

## What's next (owner-gated)

- The owner's Windows re-test: the background-jobs flow with a real dev server (`start /B node server.js > server.log 2>&1` → the job id → `job_status` shows the log tail → `job_stop`), the sub-agent Stop button in a real session, the Usage screen on his own DB.
- The v0.52.0 tag ships the FIRST release with the NSIS installer attached (the launcher's desktop flow finally has something to download — the round-51 "no installer published yet" fallback resolves).
- deepseek-harness future candidates (compaction pressure-trigger, continuable sub-agent children), installer signing, Files-tab polish.
