<!-- last-reviewed: 2026-09-08 round-79 -->
# MetaGPT — Patterns for ACUTE-CODE

> Concepts only. MetaGPT is Python (MIT) — we build TypeScript on Tauri 2 + Node/TS sidecar (SQLite via localhost REST+WS) + React 18. Nothing below proposes copying code; each entry names the *idea* in MetaGPT and translates it to our stack. MIT is inside our allowed dependency set (MIT, Apache-2.0, BSD, ISC, MPL-2.0), so studying it carries no license exposure; copying would be pointless anyway (different language/runtime, and we are closed-source).

---

## Pattern 1 — Typed pub/sub message pool with `cause_by` + `send_to`

**WHAT (MetaGPT).** The Environment is a single bus. Every `Message` carries `cause_by` (action type that produced it — an event *type*), `sent_from`, and `send_to` (set of addresses, default `<all>`; constants `<all>/<none>/<self>`). Roles subscribe two ways: `_watch(action_types)` (react to messages of those types) and address-based receipt (message addressed to me via `send_to`). `Environment.publish_message` pushes into the private queue of every role whose addresses match and appends every message to a shared `history` audit log; each role's `_observe` filters again and dedupes into per-role memory.

**WHY for ACUTE-CODE.** One mechanism replaces an orchestrator: the PM→Architect→Engineer pipeline *emerges* from subscriptions, and the full history is a naturally replayable audit record — exactly what a human-approval layer needs to answer "who said what, and why did the agent do that". Adding an agent means registering subscriptions, not touching orchestration code. At max 5 concurrent agents the fan-out is trivially cheap.

**HOW it maps.**
- Node sidecar: persist first, fan out second. SQLite `messages` table — `id, run_id, ts, type (≈cause_by), from_agent, to_agents (JSON), content, structured_payload (JSON), approved_by`. The table *is* the shared history/audit log; an in-process dispatcher just delivers.
- Keep the three routing constants (`<all>`, `<none>`, `<self>`) — self-messaging is what powers bounded agent self-loops (rewrite-until-pass) without special cases.
- Subscriptions live in the agent registry (`agents` table: `role, system_prompt, actions JSON, watch JSON`), editable from React before a run — team topology becomes UI-visible configuration.
- WS: every persisted message is pushed to React (`message.created`); the timeline is a live view of the pool with zero polling.
- React: timeline + per-agent / per-type filter chips — the subscription model doubles as the UX information architecture.

## Pattern 2 — SOP encoded as data: role spec + ordered actions + watch list

**WHAT (MetaGPT).** A Role is a declarative record — `name/profile/goal/constraints` composed into the system prompt (PREFIX_TEMPLATE + CONSTRAINT_TEMPLATE + roster of teammates), an ordered `actions` list, and a `watch` set. React modes (verbatim enum): `react` (LLM picks the next action each loop), `by_order` (fixed SOP order), `plan_and_act` (Planner builds a task graph, then executes). The whole "software company" is ~5 such records; MetaGPT now ships both a fixed-SOP mode (`use_fixed_sop`) and the dynamic tool-using RoleZero mode.

**WHY for ACUTE-CODE.** Stages of our engineering workflow (spec → plan → implement → review → test) as editable data means: users inspect/adjust the pipeline before a run; we ship different team presets without new orchestration code; and the human-approval layer is inserted declaratively ("after action X, require approval") instead of wired into control flow.

**HOW it maps.**
- SQLite `roles` / `sop_steps`: `role_key, display_name, goal, constraints, actions (ordered JSON of action keys), watch (JSON of message types), react_mode ('by_order'|'react'|'plan_and_act')`.
- Sidecar `AgentRunner` mirrors `observe → think → act`: `by_order` = index-walk with stop state; `react` = LLM chooses among declared actions, bounded `max_react_loop` (default small); `plan_and_act` = emit a task list into a `tasks` table, execute one by one.
- Action = a TS module `run(ctx): Promise<ActionResult>` with `ActionResult = { content, structured?, artifacts? }`; each action declares the message `type` it emits (the `cause_by` equivalent). System prompt assembled from role fields — no bespoke per-agent orchestration.
- React: SOP editor screen over the same tables via REST; a "topology preview" shows which agent reacts to which message type.

