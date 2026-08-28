<!-- last-reviewed: 2026-08-28 round-45 -->
# IMPLEMENTED API — the shipped surface

**Truth = this file.** Verified against `agent-core/src/server.ts` at
round-17 (2026-08-23), refreshed R37→R45. The aspirational full contract (52
operations, WS gateway, planned routes) lives in
[`API.md`](API.md) — anything there and
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
| `GET /agents?includeTemplates=` | list; `false` excludes the 5 templates (default agent "Acute" remains — seeded at DB open, fixed id `agt_default_nova`, provider openrouter / model `z-ai/glm-5.2:free` since R43/migration-0013; was the dead `stealth/ox-alpha`) |
| `POST /agents` | `AgentDraft` → `201`. `allowedTools` validated against the REAL tool list (`TOOL_NAMES`, **21 tools** incl. `delegate_task` + `browser_control` since R43 and `memory_save`/`memory_recall`/`memory_list` since R44) — SPEC-era names 400 (ADR-0019). Empty list = ALL tools. |
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
containment-enforced) ·
`POST /projects/:id/terminal` `{command}` → `{stdout, stderr, exitCode, ms}`
(synchronous run, 60s timeout / 64 KB combined cap; R44 adds a streaming
variant — see ROUND-44 additions).

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

## ROUND-43 additions (implemented)

### Embedded browser (proxy + per-tab tickets) — `agent-core/src/browser-proxy.ts`

All under `/api/v1`, bearer-gated EXCEPT the proxy itself which authenticates
per-request with a short-lived `bt` ticket (iframes cannot send Authorization
headers):

| Route | Contract |
|---|---|
| `POST /browser/session` | `{sessionId}` → `{ticket}` — mints a random 192-bit ticket bound to the tab's session (rotates on re-mint; 12h TTL refreshed on use; dies with session eviction/deletion). |
| `DELETE /browser/session` | `{sessionId}` → drops tab state. |
| `GET /browser/proxy?url=…&sessionId=…&bt=…` | Server-side fetch of the page: manual redirect walk (≤10 hops, every hop re-guarded), 20s deadline, 25 MiB cap, Range pass-through (206). HTML is rewritten (`<base href=FINAL-URL>` injected, links/assets/forms/styles re-proxied with `bt` echoed, script bodies placeholder-protected, CSP/XFO meta stripped, escape hatch injected before `</body>`); CSS `url()`/`@import` rewritten; everything else byte passthrough. Framing headers (XFO/CSP/COOP/COEP/HSTS) are never forwarded. Invalid/absent ticket → HTML 401 page (renders in-iframe). Scheme allowlist http/https; private-net guard (hostname-only, v1). |
| `POST /browser/proxy?url=…&bt=…` | Form passthrough (method + content-type + urlencoded/multipart body forwarded). |
| `GET /browser/history?sessionId=` | `{entries:[{url,title,ts}], index, canBack, canForward}` (LRU ≤32 sessions / ≤50 entries, forward-tail truncation on branch). |
| `POST /browser/navigate` | `{sessionId, url?, title?}` records/updates an entry, or `{sessionId, direction:"back"\|"forward"\|"reload"}` moves the pointer. |
| `GET /browser/viewport?sessionId=` / `PUT` | `{width,height,preset,zoom,rotate}` — presets `mobile-sm` 375×667 · `mobile-md` 390×844 · `tablet` 768×1024 · `laptop` 1280×800 (default) · `desktop` 1440×900 · `full-hd` 1920×1080 · `custom`; validation 200..3840 × 200..4320, zoom 0.25..3. This is the SAME state the BrowserPanel renders and the `browser_control` tool reads/writes. |

The rewritten page's escape hatch posts `{type:"acute:open"\|"acute:title"\|"acute:location", …}` messages to the panel (no cookies/Authorization are forwarded either direction — logins do not persist through the proxy in v1).

### Agent tool `browser_control` (19th tool)

