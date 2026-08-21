# ACUTE-CODE — Sidecar API Contracts (REST + WebSocket)

| | |
|---|---|
| **Status** | PROPOSED — Phase 1 deliverable, awaiting owner approval |
| **Date** | 2026-08-21 |
| **Served by** | `agent-core` sidecar (Fastify, ADR-0006) · schemas authored in `@acute/shared` (TypeBox) — this document is the human-readable mirror of that package; if they diverge, `@acute/shared` wins and this doc is fixed in the same PR |

---

## 1. Conventions

### 1.1 Base URL

```
http://127.0.0.1:<ephemeral-port>/api/v1
```

- The port is ephemeral per spawn; the webview obtains `{port, token}` from the shell via the Tauri command `sidecar_endpoint()` (ARCHITECTURE §2.1). Dev mode uses a fixed port (8765) with a dev token from the environment.
- Loopback only; no TLS (ADR-0008).

### 1.2 Authentication

- Every REST route except `GET /health` requires:

```
Authorization: Bearer <token>
```

- The token is minted by the Rust shell at sidecar spawn and handed to the webview in memory. Missing/wrong token → `401` `UNAUTHORIZED`.
- WebSocket authenticates with a first-message frame (§9.1).
- CORS: only the Tauri webview origin (+ dev origin). No credentials, no wildcard.

### 1.3 Error envelope

All non-2xx responses carry a single shape:

```json
{ "error": { "code": "VALIDATION", "message": "body.mode must be one of: single, auto-team, manual", "details": { "field": "body.mode" } } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION` | Malformed/failed schema validation (`details.field` present when applicable) |
| 401 | `UNAUTHORIZED` | Missing/invalid bearer token |
| 403 | `FORBIDDEN` | Authenticated but not permitted (internal endpoints called from outside the shell) |
| 404 | `NOT_FOUND` | Unknown resource id |
| 409 | `CONFLICT` | State conflict (e.g., stop a non-running session, delete an agent referenced by a running session) |
| 422 | `VALIDATION` | Semantically invalid (e.g., `remember: "project"` on a destructive approval) |
| 429 | `RATE_LIMITED` | Provider rate limits surfaced through a provider call |
| 502 | `PROVIDER_ERROR` | Upstream LLM/provider failure (`details.providerError` sanitized — never contains keys) |
| 500 | `INTERNAL` | Unexpected sidecar fault (logged with a correlation id in `message`) |

Success responses are the resource JSON shown per endpoint; `204 No Content` where noted. Field names are `camelCase`; ids are prefixed strings (`prj_`, `agt_`, `sess_`, `apr_`, `tsk_`, `mem_`) except `seq` numbers which are integers.

---

## 2. System / health

### 2.1 `GET /health` — unauthenticated

Response `200`:

```json
{ "status": "ok", "version": "0.1.0", "uptimeMs": 5123, "dbOk": true }
```

Notes: no auth (liveness only); used by the shell supervisor poll (ARCHITECTURE §2.2). Error case: none (process not listening = down).

### 2.2 `POST /internal/shutdown` — internal (shell only)

Request: empty body. Response `202` `{"status":"stopping"}` — graceful shutdown begins (ARCHITECTURE §2.4). Errors: `401`, `403` (token valid but request arrived after shutdown started → `409 CONFLICT`).

### 2.3 `POST /internal/providers/keys` — internal (shell only)

Shell pushes a credential add/rotate/revoke into the in-memory vault (ARCHITECTURE §7.3).

Request:

```json
{ "providerId": "openai", "keyName": "main", "value": "sk-…" , "action": "set" }
```

`action`: `set` | `remove`. Response `204`. Errors: `401` · `404 NOT_FOUND` (unknown providerId).

---

## 3. Projects, files & git (SPEC §F1; F9 panels)

### 3.1 `GET /projects`

Response `200`:

