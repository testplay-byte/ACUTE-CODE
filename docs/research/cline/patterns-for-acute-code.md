<!-- last-reviewed: 2026-08-24 round-33 -->
# Cline — Patterns for ACUTE-CODE

All claims verified against `github.com/cline/cline` `main` on 2026-08-21 (Apache-2.0; pattern study only — no code copying, none needed for any pattern below).

Stack shorthand: **Tauri 2 shell (Rust) + React 18/TS UI + Node/TS sidecar owning SQLite via localhost REST+WS + cloud LLM APIs + human-approval safety layer + max 5 concurrent agents.**

---

## Pattern 1 — Layered engine packages with one-way dependencies

**WHAT (in Cline).** `sdk/ARCHITECTURE.md` defines a strict stack: `@cline/shared` (types/schemas/hooks, no upward deps) → `@cline/llms` (provider gateway + model catalogs; all provider-specific behavior isolated here) → `@cline/agents` (stateless loop: "should not own persistent storage or host lifecycle concerns") → `@cline/core` (stateful orchestration: sessions, storage, plugins, hub) → host apps. Explicit constraints: "Keep `agents` Stateless", "Keep `core` Generic", "Use One-Way Optional Layers". The published umbrella `@cline/sdk` re-exports core.

**WHY it fits ACUTE-CODE.** Our sidecar will have the same tensions: agent loop vs persistence vs provider adapters vs host transport. Cline's layering is proven at scale (VS Code + CLI + Tauri example on one engine) and directly testable per layer.

**HOW it maps onto our stack.** Sidecar internal packages mirroring the same rule: `shared` (Zod schemas + WS/REST contract types, used by both React UI and sidecar), `providers` (LLM adapters + model catalog), `agent-loop` (pure TS: prompt assembly, tool-call iteration, event emission — no SQLite, no HTTP server), `core` (SQLite sessions, tool registry, approvals, MCP manager, WS server). Enforce with dependency-cruiser or ESLint import rules in CI. React UI depends only on `shared` types.

---

## Pattern 2 — Plan/Act as a tool-gated mode switch (`switch_to_act_mode`)

**WHAT (in Cline).** `apps/cli/src/runtime/interactive/mode.ts`: `InteractiveUiMode = "plan" | "act"`. A tool `switch_to_act_mode` exists **only in plan mode**, with a description demanding explicit user approval in a *later* message ("never call it in the same turn you present a plan… never treat the original task request as approval"). The tool has `lifecycle: { completesRun: true }` — the run ends immediately so the model never keeps plan-mode tools it was told it lost; the session is then rebuilt with act-mode tools. A `PendingModeChange { current, source: "tool" | "ui" }` distinguishes model-initiated switches from UI toggles; only `source: "tool"` triggers auto-execution via a canned continuation prompt ("The user approved switching to act mode. Continue with the approved plan now."). A UI toggle racing a turn completion can never start executing an unapproved plan.

**WHY it fits ACUTE-CODE.** We need Plan/Act separation with a hard approval gate. Cline's design makes the *model* request the transition, makes the *user* the approver, and makes the *toolset* mode-scoped — three properties that fit our human-approval safety layer exactly.

**HOW it maps onto our stack.** In the sidecar `agent-loop`, define two toolsets: plan (read-only: read files, search, list, ask) and act (edit, write, run command). Register a `switch_to_act_mode` tool in the plan toolset that ends the run; the UI renders the presented plan with Approve/Edit buttons; on approval the sidecar rebuilds the session with the act toolset and injects a synthetic continuation user message. Track `source: "tool" | "ui"` on mode changes so a UI toggle never auto-executes. Persist mode per session in SQLite.

---

## Pattern 3 — Minimal approval vocabulary + per-tool auto-approve policies, fail-closed