`{action: "navigate"\|"back"\|"forward"\|"reload"\|"set_viewport"\|"get_state", sessionId, url?, width?, height?, preset?}` — drives the same viewport/history state as the panel; `get_state` returns `{url, title, viewport}`. Prompt guide tells the agent it can test layouts at display sizes.

### Orchestration + turn-error additions

- `GET/PUT /settings/orchestration` now carries `subagentModel: string | null`
  (default `null` = children inherit the parent agent's model). Writes are
  validated: must be a known catalog id AND tool-capable (`supportsTools`),
  else `400`. Applied by `delegateTask`/`retryChild` to every child turn;
  agent records are never rewritten. Migration 0013 retired the dead
  default model (`stealth/ox-alpha` → `z-ai/glm-5.2:free`, conservative
  openrouter-scoped rewrite + audit row); migration 0014 appended
  `delegate_task` + `browser_control` to seeded template allowlists
  (delegation was unreachable from seeded agents before it).
- **`turn.error` session event** (persisted): failed turns append
  `{code, message, model, providerId, providerError (secret-scrubbed),
  userSeq}` and flip the session back to `queued` (retryable). The SSE
  terminal error frame is `{type:"error", status, code, message,
  details:{providerError, model, userSeq, errorTs}}`; a user STOP still
  persists nothing (`{type:"stopped"}` — stop ≠ error).
- OpenRouter free-model **fallback chain**: requests on a `:free` model
  are rewritten server-side to `models: [model, "openrouter/free"]` so the
  provider retries across free models on 429/deprecation.
- Static model catalog (46 entries: 18 free + 28 paid) with capability
  flags in `agent-core/src/storage/models.ts`; the DB `models` table
  remains the override store.

## ROUND-44 additions (implemented)

### Session intelligence — search / fork / revert

| Route | Contract |
|---|---|
| `GET /sessions?q=<text>&limit=&offset=` | **R44 search** — when `q` is a non-empty trimmed string, `searchSessions` LIKE-matches against the session title AND the event payload JSON (so tool calls and messages are searchable); response is the same shape as the plain list (`{sessions, total}`) but `total` = result count (search is not paginated). Newest-first. |
| `POST /sessions/:id/fork` | Copies the session row + its FULL event log under a NEW top-level session id, title prefixed `"Fork · <original>"`; usage rows are NOT carried over → `201 {session}`. `404` unknown source. |
| `POST /sessions/:id/revert` | `{keepThroughSeq: integer >= 0}` — deletes every event AFTER that seq (the user message AT `keepThroughSeq` survives; its reply + later turns are removed) and appends one `session.reverted` marker event → `200 {ok:true, removedCount}`. `404` unknown session · `409 CONFLICT` while a turn is running (deleting under a live stream would race it) · `400` bad body. |

The UI surfaces these as the Sessions screen's debounced search + hover Fork
action, and the chat's user-message hover "Revert to this message" (with a
confirm dialog).

### Project memory (per-project persistent knowledge)

| Route | Contract |
|---|---|
| `GET /projects/:id/memory` | `{memories: [...]}` — newest-first, capped at 100; each `{id, projectId, kind, content, source, createdAt, updatedAt}` with `kind` ∈ fact\|decision\|preference\|note. `404` unknown project. |
| `DELETE /projects/:id/memory/:memoryId` | `{ok:true}` · `404` unknown project or memoryId. |

There is deliberately **no REST create** — memory is the agent's channel
(the `memory_save` tool); the routes exist to READ and prune.

**Agent tools 20–22:** `memory_save {content, kind?}` (content trimmed,
capped at 4000 chars; kind validated case-insensitively) · `memory_recall
{query?, limit?}` (LIKE search, content-substring matches ranked before
kind-only, default limit 12) · `memory_list {limit?}` — all fail gracefully
with `ok:false` outside a project session. For project sessions the newest
memory slice (pre-formatted digest, ~1500 chars, whole-line granularity) is
auto-injected into every turn's system prompt as a
`## Project memory (persisted across sessions)` section by
`prepareTurn`. Migration `0015_memory.sql` creates the table + appends the
three tools to seeded template allowlists (0014 pattern, audit-logged).

