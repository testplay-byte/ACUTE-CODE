<!-- last-reviewed: 2026-08-26 round-42 -->
# IMPLEMENTED API — the shipped surface

**Truth = this file.** Verified against `agent-core/src/server.ts` at
round-17 (2026-08-23). The aspirational full contract (52 operations, WS
gateway, planned routes) lives in [`API.md`](API.md) — anything there and
not here **does not exist yet**. Base: `http://127.0.0.1:<port>`; dev port
**5178** (`ACUTE_PORT`), dev token `acute-dev-local`.

## Conventions

Every route except `GET /health` requires `Authorization: Bearer <token>`
(401 otherwise, constant-time compare). Errors:
`{error:{code, message, details?}}`. CORS allowlist: tauri hosts + the two
vite dev origins.

## Health & internal (root-mounted, NOT under /api/v1)

| Route | Behavior |
|---|---|
| `GET /health` | no auth → `{status:"ok", app:"acute-code", version}` |
| `POST /internal/providers/keys` | shell-only key rotation: `{providerId, value, action?: "set"\|"delete"}` → `204` |
| `POST /internal/dialog/folder` | opens the REAL OS folder dialog (PowerShell ×3 methods / zenity / kdialog; always async). → `{path: string\|null, error?}`; `501 DIALOG_UNAVAILABLE` when no backend. Never called by tests (blocks on a human). |

## /api/v1/agents

| Route | Notes |
|---|---|
| `GET /agents?includeTemplates=` | list; `false` excludes the 5 templates (default agent "Acute" remains — seeded at DB open, fixed id `agt_default_nova`, provider openrouter / model `stealth/ox-alpha`) |
| `POST /agents` | `AgentDraft` → `201`. `allowedTools` validated against the REAL 7-tool list (`list_dir, read_file, write_file, edit_file, create_dir, delete_file, search_files`) — SPEC-era names 400 (ADR-0019). Empty list = ALL tools. |
| `GET/PATCH/DELETE /agents/:id` | PATCH bumps version; DELETE 409 `{reason:"template"}` for templates |
| `POST /agents/:id/duplicate` | `{name?}` → `201` |

## /api/v1/providers

`GET /providers` → `{providers:[{id,name,kind,baseUrl,enabled,hasKey}]}` ·
`POST /providers` (custom openai-compatible) ·
`GET /providers/:id/models` (5-min cache) ·
`POST /providers/:id/test` `{model?}` → `{ok, latencyMs}` or
`{ok:false,message}` (HTTP 200) / `502` on transport failure.

## /api/v1/projects

`GET /projects` newest-first · `POST /projects` `{name, rootPath (absolute,
must EXIST, unique), color?}` → `201` (400 folder-missing, 409 duplicate) ·
`GET /projects/:id` · `DELETE /projects/:id` → `204` ·
`GET /projects/:id/tree` → `{tree:[TreeNode], rootPath}` (depth 8 / 500 per
dir; ignores node_modules/.git/dist/… ) ·
`GET /projects/:id/file?path=<rel>` → `{path, content}` (256 KB cap,
containment-enforced).

## /api/v1/sessions & turns

| Route | Contract |
|---|---|
| `POST /sessions` | `{mode:"single", agentId (required, validated), projectId?, title?}` → `202` (queued) |
| `GET /sessions?limit=&offset=` | newest-first + total (NO projectId filter — client-side) |
| `GET /sessions/:id` | session + `events[]` + `lastSeq` (events embedded; no backfill route) |
| `POST /sessions/:id/messages` | `{content, model?}` — **synchronous whole turn** → `200 {assistantMessage:{seq,role,agentId,content,ts}, usage}`; 404/409 (terminal/unconfigured/no key)/502 provider |
| `POST /sessions/:id/messages/stream` | **SSE (the UI's primary path)** — same validation; `text/event-stream` frames: `{type:"text-delta",delta}` · `{type:"tool-call",toolName,argsSummary}` · `{type:"tool-result",toolName,argsSummary,ok}` · `{type:"finish",usage}` · terminal `{type:"done",assistantMessage,usage}` or `{type:"error",status,code,message}`. **R42: a client disconnect does NOT abort the turn** — it completes in the background (events persist; the completion notification fires + Web Push delivers it to the closed window's service worker). A deliberate stop is `POST /sessions/:id/stop`. |
| `POST /sessions/:id/stop` | **R42** — explicitly aborts the live streamed turn for the session → `{ok:true, stopped:boolean}`; the stream resolves with `{type:"stopped"}` (NOT an error; no task_failed notification). |

