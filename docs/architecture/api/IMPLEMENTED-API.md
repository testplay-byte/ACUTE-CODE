<!-- last-reviewed: 2026-09-23 round-122 -->
# IMPLEMENTED API — the shipped surface

**Truth = this file.** Verified against `agent-core/src/server.ts` +
`agent-core/src/routes/<domain>.ts` (the R84 split moved 71 of 131 routes
into 14 domain modules) + `browser-proxy.ts`; established round-17
(2026-08-23), refreshed continuously since (R37→R85, then R113, then
R114; the R80.5
backfill of 11 previously-undocumented routes + the R85 backfill of
`GET /providers/:id/models-config` + the R113 live-sync additions + the
R114 sync-foundation additions — see the ROUND-80.5, R113, and R114
sections at the end).
The
aspirational full contract (52
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
| `POST /agents` | `AgentDraft` → `201`. `allowedTools` validated against the REAL tool list (`TOOL_NAMES`, **26 tools** — incl. `delegate_task` + `browser_control` since R43, `memory_save`/`memory_recall`/`memory_list` since R44, `job_status`/`job_stop` since R52, `read_skill` since R61, `analyze_image` since R66, `switch_mode` since R73, and `ask_user` since R87) — SPEC-era names 400 (ADR-0019). Empty list = ALL tools. The 31 computer-use tools are deliberately NOT allowlist vocabulary (settings-gated, default OFF); `mcp__<server>__<tool>` names are dynamic (server-config-derived). |
| `GET/PATCH/DELETE /agents/:id` | PATCH bumps version; DELETE 409 `{reason:"template"}` for templates |
| `POST /agents/:id/duplicate` | `{name?}` → `201` |

## /api/v1/providers

`GET /providers` → `{providers:[{id,name,kind,baseUrl,enabled,hasKey,
keyCount,configured}]}` (`hasKey` pool-aware + `configured` since R113 — see
the R113 additions at the end) ·
`POST /providers` (custom openai-compatible) ·
`GET /providers/:id/models` (5-min cache; R120-M — each entry
additively carries `details` {contextWindow, maxOutputTokens, the
USD/Mtok pricing trio, supportsTools/Vision/Audio/Video} parsed off the
provider's OpenRouter-shaped listing fields, absent on plain OpenAI
listings) ·
`GET /providers/:id/models-config` (round-19, backfilled R85 — the per-provider
saved model rows incl. hidden ones; the admin/models-config listing the
frontend quartet reads; 404 unknown provider) ·
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
variant — see ROUND-44 additions) ·
`GET /projects/:id/modes` → `{modes:[{id,name,description,source,readOnly}]}` (R81: `readOnly` is always `false` — postures are non-enforcing; the field is kept for wire compat)
(**R73**: the task-mode index for the session's project — the six builtins
+ the project's `.acute/agents/*.md` customs, METADATA ONLY; see the
ROUND-73 additions. **R75**: `readOnly` is true for plan/review/explore —
the mode-policy enforcement tier, so the picker badges them without
duplicating the set).

## /api/v1/sessions & turns

