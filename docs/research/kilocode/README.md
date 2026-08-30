<!-- last-reviewed: 2026-08-30 round-53 -->
# Kilo Code — Research Summary (for ACUTE-CODE)

Researched: 2026-08-21. Primary source: https://github.com/Kilo-Org/kilocode (verified via direct fetches of README, LICENSE, package manifests, source tree, and the official docs at kilo.ai).

## What it is

Kilo Code is an **open-source agentic engineering platform / AI coding agent** distributed as a VS Code extension, a JetBrains plugin, a CLI (`@kilocode/cli`, a fork of OpenCode), a TUI, and a web "Cloud Agent". Repo stats at time of research: ~27.0k stars, ~3.1k forks, monorepo version `7.4.23`.

Important lineage note: despite its historical Cline -> Roo Code fork origin, the **current repo is no longer a classic Cline-style extension**. In **April 2026** the extension was rebuilt on top of the Kilo CLI (an OpenCode fork) as its shared core engine ("the biggest update since launch"); `packages/kilo-vscode/src` still contains `roo-import/` and `legacy-migration/` modules, confirming the lineage, but the agent loop now lives in `packages/opencode` (the CLI core). All editor products are thin clients that spawn/connect to `kilo serve` over HTTP + SSE. Modes were renamed **agents**, the Orchestrator mode was **deprecated** in favor of native subagents, checkpoints became git-backed **snapshots**, and the old auto-approve allowlist became a granular per-tool **Allow/Ask/Deny** permission system.

Key user-facing concepts:

- **Agents** (formerly "modes"): Code, Ask, Plan, Debug + custom agents; Orchestrator mode is **deprecated** — full-access agents now spawn subagents natively via the `task` tool.
- **Agent Manager** (VS Code panel): parallel agents, each isolated in its own git worktree/branch with its own terminal, gated by a semaphore.
- **Skills**: folders with `SKILL.md` implementing the open "Agent Skills" format ("a lightweight, open format for extending AI agent capabilities" — per docs), with progressive disclosure.
- **MCP**: local (stdio) and remote (HTTP/SSE) servers configured in `kilo.jsonc`; MCP tools go through the same allow/ask/deny permission system as built-in tools.
- **Marketplace**: installs Agents, Skills, and MCP servers as plain config/instruction files (project or global scope) from the `Kilo-Org/kilo-marketplace` GitHub registry.

## License (verified from LICENSE files)

- Root `LICENSE` (`github.com/Kilo-Org/kilocode/blob/main/LICENSE`): **MIT** — "Copyright (c) 2026 Kilo Code" and "Copyright (c) 2025 opencode". SPDX: **MIT**.
- `packages/kilo-vscode/LICENSE`: **MIT** (same text). `packages/kilo-vscode/package.json` also declares `"license": "MIT"`.
- Inconsistency flag: `packages/kilo-vscode/README.md` states "This project is licensed under the Apache License 2.0" (likely stale text from the Roo/Cline Apache-2.0 era). The LICENSE file (MIT) is the governing instrument.
- **Compatibility verdict**: MIT (and the stale Apache-2.0 claim) are both inside ACUTE-CODE's allowed set (MIT, Apache-2.0, BSD, ISC, MPL-2.0). No GPL/AGPL/LGPL found in any inspected manifest. No license incompatibility. Per study constraints: learn patterns only, do not copy code.

## Tech stack (verified from package.json / repo tree)

| Layer | Technology |
|---|---|
| Monorepo | Bun 1.3.14 workspaces + Turborepo 2.x, 35 packages, changesets |
| Core engine | `packages/opencode` (`@kilocode/cli`) — TypeScript, fork of OpenCode |
| Runtime effects | Effect 4.0.0-beta (with local patches) |
| LLM plumbing | Vercel AI SDK (`ai`, catalog-pinned), `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider` (via `kilo-gateway`) |
| API server | `kilo serve` inside the CLI: local HTTP + SSE (`/event` per instance, multiplexed `/global/event`, 10s heartbeat); web framework [UNVERIFIED — not identifiable from fetched manifests] |
| Storage | **SQLite** (`kilo.db`, WAL, 5s busy timeout) via Drizzle ORM migrations (`packages/effect-drizzle-sqlite`, `packages/effect-sqlite-node`); tables incl. projects, sessions, messages, parts, todos, permissions, workspaces; some JSON files remain (config, auth, session diffs) |
| Validation | Zod 4 |
| VS Code extension | `packages/kilo-vscode` (`kilo-code` v7.4.23), esbuild + Vite, bundles the CLI binary |
| Webview UI | **SolidJS 1.9.x** (migrated off React), Storybook, xterm.js, simple-git, web-tree-sitter, js-tiktoken |
| Other clients | JetBrains plugin, TUI package, Zed extension via ACP (`@agentclientprotocol/sdk` 0.21.0) |
| SDK | `@kilocode/sdk` — auto-generated from the server (`src/gen/` is generated code) |
| Tooling | oxlint, tsgo typecheck, knip, Playwright (`@playwright/test` 1.57.0), 15 patched dependencies (incl. effect, solid-js, MCP SDK) |