`model` on either turn route overrides the agent's model for that call
(ADR-0015). Usage on streamed turns = awaited totals cross-checked against
per-step sums (some providers only report per-step).

## Event log (ADR-0010, append-only, per-session `seq`)

```
message.user      {role:"user", content, agentId, ts}
tool.use          {role:"tool", toolName, argsSummary, ok, agentId, ts}
                  (one per executed call, appended as each completes)
message.assistant {role:"assistant", content, agentId, ts,
                   usage:{inputTokens,outputTokens}, ms, model}   ← R16 stats
```

`message.assistant` payload stats power the per-reply chips in the UI.

## /api/v1/usage

`GET /usage/summary?days=1..90` → `{days:[{date,inputTokens,outputTokens,
requests,costUsd}], totals, generatedAt}` (zero-filled, UTC; `costUsd`=0
until estimation lands).

## ROUND-37 additions (implemented)

- `GET /api/v1/approvals?status=pending&projectId=` → `{approvals: [...]}`
  (ADR-0024; pending/approved/denied/expired rows with toolCall, category,
  remember, timestamps).
- `POST /api/v1/approvals/:id/decision` `{decision: approved|denied,
  remember?: once|always}` → resolves the waiting tool call; `always` writes
  a project-scoped EXACT-match rule; `always` on a destructive approval
  silently downgrades to `once` (hard rule).
- SSE turn stream now carries `approval.requested` /
  `approval.resolved` events; both also persist as session events (they fold
  into the turn's working section in the UI).
- `PATCH /api/v1/providers/:id` + `DELETE /api/v1/providers/:id` now apply
  to ALL providers — built-ins included (deleting one tombstones it so the
  boot seed doesn't resurrect it; re-adding via `POST /providers` with the
  reserved id clears the tombstone). `apiFormat` selects the wire protocol:
  `chat-completions` (default) | `anthropic-messages` | `responses` — all
  three are wired in chat.ts; anthropic/responses are unit-tested only (no
  live keys — honest limitation).
- Structured logging: JSON lines to stdout + `.dev/acute.log`
  (`ACUTE_LOG_PATH`/`ACUTE_LOG_LEVEL` env overrides) — turn lifecycle, tool
  calls (names + argsSummary only), approval lifecycle, boot sweeps.

## ROUND-42 additions (implemented)

- `GET /api/v1/notifications/push/key` → `{publicKey}` (the machine's VAPID
  public key; `503 UNAVAILABLE` when the sidecar has no dataDir — tests).
- `POST /api/v1/notifications/push/subscribe` `{endpoint, keys:{p256dh,auth}}`
  → `{ok:true}` (upsert by endpoint; 400 on malformed bodies).
- `POST /api/v1/notifications/push/unsubscribe` `{endpoint}` → `{ok:true}`.
- Every published notification (task complete/failed, permission requests,
  sub-agent transitions) is fanned out via Web Push to every stored
  subscription (fire-and-forget; 404/410 endpoints pruned).
- `task_complete` now fires for EVERY successful streamed turn (the R40
  didWork gate is gone); `task_failed` only for outcomes with status ≥ 500
  (404/409 request errors stay quiet).
- Boot sweep (ADR-0022): a `running` session whose LAST event is
  `message.assistant` returns to `queued` (idle conversation — alive);
  only genuine mid-turn crashes go to `failed`.

## NOT implemented (despite API.md)

`/ws` (no WS gateway — SSE per-turn instead) · `/internal/shutdown` ·
project file writes over REST · git/memory/skills/mcp/settings routes ·
audit_log routes (approvals ARE implemented — see above) ·
session events-backfill · connection-test/model-listing for
non-chat-completions providers (manual model rows work) ·
dev port is **5178**, not 8765.
