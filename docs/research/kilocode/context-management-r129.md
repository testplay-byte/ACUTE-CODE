<!-- last-reviewed: 2026-09-26 round-129 -->
# Kilo Code — Context-Window Management (R129 deep dive)

Round-129 research (task R129-R4), owner's exact asks: "research how they handle their context window, how they build the context window along the way, how they process the things... what should be included in the context window, what should not be included... how the context compression works and how each and every single one of the things gets managed."

All evidence is from a fresh shallow clone at commit **c267794785fbb841c0edc87e02d02755a643bd5c** (2026-09-26). Paths are relative to the repo root; `packages/opencode/src/...` is the core engine (the OpenCode-fork CLI that all Kilo clients talk to). **License: MIT** (root `LICENSE`, "Copyright (c) 2026 Kilo Code / 2025 opencode") — inside our allowlist; we adopt patterns, never code (per project constraints).

**Lineage reality check (important).** Kilo is Cline → Roo → Kilo by history, but the current repo is NOT a Cline-style codebase anymore: since April 2026 the engine is the OpenCode fork (`packages/opencode`). The Roo-era mechanisms the owner remembered (memory bank, `.kilocode/rules`, shadow-git checkpoints) still exist but as **migrated/deprecated layers** on the OpenCode base (rules-migrator.ts, kilo-memory replaces memory bank, snapshots = shadow git). Where Kilo diverges from both Cline and upstream OpenCode, the code is tagged `// kilocode_change` — those markers are the fastest way to find the fork's own innovations, and this doc quotes them heavily.

The whole system in one paragraph: every turn the loop re-projects the persisted event/message log (`filterCompacted` → queue scoping → trim-before-last-summary → reminders → editor-context injection → media strip → payload-size prune), builds a ≤2-message system prompt (persona + model-family prompt + env details + memory blocks + AGENTS.md instructions + MCP + skills), sends it through a **preflight token check** (compacts *before* the provider call if a configured `threshold_percent` is projected to be crossed), and after the step checks the **provider-reported usage** against the usable window (context − reserved buffer). Compaction itself is a dedicated "compaction" agent that flattens the head of the conversation into `[User]/[Assistant]/[Assistant tool call]/[Tool result]` text (tool outputs clipped at 2,000 chars), asks for a fixed 6-section Markdown summary, keeps a verbatim tail (default: 2 turns / ~25% of usable, clamped 2k–15k tokens), reorders the store so the summary replaces the head, optionally re-injects ("replays") the user's unanswered prompt, and auto-continues with a synthetic "Continue if you have next steps" nudge. Layered on top: incremental **pruning** of stale tool outputs (40k-token recency window), map-reduce **chunked compaction** when even the summary request overflows, payload-limit (4MB) recovery, byte-stable **prompt-cache breakpoints**, and a persistent **Kilo Memory** index + recall tools for cross-session continuity.

---

## 1. Per-turn context assembly

### 1.1 The main loop (one place, rebuilt every step)

`packages/opencode/src/session/prompt.ts` `runLoop` — the equivalent of our `prepareTurn`+outer loop. Every step of every turn re-derives the outgoing messages from storage:

```ts
// prompt.ts:1548-1553 (kilocode_change)
let msgs = yield* MessageV2.filterCompactedEffect(sessionID)      // drop pre-summary head, reorder tail
msgs = KiloSessionPromptQueue.scope(sessionID, msgs)             // hide later queued prompts
msgs = KiloSessionPrompt.trimBeforeLastSummary(msgs)             // trim on ANY completed summary
```

Then per step (prompt.ts:1697-1800): `SessionReminders.apply` (mode/plan reminders, §1.4) → build the assistant row → resolve tools → `KiloSessionPrompt.injectEditorContext` (§1.3) → `maybeStripHistoricalMedia` (§2.3) → a **payload-size prune** when the serialized request exceeds `REQUEST_PRUNE_BYTES = 1_250_000` bytes (prompt.ts:128, logic at 1810-1830: serialize → if >1.25MB, run `compaction.prune({reason:"payload-limit"})`, re-load, re-check, warn if still large) → build the system array → `handle.process({system, messages, tools, reportedContextTokens})`.

The final outgoing message list (prompt.ts:1851-1855):

```ts
messages: [
  ...modelMsgs,
  ...KiloSessionContinuation.context(!!input.resume && step === 1),  // resume/continue marker
  ...(isLastStep ? [{ role: "user", content: MAX_STEPS_PROMPT }] : []), // loop-bound nudge
],
```

### 1.2 System prompt structure (exact order)

`packages/opencode/src/session/llm/request.ts:69-95` — one joined system string, then collapsed to **≤2 system messages** (header + rest) so cache breakpoints land on stable prefixes:

```ts
const system = [
  [ ...(isOpenaiOauth || !includePersona ? [] : [SystemPrompt.soul()]),   // kilocode persona ("soul.txt")
    ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)), // agent's own OR model-family prompt
    ...input.system,                                                      // env details, memory, instructions, MCP, skills
    ...(input.user.system ? [input.user.system] : []),                    // per-message extra system
  ].filter((x) => x).join("\n"),
]
```

`input.system` is assembled in the loop (prompt.ts:1832-1839), in this order:

```ts
const system = [
  ...env,                    // sys.environment(model, editorContext) — <env> block + references
  ...mem,                    // Kilo memory blocks (pinned per session, §6)
  ...(tools.board_read && notify ? [BoardContext.instructions] : []),
  ...instructions,           // instruction.system() — AGENTS.md/CLAUDE.md/etc., §1.5
  ...(mcpInstructions ? [mcpInstructions] : []),   // <mcp_instructions> per server
  ...(skills ? [skills] : []),                     // skills index (name+description only)
]
```

