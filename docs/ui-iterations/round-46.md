<!-- last-reviewed: 2026-08-30 round-53 -->
# Round 46 — Agent intelligence depth + capability completion: context compaction (summarize, don't drop) · relevance-ranked memory · provider-call timeout · checkpoint restore UI (the round-25 orphan closed) · browser cookie persistence · terminal-session e2e

**Date:** 2026-08-28 · **Branch:** `main` · **Owner directive:** *"improving our
acute code… look in the missing things for its agentic coding agent and improve
all and make it highly capable."* Plan: `agent-ctx/R46-plan.md` (sandbox) — the
recon listed what a "highly capable" agent actually lacks: substring-only
memory recall, a silent hard-drop on context overflow, an orphaned restore
backend, no terminal e2e, and cookies lost on every sidecar restart.

**Commits (in order):** `cf0a492` (orchestrator wave: context compaction +
memory v2 + provider-call timeout + version 0.46.0 + CHANGELOG) · `99a3309`
(checkpoint restore UI + the loadDiff race fix) · `c4120e2` (terminal-session
e2e + browser-proxy cookie persistence).

**Sandbox reset, honestly recorded:** a sandbox re-provision rolled BOTH disks
back to R44-era mid-round. Nothing was lost — every R45 commit was already
pushed — the repos were re-cloned at the R45 tips (`6f75087` code /
`e2e4511` docs), the live worklog's R45 entries were restored from the
orchestrator's context, and the R46-c/R46-d sub-agents were re-dispatched and
re-completed. This round file documents the re-run.

## What shipped

### A. Context compaction — summarize the over-budget head instead of silently dropping it (`cf0a492`)

`agent-core/src/agents/compaction.ts` (NEW): when a session's assembled
history overflows the context budget, the over-budget head is **summarized by
the model** into a dense factual briefing (original task, decisions + why,
files/tools + outcomes, errors + fixes, open steps) instead of the legacy
hard trim that dropped oldest pairs behind a generic marker.

- The summary persists as a **`context.compact` session event**
  `{summary, throughSeq, droppedMessages, tokensSaved}` — append-only like
  every event (ADR-0010), so **fork/revert inherit compactions for free**;
  reverting past one resurrects the original messages.
- Assembly is **pure and seq-annotated** (`SeqMessage.throughSeq` — tool_results
  blocks carry the last folded tool.use seq); the newest compaction filters
  messages covered by its `throughSeq` and prepends the summary.
- Compaction fires only when the budget still overflows **after** applying the
  newest existing compaction — a compacted session never re-summarizes per
  outer-loop iteration; a round-2 compaction folds the old summary + newer
  messages into a fresh one.
- The summarizer runs on the same provider/model with **no tools, maxTurns 1,
  temperature 0**; ANY failure (throw or empty text) degrades to the legacy
  hard trim — compaction is a quality upgrade, never a new failure mode.
- Wired into **BOTH outer loops** (sync sub-agent path + streamed main path);
  the streamed path emits a **`meta.compaction` SSE event** so the UI can
  surface it. 14 tests (`context-compaction.test.ts`): seq annotations,
  findLatest/applyCompaction, planCompaction (60% keep-window,
  never-keep-nothing), end-to-end fake-ChatFn (one call, no tools, event
  appended, within budget, reuse on second assembly, round-2 supersede,
  failure + empty-text fallbacks).

### B. Memory v2 — relevance-ranked recall + ranked digest + dedup-on-save (`cf0a492`)

`agent-core/src/storage/memory.ts` + `tools/memory.ts`:

- **Recall is scored, not substring-scanned**: query tokenization (lowercase
  alphanumeric, stopword-dropped) with content-token overlap ×2 + full-
  substring bonus + kind-match boost (v1 parity) + importance×recency
  tie-break; rows matching nothing score 0 and are dropped. Multi-token
  queries now rank by relevance, not insertion order.
- **The system-prompt digest is ranked** (importance weight by kind:
  decision 1.0 > fact 0.8 > preference 0.7 > note 0.5, × recency decay
  7d/30d/90d buckets) instead of pure newest-first.
- **Dedup on save** (`saveMemoryWithDedup`): same project + same trimmed
  content (case-insensitive) bumps `updated_at` + refreshes kind/source
  instead of inserting a twin row; the tool says "refreshed" honestly.
