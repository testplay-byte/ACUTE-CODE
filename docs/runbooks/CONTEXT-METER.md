<!-- last-reviewed: 2026-09-23 round-131 (R131-T) -->
# CONTEXT METER — estimate vs measured, one budget

**Status:** normative · **Established:** round-83 (the "highly misleading"
metering round) · **Amended:** round-131 Wave T — the TWO-TRUTHS split:
the live measured number is the NEWEST provider request's input+output
(never the turn's cumulative input); the cumulative sum is billing-only
and lives in the usage row. Retired defect: the owner's v0.123.0 device
pass — "even though the context was, like roughly 200K… the actual which
it was showing me on the context window itself was like around 900K… as
soon as the context message session ended, it properly started showing
me the correct, accurate one" (an SDK tool loop re-sends the whole
history every step; the SUMMED per-step usage was masquerading as
"context at last request" mid-turn, and the same inflated anchor fed the
compaction gate).
**Audience:** anyone touching token counts, the context donut, compaction,
usage accounting, or any new metering surface
**Companion specs:** `agent-ctx/research/token-counting-robustness.md` (the
R83 audit — every § below cites it), [ARCHITECTURE](../architecture/ARCHITECTURE.md),
[AGENT-MEMORY](AGENT-MEMORY.md)

## 1. The one rule

Every number shown to the owner carries its BASIS. There are exactly two
kinds:

