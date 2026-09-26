<!-- last-reviewed: 2026-09-26 round-129 -->
# OpenCode — Context-Window Management (R129-R1 deep dive)

Cloned `github.com/sst/opencode` (→ `anomalyco/opencode`, branch `dev`) at **`696f41b` (2026-09-25)** into `/tmp/ref-opencode`, depth 50. All `FILE:LINE` citations below are against that tree. **License: MIT** (root `LICENSE`, "Copyright (c) 2025 opencode") — every pattern below is license-safe to adopt; house rule stays *patterns only, no code copying*.

Scope note: the repo contains **two session implementations**. The live one is `packages/opencode/src/session/` ("v1", the CLI/server that ships today); `packages/core/src/session/` is the in-progress Effect rewrite ("v2", with its own simpler compaction). Both are documented below — v1 is primary, v2 is the direction of travel. The historical "microcompact" (per-message tool-result *summarization* in pre-2026 versions) **no longer exists in the tree**; its successor is the **`prune`** mechanism (tool-output *clearing*), documented in §3.1.

Storage model in one line: **messages + parts are append-only rows in SQLite** (`MessageTable`/`PartTable`, hydrated by `message-v2.ts:98-123`); every model request is *re-derived* from those rows each turn; compaction never deletes rows — it marks a boundary and the assembly step hides/reorders what is sent.

---

## 1. Per-turn context assembly

**The loop.** `packages/opencode/src/session/prompt.ts:1081-1341` (`SessionPrompt.runLoop`). Each iteration of the agent loop:

1. **Reload + filter history**: `msgs = MessageV2.filterCompactedEffect(sessionID)` (`prompt.ts:1092-1094`) — full message stream from SQLite, then the compaction filter of §3.3.
2. **Extract state**: `MessageV2.latest(msgs)` (`message-v2.ts:586-602`) — last user / last assistant / last finished assistant + pending "tasks" (compaction or subtask parts).
3. **Overflow gate** (§5): `compaction.isOverflow({ tokens: lastFinished.tokens, model })` (`prompt.ts:1161-1168`) → if tripped, `compaction.create({auto:true})` and `continue` (the next iteration processes the compaction task instead of calling the provider).
4. **Reminders**: `SessionReminders.apply({messages, agent, session})` (`prompt.ts:1180-1184`) — plan-mode prompt/build-switch texts pushed as `synthetic: true` parts onto the *current user message* (`reminders.ts:15-90`). Nothing dynamic is ever injected into the system prompt.
5. **Tools resolved per turn**: `SessionTools.resolve({agent, session, model, processor, messages, ...})` (`prompt.ts:1226-1241`) — registry tools + MCP tools, filtered by permission ruleset and per-user tool toggles (`llm/request.ts:208-214`).
6. **System prompt assembled in parallel** (`prompt.ts:1257-1269`):
   ```ts
   const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
     sys.skills(agent),            // skills INDEX (names+descriptions), not bodies
     sys.environment(model),        // <env> block + project references
     instruction.system(),          // AGENTS.md / CLAUDE.md / CONTEXT.md / config URLs
     sys.mcp(agent, session.permission),
     MessageV2.toModelMessagesEffect(msgs, model),
   ])
   const system = [...env, ...instructions, ...(mcpInstructions ? [mcpInstructions] : []), ...(skills ? [skills] : [])]
   ```
7. **Send**: `handle.process({user, agent, system, messages: [...modelMsgs, ...(isLastStep ? [MAX_STEPS_PROMPT-assistant] : [])], tools, model})` (`prompt.ts:1272-1286`). On the last step the hard cap rides as an **assistant-prefill message** (`max-steps.ts:1-16`: "Tools are disabled until next user input. Respond with text only.").

**What the system prompt actually is** (`llm/request.ts:56-66`): ONE string, joined as
`[agent.prompt OR SystemPrompt.provider(model)] + env + instructions + mcp + skills + user.system`, sent as a single `role:"system"` message prepended to the messages array (`llm/request.ts:101-112`).

