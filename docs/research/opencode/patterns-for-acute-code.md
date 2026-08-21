# OpenCode — Patterns for ACUTE-CODE

Patterns worth adopting, each with WHAT (in OpenCode, verified), WHY it fits ACUTE-CODE, and HOW it maps onto our stack (Tauri 2 shell + React 18/TS UI + Node/TS sidecar owning SQLite via localhost REST+WS + cloud LLM APIs + human-approval safety layer, max 5 concurrent agents). Study only — never copy code. OpenCode is MIT (verified), so even dependency-level reuse would be license-safe; our constraint remains patterns-first.

---

## Pattern 1 — One stateful server, thin interchangeable clients

**WHAT.** All state and logic (sessions, agents, tools, permissions, providers, storage) lives in the TypeScript server; TUI, desktop, IDE, and web frontends are pure API consumers over `http://127.0.0.1:4096` + event stream. `opencode` = server+TUI in one process; `opencode serve` = headless.

**WHY.** ACUTE-CODE has the identical topology (sidecar owns SQLite; React-in-Tauri is a client). OpenCode proves the split stays clean at scale (32 packages, 4 client types) and that a CLI/desktop/IDE can share one API without server special-casing per client.

**HOW.** Keep the Tauri main process and React UI strictly API consumers of the sidecar; never let the UI touch SQLite or the filesystem directly. Define the sidecar as the *only* process that opens the SQLite file, executes tools, or holds LLM credentials. If we later add a CLI or IDE extension, they attach to the same localhost endpoint with zero server changes.

## Pattern 2 — Protocol package as single source of truth, codegen client

**WHAT.** A dedicated `@opencode-ai/protocol`/`schema` package defines the API; the server mounts routes generated/validated from it (`httpapi-codegen`), `GET /doc` serves OpenAPI 3.1, and `@opencode-ai/client` (used by TUI/SDK) is code-generated from the same spec — CI asserts generated code is up to date (`check:generated` with `git diff --exit-code`).

**WHY.** Our React UI ↔ sidecar contract is the most drift-prone seam in ACUTE-CODE. A protocol-first workflow makes drift impossible and gives us types on both ends for free.

**HOW.** Create a workspace package `@acute/protocol` holding Zod schemas + route/event definitions shared by sidecar and UI. Run the sidecar on Fastify with `fastify-type-provider-zod` (or ts-rest) and emit OpenAPI from it; generate the frontend client with `openapi-typescript` + `openapi-fetch`, checked in CI via a "regenerate then `git diff --exit-code`" step, exactly like OpenCode's `check:generated`. Our WS event payloads should be Zod schemas in the same package.

## Pattern 3 — Global event stream with a handshake event + resource-oriented REST

**WHAT.** `GET /event` streams every bus event (SSE; first event `server.connected` carries server identity); state changes are resources over REST (`/session/:id/message/...`), and one endpoint handles approval replies: `POST /session/:id/permissions/:permissionID`. Note: docs document SSE while `dev` adds a `WebSocketTracker` — they are moving SSE→WS, which validates our WS choice.

**WHY.** Multi-agent UIs need push updates for agent progress, tool runs, and approval prompts; a `server.connected`-style handshake lets clients detect restarts and re-sync; a single well-shaped approval endpoint is the cleanest human-in-the-loop mechanism we've seen.

**HOW.** Sidecar exposes WS `/ws` that emits `server.hello {serverId, pid, schemaVersion}` first, then bus events (`session.updated`, `message.part.updated`, `agent.started/finished`, `permission.requested`, `permission.resolved`). Add `POST /sessions/:id/approvals/:approvalId` accepting `{decision: approve|deny|modify, edits?}`. Version every event payload (`v` field) from day one so UI and sidecar can upgrade independently.

## Pattern 4 — Ask/allow/deny permission config with filters, deny-overrides, and tool-call interception

