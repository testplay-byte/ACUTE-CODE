<!-- last-reviewed: 2026-08-25 round-36 -->
# MetaGPT — Architecture

> All claims verified against source on `main` (2026-08-21). Files consulted: `metagpt/schema.py`, `metagpt/roles/role.py`, `metagpt/roles/di/role_zero.py`, `metagpt/environment/base_env.py`, `metagpt/environment/README.md`, `metagpt/team.py`, `metagpt/memory/memory.py`, `metagpt/actions/action.py`, `metagpt/const.py`, `metagpt/utils/project_repo.py`, `metagpt/document.py`, `metagpt/software_company.py`, plus the five software-company role files.

## The four core abstractions

Everything is a Pydantic model. Four concepts — **Environment** (roster + message bus), **Role** (agent), **Action** (one LLM-driven unit of work), **Message** (the only thing that flows) — plus **Team** (owns the run loop) and **Memory** (per-role indexed log).

### Message (`metagpt/schema.py`)

```python
class Message(BaseModel):
    id: str                                  # uuid4 hex, auto-generated (RFC 135)
    content: str                             # natural-language payload
    instruct_content: Optional[BaseModel]    # structured payload (ActionNode/pydantic)
    role: str = "user"                       # system / user / assistant
    cause_by: str = "UserRequirement"        # action type that PRODUCED this message
    sent_from: str = ""                      # producer address
    send_to: set[str] = {MESSAGE_ROUTE_TO_ALL}   # recipient addresses, default broadcast
    metadata: Dict[str, Any]                 # e.g. AIMessage.with_agent(name) stores agent name
```

- Routing constants (`metagpt/const.py`, verbatim values): `MESSAGE_ROUTE_TO_ALL = "<all>"`, `MESSAGE_ROUTE_TO_NONE = "<none>"`, `MESSAGE_ROUTE_TO_SELF = "<self>"`.
- `cause_by` is the event *type* — the class name of the action that produced the message; it defaults to `UserRequirement` for human input. Subclasses: `UserMessage`, `SystemMessage`, `AIMessage` (OpenAI-style role wrappers).
- Key design: a message is **self-describing for routing** — producer type (`cause_by`), sender (`sent_from`), recipients (`send_to`). No central router logic beyond address matching.
- `MessageQueue` (`schema.py`) wraps an `asyncio.Queue`: `pop`, `pop_all`, `push`, `empty`, plus `dump`/`load` for JSON persistence.

### Action (`metagpt/actions/action.py`)

`class Action(SerializationMixin, ContextMixin, BaseModel)` with:

- `name` (defaults to class name), `desc` ("for skill manager"), `prefix` (prepended during `aask*` calls — the system-message fragment), `i_context` (typed context union: CodingContext, TestingContext, RunCodeContext, ...), and `node: ActionNode` (optional structured-output schema, excluded from serialization).
- `async def run(self, *args, **kwargs)` — delegates to `_run_action_node` (schema-validated structured output via `node.fill`) or raises `NotImplementedError` for subclass override.
- ~45 shipped actions (`metagpt/actions/`): `WritePRD`, `WriteDesign` (design_api), `WriteTasks` (project_management), `WriteCode`, `WriteCodeReview`, `SummarizeCode`, `WriteTest`, `RunCode`, `DebugError`, `FixBug`, `WriteCodePlanAndChange`, plus research/talk/tutorial actions. `_an` variants (`write_prd_an.py`, ...) use **ActionNode** — a pydantic tree that forces schema-valid JSON before it is rendered into Markdown (and PDF via mermaid-cli).

### Role (`metagpt/roles/role.py`)

Declarative identity + runtime context:

- Identity fields: `name`, `profile` (job title), `goal`, `constraints`, `desc` — composed into the system-prompt prefix (`PREFIX_TEMPLATE`: "You are a {profile}, named {name}, your goal is {goal}." + `CONSTRAINT_TEMPLATE`); `_get_prefix` also injects the environment description listing teammates ("Other roles: [...]").
- `actions: list[Action]` — the role's SOP steps; `rc: RoleContext` carries `msg_buffer` (private MessageQueue), `memory` (Memory), `working_memory`, `state` (index into actions; -1 = idle), `todo` (current action), `watch: set[str]`, `react_mode`, `max_react_loop`.
- **Subscriptions (two kinds):**
  - `_watch(actions)` — sets `rc.watch = {any_to_str(t) for t in actions}`; role reacts to messages whose `cause_by` is in that set (event-type subscription). Default watch when unspecified: `[UserRequirement]`.
  - `set_addresses(names)` — roles also receive messages explicitly addressed to them via `send_to` (point-to-point; RFC 113-style addressing).
- `RoleReactMode` values (verbatim): `"react"`, `"by_order"`, `"plan_and_act"`.
- Lifecycle in `Role.run(with_memory=True)` (decorated `@role_raise_decorator`):

