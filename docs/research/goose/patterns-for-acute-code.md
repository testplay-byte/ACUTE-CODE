<!-- last-reviewed: 2026-08-25 round-35 -->
# Goose — Patterns for ACUTE-CODE

Pattern study only — Apache-2.0 permits dependency use, but ACUTE-CODE policy is to reimplement patterns in our own Node/TS + Tauri code, never to copy code. Each pattern: WHAT goose does (verified), WHY it fits us, HOW it maps to Tauri + Node sidecar + SQLite + React.

---

## Pattern 1 — Sidecar-as-child-process with readiness handshake, secret auth, and lease teardown

**WHAT (verified: `ui/desktop/src/gooseServe.ts`, `gooseServeLeaseRegistry.ts`, `guides/remote-goose-server.md`)**
The desktop UI process owns the agent-runtime lifecycle end to end:
- spawn `goose serve --platform desktop --host 127.0.0.1 --port <ephemeral>` (UI picks a free port by `listen(0)` then releases it);
- pass auth secret via env (`GOOSE_SERVER__SECRET_KEY`), not argv (argv leaks in process lists);
- readiness = poll `/status` every 100ms, 30s deadline, per-request 1s abort, early-exit on child death or fatal stderr patterns;
- each OS window attaches to a **lease**; last window detaching tears the backend down (idempotent cleanup, SIGTERM → 5s → SIGKILL, `taskkill /pid <pid> /f /t` on Windows);
- backend death marks the lease dead; later lookups throw a user-actionable message ("open a new chat") rather than returning a dead URL;
- a startup-diagnostics trace file records every lifecycle event for bug reports.

**WHY it fits ACUTE-CODE**
This is exactly our Tauri shell ↔ Node sidecar relationship, solved with production-hardened details we would otherwise rediscover the hard way: free-port handoff, env-borne secrets, bounded health polling, stderr fatality detection, Windows-specific kill escalation, refcounted ownership, and never trusting a dead handle.

**HOW to map onto our stack**
- Tauri main process (Rust) runs the Node sidecar (`sidecar.spawn()` / tauri-plugin-shell): UI-independent, survives window close per lease rules.
- Sidecar exposes `/status` (+ our REST base) on 127.0.0.1 with an ephemeral port; Tauri picks the port and passes it plus a generated secret via env (`ACUTE_SIDECAR_PORT`, `ACUTE_SIDECAR_SECRET`); sidecar rejects requests lacking the secret header.
- Readiness gate in Tauri: 100–250ms poll of `/status`, ~30s budget, abort on child exit / fatal stderr regexes.
- Lease registry: one backend lease per "workspace window"; refcount window IDs; teardown = SIGTERM (Windows: `taskkill /f /t`) → 5s → SIGKILL; mark lease dead on `exit` event; surface "backend stopped" state in React instead of retrying silently.
- Emit a lifecycle event log (spawn_start, healthcheck_success, child_exit…) to a diagnostics file under our app-data dir and reference the path in error toasts.

---

## Pattern 2 — Layered permission model: global modes × per-tool tri-state × argument-hashed remembered decisions

**WHAT (verified: `guides/managing-tools/goose-permissions.md`, `tool-permissions.md`, `crates/goose/src/permission/permission_store.rs`, `agents/tool_confirmation_router.rs`)**
Three orthogonal layers:
1. Session-level modes: `auto` (no approval), `approve` (confirm every tool), `smart_approve` (risk-based), `chat` (no tools) — switchable mid-session.
2. Per-tool overrides within an extension: Always Allow / Ask Before / Never Allow — "the mode sets the default behavior, while tool permissions let you override specific tools."
3. Remembered decisions: persisted as atomic JSON; key = `tool_name:blake3(JSON(args))` with `allowed`, timestamp, optional expiry; most recent non-expired record wins; expired entries pruned on load.
Approval prompting is decoupled via a `request_id → oneshot` router: the tool-exec path parks awaiting a verdict, the UI delivers `AllowOnce|DenyOnce`; stale/cancelled waiters are pruned lazily; out-of-order deliveries are safe because lookups are keyed.