- **Base prompt is model-specific** (`session/system.ts:28-51`): `anthropic.txt` / `gpt.txt` / `gemini.txt` / `codex.txt` / `kimi.txt` / `meta.txt` / `trinity.txt` / `beast.txt` / `default.txt`… measured sizes 4.0 KB (`gpt-astra.txt`) to 15.4 KB (`gemini.txt`) — roughly **1–4 K tokens** (`prompt/` dir, `wc -c`).
- **Env block** (`system.ts:69-105`): model id, working directory, worktree root, is-git-repo, platform, `new Date().toDateString()`, plus `<available_references>` (project reference dirs). Deliberately tiny and *session-stable* (only the date line rotates daily).
- **Instructions** (`session/instruction.ts:60-68`): global `~/.config/opencode/AGENTS.md` (or `~/.claude/CLAUDE.md`), then the **first** project-level `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` found walking up from cwd (`instruction.ts:122-133` — "first match wins so we don't stack AGENTS.md from every ancestor"), plus config `instructions` (files or URLs).
- **Progressive instruction loading** (`instruction.ts:179-221`): when the `read` tool touches a file, nearby AGENTS.md files are attached *once per assistant message* (an in-memory `claims` map, `instruction.ts:70-77,196-218`), deduped against every instruction already loaded by earlier `read` calls via `part.state.metadata.loaded` (`instruction.ts:17-32`).
- **Skills are INDEXED, not loaded** (`system.ts:107-119`): the system prompt lists skill names+descriptions verbosely; the bodies load only through the `skill` tool — and `skill` outputs are exempt from pruning (`compaction.ts:31`).
- **Tool order is deterministic**: `tools: Object.fromEntries(Object.entries(tools).toSorted(([a],[b]) => a.localeCompare(b)))` (`llm/request.ts:184`) — alphabetically sorted every turn, a cache-stability detail.
- **MCP instructions** are folded into the system prompt as an `<mcp_instructions>` block, filtered to servers whose tools aren't all permission-denied (`system.ts:121-137`).

**Storage vs. wire.** Stored: append-only `message` + `part` rows (text, reasoning, tool with `{status, input, output, attachments, time}`, compaction, subtask, file parts — `message-v2.ts:131-419` converts). Sent: the AI SDK `UIMessage[]` shape converted by `convertToModelMessages` (`message-v2.ts:410-418`). The divergence points are exactly the inclusion/exclusion rules of §2 plus the compaction reorder of §3.3.

---

## 2. Inclusion / exclusion policy

`MessageV2.toModelMessagesEffect` (`message-v2.ts:131-419`) is the single authority:

**Never sent to the provider:**
- User text parts marked `ignored` and empty text (`message-v2.ts:210`).
- `text/plain` and directory file parts (`message-v2.ts:216` — "converted into text parts, ignore them"; only real media rides as file parts).
- Assistant messages that ended in `error` (skipped entirely, `message-v2.ts:252-260`) — unless aborted-with-content.
- `step-start` parts are stripped before conversion (`message-v2.ts:412`).
- Reasoning parts when the model changed mid-session (`differentModel`, `message-v2.ts:249,367-374`) — replayed as plain text instead, because signed reasoning from another provider is poison.
- Everything before the compaction boundary (§3.3).

**Always sent, with transformations:**
- A pending/running tool call becomes a synthetic `output-error` result: `"[Tool execution was interrupted]"` (`message-v2.ts:353-364`) — this is how **tool_use/tool_result pairs stay balanced** for Anthropic-style APIs. Call and result are stored *fused on the same assistant message*, so a turn-aligned cut can never orphan one side.
- Pruned tool outputs render as the literal marker `"[Old tool result content cleared]"` (`message-v2.ts:297-299`).
- Optional per-call truncation: `truncateToolOutput(text, maxChars)` — head-only + `"[Tool output truncated for compaction: omitted N chars]"` (`message-v2.ts:49-53`), only active when the caller passes `toolOutputMaxChars` (used by tests; the live path relies on the Truncate service below).
- Media in tool results that the target provider can't accept there is lifted into a following **user** message (`"Attached media from tool result:"`, `message-v2.ts:302-309,382-403`), with a per-provider capability table (`message-v2.ts:147-163`).