### Streaming terminal

`POST /projects/:id/terminal/stream` `{command, timeoutMs?, maxBytes?}` —
SSE like the chat stream: `text/event-stream` frames
`data: {"type":"stdout","text":…}` · `{"type":"stderr","text":…}` ·
`{"type":"exit","code":N|null,"ms":N}` (code null = killed by signal) ·
`{"type":"error","message":…}` (timeout / output cap / spawn failure; no
exit frame follows an error — no honest exit code exists for a command the
server killed) + `: ping` comment heartbeats (a leading ping immediately on
connect, then every 10s). Same containment as the sync route (cwd = project
root, `shell:true`, FORCE_COLOR=0). **Client disconnect KILLS the child**
(an interactive command has no reader to return to — deliberate divergence
from chat turns, which complete in the background). Body overrides can only
SHRINK the server budgets: `timeoutMs` 250..60000 (default 60000) and
`maxBytes` 256..65536 (default 65536); anything else `400` with the field
name in details. `404` unknown project; empty command `400`.

### Web search is a real general search now

`web_search` (tool) runs a 3-tier chain, zero new deps: (1)
`html.duckduckgo.com/html/?q=` (parsed from `result__a`/`result__snippet`
anchors, `uddg=` redirect unwrap, ads/self-links stripped), (2)
`lite.duckduckgo.com/lite/?q=` on failure/empty, (3) the old MediaWiki
encyclopedia search as honestly-labeled last resort ("general web search
unavailable — showing encyclopedia results"). Up to 8 results
(was 6). Parsers are exported (`parseDdgHtml`/`parseDdgLite`) and unit-tested
against fixtures; live-verified from the sandbox (8 real results).

### Sub-agent keys via credentials.txt (launcher)

`launcher/acute_launcher.py` now parses optional
`OPENROUTER_SUB1..3_KEY` lines from `credentials.txt` (auto-APPENDING the
lines with the baked-in defaults when missing, per the owner's "no manual
entry" directive) and distributes them to keyring pool slots 2/3/4 as
`ACUTE_PROVIDER_OPENROUTER_SLOT{2,3,4}` env at sidecar spawn (Windows
Credential Manager on the owner's PC; `~/.acute/openrouter-slotN.key` fallback).
`scripts/dev.mjs` mirrors the env→file→Credential-Manager lookup per slot.
Settings → Sub-agents then shows slots 2/3/4 with zero manual pasting.

## ROUND-45 additions (implemented)

### Security round (audit P0-3/P0-4/P0-5)

- **Child env scrubbing (P0-3)** — not a route, a spawn-site invariant: every
  child the sidecar spawns (`run_command`, git tools, OS folder dialogs, both
  terminal routes, terminal sessions) gets an ALLOWLIST environment via
  `buildChildEnv()` (`agent-core/src/lib/child-env.ts`) — OS/toolchain vars
  + `FORCE_COLOR=0`/`CI=1`, never `ACUTE_TOKEN` or `ACUTE_PROVIDER_*`
  (secret-shaped names are dropped even if allowlisted).
- **`run_command` AUTO tier is path-contained (P0-4)** — tool behavior note:
  `decideCommand` now takes the project `root`; an auto-tier candidate whose
  tokens touch an absolute path outside the root, a `~` path, a `..`-escape,
  or a Windows other-drive path is demoted to the ASK tier (`cat /etc/passwd`
  asks now). Explicit always-allow rules still win. Token-based (quoted-token
  aware, compound-safe), not a sandbox — approved commands run with full
  user privileges.
- **Web host gate (P0-5)** — `web_fetch` and `browser_control:navigate`
  calls pass `decideWebFetch(db, projectId, url)`: http/https only; host on
  `DEFAULT_WEB_HOST_ALLOWLIST` (37 exact doc/package/source hosts) or a
  per-project `web_host_rules` row (migration 0016) → run; otherwise the
  SAME interactive approval round-trip commands use — approval rows carry
  **category `"web"`** with the URL as the payload, and "always allow"
  remembers the **HOST** (`web_host_rules`, not the URL; rule rows are
  project-scoped). Non-interactive contexts fail closed (blocked, never
  silently fetched). Other `browser_control` actions stay auto.
  `web_search` stays friction-free but its query is secret-scrubbed
  (`scrubSearchQuery` — keyring values + key-shaped patterns) before leaving
  the machine.

### Terminal sessions (persistent interactive shells — REST + SSE)

All under `/api/v1/projects/:id/…`; every route 404s an unknown project, and
session ids are verified to belong to that project (cross-project ids 404 —
never leak).

| Route | Contract |
|---|---|
| `POST /projects/:id/terminal-sessions` | `{cols? 20..500, rows? 10..200}` (defaults 120×30) → `201 {id, engine:"pty"\|"pipe", createdAt}`. The engine is chosen server-side at try-load (node-pty optionalDependency; persistent-pipe fallback) and reported back — the UI echoes locally on `pipe` (no TTY echo). `503 UNAVAILABLE` on spawn failure. Caps: 3 sessions/project, 8 global — creating over a cap kills the OLDEST session of that scope (new tabs always work). |
| `GET /projects/:id/terminal-sessions` | `{sessions: [{id, engine, createdAt}…]}` — the project's LIVE sessions, oldest first. |
| `POST /projects/:id/terminal-sessions/:tsid/input` | `{data}` (string ≤ 8 KB) → `204` — written to the shell's stdin (append your own `\n`). `400` non-string/oversize; `404` unknown/cross-project. |
| `POST /projects/:id/terminal-sessions/:tsid/resize` | `{cols 20..500, rows 10..200}` (BOTH required) → `204`; resizes the pty, a documented no-op on the pipe engine. |
| `GET /projects/:id/terminal-sessions/:tsid/stream` | **SSE** (R44-e mechanics: hijack + leading `: ping` + 10s heartbeats). Frames: `{"type":"output","text":…}` (the FIRST output frame carries the full ring-buffer backlog — 256 KB, oldest-dropped — for late subscribers; subscribe happens synchronously before backlog, so no gap/dupe) · `{"type":"exit","code":N\|null}` (null = killed; the response ENDS after this frame) · `{"type":"error","message":…}`. **Client disconnect only unsubscribes — the SESSION SURVIVES its viewers** (the deliberate divergence from the one-shot R44-e stream). |
| `DELETE /projects/:id/terminal-sessions/:tsid` | Kills the shell → `204` (viewers get the exit frame). `404` unknown. |

Lifecycle: cwd = project root, env = `buildChildEnv()` (P0-3 applies to PTY
children). Idle reaping kills a session after **10 min with NEITHER input NOR
output** (a streaming build is never reaped). Natural shell exit removes the
record. All sessions are disposed on app close + SIGTERM/SIGINT (no orphan
shells). The TerminalPanel exposes this as the **Run \| Shell** mode toggle
(Run mode = the R44-e one-shot stream, unchanged).

### Versioning & release (packaging v1)

No new HTTP endpoints — the app version is single-sourced at **0.45.0**
across root `package.json`, `agent-core`, `shared`, `src-tauri/tauri.conf.json`
(`scripts/release/version.mjs` `get`/`set`/`check`), `pnpm version:check`
**gates CI** right after install (drift = red build), and
`.github/workflows/release.yml` assembles the launcher-kit zip + tag-gated
draft release (verified: run 33182499163, artifact
`acute-launcher-kit-v0.45.0`). `GET /health` reports the same version.

## NOT implemented (despite API.md)

`/ws` (no WS gateway — SSE per-turn instead) · `/internal/shutdown` ·
project file writes over REST · git/skills/mcp/settings routes ·
audit_log routes (approvals ARE implemented — see above) ·
session events-backfill · connection-test/model-listing for
non-chat-completions providers (manual model rows work) ·
dev port is **5178**, not 8765.