**WHY it fits ACUTE-CODE**
Our human-approval safety layer needs precisely this expressiveness without inventing semantics: a default-deny-ish mode system, per-tool policy for the "safe read tools vs. write tools" distinction, and a way to honor "yes, and don't ask again *for this exact command*" — the argument hash makes remembered grants narrow (approving `npm test` does not approve `rm -rf`), while expiry keeps them from rotting.

**HOW to map onto our stack**
- Sidecar owns enforcement (never the UI): before executing any tool, resolve `perToolPolicy ?? sessionMode default`; if approval needed, create `requestId`, persist a pending row in SQLite, emit over WS to React, and `await` a promise stored in an in-memory `Map<requestId, {resolve}>` (our equivalent of the oneshot router); UI posts the decision to a REST endpoint that resolves it. Add a router-level timeout (goose has none — see "avoid").
- Remembered grants table in SQLite: `(tool_name, args_hash, allowed, created_at, expires_at)`; hash with Node crypto (`blake3` via npm, or SHA-256 — collision strength is irrelevant here, determinism is). Default expiry (e.g. 7d) on "allow always for this command".
- Modes: our default must be `approve`-equivalent (human-approval-first), with `chat`-equivalent and a scoped `smart`-equivalent as opt-ins; per-tool tri-state in a settings table seeded with read-only tools = Always Allow.
- Never store raw args in the grant row; goose keeps an optional `readable_context` for UI display — store it encrypted or truncated at most.

---

## Pattern 3 — MCP-first extension registry: declarative config, typed transports, per-extension timeout, instructions-as-prompt-fragments, approval for dynamic enable

**WHAT (verified: `crates/goose/src/agents/extension.rs`, `getting-started/using-extensions.md`)**
Every capability is an extension = an MCP server, declared in typed YAML (`type: stdio | streamable_http | builtin | platform | frontend | inline_python`), each entry carrying name/cmd/args/envs/`enabled`/`timeout` (seconds goose waits per tool call). Extensions contribute not only tools but **prompt instructions** (`ExtensionInfo { name, instructions }`), which the prompt builder merges into the system prompt. Extensions can be added mid-session (slash command, flags, deeplinks) but dynamic enable prompts the user ("do you approve?" — session-scoped). OAuth-bearing remote extensions store `client_secret_key` — a *reference into the secret store*, never the raw secret. Dead transports are retained only as compatibility shims. Docs recommend <25 enabled tools total.

**WHY it fits ACUTE-CODE**
We are MCP-first too. Goose validates the config shape we need: one declarative registry users can hand-edit, one process manager for stdio servers, one HTTP client for remote servers, per-tool timeouts isolated per extension, and the crucial insight that extensions ship *prompt instructions* alongside tools — so the system prompt composes itself from the enabled set. The "dynamic enable requires approval" rule also matches our safety layer for anything the agent tries to self-install.