**WHAT (in Cline).** Two layers. (1) UI vocabulary: `ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"` (`WebviewMessage.ts`) — every approval UI reduces to yes / no / free text. (2) Policy layer: `ToolApprovalRequest { toolCallId, toolName, input, iteration, agentId, conversationId }` → `ToolApprovalResult { approved, reason? }`; a per-tool `autoApprove` policy map plus a master switch (`approvals.ts`: no approver wired → `return { approved: false }`, i.e. fail-closed). `AutoApprovalSettings` carries a `version` field incremented on every change to defeat stale-setting races. The hub's agenda tasks bind approval to an exact task `revision` (`approvedRevision`) so an edit revokes stale approval.

**WHY it fits ACUTE-CODE.** Our safety layer needs exactly this: a tiny, auditable response vocabulary; tool-level policy; race-proof versioning; fail-closed defaults.

**HOW it maps onto our stack.** Sidecar `core` exposes `POST /approvals/:toolCallId` (body: `{ decision: "yes" | "no" | "message", text? }`) and pushes approval requests over WS (`approval.requested { toolCallId, toolName, input, session }`). SQLite table `tool_policies(tool_name, auto_approve, version)` + global default **deny**; increment `version` on every mutation and reject decisions carrying a stale version. Note the contrast: Cline's shipped defaults auto-approve edits and all commands (`editFiles: true`, `executeAllCommands: true`) — we adopt the *structure* and invert the *defaults*.

---

## Pattern 4 — MCP hub: one watched settings file, fingerprinted reconciliation, per-tool auto-approve

**WHAT (in Cline).** `services/mcp/McpHub.ts`: a single hub process manages all MCP connections via the official `@modelcontextprotocol/sdk` with stdio / SSE / StreamableHTTP transports, an OAuth manager, per-server timeout bounds (`MIN/MAX_MCP_TIMEOUT_SECONDS`), and per-tool auto-approve toggles (`controller/mcp/toggleToolAutoApprove.ts`). Config lives in one JSON file (`cline_mcp_settings.json`, zod-validated via `schemas.ts`, written under a settings lock). A chokidar watcher reconciles external edits, but computes a **content fingerprint of connection-relevant state** before acting — unchanged writes (e.g. OAuth token churn) are no-ops, preventing watcher → reconnect → write loops; writes from other processes (CLI, another window) that do change state are honored. `list_changed` notifications are debounced (300 ms, capped 2 s) with bounded-retry refresh.

**WHY it fits ACUTE-CODE.** MCP is in our scope; Cline's hub solves the real operational problems — multi-process config sharing, watcher loops, timeout defaults, and per-tool approval — that a naive implementation hits in week two.

**HOW it maps onto our stack.** Sidecar `core/mcp` module: SQLite as our source of truth, materialized to a watched `mcp.json` (compatible with the common `mcpServers` format) so external tools can read it; chokidar watcher with a connection-fingerprint check before any reconnect; env-var expansion in server configs; per-server timeout clamps; per-tool auto-approve flags surfaced in the React settings UI alongside our approval defaults (default: off).

---

## Pattern 5 — Provider config: typed provider IDs + capability/pricing model catalog, isolated in one package

**WHAT (in Cline).** `shared/api.ts`: `ApiProvider` is a ~50-value string union (anthropic, openrouter (default), openai, gemini, bedrock, vertex, ollama, lmstudio, xai, groq, …); `ApiConfiguration` is a flat options object. `ModelInfo` carries `contextWindow`, `maxTokens`, `supportsImages`, `supportsReasoning`, `supportsPromptCache`, tiered `inputPrice/outputPrice/cacheReadsPrice`, thinking budgets, plus an explicit `capabilities` list and `modalities`/`operation` fields preserved from the SDK catalog — with the rule that absent capabilities mean "unknown" and capability checks "fail open" only deliberately. All provider-specific execution lives in `@cline/llms` (`providers/`, `catalog/`), never in core or hosts; catalogs are refreshable per provider (`controller/models/refresh*`).

**WHY it fits ACUTE-CODE.** We will support multiple cloud providers from day one. Cline's model — typed IDs, one flat config object, one catalog shape, provider code quarantined in one package — avoids the scatter that kills maintainability.

