<!-- last-reviewed: 2026-09-11 round-87 -->
# Round 83 — Honest Token & Context Metering (the "highly misleading" round)

**Provenance:** the owner's verbatim complaint (the research session's
basis):

> "the context, the token count, and this stuff — they are being highly
> misleading. They are not being handled properly. All of those things need
> to be looked into properly and handled much better, using robust systems."

The spec is `agent-ctx/research/token-counting-robustness.md` (the full
audit: every token/context number inventoried with file:line evidence, the
§2 cause analysis of why each is misleading, the §3 recommended design, the
§4 file-by-file list, the §5 test impact). The normative contract going
forward is **`docs/runbooks/CONTEXT-METER.md`** — estimate vs measured, one
budget, NULL-not-zero. This file records the shipped UI-facing half.

**Everything is unit-tested (root suite 155 files / 2,825 tests: agent-core
1,867 in 92 files — the new r83-budget + r83-compact-route suites + the
context-report ROUND-83 block; frontend 946; e2e 12/12), lint + typechecks
clean, license audit 134 CLEAN, live-battery-verified 5/5 on the real keys
(`scripts/battery-r83.mjs` — `actual=61 tokens measured` end-to-end on a
real OpenRouter turn), and version 0.82.0.**

---

## 1. The donut tells the truth now

The ring still fills with the ESTIMATE (it moves live during a turn — that
is its job), but every number is labeled:

- **`~42% projected`** — the tilde and the word *projected* say estimate.
  The old header presented the estimate as fact.
- **`390k measured at last request`** — the provider's OWN prompt size for
  the last request (`actual` on the wire, from the newest
  `message.assistant` stats carrier; `not yet measured` before the first
  reply — never a fabricated 0). Its tooltip carries the ts; the model rides
  along so a per-send model switch can never silently mix numbers.
- **The budget tick + `compaction line 959k · reserve 32k output`** — the
  SAME line the compaction trigger and the context guard use (ONE budget,
  `resolveTurnBudget`); the pre-R83 donut's 85% danger color and the
  behavioral trigger disagreed on both numerator AND denominator.
- **The window's provenance** — `your override` / `catalog default` /
  `assumed 200k — set it in Settings → Models` (the silent 200K guess can
  never masquerade as a measured window).
- **`Context compacted — 34 messages summarized · ~28k saved`** — the badge
  when a `context.compact` event exists; the messages estimate APPLIES it
  (the model receives the summary + tail, not the raw log — the pre-R83
  meter counted the full log forever).
- **The estimate itself is honest now** — the meter builds the same prompt
  sections a real turn carries (skills, task-modes index, the active mode's
  deep module, background tasks, environment grounding) and MEASURES the
  real JSON tool schemas per effective tool (`measureToolSchemaTokens`,
  in-process cached) instead of the fixed 350-tokens-per-tool guess.

## 2. The session section

- **`Turns` + `Provider calls`** — "requests" counted TURNS since R24 (one
  usage row per turn) while the guard counted SDK calls and the AI SDK
  counted steps: three meanings. Migration 0031's `provider_calls` makes
  the real count visible: a 5-iteration turn is 1 turn · 5 calls.
- **Cache hit rate** — `—` with `not reported by this provider` when no
  call reported a cache tier (the row writes NULL — the shared type's
  documented contract, finally honored at write time); never a fabricated
  0%.
- **Cost** — the usage screens' model rows carry `costKnown`; an unpriced
  model shows `(unpriced)` instead of a silent $0.00 free lunch.

## 3. The affordances that were promised

- **`POST /sessions/:id/compact` EXISTS** — force-compacts the session's
  older context now (the same `assembleWithCompaction` machinery; the
  summarizer's own spend is billed as an origin-`compaction` usage row —
  real spend that previously appeared in NO usage surface). A
  single-message session declines honestly; summarizer failure degrades to
  the hard trim — never a 500.
- **The guard is model-relative** — the pre-R83 hardcoded 800K fired
  before compaction could on big-window models and its error said "run
  /compact" (a command that did not exist). Now: `usedTokens >
  budget.available` with the real numbers in the persisted turn.error.
- **The meta frames render** — `meta.compaction` / `meta.context_limit`
  become live status notes (the R75 overflow-recovery pattern) and
  invalidate the meter; the `done` frame invalidates it too (queue
  continuations and subagent-driven changes refresh the donut).

## 4. The hidden calls are billed

The compaction summarizer (a REAL chat call over the full over-budget
transcript) and the debug analyst (a real call over the whole session
transcript) now record their own `usage_events` rows — `origin:
"compaction" | "debug"`, `agentId: NULL` (shared's `UsageRecord.agentId`
is nullable for exactly these rows; the 0031 table rebuild relaxes the
0001 NOT NULL). Live battery B83-5 verified the rollups carry them.

## 5. Verification

- Root suite 155 files / 2,825 tests (agent-core 92/1,867 — the new
  `r83-budget.test.ts` resolution-order/source/available pins,
  `r83-compact-route.test.ts` contract incl. the origin-compaction usage
  row + the summarizer-failure path; the context-report ROUND-83 block —
  actual null→newest-carrier, compaction-applied estimate, budget trio,
  hitRate-null-when-unreported; r80-silent-stops re-based to the
  available-based guard; sessions/debug-analyst re-based to the honest
  cached-null).
- e2e 12/12 · lint clean (the R82 battery script's 9 pre-existing
  expression-style errors fixed) · typechecks clean · license 134 CLEAN ·
  docs:check 187/0/0 (the new CONTEXT-METER runbook).
- **Live battery 5/5** (`scripts/battery-r83.mjs`, real OpenRouter key):
  B83-2 the honest report on a real turn — `actual=61 tokens measured
  (model z-ai/glm-5.2:free)`, `basis="estimated"`, window 256000
  (`catalog`) − out 230400 = available 17600, turns 1 · providerCalls 1;
  B83-3 the honest cache line; B83-4 the compact route on the live
  sidecar; B83-5 the usage rollups' providerCalls + costKnown.
- The debug detour that mattered: the first battery run failed with 500s
  because the dist build was run WITHOUT the migration-copy step (the
  agent-core `build` script's `cpSync` of `src/storage/migrations` →
  `dist/storage/migrations`) — the fresh sidecar DB then lacked 0031's
  columns. Lesson: always build via `npm run build` in agent-core, never
  bare `tsc --outDir dist`.
