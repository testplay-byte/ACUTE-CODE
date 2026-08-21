# Cline — Patterns for ACUTE-CODE

All claims verified against `github.com/cline/cline` `main` on 2026-08-21 (Apache-2.0; pattern
study only — no code copying, none needed for any pattern below).

Stack shorthand: **Tauri 2 shell (Rust) + React 18/TS UI + Node/TS sidecar owning SQLite via
localhost REST+WS + cloud LLM APIs + human-approval safety layer + max 5 concurrent agents.**

---

## Pattern 1 — Coordination daemon with WebSocket clients ("hub-spoke")

**WHAT (in Cline).** The SDK runs a "Singleton daemon per machine. Coordinates sessions, routes
events and approvals" (docs/sdk/architecture/hub-spoke.mdx). Clients (CLI, webviews, IDE
plugins) connect over WebSocket; worker "spokes" run `@cline/core` and are "Owned by the daemon,
not by any client"; spokes never talk to clients directly. Discovery via lock files in
`~/.cline/locks/hub/owners/`; auto-start if absent; backend modes `auto | hub | remote | local`.

**WHY it fits ACUTE-CODE.** Our Node sidecar *is* a coordination process: it owns SQLite, runs
agent workers (max 5), and serves the Tauri UI over localhost. Cline validates the exact
benefits we want — UI process can restart without killing agents, a runaway agent cannot freeze
the UI, and session state survives window close. Cline's own SDK examples reportedly include a
"Tauri desktop app with a Bun sidecar backend", i.e. they built our topology deliberately.

**HOW it maps.**
- Sidecar = hub: single instance enforced with a lock file + port record (we can mirror the
  `locks/hub/owners/` pattern with an OS-level lockfile in our app-data dir); binds 127.0.0.1
  only; refuses external interfaces.
- WS channel = client plane: typed request/response + event broadcast (see Pattern 2). REST
  endpoints for CRUD (sessions, settings); WS for streaming agent events and approval prompts.
- Agent workers = spokes: child processes or worker threads in the sidecar, each owning one
  conversation loop; workers emit events only to the sidecar, which fans out to subscribed UI
  clients. Key rule to copy: **workers never connect directly to the UI** — one routing point,
  one place to enforce the approval gate and concurrency cap (our max 5).
- Unlike Cline we do **not** need machine-wide multi-app sharing in v1 — our "hub" is scoped to
  our app instance. Keep `local` (in-process) as a fallback mode for tests, mirroring their
  `auto | local` split.

## Pattern 2 — Typed RPC over the UI transport ("protobus")