## Pattern 3 — Stage-gated artifact pipeline (documents as the interface between agents)

**WHAT (MetaGPT).** Each SOP stage emits both a Message and a durable document into a repo-shaped workspace (`docs/prd/`, `docs/system_design/`, `docs/task/`, `docs/code_summary/`, `docs/code_plan_and_change/`, `srcs/`, `tests/`) via `ProjectRepo` over `GitRepository`; downstream stages re-read those files. Structured outputs are forced through ActionNode (schema-validated) *before* rendering to Markdown/PDF. `Document` carries a review lifecycle (`status: draft/underreview/approved/done` + `reviews`). At run end the workspace is git-committed (`archive()`).

**WHY for ACUTE-CODE.** Agents handing each other prose is lossy; handing each other versioned, typed documents makes every hand-off inspectable and approvable by the human. Our approval layer becomes: "PRD artifact pending approval → human approves → sidecar publishes `prd.approved` message → next agent's watch fires." Artifacts survive crashes and are the user's actual deliverable; messages are the coordination trace.

**HOW it maps.**
- SQLite `artifacts` table: `id, run_id, stage ('prd'|'design'|'plan'|'code'|'test'|'report'), version, content, structured (JSON, schema-validated), file_path?, status ('draft'|'pending_approval'|'approved'|'rejected'), created_by_agent, created_at`. Append-only: new versions instead of mutation.
- Sidecar writes real workspace files (the project being built) but treats **SQLite as source of truth**; files are a projection — the inverse of MetaGPT's file-first design (see avoid #3).
- Approval gate rides the same message pool: `<stage>.completed` sets artifact `pending_approval`; human approves in React → REST → sidecar publishes `<stage>.approved`, which is on the next agent's watch list. Unapproved stages never trigger downstream work — no separate approval mechanism to keep in sync.
- React: artifact viewer with version history/diff and a stage stepper per run.

## Pattern 4 — Budget as a hard stop (investment / CostManager / NoMoneyException)

**WHAT (MetaGPT).** `Team.invest($)` sets `cost_manager.max_budget`; every LLM call accrues to a run-wide `CostManager` on the shared Context; before each round `Team._check_balance()` raises `NoMoneyException` when `total_cost >= max_budget` — the run dies loudly, not silently. Termination is the triple: round cap (`n_round`), global idleness (`env.is_idle`: every role has no news, no todo, empty buffer), budget exhaustion.

**WHY for ACUTE-CODE.** Cloud-API spend is our main runaway risk with 5 concurrent agents. MetaGPT's placement is exactly right: the check is *outside* the agents (they cannot vote it away), it runs *per round* not per call (cheap), and the budget is shared run-wide — one chatty agent burns the whole team's allowance, an emergent pressure toward terse agents.

**HOW it maps.**
- Sidecar `RunLedger`: `runs.max_budget_usd`, `runs.max_rounds`; every LLM call logs to `llm_calls (run_id, agent, model, in_tokens, out_tokens, cost_usd, ts)` — our CostManager, fed from provider usage fields.
- Run loop: each round, before dispatching, `SUM(cost) >= max_budget` → transition run to `budget_exceeded`, notify UI over WS, stop. Round cap and all-idle terminate the same way (`completed` / `idle` states).
- React: live budget meter + per-agent cost breakdown (GROUP BY over `llm_calls`); "increase budget" is an explicit user action that resumes the run — approval-flavored cost control.

## Pattern 5 — Crash-safe, resumable runs from persisted state

**WHAT (MetaGPT).** `Team.serialize()/deserialize()` persist env + roles + context to `team.json` under `workspace/storage`; `generate_repo(recover_path=...)` resumes a stopped run. Roles keep `latest_observed_msg` so a recovered role re-observes from its last unprocessed message and continues mid-SOP; `Team.run` is wrapped in a serialization decorator.

**WHY for ACUTE-CODE.** Desktop app + long runs + cloud APIs = guaranteed interruptions (sleep, network loss, app update). Closing ACUTE-CODE mid-run and resuming exactly where agents left off is table stakes for local-first — and the safety layer benefits: a resumed run re-presents the *same* pending approval instead of regenerating artifacts (no double spend).

