<!-- last-reviewed: 2026-08-30 round-50 -->
# IMPLEMENTED API — the shipped surface

**Truth = this file.** Verified against `agent-core/src/server.ts` at
round-17 (2026-08-23), refreshed R37→R50. The aspirational full contract (52
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
| `POST /internal/dialog/folder` | opens the REAL OS folder dialog. ROUND-48 (R48-b) rebuilt the Windows path: PRIMARY is the modern `IFileOpenDialog` COM picker (`FOS_PICKFOLDERS` etc. via inline C# interop), classic `FolderBrowserDialog` only as catch-fallback — EVERY dialog owned by a topmost invisible form so it lands ON TOP; PowerShell -STA / zenity / kdialog plumbing unchanged; always async. → `{path: string\|null, error?}` — plus an explicit `ERROR:<msg>` stdout line when both pickers fail (round-48 addition); `501 DIALOG_UNAVAILABLE` when no backend. Never called by tests (blocks on a human). |

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
`POST /providers/:id/test` `{model?, slot?}` (slot-scoped since ROUND-47)
→ `{ok, latencyMs}` or `{ok:false,message}` (HTTP 200) / `502` on transport
failure.

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
| `POST /sessions` | `{mode:"single", agentId (required, validated), projectId?, title?}` → `202` (queued). **ROUND-50: rows carry `permissionMode`** (`full\|ask\|plan\|editor`, default `ask`; sub-agent children copy the parent's mode at delegation) |
| `GET /sessions?limit=&offset=` | newest-first + total (NO projectId filter — client-side) |
| `GET /sessions/:id` | session + `events[]` + `lastSeq` (events embedded; no backfill route) |
| `PATCH /sessions/:id/permissions` | **ROUND-50** — `{mode: "full"\|"ask"\|"plan"\|"editor"}` → `200` the updated session + `events[]` + `lastSeq` (same shape as GET). `400 VALIDATION body.mode` otherwise, `404` unknown. Enforcement: `sessionToolAllowList` (runtime.ts — shared with the context route): *plan* intersects tools to the 12 read-only/research tools; *editor* strips `run_command`; *full* auto-approves every ask-tier gate EXCEPT the denylist-supreme (sudo/rm -rf/… never bypassed) while agent allowlists stay authoritative; the system prompt gains a PERMISSION MODE section. |
| `GET /sessions/:id/context?model=` | **ROUND-50 (the composer's context donut)** — `{model, providerId, contextWindow, usedTokens, breakdown:{systemPrompt, systemTools, memory, messages, meta, mcpTools:0}, cache:{inputTokens, cachedInputTokens, hitRate\|null}, sessionTotals:{inputTokens, outputTokens, requests, costUsd}}`. Window = models row → catalog → 200k. Breakdown via `buildSystemPromptSections` + estimateTokens (tool schemas ≈350 tokens/tool, documented approximation); MCP is an honest 0 (no MCP system). Cache from REAL `usage_events.cached_input_tokens` (migration 0020 — captured from the provider's `prompt_tokens_details.cached_tokens` on both turn paths). **ROUND-51: also returns `usage:{main, subagents, combined}` (each `{inputTokens, outputTokens, requests, costUsd}`)** — main = the session's own usage ledger (identical to the flat sessionTotals), subagents = the SUM over the DIRECT children's usage_events (`parent_session_id = :id`, listSubAgents parity, grandchildren excluded), combined = main + subagents. Flat fields byte-identical (additive shape). |
| `POST /sessions/:id/messages` | `{content, model?}` — **synchronous whole turn** → `200 {assistantMessage:{seq,role,agentId,content,ts}, usage}`; 404/409 (terminal/unconfigured/no key)/502 provider. **ROUND-50: also accepts `thinkingLevel?: "default"\|"low"\|"high"\|"max"` (400 otherwise; injected as `reasoning.effort` on chat-completions bodies) and `attachments?: [{name, path?, size?, text?}]` (≤20, name ≤200 chars, text capped 128 KB server-side; persisted on the `message.user` payload and rendered into model-facing history as `--- attached file: … ---` blocks)** |
| `POST /sessions/:id/messages/stream` | **SSE (the UI's primary path)** — same validation (incl. the ROUND-50 `thinkingLevel`/`attachments` fields); `text/event-stream` frames: `{type:"text-delta",delta}` · `{type:"thinking-delta",delta}` · `{type:"tool-call",toolName,argsSummary}` · `{type:"tool-result",toolName,argsSummary,ok}` · `{type:"finish",usage[,cachedInputTokens]}` · `subagent-status`/`subagent-event` envelopes (children stream their own live deltas — ROUND-50) · terminal `{type:"done",assistantMessage,usage}` or `{type:"error",status,code,message}`. **R42: a client disconnect does NOT abort the turn** — it completes in the background (events persist; the completion notification fires + Web Push delivers it to the closed window's service worker). A deliberate stop is `POST /sessions/:id/stop`. |
| `POST /attachments/read` | **ROUND-50** — `{paths: string[] (≤20), projectId?}` → `{files: [{path, name, size, text\|null, truncated, error?}]}`. Text = first 128 KB head (`truncated:true` when longer); NUL-in-first-8KB sniff → `text:null`; relative paths resolve ONLY inside `projectId`'s root (escape/missing project → per-file `error`, never a 500); absolute paths read as-is (user-picked). |
| `POST /internal/dialog/files` | **ROUND-50** — the multi-FILE OS picker (the composer's Attach files). Tauri `pick_files` (rfd, parented to the main window, topmost) inside the shell; PowerShell `OpenFileDialog` Multiselect fallback (R48 topmost-owner pattern) outside → `{files: string[]}` (`[]` = cancelled). Never called by tests (blocks on a human). |
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
context.compact   {summary, throughSeq, droppedMessages,          ← R46
                   tokensSaved} (one per compaction; the newest
                   filters assembly — see ROUND-46 additions)
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
| `POST /browser/session` | `{sessionId, projectId?}` → `{ticket}` — mints a random 192-bit ticket bound to the tab's session (rotates on re-mint; 12h TTL refreshed on use; dies with session eviction/deletion). **ROUND-48 (R48-d): this is now the ONLY route that rotates a ticket** — see the ROUND-48 section. ROUND-46 (R46-d): the optional `projectId` binds the session's COOKIE PROFILE (sticky for the session; absent → the shared `_default` profile — the frontend does not send it yet). |
| `DELETE /browser/session` | `{sessionId}` → drops tab state. The profile's cookie jar deliberately SURVIVES (closing a tab is not logging out). |
| `GET /browser/proxy?url=…&sessionId=…&bt=…` | Server-side fetch of the page: manual redirect walk (≤10 hops, every hop re-guarded), 20s deadline, 25 MiB cap, Range pass-through (206). HTML is rewritten (`<base href=FINAL-URL>` injected, links/assets/forms/styles re-proxied with `bt` echoed, script bodies placeholder-protected, CSP/XFO meta stripped, escape hatch injected before `</body>`); CSS `url()`/`@import` rewritten; everything else byte passthrough. Framing headers (XFO/CSP/COOP/COEP/HSTS) are never forwarded. Invalid/absent ticket → HTML 401 page (renders in-iframe). Scheme allowlist http/https; private-net guard (hostname-only, v1). ROUND-46 (R46-d): every hop runs through the per-profile COOKIE JAR (`browser_cookies`, migration 0017 — RFC 6265-lite parse, Cookie replayed per hop, Set-Cookie ingested per hop, durable across sidecar restarts, ≤200/profile; cookie values never logged/routed/returned; client Cookie headers never forwarded). **ROUND-49: every rewritten sub-resource URL is now ABSOLUTE against the sidecar's own origin** (derived from the request's Host header) — the injected `<base href=upstream>` used to hijack path-relative rewrites onto the upstream origin (every CSS/JS/img 404'd there → blank unstyled pages). **ROUND-49: sub-resource errors (a CSS/JS/img fetch whose upstream answers ≥400 or fails 502/504) return an EMPTY body with the upstream status + content-type** (signal: `sec-fetch-dest`; fallback: Accept) — navigations (document/iframe) keep the friendly HTML error card. |
| `POST /browser/proxy?url=…&bt=…` | Form passthrough (method + content-type + urlencoded/multipart body forwarded). |
| `GET /browser/history?sessionId=` | `{entries:[{url,title,ts}], index, canBack, canForward}` (LRU ≤32 sessions / ≤50 entries, forward-tail truncation on branch). |
| `POST /browser/navigate` | `{sessionId, url?, title?}` records/updates an entry, or `{sessionId, direction:"back"\|"forward"\|"reload"}` moves the pointer. **ROUND-48 (R48-d): no longer rotates the ticket** (uses non-rotating getOrCreate). |
| `GET /browser/viewport?sessionId=` / `PUT` | `{width,height,preset,zoom,rotate}` — presets `mobile-sm` 375×667 · `mobile-md` 390×844 · `tablet` 768×1024 · `laptop` 1280×800 (default) · `desktop` 1440×900 · `full-hd` 1920×1080 · `custom`; validation 200..3840 × 200..4320, zoom 0.25..3. This is the SAME state the BrowserPanel renders and the `browser_control` tool reads/writes. **ROUND-48 (R48-d): PUT no longer rotates the ticket** (uses non-rotating getOrCreate). |

The rewritten page's escape hatch posts `{type:"acute:open"\|"acute:title"\|"acute:location", …}` messages to the panel (no client cookies/Authorization are forwarded upstream — the ROUND-46 jar is the proxy's own state; no Set-Cookie is forwarded downstream either).

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
- **ROUND-51: the loop-hygiene guard (both turn paths).** A per-turn state
  machine (`createLoopGuard()`, runtime.ts) watches consecutive tool calls:
  **3 identical consecutive calls (tool name + canonical args) → ONE
  corrective nudge** rides the next outer iteration's in-memory messages
  (never persisted); **5 identical, or 6 consecutive FAILED calls → the turn
  stops honestly** — a persisted `turn.error` with `code: "LOOP_GUARD"`, a
  502 envelope, the session back to `queued` (retryable), usage tokens
  still recorded. The streamed path stops MID-STREAM. Inspired by
  deepseek-harness's guard plugin (MIT, ideas-only — see
  docs/research/deepseek-harness-notes.md).
- **ROUND-50: sub-agents stream their RAW deltas + carry stats.** When a
  channel exists, `delegateTask`/`retryChild` run the child through
  `runStreamedAgentTurn` — the child's `text-delta`/`thinking-delta`/
  `tool-call`/`tool-result`/`finish` frames ride the parent's SSE as
  `subagent-event` envelopes exactly like the main agent's own stream
  (channel-less runs keep the R48 fail-fast ask semantics).
  `subagent-status` frames and `/subagents` rows now carry `model` (the
  child's effective model); provider calls retry **5 total attempts**
  (AI SDK `maxRetries: 4`, up from the default 2 that produced the owner's
  "failed after three attempts").
- **ROUND-49: `GET/PUT /settings/memory` → `{enabled: boolean}`** (default
  `true`; `PUT` validates the type, else `400` with `body.enabled` named).
  While `false`: no memory digest is injected into any system prompt, the
  `memory_save/recall/list` tools are not registered, and the Memory panel
  renders an OFF notice (data is preserved). Sub-agent children NEVER
  receive the digest (independent context) regardless of the switch.
- **ROUND-49: nested delegation.** Children below `MAX_DELEGATION_DEPTH = 3`
  keep `delegate_task` (a sub-agent can spawn sub-agents — same tools, own
  context + key slot); at/beyond the cap the runtime strips it (recursion
  guard; `delegationDepth()` walks the `parent_session_id` chain,
  cycle-safe). Migration **0019** repairs the default agent allowlist that
  0014+0015 narrowed from `[]` (= ALL tools) to exactly the five appended
  tools on pre-R43 databases (fingerprint-scoped: deliberate restrictions
  and user-created agents are never touched).
- **ROUND-49: the tool-intent nudge** (both turn paths). A zero-tool
  iteration whose text EVIDENCES tool intent (names a real tool or
  announces delegation) spends the turn's ONE in-memory correction
  ("ACTUALLY CALLING the tool(s)…") and runs another iteration;
  conversational zero-tool replies still end immediately (ROUND-33), a
  second stall ends the turn, and the nudge is never persisted to the
  event log.
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

## ROUND-46 additions (implemented)

No new REST routes this round — the round shipped agent-runtime intelligence
(compaction, ranked memory), one frontend caller for an EXISTING route, and
cookie persistence inside the browser proxy.

- **`context.compact` session event** (persisted, append-only like every
  event): `{summary, throughSeq, droppedMessages, tokensSaved}` — appended
  when context compaction runs (`agent-core/src/agents/compaction.ts`).
  Assembly filters messages covered by the newest compaction's `throughSeq`
  and prepends the summary message; fork/revert inherit compactions for free
  (reverting past one resurrects the original messages). Readers that don't
  know the type skip it — the UI renders only known event types, so no
  frontend change was required.
- **`meta.compaction` SSE event** on the streamed turn path
  (`POST /sessions/:id/messages/stream`): emitted as
  `{type:"meta.compaction", summary, throughSeq, droppedMessages,
  tokensSaved}` when a NEW compaction is performed during that turn's outer
  loop, so a client can surface "context compacted". Informational only —
  not persisted as an SSE-visible session event itself (the persistent
  record is the `context.compact` event above).
- **`restoreCheckpoint` frontend fn + the (pre-existing) restore route** —
  `POST /checkpoints/:id/restore` has existed since round 25 but had NO
  caller (api fn or UI) until now; round 46 documented it here and added the
  missing CALLER: `restoreCheckpoint(checkpointId)` in `src/lib/api.ts` →
  `{restored: true, message: string}`. Route contract (server.ts): `404`
  unknown checkpoint id · `409 CONFLICT` when the checkpoint's session has
  no project (or the project row is gone) · `500 INTERNAL` on a restore
  failure · restores the file on disk from the snapshot's `before` content —
  a CREATE checkpoint (`before === null`) takes the unlink branch and
  DELETES the file, which is why the UI surface (the WorkingSection
  DiffDetail **Restore pill**: two-step confirm → toast +
  `project-tree`/`project-file` invalidation) HIDES the button for creates.
- **Browser-proxy cookie persistence** — behavior notes live inline with the
  ROUND-43 browser route table above (R46-d same-round update): per-profile
  SQLite cookie jars (`browser_cookies`, migration 0017), RFC 6265-lite
  parsing, Cookie replayed + Set-Cookie ingested on EVERY redirect hop,
  durable across sidecar restarts (session cookies BY DESIGN), ≤200/profile,
  values never logged/routed/returned, client Cookie headers never
  forwarded (test-proven). The optional `body.projectId` at ticket mint
  binds the cookie profile (sticky per session; the frontend does not send
  it yet — all tabs share `_default`).
- **Provider-call timeout** (not a route — a transport invariant): both chat
  adapters (`aiSdkChat`, `streamAiSdkChat` in `agent-core/src/agents/chat.ts`)
  now wire `AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS = 10 min)` — a
  stalled provider connection aborts into the normal turn-error path
  (`turn.error` + status reset + retryable 502) instead of hanging the turn
  forever; the streamed path combines it with the caller's abort signal via
  `AbortSignal.any`. Per-call `timeoutMs` still overrides.
- **Memory recall ranking** (tool behavior note): `memory_recall` now scores
  results by relevance (token-overlap ×2 + substring bonus + kind boost +
  importance×recency tie-break; zero-match rows dropped) instead of SQL
  LIKE substring order; `memory_save` dedups (same trimmed content
  case-insensitive → bumps `updated_at`, refreshes kind/source, reports
  "refreshed"). Wire shapes unchanged.

## ROUND-47 additions (implemented)

The provider-management reliability round. One route added, one removed, one
extended, one turn-time invariant — plus the frontend consolidation onto a
single API layer.

### NEW `GET /api/v1/models/catalog`

```
200 { "models": CatalogModel[],        // === MODEL_CATALOG (46 entries,
                                    // 18 free) — recommended-order free
                                    // block first, from storage/models.ts
      "defaultModelId": "z-ai/glm-5.2:free",
      "subagentDefaultModelId": "nvidia/nemotron-3.5-lightning:free",
      "recommendedModelIds": string[] }  // [0] === defaultModelId
```

Behind the same bearer wall (401 without). Constants-only — no cache, no DB
rows. This is the single source of truth every model picker consumes
(SubAgentsTab's 47-entry hand-copied catalog and AgentFormDialog's hardcoded
provider list were both deleted in R47 in its favor — the ROUTE-side drift
guard gap lesson #65 flagged).

### REMOVED `GET /api/v1/providers/:id/key`

**Removed-in-R47 — do not call it.** It returned the RAW key value,
contradicting the route group's keys-never-appear-in-any-response invariant;
ripgrep-verified zero callers existed (src/, src-tauri/, scripts/, onboarding/
only ever PUT). The path now 404s. `PUT /api/v1/providers/:id/key` at the
same path is UNCHANGED (204 — the settings UI saves keys through it), as are
the key-POOL routes (`GET /providers/:id/keys`, `PUT|DELETE
/providers/:id/keys/:slot` — masked listings only).

### EXTENDED `POST /api/v1/providers/:id/test` — body `{model?, slot?}`

```
slot omitted  → primary key (exact pre-R47 behavior, same 409 wording:
                "no API key stored for provider '<id>' — save one in Windows
                Credential Manager before testing")
slot given    → integer 0..31, else 400 VALIDATION { field: "body.slot",
                message: "slot must be an integer between 0 and 31" }
key probed    → the keyring POOL key for that slot: slot 0 == primary
                (ACUTE_PROVIDER_<ID>), slot N → ACUTE_PROVIDER_<ID>_SLOT<N>
empty slot    → 409 CONFLICT "no API key stored for provider '<id>' slot
                <n> — save one in Settings → Models & Providers",
                details { providerId, slot } — fetch never fires
result        → unchanged: 200 {ok:true, latencyMs, model?} |
                200 {ok:false, message} (ProviderTestError) |
                400 | 409 | 502 PROVIDER_ERROR (key-scrubbed)
```

`model` + `slot` combine: the one-token completion probe runs WITH THE SLOT
KEY. **Reorder note:** body validation (the model/slot 400s) now runs
BEFORE the primary-key 409 — an invalid body against a keyless provider
was 409 pre-R47 and is 400 now; no client relied on the old order (the
existing no-key test sends `{}`).

### Turn-time `PROVIDER_DISABLED`

`provider.enabled === false` is now enforced where it matters — at turn
start. `prepareTurn` (shared by the sync route, the streamed route, AND
orchestrator child turns) returns, before the key check (disablement — the
owner's explicit choice — wins over a missing key):

```
409 { code: "PROVIDER_DISABLED",
      message: "Provider '<name>' is disabled — enable it in Settings →
               Models & Providers",
      details: { providerId: "<id>" } }
```

Same propagation as the no-key 409: no user event appended (the session
stays clean/retryable); sync route → 409 envelope; streamed route → SSE
`{type:"error", status:409, code:"PROVIDER_DISABLED", message, details}`;
status < 500 → no task_failed notification (consistent with all 409s).
`PROVIDER_DISABLED` was added to the `TurnOutcome` error code union. The
Enabled toggle had been cosmetic since R37 (PATCH wrote the flag; turns
never read it).

### Frontend consolidation (not routes — the caller side)

All provider management now lives in ONE layer, `src/lib/api.ts`
("ROUND-47 (R47-c1)" section): `fetchProviders()` · `createProvider(input)`
· `updateProvider(id, patch)` · `deleteProvider(id)` ·
`storeProviderKey(id, value)` · `testProviderConnection(id, {model?,
slot?})` (an `ok:false` result at HTTP 200 RESOLVES — only transport/
agent-core failures throw `ApiError`) · `fetchModelsCatalog()` · the
models-config CRUD quartet (`fetchProviderModelConfig` /
`upsertProviderModelConfig` / `updateProviderModelConfig` /
`deleteProviderModelConfig`). ModelsProvidersTab's local `useApi()` — a third
parallel HTTP layer — was deleted; SubAgentsTab and AgentFormDialog consume
`fetchModelsCatalog` / `fetchProviders` through shared react-query cache
keys (`["models-catalog"]`, `["settings-providers"]`). `POST /providers`
still takes NO key in the body (never did) — keys travel via the PUT or the
Tauri shell.

## ROUND-48 additions (implemented)

The owner-test round. **No REST routes added or removed** — the round
changed SSE frame payloads, one response row shape, browser-proxy ticket
semantics, and the internal Windows folder-picker script behind an existing
route.

### SSE: `subagent-status` now carries `code`; sub-agent approvals ride the parent stream

The sub-agent SSE frames (on the PARENT's turn stream,
`POST /sessions/:id/messages/stream`; frame types existed since R43 but are
documented here for the first time):

```
{"type":"subagent-status", "sessionId":"<child>", "parentSessionId":…,
 "status":"queued"|"running"|"completed"|"failed", "task":…, "role":…,
 "code":"AB12",            // ROUND-48 (R48-e1): deterministic 4-char
                              // [A-Z0-9] code (FNV-1a of the child id,
                              // base36, last 4 uppercased) — same value as
                              // the code field on /sessions/:id/subagents
 "todosDone"?:number, "todosTotal"?:number}
                              // inputTokens/outputTokens/error are
                              // deliberately NOT here — poll-only via
                              // GET /sessions/:id/subagents

{"type":"subagent-event", "sessionId":"<child>", "parentSessionId":…,
 "inner":{"type":"tool-call"|"tool-result"|"text-delta"|"finish"|
          "approval.requested"|"approval.resolved", …}}
```

**ROUND-48 (R48-e1): a child delegated from a live parent turn is now
INTERACTIVE.** Its ask-tier approvals (`run_command` non-auto,
`web_fetch`/`browser_control` to non-allowlisted hosts) no longer fail
fast: `approval.requested`/`approval.resolved` inner frames flow through
the child's emit channel (= the orchestrator's wrappedEmit → these
`subagent-event` envelopes on the parent's SSE). The approval ROW is
created against the CHILD session; **the decision travels the existing
`POST /api/v1/approvals/:id/decision` route** (unchanged) and wakes the
child's waiter; the `permission_request` notification still publishes,
naming the child. Inner approval payloads: `approval.requested`
`{approvalId, toolName, argsSummary, category}` · `approval.resolved`
`{approvalId, decision, remember?}`. Channel-less runs (the plain sync
route, `retryChild`) KEEP the fail-fast — ask-tier rules themselves are
unchanged (children can now ASK; nobody bypasses allowlists). The parent
turn's AbortSignal also propagates into the child
(`delegateTask(…, emit?, signal?)`); an aborted child returns a 499
ABORTED outcome (no `turn.error`) and currently ends status `"failed"`.

### `GET /api/v1/sessions/:id/subagents` rows gain `code`

The R43 route is unchanged in shape EXCEPT every row now carries
`code: string` — the same deterministic 4-char `[A-Z0-9]` code as the
SSE envelope (`subAgentCode(sessionId)`, `storage/sessions.ts`), so the
UI can join the live status stream to the polled list and approval
attribution by either id or code. Rows otherwise unchanged (title,
subRole, status, todos, tokens, report, error).

### Browser proxy: tickets rotate ONLY at `POST /browser/session`

**ROUND-48 (R48-d):** `POST /browser/navigate`, `PUT /browser/viewport`,
and the proxy handler's header-authed adopt path now use the NEW
non-rotating `SessionStore.getOrCreate(sessionId)` (existing valid ticket
returned, TTL + LRU refreshed; mints only when the session is unknown or
the ticket expired). Ticket rotation happens ONLY in `POST
/browser/session` — the explicit re-mint whose response carries the fresh
ticket (the panel adopts it). This killed the owner-reported flash loop:
navigate/viewport used to rotate the ticket the iframe was still using,
whose dead `bt` then 401'd forever. No URL shapes, param names, response
bodies, or error pages changed.

### `POST /internal/dialog/folder` → the modern Windows picker

See the internal-routes table above — R48-b rebuilt `dialogs.ts`'
Windows path (modern `IFileOpenDialog` COM primary, topmost owner form for
EVERY dialog, classic fallback, `ERROR:` result line). The Tauri-side
`pick_folder` is now parented to the main webview window
(`src-tauri/src/dialogs.rs`) — compile-verified by CI's `cargo check`
only (no cargo in the sandbox); runtime verification is the owner's
re-test.

## ROUND-52 additions (implemented)

### Background jobs (run_command supervision — `agent-core/src/lib/background-jobs.ts`)

`run_command` (the `core-terminal` plugin) tracks `exit` and `close`
separately: a detached grandchild holding the output pipes (Windows
`start /B …`) or a clean Unix `cmd > log 2>&1 &` launch registers a
BACKGROUND JOB and the tool call resolves IMMEDIATELY with the job id +
polling instructions; a shell that never exits within `timeoutMs` (60s
default) is process-TREE-killed and resolved as `[timeout]`.

| Route | Shape |
| --- | --- |
| `GET /api/v1/jobs` | `{jobs: JobStatus[]}` — every tracked job, newest first. `?projectId=` scopes. |
| `GET /api/v1/jobs/:id` | `{job: JobStatus}` · `404 NOT_FOUND` unknown id. |
| `GET /api/v1/projects/:id/jobs` | `{jobs: JobStatus[]}` — the project's jobs (the Terminal panel's Background-jobs view polls this every 5s). |
| `POST /api/v1/jobs/:id/stop` | `{ok, output}` — best-effort stop (tree-kill a live launcher pid; POSIX process-group kill for detached jobs; pgrep/PowerShell command-line match for pipe-holders). Honest "still appears alive" report on failure. |

`JobStatus = {id, command, cwd, projectId, startedAt, status:
"running"\|"exited", exitCode, endedAt, pid, logFile, outputTail,
detached, ageMs, alive, logTail}`. Jobs are process-local (one sidecar =
one registry), capped at 100 / pruned after 12h. Agent-side tools:
`job_status {job?}` (inspect/list, output tail + log tail) and
`job_stop {job}`.

### SSE: `tool-output` frames + supervision payloads

`POST /sessions/:id/messages/stream` additionally emits
`{type:"tool-output", toolName:"run_command", argsSummary, chunk}` —
batched (~400ms) live stdout/stderr while a command runs (rendered as the
live terminal tail by the working section / sub-agent panel; stripped
when the tool-result settles the entry). `subagent-status` running frames
carry `watch?: {lastEventAgeMs, lastActivity, toolCount, todosDone,
todosTotal, elapsedMs, stalled}` (the supervisor's 15s heartbeat sample)
and terminal frames carry `detail?: string` ("stopped by the owner" /
"stalled — …"). Inner `subagent-event` frames carry the same
`tool-output` shape for a child's running commands.

### Sub-agent stop (the shared turn registry)

`POST /sessions/:id/stop` now ALSO stops sub-agent children: the
orchestrator registers each running child in `lib/turn-registry.ts` (the
same map the server uses for main turns), so stopping a CHILD session id
aborts only that child — the parent keeps running and its `delegate_task`
result reports "STOPPED BY THE OWNER" (or "STALLED" for the watchdog's
abort after `childStallTimeoutMs`).

### Orchestration settings

`GET/PUT /settings/orchestration` gain `childWatchdogMs` (15000 default,
5s–60s) and `childStallTimeoutMs` (300000 default, 1–60min) — the
supervisor heartbeat cadence and the stall threshold (Settings →
Sub-agents exposes them in seconds/minutes).

### `GET /api/v1/usage/detailed?days=1..90`

`{days:[{date,inputTokens,outputTokens,requests,costUsd}](zero-filled),
totals:{projects,sessions,subagentSessions,toolCalls,requests,tokens,
costUsd}, tools:[{name,count,failures}], models:[{model,requests,
inputTokens,outputTokens,cachedInputTokens,totalTokens,costUsd}],
projects:[{id,name,color,lastActivity,sessions:[…],subagentCount,
toolCalls, models:[…], totals:{…}}]}` — a faithful port of
export-usage.mjs's aggregation with a PRIVATE shape (raw ids/titles — the
public export is the redacted one). `days` scopes ONLY the activity
series; totals/tools/models/projects are whole-history. Session rows
carry `{id, title, status, model, isSubagent, parentId, subRole,
subagentCount, startedAt, endMs, durationMs, requests, tokens, toolCalls,
costUsd, tools:[{name,count,failures}]}`; children stay nested under
their parent's project; orphans land in a synthetic unassigned group.
Default 30; `400 VALIDATION` outside 1–90.

## NOT implemented (despite API.md)

`/ws` (no WS gateway — SSE per-turn instead) · `/internal/shutdown` ·
project file writes over REST · git/skills/mcp/settings routes ·
audit_log routes (approvals ARE implemented — see above) ·
session events-backfill · connection-test/model-listing for
non-chat-completions providers (manual model rows work) ·
dev port is **5178**, not 8765.
