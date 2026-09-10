<!-- round: 2 (post-R81) | task-id: 7 | agent: research-agent-D | date: 2026-09-09 -->
# deepseek-harness — Round-2 Deep Study (verification + what's new + adaptation plan)

**Why this document exists.** Owner direction (Task ID 7): "do some more research
on the DeepSeek harness, look into it a bit more properly… what is good about
it, what we can take from it, and what we can learn from it and adapt those
properly." This is the follow-up to the R51 study
(`docs/research/deepseek-harness-notes.md`). Research only — no repo code was
modified. Companion docs in this folder: `task-mode-consolidation.md` (R81,
shipped), `token-counting-robustness.md`, `models-providers-fixes.md`.

**Method.** (1) Web research via z-ai web-search/page_reader — official
announcement, third-party coverage, the Cordis paper. (2) **Re-cloned the repo
fresh** to `/tmp/deepseek-harness` (the R51-era clone was wiped with /tmp) and
read the actual package sources — this round's claims about dsh mechanisms are
first-hand source reads, not reconstructions. (3) Verified each R51 mechanism
claim against the current tree. (4) Grepped ACUTE-CODE at HEAD `a22980e`
(R81, v0.80.0) for every pattern's shipped/partial/absent status.

---

## §1 What is actually verifiable about the harness

### 1.1 Correction to the task premise

