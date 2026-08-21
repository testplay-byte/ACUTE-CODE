# MetaGPT — Patterns for ACUTE-CODE

> Concepts only — MetaGPT is Python (MIT), we build TypeScript on Tauri + Node sidecar + SQLite + React. Nothing below proposes copying code; each entry names the *idea* in MetaGPT and translates it to our stack. MetaGPT's MIT license is inside our allowed set, so even deep study carries no license exposure; copying code would still be pointless (different language/runtime).

---

## Pattern 1 — Typed pub/sub message pool with `cause_by` + `send_to`

**WHAT (MetaGPT).** The Environment is a single bus. Every `Message` carries `cause_by` (class name of the Action that produced it — an event *type*), `sent_from`, and `send_to` (a set of addresses, default `<all>`). Roles subscribe two ways: `_watch(action_types)` (react to messages of those types) and `set_addresses(names)` (receive messages addressed to me). `Environment.publish_message` pushes into the private queue of every role whose addresses match; `_observe` filters again and dedupes into per-role memory. All messages also append to a shared `history` audit log.

**WHY for ACUTE-CODE.** This single mechanism replaces an orchestrator: the PM→Architect→Engineer pipeline *emerges* from subscriptions, and the full message history is a naturally auditable, replayable record — exactly what a human-approval safety layer needs to inspect "who said what and why did the agent do that". It also gives us free extensibility: adding an agent means registering subscriptions, not touching orchestration code. At max 5 agents the fan-out is trivially cheap.

