<!-- last-reviewed: 2026-09-12 round-94 -->
# Cline — Research Summary (ACUTE-CODE Reference Study)

- **Target:** https://github.com/cline/cline (canonical; not moved)
- **Studied:** 2026-08-21, `main` branch (Bun-workspace monorepo; VS Code extension mid-migration onto the SDK engine)
- **Scale at time of study:** ~66.6k stars, ~7.2k forks, ~7.1k commits

## What It Is

Cline is an open-source autonomous coding agent ("The open source coding agent in your IDE and terminal"; repo description: "Autonomous coding agent as an SDK, IDE extension, or CLI assistant."). One shared agent engine powers several shipped forms:

| Product | Location | Notes |
|---|---|---|
| SDK | `sdk/packages/*` — `@cline/sdk` (umbrella, v0.0.77), `@cline/core`, `@cline/agents`, `@cline/llms`, `@cline/shared`, `@cline/ui` | npm-published engine ("the same engine that powers Cline, packaged as a library") |
| CLI | `apps/cli` | Interactive OpenTUI app + headless JSON mode for CI/CD |
| VS Code extension | `apps/vscode` (npm name `claude-dev` v4.1.12, publisher `saoudrizwan`) | Extension host (Node) + React 18 webview; README marks repo-root location "(WIP migrating)" |
| JetBrains plugin | Closed source | "JetBrains-hosted client that talks to the shared agent core" (README) |
| Kanban board | Separate repo `cline/kanban` | Web multi-agent task board; one git worktree per card |
| Desktop example | `apps/examples/desktop-app`, `apps/examples/menubar` | **Tauri 2 shell + Bun sidecar backend + web UI** — the exact topology ACUTE-CODE chose |

Agent capabilities: whole-project file edits, terminal commands (incl. long-running dev-server monitoring and "Proceed While Running" detachment), browser use, MCP servers, git-based checkpoints (undo agent work), `.clinerules`/skills/workflows, multi-agent teams, cron-scheduled agents, connectors (Slack/Telegram/etc.). Plan/Act mode split; every edit/command approvable or auto-approved.

## License

**SPDX: `Apache-2.0`** — verified from the LICENSE file on `main`: stock Apache License 2.0 text (201 lines), `Copyright 2026 Cline Bot Inc.`; the only "Cline" occurrence is the copyright line; no appended attribution/branding clause today. `apps/vscode/package.json`, `@cline/sdk`, and `@cline/agents` manifests also declare `Apache-2.0` (the other sdk package manifests omit the field; the repo LICENSE covers them). License history: created 2024-07-10, switched to Apache-2.0 2024-10-09; whether any intermediate revision carried an extra attribution clause is [UNVERIFIED] — none exists now. Standard Section 6 applies: no rights to the "Cline" trade name/mark.

**Compatibility with ACUTE-CODE's allowed set (MIT, Apache-2.0, BSD, ISC, MPL-2.0): COMPATIBLE.** `@cline/sdk` would be a legal dependency; we still choose patterns-over-code. The closed-source JetBrains plugin is out of bounds entirely.

## Tech-Stack Table

| Layer | Technology (verified) |
|---|---|
| Language / tooling | TypeScript 5 throughout, ESM; Bun (lockfile, scripts), Biome lint/format, Vitest + Playwright, Husky, Changesets, Gitleaks |
| Monorepo | npm-style workspaces: `apps/*` (cli, cline-hub, examples, vscode, vscode-rollout) + `sdk/packages/*` + nested webviews |
| Agent engine | `@cline/shared` (types/schemas/hooks) → `@cline/llms` (provider gateway, model catalogs; AI SDK-backed) → `@cline/agents` (stateless loop, browser-compatible) → `@cline/core` (Node: sessions, tools, persistence, hub, cron) → hosts |
| VS Code host | Node extension host (`engines.vscode ^1.101.0`), esbuild bundle, `@grpc/grpc-js`, `chokidar` 4, PostHog + OpenTelemetry |
| Webview UI | React 18.3 + Vite + Tailwind + styled-components, mermaid, Storybook; `@cline/ui` shared web components |
| RPC contracts | Protobuf (`buf`): `proto/cline/*.proto` (17 webview-facing services), `proto/host/*.proto` (5 host-capability services); gRPC-style unary + streaming over VS Code `postMessage` |
| MCP | Official `@modelcontextprotocol/sdk ^1.25.1`; stdio / SSE / StreamableHTTP; OAuth manager; chokidar-watched `cline_mcp_settings.json`; per-server timeout; per-tool auto-approve |
| Storage | `~/.cline` home: per-task JSON (`ui_messages.json`, `api_conversation_history.json`, `task_metadata.json`, `settings.json`); in-memory `StateManager` with 500 ms debounced persistence; SQLite in SDK core (`tasks.db`, `cron.db`, connector store; sessions separate) |
| Checkpoints | Native git plumbing: stash-compatible `commit-tree` snapshots under private refs; restore transactions with commit/rollback |
| Providers | ~50 typed `ApiProvider` ids (Anthropic, OpenRouter default, OpenAI, Gemini, Bedrock, Vertex, Ollama, LM Studio, xAI, Groq, …) with per-model `ModelInfo` (context window, pricing tiers, capabilities, modalities) |

