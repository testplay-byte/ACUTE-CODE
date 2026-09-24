<!-- round: post-R123 | task-id: 1 | agent: research subagent (ZCode study) | date: 2026-09-14 -->
# ZCode — Context Compression, Memory, and Conversation Continuation (source-level study)

**Why this document exists.** Owner direction (Task ID 1): study the ZCode repository
(https://github.com/zai-org/ZCode, cloned at `/home/z/repos/zcode`, git @ 29628c9
"feat: update v3.14.3") — a production coding-agent CLI + Electron desktop app — to learn
how it handles the context window, agent memory, and long-running conversation
continuation, and to extract concrete, adaptable designs for ACUTE-CODE. Research only:
no repo code was modified; this file is the deliverable.

**Method.** Full-tree grep for `compact|compaction|summariz|contextWindow|truncat|cache_control`
narrowed to the agent core (the desktop/web/UI layers are out of scope), then first-hand
reads of every compaction/memory/history file. Every claim below is a file:line citation
into the clone at `/home/z/repos/zcode`; quotes are verbatim. ACUTE-CODE side was verified
at HEAD `89ef052` (v0.116.0, R123 landed).

**Path conventions.** `ZC/` = `/home/z/repos/zcode/apps/zcode-cli/packages/core/src`
(the CLI agent core — where everything interesting lives). `SH/` =
`/home/z/repos/zcode/packages/shared/src`. `AD/` =
`/home/z/repos/zcode/apps/zcode-cli/packages/adapters/src`. The repo is bilingual —
load-bearing comments are frequently Chinese; translations are mine.

---

## §A ZCode inventory (what exists, where)

### A.1 The compaction module — `ZC/compact/`

| File | Role |
|---|---|
| `ZC/compact/policy.ts` | Pure auto-compact decision function + all thresholds |
| `ZC/compact/manual.ts` | Token estimator, "enough messages" gate, boundary payload builder |
| `ZC/compact/microcompact.ts` | Local (no-LLM) old-tool-result clearing |
| `ZC/compact/prompt.ts` | The 9-section summary prompt + summary-message formatting |
| `ZC/compact/rounds.ts` | `groupByAssistantStartedRounds` — the "round" grouping primitive |
| `ZC/compact/index.ts` | Public barrel |

Key constants — `ZC/compact/policy.ts:6-14`:

```ts
export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
```

Threshold arithmetic — `policy.ts:67-88`:

```ts
export function getEffectiveContextWindowSize(config = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  // provider 的 context window 是 input + output 共享窗口；自动压缩只能让出输入侧，
  // 因此阈值分母必须先扣掉当前模型允许的 output token…
  const reserve = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  return Math.max(0, contextWindow - reserve);
}
export function getAutoCompactThreshold(config = {}): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const buffer = positiveInt(config.bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS;
  return Math.max(0, effectiveContextWindow - buffer);
}
```

So for a 200K model: effective = 200K − min(32K, 21K) = 179K; threshold = 179K − 13K =
**166K** (83% of the raw window). The decision function `shouldAutoCompact`
(`policy.ts:90-155`) returns a rich `AutoCompactDecision` with an explicit `reason`:
`disabled | not_enough_messages | circuit_breaker | below_threshold | above_threshold`,
plus both estimate- and provider-usage token counts, threshold, and window numbers —
every skip is explainable in logs and telemetry.

Token estimation — `ZC/compact/manual.ts:102-114` (chars/3 via
`ESTIMATED_TOKEN_CHAR_DIVISOR = 3` at `SH/usage-stats.ts:9`, + an important fix:
assistant `toolCalls` JSON is counted separately because it rides outside `content`):

```ts
export function estimateMessageTokens(messages): number {
  return messages.reduce((total, message) => {
    let estimatedCharacterCount = modelMessageContentToTokenEstimateText(message.content).length;
    // assistant toolCalls 独立保存在 content 之外，旧估算只读取 content，
    // 大型工具入参会被完整发给 provider，却在 auto compact 和 preflight 中计为 0。
    for (const toolCall of message.toolCalls ?? []) {
      estimatedCharacterCount += (toolCall.name + stringifyToolCallInputForTokenEstimate(toolCall.input)).length;
    }
    return total + Math.ceil(estimatedCharacterCount / ESTIMATED_TOKEN_CHAR_DIVISOR);
  }, 0);
}
```

Also notable: `modelMessageContentToTokenEstimateText` (`manual.ts:126-138`) uses a
**separate projection** from the visible-text projection because reasoning blocks are
provider-visible volume but not "visible body" — a subtle correctness point ACUTE should
note.

The "context prefix" concept (what is NEVER summarized) — `manual.ts:140-146`:

```ts
function isContextPrefixMessage(message) {
  return (
    message.role === "system" ||
    (message.role === "user" &&
      modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>"))
  );
}
```

### A.2 Microcompact — `ZC/compact/microcompact.ts` (local, no LLM)

`microcompact.ts:12-29`:

```ts
export const MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX = "[Old tool result content cleared]";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;
const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = [
  "Read", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Edit", "Write", "ApplyPatch",
] as const;
```

Default trigger threshold (`microcompact.ts:77-81`) is
`min(autoCompactThreshold × 0.9, autoCompactThreshold − 2_000)` — i.e. microcompact fires
*earlier* than full compaction, clearing old tool-result bodies of read-only-ish tools,
keeping the last 5 result groups, skipping media (image/video/file blocks,
`microcompact.ts:249-256`), skipping errors unless configured, and only applying if it
actually saves ≥ 256 tokens (`microcompact.ts:145-153`). Triggers: idle > 60 min
(`TimeBased`) OR token pressure (`TokenPressure`) — `microcompact.ts:171-195`.
**Disabled by default** (`runtime/methods/microcompact.ts:105-116`: `enabled:
config.microcompact?.enabled === true`).

