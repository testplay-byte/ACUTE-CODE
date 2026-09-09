# Token & Context Counting Robustness — Audit Spec

**Task:** RESEARCH AGENT C (Task ID 6) — token/context metering audit
**Repo state audited:** ACUTE-CODE @ 6f512aa + 6e9e3d7 (R80 close-out + R80.5 docs), v0.79.0
**Owner's brief:** "the context, the token count, and this stuff — they are being highly misleading. They are not being handled properly. All of those things need to be looked into properly and handled much better, using robust systems."

All identifiers and line numbers below were read first-hand in this audit. Uncertainties are marked **(?)** where a claim depends on runtime behavior I could not execute in the sandbox (no `node_modules` installed, no live provider keys).

---

## §1 — Inventory: every token/context number the system shows or relies on

### 1.1 The estimator core (all "estimate" numbers flow from here)

| # | Number | Where computed | Kind |
|---|--------|----------------|------|
| E1 | `estimateTokens(text)` | `agent-core/src/context.ts:87` — ROUND-64 GPT-style BPE approximation (regex pre-tokenize + calibrated per-segment costs; header claims ±15% of cl100k) | Estimate |
| E2 | `estimateMessageTokens(messages)` | `context.ts:140` — E1 per message **+8 flat per message** for "role/formatting overhead" | Estimate |
| E3 | `assembleWithinBudget()` legacy trim result (`usedTokens`, `droppedCount`) | `context.ts:172-205` — the summarizer-failure fallback path only | Estimate |

### 1.2 The context meter route (the donut's data source)

`GET /api/v1/sessions/:id/context?model=<id>` — `agent-core/src/server.ts:2681-2879` (ROUND-50 R50-c1 + ROUND-51 R51-c).

| # | Number | Where computed | Kind |
|---|--------|----------------|------|
| M1 | `contextWindow` | `server.ts:2828` → `getModelContextWindow(db, providerId, model)` (`runtime.ts:3187-3192`): models-table `context_window` → `getCatalogModel(modelId)?.contextWindow` (storage/models.ts catalog, e.g. 256000/1048576) → **fallback 200_000** | Resolved constant |
| M2 | `breakdown.systemPrompt` | `server.ts:2757` — `estimateTokens(sections.identity)` (or `agent.systemPrompt` for projectless) | Estimate |
| M3 | `breakdown.systemTools` | `server.ts:2758-2759` — `estimateTokens(sections.tools)` + **`TOOL_SCHEMA_TOKENS = 350` × tool count** (server.ts:2756) | Estimate w/ fixed constant |
| M4 | `breakdown.memory` / `breakdown.meta` | `server.ts:2760-2761` — estimates of the digest / (index + custom rules) sections | Estimate |
| M5 | `breakdown.messages` | `server.ts:2762` — `estimateMessageTokens(assembleHistory(db, id))` | Estimate (see §2.3) |
| M6 | `breakdown.mcpTools` | `server.ts:2763` — hardcoded honest `0` ("no MCP system yet") | Honest zero |
| M7 | `usedTokens` | `server.ts:2764` — exact sum M2..M6 | Estimate sum |
| M8 | `cache.inputTokens` / `cachedInputTokens` / `hitRate` | `server.ts:2770-2786, 2838-2845` — SQL `SUM(input_tokens)`, `COALESCE(SUM(cached_input_tokens),0)`, `hitRate = cached/input` (null when input=0) | Provider-reported SUM, blended |
| M9 | `sessionTotals` (input/output/requests/costUsd) | same SQL SUMs; `requests = COUNT(*)` of usage_events rows | Provider-reported SUM / turn count |
| M10 | `usage.main / subagents / combined` | `server.ts:2799-2814` (children SUM via `parent_session_id = ?`) + `sumTotals` | Same as M9 |

### 1.3 Numbers the turn loop RELIES on (behavioral, not displayed)

| # | Number | Where | Kind |
|---|--------|-------|------|
| B1 | `ContextBudget` = `{ contextWindow: getModelContextWindow(...), maxOutputTokens: 32_768 (hardcoded), margin: 8_000 }` | sync `runtime.ts:1608-1612`, streamed `runtime.ts:2289-2293` | Mixed (window resolved; output reserve hardcoded) |
| B2 | Compaction trigger | `compaction.ts:119-121` — `available = contextWindow − 32_768 − 8_000`; fires when **messages-only** estimate (`estimateMessageTokens`, no system prompt, no tool schemas) exceeds it | Estimate |
| B3 | 800K context guard | `runtime.ts:2409, 2424-2431` — `usedTokens = estimateMessageTokens(messages)`; `> 800_000` → `meta.context_limit` + `guardStop CONTEXT_LIMIT`, message says "run /compact or start a new session" | Estimate vs hardcoded constant |
| B4 | 200-request guard | `runtime.ts:2435-2442`, `totalRequests++` per outer-loop SDK call (`runtime.ts:2463`) | Actual count |
| B5 | Overflow recovery | `runtime.ts:1698-1728` (sync) / `2694-2716` (streamed) — classifier class `context_window_exceeded` (error-classification.ts) → `forceCompaction` → one retry per turn | Provider ground truth |

### 1.4 Provider-reported usage (the actuals)