- **Measured** — the provider reported it (per-SDK-call usage on the
  `message.assistant` stats carriers; the turn's `usage_events` row). The
  donut's "N measured at last request" line, the reply chips, the usage
  screens.
  R131-T: the measured number has TWO jobs and they are NEVER the same
  number —
  · the CONTEXT truth (the live headline `usedTokens`, the `actual`
    block, the compaction gate's `providerUsageAnchor`) is the NEWEST
    provider request's own input+output: the last step of the in-flight
    SDK call, exactly what a follow-up request would re-send;
  · the BILLING truth (the turn's `usage_events` row, its
    `totalInputTokens`, every cost/cache aggregate) is the turn's
    cumulative spend — an SDK tool loop RE-SENDS the whole history every
    internal step, so the real spend sums to N_steps × context.
  The seam: chat.ts's finish frame carries both (`usage` = the last
  step's numbers; the additive `turnUsage` = the call's sum) and the
  runtime persists the context truth on the stats carriers while
  accumulating the billing sum into the usage row. Never let one
  masquerade as the other — the 900K headline was exactly that.
- **Estimated** — our GPT-style BPE approximation (`context.ts
  estimateTokens`, ±15% of cl100k). The donut's ring fill, the breakdown
  slices. Always rendered with a `~` or an "estimated" label, and the wire
  field `usedTokensBasis: "estimated"` says it machine-readably.

Never present one as the other. The pre-R83 donut showed the estimate as
fact while the provider's own number sat unrendered in the same response —
the exact complaint that started R83. The pre-R131 carrier showed the
BILLING sum as the live context — the exact complaint that started R131-T.

## 2. ONE budget (resolveTurnBudget)

`agent-core/src/agents/runtime.ts resolveTurnBudget(db, providerId, model)`:

```
contextWindow    = models.context_window → catalog.contextWindow → 200_000
contextWindowSource = "override" | "catalog" | "default"   ← the provenance
maxOutputTokens  = models.max_output_tokens → catalog.maxOutputTokens → 32_768
margin           = 8_000
available        = contextWindow − maxOutputTokens − margin
```

Who reads it: the turn budgets (sync + streamed), the compaction trigger
(via `ContextBudget`), the context guard, the context-meter route, and the
compact route. **If you add a context-related number, resolve it through
this helper** — a second, divergent budget line is how the pre-R83 donut
(85% danger color) and the compaction trigger (window−41K) disagreed.

Note the honest consequence: catalog models with huge declared output caps
(e.g. glm-5.2:free reserves 230,400 of its 256,000 window) compact early —
that is the truth of a shared input+output window, not a bug.

## 3. The context report (GET /sessions/:id/context)

Additive wire shape (see IMPLEMENTED-API for the full contract):

- `actual: {inputTokens, outputTokens, cachedInputTokens|null, at, model} |
  null` — the provider's own prompt size for the NEWEST provider request
  (R131-T: the LAST STEP of the last SDK call — never the call's
  cumulative input; a multi-step call whose final step reported no
  per-step numbers is UNKNOWN and the scan keeps the last REAL
  measurement), from the newest `message.assistant` stats carrier. Null
  before the first reply. The `at` + `model` ride along so a per-send
  model switch can never silently mix numbers.
- `contextWindowSource` / `maxOutputTokens` / `available` — §2.
- `usedTokensBasis: "estimated" | "provider-anchored"` — "provider-anchored"
  when the R127-W4 anchor exists (the newest provider request's own input
  + the estimated post-anchor tail); "estimated" only before the first
  provider reply. R131-T: the anchored headline is the newest REQUEST's
  truth by construction — the carriers it scans carry the last step's
  numbers, not the turn's cumulative spend.
- `compaction: {throughSeq, droppedMessages, tokensSaved}` — present iff a
  `context.compact` event exists; the messages estimate APPLIES it (the
  model receives summary + tail, not the raw log).
- `sessionTotals.providerCalls` + the `usage` split's main/combined — the
  REAL SDK-call count (migration 0031); `requests` counts TURNS (one usage
  row per turn since R24).
- `cache.hitRate` — null when no row ever reported a cache tier (SUM over
  all-NULLs is NULL in SQLite; the rate computation does NOT COALESCE).
  The display total keeps the COALESCE for old consumers.

## 4. Cache + cost honesty

- `recordUsage` writes `cachedInputTokens: NULL` when NO provider call in
  the turn reported a cache tier (`sawCachedReport` tracking in both turn
  runners). The UI renders "— not reported by this provider", never a
  fabricated 0%.
- Cost: `costKnown` on the usage aggregates (read-time via `lookupPricing`
  — every (provider, model) pair that served the model has both sides
  null). The UI renders "(unpriced)" — $0.00 is a placeholder, not free.
- The compaction summarizer and the debug analyst record their own usage
  rows (origin `compaction` / `debug`, agentId NULL — shared's
  `UsageRecord.agentId` is nullable for exactly these rows). Hidden spend
  is a bug.

## 5. Guard + compaction affordance

- The context guard stops at `budget.available` — model-relative, honest
  numbers in the persisted turn.error. The pre-R83 800K constant fired
  before compaction could on big-window models and pointed at a
  nonexistent command.
- The compaction gate's token anchor is the SAME newest-request truth
  (R131-T): `providerUsageAnchor` reads the newest usage-bearing stats
  carrier, which carries the last step's input — so a 200K-context tool
  turn presents ~200K to the gate, never N_steps × 200K. Pre-R131 the
  summed carrier could fire a premature auto-compaction mid-turn over a
  context that was never actually over budget (pinned in
  context-compaction.test.ts's R131-T block).
- `POST /sessions/:id/compact` forces a compaction NOW (the same
  `assembleWithCompaction` machinery; summarizer failure degrades to the
  hard trim, never a 500). A single-message session declines honestly
  (nothing to summarize — `planCompaction` keeps the final message).
- The meta frames `meta.compaction` / `meta.context_limit` RENDER (the
  stream-store's `liveTurn.note`) and invalidate `["session-context"]` —
  the ring drops right after a compaction instead of lying high.

## 6. When you extend the meter

1. Prefer the provider's number whenever one exists; label the estimate.
2. Thread it through `resolveTurnBudget` — no parallel constants.
3. Additive wire fields + a `usedTokensBasis`-style label when a number is
   a projection.
4. Write NULL for "not reported/unknown", never 0 — and render the null
   honestly ("—").
5. Migration for new storage dimensions (0031 is the pattern: DEFAULT
   keeps old rows exactly true).
6. Pin every claim in a test: context-report.test.ts's ROUND-83 block,
   r83-budget.test.ts, r83-compact-route.test.ts, and the live battery
   `scripts/battery-r83.mjs` (the real-key oracle).
7. Ask WHICH truth a new number is (R131-T): the newest request's own
   numbers for anything the owner reads as "context used" or anything a
   gate thresholds on; the cumulative sum for anything billing-shaped
   (usage rows, cost, cache hit-rate). The two meet nowhere except this
   doc.
