<!-- last-reviewed: 2026-09-26 round-129 -->
# CONTEXT MANAGEMENT — the pipeline, the constants, where to edit each stage

**Status:** normative · **Established:** round-129 (the context-steward
round, built on five fresh reference studies —
`docs/research/{opencode,cline,oh-my-pi,kilocode,zcode}/context-management-r129.md`)

This is the map of EVERY stage that decides what enters the model's
context window, in the order data flows through them. The owner's
directive this round: *"we are going to… create our own robust context
window management system, which will manage the context properly on each
and every single one of the stages between the tool calls, sessions,
research, or other tasks… making sure that it is modular so that we can
easily edit any part."* Each stage below names its file, its constants,
and its pins — edit the stage at the source, never by patching a
consumer.

```
tool output ──▶ [S1 persistence budget] ──▶ session event log
                                                    │
              turn loop iteration ◀─────────────────┤ (pure reassembly
                                                    │  every iteration)
   ┌──────────────────────────────────────────────┘
   ├─▶ [S2 replay hygiene]  assembleHistory      — supersede + attachments + window
   ├─▶ [S3 the 90% gate]    planCompaction       — AUTO_COMPACT_RATIO
   ├─▶ [S4 the summary]     runCompaction        — template + Files appendix
   ├─▶ [S5 re-injection]    applyCompaction      — reinjectedPaths reminder
   └─▶ [S6 the output cap]  clampOutputTokens    — window − used − 1000
```

## S1 — The persistence budget (tool outputs at the source)

**File:** `agent-core/src/agents/chat.ts` · `summarizeToolOutput()`
**Constants:** `STICKY_OUTPUT_BUDGET = 60_000` (read_skill /
memory_recall — instructions, not data); the plain head+tail budget
`4_000` chars (2000 head + 2000 tail); the read family's truncation
marker carries the actionable pointer ("re-read with an offset").
**Pins:** `tests/r129-ctx1-replay-hygiene.test.ts` §3.
**Law:** every tool result is bounded BEFORE it is ever persisted — the
event log can never grow a single unbounded row. Sticky tools are the
deliberate exception (loaded instructions must survive the task).

## S2 — The replay hygiene (assembleHistory, pure)

**File:** `agent-core/src/agents/runtime.ts` · `assembleHistory()`
**Constants:** `RECENT_TOOL_RESULTS = 8` (the fidelity window),
`OLD_TOOL_STUB_CHARS = 200`, `MAX_TOOL_BLOCK_CHARS = 48_000`,
`STICKY_STUB_CHARS = 8_000`, `SUPERSEDE_READ_TOOLS` (read_file,
list_dir), `SUPERSEDE_WRITE_TOOLS` (write_file, edit_file,
delete_file), `SUPERSEDED_READ_MARKER`.
**Pins:** `tests/r58-stop-and-replay.test.ts` §3 +
`tests/r129-ctx1-replay-hygiene.test.ts` §1-2.
**Laws:**
- **Supersede-stale-reads (R129-CTX1):** an older read of a path the log
  has since re-read OR written stubs to the honest marker — dead weight
  never re-rides. The newest touch of every path renders full; writes
  never stub; FAILED reads never stub.
- **Old-attachment stripping (R129-CTX1):** attachment BODIES ride only
  the NEWEST attachment-bearing user message (`renderOldAttachmentStubs`
  in chat.ts for the older ones — the file lives in the project, so
  nothing is lost).
- **The R58-c window:** the last 8 tool results full, older stubbed,
  the block bounded at 48K — unchanged since round-58, composing UNDER
  the supersede pass.
- **The R70-b sticky exemption:** read_skill / memory_recall results
  never stub (instructions, not data).

## S3 — The 90% auto-compact gate (the await law)

**File:** `agent-core/src/agents/compaction.ts` · `planCompaction()`
**Constant:** `AUTO_COMPACT_RATIO = 0.9` — the auto line
`floor(available × 0.9)` where
`available = contextWindow − maxOutputTokens − margin(8_000)`.
**Pins:** `tests/r129-ctx2-steward-gates.test.ts` §1 +
`tests/context-compaction.test.ts` (the threshold pins re-pinned to the
auto line).
**Laws:**
- The gate fires BEFORE the provider call the turn loop is about to
  make (`assembleWithCompaction` is awaited inside the loop) — the
  owner's *"auto-start the compression without performing any of the
  next tasks"* is structural, not a UI state.
- The keep-target stays 60% of `available`, so a fresh compaction lands
  at ~60% — a 30-point refill runway before the next auto fire.
- The token count is PROVIDER-ANCHORED when an anchor exists
  (`providerUsageAnchor` — the provider's own reported inputTokens + the
  estimated post-anchor tail; the estimate is the fallback), and the
  decision's typed fields (`tokenCount` / `tokenSource` /
  `estimatedTokens` / `threshold` / `reason`) ride the persisted event.