```
run():
  1. _observe()   -> pop private msg_buffer; keep msgs where
                     (cause_by in rc.watch) or (my name in send_to);
                     dedupe against memory; add news to memory;
                     none kept => return None ("no news. waiting.")
  2. react()      -> _react(): loop { _think(): pick/advance todo
                     (single action => state 0; BY_ORDER => state+1;
                      REACT => LLM chooses via STATE_TEMPLATE; -1 = stop)
                     _act(): msg = todo.run(rc.history);
                             memory.add(msg) }   until no todo or
                     max_react_loop; then state reset to -1
                     _plan_and_act(): Planner alternative path
  3. _publish_message(rsp) -> env.publish_message (or own buffer if self-addressed)
```

- `is_idle` = no news + no todo + empty buffer — the team-level termination signal. Recovery state: `latest_observed_msg` lets a reloaded role resume from its last unprocessed message.

### Memory (`metagpt/memory/memory.py`)

`storage: list[Message]` + `index: DefaultDict[cause_by, list[Message]]` (key type per RFC 116). `add()` skips duplicates; `get_by_actions(actions)` is the subscription-shaped lookup used by `Role.get_memories(k)` (`important_memory` exists only as a commented TODO in current main); `try_remember(keyword)` is a linear substring scan.

### Environment (`metagpt/environment/base_env.py`)

`Environment(ExtEnv)`, where `ExtEnv(BaseEnvironment, BaseModel)` blends a Gymnasium-style contract (abstract `reset/observe/step`) with `EnvAPIRegistry` for read/write APIs to external worlds. Fields: `roles: dict[name, Role]`, `member_addrs: dict[Role, set[str]]`, `history: Memory` (commented "For debug" — the shared audit log), shared `context: Context`, `desc`. `add_role` stores by name, calls `role.set_env(self)`, and propagates the shared context to every role.

**`publish_message(message)` — the heart of the message pool:**

```python
for role, addrs in self.member_addrs.items():
    if is_send_to(message, addrs):     # "<all>" in send_to, or address intersection
        role.put_message(message)      # -> role's private msg_buffer
self.history.add(message)              # global append-only log of every message
```

Broadcast-with-address-filtering: publish once centrally; each matching role's private queue receives the message; filtering happens a second time in each role's `_observe` (watch/send_to/dedupe). Messages with no recipient log a warning. `async run(k=1)` gathers `role.run()` for every non-idle role concurrently (`asyncio.gather`); `env.is_idle` is true only when every role is idle. Per the environment README, external worlds like Android work through `EnvType.ANDROID` with observe (`get_screenshot`) / step (`system_tap`) APIs; Werewolf, Minecraft, Stanford Town are listed as migration TODOs in current main. `Team(use_mgx=True)` (the default) substitutes an `MGXEnv`.

## The classic software-company SOP wiring (verified from role sources)

| Role (name) | Base | Actions (SOP steps) | Watches (triggers on) |
|---|---|---|---|
| ProductManager ("Alice") | RoleZero | PrepareDocuments, WritePRD | UserRequirement, PrepareDocuments |
| Architect ("Bob") | RoleZero | WriteDesign | `{WritePRD}` |
| ProjectManager ("Eve") | RoleZero | WriteTasks | WriteDesign |
| Engineer ("Alex") | Role | WriteCode (+ dynamic SummarizeCode/WriteCodeReview/FixBug/WriteCodePlanAndChange) | WriteTasks, SummarizeCode, WriteCode, WriteCodeReview, FixBug, WriteCodePlanAndChange |
| QaEngineer ("Edward") | Role | WriteTest (single registered action; `_act` manually dispatches write-test -> run-code -> debug-error, capped at `test_round_allowed = 5`) | SummarizeCode, WriteTest, RunCode, DebugError |

The pipeline is **not orchestrated by a controller; it emerges from subscriptions**: PM consumes `UserRequirement` and emits `WritePRD`; Architect consumes `WritePRD` and emits `WriteDesign`; ProjectManager consumes `WriteDesign` and emits `WriteTasks`; Engineer consumes `WriteTasks`, writes code via `repo.srcs.save(...)`, and after its summarize pass sends an AIMessage listing changed files to "Edward" (QA), whose test->run->debug loop closes the cycle. Loop-back watches (Engineer watching `WriteCode`/`WriteCodeReview`/`FixBug`) create iterative refinement inside the same mechanism. The current *default* CLI team (`software_company.py::generate_repo`) is MGX-style — `TeamLeader`, `ProductManager`, `Architect`, `Engineer2`, `DataAnalyst` (from `metagpt/roles/di/`), i.e. RoleZero agents with tool access — while the classic pipeline survives behind `use_fixed_sop`.

## Run loop (`metagpt/team.py`)

```
class Team:
    hire(roles)        -> env.add_roles(roles)          # roster
    invest($)          -> sets investment + cost_manager.max_budget   # hard budget
    run_project(idea)  -> env.publish_message(Message(content=idea))
                          # cause_by defaults to UserRequirement, send_to=<all>

    @serialize_decorator
    async def run(n_round=3, idea="", send_to="", auto_archive=True):
        while n_round > 0:
            if env.is_idle: break       # all roles idle => done
            self._check_balance()       # total_cost >= max_budget
                                        #   => raise NoMoneyException
            await env.run()             # one concurrent tick of all non-idle roles
            n_round -= 1
        env.archive(auto_archive)       # git commit of the project workspace
        return env.history
```