**WHAT.** Between extension host and webview, Cline wraps postMessage in a gRPC-style protocol
(`core/controller/grpc-handler.ts`): every call carries a `request_id`; responses are
`{ message, request_id, is_streaming, sequence_number }`; unary and streaming calls; cancellation
via a `GrpcRequestRegistry` that resolves by `request_id` and confirms `{ cancelled: true }`;
handler maps are codegen'd per host; a `GrpcRecorderBuilder` records all traffic for replay in
tests. Streaming responses deliberately stay open ("the stream should stay open for future
updates").

**WHY it fits.** Our UI↔sidecar channel (WS + REST) has the same hazards protobus solves: lost
request/response correlation, interleaved streams from 5 concurrent agents, cancellation of a
running agent mid-stream, and the need to test the protocol deterministically. Ad-hoc
message-type switches rot quickly; request-id correlation + sequenced streams do not.

**HOW it maps.**
- Define services in TypeScript (shared types package imported by both React UI and sidecar —
  the role `@cline/shared` plays): `agents.Run(prompt) → stream`, `agents.Cancel(id)`,
  `approvals.Respond(id, decision)`, `sessions.List/Get/Delete`, `mcp.List/Enable`.
- WS frames: `{ kind: "request" | "response" | "event", requestId, seq?, topic?, payload }`;
  per-agent streams keyed by agentId with monotonic `seq` for gap detection and resume.
- Cancellation: registry of in-flight agent runs keyed by requestId/agentId; cancel = stop
  accepting model output, kill the tool process tree, persist partial transcript, confirm.
- Recording middleware: log every request/response pair to SQLite (`rpc_log` table) — gives us
  Cline's replay benefit nearly for free since we already own a database, and doubles as an
  audit trail for the approval layer.

## Pattern 3 — Layered SDK packages with one-way dependencies

**WHAT.** `sdk/ARCHITECTURE.md` defines the stack `@cline/shared → @cline/llms → @cline/agents
→ @cline/core → hosts` where each package may only import the ones below it: `shared` (types,
zod schemas, hooks engine), `llms` (providers/model catalogs/gateway contracts), `agents`
(stateless loop with tools + streaming events, no persistence), `core` (stateful: sessions,
storage, daemon, plugins, compaction), hosts (thin embedders). Design seams are called out
explicitly (config watchers, storage adapters, extension/hook split).

**WHY it fits.** ACUTE-CODE's sidecar will grow the same organs. The discipline that matters is
Cline's: the agent loop is **stateless and persistence-free**, so it is unit-testable with fake
providers and fake tools; all state lives one layer up. That is exactly how we should structure
the sidecar so our approval layer and SQLite never entangle with LLM plumbing.

**HOW it maps.** Inside our Node sidecar (npm workspaces, no need to publish):
- `@acute/shared` — zod schemas + TS types for messages, tool defs, approval objects, WS/REST
  envelopes (also imported by the React UI).
- `@acute/llms` — provider adapters (Anthropic/OpenAI/Google/...) behind one streaming
  interface; model catalog as data, not code branches.
- `@acute/agent` — the loop: prompt assembly, tool dispatch, event emission; **zero** fs/db
  imports; tested with fake providers.
- `@acute/core` — sessions, SQLite repositories, approval gate, MCP manager, worker supervision
  (max 5), compaction.
- `hosts`: sidecar HTTP/WS layer + (later) any CLI.

## Pattern 4 — Plan/Act as an enforced capability split (not just a prompt)

**WHAT.** Cline's Plan mode "cannot modify any files or execute commands" — an enforced
constraint, with conversation history carrying over on switch, optional **per-mode model
selection** ("Use different models for Plan and Act"), and model-family-optimized planning
prompts (docs/core-workflows/plan-and-act.mdx).

**WHY it fits.** ACUTE-CODE is approval-first. Plan/Act maps naturally onto our safety model:
Plan = read-only toolset (read, search, list) needing no approvals; Act = write/execute tools
each individually gated. Cline's insight worth stealing: the mode is a **toolset restriction**,
so it cannot be prompt-injected around, and context continuity across the switch is what makes
it usable rather than a restart.

**HOW it maps.**
- Mode is a field on the session in SQLite; the sidecar computes the allowed toolset from it;
  the agent layer literally never receives write tools in Plan mode (schema-level enforcement,
  matching Cline's hard restriction).
- Allow a "planner model ≠ executor model" setting pair per session (cheap to store, users
  expect it — Cline suggests quality/budget/speed pairings).
- Switching modes keeps one transcript; the mode change is recorded as an event so the UI can
  render the boundary (Cline keeps full continuity).

## Pattern 5 — Category-based auto-approve with per-command "Always approve" and a YOLO escape hatch

**WHAT.** Cline's approval UX (docs/features/auto-approve.mdx, `shared/AutoApprovalSettings.ts`):
approval popups per action; an Auto-Approve panel of **categories** — Read Files, Edit Files,
Execute Safe Commands, Execute All Commands, use Browser, use MCP; shell commands carry a
model-assessed `requires_approval` flag which the user can override durably via "Always approve
this command"; "YOLO mode" enables everything and triggers an explicit warning modal. Settings
carry a `version` field incremented on every change to prevent races.

**WHY it fits.** This is the gradated middle ground between "approve everything" and "approve
nothing" that a human-approval product needs. Our defaults will be stricter than Cline's (their
legacy defaults leaned permissive — see Avoid), but the interaction vocabulary — category
toggles, per-command remembers, one scary switch for full auto — is proven UX we should mirror.

**HOW it maps.**
- SQLite `permission_policy` table: per workspace/global, columns per category
  (`read_files`, `edit_files`, `run_command`, `browser`, `mcp`), each `ask | auto`; enforced in
  the sidecar **before** tool dispatch (deterministic — do not adopt Cline's model-judged
  `requires_approval` as the gate; see Avoid).
- `command_allowlist` table populated by the approval dialog's "Always approve" button
  (exact-command and prefix matching); shell tool consults it first.
- "Full auto" mode exists but flips only after a confirm dialog; every auto-executed action is
  still logged (ties into Pattern 2's rpc/audit log) and is reversible via Pattern 6.
- Scope our categories project-root-aware from day one: read/edit **inside workspace** vs
  **outside** are different permission rows (Cline had this — `readFilesExternally` /
  `editFilesExternally` — and later legacy-flagged it; we should keep the distinction primary,
  not legacy).

## Pattern 6 — Checkpoints as per-action restore points with three restore modes

**WHAT.** After every tool use Cline commits the full workspace state (including
git-ignored/untracked files) into a **shadow git repository** separate from the project's git.
Each checkpoint appears inline in the conversation with Compare (native diff) and Restore;
restore offers *Restore Files*, *Restore Task Only* (rewind conversation, keep files), or
*Restore Files & Task*; editing a past message optionally restores files to that checkpoint
first (docs/core-workflows/checkpoints.mdx). SDK side has `checkpoint-diff.ts`,
`checkpoint-restore.ts`, `session-snapshot.ts`, `session-versioning-service.ts`.

**WHY it fits.** An approval-first product needs a credible answer to "I approved it and it was
wrong." Cline's UX vocabulary (per-action bookmark, compare-before-restore, three restore
modes, message-edit → rewind) is the most refined in the field. The **mechanism** (shadow git
after every tool use) is the part we should not copy (see Avoid).

**HOW it maps.**
- In SQLite: `snapshot` table — `id, session_id, agent_id, tool_call_id, created_at`; content
  in a content-addressed blob store (file path → hash) or a hidden `.acute/snapshots` git repo
  scoped to the workspace, whichever we validate first. Snapshot **before** each approved
  mutating action (not after every read), so every approved action is bracketed.
- Restore endpoints mirror the three modes: files-only, transcript-only (truncate events +
  conversation rows after point), both. Transcript rewind is trivial for us since the sidecar
  owns the event log — easier than Cline's, which had to slice UI history files.
- UI: checkpoint chip per approved tool call; diff view in the React UI (react-markdown /
  diff rendering we already plan); "Restore" menu with the three options.

## Pattern 7 — MCP hub with fingerprint-guarded reconcile loop

**WHAT.** `services/mcp/McpHub.ts`: MCP servers configured in a zod-validated JSON file
(`{ mcpServers: {...} }`, `${env:VAR}` expansion) watched with chokidar (`awaitWriteFinish`,
atomic writes). Each server gets one official-SDK `Client` over stdio / SSE / streamable-HTTP;
OAuth handled by `McpOAuthManager` (401 → `oauthRequired` state, not failure). Capability
discovery (tools/resources/prompts) runs in parallel and is cached on the connection;
`tools/list_changed` triggers a **debounced (300 ms, max-wait 2 s), generation-guarded** refresh
so stale lists cannot publish. A **connection fingerprint** (`stableJsonStringify`) skips
no-op file edits, breaking watcher → reconnect → rewrite loops. Per-tool auto-approve from an
`autoApprove` list in the same file.

**WHY it fits.** We will ship MCP support, and the hard parts of an MCP manager are exactly
what McpHub solved: reacting to user edits of a config file without thrashing, transport
differences, OAuth, and keeping tool lists fresh without racing. The generation-guard + fingerprint
combo is the difference between a demo and a reliable feature.

**HOW it maps.**
- Config: our SQLite `mcp_server` table is the source of truth (better than a JSON file for a
  DB-first app), but keep an import/export of the standard `mcpServers` JSON shape so users can
  paste Claude/Cline-format configs — instant ecosystem compatibility.
- Sidecar `McpManager` singleton: one SDK client per server; transports stdio + streamable-HTTP
  first (SSE optional); parallel capability discovery cached in SQLite (`mcp_tool` table) so the
  UI and the agent's tool schema assembly read from the DB, not from live connections.
- Debounced, generation-counter-guarded refresh on `list_changed`; fingerprint server configs
  before reconnecting on change events.
- Per-tool permission rows join MCP tools into Pattern 5's policy engine (`mcp:server/tool` as
  the permission subject).