**HOW it maps.**
- We get this almost free from SQLite: messages, artifacts, tasks, llm_calls are already persisted. Add agent runtime state (`state_index, todo_action, last_seen_message_id`) and `runs.status ('running'|'paused'|'awaiting_approval'|'completed'|'budget_exceeded'|'crashed')`.
- On sidecar restart: for each `running` run, rebuild inboxes from `messages` where `id > agent.last_seen_message_id`, mark `paused`, surface "Resume run?" in React. Approved artifacts are never regenerated; only pending steps re-execute.
- WS reconnect in React re-hydrates by querying the tables — the audit log doubles as the resume log. (MetaGPT's serialized-team JSON becomes our rows; strictly more queryable.)

---

## What to avoid (with reasons)

1. **Whole-history prompting.** MetaGPT's `Role._act` calls `todo.run(self.rc.history)` — every action sees the role's full memory (their own `SummarizeCode` pass exists partly to fight this). At our run lengths this multiplies token cost and degrades output. Instead: bounded context assembly (triggering message + approved upstream artifacts + rolling summary); full history lives in SQLite for *humans*, not prompts.
2. **Autonomy-first agents (RoleZero) and LLM-chosen control flow.** RoleZero thinks/acts dynamically with up to 50 react iterations of tool commands; REACT-mode `_think` asks the LLM to pick the next action. Both are nondeterministic and cost-unbounded, and they contradict a human-approval gate. Keep `by_order` pipelines as the default; if we ever allow `react`, bound it tightly and route tool calls through the approval layer.
3. **Filesystem-as-database.** MetaGPT's run state, artifacts, and recovery live in scattered files (`docs/`, `resources/`, `storage/team.json`) with npm-installed mermaid-cli for renders and git-commit as archiving — heavy, process-coupled, opaque to query. For us SQLite is the single source of truth and audit surface; the file tree is only the user's actual project output; any rendering is a background job, never a pipeline dependency.
4. **Default broadcast routing.** `send_to` defaults to `<all>` and every role buffers then discards — wasted work and noisy memory. With ≤5 agents, require explicit `to_agents` for point-to-point and reserve `<all>` for genuine broadcasts (user input, run lifecycle), keeping inboxes and the timeline clean.
5. **Dynamic-class payload deserialization.** MetaGPT's `instruct_content` rehydrates by importing action classes and rebuilding pydantic models at load time — clever but fragile across schema evolution (their own code carries compat shims). Use plain JSON Schemas per message/artifact type with a `schema_version` column; old runs stay readable forever.
6. **Any code or dependency adoption.** Python runtime, pydantic idioms, pinned provider SDKs, and heavyweight optional extras (faiss, lancedb, qdrant, llama-index, meilisearch) are inapplicable: our scale (5 agents, one local SQLite) needs none of the vector machinery — if we later want semantic recall, SQLite FTS5 comes first.

## License note

MetaGPT is **MIT** (verified verbatim from the LICENSE file on `main`: canonical MIT text, "Copyright (c) 2024 Chenglin Wu"; GitHub API `license.spdx_id = MIT`). That is inside our allowed set (MIT, Apache-2.0, BSD, ISC, MPL-2.0) — no GPL-family restriction applies, and even direct porting would be legally permissible. Regardless, we adopt patterns only: no MetaGPT code, package, or dependency enters the ACUTE-CODE tree (it could not — Python vs our TS/Node/Tauri stack).

## Sources

- https://github.com/FoundationAgents/MetaGPT (README, tree)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/LICENSE and https://api.github.com/repos/FoundationAgents/MetaGPT (SPDX)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/role.py (watch/observe/think/act/react, msg_buffer, is_idle, latest_observed_msg, @role_raise_decorator)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/environment/base_env.py (publish_message routing, run gather, archive, history)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/team.py (hire/invest/run, NoMoneyException, serialize/deserialize, use_mgx)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/schema.py (Message fields, subclasses, MessageQueue)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/const.py (routing constants, SERDESER_PATH, workspace repo paths)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/memory/memory.py (storage + cause_by index)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/actions/action.py (Action fields, node/ActionNode)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/utils/project_repo.py and metagpt/document.py (artifact repos, Document status lifecycle)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/software_company.py (default team, recover_path)
- Role wiring: metagpt/roles/{product_manager,architect,project_manager,engineer,qa_engineer}.py and metagpt/roles/di/role_zero.py