**HOW it maps.**
- Node sidecar: an in-process `EventBus` (`publish(msg)`, per-agent inbox queues). Persist every message first, then fan out: `messages` table in SQLite — `id, run_id, ts, type (≈cause_by), from_agent, to_agents (JSON), content, structured_payload (JSON), approved_by`. The table *is* the shared history/audit log; the bus is just delivery.
- `to_agents` uses explicit role names plus a `<all>` broadcast constant (keep MetaGPT's three constants: `<all>`, `<none>`, `<self>` — self-messaging powers agent self-loops).
- Subscriptions live in the agent registry (`agents` table: `role, system_prompt, actions JSON, watch JSON`), editable in React before a run — the team topology becomes UI-visible configuration.
- WebSocket: every persisted message is broadcast to React (`message.created`), so the UI timeline is a live view of the pool with zero extra polling.
- React: timeline + per-agent filter chips driven by `type`/`from_agent` — the subscription model doubles as the UX information architecture.

## Pattern 2 — SOP encoded as data: role spec + ordered actions + watch list

**WHAT (MetaGPT).** A Role is a declarative pydantic record — `name/profile/goal/constraints` (composed into the system prompt) + an ordered `actions` list + a `watch` set. React modes: `BY_ORDER` (fixed SOP), `REACT` (LLM picks the next action), `PLAN_AND_ACT` (planner produces a task graph). The whole "software company" is ~5 such records; MetaGPT itself ships both a fixed SOP mode and a dynamic tool-using mode ("RoleZero") and now defaults to the dynamic one.

**WHY for ACUTE-CODE.** Stages of our engineering workflow (spec → plan → implement → review → test) as editable data means: users can inspect/adjust the pipeline before a run; we can ship different team presets (research squad vs build squad) without new orchestration code; and the human-approval layer can be inserted declaratively ("after action X, require approval") rather than wired into control flow.

**HOW it maps.**
- SQLite `roles`/`sop_steps` tables: `role (key), display_name, goal, constraints, actions (ordered JSON array of action keys), watch (JSON array of message types), react_mode ('ordered' | 'react' | 'plan_act')`.
- Node sidecar: `AgentRunner` class with `observe → think → act` mirroring MetaGPT's separation. `ordered` mode = index-walk over the actions array with a stop state; `react` mode = let the LLM choose among its declared actions (bounded `max_react_loop`, default small); `plan_act` = generate a task list into a `tasks` table, execute one by one.
- Action = a TS module implementing `run(ctx): Promise<ActionResult>` where `ActionResult` = `{ content, structured?, artifacts? }`; each action declares the message `type` it emits (the `cause_by` equivalent). System prompt assembled from role fields — no per-agent bespoke orchestration.
- React: SOP editor screen reading the same tables via REST; "run preview" shows which agent reacts to which message type (a graph of the topology).

## Pattern 3 — Stage-gated artifact pipeline (documents as the interface between agents)

**WHAT (MetaGPT).** Each SOP stage emits both a Message and a durable document into a repo-shaped workspace (`docs/prd/`, `docs/system_design/`, `docs/task/`, `srcs/`, `tests/`) via `ProjectRepo` over GitRepository; downstream stages re-read those files (incremental mode re-reads everything via `WriteCodePlanAndChange`). Structured outputs are forced through ActionNode (schema-validated pydantic) *before* being rendered to Markdown/PDF. At run end the workspace is git-committed (`archive()`).

**WHY for ACUTE-CODE.** Agents handing each other prose is lossy; handing each other versioned, typed documents makes every hand-off inspectable and approvable by the human. Our approval layer becomes: "PRD artifact awaiting approval → on approve, publish `prd.ready` message → Planner agent's watch fires." Artifacts also survive run crashes and give the user durable value (the actual deliverable), while messages are the coordination trace.

**HOW it maps.**
- SQLite `artifacts` table: `id, run_id, stage ('prd'|'design'|'plan'|'code'|'test'|'report'), kind, version, content (text), structured (JSON, schema-validated), file_path?, status ('draft'|'pending_approval'|'approved'|'rejected'), created_by_agent`. Immutable new versions instead of mutation (append-only ledger).
- Sidecar writes real workspace files (the code being built) but treats **SQLite as source of truth**; workspace files are a projection (inverse of MetaGPT's file-first design — see "avoid" #3).
- Approval gate: message of type `<stage>.completed` sets artifact `pending_approval`; the human clicks approve in React → REST → sidecar publishes `<stage>.approved`, which is on the next agent's watch list. Unapproved stages never trigger downstream work — the approval layer rides the same message pool, not a separate mechanism.
- React: artifact viewer with version history and diff, stage stepper per run.

## Pattern 4 — Budget as a hard stop (investment / CostManager / NoMoneyException)

**WHAT (MetaGPT).** `Team.invest($)` sets `cost_manager.max_budget`; every LLM call accrues `total_cost` on a shared per-run CostManager; before each round `Team._check_balance()` raises `NoMoneyException` when exceeded — the run dies loudly, not silently. Termination is the triple: round cap (`n_round`), global idleness (`env.is_idle`: every role has no news, no todo, empty buffer), budget exhaustion.

**WHY for ACUTE-CODE.** Cloud-API spend is our main runaway risk with 5 concurrent agents. MetaGPT's placement is exactly right: the check is *outside* the agents (they can't vote it away), it's checked *per round* not per call (cheap), and cost is shared run-wide so one chatty agent burns the whole team's budget — an emergent pressure toward terse agents.

**HOW it maps.**
- Sidecar `RunLedger`: `runs` table gets `max_budget_usd`, `max_rounds`; every LLM call logs tokens+cost to a `llm_calls` table (`run_id, agent, model, in_tokens, out_tokens, cost_usd, ts`) — our own CostManager, fed from provider usage fields.
- Run loop (`runOnce()` in the sidecar): each round, before dispatching agents, check `SUM(cost) >= max_budget` → transition run to `budget_exceeded`, notify UI over WS, stop. Round cap and all-agents-idle checks terminate the same way (`completed`/`idle` states).
- React: live budget meter + per-agent cost breakdown (simple GROUP BY over `llm_calls`); "increase budget" as an explicit user action that resumes the run — approval-flavored budget control.

## Pattern 5 — Crash-safe runs via serializable team state

**WHAT (MetaGPT).** `Team.serialize()` writes the whole env + roles + each role's `latest_observed_msg` to `workspace/storage/team/team.json`; `Team.deserialize(recover_path)` resumes — a recovered role re-runs `_observe` from its last unprocessed message and continues mid-SOP. The run loop itself is wrapped in a serialization decorator.

**WHY for ACUTE-CODE.** Desktop app + long runs + cloud APIs = guaranteed interruptions (laptop sleep, network loss, app update). Being able to close ACUTE-CODE mid-run and resume exactly where agents left off is table stakes for local-first, and our safety layer benefits: a resumed run can re-present the *same* pending approval instead of re-generating artifacts (no double spend).

**HOW it maps.**
- We get this almost free from SQLite: every message, artifact, task, and llm_call is already persisted. Add `agents` runtime state (`state_index, todo_action, last_seen_message_id`) and `runs.status ('running'|'paused'|'awaiting_approval'|'completed'|'budget_exceeded'|'crashed')`.
- On sidecar restart: for each `running` run, rebuild inboxes from `messages` where `id > agent.last_seen_message_id`, mark run `paused`, and surface "Resume run?" in React. Approved artifacts are never regenerated; only pending steps re-execute.
- WS reconnect in React re-hydrates by querying the tables — the audit log doubles as the resume log.

---

## What to avoid (with reasons)

1. **Whole-history prompting.** MetaGPT's `Role._act` calls `todo.run(self.rc.history)` — every action sees the role's full memory (their own `SummarizeCode` action exists partly to fight this). At our run lengths this multiplies token cost and degrades outputs. Instead: bounded context assembly (triggering message + approved upstream artifacts + a rolling summary), and put the full history in SQLite for *humans*, not for prompts.
2. **Fixed SOP as the only mode.** MetaGPT demoted its own fixed pipeline to `use_fixed_sop` and moved to dynamic tool-using agents (RoleZero/MGX) — a rigid PM→…→QA chain handles "build me X" but fails on exploration, debugging, or research tasks. Keep `ordered` mode for predictable pipelines but make `react`/`plan_act` first-class; never hardcode the pipeline shape into the run loop.
3. **Filesystem-as-database.** MetaGPT's state lives in scattered files (docs/, resources/, storage/team.json) with npm-installed mermaid-cli for PDFs, and git-commit as archiving — heavy, process-coupled, and opaque to query. For us SQLite is the source of truth and the single queryable audit surface; files are only the user's actual project output; rendering (if ever) is a background job, never a pipeline dependency.
4. **Default broadcast routing.** Messages default `send_to = <all>` and every role buffers then discards — wasted work and noisy memory. With ≤5 agents we can require explicit `to_agents` for point-to-point and reserve `<all>` for genuine broadcasts (user input, run lifecycle), keeping inboxes and the React timeline clean.
5. **Pydantic dynamic-class deserialization.** MetaGPT's `instruct_content` re-hydrates messages by importing action classes and dynamically building pydantic models — clever but fragile across schema evolution (their code carries compatibility shims). We use plain JSON Schemas per action type, versioned by `schema_version` column; old runs stay readable forever.
6. **Any code/dependency adoption.** Python runtime, pydantic-specific idioms, and their provider SDK pinning are inapplicable to Tauri/Node. Also note their heavyweight optional deps (faiss, lancedb, qdrant, llama-index, meilisearch) are irrelevant to us — our scale (5 agents, one local SQLite) needs none of the vector machinery; if we later need semantic recall, SQLite FTS5 comes first.

## License note

MetaGPT is **MIT** (verified verbatim from the LICENSE file, Copyright (c) 2024 Chenglin Wu) — within our allowed set, so even verbatim concept borrowing is unproblematic. We adopt patterns only; no MetaGPT code, package, or dependency enters the ACUTE-CODE tree (it couldn't: Python vs our TS/Node/Tauri stack). No GPL-family exposure anywhere in this research.

## Sources

- https://github.com/FoundationAgents/MetaGPT
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/LICENSE
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/role.py (watch/observe/think/act/react, msg_buffer, is_idle)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/environment/base_env.py (publish_message routing, run loop, archive)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/team.py (hire/invest/run, NoMoneyException, serialize)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/schema.py (Message fields) and metagpt/const.py (routing constants)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/memory/memory.py (indexed memory)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/utils/project_repo.py (artifact repos)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/software_company.py (default team, recover_path)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/actions/action.py (todo.run(history))
- Role wiring: metagpt/roles/{product_manager,architect,project_manager,engineer,qa_engineer}.py
- https://docs.deepwisdom.ai/main/en/guide/get_started/introduction.html