**HOW it maps onto our stack.** SQLite `providers` table (id, type, api key ref, base URL) + `model_catalog` cache table (context window, prices, capabilities, refreshed per provider on demand). Sidecar `providers` package: one adapter per provider family behind a common streaming interface (tool-call deltas + usage events); React settings UI renders the catalog (capabilities badges, cost estimates). Unknown capability ⇒ conservative behavior (no image input, no parallel tool calls).

---

## Pattern 6 — Tauri + Bun sidecar reference implementation (per-launch token, origin allowlist, WS-pushed approvals)

**WHAT (in Cline).** `apps/examples/desktop-app`: "Tauri desktop shell + Bun sidecar backend + Next.js UI". `sidecar/server.ts` starts `Bun.serve` with HTTP handlers plus a WebSocket upgrade at `/transport`; it returns `{ port, approvalToken }` with a per-launch random token compared via `timingSafeEqual`; origins are allowlisted (with an env override for dev servers). Tool approvals are in-memory on the owning connection: `poll_tool_approvals` / `respond_tool_approval` commands verify the approval belongs to *this connection and session* before accepting, and state changes are pushed as `tool_approval_state` events. The sidecar also resolves the user's login-shell `PATH` at startup (`sidecar/shell-path.ts`) so agent-spawned children and MCP servers find user-installed tools when launched from a GUI — deliberately importing only `PATH`.

**WHY it fits ACUTE-CODE.** This *is* our topology, shipped by the vendor as the canonical way to embed the engine in a desktop app. It validates Tauri-shell + sidecar + localhost WS, and it demonstrates the security and UX details (token auth, origin checks, approval ownership scoping, GUI PATH resolution) we would otherwise discover the hard way.

**HOW it maps onto our stack.** Adopt directly: sidecar binds loopback with an OS-assigned port + per-launch token (passed to Tauri via stdout/env at spawn); `timingSafeEqual` on every request; WS for events (approval requests, streaming deltas) and REST for commands; approval decisions validated against owning connection + session id. On Windows/macOS GUI launches, resolve a sane `PATH` for child processes (Git-Bash/user profile merge), importing only `PATH`.

---

## Pattern 7 — Schema-first UI transport with request correlation, streaming sequences, cancellation

**WHAT (in Cline).** The webview↔host channel wraps gRPC semantics over `postMessage` (`grpc-handler.ts`): unary and streaming requests, `request_id` correlation, `sequence_number` on streamed chunks, `GrpcRequestRegistry` for cancellation, and record/replay middleware for debugging. Services are declared in protobuf (`proto/cline/*.proto`, e.g. `TaskService`: `newTask`, `askResponse`, `getTaskHistory`, `deleteTasksWithIds`), with codegen'd handler maps per host — the contract is data, not convention.

**WHY it fits ACUTE-CODE.** Our React↔sidecar channel (REST+WS) needs the same properties: correlation, ordered streams, cancellation, and an evolvable contract. The *semantics* are the win; the gRPC *toolchain* is not (see Avoid).

**HOW it maps onto our stack.** Define one Zod schema module shared by UI and sidecar: `Command` (request) and `Event` (push) unions, every command carrying `requestId`, every event carrying `sessionId` + optional `requestId`, streamed chunks carrying monotonically increasing `seq`. Support `cancel(requestId)`. Keep a ring-buffer recorder of command/response pairs for bug reports (opt-in, local-only). Serve commands over REST (unary) and events over WS — no protobuf toolchain.

---

## Pattern 8 — Git-native checkpoints with private refs and restore transactions

