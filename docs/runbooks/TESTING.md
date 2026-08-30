<!-- last-reviewed: 2026-08-30 round-54 -->
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

**Current counts (R54, verified 2026-08-30):** `pnpm test` = **1071 tests
in 76 files** (1059 unit + 12 e2e — the e2e split is 8 sidecar + 4
terminal-session). Trajectory: 262 (R42) → 397 (R43) → 471 (R44) → 565
(R45) → 622 (R46) → 683 (R47) → 752 (R48) → 815ish (R49) → 930 (R50) →
978 (R51) → 1035 (R52) → 1058 (R53) → 1071 (R54), same counting basis.
New/changed R54 suites: `ConnectionGate.test.tsx` NEW 5 (the R54 offline
screen: renders the shell error + the sidecar_log_tail log box + the
Copy-diagnostics button + the full-log path; falls back to the %APPDATA%
pointer when no tail is available; Retry drives retryConnection) · `sidecar`
10→13 (the sidecar_log_tail wrapper: resolves path+lines with the requested
count, defaults to 60, null outside Tauri / on shell refusal) · `api` +5
(pickFolderViaBackend: bearer POST to /internal/dialog/folder with a BOUND
fetch (AbortSignal), 501 → unavailable, HTTP/dialog errors surfaced, network
failure reason, and the 2-minute abort → "paste the folder path instead") ·
`sidecar-connection` (the honest-timeout test repinned to the R54 150s
deadline, still asserting connecting at 149s → offline after) · plus `cargo
check` GREEN on x86_64-pc-windows-gnu (user-local mingw) and the LAUNCHER
helpers logic-tested in-sandbox with IS_WIN patched (the owner's exact
registry-only scenario → the reinstall decision; both tauri resource
layouts; the PS `-like` single-backslash pattern; watch-engine success /
failure-tail / rotation / timeout paths). The R54 live battery (L4+L5): dev
stack booted, connection gate pass-through in browser mode, Add-project
Browse on Linux (no zenity → immediate, honest error hint with the
paste-guidance, no eternal spinner), project created by pasting a path —
the owner's exact fallback flow.
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