```json
{ "projects": [
  { "id": "prj_9f2", "name": "acute-code", "rootPath": "C:\\dev\\acute",
    "createdAt": "2026-08-21T09:00:00Z", "lastOpenedAt": "2026-08-21T14:02:00Z" }
] }
```

### 3.2 `POST /projects`

Request:

```json
{ "rootPath": "C:\\dev\\acute", "name": "acute-code" }
```

`name` optional (defaults to directory name). Response `201` → the project object. Errors: `400 VALIDATION` (path missing) · `409 CONFLICT` (`rootPath` already registered).

### 3.3 `GET /projects/{id}`

Response `200` → project object. Errors: `404`.

### 3.4 `PATCH /projects/{id}`

Request: `{"name": "…"}` and/or `{"touchOpened": true}`. Response `200` → project object. Errors: `400` · `404`.

### 3.5 `DELETE /projects/{id}`

Unregisters the project only — **never** touches files. Response `204`. Errors: `404` · `409 CONFLICT` (running sessions reference it).

### 3.6 Project files (F1) — permission model for UI-initiated file actions

Routes §3.7–3.11 back the F1 file-tree browser and the editor hookup in the F9 ProjectWorkspace screen. They execute as `file_*` tool calls **through the approval engine** — the §7.2 evaluation order (as mirrored in ARCHITECTURE §7.2) applies verbatim, with the denylist supreme: a denylist hit is `403`, audited, and nothing is written. The tier comes from the Settings `permissions` block (§10.1): inside `rootPath` → `fileWriteInWorkspace` (default `auto` — executes immediately, audited); outside `rootPath` → `fileWriteOutsideWorkspace` (default `confirm` — raises a normal approval and completes only via §7.2; expiry or denial writes nothing). Audit rows for these calls carry `details.origin: "ui"`.

### 3.7 `GET /projects/{id}/files?path=&depth=` — directory tree

`path` is project-root-relative (default `""` = root); `depth` `1` (default) lists one level per expansion, up to `10`. Read-only: no approval, no audit.

Response `200`:

```json
{ "path": "", "entries": [
  { "name": "src", "path": "src", "kind": "directory", "childCount": 7 },
  { "name": "package.json", "path": "package.json", "kind": "file", "size": 812,
    "updatedAt": "2026-08-21T09:00:00Z" }
] }
```

`depth > 1` nests `entries` recursively. Errors: `400 VALIDATION` (`depth` > 10) · `403 FORBIDDEN` (`path` resolves outside `rootPath`) · `404` (project or directory).

### 3.8 `GET /projects/{id}/file?path=` — read one file

Workspace-scoped: `path` must resolve under `rootPath`. The sidecar canonicalizes and prefix-checks, so `..` segments, absolute-path escapes, and symlink escapes are all rejected (traversal guard, ARCHITECTURE §7.1(5)). Text-only in v1.

Response `200`:

```json
{ "path": "src/app.ts", "size": 2143, "updatedAt": "…", "content": "import …" }
```

Errors: `404` (project or file) · `403` (path escapes `rootPath`) · `422 VALIDATION` (binary content or > 1 MB — the editor hookup is text-only).

### 3.9 `PUT /projects/{id}/file` — create/overwrite a file

Upsert: overwrites an existing file, creates a missing one. Tier per §3.6.

Request:

```json
{ "path": "src/login/rate-limit.ts", "content": "…" }
```

Response — `200` when executed at the `auto` tier:

```json
{ "path": "src/login/rate-limit.ts", "bytes": 2143, "updatedAt": "…" }
```

or `202` when the tier is `confirm` (approval round-trip):

```json
{ "approvalId": "apr_9", "status": "pending" }
```

Errors: `400 VALIDATION` · `404` (project) · `403 FORBIDDEN` (denylist hit, or target outside `rootPath` while `fileWriteOutsideWorkspace` policy denies) · `409 CONFLICT` (`path` is an existing directory).

### 3.10 `POST /projects/{id}/entries` — create a file or directory

Request:

```json
{ "path": "docs/runbooks", "kind": "directory" }
```

