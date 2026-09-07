<!-- last-reviewed: 2026-09-07 round-75 -->
# PILLARS — the three-product blueprint

**Owner vision (2026-08-22/23):** ACUTE-CODE is three products in one —
(a) an agentic **coding** environment (Cline/Kiro/OpenCode class — working
today), (b) a full **agentic system** (OpenHands/CrewAI class — Phase 3),
(c) an **automation platform** (n8n class, incl. scheduling). The pillars
are **interconnected in a single environment**: a chat can call specialized
agents as skills; automations run alongside and can invoke agents. Standing
rule: **additive — no pillar ever forces a rewrite.**

Round-17 (audited by sub-agents G1-b, verified by the orchestrator). This
document is the architecture blueprint; `ROADMAP.md` tracks status.

## 1. The unified model: one graph of typed nodes

Every run — a chat turn, a delegated sub-task, a scheduled automation — is
the same thing: **`trigger → (data | agent | tool) → …`**.

- **Chat = a manual trigger** (the composer starts a one-node graph; the
  session event log is its transcript).
- **Agent node = the existing turn runtime, verbatim.** `prepareTurn` +
  `runSingleAgentTurn` / `runStreamedAgentTurn` already are the "agent node
  executor"; pillars compose them, never re-implement them.
- **Specialized agents = tools within a turn** (delegation): a `delegate`
  tool spawns a CHILD SESSION with its own agent; the parent receives only
  the child's summary (research synthesis §4: "delegation-as-task-tool won").
- **Data nodes** (IF/Set/Delay/Transform) run with no model tokens.
- Every persisted node carries `typeVersion` from day one (n8n lesson).

## 2. Event-sourcing across pillars

ADR-0010 semantics generalize: every run appends typed events with per-run
`seq`. Delegation in the log:

```
parent:  message.user → tool.use(delegate) → delegation.started{
            childSessionId, childAgentId, parentAgentId, depth}
         …child session streams its own events (own log)…
parent:  delegation.finished{summary, usage} → message.assistant
```

Usage is attributed to the real executing `agent_id`, under the root run.
Chat UI renders sub-agent work as a live pill on the tool group, expandable
into the child transcript.

## 3. Storage — reused as-is vs added

- **Reused:** agents, providers/keyring, projects, usage ledger, the turn
  runtime.
- **Added:** `workflows` + `workflow_executions` tables (own event stream;
  `typeVersion` column from row one) · child-session columns
  (`parent_session_id`, `triggered_by`) · `schedulers`
  (`{workflowId, cron, tz, lastRunAt, catchUpPolicy}`).
- **Never:** reuse `sessions.mode` for workflows (CHECK-constraint trap —
  table rebuild; floods chat session lists; imports the open-ended chat
  lifecycle into finite executions). Guard test: no execution rows in
  `sessions`.

## 4. Security & approvals across pillars

Path-containment sandbox + allowlist enforcement stay universal. The Phase-3
approval engine is the single gate for destructive ops — including
delegate-tool calls. **Unattended executions** (scheduled) default
fail-closed: destructive tools are structurally unavailable unless the
workflow was pre-authorized by the owner interactively; expiry semantics per
the approval ADR (candidate 0025).

## 5. Concurrency & budget

One global semaphore (max 5 concurrent agent runs — ADR-0011 built for
P3), shared by chat turns, delegations, and workflow agent-nodes; delegation
depth cap; per-run turn/token ceilings; per-session turn serialization
(two concurrent POSTs must not interleave history appends).

## 6. Scheduler & lifetime (owner's explicit ask: scheduling)

v1 = **sidecar-lifetime scheduling**: automations run while the app is open.
Explicit non-goal: no headless service/daemon (two-process rule stands).
Missed-run policy persisted; drain-or-resume within the shell's shutdown
grace. Webhooks are DEFERRED — the loopback-only binding rule makes an
inbound webhook unreachable by design; revisit only via ADR.

## 7. Additive build order (each step shippable alone)

1. **ToolContext seam + allowlist** — ✅ allowlist done (R17); extract
   `ctx {sessionId, agentId, runId, signal, emit, approvalHook}` through the
   runtime so nested turns can stream/abort/attribute (precondition for ②③).
2. **Delegation in chat** (pillar-2 core, owner-visible): delegation event
   schema → child sessions → `delegate` tool → live pills + drill-in.
3. **WS push channel + approval engine** (Phase 3 waves 1–2): one fan-out
   for `session.* / delegation.* / workflow.* / approval.*`; SSE remains for
   per-turn text until folded in.
4. **Workflows table + manual run + data nodes** (no model tokens).
5. **Agent node** (wraps ①) + **schedule trigger** + executions list UI.
6. **Canvas UI** on the freeform-panel store pattern (round-14 groundwork).
7. Later: fs-watch trigger, retry/pin debugging, webhook (ADR-gated).

## 8. Explicit non-goals (v1)

No headless daemon · no external webhooks · no SaaS-connector zoo (HTTP +
agents cover it) · no in-graph JS eval (security-boundary product) · no
cross-machine orchestration · chats stay open-ended (no forced terminal
events).

## 9. Decisions required BEFORE pillar 2/3 code (candidate ADRs 0022+)

1. Delegation event schema & attribution (blocks the delegate tool).
2. Sub-agent context isolation: child sessions, summary-only return,
   per-agent history projection (parent replay must never ingest child
   messages — `asChatMessage` trap).
3. Unified run budget & concurrency (semaphore, depth cap, ceilings,
   per-session serialization).
4. Workflow & execution storage (§3; guard test).
5. Scheduler lifetime & missed-run policy (§6).
6. Approval policy for unattended executions (§4).
7. One push channel (WS gateway; SSE's long-term role).

Each becomes a real ADR (STATUS: PROPOSED → ACCEPTED with the owner) at the
step of §7 that needs it — decision records follow decisions, not wishes.