| # | Number | Where | Kind |
|---|--------|-------|------|
| P1 | Per-iteration usage `iterInputTokens/iterOutputTokens/iterCachedInputTokens` | from chat.ts `finish` frames (`runtime.ts:2624-2629`); source = AI SDK `usage.inputTokens/outputTokens/totalTokens` + `inputTokenDetails.cacheReadTokens` (`chat.ts:253-268` sync, `441-551` streaming with per-step/total cross-check `Math.max`) | **Actual (provider)** |
| P2 | Per-turn `totalInput/Output/CachedInputTokens` | accumulated per iteration; **one `recordUsage` row per turn** (`runtime.ts:3132` and 5 other exit paths: abort 1963, loop-guard 2026, error 2087, guard-stop 3001, blank-output 3100) | Actual (summed per turn) |
| P3 | `usage_events` row | `storage/sessions.ts:905-922` — `cachedInputTokens ?? null` (but see §2.6); `keySlot` (migration 0024) | Actual |
| P4 | `costUsd` | `computeCost` (`runtime.ts:3158-3178`) → `lookupPricing` (`storage/models.ts:202-214`) — **models table only, no catalog fallback**; unknown side → that side costs 0 | Computed from possibly-missing pricing |
| P5 | Per-segment stats persisted on `message.assistant` payloads (`usage: {inputTokens, outputTokens}`, `ms`, `model`) | `runtime.ts:2501-2507, 2896-2910` (stats-carrier event for tool-only iterations) | Actual (per SDK call) |
| P6 | SSE `finish` frame `{usage, cachedInputTokens?}` | chat.ts:398-406 → forwarded verbatim by runtime (`runtime.ts:2538-2542`), consumed live by stream-store (`src/lib/stream-store.ts:835-838`) | Actual |
| P7 | Unbilled calls: **compaction summarizer** (`compaction.ts:215-224`, no recordUsage) and **debug analyst** (`agents/debug-analyst.ts`, no recordUsage) | — | Actual but **unrecorded** |

### 1.5 Frontend displays

| # | Display | File | Number shown |
|---|---------|------|--------------|
| F1 | Context donut ring + `% used` + `used / window tokens` | `src/components/project-chat/composer/ContextDonut.tsx:371-374, 542-551` | M7/M1 (estimates); `pct = used/window*100`; thresholds `CONTEXT_DONUT_WARN=0.6`, `CONTEXT_DONUT_DANGER=0.85` (ContextDonut.tsx:20-22) |
| F2 | Breakdown rows (Messages / System prompt / System tools / MCP tools / Memory & skills / Meta & project) | ContextDonut.tsx:560-570 | M2-M6 |
| F3 | Cache hit rate line | ContextDonut.tsx:577-588 | M8; `hitRate===null` → "—" |
| F4 | Session totals (Main / Sub-agents / Combined ↑/↓/requests/$) | ContextDonut.tsx:590-602 | M9/M10 |
| F5 | Reply stats chips (`↑ in ↓ out tok/s model`) | `AgentChatPanel.tsx:256-279` (`ReplyStats`) — from P5 | Actual, per-SDK-call |
| F6 | Sub-agent `↑/↓` tokens | `SubAgentCard.tsx:171-173`, `WorkingSection.tsx:355-357` — live (P6) or `listSubAgents` SUM (sessions.ts:375-379) | Actual, cumulative per child |
| F7 | "Tokens in → out for this turn" chip | `src/components/sessions/ChatView.tsx:380-388` | P5 (per-iteration, labeled "turn") |
| F8 | Dashboard "Tokens" stat + `TokenBarChart` | `DashboardScreen.tsx:38,105`, `TokenBarChart.tsx` — `/usage/summary` (server.ts:4851) | Actual SUM (windowed 14d default) |
| F9 | /usage screen (models/tools/keys/projects drill-down) | `storage/usage.ts:414-656` via `/usage/detailed` (server.ts:4876) | Actual SUMs + P4 cost |
| F10 | Context-window field in Settings → Models | `ModelsProvidersTab.tsx:2576-2582` (owner override → M1 resolution) | Owner constant |
| F11 | Donut refresh triggers | ContextDonut.tsx:360-369 — `queryKey ["session-context", sessionId, model, transcriptLength, liveTick]`, `staleTime 30s`, `refetchInterval 2500ms (CONTEXT_LIVE_REFETCH_MS)` only while `streaming`, `retry: false`; plus `invalidateQueries(["session-context"])` after each send (AgentChatPanel.tsx:2131-2136) and `liveTick` bumps per tool call (AgentChatPanel.tsx:1917-1921) | — |

---

## §2 — Why each number is misleading (cause analysis)

### 2.1 The donut's numerator is an estimate while a real number exists in the same response
`usedTokens` (M7) is the E-estimator's projection of "what the next request would send." The **provider already reports the actual prompt size** of every request (P1/P2/P5) — and the same route returns those SUMs (M9) — but nowhere does the UI ever show "actual tokens in the last request." The user sees one number labeled `X% used`, with no `~` and no "estimated" marker (summaryText ContextDonut.tsx:379-384 says "Context window: 42% used"). The estimate and the actual routinely disagree by more than the estimator's ±15% band because of §2.2-§2.4 below. **Severity: HIGH — this is the single most visible number in the product.**