## Pattern 8 — Deterministic compaction as an artifact, transcript kept canonical

**WHAT.** sdk/ARCHITECTURE.md: the canonical conversation transcript is never destructively
summarized; compaction is a separate `{sessionId}.compaction.json` artifact, validated by a hash
so "recompaction produces identical output" — deterministic, auditable, and reversible context
management.

**WHY it fits.** Long multi-agent sessions with 5 concurrent workers will blow context windows;
naive in-place summarization corrupts history and makes resume non-reproducible. Keeping the
transcript append-only in SQLite (which we get naturally) plus a derived compaction artifact is
both cheaper and debuggable.

**HOW it maps.** `conversation` and `events` tables are append-only canonical storage;
`compaction` table stores `{session_id, up_to_seq, summary, model, hash}`; the agent layer
receives (compacted prefix + tail) at prompt-assembly time. Recompute on demand; never mutate
rows. Hash the compaction input so we can detect drift.

## Pattern 9 — Read-only subagents with flat hierarchy

**WHAT.** Cline's `use_subagents` tool (docs/features/subagents.mdx): main agent spawns parallel
research subagents, each with its own prompt/context/token budget, restricted to read-only tools
(`read_file`, `list_files`, `search_files`, `list_code_definition_names`, read-only
`execute_command`, `use_skill`); subagents "cannot spawn their own subagents"; results return as
reports with the most relevant file paths; per-subagent cost rolled into the task total.

