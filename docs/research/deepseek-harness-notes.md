<!-- last-reviewed: 2026-09-10 round-83 -->
# deepseek-harness — Loop-Hygiene & Plugin-Architecture Reference for ACUTE-CODE

**Why this analysis exists (owner direction, 2026-08-30, R51):** the owner
shared one more GitHub repository — DeepSeek Harness — with the instruction to
"look at it, consider some things from it and implement them in our project."
This memo is the study; **R51-f implements its single best applicable idea**
(the loop-hygiene guard) in `agent-core/src/agents/runtime.ts`. Sources: the
repository cloned at `/tmp/deepseek-harness` (commit at clone time;
`packages/**` + `docs/architecture.md` read directly — no web research needed).

## What deepseek-harness is (60 seconds)

An open-source **agent harness** from DeepSeek AI (`dsh`): a Cordis-based,
all-plugin agent runtime with a web UI, headless runner, SDK, and ACP server
profiles. `packages/` holds ~60 packages covering the full agent surface —
guard, compaction, todo, subagent, session (log/persistence/telemetry/titles),
context providers, plan mode, skills, hooks, interaction (commands/approvals/
questions), sandbox, LSP, MCP, webhooks, and the agent loop itself. It is a
*developer preview* with explicit breakage warnings, but the package-level
engineering discipline (fail-loud config, documented invariants, README-per-
package with a "Known Limitations" contract) is first-rate.

## Architecture (what it is, and what's genuinely novel)

