<!-- last-reviewed: 2026-08-24 round-33 -->
# ACUTE-CODE — System Architecture

| | |
|---|---|
| **Status** | ACCEPTED — Phase 1 deliverable, owner-approved · module map reconciled with Phase 2 reality (2026-08-22) |
| **Date** | 2026-08-21 |
| **Inputs** | `docs/specs/SPEC.md` (product truth) · `docs/research/*` (nine verified reference analyses) · ADRs 0001–0005 |
| **Companion docs** | `docs/architecture/api/API.md` (REST + WS contracts) · ADRs 0006–0011 |

**Citation legend:** `(SPEC §X)` = SPEC section · `(goose)`, `(opencode)`, `(openhands)`, `(hermes)`, `(metagpt)`, `(kilocode)`, `(aider)`, `(cline)`, `(letta)` = research memos under `docs/research/<name>/` · `(synthesis §N)` = cross-cutting finding in `docs/research/README.md`.

---

## 1. System overview

ACUTE-CODE is two cooperating local processes plus storage: a **Tauri 2 (Rust) shell** that owns the window, lifecycle, and OS credentials, and a **Node/TypeScript agent-core sidecar** that exclusively owns SQLite, the agent runtime, providers, tools, approvals, and the localhost REST + WebSocket API. The React 18 frontend running in WebView2 is a pure API client of the sidecar. Model inference comes only from cloud LLM APIs the user configures (SPEC §1, §3).

This split is the field's convergence point — five independent reference projects arrived at "UI client ↔ local agent server over HTTP/WS with SQLite" (synthesis §1): Cline (hub-spoke daemon), OpenCode (TS server, thin clients), Kilo (`kilo serve`), Goose (desktop spawns a daemon on an ephemeral localhost port), OpenHands (headless Agent Server). We adopt it with Goose's spawn/lease mechanics and OpenCode's permission round-trip as concrete patterns, adapted to Tauri.

```
┌──────────────────────────────────────────────────────┐
│              Tauri 2 shell (Rust, win64)             │
│                                                     │
│  ┌───────────────────┐   ┌────────────────────────┐  │
│  │  WebView2 window  │   │  Sidecar supervisor     │  │
│  │  React 18 + TS    │   │  spawn · health · stop  │  │
│  │  (src/)           │   │  mints bearer token     │  │
│  └─────────┬─────────┘   └───────────┬────────────┘  │
│            │ Tauri invoke            │ spawn: env    │
│            │ sidecar_endpoint(),     │ ACUTE_TOKEN,  │
│            │ store_provider_key()    │ stdout ready- │
│            ▼                          │ line handshake│
│  credentials: Windows Credential     │               │
│  Manager via DPAPI (keyring crate)   │               │
└────────────┼─────────────────────────┼───────────────┘
             │ REST + WebSocket        │
             │ http(s)://127.0.0.1:<ephemeral>
             │ Authorization: Bearer <token>
             ▼                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                 agent-core sidecar (Node 24 / TS)                │
│                                                                 │
│  server/      Fastify REST + /ws gateway, auth, error envelope  │
│  providers/   Vercel AI SDK adapters · telemetry per request    │
│  agents/      definitions, templates, runner loop, prompts      │
│  orchestration/  run modes · message bus · task board · cap 5   │
│  tools/       registry + permission levels · file/shell/web/…   │
│  approvals/   denylist-supreme gate · round-trip · audit        │
│  memory/  skills/  mcp/   (Hermes-style memory, SKILL.md, MCP)  │
│  storage/     ▼ owns exclusively ▼                               │
│         SQLite (WAL) — %APPDATA%\acute-code\acute.db            │
└────────┬──────────────────────────────────────┬─────────────────┘
         │ HTTPS — API keys in memory only      │ stdio / HTTP
         ▼                                      ▼
   Cloud LLM APIs                          MCP servers
   Anthropic · OpenAI · Google             (user-configured
   OpenRouter · OpenAI-compatible          external tool servers)
```

Non-negotiables carried through every section below:

1. **One SQLite owner.** Only the sidecar process opens the database (SPEC §3). Frontend and shell touch data only via the API.
2. **No sandbox in v1 — the approval engine is the security boundary** (SPEC §F6). Every consequential action passes one choke point (§7).
3. **Event-sourced sessions.** Transcripts are append-only event rows, never mutated in place (openhands; synthesis §6).
4. **Local-first.** All state on disk under the user profile; egress only to configured providers plus user-approved tool traffic (SPEC §5).

---

## 2. Process & lifecycle model

The shell is the parent and sole spawner of the sidecar. The pattern is Goose's spawn/handshake/teardown sequence, refined to remove its port race and its token-in-URL WebSocket weakness (goose memo, "Spawn and handshake"; ADR-0008).