**WHAT (in Cline).** `sdk/packages/core/src/hooks/checkpoint-hooks.ts` + `session/checkpoint-restore.ts`: checkpoints are snapshot commits built with git plumbing — `commit-tree` (including commits that contain *only* untracked files via a temp index) shaped like stash commits, stored under a **private ref namespace** invisible to the user's stash/branch list. Restore is transactional: before any destructive restore, `beginWorktreeRestoreTransaction` captures the *current* worktree (`stash push --include-untracked`, moved behind a private ref, dropped from the visible stash), exposing `commit()` / `rollback()`; then restore runs (with `git clean -fd`). Restore granularity: task-only, workspace-only, or both (`ClineCheckpointRestore = "task" | "workspace" | "taskAndWorkspace"`).

**WHY it fits ACUTE-CODE.** "Undo the agent's work" is core to trust in a multi-agent workbench. Cline shows checkpoints need not be a custom VCS — git plumbing plus disciplined ref hygiene suffices, and the capture-before-restore transaction means a bad restore is itself recoverable.

**HOW it maps onto our stack.** Sidecar tool layer takes a checkpoint after each *approved* mutating tool batch (not every tool call — see Avoid): `commit-tree` snapshot under `refs/acute-checkpoints/<sessionId>/<n>`; checkpoint metadata (message, tool call, timestamps) in SQLite; restore UI offers workspace / session scope and always snapshots current state first (commit/rollback transaction). For non-git folders, degrade to a documented "no checkpoints" state rather than a shadow repo.

---

## Pattern 9 — Canonical transcript + separately-stored compaction state

**WHAT (in Cline).** Compaction design (ARCHITECTURE.md §9): the canonical session history stays append-only at full fidelity; the compacted working context is persisted separately as `${sessionId}.compaction.json`; on resume the compacted state is only reused after validating a **hash of the canonical prefix** it covers, then later canonical messages are appended after the compaction boundary. The stateless loop only exposes a "project message history before the provider call" seam; policy lives in core.

**WHY it fits ACUTE-CODE.** Long agent sessions in a 5-concurrent-agent workbench will exceed context windows; we need compaction that never destroys the audit trail and never desyncs from it.

**HOW it maps onto our stack.** SQLite `messages` table = canonical, append-only, never rewritten. `compactions(session_id, prefix_hash, summary, created_at)`; the agent-loop accepts a `projectHistory(messages)` hook before provider calls; on resume, recompute the prefix hash and fall back to full history on mismatch. Compaction is invisible to the UI transcript (renders canonical history).

---

## Pattern 10 — Lazy session persistence

**WHAT (in Cline).** "Root-session persistence is lazy. Starting a runtime allocates its session ID… but does not create a database row, manifest, or messages artifact. The first accepted user turn persists that same ID… Closing a runtime before a user turn therefore leaves no empty history entry."

**WHY it fits ACUTE-CODE.** Multi-agent UIs generate many aborted/empty sessions (open agent, close it, retry). Not persisting them keeps task history and storage clean without delete-on-cancel logic.

**HOW it maps onto our stack.** Sidecar allocates a ULID session id in memory; the first *approved/sent* user prompt triggers the SQLite insert (sessions + first messages row in one transaction). UI "recent sessions" lists only persisted sessions.

---

## What to Avoid (with reasons)

