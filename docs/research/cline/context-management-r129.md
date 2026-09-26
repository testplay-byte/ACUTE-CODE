<!-- last-reviewed: 2026-09-26 round-129 -->
# Cline — Context-Window Management (R129 deep dive)

- **Target:** https://github.com/cline/cline
- **Studied:** 2026-09-26, `main` @ `29896ec7fa8e2dd98805b56c2dae987d59fc9baa` (2026-09-25, "fix(llms): stop double-counting reasoning tokens in outputTokens"), shallow clone at `/tmp/ref-cline`
- **License:** Apache-2.0 (stock text, `Copyright 2026 Cline Bot Inc.` at `LICENSE:189`) — compatible with ACUTE-CODE's allowlist; pattern study only, no code copied.
- **Scope:** the owner's R129 ask — "research how they handle their context window, how they build the context window along the way, how they process the things… what should be included, what should not… how the context compression works and how each and every single one of the things gets managed."

**Read this first — the engine moved.** The classic VS Code extension engine (`src/core/task.ts` with `ApiMessage[]`, `api_conversation_history.json`, `<environment_details>` XML, the "Showing only 8 lines… use read_file to re-read" truncation) has been **deleted from `main`**; the classic `api_conversation_history` string now appears only in legacy-state readers (`apps/vscode/src/sdk/legacy-state-reader.ts`) and test fixtures. All context management now lives in the SDK engine under `sdk/packages/`. Every claim below is from the current engine; where the question references a legacy behavior I say so explicitly and mark it `[LEGACY — not on main]`. Notably: the owner's remembered **~64% auto-compact threshold belongs to the retired classic implementation and is not verifiable in this clone** — current main compacts at **90%** of the usable input budget (`COMPACTION_TRIGGER_RATIO = 0.9`).

All paths below are relative to `/tmp/ref-cline/`.

---

## 0. Map of the context-management code

| Concern | File |
|---|---|
| Compaction trigger + strategy dispatch (the `prepareTurn` pipeline) | `sdk/packages/core/src/extensions/context/compaction.ts` (812 lines) |
| Shared constants, cut selection, summary prompt/message, token estimator | `sdk/packages/core/src/extensions/context/compaction-shared.ts` (793) |
| Deterministic no-LLM strategy ("basic") | `sdk/packages/core/src/extensions/context/basic-compaction.ts` (712) |
| LLM-summarizing strategy ("agentic") | `sdk/packages/core/src/extensions/context/agentic-compaction.ts` (318) |
| Budget projection (truncate→drop closure→fail honestly) | `sdk/packages/core/src/extensions/context/budget-projection/project.ts` (676) |
| Per-request API-safe message rewrite (caps, stale reads, media budget) | `sdk/packages/core/src/session/services/message-builder.ts` (1727) |
| Tool executor output caps | `sdk/packages/core/src/extensions/tools/executors/output-limits.ts`, `file-read.ts` |
| Agent loop: `prepareTurn` per request, overflow recovery, usage capture | `sdk/packages/agents/src/agent-runtime.ts` (2825) |
| Token estimation | `sdk/packages/shared/src/llms/tokens.ts` |
| Compaction sidecar ("shadow") state | `sdk/packages/core/src/session/models/session-compaction.ts` (205) |
| System prompt builder | `sdk/packages/shared/src/prompt/cline.ts` + `prompt/system/act.ts` |
| Checkpoints (git) + message-trim restore | `sdk/packages/core/src/hooks/checkpoint-hooks.ts`, `session/checkpoint-restore.ts` |
| UI context-window meter | `apps/vscode/webview-ui/src/components/chat/task-header/ContextWindow.tsx` |

---

## 1. Per-turn context assembly

**The messages array is rebuilt from canonical state every request; raw history is never sent.**

- The runtime keeps canonical `state.messages` (`MessageWithMetadata`). Before **every** model request — `agent-runtime.ts:1613` (`request = await this.prepareTurnForModelRequest(request, options)`) inside `prepareModelRequest`, which runs on every loop iteration — two transformations run:
  1. `prepareTurn` (the compaction pipeline, §3) receives **both** the canonical messages and the **API-projected** messages: `session-runtime-orchestrator.ts:1165-1187` builds `apiMessages = await this.prepareProviderMessagesForApi(messages)`, which chains plugin message builders then `this.messageBuilder.buildForApi(...)` (`session-runtime-orchestrator.ts:1211-1221`). Token budgeting is therefore computed against the *truncated* request shape, not the raw transcript.
  2. `MessageBuilder.buildForApi` (`message-builder.ts:166-205`) produces a **copy**: reindex → commit stale-read rewrites → synthesize missing tool results → per-block transforms (§2) → media budget → aggregate text budget. Header comment: "Builds an API-safe message copy without mutating original conversation history" (`message-builder.ts:106-107`).