`kind`: `file` | `directory`; `content` optional when `kind: "file"`. Same tiering as §3.9. Response `201` → `{"path": "docs/runbooks", "kind": "directory"}`, or the §3.9 approval shape at `202`. Errors: `400` · `404` · `403` · `409 CONFLICT` (entry already exists).

### 3.11 `DELETE /projects/{id}/entries?path=`

Deletion is never auto-approved: deleting a **file** runs at the `confirm` tier; deleting a **directory** (recursive) at the `destructive` tier (`rememberable: false`, §7.2). Response `202` → `{"approvalId": "apr_10", "status": "pending"}`; the delete happens only on approval. Errors: `400` · `404` (project or entry) · `403` (denylist; path escapes `rootPath`).

### 3.12 Git panel (F9) — all routes run via the shell tool under the approval engine

Mirroring SPEC §F1 ("basic git integration (status, diff, commit) via the shell tool with approvals"), every git route is executed by the sidecar as a `shell_exec` call through the approval engine: `status`/`diff`/`log` are read-only commands in the safe subset → `auto` (§7.2); `commit` → `confirm`; destructive operations — `git reset --hard`, force push, branch delete — have **no dedicated route** and map to the `destructive` tier (always prompt, never rememberable) wherever they arise.

### 3.13 `GET /projects/{id}/git/status`

Response `200` (porcelain-derived):

```json
{ "branch": "main", "upstream": "origin/main", "ahead": 2, "behind": 0,
  "entries": [ { "path": "src/app.ts", "index": "M", "worktree": " " },
               { "path": "notes.txt", "index": "?", "worktree": "?" } ] }
```

`index`/`worktree` are porcelain XY codes (`??` = untracked). Errors: `404` (project) · `409 CONFLICT` (`rootPath` is not a git repository — `details.reason: "no_git_repo"`).

### 3.14 `GET /projects/{id}/git/diff?staged=false&path=`

`staged: false` (default) diffs worktree vs HEAD; `staged: true` diffs index vs HEAD. `path` optionally scopes to one file. Read-only (`auto`).

Response `200`:

```json
{ "staged": false, "path": null, "diff": "--- a/src/app.ts\n+++ b/src/app.ts\n@@ …" }
```

Errors: `404` · `409 CONFLICT` (no git repository).

### 3.15 `GET /projects/{id}/git/log?limit=50&skip=0`

Read-only (`auto`). Response `200`:

```json
{ "commits": [
  { "sha": "9f2a1c4d2e…", "shortSha": "9f2a1c4", "author": "Dev",
    "date": "2026-08-20T18:04:00Z", "message": "Add login rate limiting" }
] }
```

Errors: `404` · `409 CONFLICT` (no git repository).

### 3.16 `POST /projects/{id}/git/commit` — confirm tier

Executed as `git commit -m <message>` via `shell_exec` at the **confirm** tier.

Request:

```json
{ "message": "Add login rate limiting", "stageAll": true }
```

`stageAll` (default `false`) runs `git add -A` first. Response `202` → `{"approvalId": "apr_11", "status": "pending"}`; on approval the commit lands and the UI refetches §3.13. Errors: `400 VALIDATION` (empty `message`) · `404` · `409 CONFLICT` (no git repository, or nothing to commit).

---

## 4. Agents & memory (SPEC §F2, §F8)

Agent object (all endpoints return this shape):

```json
{ "id": "agt_c1", "name": "Coder", "role": "coder",
  "systemPrompt": "You write precise, minimal diffs…",
  "providerId": "openrouter", "model": "anthropic/claude-sonnet-4",
  "visionModel": null,
  "allowedTools": ["file_read","file_write","file_edit","shell_exec"],
  "memoryPolicy": "every-turn",
  "skills": ["git-rescue"],
  "maxTurns": 40, "temperature": 0.2,
  "isTemplate": false, "version": 3,
  "createdAt": "…", "updatedAt": "…" }
```

### 4.1 `GET /agents`

