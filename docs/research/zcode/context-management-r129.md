<!-- last-reviewed: 2026-09-26 round-129 -->
# ZCode — Full Context-Window Management (source-level study, Round 129)

**Why this document exists.** Owner directive (R129-R5): the earlier
compression-focused study (`agent-ctx/research/zcode-context-compression.md`,
post-R123) covered compaction only; this round goes BROADER — "research how they
handle their context window, how they build the context window along the way,
how they process the things... what should be included in the context window,
what should not be included... how the context compression works and how each
and every single one of the things gets managed." Research only: no repo code
was modified; this file is the deliverable.

**Method.** Fresh shallow clone at `/tmp/ref-zcode` (git @ `29628c9`
"feat: update v3.14.3" — same HEAD the earlier study pinned, so its citations
remain directly comparable). First-hand reads of the context builder, the
system-reminder taxonomy, the provider projection, every compaction file, the
rewind/fork/resume machinery, token/usage accounting, and the tool-result
budget seam. ACUTE-CODE side verified at the R128 tree (compaction.ts at its
post-W8 state: 1009 lines). **License: Apache-2.0** (`/tmp/ref-zcode/LICENSE`)
— every pattern below is license-clean for adoption (MIT/Apache allowlist,
AGENTS.md hard rule).

**Path conventions.** `ZC/` = `/tmp/ref-zcode/apps/zcode-cli/packages/core/src`.
`SH/` = `/tmp/ref-zcode/packages/shared/src`. The repo is bilingual; load-bearing
comments are frequently Chinese — translations are mine. `ACUTE/` =
`/home/z/acute-code/agent-core/src`.

---

## Overview — the whole pipeline in one paragraph

ZCode's context window is a **two-layer, append-mostly, projection-rendered
structure**. Layer 1 is the *canonical* `RuntimeMessageEntry[]`
(`ZC/agent/message-history.ts:49-66`): provider messages plus "attachment"
entries (system-reminder bodies stored raw, wrapped in
`<system-reminder>` tags only at request time) plus per-entry metadata
(`source`, provider `tokens`, `queryScope`). Layer 2 is the *provider
projection* (`ZC/runtime/helpers/provider-request-messages.ts:48-99`): each
request renders the canonical entries into a `ModelInputMessage[]` —
attachments become user messages, meta attachments are *bubbled backwards*
past tool results to keep their causal position cache-stable, mid-conversation
system reminders are merged into true system messages (when the model supports
it), and ONE `cache_control: ephemeral` breakpoint is stamped on the latest
non-system message. The system prompt itself is assembled once per
configuration by `ContextBuilder.build()` (`ZC/context/builder.ts:82-223`) into
up to three system messages (cli-prefix / stable body / dynamic body — each
with its own ephemeral breakpoint) plus two meta-user attachments
(`skills_listing`, `context_prefix`). History grows append-only until one of
three compaction triggers fires (auto at ~83% of window, reactive on provider
rejection, manual `/compact`); compaction replaces the in-memory history with
`[context prefix, summary user-message, preserved last round (token-invalidated),
post-compact reminders]` and records a durable `CompactBoundary` with the
preserved segment's message ids so resume/fork reconstruct the exact same
context. Reverting is *not* a delete: a rewind records a branch cut
(`keptMessageIDs` + `branchCutAfterMessageID`) and the runtime REBUILDS
message history, Read-file state, and the context prefix from the persisted
log — the reverted context state is re-derived, never patched in place.

---

## §1 Per-turn context assembly (how the messages array is built)

### 1.1 One-time context initialization (the prefix)

`ensureContextInitialized` (`ZC/runtime/methods/context.ts:31-74`) runs before
the first model step of a session: resolve env/git context sources → start MCP
→ discover skills → load memory root + `MEMORY.md` index → build the
`ContextBuilder` → `initializeMessageHistoryFromContext`
(`context.ts:273-304`) which does
`this.messageHistory.init(buildContextHistoryEntries(contextResult))`.
`buildContextHistoryEntries` (`ZC/runtime/methods/context-history-entries.ts:7-16`)
is just `[...systemMessages, ...metaUserAttachments-as-attachments]` — the
prefix is **entries**, not a frozen string, so config refreshes can replace it
in place (`rebuildContextPrefix`, `ZC/runtime/methods/context-refresh.ts:7-50`
— rebuilds the prefix and re-splices the canonical conversation tail behind it).

### 1.2 System-prompt composition (the section pipeline)

