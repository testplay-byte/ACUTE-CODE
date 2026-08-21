# MetaGPT — Architecture

> All claims verified against source on `main` (2026-08-21). File references: `metagpt/schema.py`, `metagpt/roles/role.py`, `metagpt/environment/base_env.py`, `metagpt/team.py`, `metagpt/memory/memory.py`, `metagpt/actions/action.py`, `metagpt/utils/project_repo.py`, `metagpt/software_company.py`.

## The four core abstractions

Everything is a Pydantic model. There are four concepts — **Environment** (message bus + roster), **Role** (agent), **Action** (one LLM-driven unit of work), **Message** (the only thing that flows) — plus **Team** (the run-loop owner) and **Memory** (per-role indexed log).

### Message (`metagpt/schema.py`)

```python
class Message(BaseModel):
    id: str                                  # uuid4 hex, auto-generated
    content: str                             # natural language payload
    instruct_content: Optional[BaseModel]    # structured payload (ActionNode/pydantic)
    role: str = "user"                       # system / user / assistant
    cause_by: str                            # class name of the Action that produced it
    sent_from: str                           # producer address
    send_to: set[str] = {"<all>"}            # recipient addresses (constants below)
    metadata: Dict[str, Any]
```

- Routing constants (`metagpt/const.py`): `MESSAGE_ROUTE_TO_ALL = "<all>"`, `TO_NONE = "<none>"`, `TO_SELF = "<self>"`.
- `cause_by` defaults to `"UserRequirement"` — the entry action type for human input. Subclasses: `UserMessage`, `SystemMessage`, `AIMessage`.
- Key design: the message is **self-describing for routing** — producer type (`cause_by`), sender (`sent_from`), recipients (`send_to`). No central router logic is needed beyond address matching.

### Action (`metagpt/actions/action.py`)

- Pydantic model with `name`, `prefix` (system prompt fragment), optional `node: ActionNode` (structured-output schema), and `async run(*args)`.
- When a Role acts, it calls `todo.run(self.rc.history)` — the action receives the role's **entire memory history**, not just the triggering message.
- ~45 shipped actions (`metagpt/actions/`): `WritePRD`, `WriteDesign` (design_api), `WriteTasks` (project_management), `WriteCode`, `WriteCodeReview`, `SummarizeCode`, `WriteTest`, `RunCode`, `DebugError`, `FixBug`, plus research/talk/etc. Structured variants (`write_prd_an.py`, ...) use **ActionNode**, a pydantic tree that forces schema-valid JSON before it is rendered into Markdown/PDF.

### Role (`metagpt/roles/role.py`)

Declarative identity + runtime context:

