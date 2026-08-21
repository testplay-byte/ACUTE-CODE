# OpenCode — Patterns for ACUTE-CODE

Each pattern: WHAT (verified in OpenCode), WHY it fits ACUTE-CODE, HOW it maps onto our stack (Tauri 2 shell + React 18/TS UI + Node/TS sidecar owning SQLite via localhost REST+WS + cloud LLM APIs + human-approval safety layer, max 5 concurrent agents). Study only — never copy code. OpenCode is MIT (verified from its LICENSE file), so even dependency-level reuse would be license-safe; our constraint stays patterns-first.

---

## Pattern 1 — One stateful server, many thin clients

**WHAT.** All state and logic (sessions, tools, permissions, providers, storage) lives in the TypeScript server; TUI, web, Electron desktop, IDE plugins, and SDK programs are pure consumers of `http://127.0.0.1:4096` + the event stream. `opencode` = server + TUI in one process; `opencode serve` = headless; `--cors` admits browser clients; optional Basic auth via `OPENCODE_SERVER_PASSWORD`.

**WHY.** ACUTE-CODE has the identical topology (sidecar owns SQLite; React-in-Tauri is a client). OpenCode proves the split stays clean with 32 packages and 5+ client types, and that a TUI can be remotely driven (`/tui/*` endpoints) without server special-casing.

**HOW.** Make the Tauri main process and React UI strictly API clients of the sidecar: never open SQLite, run tools, or hold LLM API keys in the shell/UI. Bind the sidecar to `127.0.0.1` with a random fixed port, token-auth every request (we can improve on their opt-in Basic auth by making auth mandatory), and allow CORS only for the Tauri origin. If we ever add a CLI, it attaches to the same endpoint with zero server changes.

## Pattern 2 — OpenAPI-contract-first server with generated clients

**WHAT.** The API is declared once (Effect HttpApi + `packages/protocol`), the OpenAPI 3.1 spec is served live at `GET /doc`, and the published SDK (`packages/sdk`) plus the TUI's client are generated from that spec — the docs explicitly say the spec "generates the SDK". A `httpapi-codegen` package keeps this pipeline in-repo.

**WHY.** Our React UI ↔ sidecar contract is the most drift-prone seam in ACUTE-CODE. A spec-first workflow makes drift structurally impossible and hands us end-to-end types plus a free playground for debugging (`/doc`).

**HOW.** Define routes + Zod schemas in a shared `@acute/protocol` package; serve the sidecar with Fastify (or ts-rest) emitting OpenAPI 3.1 at `/doc`; generate the UI client with `openapi-typescript` + `openapi-fetch`; add a CI step that regenerates and fails on `git diff --exit-code`. Do the same for WS event payloads: one Zod schema per event, shared by both ends.

## Pattern 3 — Event bus with a handshake event; state via REST, updates via stream

**WHAT.** `GET /event` (SSE) streams every bus event; the **first event is `server.connected`**, then domain events (`session.updated`, `message.part.updated`, `permission.asked`, `file.edited`, `todo.updated`, …). State changes are ordinary REST resources; a `GET /global/event` variant exists for cross-project events. Events double as the plugin `event` hook surface.

**WHY.** A multi-agent UI needs push updates for agent progress, tool runs, and approval prompts; a handshake event lets clients detect server restarts and re-sync; reusing the same event names for plugins and clients keeps one mental model.

**HOW.** Sidecar exposes WS `/ws` emitting `server.hello {serverId, pid, schemaVersion}` first, then versioned bus events (`v` field). Tauri forwards nothing — React connects directly (or via a thin Tauri WS bridge). We need bidirectional WS where OpenCode's SSE is one-way: approvals, agent pause/cancel, and interactive prompts travel downstream without extra REST hops — but keep REST for everything idempotent, exactly like OpenCode.

## Pattern 4 — Permission triple `allow`/`ask`/`deny` with glob granularity and per-agent merge

**WHAT.** A top-level `permission` config (since v1.1.1, replacing per-agent tool booleans): per-tool keys (`bash`, `edit`, `read`, `grep`, `webfetch`, `websearch`, `task`, `skill`, `lsp`, `question`, plus guards `external_directory` and `doom_loop`) mapping to `allow | ask | deny`, or to granular objects of glob patterns where the **last matching rule wins** (`{"*": "ask", "git *": "allow", "rm *": "deny"}`); `~`/`$HOME` expansion in path patterns; agent configs merge over global with agent precedence; `permission.task` globs control which subagents an agent may dispatch (denied subagents disappear from the Task tool description); most tools default allow, `doom_loop`/`external_directory` default ask, `*.env*` reads denied. TUI approvals offer **once / always / reject** with a tool-suggested safe pattern (e.g. `git status*`); `--auto` flips asks to approves. Programmatic reply: `POST /session/:id/permissions/:permissionID` `{response, remember?}`.