**Tool-output truncation strategy (the source-level cap)** — `packages/opencode/src/tool/truncate.ts`:
```ts
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024          // truncate.ts:14-15
// limits(): config tool_output.max_lines / max_bytes override   (:75-83)
// output(): head (default) or tail preview; full text written to a FILE  (:85-141)
const hint = hasTaskTool(agent)
  ? `...Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
  : `...Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
```
Key properties: (a) dual limit **2000 lines / 50 KB** per tool result, configurable; (b) head-or-tail *direction* per tool; (c) the elided content is **not lost** — it spills to a file under the truncation dir (7-day retention, hourly cleanup, `truncate.ts:12,53-66,143-148`) and the marker is a **reference, not just an apology**: the model is told exactly how to get the content back (grep/read offset-limit, or delegate to the explore subagent). Config: `tool_output.max_lines` / `tool_output.max_bytes` (`core/src/v1/config/config.ts:136-148`).

**Old tool results as the conversation grows**: two tiers — the replay-time `truncateToolOutput` cap is fixed, and the persisted `prune` pass (§3.1) *clears* outputs older than a 40 K-token protection window so they stop costing anything at all.

---

## 3. Compression / compaction

### 3.1 Tier 1 — `prune` (the microcompact successor: clear old tool outputs)

`packages/opencode/src/session/compaction.ts:271-317`:
```ts
export const PRUNE_MINIMUM = 20_000          // don't bother pruning below this gain
export const PRUNE_PROTECT = 40_000          // keep this many tokens of recent tool outputs
const TOOL_OUTPUT_MAX_CHARS = 2_000          // cap inside the summarizer transcript
const PRUNE_PROTECTED_TOOLS = ["skill"]      // never prune skill bodies
```
Walks messages **backwards**; skips the current turn entirely (`turns < 2` continues, `compaction.ts:290-291`); stops at the first already-compacted part (`part.state.time.compacted` — prune is idempotent and monotonic, `:298`) and at summary messages (`:292`); accumulates `Token.estimate(output)` until the protected 40 K tokens are covered; every tool output **older than that window** is marked for clearing — and only actually cleared if the reclaimable mass exceeds `PRUNE_MINIMUM` (20 K, `:308`). Clearing = `part.state.time.compacted = Date.now()` persisted via `session.updatePart` (`:309-313`). On the wire those parts become `"[Old tool result content cleared]"` (`message-v2.ts:297-299`).

Trigger point: **forked after every loop exit** — `compaction.prune({sessionID}).pipe(Effect.ignore, Effect.forkIn(scope))` (`prompt.ts:1338`). Gated by config `compaction.prune` (`config.ts:154-156`, **default false — opt-in**).

### 3.2 Tier 2 — full compaction (`process`)

`compaction.ts:319-557`. Anatomy:

1. **Entry**: a *user message with a `compaction` part* is created (`create`, `compaction.ts:559-582`) — either by the auto trigger (`prompt.ts:1166`, `processor.ts` returning `"compact"` at `prompt.ts:1320-1328`) or the manual `/compact` command. The part records `{auto, overflow, tail_start_id}`.
2. **Tail selection** (`select`, `compaction.ts:223-269`): a **recent-turn budget**, not a percentage of the head:
   ```ts
   // preserveRecentBudget (compaction.ts:115-120):
   input.cfg.compaction?.preserve_recent_tokens ??
     Math.min(15_000, Math.max(2_000, Math.floor(usable(model) * 0.25)))
   ```
   Turns are user-message-aligned (`turns`, `:122-138` — a turn = user msg → just before the next user msg, **never splitting an assistant exchange**, and tool call+result live on the same assistant message so pairs are structurally safe). Selection walks turns newest→oldest while they fit the budget; an over-budget turn can be **split mid-turn** by a byte walk (`splitTurn`, `:140-163`). Optional hard cap: `compaction.tail_turns` (count of recent turns, `config.ts:157-160`).
