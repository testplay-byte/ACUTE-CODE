<!-- last-reviewed: 2026-09-11 round-87 -->
# OpenHands — Patterns for ACUTE-CODE

Patterns only — never code. All OpenHands material consulted is MIT-licensed (allowed set); nothing below proposes copying implementation. Each pattern: WHAT it is in OpenHands → WHY it fits us → HOW it maps onto Tauri + Node sidecar + SQLite + React.

---

## Pattern 1 — Headless Agent Server (REST control plane + WS event stream)

**WHAT.** `openhands-agent-server` packages the agent runtime as a standalone FastAPI service: REST for control (`POST /conversations`, `GET /conversations/{id}`, `POST /conversations/{id}/run|pause|interrupt`, `POST /conversations/{id}/events/respond_to_confirmation` for human approval, `POST .../confirmation_policy|security_analyzer` for runtime safety-policy swaps — 25 conversation routes verified in `conversation_router.py`) and native FastAPI WebSockets for live events (`WS /sockets/events/{conversation_id}`, query params `session_api_key`, `resend_mode=all|since`, `after_timestamp` — cursor-based replay on reconnect), plus health endpoints (`/health`, `/ready`, `/server_info`) and an OpenAI-compatible gateway (`openai/` module; docs guide "openai-gateway"). Clients (Canvas UI, CLI, automations) never embed agent code — the SDK's own design doc names this as a V1 principle: "Applications communicate with the agent via APIs rather than embedding it directly."

**WHY.** This is exactly the ACUTE-CODE topology: a UI shell that must stay decoupled from a stateful agent runtime. A control/event split over localhost HTTP gives us crash isolation (UI never blocks on LLM calls), a hard security boundary for the human-approval layer, and a testable API without a GUI. OpenHands proved the same binary can be driven in-process (LocalConversation) or remotely (RemoteConversation) with identical semantics.

**HOW.** Our Node/TS sidecar *is* the Agent Server: `POST /sessions` (create agent session with initial prompt), `GET /sessions/:id`, `POST /sessions/:id/messages`, `POST /sessions/:id/approvals/:actionSeq` (their `respond_to_confirmation`), `DELETE /sessions/:id`, `GET /health`/`/ready` for Tauri shell supervision, and `WS /sessions/:id/events` for streaming — copy their reconnect semantics: client sends `?since=<seq>` and the server replays missed events before going live (their `resend_mode=since&after_timestamp`). Tauri spawns and health-polls the sidecar exactly as `DockerWorkspace` does (`--host/--port`, wait for `/ready`). The OpenAI-compatible gateway is a cheap later addition for IDE integrations.

## Pattern 2 — Event-sourced session: append-only event log + one mutable state snapshot

**WHAT.** Every conversation is an append-only log of immutable typed `Event`s (`id`, `timestamp`, `source ∈ {user, agent, environment}`) plus a single separately-persisted mutable `ConversationState` (`base_state.json` rewritten wholesale; events appended incrementally as `event-00000-<id>.json`). The log is simultaneously agent memory, LLM input, persistence unit, and integration bus; auxiliary services are read-only observers. Resume = re-construct with the same `conversation_id`; `paused` status survives restarts. Design doc: "Keep everything stateless, with exactly one mutable state … a single source of truth that enables deterministic replay and robust persistence."

**WHY.** ACUTE-CODE needs durable multi-agent sessions with resume-after-crash, a scrollable audit trail for the approval layer, and cheap UI rehydration. Event sourcing gives all three from one mechanism: the React UI is just a projection of the log (their visualization service does precisely this), and replaying events rebuilds state deterministically.

**HOW.** In SQLite (WAL mode) owned by the sidecar: an append-only `events` table `(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id, id, type, source, ts, payload JSON)` — never UPDATE/DELETE — plus a `sessions` table with a `state` JSON column (config, status incl. `paused`, iteration/cost counters, activated skills) rewritten on change. Sequence numbers replace their zero-padded filenames; `seq`-based cursors feed the WS stream ("everything after cursor N"), and a debounced state writer mirrors their auto-save. UI rehydration = `SELECT * FROM events WHERE session_id=? ORDER BY seq`.

## Pattern 3 — Typed event schema with an LLM-convertible split, risk fields, and rejection events