Termination is threefold: round cap, global idleness, or budget exhaustion (`NoMoneyException`, checked once per round against the shared `CostManager`). `Team.serialize()/deserialize()` persist the whole env + roles + context to `team.json` under `SERDESER_PATH` (`workspace/storage`); `generate_repo(recover_path=...)` resumes a stopped run from that state. Cost tracking lives on the shared `Context` (`cost_manager`), so every role's LLM calls accrue to one run-wide budget.

## Artifact flow (`metagpt/utils/project_repo.py`, `metagpt/const.py`, `metagpt/document.py`)

Actions do not only return messages — they write structured documents into a **repo-shaped workspace** via `ProjectRepo` (a `FileRepository` over `GitRepository`, rooted at the per-project path):

- `docs/prd/`, `docs/system_design/`, `docs/task/`, `docs/code_summary/`, `docs/graph_repo/`, `docs/class_view/`, `docs/code_plan_and_change/` — SOP stage outputs (constants `PRDS_FILE_REPO`, `SYSTEM_DESIGN_FILE_REPO`, `TASK_FILE_REPO`, ...).
- `resources/` — rendered counterparts (PRD/design/task PDFs via npm mermaid-cli, competitive analysis, sequence flows).
- `tests/`, `test_outputs/`, and `srcs/` (the code tree; `with_src_path()` must be called first).
- `workspace/storage/` — serialized run state (`team.json`) for recovery.

`Document` (`metagpt/document.py`) is itself a reviewable object: fields `path, name, content, author, status` (enum `draft / underreview / approved / done`) and `reviews`; `to_path()` writes UTF-8 with `mkdir(parents=True)`. A generic `Repo` model additionally buckets documents into `docs / codes / assets` by extension. So an artifact has two lives: a `Message` (with `instruct_content` structured payload) flowing through the pool, and a durable file in the project repo that later stages re-read (incremental mode: `WriteCodePlanAndChange` docs re-read everything). At run end, `env.archive()` commits the workspace as a git snapshot.

## ASCII diagram

```
                      Team.run(n_round)   [while rounds>0 and not idle; _check_balance]
                        │ hire()                          run_project(idea)
                        v                                        │
  ┌─────────────────── Environment ─────────────────────┐         │ Message(content=idea,
  │  roles: {name→Role}    member_addrs    history      │         │   cause_by=UserRequirement,
  │                                                    │<────────┘   send_to=<all>)
  │                publish_message(msg)                 │
  │   "for role, addrs in member_addrs:                 │
  │        if is_send_to(msg, addrs):                   │
  │            role.put_message(msg)  → private queue   │
  │    history.add(msg)              → audit log        │
  └───┬──────────────┬───────────────┬──────────────┬───┘
      v              v               v              v
 ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌───────────┐   each Role:
 │ Product  │  │ Architect │  │ Engineer   │  │ QaEngineer│    msg_buffer (private)
 │ Manager  │  │  "Bob"    │  │  "Alex"    │  │ "Edward"  │    memory (indexed log)
 │ "Alice"  │  │           │  │            │  │           │    actions [A1..An]
 │ watch:   │  │ watch:    │  │ watch:     │  │ watch:    │    _observe → _think
 │ UserReq  │  │ WritePRD  │  │ WriteTasks,│  │ Summarize-│      → _act (todo.run(
 │          │  │           │  │ WriteCode..│  │  Code,... │        rc.history))
 │ actions: │  │ actions:  │  │ actions:   │  │ actions:  │    → _publish_message
 │ WritePRD │  │ WriteDesign│ │ WriteCode..│  │ WriteTest │
 └────┬─────┘  └─────┬─────┘  └─────┬──────┘  └─────┬─────┘
      v              v               v               v
  cause_by:      cause_by:       cause_by:        cause_by:      (each message consumed
  WritePRD ──► Architect ──► WriteDesign ──► ProjectManager ...   by the next watch)
      │  side-effect per action: durable artifacts
      v
  workspace/<project>/ ├── docs/prd/  docs/system_design/  docs/task/
                       ├── docs/code_summary/  docs/code_plan_and_change/
                       ├── srcs/  tests/  test_outputs/  resources/
                       └── storage/team.json (recovery)  + git archive() at run end
```

## Sources

- https://github.com/FoundationAgents/MetaGPT (README, tree, stats)
- https://github.com/FoundationAgents/MetaGPT/tree/main/metagpt, .../tree/main/metagpt/roles, .../tree/main/metagpt/actions
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/schema.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/role.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/__init__.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/di/role_zero.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/product_manager.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/architect.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/project_manager.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/engineer.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/qa_engineer.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/environment/base_env.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/environment/README.md
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/team.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/memory/memory.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/actions/action.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/const.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/utils/project_repo.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/document.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/context.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/software_company.py