3. **What is summarized**: everything before the tail (the `head`), *serialized to flat text* (`serialize`, `:54-85`) as `[User]: …` / `[Assistant]: …` / `[Assistant tool call]: name(json)` / `[Tool result]: …` with each tool result capped at `TOOL_OUTPUT_MAX_CHARS = 2_000` chars (`:51-52`) and pruned results shown as `"[Old tool result content cleared]"` (`:76-78`). **Prior compactions are hidden from re-summarization** (`completedCompactions` → `hidden` set, `:97-113,364-371`) and their summary is threaded forward as `<prior-summary>` (see §6).
4. **The summarizer call** (`compaction.ts:393-448`): a dedicated **hidden `compaction` agent** (`agent/agent.ts:219-233`: 630-byte prompt, all tools denied) using the *compaction agent's configured model or the session's model* (`:358-361`); `processor.process` is invoked with **`tools: {}`, `system: []`, and a single user message** containing the prompt from `buildPrompt` — so the summarizer cannot call tools and its only system is the tiny compaction-agent prompt (via `llm/request.ts:60`).
5. **The summary lands as a real assistant message** with `mode/agent: "compaction"`, `summary: true`, parented to the compaction user message (`:393-419`) — same storage, same event stream.
6. **The compaction-part's `tail_start_id` is updated** if selection moved (`:461-466`).
7. **Resume**: for auto compactions a **synthetic user message** `"Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."` (`:527-547`, `metadata.compaction_continue`) — and on the *overflow* path the pre-overflow user message is **replayed verbatim** (fresh ids, media demoted to `[Attached mime: name]` text, `:468-495`) so the original ask survives.
8. **Failure**: if the compaction request *itself* overflows, the session errors out honestly ("Session too large to compact…", `:450-459`).

### 3.3 What the provider sees after a compaction — `filterCompacted`

`message-v2.ts:525-576`. Chronology is **rewritten, not truncated**:
```
[user "What did we do so far?" (the compaction part), assistant <summary>, ...retained tail (from tail_start_id)..., ...everything after the compaction...]
```
(the reorder block `message-v2.ts:568-573`; the compaction part renders as the text `"What did we do so far?"` at `message-v2.ts:232-237`). So the summary is injected as a normal Q/A pair near the *front* of the visible conversation, and the preserved tail follows it — the model reads a coherent short conversation, and the provider sees balanced roles. Pinned by `test/session/message-v2.test.ts:1657-1699` (layout `[continueUser, summaryAssistant, compactionUser, overflowAssistant, tailUser]` after reorder).

### 3.4 The v2 (core) compaction — direction of travel

`packages/core/src/session/compaction.ts` is a standalone, DB-event-driven version with an explicit **pre-send estimate trigger** (`compactIfNeeded`, `:232-243`):
```ts
if (estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools })
    <= context - Math.max(output, config.buffer)) return false    // buffer default 20_000 (:12)
```
plus `keep.tokens` default **8_000** (`:13`), summary output cap **4_096** tokens (`:15`), a string-level recent-window `select` (`:137-158`), and a guard that refuses to compact when the summary prompt itself wouldn't fit (`:190`). Its summary template is the "anchored summary" of §6.

---

## 4. Token counting

- **Estimation (planning)**: `packages/core/src/util/token.ts` — the whole file:
  ```ts
  const CHARS_PER_TOKEN = 4
  export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))
  ```
  No tiktoken, no BPE — chars/4 everywhere compaction/tail budgets are computed (`compaction.ts:215-221,299`; `core/compaction.ts:83,149,190`). Deliberately cheap; correctness comes from provider numbers.
- **Exact (triggering)**: provider-reported usage from every `step-finish` — normalized in `Session.getUsage` (`session/session.ts:338-405`): `inputTokens` (AI SDK v6 *includes* cached tokens → subtracted, `:361-364`), `reasoningTokens` split out of output, `cacheWrite` recovered from four different provider metadata spellings (`:345-359`). Cost tiers pick per-context-size pricing (`:380-386`).
- **Window sizes**: from the **models.dev catalog** — `limit: { context, input, output }` (`provider/provider.ts:1284-1288` from `fromModelsDevModel`). `usable()` prefers `model.limit.input` when the catalog declares one (`overflow.ts:17-19`).

## 5. Auto-compaction triggers + overflow retry ladder

Three trigger points, all feeding the same compaction task:

