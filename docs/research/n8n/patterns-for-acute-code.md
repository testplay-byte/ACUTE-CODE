<!-- last-reviewed: 2026-08-25 round-35 -->
# n8n → ACUTE-CODE: Adoption Patterns (no-rewrite plan)

How the automation pillar lands on TODAY's codebase additively — the owner's
standing rule: the three pillars must never force rewrites.

## Principles extracted

1. **Graph as data, not code** — store workflow definitions as JSON rows
   (like n8n's `nodes[] + connections{}`), render whatever UI we like later.
   The demo-parity drag/resize work (round-14 freeform panels) is the UX
   seed; wiring lines are a later additive layer on the same store pattern.
2. **Everything is runnable manually first** — a workflow must be executable
   from the chat/composer with visible data before any trigger arms it. Keeps
   the owner's test-everything-yourself loop intact.
3. **Event-sourcing already won** — a workflow execution should APPEND to an
   event log exactly like sessions do today (ADR-0010). New event types
   (`workflow.started`, `node.started/finished`, `workflow.finished`) slot
   into the existing `session_events` shape — no schema surgery, one new
   table for workflow definitions.
4. **Agents are one node type, not the whole graph** — pure data nodes (IF/
   Set/Delay) run without any model call; agent nodes reuse `runSingleAgentTurn`
   verbatim. The turn runtime becomes the "agent node executor".
5. **typeVersion everything** — from the first persisted workflow row.

## Concrete mapping onto the current stack

| n8n concept | Landing spot in ACUTE-CODE (additive) |
|---|---|
| Workflow row | new `workflows` table (id, name, graph JSON, version) — migration 0004 |
| Manual trigger | "Run workflow" → creates an execution (session-like event stream) |
| Agent node | wraps `runSingleAgentTurn` (existing runtime + tools + audit) |
| Tool node | direct tool call without a model (the round-14 tool functions are already standalone) |
| Schedule trigger | `schedulers` row {workflowId, cron, tz, lastRunAt} + one loop in the sidecar |
| Webhook trigger | one route per workflow under `/hooks/:token` (token = secret, never sequential ids) |
| Pinned data / retry-from-node | runData rows keyed by execution+node (start as debug-only) |
| Credentials | EXISTING provider keyring + Credential Manager — no change |

## Suggested build order (each step shippable alone)

1. **Workflows table + manual run + event log** (invisible UI: CLI only).
2. **Tool-node + IF-node** (no model tokens) — automation that's worth it
   even without agents.
3. **Agent-node** (wrap the existing turn runtime; reuse everything).
4. **Schedule trigger** (owner's explicit ask) + executions list UI.
5. **Canvas UI** (drag-wire) on top of the same store — the round-14
   freeform-panel work proved the interaction model.
6. Webhook trigger + retry/pin debugging niceties.

## What NOT to copy from n8n

- **No inline JS "Code node" with raw execution** — if we add a code node,
  it goes through the Phase-3 approval engine like everything else (ours is
  a security boundary product).
- **No expressions-in-any-string magic** — explicit, typed inputs only;
   discoverability beats terseness for a product whose owner watches every UI.
- **Don't build 400+ SaaS connectors** — HTTP node + agent tools cover 95%
   of real use; connectors come when a real workflow demands them.