### 2.1 Spawn sequence (cold start)

| Step | Actor | Action | Budget |
|---|---|---|---|
| 1 | shell | App launch; Tauri single-instance guard acquires lock (second launch focuses the first window) | — |
| 2 | shell | Credentials: read provider API keys from Windows Credential Manager (DPAPI) via the Rust `keyring` crate | <100 ms |
| 3 | shell | Mint a 256-bit random bearer token (`getrandom`); hold in memory only | <1 ms |
| 4 | shell | Spawn sidecar child (`CREATE_NO_WINDOW`): `agent-core.exe/node … --host 127.0.0.1 --port 0`, token + provider keys via **environment variables** | <200 ms |
| 5 | sidecar | Bind an **ephemeral port itself** (`:0`) — no race — open SQLite, run pending migrations, emit one stdout ready line: `{"event":"listening","port":43127}` | 0.3–1 s |
| 6 | shell | Receive ready line; hand `{port, token}` to the webview via Tauri command `sidecar_endpoint()`; start health watch | — |
| 7 | sidecar | `GET /health` returns `{"status":"ok"}` once routes are mounted (shell polls every 100 ms, 10 s deadline, abort-on-child-exit) | <2 s total |
| 8 | shell+UI | First data fetch renders Dashboard; background warm-up (skills/memory index refresh, MCP connects) starts **after** first paint | rest of <5 s |

Goose's diagnostics discipline is adopted: every phase emits a named event (`spawn_start`, `listening`, `healthcheck_success`, `child_exit`, …) appended to a local diagnostics file the error screen can show (goose, "Diagnostics").

**Port selection: ephemeral, chosen by the sidecar.** The shell never picks the port (Goose lets the UI pick via `listen(0)` then release — a TOCTOU race we avoid by having the sidecar bind `:0` and report the chosen port on stdout). A fixed port is used only in dev (`pnpm dev`, port 8765, dev token from env) so hot-reload keeps reconnecting.

**Bind address: `127.0.0.1` only, always.** No `0.0.0.0`, no LAN exposure, no TLS needed for v1 (loopback + token; remote cores are out of scope).

### 2.2 Health checking

- `GET /health` (unauthenticated — reveals only liveness): `{"status":"ok","version":"1.0.0","uptimeMs":…,"dbOk":true}`.
- Shell polls every 100 ms during startup, then every 5 s steady-state; two consecutive failures after readiness trigger the restart path.
- Stderr watch: fatal patterns (`panicked`, `FATAL`, `unhandled`) abort startup immediately (goose pattern).

### 2.3 Shell ↔ sidecar authentication (ADR-0008)

- Shell generates the token at every spawn and passes it via env var; the sidecar requires `Authorization: Bearer <token>` on **every** route except `GET /health`.
- WebSocket (`GET /ws`): browser WebSocket cannot set headers, and Goose's token-as-query-param leaks into logs (goose) — so the sidecar requires a **first-message auth** frame `{"type":"auth","token":…}` within 2 s of connect or closes with code 4401.
- CORS is a single-origin allowlist: the Tauri webview origin (`http://tauri.localhost` / `https://tauri.localhost`) plus the Vite dev origin. No wildcard.
- The webview obtains `{port, token}` only through the Tauri command `sidecar_endpoint()` — the token never appears in URLs, storage, or logs.

### 2.4 Shutdown & crash recovery

- **Normal shutdown:** window close → shell calls `POST /internal/shutdown` (authed) → sidecar stops accepting connections, appends a terminal `session.interrupted` event to any running sessions (status → `failed`), flushes WAL, closes WS with 1001, exits within 5 s → shell falls back to `taskkill /pid <pid> /T /F` if the deadline passes (goose teardown).
- **Sidecar crash while app open:** shell detects child exit → error screen with the diagnostics file and a "Restart core" action (one automatic retry, then manual). Because sessions are event-sourced, restart marks orphaned `running` sessions as `failed` on the next boot (terminal `session.interrupted` event records the cause; openhands resume-by-log pattern) — no transcript corruption is possible.
- **App crash:** sidecar is a child process; Windows terminates it with the shell. Same recovery as above on next launch; SQLite WAL guarantees consistency.

### 2.5 Process inventory (SPEC §5: no resident extras)

Exactly two processes in steady state: `acute-code.exe` (shell + WebView2 renderer threads) and the sidecar Node process. MCP servers are children of the **sidecar**, spawned lazily on first use, killed at shutdown.

---

## 3. Module map

Anti-drift rule: **every future file must map to a purpose declared here.** A new file that does not fit one of these modules — or a new module — requires editing this section (and an ADR if the change is non-trivial) in the same commit. This is the defense against the monolithic-core and storage-sprawl anti-patterns the research flagged (hermes' 560 KB `run_agent.py`; opencode's pre-migration format sprawl — synthesis §8).