Query: `?includeTemplates=true|false` (default `true`). Response `200`: `{"agents": [ … ]}`.

### 4.2 `POST /agents`

Request: agent object **without** `id`, `isTemplate`, `version`, timestamps. Response `201` → agent object. Errors: `400 VALIDATION` (unknown `providerId`, unknown tool names, negative `maxTurns`).

### 4.3 `GET /agents/{id}` — `200` / `404`

### 4.4 `PATCH /agents/{id}`

Request: any editable subset of fields. Bumps `version` by 1. Response `200` → agent object. Errors: `400` · `404` · `409 CONFLICT` (agent is currently running in a live session).

### 4.5 `DELETE /agents/{id}`

Response `204`. Errors: `404` · `409 CONFLICT` (referenced by a running session). Templates cannot be deleted — `409 CONFLICT` with `details.reason: "template"`.

### 4.6 `POST /agents/{id}/duplicate`

Request: `{"name": "Coder (fast)"}` (optional override; default `"<name> (copy)"`). Response `201` → new agent (`isTemplate: false`, `version: 1`). Errors: `404`.

### 4.7 Memory notes (F8) — user-editable, markdown on disk + SQLite index

Memory notes are bounded markdown files on disk (`%APPDATA%\acute-code\memories\<agentId>\MEMORY.md` / `USER.md`) — the **source of truth** — mirrored into the `memory_entries` SQLite + FTS5 index (ARCHITECTURE §3.3, §5.1). Each agent has one `memory` note and one `user` note in v1, with stable ids (`mem_…`).

**Permission carve-out:** these are *user-initiated* edits — they **bypass the approval modal but are always audit-logged** (`category: "memory"`, `decision: "approved"`, `reason: "user-initiated"`; §7.3). Agent-initiated memory writes during a session still pass the approval gate (ARCHITECTURE §3.3 `memory/`). An edit updates the index synchronously but never mutates a running session's frozen memory snapshot — it takes effect next session.

### 4.8 `GET /agents/{id}/memory`

Response `200`:

```json
{ "notes": [
  { "id": "mem_m1", "kind": "memory",
    "path": "C:\\Users\\…\\acute-code\\memories\\agt_c1\\MEMORY.md",
    "chars": 2140, "updatedAt": "…" },
  { "id": "mem_u1", "kind": "user",
    "path": "C:\\Users\\…\\acute-code\\memories\\agt_c1\\USER.md",
    "chars": 980, "updatedAt": "…" }
] }
```

Errors: `404`.

### 4.9 `GET /agents/{id}/memory/{noteId}`

Response `200` → note object **plus** `"markdown": "<full file text>"`. Errors: `404` (agent or note).

### 4.10 `PUT /agents/{id}/memory/{noteId}` — create/update (upsert)

Request:

```json
{ "markdown": "# Coder memory\n- prefers vitest, minimal diffs…" }
```

