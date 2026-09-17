<!-- last-reviewed: 2026-09-17 round-102 -->
# Kilo Code — Architecture (verified from repo, Aug 2026)

All statements below are verified against the repository (source tree, package manifests, `AGENTS.md`) or the official docs, except where marked **[inferred]** (filename-based inference) or **[UNVERIFIED]**.

## 1. Big picture: one core engine, many thin clients

Kilo Code's defining architectural decision (stated in the repo's `AGENTS.md`): **"All products are clients of the CLI, spawning/connecting to `kilo serve` over HTTP + SSE. Each extension host shares one backend via `KiloConnectionService`."**

- The core engine is `packages/opencode` (`@kilocode/cli`) — a fork of upstream OpenCode. It contains the agent loop, tools, permissions, skills, MCP client, config system, LLM providers, storage, and the HTTP server.
- The VS Code extension (`packages/kilo-vscode`, `kilo-code` v7.4.23) **bundles the CLI binary** and manages the connection; its `src` contains UI providers and product features, not the agent loop.
- JetBrains plugin (`packages/kilo-jetbrains`), the TUI (`packages/tui`), and the Zed extension (`packages/extensions/zed` + `src/acp/` Agent Client Protocol in the core) are additional clients of the same server.
- `@kilocode/sdk` (`packages/sdk/js`) is auto-generated from the server API (`src/gen/` must not be hand-edited).
- `packages/kilo-gateway` is not the IDE bridge — it is auth + LLM routing (device-auth flow, OpenRouter-based provider factory `createKilo`, `KiloAuthPlugin` for OpenCode's plugin system).

```
                    +----------------------------------------------------------+
                    |                 Kilo Code monorepo (Bun + Turbo)        |
                    |                                                          |
  +-----------+     |  +-----------------+   spawns/connects   +-------------+ |
  | VS Code   |-----+->| kilo-vscode     |------------------->| opencode    | |
  | (webview: |     |  | (SolidJS UI,    |   HTTP + SSE        | (@kilocode/ | |
  | SolidJS)  |     |  | Agent Manager,  |                     |  cli) CORE  | |
  +-----------+     |  | bundles CLI     |   KiloConnection    |             | |
  +-----------+     |  | binary)         |   Service (1 shared +-------------+ |
  | JetBrains |-----+->+-----------------+   backend per       | session/    | |
  +-----------+     |  +-----------------+   extension host)   |  agent loop | |
  +-----------+     |  | kilo-jetbrains  |-------------------->| tool/  mcp/ | |
  | CLI / TUI |-----+->+-----------------+                     | permission/ | |
  +-----------+     |  +-----------------+                     | skill/      | |
  +-----------+     |  | Zed ext (ACP)   |                     | snapshot/   | |
  | Zed       |-----+->+-----------------+                     | worktree/   | |
  +-----------+     |  +-----------------+                     | server/     | |
                    |  | sdk (generated) |<-- API contract ---> | provider/   | |
                    |  +-----------------+                     | storage/    | |
                    |         Marketplaces / Skills / Agents   | (SQLite +   | |
                    |         = plain files in .kilo/ or ~/.k  |  Drizzle)   | |
                    |                                          +------+------+ |
                    +------------------------------------------|--------|--+
                                                                  |        |
                                                       LLM calls |        | auth/models
                                                       (AI SDK)  v        v
                                                   Anthropic/OpenAI/...  kilo-gateway
                                                                          (Kilo auth +
                                                                          OpenRouter)
```

## 2. Core engine internals (`packages/opencode/src`, verified directory listing)

| Module | Role (purpose per name; **[inferred]** where noted) |
|---|---|
| `session/` | Conversation state / message handling — the heart of the agent loop |
| `agent/` | Agent (mode) definitions and selection |
| `tool/` | Built-in tools (edit, bash, search, task, webfetch, ...) |
| `mcp/` | MCP client for external tool servers |
| `permission/` | Tool-call gating behind user approval |
| `server/` | The HTTP API server that IDE/CLI clients talk to |
| `config/`, `env/` | JSONC config loading (`kilo.jsonc`, `kilo.json`), env overrides |
| `provider/`, `auth/` | LLM provider registry, API keys / OAuth |
| `skill/` | Skill discovery and loading |
| `snapshot/` | Checkpointing file state for undo |
| `worktree/`, `git/` | Git worktree management for parallel agents |
| `bus/` | Internal event bus (`event-manifest.ts`, `event-v2-bridge.ts` at top level) |
| `acp/` | Agent Client Protocol (Zed integration) |
| `storage/`, `sync/`, `kilo-sessions/` | Persistence and cloud sync; `sql.d.ts` indicates native SQLite bindings |
| `background/`, `question/` | Background tasks; mid-run clarifying questions to the user |
| `plugin/`, `command/`, `suggestion/` | Plugin interfaces, slash commands, follow-up suggestions |

The engine is written TypeScript on **Effect 4 beta** (root catalog pins `effect 4.0.0-beta.83`) with the **Vercel AI SDK** (`ai` + ~20 provider packages) for providers, **Zod 4** for validation, and **SQLite via Drizzle ORM** for storage (dedicated packages `effect-drizzle-sqlite`, `effect-sqlite-node`). HTTP framework: **[UNVERIFIED — not identifiable from the fetched manifests; upstream OpenCode lineage suggests Hono]**.

### 2b. Process model, persistence, events, config (verified from the CLI Runtime architecture doc)

- **Entry points**: `kilo` (interactive TUI; attaches to a healthy local daemon, else starts a Bun worker issuing SDK-shaped RPC into an embedded server), `kilo run` (headless; daemon attach -> embedded fallback; `--attach <url>`), `kilo serve` (explicit HTTP + SSE server), `kilo daemon start` (detached reusable `kilo serve` child; state in `daemon.json` mode 0600; ports scanned 4097..4116; health probe on authenticated `/global/health`, 2s timeout; `KILO_NO_DAEMON` opts out).
- **Editor-owned server**: the VS Code extension spawns `bin/kilo serve --port 0` with a random 32-byte hex password via `KILO_SERVER_PASSWORD`. Basic Auth becomes required when that env is set (default user `kilo`); WebSocket uses an `auth_token` query param; PTY access uses single-use tickets; the server **strips password vars from shells it spawns**. SSE gap >15s triggers reconnect (250ms -> 5s backoff); health polled every 10s; server exit clears state and a retry respawns.
- **Directory-keyed instances**: one `kilo serve` hosts several local runtime instances; the directory resolves via `directory` query param -> `x-kilo-directory` header -> process cwd. `InstanceStore` caches normalized directory-scoped contexts, dedupes concurrent boots, and disposes per-directory state — while process-shared service state stays shared. Worktree paths (`.kilo/worktrees/`) act as isolated directory contexts for parallel Agent Manager work.
- **Persistence**: SQLite is the default structured store at `${Global.Path.data}/kilo.db` (`KILO_DB` override; `:memory:` accepted), WAL journaling, 5-second busy timeout, Drizzle migrations. Tables: projects, sessions, messages, parts, todos, **permissions** (permission decisions are persisted), workspaces, sync events, accounts. A one-time JSON-to-SQLite legacy migration runs on first DB creation; some JSON-backed storage remains (session diffs, config, auth).
- **Snapshots**: git-backed file baselines for diffs/revert, stored in a separate git directory per worktree under `${data}/snapshot/<project-id>/<worktree-hash>`; one process-wide slow-snapshot guard; Agent Manager turns request `snapshotInitialization: "wait"`.
- **Events**: `/event` = per-instance bus; `/global/event` = process-wide multiplexed stream wrapping payloads with directory/project/workspace metadata (one connection serves multiple directories); both send `server.connected` then a heartbeat every 10s.
- **Config**: a 12-source precedence merge (legacy migrations, org modes, global files, `kilo.json[c]` / `opencode.json[c]`, `KILO_CONFIG` / `KILO_CONFIG_DIR` / `KILO_CONFIG_CONTENT`, cloud org config, managed directories/prefs, runtime flags). Tools/permissions/agents live in CLI config, not VS Code settings — shared across all clients.
- **Tool registry**: "loads built-in, Kilo-specific, MCP, and readiness-gated semantic search tools" — `semantic_search` is registered only after the `kilo-indexing` worker (async bootstrap; Qdrant/LanceDB vector stores; multiple embedding providers) reports readiness.

## 3. Agent loop (as documented)

The loop is the standard tool-use agentic cycle (model turn -> tool calls -> permission check -> execute -> observations -> next turn), wrapped in a session object. Verified characteristics:

- **Tools** include at least: `read`, `edit`, `bash`, `glob`, `grep`, `task` (subagent launch), `webfetch`, `websearch`, `todowrite`, `todoread`, plus all MCP server tools.
- **Permissions** intercept every tool call: each rule resolves to `allow` (run), `ask` (prompt the user), or `deny` (block). The mid-run `question/` module and the Ask-agent's "MCP tools require per-call approval" confirm prompts are part of the loop, not a UI afterthought.
- **Checkpoints** (`snapshot/`) capture file state so steps can be undone.
- **`steps`** frontmatter field caps iterations per agent (loop bound).
- **`kilo run --auto`** is the loop with all permission prompts disabled (CI/CD mode; docs warn "only use it in trusted environments").
- The legacy Cline-style loop (Roo/Cline fork era: React webview, mode system in extension host) has been superseded; `kilo-vscode/src/legacy-migration/` and `roo-import/` exist only to migrate old data. Exact legacy loop internals: **[UNVERIFIED — not in current repo]**.

## 4. Mode / agent / permission model

Two generations, both visible in the docs:

### Legacy "modes" (Roo/Cline lineage, auto-migrated away)

Legacy `custom_modes.yaml` / `.kilocodemodes` files **auto-migrate on startup** (verified from the Custom Modes doc). Historical Roo-style fields (`slug`, `roleDefinition`, `customInstructions`, `groups` such as `["read", "edit", "browser"]`, `whenToUse`) and their mapping onto the new agent format: **[UNVERIFIED — field-level migration mapping not present in current docs]**.

### Current "agents" (Markdown + frontmatter, 2026)

- Files: `.kilo/agents/<name>.md` (project) or `~/.config/kilo/agents/<name>.md` (global); filename = agent name; body = system prompt; YAML frontmatter fields: `description`, `model` (`provider/model-id`, else inherits parent's), `mode` (`primary` | `subagent` | `all`), `permission`, `color`, `steps`, `temperature`/`top_p`, `hidden`, `disable`. JSON form lives under `agent` in `kilo.jsonc`; `kilo agent create` scaffolds one.
- **Permissions**: ordered rules with `allow`/`deny`/`ask`, glob patterns, **last-match-wins**. Tool types: `read`, `edit`, `bash`, `glob`, `grep`, `task`, `webfetch`, `websearch`, `todowrite`, `todoread`. Path scoping example: deny `"*"`, then allow `"*.md"` and `"docs/**"`. `permission.task` restricts which subagents an agent may invoke. MCP tools use the same system under namespaced keys `{server}_{tool}`.
- **Merge precedence**: built-in defaults -> global config -> project config -> global Markdown -> project Markdown (project wins); built-ins can be overridden by name or disabled.
- **Built-in agents** (roles and tool access verified from docs):
  - **Code** (default): "skilled software engineer" — full tool access incl. MCP.
  - **Ask**: read-only tools plus a read-only bash allowlist (cat, grep, git log/diff, jq...); all writes blocked; MCP tools per-call approval.
  - **Plan**: read-only + edits restricted to plan files under `.kilo/plans/` (successor of legacy "Architect").
  - **Debug**: full access, systematic-troubleshooting prompt.
  - **Orchestrator**: **deprecated** — was a dedicated delegator mode; replaced by native subagents.
  - Built-in subagents: `general` (full access) and `explore` (read-only); both overridable or disableable by name.
  - Docs/repo discrepancy: the GitHub README lists a "Review" agent, but the Using Agents doc states there is no built-in Review agent in the VS Code extension or CLI — code review is a `/review` command (local AI review of uncommitted/branch/commit/PR targets) rather than a persona.
- The VS Code settings UI's per-tool Allow/Ask/Deny dropdowns read and write **the same `kilo.jsonc`** the CLI uses (single source of truth).

### Subagents / orchestration

- Any full-access agent (Code/Plan/Debug) may call the **`task` tool** to spawn a subagent (built-in or custom, chosen by `description` matching, or `@agent-name` manual mention). Read-only agents (Ask) cannot delegate.
- Each subagent runs in **its own session with a separate conversation history**; on completion only a **summary returns to the parent**. Multiple subagent sessions can run in parallel.
- The deprecated Orchestrator mode (docs): user manually switched to it; it decomposed tasks and handed subtasks to Code/Architect via `new_task`. Lesson recorded by Kilo: delegation should be a capability of agents, not a separate persona.

## 5. Agent Manager (parallel agents in the VS Code panel)

`packages/kilo-vscode/src/agent-manager/` (verified file listing; roles **[inferred]** from names):

- **Isolation**: `WorktreeManager`, `WorktreeStateManager`, `worktree-create/importer`, `branch-naming` — one git worktree + branch per agent; `GitOps`/`git-transfer` move changes back; `gh.ts` + `PRStatusPoller` integrate PR checks.
- **Concurrency**: `semaphore.ts` queues operations up to a max count; `prune-subagents.ts` reaps stale ones.
- **Lifecycle**: `fork-session`/`fork-handoff` (fork a session into a new agent), `promotion-handoff` (promote completed work), `multi-version`/`provider-lifecycle` (multiple core instances/versions), `state-recovery` (survive window reloads).
- **Terminals**: per-agent terminal creation and routing (`terminal-manager`, `terminal-routing`, `SessionTerminalManager`), xterm.js in the webview.
- **Env setup**: `SetupScriptRunner`/`setup-script-template` run install/build in fresh worktrees; `sandbox-bootstrap`, `env-copy`, `shell-env` for environment; `mcp-warmup` pre-warms MCP servers.

## 6. Skills / MCP / Marketplace data flow

**Skills**: a folder with `SKILL.md` (frontmatter: `name` <=64 chars, must match directory name; `description` <=1024 chars; optional `license`, `compatibility`, `metadata`) plus optional `scripts/`, `references/`, `assets/`. Load order: `~/.kilo/skills/` (global) -> `.kilo/skills/` (project, wins) with compat dirs `.agents/skills/` (loaded by default) and `.claude/skills/` (when Claude Code compatibility is enabled), plus `skills.paths` and remote `skills.urls` (remote servers must serve an `index.json` manifest). Discovery is **progressive**: at session start only name+description are scanned and injected into the system prompt; the full SKILL.md is read into context only when the LLM decides it applies — "There's no keyword matching or semantic search — the agent evaluates your request against all available skill descriptions" — surfacing as a `skill` tool call; manual "use the X skill" always works; `/reload` rescans mid-session. Skills may embed `` !`command` `` shell substitutions, executed only from trusted locations (global/built-in), with per-command approval, disableable via `KILO_DISABLE_SKILL_SHELL`; project and remote-URL skills never execute commands. Distribution: the Kilo Marketplace panel installs them generically (see below).

**MCP**: configured under the `mcp` key in `kilo.jsonc`; `local` servers run as child processes (stdio), `remote` servers are HTTP/SSE URLs; default timeouts 10s local / 15s remote. MCP tools are presented to the model alongside built-in tools and pass through the same allow/ask/deny permission system (namespaced key `{server}_{tool}`). Installing an MCP server "only makes tools available — it does not automatically approve every tool call."

**Marketplace** (sidebar Marketplace panel in the extension; registry = `Kilo-Org/kilo-marketplace` GitHub repo): three item types — Agent, Skill, MCP server — described as "configuration and instruction files, not VS Code extensions." Two scopes: project (`.kilo/agents/<name>.md`, `.kilo/skills/<name>/`, `kilo.json` `mcp` key merged "without replacing your other Kilo settings") and global; project takes precedence; removal is scope-specific. After install/removal "sessions may reload after changes" — a full config reload is involved. No runtime plugin host is involved — installed items are discovered by the ordinary config/skill loaders, and installing does not auto-approve tool calls (credentials should stay in env vars, not committed config).

```
Marketplace registry (GitHub: Kilo-Org/kilo-marketplace)
        |  install (project | global scope)
        v
.kilo/agents/*.md   .kilo/skills/<n>/SKILL.md   .kilo/kilo.json (mcp key)
        |                  |                            |
        +-------- config loaders at session start ------+
                           |
             system prompt: agent persona + skill
             name/description index (metadata only)
                           |
              LLM picks skill -> full SKILL.md loaded
              LLM calls tool -> permission check
                       (allow / ask / deny, last-match-wins)
```

## 7. Fork-management machinery (context)

Because `packages/opencode` is a fork of live upstream OpenCode, the repo enforces: edit shared upstream files only as last resort; `kilocode_change` markers on every Kilo-specific edit in shared files; a "no Promise facades over Effect services" ratchet script; config keys mirrored to a cloud JSON schema; CI-checked workflow allowlists. Relevant only if ACUTE-CODE ever forks a live upstream (we do not plan to).

## Sources

- https://github.com/Kilo-Org/kilocode
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/AGENTS.md
- https://github.com/Kilo-Org/kilocode/blob/main/package.json
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/opencode/package.json
- https://github.com/Kilo-Org/kilocode/tree/main/packages
- https://github.com/Kilo-Org/kilocode/tree/main/packages/opencode/src
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/src
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/src/agent-manager
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/package.json
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-gateway/README.md
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-gateway/package.json
- https://kilo.ai/docs
- https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new
- https://kilo.ai/docs/contributing
- https://kilo.ai/docs/contributing/architecture
- https://kilo.ai/docs/contributing/architecture/cli-runtime
- https://kilo.ai/docs/contributing/architecture/vscode-extension
- https://kilo.ai/docs/code-with-ai/agents/using-agents
- https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode
- https://kilo.ai/docs/customize/custom-modes
- https://kilo.ai/docs/customize/custom-subagents
- https://kilo.ai/docs/customize/skills
- https://kilo.ai/docs/customize/marketplace
- https://kilo.ai/docs/automate/mcp/using-in-kilo-code
- https://kilo.ai/docs/getting-started/faq
- https://kilo.ai/docs/getting-started/faq/general