```
acute-code/
├── src-tauri/          Rust shell (Tauri 2)
├── src/                React frontend (WebView2)
├── agent-core/         Node/TS sidecar — pnpm workspace package @acute/agent-core
├── shared/             pnpm workspace package @acute/shared — TypeBox schemas + DTOs
├── scripts/            build, package, license-audit, portable-zip scripts
├── tests/              cross-workspace integration tests + recorded provider fixtures
└── docs/               specs, research, architecture, decisions, compliance, runbooks
```

### 3.1 `src-tauri/` — Rust shell

Owns the window, process lifecycle, and OS credentials. Contains **no** product logic and never opens SQLite.

| Module | Responsibility |
|---|---|
| `src-tauri/src/main.rs` | Binary entry; `lib.rs` wires plugins, starts the sidecar on setup, and tears it down on app exit. |
| `src-tauri/src/sidecar.rs` | Sidecar lifecycle state machine, currently in one file: spawn (256-bit token mint via `getrandom`, env assembly incl. Credential-Manager provider-key injection — `keyring` reads `ACUTE-CODE/provider/<id>` and exports `ACUTE_PROVIDER_<ID>`, §7.3), stdout ready-line (`ACUTE_READY {port}`) parsing, health polling, graceful stop + `taskkill /T /F` fallback (§2). Also hosts today's whole Tauri invoke surface: `sidecar_info()`, `ping_sidecar()`. |
| `src-tauri/src/supervisor/` · `credentials/` · `commands/` *(planned split)* | Future home of the same responsibilities once Settings key entry (`store_provider_key()`, `delete_provider_key()`), key-update push to the running sidecar, and window controls arrive — purposes stay as declared here; files move out of `sidecar.rs`. |
| `src-tauri/tauri.conf.json` | Window config, external-binary registration of the sidecar bundle (ADR-0009), CSP allowing only the sidecar origin. |

### 3.2 `src/` — React frontend

A pure client of the sidecar API (opencode thin-client pattern). No business rules; all state derivable from API data.

| Module | Responsibility |
|---|---|
| `src/api/` | Typed fetch client generated/handwritten from `@acute/shared` schemas: REST wrappers, WS connection manager (auth frame, subscribe, reconnect + seq backfill), token obtained via Tauri command. |
| `src/stores/` | Zustand stores: projects, agents, active sessions (live event stream reducers), approvals queue, usage, settings. TanStack Query for REST reads. |
| `src/screens/` | The six SPEC §F9 screens: `Dashboard`, `ProjectWorkspace` (file tree, git panel, agent console), `AgentRegistry`, `SessionView` (task board + transcripts + approval modals), `UsageDashboard`, `Settings` (theme, providers & keys, execution/denylist, memory, skills, audit log). |
| `src/components/` | shadcn/ui-based primitives: file tree, diff viewer, task board columns, approval modal (action / target / agent / risk note), event stream virtualized list. |
| `src/theme/` | CSS-variable theming (light/dark/accent) — the only theming mechanism in v1 (SPEC §F9). |

### 3.3 `agent-core/src/` — the sidecar (sole SQLite owner)

