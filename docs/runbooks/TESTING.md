<!-- last-reviewed: 2026-08-29 round-48 -->
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

**Current counts (R48, verified 2026-08-29):** `pnpm test` = **752 tests in
61 files** (740 unit + 12 e2e — the e2e split is 8 sidecar + 4 terminal-
session, statically countable in `tests/e2e/` and confirmed in the CI run
log, where the root run skips them pre-build and the dedicated e2e step
runs them green). Trajectory: 262 (R42) → 397 (R43) → 471 (R44) → 565
(R45) → 622 (R46) → 683 (R47) → 752 (R48), same counting basis. New/
changed R48 suites (every final number re-verified via `vitest list` at
the tip): `browser-proxy` 33→38 (NEW describe: navigate/viewport/adopt
never rotate the ticket — mint → navigate → proxy with the ORIGINAL bt
→ 200, the exact 401-loop sequence; direction/title non-rotation; TTL
refresh on use unchanged; 4 of 5 stash-verified to FAIL on the pre-fix
backend) · `BrowserPanel` 9→10 (the fetch mock now mirrors REAL rotation
semantics — /browser/session rotates, navigate/viewport don't; recovery
ONCE + loop-PARKS-at-3-per-60s tests) · `approval-flow` 9→11 (no-emit
child still fails fast, retitled; child WITH emit → approval.requested
subagent-event envelope → decision route → command runs + resolved
envelope; denied case) · `orchestrator` 8→16 (code determinism/shape,
status-envelope ⇄ row agreement, abort between iterations + zero provider
calls on pre-aborted signal, delegate_task forwards signal, live per-step
events with no duplicate batch, onStepFinish normalization, children's
prompt omits the SUB-AGENTS section) · `projects-tools` 21→27 (palette
shape/default sequence/explicit-color-wins/POST default + migration 0018
round-robin backfill incl. >8 wrap + custom colors untouched + audit row)
· `Sidebar` 8→9 (collapsed-rail inset ring, same-36px, scrollable) · `App`
2→3 (new primary quick action + explicit no-Sessions-nav assertion) ·
`DashboardScreen` 5→5 (quick-action test rewritten to "Continue in
<project>") · `WorkingSection` 9→17 (live delegate rows render + click
opens, attribution incl. the polled-row fallback, "delegating…" beat) ·
`SubAgentPanel` 6→9 (full transcript render, 1s fake-timer clock, code
chip, turn.error banner, resolved folding, tab-title prefix strip) ·
NEW `stream-store` 9 (SSE-driven status→live map + invalidate, approval
routing with subAgentId, main-agent frame parity, lastActivity summaries)
· NEW `RightSidebar` 4 (Files quick-menu opens the explorer TAB, picker
code badge + code-prefixed tab title) · NEW `FilesExplorerPanel` 8
(tree render, expand/collapse, .md + .ts content, Search fires the
palette, collapse toggle, honest error+Retry on both panes) · NEW
`right-sidebar-store` 5 (openFiles singleton dedupe/activate/re-create,
no collision with single-path file tabs, per-session isolation) · NEW
`dialogs-script` 8 (script structure + fully-mocked win32 routing for the
modern-picker chain). Per-suite deltas sum to exactly **+69 = 752 − 683**
(no baseline drift this round). agent-core total: **460 tests across 27
files**. Counting honesty note carried from R47: CI's root run on
windows-latest shows `717 passed | 35 skipped (752)` — the 35 skips are
the 23 windows-PTY `terminal-sessions` tests + the 12 e2e (skipped
pre-build in the root pass, then run green by the dedicated e2e step:
`11 passed | 1 skipped (12)`); the sandbox runs all 752 green in one
`pnpm test` (dist present).

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