- **System prompt is stable per session, not rebuilt per turn.** `buildClineSystemPrompt` (`shared/src/prompt/cline.ts:152-213`) does placeholder substitution over a persona template (`prompt/system/act.ts:1-36`): platform, date, IDE, CWD in a small `<env>` block, plus `{{CLINE_RULES}}` (.clinerules/skills/workflows) and `{{CLINE_METADATA}}` (workspace JSON: root, hint, redacted git remotes, branch, commit — `processWorkspaceInfo`, `cline.ts:79-96`). The VS Code host builds it once at session creation (`apps/vscode/src/sdk/cline-session-factory.ts:1082`) and passes it as fixed config; mode (plan/act) and rules are the only variants. There is **no per-turn `<environment_details>` re-injection and no workspace file listing in the prompt on main** — the codebase index / file awareness comes from tools, not the prompt. `[LEGACY]` The classic extension appended `<environment_details>` (open tabs, workspace file tree, git state) to the *last user message* of every request; that code is gone.
- User messages carry mode wrappers: `<user_input mode="...">` + `<mode_notice>` on switch (explained in `MODE_TAG_INSTRUCTIONS`, `cline.ts:15-17`); first-turn images/files are attached as content blocks by `user-input-builder.ts:10-37` (data-URL images parsed to base64 blocks, files loaded via an injected loader).
- The prior legacy question "the famous 8-line + 'lines hidden' file-read truncation": on main the read tool returns **line windows with an honest footer** instead — `file-read.ts:184-188`:
  ```ts
  return (
      `${body}\n\n` +
      `[Showing lines ${requestedStartLine}-${lastCapturedLine} of ${totalLineText}. ` +
      "Use start_line/end_line to read other sections.]"
  );
  ```
  and the tool description teaches paging: "Each read returns at most 2000 lines / ~47k characters; longer files report their total line count, page through them with start_line/end_line" (`definitions.ts:274-278`).

## 2. Inclusion / exclusion — what enters context and what never does

**Executor-side caps (what a tool may emit at all)** — `executors/output-limits.ts:17-50`:
```ts
export const MAX_COMMAND_OUTPUT_CHARS = 48_000;   // head+tail, middle elided
export const MAX_READ_LINES = 2_000;
export const MAX_LINE_CHARS = 2_000;              // "[line truncated]" per line
export const MAX_READ_OUTPUT_CHARS = 48_000;
export const MAX_SEARCH_OUTPUT_CHARS = 48_000;
```
`truncateCommandOutput` (`output-limits.ts:20-38`) keeps head+tail halves and puts the recovery advice **in the preserved edges**: `[... output truncated: N chars total. Refine the command (grep, head, tail) to view the elided middle ...]`. File reads stream line-by-line with per-line and per-window caps plus a 10 MB file limit and a 100 MB stream guard (`file-read.ts:52-59, 134-148`); images are read as base64 blocks only when the model supports them (`file-read.ts:231-252`).

**Request-build caps (what may be re-sent)** — `message-builder.ts:28-42`:
```ts
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;        // per tool result, middle-cut
export const DEFAULT_MAX_FILE_CONTENT_CHARS = 50_000;      // user-attached file content
export const DEFAULT_MAX_TOTAL_TEXT_BYTES = 6_000_000;     // whole-transcript overflow valve
export const DEFAULT_MAX_ASSISTANT_TEXT_CHARS = 200_000;
export const DEFAULT_MAX_ASSISTANT_TOOL_MARKUP_CHARS = 12_000; // repeated tool-call markup
export const DEFAULT_MIN_OUTDATED_REWRITE_BYTES = 65_536;  // stale-read rewrite batching
```
- **Every** tool result (built-in, MCP, custom SDK) is middle-truncated (`transformBlock` → `truncateToolResultContent`, `message-builder.ts:271, 1064-1084`) — the comment at `:268-270` is explicit: "Truncation is default-on for every tool result: MCP and custom SDK tools produce payloads just as large as the built-in ones, and any allowlist gate silently exempts them."
- **Stale read results are rewritten deterministically.** The builder indexes every `read`/`read_files` tool_use → result pair by `path:start-end` locator (`message-builder.ts:736-894`); when a newer read of the same locator (or any full-file read of the same path) exists, the older result's content is replaced with `"[outdated - see the latest file content]"` (`OUTDATED_FILE_CONTENT`, `:49`, applied `:912-969`). Rewrites are **batched until ≥64 KB is reclaimable** to avoid busting provider prefix caches every re-read (`:335-418`, comment `:37-38`). Rollback can un-stale a locator (`:367-377`).
- **Missing tool results are synthesized** as `"Tool execution was interrupted before a result was produced."` with `is_error: true` (`addMissingToolResults`, `:502-711`) so no orphaned tool_use is ever sent.
- **Assistant text caps**: 200 K chars generally, 12 K when the text contains ≥8 repeated tool-call markup tags (degenerate verbatim-repetition guard, `:1148-1159`).
- **Images**: a media budget of 5 MB encoded / 6 MB decoded per image and 8 MB total per request (`shared/src/llms/media.ts:80-83`); over-budget images become `IMAGE_OMITTED_PLACEHOLDER` text (`message-builder.ts:1449-1477`). In compaction summaries images collapse to `[image:image/png]` markers (`compaction-shared.ts:104-109, 177-181`).
- **Old user attachments are dropped**: once a turn is old enough to be compacted, its `file`/`image` blocks are stripped — "Attached files and images are stale context bloat once the turn is old enough to compact; the dropped-work summaries carry file paths. Only the latest typed prompt keeps its attachments" (`basic-compaction.ts:95-114`). At request-build time user attachments get the looser 50 K cap (`message-builder.ts:232-244`).
- **Thinking blocks** are dropped from archived older assistant finals (`sanitizeOlderAssistantFinal`, `basic-compaction.ts:428-441`) and truncated to 2 000 chars when flattened into summarizer input (`compaction-shared.ts:159`).
- **Never enters context at all**: raw terminal transcript beyond the caps, full file contents beyond the read window, secrets in git remote URLs (`redactRemoteUrlCredentials`, `cline.ts:55-77`), unredacted provider credentials, and (in the SDK) `metadata.displayOnly` messages (`session-compaction.ts:40-44`).

## 3. Compression / compaction — the core mechanism

Compaction is a **`prepareTurn` hook** built by `createContextCompactionPrepareTurn` (`compaction.ts:267-686`), dispatched before every model request. Auto mode:

```ts
// compaction.ts:354-362 (abridged)
const underestimateFactor = actualPreviousInputTokens > 0 && requestInputTokens > 0
        ? Math.min(MAX_INPUT_UNDERESTIMATE_FACTOR, Math.max(1, actualPreviousInputTokens / requestInputTokens))
        : 1;
const maxInputTokens = rawMaxInputTokens / underestimateFactor;
const requestTriggerTokens = maxInputTokens * COMPACTION_TRIGGER_RATIO;
const shouldCompact = requestInputTokens >= requestTriggerTokens;
```

Constants (`compaction-shared.ts:13-35`):
```ts
export const DEFAULT_MAX_INPUT_TOKENS = 128_000;
export const CONTEXT_WINDOW_INPUT_RATIO = 0.9;   // usable = 90% of contextWindow
export const COMPACTION_TRIGGER_RATIO = 0.9;     // compact at 90% of usable budget
export const MAX_INPUT_UNDERESTIMATE_FACTOR = 4; // provider-actual/estimate cap
export const DEFAULT_TARGET_RATIO = 0.7;         // auto target = 70% of trigger
export const DEFAULT_PRESERVE_RECENT_TOKENS = 20_000;
export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 8_192; // raised from 4096
```

Two strategies (`BUILTIN_COMPACTION_STRATEGIES`, `compaction.ts:161-186`), default `agentic`:

**(a) Agentic (LLM summary).** `runAgenticCompaction` (`agentic-compaction.ts:116-318`):
1. `findCutIndex` walks back accumulating tokens until `preserveRecentTokens` (default 20 K), then **never splits a tool pair** — the cut walks back to a safe boundary (assistant message or typed-user turn; a tool_result-only user message is never safe because its tool_use sits in the preceding assistant — `compaction-shared.ts:329-376`), and never summarizes away the latest typed user prompt (`:362-371`).
2. Everything before the cut is serialized to a flat transcript (`serializeMessage`, `compaction-shared.ts:146-190`): `[User]: …`, `[Bot tool calls]: read_files({…})`, `[Tool result]: <2 000-char-truncated content>`, `[Bot thinking]: <2 000 chars>`, `[Bot image]: image/png`.
3. The summary request (`buildSummaryRequest`, `:669-703`) asks for a fixed structure:
   ```
   Summarize this session for continuation. Be concise and factual.
   ## Goal  — one sentence: what is being built or fixed.
   ## State — Done / In Progress / Blocked
   ## Highlights — key technical choices or notable findings
   ## Next  — immediate next steps
   ## Files — Read: … Edited: …
   [Previous summary: …]
   Conversation: <flattened transcript>
   ```
   with the system prompt "Summarize the provided coding session into a concise continuation note with detailed next steps." (`agentic-compaction.ts:80`). The previous compaction summary is **folded in** (summary-of-summaries; only messages after the last summary are re-serialized — `:139-151`).
4. The summarizer is the same provider/model with `thinking: false` and `maxOutputTokens: 8 192` (raised because reasoning models would otherwise spend the whole budget thinking and return no text — `resolveSummarizerConfig`, `compaction-shared.ts:705-766`), or a separately configured `compaction.summarizer` model.
5. `ensureFilesSection` re-appends the deterministic `## Files` section (read/modified lists extracted from tool_use inputs — `extractFileOps`, `:424-461`) if the model omitted it (`:659-667`).
6. Result = one summary message + the preserved tail (`agentic-compaction.ts:283-291`). The summary message is a **user-role message with `metadata.displayRole: "system"` and `kind: "compaction_summary"`** carrying `{summary, details:{readFiles, modifiedFiles}, tokensBefore, generatedAt, userRunSpan}` (`buildSummaryMessage`, `:768-792`) — the "previous conversation was summarized" notice the model sees is the message itself: `Context summary:\n\n{summary}`.

**(b) Basic (deterministic, no LLM).** `runBasicCompaction` (`basic-compaction.ts:452-711`): typed user prompts always survive (sanitized); the latest typed turn keeps newest messages within the target, with the kept suffix snapped forward to an assistant message so no tool pair splits (`:517-548`); older turns keep their **concluding assistant answer** (thinking stripped) newest-first while they fit (`:552-584`); everything dropped is re-surfaced as a `<SYSTEM_NOTICE>` block attached to the surviving prompts:
```ts
// basic-compaction.ts:89-92
text: `<SYSTEM_NOTICE>\nEarlier context was compacted. Summary of your actions after the request above:\n${formatToolActivitySummary(summary)}${responsesSection}</SYSTEM_NOTICE>`,
```
where the tool-activity summary is **deterministically extracted** — files read (with line ranges), files edited (line ranges parsed from numbered diff output, `compaction-shared.ts:520-554`), commands run (≤100 chars each) — plus the **last 3 assistant texts preserved verbatim** (`PRESERVED_ASSISTANT_TEXT_COUNT = 3`, `:61`, `:140-165`). Survivors of an earlier compaction are **frozen** (`metadata.compaction = "preserved"`, `:395-421`) so repeated compactions only process the new tail. Adjacent typed user turns are merged, each gap bridged by its dropped-work summary (`mergeAdjacentUserTurns`, `:125-291`). Both strategies finish through `buildBudgetProjection` (§9) and are no-ops when nothing changes (`:635-637`).

**Fallback ladder:** agentic throws → basic runs (`compaction.ts:546-565`); empty summary text → skipped with a logged likely-cause (`agentic-compaction.ts:259-276`); overflow recovery → basic (or a custom compactor held to the same "strictly smaller and within target" bar) so **recovery never depends on another successful LLM request** (`compaction.ts:480-543`).

**Tool pairs in the result:** preserved tail keeps native `tool_use`/`tool_result` blocks; the summarized head is **flattened to text** (the summary message + dropped-work notices). Only basic compaction ever keeps verbatim old tool pairs (frozen survivors).

## 4. Token counting

- **Estimate:** chars/3, deliberately over-counting — `shared/src/llms/tokens.ts:1-12`: "Uses 3 chars/token (slightly over-counts vs the conventional 4) so trigger thresholds fire before provider rejection rather than after." `estimateRequestInputTokens` (`:47-67`) JSON-stringifies `{systemPrompt, messages, tools}` **including tools and system prompt** so "request execution and pre-request policies use the same definition of input utilization."
- **Provider actuals:** the runtime records the provider's own `usage.inputTokens` from every response — `agent-runtime.ts:1884-1893` (`state.lastRequestInputTokens = event.usage.inputTokens`) — and threads it into the next `prepareTurn` as `previousRequestInputTokens` (`:2158-2161`). The compaction gate uses it as the **underestimate factor**: if the provider's real count for the previous request exceeds our estimate for the (larger) current transcript, the whole budget is scaled down by that ratio, capped at ×4 (`compaction.ts:329-354`).
- **Per-message estimator** is a WeakMap-cached JSON-length estimate (`createTokenEstimator`, `compaction-shared.ts:196-214`).
- **Model limits:** `ModelInfo` carries optional `maxTokens`, `contextWindow`, `maxInputTokens` (`shared/src/llms/model-info.ts:260-262`) from the provider catalog (`sdk/packages/llms/src/catalog/catalog.generated.ts`); resolution is `min(maxInputTokens, contextWindow)`, else `contextWindow × 0.9` (`resolveEffectiveMaxInputTokens`, `compaction-shared.ts:63-82`).
- **UI meter:** `ContextWindow.tsx:102-111` — `percentage = (lastApiReqTotalTokens / contextWindow) × 100`, i.e. **provider-reported tokens of the last request over the catalog context window**, rendered as a progress bar with in/out/cache breakdown on hover. A "Compact the current task?" dialog triggers a real manual compaction RPC, never a literal "/compact" prompt (CLINE-2503 note, `:83-94`).

## 5. Auto-compaction: when it fires, and the overflow path

- Fires **before every model request** (auto mode) whenever `requestInputTokens ≥ 0.9 × usable budget` — auto-skip otherwise returns `undefined` and the request goes out untouched (`compaction.ts:386-388`).
- **Targets** (`compaction.ts:210-228`): `trigger × 0.7` normally; for long conversations (≥5 user/assistant pairs) on models whose `maxTokens` < input budget, **50% of max input** (`LONG_CONVERSATION_TARGET_RATIO = 0.5`) so a long task doesn't immediately re-trigger.
- Status notices `auto-compacting` / `auto-compacted` with tokensBefore/After, messagesBefore/After are emitted as events (CLI renders "Context compacted · 45.2k → 12.1k tokens · 34 → 6 messages", `apps/cli/src/tui/utils/compaction-status.ts:63-102`).
- **Provider-rejected overflow** (`context_window_exceeded`): `generateAssistantMessageWithOverflowRecovery` (`agent-runtime.ts:1276-1321`) — **one recovery attempt per run** (`overflowRecoveryAttempted`, `:575-576`); emits `"context window exceeded — compacting and retrying"`; the retry's `prepareTurn` runs with `overflowRecovery: true` which forces compaction regardless of estimates and **must return a strictly smaller request** (serialized-length proxy check, `:2171-2194`) or a terminal `ContextWindowOverflowError` is thrown. A second overflow on the retry throws the terminal "still exceeds after compacting" message (`:1311-1319`).
- **Output-token cut-off recovery:** a text-only turn truncated at `max_tokens` (common on local servers that cap generation at remaining context) also forces one compaction+retry (`retryTruncatedTurnWithCompaction`, `:1394-1508`), separate from the loop's nudge-retry (≤3 consecutive cut-off turns, `MAX_TOKENS_RECOVERY_LIMIT = 3` with a conciseness nudge, `:61-75`).
- **Transient provider errors** (rate limits, 5xx, network — never auth/overflow/client errors) retry ≤3 times with 1 s → 15 s doubling backoff (`:87-91`); the retry re-issues the *same prepared request* without re-compacting (`:1423-1433`).

## 6. Long-horizon support — surviving condensing

- **Summary structure** is fixed (Goal/State/Highlights/Next/Files) and the Files list is **guaranteed** (deterministic extraction + `ensureFilesSection`), so task, decisions, tool outputs, and file state survive in a known shape.
- **Shadowing (the key architecture):** the canonical transcript is never destroyed. Compaction state is persisted as a **sidecar** — `SessionCompactionState { version, source_message_count, source_prefix_hash (sha256 over role/content/durable metadata, id/ts deliberately excluded), messages: compacted, system_prompt }` (`session-compaction.ts:25-138`). Every turn, `createCompactionStateAwarePrepareTurn` (`compaction.ts:745-812`) **projects**: `[...compacted messages, ...canonical tail after source_message_count]`, validated by prefix hash. The VS Code host's comment is explicit: "The VSCode coordinator persists that sidecar without replacing the canonical transcript, so the active session and later resumes use compacted working context while saved messages remain intact" (`apps/vscode/src/sdk/sdk-compaction.ts:9-11`). CLI divider copy: "Compacted working context carried over · saved history remains N messages" (`compaction-status.ts:83-85`).
- **Re-compaction starts from the projection + tail**, keeping automatic turns bounded; manual `/compact` is the path to a fresh full-history summary (`compaction.ts:766-769` comment).
- **TODO/task lists:** cline has no per-turn TODO re-injection on main (the todo-like state is the summary's `## State`/`## Next` sections + frozen preserved answers).
- **File state re-listing after compaction:** the `## Files` section (read/edited lists with line ranges) — carried in the summary message metadata (`CompactionSummaryMetadata.details`) and re-merged across compactions (`extractFileOps` folds prior summaries' lists, `compaction-shared.ts:427-461`).
- **Run spans:** every message carries `metadata.userRunSpan` (how many user runs a folded message covers; synthetic notices have span 0 — `user-run-messages.ts:17-25`), which is what lets checkpoint restore and forking reason about compacted transcripts (§8).
- **Foreign-session import:** the first turn of a session imported from another agent folds the whole foreign transcript into one summary (manual mode, `preserveRecentTokens: 0`, one attempt per session start, falls back to raw transcript on failure) — `createImportedHistoryCompactionPrepareTurn`, `compaction.ts:688-743`.

## 7. Prompt caching

- **Anthropic cache_control placement:** `cache_control: { type: "ephemeral" }` (`createEphemeralCacheControl`, `providers/routing/utils.ts:11-15`) is attached to **the last text part of the last user message** of every request — `ai-sdk.ts:415-424`: walk messages backwards, first `role === "user"` wins, `applyPromptCacheToLastTextPart` (`anthropic-compatible.ts:110-173`) stamps `providerOptions` on the final text part. This is a **rolling single breakpoint**: each request caches the prefix up to the newest user turn, so the next request's prefix (which extends it) hits the cache; Anthropic's documented ~5-minute ephemeral TTL then refreshes naturally on each turn of an active session. (The classic extension's code comments about the 5-min TTL are gone with it — current source carries no TTL note; the TTL is an Anthropic platform property, not engine logic.) For non-Anthropic OpenAI-compatible gateways the same marker rides `providerOptions.openaiCompatible.cache_control` (Qwen-style), with a filler text part so the multipart shape survives (`anthropic-compatible.ts:121-136`).
- Routing is metadata-driven (`promptCache: { format: "anthropic-cache-control", routes: [...] }`, `anthropic-compatible.ts:46-88`); Bedrock gets a `cachePoint` content block appended after the last user message (`bedrock-cache-point.ts`).
- **Cache-awareness shapes other layers:** the aggregate text budget is deliberately huge (6 MB) because "budget truncation rewrites bytes mid-transcript, which invalidates provider prefix caches from the first rewritten block onward, so it must remain a rare overflow valve rather than the steady state" (`message-builder.ts:30-34`); stale-read rewrites batch at 64 KB for the same reason (`:37-39`). The stable per-session system prompt (§1) keeps the system+tools prefix cacheable.
- Usage tracks `cacheReadTokens`/`cacheWriteTokens` per message and aggregates them through compaction (`basic-compaction.ts:306-361`, `agent-runtime.ts:2231-2249`).

## 8. Fork / restore — checkpoints

- **Storage: git plumbing, no shadow repo.** Every run snapshots the worktree: `git stash create`-style **commit-tree snapshots under private refs** with message marker `"cline checkpoint session=<id>"` (`checkpoint-hooks.ts:11, 21-23`); untracked files are indexed through a **persistent private `GIT_INDEX_FILE` scratch dir** keyed `sha256(cwd\0sessionId)` (never the OS tmpdir) whose git stat-cache skips re-hashing unchanged untracked files across turns (`:29-49, 169-199`); config pins `core.ignorestat=false`/`core.splitIndex=false` so change detection can't silently break (`:169-184`); scratch dirs idle >14 days are reaped (`:13-19`). Checkpoint history (`{ref, createdAt, runCount, kind}`) lives in session metadata (`:80-90`).
- **Restore is transactional:** `beginWorktreeRestoreTransaction` captures the current worktree with `stash push --include-untracked`, moves it behind a private ref `refs/cline/restore-transactions/<uuid>`, drops it from the visible stash, and offers commit/rollback (`checkpoint-restore.ts:50-131`).
- **Does reverting restore the conversation?** Yes — `createCheckpointRestorePlan` returns `messages: trimMessagesToCheckpoint(messages, runCount)` (everything through the Nth user run) unless `restoreMessages: false` (`checkpoint-restore.ts:266-303`). Compaction interacts honestly: `findUserRunMessage` counts `userRunSpan`s and **throws** "Run N is folded into a compacted message spanning runs X–Y" when the requested run is inside a folded summary (`:217-243`) — restore works through compaction when the boundary aligns, and refuses loudly otherwise (fork-before-run likewise, `:253-264`).

## 9. Context-window overflow protection at 100%

Three layers:
1. **Budget projection** (`budget-projection/project.ts`): after strategies produce messages, the projection enforces a token target — first **truncate** text blocks oldest-tail-first (never the first/last typed user message, never the protected live tail; `:560-598`), then **drop whole message closures** (a message + its tool-pair closure, never splitting tool_use from tool_result — reason `tool_pair_boundary`, `:600-649`); if the target still can't be met without violating protections it returns `status: "failed"` with warning `budget_unachievable_with_protections` and `liveTailHandling: "included_degraded"` (`:651-665`) — the request still goes out, degraded, with telemetry `compaction_budget_emergency`.
2. **Runtime guards:** one overflow-recovery compaction+retry per run; the retry must be strictly smaller; terminal `ContextWindowOverflowError`s carry actionable text ("no conversation history to compact — the system prompt, tools, and current input alone are too large…", `agent-runtime.ts:94-113`) including the provider's own error string.
3. **Consecutive-failure handling:** distinct counters — `PROVIDER_ERROR_MAX_RETRIES = 3` transient (1 s → 15 s backoff, auth/overflow excluded, `:77-91`); `MAX_TOKENS_RECOVERY_LIMIT = 3` output-truncation nudges ("keep responses concise… write large files or command output in smaller chunks across multiple tool calls", `:61-75`); each resets on progress (any tool call), so a run of cut-off turns ends the task rather than looping forever.

---

## ACUTE-CODE adoption table

Our current state (read this round): `agent-core/src/agents/compaction.ts` (R46→R128: single-tier LLM summarize; round-aligned selection D3a; provider-usage anchor + invalidation D1/D3b; rapid-refill breaker D5; hard-trim fallback), `runtime.ts` (`assembleHistory` folds the event log into `<tool_results>` blocks — RECENT_TOOL_RESULTS=8 full outputs, older stubbed to 200 chars, MAX_TOOL_BLOCK_CHARS=48 000 per block, sticky skill/memory lines exempt; per-turn system prompt with env/git grounding + todo snapshot + memory digest; one-shot overflow recovery via `forceCompaction`), `chat.ts` (Vercel AI SDK; `summarizeToolOutput` caps tool output at 4 000 chars head+tail, sticky tools 60 K; attachments render inline; no cache_control). Owner complaint being answered: "a very small task reaches 100 M context in no time… takes in a lot of useless, unneeded data… cannot handle long horizon tasks… keeps hallucinating."

| # | Cline mechanism (evidence) | Verdict | Concrete ACUTE-CODE change |
|---|---|---|---|
| 1 | **Stale-read rewrite** — superseded `read_file` results become `"[outdated - see the latest file content]"`, batched at 64 KB to protect prefix caches (`message-builder.ts:49, 335-418, 912-969`) | **ADOPT** | `runtime.ts assembleHistory`: track the newest `read_file`/`search` tool.use per path (we already hold argsSummary; persist `path` in the tool.use payload if absent) and replace older full outputs for the same path with `[outdated — see the newest read of this file above]` **before** the recent-8 window applies. Pure, unit-pinnable like the R58-c stubbing. Highest value per line for the owner's "useless data" complaint: re-reads currently ride verbatim 8-deep. |
| 2 | **Old-attachment stripping** — file/image blocks only survive on the latest typed prompt; older ones drop with paths carried in summaries (`basic-compaction.ts:95-114`); 50 K per-attachment cap at request build (`message-builder.ts:232-244`) | **ADOPT** | `chat.ts renderAttachments` + `runtime.ts assembleHistory`: only the newest N (1–2) user turns keep inline attachment text; older turns keep the `--- attached file: name (saved at path) ---` pointer line without the body. Today an attached 30 KB file rides **every** request at full size forever. |
| 3 | **Deterministic basic tier for overflow recovery** — recovery "must not depend on another successful LLM request" (`compaction.ts:480-543`); dropped-work summaries list files read/edited + commands verbatim (`compaction-shared.ts:561-645`) | **ADAPT** | `compaction.ts`: add a `basicCompact()` no-LLM path (deterministic transcript: files read/edited, commands run, last 3 assistant texts verbatim, `<SYSTEM_NOTICE>` blocks on surviving prompts) used when (a) the summarizer fails *on the force path* (today: hard trim destroys information), and (b) `evaluateRapidRefill` blocks (today: blocked = raw oversized messages go out; cline instead shrinks deterministically). Keep the LLM tier for the normal auto path. |
| 4 | **Guaranteed `## Files` section** — deterministic extraction from tool_use inputs, re-appended if the model omits it (`compaction-shared.ts:424-461, 659-667`) | **ADOPT** | `compaction.ts`: after the summarizer returns, compute readFiles/editedFiles/commands from `plan.toSummarize` (our tool.use events carry toolName + argsSummary) and append/overwrite a `## Files` section on the summary. Cheap, closes the "model forgot to list the files" hallucination vector on long horizons. |
| 5 | **Provider-actual budget scaling (underestimate factor ≤4)** (`compaction.ts:329-362`) | **ADAPT** | `compaction.ts planCompaction`: we already prefer the provider anchor (R125 D1); add cline's ratio law — when `anchor > estimatedTokens`, scale `available` down by `min(4, anchor/estimate)` so target/keep-window shrink too (today only the *gate* uses the anchor; the keep-target still trusts the estimator, so a dense-content session re-triggers immediately after compacting — the exact thrash the R128 breaker papers over). |
| 6 | **Trigger at 90% of usable input; target 70% of trigger / 50% of window for long runs** (`compaction-shared.ts:13-27`, `compaction.ts:100, 210-228`) | **SKIP (mostly)** | We already trigger at 100% of `available` with a 60% keep-target and a rapid-refill breaker; our margins (output reserve + safety margin) play the role of cline's 0.9/0.9. Different shape, equivalent intent — changing both now would churn R128's pinned behavior for no measured win. Revisit only if #5 lands and the meter still shows late triggers. |
| 7 | **Rolling cache_control breakpoint on the last user message** (`ai-sdk.ts:415-424`, `utils.ts:11-15`) + stable per-session system prompt | **ADOPT (anthropic-messages only first)** | `chat.ts buildModel`: for `format === "anthropic-messages"`, set `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }` on the last user message part (AI SDK v5 message parts support it). CAVEAT for our default path: our system prompt is rebuilt per turn (env/git/date/todo/hints), which busts system-prefix caches anyway — either freeze the volatile sections (date/git) into the first user turn like classic cline did, or accept that only the message prefix caches. Native-Anthropic is fixture-tested only (no key), so mark it spec-gated; OpenRouter/`:free` models gain nothing. |
| 8 | **Thinking dropped from archived turns; flattened to 2 K in summaries** (`basic-compaction.ts:428-441`, `compaction-shared.ts:159`) | **ADOPT** | `compaction.ts renderTranscript` / `assembleHistory`: cap any assistant `<thinking>…` segments carried in content at ~2 000 chars in the summarizer input (and drop from keep-set messages older than the current round). Small, pure, reduces summarizer input size. |
| 9 | **Missing-tool-result synthesis** (`message-builder.ts:502-711`) | **SKIP** | Our event log folds tool results from `tool.use` events with `ok` flags; interrupted calls already persist honestly and the loop guard surfaces failures. No observed orphaned-tool_use failure mode. |
| 10 | **Compaction sidecar w/ prefix-hash projection (shadowing)** (`session-compaction.ts`, `compaction.ts:745-812`) | **SKIP (already have the equivalent)** | Our append-only `context.compact` event + pure `applyCompaction` on every assembly *is* the same law (revert resurrects raw history; fork copies the compacted log) — documented in our compaction.ts header since R46. Cline's sidecar exists because their store is message-shaped rather than event-shaped. |
| 11 | **Run-span metadata for restore-through-compaction** (`checkpoint-restore.ts:217-251`) | **ADOPT (cheap)** | Persist `droppedRuns` (count of user turns covered by the summary) on `CompactionPayload`; the revert/fork route then answers honestly ("cannot revert into a summarized span — revert to the compaction boundary") instead of silently mis-slicing. Our `throughSeq` covers messages, not user-turn boundaries. |
| 12 | **FileContextTracker (chokidar watcher → user-edit notices)** (`apps/vscode/src/core/context/context-tracking/FileContextTracker.ts`) | **ADAPT later / SKIP for v1** | Strong fit conceptually (our owner edits files in the workbench while the agent runs) but its consumer wiring is absent on current main — the SDK answers staleness with the deterministic rewrite (#1) instead. Ship #1 first; a watcher is a Phase-2 nicety behind the same notice format. |
| 13 | **Output-token cut-off → compaction+retry** (`agent-runtime.ts:1340-1508`) | **SKIP for now** | We have a loop guard (MAX_CONSECUTIVE_FAILURES=6) and a retry ladder; our providers rarely cap generation at remaining context (cloud APIs). Revisit if local-model support lands. |
| 14 | **Env block + rules in a short stable system prompt** (`prompt/system/act.ts`) | **SKIP** | Our prompt registry already does this better for us (structured sections, todo snapshot, memory digest); cline's advantage is *stability*, which #7 addresses where it matters. |

All adopted patterns are Apache-2.0-licensed ideas expressed in our own code — no code copying (AGENTS.md hard rule); nothing here touches GPL-family code.

## Sources

- Clone: `git clone --depth 50 https://github.com/cline/cline` @ `29896ec` (2026-09-25); `LICENSE` (Apache-2.0, © 2026 Cline Bot Inc.)
- `sdk/packages/core/src/extensions/context/compaction.ts`, `compaction-shared.ts`, `basic-compaction.ts`, `agentic-compaction.ts`, `budget-projection/{types,project}.ts`
- `sdk/packages/core/src/session/services/message-builder.ts`; `session/models/session-compaction.ts`; `session/checkpoint-restore.ts`; `session/user-run-messages.ts`
- `sdk/packages/core/src/extensions/tools/executors/{output-limits,file-read}.ts`; `extensions/tools/definitions.ts`
- `sdk/packages/agents/src/agent-runtime.ts`; `sdk/packages/core/src/runtime/orchestration/{session-runtime-orchestrator,user-input-builder}.ts`; `runtime/host/local-runtime-host.ts`
- `sdk/packages/shared/src/llms/{tokens,model-info,media}.ts`; `shared/src/prompt/{cline.ts,system/act.ts}`
- `sdk/packages/llms/src/providers/ai-sdk.ts`; `providers/routing/{anthropic-compatible,generic-compatible,utils,bedrock-cache-point}.ts`
- `sdk/packages/core/src/hooks/checkpoint-hooks.ts`; `apps/vscode/src/sdk/{sdk-compaction.ts,cline-session-factory.ts}`; `apps/vscode/webview-ui/src/components/chat/task-header/ContextWindow.tsx`; `apps/cli/src/tui/utils/compaction-status.ts`
- `apps/vscode/src/core/context/context-tracking/FileContextTracker.ts`
- Prior round: `docs/research/cline/README.md` (round-108) — license verification and repo-layout baseline