- `<env>` block (`kilocode/system-prompt.ts:20-35`): model id, git-repo yes/no, platform, today's date, where `.kilo/` config lives, plus editor lines. Not Cline's XML "environment details" — that lives per user-message instead.
- Model-family prompts: `session/prompt/{anthropic,default,beast,gemini,gpt,kimi,ling,codex,trinity,kilocode-gpt-5.5}.txt` (~65-155 lines each, `system.ts:46-95` selects by `model.prompt` or api.id heuristics). Same lineage as Roo/Cline's XML prompts but trimmed; e.g. anthropic.txt:1 "You are Kilo, the best coding agent on the planet."
- Skills are injected **name+description only** (progressive disclosure; `system.ts:153-165`), with the deliberate comment that models ingest skills better verbose-in-system + terse-in-tool-description.

### 1.3 Environment details per user message (transient, byte-stable)

`kilocode/session/prompt.ts:452-502` `injectEditorContext` — a `<environment_details>` block is appended to every user message that lacks one, **reconstructed at send time from the message's own creation timestamp** (never persisted):

```ts
// prompt.ts:475-501 (abridged)
const block = input.cache.blocks.get(msg.info.id)
  ?? environmentDetails({ ...route, ...msg.info.editorContext }, new Date(msg.info.time.created))
msg.parts.push({ type: "text", text: block, synthetic: true })
```

```ts
// kilocode/editor-context.ts:39-63
export function environmentDetails(ctx?: EditorContext, now = new Date()): string {
  const lines = [`Message time: ${timestamp(now)}`]
  if (ctx?.directory) lines.push(`Working directory: ${ctx.directory}`)
  if (ctx?.worktree)  lines.push(`Workspace root folder: ${ctx.worktree}`)
  if (ctx?.activeFile) lines.push(`Active file: ${ctx.activeFile}`)
  ... visible files / open tabs ...
  return ["", "", "<environment_details>", ...lines, "</environment_details>"].join("\n")
}
```

The doc comment is the key idea: *"Using each message's creation time keeps historical blocks byte-identical, so later turns only append instead of moving the block and discarding the provider prompt cache."* `envCache` is per-turn (prompt.ts:1532-1533).

### 1.4 Reminders (mode switches, plan mode)

`session/reminders.ts` delegates to `kilocode/session/mode-reminders.ts:50-83`: (a) **plan-mode** turns re-inject the plan instructions as a transient `<system-reminder>` every Plan turn (`insertPlanReminders`, prompt.ts:518-565 — plan-file path policy, plan_exit contract); (b) an **agent switch** persists exactly one synthetic reminder naming prior + current agent plus a capability line derived from the permission ruleset (READONLY/WRITABLE/NEUTRAL, mode-reminders.ts:25-38). Newest reminder supersedes older ones; deduped by exact text.

### 1.5 Rules files / custom instructions (the Roo heritage, now migrated)

Current engine = OpenCode instruction system, `session/instruction.ts`:

- Global (first existing wins, instruction.ts:63-73): `$KILO_CONFIG_DIR/AGENTS.md` → `<global.config>/AGENTS.md` → `~/.claude/CLAUDE.md` (the last only pre-migration).
- Project (instruction.ts:74-78, 152-163): first match walking UP from cwd to worktree root among **AGENTS.md, CLAUDE.md, CONTEXT.md (deprecated)** — "The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor."
- `config.instructions` entries: paths, `~/`-globs, or **http(s) URLs** (fetched with 5s timeout, instruction.ts:118-126).
- Injected as `Instructions from: <path>\n<content>` blocks in the system prompt (instruction.ts:208-211).
- **Proximity instructions** (instruction.ts:222-264 `resolve`): when the `read` tool opens a file, walk UP from that file's directory and attach nearby AGENTS.md/CLAUDE.md **once per assistant message** (dedup via a claims map + the set of files already loaded through `read`, `extract()` at instruction.ts:20-35 reads `tool.state.metadata.loaded`). This is how deep subdirectory rules get discovered without pre-scanning the tree.

The Roo-style files are migrated, not natively read: `kilocode/rules-migrator.ts:6-11` — only `.kilocoderules` (explicitly "no migration for .roorules or .clinerules"), `.kilo/rules/*.md` + `.kilocode/rules/*.md` (project), `~/.kilo/rules/*.md` (global), plus mode-specific `rules-<mode>/` dirs; all become `instructions:` config entries. So the answer to "what happened to .roorules": **dropped; AGENTS.md is the single source now** (docs: "The Kilo Code memory bank feature has been deprecated in favor of AGENTS.md", kilo-docs/pages/customize/agents-md.md:10-13).

### 1.6 Queue scoping / continuation

`kilocode/session/prompt-queue.ts` — a per-session queue of not-yet-answered user prompts; `scope()` hides prompts queued after the one being answered (prompt.ts:1552), `retarget()` re-points the active prompt when compaction/auto-continue inserts synthetic user messages (compaction.ts:616, 665), `hasFollowup()` lets a turn hand off to a newer queued prompt with close-reason "superseded" instead of another LLM step (prompt.ts:1952-1961). `KiloSessionContinuation` (kilocode/session/continuation.ts) identifies an unanswered user turn for resume-after-restart and injects a continuation marker at step 1.

---

## 2. Inclusion / exclusion policies (what gets in, what never does)

### 2.1 The event→message projection (`toModelMessagesEffect`)

`session/message-v2.ts:256-551` is the single inclusion/exclusion choke point (options: `stripMedia`, `toolOutputMaxChars`):