**Everything is a plugin, literally.** dsh is built on
[Cordis](https://github.com/cordiverse/cordis): plugins contribute services,
typed events, and *reversible effects* to a shared context (`ctx`). There is
no privileged core — the model adapter, the tool registry, the session log,
and the agent loop itself are all mountable plugins, each replaceable from
configuration. Composition happens at boot from ordered layers (profiles →
bundles → patch files), so a deployment swaps, say, the filesystem provider
without forking anything. Extension points are *waterfall events* (`tools/
pre-execute`, `agent/pre-step`, …) whose listeners must call `next()` to
delegate — the disciplined interception model our runtime approximates with
its toolDeps seams at a much smaller scale.

**Capability seams.** Every model-facing capability is designed as a triple:
a **Service Definition** (the interface, e.g. `ctx.tools`), a **Service
Provider** (an implementation), and a **Consumer** (usually a model-facing
tool). `docs/architecture.md` and `docs/subsystems/*` enforce that adding a
capability means designing all three. This is why one provider swap moves the
whole product — pointing `ctx.fs`/`ctx.subprocess` at a remote sandbox moves
Bash, PTY, and LSP with it, no forks (`docs/architecture.md` §"Capability
seams").

**The session log is the source of truth, with an invariant to prove it.**
Their turn model (a *step* = one model request plus its tool calls; a *turn* =
zero or more steps) writes durable session events, and a runtime invariant
asserts "**model-visible means logged**" — anything that reaches a model
request must be reconstructable from the log. Policy is state folded from the
log (e.g. `effectiveApprovalPolicy()` in
`packages/interaction/user-approval/src/index.ts` — "replaying the log IS the
state"), which gives resume/fork/telemetry one shared mechanism. This is the
same philosophy as our ADR-0010 append-only `session_events`; their version
pushes it further (invariants asserted at runtime, not just by convention).

**Honest assessment for us (as written R51):** the plugin machinery is *not*
worth adopting at our scale — our runtime is a deliberately boring layered
monolith, and their smallest behavioral unit (plugin + config schema +
invariant companion + bilingual README + tests) is heavy apparatus for a
two-person product. The transferable value is in the *individual packages'
logic* — detection algorithms, trigger policies, escalation contracts —
which port cleanly into our runtime. That is exactly what R51-f does.

**R52 UPDATE — the owner overruled the "not worth adopting" verdict** (his
directive: "a plug-in-based system, just like how DeepSeek harness is… much
more flexibility… way too many tools just how we want them"), and the
pragmatic adoption landed as **ADR-0025**: the TOOL LAYER became a plugin
registry (`tools/plugins/*.ts` + `tools/registry.ts`, the catalog COMPUTED
from the declarations, external `.mjs` plugins from disk) while the runtime
stays the boring layered monolith the assessment defended. The R51 judgment
survives in scoped form: Cordis-style service injection, runtime-mountable
agent loops, and invariant companions remain un-adopted — only the tool
grouping + external loading was taken.

## The orchestrator's three asks

### 1. The guard family (`packages/guard/`) — read fully

`repeat-tool-reminder` is the heart. Detection (all in
`packages/guard/repeat-tool-reminder/src/index.ts`):

- **Repeat chain**: a `WeakMap<Agent, {key, count}>`; the key is
  `JSON.stringify([toolName, canonicalArgs])` where `canonicalize()` deep-sorts
  object keys then stringifies — property-order-insensitive exact identity. A
  different tracked call resets the chain to 1.
- **Escalating thresholds** `[3, 5, 8]` (config): a *gentle* reminder at the
  first threshold ("analyze the previous result before calling again"), then
  *detailed* reminders naming the tool, the run length, and a capped preview of
  the canonical arguments (`argumentsPreviewChars`, default 500 — bounds the
  reminder, never the detection).
- **Delivery is advisory, never veto**: the reminder rides the post-execute
  decision's `additionalContexts` (source-attributed
  `{kind:'plugin', form:'notice'}`), which the loop renders as a synthetic
  user message after the step's tool results. The tool's own `tool/result`
  event stays untouched for audit.
- **Counting happens post-execute**, so *denied* calls count too — "a model
  hammering a denied call is exactly the loop worth breaking."
- **Reset semantics**: a new user message deletes the agent's chain
  (`agent/pre-step` listener); untracked tools (include/exclude wildcards) are
  *transparent* — they neither count nor reset, so bookkeeping tools
  interleaved into a loop don't launder it.
- **Documented limits** (README "Known Limitations"): exact-match only (no
  fuzzy matching), compaction does not reset chains, advisory-only (blocking
  unimplemented), no subagent chain-sharing, past the highest threshold the
  chain goes silent.

`timeout-policy` (sibling): tools *declare* `timeoutMs`, the wrapper arms a
deadline, and expiry substitutes a structured `TOOL_TIMEOUT` error result the
model sees — never abandoning the tool promise (`packages/guard/timeout-policy/src/index.ts`).

**Our adoption (R51-f), with one deliberate divergence.** We took the chain
detection, the canonicalization, the nudge-first philosophy, and the
failure-hammering insight. We DIVERGE on two points, both owner-directed:
(a) their guard is advisory-only; our owner's complaint ("It takes up way too
many steps… It should work in an optimized way") demands a **hard stop** after
a second threshold, so ours is nudge-at-3 → stop-at-5; (b) ours also counts
consecutive *failed* calls (any args), which theirs handles only implicitly
through denied-call counting. Details in the runtime source
(`agent-core/src/agents/runtime.ts`, ROUND-51 (R51-f) comments).

### 2. Compaction triggers (`packages/compaction/`)

Our R46-b compaction is **reactive**: it fires only when the assembled history
already exceeds the budget, then summarizes the over-budget head. Theirs
(`packages/compaction/compaction-basic/src/index.ts` + `src/config.ts`) layers
three triggers:

- **Proactive pressure**: at every step boundary (`agent/pre-step`), compact
  when estimated tokens cross `thresholdRatio` (default **0.8** of the routed
  model's context window), keeping the newest `retainRatio` (0.16) verbatim —
  so compaction happens *before* an overflow can waste a request.
- **Overflow recovery**: on a confirmed `CONTEXT_WINDOW_EXCEEDED` request
  error, compact and **retry the request** (`{kind:'retry'}`), with bounded
  per-agent retries (`maxOverflowRetries`, default 1) that reset on the next
  successful assistant message — an overflow never kills a turn that one
  compaction could save.
- **Per-model policies**: exact `{provider, model}` overrides for
  threshold/retention, so one backend serves mixed context sizes
  (`src/config.ts` `resolveTargetPolicy`).
- **KV-cache-preserving summarizer**: the summary request reuses the
  conversation's own system prompt + messages as prefix so the provider's
  prompt cache is not invalidated (`src/index.ts` `summarize()`).
- A sibling package (`compaction-tool-result-pruner`) trims oversized tool
  outputs *before* condensing — we already do this at the source
  (`chat.ts summarizeToolOutput`, 4000-char head+tail), so the pruner is
  redundant for us.

**Verdict: candidate for a future round** — the pressure trigger and the
overflow-retry are strictly better than our single reactive trigger, and both
are small, localized changes to `compaction.ts`/`runtime.ts`.

### 3. Session telemetry vs our `usage_events`

Their `session-telemetry` (`packages/session/session-telemetry/src/{index,
coordinator}.ts`) is an *outbound reporting* seam: records mirror session
events 1:1 (only the first `assistant/chunk` per (turn, step) ships), severity
is pre-mapped (`error` for `tool/result.isError`, turn-end errors), every
record passes a **redaction waterfall** (`sessionTelemetry/record`) that can
withhold fail-closed, `emit()` must be non-blocking, and a WeakMap handoff
cursor + `(session.id, event.seq)` receiver dedupe gives at-most-once
delivery. Backends disclose a sharing policy (`full` / `feedback-only` /
`disabled`).

Our `usage_events` (migration 0001 + R50-c1 `cached_input_tokens`) is a
different animal: a **per-turn cost ledger** (agent/session/provider/model/
input/output/cached/cost/ts — one row per turn) feeding the context meter and
the R51-e usage dashboard. It is accounting, not activity mirroring, and it
never leaves the machine. **Verdict: not applicable as a whole** — we have no
outbound telemetry and want none by default (owner privacy). The two ideas
worth keeping in the drawer: the redaction-waterfall shape (if we ever add an
export/reporting feature) and their 1:1 event-mirror + seq-dedupe discipline,
which further validates our seq-keyed append-only log.

## Applicability matrix

| Package | Verdict | One-line reason |
|---|---|---|
| `guard/repeat-tool-reminder` | **ADOPTED (R51-f)** | Exactly the owner's "too many steps" failure mode; ported as an in-runtime nudge→stop guard. |
| `guard/timeout-policy` | Candidate (later) | We already have per-provider-call timeouts (R46) + a command timeout; per-tool *declared* `timeoutMs` with a structured `TOOL_TIMEOUT` error is a clean next step. |
| `compaction/compaction-basic` | **Candidate (future round)** | Proactive 80%-pressure trigger + overflow-error-recovery-retry beat our reactive-only trigger. |
| `compaction/compaction-tool-result-pruner` | Not applicable | `chat.ts summarizeToolOutput` already trims at the source (4000-char head+tail). |
| `compaction/command-compact` | Candidate (tiny) | An owner-facing "compact now" action is a small UI+route addition once triggers land. |
| `todo/tool-todo` | Not applicable | We already have `todo_write` with whole-list `todo.update` session events (round-28 WS-F) — same design. |
| `subagent/` group | **Candidate (future round)** | Continuable children (follow-up to a live/stored child) + list-children tools are the natural evolution of our R49 nested delegation; the provider-seam abstraction (ACP/codex/claude-code children) is over-engineering for us today. |
| `session/session-telemetry` | Not applicable | Outbound reporting seam; ours is a local cost ledger (see above). |
| `session/session-persistence-sqlite` etc. | Not applicable | We already run SQLite WAL owned by the sidecar (validated by rounds of prior research). |
| `context/` group | Partial candidate | `time-context` (inject current date/time) is a trivially cheap prompt win someday; file/session references ≈ our composer attachments; `agent-instructions` ≈ our custom rules. |
| `plan/plan-mode` | Studied, deliberately not adopted | Their stance is "guidance, not enforcement — every tool stays available"; our R50-c1 `PLAN_MODE_TOOLS` is a hard read-only intersection, which matches our owner's mode-switch intent and our fail-closed posture. One idea logged: plan-as-logged-state (the plan survives resume/fork because it is a session event). |
| `interaction/user-approval` | Candidate (future round) | "Policy as a durable session event folded pure from the log" (`approval/policy` + `effectiveApprovalPolicy`) is a nicer shape for per-session permission-mode overrides than our column copy; their model-facing policy sentences (ask/never) are a prompt-pattern worth copying. |
| `interaction/permission-presets`, `user-questions` | Candidate (later) | Named permission presets (sandbox mode + approval policy bundled) and a pause-for-human-question service map to our ask-tier + approval future. |
| `skill/` group | **Candidate (future round, SPEC F8)** | Skill catalog as a *durable session event* + loader tool = progressive disclosure (names+descriptions only until invoked); scoped precedence ranks and a strict name grammar are the reference design. |
| `hooks/` group | Not applicable | Bridging Claude Code/Codex `hooks.json` configs serves an ecosystem hub, not a self-contained product. |

**Top 3 future candidates** (for the round-51 worklog): (1) compaction
pressure-trigger + overflow-recovery; (2) continuable sub-agent children
(follow-up delegation); (3) the skill catalog's progressive-disclosure shape
when SPEC F8 skills land.

## Attribution & license

deepseek-harness is MIT-licensed — `LICENSE`: "MIT License, Copyright (c)
2026 DeepSeek" — repository: <https://github.com/deepseek-ai/deepseek-harness>
(mirror used for study: the clone at `/tmp/deepseek-harness`). Consistent with
every prior reference study in this folder, ACUTE-CODE takes **ideas and
patterns only — no code is copied**; the R51-f loop guard is an original
implementation in our runtime's idiom (different thresholds, a hard-stop tier,
failure-streak counting, and per-turn rather than per-agent scope), informed
by their published detection algorithm. If a future round ever lifts a
trivially small snippet verbatim (e.g. the key-sort canonicalizer), it must
carry an inline MIT © 2026 DeepSeek attribution comment — none was needed this
round.
