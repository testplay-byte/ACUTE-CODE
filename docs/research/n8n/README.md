<!-- last-reviewed: 2026-09-07 round-75 -->
# n8n — Reference Analysis for the ACUTE-CODE Automation Pillar

**Why this analysis exists (owner direction, 2026-08-23):** ACUTE-CODE is
three products in one — (a) an agentic CODING environment (Cline/Kiro/OpenCode
class — now working, rounds 9–14), (b) a full agentic system (OpenHands/
CrewAI class — Phase 3), and (c) an AUTOMATION PLATFORM (n8n class, incl.
scheduling). The owner asked for n8n research "to get a better understanding
in some areas" so the third pillar is planned from the start and never needs
a rewrite. Sources: n8n docs (docs.n8n.io), architecture write-ups, community
threads — gathered via web research 2026-08-23.

Read order: this file → [`architecture.md`](architecture.md) →
[`patterns-for-acute-code.md`](patterns-for-acute-code.md).

## What n8n is (60 seconds)

A fair-code, node-based workflow automation tool: you wire **nodes** into a
**workflow** (a DAG) that moves and transforms data between apps. A **trigger**
starts an execution; each node receives **items** (an array of JSON objects),
does one thing, and passes items on. Executions are recorded run-by-run with
per-node data, so any run can be inspected and replayed. It is the canonical
model of "visual automation with real engineering underneath".

## The five ideas that matter for ACUTE-CODE

1. **Trigger → nodes → items** is the entire mental model. Everything else
   (credentials, expressions, pinning, errors) hangs off it.
2. **Node = typed unit with typed inputs/outputs** — the graph is validated
   by construction, and any node can be executed/tested in isolation with
   pinned (frozen) input data.
3. **Executions are first-class history** — every run is stored with its
   per-node data; debugging = time travel, not guesswork.
4. **Credentials live in ONE store**, referenced by id — never inline in the
   workflow (mirrors our Credential Manager/keyring rule exactly).
5. **Sub-workflows = composition** — an "Execute Workflow" node turns any
   workflow into a reusable brick; delegation-as-tool is the same pattern the
   research synthesis already recommends for our multi-agent Phase 3.

## Where ACUTE-CODE already matches (by design)

| n8n concept | ACUTE-CODE today |
|---|---|
| Node (typed unit) | Agent (config: provider/model/tools/maxTurns) + tool (typed JSON-Schema I/O) |
| Workflow | Session (event-sourced, append-only — ADR-0010) |
| Execution record | `session_events` + `usage_events` (already an audit trail) |
| Credentials store | Provider keyring / Windows Credential Manager (ADR-0008 family) |
| Sub-workflow / execute-node | Phase-3 delegation-as-task-tool (research synthesis §4) |
| Manual trigger | The chat composer (a run you start by hand) |

## The gap (what the automation pillar must ADD — nothing rewrites)

- A **workflow definition** (persisted graph of steps) distinct from a single
  session run — sessions become one kind of execution of a workflow.
- **Non-chat triggers**: schedule (cron), filesystem-watch, webhook — the
  owner explicitly called out scheduling.
- **Non-agent nodes**: pure data steps (transform, branch/IF, merge, delay)
  so automations don't burn model tokens on plumbing.
- A **visual canvas** (drag-wire editor) — the owner's "highly customizable
  experience … creating automations, creating proper workflows".

Details: [`architecture.md`](architecture.md) · how to adopt without rewrites:
[`patterns-for-acute-code.md`](patterns-for-acute-code.md).