**WHY it fits.** This is a safe design for our max-5 concurrency: research fan-out needs no
approval flow at all (read-only toolset, like Plan mode), cannot fork-bomb (flat hierarchy,
hard cap), and keeps the orchestrator's context small. It matches ACUTE-CODE's multi-agent
workbench story without any of the write-collision hazards.

**HOW it maps.** Orchestrator agent gets a `spawn_researcher` tool; sidecar enforces: ≤5 live
agents total (orchestrator counts), subagent toolset = read-only set, no subagent spawn tool in
subagent toolset (schema-level), per-subagent token budget, results delivered as a structured
report tool-result. All under the same WS event stream with `agentId` correlation (Pattern 2).

## Pattern 10 — Batched, debounced state writes with layered settings precedence

**WHAT.** `StateManager.ts`: in-memory cache; writes batched and flushed to disk debounced
(500 ms); secrets in a separate store; explicit precedence **remote config > session override >
task settings > global settings**; settings schema versioned with migrations
(`state-migrations.ts`); multi-window staleness accepted (instances read disk only at init).

**WHY it fits.** Our sidecar is the single writer to SQLite, which removes Cline's multi-window
staleness problem entirely — but their layered-precedence model is directly useful: per-task
overrides (e.g., this task may auto-approve tests), session overrides (CLI flag equivalents,
never persisted), global defaults. Versioned migrations are table stakes we need anyway.

**HOW it maps.** SQLite tables `settings_global`, `settings_task(task_id, key, value)`; in-memory
effective-settings resolver with documented precedence (for us: **policy > task override >
session override > global** — our human-approval policy outranks convenience settings); a
`settings_version` bumped on every mutation for optimistic concurrency from multiple UI tabs;
secrets (API keys) in the OS keychain via Tauri's stronghold/keyring APIs, referenced by ID from
SQLite — never stored in the DB file.

---

## What to Avoid (with reasons)

1. **Shadow-git commit after every tool use (their checkpoint mechanism).** Their own docs warn
   checkpoints "may use significant storage and slow down Cline" on large projects — a full
   snapshot per tool call is O(workspace × actions). Adopt the UX (Pattern 6), not the
   mechanism; snapshot before mutating actions only, and prefer content-addressed deltas in our
   SQLite/blob store. Complexity/perf risk, not license risk.
2. **Model-judged `requires_approval` as the safety gate.** Cline has the LLM flag each command
   as safe/unsafe. That is non-deterministic and prompt-injectable — unacceptable as the primary
   gate for a product whose differentiator is a human-approval layer. Use deterministic policy
   tables (Pattern 5); at most use model judgment as advisory metadata shown in the approval UI.
3. **Permissive defaults (legacy `executeAllCommands: true`, `editFiles: true` out of the box).**
   Incompatible with our positioning. Default every category to `ask`; "full auto" is an explicit,
   warned opt-in.
4. **File-based settings as the coordination medium.** Cline reconciles concurrent editors of a
   JSON settings file with chokidar + fingerprints + lock files — real engineering to solve a
   problem we simply don't have: our sidecar owns SQLite and is the single writer. Keep JSON only
   as an import/export format for MCP configs.