**WHY.** This is ACUTE-CODE's safety layer almost verbatim — but inverted defaults: we need default-ask/deny, not default-allow. The grammar itself (triple + globs + last-match-wins + per-agent merge + remember-decision-as-pattern + programmatic resolution endpoint + doom-loop guard) is the best-specified minimal design we've seen.

**HOW.** Sidecar evaluates permissions centrally before tool dispatch (never in the UI): SQLite-backed rules `{tool, effect, pattern?}` with evaluation deny → allow → ask → default-ask; `remember` writes a new scoped rule (project or global). Every `ask` blocks that agent, persists an approval row, emits `permission.requested`; the human answers from React via `POST /sessions/:id/approvals/:approvalId` `{decision, remember?, scope?}`. Steal two extras: a `doom_loop` guard (same tool+identical input ≥3 times → force ask) and subagent-dispatch gating so a max-5-agents cap and per-agent tool restrictions fall out of the same rule engine.

## Pattern 5 — Provider = npm AI-SDK package + config record + metadata catalog

**WHAT.** Providers are config entries: `provider.<id>.npm` (any Vercel-AI-SDK-compatible package, e.g. `@ai-sdk/openai-compatible`), `options` (`baseURL`, `apiKey` with `{env:VAR}` / `{file:path}` substitution, headers, cloud-specific keys), a `models` map (`name`, `limit.context`, `limit.output`, `reasoning`), and `blacklist`/`whitelist` for the picker. Top-level `model` / `small_model` use `providerID/modelID`. Standard providers auto-inherit limits from **models.dev**; credentials live in `auth.json`, never config; OAuth (device-code/browser) supported for several providers.

**WHY.** ACUTE-CODE needs multi-provider routing with per-model limits and a cheap "add any OpenAI-compatible endpoint" story. Their split — *credentials in a separate store, transport in config, model metadata from a catalog* — is exactly the right factorization, and models.dev (also MIT-licensed data [UNVERIFIED license of models.dev]) removes hand-maintained limit tables.

**HOW.** Sidecar keeps a `providers` table (id, npm-package/driver id, baseURL, keyRef) + `models` table (id, provider, context/output limits, flags); API keys go in OS keychain (better than their auth.json plaintext) referenced by id. Route via the Vercel AI SDK (`ai` + `@ai-sdk/*`, MIT/Apache-2.0 — license-compatible with our allow-list) so custom endpoints are just `@ai-sdk/openai-compatible` instances. Separate `model` vs `small_model` (cheap model for titles/summaries) per workspace.

## Pattern 6 — Session as a first-class resource with fork/revert/children

**WHAT.** Sessions are REST resources with: list/create/patch/delete, `POST /init` (analyze repo, generate AGENTS.md), `/fork` (branch from a message), `/revert` / `/unrevert` (checkpoint rollback of agent file changes), `/children` (subagent runs are child sessions), `/share`, `/summarize` + automatic compaction via a hidden agent, `/todo`, `/diff`.