**WHAT.** Since v1.1.1 a top-level `permission` config: `edit: ask|allow|deny` (string | string[] | regex), `bash: { ask|allow|deny, command: string[] | regex }`, `webfetch: ask|allow|deny`. Bash command filters run before permission checks; explicit `deny` always wins; per-agent defaults differ (`build` = full access, `plan` = read-only, asks before bash). Approvals resolve over the API (Pattern 3); legacy releases used per-agent `permission` blocks (`bash.bypass`, `edit.create/edit.write`) — the consolidation into one top-level block is deliberate simplification. Preceding this, plugins can intercept: `tool.execute.before` mutates args or throws to block.

**WHY.** This is ACUTE-CODE's safety layer almost verbatim: default-deny-ish editing, `ask` for bash, regex command filters (e.g. allow `git status`, deny `rm -rf`), and deny-overrides as the invariant. OpenCode's own migration from agent-scoped to global permission config is a lesson: keep one canonical permission block.

**HOW.** Sidecar evaluates permissions *centrally* before any tool executes (never in the UI): SQLite-backed rules `{tool: 'bash'|'edit'|'webfetch', effect: allow|ask|deny, pattern?: regex}` with evaluation order deny → allow → ask → default-ask. Every `ask` blocks the agent, persists an approval request, and emits `permission.requested` to the UI; the human answers via the approvals endpoint; decisions can be saved as rules ("always allow commands matching X in this project"). Ship default agent profiles mirroring build/plan: a full-access agent (still `ask` for destructive ops) and a read-only planner.

## Pattern 5 — Catalog-driven multi-provider routing with composite model IDs

**WHAT.** Vercel AI SDK + Models.dev metadata for 75+ providers; models referenced as `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5`); config shape: `provider.<id> = { npm?, name?, options: { baseURL?, apiKey?, headers? }, models: { "<id>": { name?, limit: {context, output}?, options? } }, whitelist?, blacklist? }`; separate `model` and `small_model`; secrets via `{env:VAR}` / `{file:path}`; custom local providers by pointing `npm: @ai-sdk/openai-compatible` at a `baseURL`.

**WHY.** ACUTE-CODE needs multi-provider cloud routing without hand-maintaining vendor metadata; composite IDs give an unambiguous routing key everywhere (config, UI model picker, session records); `small_model` separation (cheap model for titles/summaries) cuts cost.

**HOW.** Sidecar uses the Vercel AI SDK (`ai` + per-provider packages, all Apache-2.0/MIT) and reads model metadata from the Models.dev catalog (MIT-licensed data) with a bundled snapshot + refresh. Store `provider/model-id` strings in SQLite session rows and config; keep a `small_model` for background tasks. Adopt `{env:}`/`{file:}` indirection for API keys so secrets never sit in our config file; keys live in the sidecar's own credential store, never in Tauri/webview storage.

## Pattern 6 — Session → message → part event-sourced data model + compaction

**WHAT.** Sessions contain messages; messages contain typed **parts** (text, tool calls, reasoning, diffs); everything persisted as an append-mostly stream (legacy JSON files keyed `session/<projectID>/<sessionID>.json` → `message/...` → `part/...`; now migrating to Drizzle SQLite tables `Session/Message/Part/Todo`). Long sessions compact via a dedicated compactor with hook-injectable context; `revert`/`unrevert` snapshot and restore conversation-plus-worktree state; diffs (`session_diff`) tracked additively.

**WHY.** Parts-as-rows gives ACUTE-CODE replayable, inspectable agent transcripts (essential for our approval audit trail) and cheap incremental UI updates (`message.part.updated` events map to React list diffs). Compaction bounds token spend on long multi-agent runs; revert gives users trust.

**HOW.** SQLite tables `sessions(id, project_id, agent, model, title, status, created_at)`, `messages(id, session_id, role, created_at)`, `message_parts(id, message_id, type, payload_json, seq, created_at)` with an index on `(message_id, seq)`; append-only inserts, edits only for streaming text parts. UI renders straight from parts. Add `context_windows`/compaction as a sidecar job that summarizes into a synthetic system part when tokens exceed a threshold.

## Pattern 7 — Merge-not-replace layered config

**WHAT.** `opencode.json` at global, project, and env-var layers, deep-merged with a documented precedence ladder (remote < global < custom < project < `.opencode` dir < inline < managed/MDM); JSON schema published at a URL; `{env:}`/`{file:}` substitution; config itself patchable over the API (`PATCH /config`).