| Route | Contract |
|---|---|
| `POST /sessions` | `{mode:"single", agentId (required, validated), projectId?, title?}` → `202` (queued). **ROUND-50/R81: rows carry `permissionMode`** (`full\|ask\|plan`, default `ask`; the retired `editor` reads as `ask`; sub-agent children copy the parent's mode at delegation) |
| `GET /sessions?limit=&offset=` | newest-first + total (NO projectId filter — client-side). **R114: rows carry `selectedModel`** (`{providerId, model}\|null` — the server-side session model tier, migration 0041; null = follow the agent default) |
| `GET /sessions/:id` | session + `events[]` + `lastSeq` (events embedded; no backfill route). **R73/R81: rows carry `activeMode`** (the active POSTURE id or `null`; set/cleared via PATCH below or the agent's `switch_mode` tool — non-enforcing guidance since R81; see ROUND-73 additions). **R114: rows carry `selectedModel`** (see the R114 additions at the end) |
| `PATCH /sessions/:id` | **round-33 (rename) · R73 (mode switch) · R81 (posture pointer) · R114 (selected model)** — body `{title?, activeMode?, model?}`, each independently optional: `title` (string ≤200) renames; `activeMode` is a POSTURE id (resolved against the session's project — projectless resolves builtins only; unknown → `400 VALIDATION` with `availableModes` in details, validated BEFORE any write), `null` clears, absent = untouched; `model` is the session's server-side selected-model pair (`{providerId, model}\|null` — see the R114 additions; validated BEFORE any write). `200` the bare updated session row (NOT the GET shape — no `events`/`lastSeq`). `404` unknown. R81: the posture is NON-ENFORCING guidance (switch_mode's REST surface — no shipped UI calls it); enforcement lives in the operating mode. |
| `PATCH /sessions/:id/permissions` | **ROUND-50 · R81 (the unified operating-mode picker) · R114 (the selected-model pair rides the same route — the composer flips mode and model in one breath; see the R114 additions)** — `{mode: "full"\|"ask"\|"plan", model?}` → `200` the updated session + `events[]` + `lastSeq` (same shape as GET). `400 VALIDATION body.mode` otherwise — **R81: `editor` is retired** (the 400 carries a `details.hint` naming the mapping: "mode 'editor' was removed in R81 — use 'ask'…"; migration 0029 + a read-time remap map existing `editor` rows to `ask`, fail-closed). `404` unknown. Enforcement (R81, ADR-0029 — the SOLE enforcement tier): `sessionToolAllowList` (runtime.ts — shared with the context route): *plan* intersects tools to the 19-tool `PLAN_MODE_TOOLS` read-only/research set (canonical home `agents/mode-policy.ts`; includes the git inspectors, `analyze_image`, `job_status` — the retired R75 review/explore extras); *full* auto-approves every ask-tier gate EXCEPT the denylist-supreme (sudo/rm -rf/… never bypassed) while agent allowlists stay authoritative; *ask* keeps the interactive approval gates; the system prompt gains an OPERATING MODE section (non-ask modes only). The R75 task-mode policy tier is RETIRED — postures no longer narrow toolsets. |
| `GET /sessions/:id/context?model=&providerId=` | **ROUND-50 (the composer's context donut) · ROUND-83 (the honest metering round — every new field additive; see the [CONTEXT-METER runbook](../../runbooks/CONTEXT-METER.md))** — `{model, providerId, contextWindow, contextWindowSource: "override"\|"catalog"\|"default", maxOutputTokens, available, usedTokens, usedTokensBasis: "estimated", breakdown:{systemPrompt, systemTools, memory, messages, meta, mcpTools:0}, actual\|null, compaction?, cache:{inputTokens, cachedInputTokens, hitRate\|null}, sessionTotals:{inputTokens, outputTokens, requests, costUsd, providerCalls}, usage:{main, subagents, combined}}`. Window + output reserve = `resolveTurnBudget` (models row → catalog → defaults; the OWNER's `max_output_tokens` finally honored; `available = window − output − 8 000` — the SAME line the compaction trigger and context guard use, ONE truth). **R83: the meter builds the same prompt sections a real turn carries** (skills, task-modes index, active mode, background tasks, environment) and MEASURES the real JSON tool schemas per effective tool (`tools/index.ts measureToolSchemaTokens`, in-process cached — replacing the fixed ≈350/tool approximation); **the messages estimate APPLIES the newest `context.compact` event** (the model receives summary + tail) and `compaction:{throughSeq, droppedMessages, tokensSaved}` reports it. **`actual`** = the provider's OWN prompt tokens for the last request (the newest `message.assistant` stats carrier — `{inputTokens, outputTokens, cachedInputTokens\|null, at, model}`; null before the first reply, never a fabricated 0). **`hitRate` is null when no usage row reported a cache tier** (the rate reads the raw SUM — no COALESCE; a provider without cache reporting renders "— not reported", never 0%). **`providerCalls`** = `SUM(usage_events.provider_calls)` (migration 0031 — the real SDK-call count; `requests` counts TURNS, one row per turn since R24). Cache from REAL `usage_events.cached_input_tokens` (migration 0020). ROUND-51: `usage:{main, subagents, combined}` (subagents = the DIRECT children's usage_events, listSubAgents parity; main/combined carry `providerCalls`). Flat pre-R83 fields byte-identical (additive shape). |
| `POST /sessions/:id/compact` | **ROUND-83** — the compaction affordance the pre-R83 800K guard promised while no such command existed. Body `{}` → force-runs the SAME `assembleWithCompaction` machinery the turn loop uses (summarize the over-budget head into a dense briefing, persist the `context.compact` event, keep the newest messages; the summarizer's own spend is a usage row with `origin:"compaction"`). `200 {compacted: true, throughSeq, droppedMessages, tokensSaved}` · `200 {compacted: false, reason}` (nothing to summarize — a single-message session keeps its final message by construction; summarizer failure degrades to the honest hard trim, never a 500). Gates: `404` unknown session · `409` no agent / vanished agent / unconfigured model / missing provider / no baseUrl / disabled provider / no key. The next turn's assembly AND the context meter read the persisted event (fork/revert inherit it, ADR-0010). |
| `POST /sessions/:id/messages` | `{content, model?}` — **synchronous whole turn** → `200 {assistantMessage:{seq,role,agentId,content,ts}, usage}`; 404/409 (terminal/unconfigured/no key)/502 provider. **ROUND-50: also accepts `thinkingLevel?: "default"\|"low"\|"high"\|"max"` (400 otherwise; injected as `reasoning.effort` on chat-completions bodies) and `attachments?: [{name, path?, size?, text?}]` (≤20, name ≤200 chars, text capped 128 KB server-side; persisted on the `message.user` payload and rendered into model-facing history as `--- attached file: … ---` blocks)** |
| `POST /sessions/:id/messages/stream` | **SSE (the UI's primary path)** — same validation (incl. the ROUND-50 `thinkingLevel`/`attachments` fields); `text/event-stream` frames: **R114: `{type:"turn.started", text, model, providerId}` — the turn's FIRST frame** (emitted the instant `prepareTurn` succeeds, once per POST/stream; see the R114 additions) · `{type:"text-delta",delta}` · `{type:"thinking-delta",delta}` · `{type:"tool-call",toolName,argsSummary}` · `{type:"tool-result",toolName,argsSummary,ok}` · `{type:"finish",usage[,cachedInputTokens]}` · `subagent-status`/`subagent-event` envelopes (children stream their own live deltas — ROUND-50) · terminal `{type:"done",assistantMessage,usage}` or `{type:"error",status,code,message}`. **R42: a client disconnect does NOT abort the turn** — it completes in the background (events persist; the completion notification fires + Web Push delivers it to the closed window's service worker). A deliberate stop is `POST /sessions/:id/stop`. |
| `POST /attachments/read` | **ROUND-50** — `{paths: string[] (≤20), projectId?}` → `{files: [{path, name, size, text\|null, truncated, error?}]}`. Text = first 128 KB head (`truncated:true` when longer); NUL-in-first-8KB sniff → `text:null`; relative paths resolve ONLY inside `projectId`'s root (escape/missing project → per-file `error`, never a 500); absolute paths read as-is (user-picked). Files >512 KB refuse (the honest per-file error — see the ROUND-67 section for the upload route that supersedes this cap for drop/paste). |
| `POST /attachments/upload` | **ROUND-67** — the ingestion route (see the ROUND-67 section): `{projectId, name, dataBase64?\|absolutePath?}` (exactly ONE source) → `200 {path: "attachments/<name>", name, size}`; ≤8 MB decoded, sanitized names, content-dedupe (never overwrites). |
| `GET /projects/:id/attachments/bytes` | **ROUND-121** — the DISPLAY route (the pixels round's out-door for the R67 no-bytes-on-the-wire law): `?path=<project-relative>` → the raw image bytes with `content-type` (png/jpg/jpeg/gif/webp/bmp ONLY — no SVG), `content-length`, `private, max-age=300` + a weak ETag (honest: the upload route's content-dedupe makes a path's bytes stable). 400 escapes/non-image/oversize (>8 MB)/missing `path`; 404 unknown project/file. Device tokens reach it (not on the R109 blocklist) — the phone's thumbnails are the point. Pinned by `agent-core/tests/r121-attachment-bytes.test.ts`. |
| `POST /internal/dialog/files` | **ROUND-50** — the multi-FILE OS picker (the composer's Attach files). Tauri `pick_files` (rfd, parented to the main window, topmost) inside the shell; PowerShell `OpenFileDialog` Multiselect fallback (R48 topmost-owner pattern) outside → `{files: string[]}` (`[]` = cancelled). Never called by tests (blocks on a human). |
| `POST /sessions/:id/stop` | **R42** — explicitly aborts the live streamed turn for the session → `{ok:true, stopped:boolean}`; the stream resolves with `{type:"stopped"}` (NOT an error; no task_failed notification). |

`model` on either turn route overrides the agent's model for that call
(ADR-0015). **R114: the resolution is a THREE-TIER ladder — per-send
override → `session.selectedModel` → agent row** (each side falls through
independently; see the R114 additions at the end). Usage on streamed turns = awaited totals cross-checked against
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
| `POST /browser/session` | `{sessionId, projectId?}` → `{ticket}` — mints a random 192-bit ticket bound to the tab's session (rotates on re-mint; 12h TTL refreshed on use; dies with session eviction/deletion). **ROUND-48 (R48-d): this is now the ONLY route that rotates a ticket** — see the ROUND-48 section. ROUND-46 (R46-d): the optional `projectId` binds the session's COOKIE PROFILE (sticky for the session; absent → the shared `_default` profile). **ROUND-67 (R67/E4): the frontend now SENDS the projectId on every panel mint** — two projects' tabs keep separate jars. |
| `POST /browser/bind` | **ROUND-67** — declare a chat session's browser tab (the cross-session-leak fix; see the ROUND-67 section): `{chatSessionId, sessionId\|null}` → `{ok, chatSessionId, sessionId}`; null clears. |
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
- **ROUND-65: `GET/PUT /settings/debug` → `{enabled: boolean}`** (default
  `false`; same validation/envelope as the memory switch). **R66 rework:**
  the switch no longer composes any prompt section (the R65
  `## DEBUG MODE` self-report is REMOVED) — while `true`, the stream route
  runs the post-turn CONTEXT-FREE debug analyst after the turn completes
  (see the ROUND-66 section). Read per-turn; a flip applies to the very
  next message.
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
| `POST /sessions/:id/revert` | `{keepThroughSeq: integer >= 0}` — **R77 semantics**: `keepThroughSeq` is the seq of the USER message being reverted; every event from that seq ONWARD is deleted (the target message itself + its reply + later turns — the UI refills the composer with the message's text so the owner can edit + resend), then one `session.reverted` marker event is appended → `200 {ok:true, removedCount}`. `404` unknown session · `409 CONFLICT` while a turn is running (deleting under a live stream would race it) · `400` bad body. |

The UI surfaces these as the Sessions screen's debounced search + hover Fork
action, and the chat's user-message hover "Revert to this message" (with a
confirm dialog).

### Project memory (per-project persistent knowledge)

| Route | Contract |
|---|---|
| `GET /projects/:id/memory` | `{memories: [...]}` — newest-first, capped at 100; each `{id, projectId, kind, content, source, createdAt, updatedAt}` with `kind` ∈ fact\|decision\|preference\|note. `404` unknown project. |
| `DELETE /projects/:id/memory/:memoryId` | `{ok:true}` · `404` unknown project or memoryId. |
| `POST /projects/:id/memory` | **R98-F1** — `{kind?, content}` (the Memory tab's add form): kind absent/blank → `note` (the `memory_save` tool's contract), content trimmed + non-empty + ≤4000. `201 {memory, deduplicated:false}` on insert; an exact duplicate (case-insensitive) refreshes the row instead → `200 {memory, deduplicated:true}`. Rows are sourced `"owner"` (the agent's own saves stay `"agent"`). `400` invalid body · `404` unknown project. |
| `PUT /projects/:id/memory/:memoryId` | **R98-F1** — partial patch `{content?, kind?}` (at least one): content re-validates like the POST, kind moves the row between the four, `updated_at` bumps (the row ranks like a fresh save). `200 {memory}` · `400` empty/invalid patch · `404` unknown project or memoryId. |

The AGENT's channel is still the `memory_save` tool — that is what writes
memory during turns. The R98-F1 write routes are the OWNER's manual surface
(the right-sidebar Memory tab's add/edit forms), the same read/prune
ownership the GET/DELETE pair always had; REST-created rows are marked
`source:"owner"` so the audit trail stays legible.

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
entry" directive) and distributes them to credential pool slots 2/3/4 as
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
key probed    → the credential POOL key for that slot: slot 0 == primary
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

## ROUND-53 additions (implemented)

### Tauri shell commands (NOT REST — `window.__TAURI__.core.invoke`, sidecar.ts wrappers)

`sidecar_status` → `{phase: "starting" | "running" | "failed" | "stopped",
port?: number, error?: string}` (serde tag="phase") — the connection-gate
diagnostics channel: the webview's connect loop reads it between refused
`sidecar_info` attempts to fail fast with the REAL lifecycle error (spawn
failure, missing bundle, ready-line timeout, mid-session exit code).

`restart_sidecar` → `"restarting"` — graceful teardown (authed
`/internal/shutdown` → 3s grace → taskkill /T /F) then a fresh handshake on
a background thread; serialized by a restart lock; "already starting" while
Starting. Powers the offline screen's Restart-engine button.

Behavior changes to existing commands: `sidecar_info` now ERRORS with the
phase description until Running (Starting used to be indistinguishable from
dead — the webview retries now); the handshake itself moved off `setup` to
a background thread (the window paints immediately; `phase` starts
`starting`). New artifacts: `%APPDATA%\acute-code\sidecar.log` (every
lifecycle line, provider keys logged as id+length ONLY, rotated at 1 MB).

### Webview connection contract (src/lib/*, no backend surface)

`config-store` v2: inside Tauri NOTHING persists (the ephemeral port must
never reach localStorage — the "55963" stale-endpoint bug); `connection`:
`connecting|connected|offline` + `connectionError` gate the whole app tree
(ConnectionGate). The connect loop (`sidecar-connection.ts`): poll
`sidecar_info` every 400ms (**150s deadline** — R54: the Rust handshake
retries 3× before declaring Failed, so the webview must not quit first) →
adopt + invalidate ALL queries; `failed|stopped` → offline immediately; a 20s
`ping_sidecar` watchdog re-enters the loop on mid-session death.

## ROUND-55 additions (implemented)

### Credential store: keyring crate → direct FFI (src-tauri/src/wincred.rs)

The keyring crate is REMOVED (Cargo.toml) — its Windows TargetName is
derived as `{user}.{service}` (`api-key.ACUTE-CODE/provider/<id>`), which
could never match the launcher's cmdkey targets (`ACUTE-CODE/provider/<id>`):
the packaged app found none of the launcher-seeded keys ("no provider keys
found in Credential Manager" on every boot). `wincred.rs` calls
`CredReadW`/`CredWriteW`/`CredDeleteW` directly (windows-sys) with exact
TargetName control:

- reads + writes at the canonical `ACUTE-CODE/provider/<id>` targets
  (user `api-key`, CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE) —
  byte-compatible with cmdkey;
- the pre-R55 keyring-form targets are still READ as a legacy fallback
  (keys saved through ≤ 0.54.0 app builds keep working) and retired on the
  next Settings save;
- blobs are UTF-16LE on write, dual-decoded on read (UTF-16 with
  parity+printable validation, then UTF-8/ASCII) — cmdkey-, UI-, and
  keyring-seeded values all round-trip;
- the Tauri command surface is unchanged (`store_provider_key`,
  `provider_key_status` — same names, args, and semantics); non-Windows dev
  checkouts get an honest stub (keys flow from dev.mjs env injection there).

### Sidecar spawn: verbatim-path stripping (src-tauri/src/sidecar.rs)

Tauri's `resource_dir()` on Windows returns `\\?\`-verbatim paths;
`resolve_sidecar_command` passed them to the child as the program, the
script argument, AND the cwd — node's module resolver
(`fs.realpathSync`/`resolveMainPath`) cannot handle a verbatim entry script
and died with `EISDIR: lstat 'C:'` before the first line of agent-core code
(the packaged app's "Can't reach agent-core" since the first build; dev
mode passes plain paths and never saw it). `simplified_path()` now strips
the prefix (`\\?\C:\…` → `C:\…`, `\\?\UNC\…` → `\\…`) off the resource
dir before any derived path exists. sidecar.log's spawn line now shows
plain Win32 paths, and the spawn injects the four provider keys
(`sidecar: injected provider keys: openrouter (len N), …`).

## ROUND-54 additions (implemented)

### Tauri shell command: `sidecar_log_tail`

`sidecar_log_tail({lines?})` → `{path: string, lines: string[]}` — the last
`lines` (default 60, clamped 1–200) lines of
`%APPDATA%\acute-code\sidecar.log`, oldest first, plus the file's absolute
path. Serves the offline screen's in-app engine-log view + Copy-diagnostics
button (R54: the owner no longer has to find %APPDATA% by hand). Null-safe
wrapper `getSidecarLogTail()` in `src/lib/sidecar.ts`.

### Sidecar lifecycle behavior changes (src-tauri/src/sidecar.rs)

- stderr is PIPED and drained (`sidecar:stderr] …` lines in sidecar.log + an
  in-memory 24-line ring) — the packaged GUI app has no stderr handle, so
  the old `Stdio::inherit()` swallowed agent-core's own crash reason.
- The startup handshake RETRIES (3 attempts, 2s apart; READY_TIMEOUT 25s,
  HEALTH_TIMEOUT 15s) before declaring `failed`; the `failed` error string
  embeds the engine's last 6 output lines (`recent engine output:`).
- A failed handshake attempt kills its child (kill_tree + wait) — the old
  code dropped the Child handle and orphaned a node.exe that held the DB
  (the "restart engine didn't work" mechanism).

### Browser-mode folder dialog (REST, existing route unchanged)

`POST /internal/dialog/folder` is now fetched with a 120s AbortController
timeout client-side (a hung OS dialog used to spin the Browse button
forever); the timeout error message tells the owner to paste the path.

## NOT implemented (despite API.md)

`/ws` (no WS gateway — SSE per-turn instead) · `/internal/shutdown` ·
project file writes over REST · git/settings routes ·
audit_log routes (approvals ARE implemented — see above) ·
session events-backfill · connection-test/model-listing for
non-chat-completions providers (manual model rows work) ·
dev port is **5178**, not 8765. (The skills + MCP routes the
pre-R61 "NOT implemented" line carried are implemented since
ROUND-61 — see below.)

## ROUND-59 additions (implemented)

### Response ratings (the owner's feedback loop)

- `POST /sessions/:id/ratings` `{assistantSeq, rating: "good"|"bad", note?}` —
  rates one assistant reply; **upsert on (session_id, assistant_seq)** (re-rating
  overwrites rating+note+context, preserves created_at). The server builds an
  **immutable full-context snapshot at rate time** (user message, assistant
  reply with usage/ms, tool events ≤50 with 500-char summaries, any
  turn.error, session title, agent name, model, event count; 8000-char field
  caps with `truncated` flags). 200 `{rating}` (no context) · 404 unknown
  session · 400 bad body / unknown assistantSeq.
- `GET /sessions/:id/ratings` → `{ratings: [...]}` (no context — the chat UI's
  rated-state map).
- `GET /ratings?sessionId=&rating=&limit=` → `{ratings: [...]}` **with full
  context** (the analysis/export path; newest-first, limit default 200).
- `DELETE /ratings/:id` → `{ok: true}` · 404 unknown.
- Migration `0022_message_ratings.sql` (UNIQUE upsert key + audit row; no FK —
  the sessions.ts convention). Storage: `agent-core/src/storage/ratings.ts`.
- Frontend: `rateReply`/`listSessionRatings`/`deleteRating` (api.ts) + the
  thumbs cluster in AgentChatPanel (bad ratings prompt a note). CLI:
  `node scripts/acute.mjs ratings [--session/--rating/--limit/--full]` +
  `ratings:rm <id>` — `--full` dumps the evidence JSON.

### Diagnostics console (error monitoring)

- `GET /diagnostics/errors?limit=` → `{errors: [...]}` — the sidecar's
  in-memory fastify error ring (thrown errors + ≥500 responses only; 4xx
  client mistakes stay out by decision), newest-first, scrubbed (no bodies,
  no auth, no query strings). 200 entries cap.
- `DELETE /diagnostics/errors` → `{ok: true}` (clears the ring).
- Frontend: `listDiagnosticErrors`/`clearDiagnosticErrors` (api.ts) + the
  right-sidebar **Console** tab (ConsolePanel) merging the sidecar ring with
  `src/lib/error-bus.ts` (ErrorBoundary render errors, window.onerror,
  unhandledrejection, TanStack QueryCache.onError — 200-entry ring, 5s
  same-error dedupe, secret-scrubbed).

### Prompt-section registry (modular system prompts)

- `.acute/prompts/<section-id>.md` per-section overrides (32 registry ids —
  R99-G: +precedence +autonomy, −precision-discipline; see
  `docs/runbooks/PROMPT-MODULES.md`); empty file removes the section;
  `_order.txt` reorders when ≥1 override exists. No overrides → composition
  byte-identical to pre-R59-F (golden-fixture pinned).
- CLI: `prompt:sections [--project]` + `prompt:show <id> [--project]`.
- No new routes — the registry composes inside `buildProjectSystemPrompt`.

## ROUND-60 additions (implemented)

**No new sidecar routes this round** — R60's additions are Tauri (IPC)
commands and frontend modules:

### Browser tab webview — scroll channel + zoom (Tauri commands)

- `browser_tab_scroll_state(tab_id)` → JSON string `{y, vh, ch, css}` — the
  page's main-scroller geometry read OUT of the child webview via
  `Webview::eval_with_callback` (tauri 2.11.5; the only channel that returns
  data from an external page without injecting IPC into it). `css` reports
  whether the document-start themed-scrollbar style APPLIED (a CSP-blocked
  `<style>` has `sheet === null`). Async, 2s channel timeout — a wedged page
  never hangs the poller. Frontend bridge: `nativeTabScrollState`
  (native-browser.ts; null on every miss — never throws).
- `browser_tab_scroll_to(tab_id, y)` — `window.scrollTo(0, y)` (finite,
  non-negative, validated in Rust). Bridge: `nativeTabScrollTo`.
- `browser_tab_set_zoom(tab_id, factor)` — REAL DPI zoom via
  `Webview::set_zoom` (WebView2 zoomFactor), factor clamped 0.1–5.0; the
  BrowserPanel's native mode drives it on zoom changes + activation +
  navigations (the R50 viewport-divide approximation is deleted). Bridge:
  `nativeTabSetZoom`.
- `browser_tab_create` gained optional `hide_viewport_scrollbar` — when true
  (the pop-out passes it) a document-start `initialization_script` installs
  the themed-pill scrollbar CSS + hides the page's VIEWPORT scrollbar (the
  pop-out's GutterScrollbar replaces it, outside the content card).
  Backward compatible (missing key → None).

### Pop-out gutter scrollbar (frontend module)

- `src/popout/GutterScrollbar.tsx` — the pop-out window's own scrollbar in
  the right gutter: 250ms `browser_tab_scroll_state` polling (paused during
  drags), pointer-captured drag + track page-jump + full keyboard contract
  on a `role="scrollbar"` track, rAF-throttled `browser_tab_scroll_to`.
  Honesty: hidden when no data / `css:false` (CSP-strict pages keep their
  own bar — never two) / no overflow; the column stays mounted (stable
  layout).

### Rating-note visibility (AgentChatPanel)

- A saved bad-rating note renders a "noted" chip on the rating cluster
  (click → the editor reopens pre-filled); re-rating a saved bad reply
  pre-fills the editor. No route changes (the existing upsert carries it).

## ROUND-61 additions (implemented)

The computer-use + extensibility round (migration
`0023_computer_use.sql`: `models.supports_vision` column, `skills` +
`mcp_servers` tables, `read_skill` appended to template/default-agent
allowlists — no computer-use allowlist append, the surface is
settings-gated default OFF). Full owner guides:
[`docs/runbooks/COMPUTER-USE.md`](../../runbooks/COMPUTER-USE.md) +
[`docs/runbooks/EXTENSIBILITY.md`](../../runbooks/EXTENSIBILITY.md).

### /api/v1/computer-use (monitor + config + the vision key)

| Route | Contract |
|---|---|
| `GET /computer-use/config` | `{settings:{enabled,permission,vision:{mode,provider,modelId}}, platform, capabilities}` — the detected backend + its honest capability matrix |
| `PUT /computer-use/config` | Partial patch `{enabled?, permission?, vision?{mode?, provider?, modelId?}}` (storage validates: posture/vision enums, provider slug, modelId ≤256) → `{settings}` · 400 VALIDATION |
| `GET /computer-use/session` | The monitor snapshot: `{active, killSwitch, backendKind, startedAt, stopReason, stats:{actionsSent,actionsRefused,observations,visionCalls}, events[]}` — newest-first 200-entry ring; `stopReason` is null while running (the R61 close-out drift fix). |
| `GET /computer-use/frames/:frameId/raster` | **ROUND-67, consumer updated ROUND-68** — the PNG bytes of a capture made THIS process lifetime (the live chat's INLINE screenshot rows — one lazy fetch per `screenshot` WorkingEntry, was the R67 strip; see the ROUND-67 + ROUND-68 sections): frameId `^[A-Za-z0-9_-]{1,64}$` → 400 otherwise; miss (never registered / LRU-evicted / TTL-expired) → the honest 404 envelope; hit → the decoded PNG, `image/png`, `no-store`. |
| `POST /computer-use/stop` | The UI kill switch. `{reason?}` (default "stopped by the owner from the UI") → sets the enforced kill switch, releases a session-held mouse button with a real mouse-up → `{ok:true, reason}`. Every further computer-use tool call refuses `kill_switch_active` |
| `POST /computer-use/test` | Readiness probe (permissions + capabilities; never pops OS dialogs) → `{report, capabilities, platform}` where `report` is the PermissionReport `{accessibility, screenCapture, backendKind, notes[]}` **+ the composed UI verdict `ok` (both core capabilities granted) and `issues[]` (notes + explicit denied-permission lines)** — exactly what the ComputerUseTab's Test readiness renders (the R61 close-out drift fix). |
| `GET /computer-use/vision-key?providerId=` | `{providerId, hasKey, masked}` — the dedicated `<providerId>-vision` keyring slot; the VALUE is never returned |
| `PUT /computer-use/vision-key` | `{providerId (slug), value}` → keyring set → `204` (web/dev mode; the packaged app writes the durable credential via the Tauri `store_vision_key` command → credential target `ACUTE-CODE/provider/<id>-vision` + env `ACUTE_PROVIDER_<ID>_VISION` at spawn) |
| `DELETE /computer-use/vision-key?providerId=` | Clears the slot → `204` |

### /api/v1/skills + /api/v1/mcp + /api/v1/plugins

| Route | Contract |
|---|---|
| `GET /skills` | **R70: the MERGED listing** — `{skills:[SkillRecord & {source: "builtin"|"user"|"project-file"|"global-file", filePath?, projectName?, references?}]}`: DB rows + every registered project's `.acute/skills/` files + user-global `~/.agents/skills/` files (file bodies read from disk at call time — a deleted file de-lists; the `filePath`/`projectName`/`references` fields are additive, so the existing frontend type needs no change). **R72:** file-skill entries now also carry `references` — the `references/` metadata (`[{name, fileName, bytes}]`, possibly empty; DB rows OMIT the field; metadata only — reference content is never served here, the agent loads it with `read_skill {name, reference}`) |
| `POST /skills` | `{name (lowercase slug 2-64), description?, body?, enabled?}` → `201` SkillRecord · 400 (bad slug/duplicate) — a DB row created with a file-skill's name SHADOWS the file (the documented override path) |
| `PATCH /skills/:id` | Partial patch (name unique-checked) → SkillRecord · 404 · 400 · **409 for a FILE-skill synthetic id** (`skill_file_p_…` / `skill_file_g_…`): "file-defined skill: edit the SKILL.md" (the UI's row-error path surfaces it verbatim) |
| `DELETE /skills/:id` | User rows `204`; built-in rows `409 CONFLICT` "built-in skills can be disabled or edited, but not deleted"; file-skill ids `409` (same message as PATCH); unknown `404` |
| `GET /mcp` | `{servers:[McpServerRecord]}` (id/name/command/args/env/enabled) |
| `POST /mcp` | `{name (slug 2-32), command, args?, env?, enabled?}` → `201` · 400 — owner-configured only, never model-writable |
| `PATCH /mcp/:id` | Partial patch; drops the cached child so the next call respawns with the new config → record · 404 · 400 |
| `DELETE /mcp/:id` | Kills the child process + deletes the row → `204` · 404 |
| `GET /mcp/:id/tools` | Live `tools/list` → `{tools:[{name,description,inputSchema}]}` or `{tools:[], error}` (in-band honest error) |
| `POST /mcp/:id/probe` | Health probe (spawn + initialize + tools/list) → `{ok, toolCount?, error?, ms}`; resets the one-strike spawn failure |
| `GET /plugins?projectId=` | The Extensions surface: `{plugins:[12 built-ins' metadata], tools:[computed catalog], external:{files:[{file,scope,loaded}], loadedCount, note}}` — computer-use is LISTED even while gated off |

### Models: `supportsVision`

- `POST /providers/:id/models` + `PATCH /models/:id` accept
  `supportsVision: boolean` (same scalar gate as `supportsThinking`; 400
  otherwise) — prefilled from the catalog for known vision models. The
  vision relay's "main" mode is allowed only when the turn's model row has
  this flag; the Computer Use settings tab can flip it per row.

### SSE: the `computer-use` monitor frame

- `POST /sessions/:id/messages/stream` now also emits
  `{type:"computer-use", kind, tool?, code?}` — one frame per computer-use
  tool execution at dispatch time (`kind` = the dispatch outcome:
  `data|receipt|refusal` shapes from the plugin; `code` carries the refusal
  code). The stream-store routes these to the monitor store BEFORE the
  live-turn guard, so the right-sidebar Computer panel + the floating mini
  window update live even for background turns.

### Tools: `read_skill` + `mcp__<server>__<tool>`

- `read_skill` (the skills loader) joins the always-on toolset (deps-gated)
  and `TOOL_NAMES` (25 — see /api/v1/agents above); migration 0023 appended
  it to template + default-agent allowlists only. **R70**: it is ALSO a
  plan-mode tool (`PLAN_MODE_TOOLS`), and it resolves through the ONE
  shared skill index (`resolveEffectiveSkills`: enabled DB rows with the
  computer-use gate → file skills not shadowed → the agent's `skills`
  allowlist) — the same index that composes the prompt's SKILLS section.
  The `computer-use` skill is refused while the master switch is off
  ("its tools are dark"); sticky result semantics — see ROUND-70 below.
  **R72**: the inputSchema gained the optional `reference` param (load a
  `references/` file instead of the main body — see ROUND-72 below).
- Enabled MCP servers contribute their tools dynamically as
  `mcp__<server>__<tool>` (grammar-checked; over-length names skipped +
  logged). A failed/unconfigured server contributes nothing (fail-soft).
- The 31 computer-use tools register ONLY when
  `computerUse.enabled=true` (default OFF); the "observe" posture registers
  just the 12 read-only ones.


## ROUND-62 additions (implemented)

The owner-feedback round: the agent-browser surface, the browser-command
bridge, and the per-side cost fix. No new tables (D4/D8 ride the R50
models columns + the R61 computer-use settings).

### POST /api/v1/browser-commands/:commandId/result (the bridge's answer channel)

The browser_control tool's live actions (`eval`, `screenshot`'s meta ask)
send a `{type:"browser-command", commandId, tabId, action, payload}`
frame on the turn's SSE stream; the app UI executes it (eval → the Rust
`browser_tab_eval` in the tab's webview; screenshot_meta → the panel's
physical-px region) and POSTs the result here. Body
`{ok: boolean, data?: unknown, error?: string}` → **204** when a pending
command resolved (or rejected with the honest error), **404** for
unknown/expired ids (fire-and-forget from the UI). The tool side fails
closed without a live stream channel ("no live stream channel in this
context") and times out honestly after 15 s (`browser-command.ts`).

### browser_control — the new actions (no route changes; the shared cores)

- `read` — the session's current page fetched server-side (webFetch's
  extractor, maxChars ≤ 16 000, honest truncation marker).
- `eval` — `{script}` (≤ 20 000 chars) → the bridge → the Rust
  `browser_tab_eval` (function-BODY semantics: `return value`; page
  exceptions return `{ok:false,error}` as data). Native desktop mode
  only; the honest refusal elsewhere.
- `screenshot` — the panel region (via the bridge) → the computer-use
  `captureRegion`/`captureDisplay` → the vision relay
  (separate/main model) → the description + honest unavailable notes;
  needs Computer Use enabled (the relay registry the computer-use plugin
  publishes per armed turn).
- `get_state` — now `tabs` (every open session: id, url, title,
  viewport) + `activeTab` (the LRU tab the user views).
- New client fn `postBrowserCommandResult`; the `StreamTurnEvent` union
  grew the `browser-command` variant (intercepted in stream-store BEFORE
  the liveTurn guard, like computer-use frames).

### The D4 cost fix

`computeCost` (agents/runtime.ts, now exported): pricing sides are
independent — input-only/output-only priced models cost their KNOWN
sides (the pre-R62 either-null → $0 gate silently zeroed partially
priced turns). The settings tab's mutation sites fan out
`invalidateProvidersEverywhere()` / `invalidateModelConfigEverywhere()`
so session-page pickers refresh immediately; the model dialog's pricing
fields are labeled "$ per 1M tokens" with decimal input, and
`supports_vision` is editable there.

### Drift notes (none this round)

The R61 drifts (test-readiness ok/issues; session stopReason) were fixed
in the R61 close-out; no new contract drifts were found in R62.

## ROUND-63 additions (implemented)

The desktop-update round — no new REST routes; the shipped surface change
is the health version finally telling the truth (the launcher's new
version-truth chain depends on it).

### `GET /health` — the version is real now

`VERSION` (server.ts) derives at boot from the **package.json next to the
compiled code** (`agent-core/package.json` in dev; `sidecar/app/package.json`
inside the installed desktop app — the staging step copies the exact version
field). It had been a hardcoded `"0.3.0"` since round 1, which made `/health`
useless for exactly what it exists for: the launcher's post-launch
verification that the freshly installed desktop app is really running the new
engine. A missing/corrupt manifest degrades to `"0.0.0"` (never takes the
engine down). Pinned by `server.test.ts` (VERSION == the package.json
version + semver shape; the health payload asserts against `VERSION`).

### The launcher's version-truth chain (consumer side, not an API)

Every desktop launch compares the newest GitHub release against the
uninstall-registry version, the installed exe's FileVersion ON DISK, and the
running engine's `/health` version (polled token-free on the sidecar log's
listening port); a hybrid install is deleted completely and reinstalled, then
verified the same three ways. See `docs/ui-iterations/round-63.md` and
`launcher/README.md`. `ACUTE.bat` also gained `reinstall` / `uninstall`
commands.

### Drift notes

`API.md` §2.1's response example (`uptimeMs`, `dbOk`) never matched the
shipped shape — the spec example is corrected to the real payload
`{status, app, version}` (the shipped code is unchanged; the example was
wrong, not the code).

## ROUND-64 additions (implemented)

The capability round — one REST surface extension (the per-key usage
aggregate), plus payload EXTENSIONS to computer-use tool results (no route
or signature changes).

### `GET /usage/detailed` — the `keys` aggregate

The response gained a `keys` array: the usage ledger grouped by
`(provider, key_slot)` — each entry `{providerId, keySlot, requests,
inputTokens, outputTokens, costUsd, lastUsedAt}`, ordered by cost
descending. `keySlot` 0 = the provider's PRIMARY key; N ≥ 2 =
`ACUTE_PROVIDER_<ID>_SLOT<N>` (the pool slots sub-agent children prefer).
Backed by migration 0024 (`usage_events.key_slot INTEGER NOT NULL DEFAULT 0`
— the default is the truthful reading of history: nothing recorded slots
before R64, and pre-R64 rows genuinely ran on the primary) +
`idx_usage_events_provider_slot`. The runtime threads the slot through
`TurnDeps.keySlot` (the orchestrator sets it to the acquired pool slot for
child runs; main sessions omit it → primary). The /usage screen's "API
keys" section renders one card per key joined with
`GET /providers/:id/keys` (the masked poolInfo).

### Computer-use tool result extensions (same 30 tools, richer payloads)

- `list_apps` rows gained **`processName`** (the executable name, from the
  new EnumWindows-based enumeration) and the result carries
  **`diagnostics`** when the list is empty (`processCount`,
  `foregroundPid`, `enumWindowsCount`, `note`) — residual failures are
  readable from the transcript.
- `app_not_found` / `ambiguous_app_ref` refusals now carry a
  **`runningApps` payload** (≤25 `{name, processName?, pid}` candidates)
  so the model self-corrects in one step; app references resolve by
  window title OR processName with substring matching (5-tier resolver).
- `list_displays` failures are honest `[]` + diagnostics (the fake
  1920×1080 fallback is REMOVED); single-display machines return REAL
  bounds now (the PowerShell JSON array collapse is fixed — see
  `docs/runbooks/COMPUTER-USE.md`).

### Drift notes (none this round)

No route/signature changes; `estimateTokens` consumers keep their exact
signatures (the estimator internals changed — a calibrated GPT-style BPE
approximation — but it remains a pure synchronous function).

## ROUND-65 additions (implemented)

The honesty patch — one REST surface extension (the debug switch), prompt
additions, and a frontend auto-open signal. No route signature changes
beyond `/settings/debug`.

### `GET/PUT /settings/debug`

See the ROUND-49 area above — the memory-switch pattern verbatim
(`{enabled: boolean}`, `400` with `body.enabled` named on bad payloads).

### Prompt additions (prompts.ts)

- **SURFACE BOUNDARY (R65)** lines in BOTH the `computer-use` and
  `browser-panel` sections — each names the OTHER surface and forbids
  narrating embedded-browser actions as desktop actions (the 0.63.0
  hallucination fix). The golden fixture regenerated (additions-only).
- **`## DEBUG MODE (ON)`** (registry id `debug`, `ctx.debugMode`-gated):
  the execution-report contract above.

### Frontend contract additions

- `api.ts`: `fetchDebugSettings()` / `updateDebugSettings(patch)` /
  `DebugSettings`.
- `right-sidebar-store`: `noteAgentBrowserActivity(projectId)` — the
  burst-gated per-project agent-browser activity signal (8s gate);
  `agentBrowserActivityByProject` / `agentBrowserActivityAtByProject`
  (transient — the persist `partialize` keeps them out of localStorage).
- `stream-store`: `startStream(sessionId, text, {projectId?})` — records
  the session's project (exported `streamSessionProject(sessionId)`); every
  `browser_control` tool-call frame and `browser-command` bridge frame from
  an attributed session bumps that project's signal; the RightSidebar's
  controller effect opens/surfaces the Browser tab on the edge.
- `DEFAULT_WEB_HOST_ALLOWLIST` gained `google.com`, `www.google.com`,
  `bing.com`, `www.bing.com` (exact-host matching, no www normalization —
  `google.com.evil.org` still asks).

## ROUND-66 additions (implemented)

The live-fire patch (the owner's 0.65.0 field report: browser page actions,
bot-wall checkpoints, instant viewport apply, the vision split, the debug
analyst, Windows element search). New REST: the browser-checkpoint resolve
route + the `/vision` settings/test trio. New SSE frames: `browser-viewport`,
`browser-checkpoint(.resolved)`, and the debug analyst's
`debug-start|delta|done|error`. New session event type `debug.report`
(display-only).

### `POST /api/v1/browser-checkpoints/:checkpointId/resolve`

The human-verification checkpoint's answer channel (the
`browser_control` `wait_for_verification` action opens a countdown card in
chat and pends; the owner's click answers here). Body
`{action: "done"|"stop"}` → **200 `{ok:true, resolution}`** when a pending
checkpoint resolved; **200 `{ok:false, resolution:"timeout", error:
"unknown or expired checkpoint"}`** for unknown/expired ids (the card's own
countdown is the fallback); `400 VALIDATION` on a bad body (the action must
be one of the two). Registered next to the browser routes (same bearer
wall). The registry (`agent-core/src/browser-checkpoint.ts`) settles every
checkpoint on REST resolve OR its countdown (default 15 s, hard cap 60 s)
and emits the resolved frame on every settle. The wall detector itself is
pure and exported (`detectVerificationWall` — cloudflare > captcha > age >
"verification" priority, word-boundary markers, ≤120-char evidence).

### `GET /vision/settings` · `PUT /vision/settings` · `POST /vision/test`

The R66 vision split — the vision model moved OUT of computer use into its
own global settings (Settings → Image Analysis; computer-use + browser
screenshots AND the new `analyze_image` tool all read this one
configuration):

- `GET` → the bare `VisionSettings` `{mode: "off"|"separate"|"main",
  provider: string|null, modelId: string|null}`. **R114: `"off"` is
  RETIRED — the type is `"main"|"separate"`, and a stored `"off"` (or any
  unknown value) READS as `"main"`** (a marked model always sees; see the
  R114 additions at the end).
- `PUT` → validated partial patch (mode enum, provider slug
  `^[a-z0-9_-]+$`, modelId ≤ 256 chars; `null` clears) → the new settings
  BARE; `400 VALIDATION` with the field named on bad payloads. The writes
  land on the new `vision.*` settings rows — migration
  `0025_vision_settings.sql` seeds them from the legacy
  `computerUse.vision.*` rows (INSERT…SELECT + OR IGNORE; absent sources
  insert nothing), and a lazy read covers databases the migration has not
  touched. `PUT /computer-use/config` with a `vision` field now answers
  `400 "vision settings moved to PUT /vision/settings"` (honest pointer,
  never a silent drop); `GET /computer-use/config` returns
  `{enabled, permission}` only. The vision KEY keeps the R61
  `/computer-use/vision-key` routes + the `"<providerId>-vision"` keyring
  slot + the Tauri `store_vision_key` command (unchanged).
- `POST /vision/test` → a 1×1 transparent PNG through the CURRENT settings:
  `{ok:true, description, model, ms}` in separate mode (configured); honest
  `{ok:false, error}` for off ("image analysis is OFF"), main ("main-mode
  test needs a live turn — flip a provider model's supports-vision flag
  instead"), and unconfigured separate.

### New SSE frames (`POST /sessions/:id/messages/stream`)

- `{type:"browser-viewport", sessionId:"", tabId, viewport:{width, height,
  preset, zoom, rotate}}` — emitted by the `set_viewport` action the moment
  the server state changes; the stream-store intercepts it BEFORE the
  live-turn guard (turn-independent) and applies it INSTANTLY to the
  matching tab (the 4 s poll stays as the backfill). The owner's
  "agent viewport was not applied until I nudged a number" fix.
- `{type:"browser-checkpoint", sessionId:"", checkpointId, tabId, kind:
  "captcha"|"cloudflare"|"age"|"verification", url, waitMs}` — mounts the
  chat countdown card (Mark as done / Stop waiting); handled after the
  live-turn guard (tools only run inside live turns).
- `{type:"browser-checkpoint.resolved", sessionId:"", checkpointId,
  resolution: "done"|"stop"|"timeout"}` — collapses the card on EVERY
  settle (owner click or countdown).
- `{type:"debug-start"|"debug-delta"|"debug-done"|"debug-error", sessionId,
  …}` — the post-turn context-free debug analyst's live stream (see below);
  the frames ride the still-open SSE BEFORE the turn's terminal `done` /
  `error` frame.
- The `computer-use` monitor frames are unchanged, but the browser
  `screenshot` action NO LONGER records into the computer-use ring (A1 —
  browser work must never show "agent is using your computer"), and the
  monitor's live signal is now the decayed (6 s) real-control activity.

### The `debug.report` session event (display-only)

When debug mode is ON and a turn finished on its own (ok, or
`status >= 500` — never a deliberate ABORTED stop), the stream route runs a
FRESH model call over the session's whole transcript (user request, every
tool call with its FULL persisted result, errors; 60 k cap with head+tail
split; no tools; `maxTurns` 1; keyring secrets scrubbed) and persists the
report as `{type:"debug.report", payload:{content, model, ts}}` (+
`agentId` stamped by the storage layer). **`assembleHistory` has no branch
for the type** — follow-up turns NEVER include it in the model-facing
history. The frontend folds it onto the analyzed turn
(`AssistantTurnItem.debugReport`); a stray report with no analyzable turn
in its gap is dropped honestly. The analyst's own failure sends
`debug-error` (API key scrubbed) and never breaks the turn's terminal
frame. Frame order (pinned by test):
`[turn events…] → debug-start → debug-delta* → (persist) → debug-done →
done|error`.

### `browser_control` — the 15-action surface

The action enum grew (9 → 15): `navigate | back | forward | reload |
set_viewport | read | read_dom | source | click | type | press_key | eval |
screenshot | get_state | wait_for_verification`. The new page actions
(`click`/`type`/`press_key`/`read_dom`/`source`) each compile to ONE eval
script over the existing browser-command bridge (user input embedded via
`JSON.stringify` only); `type` supports `submit:true` and `press_key`
Enter-in-a-form both trigger native `form.requestSubmit()` (the
Google-search fix); `navigate`/`read` probe for bot walls and append the ⚠
note; `wait_for_verification` opens the checkpoint (above). No new bridge
routes — everything rides `POST /browser-commands/:id/result` (R62).

### Tools: `analyze_image` (TOOL_NAMES 25) + `find_elements`

- `analyze_image` (`agent-core/src/tools/plugins/vision.ts`, plugin
  `core-vision`) — `{path?|url?, instruction?}`, local file (png/jpg/jpeg/
  webp/gif/bmp, ≤8 MB) or http(s) URL, described through the global vision
  relay (the `/vision/settings` configuration above; honest refusal when
  off/unconfigured). ALWAYS registered (like `web_fetch` — the OFF refusal
  is the switch), so it joined `TOOL_NAMES` (**25**) + the api.ts
  `TOOL_CATALOG`; migration `0026_analyze_image_tool.sql` appends it to
  existing EXPLICIT allowlists (template + default agent rows that carry
  `web_fetch`; `[]` = ALL already covers it; user curation never widened).
- `find_elements` (computer-use plugin, 31st tool) — `{appRef, query,
  kind?, limit?}` searches the a11y snapshot server-side; observe-posture
  read-only, never consents; NOT `TOOL_NAMES` vocabulary (the
  settings-gated computer-use surface). The Windows walk behind it:
  pattern probes on 17 interactive ControlTypes only, ONE 4-probe pass per
  probed node, `maxEl` 800 → 2400.

### Drift notes

- The browser screenshot's monitor-ring record removal (A1) changed no API
  surface — only the session ring contents.
- The R65 `## DEBUG MODE` prompt section is REMOVED (the R66 analyst is
  route-side); the golden fixture regenerated by the sanctioned procedure
  (the R62-era description of the prompt as the debug surface is history).

## ROUND-67 additions (implemented)

The bridge round (the owner's 0.66.0 live Windows field report: the
blank-panel navigate, the WebView2 eval double-encoding, the
cross-session tab leak, the chat-image upload, the Windows computer-use
failures, the debug card's copy, the live screenshot visibility). New
REST: the attachment upload route + the browser bind route + the capture
raster route. New SSE frames: `browser-navigate`, `browser-open`, and
`screenshot`. Updated `browser_control` semantics: the chat-session-bound
default target + the scoped `get_state`. No new tools, no new migrations.

### `POST /attachments/upload`

The chat-image ingestion route (the owner's "it does not actually upload
the image, it just shows the path" fix). Registered next to
`/attachments/read` (same bearer wall, same error-envelope style), with a
**per-route 12 MB `bodyLimit`** (fastify's 1 MB default would 413 the
~10.7 MB base64 body of an 8 MB image before the handler ran):

- Body `{projectId, name, dataBase64? | absolutePath?}` — EXACTLY ONE
  source (both/neither/junk-typed → `400 VALIDATION` with the field
  named). `projectId` must exist (`404`).
- `name` is sanitized to a plain filename: no separators, no `..`
  (conservatively anywhere), no control chars, ≤200 chars, non-blank; the
  EXTENSION survives (the vision tool's extension gate keeps working).
- `dataBase64`: strict base64 (alphabet regex + length %4 + round-trip
  decoded length), capped at **8 MB decoded** (the `analyze_image`
  ceiling). `absolutePath`: must be absolute (the same POSIX-root /
  Windows-drive check the read route applies), stat/read honest 400s
  (missing, directory); the write itself uses `copyFile`.
- Persists at `<project-root>/attachments/<name>` (mkdir recursive, sync
  fs, `500 INTERNAL` envelope on failure). **Dedupe, never overwrite:**
  identical content (size AND bytes) reuses the incumbent; different
  content mints `-2`/`-3`… before the extension (cap 100 variants →
  `409 CONFLICT`). Reply `200 {path: "attachments/<final-name>",
  name, size}` (project-relative, forward slashes).
- Frontend contract: `uploadAttachmentBytes(projectId, name, dataBase64)`
  (the composer's dropped/pasted bytes, sent BEFORE the message) and
  `ingestAttachmentPath(projectId, name, absolutePath)` (the picker
  binary). A failed upload never blocks the send (the honest no-path
  attachment + a per-file toast).

The model-facing contract (the message attachment path): a
path-bearing IMAGE attachment renders into the history as
`--- attached image: <name> (saved in the project at <path>) ---`
followed by the exact `Use analyze_image with path "<path>" to view it.`
instruction (`renderAttachments`, runtime.ts); other path-bearing files
keep their render plus the path line; `MessageAttachment.path` is now
RELIABLE for uploaded copies (bytes never ride the wire or the event log
— only the resulting path persists). Full owner guide:
[`docs/runbooks/ATTACHMENTS.md`](../../runbooks/ATTACHMENTS.md).

### `POST /browser/bind`

Declares which browser tab a CHAT session drives (the cross-session leak
fix). Body `{chatSessionId: string, sessionId: string|null}` →
`{ok, chatSessionId, sessionId}`; null clears the binding; `400
VALIDATION` on a missing/empty chatSessionId, a non-string sessionId, or
an id that fails the session-id grammar (alphanumeric/-/./_, ≤64). The
binding is a module-level Map in `browser-proxy.ts` (it survives the
session store's LRU eviction); the chat panel posts it just before every
turn starts (fire-and-forget — a failed bind means the tool mints).

`browser_control`'s default target resolution changed accordingly:
explicit `sessionId` param > the chat session's binding > MINT a
deterministic `ag-<chatSession>` tab (bound + announced with the
`browser-open` frame). `get_state`'s `tabs` list is SCOPED to the
addressed tab (plus the explicit param) with `activeTab` = the addressed
session — the agent never sees another session's tabs. The legacy
global-LRU/"agent" fallback survives only for no-chat-session contexts
(catalog/tests), and the tool output notes it honestly. Cookie profiles
are per-project now: the panel's `POST /browser/session` mint carries the
project id (the R46 `projectId` field is finally sent by the frontend).

### `GET /computer-use/frames/:frameId/raster`

The live screenshot THUMBNAIL fetch (see the main computer-use table for
the contract; the owner's "the images should be shown during its
thinking in the agent's chat window itself, in a small view"). The
registry behind it (`agent-core/src/computer/raster-cache.ts`) is
EPHEMERAL by design: in-memory only (never persisted, never model-facing),
LRU-capped at 12, 10-minute TTL (expired entries are dropped on lookup —
never resurrected; re-registration refreshes recency + the TTL clock).
The plugins register the PNG right after a successful capture —
computer-use `screenshot`/`zoom`/`get_app_state includeScreenshot` via
the dispatcher's public `rasterFor(frameId)`; the `browser_control`
`screenshot` action under a minted `bs_<base36>` id — and emit the
`screenshot` frame. The frontend lazy-fetches per thumbnail tile
(`fetchComputerFrameRaster` — a dedicated binary fetch with its own
Authorization header; a 404 becomes the caller's "expired" tile signal).

### New SSE frames (`POST /sessions/:id/messages/stream`)

- `{type:"browser-navigate", sessionId:"", tabId, url}` — emitted by
  `navigate`/`back`/`forward`/`reload` the INSTANT the sidecar history
  changes (the blank-panel fix: the old path had NO frame — the panel
  learned via the 4 s poll, which adopted the URL without creating the
  webview). Turn-independent: the stream-store applies it BEFORE the
  live-turn guard → `browser-store.applyAgentNavigation(tabId, url)`
  (patch + `agentNavSeq`++) → the mounted panel navigates-or-CREATES the
  native webview; the poll (its adopt path now creating too) is the
  backstop. Emit failures are swallowed (the poll backfills).
- `{type:"browser-open", sessionId:"", tabId, chatSessionId, url:null}` —
  emitted when the tool MINTS a chat session's agent tab: the
  stream-store lands it via `openBrowserForChatSession` in the
  right-sidebar store — the tab lands in the CHAT session's slice (id ==
  the sidecar session id), auto-opening only the ACTIVE slice (a
  background turn never yanks the visible sidebar); idempotent re-fires
  patch the URL.
- `{type:"screenshot", sessionId, frameId, tool, note?}` — emitted after
  every successful capture (the tools above; browser captures carry tool
  `"browser_control"` + note "browser panel"). Handled AFTER the
  live-turn guard (turn-scoped, like debug-*): appends
  `{frameId, tool, ts}` to `liveTurn.screenshots` (newest LAST, cap 8;
  the folded log owns no screenshot history by design — the bytes are
  ephemeral). SSE-only: never persisted, never model-facing; the frame is
  an enhancement (try/catch — a missing raster emits nothing, never
  breaks the tool). **ROUND-68 changed the frontend consumer** — see the
  ROUND-68 section (the frame itself is unchanged).

### Drift notes

- The `computer-use` monitor frames are unchanged, but the frontend now
  also LATCHES them: `holdForTurn(sessionId)` on any computer-use frame
  during an open turn, `releaseTurnHold` at turn end (every terminal
  path), `noteStopSignal` on a `stop_computer_control` frame — the
  monitor's live signal became `(liveActivity || any turn hold) &&
  !killSwitch` (the mini window no longer closes while the agent thinks;
  browser-only turns never hold).
- The PowerShell capsules now ride `-EncodedCommand` argv (no stdin), the
  key tool composes real SendKeys chords with a focused-element receipt
  readback, and probePermissions reports `addTypeOk` — none of these
  change the REST surface (the receipt payload gained the optional
  `focused` field; the refusal payloads gained `probeNote` and the
  helper-process `{pid, processRunning, ownsAccessibleWindow}` shape).
- Three R66 prompt lines were corrected to the R67 truth (get_state's
  scoping ×2, the default-target claim) and the golden fixture was
  regenerated by the sanctioned procedure (21 079 chars).


## ROUND-68 additions (implemented)

The computer-use overhaul round (the owner's v0.67.0 live Windows field
report: the screenshots shown at the wrong moment, the monitor burned
into captures, the SendKeys input path dead on modern .NET, the frontmost
refusals, the sparse Edge trees, the stale frames, the vision 429s). **No
new REST routes, no new SSE frame TYPES, no new tools, no new migrations**
— one SSE frame's CLIENT-side consumer contract changed, and the
computer-use receipts/refusals gained new payloads. The web-browse stack
the owner confirmed working is untouched.

### The `screenshot` SSE frame — the ROUND-68 consumer contract

`{type:"screenshot", sessionId, frameId, tool, note?}` is UNCHANGED on
the wire (same fields, same emitters — computer-use
screenshot/zoom/get_app_state + the browser_control screenshot action,
same try/catch enhancement semantics, still handled AFTER the live-turn
guard). What changed is what the frontend DOES with it (R68-A, the
owner: "The screenshots were supposed to be shown properly when they were
actually taken, not at the bottom in a dedicated section."):

- The stream-store now appends a `{type:"screenshot", frameId, tool, ts}`
  entry onto the OPEN `liveTurn.working` array (a new `WorkingEntry`
  kind, CLIENT-side state — nothing persists; the R67
  `liveTurn.screenshots` sidecar array, its cap-8, and the exported
  `LiveScreenshot` type are GONE).
- The sideband fires DURING tool execution, so the entry lands right
  after the in-flight tool row = the capture moment;
  `WorkingSection` renders the new `ScreenshotRow` INLINE at that
  position (the R67 `ScreenshotStrip` is deleted).
- NO cap on entries (the server-side 12-LRU/10-minute raster registry is
  the real limit — expired tiles render the honest "expired"
  placeholder). The raster route `GET /computer-use/frames/:frameId/
  raster` is unchanged (its CONSUMER is now the inline row — the main
  table row above is corrected).
- The debug full-turn export (`buildFullTurnText`) renders the live
  markers as `[screenshot captured by <tool>]` (no tool-number bump);
  the folded log still owns no screenshot history by design.

### Computer-use receipt / refusal payload changes (no route changes)

- **frontmost_pid_mismatch** (errors.ts): the message + recovery text
  now tell the truth about the R68 auto-activation — "the automatic
  re-activation of pid N was already attempted and failed" (dispatch's
  `withForegroundRetry` activates + retries ONCE before this refusal
  ever reaches the model).
- **Over-long model payloads refuse BEFORE the spawn** (windows.ts): the
  `type`/`set_value`/`write_clipboard` capsules that embed model text
  are measured pre-spawn — a payload composing a >31,875-char
  `-EncodedCommand` returns a self-teaching error ("…the Windows
  CreateProcess ceiling is 32,767 command-line chars — split it across
  multiple type calls") instead of a spawn failure. This is a new
  honest-error shape, not a refusal code.
- **MAX_FRAME_AGE_MS 10 s → 30 s** (session.ts): the `frame_stale`
  refusal now fires at 30 s (the vision roundtrip is 10–25 s; 10 s
  expired frames between observing and acting). The refusal code and
  recovery text are unchanged.
- **The vision relay retries 429/5xx** (vision.ts): two retries with
  [1500, 3000] ms backoff inside `describeRaster` (both wire formats
  share one attempt body; other 4xx fail fast) — the tool RESULT is
  unchanged on success, and the failure shape carries the last attempt's
  status.
- The Windows input path is raw SendInput end-to-end (the preamble's
  `LoadWithPartialName('System.Windows.Forms')` removed; SendText/
  Chord/TapKey/ModsDown/ModsUp in the one U32 Add-Type; the win/meta key
  is now a real LWIN chord instead of an honest refusal) — receipt
  shapes unchanged. `buildSnapshot` pokes Chromium's render widgets
  (WM_GETOBJECT) before the UIA walk with a sparse-retry — the
  `get_app_state`/`find_elements` result SHAPES are unchanged, the
  CONTENT gains real web elements on Edge/Chrome.

### Drift notes

- The mini monitor window's capture exclusion
  (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` in
  `src-tauri/src/mini.rs`) is a Tauri-shell change — no REST/SSE surface.
- The prompts/skill/tool-description teaching (BROWSER CONTENT IS
  SEARCHABLE, CHAIN DISCIPLINE, the auto-activation) changed the golden
  fixture only — no contract.

## ROUND-69 additions (implemented)

The computer-use enforcement layer (the residuals R68's own close-out
named; no owner field report). **No new REST routes, no new SSE frame
TYPES, no new tools, no new migrations** — the plugin's tool RESULTS
gained the observation payloads, two refusal codes joined the catalog,
and one existing SSE frame gained new `tool` values. The frontend is
untouched.

### The `screenshot` SSE frame — ROUND-69 emitters

`{type:"screenshot", sessionId, frameId, tool, note?}` is UNCHANGED on
the wire (the R67 shape, the R68 consumer contract). R69 adds two
EMITTERS after a mutating tool's receipt: the stale-frame
auto-refresh frame (`tool: "auto_refresh"`, note
"stale-frame auto-refresh") and the post-action OBSERVATION frame
(`tool:` the ACTION tool's name, note "post-action observation") —
both registered in the route-side raster cache, both rendered by the
existing inline `ScreenshotRow` pipeline. A failed observation capture
or an evicted raster emits nothing.

### The computer-use tool receipts (model-facing, not HTTP)

- **`observation`** on the 11 mutating tools' SENT receipts:
  `{frameId, screenChanged?, focusedElementName?, activeApp?:
  {pid, title}, titleChanged?} | {captureFailed: true}` (after a
  600 ms settle; every optional field omitted when honestly unknown).
- **`returnState`** (new tool-schema param on those tools):
  `"compact"` (default) / `"none"` / `"full"`.
- **`targetVerificationStatus`** gains `"changed" | "unchanged"`
  (coordinate clicks, upgraded from `"unverified"` by the
  observation); **`hitElementName`** rides coordinate-click receipts.
- **New refusal codes**: `frame_changed` (payload
  `{refreshFrameId}` — the screen changed; a fresh frame is already
  registered; zoom it and retry) and `screen_unchanged` (the 3rd
  consecutive near-identical model capture refused pre-registration
  with act / wait() / find_elements guidance). `frame_stale` is now
  reachable only for `set_value` / `left_mouse_down` / the honest
  unhashable-refresh fallback (pointer tools auto-refresh first).
- **`GET /computer-use/frames/:frameId/raster`** is unchanged — the
  new observation/auto-refresh frames register in the same LRU-12 /
  10-min-TTL registry the route serves.

### Drift notes

- The frame aHash/provenance (`agent-core/src/computer/framehash.ts`,
  pngjs@7 MIT — 134 prod deps, audit CLEAN) and the dispatcher's
  spam-guard/auto-refresh logic are engine-internal — no wire surface.
- The long-type stdin paste channel, the HWHEEL scroll math, the
  dual-object Chromium poke, and the mini monitor's
  `WS_EX_NOACTIVATE` are backend/shell changes — no REST/SSE surface.

## ROUND-70 additions (implemented)

The agent brain round (research-driven; no owner field report). The REST
surface gained only the skills changes above — the round lives in the
prompt, the tool outputs, and the skills system (engine-internal).

### `GET /api/v1/skills` — the merged listing + the file-skill 409s

See the ROUND-61 table (updated in place): the listing merges DB rows,
every registered project's `.acute/skills/` files, and user-global
`~/.agents/skills/` files, with provenance (`source` gains
`project-file`/`global-file`; `filePath` + `projectName` additive); file
bodies are read from disk at call time. `PATCH`/`DELETE` on a file-skill's
synthetic id (`skill_file_p_…`/`skill_file_g_…`) → 409 "file-defined
skill: edit the SKILL.md" (the UI's existing row-error path surfaces it —
zero frontend changes).

### `read_skill` gating + the agent allowlist

`read_skill` and the prompt's SKILLS section share ONE resolver
(`agent-core/src/storage/skills-files.ts` `resolveEffectiveSkills`):
enabled DB skills (the `computer-use` builtin DROPPED while the master
switch is off — refused with the specific dark-tools message), then file
skills not shadowed by any DB name, then the agent's `skills` array as a
filter (non-empty = allowlist — the field was stored and patched since R61
and never read; wired this round). Plan mode keeps `read_skill` in its
tool set (`PLAN_MODE_TOOLS`).

### `read_file` — offset/limit params (model-facing tool schema)

The read_file TOOL's schema gained `offset` (1-based line number,
  default 1) and `limit` (line count, default the whole file), and its
  output is now `cat -n`-style line-numbered with honest validation errors
  (non-integer / past-EOF / limit<1), an empty-file message, and a
  line-aligned head+tail + paging marker for >256KB windows. The REST
  viewer route `GET /projects/:id/file` is UNCHANGED (byte-exact raw
  content — only the MODEL-facing tool output is numbered).

### `run_command` output shape (model-facing, not HTTP)

Oversized output (the 64KB cap) now renders head 32KB + tail 32KB with an
explicit `…[output truncated: N bytes omitted from the middle — the first
32KB and the last 32KB are kept]…` marker (one shared clip in
`agent-core/src/tools/exec.ts` for normal completion, timeouts, and
background-launch pre-exit output); zero-stdout success says "(no output —
the command ran successfully and printed nothing)". `job_status`'s
empty-log-file case explains itself. No REST/SSE surface changed.

### Drift notes

- The event log's tool-result summaries changed SHAPE (model-facing):
  `read_skill`/`memory_recall` results persist with a 60K budget
  (STICKY_RESULT_TOOLS in `agent-core/src/agents/chat.ts`) instead of the
  4K head+tail cap — the persisted `tool.result` payloads for those two
  tools can now be much longer. Replay-side, sticky lines skip the
  200-char stub (`assembleHistory`).
- The system prompt's composition changed (grounding/consolidation/
  conventions/discipline/communication + the panel trims; the golden
  fixture regenerated by the sanctioned procedure, 22,625 → 20,156
  bytes) — prompt-only, no route contract.
- The 8 builtin skill bodies seed via `INSERT OR IGNORE` at DB open — no
  migration (an existing DB gains the 7 new rows on next open; user edits
  persist).

## ROUND-71 additions (implemented)

The discipline & reliability round (research-driven; no owner field
report). The REST surface gained NOTHING new — the round lives in the
prompt, the tool output strings, and the failure paths — but three
existing surfaces changed shape ADDITIVELY:

### The PROVIDER_ERROR 502 envelope + `turn.error` event — the error class

`classifyProviderError` (`agents/error-classification.ts` since R75,
runtime.ts re-exports) classifies every
provider/stream failure into six classes — `context_window_exceeded` /
`auth` / `rate_limit` / `network` / `timeout` / `unknown` — BEFORE
flattening. Additive payload changes (older readers ignore the new
fields; the existing message prefix and retry policy are unchanged):

- the 502 envelope's `details` gains `errorClass` (the class id) and
  `classMessage` (the class-specific honest one-liner); the message
  itself gains `(class: <id>)`, and the twice-overflow case (recovery
  already ran) names it: "context window exceeded even after compaction
  — start a new session or /compact";
- the persisted `turn.error` session event payload gains `errorClass`.

### The `meta.overflow_recovery` SSE frame (NEW frame type, same family
as `meta.compaction`)

When a classified context-window overflow hits a turn with NOTHING
streamed yet, the runtime emits
`{"type":"meta.overflow_recovery","sessionId":…,"message":"[context
overflow → auto-compacted conversation → retrying]"}` before forcing a
compaction and retrying the turn ONCE. SSE-only, never persisted, never
model-facing; the chat UI's stream-store deliberately ignores unlisted
meta frames (the documented contract — same as `meta.compaction`), so
no frontend change is required; extend the consumer union only when a
UI starts rendering it.

### Model-facing (non-HTTP) drift notes

- `read_file`'s >256KB truncation marker now carries the file's TOTAL
  line count and the exact next call ("use offset=N to continue"); the
  degenerate single-line cap says honestly that no continuation call
  can reach the middle and names `search_code`/`run_command` as the
  recovery tools; `run_command`'s 64KB middle-omission marker teaches
  the spill-to-file recovery path. Tool-output strings only — no route
  contract.
- `edit_file` failures now escalate by consecutive-failure count
  (NEW `agent-core/src/tools/edit-streak.ts`, per-session in-memory):
  the 2nd anchor failure appends "re-read the file and copy the anchor
  EXACTLY", the 3rd/4th "change your approach", the 5th+ refuses the
  pattern; a success resets the streak. The `ok:false` shape is
  unchanged — only the output text grows.
- Owner DENIALS of approvals (command / web request / computer-use
  consent) now read "this is NOT a tool or system failure" with timeouts
  and aborts distinguished from denials — `ok:false` contract unchanged,
  note text only.
- The builtin skills are now TWELVE (8 → 12: focused-fix,
  zero-hallucination, self-eval, ship-gate at sortOrder 8-11) and all
  descriptions were rewritten trigger-rich — same `INSERT OR IGNORE`
  seeding, no migration, no route change; `GET /skills` shows the new
  rows on an existing DB at next open (description text updates do NOT
  overwrite user-edited rows — by design).

## ROUND-72 additions (implemented)

The adaptive capability round (the owner's "on the basis of the task"
directive; no owner field report). The REST surface gained NO new
routes and NO payload removals — one additive response field on
`GET /skills` (documented at the route row above) and one tool-schema
parameter (documented at the read_skill row above). The rest of the
round is model-facing:

### `GET /skills` — the `references` metadata (additive)

File-skill entries (source `project-file`/`global-file`, dir-form
skills only) now carry `references: [{name, fileName, bytes}]` — the
skill's `references/` subdirectory listed as METADATA ONLY (one level
deep, .md only, ≤8 files, ≤64KB each; larger/odd files skipped +
logged; sorted by fileName). Flat-file skills carry `[]`; DB rows
OMIT the field entirely. Reference CONTENT is never served over REST
(the settings listing stays metadata-only by design) — the agent
loads it with the `read_skill` tool. Zero route/frontend changes
required (the field is additive; the merged listing is
`listAllSkillsMerged` in `agent-core/src/storage/skills-files.ts`).

### Tools: `read_skill`'s optional `reference` param (tool schema)

`read_skill {name, reference?}` — with `reference` absent/blank the
call loads the skill BODY exactly as before (file-skill bodies now
append a "references available: a, b — load with read_skill { name:
…, reference: "a" }" listing block when the skill carries references;
DB and reference-less file skills are byte-identical to R71). With
`reference` set: the name resolves through the SAME
`resolveEffectiveSkills` index first (the computer-use gate and the
agent `skills` allowlist fire identically with or without the
reference — resolve, then load), then the reference NAME is sanitized
(traversal/separators → `ok:false` with the reason), then the file
loads (`# Skill: <name> — reference: <ref>` header, the reference's
own frontmatter stripped, 64KB cap, ENOENT honest, the 60K output
budget trimmed WITH an honest marker). DB skill + reference → the
honest "database skills carry no reference files". The core-skills
plugin manifest version 1.1.0 → 1.2.0 (manifest-level; the plugin
catalog in `GET /plugins` reflects it).

### Model-facing (non-HTTP) drift notes

- **The SKILLS prompt section can now carry ONE advisory "Task
  signal" line** — computed per turn by the deterministic matcher
  (`agent-core/src/agents/task-hints.ts`: quoted phrases from the
  skill descriptions × their word count, stopword-filtered tokens +1,
  top-2 above threshold, against the turn's user message):
  "Task signal: this request looks like it matches **<name>** —
  consider calling read_skill with that name FIRST". Prompt-section
  text only — no route contract; the golden fixture stayed
  BYTE-IDENTICAL (the ctx field is optional and unset in the golden).
- **`read_file` may append a conventions reminder** — when a
  directory STRICTLY BELOW the project root on the read file's path
  carries its own AGENTS.md (or CLAUDE.md), the first `ok:true` read
  under that directory per session appends, after the numbered
  content, a clearly-fenced
  `--- [conventions from <dir>/AGENTS.md apply to this file] ---
  <excerpt ≤2,000 chars> --- (end conventions — …)` block (NEW
  `agent-core/src/tools/dir-conventions.ts`; root files never carry
  one — readCustomRules already injects the root ladder into the
  system prompt). The `ok:true` shape and the raw REST file-viewer
  route are unchanged — only the tool output can grow.
- The builtin skills are now EIGHTEEN (12 → 18: tdd, api-design,
  frontend-craft, typescript-craft, security-review, refactoring at
  sortOrder 12-17) — same `INSERT OR IGNORE` seeding, no migration,
  no route change; `GET /skills` shows the new rows on an existing DB
  at next open (description/body updates do NOT overwrite user-edited
  rows — by design, the standing R71 note).

## ROUND-73 additions (implemented)

The task modes round (the posture tier of the owner's "proper detailed
system prompts which the agent accesses when required and on the basis
of the task" directive). The REST surface gained TWO routes/fields —
`GET /projects/:id/modes` (new), the `PATCH /sessions/:id`
`activeMode` field (the route itself predates this round; documented at
its row above), and `activeMode` on session rows — plus one new tool.
The rest of the round is prompt-side and tool-side:

### `GET /projects/:id/modes` — the mode index (metadata only)

`{modes: [{id, name, description, source: "builtin"|"file"}]}` — the
six builtins (plan/debug/build/review/explore/refactor, sortOrder
10-60) plus the project's `.acute/agents/*.md` customs (a custom whose
id equals a builtin's SHADOWS it — one entry, custom wins; ≤8 files;
≤16,000-char bodies; ≤500-char descriptions). 404 unknown project.
Resolved through the ONE `resolveEffectiveModes(project.rootPath)` that
`prepareTurn` and `switch_mode` also use, so the picker, the prompt's
TASK MODES index, and the tool can never disagree. **METADATA ONLY —
mode bodies are never served over REST** (the deep module rides the
system prompt's ACTIVE TASK MODE section while active; `switch_mode`
returns it once on activation) — the `GET /skills` honesty, applied to
the sibling tier.

### `PATCH /sessions/:id` — the `activeMode` field

Body `{title?, activeMode?}` (each independently optional; see the
route row above for the full validation contract). `activeMode: "debug"`
sets the session's task mode; `null` clears it; absent leaves it
untouched. An unknown id is a `400 VALIDATION` carrying
`availableModes` (the resolvable ids for the session's project) in
`details`, validated BEFORE any write — a bad mode never renames the
session as a side effect. Enforcement is at TURN time: `prepareTurn`
resolves the id through the same resolver, composes the ACTIVE TASK
MODE prompt section with the body verbatim while set, sweeps a VANISHED
custom mode clear with a one-turn honest note, and intersects a
file-mode's `tools` frontmatter into the session's tool allowlist
(narrow-only; unknown names drop; empty intersection → the NO_TOOLS
sentinel).

### Tools: `switch_mode` (the 26th TOOL_NAMES entry)

NEW `agent-core/src/tools/plugins/modes.ts` (the `core-modes` plugin,
1.0.0) — ALWAYS REGISTERED (the read_skill declaration-context
pattern; gated on toolDeps at execute time): `switch_mode {mode?}` —
no arguments → the mode index + which mode is active + the usage line;
`{mode: "<id>"}` → ACTIVATE (the session row's `active_mode` is set
via the storage-level `updateSessionActiveMode` — the same writer the
PATCH route uses — and the FULL posture guide returns ONCE, followed
by the fenced task-mode reminder); `{mode: "none"}` (also "off"/"auto"/""
+ an actual JSON null) → DEACTIVATE (idempotent, honest no-op when
nothing is active). Unknown id → `ok:false` + the available ids + the
`.acute/agents/*.md` hint. The description teaches the schema-clean
sentinel `"none"` (the input schema is type "string"; a nullable union
does not validate cleanly on every strict provider — both are
accepted, the reliable one is taught). `switch_mode` also joined
`PLAN_MODE_TOOLS` (the R70-b D4 dark-tools honesty rule: plan
permission mode advertises the TASK MODES index + its Task signal
line, so the switch must not be dark there).

### Model-facing (non-HTTP) drift notes

- **The prompt gained two STRICTLY-GATED sections** (the registry's
  21 → 23; both directly after SKILLS; both overridable via
  `.acute/prompts/task-modes.md` / `active-mode.md`):
  `## TASK MODES (posture modules — activate with switch_mode)` — the
  available-mode index (id + name + description), the division line
  ("Skills carry methodology you read with read_skill; a task mode
  changes your operating POSTURE for a class of work … nothing
  auto-activates"), the per-turn advisory "Task signal: this request
  looks like the **<id>** posture — consider switch_mode FIRST" (the
  R72-a deterministic matcher, extended to mode descriptions via
  `computeModeHints` — same scorer, id-keyed, `computeTaskHints`
  behavior unchanged), and the bracketed one-turn note when a stale
  custom mode was swept; `## ACTIVE TASK MODE — <Name> (<id>)` — the
  activation note (ends "Clear with switch_mode { mode: \"none\" }.")
  + the mode body VERBATIM, every turn while active. **The golden
  fixture stayed BYTE-IDENTICAL** (md5 3a5d2c7d…, both ctx fields
  optional and unset in the golden).
- **The system-reminder renderer** (NEW
  `agent-core/src/agents/system-reminders.ts`) is now the ONE fenced-
  reminder mechanism — the R72-d per-directory conventions reminder
  renders through it BYTE-IDENTICALLY (`r72-dir-conventions.test.ts`
  green unmodified) and `switch_mode`'s activation reminder is its
  second consumer; a per-turn `ReminderBudget` (default 3) bounds the
  family. The `read_file` conventions contract documented in the
  ROUND-72 additions is unchanged.
- The builtin skills are now TWENTY (18 → 20: spec-planning,
  performance at sortOrder 18/19) — same `INSERT OR IGNORE` seeding,
  no migration, no route change; the standing R71/R72 note (existing
  rows keep their text) applies.

## ROUND-75 additions (implemented)

The reliability & enforcement round. No new routes; three surfaces
changed ADDITIVELY and the failure paths gained a retry ladder:

### `GET /projects/:id/modes` — the `readOnly` field (additive)

Each row gains `readOnly: boolean` (true for plan/review/explore) — the
mode-policy enforcement tier (`agents/mode-policy.ts`), so the picker
badges read-only postures without duplicating the set.

### The `meta.retry` SSE frame (NEW frame type, the `meta.*` family)

While the transient-API retry ladder (`lib/retry.ts`:
RETRY_LADDER_MS = [immediate, 1.5 min, 5 min, 10 min, 30 min], six total
attempts) waits out a rate_limit/network/timeout failure, the stream emits
`{type:"meta.retry", sessionId, attempt, totalAttempts, waitMs, retryAt,
errorClass, message}` on entry and every 60 s tick
(keep-alive + live countdown); the frontend renders the amber
`RetryStatusCard` (role=status) and clears it on the first content frame.
auth/context_window_exceeded/unknown NEVER ladder (fail fast). SSE-only,
never persisted, never model-facing; a user Stop aborts the wait.

### Error payloads gain `attempts`; the 502/`turn.error` shapes

The 502 envelope's `details` and the persisted `turn.error` payload gain
`attempts` (additive; `errorClass`/`classMessage` since R71). Two honesty
fixes: the sync `POST /sessions/:id/messages` path no longer lies
`ok:true` on a failed sub-agent after partial replies (honest 502 + the
completed iterations' usage recorded), and the boot sweep
(`sweepStaleRunning`) writes an INTERRUPTED `turn.error` event + resets
the session to `queued` instead of terminal `failed` (retryable, no 409).

### Model-facing (non-HTTP) drift notes

- `chat.ts` now re-throws fullStream error PARTS (the AI SDK delivers
  post-retry provider errors as parts, not throws — the live-429 find);
  without it real 429s classified `unknown` and could never ladder.
- Task modes are HARD-enforced (see the PATCH /sessions/:id row): the
  composition order in `prepareTurn` is agent allowlist → delegation depth
  → permission mode → custom-mode `tools` frontmatter (R73) → task-mode
  policy (R75); `switch_mode` refuses to leave or clear plan/review/explore
  (owner-pinned); delegated children COPY the parent's `activeMode`
  (`createSession` gained the input — internal, not a REST field).
- `meta.overflow_recovery` is now typed + rendered (was untyped
  fall-through since R71).

## ROUND-78 additions (implemented)

The honest-errors + queue round. Two NEW route pairs, one NEW event type,
three NEW SSE frames, and additive fields on the retry/error surfaces:

### `GET /settings/retry` + `PUT /settings/retry` (the DebugSettings pattern)

`GET` → `{autoRetryRateLimit: boolean, autoRetryTimeout: boolean,
autoRetryNetwork: boolean}` (all default TRUE — the R75 ladder behavior out
of the box; keys `retry.autoRetry*` in the settings table). `PUT` accepts a
PARTIAL body of booleans → 200 with the updated object; a non-boolean field
→ 400 VALIDATION with `details.field = "body.<field>"`. The runtime reads
the settings once per turn and gates the retry ladder PER CLASS: a disabled
class fails fast through the honest terminal path (attempts 1, no
`meta.retry` frames, the real provider text on the card). Bearer-gated like
every /api/v1 route.

### `POST /sessions/:id/queue` + `DELETE /sessions/:id/queue/:seq` (NEW)

- `POST /sessions/:id/queue` `{content, attachments?}` — validates exactly
  like the send routes (content shape, attachments, 404 unknown session,
  409 terminal status). Requires a LIVE registered turn: no live turn →
  **409 `{error:{code:"NO_LIVE_TURN", message:"no live turn for this
  session — send the message normally"}}`** (the panel catches the code and
  falls back to a normal send). Success appends a `message.queued` event
  and bridges a `user.queued` frame onto the OPEN SSE stream via the turn
  registry's notify hook (`registerTurn(id, controller, notify?)` /
  `notifyTurn(id, event)` — a dead/throwing notifier never fails the POST)
  → `200 {ok:true, seq}`.
- `DELETE /sessions/:id/queue/:seq` — removes an UNDELIVERED queued event
  (the chip's remove / send-now path) → `200 {ok:true}` | 404 (absent or
  already delivered — a delivered row is transcript history) | 400 (bad
  seq).

### The `message.queued` event + the delivery FLIP

A queued message is a `session_events` row of NEW type `message.queued`
with the exact `message.user` payload `{role:"user", content,
attachments?}` (+ agentId/ts stamped by appendSessionEvent). NOTHING
existing reads it — `assembleHistory` and the fold skip unknown types (test-pinned). **Delivery is a strict type FLIP** (`message.queued` →
`message.user` on the same row; seq/ts/payload untouched), so the message
lands exactly where it was QUEUED — the model sees it at the next model
call, in the same prompt as the completed tool results. Three delivery
paths:

1. **Loop-top (mid-turn)**: every outer-loop iteration of the streamed turn
   flips undelivered queued events BEFORE `assembleHistory` and emits one
   `queued.delivered` frame each (delivery spends no outer-loop budget).
   Because the R75 ladder's retry `continue` re-enters the loop top, a
   message queued during a ladder wait delivers at the next rung boundary.
2. **Turn-end continuation**: after a SUCCESSFUL turn the streamed route
   checks the queue — non-empty and under the 25-continuation cap →
   `meta.queue_continue {count}` frame, the FIRST queued event is CONSUMED
   (deleted; its content/attachments become the next
   `runStreamedAgentTurn`'s args), the REST flip directly (they ride the
   continuation turn's iteration-0 history as ordinary user events), and
   the SAME SSE stream runs another full turn (own `message.user` + usage
   + task_complete). The debug analyst + the terminal `done` frame run
   ONCE after the loop exits; ABORTED/error break the loop (queued
   messages STAY queued); one registerTurn + one abort controller span the
   whole loop (a Stop aborts the in-flight continuation). The sync path
   and sub-agents have NO interactive queueing (no owner composer) — they
   inherit only the pre-flip.
3. **Pre-flip (crash/stop recovery)**: BOTH turn functions call
   `deliverAllQueuedMessages` BEFORE their own `message.user` append — a
   queue left by an aborted turn or a sidecar kill always delivers, in
   order, ahead of the next message (no frames; the folded log owns the
   render).

### New SSE frames + the honest retry fields

- `{type:"user.queued", seq, content, ts}` — rides the OPEN stream at
  queue-POST time (the notify bridge), renders the amber chip.
- `{type:"queued.delivered", seq, content, ts}` — loop-top delivery (chip →
  user bubble).
- `{type:"meta.queue_continue", count}` — before each continuation turn.
- `meta.retry` gains `providerError?: string` — the scrubbed REAL provider
  text (unwrapped from any SDK RetryError by `providerErrorDetail`), so the
  live RetryStatusCard shows the API's actual words under the class chip;
  the same field rides the 502 envelope's `details` and the persisted
  `turn.error` payload.
- **`classMessage` semantics changed (honest)**: it is now the key-scrubbed
  REAL provider text (240-char cap) — the R71 generic one-liners demote to
  the empty-text fallback (still exported as `CLASS_MESSAGES`). Only a REAL
  rate limit ladders; 403s whose body says region/moderation/permission/
  unavailable reclassify from `auth` to fail-fast `unknown` with the real
  text; plain 403 stays auth; 401 stays status-only auth.
- Frontend fold: `toProjectChatItems` folds a `message.queued` row into the
  NEW item kind `"queued"` `{kind, seq, content, ts, attachments?}` (never
  a turn boundary; a flipped row is an ordinary user item).

### Model-facing (non-HTTP) drift notes

- `agents/error-classification.ts` exports NEW `unwrapRetryError` (an
  AI_RetryError → its `lastError`, else the last `errors[]` element) +
  `CLASS_MESSAGES`; `classifyProviderError`/`extractStatus` read the
  UNWRAPPED error (status walk over `lastError`/`errors`, depth ≤ 4,
  cycle-guarded); `userMessage` is the real text.
- `runtime.ts` re-exports `unwrapRetryError` + `CLASS_MESSAGES` alongside
  the historical surface.

## ROUND-79 additions (implemented)

The orchestrator round — the standing R73 deferral (ADR-0028): the
addressable-delegation tier. NO new REST routes and NO new SSE frame
types; the changes are the tool's semantics, one additive field on two
existing shapes, and one NEW event type.

### `delegate_task` — the tool semantics (not an HTTP surface)

```
delegate_task({
  task?: string,          // the self-contained task (delegate path)
  role?: "planner"|"researcher"|"coder"|"reviewer"|"tester",
  task_id?: string,       // 1–64 chars: ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$;
                          // unique among this session's delegations;
                          // REQUIRED with background:true
  background?: boolean,   // true = fire-and-forget (the immediate receipt)
  resume?: string         // task_id | child session id | 4-char code
})
```

- **resume present** → the COLLECT path (task/role ignored): resolution
  precedence task_id → child session id → `subAgentCode(id)`
  (case-insensitive). Child `queued|running` → the call WAITS (~300 ms
  session-status poll, bounded by the child's own lifecycle — watchdog /
  retry ladder / owner Stop — never an artificial timeout; the parent
  turn's abort → the honest "STILL RUNNING — resume it in a later turn;
  do not re-delegate" line). Child `completed` → the final report (the
  same last-non-empty-assistant extraction the `/subagents` row shows,
  so tool and panel can never disagree), returned IDEMPOTENTLY on
  re-resume. Child `failed` → the ADR-0022 §3 "continue from where you
  stopped" retry, awaited (no prior progress → the original task
  re-sends). Unknown address → honest refusal + the ADDRESSABLE LIST
  (every child: task_id when present, session id, 4-char code, role,
  status).
- **resume absent, task present, `background:true`** → REQUIRES task_id
  (else the honest refusal teaching both fixes). The call returns
  IMMEDIATELY: the receipt (task_id, child session id, code, role,
  model + the "resume to collect" instruction). The child runs DETACHED
  through the same machinery as the blocking path (status frames,
  notifications, watchdog, turn-registry, key-slot; queued while the
  semaphore is full). Detached failures settle via the run's own
  handlers — never an unhandled rejection, never a silent death. The
  child's wrapped emit is BEST-EFFORT (a background child routinely
  outlives the parent's SSE; a throwing emit is swallowed). The parent
  turn's abort signal cascades to the detached child (no zombie spend
  after a Stop); a misbehaving background task is stopped by the OWNER
  from the Sub-agents panel (the existing Stop surface).
- **resume absent, task present, no background** → the BLOCKING default,
  verbatim pre-R79 behavior (+ the optional task_id: validated,
  duplicate-checked, `delegation.collected`-marked at completion — the
  report was delivered inline).
- **Honest refusals (the tool NEVER throws; every failure is
  `{ok:false, output}`):** task_id grammar, duplicate task_id (naming
  the existing task's status), background-without-task_id,
  ≥10 outstanding background children of this parent in
  `queued|running` WITH a task_id (the runaway fan-out cap, listing
  them), and neither-task-nor-resume (the addressable list).

### Additive fields + the new event

- `GET /sessions/:id/subagents` rows gain **`taskId: string | null`**
  (migration 0028's `sessions.delegate_task_id`; null = every pre-R79
  child and every unaddressed delegation).
- The **`subagent-status` SSE frames** gain the same optional `taskId`
  (present from the queued frame onward for addressable children;
  absent on unaddressed ones — pre-R79 frames unchanged). The
  frontend's live map carries it forward between frames.
- **`delegation.collected`** — a NEW `session_events` row type on the
  PARENT's log, payload `{taskId, childId, childCode?}` (+
  appendSessionEvent's agentId/ts). Written when a BLOCKING delegation
  with a task_id completes (inline delivery) and when `resume` returns a
  background task's report (or retry outcome) — idempotently. NOTHING
  else reads it: `assembleHistory` skips the type by construction (the
  R78 `message.queued` pattern) and the frontend's event fold
  (an allowlist chain) never knew it existed. It is the collected
  marker the reminder filters on.

### The model-facing reminder (the delivery channel — a system-prompt
section, not an API)

Per turn, `prepareTurn` composes `backgroundTasks` (the taskHints
ephemeral pattern: rebuilt every turn, never persisted, never a message
mutation): a cheap indexed guard (`LIMIT 1` on
`idx_sessions_parent_task`) — empty → NO section, childless sessions
compose byte-identically; non-empty → the parent's children WITH a
`delegate_task_id` that are NOT yet collected (status, role, code, todo
progress, elapsed minutes; capped at 10 rows). `prompts.ts` renders the
`## BACKGROUND TASKS` section: the header instruction
("call delegate_task {\"resume\":\"<task_id>\"} to WAIT for a task and
collect its final report; do not poll") + per-status lines
(running "Xm in, n/m todos" / COMPLETED — resume to read its final
report / FAILED (<error>) — resume to retry it from where it stopped /
queued — waiting for a concurrency slot) + `…and N more`. The
prompt-registry section id is `background-tasks` (count 23→24,
strictly ctx-gated — the golden fixture's byte-identity proof).

### Drift notes

- Migration **0028** (`agent-core/src/storage/migrations/
  0028_delegation_task_id.sql`): `sessions.delegate_task_id TEXT` (NULL
  default) + `idx_sessions_parent_task(parent_session_id,
  delegate_task_id)` + the audit_log row. Set only through
  `createSession`'s `SessionInput.taskId` (the orchestrator's gated
  path); immutable for the child's lifetime.
- `agents/orchestrator.ts` exports the new surface
  (`delegateBackground`, `resumeTask`, `addressableChildrenOutput`) and
  the shared `runChildTurn` extraction; `storage/sessions.ts` exports
  `buildBackgroundTasksReminder`, `appendDelegationCollected`,
  `collectedChildIds`, and the `SubAgentRow.taskId` mapping.
- Frontend: `api.ts`'s `SubAgentStatus.taskId` + the frame's optional
  `taskId`; `stream-store.ts`'s live entry carries it; the chips render
  only when non-null (`subagent-taskid-chip` in the Sub-agents panel
  header, `subagent-card-taskid` on the chat card).

## ROUND-80 additions (implemented)

The reliability round (the owner's four-clause field report: silent
stops / raw errors / retry customization / NVIDIA). NO new REST routes
and NO new event types; the changes are three additive fields on
`/settings/retry`, two NEW turn-error codes, one NEW seeded provider,
and the raised error-detail caps.

### `GET /settings/retry` + `PUT /settings/retry` — the schedule fields

The R78 object gains three fields (all default = the R75 behavior,
byte-identical when unset):

- **`maxAttempts`** — total provider attempts per turn (initial call +
  rungs), integer 2–10, default 6. Settings key `retry.maxAttempts`.
- **`waitMinutes`** — the rung waits in MINUTES (JSON array; rung i =
  the wait before attempt i+2), 1–9 entries of 0–1440 each, default
  `[0, 1.5, 5, 10, 30]`. Settings key `retry.waitMinutes` (stored as
  JSON; read defensively — corrupt entries fall back rung-by-rung).
- **`providerTimeoutSeconds`** — the per-call provider ceiling,
  integer 60–3600, default 600 (the old hardcoded
  `PROVIDER_CALL_TIMEOUT_MS`). Settings key
  `retry.providerTimeoutSeconds`.

`PUT` accepts them in the same partial-patch style as the booleans;
out-of-bounds values → 400 VALIDATION with `details.field` naming the
offending field (the route validates AND the storage layer re-validates
— the same bounds both places). The runtime resolves the schedule once
per turn via `resolveRetrySchedule(retrySettings)` (agent-core
`lib/retry.ts` — defensive: missing/out-of-bounds values fall back
rung-by-rung to the R75 defaults, so a corrupt row can never produce a
zero-rung or negative-wait ladder) and threads `timeoutMs` into the
chat/chatStream inputs; every `meta.retry` frame's
`totalAttempts`/`waitMs`, the `task_failed` notification's schedule
line, and the Settings card's footnote follow the RESOLVED schedule.
New exported surface: `resolveRetrySchedule`, `describeRetrySchedule`,
`DEFAULT_RETRY_MAX_ATTEMPTS`, `DEFAULT_RETRY_WAIT_MINUTES`,
`DEFAULT_PROVIDER_TIMEOUT_SECONDS`, and the three bounds tuples.

### Turn outcome codes: `CONTEXT_LIMIT` + `REQUEST_LIMIT`

The streamed turn's 502 `TurnOutcome.code` union (and the persisted
`turn.error` payload `code`) gains both — the 800k-token context guard
and the 200-request guard now end through the honest terminal path
(persisted turn.error + usage + the 502 outcome + the session reset to
`queued`; pre-R80 they broke the loop with `ok:true` + SSE-only meta
frames). The route-level crash handler also persists now: an unexpected
exception inside the stream route writes a best-effort `turn.error`
(code `INTERNAL_ERROR`, `route crash: <message>`) + the `task_failed`
notification, both crash-guarded — the live error frame remains the
guaranteed terminal event.

### The SSE truncation guard (adapter semantics, not a frame change)

`streamAiSdkChat` counts finish-step parts: zero finish-steps + content
deltas streamed → the honest throw
`provider stream ended without a finish signal — the connection closed
mid-response (truncated output)` instead of a synthesized finish
(classified `network` — the ladder engages; the partial text is
preserved by the R75 flush). Three meta frame types are now TYPED in
the frontend union (the store takes no action by design — the
persisted turn.error + the error card own the render):
`meta.context_limit {tokens, limit}`, `meta.request_limit {requests,
limit}`, `meta.continuation_complete {iterations}`.

### The NVIDIA provider seed + the raised caps

- `nvidia` joins `RESERVED_PROVIDER_IDS` + `BUILTIN_PROVIDER_SEEDS`
  (id `nvidia`, name "NVIDIA",
  https://integrate.api.nvidia.com/v1, chat-completions,
  openai-compatible) — the adapter speaks it as-is; models load through
  the existing `GET /providers/:id/models`. The packaged app injects
  the key via `ACUTE_PROVIDER_NVIDIA` (keys.rs
  `provider_key_env_targets`, 4→5 entries); dev mode reads env →
  `~/.acute/nvidia.key`. The `nvapi-…` prefix is scrubbed on every
  key-redaction surface (`error-bus.ts` SCRUB_PATTERNS, `chat.ts`
  summarizeToolOutput).
- Error-detail caps raised for the raw-visibility ask:
  `providerErrorDetail` 500 → **4000** chars, the userMessage one-liner
  240 → **600**, the providers/registry `scrub` 500 → **4000** and
  `upstreamErrorDetail` 160 → **2000**, the debug-analyst error slice
  300 → **2000**. Key-scrub discipline unchanged everywhere.

## ROUND-80.5 additions (documentation backfill — routes shipped R28-R79, first documented now)

The R80.5 modularity audit found these shipped routes missing from this truth doc.
No behavior changed in R80.5 — this section only closes the documentation gap:

- `GET /api/v1/notifications?unread=&limit=` → `{notifications:[…], unread}` —
  the notification-bell list (limit default 50, invalid values fall back to 50;
  `unread=1|true` filters unread only).
- `GET /api/v1/notifications/stream` — SSE (hijacked raw socket, same CORS pattern
  as the message stream): a `hello` frame first `{type:"hello", unread}`, then one
  `data:` frame per published notification; the client opens it once on app boot
  (fetch-stream, not EventSource — auth header).
- `POST /api/v1/notifications/:id/read` → `{ok, unread}` (404 when no UNREAD
  notification with that id); `POST /api/v1/notifications/read-all` →
  `{ok, cleared, unread:0}` (the bell's clear-all).
- `GET /api/v1/sessions/:id/checkpoints` → `{checkpoints:[{id, seq, path,
  toolName, ts, hadBefore}]}` — the snapshot list WITHOUT content BLOBs (404
  unknown session). Companion: `GET /api/v1/sessions/:id/snapshots/:seq` → the
  full `{…, beforeContent, afterContent}` for ONE snapshot (400 invalid seq, 404
  no snapshot at that seq — older sessions pre-R25); DiffCard renders the real
  unified diff from this. (The restore route `POST /checkpoints/:id/restore` was
  already documented in ROUND-28.)
- `GET /api/v1/projects/:id/index` → `{index: <summary>}` — the codebase-index
  summary (built by `index_project`; 404 unknown project).
- `POST /api/v1/projects/:id/search` `{query, kind:"files"|"symbols"|"content",
  case_sensitive?, whole_word?, file_glob?, max_results?}` → kind-specific results
  (symbols from the index, capped 50; content/files via the grep/file search tools;
  400 empty query; 404 unknown project). The CommandPalette ⌘K data source.
- `GET /api/v1/projects/:id/demos` → `{demos:[{name, path, size, modifiedAt}]}`
  — the in-app demo viewer's directory walk of `<project>/demos/` HTML files
  (empty list when the dir doesn't exist; 404 unknown project).
- `POST /api/v1/providers/:id/keys/reveal` → `{keys:[{slot, value}]}` — every HELD
  slot's full value (the settings key-pool reveal; getPool never logs, only reads;
  404 unknown provider).
- `POST /api/v1/sessions/:id/subagents/:childId/retry` → `{ok, message}` — the
  R79 retry of a failed child from where it stopped (404 unknown session/child or
  child not under :id; 409 child already running; 502 PROVIDER_ERROR on failure —
  orchestrator `retryChild`).

## ROUND-81 additions (the unified operating modes)

ADR-0029. The value-set changes (all fail-closed, all migrated by
`0029_unified_modes.sql`):

- `PATCH /sessions/:id/permissions` — `{mode: "full"|"ask"|"plan"}` (editor
  retired: 400 + `details.hint` naming the ask mapping; legacy rows remapped
  at read time and durably by migration 0029).
- `GET /projects/:id/modes` — unchanged shape; `readOnly` is now always
  `false` (postures are non-enforcing guidance; kept for wire compat).
- `PATCH /sessions/:id {activeMode}` — unchanged; semantics are now "set the
  POSTURE pointer" (the switch_mode REST surface; no shipped UI consumer).
- Session rows: `permissionMode` 3-valued; `activeMode` = the posture
  pointer (kept).
- New migration `0029_unified_modes.sql`: `editor`→`ask`;
  `active_mode IN (plan/review/explore)`→`permission_mode='plan'` (the R75
  read-only guarantee preserved); `active_mode` kept. Idempotent, audited,
  pinned by `tests/migration-0029.test.ts`.
- Enforcement is now solely the operating mode: `PLAN_MODE_TOOLS` grew to 19
  tools (the retired review/explore read-only extras: `git_status`,
  `git_diff`, `git_log`, `analyze_image`, `job_status`); the R75 task-mode
  policy tier, debug command tier, and switch_mode owner-pin are removed.

## ROUND-82 additions (models & providers hardening)

The owner's field-report round 2 (custom models misroute, NVIDIA workflow,
the per-model test button, the model edit dialog). Spec:
`agent-ctx/research/models-providers-fixes.md`.

### The custom-provider routing fix (the headline)

- `POST /sessions/:id/messages` and `POST /sessions/:id/messages/stream`
  accept `providerId` alongside `model` in the body — the per-send override
  is now a provider-scoped pair. `prepareTurn` resolves the EFFECTIVE
  provider from the override (custom gateways, NIM) instead of always the
  agent's provider; the misroute ("custom model id sent verbatim to
  OpenRouter → 'No endpoints found'") is gone. Unknown ids → early
  `400 VALIDATION` (`body.providerId`); absent → the agent's provider
  (pre-R82 behavior). The queued-message carry (`POST /sessions/:id/queue`), the vision
  relay, the context meter (`GET /sessions/:id/context?model=&providerId=`),
  and the debug analyst all key on the same effective pair.
- Orchestrator children: `orchestration.subagentModel` is now the
  provider-scoped ref `{providerId, modelId}` (a legacy plain string reads
  as openrouter-scoped — the honest backfill; corrupt JSON degrades to
  null). `PUT /settings/orchestration` validates the ref (provider must
  exist, modelId non-blank, the configured row must be tool-capable or
  unknown — `supportsTools:false` 400s with the reason). `runChildTurn`/
  `retryChild` provision the child's keyring VIEW from the EFFECTIVE
  provider (the override's, not the parent agent's) — a provider-scoped
  sub-agent ref can now actually serve a child turn.

### The per-model test button

- `POST /models/:id/test` `{slot?}` → `ModelTestResult` (HTTP 200 either
  way — a probe that RAN and got a NO is a successful test call):
  `{ok, latencyMs, providerId, model, checks:{http, auth, modelAccepted,
  nonEmptyContent}, contentPreview? (≤200 chars, scrubbed), usage?
  {inputTokens, outputTokens}, reason? (ok:false only, scrubbed)}`.
  The probe is a REAL minimal completion (max_tokens 16, 30s timeout),
  apiFormat-branched (chat-completions / anthropic-messages / responses),
  key-slot-aware, 409 when no key is held, 404/409 for unknown
  model/provider rows. Secrets are double-scrubbed (exact key + shape
  prefixes via the shared `lib/secret-shapes.ts`).
- `GET /models/configured` → `{models:[ProviderModelConfig]}` — every
  provider's configured rows, ordered provider-then-model (the sub-agent
  picker's "your configured models" feed and the composer picker's
  provider-grouped rows).

### Tri-state capability columns (migration 0030)

- `models.supports_tools / supports_audio / supports_video` are NULLABLE
  tri-states: NULL = unknown (the honest default for NIM/custom rows with
  no catalog source), 0 = explicitly off, 1 = explicitly on. Migration
  `0030_model_capabilities.sql` + a code-side openrouter-scoped backfill
  (never over a user-set value; same-id rows on other providers are never
  touched — a NIM row sharing the model_id string must not inherit
  OpenRouter's metadata).
- `POST /providers/:id/models` + `PATCH /models/:id` accept
  `supportsTools/supportsAudio/supportsVideo: boolean | null` — `null`
  records UNKNOWN (the INSERT path's old two-way ternary folded null→0;
  found by the R82-TESTS mandate and fixed in the close-out), absent
  KEEPS (PATCH) / catalog-prefills-or-unknown (INSERT). Wrong type →
  `400 VALIDATION` with the "a boolean or null (unknown)" contract text.

### The model edit dialog + picker hardening (frontend)

- The Configure-model dialog renders a capabilities card: Reasoning/Vision
  (On/Off toggles, the 0004-era boolean columns) + Tool use / Audio input /
  Video (On/Off/? tri-states — "?" = unknown), each with a
  "consumed by" micro-hint; a Test button runs `POST /models/:id/test`
  in-dialog and shows latency + checks + preview or the honest reason.
- The Add-models picker's Free only ↔ All models toggle is now
  dialog-LOCAL scope: it initializes from the shared persisted pref but
  never writes it, and AUTO-SWITCHES to All when the catalog has zero
  free-classified entries (every NIM catalog — none of the 81 ids end
  ":free" — previously opened on the "No free models match" empty state,
  which read as broken).
- The SubAgentsTab model card renders the running override's provider
  chip (`providerId · modelId`) and a "your configured models" section
  (per-provider rows from `GET /models/configured`, deduped against the
  OpenRouter catalog).

### Custom-provider keys survive restarts (R82-B, the Rust side)

- `keys.rs` notes non-builtin provider ids in
  `~/.acute/custom-providers.txt` at key-save time and re-injects
  `ACUTE_PROVIDER_<ID>` into every sidecar spawn (the note-file pattern
  from the ROUND-61 vision key) — the "409 no API key for provider
  'prv_…'" restart cliff is gone. `cargo check` green.

## R87 additions (2026-09-11) — the UX + capability round

### POST /api/v1/system/reset — the application-wide reset (NEW, `routes/system.ts`)

- Wipes EVERY user table (derived from sqlite_master at reset time — never a
  hand list) with FKs off, re-runs the factory seeds (templates, builtin
  provider rows, builtin skills, the default agent — `reseedFactoryData`,
  the same definition `openDatabase` calls), VACUUMs, aborts every live turn
  first, clears the in-memory keyring, disposes every terminal session, and
  purges the machine files best-effort (`~/.acute` notes + key files +
  external plugins; the dataDir's vapid.json). 200 `{ok, abortedTurns,
  wipedTables, purgedFiles}`. The webview clears its own localStorage +
  query cache and reloads to onboarding; the desktop app's Tauri
  `purge_provider_keys` command runs BEFORE this route (it reads the note
  files the route then deletes).

### POST /api/v1/agent-questions/:id/resolve — the ask_user answer path (NEW, `routes/questions.ts`)

- Body `{answers: string[] (one per question, in order), sources?: ("option"|
  "custom")[]}`. 200 `{ok:true}` settles the pending ask (the tool's promise
  resolves; the `agent-question.resolved` SSE frame collapses the card);
  404 for an unknown/expired id (the card's own timeout is the fallback);
  400 for malformed bodies.

### Model rows carry the R87 input/output capabilities (migration 0032)

- `supports_pdf`, `supports_text_output`, `supports_image_output`,
  `supports_video_output`, `supports_audio_output` (tri-state — same
  contract as the R82 columns) + `size_label` (text, e.g. "70B"). The POST
  `/providers/:id/models` upsert + PATCH `/models/:id` gates accept them
  (boolean sets, null clears, absent keeps); the INSERT default for text
  output is ON. Reasoning + tool use are no longer dialog-configured — the
  app detects them; the PATCH simply omits them (absent = keep stored).

### POST /api/v1/sessions/:id/todo — the owner's manual to-do edit (NEW, `routes/todo.ts`)

- Body `{todos: [{content, status}]}` — the FULL list snapshot (the
  todo_write contract). The route reuses writeTodo's exact validation
  ladder (max 30 items, 200-char content, status normalize) with ONE
  widening: the EMPTY array is accepted (the floating widget's clear —
  the tool keeps its ≥1 rule; the model has no business deleting its
  plan, the owner does). Persists a `todo.update` event with
  `source:"user"` and fans a `todo-updated` frame to any live turn's SSE
  via the turn registry (the R78 user.queued pattern). The agent's NEXT
  turn sees the list in its CURRENT TODO LIST prompt section (R88) with
  the owner-edit emphasis. 200 `{ok, todos}` (normalized); 404 unknown
  session; 409 agent-less; 400 malformed.

### TOOL_NAMES grows to 27 (ask_user, migration 0033)

- The mid-task interactive question tool: batched questions with option
  pills + custom-text answers, a 10-minute timeout, abort-cancellation, and
  `agent-question.requested`/`agent-question.resolved` session events (the
  approvals' fold contract). Plan mode keeps it (pure clarification).

## R89 additions (2026-09-11) — the owner's hands-on verdict round

### GET /api/v1/system/updates — the server-side update check (`routes/system.ts`)

- The check runs in the SIDECAR (the repo is public since R94-B — the
  old anonymous webview fetch died on the private repo's 404; the
  launcher's PAT, when saved, rides the Authorization header as an
  optional rate-limit accelerator, never a gate; sources: the
  `ACUTE_GITHUB_PAT` env var first, then `~/.acute/github.pat`).
  Queries `repos/testplay-byte/ACUTE-CODE/releases/latest` (8s abort
  budget, `X-GitHub-Api-Version: 2022-11-28`). 200 `{current (the
  engine's own package.json version), releasesUrl, ok:true, latest,
  updateAvailable, releaseUrl, body (the release notes, capped at 8,000
  chars + an honest truncation marker), asset}` — or `ok:false` with a
  `reason` (`no-release` — GitHub's 404; `github` — other HTTP status;
  `network`) and an `error` string the About tab renders honestly. The
  version walk is the tuple compare (`0.86.0` vs `0.87.0` →
  per-segment), computed where the check runs.
- **R104: the `asset` is THIS machine's updater asset**
  (`updaterAssetSuffixForPlatform` keys off the sidecar's own
  platform/arch, which ships with the app): the `_x64-setup.exe`
  (`kind: "windows-setup"`) on Windows; the `_aarch64.AppImage`
  (`kind: "linux-appimage"`, the Rust triple's arch name — the R101
  deb=`_arm64`/AppImage=`_aarch64` asymmetry) on linux/arm64; the
  `_amd64.AppImage` on linux/x64; `null` (no `asset` field) on anything
  else. Each asset carries `{url (the API form preferred, the
  browser_download_url fallback), size, digest (GitHub's server-side
  sha256), kind, name (the REAL asset filename)}`.

### POST /api/v1/system/updates/download — the in-app update download (`routes/system.ts`)

- Streams the release's updater asset to a temp file with live byte
  counts, then sha256-verifies it against the release digest. The URL
  must be THIS repo's release asset (the allowlist covers the
  api.github.com asset endpoint, the github.com /releases/download
  permalink, and the objects/release-assets.githubusercontent.com hosts
  — never an open proxy for the PAT). Body `{url, digest?, version?,
  name?}` — R104: `name` is the check's REAL asset filename and the
  staged file keeps it (basename-sanitized: separators stripped, no
  `..`, the extension must be `.exe`/`.AppImage`, else the platform's
  conventional fallback name). Single-flight: one download at a time
  (module state; a second POST while one runs answers 200
  `{ok:true, alreadyRunning:true}`). The plausibility floor is
  extension-aware (R104): 10 MB for a setup.exe, 50 MB for an AppImage.
  200 `{ok:true, status:"downloading"}` — poll the progress route.

### GET /api/v1/system/updates/download/progress — the live download state

- `200 {status: idle|downloading|verifying|ready|error, received,
  total, path (the absolute staged path when ready), version, error}`.
  `ready` is the two-stage hand-shake's STAGED state (R104): the file is
  verified and waits for the owner's explicit install confirmation —
  nothing auto-installs.

### DELETE /api/v1/system/updates/download — the staged walk-back (R104)

- Discards a STAGED download: the verified file is unlinked and the
  single-flight state returns to idle (`200 {ok:true, status:"idle"}`).
- 409 `CONFLICT` while a download is in flight (the live download's
  state is not the caller's to cancel out from under); from idle it is
  the idempotent reset.

### POST /api/v1/providers — the R89 identity rules (BREAKING behavior change)

- The owner's verbatim rule: "the user can add as many providers as needed…
  only the provider name should be different." The NAME is now the
  uniqueness key (409 `field: body.name` — was the id). The wanted id's
  row, when KEYLESS (an invisible seeded built-in), is ADOPTED in place
  (200 `{…record, hasKey:false, adopted:true}` — the request's
  name/baseUrl/apiFormat update the row; this is the fix for the owner's
  "provider NVIDIA already exists" on a fresh reset: `reseedFactoryData`
  re-creates the five keyless built-in rows the R58 list renders as
  absent). A CONFIGURED row at the wanted id (a second same-type provider)
  derives a fresh id from the requested NAME (`prv_<slug>`, walking `-2`
  `-3…` suffixes; 201 as a create). PATCH /providers/:id enforces the same
  name-uniqueness on renames (409 body.name).

## R113 additions (2026-09-20) — the live-sync round (the events fan-out)

**Truth for this section:** `agent-core/src/lib/events-bus.ts` (the frame
contract), `agent-core/src/routes/events.ts` (the SSE route),
`agent-core/src/routes/settings.ts` (the appearance domain),
`agent-core/src/providers/registry.ts` (`toProviderView`). The round's story:
`docs/ui-iterations/round-113.md`.

### GET /api/v1/events/stream — the watcher's single live channel (NEW)

SSE (the hijacked-raw-socket `GET /notifications/stream` pattern verbatim:
CORS rides `writeHead`, the immediate `hello` frame, the R112 10 s `: ping`
comment heartbeat, close-handler teardown of heartbeat + subscription).
Bearer-gated like every route in the scope — the SHELL token (desktop) and
paired DEVICE tokens (phone) both pass; NOT on the device-token blocklist
(the phone's live view of turns the desktop starts); cloud-relay-reachable
(the relay's guest allowlist permits `/health` + `/api/*`). EventSource
cannot set an Authorization header, so clients use the same
fetch + ReadableStream reader the notifications stream already requires.

Frames (the whole wire contract — JSON, one `data:` line each):

| Frame | Semantics |
|---|---|
| `{"type":"hello"}` | once, immediately on open. **"Resync everything"**: a fresh/reconnected watcher refetches its state, then follows frames (whatever landed between the last received frame and the hello is caught by that refetch) |
| `{"type":"session","sessionId","projectId","kind":"event"\|"status"\|"created"\|"meta","seq?","status?"}` | a session-scoped change. `event` = a row appended to the append-only session log (`seq` = the new row's seq — watchers refetch `GET /sessions/:id` and fold from their last seen seq). `status` = a REAL flip (`status` = the NEW value; a no-op write publishes nothing). `created` = a new session exists (POST /sessions AND delegation children — published at the `createSession` storage choke point; `forkSession` announces its own). **`meta` = R114: a session-level PREFERENCE changed** — `permissionMode?`/`activeMode?`/`selectedModel?` ride present-keys-only (see the R114 additions at the end) |
| `{"type":"turn","sessionId","frame"}` | the LIVE turn mirror: `frame` is the EXACT `StreamTurnEvent` the initiating socket receives, published pre-serialization (text-delta, thinking-delta, tool-call/tool-result, meta.*, user.queued, error, done, stopped, debug-*, subagent-status…). Published BEFORE the clientGone check — the mirror survives the initiator's own death mid-turn |
| `{"type":"project","projectId","kind":"created"\|"updated"}` | a project row was created (POST /projects). `updated` is reserved vocabulary — no project-update route exists, and DELETE stays unannounced in v1 |
| `{"type":"settings","domain","value"}` | a settings domain was PUT; `value` is the persisted object as the domain's GET serves it — secrets NEVER ride the frame (cloud-connector broadcasts `hostKeyPresent`, not the key) |

**NO server-side session filtering** — one global channel; every connected
client filters frames by `sessionId` locally (deliberate for a single-owner
sidecar; per-session subscriptions would multiply reconnect complexity for
zero privacy gain).

Publish points (each at its single choke point):
`agent-core/src/storage/sessions.ts` (`appendSessionEvent` — the only runtime
writer into `session_events`, so queue chips and todo/ask flows ride it too;
`setSessionStatus`; `createSession`), `agent-core/src/routes/sse.ts` (`send()`
— the turn mirror), `agent-core/src/routes/projects.ts` (POST),
`agent-core/src/routes/settings.ts` (every domain PUT) + vision
(`agent-core/src/server.ts`). The bus itself is pure in-memory
fire-and-forget: subscriber throws are logged + skipped, so a watcher's dead
socket never propagates into a turn, a route, or a storage helper (the
notification-bus contract, verbatim — the notification bus itself is
COMPLETELY untouched).

### GET/PUT /api/v1/settings/appearance — the theme-sync domain (NEW)

**R114 widened this domain to FIVE fields** (the four chat-density prefs
joined themeId/mode — same partial-PUT + broadcast contract; see the R114
additions at the end for the full shape). The R113 two-field contract:

- `GET` → `{themeId: nova|bento|midnight|sunset|mono|clay|null, mode:
  "system"|"light"|"dark"}` — the stored preference, or the default
  `{themeId: null, mode: "system"}` (null = no server preference — each
  client falls back to its LOCAL default, the honest pre-R113 behavior).
  Fail-open on corrupt reads (the desktop-notifications storage pattern).
- `PUT` takes a partial patch `{themeId?, mode?}` — either field
  independently optional, `null` themeId clears the server preference;
  `400 VALIDATION` names the offending field (`body.themeId` / `body.mode`).
  Persists and BROADCASTS `{"type":"settings","domain":"appearance"}` on the
  events bus, so the change lands live on every other device.
- Device tokens are WELCOME here — the phone changing the desktop's theme is
  a first-class use case (the route is not on the device blocklist; only
  management-surface domains reject device tokens).
- Every OTHER settings-domain PUT broadcasts the same settings-frame shape
  (orchestration / memory / debug / retry / thinking-loop / browser /
  desktop-notifications / device-link / cloud-connector [secret-free] /
  appearance / vision) — the cross-device live-settings backbone. Consumers:
  the desktop maps frames to the exact query keys the settings tabs use
  (live refetch + apply); the phone refetches open settings screens on a
  debounced batch.

### GET /api/v1/providers rows gain `configured` (NEW field, additive)

- Every row now carries `configured: boolean` (a custom row OR `keyCount > 0`)
  beside the pool-aware `hasKey` (`keyCount > 0` — the OLD primary-slot-only
  `hasKey` read `false` for a provider whose keys all sat in pool slots) and
  `keyCount` (R92-D, the deduped pool size). All three derive from ONE
  deduped pool read — they can never disagree.
- ONE view builder (`toProviderView`) now serves GET /providers,
  POST /providers (adopt + create), and PATCH /providers/:id — the same
  truth on every provider view the API emits (the POST/PATCH routes used to
  hand-build their views with the old primary-only `hasKey`).
- Consumers: the desktop's Models & Providers tab and the phone's providers
  screen render configured-first ("Your providers" above the add-a-provider
  catalog tier); the CLI's display-only reads are unchanged (the field is
  additive; nobody breaks).

## R114 additions (2026-09-20) — the sync-foundation round (mode/model live sync + turn.started + the honest model)

**Truth for this section:** `agent-core/src/routes/sessions.ts`
(`readSessionModelPatch` + both PATCH routes),
`agent-core/src/storage/sessions.ts` (the selected-model tier + the
meta-frame choke points),
`agent-core/src/storage/migrations/0041_session_selected_model.sql`,
`agent-core/src/agents/runtime.ts` (`turn.started` + the three-tier
`prepareTurn` ladder), `agent-core/src/routes/sse.ts` (the once-per-POST
gate), `agent-core/src/lib/events-bus.ts` (`publishSessionMetaFrame`),
`agent-core/src/storage/settings.ts` (the appearance five-field domain),
`agent-core/src/storage/vision.ts` +
`agent-core/src/tools/plugins/computer-use.ts` (the vision rework),
`agent-core/src/routes/system.ts` (fs browse). The round's story:
`docs/ui-iterations/round-114.md`.
Pinned by `agent-core/tests/r114-sync-wave.test.ts` (38 tests).

### PATCH /sessions/:id + PATCH /sessions/:id/permissions — the `model` body field (NEW field on both routes)

The session's SERVER-SIDE selected model — the persistent tier between
the per-send override and the agent row (until R114 the desktop's pick
lived only in browser localStorage; the phone rendered "Auto" and the two
devices silently disagreed). Body field `model`, shared by BOTH PATCH
routes (the composer flips mode and model in one breath):

- **absent** → untouched; **`null`** → CLEAR (back to the agent default);
  an object → must be a COMPLETE `{providerId, model}` pair.
- Validation runs BEFORE any write (a bad model never renames the session
  or switches the mode as a side effect): the pair must name a KNOWN +
  CONFIGURED provider (a row WITH a `baseUrl` — the send-time gates then
  police enabled/key honestly, exactly like an agent row referencing
  them) and a model that matches a models row for that provider OR a
  catalog entry (the same surface the pickers list — never a string a
  picker could not have produced).
- 400 shapes (all `VALIDATION`, field named in `details`):
  not-an-object/partial-pair → `body.model` ("model must be
  { providerId, model } or null…" / "…must carry BOTH providerId and
  model"); unknown-or-baseUrl-less provider → `body.model.providerId`;
  unknown model → `body.model.model`.
- Persistence: migration `0041_session_selected_model.sql`
  (`sessions.model_provider` + `model_id`; BOTH NULL = follow the agent
  default — every pre-R114 row composes byte-identically; NULLs are
  written only as a pair; a half-written/corrupt row fails open to null
  at read). Writes flow through `setSessionSelectedModel` — the storage
  choke point that publishes the meta frame. Forks deliberately start
  modelless.
- **The meta-frame publication**: every setter
  (`updateSessionPermissionMode` / `updateSessionActiveMode` /
  `setSessionSelectedModel`) publishes
  `{type:"session", kind:"meta", …}` on the events bus at the choke point
  — so BOTH PATCH routes AND the agent's `switch_mode` tool ride ONE
  hook, and the other device's composer follows the flip live (never on
  the next unrelated refetch).
- **`prepareTurn`'s three-tier ladder**: per-send override →
  `session.selectedModel` → agent row, each SIDE falling through
  independently (a half override contributes its side and falls through —
  the pre-R114 chain semantics the orchestrator's `subagentModel` arm
  relies on; a complete override still wins outright).
  `GET /sessions/:id/context`'s effective-model line mirrors the same
  ladder (query pair → session tier → agent).

### GET /sessions + GET /sessions/:id — the `selectedModel` row field (NEW field, additive)

Every session row (list + detail + fork responses) now carries
`selectedModel: {providerId, model} | null` (null = follow the agent
default). Consumers: the phone's composer pill (local override →
`detail.selectedModel` → the context report → "Auto") and the desktop's
display seed (`loadModelOverride(sessionId) ?? session.selectedModel ??
loadLastUsedModel()`, re-seeded on the session's `selectedModel` string
key so a phone-side pick lands through the meta frame's invalidation).

### The `turn.started` StreamTurnEvent (NEW SSE frame — the turn's FIRST frame)

`{type:"turn.started", text, model, providerId}` — emitted the instant
`prepareTurn` succeeds, BEFORE `setSessionStatus`/`appendSessionEvent`
and before any loop-top queue delivery:

- **First-frame guarantee**: nothing precedes it on the turn's stream
  except the route's leading `: ping` comment — the OTHER device flips
  into processing state and renders the user bubble BEFORE the persisted
  fold refetch (pre-R114, nothing reached a watcher until the first
  text/tool delta: the desktop's send button never flipped when the phone
  sent).
- **Once per POST/stream**: the sse route passes `emitTurnStarted: true`
  for the POST's own first turn ONLY — queue continuations and the
  orchestrator's streamed children stay quiet (they already have live
  context via `user.queued` / `subagent-status` frames; a re-announcement
  would be noise, and a child's frame would nest oddly inside the
  subagent-event envelope). Default OFF on direct
  `runStreamedAgentTurn` calls.
- Payload: the USER text (`text` — a remote client renders the user
  bubble immediately) + the RESOLVED effective `model` + `providerId`
  (the three-tier ladder's verdict — a remote UI labels the live turn
  honestly instead of "Auto"). NOT persisted (the `message.user` append
  is the durable record). Rides the initiator's own stream (benign — its
  reducer treats it as the opening frame) AND the events-bus mirror
  `{type:"turn", sessionId, frame}` verbatim.

### GET/PUT /api/v1/settings/appearance — the FIVE-field domain (R113's two fields + four)

`{themeId: nova|bento|midnight|sunset|mono|clay|null, mode:
"system"|"light"|"dark", chatDensity: "comfortable"|"compact",
chatTextSize: "small"|"medium"|"large", timestampsMode:
"hidden"|"hover", toolActivity: "detailed"|"compact"|"hidden"}`.

- Defaults: `null / system / comfortable / medium / hover / detailed`.
  Missing rows read as defaults — a pre-R114 database GETs the full
  five-field shape with the new fields at their defaults (**no migration
  needed**: the settings key-value table absorbs them, one row per
  field, `appearance.<camelCase>`).
- `PUT` takes a PARTIAL patch (any subset; an absent field never touches
  its row — the R113 two-field semantics, extended); each enum validated
  only when present; `400 VALIDATION` names `body.<field>`. All four new
  fields are cosmetic-only render prefs — no turn machinery reads them.
- Every PUT BROADCASTS the full five-field shape
  (`{"type":"settings","domain":"appearance",value}` — value = the
  persisted object as GET serves it). Consumers: the phone's Chat
  section (four segmented rows, one-field partial PUTs) + the transcript
  mappings; the desktop's write-through setters + echo-guarded live
  apply (a present-but-INVALID value rejects the whole frame on both
  clients — malformed is malformed).

### Vision — the mode narrowing + the always-on ladder (BREAKING-ish: "off" retired)

The owner directive: **a model marked `supportsVision` must ALWAYS be
able to see, regardless of any other setting.**

- `VisionMode = "main" | "separate"` (was `"off" | "separate" |
  "main"`). READ COERCION: a stored `"off"` (the pre-R114 default, still
  sitting in real databases) or any unknown value reads as `"main"`
  (readEnum's fail-open fallback — stable + idempotent forever; no row
  rewrites). WRITE COERCION: `PUT /vision/settings` ACCEPTS a legacy
  `"off"` and coerces it to `"main"` (wire compat — an old client PUTting
  its stored value gets the new semantics, never a 400); anything else
  outside `main|separate` 400s. `POST /vision/test`'s dead off-branch is
  deleted.
- **`relayVision`'s ladder** (computer-use + browser screenshots +
  `analyze_image` all relay through it): (1) `"separate"` FULLY
  CONFIGURED (provider + modelId) → `describeRaster` on the dedicated
  pair with the `<providerId>-vision` keyring slot; (2) else the MAIN
  MODEL MARKED `supportsVision` → the turn's own model (mode `"main"` OR
  the fallback from a chosen-but-incomplete separate pick — a half-built
  separate picker must not blind a vision-capable session); (3) else the
  honest refusal naming BOTH fixes (mark the model in Models &
  Providers / pick the separate model in Settings → Image Analysis; the
  separate-unconfigured variant adds why no fallback existed).
- **`sessionHasVisionPath`** mirrors the ladder tier-for-tier (the flat
  OR would let leftover separate rows un-blind a session whose relay
  actually refuses — one vision configuration, one failure story).
  Screenshot tools refuse only when NEITHER path works; any
  settings-read failure → false (fail-closed).

### GET /api/v1/system/fs/browse — the phone's New Project folder picker (NEW)

`?path=<abs>&hidden=<0|1>` → `200 {path, parent: string|null,
entries: [{name, path, dir}], truncated}` — names/types/paths ONLY,
never file contents:

- `path` omitted/blank → the user's HOME (`os.homedir()`); `hidden=1`
  (or `"true"`) includes dotfiles, the default skips them.
- Entries: DIRECTORIES first, then files, each alphabetical (the plain
  string comparison — deterministic across machines); hard cap **400**
  entries per response with `truncated: true` (a directory with thousands
  of files answers fast; the picker paginates by descending into
  subdirectories).
- `parent` = the browsed directory's parent, `null` at a filesystem root
  (`dirname("/") === "/"` — the picker hides Up).
- `404 NOT_FOUND` on ENOENT (the OS's message rides along);
  `400 VALIDATION` on not-a-directory/unreadable (the OS's message —
  never a 500).
- **Device-token reachable** (deliberately NOT on the device blocklist —
  a paired phone is a view+input medium with config rights per the R109
  ruling; only `/api/v1/system/reset` is blocked under `/system/*`).
  Pinned by a real pair→claim→TLS-device-token test with the
  `/computer-use/config` 403 contrast leg.

### The events-bus session frame extension (kind "meta")

The R113 session frame's `kind` vocabulary gains `"meta"`:

`{"type":"session","sessionId","projectId","kind":"meta",
"permissionMode"?, "activeMode"?, "selectedModel"?}` — a session-level
PREFERENCE changed. Only the field(s) this change touched ride the frame
(absent keys stay ABSENT on the JSON wire — never `undefined`);
`activeMode`/`selectedModel` carry `null` for a clear. One frame per
change, written at the storage choke point the durable row lands
through, so the phone + desktop never silently disagree; a watcher
applies the carried value directly (it IS the new truth) or refetches
the session row. Consumers: the phone's `applySessionMetaPatch`
(in-place detail flips; the frame moves NO list epochs — nothing in the
lists reads mode/model) and the desktop's immediate
`["session"]+["sessions"]` invalidation (no debounce — a preference
patch is one tiny row write).

## ROUND-117 additions (the memory round — R117-b)

### The memory scopes (migration 0042)

The `memory` table is rebuilt with a `scope` column
(`CHECK (scope IN ('project','workspace'))`, default `'project'` — every
legacy row carries over as project memory) and a nullable `project_id`
(workspace rows carry `NULL`). Indexes: the legacy
`(project_id, updated_at DESC)` plus a partial workspace
`(updated_at DESC) WHERE scope='workspace'`. Template/default agent
allowlists that already carried `memory_recall` gain `session_recall`
(curation-respecting — user agents are never widened).

### The workspace memory REST family

`GET /memory/workspace` (cap 100, newest-first) · `POST /memory/workspace`
(`{content, kind?}`, dedup-aware — mirrors the project POST) ·
`PUT /memory/workspace/:memoryId` · `DELETE /memory/workspace/:memoryId`.
Bearer-wall + validation envelope identical to the project family. The
Memory panel renders both tiers behind a segmented switch.

### The composed digest + the policy

Main-session turns now compose **two labeled sections** when both scopes
have rows: `## Workspace memory` (cross-project truths) above
`## Project memory`. `agents.memory_policy` is LIVE: `none` → no digest
AND the memory tool family is dropped for that agent's sessions;
`on-start` → the digest rides the session's FIRST turn only;
`every-turn` (default) → every turn. The master `memory.enabled` switch
still governs absolutely (policy can only narrow ON). The digest budget
steps with content richness (1,500 chars; 3,000 when >30 rows) and a
zero-memory project renders the honest "No memories saved yet" line.

### session_recall (the episodic tool)

`session_recall {query, limit?}` — model-facing search over PAST
sessions of the session's project (`searchSessions` LIKE over titles +
event payloads), returning id + title + last-activity + a 200-char
snippet. Projectless sessions get the honest no-project refusal.
Registered in the memory family; rides the same allowlist curation.

### Automatic formation

Compaction runs persist their summary into project memory (`kind=note`,
`source=system`, deduped — the episodic bridge: future sessions start
knowing what past sessions did). A turn-end `memory.saved` event counts
new memories of either source. The Prompts-tab preview now passes a
real digest (no more "absent" for memory-rich projects) and warns when
a `project-memory` section override is active (an override replaces the
live injection).

### CLI project binding

CLI session creation resolves the project: `--project <path>` (exact
root match; a miss stays projectless with an honest stderr note) or the
cwd match against registered roots (exactly ONE match binds; zero or
many stay projectless). The projects list is advisory — any fetch
failure degrades to projectless. Memory + session_recall work on the
CLI surface from R117-b.

## ROUND-120 additions (R120-U, 2026-09-23) — the updater's PAT-rotation resilience

The owner's v0.113.0 report: "Check for updates" answered **HTTP 401**.
He had rotated his GitHub PAT; the sidecar's `readLauncherGithubPat()`
kept serving the dead token; and GitHub rejects bad credentials EVEN ON
PUBLIC REPOS — so the check died while the code, having attached the
`Authorization` header, never once tried without it.

### GET /api/v1/system/updates — the dead-PAT anonymous fallback (behavior change)

When the PAT-bearing fetch answers **401 or 403**, the route retries
ONCE ANONYMOUSLY (the `Authorization` header dropped; both legs share
the one 8 s abort budget). The answer matrix:

- anonymous retry 200 → the normal `ok:true` answer **plus
  `tokenWarning`** ("the saved GitHub token was rejected — a new token is
  needed for private/rate-limited access") — the About tab renders the
  amber hint line and auto-opens the re-pairing row, but the check
  itself SUCCEEDED;
- anonymous retry 404 → `ok:false`, reason `no-release` with the
  rejected-token copy + `tokenWarning`;
- anonymous retry non-ok → `ok:false`, reason **`token-rejected`** (the
  new, distinguished reason the About tab's re-pairing row keys on) with
  the both-legs copy ("GitHub rejected the saved token (HTTP 401) and
  the anonymous check also failed (HTTP 403) — save a new GitHub token
  …") + `tokenWarning`;
- no token attached at all + non-ok → `ok:false`, reason `github` with
  the honest anonymous copy ("GitHub answered HTTP 403 anonymously (no
  GitHub token is saved on this machine — a token raises the anonymous
  rate limit)") — the anonymous-failure distinction, no retry (nothing
  to drop);
- fetch throw → `ok:false`, reason `network`, the message
  **secret-shape scrubbed** (`scrubSecretShapes`).

### POST /api/v1/system/updates/download — the same one-leg fallback

The download leg attaches the PAT identically, so it inherits the same
dead-PAT wall: a 401/403 on the PAT-bearing asset fetch re-fetches ONCE
with the header dropped (the 401 response's body is never consumed, so
the retry is clean). A retry that also fails lands the honest
both-legs message in the single-flight `error` state ("GitHub rejected
the saved token (HTTP 401) and the anonymous download also failed (HTTP
403) — save a new GitHub token (Settings → About) or download from the
Releases page"); the single-flight error message is secret-shape
scrubbed.

### PUT /api/v1/system/updates/token — the re-pairing write (NEW)

Body `{pat: string}`. Validates the token LIVE before persisting, then
writes it to `~/.acute/github.pat` (the R90-B1 home location the
launcher reads and migrates — never the env var):

- 400 `VALIDATION` (field `body.pat`) — the shape gate: the token must
  start with `github_pat_` or `ghp_` (both real GitHub PAT spellings);
  empty/whitespace/non-string refuse the same way;
- 401 `UNAUTHORIZED` — GitHub answered 401/403 to the token-bearing
  `GET /repos/testplay-byte/ACUTE-CODE` (the rotated/dead case the route
  exists for);
- 503 `UNAVAILABLE` — GitHub unreachable (the network/abort message
  rides along, secret-shape scrubbed), answered non-200 otherwise, or
  answered 200 for the WRONG repository (`full_name` mismatch — the
  token must see THIS repo, not just any 200);
- 500 `INTERNAL` — the persist itself failed (the OS message, scrubbed);
- 200 `{ok:true, valid:true}` — validated AND persisted: trimmed,
  newline-terminated (the launcher's own file grammar), best-effort
  owner-only perms (0600; near-no-op on Windows).

Side effect on success: `ACUTE_GITHUB_PAT` is cleared in the sidecar's
environment. The R90-B1 "env wins" invariant holds only while the env
var mirrors the file; a re-pair through this route proves the
spawn-time snapshot stale, so the running sidecar drops the dead export
and the very next `/system/updates` call rides the fresh token (the
next launcher start re-exports from the file, restoring the invariant).
The file-layer shape gate in `readLauncherGithubPat()` accepts `ghp_`
alongside `github_pat_` (before this a re-paired classic token sat in
the file but never rode the header). **The PAT's value is never
logged, never returned** — every message this route can emit runs
through `scrubSecretShapes` as the belt.

TRUST MODEL: a paired phone is a view+input medium with config rights
(the R109 ruling — the same standing that lets a phone set provider
keys); the route is deliberately NOT on the device-token blocklist
(only `/api/v1/system/reset` is blocked under `/system/*`).

### GET /api/v1/system/updates/token — the health probe (NEW)

`200 {present: boolean, valid: boolean|null}` — never the value:

- `present` is SHAPE-FREE ("something non-blank is saved", env-or-file —
  a garbage-shaped file answers `present:true, valid:false`, never a
  masquerading "no token");
- `valid` is the same live repo validation the PUT runs: `true` (200 +
  `full_name` match), `false` (GitHub rejected it), `null` when nothing
  is saved to validate OR the wire to GitHub never answered (present but
  unverifiable is honest, not "invalid").

### Secret-shapes: the classic `ghp_…` spelling joins the scrubber

`agent-core/src/lib/secret-shapes.ts` (`scrubSecretShapes`) gained
`ghp_[A-Za-z0-9]{20,}` → `ghp_***` beside the existing `github_pat_…`
rule — the updater now accepts (and persists) classic tokens, so its
error lines must scrub both spellings (the R80 one-place lesson).

## ROUND-120 additions, part 2 (R120-C-PC, 2026-09-23) — the live-turn truth surface

The owner's items 37+38 (round-120 §1 I): "the frontend claims completion
while the backend still works; the stop button disappears mid-processing; a
refresh makes everything look finished until the next agent frame arrives."
The working/stop state now derives from the BACKEND's shared turn registry,
not from SSE frame arrival.

### GET /api/v1/sessions/:id/live (NEW)

A read-only view of the registry — the SAME map
`registerTurn`/`unregisterTurn`/`abortTurn` maintain for the stop route and
the queue route's `notifyTurn` — answering, for any session, whether a turn
is registered RIGHT NOW:

- `404 NOT_FOUND` — unknown session id;
- `200 {live: boolean}` — `true` when `getTurnController(id)` resolves
  (a live parent turn OR a registered sub-agent child; both stop routes and
  the queue route share the registry).

One boolean, no session mutation, no event writes — additive to the route
set. The PC panel polls it on mount + every 5 s
(`SESSION_LIVE_POLL_MS`), skipping the poll while its own SSE reader holds
the session (the reader is the freshest truth), and feeds the store's
`rehydrateLiveTurn` reconciler — live:true with no local liveTurn
REHYDRATES the remote mirror (a refresh mid-turn reopens the working state
+ the stop button); a non-deliberate own-stream death with the turn alive
DETACHES the frozen failure onto the mirror path; live:false with an open
mirror and no pending retire RETIRES it (the missed terminal frame). The
agent-core pin: `tests/r120-live-turn.test.ts` (6); the store pin:
`src/lib/stream-rehydrate.test.ts` (7).

## ROUND-122 additions (2026-09-23) — the self-feedback ledger

The owner's directive: after each completed session turn (while the setting
is ON), a separate context-free agent with the WHOLE main-conversation
context appends one structured entry to the ONE shared ledger file; the
feedback NEVER touches any conversation (the owner's explicit contract —
"it will just stop, and then if I chat, then the normal conversation will
go and the feedback info will not be included anywhere"). MAIN sessions
live queued⇄running across turns, so the turn's TERMINAL frame is the app's
"session completed" moment — the reporter hooks the stream route's `finally`
block, DETACHED (never awaited, zero SSE frames, zero session events; the
FILE is the only persistence). Deliberate stops (ABORTED) and validation
conflicts (404/409) never report; ok turns, real failures (≥500 — the
transcript carries the persisted ERROR line), and route crashes do (the
debug analyst's exact gate). The reporter's spend is metered with usage
origin `"feedback"` (the R83 discipline).

### `GET/PUT /settings/feedback` → `{enabled: boolean}`

The DebugSettings pattern verbatim (default OFF — one extra model call per
completed turn while ON). PUT broadcasts `{type:"settings",
domain:"feedback"}` on the events bus (the R113 fan-out) — the desktop's
`SETTINGS_DOMAIN_QUERY_KEYS` invalidates `["feedback-settings"]` AND
`["feedback-file"]` (the ledger card live-refreshes on every append/clear,
which publishes the same domain with the file's meta as the value).

### `GET /api/v1/feedback/file` → `{exists, content, bytes, updatedAt, entries}`

The raw ledger (`<dataDir>/feedback.md` — the machine-scoped directory
beside vapid.json) plus honest meta; never a 404 (`exists:false` is the
never-written state, the mobile-link off-state pattern). Device tokens
REACH this route (the R109 view trust — a paired phone may view the
ledger). `503 SERVICE_UNAVAILABLE` when the server has no dataDir (the R42
hermetic contract).

### `DELETE /api/v1/feedback/file` → `{cleared: boolean, entries: number}`

The settings viewer's Clear action — SHELL-ONLY: the route-local
`rejectDeviceTokens` guard (the settings.ts cloud-connector pattern), 403
for a paired device (the PATH blocklist cannot split GET from DELETE on
one path, so the method split is enforced where the route lives). The
wiped entry count rides the reply — the confirmation line is honest, never
assumed. Serialized on the ledger's write chain (a concurrent append lands
AFTER the wipe).

**The entry format** (the cold-read contract — the file's header explains
itself before the first entry): a machine-written metadata block (`## Entry
— <ISO>` + Session / Project / Agent · provider/model / Turn outcome /
Transcript size) followed by the model's six sections (What I was trying
to do · What actually happened · Issues & problems encountered · Glitches
& anomalies noticed · Expectations vs reality · Suggested improvements).
Appends are whole-entry and SERIALIZED (a module-level promise chain in
`storage/feedback-ledger.ts` — concurrent turns can never interleave). The
app-wide reset purges the file beside vapid.json.

Pinned by `agent-core/tests/r122-feedback-writer.test.ts` (13),
`r122-feedback-routes.test.ts` (9 — including the REAL-TLS device-token
auth split), and `r122-feedback-phase.test.ts` (4 — the route-level
separation contract: zero feedback frames, zero feedback events).
