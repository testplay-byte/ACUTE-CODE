<!-- status: planning (PLAN-ADOPT, R105) — the R105 implementation set is named in §"The verdicts" -->
<!-- source-study: https://github.com/can1357/oh-my-pi (MIT; see OMP research notes below) -->
<!-- planning-round: 1 of N (the owner's multi-round directive) -->

# The oh-my-pi Adoption Roadmap (PLAN-ADOPT)

Round 105's planning artifact for the owner's directive: "take the best
parts from this GitHub repository, learn from them, and handle them with
care, with proper understanding, and with proper planning." Grounded
read-only in ACUTE-CODE's real code: the LLM boundary is
`agents/chat.ts` (`aiSdkChat`/`streamChat` → `buildModel`, Vercel AI
SDK; tool_calls parsed by the SDK via `extractToolCalls`); the
established extension pattern there is **composed fetch wrappers**
(`buildModelFallbackFetch` R43, `buildThinkingFetch` R95,
`buildOutputCapFetch` R96, `withAppAttribution`); prompts are built per
turn in `runtime.ts prepareTurn` → `buildProjectSystemPrompt` with
per-turn volatile sections baked into the system prompt (composition
byte-pinned by golden fixtures); retries are three-layer (SDK
`maxRetries:4` → overflow-recovery → `lib/retry.ts` R75/R80 ladder) with
9-class `error-classification.ts`; compaction is single-tier summarize
(`compaction.ts`, 3 triggers; tool outputs already head+tail-truncated
at persistence); the edit tool is `fs-ops.ts editFile/editFileMulti` +
`edit-streak.ts` escalation; steering injection already exists (R94-D1
`consumeQueuedForStep`); fork is a deliberate full-copy (R44-c), no
parent linkage.

## Candidate assessment table

| # | Candidate | Effort | Landing spot (file → function) | Key deps | Risk vs gates | Verdict |
|---|---|---|---|---|---|---|
| 1 | In-band tool-call dialects | M-L | `agents/chat.ts buildModel` (new fetch wrapper, composed under attribution) + new `agents/dialects/` pure modules + `ChatTurnInput.toolDialect` + models-table column (migration 0039) + `prepareTurn` threading | Benefits from #3; none hard | MED-HIGH (response-body SSE re-encode is new ground) but pure-function testable; gated NULL=native → byte-identical, goldens safe | **R105/106** |
| 2 | StablePrefix / cache reuse | S-M | `prompts.ts buildProjectSystemPrompt` split (stable prefix + volatile tail), `runtime.ts prepareTurn`, `chat.ts` sends tail as trailing context; win measurable via existing `cachedInputTokens` meter | After #1 (dialect changes system bytes); trips golden fixtures → deliberate re-pin | MED (byte-pinned goldens, R71 prompt-discipline tests) | **NEXT (R106)** |
| 3 | Rate-limit reason taxonomy + lessons state | S-M | `error-classification.ts` (rate_limit → quota/rate/capacity reason), `lib/retry.ts` reason-aware rung selection, `runtime.ts` catch blocks, `resolveKeyPool` interplay, small storage migration | Feeds #4; composes with #1 | LOW (pure classifier + additive fields; existing ladder tests pin defaults) | **R105** |
| 4 | Model roles + fallback chains | M | `prepareTurn` model resolution (role→chain→served candidate), `storage/settings.ts` new role config, `storage/usage.ts` origin attribution (0031 origin exists), ModelsProvidersTab UI | **Depends on #3** (reason decides fallback vs wait); encodes benchmark winners (cohere primary, nemotron fallback) | MED (UI → design-audit ratchet R2; tests for turn resolution) | **NEXT (R106/107)** |
| 5 | Compaction shake→prune→summarize | M | `compaction.ts assembleWithCompaction` (mechanical elision tier before summarizer call), `runtime.ts` extra triggers (mid-turn, stopReason=length) | — | LOW-MED (`context-compaction.test.ts` exists; persistence-side outputs already bounded 4K/60K) | **LATER (R107+)** |
| 6 | Edit auto-repair (smol model) + blackbox | S-M | `tools/plugins/filesystem.ts` (needs ChatFn dep — layer change), new recorder storage | Needs #4's "smol" role | MED (tool layer gains model-call semantics; costs/attribution) | **LATER** |
| 8 | Session tree (parent_id + leaf) | M | `storage/sessions.ts forkSession` → pointer tree; touches `assembleHistory`, compaction seq anchors, revert, snapshots | — | HIGH vs LOW value (fork-copy is a documented R44-c contract; owner hasn't complained) | **SKIP** (revisit only on owner ask) |
| 9 | Single agent loop dedupe | L | `runtime.ts runSingleAgentTurn`/`runStreamedAgentTurn` (~800 lines ×2; steering already exists via R94-D1) | — | HIGHEST (subtle per-path error/abort/compaction semantics; 4,524-line runtime) | **LATER** — dedicated parity round |
| 10 | read tree-sitter summarization + LRU | M | `tools/fs-ops.ts readFileWindow`, Rust sidecar crate (CI cargo-check like R104) | — | MED (new native dep → license-audit; auto-index/search_symbols already cover structure) | **LATER** |
| 11 | Todo phases + mid-run nudges | S-M | `agents/system-reminders.ts` (ReminderBudget is the exact rail — "note" kind) + todo plugin | — | LOW | **LATER** (cheap filler item) |
| 12 | Prompts as .md assets | S | **Already covered**: R59-F `prompt-registry.ts` + `.acute/prompts/<id>.md` overrides + `_order.txt` + DB overrides | — | Golden churn for ~zero user value | **SKIP** |

## The R105 set (quality over speed — two items)

**R105-A: Tool-call dialects, scoped to two dialects (qwen3-hermes +
deepseek), default-off.** The benchmark's core finding — several free
models FAIL native tool calls — makes this the highest-value item; it
converts the owner's unusable free models into working ones. First
steps:

1. `agent-core/src/agents/dialects/qwen3.ts` + `deepseek.ts` (pure, no
   SDK imports): `encodeRequestBody(body)` — strip `tools`, append the
   dialect tool advertisement (formats documented in oh-my-pi
   `docs/toolconv/*.md`, MIT, attributed) into the system message,
   re-encode assistant `tool_calls` history into in-band call blocks;
   and `decodeResponseBody(text)` / `decodeSseChunk(chunk)` — parse
   in-band call markers in `choices[].delta.content` into native
   `tool_calls` entries (generated ids), strip markers from content.
   Unit-test against fixture JSON bodies (the `buildModelFallbackFetch`
   test pattern).
2. `chat.ts`: `buildDialectFetch(dialect, inner)` composed in
   `buildModel`'s existing chain (inside `withAppAttribution`, above
   thinking/cap) — rewrites the outgoing body and returns a re-encoded
   `Response` (buffered rewrite for the JSON shape `generateText` uses;
   `TransformStream` for SSE `streamText`). `ChatTurnInput` gains
   `toolDialect?: string`; absent → no wrapper, byte-identical (the
   R95-E gating discipline).
3. Migration `0039_model_tool_dialect.sql` (`models.tool_dialect TEXT`,
   NULL = native) following the 0030 tri-state contract; `prepareTurn`
   resolves and threads it exactly like `reasoningSupport`.
4. Gate plan: pure encode/decode suites + a `chat-format.test.ts`-style
   stubbed-fetch integration test asserting `extractToolCalls` recovers
   in-band calls through `aiSdkChat`; IMPLEMENTED-API.md
   honest-limitation note marking live-untested dialects.

**R105-B: Rate-limit reason taxonomy + per-model lessons state.** The
other half of the benchmark finding (models that rate-limit hard). First
steps:

1. `error-classification.ts`: add `rateLimitReason?: "quota" | "rate" |
   "capacity"` to `ProviderErrorClassification` + pure
   `classifyRateLimitReason(unwrappedText, status)` (quota:
   daily/monthly/credits/request-quota patterns; rate: RPM/TPM/
   per-second; capacity: 503/overloaded; unknown → undefined — honest).
   Reuse the R78 unwrapping.
2. `lib/retry.ts`: reason-aware rung selection in the ladder call site
   (runtime.ts catch blocks): quota → skip the short rungs (jump to
   10/30-min) or fail over to the next R92-D pool key; rate/capacity →
   unchanged default ladder. Additive only — default behavior
   byte-identical when reason unknown (tests pin it).
3. Migration `0040_provider_lessons.sql` (model, provider, reason,
   count, lastTs) written on each rate-limited catch; read-only
   surfacing deferred (no UI this round → design-audit ratchet
   untouched).
4. Tests: pattern suites from real OpenRouter bodies (the worklog's
   live-fire catches supply verbatim examples), ladder-selection tests.

## Sequencing rationale

R105 attacks the owner's two live pains (tool-call failures + rate
limits) in modules with proven test patterns and additive gating; **R106**
then lands #2 StablePrefix (golden re-pin done deliberately in focus,
win proven by the existing cache-hit-rate meter) and/or #4 roles+chains
(now fed by #3's reasons — the benchmark winners become the seeded
default chain); **R107+** takes #5 compaction tiers and #11 nudges; #9
gets a dedicated parity round only after the dialect work stabilizes the
same files. #12 and #8 are skipped: the repo already has idioms that
cover them (R59-F overrides; R44-c fork-as-copy), and the append-only
event log + compaction seq anchors make a pointer-tree a high-risk
storage rewrite for a capability the owner already has.