### A.3 The summary prompt — `ZC/compact/prompt.ts`

Claude-Code-style, ~100 lines, worth reading in full. Structure:
- `NO_TOOLS_PREAMBLE` (`prompt.ts:1-8`): "CRITICAL: Respond with TEXT ONLY. Do NOT call
  any tools… Your entire response must be plain text: an `<analysis>` block followed by a
  `<summary>` block." (The summary call CAN carry tools — see A.5 — but the prompt
  forbids using them.)
- `BASE_COMPACT_PROMPT` (`prompt.ts:14-109`): think-in-`<analysis>` first, then a
  **9-section summary**: 1 Primary Request and Intent · 2 Key Technical Concepts ·
  3 Files and Code Sections ("include full code snippets where applicable") ·
  4 Errors and fixes · 5 Problem Solving · 6 **All user messages** ("List ALL user
  messages that are not tool results… Preserve any security-relevant instructions or
  constraints verbatim so they remain in effect after compaction") · 7 Pending Tasks ·
  8 Current Work · 9 Optional Next Step ("include direct quotes from the most recent
  conversation… verbatim… so there's no drift in task interpretation").
- Custom instructions ride as `Additional Instructions:` (`prompt.ts:111-117`).
- `formatCompactSummary` (`prompt.ts:119-131`) strips the `<analysis>` block and rewrites
  `<summary>…</summary>` → `Summary:\n…`.
- `buildCompactSummaryMessage` (`prompt.ts:133-165`) — how the summary is injected back:

```ts
let message = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${formatCompactSummary(summary)}`;
if (options.transcriptPath) { message += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${options.transcriptPath}`; }
if (options.recentMessagesPreserved) { message += "\n\nRecent messages are preserved verbatim."; }
if (options.replStateCleared) { message += `\n\nYour REPL VM state has been cleared as part of this compaction…`; }
if (options.suppressFollowup) { message += '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary…'; }
```

It is injected as a **user-role message** with `legacySyntheticRuntimeMetadata()`
(`compact-active.ts:531-539`) — the same envelope ACUTE uses.

### A.4 The runtime compaction engine

| File | Role |
|---|---|
| `ZC/runtime/methods/compact.ts` | `executeManualCompact` (/compact), `autoCompactIfNeeded`, `reactiveCompactAfterContextExceeded`, provider-usage token override |
| `ZC/runtime/methods/compact-active.ts` | `compactActiveConversation` — the engine (726 lines) |
| `ZC/runtime/methods/compact-summary-model-request.ts` | The summary model call wrapper (streaming state machine, 430 lines) |
| `ZC/runtime/methods/compact-persistence.ts` | Boundary + timeline event persistence (490 lines) |
| `ZC/runtime/helpers/compact-selection.ts` | What gets summarized vs preserved vs truncated |
| `ZC/runtime/helpers/compact-preservation.ts` | Persisted-tail segment selection |
| `ZC/runtime/helpers/compact-post-reminders.ts` | Post-compact Read-state re-injection |
| `ZC/runtime/helpers/compact-media.ts` | Media strip/projection for the summary request |
| `ZC/runtime/helpers/compact.ts` | Phase/reason mapping + `buildPostCompactRuntimeEntries` |

Three triggers (mapping in `helpers/compact.ts:38-63`):
- **Manual** (`/compact`) → phase `StandaloneTurn`, reason `UserRequested`.
- **Auto** → phase `PreRequest` (checked before the first model call of a turn) or
  `MidTurn` (between model steps), reason `ContextLimit`.
- **Reactive** → phase `Reactive`, reason `ProviderOverflow` — armed only after the
  provider itself rejected the request (`turn-model-step.ts:742-803`).

Where auto-compact sits in the turn loop — `ZC/runtime/methods/turn-loop.ts:67-90`:

```ts
const compactPhase = state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
await this.microcompactIfNeeded(...);
throwIfTurnAborted(state.turnAbortSignal);
const rapidRefill = evaluateRapidRefill(state.compactTracking);
const autoCompactOutcome = await this.autoCompactIfNeeded(...);
if (autoCompactOutcome === "rapid_refill_blocked") { throw createCompactRapidRefillError(...); }
```

i.e. **microcompact → auto-compact → MCP init → reminders → provider request**, every
model step.

Provider-usage anchoring — `methods/compact.ts:313-340` `buildProviderUsageTokenOverride`:
instead of trusting chars/3, it scans **backwards** for the latest committed assistant
message carrying real provider usage and computes `tokenCount = providerBase +
estimate(tail after that message)`; the comment at `:326-328` explains why reverse scan
survives history replacement. `estimateCurrentModelInputTokens` (`:342-350`) is the same
function reused for context metering. This is the exact hybrid ACUTE's R64 estimator
could anchor to.

### A.5 The engine's step-by-step (see §B1) — key quotes

Attempts + tools budget — `compact-active.ts:72-73`:

```ts
const AUTO_COMPACT_MAX_ATTEMPTS = 3;
const COMPACT_TOOL_KEEP_MAX_COUNT = 100;
```

`compact-active.ts:251-257` — massive MCP catalogs degrade the summary call to no-tools:

```ts
// 止血原因：massive MCP 工具会把 compact summary request 的 provider context 撑爆。
// ToolSearch/deferred tools 完成前，仅在工具数超过阈值时让 compact summary 保持无工具。
await this.initializeMcp(turnTraceContext);
const runtimeCompactTools = this.getTools(compactModel);
const compactTools = runtimeCompactTools.length > COMPACT_TOOL_KEEP_MAX_COUNT ? [] : runtimeCompactTools;
```

History replacement + Read-state reset — `compact-active.ts:615-625`:

```ts
this.latestConversationMessageId = summaryMessageId;
this.messageHistory.replaceMessages(
  options.activeEntries
    ? preserveCanonicalContextPrefix(this.messageHistory.borrowReadOnlyRuntimeEntries(), recordablePostCompactEntries)
    : recordablePostCompactEntries,
);
this.readFileState.clear();
```

Selection (what is kept verbatim) — `helpers/compact-selection.ts:30-57` +
`:209-227`: history is split into `prefixEntries` (context prefix — system +
`<system-reminder>` meta user + skills listing, see A.6) and "rounds" (an
assistant-started round = the assistant message + its tool results + trailing user
messages, `compact/rounds.ts:1-35`). For **Auto/Reactive triggers the last 1 round is
preserved verbatim** (`shouldPreserveRecent`, `:225`); manual compact summarizes
everything. `CompactEntrySelection = { entriesForSummary, groupsPreserved, preservedEntries, totalGroups }`.

Prompt-too-long resilience inside the summary call itself (`compact-active.ts:432-481` +
`compact-selection.ts:59-139, 279-335`): on `context_exceeded` (thrown OR returned as
finishReason) the engine (1) **reselects** — moves more recent rounds into the preserved
set, sized by the token gap parsed from the provider error message
(`parsePromptTooLongTokenGap`, `compact-selection.ts:400-410`, regex
`/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i` → `actual − limit`); (2) **truncates** — drops
oldest rounds from the *summary input only* (manual trigger only), inserting the marker
`"[earlier conversation truncated for compaction retry]"` (`manual.ts:56-57`), max 3
retries (`MAX_COMPACT_PROMPT_TOO_LONG_RETRIES`, `manual.ts:55`); (3) media strip retry
(`isModelMediaTooLargeError` → `stripMediaForSummary`, `compact-active.ts:432-444`).

Failure handling — circuit breaker + rapid-refill breaker:
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (`policy.ts:14`, checked at `:136-144`) — 3
  consecutive failed compactions disable auto-compact (`reason: "circuit_breaker"`).
- **Rapid-refill breaker** — `turn-loop-state.ts:21-22`:

```ts
export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
```

`evaluateRapidRefill` (`:154-168`): if a compaction completes but fewer than 3 tool
turns pass before the next compaction would fire, `consecutiveRapidRefills` increments;
at 3 in a row the compaction is BLOCKED and a hard error surfaces
(`turn-loop.ts:91-98`) — the anti-doorknob design that stops "compact → refill → compact
→ refill" death spirals when single tool results are enormous.

### A.6 Message history architecture — `ZC/agent/message-history.ts`

- `RuntimeMessageEntry = RuntimeMessageMessageEntry | RuntimeAttachmentEntry`
  (`:49-66`): either a provider message (role/content/toolCalls/tokens) with
  `RuntimeMessageMetadata { source: SystemReminderSource | "shared_context" | "real_user"
  | "legacy_synthetic" }`, or an **attachment entry** (system-reminder body rendered at
  request time). Metadata + per-assistant `tokens?: TokenUsageInfo` ("已提交 assistant
  自己的 provider tokens；不会发送到 provider") + `queryScope?:
  "output_token_continuation"` (query-local, never persisted) live on the entry, not the
  message.
- `countContextPrefixMessages` (`:269-302`): the stable-prefix detector — system
  messages, `context_prefix`/`skills_listing` attachments, and leading
  `<system-reminder>` user text. `reset()` (`:258-266`) keeps ONLY the prefix. Compaction
  preserves it (`buildPostCompactRuntimeEntries`, `helpers/compact.ts:72-88`).
- `CacheStats { totalMessages, cachedMessages, lastCacheHit, cacheReadTokens? }` (`:68-73`)
  with `setCacheHit/setCacheMiss` (`:245-256`) — per-session cache observability.
- `invalidateRuntimeTokenUsage` (`:426-442`): preserved-tail assistants keep shape but
  zero their token anchors — "Compact 之后 preserved assistant 的 provider usage 仍属于被
  替换的旧前缀" (usage no longer describes the new request's prefix; zeroing prevents the
  provider-usage estimator from anchoring on stale numbers).

Provider projection + prompt caching — `ZC/runtime/helpers/provider-request-messages.ts`:

```ts
// :292-313
function finalizeLatestNonSystemMessageCacheControl(messages, options = {}): number | undefined {
  clearNonSystemMessageCacheControl(messages);
  const latestIndex = findPreviousNonSystemMessageIndex(messages, messages.length - 1);
  if (latestIndex === undefined) return undefined;
  const cacheControlIndex = options.skipCacheWrite === true
      ? findPreviousNonSystemMessageIndex(messages, latestIndex - 1)
      : latestIndex;
  …
  messages[cacheControlIndex] = { ...message, cacheControl: { type: "ephemeral" } };
```

One **Anthropic-style `cache_control: ephemeral` breakpoint on the latest non-system
message** (and one step earlier when `skipCacheWrite`, e.g. for the compact prompt so the
breakpoint doesn't sit on the throwaway query). Plus **attachment bubbling**
(`reorderAttachmentLikeEntries`, `:106-139`): meta attachments are floated *backwards*
past tool results to just before the next real user/assistant boundary so their position
in the prefix is stable — cache-friendliness is the explicit design driver ("State
changes must keep their causal position", `:43-46`). The context builder marks every
section `cacheHint: "stable" | "dynamic"` and orders stable-before-dynamic
(`context/builder.ts:310-325`), emitting up to 3 system messages (cli-prefix / stable
body / dynamic body) each with an ephemeral breakpoint (`builder.ts:230-274`).

### A.7 Conversation continuation across sessions

- **Cold resume** — `ZC/agent/session-history-hydrator.ts:54-199`
  `hydrateMessageHistoryFromSession`: rebuilds `RuntimeMessageEntry[]` from the
  persisted message log; interrupted tools become
  `"[Tool execution was interrupted before resume]"` (`:45`); empty assistants with valid
  token baselines are KEPT as estimation anchors (`:123-130`).
- **Compact-aware branch selection** — `activeSessionMessages` (`:201-256`) + `ZC/agent/
  compact-session.ts:4-27`: on resume, everything before the LAST compaction boundary is
  dropped, then the **preserved segment** (`headMessageId..tailMessageId` recorded in the
  boundary payload) is re-inserted right after the summary anchor message. So the
  "keep last round verbatim" decision is durable across restarts — resume does not
  re-summarize.
- **Preserved-segment durability** — `helpers/compact-preservation.ts:13-45`
  `selectPersistedCompactTail` re-derives the kept DB message ids (respecting
  revert/rewind branches) so the boundary records `preservedSegment:
  { anchorMessageId, headMessageId, tailMessageId }` + `keptMessageCount`.
- **Post-compact Read-state reminders** — `helpers/compact-post-reminders.ts:8-51`:
  after compaction, the 5 most recently Read files (`maxFiles ?? 5`) are re-injected as
  `<system-reminder>` attachments — full content if ≤ 5K tokens each and ≤ 50K total,
  else a pointer line ("Note: {path} was read before the last conversation was
  summarized… Use Read tool if you need to access it"). This directly answers "what was
  in the model's hands when the cut happened".
- **Output-token continuation** — `methods/turn-output-token-continuation.ts:12-23`:

```ts
const OUTPUT_TOKEN_CONTINUE_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
const MAX_OUTPUT_TOKEN_CONTINUATIONS = 3;
```

When `finishReason === "length"` (or raw `max_tokens|max_output_tokens|
model_context_window_exceeded`) and no tool calls, a query-local continuation user entry
is appended and the model step repeats — max 3, then an honest
`OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE` error. The long comment at `:44-55` documents the
subtle contract: an input+output shared-window truncation is a *continuation*, not an
overflow — save partial output first, continue, and only reactive-compact if a real
request failure follows.

### A.8 Memory system — two independent layers

**Layer 1: file-based agent memory (CLI core)** — `ZC/memory/` + `ZC/context/sections/memory.ts`:

- **Storage**: a plain directory of Markdown files, one fact per file, YAML frontmatter
  `name/description/metadata.type (user|feedback|project|reference)`, `[[wiki-links]]`
  between memories, plus a `MEMORY.md` one-line-per-memory index — the format contract is
  the system-prompt section (`context/sections/memory.ts:25-49`, quoted in §B3). An
  `originSessionId` is stamped into frontmatter on every write
  (`memory/origin-session.ts:8-51`).
- **Recall**: only `MEMORY.md` is loaded into context each session — hard-capped at 200
  lines / 25K chars with a warning footer when truncated (`memory/index-content.ts:3-4,
  13-38`). A manifest scanner (`memory/recall/manifest.ts:10-33`) walks the memory dir
  (≤200 files, mtime-desc, 30-line preview for frontmatter `description`/`type`) — used
  to give the extraction agent a dedup checklist, NOT injected wholesale.
- **Write path — the memory extraction subagent**: after each successful turn
  (`runtime/methods/turn.ts:699-704`), `scheduleProjectMemoryExtraction`
  (`runtime/helpers/project-memory-extraction.ts:32-81`) captures an async snapshot of
  durable messages (bounded by the turn's last message id, branch-aware) and hands it to
  a **single-flight, cursor-tracking scheduler** (`memory/extraction.ts:85-179`:
  coalesces overlapping snapshots, advances the `MessageId` cursor only on success/no-op,
  abortable shutdown, 60s drain timeout on session close). The extraction prompt
  (`memory/extraction.ts:42-66`) turns the model into "the memory extraction subagent"
  with a **tool firewall** (`memory/memory-agent-loop.ts:121-163`): only Read/Grep/Glob,
  read-only Bash, and Write/Edit/rm *inside the memory root* — everything else
  (Agent, `mcp__*`, network-side-effect tools) is denied with a reason string that goes
  back into the loop. Max 5 turns (`EXTRACTION_MAX_TURNS`, `project-memory-extraction.
  ts:19`), and the prompt teaches the efficient 2-turn pattern ("turn 1 — issue all Read
  calls in parallel…; turn 2 — issue all Write/Edit calls in parallel").
  Skip gates: no eligible user prose (≥3 words, non-synthetic, `extraction.ts:257-276`)
  or the turn already wrote memory directly (`containsDirectMemoryWrite`, `:228-255`) →
  skip without a model call.

**Layer 2: SQLite-backed project memory (desktop/services layer)** —
`/home/z/repos/zcode/packages/services/src/memory/memoryService.ts` (238 lines): stores
per-workspace memory under `~/.zcode/cli/memories/projects/<workspaceId>/memory/`
(MEMORY.md + topic .md files), with a stable-read handle for concurrent access. The
desktop host feeds `memoryRoot`/`memoryIndexContent` into the CLI core's context builder
config (`ZC/context/types.ts:111-112`).

### A.9 Tool-result budgets (pre-compaction defense)

`ZC/tool/executor/result-serialization.ts:33-40`:

```ts
const DEFAULT_RESULT_BUDGET: ToolResultBudget = {
  maxInlineBytes: 100_000,
  maxModelBytes: 100_000,
  strategy: "truncate",
  preview: { direction: "head" },
};
```

- Per-tool `resultBudget` override (registry), per-tool `maxModelChars` (UTF-16 char
  threshold — some providers count JS chars, `:74-81`).
- Truncation marker carries metadata (`:201`):
  `[Tool output truncated by resultBudget: originalBytes=…, maxModelBytes=…, strategy=truncate]`.
- **Artifact strategy** (`strategy: "artifact"`, `:36` + `:83-98`): oversized results
  spill to a persisted artifact file and the model gets a pointer — the same idea as
  ACUTE's C4 tool-result spill from the DeepSeek study.
- MCP-specific budgets (`ZC/mcp/index.ts:125-145`): 256KB / 64KB / 50KB tiers by MCP
  authority mode.
- Empty output gets a synthetic `(tool completed with no output)` (`:59`) so the model
  never mistakes silence for a missing result.

### A.10 Provider retry — `AD/model/retry-policy.ts:13-30`

```ts
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_FACTOR = 2;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
```

Exponential backoff (2s → ×2 → cap 60s) with jitter, 10 retries, env-overridable
(`ZCODE_MODEL_RETRY_*`), layered under the compaction/reactive paths rather than
competing with them.

---

## §B How each mechanism works, step by step

### B1 Auto-compact (the main path)

1. **Every model step** (turn start AND between tool batches), the loop first runs
   `microcompactIfNeeded` (if enabled) — pure local clearing of old tool results.
2. `evaluateRapidRefill` computes `toolTurnsSinceCompact` (reset to 0 by every successful
   compact; +1 by every completed tool batch, `turn-loop-state.ts:180-186`).
3. `autoCompactIfNeeded` (`methods/compact.ts:184-311`):
   a. Builds the policy config from the model's real `contextWindow` + session
      `config.compact` + resolved `maxOutputTokens`.
   b. Projects the live entries through `buildRuntimeProviderRequestMessages` (the SAME
      projection the real request uses — no estimator drift between shapes).
   c. `buildProviderUsageTokenOverride` — anchor on the last committed assistant's real
      provider usage + locally-estimated tail; fall back to chars/3.
   d. `shouldAutoCompact` → decision with reason.
   e. Rapid-refill breaker check; on block, a hard `CompactRapidRefillError` (fail loud,
      not silently thrash).
4. `compactActiveConversation` (`methods/compact-active.ts:75-140`): wraps the impl in a
   compaction telemetry span (input/output tokens, policy window, threshold, token
   source, trigger, phase).
5. Snapshot `activeEntries` (immutability contract documented at `:180-185`).
6. `selectInitialCompactEntriesForActiveConversation`: split prefix vs rounds; preserve
   last round (Auto/Reactive only); if this was called from an initial-prompt-overflow,
   pre-size the preserved set from the parsed token gap (`compact-selection.ts:103-139`).
7. Gate: `<2 rounds or no assistant → skipped` (healthy no-op with its own timeline
   event, `:217-238` — "Context is up to date; no compression needed").
8. `initializeMcp`; if tool catalog > 100 entries, run the summary call with NO tools.
9. **Attempt loop** (max 3 for Auto, 1 otherwise):
   - Build the summary request: `[...prefixEntries, ...summaryGroups]` + the compact
     prompt as the final user message; project media per model policy (and strip media on
     retry); `maxOutputTokens = min(model max, normal-request cap, 20K)` (`:716-724`).
   - `runCompactSummaryModelRequest` — a full streaming request with its own recovery
     semantics (`preserveProviderStreamBoundaries`, `:399-401`).
   - On `context_exceeded`: reselect (move recent rounds out of the summary input) →
     truncate (manual only) → give up with `CompactPromptTooLongError`. On
     media-too-large: strip and retry.
   - On generic retryable error: retry up to 3 (timeline shows `Retrying`, not `Failed`
     until the last attempt, `:646-654`).
10. `formatCompactSummaryOrThrow` (rejects a tool-call-only response), then build the
    post-compact entry list: `[contextPrefix, summary-user-message, preservedEntries
    (token-invalidated), postCompactReminders]` (`helpers/compact.ts:72-88`).
11. Post-compact reminders: re-inject the Read-state of the 5 most recent files
    (≤5K/50K tokens, else pointers) + the approved plan file reference.
12. Persist: `CompactBoundary` event (full `CompactBoundaryPayload` — trigger, phase,
    reason, pre/post token counts BOTH estimated ("true") and provider-reported,
    `willRetriggerNextTurn`, summarized/kept counts, `preservedSegment` anchor/head/tail,
    customInstructions flag, trace ids) + a `CompactTimeline` UI event.
13. `messageHistory.replaceMessages(...)` (prefix-preserving) + `readFileState.clear()`.
14. The turn loop continues with `turnRequestState.entries` swapped to the compacted set;
    the next provider request sees `[prefix, summary, preserved round, reminders, …]`.

### B2 Reactive compact (provider said no)

`recoverModelStepAfterContextExceeded` (`turn-model-step.ts:742-803`) catches the
provider's context-exceeded error mid-turn: rapid-refill breaker → mark
`reactiveCompactAttemptedInCurrentModelStep` (reset after each completed tool batch so a
LATER real overflow can still recover, `turn-loop-state.ts:180-186` comment) →
`reactiveCompactAfterContextExceeded` (`methods/compact.ts:352-462`) reuses the overflow
path's active entries, compacts with `trigger: Reactive`, and on success the model step
is retried. The Auto failure counter (`autoCompactConsecutiveFailures`) is shared by both
paths — one circuit breaker.

### B3 Memory write + recall

1. Turn completes → scheduler receives a branch-aware message snapshot (async).
2. Skip gates (direct-memory-write / no user prose ≥3 words) → cheap skips.
3. `scanMemoryManifest` (≤200 files, mtime desc) → the extraction prompt embeds the
   existing-file checklist ("update an existing file rather than creating a duplicate").
4. `runMemoryAgentLoop` (≤5 turns) executes with the tool firewall; denials return
   readable reasons into the loop so the subagent can adapt.
5. Files written under the per-workspace memory root —
   `<cliStorageRoot>/memories/projects/<slug>-<sha256[0:16] of workspace path>/memory/`
   (`memory/project-root.ts:10-24`); `MEMORY.md` index updated by the subagent itself;
   `originSessionId` stamped.
6. Next session: the context builder injects (a) the Memory *instructions* section into
   the system prompt (`context/sections/memory.ts` — cacheHint "dynamic") and (b) the
   `MEMORY.md` index content as a meta-user `context_prefix` attachment
   (`context/sections/request-user-context.ts` + `builder.ts:189-197`) — capped, warned,
   and prefix-stable.

### B4 Output-token continuation

finishReason=length + zero tool calls → append the continuation entry (query-local,
never persisted — `queryScope: "output_token_continuation"`), increment count, re-enter
the loop (micro/auto compact re-checked first). At 3 → honest error. Canonical history
filters these entries out at commit time (`filterOutputTokenContinuationEntries`,
`turn-output-token-continuation.ts:70-76`), so the *persisted* transcript stays clean
while the *provider-visible* context carries the resume thread.

---

## §C What ACUTE-CODE has today (verified at 89ef052, v0.116.0)

| Mechanism | ACUTE status | Where |
|---|---|---|
| Token estimator | **SHIPPED, stronger than ZCode's** — R64 BPE-approximation (regex pre-tokenize + calibrated per-segment costs, ±15% target vs cl100k references; CJK 1/char, digit triads, punct classes) | `agent-core/src/context.ts:87-137` (`estimateTokens`), `:140-146` (`estimateMessageTokens`, +8 role overhead) |
| Context budget | SHIPPED — `ContextBudget { contextWindow, maxOutputTokens, margin }`; shared `resolveTurnBudget` (one truth: compaction trigger = context meter = guard) | `context.ts:148-155`; runtime `:2372-2375` |
| Hard trim fallback | SHIPPED (legacy path) — drop oldest user/assistant pairs + marker message | `context.ts:172-205` `assembleWithinBudget` |
| **LLM compaction** | SHIPPED (R46-b, improved R71-e2/R83/R117-b) — summarize the over-budget head (60% of available budget kept as tail), persist append-only `context.compact` event `{summary, throughSeq, droppedMessages, tokensSaved}`; assembly is pure (newest event filters messages ≤ throughSeq, prepends summary as leading user message); event reused until overflow again; **force flag armed by provider-side `context_window_exceeded` classification → compact + retry once per turn**; summarizer usage recorded with origin "compaction" (R83); summarizer failure degrades to hard trim | `agent-core/src/agents/compaction.ts:240-351` (`assembleWithCompaction`), `:158-185` (`planCompaction`), `:188-197` (SUMMARIZER_SYSTEM_PROMPT — dense 6-bullet briefing, ~600 words); runtime `:2382-2394` call site, `:2669-2690` overflow recovery, `:541` OVERFLOW_RECOVERY_NOTE |
| Compaction ↔ memory bridge | SHIPPED (R117-b) — compaction summary also persisted to project memory (400-char slice, dedup, best-effort) | `compaction.ts:82-101` |
| Memory system | SHIPPED — SQLite per-project + workspace tiers (R44/R46/R117): `memory_save/recall/list` tools, relevance-ranked recall (token-overlap + substring bonus + kind boost + importance×recency), digest injected in system prompt above project digest; scope tiers; compaction episodic bridge; `memory.saved` event + memoryPolicy 'on-start' probe | `storage/memory.ts` (509 L), `tools/memory.ts`, `agents/prompts.ts:1506-1530`, runtime `:1254-1290` |
| Retry | SHIPPED (R75) — owner-specified patient ladder [immediate, 1.5m, 5m, 10m, 30m] (6 attempts) for transient classes only, Retry-After aware, abort-aware, heartbeat ticks, active-wait registry for the sub-agent stall watchdog; inner SDK maxRetries 4 | `lib/retry.ts:58-67` + runtime catch blocks `:2691-2714` |
| Tool result truncation | PARTIAL — Read tool: MAX_READ_BYTES with head+tail windowing and honest middle-omission notes; per-file grouped truncation notes; exec output clipping | `tools/fs-ops.ts:140, 167-191, 301, 373` |
| Context guard | SHIPPED — assembled-context guard (`meta.context_limit` + guardStop CONTEXT_LIMIT) + 200-request guard (`meta.request_limit`) | runtime `:2439-2460` |
| Prompt caching | **ABSENT** — reads `cachedInputTokens` from provider usage and accounts it (R50-c1, R83), but **sends no cache_control breakpoints** (no `ephemeral` anywhere in agent-core) and has no stable/dynamic section ordering for cache-friendliness | `agents/chat.ts:716-723, 1210-1214` (read side only) |
| Microcompact | ABSENT — no local tool-result clearing tier | — |
| Post-compact re-injection | ABSENT — no Read-state/plan re-injection after compaction | — |
| Output-token continuation | ABSENT — length-finish is not distinguished from other finish reasons | — |
| Rapid-refill breaker | ABSENT — a session with one giant tool result per turn re-compacts every turn (bounded only by the one-recovery-per-turn rule) | — |
| Provider-usage token anchoring | ABSENT — budget decisions ride the local estimator only (the `force` path covers estimate misses reactively) | — |

---

## §D Gap analysis + recommendations for ACUTE

Ranked by value/effort for ACUTE's architecture (modular, customizable, documented —
each item names its seam).

### D1. Provider-usage token anchoring (HIGH value, SMALL effort) — the best first pick
Mirror ZCode's `buildProviderUsageTokenOverride`: when assembling history, find the last
assistant turn whose persisted usage row exists and compute `providerInputTokens +
estimate(messages after it)`; use that as the compaction trigger's number, with the pure
estimate as fallback. ACUTE already persists per-turn usage rows (R50-c1/R83
`cachedInputTokens` handling) and already has the better estimator — this fuses them.
Seam: `agents/compaction.ts` `planCompaction` takes an optional `tokenOverride`; runtime
passes it from the last persisted usage. Add the dual-number (estimated vs provider)
debug fields to `meta.compaction` like ZCode's `AutoCompactDecision.reason`.

### D2. Trigger-point + reason codes (HIGH value, SMALL effort)
Today ACUTE checks the budget once per outer-loop iteration *after* assembly — the same
place ZCode checks (pre-request), which is fine — but the decision is boolean. Adopt
ZCode's typed decision: `{ shouldCompact, tokenCount, tokenSource, threshold, reason:
"disabled|not_enough_messages|circuit_breaker|below_threshold|above_threshold" }` logged
on every skip. ACUTE's event-log architecture makes this trivially observable
(`meta.compaction` already exists — extend its payload). This is the single biggest
debuggability upgrade for "why did/didn't it compact".

### D3. Round-preserving selection + durable preserved segment (HIGH value, MEDIUM effort)
ACUTE's `planCompaction` keeps the newest messages fitting 60% of budget — close to
ZCode's "preserve last round" but (a) not round-aligned (it can cut mid-exchange: an
assistant tool_call whose tool_result lands in the summarized head), and (b) the kept set
is recomputed at every assembly rather than recorded in the event. ZCode's design:
- Group by assistant-started rounds (ZC `groupByAssistantStartedRounds` — ~35 lines, pure).
- Record `{ anchorMessageId, headMessageId, tailMessageId }` (ACUTE: seq numbers —
  `{summarySeq, keptFromSeq, keptThroughSeq}`) inside the `context.compact` payload so
  assembly, resume, and fork/revert all agree on what was kept (ACUTE's pure-assembly
  principle already supports this — it's a payload extension, not an architecture change).
- Zero/invalidate usage anchors for preserved assistants is N/A for ACUTE until D1 lands —
  then mirror `invalidateRuntimeTokenUsage` for the kept tail.

### D4. Post-compact Read-state re-injection (MEDIUM value, SMALL effort)
ZC `compact-post-reminders.ts` is ~120 lines, pure, and directly portable: after a
compaction, re-inject the N most recently read files (ACUTE: from its own tool events —
the read tool's file paths are in the event log) as a system-reminder-style user message,
full content under per-file/total caps, pointer lines otherwise. ACUTE's event-log
assembly can synthesize this at assembly time (pure, no persistence change) — the same
pattern as the R120-H resume widened-fidelity window (`recentToolResults`). This kills
the classic failure where compaction drops the file contents the agent was mid-edit on.

### D5. Rapid-refill circuit breaker (HIGH value, SMALL effort)
Port the two counters: `toolTurnsSinceCompact` (reset on compact, +1 per completed tool
batch) and `consecutiveRapidRefills` (a compact with <3 tool turns since the last one).
At 3 consecutive, STOP compacting and fail the turn loudly with a diagnostic that names
the culprit (single oversized tool result / runaway loop), pointing at the artifact-spill
fix instead. Without this, ACUTE's one-recovery-per-turn can still enter a
compact-every-turn steady state on pathological sessions. Seam: module-level pure
function in `compaction.ts` + state on the turn loop; ~60 lines.

### D6. Tool-result budget unification + artifact spill (MEDIUM-HIGH value, MEDIUM effort)
ACUTE truncates Read/Exec well but has no uniform per-tool `resultBudget` contract and no
artifact-spill strategy (this is also the DeepSeek study's C4, still queued). ZCode's
shape to copy: `ToolResultBudget { maxModelBytes, maxInlineBytes, strategy: "truncate" |
"artifact", preview: { direction } }` declared per tool, applied in ONE serialization
seam, with the truncation marker carrying `originalBytes/maxModelBytes/strategy`. The
artifact variant is the rapid-refill breaker's structural partner: a 200KB tool result
becomes a file + pointer instead of compaction fuel. Seam: a new
`agent-core/src/tools/result-budget.ts` + hooks in the tool executor's output path.

### D7. Output-token continuation (MEDIUM value, SMALL effort)
ZC's `classifyOutputTokenContinuation` + the 3-cap + the query-local "Output token limit
hit. Resume directly…" entry is ~150 lines total. ACUTE's chat adapter already sees
finish reasons; the continuation entry can ride the existing in-memory nudge channel
(`pendingNudge` — runtime `:2396-2403`) so it never persists, exactly matching ZCode's
`queryScope` semantics. Distinction to preserve from ZC's comment: input+output
shared-window truncation (a *successful* finish with length) is continuation territory;
an actual request rejection is overflow territory (ACUTE's force-compaction path).

### D8. Prompt-cache breakpoints (MEDIUM value, MEDIUM effort — provider-dependent)
ZCode's whole pipeline is built around a stable prefix: context sections ordered
stable→dynamic with `cache_control: ephemeral` breakpoints at the prefix edge
(`finalizeLatestNonSystemMessageCacheControl`), attachment bubbling to keep meta content
positionally stable, and compaction explicitly preserving the context prefix.
ACUTE already HAS the stable prefix concept implicitly (system prompt + memory digest are
stable; history grows append-only) and tracks cache hits — what's missing is *declaring*
the breakpoint for Anthropic-format providers. Concrete: in `agents/chat.ts`, when
`apiFormat` is anthropic, set `cache_control: {type:"ephemeral"}` on the LAST history
message (and on the system prompt block) — the smallest possible change that makes the
provider cache the entire turn history. Then verify via the existing
`cachedInputTokens` accounting (the metric is already wired — this turns it from
measurement into a control loop).

### D9. Memory: keep ACUTE's model, steal two ZCode ideas (LOW-MEDIUM value, SMALL effort)
ACUTE's SQLite memory (ranked recall, digests, scope tiers, dedup) is arguably
*stronger* than ZCode's plain-files memory for retrieval; ZCode's advantages worth
taking:
1. **The extraction-subagent tool firewall pattern** — a background loop whose tool
   policy is narrowed to read-only + write-only-inside-memory-root with readable denial
   messages. ACUTE's R117 'memory formation is voluntary' stance can stay voluntary, but
   if/when a background extractor is added, `memory-agent-loop.ts`'s policy shape
   (deny-with-reason into the loop, catalog-miss ≠ permission denial) is the template.
2. **Hard caps on the injected index** (200 lines/25K chars + warning footer) — ACUTE's
   `memoryDigest` is "small + whole-line capped" but the cap values and the
   self-describing warning (which teaches the model to keep the index lean) are worth
   mirroring explicitly.

### D10. Explicitly NOT recommended to copy
- ZCode's chars/3 estimator — ACUTE's R64 estimator is strictly better; keep it.
- The `memoryExtractionScheduler`'s async snapshot machinery — ACUTE's turn-end
  synchronous hooks are simpler and its event-log is already the snapshot.
- Microcompact as a default-on feature — even ZCode ships it OFF; adopt only after D6
  (result budgets) makes clearing semantics moot for oversized results, and if adopted,
  wire it to idle-time (its best trigger) rather than token pressure.

---

## §E How to navigate ZCode (for future agents)

```
/home/z/repos/zcode
├── apps/zcode-cli/                 ← THE agent CLI (its own nested pnpm workspace)
│   ├── AGENTS.md                   ← read this first: design laws (400-line files,
│   │                                  spec-before-code, "compact on token/context limit
│   │                                  is the designated resource boundary")
│   └── packages/
│       ├── core/src/               ← agent core (~everything below)
│       │   ├── compact/            ← policy.ts (thresholds/decision), manual.ts
│       │   │                          (estimator/gates), microcompact.ts, prompt.ts
│       │   │                          (the 9-section summary prompt), rounds.ts
│       │   ├── runtime/
│       │   │   ├── methods/        ← compact.ts (3 triggers), compact-active.ts (the
│       │   │   │                      engine), compact-persistence.ts,
│       │   │   │                      compact-summary-model-request.ts, microcompact.ts,
│       │   │   │                      turn-loop.ts (integration order), turn-loop-state.ts
│       │   │   │                      (rapid-refill), turn-model-step.ts:742 (reactive),
│       │   │   │                      turn-output-token-continuation.ts, context-usage.ts
│       │   │   └── helpers/        ← compact-selection.ts (what's kept),
│       │   │                          compact-preservation.ts, compact-post-reminders.ts,
│       │   │                          provider-request-messages.ts (cache_control +
│       │   │                          attachment bubbling), project-memory-extraction.ts
│       │   ├── agent/              ← message-history.ts (RuntimeMessageEntry +
│       │   │                          CacheStats + context prefix), session-history-
│       │   │                          hydrator.ts (cold resume), compact-session.ts
│       │   ├── memory/             ← extraction.ts (scheduler), memory-agent-loop.ts
│       │   │                          (tool firewall), recall/manifest.ts, index-content.ts
│       │   ├── context/            ← builder.ts + sections/ (stable/dynamic cacheHint,
│       │   │                          memory section, meta_user attachments)
│       │   └── tool/executor/      ← result-serialization.ts (resultBudget + artifact)
│       ├── adapters/src/model/     ← retry-policy.ts (exponential backoff defaults)
│       └── contracts/src/          ← CompactTrigger/Phase/Reason enums, payload types
├── packages/shared/src/            ← usage-stats.ts:9 (ESTIMATED_TOKEN_CHAR_DIVISOR=3),
│       │                              zcode-protocol/index.ts:1697 (budget strategy
│       │                              "preflight-v1")
├── packages/services/src/          ← desktop-side services; memory/ = SQLite-backed
│       │                              workspace memory feeding the CLI's memoryRoot
└── packages/{desktop,ui,web}/      ← Electron app + React UI (out of scope here)
```

Grep recipes that work: `rg -n "shouldAutoCompact|compactActiveConversation"` (decision
chain); `rg -n "cacheControl"` (all cache breakpoints); `rg -n "MicrocompactBoundary|`
CompactBoundary|CompactStarted"` (event surface); `rg -n "queryScope"` (query-local vs
canonical entries). The tests live in `apps/zcode-cli/packages/core/test/` — compact
policy/selection/microcompact each have dedicated suites that double as executable
specifications of the thresholds quoted above.

Version note: clone git @ 29628c9 ("feat: update v3.14.3", post-open-source-release).
Line numbers are exact for that commit.