- **User text**: only non-`ignored`, non-empty parts (message-v2.ts:331). `ignored` is how local UI warnings are kept out of future prompts.
- **User files**: `text/plain` and `application/x-directory` are converted/ignored; with `stripMedia`, media becomes `[Attached <mime>: <file>]` (337-350).
- **Compaction marker**: a compaction user part renders as the literal text **"What did we do so far?"** (353-358) — the anchor question the summary answers.
- **Subtask marker**: "The following tool was executed by the user" (359-364).
- **Assistant messages with terminal errors are skipped entirely** (373-381) unless aborted-with-content.
- **Tool outputs**: `part.state.time.compacted ? "[Old tool result content cleared]" : truncateToolOutput(part.state.output, maxChars)` (419-422) — pruning is a *timestamp flag*, the placeholder is substituted at projection time.
- `send_file` delivery attachments never replay ("mobile delivery artifacts (up to 4 MiB base64), not model context", 426-432).
- **Pending/running tool calls** are rendered as `output-error` with text `[Tool execution was interrupted]` (485-497) — keeps Anthropic's tool_use/tool_result pairing valid.
- **Reasoning parts**: kept with provider signatures when same model; flattened to plain text when the model changed (498-512); empty-text separators preserved as `" "` when signed reasoning exists (387-407).
- **Media in tool results**: extracted into a synthetic follow-up user message for providers that don't support media in tool-result position (provider capability table at 272-284; injection at 514-535).
- Transient UI parts never replay (`KiloPartLifecycle.transient`, 403).

### 2.2 Tool-output truncation at ingress (the Truncate service)

`tool/truncate.ts`: `MAX_LINES = 2000`, `MAX_BYTES = 50 * 1024` (14-15), configurable via `tool_output.max_lines/max_bytes`. Oversized output is NOT discarded — the full text is written to a truncation dir (7-day retention, hourly cleanup, 12/53/145-150) and the model gets a preview + an actionable hint (131-133):

```ts
const hint = hasTaskTool(agent)
  ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
  : `...Use Grep to search the full content or Read with offset/limit to view specific sections.`
```

That hint — *delegate to a subagent instead of re-reading* — is the anti-context-bloat pressure valve.

### 2.3 File-read limits

`tool/read.ts:24-32`: `DEFAULT_READ_LIMIT = 2000` lines, `MAX_LINE_LENGTH = 2000` chars per line (long lines sliced with an honest `... (line truncated to N chars)` suffix), `MAX_BYTES = 50 * 1024`, `SAMPLE_BYTES = 4096` binary sniffing, image mimes jpeg/png/gif/webp. `offset`/`limit` params are first-class so re-reads are partial. Read results carry `metadata.loaded` (the instruction-proximity feature of §1.5).

### 2.4 Media policy across the lifetime

Three distinct strips: (a) `stripMedia` during compaction/chunk estimation; (b) `maybeStripHistoricalMedia` every turn **once a completed summary exists** — everything before the newest real (non-synthetic) user message has image/PDF file parts and tool attachments replaced by placeholders (`kilocode/session/prompt.ts:676-710`, doc comment: the fix for "re-shipping multi-MB base-64 images on every turn"); (c) media stripped from the *replayed* user prompt only after a provider-side overflow (compaction.ts:619-623). Unsupported modalities become explicit error text ("ERROR: Cannot read ... this model does not support image input. Inform the user.", `provider/transform.ts:465-501`).

### 2.5 Diffs

File changes are recorded as `patch` parts (snapshot diffs) on assistant messages (processor.ts:823-837) and surfaced as user-visible diffs on revert; they are not pushed into the model context as full diffs — the model sees its own edits through the tool results of `edit`/`write`/`apply_patch`.

---

## 3. Compression / compaction (the core answer)

### 3.1 Trigger thresholds — three independent gates

**(a) Preflight (economic, before the provider call)** — `kilocode/session/overflow.ts` + `session/llm.ts:129-173`:

```ts
// kilocode/session/overflow.ts
const FACTOR = 1.3            // :8  — Token.estimate undercounts real tokenizers by ~15-30%
export function count(tokens) { return input+output+reasoning+cache.read+cache.write }  // :71-74
export function limit(input) {   // :89-98
  const percent = input.cfg.compaction?.threshold_percent
  if (typeof percent !== "number") return input.usable
  const cap = Math.floor(context * (percent / 100))
  return Math.min(input.usable, cap)
}
export function shouldCompact(input) {  // :135-154
  if (!enabled(input)) return false
  if (stats.continuation) return false   // never compact mid tool-continuation
  const baseline = reported > 0 ? reported + stats.tail + (stats.overhead ?? 0) : undefined
  const projected = baseline ?? stats.normalized
  return projected >= limit(input)
}
```

In `llm.run` (llm.ts:142-171): measure the outgoing body (messages + tool schemas + leading system), `shouldCompact` → **fail with `PreflightError` before contacting the provider**. The projection is `last reported usage + new-since-then tail + (tools+system overhead)` — over-projection is deliberate ("bounded over-projection, never an under-count that bypasses the threshold", overflow.ts:118-123). Media is counted as its placeholder (`[encoded media]`, byteLength/4 for binary), encrypted reasoning as `[opaque reasoning state]`.

**(b) Post-step (safety, after the provider reports usage)** — `session/overflow.ts:11-36`:

```ts
const COMPACTION_BUFFER = 20_000
export function usable(input) {
  const reserved = input.cfg.compaction?.reserved
    ?? Math.min(COMPACTION_BUFFER, maxOutputTokens(model))
  return model.limit.input ? Math.max(0, model.limit.input - reserved)
                           : Math.max(0, context - maxOutputTokens(model))
}
export function isOverflow(input) {
  if (input.cfg.compaction?.auto === false) return false
  return KiloSessionOverflow.count(input.tokens) >= usable(input)
}
```

Checked in the loop (prompt.ts:1656-1685) on the last finished non-summary assistant: `compaction.isOverflow({tokens: lastFinished.tokens, model})` → `compaction.create({auto:true, overflow:false})`. Post-step is safety-only ("post-step checks are safety-only; economic thresholds run in preflight", overflow.ts:33).

**(c) Provider rejection** — a `ContextOverflowError` mid-stream sets `ctx.needsCompaction` (processor.ts:911-922) and the step returns `"compact"`.