### 2.2 The system-prompt estimate omits sections the real turn includes
The real turn builds its system prompt in `prepareTurn` (`runtime.ts:1318-1407`) with the FULL `PromptContext`: `environment` (OS/shell/date/git), `maxOuterLoops`, `skills` (R61 index), `taskHints`, `modeHints`, `taskModes` (R73 index), `backgroundTasks` (R79), **`activeTaskMode` (the active mode's deep module body — up to 16K chars ≈ 3-4K tokens)**, `clearedModeNote`, `computerUse`, `debugMode`.
The meter route calls `buildSystemPromptSections` with only `{projectName, rootPath, toolNames, customRules, maxTurns, indexSummary, memoryDigest, permissionMode}` (`server.ts:2722-2741`). Every section the route doesn't pass is simply **absent from the estimate** — the SKILLS lines, TASK-MODES index, ACTIVE TASK MODE deep module, background-delegation reminders, environment grounding (all tagged `ident()`/`meta()` in prompts.ts:488-549, so they would be countable, they're just not fed in). A mode/skills-heavy session under-counts the system prompt by thousands of tokens. The meter labels its "Memory" slice "Memory & skills" (ContextDonut.tsx:569) while **not counting the skills index at all** — the label itself is wrong. **Severity: MEDIUM-HIGH** (systematically low; grows with skills/modes usage).

### 2.3 Tool-schema cost is a fixed 350 tokens/tool
`TOOL_SCHEMA_TOKENS = 350` (server.ts:2756). The registry's real JSON schemas (`tools/plugins/*.ts` `parameters`) range from tiny (todo_write) to large (computer-use/dispatch). The provider bills the full serialized schema set every request. With ~15-20 effective tools the error is easily ±1-3K tokens. **Severity: MEDIUM.**

### 2.4 The estimate ignores compaction — the donut stays wrong after the system compacts
The real turn runs `assembleWithCompaction` (`runtime.ts:1619-1631 / 2384-2397`) — when the history overflows, a `context.compact` event replaces the head with a summary. The meter's `messages` slice is `estimateMessageTokens(assembleHistory(db, id))` (server.ts:2762) — `assembleHistory` (`runtime.ts:678-776`) **skips `context.compact` events** (it only folds message.*/tool.use). After an auto-compaction the model actually receives a short summary + tail, but the donut keeps counting the entire raw log — it stays at its pre-compaction level (and keeps climbing). Compounded: the SSE `meta.compaction` frame (`runtime.ts:2410-2417`, carries `tokensSaved/droppedMessages/throughSeq`) is **never rendered by the frontend** (stream-store handles `meta.overflow_recovery` only — stream-store.ts:1410; no handler for `meta.compaction`/`meta.context_limit`). The user is told nothing, and the number contradicts reality. **Severity: HIGH.**

### 2.5 Two different "used vs limit" definitions disagree
- Donut: `used = system slices + messages (estimate)` ÷ `contextWindow` (full window, no output reserve) → danger at 85%.
- Compaction: `messages-only estimate` vs `available = contextWindow − 32_768 − 8_000` (compaction.ts:119).
So the donut can read 60% while compaction fires (messages alone exceeded window−41K), or read 90% while compaction never fires (system prompt large, messages small). The number the user is shown is **not the number that drives behavior**. **Severity: HIGH.**

### 2.6 The 800K guard pre-empts compaction on large-window models and tells the user to run a command that doesn't exist
Order of operations per iteration (streamed): `assembleWithCompaction` (compacts only if messages > `window − 40_960`) → `usedTokens > 800_000` guard (runtime.ts:2424). For a 1M-window model, messages between 800K and 959K **compact nothing** but **trip the guard** → the turn dies with `CONTEXT_LIMIT` and the message "run /compact or start a new session" (runtime.ts:2428). There is **no `/compact` route, no `/compact` slash command anywhere** (grepped server.ts and src/ — zero hits). The user is instructed to do something impossible. **Severity: HIGH (honest-contract violation).**

### 2.7 Context-window resolution silently defaults to 200K
`getModelContextWindow` (runtime.ts:3187-3192): models-table override → catalog → **200_000**. Any per-send model (composer picker lists provider models-config rows, `ModelSelector.tsx:200-208`) that is neither in the models table with a context_window nor in `FREE_MODEL_CATALOG` silently gets 200K:
- a 1M-context model → donut shows ~5× "fuller" than reality (user thinks they're near the limit when they aren't);
- a 32K-context model → donut shows 3% used while the provider is about to reject the request.
No `source` field is returned; the UI cannot tell an override from a guess. **Severity: HIGH for unknown models, LOW for catalog models.**

### 2.8 `max_output_tokens` is stored and editable but ignored
Migration 0004 + `models.ts:150-154` persist `max_output_tokens`; Settings lets the owner edit it (ModelsProvidersTab.tsx shows it). Both runtime budgets hardcode `maxOutputTokens: 32_768` (runtime.ts:1610/2291). The owner's per-model output-limit edits have **zero effect** on the compaction budget, and the donut never subtracts an output reserve at all — a 90% donut leaves no room for the reply the model must still generate. **Severity: MEDIUM.**