## Top adoptable patterns (details in patterns-for-acute-code.md)

1. **Thin-client + core-process architecture**: every editor ships as a UI client; the agent loop, tools, permissions, and storage live in one core process (`kilo serve`, HTTP + SSE, shared per extension host via `KiloConnectionService`).
2. **Agent-as-config-file with ordered allow/ask/deny permission rules**: agents are Markdown files with frontmatter; permissions are ordered glob rules (`allow`/`ask`/`deny`, last-match-wins) covering tools, file paths, and bash commands.
3. **Subagents via a `task` tool with context isolation**: parent agents spawn isolated subagent sessions that return only a summary; parallelism managed by a semaphore and (in Agent Manager) one git worktree per agent.

## What to avoid (one line each)

- `kilo run --auto` blanket disabling of all permission prompts — directly contradicts ACUTE-CODE's human-approval safety layer.
- Effect 4 beta + 15 patched dependencies as foundation — operational complexity we do not need.
- Fork-merge machinery (`kilocode_change` markers, upstream-sync discipline) — only valuable if we fork a live upstream; we are building original code.
- Marketplace installs that trigger a full config reload interrupting running sessions — a UX hazard ACUTE-CODE should design around.
- Trusting the README license text — the repo itself has an MIT/Apache-2.0 doc mismatch; always read the LICENSE file.

## Relevance to ACUTE-CODE

Kilo Code is the most architecturally similar of our reference targets despite the different surface (VS Code vs Tauri). Its core decision — "all products are clients of the CLI, spawning/connecting to `kilo serve` over HTTP + SSE" — is precisely ACUTE-CODE's Tauri-shell + Node-sidecar (localhost REST + WS) split, validated at scale with three real clients (VS Code, JetBrains, CLI/TUI). Its permission model (unified allow/ask/deny ordered glob rules, shared by UI dropdowns and CLI config, with MCP tools namespaced into the same system) gives us a proven shape for our human-approval layer. Its subagent model (`task` tool, isolated context, summary-only return, built-in `general`/`explore` subagents) and Agent Manager (semaphore-bounded parallel agents, worktree isolation, fork/promotion handoff, PR status polling) map directly onto our max-5-concurrent-agents requirement with SQLite-backed session persistence. Finally, its Skills system demonstrates progressive-disclosure loading of Markdown-packaged capabilities — a lightweight alternative to heavyweight plugin runtimes. Caveats: the solid-js webview, Effect-TS core, and OpenCode fork lineage are context, not prescriptions; the deprecated Orchestrator mode shows that delegation-as-a-mode ages worse than delegation-as-a-capability.

## Sources

- https://github.com/Kilo-Org/kilocode (repo page)
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/LICENSE
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/README.md
- https://github.com/Kilo-Org/kilocode/blob/main/package.json
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/opencode/package.json
- https://github.com/Kilo-Org/kilocode/tree/main/packages
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/LICENSE
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/README.md
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/package.json
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/src
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/src/agent-manager
- https://github.com/Kilo-Org/kilocode/tree/main/packages/opencode/src
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-gateway/README.md
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-gateway/package.json
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/AGENTS.md
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
- https://kilo.ai/docs/automate/mcp/using-in-cli (via search result excerpts)
- https://kilo.ai/docs/getting-started/settings/auto-approving-actions (via search result excerpts)
- https://kilo.ai/docs/getting-started/faq
- https://kilo.ai/docs/getting-started/faq/general
