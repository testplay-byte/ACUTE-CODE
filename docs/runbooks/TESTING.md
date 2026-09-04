<!-- last-reviewed: 2026-09-04 round-66 -->
# TESTING — the verification ladder

Five layers; each has a defined "when mandatory". Rules here are binding
(`WORKFLOW.md` §4 references them). Promoted from AGENT-MEMORY lessons
(#8–#35) into one place (round-17).

| Layer | What | Runs where | Mandatory when |
|---|---|---|---|
| L1 unit | `agent-core/tests` (AI SDK **mocked**) + frontend suites | `pnpm test` / vitest | every change, with the code |
| L2 verify | lint + typecheck + test + build + license audit | `pnpm verify` | before every commit/push (== CI) |
| L3 sidecar E2E | black-box vs built `agent-core/dist` (boots, auth, seeds, CRUD) | `pnpm test:e2e` (in verify) | automatic (rebuild dist first!) |
| L4 live battery | real provider turn(s), real disk, fresh DB | sandbox, single invocation | anything touching agents, projects, tools, streaming |
| L5 browser verification | real UI against the live stack; screenshots machine-verified | sandbox, single invocation | any UI-affecting round |

**Current counts (R66, verified 2026-09-04 by re-running the suites):**
the root `pnpm test` = **1807 tests in 118 files** (all workspace suites
from the root vite config; agent-core alone = **980/980 in 58 files**,
frontend `src/` alone = **815/815 in 58 files**, root `tests/` e2e = 12).
Trajectory: 262 (R42) → 397 (R43) → 471 (R44) → 565 (R45) → 622 (R46) →
683 (R47) → 752 (R48) → 815ish (R49) → 930 (R50) → 978 (R51) → 1035
(R52) → 1058 (R53) → 1071 (R54–R56, launcher rounds) → 1169 (R58) → 1302
(R59) → 1348 (R60) → 1491 (R61) → 1542 (R62) → 1632 (R63) → 1664 (R64) →
1686 (R65) → 1807 (R66).

**R66 (the live-fire patch):** +121 root over R65's 1686 — the round's
features again carried their own suites (all counts as MEASURED this round,
not remembered): agent-core NEW/EXTENDED `browser-checkpoint` **16**
(detector: cloudflare/captcha/age word-boundary + priority + evidence
trimming; the registry: open→resolve/stop/timeout settles, both frames,
resolve-after-timeout, the 60 s hard-cap rejection, the reset hook, the
emit-throws path; the REST resolve route over a real buildServer — 401
wall, 400 validation, the unknown-id `{ok:false,resolution:"timeout"}`
contract, the live-id resolve) · `browser-tool` 17 → **43** (the six new
actions: click/type/press_key happy paths assert the ONE eval frame + the
JSON.stringify-escaped payloads + the native value setter + input/change
events + requestSubmit + the key trio; no-target/page-miss honest errors;
read_dom outline + source html/css/scripts + in-script caps;
wait_for_verification's full contract incl. the exact
browser-checkpoint frame + fake-clock timeout; the navigate/read ⚠ notes;
the set_viewport `browser-viewport` frame; screenshot now pins that
`relay.session.record` is NOT called — A1) · `vision-plugin` **13**
(fail-closed gates, always-registered with CU+vision OFF, every honest
refusal, the end-to-end separate-mode path + URL download) ·
`migration-0025` **5** (no-seed, seed-from-legacy, OR-IGNORE idempotency,
the lazy read + switch-over, validation) · `migration-0026` **1** (the
allowlist append: web_fetch companions only, curation respected) ·
`debug-analyst` **10** (the transcript renderer's five line kinds, the
60 k head+tail cap, the degenerate slice, the skip rules, the streamed
path — NO tools, ONE user message, deltas accumulate — the sync fallback,
the scrubbed provider failure) · `r58-stop-and-replay` 6 → **10** (the
stream-route SSE frame ORDER debug-start → 2×delta → debug-done → done,
the persisted `debug.report` payload, the analyst's provider dying →
debug-error with the turn's done still terminal, the 502-turn gate) ·
`computer-dispatch` 44 → **52** (find_elements: happy path with the
registered stateId + bounds/total, kind AND-rule, limit clamp, empty-match
refusal, find→click end-to-end, observe-posture runs it, kill-switch
refuses, resolution parity) · `computer-windows-backend` 24 → **30** (the
$maxEl 800→2400 pin + construction pins: the exact $probe list,
non-interactive kinds unprobed, EXACTLY 4 GetCurrentPattern calls inside
the interactive branch, cached-handle reuse) · `computer-use-plugin` 14 →
**15** (the 31-tool list × both postures + find_elements registration) ·
`skills-mcp` **11** (the big-apps/find_elements skill body pin). Frontend
NEW/EXTENDED `ImageAnalysisTab` **11** (mode radios, provider/model save,
the masked key row with the Tauri-first durable store, readiness) ·
`ComputerUseTab` 12 → **8** (vision tests removed; the pointer-card test
added) · `DebugReportCard` **8** (streaming/done/error states, the amber
error line) · `BrowserCheckpointCard` **8** (the waiting card: kind
title, live countdown, BOTH controls, the resolve POSTs, the resolved
states) · `ComputerMiniWindow` 7 → **10** (the 6 s decay: arms on real
control events, hides on silence, session_stop rests, browser frames
never trip it) · `MiniApp` **10** (the single-row layout + honest web
mode) · `Sidebar` **15** (the minimized SETTINGS rail — section icons +
`?tab=` navigation; the normal rail unchanged) · `BrowserPanel` **36**
(the agentViewportSeq natural-mode exit + the poll adoption) · `api.test`
**90** (the debug.report folding cases). The prompt-removal cascade
(prompt-registry, r65-honesty-patch, the golden fixture) was re-pinned to
the R66 reality. **The Windows walk + the native-bridge browser actions
remain construction/test-pinned only** (headless Linux sandbox — web mode
refuses the bridge actions honestly); the owner's live Windows run is the
L4 proof.

**R62 (the owner-feedback round):** +50 root — the sidebar rail pair
(Sidebar.test), the aspect-fit geometry 6 + the fit/zoom/readout 4
(native-browser + BrowserPanel), the footnote-removal 2, the overlay
guard 5 (popover-webview-guard.test — including the boot-crash selector
regression pin), the bridge dispatch 5 (agent-browser-bridge.test), the
panel handler 5 (BrowserPanel native suite), the appearance 7
(SettingsPage.test), the models/providers + picker 13 (2-a/2-b files).
agent-core +14: the browser-tool D8 block 12 (read/eval/screenshot/tabs
+ the result-route + timeout pair), computeCost per-side 1
(models-catalog), the sticky-mock reset. The L4/L5 batteries ran LIVE
this round: a real model turn drove browser_control get_state/read/eval
against the dev stack (the honest web-mode eval refusal verified), and
the readiness probe honestly reported the headless sandbox.

**R64 (the capability round):** +122 root — ChatMarkdown 23 (the block
scanner + every block/inline kind + path pills + mid-stream partials),
the mini window suite + the controller + the sidebar-removal absence
assertions (~35), the delegated-row claim matching + subagent paths, the
context-donut portal/live tests, the config-only picker reworks,
approval-deps 5 + safe-list 8 (agent-core). agent-core +84: the windows
backend 24+11+5+1 (scripts pinned by construction — EnumWindows/OutJson
shapes/diagnostics), the resolver tiers + runningApps payload, the keys
aggregate + slot threading + migration list, the estimator calibration
table. The L5 battery ran LIVE: the app boots with zero console/page
errors through onboarding → dashboard → usage → a fresh session chat,
and mini.html renders its honest web-mode notice.

**R54–R56 (launcher rounds, historical):** the JS suite sat at 1071/76 —
R56's logic tests run in-sandbox against the real `acute_launcher.py`
(not vitest — the launcher ships outside the pnpm workspace): mode
resolution + `ask_launch_mode` persistence + recourse branches +
`main()` dispatch + the self-update re-exec verified as a REAL process
replacement (exec'd stub printed its marker, exit code 42 propagated);
`python3 -m py_compile` clean; ACUTE.bat CRLF-verified. The R56 live
battery (L4): /health 200 · real-key streamed turn answered exactly
`R56-LAUNCH-CHOICE-VERIFIED`.

**R57 (the engine-bundling round):** the JS suite is unchanged at
1071/1071 in 76 files (no product code changed — the fix is in the
PACKAGING: the staged node_modules is now a hoisted npm-style tree of
real directories instead of pnpm's 189-link farm). New verification
surface, all green in-sandbox: (a) staging re-run with
`--config.node-linker=hoisted` verified with BOTH pnpm 11.24 (local)
and the exact CI pnpm 11.22.0 — zero symlinks, `.pnpm` metadata-only,
staged tree 301.5 MB → 124.6 MB; (b) the ZERO-LINKS gate inside
stage-sidecar.mjs (walks the whole staged tree, fails on any
symlink/junction — junctions report as symlinks via lstatSync; it
already caught the yaml-only-setting regression during development);
(c) staged-boot battery from the staged tree alone: `ACUTE_READY
{"port":…}` handshake, `/health` → 200 `{"status":"ok"}`,
`/api/v1/agents` → 200 (auth + SQLite + 20 migrations against a fresh
DB); (d) the release workflow's NEW Windows pre-pack boot gate runs the
real staged node.exe + the same env the Rust shell passes on
windows-latest and fails the release before packing if `ACUTE_READY`
does not arrive (90 s budget) — the gate the R51 round believed it had.
docs:check 147/0 (the sandbox's 3 unreachable-URL WARNs are
raw.githubusercontent 429 rate-limits from THIS sandbox's network, not
dead links; CI's clean network is the authority).

**R57 follow-up (the CI flake, fixed same-round):** the docs-only worklog
commit's CI run (33411797885) exposed a LATENT flake — all 1035 tests
passed, but `ModelsProvidersTab`'s "Slot added." reset
(`setTimeout(() => setMsg(null), 1500)`) fired AFTER happy-dom teardown →
React-DOM's dispatchSetState hit `window is not defined` → vitest failed
the whole suite on the uncaught exception. The bare-timer idiom existed
at 11 call sites (ModelsProvidersTab 3, SubAgentsTab 4, AgentChatPanel 3,
ConnectionGate 1). NEW `src/hooks/use-timeout-clear.ts`
(`useTimeoutClear`) schedules state resets that cancel on unmount and
replace-on-reschedule; all 11 sites now ride it (+3 tests:
fires-after-delay, unmount-cancels — the exact CI failure mode —
reschedule-replaces). **1074/1074 in 77 files.** Production was never
affected (an unmounted setState is a silent no-op in React 18; the
crash only exists in torn-down test environments) — the shipped 0.57.0
installer stands; the fix is CI-reliability.

**R58 (the desktop-polish round):** the JS suites grew to
**1169/1169 in 80 files** (root) + **631/631 in 38 files** (agent-core) —
the round's features carried their own tests (TitleBar 8, stop/continue/
live-preview 40+, settings restructure + reveal 30+, streaming-args 12,
CLI-harness live battery). NEW LAYER: `scripts/battery-r58.mjs` — the
R51 battery pattern (the script supervises its own dedicated sidecar on
:5199 because the sandbox reaps background processes between commands)
runs FIVE live checks against the real engine + a real OpenRouter model:
the owner's exact 3-file task with tool-input frame ORDER assertions,
the stop path (stopped frame + `queued` status + persisted partial),
continue-after-stop, and the key-reveal route. Run it with
`node scripts/battery-r58.mjs` from the repo root (needs
`/home/z/.secrets/openrouter-main.key`). Two battery gotchas it now
documents: projectless sessions have NO tools (create a project first),
and Fastify 400s a JSON content-type with an empty body. For
terminal-driven session testing generally, see
`docs/runbooks/CLI-HARNESS.md` (`scripts/acute.mjs chat:stream`).
`r52-supervision` NEW 14 (exec helpers: background-launch grammar + log-
redirect parsing; the hang fix: pipe-holding grandchild resolves FAST with
a job id — the owner's exact trap, cross-platform via node-spawns-node;
the job flips exited when the grandchild dies; the hard watchdog kills a
silent never-exiting command as [timeout]; live onOutput frames; normal
commands keep the old contract; the Unix `&` detached round-trip incl.
process-group kill — POSIX-only skipIf; a failed launch reports failure,
no phantom job; the job_status/job_stop tools through the REAL toolset;
the /jobs REST routes + 404s; the child turn-registry owner-stop with the
honest parent report; sampleChildWatch stall math) · NEW `r52-plugin-
registry` 8 (plugin grammar/catalog-computed-from-declarations incl. the
TOOL_NAMES seed, allowlist semantics through the registry, external .mjs
loading + EXECUTION, built-in-wins collisions, fail-soft invalid shapes,
the REAL scope matrix via HOME/USERPROFILE override, the settings scope
reader) · `usage` 10→16 (getDetailedUsage aggregation: totals, tools
leaderboard with failures, models, children nested under parents with
isSubagent/parentId/role, subagentCount, dominant model, days zero-fill,
orphans→synthetic group, the HTTP route shape + 400 walls) · NEW
`migration-0021` (settings rows for the supervision knobs) · `stream-
store` 9→14 (watch samples land/carry/restart-clear, failed detail
persists/attempt-clears, MAIN tool-output appends + result strips, orphan
chunks ignored, INNER child tool-output appends + strips) ·
`SubAgentPanel` →+5 (Stop renders + calls stopSessionTurn + stopping
chip + disabled, settled shows none, the WatchLine, the stalled amber
line, the failed detail strip) · `TerminalPanel` →+5 (running job row +
age + Stop → stopBackgroundJob, exited row shows exit code + expandable
outputTail, logTail fallback, zero jobs hides the section, demo mode
never polls) · `WorkingSection` →+4 (LiveOutputTail renders + live
indicator, settled strips it, no output no tail, last-10-lines) ·
`SubAgentsTab` →+3 (the supervision card: ms↔s/min round-trip, dirty-only
PUT, range validation disables Save) · `Composer` 46→48 (the model-flyout
HOVER BRIDGE: row-leave keeps the flyout open through the 220ms grace;
flyout-enter cancels + flyout-leave re-schedules) · NEW `UsageScreen` 4
(hero + stats + leaderboard + model card, drill-down with the nested
"sub-agent · role" badge + deep-link, the range selector refetches, the
empty state).

**R61 (the computer-use + extensibility round): 1491/1491 in 102 files
(was 1348/91; agent-core alone 786/786 in 48 files).** Eleven new suites,
all green: backend `computer-dispatch` **33** (the universal gates —
kill-switch/observe-posture/unknown-tool refusals; the a11y-first matrix
— element press/type/set_value/right_click, staleness, fail-closed
non-editable + double_click/scroll; coordinate actions — frame binding,
the 10s freshness, raster bounds, the Win/Linux frontmost rule; keyboard
targetless refusals; open_application launch/activation postconditions;
stop + held-button release; receipts + the audit journal + monitor
stats; app_ref resolution) against an INJECTED FAKE backend ·
`computer-session` **12** (lifecycle, the enforced kill switch, snapshot
supersession + keep-8 eviction, frame registry + imageToGlobal, the
200-entry ring, the process singleton) · `computer-errors-audit` **15**
(every refusal code's what/why/nothing-sent/recovery shape + the journal
redaction: credential scrub, text/clipboard/value length markers, caps) ·
`computer-use-plugin` **13** (settings gates: default-OFF, no-deps,
declaration-context, exactly the 30 doc-02 names, observe = the 11
read-only subset; output shapes + monitor emission; vision wiring incl.
the OFF/separate cases; the ask-mode consent gate incl. auto-skip +
element-press-never-prompts; the audit trail lands under
`<root>/.acute/computer-use`) — this suite runs the REAL Linux backend on
the headless sandbox (GUI probes fail closed; the SHAPE contracts are
pinned, not live GUI behavior) · `computer-vision` **10** (the
`<id>-vision` slot resolution + primary fallback, chat-completions +
anthropic wire formats, no-key/no-provider/request-failure honest codes,
the main-mode supports_vision gate + catalog prefill) · `skills-mcp`
**10** (skill seed/CRUD/builtin-delete-refused, MCP storage round-trips +
corrupt-JSON fail-soft, the manager: sanitized env, initialize/tools/call
against a LIVE child, missing-executable fail-soft, probe, banner-noise
survival) · frontend `SkillsTab` **11**, `McpTab` **12**,
`ComputerUseTab` **12** (the settings tabs: master switch optimistic
update + posture + readiness result cards + vision modes + the masked
vision-key row + the per-row eye toggle; create/toggle/delete/edit flows,
inline ApiError surfaces), `ComputerPanel` **8** + `ComputerMiniWindow`
**7** (the monitor: status chips, stat cells, the event feed with refusal
codes, STOP semantics, the pop-out, the drag). **LIVE verification of the
platform backends is NOT done** (headless sandbox; Windows/macOS never
run on hardware) — the owner's LIVE-VERIFICATION CHECKLIST in
[`COMPUTER-USE.md`](COMPUTER-USE.md) is the mandatory follow-up.

**R52 live battery (L4+L5, all against the real model):** the owner's
Unix-shaped trap reproduced broken THEN verified fixed (`node … >
server.log 2>&1 &` resolved instantly with a job id pre-fix: silent
"(no output)" + "no background jobs tracked"); the agent called
job_status unprompted right after the launch; the job group-stop via
POST /jobs/:id/stop; a real delegation streaming 15s watch heartbeats
(lastActivity evolving, todos, elapsed); a mid-flight child stop via POST
/sessions/:id/stop → detail "stopped by the owner" → the parent's honest
delegate_task report; agent-browser: the Usage screen on real data (283K
tokens, leaderboard, drill-down with nested sub-agent rows, deep-links),
the Terminal panel's Background-jobs section (live row + UI Stop click →
exited), and the SubAgentPanel (Stop button → "FAILED / stopped by the
owner").

## Hard rules

1. **No live AI calls in tests** (L1/L3 mock the SDK; the only live model is
   exercised in L4/L5 batteries).
2. **Fresh-DB journey gate** (lessons #31/#32): L4 runs on a throwaway
   `ACUTE_DB_PATH` and must cover the *first-user journey* — open → send →
   reply works with zero setup (default agent seeded), not just API CRUD.
3. **Disk is ground truth** for file-mutating turns: assert the file exists
   with the expected content, not just a 200 response (#35).
4. **Outcome-based completion polls, never sleeps**: poll the on-disk file or
   a specific new DOM string (#35). Verify you drove the RIGHT element
   (snapshot refs before acting).
5. **Single-invocation batteries** (#4): boot sidecar (+vite for L5), run
   everything, assert, teardown — background processes die between shell
   invocations; check for orphans after.
6. **CLI template-agent filter** (#27): `GET /agents?includeTemplates=false`
   in batteries; a template has no provider/model and 409s confusingly.
7. Rebuild `agent-core/dist` before L3/e2e after backend changes (e2e runs
   against the built dist).
8. Model on the owner's keys (R43+): free-first — default
   `z-ai/glm-5.2:free` with the OpenRouter fallback chain
   (`models:[model, openrouter/free]`); the dead `stealth/ox-alpha` is
   retired (R43). Free-tier 429 storms are REAL — expect the fallback to
   engage mid-battery and say so in the round report.

## L4 live-battery recipe

```bash
export PATH=/home/z/.local/bin:$PATH
mkdir -p .dev && rm -f .dev/<name>.db
setsid env ACUTE_TOKEN=acute-dev-local ACUTE_PORT=5178 \
  ACUTE_DB_PATH="$PWD/.dev/<name>.db" \
  ACUTE_PROVIDER_OPENROUTER="$(cat /home/z/.secrets/openrouter.key)" \
  node agent-core/dist/main.js > .dev/<name>.log 2>&1 < /dev/null &
# wait for /health; export ACUTE_BASE_URL/ACUTE_TOKEN for scripts/acute.mjs
# ...create project/agent(non-template)/session → POST message →
# ...assert files on disk + event log ordering + usage rows →
pkill -f 'agent-core/dist/main.js'   # teardown, then check for orphans
```

## L5 browser-verification recipe

- Boot sidecar + `pnpm dev` with `.env.development`
  (`VITE_ACUTE_BASE_URL` + `VITE_ACUTE_TOKEN`; **delete the file before any
  verify/commit** — lesson #12). Bypass the first-run gate with
  `localStorage.acute.setupDone=1` (lesson #11).
- Drive the real UI (snapshot refs → fill/click), screenshots at
  1920×1080 **and** a tall viewport into `docs/ui-iterations/assets/round-NN/`.
- Machine-verify each screenshot (VLM) against a checklist; numeric checks
  for centering/overflow; `agent-browser errors` + console must be clean
  (`[role=alert]` empty).
- Streaming turns: completion signal = the on-disk file or the stats row for
  THIS turn (a "tok/s" text poll can match the previous turn's stats — #35).

## CI

`ci.yml` on `main` pushes + PRs: windows-latest, `pnpm verify` +
`cargo check`. ~4–6 min; a client timeout while polling is not a failure —
re-query the run (#8). Heavy Rust builds belong on Actions, never the
owner's machine (ADR-0012).