The task brief assumed "the DeepSeek harness is NOT public as a repo — the
R51 study was likely based on disclosed technical reports/papers." **That
premise is wrong.** deepseek-harness is a public, MIT-licensed open-source
repository. The R51 notes said so ("the repository cloned at
`/tmp/deepseek-harness`"), and this round re-verified it end-to-end.

### 1.2 Verified public facts (with sources)

| Fact | Source (URL, checked 2026-09-09) | Quality |
|---|---|---|
| Repo exists: `deepseek-ai/deepseek-harness`, **MIT** ("Adopt MIT for DSH packages", Aug 13 2026 commit; LICENSE: "MIT License, Copyright (c) 2026 DeepSeek") | https://github.com/deepseek-ai/deepseek-harness | Primary (read directly) |
| Scale at clone: **217.4k stars, 25.7k forks, 928 watching, 16,351 commits, 34+ contributors, 14 tags**; latest `dsh 0.1.5-alpha.2` (Sep 9, 2026); repo bootstrapped ~Jun 10, 2026 | same | Primary |
| Size: `packages/` = **55 top-level groups, 267 leaf packages** (R51 said "~60" — the repo has grown ~4× since); plus `apps/` (Electron desktop), `python/` SDK wheels, `vendor/` (cordis 4.0.2), `benchmarks/`, `native/`, `website/`, `.agents/notes/` (**324 dated architecture decision notes**, bilingual) | clone at /tmp/deepseek-harness | Primary |
| Official announcement: "DeepSeek Harness developer preview: Everything is a plugin" — **"Agent = Model + Harness"**; Cordis kernel; capabilities as plugins (models, tools, skills, sessions, sandboxes, storage, loops, scheduling, UI); "Every run is traceable" (append-only session log: system prompts, reasoning, tool calls/results, subagent scheduling, every context injection; Trajectory view; resume/fork/search/replay on one event stream); **4 runtime modes: Standard / Code / Minimal / Creator** | https://www.deepseek.com/harness/en | Primary (vendor) |
| Cordis has a formal foundation: **arXiv 2608.25512 — "A Programming Paradigm for Spatiotemporal Composability"** (Yifan Shi, Wei Zhang, Tianyi Cui; PKU + DeepSeek-AI; 92 pp; Aug 26, 2026). Formalizes *temporal composability* (revertible effects — every context transformation carries an inverse the runtime holds) and *spatial composability* (reactive coeffects — context changes classified against a component's coeffect spec); unified "context paradigm"; implemented in Cordis with hot module replacement + config reconciliation | https://arxiv.org/abs/2608.25512 | Primary (peer-style preprint) |
| Third-party coverage (dates confirm the Aug 13, 2026 release): InfoQ "The Open-Sourcing of DeepSeek Harness Opens the Door to Modular, Unbundled AI Agent Infrastructure" (Aug 20); MarkTechPost release note (Aug 17); DataCamp "DeepSeek Harness vs Claude Code" (Aug 24) + "What Is DeepSeek Harness?" (Sep 7); eigent.ai summary (Aug 13); mindstudio.ai "can even call Claude Code or Codex as sub-agents" (Aug 14); habr.com engineering deep-dive (Aug 16); r/LocalLLaMA "insanely good" (Aug 23); HN thread (Aug 13) | URLs in search results above | Secondary (consistent) |
| Community/plugin ecosystem: `dsh-plugin` GitHub topic, Discord, GitHub Discussions | README (repo) | Primary |
| Developer preview with explicit compat-breaking warning; docs at https://deepseek-harness.github.io/deepseek-harness/ | README + docs site | Primary |

### 1.3 Terminology that did NOT check out (unverifiable / wrong lineage)

- **"dpswb" / "DeepSeek DSWB agent harness"** — web search surfaces **no public
  artifact by that name**. All "DSWB" queries resolve to dsh pages or unrelated
  hits. I could not find any DeepSeek-published thing called DSWB. Treat "DSWB"
  as noise; the reference architecture is `dsh`, full stop.
- **"DeepEP / SWE-agent DeepSeek"** — DeepEP is DeepSeek's EP communication
  library (training infra), unrelated to dsh. The *agentic-RL* lineage the task
  gestured at is real but separate: **DeepSWE** (together.ai, Jul 2025 —
  RL-trained open coding agent, 59% SWE-bench Verified) and 2026's
  **"harness-native RL"** literature (e.g. arXiv "Polar: Agentic RL on Any
  Harness at Scale", May 22, 2026 — a rollout framework where *the harness, not
  the training engine, owns the environment interaction loop*). dsh itself is a
  product harness, not a training harness — but its Minimal mode ("two tools
  for benchmarking models in a minimal environment") and the log-is-trajectory
  invariant are clearly shaped by the eval/RL lineage (§5.6).
- The R51 notes' mechanisms were **all** verifiable against source — I found
  **zero** R51 claims that failed verification, and zero that were
  "reconstruction only." R51 read the repo directly; this round re-read the
  same files at a 10-days-newer HEAD. What changed since R51 is **additions**
  (see §2.7–2.10), not corrections.

---

## §2 The key patterns (what it is, why it's good, evidence quality)

Evidence quality: **[SRC]** = read the package source this round;
**[DOC]** = dsh's own docs/architecture.md or READMEs; **[WEB]** = third-party
or official web pages; **[PAPER]** = arXiv 2608.25512.

### 2.1 Everything-is-a-plugin + capability seams [SRC][DOC][WEB][PAPER]

Every capability — model adapters, tool registry, session log, agent loop,
sandbox, approval, compaction, UI — is a Cordis plugin contributing services,
typed events, and **reversible effects** to a shared context; there is no
privileged core. A **capability seam** has three roles: Service Definition
(the interface, e.g. `ctx.fs`), Service Provider (implementation), Consumer
(usually a model-facing tool). One provider swap (local → remote sandbox)
moves Bash/PTY/LSP with it. The Cordis paper gives the machinery a formal
metatheory (revertible effects + reactive coeffects).

*Why good:* composition without forking; deployment-level substitution; the
R52 owner directive ("a plug-in-based system, just like how DeepSeek harness
is") is what produced our ADR-0025 tool registry. *Honest note:* at 267
packages, this is a *framework* with a research paper behind it — heavy
apparatus. R51's scoped verdict (tool layer only for us) still stands.

### 2.2 The session log is the source of truth, with RUNTIME-ASSERTED invariants [SRC][DOC]

- Turn = 0..N steps; step = one model request + its tool calls/results; all of
  `turn/*`, `step/*`, `user/message`, `system/message`, `assistant/message`,
  `assistant/attempt`, `tool/*` are **durable session events**; live streams
  (`agent/assistant-stream`) commit only at settlement.
- **"Model-visible means logged"** (docs/architecture.md §Session log): anything
  reaching a model request must be reconstructable from the log — *and a
  runtime invariant asserts it*.
- **Invariant companions** (`packages/core/session/src/invariant.ts`,
  `user-approval/src/invariant.ts`, etc.): a dsh-invariants service registers
  package-owned relational checks that run at **pre-commit staging** (via an
  `internal/dispatch` hook) and on reload: seq strictly increases; turn/step
  numbering matches the open turn/step; `tool/result` must match a pending
  `tool/call`; **audit pairs must be turn-enclosed** ("a bare event appended
  between turns is indistinguishable from a crash tail and silently dropped on
  reload" — the turn is the durable log's commit/replay boundary).
- Session **format versioning** v0→v3 with adjacent migration packages
  (`session-format-v0-to-v1` … `-v2-to-v3`); committed generation paths are
  never renamed/replaced; write-opens publish a successor exclusively.
- **Projection seam** (`session-projection`): registered units fold committed
  events incrementally into typed state (`stateOf()`), clients get
  schema-validated snapshots annotated with the last event seq they reflect.

*Why good:* resume/fork/replay/telemetry/eval all share one mechanism; bugs in
the log surface as loud invariant failures, not silent corruption. Our
ADR-0010 append-only `session_events` is the same philosophy **without** the
asserted invariants (our event type is an untyped string, `sessions.ts:84`).

### 2.3 Policy as a folded log (the interaction family) [SRC]

`packages/interaction/user-approval/src/index.ts`:
- A session's approval policy is an `approval/policy` **durable session event**;
  `effectivePolicy()` folds the LAST such event ("replaying the log IS the
  state"). `source: 'delegation'` marks overrides seeded into children.
- The policy is model-facing via a **system-prompt context block injected
  AFTER retained history** — "switching policy does not rewrite the stable
  system-prompt cache prefix" (KV-cache stability), plus a live switch notice
  as a `plugin`-source user message ("The approval policy changed from…").
- Model-facing sentences are fixed constants (`ASK_SENTENCE`,
  `NEVER_SENTENCE` — the latter explicitly tells the model not to request
  sandbox escalation).
- Ask/decide is a **turn-enclosed audit pair** (`approval/asked` +
  `approval/decided` with a shared id); answerers fail closed
  (`unavailable`); rogue returns normalize to fail-closed; abort → `cancelled`
  with late answers discarded by construction.
- Sandbox and approval are **independent controls** (habr + permission-presets
  package): `workspace-write + ask`, `danger-full-access + never` — "an
  approval dialog is not a filesystem boundary."

*Why good:* permission state participates in fork/revert/replay like every
other fact; deterministic `never` is CI/headless-friendly; cache-stable policy
disclosure. This is the exact shape R51 flagged as the "next study candidate."

### 2.4 The guard family [SRC]

- **`repeat-tool-reminder`** (233 lines, read fully): WeakMap chain keyed on
  `JSON.stringify([tool, canonicalArgs])` with deep key-sort canonicalization;
  escalating thresholds `[3,5,8]` (gentle → detailed with capped 500-char
  argument preview — "bounds the reminder, never the detection");
  **advisory-only** via `additionalContexts` riding the post-execute decision
  (a blocked call still gets the nudge); counting is post-execute so **denied
  calls count**; a user interjection resets the chain; untracked tools are
  *transparent* (neither count nor reset). Every R51 claim verified verbatim.
- **`timeout-policy`** (81 lines, read fully — the R51 "next study candidate"):
  a tool **declares `timeoutMs`** and promises to honor `exec.signal`; the
  wrapper arms a deadline via `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)`,
  swaps the derived signal onto `exec`, delegates, restores the upstream signal
  in `finally`, and — only if **its own** timer fired (deadline codes are
  scoped so a nested outer deadline reads as an upstream cancel) — substitutes
  a structured `isError` result: `error.code === 'TOOL_TIMEOUT'`,
  `info.name === 'ToolTimeoutError'`, model-facing text "tool call timed out
  after Nms". No racing, no abandoned promises; retry/replay plugins can route
  on the code. A tool with no `timeoutMs` delegates unchanged.

*Why good:* two tiny plugins cover the two dominant agent-loop failure modes
(hammering and hanging) with fail-soft, model-visible, auditable results.

### 2.5 The compaction family [SRC]

`compaction-basic` (1,621 lines across 5 files, read the engine + config):
- **Proactive pressure**: on every `agent/pre-step`, measure the session with
  the singleton token meter; compact when ≥ `thresholdRatio` (**default 0.8**)
  of the *routed* model's context window; keep the newest `retainRatio`
  (**0.16**) verbatim. R51's numbers confirmed in `config.ts:20-23`.
- **Overflow recovery**: on a confirmed `CONTEXT_WINDOW_EXCEEDED` request
  error (`agent/request-error` waterfall), compact then return
  `{kind:'retry'}`; bounded by `maxOverflowRetries` (per-agent WeakMap) that
  resets on agent-idle AND on each successful `assistant/message`; a failed
  recovery that still durably shrank the surface counts as retry-proof.
- **Per-model policies**: exact `{provider, model}` overrides
  (`resolveTargetPolicy`), resolved from the *durably routed* request header.
- **KV-cache-preserving summarizer**: `summarize()` reuses the conversation's
  own system prompt + tools + messages as prefix "so the provider's KV cache
  is not invalidated"; it is the sole subclass hook.
- **Surface transactions**: compaction is a region replacement on the
  session's *model-visible surface* (`shadowedSeqs`, `replaceGeneration`);
  post-compaction remeasure + retry loop (`compactionRetries`) throws
  honestly if still above threshold; sibling `compaction-tool-result-pruner`
  runs a model-free prune pass first (optional, independently composable).
- **`command-compact`**: `/compact` works with any backend, consumes **no
  model turn**, requires an **idle agent** (`agent.runMaintenance`), reports
  items condensed + tokens saved, queues prompts sent while running, and
  turns every failure into a stable user-facing message.

*Why good:* three-layer defense (pressure → overflow → manual) with zero
wasted requests and honest accounting.

### 2.6 Skills: durable catalog + loader (progressive disclosure) [SRC]

`skill/` (service + filesystem provider + tool): strict kebab-case name
grammar `^[a-z0-9]+(?:-[a-z0-9]+)*$`; scoped precedence ranks (bundled 600,
runtime 250, custom…); **the catalog is published as a durable session context**
(`SkillCatalogSource {kind:'skill-catalog', form:'catalog', entries[]}` — a
consumer presenting the list must not re-parse the model-facing
`<available_skills>` block); `tool-skill` renders name+description only; the
body loads on `skill {name}` invocation; description cap 500 chars. This is
the exact progressive-disclosure design R51 called "the reference design" —
and it matches what we shipped in R61/R70/R72.

### 2.7 NEW since R51 — the spill family (tool-output spill) [SRC]

`spill/` + `spill-local/` + `spill-policy/` (decision note
2026-07-08-tool-output-spill-files): oversized plain-text tool results are
stored **outside the model's context** in session-scoped private files; the
model receives a **preview + opaque locator + retrieval guidance**; opt-in via
`maxInlineBytes`; on storage failure the ORIGINAL result stays inline
(best-effort degradation, never a new failure mode). Session references
consume the same store for truncated captured transcripts.

*Why good:* truncation (head+tail) is lossy and permanent; spill keeps the
full artifact addressable. This is the "tool output as a file, not a wall of
text" pattern — and we don't have it (§3.6).

### 2.8 NEW since R51 — Code Mode / PTC (run_code + generated SDK) [SRC]

`core/tools` PTC mode + `code-runtime/` + `code-runtime-worker-thread` +
`experimental/code-runtime-python`: the registry can expose a reserved
**`run_code`** transport plus a **deterministic SDK generated in the loaded
runtime's language**; the model writes ONE program (async TS/Python body)
whose SDK binding calls **re-enter the complete tool pipeline** with logged
correlation (`<parent>:ptc:<n>` ids); under `ptc` alone a direct call naming
any other tool resolves to `UNKNOWN_TOOL` before policy — "the announced
surface and the callable surface stay the same." Only the outer `run_code`
result has a hard size cap; the prompt carries a fixed "Writing code for
run_code" instruction block (first-party order 5000).

Related orchestration family: **`workflow`** (model-written plain-JS
orchestration script with `agent()/parallel()/pipeline()/phase()/log()`,
structured-output schemas, blocking tool `workflow {meta, script, args}` →
`{runId, agentsStarted, result}`), **`goal`** (ONE durable completion
objective per session, survives resume/fork/restart, compare-and-set updates,
round cap 256, blocked goals keep a stable policy code), **`tool-ralph`**
(foreground fresh-agent loop, immutable objective, only a bounded structured
report crosses rounds, "the workspace is the long-term memory," explicit
use-only-when-the-human-asks guardrail).

*Why good:* for fan-out work, one program replaces N tool-call round-trips;
for long-running work, a durable objective replaces the model's memory of
intent. (Adoption verdict in §4/§5.)

### 2.9 NEW since R51 — subagent maturity + Agent Teams [SRC]

`subagent/` now has: one-shot vs **continuable** children (`backgroundMode`),
`sendMessage` with **Steer-at-nearest-step vs Queue** semantics, interrupt,
`agentOptions` (provider/model/reasoningEffort/maxTokens) each gated on
provider capability, `maxDepth` default 3, `toolFilter`, persona, fail-loud
capability refusals, child isolation ("a crashed child cannot corrupt the
parent's session"), and **discovery without loading** (list children +
descendant tree with mode/activity/lineage reading live state + persistence).
Provider backends: in-process spawn/fork, **ACP, SDK, Codex, Claude Code**.
`experimental/agent-team` (published Sep 9): durable roster + task board +
mailbox over continuable subagents.

### 2.10 The event taxonomy itself [DOC]

Three domains — **session events** (durable facts), **agent events** (live
execution: pre-step, request, validation, continuation, turn-stopping),
**capability events** (`fs/*`, `tools/*`, `telemetry/*` — attach behavior to a
seam without importing the loop). Waterfalls (`agent/pre-step`,
`agent/request`, `llm/stream`, `tools/pre|execute|post-execute`) require
`next()`; `agent/turn-stopping` is serial. The tool pipeline is
`tools/pre-execute` (reorderable allow/deny/ask gate) → `tools/execute`
(wrappers for timeout/retry/metrics) → provider → `tools/post-execute`
(replace/block-with-feedback/attach-contexts) → `tools/result` (observe
immutable outcome).

*Why good:* "where new behavior goes" is a **table**, not folklore — 20+ rows
mapping goal → mechanism (docs/architecture.md §Where new behavior goes).

---

## §3 ACUTE-CODE status per pattern (repo evidence at HEAD a22980e)

| # | dsh pattern | ACUTE-CODE status | Repo evidence |
|---|---|---|---|
| 1 | Tool plugin registry (scoped adoption) | **SHIPPED (R52, ADR-0025)** | `agent-core/src/tools/registry.ts` (PluginDefinition/ToolDefinition, external .mjs fail-soft), `tools/plugins/*.ts`, catalog computed from declarations; Cordis service injection deliberately NOT adopted (ADR-0025 §3) |
| 2 | Loop guard (repeat-call detection) | **SHIPPED (R51-f, with owner-directed divergence)** | `agents/runtime.ts:299-460` — nudge-at-3 → STOP-at-5, failure-streak (any args) counting, per-turn scope, canonical identity via sorted-key stringify |
| 3 | Compaction: reactive + overflow recovery | **PARTIAL (R46-b + R71-e2)** | `agents/compaction.ts:96-141` `planCompaction` fires only when `total > available` (or `force`); `runtime.ts:1561-1719/2337-2384` arm `forceCompaction` on classified `context_window_exceeded`, ONE recovery per turn, retry. Overflow-recovery ≈ dsh trigger #2 ✓ |
| 3a | Compaction: **proactive pressure (0.8) + per-model policy** | **ABSENT** | No pre-step pressure check anywhere (`grep proactive/pressure` → only a skills.ts comment); no `{provider,model}` policy overrides; single global budget math (`contextWindow − maxOutput − margin`) |
| 3b | Compaction: KV-cache-preserving summarizer | **ABSENT (opposite)** | `compaction.ts:144-153` uses a CUSTOM `SUMMARIZER_SYSTEM_PROMPT` + rendered transcript — different prefix from the conversation (cache-hostile); also unbilled (Agent C audit) |
| 3c | Manual `/compact` command | **ABSENT — and the 800K guard references it!** | `runtime.ts:2424-2428`: guard message says "run /compact or start a new session" — Agent C's audit already flagged that **no /compact exists anywhere in the product** |
| 4 | Per-tool declared `timeoutMs` + structured `TOOL_TIMEOUT` | **ABSENT as a contract; PARTIAL as point fixes** | `tools/registry.ts:85-93` ToolDefinition has no timeout field. Bespoke: `tools/exec.ts:148-347` (hard watchdog + inline `[timeout]` text), `tools/git.ts:24`, `mcp/manager.ts:147-158`, `chat.ts:235/424` (provider call), `browser-command.ts:73-86`, terminal route shrink-only override (`server.ts:1843`). No routable error code; no uniform wrapper (prior audit rec S-(d): execute()-level timeout wrapper in buildProjectTools) |
| 5 | Policy-as-folded-log (approval/mode events) | **ABSENT (columns instead)** | `storage/sessions.ts:479/502` — `UPDATE sessions SET permission_mode/active_mode` (plain column writes; migrations 0020/0027). Mode narration lives **inside the system prompt** (`prompts.ts` OPERATING MODE section; R81 pinned headings) → every mode switch rewrites the cached prompt prefix. Equivalents that DO exist: R81 ask-tier approvals (`approvals.ts` risk tiers + always-allow rules), mode inheritance into child sessions (`orchestrator.ts` createChildSession), delegation-seeded modes (R81 tests) |
| 6 | Tool-output spill (locator + retrieval) | **ABSENT (lossy truncation)** | `agents/chat.ts:297-354` `summarizeToolOutput` — 4000-char head+tail with `…[truncated N chars]…` marker (sticky 60K exceptions for skills); the middle is gone forever |
| 7 | Skills progressive disclosure | **SHIPPED (R61/R70/R72)** | `tools/plugins/skills.ts` (read_skill, name+desc only, body on demand, 60K sticky budget, references/ depth), `storage/skills-files.ts:534` `resolveEffectiveSkills` feeds BOTH prompt index and loader. Minor divergence: our SKILLS prompt section is derived from DB state per turn; dsh additionally logs the catalog as a durable session context |
| 8 | Addressable/continuable delegation | **SHIPPED (R49 + R79-a)** | `agents/orchestrator.ts:197,364-393,431-583` — `delegate_task {"resume":"<task_id>"}`, background children outlive the turn, `delegation.collected` events, ≥10 outstanding fan-out cap, boot sweep, `subagents/:childId/retry` route. Absent sub-features: list-children-without-loading tool (dsh discovery), provider zoo (deliberate), Steer-vs-Queue message semantics (our resume IS the wait — R71 no-polling) |
| 9 | Code Mode / PTC, workflow scripts, goal, ralph | **ABSENT** | PILLARS §3-6 workflows/scheduler UNBUILT (R80.5 audit: "turn executor and semaphores are ready; the missing pieces are storage, the trigger module, and a typed event schema"). `todo_write` covers planning, not durable objectives |
| 10 | Session-log runtime invariants / typed event contract | **ABSENT** | `storage/sessions.ts:84` — stringly-typed event names; no typed SessionEventType union (backend); no invariant companion; no turn-enclosure checks |
| 11 | Session projection seam | **PARTIAL** | UI state derives from SSE frames + REST reads; `todo.update`/`delegation.collected` events exist; no typed incremental fold service; the donut/meter mismatches are the symptom (Agent C audit) |
| 12 | Time-context | **SHIPPED (R70-c)** | `agents/prompts.ts:794-803` environment grounding (OS/shell/current date/git) |
| 13 | Telemetry (outbound) | **N/A by design** | Local cost ledger `usage_events` (migration 0001, R50-c1 cached tokens); owner privacy posture. Redaction-waterfall shape stays in the drawer |
| 14 | Sandbox-vs-approval independence | **PARTIAL** | Risk-tier approvals + R81 mode allowlists are permission-side; OS-level sandboxing is absent (Tauri sidecar process boundary only). Not a near-term gap for a local IDE |

---

## §4 Top 5 adaptation candidates (ranked; concrete attach points)

### C1 — Compaction completion round: proactive pressure + per-model policy + KV-preserving summarizer + **close the /compact hole**
**What.** Port dsh's remaining two triggers (pressure at 0.8 of the routed
window measured at the top of each outer-loop iteration; per-`{provider,model}`
threshold/retention overrides), switch the summarizer to reuse the
conversation's own prefix (system prompt + messages) instead of a bespoke
SUMMARIZER_SYSTEM_PROMPT (keeps the provider prompt cache warm), and add the
**manual compact** affordance the 800K guard already promises: `POST
/sessions/:id/compact` (idle-only, honest 409 when mid-turn — dsh's
`runMaintenance` gate), a `/compact` composer slash + a "Compact now" action in
the context meter, reporting `{items condensed, tokensSaved}`. Rename the
800K-guard message to point at the real affordance.
**Attach points.** `agents/compaction.ts` (planCompaction gains a
`pressureThreshold` param + a `resolveCompactionPolicy(provider, model)` map;
summarizer prompt construction ~:144); `agents/runtime.ts` iteration heads
(~:1613 sync / ~:2384 streamed — add the pre-request pressure check where
`assembleWithCompaction` is called; `resolveTurnBudget` reuse per Agent C's
spec); `server.ts` route section + `src/lib/api.ts` + `AgentChatPanel.tsx` /
`ContextDonut.tsx` (compact action) + `Composer` slash table.
**Size.** M (pressure + policy ≈ 1 small round; /compact route + UI ≈ half a
round; total one round). **Risk.** Medium-low: token-estimate accuracy is the
known weak input (Agent C's audit) — pair the trigger with the persisted
actual-tokens feed where available; the once-per-turn overflow retry already
bounds the failure mode. **Expected value.** HIGH: kills wasted
overflow-rejected requests before they happen, stops cache-thrash on every
compaction, and fixes an existing honesty bug (guard references a nonexistent
command). This is R51's own #1 future candidate, still open.

### C2 — Per-tool declared `timeoutMs` with structured `TOOL_TIMEOUT` results (the R51 next-study candidate)
**What.** Extend `ToolDefinition` (`tools/registry.ts:85`) with optional
`timeoutMs` + require cooperative `signal` (already in `ToolDeps` — delegation
uses it, `plugins/delegation.ts:103`). Wrap tool execution in ONE place — the
assemble/dispatch path in `tools/index.ts` (or `buildProjectTools`) — arming
`AbortSignal.timeout(timeoutMs)`; on expiry return `{ isError: true, error:
{ code: "TOOL_TIMEOUT", ... }, content: "Error: tool call timed out after
Nms" }` so the model (and the retry ladder / error-classification) can route
on it. Declare budgets per plugin: exec (keep watchdog semantics), git,
mcp__* (per-call from manager), browser, vision fetch, computer-use actions.
Leave undeclared tools unwrapped (dsh's "no budget → delegate unchanged").
**Attach points.** `tools/registry.ts` (field + validation),
`tools/index.ts` (wrapper), per-plugin declarations, `agents/error-classification.ts`
(add TOOL_TIMEOUT to the vocabulary), one test file pinning the structured
shape.
**Size.** S-M (~150-250 src lines + tests). **Risk.** Low if budgets are
generous and unwrapped-by-default; the one design decision is whether an
in-flight hung child process gets killed (exec already does) vs merely
abandoned (dsh restores the upstream signal and lets the tool's own
cooperative handling quiesce). **Expected value.** HIGH for the hang modes we
actually hit (browser/computer-use/MCP); the model sees a clean structured
error instead of a turn-killing stall.

### C3 — Mode/permission policy as session events + cache-stable policy narration
**What.** Mode changes become **append-only session events**
(`mode.update {mode, source: 'user'|'delegation'}`), folded on read (last
event wins — `findLatestCompaction` is the in-repo fold precedent) with the
existing columns kept as a read cache. Two dividends: (a) fork/revert inherit
mode changes correctly (today a revert-to-seq does NOT roll back a mode
column write); (b) the OPERATING MODE narration can move **after retained
history** as a post-system context block (dsh's approval sentences pattern) so
switching modes stops invalidating the provider's prompt-cache prefix — with
a live switch notice injected as a `plugin`-source user message (our
`createUserMessage` equivalents exist in runtime's nudge path).
**Attach points.** `storage/sessions.ts` (event append + fold + column sync
in the same transaction), `server.ts` PATCH permissions/activeMode routes
(~:2544-2664), `agents/prompts.ts`/`prompt-registry.ts` (move the OPERATING
MODE block out of the stable prefix; **golden fixture regeneration via the
sanctioned UPDATE_GOLDEN=1 procedure** — expect the R81 test suite pins to
move with it), migration 0030 backfilling one event per session from the
current column.
**Size.** M. **Risk.** Medium: prompt golden-fixture + R81 test churn is the
bulk of the cost; wire-compat is safe (fields unchanged). **Expected value.**
MEDIUM-HIGH: honesty (revert semantics) + real token-cost savings on mode
switches with cache-enabled providers (the owner's cost complaints).

### C4 — Tool-result spill: keep the full artifact, hand the model a locator
**What.** For plain-text tool outputs over a `maxInlineBytes` threshold
(start ≈ the sticky/4000-char regime): write the FULL text to a
session-scoped spill file (sidecar data dir, `sessions/<id>/spill/<uuid>.txt`),
and give the model head+tail preview + `…[full output (N chars) saved to
spill: <name>]…` + retrieval guidance (read_file with offset/limit covers
retrieval today — no new tool needed). Storage failure → current truncation
(never a new failure mode). Delete with the session (the existing session
cleanup path).
**Attach points.** `agents/chat.ts:322` `summarizeToolOutput` call site (spill
before truncate; the persisted `tool.result` event carries the preview + spill
locator), new `agents/spill.ts` (S: ~80 lines), session-cleanup sweep.
**Size.** S-M. **Risk.** Low-medium: disk growth bounded by session TTL;
secrets already scrubbed upstream of the persist path. **Expected value.**
MEDIUM: long build/test logs currently lose their diagnostic middle exactly
when the agent needs to iterate; spill converts permanent loss into an
addressable artifact.

### C5 — Design input only: the goal/workflow shape for PILLARS §3-6
**What.** NOT a port — a reference design for the already-planned
workflows/scheduler pillar: dsh's split is (i) durable *goal* state (one
objective per session, CAS updates, round cap), (ii) *workflow* = model-written
orchestration script over `agent()/parallel()` with structured outputs, (iii)
*jobs* as the uniform background-work substrate with `job_output/job_kill`
collection tools. Our R80.5 audit already concluded the turn executor +
semaphores are ready and the missing pieces are storage + trigger module +
typed event schema. dsh's trio tells us the **storage shape** (goal/task-board
as session events or tables, results as collectible job ids) and the
**round-cap discipline** (bounded autonomous continuation, blocked-with-code
terminal states) — both fit our delegation/event vocabulary.
**Size.** L (pillar-scale, multi-round). **Risk.** High (new surface).
**Expected value.** Strategic: it is the difference between workflows as
"cron + prompt" and workflows as durable, resumable, bounded autonomy.

**Runner-up worth a backlog line:** a dev-mode **session-log invariant
checker** (typed `SessionEventType` union in `shared/` + a vitest/boot-time
assertion pass: seq monotonicity, tool_use↔tool_result pairing, turn
containment of audit-ish events). Pure additive, ~1 day, converts silent log
corruption into loud failures — the single cheapest dsh idea we haven't taken.

---

## §5 What NOT to adopt (and why)

1. **Cordis-the-framework (service injection, hot-swappable loops, profiles →
   bundles → patch layers, HMR).** R51's scoped verdict survives two more
   verification rounds: we are a two-person product with a deliberately boring
   layered monolith (ADR-0025 §3); dsh's smallest behavioral unit (plugin +
   config schema + invariant companion + bilingual README + spec tests × 267
   packages, 324 architecture notes) is framework-scale apparatus. The Cordis
   paper is beautiful PL theory; none of it pays rent at our scale.
2. **Session-format migration chain (v0→v3 adjacent packages).** Our
   equivalent problem is solved by 29 idempotent SQL migrations + a stable
   stringly-typed event stream whose readers skip unknown types. A versioned
   event-format chain is for ecosystems with external consumers of stored
   sessions; we have one consumer (us).
3. **PTC / Code Mode (`run_code` + generated SDK).** Tied to their
   model-training and benchmarking story (Minimal/Code modes exist to evaluate
   *their* models; DeepSeek trains against this surface). For our multi-provider
   IDE: fixed per-request prompt cost (the SDK block), provider
   function-calling quality varies wildly, and our failure modes (loops, hangs,
   overflow) are not round-trip-count problems. Revisit only if a provider
   family shows systematically weak tool-calling.
4. **Outbound telemetry (redaction waterfall, OTel export).** Owner privacy
   posture: nothing leaves the machine. Keep the fail-closed redaction
   waterfall *shape* in the drawer for a future opt-in export feature.
5. **The subagent provider zoo (ACP / Codex / Claude Code children).** An
   ecosystem-hub play. We are self-contained; R51's verdict stands. The
   transferable bits (capability-gated options, list-children discovery,
   fail-loud capability refusals) are noted in §3.8 and can be cherry-picked
   when delegation next comes up.
6. **RL/rollout machinery (GRPO, harness-native RL, Polar-style rollout
   frameworks).** Training-time infrastructure; we don't train models. The one
   usable echo: dsh's log-is-trajectory discipline ("an evaluator can inspect
   input, schemas, responses, results, stop conditions") is *why* their
   invariants are so strict — a good argument for C-invariants, not for RL.
7. **Ralph as a default tool.** Even dsh gates it: "use only when the direct
   human explicitly requests Ralph-style fresh-agent iteration." Right call —
   burn-rate risk without verification ("reports are not independently
   verified").
8. **Agent Teams, Electron desktop, e2b remote sandbox, webhooks.** All either
   experimental (Teams), redundant with our Tauri/sidecar architecture, or
   serving deployment shapes we don't have.

---

## Attribution & license (carried forward from R51)

deepseek-harness is MIT-licensed (© 2026 DeepSeek) —
https://github.com/deepseek-ai/deepseek-harness; fresh clone used for this
study at `/tmp/deepseek-harness` (commit b2e3b2a, Sep 9, 2026, dsh
0.1.5-alpha.2). ACUTE-CODE takes **ideas and patterns only — no code is
copied**; every mechanism described above was read for understanding, and any
future implementation will be an original one in our runtime's idiom (the R51-f
loop guard is the precedent). If a future round ever lifts a trivially small
snippet verbatim (e.g. the deadline-scoping idiom in timeout-policy), it must
carry an inline MIT © 2026 DeepSeek attribution comment.