- Live-verified on the dev sidecar through REAL model turns: a turn saved 2
  memories, a duplicate re-save deduped (count stayed 1, `updated_at`
  bumped), recall returned them. Tests 16→21 (multi-token relevance beats
  insertion order, stopword queries, kind boost parity, recency buckets,
  digest ranking, dedup bump, cross-project isolation).

### C. Provider-call timeout — a live-battery find (`cf0a492`)

`agent-core/src/agents/chat.ts`: `aiSdkChat` had NO abortSignal and
`streamAiSdkChat` only had the client-abort signal — a stalled provider
connection hung the turn FOREVER (live battery: a turn stuck 8+ min at
status `running` after the model's last event; the session read as live
forever and the outer loop never returned; the boot's stale-running sweep
cleaned it on restart). Both adapters now wire
**`AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS = 10 min)`** — generous for
slow free-tier multi-step calls, bounded enough to abort into the normal
turn-error path (turn.error + status reset + retryable 502); the streamed
path combines it with the caller's signal via `AbortSignal.any`. +1 test
(`chat-format.test.ts`: generateText receives a bounded abortSignal; a 1 ms
override aborts).

### D. Checkpoint restore UI — the round-25 orphan closed (`99a3309`)

The `POST /checkpoints/:id/restore` backend + `restoreSnapshot()` had existed
since round 25 with **no api fn and no button** — users could not restore
agent-mutated files from the UI (lesson #64 pattern; now lesson #65). The
diff view (WorkingSection DiffDetail) gains:

- `restoreCheckpoint(id)` in `src/lib/api.ts` (bodyless POST via the standard
  `request()` helper).
- A **Restore pill** with two-step confirm (danger-bordered "Confirm
  restore?" + Cancel — never single-click destructive) → disabled
  "Restoring…" + spinner → green "Restored" + an honest note ("the diff
  above is the recorded history; the stored snapshot is unchanged") →
  `pushLocalToast("File restored", serverMessage)` + `["project-tree"]` /
  `["project-file"]` invalidation. Failure = persistent `task_failed` toast
  + back to idle for retry.
- **Hidden for creates** (`beforeContent === null`): the backend's unlink
  branch would DELETE the file — deliberately not exposed.
- **Pre-existing race fix** found on the way: `loadDiff` resolved against
  `?? []` while the checkpoints query was still loading, baking "no snapshot
  recorded" forever on the first-mounted diff card; now early-returns while
  `checkpointsQuery.isLoading` with the transition in the effect deps. The
  race was proven meaningful (guard removed → 1 failed; restored → green).
- Live-verified in the real UI: Restore → confirm → toast → **the file on
  disk actually reverted** (the appended edit lines disappeared). Tests:
  WorkingSection.test.tsx NEW (9) + api.test.ts +2 (30 total).

### E. Terminal-session e2e + browser cookie persistence (`c4120e2`)

- **`tests/e2e/terminal-sessions.e2e.test.mjs` (NEW, 4 tests; e2e suite
  8→12):** black-box against the built dist on the existing harness (own
  token/db, `ACUTE_READY` port, describe-level self-skip without dist —
  verified both ways). Session create (engine asserted ∈ {pty,pipe} —
  response-based, engine-agnostic) + list + resize 204/400; the SSE happy
  path (leading `: ping`, computed marker `echo r46d_$((6*7))` → output
  frame contains `r46d_42` — un-fakeable by command echo on either engine,
  exit frame code 0, response END, 404s after exit); DELETE-kill (exit frame
  code null); unknown-project 404. The bash-arithmetic test self-skips on
  win32 (cmd.exe has no `$((…))` — same honesty as the unit suite). One
  vitest gotcha found + worked around: test-level `{skip}` overrides
  describe-level skip.
- **Browser cookie persistence (the R43 deferral closed):** browser-proxy is
  a fetch-based URL-rewriting proxy — no engine/profile exists — so this is
  a cookie JAR inside the proxy. `agent-core/src/storage/browser-cookies.ts`
  (NEW): `parseSetCookieHeader` (RFC 6265-lite: Domain/host-only,
  hostile-Domain + public-suffix rejection, default-path, Max-Age>Expires,
  ≤0=delete, 256/4096 size guards) + `CookieJar` (lazy SQLite restore,
  ingest on EVERY redirect hop, Cookie header replayed per hop, full-replace
  persist in a finally, 200/profile cap, every failure SWALLOWED — cookie
  bookkeeping can never 502 a page) + per-profile `CookieJarStore`.
  Migration `0017_browser_cookies` (one row per project_id+name+domain+path +
  audit row). **Session cookies are stored durably BY DESIGN** —
  restart-survival is the point. Security: values never logged/routed/returned
  (no read-back API at all); client Cookie headers can't smuggle
  (test-proven); jars never cross profiles. `server.ts`: exactly one line
  (registerBrowserRoutes gains the db handle). Tests: browser-cookies.test.ts
  NEW (16) + browser-proxy 26→33 (incl. the close/reopen-on-same-db
  restart-survival test).

### F. Version 0.46.0 + CHANGELOG (`cf0a492`)

Version single-sourced at **0.46.0** across all four manifests
(`version.mjs set`); `CHANGELOG.md` `[0.46.0]` section (compaction, ranked
memory, checkpoint-restore UI, cookie persistence, terminal e2e, the
diff-view race fix).

## Verification

- `pnpm lint` / `pnpm typecheck` (root + agent-core) CLEAN (orchestrator's
  full gates).
- **Tests: 622 in 53 files** (`pnpm test`, run by the orchestrator at
  integration; was 565 in 49). The +57 net is fully accounted for:
  context-compaction 14 (NEW) · browser-cookies 16 (NEW) · WorkingSection 9
  (NEW) · terminal-session e2e +4 (NEW file) · memory-tools 16→21 (the old
  newest-first digest test was replaced by ranked-digest tests) ·
  browser-proxy 26→33 · api 28→30 · chat-format 5→6. Split: **610 unit +
  12 e2e** (8 sidecar + 4 terminal — suite counts verified statically for
  this report; the 622 total is the orchestrator's run).
- **CI (GitHub Actions API, not hand-claimed):** run `33219573774` @
  `c4120e2` (the tip) **success** (push event). The R45 runs for reference:
  `33186680334` @ `e2e4511` success · `33184750437` @ `6f75087` success.
- **Live battery on the dev sidecar (real model, real disk):** memory save →
  duplicate re-save DEDUPED (count stayed 1, `updated_at` bumped) → recall
  through REAL model turns · PTY terminal create/input/stream/exit/delete ·
  checkpoint restore round-trip in the real UI (file on disk actually
  reverted) · approval allow-once round-trip. The provider-timeout find came
  out of this battery (a turn stuck 8+ min at status `running`; the boot
  sweep cleaned it; the 10-min AbortSignal.timeout now bounds it).
- **VLM pass (agent-browser + vision): 8/8 screenshots PASS** — chat, diff +
  restore, confirm state, memory panel, terminal Run, terminal Shell,
  terminal shell-output, settled 375px mobile. The first mobile screenshot
  caught a transient load state; re-verified settled → PASS.
- docs:check (this round's docs batch): 0 failures / 0 warnings.

## Known limitations (honest)

- **Frontend projectId wire-up for cookie jars is deferred**: the backend
  accepts an optional `body.projectId` at ticket mint (sticky per session)
  but the frontend doesn't send it yet — all tabs share the `_default`
  profile. Restart-safe today; per-project isolation is a 1-line panel
  wire-up with zero backend change.
- **Compaction adds one provider call per overflow** (the summarizer runs on
  the same provider/model). It never fires on normal sessions, but the
  first overflow costs one extra call; long-session behavior is
  unit-tested, not yet live-validated across a multi-hour session.
- **The first VLM mobile screenshot caught a transient load state** (not a
  defect — the settled re-shot passed); recorded here because the pass is
  reported as 8/8 with that context.
- Cookie jars are jar-level (no per-tab isolation within a profile);
  SameSite/Partitioned are parsed but ignored; the private-net guard is
  still hostname-only (unchanged R43 limits).
- The restore button is hidden for creates (`beforeContent === null`) —
  create-undo would need its own explicit "Delete file" affordance.
- The bundled installer workstream (sidecar.rs production spawn) remains
  deferred by owner verdict (ADR-0003; CHANGELOG `[Unreleased]`).