**WHY.** ACUTE-CODE will need app-level defaults, user prefs, and per-project overrides; users will ask for "stricter permissions for this repo." Deep-merge with explicit precedence prevents the classic "project file nukes user settings" bug.

**HOW.** Sidecar loads `defaults.json` (app) < `%APPDATA%/acute/config.json` (user) < `<project>/.acute/config.json` (project), deep-merged; expose `GET/PATCH /config`; publish a JSON schema URL and reference it via `$schema` in generated files for editor autocomplete. Same `{env:}`/`{file:}` indirection as Pattern 5.

## Pattern 8 — Built-in dual agents (plan vs build) + named subagents

**WHAT.** Two shipped agents: `build` (default, full tool access) and `plan` (read-only — denies edits, asks before bash), switched with Tab; a `general` subagent for delegated search/research; `subagent_depth` config caps recursion.

**WHY.** Matches ACUTE-CODE's orchestrator/subagent model and its human-approval posture: planning is safe-by-default; a depth cap prevents runaway delegation. Shipping both as *config + permission profiles*, not code forks, keeps agent definitions data.

**HOW.** Store agents as rows/config (`name, model, tools[], permissionProfileId, systemPrompt`); hard cap concurrent running agents at 5 (our product constraint — OpenCode has no such cap, this is our addition); subagent spawning goes through the same permission gate as any tool call.

---

# What to avoid (with reasons)

- **Effect v4-beta `unstable` HTTP stack** — the whole server is built on pre-release Effect APIs (`effect/unstable/http`, beta peer deps). Powerful but a moving target with a steep FP learning curve; for a closed-source team, Fastify + Zod gives 90% of the guarantees at a fraction of the onboarding cost. (Also explains why their HTTP layer churns: SSE docs vs WS source today.)
- **Bun as runtime/package manager** — lock-in to Bun-specific behavior (auto-installing plugin deps, `bunfig`, shell `$` API). Our sidecar should stay plain Node + npm/pnpm for Windows service integration and ecosystem compatibility.
- **One-JSON-file-per-entity storage with per-file locks** — they wrote their own locking (`RcMap` + reentrant locks) and are now migrating to Drizzle/SQLite; skip the detour, start with SQLite (we do).
- **Plugins that auto-install npm packages at startup and can override built-in tools by name** — supply-chain exposure (any npm plugin executes with full user privileges at startup) and a safety hole (a plugin silently replacing `bash` defeats the permission system). ACUTE-CODE's extension points, if any, must be a vetted, typed hook API running in-process with no dynamic npm installs.
- **Basic-auth with a shared static password on localhost** — fine for a dev tool, weak for us: any local process that learns the password fully controls agents. Use a per-launch random token passed out-of-band (Tauri spawns sidecar with a `--token` arg on `127.0.0.1` only).
- **mDNS network discovery** — OpenCode publishes the server on the LAN when enabled; ACUTE-CODE is local-first and single-user; binding loopback with no discovery removes a whole attack-surface class.
- **`/tui/*` remote-control endpoints in the server API** — client-specific UI control (append-prompt, show-toast, open-themes) leaked into the generic server API; it couples the API to one client's internals. Keep our server API client-agnostic; any UI affordances belong in the UI layer.
- **Headless `serve` spawning a *second* independent server instance** — surprising instance semantics (two servers = two session stores for the same project). ACUTE-CODE should enforce single-sidecar-per-project (lock file / named pipe) so the React UI, CLI, and future clients always share one state.

# Sources

- https://github.com/anomalyco/opencode (canonical; formerly sst/opencode)
- https://github.com/opencode-ai/opencode (name-collision check — archived Go project, not OpenCode)
- https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE
- https://opencode.ai/docs/ , /docs/server/ , /docs/sdk/ , /docs/config/ , /docs/providers/ , /docs/permissions/ , /docs/plugins/
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/server.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/storage.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/schema.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/client/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/package.json
- https://api.github.com/repos/anomalyco/opencode/contents/packages?ref=dev (and .../src, .../src/storage, .../src/session, .../src/server)
- https://news.ycombinator.com/item?id=44482504