5. **Debounced-disk state with accepted multi-window staleness.** A workaround for VS Code's
   storage model, not a pattern we need; our sidecar can persist synchronously on change events
   in SQLite transactions.
6. **Bun-pinned monorepo toolchain (`bun@1.3.13` exact) and patched dependencies**
   (`ollama-ai-provider-v2`, `@opentui-ui/dialog` patches; heavy security `overrides`). Tooling
   lock-in and supply-chain maintenance we don't want; we target plain Node + npm workspaces in
   the sidecar. No license issue — purely operational risk.
7. **Scope creep features: cron/scheduled agents, Slack/Telegram/Discord connectors, plugin
   marketplace, enterprise remote config, Kanban web board.** Each is a product surface with its
   own auth, storage, and reconciliation machinery (Cline dedicates whole subsystems — `cron/`,
   reconciler/materializer — to them). All out of ACUTE-CODE v1 scope; the underlying seams
   (scheduled task = a session with a trigger; connector = another WS client) are enough to keep
   the door open.
8. **JetBrains plugin as reference.** Explicitly closed source ("we are not open-sourcing
   JetBrains plugins") — do not decompile or imitate-from-artifact; the `hosts/` abstraction
   pattern is the legitimate takeaway.
9. **Brand/trademark adjacency.** Apache-2.0 §6 grants no rights to the "Cline" name. Fine for
   docs (like this one) crediting the project; never in our UI, package names, or marketing.
10. **React-18 webview dependency sprawl** (styled-components + Tailwind v4 + Radix + HeroUI +
    vscode-toolkit simultaneously). Evidence of accretion; pick one styling system for our React
    UI (e.g., Tailwind + a headless component lib) and one markdown pipeline (react-markdown +
    remark-gfm + rehype-highlight + DOMPurify is the proven core worth keeping).

---

## License Note

Cline is **Apache-2.0** (verified in LICENSE). Compatible with ACUTE-CODE's allowed dependency
set; nothing studied here requires copying code, and no GPL-family exposure exists. The only
encumbrance is trademark (name/branding), which we do not use.

## Sources

- https://github.com/cline/cline (README, repo stats, forms, JetBrains note)
- https://github.com/cline/cline/blob/main/LICENSE (Apache-2.0 verification)
- https://github.com/cline/cline/blob/main/package.json (Bun pin, patches, overrides)
- https://github.com/cline/cline/blob/main/sdk/README.md (packages, Agent, createTool, ClineCore, examples incl. Tauri+Bun sidecar)
- https://raw.githubusercontent.com/cline/cline/main/sdk/ARCHITECTURE.md (layering, seams, compaction, agenda, cron)
- https://github.com/cline/cline/blob/main/docs/sdk/architecture/hub-spoke.mdx (hub/spoke/clients, ports, discovery, session storage)
- https://github.com/cline/cline/blob/main/docs/sdk/tools.mdx (toolPolicies, built-in tools)
- https://github.com/cline/cline/blob/main/docs/core-workflows/plan-and-act.mdx (mode constraints, per-mode models)
- https://github.com/cline/cline/blob/main/docs/core-workflows/checkpoints.mdx (shadow git, restore modes)
- https://github.com/cline/cline/blob/main/docs/core-workflows/task-management.mdx (task model)
- https://github.com/cline/cline/blob/main/docs/features/auto-approve.mdx (raw; categories, requires_approval, YOLO)
- https://github.com/cline/cline/blob/main/docs/features/subagents.mdx (read-only subagents, flat hierarchy)
- https://github.com/cline/cline/blob/main/docs/cline-overview.mdx (forms on shared core, ACP)
- https://github.com/cline/cline/blob/main/apps/vscode/src/core/controller/grpc-handler.ts (protobus)
- https://github.com/cline/cline/blob/main/apps/vscode/src/core/storage/StateManager.ts (state model, precedence)
- https://github.com/cline/cline/blob/main/apps/vscode/src/services/mcp/McpHub.ts (MCP config/transports/refresh)
- https://github.com/cline/cline/blob/main/apps/vscode/src/shared/AutoApprovalSettings.ts (settings shape, defaults)
- https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/package.json (React stack)
- https://api.github.com/repos/cline/cline/contents/... (tree verification: apps, apps/vscode/src and subpaths, sdk, sdk/packages and subpaths, docs subfolders)
