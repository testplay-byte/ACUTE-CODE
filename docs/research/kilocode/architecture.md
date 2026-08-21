# Kilo Code — Architecture (verified from repo, Aug 2026)

All statements below are verified against the repository (source tree, package manifests, `AGENTS.md`) or the official docs, except where marked **[inferred]** (filename-based inference) or **[UNVERIFIED]**.

## 1. Big picture: one core engine, many thin clients

Kilo Code's defining architectural decision (stated in the repo's `AGENTS.md`): **"All products are clients of the CLI, spawning/connecting to `kilo serve` over HTTP + SSE. Each extension host shares one backend via `KiloConnectionService`."**

- The core engine is `packages/opencode` (`@kilocode/cli`) — a fork of upstream OpenCode. It contains the agent loop, tools, permissions, skills, MCP client, config system, LLM providers, storage, and the HTTP server.
- The VS Code extension (`packages/kilo-vscode`, `kilo-code` v7.4.23) **bundles the CLI binary** and manages the connection; its `src` contains UI providers and product features, not the agent loop.
- JetBrains plugin (`packages/kilo-jetbrains`, Java 21), the TUI (`packages/tui`), and the Zed extension (`packages/extensions/zed` + `src/acp/` Agent Client Protocol in the core) are additional clients of the same server.
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

The engine is written TypeScript on **Effect 4 beta** with the **Vercel AI SDK** for providers, **Hono** for the HTTP server, and **SQLite via Drizzle ORM** for storage (dedicated packages `effect-drizzle-sqlite`, `effect-sqlite-node`).

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

YAML (`custom_modes.yaml` / `.roomodes` historically) with fields `slug`, `name`, `roleDefinition`, `whenToUse`/`description`, `customInstructions`, `groups` (e.g. `["read", "edit", "browser"]`), `model`. Migration mapping documented: `slug` -> agent name; `roleDefinition` + `customInstructions` -> prompt; `groups` -> permission rules; `whenToUse` -> description.

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
  - Built-in subagents: `general` (full tools except todo) and `explore` (fast, read-only).
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

**Skills** (open [Agent Skills](https://agentskills.io) standard): a folder with `SKILL.md` (frontmatter: `name` <=64 chars, must match directory name; `description` <=1024 chars; optional `license`, `compatibility`, `metadata`) plus optional `scripts/`, `references/`, `assets/`. Load order: `~/.kilo/skills/` (global) -> `.kilo/skills/` (project, wins) with compat dirs `.agents/skills/`, `.claude/skills/`, plus `skills.paths` and remote `skills.urls` (server hosts `index.json`; version bumps trigger atomic cache replacement). Discovery is **progressive**: at session start only name+description are scanned and injected into the system prompt; the full SKILL.md is read into context only when the LLM decides it applies (no keyword/semantic search — the model judges from descriptions; manual "use the X skill" always works). Skills may embed `` !`command` `` shell substitutions, executed only from trusted locations, with per-command approval, disableable via `KILO_DISABLE_SKILL_SHELL`. Distribution: GitHub repos (`Kilo-Org/skills`, `Kilo-Org/kilo-marketplace`) or remote URLs; "no marketplace UI yet" for skills specifically (the Marketplace panel installs them generically).

**MCP**: configured under the `mcp` key in `kilo.jsonc`; `local` servers run as child processes (stdio), `remote` servers are HTTP/SSE URLs; default timeouts 10s local / 15s remote. MCP tools are presented to the model alongside built-in tools and pass through the same allow/ask/deny permission system (namespaced key `{server}_{tool}`). Installing an MCP server "only makes tools available — it does not automatically approve every tool call."

**Marketplace** (`MarketplacePanelProvider` in the extension; registry = `Kilo-Org/kilo-marketplace` GitHub repo): three item types — Agent, Skill, MCP server — described as "configuration and instruction files, not VS Code extensions." Two scopes: project (`.kilo/agents/<name>.md`, `.kilo/skills/<name>/`, `.kilo/kilo.json`) and global (`~/.config/kilo/agents/`, `~/.kilo/skills/`, `~/.config/kilo/kilo.json`); project takes precedence; removal is scope-specific. After install/removal Kilo **reloads configuration**, which may interrupt running sessions. No runtime plugin host is involved — installed items are discovered by the ordinary config/skill loaders.

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
- https://github.com/Kilo-Org/kilocode/tree/main/packages
- https://github.com/Kilo-Org/kilocode/tree/main/packages/opencode/src
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/src
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/src/agent-manager
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/package.json
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-gateway/README.md
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-gateway/package.json
- https://kilo.ai/docs/code-with-ai/agents/using-agents
- https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode
- https://kilo.ai/docs/customize/custom-modes
- https://kilo.ai/docs/customize/custom-subagents
- https://kilo.ai/docs/customize/skills
- https://kilo.ai/docs/customize/marketplace
- https://kilo.ai/docs/automate/mcp/using-in-kilo-code (search excerpts)
- https://kilo.ai/docs/automate/mcp/using-in-cli (search excerpts)
- https://kilo.ai/docs/getting-started/settings/auto-approving-actions (search excerpts)