- The overflow FORCE path (the provider itself rejected the request) and
  the R128-W8 rapid-refill circuit breaker are untouched.
- The round-aligned selection (R128-W8 D3a): the boundary walks back to
  an assistant-round start; no tool exchange is ever split.

## S4 — The summary (the anchored template + the deterministic appendix)

**File:** `agent-core/src/agents/compaction.ts` ·
`SUMMARIZER_SYSTEM_PROMPT` (the template),
`buildFilesAppendix()` (the deterministic half), `runCompaction()` (the
fold).
**Constants:** `FILES_APPENDIX_MAX = 30`; the commands cap 10.
**Pins:** `tests/r129-ctx2-steward-gates.test.ts` §2-3.
**Laws:**
- **The fixed sections** — Objective / Key decisions / Work state
  (Completed · Active · Blocked) / Relevant files / Next move — make the
  summary STATE, not prose (the long-horizon hallucination guard).
- **The exact-string law:** paths, commands, identifiers, and error
  strings survive VERBATIM; a prior summary folds in ("anything you
  drop from it is lost forever"); the transcript wins contradictions.
- **The guaranteed Files section:** when the model's summary omits it,
  the event-log-derived appendix (deduped, order-preserving, capped)
  rides verbatim — a hallucinated path can never displace the log's own
  record.

## S5 — The post-compact re-injection (ZCode D4)

**File:** `agent-core/src/agents/compaction.ts` · `recentReadPaths()`,
`reinjectionNoteMessage()`, `applyCompaction()`, the
`reinjectedPaths` field on `CompactionPayload`.
**Pins:** `tests/r129-ctx2-steward-gates.test.ts` §4.
**Laws:**
- The ≤5 most-recently-read paths of the summarized region persist ON
  THE EVENT (additive — old events lack the field and render exactly as
  before) and every applyCompaction renders the reminder note right
  after the summary: "the files you were most recently reading… re-read
  any of them you still need."
- Works across restarts, forks, and the context meter (the meter reads
  the same fold — the R83 one-truth law).

## S6 — The preflight output cap

**File:** `agent-core/src/agents/runtime.ts` · `clampOutputTokens()`
(used at BOTH chat call sites — the sync runner and the streamed
runner, right after each `usedTokens` computation).
**Law:** `min(modelMax, contextWindow − usedTokens − 1000)`, floored at
1024. The request never RESERVES more output than the window has left —
free chat-completions models hard-400 when prompt + max_tokens exceeds
the window, long before any compaction threshold fires. A healthy
window keeps the model cap verbatim (byte-identical to pre-R129).

## REVERT = CONTEXT REVERT

Reverting messages restores the prior context STRUCTURALLY: assembly is
pure over the event log, the compaction rides an append-only event, and
`revertSession` deleting the events past a seq deletes the compaction
event with them — the original messages resurrect. Pinned end-to-end in
`tests/r129-ctx2-steward-gates.test.ts` §6.

## The meter + the ledger read the SAME seams

The composer's context donut (`GET /sessions/:id/context`) and the
self-feedback ledger's telemetry preamble both read
`resolveTurnBudget` + `providerUsageAnchor` + the same fold — the
surfaces can never tell two different stories (R83's one-truth law,
kept through every stage above).

## Lifetime token totals (reading the usage pages honestly)

`usage_events` rows record per-REQUEST tokens — a multi-step turn
re-sends the assembled history on every outer-loop iteration by
protocol design, so a session's lifetime INPUT total naturally exceeds
any single request's context (the meter's usedTokens is the per-request
truth). The steward's job is to keep that re-sent weight SMALL (S1-S6)
— the totals fall as a side effect.

## Deliberate SKIPs (documented, with reasons — round-129.md §0)

- **Artifact spill files** (opencode/zcode): ACUTE's 4K
  persistence-side budget already bounds every result; the actionable
  re-read pointer covers the recoverability need at a fraction of the
  complexity. Revisit if a tool family starts needing full-body recall.
- **Mechanical prune tier / shake** (omp): supersede + the R58-c window
  + the 90% gate cover the same ground at ACUTE's budget shape.
- **Provider-native compaction** (OpenRouter): the owner's key pool
  spans providers without a native endpoint.
- **The sidecar/shadow projection** (cline): our append-only
  `context.compact` event + pure `applyCompaction` IS the same law.
- **Prompt-cache breakpoint discipline** (C9): the per-turn volatile
  system prompt sections (todos, task hints, environment) are the
  known next candidate — needs a prompts.ts restructuring round; the
  cache hit-rate metric (`cachedInputTokens`) is already read, so the
  win is measurable when it lands.