- Identity fields: `name`, `profile` (job title), `goal`, `constraints`, `desc` → composed into the system prompt prefix (`_get_prefix`, includes teammates' names and env description).
- `actions: list[Action]` — the role's SOP steps, executed in order or LLM-selected.
- `rc: RoleContext` — `msg_buffer` (private MessageQueue), `memory` (Memory), `working_memory`, `state` (index into actions, -1 = idle), `todo`, `watch: set[str]`, `react_mode`, `max_react_loop`.
- **Subscriptions (two kinds):**
  - `_watch(actions)` — sets `rc.watch` to the class-name strings of actions; the role reacts to messages whose `cause_by` is in that set (event-type subscription).
  - `set_addresses(names)` / default `{class_path, name}` — the role also receives messages explicitly addressed to it via `send_to` (point-to-point subscription).
- `react_mode`: `REACT` (LLM picks next action each loop), `BY_ORDER` (fixed SOP order), `PLAN_AND_ACT` (Planner builds a task graph, then executes tasks).
- Lifecycle in `Role.run(with_message=None)`:

```
run():
  1. _observe()   -> pop private msg_buffer; keep msgs where
                     (cause_by in rc.watch) or (my name in send_to);
                     dedupe against memory; add news to memory;
                     return 0 => suspend ("no news. waiting.")
  2. react()      -> _react(): loop { _think(): pick/advance todo
                     (single action => state 0; BY_ORDER => state+1;
                     REACT => LLM chooses; -1 = stop)
                     _act(): msg = todo.run(rc.history);
                             memory.add(msg) }   until no todo or
                     max_react_loop; then state reset to -1
                     _plan_and_act(): Planner alternative path
  3. publish_message(rsp) -> to env (or to own buffer if self-addressed)
```

- `is_idle` = no news + no todo + empty buffer — the team's termination signal.
- Recovery: `latest_observed_msg` + serialized state let a crashed/recovered role resume where it left off.

### Memory (`metagpt/memory/memory.py`)

`storage: list[Message]` plus `index: DefaultDict[cause_by, list[Message]]`. Retrieval: `get(k)` (last k), `get_by_actions(watch)` (a.k.a. `important_memory` — only messages produced by watched actions), `get_by_role`, `try_remember(keyword)` (substring). Dedup on `add` by message equality. Optional `longterm_memory.py`/`memory_storage.py` add vector-backed recall (faiss etc.).

### Environment (`metagpt/environment/base_env.py`)

- `Environment(ExtEnv)`: `roles: dict[name, Role]`, `member_addrs: dict[Role, set[str]]`, shared `history`.
- **`publish_message(message)` — the heart of the message pool:**

```python
for role, addrs in self.member_addrs.items():
    if is_send_to(message, addrs):     # "<all>" in send_to, or address intersection
        role.put_message(message)      # -> role's private msg_buffer
self.history.add(message)              # global audit log
```

  Broadcast-with-address-filtering: publish once centrally; each subscribed role's private queue receives a reference; filtering happens a second time in `_observe` (by `watch`/`send_to`/dedupe). Unmatched messages log "Message no recipients".
- `async run(k=1)`: for every non-idle role, schedule `role.run()`; `asyncio.gather(...)` — one environment tick runs all active roles concurrently.
- `ExtEnv` generalizes to external worlds (Android, Minecraft, Werewolf, Stanford Town) with `observe()/step()` and an `EnvAPIRegistry` for read/write APIs; `MGXEnv` is the current default (`Team(use_mgx=True)`).
- `archive(auto_archive=True)`: on run end, `GitRepository.archive()` commits the project workspace.

## The classic software-company SOP wiring (verified from role sources)

| Role (name) | Actions (SOP steps) | Watches (triggers on) |
|---|---|---|
| ProductManager "Alice" | PrepareDocuments, WritePRD | UserRequirement, PrepareDocuments |
| Architect "Bob" | WriteDesign | WritePRD |
| ProjectManager | WriteTasks | WriteDesign |
| Engineer | WriteCode (+ SummarizeCode/Review/FixBug flow) | WriteTasks, SummarizeCode, WriteCode, WriteCodeReview, FixBug, WriteCodePlanAndChange |
| QaEngineer | WriteTest | SummarizeCode, WriteTest, RunCode, DebugError |

i.e. the pipeline is not orchestrated by a controller; it **emerges from subscriptions**: PM consumes `UserRequirement`, emits `WritePRD`; Architect consumes `WritePRD`, emits `WriteDesign`; and so on. Note the Engineer's loop-back watches (WriteCode → WriteCode, WriteCodeReview → FixBug) create iterative refinement cycles inside the same mechanism. (The current default team in `software_company.py` is MGX-style: TeamLeader, ProductManager, Architect, Engineer2, DataAnalyst — RoleZero agents with tools like Editor/Terminal/Browser; the fixed pipeline above is kept behind `use_fixed_sop`.)

## Run loop (`metagpt/team.py`)

```python
class Team:
    hire(roles)        -> env.add_roles(roles)         # roster
    invest(dollars)    -> cost_manager.max_budget      # hard budget
    run_project(idea)  -> env.publish_message(Message(content=idea))
                           # cause_by defaults to UserRequirement, send_to <all>

    async def run(n_round=3):
        while n_round > 0:
            if env.is_idle: break          # all roles idle => done
            self._check_balance()          # total_cost >= max_budget
                                           #   => raise NoMoneyException
            await env.run()                # one concurrent tick of all roles
            n_round -= 1
        env.archive(auto_archive)          # git commit workspace
        return env.history
```

Termination is threefold: round cap, global idleness, or budget exhaustion. Every role tick is independently serialized (`@serialize_decorator`), enabling `Team.serialize()` to `workspace/storage/team/team.json` and `Team.deserialize(recover_path=...)` to resume a stopped run.

## Artifact flow (`metagpt/utils/project_repo.py`)

Actions don't just return messages — they write structured documents into a **repo-shaped workspace** via `ProjectRepo` (a `FileRepository` over `GitRepository`, root `workspace/<project_name>/`):

- `docs/prd/`, `docs/system_design/`, `docs/task/`, `docs/code_summary/`, `docs/graph_repo/`, `docs/code_plan_and_change/` — the SOP stage outputs (Markdown; `resources/` holds PDF + Mermaid renders via npm `mermaid-cli`).
- `tests/`, `test_outputs/`, and `srcs/` (the actual code tree).
- `workspace/storage/team/team.json` — serialized run state for recovery.

So an artifact has two lives: a `Message` (with `instruct_content` pydantic payload) flowing through the pool, and a durable file in the project repo that later stages (and incremental changes: `WriteCodePlanAndChange`) re-read.

## ASCII diagram

```
                       Team (run loop: rounds / is_idle / budget)
                         │ hire()                       run_project(idea)
                         v                                     │
   ┌─────────────────── Environment ────────────────────┐      │ Message(content=idea,
   │  roles: {name→Role}   member_addrs   history       │      │   cause_by=UserRequirement,
   │                                                   │<─────┘   send_to=<all>)
   │                publish_message(msg)                │
   │    "for each role: if is_send_to(msg, addrs):      │
   │        role.put_message(msg)  → private queue"     │
   └──┬──────────────┬──────────────┬──────────────┬────┘
      v              v              v              v
 ┌─────────┐   ┌───────────┐  ┌────────────┐  ┌──────────┐
 │Product  │   │Architect  │  │Engineer    │  │QaEngineer│   (each Role:)
 │Manager  │   │           │  │            │  │          │
 │ watch:  │   │ watch:    │  │ watch:     │  │ watch:   │   msg_buffer (private)
 │ UserReq │   │ WritePRD  │  │ WriteTasks │  │ Summar-  │   memory (indexed log)
 │         │   │           │  │ WriteCode..│  │  izeCode │   actions [A1,A2..]
 │ actions:│   │ actions:  │  │            │  │          │   _observe → _think →
 │ WritePRD│   │WriteDesign│  │ actions:   │  │ actions: │   _act (todo.run(history))
 └────┬────┘   └─────┬─────┘  │ WriteCode  │  │WriteTest │   → publish back
      │              │        └─────┬──────┘  └────┬─────┘
      v              v              v              v
  Message        Message        Message         Message        (cause_by = action
  cause_by:      cause_by:      cause_by:       cause_by:       that produced it)
  WritePRD ─────► consumed by Architect ─────► WriteDesign ───► consumed by
                                                       ProjectManager ...
      │
      │  side-effect per action: durable artifacts
      v
  workspace/<project>/  ├── docs/prd/  ├── docs/system_design/ ├── docs/task/
                        ├── srcs/  ├── tests/  └── storage/team.json (recovery)
                        └─ git archive() at run end
```

## Sources

- https://github.com/FoundationAgents/MetaGPT (README, repo tree, stats)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/schema.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/role.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/environment/base_env.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/environment/README.md
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/team.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/memory/memory.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/actions/action.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/utils/project_repo.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/software_company.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/product_manager.py, architect.py, project_manager.py, engineer.py, qa_engineer.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/const.py and utils/common.py (routing constants, `is_send_to`)