`ContextBuilder.build()` (`ZC/context/builder.ts:82-223`) assembles ordered
sections: 1. CLI prefix (`sections/cli-prefix.ts`) — skipped for workflow
child agents; 2. identity (`sections/identity.ts`) OR custom system prompt OR
workflow-actor persona (mutually exclusive — a wiring error throws,
`builder.ts:93-97`); 3. dynamic system context — desktop protocol,
"Dynamic Behavior" (communication norms), session guidance, memory
instructions (`sections/memory.ts` — the file-format contract for the memory
directory), env info (`sections/env-info.ts:66-83`: cwd, platform, shell, OS,
model id), output style, **Context Management** (`ZC/context/dynamic-sections.ts:26-42`
— the paragraph that TEACHES the model compaction exists:
*"When the conversation grows long, some or all of the current context is
summarized; the summary, along with any remaining unsummarized context, is
provided in the next context window so work can continue — you don't need to
wrap up early or hand off mid-task"*, plus "do not stop because the context or
session is long"), git snapshot (branch/status/recent commits,
`env-info.ts:85-102`); 4. skills listing → meta-user; 5. request-user context
(`sections/request-user-context.ts:15-135` — `# agentsMd` block: workspace
AGENTS.md/user instructions + `MEMORY.md` index under the caption "user's
auto-memory, persists across conversations"); 6. current date; 7. custom
sections.

**Tool definitions are NOT in the system prompt** — `builder.ts:47-52`
(`setToolRegistry` is a compatibility no-op: "工具说明由 model request 的 tools
字段承载，不再镜像进 system prompt" — tool descriptions ride the request's
`tools` field, no longer mirrored into the prompt). Every section carries
`injectionTarget: "system" | "meta_user"` + `cacheHint: "stable" | "dynamic"`
(`ZC/context/types.ts:52-71`) and is ordered stable→dynamic within each target
(`orderSectionsForInjection`, `builder.ts:310-325`). Rendering:
`assembleSystemMessages` (`builder.ts:230-277`) emits up to **three system
messages** — cli-prefix, stable body, dynamic body — **each with
`cacheControl: {type: "ephemeral"}`**; `assembleMetaUserAttachments`
(`builder.ts:279-307`) emits `skills_listing` + `context_prefix` attachments
(the `context_prefix` body is wrapped "As you answer the user's questions, you
can use the following context… this context may or may not be relevant",
`builder.ts:327-336`).

### 1.3 Per-request assembly (the turn loop order)

`runRegularTurnLoop` (`ZC/runtime/methods/turn-loop.ts:43-219`) — every model
step, in order: abort check → drain queued runtime commands/background results
→ **compactPhase = PreRequest (first step) or MidTurn (later steps)**
(`turn-loop.ts:67-68`) → `microcompactIfNeeded` → `autoCompactIfNeeded`
(awaited — see §5) → `initializeMcp` → tool table (minus turn-scoped
disallowlists) → per-request reminders → `buildRuntimeProviderRequestMessages`
(cache-control applied AFTER projection, `turn-loop.ts:170-176`) → model step.
Per-request reminders injected as runtime attachments
(`commitTurnRequestEntries`): plan-mode exit, runtime mode (plan-mode full or
sparse — full every 5th reminder, `ZC/runtime/helpers/runtime-reminders.ts:18-21`),
**todo reminder** (see §6), output style (first step only). Per-request
reminders ride the in-memory turn request state; the todo reminder is ALSO
persisted (`persistSyntheticUserNoticeForSession`, `turn-loop.ts:148-155`).

### 1.4 The projection (canonical → provider messages)

`buildProviderRequestMessages` (`ZC/runtime/helpers/provider-request-messages.ts:48-99`):
(1) `projectIncomingMessageEntries` (origin tagging); (2)
`reorderAttachmentLikeEntries` (`:106-139`) — attachment-like user entries are
collected while walking BACKWARDS and flushed *before* the next real
user/assistant boundary, so meta content keeps a positionally stable spot in
the growing prefix (cache-friendliness is the stated design driver;
`goal_state_change` is deliberately non-bubbling — "State changes must keep
their causal position", `:43-46`); (3) `projectMidConversationSystemEntries`
(`ZC/runtime/helpers/provider-mid-conversation-system.ts:36-100`) — pending
mid-conversation system texts are merged into ONE system message anchored
after the previous assistant/tool-run when the model supports mid-conversation
system, else fall back to user `<system-reminder>` bodies; (4) legacy
`<system-reminder>` texts move after tool-result runs
(`moveLegacySystemRemindersAfterToolResultRun`, `:184`); (5) adjacent-user
merge exists but is OFF (`ENABLE_MCS_ADJACENT_USER_MERGE = false`, `:41` —
it's the Anthropic serializer's job, the projection stays provider-neutral);
(6) attachments render as `wrapSystemReminderForSource(source, content)` user
messages with nested-tag escaping (`ZC/system-reminder/source.ts:190-237`);
(7) `finalizeLatestNonSystemMessageCacheControl` (`:292-314`) — see §7.

### 1.5 The system-reminder taxonomy (what may enter context at all)

`ZC/system-reminder/source.ts:88-164` — 27 sources, each with a typed
`channel` (request_prefix | current_turn | tool_result | history_continuity |
mid_turn_event | real_user), `lifecycle`, `isMeta`, `providerVisibility`, and
an evidence label. Three families: **prefix** (`context_prefix`,
`skills_listing`), **persisted** (todo_reminder, task_status,
tool_result_warning, resume_referenced_session_context, plan_file_reference,
resume_goal_state, goal_state_change, plugin_reference, target_continuation,
goal_completion_verification, rewind_notice, conversation_fork,
selection_side_chat, queued_system_notification, shell_environment_change),
**per-request** (incoming_message, hook_context, runtime_mode, plan_mode_exit,
output_style, date_change, referenced_session_context, model_anomaly,
prompt_attachment, diagnostics). The descriptor drives every downstream
decision (bubbling, mid-conversation projection, compaction-prefix detection,
persistence). This is the cleanest answer in the repo to "what should be
included in the context window" — inclusion is a *typed, per-source policy*,
not ad-hoc string concatenation.

**ACUTE contrast:** `ACUTE/agents/runtime.ts` builds the message list per
outer-loop iteration: `assembleHistory(db, session.id, …)` (event log →
SeqMessages, `runtime.ts:1046-1156`) → `assembleWithCompaction` (compaction
gate, `runtime.ts:2392-2410` sync / `:3863-3880` streamed) → `chat()`. The
system prompt is one composed string (`buildProjectSystemPrompt`,
`ACUTE/agents/prompts.ts:1767-1772`; sections identity/tools/memory/meta via
`buildSystemPromptSections :1753-1766` + the `.acute/prompts/` override
registry). There is no stable/dynamic split, no meta-user attachment layer, no
per-request reminder cadence — hints (taskHints/modeHints) are ephemeral
per-turn additions; the memory digest rides the prompt above the project
digest. Tools live in the prompt's `tools` section today (ZCode moved them
out to the request's tools field — a deliberate cache/size decision).

---

## §2 Inclusion / exclusion — what gets in, what gets truncated or elided

### 2.1 Tool-result budgets (the pre-compaction defense)

`ZC/tool/executor/result-serialization.ts:33-40`:

```ts
const DEFAULT_RESULT_BUDGET: ToolResultBudget = {
  maxInlineBytes: 100_000,
  maxModelBytes: 100_000,
  strategy: "truncate",
  preview: { direction: "head" },
};
```

Applied at ONE serialization seam (`serializeOutput`, `:46-218`): per-tool
`resultBudget` override from the registry; per-tool `maxModelChars`
(UTF-16-count providers, `:74-81`); **artifact strategy** — oversized results
spill to a persisted artifact file and the model receives a pointer +
preview (`:178-198`; write failure degrades to truncation, never fails the
tool, `:322-327`); the truncation marker is self-describing:
`[Tool output truncated by resultBudget: originalBytes=…, maxModelBytes=…,
strategy=truncate]` (`:201`). Empty output gets the synthetic
`(tool completed with no output)` so silence is never mistaken for a missing
result (`:57-67`). MCP tools get tiered budgets by authority
(`ZC/mcp/index.ts:125-151`): official CUA 256K/256K truncate-head; host-node
REPL 1M inline / **64K model** with `strategy: "artifact"`, preview
direction *tail* (REPL output — the end matters); normal MCP 100K/50K
truncate-head.

### 2.2 Microcompact (local, no-LLM clearing of old tool results)

`ZC/compact/microcompact.ts:12-29` — keeps the last
`DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5` result *groups* (a group =
the results of one assistant tool batch); older results of compactable tools
(`Read, Bash, Grep, Glob, WebFetch, WebSearch, Edit, Write, ApplyPatch`)
collapse to `[Old tool result content cleared]`. Gates: fires on idle > 60 min
OR token pressure ≥ `min(autoCompactThreshold × 0.9, autoCompactThreshold −
2_000)` (`:77-81, 171-195`); media blocks (image/video/file) and error
results are protected (`:249-256`, `:225`); applies only if it saves ≥ 256
tokens (`:145-153`); **disabled by default**
(`ZC/runtime/methods/microcompact.ts`, `enabled: config.microcompact?.enabled
=== true`). The runtime wrapper is copy-on-write — only cleared entries are
cloned (`ZC/runtime/helpers/compact.ts:129-144`).

### 2.3 What is structurally excluded from summarization

`isContextPrefixMessage` (`ZC/compact/manual.ts:140-146`): system messages and
`<system-reminder>`-prefixed user messages are NEVER summarized. Media is
projected per model policy for the summary request and stripped on retry
(`compact-active.ts:323-363, 432-444`). Empty assistants with valid usage are
KEPT on hydration as estimation anchors (`session-history-hydrator.ts:123-130`).
Interrupted tools become `[Tool execution was interrupted before resume]`
(`:45`).

**ACUTE contrast:** inclusion/exclusion is enforced in
`assembleHistory`'s replay window — `RECENT_TOOL_RESULTS = 8` newest tool.use
events keep full output summaries, older stub to `OLD_TOOL_STUB_CHARS = 200`
chars, each `<tool_results>` block caps at `MAX_TOOL_BLOCK_CHARS = 48_000`
with oldest-first stubbing; sticky tools (read_skill / memory_recall) are
exempt to `STICKY_STUB_CHARS = 8_000` (`ACUTE/agents/runtime.ts:1036-1039`).
read_file itself caps at `MAX_READ_BYTES = 256KB` / whole-file budget 128KB
with head+tail windowing (`ACUTE/tools/fs-ops.ts:22,35`). There is NO uniform
per-tool `resultBudget` contract and NO artifact spill (the earlier doc's D6,
still queued — and the structural partner of the rapid-refill breaker: a 200KB
result becomes compaction fuel instead of a file + pointer).

---

## §3 Compression / compaction — full mechanics

### 3.1 Thresholds and the decision function

`ZC/compact/policy.ts:6-14`:

```ts
export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
```

Arithmetic (`policy.ts:67-88`): the provider window is input+output SHARED, so
the threshold denominator first subtracts the output reserve —
`effective = contextWindow − min(maxOutputTokens ?? 32K, 21K)`; then
`threshold = effective − 13K buffer`. For a 200K model: 200K − 21K − 13K =
**166K = 83% of the raw window**. `shouldAutoCompact` (`policy.ts:90-155`)
returns a rich `AutoCompactDecision` — both estimate- and provider-usage
counts, threshold, windows, and a typed `reason`
(`disabled | not_enough_messages | circuit_breaker | below_threshold |
above_threshold`) so every skip is explainable. Message-count gate:
`hasEnoughMessagesToCompact` (`manual.ts:69-75`) — ≥2 assistant-started
rounds AND at least one assistant message.

### 3.2 The engine step by step

`compactActiveConversation` (`ZC/runtime/methods/compact-active.ts:75-140` +
impl `:142-682`):
1. Snapshot `activeEntries` (immutability contract documented `:180-185`).
2. `selectCompactEntries` (`ZC/runtime/helpers/compact-selection.ts:30-57`):
split prefix vs body; group body into assistant-started rounds
(`ZC/compact/rounds.ts:1-35` — an assistant message + its tool results +
trailing user messages; consecutive assistants each start their own round
unless an assistant-id seam merges them); **Auto/Reactive triggers preserve
the last 1 round verbatim** (`shouldPreserveRecent`, `:225`); manual
`/compact` summarizes everything. `<2 rounds or no assistant → healthy no-op
skip` ("Context is up to date; no compression needed", `:217-238`).
3. `initializeMcp`; if the tool catalog exceeds
`COMPACT_TOOL_KEEP_MAX_COUNT = 100`, the summary call runs with NO tools
(`:251-257` — "massive MCP 工具会把 compact summary request 的 provider context
撑爆").
4. **Attempt loop** (max `AUTO_COMPACT_MAX_ATTEMPTS = 3` for Auto, 1
otherwise, `:72-73, 203`): build the summary request
`[...prefixEntries, ...summaryGroups, compactPrompt-as-final-user-message]`;
media projected per model policy; `maxOutputTokens = min(model max, normal
cap, MAX_OUTPUT_TOKENS_FOR_SUMMARY=20K)` (`capCompactSummaryMaxOutputTokens`,
`:716-724`); `querySource: "compact"` telemetry; the summary call CAN carry
tools but the prompt forbids using them (`NO_TOOLS_PREAMBLE`,
`ZC/compact/prompt.ts:1-12`).
5. **Prompt-too-long resilience inside the summary call itself** (thrown OR
returned as finishReason, `:445-480`): (a) RESELECT — move more recent rounds
into the preserved set, sized by the token gap parsed from the provider error
(`parsePromptTooLongTokenGap` regex `/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i`
→ actual − limit, `compact-selection.ts:400-410`); (b) TRUNCATE — drop oldest
rounds from the summary input only (manual trigger only), inserting the
marker `[earlier conversation truncated for compaction retry]`, max
`MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3` (`manual.ts:55-59`); (c) media-strip
retry. Give up → `CompactPromptTooLongError`.
6. `formatCompactSummaryOrThrow` (rejects a tool-call-only response), then
build the post-compact list (`ZC/runtime/helpers/compact.ts:72-88`):
`[contextPrefix, summaryEntry, preservedEntries (token-invalidated),
postCompactReminderEntries]`.
7. **Post-compact reminders** (`compact-active.ts:486-501`): the approved
plan-file reference + `buildPostCompactReadStateReminderEntries` — see §6.2.
8. Persist the `CompactBoundary` payload (`buildManualCompactBoundary`,
`manual.ts:77-100`): trigger, phase, reason, pre/post token counts BOTH
estimated ("true") and provider-reported, `willRetriggerNextTurn`
(`truePostCompactTokenCount >= autoCompactThreshold`, `compact-active.ts:569-572`
— the honest chained-compaction flag), summarized/kept counts,
**`preservedSegment: {anchorMessageId, headMessageId, tailMessageId}` +
keptMessageCount** (re-derived against the DB with revert/rewind branches
respected, `ZC/runtime/helpers/compact-preservation.ts:13-45`), plus UI
timeline events.
9. `messageHistory.replaceMessages(...)` (prefix-preserving; the
turn-local variant `preserveCanonicalContextPrefix` keeps the CURRENT
canonical prefix, `turn-output-token-continuation.ts:78-88`) and
**`readFileState.clear()`** (`compact-active.ts:615-625`).
10. Generic retryable errors retry up to 3 with timeline status Retrying (not
Failed) until the last attempt (`:632-668`).

### 3.3 The summarize prompt (9 sections + preservation rules)

`ZC/compact/prompt.ts:14-109` — think-in-`<analysis>` first, then a 9-section
`<summary>`: 1 Primary Request and Intent · 2 Key Technical Concepts · 3 Files
and Code Sections ("include full code snippets where applicable") · 4 Errors
and fixes · 5 Problem Solving · 6 **All user messages** ("List ALL user
messages that are not tool results… Preserve any security-relevant
instructions or constraints verbatim so they remain in effect after
compaction") · 7 Pending Tasks · 8 Current Work · 9 Optional Next Step
("include direct quotes from the most recent conversation… verbatim… so
there's no drift in task interpretation"). Custom instructions ride as
`Additional Instructions:` (`:111-117`). `formatCompactSummary`
(`:119-131`) strips the `<analysis>` block and rewrites
`<summary>…</summary>` → `Summary:\n…`.

**What ALWAYS survives:** the context prefix (system + `<system-reminder>`
meta user + skills listing — never summarized, §2.3), the last round
verbatim (Auto/Reactive), all user messages *inside the summary text*
(section 6 — the prompt-level guarantee), security constraints verbatim, the
post-compact Read-state reminders, and the plan-file reference.

### 3.4 Re-injection — how the summary comes back

`buildCompactSummaryMessage` (`prompt.ts:133-165`):

```ts
let message = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${formatCompactSummary(summary)}`;
if (options.transcriptPath) { message += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${options.transcriptPath}`; }
if (options.recentMessagesPreserved) { message += "\n\nRecent messages are preserved verbatim."; }
if (options.replStateCleared) { message += `\n\nYour REPL VM state has been cleared…`; }
if (options.suppressFollowup) { message += '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap…'; }
```

Injected as a **user-role message with `legacySyntheticRuntimeMetadata()`**
(`compact-active.ts:531-539`) — the same envelope ACUTE's
`summaryMessage` uses (`ACUTE/agents/compaction.ts:459-468`). The engine
calls it with `suppressFollowup: true` (`compact-active.ts:518-520`) — the
"continue" flow: the next model step receives
`[prefix, summary, preserved round, reminders, …]` and picks up mid-task.

### 3.5 Pair-flattening / tool-call-result shape

ZCode does NOT flatten pairs into one message: the assistant entry carries
`toolCalls[]` alongside `content` (`message-history.ts:179-207`), tool results
are separate `role:"tool"` messages with `toolCallId`/`toolName`/`isError`
(`:379-394`). Microcompact clears the *result bodies* only, leaving the
call/result grammar intact (`helpers/compact.ts:129-144`). The estimator
counts `toolCalls` JSON SEPARATELY because it rides outside content
(`manual.ts:102-114` — the fix for "大型工具入参会被完整发给 provider，却在 auto
compact 和 preflight 中计为 0"). Adjacent-user merging (which WOULD flatten
reminder-user + real-user) is deliberately disabled at the projection layer
(`provider-request-messages.ts:39-41`) and delegated to the Anthropic
serializer.

### 3.6 Output-token continuation (the OTHER "context exceeded")

`ZC/runtime/methods/turn-output-token-continuation.ts:12-56`: when
`finishReason === "length"` (or raw `max_tokens|max_output_tokens|
model_context_window_exceeded`) and there are NO tool calls, a query-local
user entry — *"Output token limit hit. Resume directly — no apology, no recap
of what you were doing. Pick up mid-thought if that is where the cut
happened. Break remaining work into smaller pieces."* — is appended
(`queryScope: "output_token_continuation"`, never persisted), max
`MAX_OUTPUT_TOKEN_CONTINUATIONS = 3`, then an honest error. The long comment
(`:44-55`) pins the subtle contract: a *successful* finish with length on a
shared input+output window is CONTINUATION territory (save partial output,
continue; the outer loop re-checks micro/auto compact first); an actual
request REJECTION is overflow territory (reactive compact). Canonical history
filters the continuation entries at commit time
(`filterOutputTokenContinuationEntries`, `:70-76`).

**ACUTE contrast:** single-tier LLM compaction with a 6-bullet ~600-word
summarizer prompt (`SUMMARIZER_SYSTEM_PROMPT`,
`ACUTE/agents/compaction.ts:791-800`); keep = newest ~60% of `available`
(window − output-reserve − margin) with the R128-W8 round-aligned walk-back
(§D3 below); summary lands as the leading user message `[Earlier conversation
compacted (N messages summarized…)]`; the `context.compact` event is reused
until overflow again; summarizer failure degrades to hard trim; overflow
recovery forces one compaction per turn (`runtime.ts:2688-2705`).
ACUTE has NO mid-summary prompt-too-long reselect/truncate ladder (the
summarizer request is bounded only by the 60% keep design), NO output-token
continuation (length-finish is not distinguished), NO media policy, and the
keep-set is re-derived per assembly from the pure event fold rather than
recorded as a preserved segment.

---

## §4 Token counting — usage measurement, budgets, per-model windows

### 4.1 The estimator (fallback tier)

chars/3 via `ESTIMATED_TOKEN_CHAR_DIVISOR = 3` (`SH/usage-stats.ts`), with
`estimateTokens` giving CJK chars double weight (`ZC/context/utils.ts:13-21`).
`estimateMessageTokens` (`ZC/compact/manual.ts:102-114`) counts assistant
`toolCalls` JSON separately and uses a DEDICATED projection that includes
reasoning blocks ("modelMessageContentToText 是'可见正文'投影，会有意隐藏
reasoning；compact fallback 却把它当作 provider 上下文体积" — the visible-text
projection would count reasoning as 0, `:126-138`).

### 4.2 Provider-usage anchoring (primary tier)

`buildProviderUsageTokenOverride` (`ZC/runtime/methods/compact.ts:313-340`):
scan BACKWARDS over source entries for the latest committed assistant with
persisted usage (`findLatestCommittedAssistantUsage`,
`turn-model-step-usage.ts:54-64`); `tokenCount = providerBase +
estimate(messages after it)` where providerBase is the provider's
`contextUsageTokens` or `inputTokens`; cache read/write reported separately.
The reverse scan survives history replacement ("反向扫描可随 history
replacement 自然移动，不再依赖可能失效的绝对 message cursor", `:326-329`).
`estimateCurrentModelInputTokens` (`:342-350`) reuses it for context metering
— the same number gates compaction and feeds the meter. Anthropic nuance:
AI SDK v6 folds cache read/write into `inputTokens`; the runtime uses the
normalized input as the window number (`turn-model-step-usage.ts:160-182`).
Preserved-tail assistants are token-ZEROED on the projection copy only
(`invalidateRuntimeTokenUsage`, `ZC/agent/message-history.ts:426-442` —
"Compact 之后 preserved assistant 的 provider usage 仍属于被替换的旧前缀";
applied in `helpers/compact.ts:157-166` and re-applied on cold resume
`ZC/agent/compact-session.ts:49-58`).

### 4.3 Budget tracking per turn + the observability snapshot

Per model step: `buildContextUsageSnapshot`
(`ZC/runtime/methods/context-usage.ts:119-253`) logs a category breakdown —
`system_prompt`, `meta_user_context`, `skills`, `tool_prompt`,
`system_tool_schemas`, `mcp_tool_schemas`, `messages` — each with
chars/tokens/percent, per-section contributors, per-tool schema estimates
(`buildToolUsageDetail :310-335` serializes the FULL tool contract for
estimation), per-role message breakdown, honest warnings ("当前 token 来自本地
估算，不是 provider count"), tokenizer tag `zcode.estimateTokens.v1`.
Per-model-step output caps: `resolveModelStepMaxOutputTokens`
(`ZC/runtime/methods/model-token-limits.ts:17-41`) —
`min(baselineMaxOutputTokens, contextWindow − estimatedCurrentUsage − 1000)`
(the preflight cap: the request never asks for more output than the window
has left). Normal-request default output = 32K (`:5`).

### 4.4 Per-model window tables

No hard-coded table in code — the window is CONFIG-DRIVEN:
`modelConfigRules.modelRules` in `/tmp/ref-zcode/config/provider/zcode-builtin.json`
(a regex-matched rule list; the `.*` default rule sets
`properties.contextWindow: 200000` + `optionSpecs.maxOutputTokens.max: 32000`;
specific patterns override — 38 models carry `1000000`, others 131072 /
200000 / 262144 / 400000 …). Schema: `SH/model-config.ts:71`
(`contextWindow: z.number().int().positive()` inside
`completeModelPropertiesDataSchema`). Code-side fallback:
`DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000` (`policy.ts:6`), used when the
model row lacks the property (e.g. `compact.ts:419-422`).

**ACUTE contrast:** the R64 BPE-approximation estimator (±15% vs cl100k
references, CJK 1/char, digit triads — `ACUTE/src/context.ts:87-137`) is
STRICTLY better than chars/3 and stays. R125-C shipped the provider-usage
anchor twin (`providerUsageAnchor`, `ACUTE/agents/compaction.ts:527-572`) and
R127-W4 threaded it into the context meter — so ACUTE already has the hybrid.
ACUTE's per-model window comes from its models table via `resolveTurnBudget`
(one truth for compaction + meter). ACUTE lacks the per-step preflight output
cap and the category-level usage snapshot (its context report has breakdown
slices but not per-tool-schema estimates).

---

## §5 Auto-compaction — when it fires, and the "finish before next task" law

**Where:** every model step, BEFORE the provider request —
`turn-loop.ts:67-98`:

```ts
const compactPhase = state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
await this.microcompactIfNeeded(...);
const rapidRefill = evaluateRapidRefill(state.compactTracking);
const autoCompactOutcome = await this.autoCompactIfNeeded(...);
if (autoCompactOutcome === "rapid_refill_blocked") { throw createCompactRapidRefillError(...); }
if (autoCompactOutcome === "compacted") { recordCompactSuccess(state, rapidRefill); recordCompactHistoryRound(state); }
```

`autoCompactIfNeeded` (`ZC/runtime/methods/compact.ts:184-311`) is AWAITED
inside the loop — **the next model request literally does not fire until
compaction completes** (the owner's "does not perform the next task until
compression completes" behavior, exactly). On success the loop CONTINUES with
`context.turnRequestState.entries` swapped to the compacted set; on failure
`autoCompactConsecutiveFailures++` → after 3 consecutive failures the
decision function returns `reason: "circuit_breaker"` and auto-compact is
disabled (`policy.ts:136-144` — a SEPARATE breaker from rapid-refill). Three
triggers (mapping `ZC/runtime/helpers/compact.ts:38-63`): **Auto**
(`PreRequest` at turn start / `MidTurn` between tool batches, reason
ContextLimit) · **Reactive** (phase `Reactive`, reason ProviderOverflow —
armed only after the provider rejects; `recoverModelStepAfterContextExceeded`
`ZC/runtime/methods/turn-model-step.ts:742-803` checks rapid-refill first,
marks `reactiveCompactAttemptedInCurrentModelStep` — reset after each
COMPLETED tool batch (`turn-loop-state.ts:180-186`) so a later real overflow
can still recover — compacts, retries the step; the failure counter is SHARED
with auto — one circuit breaker) · **Manual** (`/compact`, StandaloneTurn,
UserRequested). The design law is stated in `apps/zcode-cli/AGENTS.md:11`:
resource boundaries are "token/context limit 自动 compact、用户取消、权限拒绝、
工具超时、输出截断、provider retry 上限" — never tool-call count limits.

**Rapid-refill breaker** (`turn-loop-state.ts:21-22, 154-186`):
`RAPID_REFILL_TOOL_TURN_THRESHOLD = 3`, `MAX_CONSECUTIVE_RAPID_REFILLS = 3` —
if a compaction completes but fewer than 3 tool turns pass before the next
would fire, `consecutiveRapidRefills` increments; at 3 the compaction is
BLOCKED with a hard `CompactRapidRefillError` (fail loud, not silent
thrashing).

**ACUTE contrast:** R128-W8 landed the breaker (durable event-log-derived
twin, `evaluateRapidRefill` `ACUTE/agents/compaction.ts:294-319`) and ACUTE's
`assembleWithCompaction` is likewise awaited before each iteration's `chat()`
call, so the finish-before-next-task law already holds. ACUTE has no failure
circuit breaker (its breaker blocks rapid-refill cadence, not summarizer
failures — a different failure family: ACUTE's summarizer failure degrades to
hard trim immediately rather than retrying 3×).

---

## §6 Long-horizon support — memory, todos, files-as-memory, continuation

### 6.1 File-based memory (the cross-session tier)

Storage: a plain directory of Markdown files, one fact per file, YAML
frontmatter `name/description/metadata.type (user|feedback|project|reference)`,
`[[wiki-links]]`, plus `MEMORY.md` — the format contract IS the system-prompt
section (`ZC/context/sections/memory.ts:25-50`: "write to it directly with the
Write tool (do not run mkdir)… Don't save what the repo already records…").
`originSessionId` stamped into frontmatter on every write
(`ZC/memory/origin-session.ts`). **Recall: ONLY `MEMORY.md` enters context** —
hard-capped at 200 lines / 25K chars with a self-teaching warning footer
(`ZC/memory/index-content.ts:3-4, 13-38`: "> WARNING: MEMORY.md is N lines…
Keep index entries to one line under ~200 chars; move detail into topic
files."). The full directory is NEVER injected (a manifest scanner ≤200 files
serves only the extraction agent's dedup checklist,
`ZC/memory/recall/manifest.ts`). Write path: after each successful turn,
`scheduleProjectMemoryExtraction` (`ZC/runtime/helpers/project-memory-extraction.ts:32-81`)
captures a branch-aware message snapshot (bounded by the turn's last message
id) and hands it to a single-flight, cursor-tracking scheduler
(`ZC/memory/extraction.ts:85-179` — coalesces overlapping snapshots, advances
the cursor only on success/no-op, 60s drain on close). The extraction agent
runs ≤5 turns with a TOOL FIREWALL (`ZC/memory/memory-agent-loop.ts:121-163`):
Read/Grep/Glob, read-only Bash, Write/Edit/rm only INSIDE the memory root;
everything else denied with a readable reason that goes back into the loop.
Cheap skip gates: no eligible user prose (≥3 words, non-synthetic) or the
turn already wrote memory directly → no model call.

### 6.2 Todo/task state + post-compact re-injection (the in-session tier)

- **TodoWrite reminder cadence** (`ZC/runtime/helpers/runtime-reminders.ts:81-84,
  126-180`): `TURNS_SINCE_WRITE: 10`, `TURNS_BETWEEN_REMINDERS: 10` — after 10
  assistant turns without a TodoWrite AND 10 since the last reminder, a
  `<system-reminder>` attachment re-injects the nudge + the CURRENT todo list
  (read from session storage, `turn-loop.ts:138-156`), and it is PERSISTED as
  a model-only synthetic notice so cold resume replays it.
- **Goal/target machinery**: `goal_state_change` reminders (deferred to a safe
  position when Stop pauses a goal mid-tool-run — the provider-grammar guard,
  `ZC/runtime/methods/goal-state-reminder.ts:9-38`); the target-continuation
  loop re-enqueues "continue" commands while a goal is active
  (`ZC/runtime/methods/target-continuation-loop.ts:38-63` — yields to pending
  user commands first); `injectTargetStateIntoMessageHistory` re-injects
  target state after rewind/resume (`rewind-message.ts:706`).
- **Post-compact Read-state re-injection** (the earlier doc's D4 — still
  ACUTE's open queue item), `ZC/runtime/helpers/compact-post-reminders.ts:8-51`:

```ts
const maxFiles = input.maxFiles ?? 5;
const maxFileApproxTokens = input.maxFileApproxTokens ?? 5_000;
const maxTotalApproxTokens = input.maxTotalApproxTokens ?? 50_000;
// candidates: readFileState entries with sourceTool === "Read", newest-first,
// skipping .git paths and paths already covered by the PRESERVED entries;
// full content (line-numbered, "Called the Read tool with the following
// input: … / Result of calling the Read tool: …") when ≤5K tokens each and
// ≤50K total, else the pointer line:
// "Note: {path} was read before the last conversation was summarized, but the
//  contents are too large to include. Use Read tool if you need to access it."
```

Emitted as `resume_referenced_session_context` attachments
(`history_continuity` channel) right after the preserved segment — the direct
answer to "what was in the model's hands when the cut happened". Sibling: the
approved PLAN FILE reference (`plan-file-continuity.ts` — the ExitPlanMode
plan persisted at `.zcode/plans/plan-<sessionId>.md`, re-injected after
compaction, capped `PLAN_MODE_MAX_PLAN_CHARS × 4 + 1024` bytes). **Files-as-memory
pattern:** transcript path pointer + plan file + memory files — anything too
big for context becomes a PATH, and the summary prompt + reminder bodies
TEACH the model to re-read them.

### 6.3 Session continuation across compactions

`resumeFromStore` (`ZC/runtime/methods/resume.ts:49-150`): reads the session's
`revert` branch info → `hydrateReadFileStateFromSession` BEFORE context init
(so the single MEMORY.md read-state matches what the provider sees) →
`ensureContextInitialized` → `recoverInterruptedCompactTimelines` →
`hydrateMessageHistoryFromSession` (`ZC/agent/session-history-hydrator.ts:54-199`)
rebuilds `RuntimeMessageEntry[]` from the persisted log: interrupted tools →
`[Tool execution was interrupted before resume]`; empty assistants with valid
usage KEPT as anchors; completed tool attachments re-hydrated as real media
blocks. **Compact-aware branch selection** (`activeSessionMessages :201-256` +
`ZC/agent/compact-session.ts:4-27`): everything before the LAST compaction
boundary is dropped, then the recorded `preservedSegment`
(`headMessageId..tailMessageId`) is re-inserted right after the summary anchor
message — "keep last round verbatim" is DURABLE across restarts; resume never
re-summarizes. Preserved assistants' usage is re-invalidated on the way in
(`compact-session.ts:49-58`).

**ACUTE contrast:** the R117 SQLite memory (ranked recall, digests, scope
tiers, dedup, the compaction→memory episodic bridge
`ACUTE/agents/compaction.ts:388-407` — a 400-char summary slice, no extra LLM
call) is a stronger RETRIEVAL tier than ZCode's plain files; ZCode's
advantages worth taking are the hard index cap + self-teaching footer (the
earlier doc's D9) and the extraction-subagent firewall IF a background
extractor is ever added. Todo state: ACUTE has the R96-B todos nudge (ONE
unfinished-plan nudge per turn end) but no periodic cadence and no
post-compaction re-injection; the R120-H resume widening
(`RESUME_RECENT_TOOL_RESULTS = 40`, `runtime.ts:266`) covers resume turns
only. **D4 post-compact re-injection remains UNADOPTED — the known queue
item.**

---

## §7 Prompt caching — stable prefix, breakpoints, attachment bubbling

Four cooperating mechanisms:
1. **Section classification** — every context section declares
   `cacheHint: "stable" | "dynamic"`; ordering is stable→dynamic per target
   (`builder.ts:310-325`), so the stable body's bytes never move when dynamic
   sections change.
2. **Breakpoints** — the three system messages each carry
   `cacheControl: {type: "ephemeral"}` (`builder.ts:35, 239-273`); the
   conversation gets exactly ONE breakpoint on the LATEST non-system message
   (`finalizeLatestNonSystemMessageCacheControl`,
   `provider-request-messages.ts:292-314`):

```ts
const cacheControlIndex = options.skipCacheWrite === true
    ? findPreviousNonSystemMessageIndex(messages, latestIndex - 1)   // one step back
    : latestIndex;
messages[cacheControlIndex] = { ...message, cacheControl: { type: "ephemeral" } };
```

   `skipCacheWrite` moves the breakpoint one message back — used for the
   compact prompt so the throwaway query doesn't hold the cache-write
   breakpoint (`:301-305`). All non-system `cacheControl` stamps are cleared
   first (`clearNonSystemMessageCacheControl :326-333`) so exactly one
   exists per request.
3. **Attachment bubbling** (`reorderAttachmentLikeEntries :106-139`) — meta
   attachments float BACKWARDS past tool results to just before the next real
   boundary, keeping their prefix position stable as history grows (the
   explicit design driver, `:43-46`); `goal_state_change` opts out to keep
   causal position.
4. **Compaction preserves the prefix** (`buildPostCompactRuntimeEntries`,
   `helpers/compact.ts:80-87`) and cold-resume rebuilds attachments from
   PERSISTED raw bodies "以保持缓存前缀" (`source.ts:103-105` comment).
Observability: `CacheStats {totalMessages, cachedMessages, lastCacheHit,
cacheReadTokens}` per session (`message-history.ts:68-73, 245-256`) +
`mainTurnCacheHitAggregate` (rolling hit-rate over the active branch,
`turn-model-step-usage.ts:66-158` — reading PERSISTED tokens because
"Compact preserved usage 可能已被清零").

**ACUTE contrast:** still ABSENT on the send side — `ACUTE/agents/chat.ts`
reads `cachedInputTokens` (`usage.inputTokenDetails?.cacheReadTokens`,
`chat.ts:722`) but sends NO `cache_control` breakpoints (no `ephemeral`
anywhere in agent-core) and has no stable/dynamic section ordering (the
earlier doc's D8, still queued; the metric exists, the control loop doesn't).

---

## §8 Fork / revert / continuation — restoring prior context state

**Revert/rewind is a REBUILD, not a patch.** `rewindConversationToMessage`
(`ZC/runtime/methods/rewind-message.ts:404-431`) → `buildConversationRewindPlan`
(`:440-537`): the rewind target may sit BEFORE the current compact boundary —
"定位 edit target 时只能应用 append-only branch cut，compact scope 只用于
provider history，不能提前隐藏 target" (`:458-461`); an assistant anchor is
remapped back to its turn's user prompt for the edit/retry paths. The plan
commits `sessionStore.setRevert({ keptMessageIDs, branchCutAfterMessageID,
branchGeneration, targetMessageID, … })` (`:542-672` — keptMessageIDs
"保存的是本次 rewind 前 active branch 的保留前缀，避免旧分支重新浮出", `:570-571`) and
then **`rebuildConversationDerivedState`** (`:675-739`) restores EVERYTHING:
`messageHistory.reset()` (keeps only the context prefix,
`message-history.ts:258-266`) → `hydrateMessageHistoryFromSession` with the
branch options → `hydrateReadFileStateFromSession` (`:699` — the read cache is
reverted too) → `rebuildContextPrefix` (`:706`) → re-inject target state
(`:707`) → `setCacheMiss()` → `mainTurnCacheHitAggregate` recomputed from PERSISTED
tokens → `turnNumber` recounted → **`autoCompactConsecutiveFailures = 0`** (`:735`).
Background tasks on the removed branch are CANCELLED first (fail-closed — a
branch cut is not committed if a task can't be confirmed stopped,
`cancelRemovedBranchBackgroundTasks :628-663`).
Workspace rewind restores files from `workspace-checkpoints`
(`rewindWorkspaceToCheckpoint`, checkpoint artifacts in the artifact store;
cascade variants chain multiple checkpoints). Fork:
`session-fork.ts`/`stable-fork-boundary.ts` — fork boundaries ride
`conversation_fork` reminders and `NON_MID_CONVERSATION_SYSTEM_SOURCES`
("Fork 和辅助对话边界必须位于新问题之前", `source.ts:76-86`).

**ACUTE contrast — the owner's "reverting should revert the context" is
already structural:** `revertSession` (`ACUTE/storage/sessions.ts:1386-1440`)
DELETES events `seq >= keepThroughSeq` in one transaction + appends a
`session.reverted` marker; because `assembleHistory`/`assembleWithCompaction`
are PURE over the event log (ADR-0010 append-only discipline), the next turn's
context is exactly the pre-revert state — including ROLLING BACK any
compaction event deleted by the revert (the summary vanishes with its seq).
`forkSession` (`sessions.ts:1293-1350`) copies the event log byte-identical
via `INSERT…SELECT` — the fork's first turn reassembles the same compacted
context. The deltas vs ZCode: ACUTE's revert is destructive (ZCode's branch
cut is append-only and reversible via branchGeneration), and ACUTE does not
revert a read-file cache (it has none — the read state IS the event log).

---

## §9 The D1–D5 decision set — re-verification against current source

The earlier doc's §D ranked five near-term adoptions. Status against the
R128 ACUTE tree (evidence above):

| # | Decision (earlier doc) | ZCode evidence (re-verified) | ACUTE status |
|---|---|---|---|
| **D1** | Provider-usage token anchoring | `compact.ts:313-340` `buildProviderUsageTokenOverride` — reverse scan, provider base + estimated tail, both numbers reported | **LANDED (R125-C)** — `providerUsageAnchor` `ACUTE/agents/compaction.ts:527-572`, threaded at both runtime call sites (`runtime.ts:2393, 3863`) and the context meter (R127-W4). Byte-identical law, stronger estimator beneath it. |
| **D2** | Trigger-point + typed reason codes | `policy.ts:41-65` `AutoCompactDecision` + `shouldAutoCompact:90-155` (5 reasons, every skip logged) | **LANDED (R125-C)** — `CompactionDecisionFields` `compaction.ts:173-185` on every planCompaction path (4-reason ACUTE vocabulary: forced/above_threshold/below_threshold/empty_to_summarize), persisted additively on the event. |
| **D3** | Round-preserving selection + durable preserved segment | `rounds.ts:1-35`; `compact-selection.ts:30-57` (preserve last round on Auto/Reactive); `compact-preservation.ts:13-45` (preservedSegment ids in the boundary); `message-history.ts:426-442` `invalidateRuntimeTokenUsage` | **LANDED (R128-W8) as D3a+D3b** — round-aligned selection with the 1.25× materiality guard (`compaction.ts:607-745`) + anchor invalidation at the compaction boundary (`:535-548`). Structural note: ACUTE records `throughSeq` + `preservedRounds` instead of ZCode's `preservedSegment` id-triple; the keep set is RE-DERIVED per assembly from the pure event fold, which achieves the same durability (the kept messages ARE the raw events) without a segment index — the id-triple's only extra power is O(1) segment lookup on cold resume, which ACUTE's fold gives for free. |
| **D4** | Post-compact Read-state re-injection | `compact-post-reminders.ts:8-51` (5 files / 5K each / 50K total / pointer lines / .git skip / preserved-path dedup) + plan-file reference `plan-file-continuity.ts` | **STILL UNADOPTED — the known remaining queue item.** ACUTE has no read-file state (the event log is the state), but the equivalent is synthesizable at assembly time from `tool.use` events (the R120-H path extraction `pathFromArgsSummary` `runtime.ts:282-289` already exists; the keep-set dedup equivalent is "skip files whose read events sit after `throughSeq`"). See adoption table A1. |
| **D5** | Rapid-refill circuit breaker | `turn-loop-state.ts:21-22, 154-186` + `turn-loop.ts:91-98` (hard error) | **LANDED (R128-W8)** — `evaluateRapidRefill` `compaction.ts:294-319`, durable (event-log-derived, survives restarts — stronger than ZCode's in-memory tracking), AUTO-only, one teaching `turn.warning` per episode, force/manual/trim immune. |

Earlier-doc companions, for completeness: D6 (tool-result budget unification
+ artifact spill) — **still queued**, and now the top structural gap given D5
landed; D7 (output-token continuation) — still queued; D8 (cache breakpoints)
— still queued; D9 (memory index caps + firewall) — partially inherent in
ACUTE's own memory design; D10 (chars/3, async snapshot machinery,
microcompact-default-on) — correctly rejected then and now.

---

## §10 ACUTE-CODE adoption table (ranked)

License note: ZCode is **Apache-2.0** — every pattern below is
license-clean for adoption (patterns/ideas, not verbatim code copying, per the
no-GPL / MIT-Apache-only discipline; we write our own implementation in every
case, as R125-C/R128-W8 did).

| # | Pattern (ZCode file:line) | Verdict | Concrete ACUTE seam |
|---|---|---|---|
| **A1** | Post-compact Read-state re-injection (`compact-post-reminders.ts:8-51`) — D4 | **ADOPT** | `agents/compaction.ts` `assembleWithCompaction`: after a compaction lands, derive the ≤5 most-recent distinct `read_file` paths from `tool.use` events ABOVE the keep boundary (reuse `pathFromArgsSummary`), emit one synthetic user message — pointer lines by default (ACUTE's read results already ride the event log; the model can re-read via the read_file tool, and ACUTE has no content cache to re-inject verbatim, so the POINTER-line tier is the honest adaptation; full-content tier only if we later add a read-state map). Bound it: 5 paths, one message, additive `reInjectedFiles` count on the event payload. ~80 lines + tests. |
| **A2** | Tool-result budget unification + artifact spill (`result-serialization.ts:33-40, 178-198`; `mcp/index.ts:125-151`) — D6 | **ADOPT** (the owner's "useless unneeded data" complaint) | New `tools/result-budget.ts` + the tool executor's output path: a per-tool `resultBudget {maxModelChars, strategy: "truncate"|"artifact"}`; artifact = spill to `<dataDir>/artifacts/<sessionId>/<toolCallId>.txt` + a pointer + head preview in `outputSummary`. Priority targets: exec/terminal output (tail preview), search results, sub-agent reports. This is the structural partner of D5: oversized results stop being compaction fuel. Note our `MAX_TOOL_BLOCK_CHARS=48K` replay cap already bounds HISTORY; the budget bounds the PERSISTED payload at source (better for resume + the meter). |
| **A3** | Preflight output cap (`model-token-limits.ts:17-41`) | **ADAPT** | `resolveTurnBudget` consumers: per model step, cap `maxOutputTokens` at `min(modelMax, window − estimatedCurrentUsage − 1000)` using the EXISTING providerUsageAnchor number. Small, pure, kills a whole failure family (request rejected because output reservation overran the window). Additive in `runtime.ts`'s chat-call sites or inside `chat.ts`'s request build. |
| **A4** | Cache breakpoints + stable/dynamic split (`builder.ts:230-277`; `provider-request-messages.ts:292-314`) — D8 | **ADAPT** | `agents/chat.ts` request build: when `apiFormat` is anthropic, set `cache_control: {type:"ephemeral"}` on the last system block + the last message (Anthropic allows 4 breakpoints; 2 is the safe start); then verify via the existing `cachedInputTokens` accounting (measurement → control loop). The stable/dynamic prompt re-architecture is NOT needed first — ACUTE's prompt is already mostly stable (agent prompt + registry), so the single history breakpoint carries most of the win. Provider-conditional (OpenAI-compatible providers ignore it — verify per format). |
| **A5** | Output-token continuation (`turn-output-token-continuation.ts:12-76`) — D7 | **ADAPT** | `chat.ts` already surfaces finish reasons to the runtime; on `length` + no tool calls, append the one-line resume nudge through the EXISTING in-memory `pendingNudge` channel (never persisted — the `queryScope` twin) with a 3-cap and an honest terminal error at exhaustion. ACUTE's nudge machinery makes this ~60 lines. |
| **A6** | Summary-prompt-too-long resilience (`compact-selection.ts:59-139, 279-335`) | **SKIP (for now)** | ACUTE's summarizer input is bounded by design (the 60% keep window means the summarize set is ~40% of window — it fits by construction unless the provider window is tiny). Revisit only if a provider's effective window makes the summarize set itself overflow; the token-gap regex `/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i` is the piece worth stealing then. |
| **A7** | Microcompact (`compact/microcompact.ts`) | **SKIP** | Same verdict as the earlier doc's D10: ZCode ships it OFF; ACUTE's replay-window stubbing (RECENT_TOOL_RESULTS=8) already gives the token relief without a second persistence path; after A2 lands, clearing semantics are moot for oversized results. |
| **A8** | Per-source reminder taxonomy (`system-reminder/source.ts`) | **ADAPT (long-term)** | ACUTE's synthetic injections (resume note, todos nudge, telemetry block) are ad-hoc today. A lightweight typed registry (channel/lifecycle/persisted-vs-ephemeral) would give the same governance — but it's an architecture refactor, not a fix; queue behind A1-A5. |
| **A9** | Context-usage category snapshot (`context-usage.ts:119-253`) | **ADAPT (cheap slice)** | ACUTE's GET /sessions/:id/context already has breakdown slices; the one ZCode idea worth adding is per-TOOL-SCHEMA token estimates (serialize the tool contract and estimate) — the "why is my prompt 40K tokens" answer. Low priority. |
| **A10** | Todo reminder cadence (`runtime-reminders.ts:81-180`) | **ADAPT** | ACUTE's R96-B todos nudge fires once at turn end; ZCode's 10-turn/10-turn cadence with the CURRENT todo list re-injected is the long-horizon anti-drift upgrade. Cheap: reuse the persisted todo events. |
| **A11** | Preserved-segment id-triple (`compact-preservation.ts:13-45`) | **SKIP** | See §9 D3 note: ACUTE's pure fold gives the same durability; the id-triple adds nothing for us today. |
| **A12** | Chars/3 estimator | **SKIP** | ACUTE's R64 estimator is strictly better (the earlier doc's D10 verdict stands). |

Ordering recommendation for the next implementation round: **A1 (D4 — the
named queue item) → A3 (preflight cap, tiny) → A2 (result budgets — the
owner's "useless data" complaint) → A5 → A4 → A10**. A1+A3 are one small wave
each; A2 is a medium wave (new module + per-tool contracts + tests); A4 needs
provider-format verification against the owner's OpenAI-compatible endpoint.

---

## Sources

- Clone: `/tmp/ref-zcode` @ `29628c9` ("feat: update v3.14.3"), branch `main`,
  Apache-2.0 (`LICENSE`).
- Primary files (all `apps/zcode-cli/packages/core/src/` unless noted):
  `context/builder.ts`, `context/types.ts`, `context/dynamic-sections.ts`,
  `context/sections/{env-info,memory,request-user-context}.ts`, `context/utils.ts`,
  `context-history-entries.ts`, `context-refresh.ts`,
  `system-reminder/source.ts`,
  `runtime/helpers/{provider-request-messages,provider-mid-conversation-system,
  compact-selection,compact-preservation,compact-post-reminders,compact,
  runtime-reminders,plan-file-continuity}.ts`,
  `runtime/methods/{turn-loop,turn-loop-state,turn-output-token-continuation,
  compact,compact-active,turn-model-step,context-usage,turn-model-step-usage,
  model-token-limits,rewind-message,rewind,resume,context,microcompact,
  goal-state-reminder,target-continuation-loop}.ts`,
  `compact/{policy,manual,prompt,rounds,microcompact}.ts`,
  `agent/{message-history,session-history-hydrator,compact-session}.ts`,
  `memory/{index-content,extraction,memory-agent-loop,origin-session}.ts`,
  `tool/executor/result-serialization.ts`, `mcp/index.ts`,
  `tool/read-file-state.ts`; `packages/shared/src/{model-config,usage-stats}.ts`;
  `config/provider/zcode-builtin.json`; `apps/zcode-cli/AGENTS.md`.
- ACUTE-CODE (R128 tree, read-only): `agent-core/src/agents/compaction.ts`
  (1009 L), `agent-core/src/agents/runtime.ts` (5487 L),
  `agent-core/src/agents/chat.ts`, `agent-core/src/agents/prompts.ts`,
  `agent-core/src/context.ts`, `agent-core/src/tools/fs-ops.ts`,
  `agent-core/src/storage/sessions.ts` (forkSession/revertSession),
  `agent-ctx/research/zcode-context-compression.md` (prior study), the
  worklog's R125-C/R127-W4/R128-W8 records.