**WHY.** Durable, inspectable, replayable agent state is a core ACUTE-CODE promise. Fork/revert give cheap experimentation and safety (undo an agent's edits), child sessions make subagent work first-class UI objects, and server-side summarization keeps context bounded.

**HOW.** SQLite tables `sessions(id, parent_id, title, agent, status, created_at)`, `messages`, `parts`, `todos`, `file_snapshots` (before/after per edit for revert). REST mirrors their shape (`POST /sessions/:id/fork`, `/revert`). Our 5-agent cap maps to a `max_children`/scheduler on the sidecar. Compaction = a hidden system agent that rewrites the message history into a summary row, invisible in the main thread.

## Pattern 7 — Agents as markdown + YAML frontmatter; dispatch gating in the same permission engine

**WHAT.** Agents are defined in `opencode.json` or markdown files (`.opencode/agent/*.md` global/project) where frontmatter holds config (`description`, `model`, `mode: primary|subagent|all`, `permission`, `temperature`, `steps`, `hidden`, `disable`) and the body is the system prompt. Built-ins: `build` (full access), `plan` (edits denied, bash asks), `general`/`explore`/`scout` subagents; hidden agents for compaction/title/summary.

**WHY.** Markdown agents are trivially versionable per-project and readable by both humans and models; primary-vs-subagent `mode` plus `permission.task` gating gives a complete multi-agent permission story with no new mechanisms.

**HOW.** Store agents as markdown+frontmatter in workspace `.acute/agents/*.md` (seeded defaults: a `builder` that still asks on destructive ops, a read-only `planner`), parsed with `gray-matter` (MIT). The Task/dispatch tool lists only agents the parent is allowed to invoke; the React UI shows agent chips with their effective permission set. Keep hidden system agents for titling/summarization.

## Pattern 8 — Hook chokepoints: plugins intercept tools, not the LLM loop

**WHAT.** Plugins are JS/TS modules returning hooks: `tool.execute.before` (mutate args or **throw to block**), `tool.execute.after`, `event` (all bus events), `shell.env` (inject env), `tool` (register custom tools that can override built-ins of the same name), compaction hooks. Context: `{project, client (SDK), $ (shell), directory, worktree}`. Load order global→project; npm plugins auto-installed with Bun.

**WHY.** A single before/after chokepoint around every tool call is the cleanest extension and policy surface possible — it's also how we should implement our own policy layer (the permission engine) even before any third-party plugins exist.

**HOW.** Internal-first: implement ACUTE-CODE's permission engine, audit log, and secret-redaction as internal before/after interceptors around each tool in the sidecar. If we later open a plugin surface, run third-party hooks in a sandboxed worker with an explicit capability grant (no shell, no direct DB) — do NOT replicate their in-process `$` shell access.

## Pattern 9 — SQLite discipline: WAL, one file, migrations, runtime-adaptive driver

**WHAT.** Storage is one SQLite file (`opencode.db` in the XDG data dir; channel-suffixed files like `opencode-beta.db` so different release channels never share data), opened with WAL / synchronous=NORMAL / busy_timeout / foreign_keys pragmas, schema managed by generated migrations through Drizzle, with `sqlite.bun.ts` / `sqlite.node.ts` selecting the driver per runtime; init failures are fatal by design.

**WHY.** Same engine we chose; their pragmas and single-owner, fatal-on-corruption posture are production-proven defaults, and channel/dev-vs-prod database separation prevents test runs from nuking user data.

**HOW.** Sidecar opens `acute.db` under `%APPDATA%/ACUTE Code/` with exactly those pragmas (busy_timeout matters for our WS + REST concurrency); `better-sqlite3` as the driver; Drizzle for schema + generated migrations (both are in OpenCode's dependency set and permitted by our allow-list — confirm exact SPDX at adoption time); separate `acute-dev.db` in dev mode; every migration runs in a transaction on boot.

---

## What to avoid (with reasons)

| Avoid | Reason |
|---|---|
| **Effect as the framework** | Core/server lean on Effect incl. `effect/unstable/*` — steep learning curve, API churn, poor hiring fit; our sidecar gains nothing from it over plain Fastify + Zod. |
| **Default-allow permissions** | Most OpenCode tools default to "allow"; only `doom_loop`/`external_directory` ask. ACUTE-CODE is approval-first — our defaults must be ask (bash/edit) or deny (secrets, network). |
| **In-process plugins with `$` shell + SDK client** | Zero sandboxing; any plugin = arbitrary code in the server with user credentials. Fine for an OSS dev tool; unacceptable for a closed-source workbench. |
| **Auto-installing npm plugins at startup (Bun)** | Supply-chain risk at every launch; if we ever add plugins, require explicit install + signature/allow-list. |
| **Bun-only runtime assumptions** | `bun:sqlite`, Bun shell in the plugin API, Bun install — we are a Node sidecar inside Tauri; keep drivers runtime-agnostic (they actually show how: `sqlite.node.ts`). |
| **SSE-only streaming** | One-way; approvals and agent control would need REST side-channels. Keep our WS for bidirectional, and add SSE later only if a consumer needs it. |
| **Electron desktop shell** | 150+ MB bundles vs our Tauri choice; their Windows story ("use WSL") is the opposite of our native-Windows requirement. |
| **Plaintext `auth.json` for credentials** | Convenient, but we should use the OS keychain/credential manager from day one. |
| **Optional server auth** | Loopback-only + opt-in Basic auth is thin; any local process can drive the agent (and its bash tools). Make token auth mandatory for the sidecar. |

## Sources

- https://opencode.ai/docs/server/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/windows-wsl
- https://opencode.ai/docs/ (index)
- https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE
- https://raw.githubusercontent.com/anomalyco/opencode/dev/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/database/database.ts
- https://api.github.com/repos/anomalyco/opencode/contents/packages/core/src/database?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/core/src/session?ref=dev
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/server/src/routes.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/server/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/desktop/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/package.json
- https://api.github.com/repos/anomalyco/opencode
- https://api.github.com/repos/sst/opencode
- https://api.github.com/repos/opencode-ai/opencode
- https://registry.npmjs.org/opencode-ai/latest