### 2.9 "requests" means three different things
- Context route + /usage screens: `requests = COUNT(*)` of usage_events rows = **turns** (one recordUsage per turn — 6 call sites).
- REQUEST_LIMIT guard: `totalRequests` = **SDK calls** (one per outer-loop iteration; runtime.ts:2463).
- AI SDK internally: one SDK call can run many steps (tool round-trips) — neither counter sees steps.
The popover and usage screens say "requests" while counting turns; a 5-iteration turn records 1 "request." **Severity: MEDIUM (labeling).**

### 2.10 Cache hit-rate: "0%" is fabricated when the provider doesn't report a cache tier
`shared/src/index.ts:107-121` documents `cachedInputTokens` as "Null when the provider didn't report a cached tier," and the schema allows NULL (migration 0020). But the runtime **writes 0, not null** ("recorded as a plain 0 (not null) because at least one call ran" — runtime.ts:2140-2142, `totalCachedInputTokens` initialized to 0 and `?? 0` everywhere). The route then `COALESCE(SUM(cached),0)`s it. Result: on a provider with no cache reporting, `hitRate = 0/positive = 0` → the donut shows a confident **"Cache hit rate 0%"** instead of "not reported." The honest NULL contract exists in the type and schema and is discarded at write time. Also the rate blends ALL turns/models in the session (a lifetime average, not current behavior). **Severity: MEDIUM.**

### 2.11 Cost silently reads $0.00 for unpriced models
`lookupPricing` (models.ts:202-214) consults only the models table (the catalog's prices are NOT a fallback). A paid model added without pricing rows → every turn records `cost_usd = 0` → usage screens show $0.00 with no "unpriced" marker (R62 made sides independent, but "both sides unknown" still silently = free). **Severity: MEDIUM (money truth).**

### 2.12 Hidden provider calls are unbilled
The compaction summarizer (`compaction.ts:215-224` — a real `chat()` call with the full transcript) and the debug analyst (server.ts:3994-4003, `runDebugAnalyst` with `chat/chatStream`) **never call recordUsage**. Their tokens/cost appear nowhere in usage_events, the usage screens, or the public usage.json export. **Severity: MEDIUM.**

### 2.13 Small stuff
- `+8/message` role overhead (context.ts:143) — real per-message overhead varies by provider/format (chat-completions wraps each message in an object; tool-call assistant messages are JSON). ±small.
- The estimate counts the *replay* view (stubbed old tool results — R58 caps at 48K/block) which IS what the model sees — good — but the AI SDK's native multi-step wire format (assistant `tool_calls` objects) differs from the folded user-role `<tool_results>` blocks, so actual vs estimate diverges structurally. **(?)** exact magnitude unverified without a live provider.
- In-memory nudges (TOOL_INTENT_NUDGE / guard nudge, runtime.ts:1633-1644) ride the next iteration's request but are never persisted or estimated — fine (tiny), but the meter cannot see them.
- ChatView's chip says "Tokens in → out **for this turn**" (ChatView.tsx:383) while the number is per-SDK-call (P5, iteration-level). Minor labeling.
- `hitRate` mixes providers if a session's model was switched mid-run (per-send override).
- Donut % shows "0% used" (not an error) if `contextWindow <= 0` (ContextDonut.tsx:548) — currently unreachable due to the 200K fallback, but the path exists and would silently show 0%.

### 2.14 What is already honest (keep)
- Error state: `retry: false` + `summaryText = "Context window usage unavailable"` + danger track (ContextDonut.tsx:379-384, 469) — pinned by Composer.test.tsx:1741 ("a failed context report renders the honest '—' (never a fake 0%)").
- Route 404/409s with `errorBody` codes; never 500s on metering.
- mcpTools = honest 0 with "none configured" note.
- The route header comment (server.ts:2666-2680) openly says "All breakdown numbers are ESTIMATES... the goal is an honest donut, not exact provider accounting" — the intent is documented; the UI just never surfaces that disclaimer.
- Streaming usage cross-check `Math.max(totals, stepSums)` (chat.ts:542-550) and the R80 silent-truncation guard (chat.ts:537-541).

### Summary table (severity-ranked)

| Number | Source | Why misleading | Severity |
|---|---|---|---|
| Donut `usedTokens` / `% used` | M7 (estimator) | estimate presented as fact; actual prompt size available but never shown; misses skills/task-mode sections; ignores compaction; 350/tool schema constant | **HIGH** |
| Compaction trigger vs donut | B2 vs M7 | different numerator (messages-only) AND different denominator (window−41K); the displayed number is not the behavioral one | **HIGH** |
| Donut after compaction | M5 + §2.4 | counts full raw log though model receives the compacted summary; compaction frames never rendered | **HIGH** |
| `contextWindow` for unknown models | M1 | silent 200K default, no source label; 1M/32K models mis-scaled | **HIGH** |
| 800K guard + "run /compact" | B3 | hardcoded model-independent; fires before compaction on big windows; references a nonexistent command | **HIGH** |
| "requests" label | M9 vs B4 | counts turns, not provider calls (3 meanings in the codebase) | MEDIUM |
| Cache hit rate 0% | M8 + §2.10 | 0 written where NULL documented; provider-not-reporting shows as measured 0% | MEDIUM |
| `maxOutputTokens` ignored | B1 | owner's per-model output limit stored+editable, never used; donut has no output reserve | MEDIUM |
| Cost $0.00 unpriced | P4 | models-table-only pricing; no unpriced marker | MEDIUM |
| Unbilled summarizer/debug calls | P7 | real spend absent from usage_events | MEDIUM |
| "for this turn" chip | F7 | per-iteration actual labeled as turn | LOW |
| +8/message, wire-format drift | E2 | approximation noise | LOW |

---

## §3 — Recommended robust design

House style constraints: additive wire shapes (old consumers keep working — the R51 `usage` split precedent), honest labels on every cap/marker, meta frames for transient truth, no silent failure, `errorBody` codes, tests pinning each claim. The design below is the **minimal-yet-robust** cut; option notes mark where a bigger alternative exists.

### 3.1 Ground truth: surface the provider's own number

**Add an `actual` block to the context report (additive):**

```
GET /sessions/:id/context → {
  ...existing fields byte-identical...,
  actual: {                      // NEW (absent/null before the first provider reply)
    inputTokens: number,         // prompt tokens of the LAST provider request
    outputTokens: number,
    cachedInputTokens: number | null,   // null = provider didn't report
    at: string,                  // ISO ts of that request
    model: string                // the model that actually served it
  } | null
}
```

Computed from the **newest `message.assistant` event carrying `usage`** (P5 — the stats-carrier mechanism already persists per-SDK-call usage on the event log; no schema change, no new table). Fallback: the last `usage_events` row is NOT usable for this (turn-level SUM) — the event-log scan is the right source. This is the number OpenAI/Anthropic/OpenRouter themselves bill — the definition of "context used" cannot be more honest than this.

**Donut UI:** primary line becomes "Last request: **42.3k tokens** (measured)"; the projected estimate becomes the secondary line "~45.0k projected now (estimated)". The ring can keep filling by the estimate (it moves live during a turn), with the measured value pinned as a tick/label — both labeled. `aria-label`/`title` follow ("Context window: 41% used — 42.3k measured at last request, of 102.4k window").

### 3.2 Make the estimator honest about what it includes

a) **Feed the meter the same PromptContext the turn gets.** Extract a shared `buildMeterContext(db, session, agent)` (or reuse `prepareTurn`'s resolution pieces) so `buildSystemPromptSections` receives `skills`, `taskModes`, `activeTaskMode`, `environment`, `backgroundTasks`, `maxOuterLoops`, `computerUse` exactly like `runtime.ts:1318-1407`. This mirrors the existing precedent — `effectiveToolNames` is already shared "so the donut reflects the live toolset" (server.ts:2715-2718). The SKILLS/TASK-MODES lines are already tagged `ident()` in prompts.ts (488-549), so they flow into the identity slice with zero prompts.ts changes.

b) **Measure the tool schemas instead of 350/tool.** The registry already holds the JSON schemas; `estimateTokens(JSON.stringify(schema))` per tool at meter time (cache per tool-name in-process if needed). Label stays "System tools (incl. schemas)".