## Top Adoptable Patterns (one line each)

1. **Layered engine with one-way deps** (`shared → llms → agents(stateless) → core(stateful) → hosts`): the agent loop owns no storage; the core owns no UI/host concerns.
2. **Plan/Act as a tool-gated mode switch**: the model calls `switch_to_act_mode` only after explicit user approval; the run ends, the session is rebuilt with act-mode tools, and a synthetic continuation prompt drives execution.
3. **Tauri + sidecar with typed command/event transport and per-launch auth token**: `apps/examples/desktop-app` ships exactly our topology — Bun HTTP+WS sidecar, random `approvalToken` compared with `timingSafeEqual`, origin allowlist, tool approvals pushed over WS scoped to connection+session.

## What to Avoid (one line each)

- **Hub-daemon subsystem** (detached WebSocket daemon, discovery records, build fingerprints, multi-client attach/detach): complexity for a local-first single-user app with max 5 agents.
- **gRPC-over-postMessage toolchain**: buf/protoc/grpc-js in the UI path is heavy machinery; typed JSON schemas over our REST+WS achieve the same guarantees cheaper.
- **Permissive auto-approve defaults**: shipped defaults auto-approve file edits and *all* commands (`executeAllCommands: true`, `editFiles: true`) — invert for ACUTE-CODE's human-approval-first stance.
- **Scope sprawl** (cron/agenda, marketplace, remote-config, connectors, baked-in PostHog telemetry): enterprise/cloud features that conflict with a closed-source local-first v1.

## Relevance to ACUTE-CODE

Cline is the most architecturally isomorphic project in our study set. Its desktop example *is* our topology — a Tauri shell with a Bun sidecar backend serving a web UI over localhost HTTP+WS — and its SDK layering (`shared → llms → agents → core`) is the dependency discipline our sidecar should copy: a stateless agent loop, a stateful core owning SQLite persistence, thin host adapters. Every focus area transferred cleanly: Plan/Act implemented as a tool-gated mode switch with per-mode toolsets; MCP managed through one watched settings file with fingerprint-guarded reconciliation and per-tool auto-approve; a provider model of typed provider IDs plus a capability/pricing catalog isolated in one package; and an approval vocabulary (`yes`/`no`/free-text + per-tool policies) that matches our human-approval safety layer — with defaults we must invert. Apache-2.0 makes everything safe to study and even to depend on. The cautionary tale is accretion: a once-simple extension grew a hub daemon, cron scheduler, and enterprise remote-config around its core; ACUTE-CODE should keep the core loop small and push such extras out of v1 scope.

## Sources

- https://github.com/cline/cline (README, tree, stats)
- https://github.com/cline/cline/blob/main/LICENSE (stock Apache-2.0, © 2026 Cline Bot Inc.) + GitHub API `/contents/LICENSE`, `/commits?path=LICENSE`
- https://api.github.com/repos/cline/cline (metadata)
- https://github.com/cline/cline/tree/main, `/tree/main/apps/vscode`, `/tree/main/sdk`, recursive git tree
- https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md (layering, RuntimeHost, hub, design seams, constraints)
- https://github.com/cline/cline/blob/main/sdk/README.md (SDK positioning, quickstart)
- https://docs.cline.bot/cline-sdk/overview (package table, Node 22+)
- Raw: `package.json` (root), `apps/vscode/package.json`, `apps/vscode/webview-ui/package.json`, `sdk/packages/{sdk,core,shared,llms,agents}/package.json`
- Raw sources `apps/vscode/src/`: `hosts/host-provider.ts`, `core/controller/grpc-handler.ts`, `core/webview/WebviewProvider.ts`, `core/storage/StateManager.ts`, `core/storage/disk.ts`, `core/controller/checkpoints/checkpointRestore.ts`, `services/mcp/McpHub.ts`, `shared/api.ts`, `shared/AutoApprovalSettings.ts`, `shared/WebviewMessage.ts`, `shared/constants.ts`; `proto/cline/task.proto`, `proto/cline/common.proto`
- Raw: `apps/cli/src/runtime/interactive/mode.ts`, `approvals.ts`
- Raw: `sdk/packages/core/src/hooks/checkpoint-hooks.ts`, `session/checkpoint-restore.ts`, `runtime/tools/tool-approval.ts`
- Raw: `apps/examples/desktop-app/README.md`, `sidecar/server.ts`, `sidecar/commands.ts` (Tauri + Bun sidecar example)