Both loop paths are guarded by `MAX_COMPACTION_ATTEMPTS = 3` per turn (`kilocode/session/prompt.ts:591`, guard at 600-617): after 3 attempts the turn fails with `ContextOverflowError("Compaction exhausted: context still exceeds model limits after 3 attempts")`. `compaction.auto === false` makes provider overflow a hard error instead of auto-compacting (processor.ts:911-919).

**Config surface** (docs `context-condensing.md` + code): `compaction.auto` (default true), `compaction.threshold_percent` (unset by default; VS Code Settings→Context clamps 1-100, ContextTab.tsx:32-35), `compaction.prune` (true), `compaction.tail_turns` (2), `compaction.preserve_recent_tokens` (25% of usable — code clamps 2,000-**15,000** [compaction.ts:44-45]; the docs page still says 8,000 — stale), `compaction.reserved` (min(20k, max output)); env overrides `KILO_DISABLE_AUTOCOMPACT` / `KILO_DISABLE_PRUNE` (config.ts:1047-1050). So "Roo compacted at ~50%" is no longer true — today the default is "usable window reached" with an optional percent.

### 3.2 The summarization prompt (anchored, structured, chainable)

The compaction **agent**'s system prompt (`agent/prompt/compaction.txt`, 6 lines): "You are a context summarization agent... Do not continue the conversation... Only output the structured summary in the exact format requested."

The user prompt is built by `buildPrompt` (`packages/core/src/session/compaction.ts:160-174`) with `<conversation>` / `<prior-summary>` tags, and the fixed template (`core/src/session/compaction.ts:16-46`):

```
## Objective
## Important Details        (constraints, decisions+why, exact context needed)
## Work State
### Completed / ### Active / ### Blocked
## Next Move  (1. immediate concrete action 2. next)
## Relevant Files  (path: why it matters)
```