| Module | Responsibility |
|---|---|
| `server/` | Fastify app assembly (ADR-0006): REST routes per resource, `/ws` gateway (auth frame, subscriptions, fan-out), bearer-token middleware, uniform error envelope, request logging with secret redaction, graceful shutdown hook. Routes are thin: validate → call a module → return. |
| `providers/` | The LLM egress point and the **only** code allowed to open network connections to model APIs. Wraps Vercel AI SDK (Apache-2.0): native adapters (Anthropic, OpenAI, Google) + OpenAI-compatible escape hatch; model catalog fetch/cache; vision-model routing (global default + per-agent override, SPEC §F4); per-request telemetry emission into `usage_events` with cost provenance (§6.5); recorded-fixture test mode for native adapters. Keys live in an in-memory vault populated at spawn. **In place after Phase 2** (ADR-0013): `registry.ts` — env-borne keyring (`ACUTE_PROVIDER_<ID>`, never persisted, only `hasKey` ever leaves), model listing with a 5-minute cache, secret scrubbing on errors; the SDK call seam is `agents/chat.ts` (`aiSdkChat` via `@ai-sdk/openai-compatible`, live through OpenRouter). Native adapters stay fixture-tested until their keys exist. |
| `agents/` | Agent-as-data (SPEC §F2): load/validate agent YAML/JSON definitions; template registry (Planner, Researcher, Coder, Reviewer, Tester — seeded, never hard-coded); per-agent context assembly — system prompt tiers: stable identity+tools, then memory snapshot (frozen per session), then skills index (hermes prompt tiers); the runner: one agent's LLM↔tool loop with abort propagation. **In place after Phase 2:** `chat.ts` (the AI SDK seam) + `runtime.ts` (single-agent turn: append user event → provider call → assistant event + usage row; failed turns keep their seq — ADR-0010 semantics). The multi-agent runner loop is Phase 3+. |
| `orchestration/` | Session engine for the three run modes (ADR-0001): run coordinator, typed pub/sub message bus (metagpt), Kanban task-board state, `delegate_task` tool implementation (kilocode/openhands delegation-as-tool: child gets isolated context, returns a summary), topology-as-data loader (roles/wiring stored as JSON, not code), global 5-slot runner semaphore with queueing (ADR-0011). |
| `tools/` | Tool registry and implementations: every tool declares `{name, description, JSON-Schema params, permission category}`; dispatch is the single execution choke point routed through `approvals/` (§7). Built-ins: file read/write/edit (workspace-scoped; edit ladder with structured errors per aider), shell exec, web search, code execution. Enforces the <25-tools guidance (goose). |
| `approvals/` | The security boundary (SPEC §F6): policy evaluation in fixed denylist-supreme order (§7.2); pending-request store; round-trip coordination with `server/` (parked promise per request, resolved by the decision endpoint); remembered grants (project-scoped, `tool + hash(args)` key, non-destructive only — goose); audit writer (every decision, every category, no exceptions); configurable expiry that fails closed. |
| `storage/` | Exclusive SQLite access (ADR-0007): better-sqlite3 (WAL), numbered SQL migrations, a serialized write queue (single-writer discipline — hermes), repository functions per table group, append-only event-log writer/reader with per-session `seq`, usage-ledger writer, FTS5 maintenance for memory/skills indexes. No other module issues SQL. |
| `memory/` | Hermes-inspired memory (SPEC §F8): bounded markdown files on disk (`%APPDATA%\acute-code\memories\<agentId>\MEMORY.md` / `USER.md`) as source of truth, mirrored into SQLite + FTS5 for recall; per-session frozen snapshot injection (never mutated mid-session — protects prompt cache, resists injection); agent-initiated memory writes staged through approvals, while user-initiated edits via the memory API bypass the modal but are audit-logged (API.md §4.7–4.11). |
| `skills/` | SKILL.md folder standard (SPEC §F8; hermes/kilocode): scan global (`%APPDATA%\acute-code\skills\`) and per-project (`<project>\.acute\skills\`) locations; parse optional frontmatter; index into SQLite; per-agent enable; inject enabled skills into the agent's context per its policy. |
| `mcp/` | MCP client manager (SPEC §F5): connect user-configured servers (stdio + streamable HTTP) via `@modelcontextprotocol/sdk` (MIT), lazily on first use; bridge discovered tools into `tools/` registry with `mcp__<server>__<tool>` names and `confirm` default; status reporting for Settings. |
| `main.ts` | Process entry: requires env-borne `ACUTE_TOKEN` + `ACUTE_DB_PATH` (exits if missing), opens SQLite, binds 127.0.0.1 on an ephemeral port, prints the one stdout ready line the shell parses (`ACUTE_READY {port}`, §2.1). Provider keys arrive as `ACUTE_PROVIDER_<ID>` env vars held only in memory (§7.3). |
| `config.ts` *(future)* | CLI args / settings-file composition on top of the env contract when the surface grows beyond the spawn env. |

### 3.4 `shared/` — `@acute/shared`

Single source of truth for API DTOs and event schemas, authored in TypeBox (MIT): one schema definition yields both the JSON Schema Fastify validates with and the static TypeScript type the frontend and sidecar import (opencode's `protocol`/`schema` package pattern). **Every REST body, response, and WS event type in `api/API.md` lives here.** Anti-drift: if it is not in `@acute/shared`, it is not a contract.

### 3.5 `scripts/` and `tests/`

- `scripts/`: `license-audit.mjs` exists today (feeds `docs/compliance/dependency-licenses.md`, fails on GPL family and unknown licenses, parses SPDX OR expressions — SPEC §6); `build-sidecar.mjs` (esbuild single-file bundle + native addon copy, ADR-0009) and `package-portable.mjs` (assembles exe + sidecar + node runtime folder) are planned for the packaging workstream. `pnpm verify` is a root package.json script chain (lint + typecheck + test + build + license audit, ADR-0005), not a file here.
- `tests/`: cross-workspace integration tests (boot sidecar → migrate → full multi-agent run against fixture providers → assert event log + usage rows + audit rows), recorded provider fixtures (SPEC §F4 dev/test note), boot/smoke e2e.

---

## 4. Data flows

### 4.1 Session run lifecycle — three modes (ADR-0001)

Shared engine for all modes (differences are only in topology construction):

```
POST /sessions {projectId, mode, prompt, agentId? | agentIds?}
  → storage: sessions row (status=running) + session.created event
  → orchestration: build topology (mode-specific, below)
  → for each agent slot: acquire semaphore (cap 5, queue beyond) → spawn runner
  → runner loop (agents/): assemble context → providers/ call → tool calls
        → tools/ dispatch → approvals/ gate → execute → result → loop
        → every step appends a session event (storage/) → WS session.* to UI
  → terminal event (session.completed | session.cancelled | session.failed)
```

**Mode 1 — Single (default).** Topology = one node: the user's chosen agent or the default template. Zero configuration (SPEC §F3). Cline's Plan/Act lesson applies later if we add mode-scoped toolsets (cline); v1 single mode has the full toolset.

**Mode 2 — Auto-team.** Topology is built at run time:

1. An **orchestrator agent** (routed by default to the cheaper model configured in Settings → defaults) receives the task and produces a plan: team composition from templates/registry, a task-board breakdown, and per-worker context packages (files, locations, constraints).
2. The topology (roles, wiring, communication rules) is stored as a JSON blob on the session — data, not code (ADR-0001; metagpt SOP-as-data).
3. The orchestrator delegates through the **`delegate_task` tool**: each worker runs with an isolated context containing exactly its package; it returns a structured summary to the orchestrator's context — the parent sees the call and the summary, never the worker's full transcript (kilocode `task` tool; openhands `TaskToolSet`). Workers use the powerful model (per-agent routing, SPEC §F4).
4. The orchestrator monitors via the shared **typed pub/sub bus** (metagpt message pool), integrates results, may re-delegate, then produces the final answer. The user watches the task board and transcripts live and can steer (steering messages enter the bus marked as user-source).
5. Concurrency: at most 5 runners across the whole app; further `delegate_task` calls queue (SPEC §F3 hard cap).

**Mode 3 — Manual team.** Same engine; the topology comes from the user's explicit agent selection in the session-create request. Minimal UI in v1 (SPEC §F3). Delegation and the bus behave identically.

### 4.2 Approval round-trip (SPEC §F6; opencode permission round-trip; goose remembered grants)

```
 ① model emits tool call (e.g. shell.exec "rm -rf build")
 ② tools/ registry → approvals/ evaluate()            ── fixed order, §7.2
 ③a auto-allowed  → execute → audit row (decision=auto)
 ③b denylist hit  → DENY immediately, no prompt, audit row (decision=denied,
                    reason=denylist)
 ③c prompt needed → approval_requests row (pending)
                     WS: approval.requested {requestId, sessionId, agent, tool,
                          args, category, riskNote}
                     runner parks on a promise (no default timeout < expiry;
                     default expiry 15 min → decision=expired, fail-closed —
                     the runner receives a denial)
 ④ UI modal: action · full target path/command · requesting agent · risk note
 ⑤ user decision → POST /approvals/{requestId}/decision
                    {decision: approved | denied, remember?: once | project}
    · remember=project rejected (422) for destructive categories
    · remember=project writes permission_grants row (tool + hash(args), projectId)
 ⑥ approvals/ resolves the parked promise, writes audit_log row
    (ts, sessionId, agentId, category, action, decision, reason)
 ⑦ runner proceeds — or receives the denial as a tool_result for the model
 ⑧ Settings → Audit Log reads audit_log (immutable: no update/delete API)
```

Every step ①–⑧ lands in the event log too (`session.event` of type `approval.*`), so a replayed session shows approvals exactly as they happened (openhands event sourcing).

### 4.3 Provider request with per-request telemetry (SPEC §F4, §F7; goose usage_ledger)

```
runner needs completion
  → providers/ resolve(agent.providerId, agent.model)
      key from in-memory vault (never disk; §7.3)
  → Vercel AI SDK stream call (native or OpenAI-compatible baseURL)
      · retries: 429/5xx with backoff (AI SDK built-ins)
      · redaction: keys/headers scrubbed from all log lines
  → on completion, storage/ inserts ONE usage_events row:
      {id, ts, sessionId, agentId, providerId, model,
       inputTokens, outputTokens, cachedTokens?, costUsd,
       costSource: provider_reported | estimated,
       latencyMs, status: ok | error, errorCode?}
      costSource provenance copied from goose — the dashboard can show
      "estimated" vs "reported" honestly (aider's honest-cost lesson)
  → WS usage.recorded → live dashboard tile updates (no polling)
  → GET /usage aggregates by day/provider/model/agent/project (SQL GROUP BY)
```

Phase 2 note: `GET /api/v1/usage/summary?days=N` — daily request/token/cost buckets over the trailing N days (UTC-day SQL aggregation over `usage_events`, zero-filled so the chart gets a dense series) — lands this phase to feed the dashboard chart; the full group-by `GET /usage` contract above is unchanged.

Vision routing: an image attachment or image-bearing tool result is wrapped and sent to the configured vision model; its analysis returns as text into the requesting agent's context; telemetry attributes the call to the vision model with the original agentId (SPEC §F4, §F10).

---

## 5. Storage overview

Single database `%APPDATA%\acute-code\acute.db`, SQLite in **WAL** mode, opened only by the sidecar (SPEC §3; synthesis §6). Full column-level schema is Phase 2 work; this section fixes the **table groups** and their purpose. Migrations: numbered SQL files applied in order, recorded in `schema_migrations` (goose migration discipline).

### 5.1 Table groups

| Group | Tables | Purpose & key columns |
|---|---|---|
| **Projects** | `projects` | Registered workspaces (SPEC §F1): `id, name, root_path, created_at, last_opened_at`. |
| **Agents** | `agents` | Agent-as-data (SPEC §F2): `id, name, role, system_prompt, provider_id, model, vision_model?, allowed_tools (JSON), memory_policy (JSON), skills (JSON), max_turns, temperature, is_template, version, created_at, updated_at`. Templates are rows with `is_template=1`, seeded on first run, fully editable. |
| **Sessions & events** | `sessions`, `session_events` | `sessions`: `id, project_id, mode, status, title, topology (JSON), created_at, ended_at`. `session_events`: **append-only** — `id (autoincrement PK), session_id, seq (per-session monotonic), ts, type, agent_id?, task_id?, payload (JSON)`. Transcripts, tool calls, approval steps, task moves, interruptions are all event types. Replay = SELECT ordered by `seq`. No in-place transcript mutation, ever (openhands; synthesis §6). |
| **Tasks** | `tasks` | Kanban board (SPEC §F3): `id, session_id, title, status (todo\|in_progress\|done\|blocked), assignee_agent_id, parent_task_id?, sort_order, created_at, updated_at`. Board mutations also append events. |
| **Approvals & audit** | `approval_requests`, `permission_grants`, `audit_log` | Pending/decided prompts: `id, session_id, agent_id, tool_name, args (JSON), category, risk, status, decided_at`. Remembered grants (goose): `id, project_id, tool_name, args_hash, allowed, granted_at, expires_at?`. Immutable audit (SPEC §F6): `id, ts, session_id?, agent_id?, category, action, decision, reason, details (JSON)` — insert-only; no API ever updates or deletes rows. |
| **Usage** | `usage_events` | Per-request telemetry (SPEC §F7; goose usage_ledger): columns as in §4.3. Indexed on `(ts)`, `(session_id)`, `(provider_id, model)`. |
| **Memory index** | `memory_entries` (+ FTS5) | Mirror of on-disk markdown (hermes): `id, agent_id, kind (memory\|user), path, content, updated_at`. Markdown files are the source of truth; SQLite is the recall index. |
| **Skills index** | `skills` (+ FTS5) | `id, name, scope (global\|project), project_id?, path, description, frontmatter (JSON), discovered_at`. |
| **Settings** | `settings` | Key/value JSON: theme, denylist patterns, permission category defaults, model defaults (provider/model/vision/orchestrator-cheap), memory budgets, MCP server configs. |
| **Internal** | `schema_migrations`, `kv` | Migration bookkeeping; internal flags (e.g., seed-done marker). |

### 5.2 Write discipline

- All writes flow through `storage/`'s serialized queue — single-writer by construction (hermes single-writer queue; better-sqlite3 is synchronous, so ordering is trivially deterministic on the main thread).
- Streaming deltas are **not** written per-token: message text buffers and flushes on part boundaries (paragraph/tool-call/turn end) to bound write amplification; the full final message is always an event.
- WAL + `synchronous=NORMAL` gives crash-safe append-only logs at negligible cost; `wal_checkpoint(TRUNCATE)` on shutdown.

### 5.3 On-disk layout (all under the user profile — ADR-0003)

```
%APPDATA%\acute-code\
├── acute.db (+ -wal, -shm)
├── memories\<agentId>\MEMORY.md · USER.md      # source of truth
├── skills\<name>\SKILL.md …                    # global skills
├── logs\sidecar-diagnostics.jsonl              # startup phases (goose pattern)
└── backups\                                    # pre-migration DB copies
<project>\.acute\skills\…                       # project-scoped skills
```

---

## 6. Event model (WebSocket)

One WS endpoint (`GET /ws`), one subscription stream per UI, five public categories (plus `system.*` for connection management). Envelope:

```json
{ "type": "agent.message.delta", "ts": "2026-08-21T14:03:11Z",
  "sessionId": "sess_…", "seq": 148, "payload": { … } }
```

`seq` is present on session-scoped events (the `session_events.seq`) so the client can dedupe and backfill after reconnect via `GET /sessions/{id}/events?afterSeq=` (§ backfill contract in API.md).

| Category | Events | UI consumer |
|---|---|---|
| `session.*` | `session.created` · `session.event` (generic transcript-event fan-out: messages, tool calls/results, approval steps) · `session.status` (queued / running / completed / failed / cancelled — canonical `SessionStatus`) · `session.completed` | Session view transcripts, session list badges |
| `agent.*` | `agent.started` · `agent.queued` (cap hit → queued) · `agent.message.delta` (streaming text) · `agent.tool.started` · `agent.tool.result` · `agent.status` (thinking / idle / waiting_approval / stopped) · `agent.finished` | Transcript streams, per-agent status chips, queue indicator |
| `task.*` | `task.created` · `task.moved` (column change with from/to) · `task.updated` · `task.completed` | Kanban board live updates |
| `approval.*` | `approval.requested` · `approval.resolved` · `approval.expired` | Global approval modal queue, Settings audit badge |
| `usage.*` | `usage.recorded` (per provider request, §4.3) | Live usage dashboard |
| `system.*` | `system.ready` · `system.error` · `system.pong` | Connection manager |

No polling anywhere: every dashboard number moves because an event arrived (SPEC §5 background-behavior rule).

---

## 7. Security model

### 7.1 Approval-gate integration points (the choke points)

1. **Tool dispatch** — `tools/` registry `dispatch()` is the only path from a model tool call to execution; it calls `approvals/evaluate()` before every execution, with no bypass flag in the codebase (hermes hardline floor: no path skips the gate; synthesis §5).
2. **Agent tool allowlist** — tools not listed in `agent.allowed_tools` are never even exposed to the model (applied at prompt assembly, before dispatch).
3. **MCP-bridged tools** — enter the same registry, same gate, `confirm` default (§3.3 `mcp/`).
4. **Network egress** — `providers/` is the only module permitted to open connections to model APIs; every other network action is a tool (web search, code exec) and therefore gated (SPEC §5 data locality).
5. **File scope** — file tools default to workspace-scoped paths; anything outside the active workspace routes to prompt (SPEC §F6).
6. **Failure semantics** — any exception inside the approval engine is treated as a denial and audited (fail-closed). A closed UI does not auto-deny; requests expire (default 15 min) to a denial. Nothing ever auto-approves.

### 7.2 Denylist-supreme evaluation order (SPEC §F6: denylist wins over everything)

```
0. agent.allowed_tools      → not listed            ⇒ tool never exposed to model
1. settings denylist        ⇒ DENY  (audited, never prompted, cannot be remembered away)
2. tool static level        ⇒ blocked              ⇒ DENY
3. destructive category     ⇒ PROMPT always — "always allow" & "remember=project"
                              structurally unavailable (UI + API both reject)
4. remembered decision      ⇒ most recent non-expired grant/deny for
                              (project, tool, hash(args)) wins      (goose)
5. category default         ⇒ auto → ALLOW (audited) · confirm → PROMPT
6. unknown tool             ⇒ DENY + audit (fail-closed default)
```

Order is fixed in code and unit-tested against a permutation table (Phase 3 acceptance; SPEC §6 "complete, unbypassable, denylist-supreme"). Destructive set per SPEC §F6: shell commands outside a safe subset, writes outside workspace, `git reset --hard` / force-push / branch-delete, non-provider network egress.

### 7.3 Secrets flow (SPEC §5: Credential Manager only)

```
Windows Credential Manager (DPAPI at rest)
   │ read at spawn (never on disk in between)
   ▼
Rust shell (keyring crate — MIT OR Apache-2.0)
   │ env vars at spawn; in-memory push on change
   ▼
agent-core in-memory vault  ──▶ used only by providers/ at request time
```

- The sidecar **never** writes keys to disk, never logs them (redaction middleware strips `Authorization`/`x-api-key`/key-shaped strings from every log line and error), and never echoes them into transcripts, tool args, or API responses (SPEC §5).
- SQLite stores only `provider_id` + credential **names** ("openai/main"), never values.
- Adding/rotating a key in Settings: UI → Tauri command `store_provider_key` (Rust writes Credential Manager) → shell pushes the new key to the running sidecar via authed internal endpoint → vault updates without restart. Revocation mirrors this.
- Diagnostics/logs may contain ports, session ids, error codes — never tokens or keys.

### 7.4 Transport & process boundaries

Loopback-only sidecar (§2.1), bearer token per spawn (ADR-0008), single-origin CORS, WS first-message auth, single-instance app, sidecar spawned with `CREATE_NO_WINDOW`. No admin rights anywhere (ADR-0003).

---

## 8. Performance vs the budget

Budget (SPEC §5): idle <700 MB · 5 agents <2.5 GB · cold start <5 s · warm <2 s. Analysis now; measurement is a phase-exit ritual (SPEC §8 requires measured performance in phase reports).

### 8.1 Startup sequence & what must be lazy

| Must be fast (blocking first paint) | Must be lazy (after first paint) |
|---|---|
| Node process boot with single-file esbuild bundle (~0.3 s) | MCP server connections (first session use or idle background) |
| SQLite open + WAL + migration check (no-op when current) | Provider model-list fetch (cache in `settings`/`kv`; refresh on demand) |
| `/health` ready | Skills + memory re-scan (debounced background; indexes already in SQLite) |
| Dashboard first query (recent projects/sessions — indexed) | Usage aggregation (computed on request; no materialized jobs) |
| — | Template seeding (first run only, guarded by `kv` marker) |

### 8.2 Memory accounting (targets to verify in Phase 2/3)

- WebView2 + React UI: ~150–250 MB (the reason we are not Electron — SPEC §3).
- Sidecar Node baseline: ~80–120 MB (single process, no per-agent processes — ADR-0011).
- Per running agent: transcript arrays + streams, bounded by context compaction adopted from hermes (compress at ~75% window, protect head/tail messages) — target <300 MB/agent worst case ⇒ 5 agents ≈ 1.5 GB + baseline ≈ well under 2.5 GB.
- SQLite page cache default; WAL kept small via shutdown checkpoint.

### 8.3 Steady state

One health poll / 5 s is the only timer (SPEC §5); everything else is event-driven (§6). No resident processes beyond shell + sidecar (§2.5).

---

## 9. Extension points

**Add a provider** (SPEC §F4): register an adapter in `providers/registry.ts` — native adapters wrap the matching Vercel AI SDK package; anything OpenAI-compatible needs only a settings row (`{id, name, baseUrl}`) and a key in the vault, no code. Model catalog + test endpoint come from the registry contract. Touch nothing else.

**Add a tool**: create `tools/<name>.ts` exporting the Tool interface `{name, description, parameters (TypeBox), category, execute(args, ctx)}`; register it in the explicit registry list (no auto-discovery — hermes' 70-tool bloat and goose's <25-tools guidance are the lesson). It inherits the approval gate automatically; nothing else changes.

**Add an MCP server**: Settings → MCP → add `{name, transport: stdio|http, command?|url?, env key names}`; `mcp/` connects lazily and bridges its tools into the registry as `mcp__<server>__<tool>` with `confirm` default. No code, no rebuild.

**Add a skill**: drop a folder with `SKILL.md` (+ optional scripts/resources) into `%APPDATA%\acute-code\skills\` or `<project>\.acute\skills\`; the scanner indexes it; enable it per agent in the registry (SPEC §F8). No marketplace, no sync — files on disk only.

---

## 10. Phase 2–6 build order implied by this architecture

| Phase | What this architecture forces first | Exit (SPEC §8) |
|---|---|---|
| **2 — Core skeleton** | Repo scaffolding per §3; `server/` + auth + health (§2); `storage/` + migrations for projects/agents/sessions/usage/settings (§5); `providers/` openai-compatible live + native adapters on fixtures (SPEC §F4 dev note); `agents/` CRUD + templates; single-agent round trip | Owner creates an agent, completes one conversation |
| **3 — Orchestration** | `orchestration/` bus + semaphore + task board; `approvals/` engine + round-trip + audit; three modes (§4.1, §4.2); `session_events` replay | Live 3-agent coding + 2-agent research demos |
| **4 — Tool layer** | `tools/` built-ins (file ladder per aider, shell, web search, code exec) + `mcp/` — all through the gate (§7) | Agent writes & runs a script; approval fires; audit records it |
| **5 — Dashboard & polish** | Usage aggregates on real `usage_events`; Settings screens (denylist, audit view, memory, skills); theming; vision routing + image attachment (§4.3) | Dashboard matches a session the owner just ran |
| **6 — Hardening & release** | `scripts/package-portable.mjs` (ADR-0009); crash-recovery drills (§2.4); perf measurement vs §8; user guide | Clean-machine portable run within budget |

Dependencies run strictly downward: the API contracts (`api/API.md`) and `@acute/shared` schemas are authored in Phase 2 kickoff week and frozen per resource before its UI is built — the opencode lesson that one schema source prevents client/server drift.