**HOW to map onto our stack**
- `mcp_servers` table (or JSON column) in SQLite mirroring goose's fields: `key, name, transport {stdio: {cmd,args,envs,cwd} | http: {url,headers}}, enabled, timeout_s, oauth?` — plus a `secrets` table so config stores only secret *keys* (goose: keys in config.yaml are ignored; keychain or secrets.yaml only).
- Sidecar owns all MCP client connections via the official `@modelcontextprotocol/sdk` (MIT) — spawn stdio servers as child processes with per-tool-call timeout, streamable-HTTP for remotes.
- Store per-extension `instructions` text; sidecar assembles the system prompt from enabled extensions' instructions + tool schemas; cap default-enabled set small (<25 tools guidance).
- Any `enable`/`disable` request originating from the agent (not the user clicking Settings) routes through Pattern 2's approval flow and is session-scoped by default.
- Ship our built-in tools (fs read, grep, apply-patch…) as an in-process "builtin" extension with the same registry shape, so permission and prompt logic treat all tools uniformly (goose's `Builtin` variant).
- Do NOT replicate `Frontend`-variant tools (tools executed by the UI process) for anything the sidecar must be able to run headless — keep tools sidecar-owned; a UI-tool variant couples capability to window lifetime. [Design decision]

---

## Pattern 4 — SQLite session ledger with monotonic ordering, usage accounting, and fork-by-copy

**WHAT (verified: `crates/goose/src/session/session_manager.rs`, `guides/sessions/session-management.md`)**
Single SQLite DB (WAL, 30s busy timeout) shared by CLI and desktop: `sessions` (metadata, model config JSON, mode, parent id), `messages` (role, content JSON, monotonic-clamped `created_timestamp`, message_id), `usage_ledger` (per-request tokens/cost with provenance: provider_reported | estimated | carried_forward; compaction flag), `schema_version` = 16 with migrations. Resume = replay; fork/duplicate = new session row + delete-and-reinsert messages with fresh IDs. Export JSON/Markdown; import creates new IDs. IDs are human-friendly (`YYYYMMDD_N`).

**WHY it fits ACUTE-CODE**
We already chose SQLite in the sidecar; goose shows the *minimal sufficient* schema for durable agent sessions plus two things we'd have missed: (a) timestamp clamping so late writes can never reorder history, and (b) a token/cost ledger with explicit provenance instead of trusting provider-reported totals — the reconciliation row ("carried_forward") is exactly how to keep cost display honest across resumes.

**HOW to map onto our stack**
- Tables: `sessions(id, title, parent_session_id, agent_id, mode, model_config_json, created_at)`, `messages(id, session_id, role, content_json, created_at, metadata_json)` with insert-time clamp `created_at = max(incoming, latest_in_session)`, `usage_ledger(session_id, message_id, prompt_tokens, completion_tokens, cost_usd, cost_source, is_compaction)`, `schema_version`.
- Resume: sidecar loads session, replays messages into provider context, agent continues; fork = copy row + messages (new UUIDs) — cheap and safe under WAL.
- Store everything as JSON payloads keyed by role — provider-agnostic, trivially exportable; add Markdown export for users.
- One DB for all surfaces (if we ever add a CLI, it shares the sidecar's DB).

---

## Pattern 5 — Malicious-package gate before executing package runners (adopt the check, invert the failure mode)

**WHAT (verified: `crates/goose/src/agents/extension_malware_check.rs`)**
Before a command that installs/executes packages (`npx`, `uvx`), goose parses the package name out of argv (npm scoped/versioned forms; PyPI PEP-503 normalization, extras, `--from` handling), queries OSV (`api.osv.dev/v1/query`, 10s timeout) for `MAL-*` advisories, and blocks on a confirmed malicious match. Infrastructure errors (network, HTTP, parse) **fail open** — the check is skipped.

**WHY it fits ACUTE-CODE**
Our agents will routinely run `npx`/`uvx`-style commands; typosquatting is the top supply-chain risk for an agentic tool. OSV is a free, keyless, well-defined API — cheap to integrate and easy to test (goose mocks it with wiremock; we can mock with nock/msw).

**HOW to map onto our stack**
- Sidecar-side pre-exec interceptor in the shell tool: detect `npx`/`uvx`/`pnpm dlx`/`pipx run`, extract package name (Node implementation; normalize per ecosystem), query `https://api.osv.dev/v1/query` (MIT-licensed API; endpoint overridable via env for tests), block on any `MAL-*` advisory with a user-visible reason.
- **Diverge on failure**: on network/parse error do NOT fail open silently — downgrade to "ask the user" (route through the approval flow with a warning) so availability is preserved without silently skipping a safety check. Cache negative results briefly.

---

## Pattern 6 — Structured final output via a dedicated output tool

**WHAT (verified: `crates/goose/src/agents/subagent_handler.rs`, `final_output_tool.rs` presence)**
When a (sub)task declares a response schema, goose appends a dedicated final-output tool; the agent's last required action is to call it with schema-conformant JSON, which the harness captures as the task result — rather than parsing prose out of the transcript. Subagents get budgets (`max_turns`) and their tool events are forwarded to the parent as typed MCP log notifications (`subagent_tool_request` + subagent id).

**WHY it fits ACUTE-CODE**
Orchestrator → researcher sub-agents need machine-readable returns. "Make the final answer a tool call the runtime validates" is more reliable than prompt-regex extraction and gives us a single interception point for schema validation.

**HOW to map onto our stack**
- Every sub-agent task in the sidecar declares an optional JSON schema (Zod in our case); inject an `acute_final_output` tool available only to that task; sidecar validates the call against the Zod schema, resolves the task promise, and cancels further turns.
- Forward sub-agent tool activity to the UI over WS as typed events with the agent id — the React timeline can render nested activity. Enforce our max-5 concurrent agents with a semaphore in the sidecar (goose has no cap — see below).

---

## What to avoid (with reasons)

1. **Autonomous-by-default** — goose's default mode modifies files and runs commands with no approval. ACUTE-CODE's contract is human-approval-first; our default mode must be "approve", and "auto" must be an explicit, per-session opt-in with visible state. (Reason: safety posture is a product requirement, not a setting.)
2. **Fail-open safety checks** — goose's OSV gate skips the check when the network fails. For us that inverts the safety layer under exactly the conditions (flaky network) where users are least attentive. Fail to a mandatory user prompt instead. (Reason: "availability over safety" is the wrong default for an approval-centric product.)
3. **No router-level approval timeout / no subagent concurrency cap** — goose's `ToolConfirmationRouter` waits forever (callers must remember to wrap timeouts), and `subagent_handler.rs` has no concurrency limit (only `max_turns` in a prompt template). We need bounded waits (auto-deny or re-prompt after N minutes) and a hard semaphore for max 5 agents in the sidecar, not in prompts. (Reason: unbounded waits leak resources; prompt-borne limits are unenforceable.)
4. **Config/storage sprawl** — goose persists state across `config.yaml`, `secrets.yaml`, `permissions/tool_permissions.json`, `sessions.db`, legacy `.jsonl`, `custom_providers/*.json`. We own a database from day one: put sessions, permissions, grants, MCP registry, and usage in SQLite; keep exactly one secrets mechanism (OS keyring via Tauri, encrypted fallback). (Reason: fewer formats = fewer migration and consistency bugs; atomicity for free.)
5. **Raw API keys in config files** — goose ignores keys in `config.yaml` (keychain only) — good — but the YAML format *shows* an envs map with a token placeholder that users will fill in. Our config should accept only secret-store references. (Reason: `config.yaml` gets committed to dotfile repos.)
6. **Dead transports kept for compatibility** — `Sse` variant exists only so old configs parse, tools permanently unavailable. On a greenfield project, migrate config at load time instead of carrying zombie variants. (Reason: dead code paths in a security-sensitive dispatcher are risk surface.)
7. **Frontend-provided tools** — goose's `Frontend` extension variant makes the UI process a tool host. Coupling tool availability to UI lifetime breaks headless/scheduled runs and complicates permission enforcement. Keep all tool execution in the sidecar. (Reason: our sidecar must own the loop even with zero windows open.)
8. **Tool-count bloat** — goose's own docs recommend <25 enabled tools ("tool decision paralysis", context cost). Don't auto-enable every MCP server we bundle; ship a small default set and make enabling explicit. (Reason: measurable quality regression the upstream project itself warns about.)

---

## Sources

- https://github.com/block/goose
- https://raw.githubusercontent.com/block/goose/main/README.md
- https://raw.githubusercontent.com/block/goose/main/LICENSE
- https://raw.githubusercontent.com/block/goose/main/Cargo.toml
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/package.json
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/src/gooseServe.ts
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/src/gooseServeLeaseRegistry.ts
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/agents/extension.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/agents/extension_malware_check.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/agents/tool_confirmation_router.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/agents/subagent_handler.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/session/session_manager.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/permission/mod.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/permission/permission_store.rs
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/goose-architecture/goose-architecture.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/getting-started/using-extensions.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/getting-started/providers.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/remote-goose-server.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/sessions/session-management.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/managing-tools/goose-permissions.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/managing-tools/tool-permissions.md
- https://api.github.com/repos/block/goose/contents/ (and subpaths: crates, crates/goose/src, crates/goose/src/{session,permission,agents,gateway,bin}, crates/goose-mcp/src, crates/goose-cli/src/commands, crates/goose-providers/src, documentation/docs/*, ui, ui/desktop/src)