Rules: keep every section even when empty ("(none)"); terse bullets; **preserve exact file paths, symbols, commands, error strings, URLs, identifiers**; "Do not mention the summary process or that context was compacted." Chained compactions get `SUMMARY_UPDATE_INSTRUCTIONS` (47-55): the prior summary is discarded after the merge — "anything you do not carry into the new summary is lost"; conversation wins on conflict; move Active→Completed; resolved blockers update the summary. Constants (12-15): `DEFAULT_BUFFER 20_000`, `DEFAULT_KEEP_TOKENS 8_000`, `TOOL_OUTPUT_MAX_CHARS 2_000`, `SUMMARY_OUTPUT_TOKENS 4_096` (the summary call's maxTokens cap). The compaction model is configurable (`agent.compaction.model`, e.g. haiku; compaction.ts:410-413 falls back to the session model). Plugins can replace the prompt or inject context (`experimental.session.compacting`, compaction.ts:425-430).

### 3.3 What's kept as text vs dropped (the flattening)

`serialize()` (session/compaction.ts:66-97) flattens each message to plain text:

```
[User]: ...
[Assistant]: ...
[Assistant reasoning]: ...                       (kept!)
[Assistant tool call]: read({"filePath":...})
[Tool result]: <output clipped at 2,000 chars>   (or "[Old tool result content cleared]")
[Tool error]: ...
[Attached image/png: foo.png]                    (media → placeholder)
```

The head (everything before the retained tail) is what gets summarized; the tail is kept **verbatim**. Tail selection (`select`, compaction.ts:242-294): last `tail_turns` (default 2) user-turns; walk backwards accumulating estimated size until the budget `preserveRecentBudget = clamp(usable*0.25, 2k, 15k)` (132-137) is exceeded; if a turn doesn't fit, `splitTurn` (158-181) finds the earliest message inside the turn where the remaining slice fits — **lazy estimation** so "cost stays proportional to the retained tail, not the whole session" (comment at 264).

### 3.4 History replacement mechanics (how the summary replaces the past)

Compaction is persisted as data, and the *projection* does the replacement — nothing is deleted:

1. `compaction.create` (compaction.ts:770-804) appends a **user message with a `compaction` part** `{auto, overflow}` (this is the `/compact` / auto marker).
2. The summarizer's answer lands as an **assistant message with `summary: true`** whose parent is that user message.
3. The compaction part records `tail_start_id` (updated at compaction.ts:567-579 if selection changed).
4. Every subsequent read uses `filterCompacted` (message-v2.ts:657-709): it stops at the newest compaction user message and **reorders** the outgoing list to `[compaction-user, summary-assistant, ...retained tail..., everything after]` — i.e. the model sees "What did we do so far?" → summary → verbatim recent tail → new turns.
5. `trimBeforeLastSummary` (kilocode/session/prompt.ts:642-655) additionally drops everything before the summary's parent — the fix for manual `/compact` against a plain-text user, where `filterCompacted` alone kept re-shipping multi-MB history (doc comment 627-641).

So "previous conversation summarized" markers = the "What did we do so far?" user text + `summary:true` assistant + the reordering. Prior summaries are inputs to the next compaction (chain), and their messages are hidden from selection via `completedCompactions` (compaction.ts:113-129).

### 3.5 Replay (the user's unanswered prompt is never lost)

When compaction fires *before* a turn could answer (preflight) or the provider rejected the request (overflow), `processCompaction` (compaction.ts:378-407) walks back to the newest user message with **no assistant progress after it**, cuts it out of the history to be summarized, and **re-injects it verbatim after the summary** as a fresh synthetic user message (603-632) — media stripped only in the provider-overflow case, with the honest explainer ("The previous request exceeded the provider's size limit due to large media attachments...", 666-670).

### 3.6 Auto-continue

After an **auto** compaction, a synthetic user message `"Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."` (with `metadata: {compaction_continue: true}`, `synthetic: true`) re-arms the loop (635-688), gated by the `experimental.compaction.autocontinue` plugin hook.

### 3.7 Chunked (map-reduce) compaction when the transcript itself overflows

`kilocode/session/compaction-chunks.ts` — if the *summarization request* wouldn't fit (`needed()`, :70-78 — `ceil(tokens*1.3) + output > usable`):

- Split messages into chunks of `usable * 0.6` (RATIO 0.6, min 1,000; :22, 110-116).
- Summarize chunks in parallel, `CONCURRENCY = 3` (:23), each worker capped at `OUTPUT = 2_048` tokens (:25).
- Chunk prompt (:216-223): "Summarize conversation chunk i of N. Only summarize facts present in this chunk. Preserve concrete file paths, commands, errors, decisions, and unresolved tasks. Use terse Markdown bullets. Do not mention chunking or compaction."
- A chunk that is itself too large is first rendered as a clipped transcript: text/reasoning clipped at `TRANSCRIPT_MAX_CHARS = 16_000`, tool input/output at 2,000, with `<message index="N" role="...">` wrappers (:21, 171-214).
- Then `reduce()` (:341-362): hierarchical pairwise reduction of `<partial-summary index="N">` groups, `DEPTH = 3` (:24).
- Empty summary → retryable `APIError` "Compaction did not run: the model returned an empty summary. Retry with /compact." (:28, 279-289); worker messages are removed after use (`Effect.ensuring(removeMessage)`, :271-274).

### 3.8 Payload-limit (4MB) recovery

`kilocode/session/compaction-payload-recovery.ts` — matches `request entity too large|function_payload_too_large` (:12); on hit, marks all completed tool outputs compacted and converts media file parts to text placeholders (`strip`, :29-51), then retries the compaction with the stripped prompt prefixed by "The previous compaction request exceeded the provider's 4MB payload limit. Older tool outputs and media attachments were removed..." (:21-27).

### 3.9 Incremental pruning (between compactions)

`compaction.prune` (session/compaction.ts:296-355): walks BACKWARD from the newest message; protects the last 2 turns, the last 2 completed steps, and everything after the newest summary; accumulates tool-output tokens until `PRUNE_PROTECT = 40_000`(:41); everything older is marked `time.compacted` (placeholder at projection time) — but only commits if it would free `> PRUNE_MINIMUM = 20_000` (:40, 345). Opt-in for the standalone pass (`reason:"normal"` needs `compaction.prune === true`), but **automatic after every compaction** (`reason:"post-compaction"`, compaction.ts:763 — "compaction already invalidates cache, so collapse stale tool outputs too") and on the 1.25MB payload guard (`reason:"payload-limit"`, prompt.ts:1815). `PRUNE_PROTECTED_TOOLS = ["skill"]` (:43) — loaded skill bodies are never pruned.

---

## 4. Token counting

- **Estimate**: `Token.estimate = round(length / 4)` chars→tokens (`packages/core/src/util/token.ts:3-5`) — deliberately cheap; every serious comparison multiplies by **1.3** to compensate (overflow.ts:8; compaction-chunks.ts:72-77).
- **Provider-reported usage is the source of truth**: `count(tokens) = input + output + reasoning + cache.read + cache.write` (kilocode/session/overflow.ts:71-74). `baseline()` (78-87) extracts it from the last finished non-summary assistant — and it *invalidates* the moment an unfinished assistant trails it or prompt-side usage is missing. Threaded into the request as `reportedContextTokens` (prompt.ts:1861-1864).
- **Output-token cap from real usage**: `KiloLLM.capOutputTokens` (kilocode/session/llm.ts:58-82): `available = context - max(reported, estimated) - 2048 (SAFETY)`, floor `MIN_OUTPUT = 1024`; if available ≤ 0 the configured cap passes through so the provider's natural overflow triggers compaction. Explicit rationale: small models ship 32k default max_output leaving no input room.
- **UI**: VS Code `ContextProgress.tsx` — `used / limit` tokens with the output reserve as a separate segment; "turns red when >= 50%" (:5, 27-44). Settings→Context exposes threshold_percent and the auto-compaction toggle (ContextTab.tsx).
- **Model-aware window math**: `model.limit.context`, `model.limit.input`, `model.limit.output` per model in the provider catalog; models with `context === 0` are "unknown window" and are exempt from auto-compaction entirely (overflow.ts:30, docs).
- **Model-facing self-report**: the `get_context_info` tool (§9) lets the *model* read its own token state.

---

## 5. Forced compaction / context_window_exceeded handling

- **Detection**: `packages/llm/src/provider-error.ts` — a 27-regex battery (`prompt is too long`, `request_too_large`, `context_length_exceeded`, `model_context_window_exceeded`, `too many tokens`, 413/no-body, ...) with rate-limit **exclusions** so token throttles stay retryable (:4-45). `parseAPICallError` (opencode provider/error.ts:189-210) also classifies `statusCode === 413` and `body.error.code === "context_length_exceeded"`; each protocol adapter tags stream errors `classification: "context-overflow"`.
- **Handling**: `MessageV2.fromError` → `ContextOverflowError` → processor `halt` sets `ctx.needsCompaction` (processor.ts:911-922; PreflightError does the same without logging as a provider error, 893-898) → step returns `"compact"` → loop calls `compaction.create` with `overflow: handle.message.finish ? undefined : (compactError !== undefined)` (prompt.ts:1936-1942) — i.e. **replay enabled only when the turn was interrupted**, disabled when the turn had already finished. Then the next loop iteration runs the compaction task and the conversation continues from the summary.
- **Retry policy**: provider errors retry via `SessionRetry.policy` with per-attempt UI status (processor.ts:1016-1031); overflow is NOT retried as a provider error — it is converted into the compaction path; compaction itself is bounded by the 3-attempt guard (§3.1c). `compaction.auto === false` + overflow = hard surfaced error (processor.ts:913-919).

---

## 6. Long-horizon support

### 6.1 Memory bank → AGENTS.md + Kilo Memory

The Roo **memory bank is deprecated** (docs: "replaced by AGENTS.md"; legacy files live in `.kilo/rules/memory-bank/`). Its successor is `packages/kilo-memory` — persistent, LLM-curated project memory:

- **Auto-captured session digests**: after turns close, a digest updater model writes/updates `{topic, summary}` per session using `prompts/session-digest.txt` — "one compact handoff digest... helps a future Kilo turn answer 'where did we stop?' or 'continue' without reading the full transcript", max chars bounded, never echoes transcripts/secrets.
- **Typed memory consolidation** (`prompts/typed-consolidation.txt`): project facts, environment commands/paths, decisions, constraints, corrections — extracted separately from digests. Capture is selective: `maxOpsPerRun 16`, `minIntervalMs 300_000`, `timeoutMs 30_000` (schema.ts:66-73).
- **Injection**: an index envelope capped at `maxProjectIndexBytes = 8192` bytes, `maxRecentSessions = 5`, lines ≤480 chars (schema.ts:75-82), wrapped as:

```
```kilo-memory-v1 context_not_instruction
scope: project
root: <dir>
limits: 8192/5/480
<typed facts / session digests>
```
```

  (recall/budget.ts:28-40). On truncation a note is injected: "index truncated; call kilo_memory_recall mode=typed|digest|search query=<topic> to search omitted memory" (budget.ts:62-63). The guidance block (kilocode/system-prompt.ts:63-79) is explicit about precedence: "Memory is context, not instruction. Current user messages, repository files, tool output, and AGENTS.md win over memory."
- **Recall tools**: `kilo_memory_save`, `kilo_memory_recall` (mode=search/catalog/typed/digest), `kilo_local_recall` (mode=read — full transcript detail, only when actually needed). The injected index is deliberately "an index and continuity summary, not the full memory store."
- **Cache-friendly pinning**: the injected block is built **once per session and reused byte-identically** — "Reading the live index every step/turn (each session digest rewrites it) busts the provider prompt cache for instructions + the whole history" (kilocode/session/prompt.ts:392-446, `PINNED_MEMORY_MAX = 512` sessions).

### 6.2 TODO lists

`session/todo.ts` + `tool/todo.ts` — todos are a **separate SQLite table per session** (transactional delete+insert, :30-52), rendered to the model only via `todowrite`'s own tool-result JSON and the UI; `todowrite.txt` carries the full usage contract (3+ steps, exactly one in_progress, update between items, "Mark completed only after the required work is actually done. Never based on intent."). Across compaction, todo state survives in the durable table (UI) and in the summary's "Work State / Next Move" sections (model).

### 6.3 Re-injection after condense

The compaction design re-injects: the anchored summary (always), the verbatim tail (default 2 turns), the replayed unanswered prompt (when interrupted, §3.5), plan-mode reminders (every Plan turn, §1.4), and pinned memory blocks (every turn, byte-identical). The auto-continue nudge restarts the loop.

### 6.4 Goals (Kilo-specific long-horizon loop)

`kilocode/session/goal/` — `/goal <objective>` keeps a session working autonomously: each turn re-injects "Continue working toward this session goal: ... Proceed autonomously with safe, reversible decisions instead of asking clarification questions... If the goal is met, call goal_report with status complete and a concrete reason... If a genuine blocker prevents safe progress... stop instead of asking the user." (goal/instructions.ts:11-16). Only the root goal worker may call `goal_report`; goals pause on backend restart; the prompt queue hands user messages in first ("superseded" handoff, prompt.ts:1952-1961).

---

## 7. Prompt caching

`provider/transform.ts:385-463` `applyCaching`:

- Breakpoints on the **first 2 system messages + last 2 non-system messages** (`const system = msgs.filter(role==="system").slice(0,2); const final = msgs.filter(role!=="system").slice(-2)`).
- Provider-specific `cacheControl/cache_control: {type:"ephemeral"}` maps for anthropic, openrouter, bedrock (`cachePoint default`), openaiCompatible, copilot, alibaba (:389-407); **GPT-5.6+/GPT-6+ get `promptCacheBreakpoint: {mode:"explicit"}`** (ChatGPT-subscription zero-cost models excluded, :366-382).
- **Breakpoint placement avoids volatile tails** (kilocode_change :429-457): on content-part messages the marker goes on the last part that is NOT a trailing `<environment_details>` / tool-approval part — the ephemeral env block must sit *after* the breakpoint.
- Cache discipline shows up everywhere else: system collapsed to ≤2 messages with a stable header (request.ts:91-95); pinned byte-identical memory (§6.1); byte-stable historical env blocks (§1.3); append-only synthetic parts; and the economic observation that compaction itself invalidates the whole cache — hence "collapse stale tool outputs too" at the same moment (compaction.ts:691, 763).

---

## 8. Fork / checkpoint / revert (snapshots)

- **Snapshots are shadow git**: a separate git dir under `Global.Path.data/snapshot/<project.id>/<hash(worktree)>` driven with `--git-dir/--work-tree` (snapshot/index.ts:107-111); the loop takes a snapshot before tool mutations and records per-assistant `patch` parts (hash + changed files, processor.ts:823-837).
- **Revert rewinds BOTH workspace and context**: `session/revert.ts:42-130` — rewinds to a message/part, collects all later `patch` parts, restores files via `snap.revert(patches)` inside an atomic workspace transition, takes a *new* snapshot for redo (`rev.snapshot = snap.track()`), computes the user-facing diff, and records `rev.workspace` status: "restored" | "not-a-git-repo" | "snapshots-disabled" | "unavailable" (74-88).
- **Does reverting restore context state? Yes — destructively.** `revert.cleanup` (159-203) runs when the next prompt arrives (prompt.ts:1447): it **deletes every message after the revert point** (and parts after the part-level cut) from storage. Unrevert (redo) restores files but not the deleted messages. So conversation history IS the context state, and revert truncates it for real.
- Interaction with compaction: a revert to a point before a compaction simply removes the summary messages too (they're ordinary messages) — the original messages were never deleted, so the pre-compaction context is resurrected. (Our ACUTE-CODE event-sourced design gets this for free the same way — noted in the adoption table.)

---

## 9. Kilo-specific innovations beyond Roo/Cline/upstream OpenCode

Everything tagged `kilocode_change` is a candidate; the ones that matter for context management:

1. **Preflight threshold compaction** (`kilocode/session/overflow.ts` + llm.ts:129-173) — compact *before* spending the request, driven by `threshold_percent`, projected from reported usage + new tail + overhead with the 1.3x safety factor. Upstream OpenCode only reacts post-hoc.
2. **`get_context_info` + `compact` model tools** (`kilocode/tool/context.ts`) — the model can *read its own* context usage (tokens, limit, remaining, message/part counts) and *schedule its own compaction* after the current turn (deduped via a WeakMap claim + pending-part check). "Experimental."
3. **Chunked map-reduce compaction + payload-limit recovery** (§3.7-3.8) — hierarchical summarization with concurrency 3, depth 3, 2,048-token chunk outputs; 4MB-body strip-and-retry.
4. **Pinned memory + byte-stable env blocks + breakpoint placement** (§6.1, §1.3, §7) — a systematic "don't bust the prompt cache" discipline threaded through injection, ordering, and caching.
5. **Kilo Memory** (`packages/kilo-memory`) — deprecated Roo's memory bank in favor of auto-captured digests + typed facts + recall tools with an 8KB capped index and explicit "index, not the store" guidance (§6.1).
6. **Goals** (§6.4) and the **prompt queue** with "superseded" handoff (§1.6).
7. **Codebase indexing** (`packages/kilo-indexing`, opt-in): tree-sitter semantic blocks → embeddings → LanceDB/Qdrant → `semantic_search` tool with min-score + maxResults (search expands up to `min(maxResults*16, 1000)` candidates before score filtering, search-service.ts:38-97). Keeps *code retrieval out of the context window* entirely.
8. **Session retention policy** (`kilocode/session/retention.ts`): fail-closed 30-day max-age deletion of old sessions (storage hygiene, not context management proper).

---

## ACUTE-CODE adoption table

Our current state (read this round): `agent-core/src/agents/compaction.ts` (R46→R128: single-tier summarize, round-aligned selection, provider-usage anchor R125, rapid-refill breaker R128), `runtime.ts` (`assembleHistory` RECENT_TOOL_RESULTS=8 / OLD_TOOL_STUB_CHARS=200 / MAX_TOOL_BLOCK_CHARS=48k / sticky skills; `prepareTurn`; single-shot overflow recovery with `forceCompaction` at runtime.ts:2687-2708), `chat.ts` (Vercel AI SDK seam, cachedInputTokens tracked, no explicit cache breakpoints).

| # | Finding (Kilo) | Verdict | Concrete ACUTE-CODE change |
|---|---|---|---|
| 1 | **Structured 6-section summary template** (Objective / Important Details / Work State C-A-B / Next Move / Relevant Files) + "preserve exact paths/symbols/commands/errors" + "never mention compaction" + explicit prior-summary merge rules | **ADOPT** | Replace `SUMMARIZER_SYSTEM_PROMPT`'s free-form bullets (compaction.ts:791-800) with this fixed template + a `PRIOR_SUMMARY_MERGE` instruction block for chained compactions. Cheap, directly attacks the owner's "keeps hallucinating on long tasks" (the summary becomes a state machine, not prose). |
| 2 | **Verbatim tail preservation** (tail_turns=2, budget = clamp(usable·25%, 2k-15k), splitTurn mid-turn fitting) | **ADOPT** | `planCompaction` currently summarizes everything below the byte cut with no verbatim tail. Add `keepTailRounds = 2` + a tail token budget to `selectSummarizationBoundary`-equivalent in compaction.ts; the round-aligned selection R128 shipped is exactly the right substrate. |
| 3 | **Preflight compaction at a configurable threshold** (projected = reported usage + new tail + overhead, ×1.3 safety, vs `min(usable, context×pct)`) | **ADAPT** | We already have the provider-usage anchor (R125) but only gate on it *post-hoc* inside `assembleWithCompaction`. Add a pre-send projection in `prepareTurn`/runtime loop: `anchor + estimated new tail + (system+tools estimate)` ≥ `thresholdPercent × window` → compact before the call. Skip Kilo's `FACTOR 1.3` double-counting nuance by reusing our anchor; make `compaction.thresholdPercent` a per-model setting (default ~80%). |
| 4 | **Incremental tool-output pruning** (40k recency protect, ≥20k freed to fire, placeholder at projection time, auto after compaction "since cache is already busted", skill outputs protected) | **ADOPT** | Our `assembleHistory` stubs to 200 chars after 8 results but never *persists* the collapse, so every iteration re-pays estimation and the event log keeps full blobs. Add a persisted `tool.use.pruned` flag (or a `context.prune` event) applied by `assembleHistory`, fired post-compaction and on a payload-size guard. Protect `read_skill`/`memory_recall` (we already have the sticky concept — reuse it). |
| 5 | **`MAX_COMPACTION_ATTEMPTS = 3` per turn + honest exhaustion error** | **ADOPT** | We have the rapid-refill breaker but our overflow recovery is single-shot (`overflowRecovered` latch, runtime.ts:2688-2707). Allow up to 3 force-compactions per turn with a terminal `context_window_exceeded` error naming the attempt count; pairs naturally with #2 (each compaction now frees more because the tail is kept, not re-summarized). |
| 6 | **Replay of the unanswered user prompt after compaction** | **ADOPT** | After a forced compaction (overflow recovery), re-inject the user's original message verbatim after the summary instead of relying on the auto-continue note. Small change in the overflow-recovery branch of runtime.ts + compaction.ts output assembly. |
| 7 | **Truncate-at-ingress with durable full output + delegate hint** (2000 lines / 50KB; "Use the Task tool... Do NOT read the full file yourself") | **ADAPT** | Our tool layer already summarizes outputs; adopt the *policy*: persist full outputs to a truncation store (SQLite table or temp dir) with an id + a hint that names our sub-agent path. Needs our sub-agent story wired to tool output — until then ship the grep/offset hint only. |
| 8 | **Byte-stable prompt-cache discipline** (≤2 system messages with stable header; per-user env blocks keyed to message creation time; pinned memory block; breakpoint placed *before* volatile tails; GPT-5.6 explicit breakpoints) | **ADAPT** | Our OpenRouter path benefits from implicit caching but we do nothing to stabilize prefixes: `prepareTurn` should (a) freeze the system prompt's identity/instructions header per session (only env-volatile parts may vary), (b) render any per-turn env details as append-only, timestamp-keyed synthetic content, (c) for anthropic-messages format add `cache_control` breakpoints on system + last stable user block via our chat.ts fetch chain. Skip GPT-5.6 explicit breakpoints (we have no native OpenAI key; OpenRouter handles it). |
| 9 | **Chunked map-reduce compaction** (0.6·usable chunks, 3-way parallel, depth-3 reduce, 2,048-token outputs) | **SKIP (for now)** | Correct but heavy: needs ephemeral worker sessions and our summarizer seam is single-shot. Revisit only if we ship models with tiny windows or owners hit "session too large to compact". Our hard-trim fallback already covers the failure mode. |
| 10 | **Kilo Memory (digests + typed facts + recall tools, 8KB index)** | **ADAPT** | We already have memory_recall + a session summary slice (compaction.ts:372-401, 400 chars). Adopt the *digest* upgrade path: per-session `{topic, summary}` written at turn close with the "where did we stop" prompt, injected as one capped index block pinned per session, recall tool for detail. SKIP the full typed-consolidation pipeline initially. |
| 11 | **`get_context_info` / `compact` model tools** | **ADAPT** | A cheap, high-leverage addition to our tool registry: a read-only `context_status` tool (tokens used/limit/remaining from the last usage row + model window) so the model can budget itself; optional `self_compact` later. |
| 12 | **TODO as durable per-session table (not transcript text)** | **SKIP** | We already persist todos as events (R96 nudge machinery) and the summary template (#1) carries "Next Move". No change needed. |
| 13 | **Snapshots = shadow git; revert deletes post-point messages** | **SKIP** | Our event-sourced log + compaction events already gives revert/fork the same semantics for free (compaction.ts header, ADR-0010). Shadow git for workspace rewind is a separate (large) workstream. |
| 14 | **1.25MB payload guard + 4MB strip-and-retry** | **ADAPT** | Cheap insurance at `prepareTurn`: after assembling, `Buffer.byteLength(JSON.stringify(messages))` > ~1.2MB → run the pruner (#4) once and warn. The 4MB recovery only matters for image-heavy sessions; our media policy is stricter already. |
| 15 | **Rules-file unification (AGENTS.md only; .roorules dropped; proximity instructions on read)** | **ADOPT (policy)** | Confirms our AGENTS.md-centric direction; steal the *proximity* trick — when `read` opens a file, surface nearby AGENTS.md once (deduped) — a tiny addition to our read tool's output assembly. |
| 16 | **Model-family prompt variants** (anthropic/gpt/gemini/codex... one prompt each, ~100 lines) | **SKIP** | Our provider-agnostic prompt is a deliberate product choice; per-family prompts are a maintenance tax. Revisit only with native Anthropic keys. |
| 17 | **Goals loop** (`goal_report`, autonomous re-injection) | **SKIP (v1)** | Attractive for the owner's long-horizon complaint but it changes the product surface (autonomy + permission interplay). Log as a candidate post-v1; the memory + structured-summary adoptions address the same pain more safely. |

Priority order for the next implementation round: **1 → 2 → 5 → 6 → 4 → 3 → 11 → 8**. Items 1+2+5+6 are pure `compaction.ts`/runtime-overflow-branch work with no new infrastructure; 4 needs one persisted flag; 3 threads an existing anchor; 11 is one tool; 8 is prompt-assembly discipline in `prepareTurn` + optional chat.ts fetch tweak.

## Sources

- Clone: https://github.com/Kilo-Org/kilocode @ c267794785fbb841c0edc87e02d02755a643bd5c (2026-09-26)
- `packages/opencode/src/session/` — compaction.ts, overflow.ts, prompt.ts, processor.ts, llm.ts, message-v2.ts, instruction.ts, system.ts, reminders.ts, todo.ts, summary.ts, revert.ts, llm/request.ts
- `packages/opencode/src/kilocode/session/` — overflow.ts, compaction-chunks.ts, compaction-payload-recovery.ts, prompt.ts, prompt-queue.ts, mode-reminders.ts, continuation.ts, retention.ts, goal/
- `packages/opencode/src/kilocode/` — system-prompt.ts, editor-context.ts, rules-migrator.ts, tool/context.ts
- `packages/opencode/src/provider/` — transform.ts, error.ts · `packages/opencode/src/tool/` — truncate.ts, read.ts, todo.ts, todowrite.txt · `packages/opencode/src/agent/prompt/` — compaction.txt, title.txt · `packages/opencode/src/session/prompt/` — anthropic.txt et al.
- `packages/core/src/session/compaction.ts`, `packages/core/src/util/token.ts`, `packages/llm/src/provider-error.ts`
- `packages/kilo-memory/src/` — schema.ts, recall/budget.ts, prompts/session-digest.txt
- `packages/kilo-indexing/src/indexing/search-service.ts`, `packages/opencode/src/snapshot/index.ts`
- Docs: kilo-docs/pages/customize/context/context-condensing.md, codebase-indexing.md, context/memory.md, customize/agents-md.md; kilo-vscode/webview-ui/src/components/chat/ContextProgress.tsx, settings/ContextTab.tsx
- Prior rounds: docs/research/kilocode/README.md (R108), architecture.md, patterns-for-acute-code.md