**WHAT.** Events split into **LLM-convertible** (`MessageEvent`, `ActionEvent` carrying `thought`/`reasoning_content`/**security-risk fields**, `ObservationEvent` with `role=tool`, `AgentErrorEvent`, `SystemPromptEvent`, `CondensationSummaryEvent`; each implements `to_llm_message()`) and **internal** (`ConversationStateUpdateEvent`, `CondensationRequest`/`Condensation`, `PauseEvent`). `UserRejectObservation` is a first-class event fired when a user rejects an action in confirmation mode. Two error classes: recoverable `AgentErrorEvent` (LLM sees it and retries) vs fatal `ConversationErrorEvent` (run aborts, `ConversationRunError`). `source` (attribution) is deliberately independent from LLM `role` (formatting).

**WHY.** This is the schema blueprint for our human-approval safety layer: OpenHands encodes *risk on the action* and *human rejection as an environment observation the LLM must digest and route around* — precisely the semantics our approver needs (propose → gate → allow/deny → agent adapts). The convert/keep-internal split also keeps token streaming cheap and makes parallel tool calls explicit (`llm_response_id` grouping).

**HOW.** Zod-typed event union in the sidecar: `user_message | agent_message | action { tool, args, thought, risk: 'safe'|'needs-approval', status: 'proposed'|'approved'|'denied' } | observation | rejection | error { recoverable: boolean } | state_delta | pause`. Only LLM-convertible rows are serialized into provider calls (a `toLlmMessage()` equivalent per type; `action`+`observation` pair by `action_id` like their `tool_call_id`). A denial writes a `rejection` event that renders as a `tool`-role message, mirroring `UserRejectObservation`; the UI's approve/deny button maps to a dedicated REST route exactly as theirs does (`POST /conversations/{id}/events/respond_to_confirmation`). Consider their inline-risk trick (LLM self-declares `security_risk` in the tool call) as a *hint* layered under our own deterministic classifier — never the only signal. Risk classification lives on the action *before* execution, feeding the approval gate.

## Pattern 4 — Workspace/runtime abstraction with opt-in isolation

**WHAT.** Execution environment is hidden behind a narrow `Workspace` boundary: `LocalWorkspace` (in-process), `DockerWorkspace` (spawns container running agent-server), `RemoteAPIWorkspace` (HTTP). Critical boundary rule: **tools are not workspace calls** — tools run alongside the agent in whatever environment the workspace configures; the workspace only provisions it. Same Agent + Tools + LLM code in every mode. Their V1 design doc states the lesson from V0: "Sandboxing should be opt-in, not universal." The legacy design (for contrast) pushed *every* action through a `Runtime` → `ActionExecutionServer` (`/execute_action`, `/alive`) inside a sandbox — the model they walked away from as the default.

**WHY.** ACUTE-CODE v1 deliberately ships no sandboxing; OpenHands validates that as a legitimate architecture, not a shortcut — they made isolation *optional* after running the always-sandboxed model at scale. What we should copy is the *seam*: today our "workspace" is the local machine, tomorrow it can be a container, without touching agent or tool logic.

**HOW.** Define a `Workspace`/`ExecutionTarget` interface in the sidecar (v1: `LocalWorkspace` executing shell/file tools as the sidecar user under the repo root; later: `DockerWorkspace` speaking the same interface). Tools receive a workspace handle for environment details (cwd, env vars) but execute through a tool-runner that is workspace-agnostic — preserving their "tools are not workspace calls" rule, which keeps v1 dead simple and v2 containerization surgical. Approval risk classes (Pattern 3) apply regardless of workspace, so safety does not depend on sandboxing.

## Pattern 5 — Controller/agent separation with observer services

**WHAT.** `Conversation` is the controller (lifecycle: init/run/pause/terminate; owns `ConversationState` and `EventLog`; FIFO-locked two-path writes — state-only vs event-append; reads never block writes). `Agent` is a pure reasoning loop reporting back only via state events. All auxiliary services — persistence, **stuck detection** (sliding-window pattern matching over the log), visualization, secret registry — attach as read-only observers that "read from the event log but never mutate state directly."

**WHY.** ACUTE-CODE has the same three concerns (session orchestration, agent loop, cross-cutting services like approvals/logging/cost caps). Making the sidecar's session manager the sole writer and everything else a subscriber eliminates a whole class of concurrency bugs and lets us add features (stuck-detection is directly useful for flailing agents under our 5-agent cap) without touching the loop.

**HOW.** Sidecar modules: `SessionManager` (controller — owns SQLite writes, run/pause/stop, max-iterations), `AgentLoop` (LLM ↔ tools, emits actions, consumes observations; no DB access), and subscribers registered on an in-process event bus fanned out to the WS: `ApprovalGate` (intercepts `risk='needs-approval'` actions, holds the loop, surfaces to React), `StuckDetector` (sliding window over recent actions), `CostTracker` (token/cost counters into state), `PersistenceWriter` (debounced state snapshots — SQLite instead of `base_state.json`). Pause = persisted status + `pause` event, resumable across app restarts.

## Pattern 6 — Delegation as a typed tool with resumable sub-agents

**WHAT.** `TaskToolSet` (from `openhands.tools.task`) exposes delegation itself as a tool: parent calls it with `{prompt, subagent_type?, description?, resume?}`; a `TaskManager` creates or resumes a sub-agent conversation that "runs autonomously," then returns a `TaskObservation {task_id, subagent, status: completed|error, text}`. Sub-agent types are registered via `register_agent(name, factory_func, description)` (`openhands.sdk.subagent`); a `default` type exists. Sub-conversations persist to disk, so `resume='task_00000001'` reloads full history. Delegation is **synchronous/blocking** — parent halts until the child finishes; benefit is context isolation. A `DelegationVisualizer` renders the tree.

**WHY.** Our orchestrator→researcher/builder/critic model needs exactly this: typed agent profiles, context isolation per sub-agent, structured returns (not free text), and resumability for follow-ups. Their model proves delegation-as-a-tool keeps the parent's loop uniform (it's just another tool call — which also means our approval gate can mediate *delegations themselves*).

**HOW.** Sidecar registry: agent profiles (name, description, system prompt, tool whitelist, risk defaults) in SQLite; a `delegate` tool that spawns a child session (rows in the same `sessions`/`events` tables with `parent_session_id`, `parent_action_seq`), streams its events into the parent's WS as nested views (React renders a tree like `DelegationVisualizer`), and returns `{task_id, status, text}` as the observation. Two deviations we should make: (a) **async by default** — OpenHands is blocking/sequential, but we cap at 5 concurrent agents, so `delegate` should accept a list and the parent's loop should await observations as they land (still one assistant turn); (b) approval gates inside children report to the same approver surface. Resume = reopen child session by task_id, matching their semantics.

---

## What to avoid (with reasons)

1. **Full container sandboxing in v1.** Out of scope for ACUTE-CODE v1 — and OpenHands' own V1 redesign ("sandboxing should be opt-in, not universal") shows always-on sandboxing is an operational cost, not a prerequisite. Keep the `Workspace` seam (Pattern 4) and defer.
2. **File-based persistence everywhere.** Their `events/event-00000-*.json` layout trades DB complexity for filesystem churn, and even the server's settings/secrets stores are flat JSON files with `fcntl`/`msvcrt` locking (verified in `persistence/store.py` — no SQL database anywhere in the agent server). On Windows (our target) thousands of tiny files is slow to enumerate and backup. We already own SQLite — use append-only WAL tables instead.
3. **Secrets inside persisted session state.** They store credentials in `base_state.json`, encrypted via a long-lived `OH_SECRET_KEY` that bricks stored data if lost. For a local-first app, keep secrets in the Windows Credential Manager / OS keychain and store only references in SQLite.
4. **Letting the UI share code with the agent core.** Their documented V0 failure (CLI/web UI "polluted the core with conditionals"). Our Tauri/React layer must only ever speak the sidecar's HTTP/WS API — no shared TS modules that leak agent logic into the shell.
5. **Blocking-only delegation.** `TaskToolSet` is explicitly sequential ("synchronous … not parallel"). With max 5 concurrent agents and human approvals in the loop, purely sequential delegation would serialize latency behind approval queues. Adopt the shape, make it async.
6. **Duplicating their multi-backend/multi-server UX in v1.** Canvas's connect-to-N-backends, backend-switching (switching silently switches the agent's environment!), ACP third-party agents, and automations (Slack/GitHub/Linear) are product breadth we do not need. One local sidecar first.
7. **Their legacy `enterprise/` carve-out and archived monorepo.** The `OpenHands/legacy` repo is read-only, split-licensed (enterprise dir under a separate license), and stripped of the interesting code. Treat it as history; study `software-agent-sdk`.
8. **Unauthenticated localhost API complacency.** OpenHands gates `/api/*` behind `X-Session-API-Key` with key rotation and CORS allow-lists even though it's often local. Our sidecar should bind 127.0.0.1 with a per-launch token (generated by Tauri, passed to the sidecar) so other local processes cannot drive agents.

## License note

All consulted artifacts are MIT (`OpenHands/OpenHands` LICENSE, `software-agent-sdk` LICENSE) — within ACUTE-CODE's allowed set; no GPL-family components encountered. The archived `OpenHands/legacy` has a non-MIT `enterprise/` directory — not consulted, not needed. This document records patterns only; no OpenHands code is proposed for copying.

## Sources

- https://docs.openhands.dev/sdk/arch/overview.md
- https://docs.openhands.dev/sdk/arch/design.md
- https://docs.openhands.dev/sdk/arch/agent-server.md
- https://docs.openhands.dev/sdk/arch/events.md
- https://docs.openhands.dev/sdk/arch/conversation.md
- https://docs.openhands.dev/sdk/guides/convo-persistence.md
- https://docs.openhands.dev/sdk/guides/task-tool-set.md
- https://docs.openhands.dev/sdk/guides/agent-server/overview.md
- https://docs.openhands.dev/openhands/usage/agent-canvas/overview.md
- https://docs.openhands.dev/openhands/usage/architecture/backend
- https://github.com/OpenHands/software-agent-sdk
- https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-agent-server/openhands/agent_server
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/LICENSE
- https://raw.githubusercontent.com/OpenHands/legacy/main/LICENSE
- https://github.com/OpenHands/legacy
- https://github.com/All-Hands-AI/OpenHands
- https://raw.githubusercontent.com/All-Hands-AI/OpenHands/main/LICENSE
- https://docs.openhands.dev/
- https://docs.openhands.dev/sdk/arch/security.md
- https://docs.openhands.dev/sdk/arch/workspace.md
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/conversation_router.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/event_router.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/sockets.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/persistence/store.py
- https://www.openhands.dev/blog/the-path-to-openhands-v1