| Avoid | Reason |
|---|---|
| **The hub-daemon subsystem** (detached WebSocket daemon, discovery records, build fingerprints, daemon retirement/upgrade races, multi-client attach/detach, proceed-while-running process tracking) | Complexity budget: it exists to share one engine across *multiple concurrent client apps*. ACUTE-CODE has exactly one UI per sidecar and max 5 agents; a single sidecar process with an internal agent pool achieves the same isolation. Adopt only the localhost auth-token discipline (Pattern 6). |
| **gRPC/protobuf toolchain in the UI transport** (buf, protoc-gen, `@grpc/grpc-js`, per-host codegen'd handler maps) | Heavy build chain and awkward in a Tauri webview; typed Zod schemas over REST+WS give the same contract guarantees (correlation, streaming, cancellation) at a fraction of the tooling. Cline needs proto for its closed-source JetBrains client; we control both ends. |
| **Cline's auto-approve defaults** (`editFiles: true`, `executeAllCommands: true`, MCP `useMcp: true`) | Direct conflict with ACUTE-CODE's human-approval-first safety layer; also their legacy fields show the migration cost of once-permissive settings. Adopt the policy structure, default everything to ask. |
| **File-polling approval IPC** (`tool-approval.ts`: write `*.request.json`, poll for `*.decision.json` every 200 ms) | Polling hack for hosts without a channel; our sidecar owns a WS connection — push approvals (their own desktop example already does this). Stale decision files and cleanup windows are avoidable failure modes. |
| **Checkpoint after *every* tool use** | Volume: snapshot commits per tool call multiply git object churn and disk usage on large repos; their own multi-hour engineering of detached-log/reconciliation machinery shows the cost. Checkpoint per approved mutating batch is enough for our trust model. |
| **Cron/agenda/marketplace/remote-config/connectors subsystems** | Scope mismatch: scheduled agents, an MCP marketplace, enterprise remote config (materializing managed rules/skills), and Slack/Telegram connectors are v2+ product surfaces; the cron layer alone is a 9-component subsystem. Keeping v1 small is the lesson, not the code. |
| **Baked-in telemetry stack** (PostHog keys in build constants, OTEL env plumbing through every layer) | Wrong default for a closed-source, local-first product; if we add telemetry it must be explicit opt-in and cleanly removable — not woven through `BUILD_CONSTANTS`. |
| **Depending on `@cline/sdk` as our engine** | License-**compatible** (Apache-2.0, in our allow-list), so this is strategy not law: v0.0.x churn, Cline-brand auth/telemetry defaults baked into core, and our requirement to own the approval model and closed-source distribution make an engine dependency a poor trade. Pattern adoption costs less. |
| **Copying their model-catalog data wholesale** | Apache-2.0 permits it with notice retention, but pricing/capability data goes stale monthly and errors there produce real billing/capability bugs. Maintaining a small verified catalog for our supported providers is cheaper than trusting a large borrowed one. |
| **Multi-instance in-memory state without re-sync** (StateManager caches reads at init; other windows only see changes after restart) | Known Cline caveat. Our sidecar is a single owner of SQLite — keep it that way (single-writer), and design settings mutation to go through the sidecar only, so the UI can never desync from the DB. |

---

## Sources

- https://github.com/cline/cline (README; product index; monorepo layout)
- https://github.com/cline/cline/blob/main/LICENSE (Apache-2.0 verification) and `sdk/packages/*/package.json`, `apps/vscode/package.json` (license fields; `@cline/sdk` v0.0.77)
- https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md (layering rules, RuntimeHost/hub, design seams incl. compaction §9, agenda approval-by-revision, lazy persistence, plugin sandbox)
- Raw `apps/cli/src/runtime/interactive/mode.ts` (Plan/Act switch tool), `approvals.ts` (policy controller)
- Raw `apps/vscode/src/shared/WebviewMessage.ts` (ask vocabulary), `shared/AutoApprovalSettings.ts` (defaults, version field), `shared/api.ts` (ApiProvider union, ModelInfo)
- Raw `apps/vscode/src/services/mcp/McpHub.ts` (transports, fingerprint reconcile, watcher debounce) + `controller/mcp/` handlers (toggleToolAutoApprove, updateMcpTimeout)
- Raw `apps/vscode/src/core/controller/grpc-handler.ts` (protobus semantics); `proto/cline/task.proto`, `proto/cline/common.proto`
- Raw `sdk/packages/core/src/runtime/tools/tool-approval.ts` (file-based approval IPC — avoid case), `session/checkpoint-restore.ts`, `hooks/checkpoint-hooks.ts` (git checkpoint mechanics)
- Raw `apps/examples/desktop-app/README.md`, `sidecar/server.ts`, `sidecar/commands.ts` (Tauri + Bun sidecar, approvalToken, WS approvals, login-shell PATH)
- https://docs.cline.bot/cline-sdk/overview (package table, Agent embedding, Node 22+)