c) **Apply the latest compaction to the meter.** `messages = applyCompaction(assembleHistory(...), findLatestCompaction(events))` — both functions are exported and pure (compaction.ts:62-96). The estimate then matches what the model actually receives. Also surface compaction in the report: `compaction: { compacted: true, throughSeq, droppedMessages, tokensSaved, at } | null` (from the newest `context.compact` event) → the donut popover renders "Context compacted — 34 messages summarized (~28k tokens saved)" and the ring drops after compaction instead of lying high.

d) Keep `usedTokens` as the estimate sum (compat) but add `usedTokensBasis: "estimated"` now and the `actual` block per §3.1 — the wire says which is which.

### 3.3 One budget, computed once, used by both the meter and the loop

New pure helper (suggested home: `agent-core/src/context.ts` or a new `agents/context-report.ts`):

```
resolveTurnBudget(db, providerId, model):
  contextWindow   = getModelContextWindow(...)          // existing resolution
  maxOutputTokens = models.max_output_tokens ?? catalog.maxOutputTokens ?? 32_768   // NEW: honor the owner's column
  margin          = 8_000
  available       = contextWindow - maxOutputTokens - margin
  source          = "override" | "catalog" | "default"  // NEW
```

- Runtime budgets (runtime.ts:1608-1612 / 2289-2293) and the meter route both call it — one number, one truth.
- Report gains `contextWindowSource: "override"|"catalog"|"default"` + `maxOutputTokens` + `available`; the donut draws the **"safe budget" marker** at `available/window` labeled "compaction line" so the danger color (85%) and the behavioral trigger (100% of available) stop contradicting each other.
- Donut popover shows "window: 256k (catalog default)" vs "(your override)" vs "(assumed 200k — unknown model)" — the honest source label.

### 3.4 Fix the 800K guard and the phantom `/compact`

