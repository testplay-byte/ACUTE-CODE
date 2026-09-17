<!-- last-reviewed: 2026-09-17 round-102 -->
# n8n — Architecture Notes (what's under the hood)

Companion to [`README.md`](README.md). Focused on the parts that should shape
ACUTE-CODE's automation pillar design; not an n8n user manual.

## Core model

```
Workflow  = { id, name, nodes[], connections{} }        // persisted graph
Node      = { id, type, typeVersion, parameters, credentials? }
Connection= { sourceNode → sourceOutput → destNodeInput }
Execution = { id, workflowId, mode, status, startedAt, stoppedAt,
              runData: { nodeId → [ { output, error? } ] } }
Item      = { json: {…}, binary? }                      // nodes trade Item[]
```

- **Connections are output→input ports**; a node may have multiple outputs
  (success/error, or branches). This is the piece a visual editor needs from
  day one — model connections as data, never as component nesting.
- **typeVersion on every node**: nodes evolve without breaking saved
  workflows (old workflows keep running on the version they were built
  against). Adopt this the moment we persist any workflow shape.
- **mode** on executions: `manual` (button/creator), `trigger` (live),
  `retry`, `evaluation` — the SAME graph runs in all modes; only the
  initiator differs. Our equivalent: chat-started vs scheduled vs webhook.

## Node categories (n8n's own taxonomy)

| Category | Examples | ACUTE-CODE analogue |
|---|---|---|
| Trigger | Manual, Webhook, Schedule/Cron, Polling, App-event | composer (manual) · cron/fs-watch/webhook (to build) |
| Action / App | HTTP, DB, SaaS connectors | our TOOLS (write_file, search_files…) and Phase-3+ connectors |
| Core / Logic | IF, Switch, Merge, Split-Out, Filter, Code, Set | pure data nodes (to build — no model tokens) |
| Flow | Execute Workflow (sub-workflow), Error Trigger | delegation-as-task-tool (Phase 3) |

## Execution semantics worth copying

1. **Items flow forward only** — a node sees the OUTPUT of upstream nodes,
   never their internals. Predictability over cleverness.
2. **Per-node runData with error capture**: an execution that fails records
   exactly which node failed and its input, enabling **retry-from-node** and
   **pinning** (freeze a node's output; develop downstream without
   re-triggering the world). Pinned data + "execute this node only" is n8n's
   killer debugging loop.
3. **Manual runs are first-class** — every automation is runnable by hand
   with visible data before it is ever armed live. (Our chat IS the manual
   run; keep that guarantee for every future trigger.)
4. **Errors route to an error output / Error Trigger workflow** — failure
   handling is part of the graph, not an afterthought.
5. **Expressions** (`{{ $json.field }}`, `{{ $now }}`) reference upstream
   item data inside parameters — a tiny, sandboxed template language.
   Adopt only with strict sandboxing (never raw eval).

## Scheduling & triggers (the owner's explicit ask)

- n8n's Schedule Trigger is cron-in-node: timezone-aware, persists last-run,
  queues missed runs by policy. A future ACUTE-CODE `schedule` trigger
  should reuse the OS-agnostic pattern: persist {cron, tz, lastRunAt,
  catchUp policy} + a single in-app scheduler loop that starts workflows.
- Polling triggers = schedule + fetch + diff (emit only NEW items). The
  diff/state store is the hard part, not the fetching.
- Webhook triggers = unique path per workflow + auth; executions record the
  raw payload (redacted for secrets) — matches our event-log discipline.

## Persistence & concurrency

- Workflows and credentials in a DB (SQLite in self-hosted n8n — same
  starting point as ours); executions pruned by retention policy.
- One active execution per workflow by default (queue mode for scale) — for
  us: serialize runs per workflow, parallelism across workflows (matches the
  "max 5 concurrent agents" budget rule).