## Gate cautions

Both R105 items must preserve the "absent → byte-identical" discipline
(dialect NULL/native; reason undefined) so the 3,823+2,392 suites and
prompt goldens stay green without edits; per the R104 hotfix lesson
(AGENT-MEMORY #105(e)), run every gate with true exit codes — no pipes.

---

## The oh-my-pi study — research summary (RESEARCH-OMP)

License: **MIT** (no conflict with the license-audit allow-list). An
extremely active Bun+TypeScript monorepo (16 packages) plus ~80k lines
of Rust N-API natives; 60+ providers, 31 tools, LSP and DAP integration,
subagents, sessions-as-trees, four entry points (TUI, one-shot `-p`,
JSON-RPC-over-stdio, ACP). Also-pilferable quick list: two-tier tool
loading (essential tools get full schemas; "discoverable" tools render
as a compact inventory in the system prompt — huge token saver); TTSR
stream rules (regex match mid-stream → abort → inject rule → resume —
guard rails for flaky models); the advisor second model with watchdog +
loop-guard; `+Nk` turn token-budget directives; magic keywords scoped
to prose; shell completions generated from live flag metadata. What NOT
to adopt: the Bun runtime requirement, the Rust N-API natives
architecture, the bundled 11MB static models.json (query dynamically),
the collab/browser-relay/voice features, speculative tool execution
(someday).