- Guard becomes `usedTokens > available` (the same §3.3 budget) — model-relative, not hardcoded; still a hard stop, still `meta.context_limit` + honest `turn.error`.
- Message text: drop "run /compact"; use the actionable truth — "the turn's context exceeded the model's window (N tokens > M available) — start a new session, or clear older context" (and/or wire a real `POST /sessions/:id/compact` that calls `assembleWithCompaction` with `force: true` — small, reuses everything; **option: ship the route or just fix the message; the message fix is mandatory, the route is nice**).
- Render `meta.compaction` + `meta.context_limit` frames in stream-store (a `liveTurn.note` line — the `meta.overflow_recovery` pattern already exists at stream-store.ts:1410).

### 3.5 Cache + requests + cost honesty

- `recordUsage`: write `cachedInputTokens: null` when **no** call in the turn reported a cache tier (track `sawCachedReport` alongside the accumulator; the shared type already documents null semantics). Route: `hitRate = null` when the SUM is NULL (drop the COALESCE for the rate computation; keep COALESCE only for display totals) → donut shows "—" with a "not reported by this provider" tooltip.
- Rename the popover/usage "requests" to **"turns"** and add the real call count: store `provider_calls` (=`totalRequests`, B4) on the turn's usage row — **migration 0029: `ALTER TABLE usage_events ADD COLUMN provider_calls INTEGER`** (backfill = 1 for old rows; the migration pattern is established — 0024 did the same for key_slot). Usage screens show "turns · N provider calls" honestly.
- Cost: when both pricing sides are unknown, record `cost_usd = 0` but return `costKnown: false` on the usage aggregates (or a sentinel `-1` — prefer the explicit flag, additive) → screens render "$0.00 (unpriced model)" instead of a silent free lunch.
- Meter the hidden calls: `recordUsage` for the compaction summarizer (row: `session_id`, `agentId: null`, `model`) and the debug analyst — **(option: add an `origin TEXT DEFAULT 'turn'` column in the same 0029 migration to label `compaction`/`debug` rows; the /usage screens can then break them out or fold them in, labeled)**.

### 3.6 Refresh triggers (keep + tighten)

- Keep: `liveTick` query-key bumps per tool call; 2.5s poll while streaming; `invalidateQueries(["session-context"])` after send (AgentChatPanel.tsx:2136).
- Add: in stream-store, invalidate `["session-context"]` when the outer `done` frame lands (next to the existing `["usage"]` invalidation at stream-store.ts:1048) — covers queue-continuations and subagent-driven changes that don't pass through the panel's send path.
- On `meta.compaction` / `meta.overflow_recovery` frames → same invalidation (the number must visibly drop right after a compaction).

### 3.7 Never silently 0/NaN

- Keep the pinned error state (Composer.test.tsx:1741). Extend: if `contextWindow <= 0` (currently unreachable) or `contextWindowSource === "default"`, the popover header shows "window assumed 200k — set it in Settings → Models" (a link, not a silent guess).
- `actual: null` before the first provider reply → the popover's "measured" line renders "not yet measured" (never 0).
- If the route 409s (no agent/model configured) the donut already shows the unavailable state — keep.

### 3.8 Data flow after the redesign (end-to-end)

```
provider response (per SDK call)
  → chat.ts finish frame {usage, cachedInputTokens?}          [actual]
  → runtime accumulates per-turn totals; persists per-segment
    usage on message.assistant events (stats carriers)        [actual, event log]
  → recordUsage: one row/turn {input, output, cached|null,
    provider_calls, cost, keySlot, origin}                    [actual, SQL]
  → SSE: finish frames live + meta.compaction/context_limit   [actual + events]

GET /sessions/:id/context
  → contextWindow + maxOutputTokens + available + source     [§3.3, resolved]
  → breakdown: full PromptContext sections (shared with
    prepareTurn), schema-measured tools, compaction-applied
    assembleHistory                                           [§3.2, estimated]
  → usedTokens = Σ breakdown (labeled estimated)              [compat]
  → actual = last message.assistant usage (inputTokens,
    cached|null, ts, model)                                   [§3.1, ground truth]
  → cache/sessionTotals/usage split: SQL SUMs, hitRate null
    when unreported, requests → turns + provider_calls        [§3.5]

ContextDonut
  → ring fills by estimate (live), "measured at last request"
    line + projected line, compaction badge, budget marker,
    window-source badge, cache "—" when unreported            [§3.1-3.7]
  → refetch: liveTick/poll(2.5s while streaming)/invalidate on
    done + meta.compaction                                    [§3.6]

runtime loop
  → budget = resolveTurnBudget(...) (same as meter)           [§3.3]
  → compaction when full estimate (system+messages+schemas) >
    available  — same number the donut marks                  [§2.5 fixed]
  → guard at available (not 800K); honest message; optional
    POST /sessions/:id/compact                                [§3.4]
```

---

## §4 — File-by-file change list