1. **Post-step usage** (mid-turn): on every `step-finish`, `isOverflow({tokens: usage.tokens, model})` → `ctx.needsCompaction = true` (`processor.ts:491-496`) and the stream is **stopped early**: `Stream.takeUntil(() => ctx.needsCompaction)` (`processor.ts:656-660`). The process call then returns `"compact"` (`:693`).
2. **Loop-top usage**: `compaction.isOverflow({tokens: lastFinished.tokens, model})` (`prompt.ts:1161-1168`).
3. **Provider rejection**: `ContextOverflowError` from the stream → `halt` sets `needsCompaction` (unless `compaction.auto === false`, in which case it's a hard error) (`processor.ts:621-632`) → `"compact"` → `compaction.create({overflow:true})` (`prompt.ts:1320-1328`).

**The threshold itself** (`overflow.ts:8-34`):
```ts
const COMPACTION_BUFFER = 20_000
usable  = (limit.input ?? limit.context) - (cfg.compaction?.reserved ?? min(20_000, maxOutputTokens))
isOverflow = count >= usable      // count = tokens.total || input + output + cache.read + cache.write
```
i.e. compaction fires when provider-reported context **reaches ~100 % of the window minus a ~20 K reserve** — there is *no* 80 %-style early trigger in v1. (The v2 `compactIfNeeded` is the estimate-based pre-send variant, §3.4.)

**Retry ladder** (`session/retry.ts`): max **5 retries**, 2 s initial ×2 backoff +25 % jitter, capped 30 s without headers / 32-bit max with; honors `retry-after-ms` / `retry-after` (seconds and HTTP-date forms) (`:26-83`); retryable classification = 5xx always + a regex battery of rate-limit/overload/network phrases (`:33-41,85-155`). **Context overflow errors are explicitly NOT retried** (`:86-87`) — they go straight to the compaction path. Status surface: every attempt publishes a `retry` status with attempt/message/next-retry time (`processor.ts:674-688`).

**Overflow recovery detail** (`compaction.ts:340-356`): on the overflow path, the pre-overflow user message is remembered as `replay`; if the log still has earlier real user content, history is cut before the replay message so the compaction summarizes everything *except* the ask, then re-inserts it after the summary (§3.2 step 7). Media in the replayed message is demoted to text placeholders — "The previous request exceeded the provider's size limit due to large media attachments…" teaching text at `:527-531`.

## 6. Long-horizon support (state across compaction)

- **Anchored summary template** — `core/src/session/compaction.ts:16-55`: a fixed Markdown skeleton the summarizer MUST reproduce: `## Objective / ## Important Details / ## Work State (Completed | Active | Blocked) / ## Next Move (1,2) / ## Relevant Files`, with rules "Keep every section, even when empty", "terse bullets", "**Preserve exact file paths, symbols, commands, error strings, URLs**", "Do not mention the summary process". The compaction agent prompt (`agent/prompt/compaction.txt`) reinforces the same contract.
- **Prior-summary threading**: `<prior-summary>` + `SUMMARY_UPDATE_INSTRUCTIONS` (`core/compaction.ts:47-55`): carry forward objectives/constraints/decisions "even when the conversation does not mention them"; "the conversation wins" on conflict; move completed work Active→Completed; update Objective/Next Move. The prior summary is *discarded* after folding — one summary, always current. In v1 the same threading happens via `buildPrompt({previousSummary, context})` (`core/compaction.ts:160-174`, used at `opencode/compaction.ts:381-391`).
- **Todo state**: a DB table + `todowrite` tool whose output echoes the full list back to the model (`tool/todo.ts:36-42`) — the todo list re-enters context only when the model updates it; it is NOT re-injected into the system prompt.
- **Plan files**: plan mode writes a plan file and the build agent gets "A plan file exists at … execute on the plan" (`reminders.ts:52-67`) — durable state *in the repo*, out of context.
- **Skills + AGENTS.md are re-read on demand** (and `skill` outputs are prune-protected, `compaction.ts:31`) — instructions survive compaction by being reloadable rather than by being carried in the summary.
- **v2 direction — context epochs**: `core/src/session/context-epoch.ts:40-78` stores a system-context *baseline*; when the env/instructions drift it either silently replaces the baseline or emits a `ContextUpdated` **system message** into the event log — environment changes become explicit conversation events instead of silent prefix mutations.

## 7. Prompt-caching awareness

`packages/opencode/src/provider/transform.ts`:

- **Cache breakpoints** (`applyCaching`, `:358-399+`): `cacheControl: {type:"ephemeral"}` (Anthropic phrasing) is attached to the **last 2 system messages + last 2 non-system messages** — with per-provider spellings (anthropic / openrouter / bedrock `cachePoint` / openaiCompatible `cache_control` / copilot / alibaba, `:362-381`) and a message-level vs content-part-level decision per provider (`:383-399`). Two breakpoints at each end = the classic "growing prefix + volatile tail" cut.
- **Session-stable cache keys**: `prompt_cache_key`/`promptCacheKey` = **sessionID** for openai/azure/xai/mistral/deepinfra/cerebras/venice/opencode-gateway (`:1323-1336,1380-1384`) — routing-level cache affinity.
- **Stable-prefix discipline by construction**: alphabetical tool sort (`llm/request.ts:184`); system = static base prompt + env + instructions + skills index; ALL per-turn variability (plan reminders, compaction continue, queued messages) rides **user messages**, never the system prompt; the env block's only volatile line is the date. The compaction reorder (§3.3) deliberately places the summary pair before the retained tail so the *tail* keeps its chronological prefix.
- Anthropic-empty-content and reasoning-signature edge cases are scrubbed before caching (`transform.ts:168-222,266-278`).

## 8. Fork / revert

- **Fork** (`session/session.ts:691-732`): clones messages up to a messageID into a new session, remapping ids — **including the compaction part's `tail_start_id`** (`:725-727`), so a fork inherits the compacted view (summary + tail) intact. Context is neither restored nor re-expanded.
- **Revert** (`session/revert.ts:38-124`): records `{messageID, partID}` + a file snapshot; the actual message deletion is **deferred to the next prompt** — `prompt.ts:458-460` runs `revert.cleanup(session)` at the top of the next turn, which **removes every message after the revert point** (`revert.ts:101-124`). So revert genuinely *trims* future context (and can revert *past* a compaction, resurrecting the original messages, because compaction never deleted them).

## 9. Structure limits

- **No cap on message count sent** — the full (post-compaction-filter) history rides every request; DB paging is 50/page but only for loading (`message-v2.ts:473-494`).
- **No cap on tool count** — permission-filtered only; a `_noop` tool is injected only for Copilot replay compatibility (`llm/request.ts:159-175`).
- **Per-tool output**: 2000 lines / 50 KB (§2); **summarizer transcript**: 2 K chars per tool result (§3.2); **summary output**: 4 096 tokens (v2) (§3.4); **maxOutputTokens** = `min(model.limit.output, 32_000)` (`transform.ts:18,1481-1483`).
- **Agent steps**: `agent.steps ?? Infinity` for `build` (`prompt.ts:1178`) — the practical bound is the max-steps assistant prefill (`prompt.ts:1279-1282`).
- **MCP resource blobs**: 10 MB attachment gate (`prompt.ts:65,84-94`).

---

## ACUTE-CODE mapping — what explains the owner's complaint, and the adoption table

Our current state (all verified this round): `agent-core/src/agents/compaction.ts` (R128: single-tier summarize, round-aligned selection, 60 % keep-target, 75 % materiality guard, provider-usage anchor, rapid-refill breaker), `runtime.ts` (`prepareTurn` ~:1491, `assembleHistory` :1046 with `RECENT_TOOL_RESULTS=8`, `OLD_TOOL_STUB_CHARS=200`, `MAX_TOOL_BLOCK_CHARS=48 000`, `STICKY_STUB_CHARS=8 000`, `RESUME_RECENT_TOOL_RESULTS=40`; compaction gate at both loop tops :2394/:3864; context guard :2457), `chat.ts` (`summarizeToolOutput` :854 — 4 000-char head+tail cap, sticky tools 60 K; `aiSdkChat` :669 — `generateText` with `system` + messages, `stopWhen: stepCountIs`, `maxRetries: 4`), `context.ts` (±15 % BPE-approx estimator), budget = `contextWindow − maxOutputTokens − 8 000 margin` (`resolveTurnBudget` :5466).

Context-inflation suspects in OUR runtime, against OpenCode's numbers:
1. **Sticky tool outputs**: `STICKY_OUTPUT_BUDGET = 60 000` chars per `read_skill`/`memory_recall` result rides *every* replay until the 48 K block cap bites (OpenCode: 50 KB hard per result, spill-to-file, prune clears). Several loaded skills ≈ 15 K tokens each, forever.
2. **System prompt mass**: skills index 12 K chars + always-on skill bodies 24 K chars + identity + tools + env + memory digest + todos + task/mode hints — all re-sent every turn, with per-turn-varying sections (taskHints, todoList, backgroundTasks, git branch) that also defeat prefix caching.
3. **Resume window 40 full results** and the 8-full-results window counts CALLS, not tokens.
4. The meter undercount was already fixed (R127-W4 provider anchor) — the visible "100 M in no time" is the *estimate catching up with reality*, plus the above.

| # | OpenCode mechanism (evidence) | Verdict | Concrete ACUTE-CODE change |
|---|---|---|---|
| 1 | **Tool-output spillover file + pointer hint** (`tool/truncate.ts:85-141`, 2000 lines/50 KB, "Full output saved to: …Use Grep/Read offset-limit") | **ADOPT** (MIT) | `chat.ts summarizeToolOutput` (:854): when over the 4 K budget, write the full output to a per-session artifacts file (sidecar already owns a data dir), keep head+tail preview, and append the pointer hint. `read_file` already supports offset/limit (`tools/fs-ops.ts:234-240`, plus head+tail auto-paging for huge files) — the hint would name a real capability, zero new tooling needed. |
| 2 | **Anchored summary template + prior-summary merge rules** (`core/session/compaction.ts:16-55,160-174`) | **ADOPT** (MIT) | Replace `SUMMARIZER_SYSTEM_PROMPT`'s free-form "~600 words" (compaction.ts:791-799) with the fixed sections Objective / Important Details / Work State (Completed/Active/Blocked) / Next Move / Relevant Files + "preserve exact paths/commands/error strings" + prior-summary folding with "conversation wins" rules. Cap summarizer output tokens (~4 K). Directly targets the owner's "cannot handle long horizon tasks, keeps hallucinating". |
| 3 | **Prune tier (persisted clearing of old tool outputs)** (`opencode/compaction.ts:271-317`: protect 40 K tokens, minimum 20 K gain, protected tools, idempotent marker) | **ADAPT** | We already stub to 200 chars at replay, but the stub is recomputed from full stored outputs and the 8-full window counts calls. Adapt as: a *token-budgeted* fidelity window (e.g. protect ~40 K estimated tokens of recent results instead of 8 calls) + persist a `compacted` flag on `tool.use` events (append-only marker event, ADR-0010-safe) so old `outputSummary` bodies stop riding any replay/meter path; keep `read_skill`/`memory_recall` protected (our sticky law already matches theirs). |
| 4 | **Mid-turn usage trigger + early stream stop** (`processor.ts:491-496,656-660`; `Stream.takeUntil(needsCompaction)`) | **ADAPT** | Our gate runs at loop top only; within one `chat()` call the SDK runs many tool steps with no overflow re-check. Adapt at the seam we own: in `aiSdkChat`/`streamAiSdkChat` `onStepFinish` (chat.ts:700-709), compare `result.usage.inputTokens` to the turn budget and abort the multi-step loop early with a typed "needs compaction" signal the runtime maps to the existing force path (R71-e2). |
| 5 | **Prompt-cache discipline: cache breakpoints + session cache key + static system prefix** (`transform.ts:358-399,1323-1336`; alphabetical tools `llm/request.ts:184`; zero dynamic system content) | **ADOPT (cache key + ordering) / ADAPT (breakpoints)** | (a) Sort our tool map deterministically before send; (b) emit `promptCacheKey: sessionId`-equivalent for OpenRouter/openai-compatible in the chat adapters (we already *read* `cacheReadTokens` in usage — make the write side intentional); (c) reorder `buildProjectSystemPrompt` so volatile sections (todos, task hints, background tasks, git branch) render LAST or move to the user message — the stable identity/tools/env/memory prefix first. Breakpoints (`cache_control`) only for the anthropic-messages adapter. |
| 6 | **Tail budget = clamp(25 % usable, 2 K–15 K)** vs our 60 % keep-target (`compaction.ts:115-120` vs compaction.ts:695) | **ADAPT** | Our 60 % keeps a huge verbatim tail post-compaction (on a 200 K window that's ~110 K tokens); OpenCode keeps ≤15 K + a folded summary. Make the keep-target a knob (agent-level first), default ~35–40 % for large windows, and keep the round-aligned law. Smaller post-compaction context = slower refill = fewer compactions = less thrash (complements our D5 breaker). |
| 7 | **Compaction as a hidden agent with no tools** (`agent/agent.ts:219-233`, `processor.process({tools:{}, system:[], messages:[one user msg]})` `compaction.ts:425-448`) | **ADOPT (one half)** | Verified: our summarizer call already matches the shape exactly — no tools, `maxTurns: 1`, single user message, tiny system (`compaction.ts:911-920`). The missing half: a **cheaper summarizer model override** (their `compaction` agent can pin a small model; we always spend the session's model on the summary). Add an optional summarizer-model column/setting threaded into `assembleWithCompaction`'s deps. |
| 8 | **Overflow recovery: replay the pre-overflow user message after compaction + media demotion** (`compaction.ts:340-356,468-495`) | **ADAPT** | We force-compact on overflow (R71-e2) but the original ask can end up inside the summarized head. Adopt the replay: after a forced compaction, re-insert the overflowed turn's user message verbatim (media already render as attachments in our fold) so the task survives the emergency compaction. |
| 9 | **Deterministic env block; context-epoch reconcile for env drift (v2)** (`system.ts:69-105`, `core/session/context-epoch.ts:40-78`) | **SKIP (epoch) / ADAPT (env)** | The epoch machinery is Effect-bound and heavy. But cache our `buildPromptEnvironment` per session (re-probe only git branch on demand) so the system prefix stays byte-stable across turns of one session. |
| 10 | **chars/4 estimator** (`core/util/token.ts`) | **SKIP** | Our ±15 % BPE-approx estimator is strictly better and already provider-anchored (R125-C/R127-W4). |
| 11 | **Effect session framework, plugin hooks (`experimental.chat.messages.transform`, `session.compacting`)** | **SKIP** | Wrong stack for us; our ADR-0010 append-only event log already covers the durability these hooks provide. |
| 12 | **Retry ladder with retry-after honoring + overflow-not-retried** (`retry.ts:26-155`) | **ADOPT (small)** | We already have `maxRetries: 4` SDK-side (chat.ts:685) and overflow→force-compaction; add explicit `retry-after` header honoring in the model-fallback fetch and keep the "context overflow is never retried, it compacts" law documented in one place. |

**Recommended order** (impact × risk for the owner's exact complaints): #2 (summary template — fixes long-horizon hallucination) → #1 (spillover files — fixes "useless unneeded data" while keeping data reachable) → #5 (cache discipline — cost/latency, zero behavior risk) → #3 (prune tier — caps steady-state growth) → #6 (tail knob — anti-thrash).

## Sources

- Clone: `https://github.com/sst/opencode` (→ anomalyco/opencode, `dev`) @ `696f41bc8e7586657375d53390925fc54c25d34c` (2026-09-25), depth 50, at `/tmp/ref-opencode`.
- `packages/opencode/src/session/`: `prompt.ts`, `compaction.ts`, `overflow.ts`, `message-v2.ts`, `processor.ts`, `retry.ts`, `reminders.ts`, `system.ts`, `instruction.ts`, `summary.ts`, `todo.ts`, `revert.ts`, `session.ts`, `llm.ts`, `llm/request.ts`, `prompt/*.txt`.
- `packages/opencode/src/`: `tool/truncate.ts`, `tool/todo.ts`, `agent/agent.ts`, `agent/prompt/compaction.txt`, `provider/transform.ts`, `provider/provider.ts`.
- `packages/core/src/`: `session/compaction.ts`, `session/context-epoch.ts`, `session/runner/max-steps.ts`, `util/token.ts`, `v1/config/config.ts`.
- Tests confirming behavior: `packages/opencode/test/session/compaction.test.ts` (prune/overflow/process/token-estimate suites), `message-v2.test.ts` (filterCompacted reorder + latest regression).
- Prior house docs: `docs/research/opencode/README.md` (R108 — license + canonical-repo verification), `architecture.md`, `patterns-for-acute-code.md`.