`memoryPolicy` is the canonical `@acute/shared` string union `"none" | "on-start" | "every-turn"`. Char budgets come from Settings (§10.1), not per-agent policy: `memory` notes ≤ `memory.memoryCharLimit`, `user` notes ≤ `memory.userCharLimit`. Response `200` → note object (audit-logged per §4.7). Errors: `400 VALIDATION` · `404` (agent) · `422 VALIDATION` (`markdown` exceeds the note's budget).

### 4.11 `DELETE /agents/{id}/memory/{noteId}`

Removes the file and its `memory_entries` row. Response `204`. Errors: `404`. Same carve-out as §4.10 (no modal, audit-logged).

---

## 5. Sessions (SPEC §F3; ADR-0001)

Session object:

```json
{ "id": "sess_a7", "projectId": "prj_9f2",
  "mode": "auto-team", "status": "running", "title": "Add login rate limiting",
  "agents": [ {"agentId": "agt_c1", "name": "Coder", "role": "coder", "status": "thinking"} ],
  "taskCounts": { "todo": 2, "inProgress": 1, "done": 4, "blocked": 0 },
  "usage": { "requests": 31, "inputTokens": 41200, "outputTokens": 8800, "costUsd": 0.41 },
  "createdAt": "…", "endedAt": null }
```

`mode`: `single` | `auto-team` | `manual` (canonical `RunMode`). `status`: `queued` | `running` | `completed` | `failed` | `cancelled` (canonical `SessionStatus`; `@acute/shared` is the single source of truth). A session stays `running` while an approval is pending — pending approvals surface via `GET /approvals?status=pending` and `agent.status: waiting_approval` events (§6), not via `SessionStatus`.

### 5.1 `POST /sessions` — create + start a run

Request (mode-dependent):

```json
{ "projectId": "prj_9f2", "mode": "single", "agentId": "agt_c1",
  "title": "Fix flaky test", "prompt": "The login test flakes on CI; find and fix the race." }
```

- `mode: "single"` — `agentId` optional (falls back to the default agent configured in Settings).
- `mode: "auto-team"` — neither `agentId` nor `agentIds`; the orchestrator composes the team (topology stored on the session as data).
- `mode: "manual"` — requires `agentIds: ["agt_a","agt_b", …]`.

Response `202` → session object (status `running` or `queued` if the 5-agent cap is saturated). Errors: `400 VALIDATION` (mode/agent mismatches) · `404` (project / agent ids) · `409 CONFLICT` (reserved — no defined case in v1).

### 5.2 `GET /sessions?projectId=&limit=50&offset=0`

Response `200`: `{"sessions": [ … ], "total": 132}`. Ordered newest-first.

### 5.3 `GET /sessions/{id}`

Response `200` → session object (above) **plus** `{"tasks": [ …task objects ]}` and `{"lastSeq": 1487}` (for WS backfill anchoring). Errors: `404`.

### 5.4 `POST /sessions/{id}/messages` — follow-up turn

Request:

```json
{ "text": "Also cover the remember-me cookie",
  "attachments": [ { "kind": "image", "path": "C:\\shots\\err.png" } ] }
```

Response `202` → `{"messageId": "msg_31"}` (deltas arrive over WS; final message lands in the event log). Errors: `400` · `404` · `409 CONFLICT` (session not active: `completed | failed | cancelled`).

### 5.5 `POST /sessions/{id}/stop`

Request: empty. Graceful: runners cancelled, terminal `session.cancelled` event appended, status → `cancelled`. Response `202` → session object. Errors: `404` · `409 CONFLICT` (not running).

### 5.6 `GET /sessions/{id}/events?afterSeq=0&limit=500&type=` — REST backfill

Response `200`:

```json
{ "events": [
  { "seq": 1,  "ts": "…", "type": "message.user",      "agentId": null,   "payload": {"text": "Fix the flaky test…"} },
  { "seq": 2,  "ts": "…", "type": "agent.started",     "agentId": "agt_c1", "payload": {"model": "…"} },
  { "seq": 3,  "ts": "…", "type": "tool.call",         "agentId": "agt_c1", "payload": {"tool": "file_read", "args": {"path": "tests/login.spec.ts"} } },
  { "seq": 4,  "ts": "…", "type": "approval.requested", "agentId": "agt_c1", "payload": {"approvalId": "apr_5", "category": "shell", "risk": "medium"} },
  { "seq": 5,  "ts": "…", "type": "approval.resolved", "agentId": "agt_c1", "payload": {"approvalId": "apr_5", "decision": "approved"} }
], "lastSeq": 1487 }
```

`type` filter is optional (repeatable). This endpoint plus WS `seq` gives exactly-once replay after reconnect (ARCHITECTURE §6). Errors: `404` · `400 VALIDATION` (afterSeq > lastSeq is clamped, not an error).

---

## 6. Events — WebSocket subscribe

### 6.1 `GET /ws`

**Connect:** `ws://127.0.0.1:<port>/ws`. Server waits ≤2 s for:

```json
{ "type": "auth", "token": "<bearer token>" }
```

→ `{"type":"auth_ok"}` or close `4401`. Then subscribe:

```json
{ "type": "subscribe", "categories": ["session.*","agent.*","task.*","approval.*","usage.*"],
  "sessionIds": ["sess_a7"] }
```

- `session.*`/`agent.*`/`task.*` events are delivered **only** for sessions listed in `sessionIds` (add more later by resending `subscribe`).
- `approval.*` and `usage.*` are app-global topics (any subscription receives them).
- Server → client event envelope (one per §6 of ARCHITECTURE):

```json
{ "type": "agent.message.delta", "ts": "…", "sessionId": "sess_a7", "seq": 201,
  "payload": { "agentId": "agt_c1", "delta": "The race is in…" } }
```

- Keep-alive: client `{"type":"ping"}` → server `{"type":"pong"}` (idle timeout 60 s).
- Server errors: `{"type":"error","code":"…","message":"…"}`.
- **Reconnect protocol:** on reconnect, client re-auths, re-subscribes, then calls `GET /sessions/{id}/events?afterSeq=<highest seq seen>` per open session; `seq` dedupes the overlap (ARCHITECTURE §6).

---

## 7. Approvals & audit (SPEC §F6)

Approval object:

```json
{ "id": "apr_5", "sessionId": "sess_a7", "agentId": "agt_c1", "agentName": "Coder",
  "toolName": "shell_exec", "category": "shell",
  "args": { "command": "npm test -- --grep login", "cwd": "C:\\dev\\acute" },
  "risk": "low",
  "riskNote": "Runs the project test suite; no file modification outside node_modules/coverage.",
  "rememberable": true,
  "status": "pending", "createdAt": "…", "decidedAt": null }
```

`status`: `pending` → `approved` | `denied` (user decision, §7.2) or `expired` (set only by the server when expiry passes — fail-closed; the runner receives a denial). The decided/expired values are the canonical `ApprovalDecision` union (`@acute/shared`). `rememberable: false` marks destructive categories (no always-allow, SPEC §F6).

### 7.1 `GET /approvals?status=pending`

Response `200`: `{"approvals": [ … ]}`. Typically ≤ a handful; drives the global modal queue.

### 7.2 `POST /approvals/{id}/decision`

Request:

```json
{ "decision": "approved", "remember": "once" }
```

`decision`: `approved` | `denied` — the client-sendable values of the canonical `ApprovalDecision` union (`approved` | `denied` | `expired`; `expired` is set only server-side on expiry). `remember`: `once` (default) | `project` — valid only alongside `approved`; `project` additionally records a remembered grant keyed `(projectId, tool, hash(args))` (goose pattern).

Response `200` → approval object with `status: "approved" | "denied"`. Errors: `400 VALIDATION` (e.g., `remember` present alongside `denied`) · `404` · `409 CONFLICT` (already decided or expired) · `422 VALIDATION` (`remember: "project"` while `rememberable: false` — message: "destructive categories cannot be remembered").

### 7.3 `GET /audit?limit=100&offset=0&sessionId=`

Response `200`:

```json
{ "entries": [
  { "id": 991, "ts": "…", "sessionId": "sess_a7", "agentId": "agt_c1",
    "category": "shell", "action": "npm test -- --grep login",
    "decision": "approved", "reason": "user decision", "details": null }
], "total": 4102 }
```

Read-only; no update/delete route exists (immutable audit, ARCHITECTURE §5.1). Errors: `400`.

---

## 8. Providers (SPEC §F4)

Provider object:

```json
{ "id": "openai", "kind": "openai", "name": "OpenAI",
  "baseUrl": null, "configured": true, "keyNames": ["main"] }
```

`kind`: `anthropic` | `openai` | `google` | `openrouter` | `openai_compatible`. `configured` = at least one key present in the vault. **Key values never appear in any response.**

### 8.1 `GET /providers`

Response `200`: `{"providers": [ … ]}` — the four built-ins always listed (unconfigured ones flagged) plus user-added `openai_compatible` entries.

### 8.2 `POST /providers` — add a custom OpenAI-compatible provider

Request: `{"id": "groq", "name": "Groq", "baseUrl": "https://api.groq.com/openai/v1"}`.
Response `201` → provider object. Errors: `400 VALIDATION` (malformed URL, reserved id) · `409 CONFLICT` (id exists).

### 8.3 `POST /providers/{id}/keys` — add/replace a key (via shell)

The UI calls the Tauri command `store_provider_key(providerId, keyName, value)`; the shell persists to Windows Credential Manager and pushes to the sidecar via §2.3. The sidecar also exposes the REST route for completeness:

Request: `{"keyName": "main"}` (value arrives via the internal handoff; never accepted on this route). Response `202` `{"status": "pending_shell_handoff"}`. Errors: `401` · `404` · `400 VALIDATION`.

### 8.4 `DELETE /providers/{id}/keys/{keyName}` — revoke (via shell)

Response `204` (shell removes the credential and pushes `action: "remove"`). Errors: `404`.

### 8.5 `GET /providers/{id}/models`

Fetches (OpenAI-compatible: live `GET {baseUrl}/models`) or returns the cached catalog (native providers), cached in SQLite.

Response `200`:

```json
{ "models": [ { "id": "claude-sonnet-4", "name": "Claude Sonnet 4", "contextWindow": 200000, "vision": false } ],
  "cached": true }
```

Errors: `404` · `409 CONFLICT` (`configured: false`) · `502 PROVIDER_ERROR` (upstream fetch failed).

### 8.6 `POST /providers/{id}/test`

Request: `{"model": "claude-sonnet-4"}` (optional; default = provider's default). Sends a 1-token completion. Response `200`:

```json
{ "ok": true, "latencyMs": 640, "model": "claude-sonnet-4" }
```

Errors: `409 CONFLICT` (no key) · `502 PROVIDER_ERROR` `{"details":{"providerError":"401 invalid key"}}` · `429 RATE_LIMITED`.

---

## 9. Usage (SPEC §F7)

### 9.1 `GET /usage?from=&to=&groupBy=day|provider|model|agent|project|session&projectId=&sessionId=&limit=200`

All params optional. Response `200`:

```json
{ "groupBy": "day",
  "rows": [
    { "key": "2026-08-21", "requests": 214, "inputTokens": 812000, "outputTokens": 120400,
      "costUsd": 4.31, "costBySource": { "provider_reported": 3.90, "estimated": 0.41 } }
  ],
  "totals": { "requests": 214, "inputTokens": 812000, "outputTokens": 120400, "costUsd": 4.31 } }
```

`costBySource` preserves goose-style cost provenance (provider-reported vs estimated) so the dashboard can be honest (aider lesson). Live updates arrive as `usage.recorded` WS events; the dashboard refetches on event, never polls. Errors: `400 VALIDATION` (bad dates/groupBy).

---

## 10. Settings

### 10.1 `GET /settings`

Response `200`:

```json
{ "settings": {
  "theme": "dark",
  "denylist": [ "rm -rf /", "format *:", "git push --force*" ],
  "permissions": {
    "shell": "confirm", "fileWriteInWorkspace": "auto",
    "fileWriteOutsideWorkspace": "confirm", "webSearch": "confirm",
    "codeExec": "confirm", "networkEgress": "confirm",
    "approvalExpiryMinutes": 15
  },
  "defaults": { "providerId": "openrouter", "model": "anthropic/claude-sonnet-4",
                "orchestratorModel": "openai/gpt-5-mini", "visionModel": null },
  "memory": { "memoryCharLimit": 2200, "userCharLimit": 1375 }
} }
```

`auto` and `confirm` are the user-settable levels of the canonical `ToolPermission` union (`auto` | `confirm` | `blocked`); `blocked` is tool-static (§7.2 step 2) and `destructive` is an engine-internal fourth tier (always prompts, never rememberable) — neither is settable here.

### 10.2 `PATCH /settings`

Request: any subset at any depth (merge, not replace). Response `200` → full settings object. Errors: `400 VALIDATION` (unknown permission level, malformed pattern). Denylist changes take effect immediately (evaluated per-call, ARCHITECTURE §7.2).

---

## 11. Skills (SPEC §F8)

### 11.1 `GET /skills?projectId=`

Response `200`:

```json
{ "skills": [ { "id": "skl_git_rescue", "name": "git-rescue", "scope": "global",
  "path": "C:\\Users\\…\\acute-code\\skills\\git-rescue\\SKILL.md",
  "description": "Recover lost commits…", "enabledByDefault": false } ] }
```

### 11.2 `GET /skills/{id}`

Response `200`: skill object + `"markdown": "<full SKILL.md text>"`. Errors: `404`.

Per-agent enablement is part of the agent object (`skills: [names]`, §4) — there is no separate enable endpoint.

---

## 12. MCP (SPEC §F5)

MCP server object:

```json
{ "id": "mcp_github", "name": "github", "transport": "stdio",
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "url": null, "envKeys": ["GITHUB_TOKEN"],
  "enabled": true, "status": "connected",
  "tools": [ { "name": "create_issue", "permissionLevel": "confirm" } ] }
```

`status`: `stopped` | `connecting` | `connected` | `error`. `envKeys` are Credential Manager names — values never stored or returned.

### 12.1 `GET /mcp/servers`

Response `200`: `{"servers": [ … ]}`.

### 12.2 `POST /mcp/servers`

Request: server object without `id`, `status`, `tools`. Connection is lazy (first use). Response `201` → server object (`status: "stopped"`). Errors: `400 VALIDATION` · `409 CONFLICT` (name exists).

### 12.3 `PATCH /mcp/servers/{id}`

Request: `{"enabled": false}` or edits to command/args/url. Toggling `enabled` connects/disconnects. Response `200` → server object. Errors: `400` · `404`.

### 12.4 `DELETE /mcp/servers/{id}`

Kills the child process if running, removes config. Response `204`. Errors: `404`.

---

## 13. Endpoint summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness (no auth) |
| POST | `/internal/shutdown` | Shell teardown (internal) |
| POST | `/internal/providers/keys` | Shell key handoff (internal) |
| GET/POST | `/projects` · `GET/PATCH/DELETE /projects/{id}` | Project registry |
| GET/PUT | `/projects/{id}/files` · `/projects/{id}/file` · `POST/DELETE /projects/{id}/entries` | F1 file tree + editor, through the approval engine (§3.6–3.11) |
| GET/POST | `/projects/{id}/git/status` · `/git/diff` · `/git/log` · `POST /git/commit` | F9 git panel via the shell tool under the approval engine (§3.12–3.16) |
| GET/POST | `/agents` · `GET/PATCH/DELETE /agents/{id}` · `POST /agents/{id}/duplicate` | Agent registry |
| GET/PUT/DELETE | `/agents/{id}/memory` · `/agents/{id}/memory/{noteId}` | F8 user-editable memory notes — audit-logged, no modal (§4.7–4.11) |
| POST/GET | `/sessions` · `GET /sessions/{id}` · `POST /sessions/{id}/messages` · `POST /sessions/{id}/stop` · `GET /sessions/{id}/events` | Session lifecycle + backfill |
| WS | `/ws` | Auth frame → subscribe → event stream |
| GET | `/approvals` · `POST /approvals/{id}/decision` · `GET /audit` | Approval round-trip + audit |
| GET/POST | `/providers` · `POST /providers/{id}/keys` · `DELETE /providers/{id}/keys/{name}` · `GET /providers/{id}/models` · `POST /providers/{id}/test` | Provider management |
| GET | `/usage` | Cost/token aggregation |
| GET/PATCH | `/settings` | Settings incl. denylist |
| GET | `/skills` · `GET /skills/{id}` | Skill index |
| GET/POST | `/mcp/servers` · `PATCH/DELETE /mcp/servers/{id}` | MCP management |