| File | Change |
|---|---|
| `agent-core/src/server.ts` (context route 2681-2879) | full PromptContext for sections (shared builder); schema-measured systemTools; compaction applied to messages + `compaction` field; `actual` block from last stats-carrier event; `contextWindowSource`/`maxOutputTokens`/`available`; hitRate null-safe (no COALESCE for the rate); `requests` stays + doc-comment updated to "turns"; (optional) `POST /sessions/:id/compact` route |
| `agent-core/src/agents/runtime.ts` | budgets at 1608-1612 & 2289-2293 → `resolveTurnBudget`; guard 2424 → `available` + message without "/compact"; record cached=null when unreported (2140-2142 + all recordUsage sites); pass `provider_calls: totalRequests` to recordUsage; recordUsage for debug-analyst + summarizer calls (or at route level) |
| `agent-core/src/context.ts` | add `resolveTurnBudget` (pure, db-injected like getModelContextWindow); no estimator changes needed |
| `agent-core/src/agents/compaction.ts` | nothing functional; optionally accept a deps hook to record the summarizer's usage row |
| `agent-core/src/storage/sessions.ts` (recordUsage 905-922) | pass-through `provider_calls`, `origin`; keep null cached semantics |
| `agent-core/src/storage/migrations/0029_usage_calls_origin.sql` (new) | `provider_calls INTEGER`, `origin TEXT NOT NULL DEFAULT 'turn'` (+ index if the usage screens group by origin) |
| `agent-core/src/storage/usage.ts` | aggregates read the new columns; `costKnown` flag when pricing sides were null; label requests as turns |
| `agent-core/src/agents/chat.ts` | none required (usage capture is already right) — optionally surface `reasoningTokens` if owner wants thinking-token split **(option)** |
| `src/lib/api.ts` (SessionContextReport 319-352) | additive fields: `actual?`, `contextWindowSource?`, `maxOutputTokens?`, `available?`, `compaction?`, `usedTokensBasis?` |
| `src/components/project-chat/composer/ContextDonut.tsx` | measured/projected lines; compaction badge; budget marker; window-source badge; cache "— not reported"; summaryText wording ("~X% projected · Y measured") |
| `src/lib/stream-store.ts` | invalidate `["session-context"]` on `done` (next to :1048) and on `meta.compaction`; render compaction/context_limit as `liveTurn.note` |
| `src/components/sessions/ChatView.tsx:380-388` | label "per model call" instead of "for this turn" |
| `src/components/usage/*` + `src/components/dashboard/*` | "turns · provider calls" relabel; "(unpriced)" cost marker |
| Docs | `docs/architecture/api/IMPLEMENTED-API.md` context-route contract; a runbook section in `docs/runbooks/AGENT-MEMORY.md`-style (or new `CONTEXT-METER.md`) explaining estimate vs measured |

---

## §5 — Test impact (files pinning context/usage behavior)

- `agent-core/tests/context-report.test.ts` — 21 its: SUM exactness, hitRate null-before-input, usage split, window resolution (250-252: override→catalog→200K), `?model=` override, slice semantics, usedTokens = sum, 404/409/auth. **Must extend**: `actual` block (null before first reply; equals last stats-carrier), compaction-applied messages estimate, schema-measured systemTools, source labels. Existing "hitRate is null before any usage row" (line 154) must gain the "null when provider never reports cache" case.
- `agent-core/tests/context-estimator.test.ts` — estimator calibration (±15% band, +8 overhead pin at line 200, budget trim). Unchanged unless estimator changes (none proposed).
- `agent-core/tests/context-compaction.test.ts` — plan/apply/assemble pins. Extend: meter-side application (server route test) once compaction feeds the report.
- `agent-core/tests/usage.test.ts` — SUMs, day buckets, detailed rollups, per-key. Extend: `provider_calls`, `origin`, `costKnown`.
- `agent-core/tests/server.test.ts` — route-registry coverage.
- `agent-core/tests/r80-silent-stops.test.ts:206` — pins `meta.context_limit` emission; **must update** when the guard's threshold/message change.
- `agent-core/tests/r71-tool-reliability.test.ts:601-718` — overflow-recovery once-per-turn pins (unchanged behavior, keep green).
- `src/components/project-chat/composer/Composer.test.tsx:1741` — the honest-error pin ("never a fake 0%"); extend with measured/projected labels + compaction badge.
- `src/lib/api.test.ts`, `src/lib/stream-store.test.ts`, `src/components/usage/UsageScreen.test.tsx`, `src/components/project-chat/WorkingSection.test.tsx` — wire-shape/live-counter pins to extend (done-frame invalidation, new fields).

---

## §6 — Risks & edge cases

1. **Tokenizers unavailable client-side** — tiktoken/js-tiktoken is not a dependency and the sandbox forbids new deps (the ROUND-64 header documents this). Keep ALL estimation server-side (the route already is); the frontend only renders numbers + labels. Do not attempt renderer-side tokenization.
2. **Provider usage missing fields** — some OpenAI-compatible backends omit `usage` entirely on streams; chat.ts already cross-checks `Math.max(totals, stepSums)` and defaults 0. `actual` must therefore carry a "measured at last request" **ts** so a stale/absent value can't maspquerade as current; when the finish frame never arrives (R80 truncation path), the last persisted stats-carrier remains — labeled by its ts. `includeUsage: true` is set only on the openai-compatible branch (chat.ts:151); anthropic-messages/responses map usage natively **(?)** — verify live before relying on `cachedInputTokens` for those formats.
3. **Cache-token semantics differ per provider** — OpenRouter/OpenAI count `cached_tokens` INSIDE `prompt_tokens`; Anthropic reports cache read/creation separately and AI SDK maps `cacheReadTokens` (+ `cacheCreationTokens` separately — do NOT sum creation into the hit rate). Hit rate must be defined as `cacheRead / inputTokens` with a doc comment, null when unreported.
4. **Compaction interplay** — after the fix, the meter applies the newest `context.compact`; but `tokensSaved` (compaction.ts:248-250) is an estimate delta, not provider-measured — keep it labeled "~". Also the summarizer call itself consumes tokens (now metered per §3.5) and can overflow on its own — the existing empty-summary → hard-trim fallback stays.
5. **Estimate/actual drift is a feature, not a bug, once labeled** — the wire format (AI SDK multi-step tool-call JSON) will never match the folded `<tool_results>` estimate exactly; showing BOTH numbers with basis labels makes the drift visible instead of disqualifying. Don't chase exactness in the estimator; chase labeled honesty.
6. **`actual` semantics on model switch** — the last stats-carrier may come from a different per-send model than the donut's `?model=` param. Render the model next to the measured number (field included in the design) so a mismatch is visible, never silently mixed.
7. **Backfill/migration** — old rows have no `provider_calls`/`origin`; default 1/'turn' keeps old data honest-ish, and the "turns" relabel is then exactly true for history. `cached_input_tokens` old zeros stay zeros (pre-0020 rows are NULL — the rate becomes null-honest for them, 0-for-new-rows-until-the-write-fix — acceptable transitional truth, document it).
8. **Usage-row cardinality** — recording summarizer/debug rows with `agentId: null` must not break consumers that assume agent-joined rows (`getDetailedUsage` groups by session — verify `dominantModel`/parent joins tolerate it; they group from usage rows only, no agent join — safe **(?)** spot-check in usage.test).
9. **800K guard removal risk** — `available`-based guard fires earlier on big-window models than 800K never did (no: `available` ≈ window−41K is LARGER than 800K for 1M models → guard fires LATER, but compaction now fires first because the trigger and guard share the budget — the guard becomes the true last resort, which is the intended layering).
10. **Per-send model from a foreign provider** (pre-existing, adjacent): the send route only overrides the model id, not the provider; the context-window lookup then misses (agent's providerId + foreign model) → default 200K. Out of scope here, but the `contextWindowSource: "default"` badge will at least make the wrongness visible.

---

## Appendix — exact identifiers verified (for implementers)

- `scope.get("/sessions/:id/context")` — server.ts:2681; `TOOL_SCHEMA_TOKENS` 2756; slices 2757-2764; totalsRow 2770-2786; subRow 2799-2814; response 2825-2878.
- `getModelContextWindow` — runtime.ts:3187-3192 (`?? getCatalogModel(modelId)?.contextWindow ?? 200_000`).
- Budgets: runtime.ts:1608-1612, 2289-2293 (`maxOutputTokens: 32_768, margin: 8_000`).
- Guard: runtime.ts:2409 (`estimateMessageTokens(messages)`), 2424 (`> 800_000`), 2428 ("run /compact"), 2435 (`totalRequests > 200`), 2463 (`totalRequests++`).
- Overflow recovery: runtime.ts:1561-1572 (state), 1698-1728 (sync), 2694-2716 (streamed); `OVERFLOW_RECOVERY_NOTE` runtime.ts:285.
- Usage accumulation: runtime.ts:1822-1824 (sync `+=`), 2624-2629 (streamed finish), 2884-2886; recordUsage sites: 1963, 2026, 2087, 3001, 3050 (blank-output), 3100, 3132; `computeCost` 3158-3178; `lookupPricing` models.ts:202-214.
- cached-0-not-null comment: runtime.ts:2140-2142; `UsageRecord` shared/src/index.ts:107-121; `recordUsage` sessions.ts:905-922.
- chat.ts usage capture: 253-268 (`aiSdkChat`), 441-551 (`streamAiSdkChat`, cross-check 542-550), finish frame type 398-406, `includeUsage: true` 151.
- compaction: compaction.ts:114-141 (`planCompaction`, available 119), 196-260 (`assembleWithCompaction`, summarizer 215-224, no recordUsage), 57 (`COMPACTION_EVENT_TYPE`).
- assembleHistory skips compaction: runtime.ts:678-776 (event filter 725-772; compaction events unread).
- Meter's reduced PromptContext: server.ts:2722-2741 vs prepareTurn full ctx runtime.ts:1318-1407; SKILLS/TASK-MODES lines tagged `ident()` prompts.ts:488-549; `buildSystemPromptSections` prompts.ts:941.
- Frontend: ContextDonut.tsx:20-22 (WARN/DANGER), 77 (`CONTEXT_LIVE_REFETCH_MS`), 360-369 (query), 371-374 (used/pct), 379-384 (summaryText), 386-389 (hitRate), 560-570 (breakdown rows); AgentChatPanel.tsx:1917-1921 (liveTick), 2131-2136 (invalidations), 256-279 (ReplyStats); stream-store.ts:835-838 (finish counters), 1048 (usage invalidation), 1410 (overflow note); ChatView.tsx:380-388.
- Tests: context-report.test.ts (21 its, resolution pin 250-252, hitRate-null 154), context-estimator.test.ts (200: +8 pin), context-compaction.test.ts, usage.test.ts, r80-silent-stops.test.ts:206, r71-tool-reliability.test.ts:601-718, Composer.test.tsx:1741.

*End of spec.*
