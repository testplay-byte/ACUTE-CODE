# Cline — Research Summary (ACUTE-CODE Reference Study)

- **Target:** https://github.com/cline/cline (canonical; not moved)
- **Studied:** 2026-08-21, `main` branch (monorepo mid-migration; see notes)
- **Scale at time of study:** ~66.6k stars, ~7.2k forks

## What It Is

Cline is an open-source autonomous coding agent that ships in multiple forms on top of one shared
agent core: a VS Code extension (the original and primary product), a CLI (`npm i -g cline`,
including headless JSON output for CI/CD), a web-based Kanban task board for parallel agents
(separate repo `cline/kanban`), a closed-source JetBrains plugin ("Currently we are not
open-sourcing JetBrains plugins" — it is a client that "talks to the shared agent core"), and a
published TypeScript SDK (`@cline/sdk`) that packages "the same engine" as an embeddable library.
The agent reads/writes files across a whole project, runs terminal commands (including monitoring
long-running dev servers), drives a browser, connects to MCP servers, and takes git-based
checkpoints after every tool use. The repo is currently migrating from "extension code at repo
root" to a Bun-workspace monorepo (`apps/vscode`, `apps/cli`, `apps/cline-hub`, `sdk/packages/*`);
the README marks the VS Code location as "/ (WIP migrating)" but `apps/vscode` already exists and
is where the extension source lives.

## License

**SPDX: Apache-2.0** — verified directly from the LICENSE file ("Apache License, Version 2.0,
January 2004", copyright Cline Bot Inc.). Plain Apache-2.0: commercial use permitted, derivative
works permitted with notice retention; Section 6 does **not** grant trademark rights, so any
derivative must not use the "Cline" name/branding.

**Compatibility with ACUTE-CODE's allowed set (MIT, Apache-2.0, BSD, ISC, MPL-2.0): compatible.**
Apache-2.0 is on our allow-list both for pattern study and, if ever needed, as a dependency.
(Study-only rule still applies: we learn patterns, we do not copy code.) The JetBrains plugin is
closed source and out of bounds entirely.

## Tech-Stack Table

| Layer | Technology (verified) |
|---|---|
| Language | TypeScript throughout ("type": "module") |
| Repo/build | Bun workspace (`bun@1.3.13` pinned, Node >= 22), Biome lint/format, Vitest, Husky + lint-staged, changesets |
| Monorepo | `apps/` (cli, cline-hub, examples, vscode, vscode-rollout) + `sdk/packages/` (shared, llms, agents, core, sdk, ui) |
| SDK packages | `@cline/sdk` (umbrella) → `@cline/core` (sessions, storage, RPC) → `@cline/agents` (stateless loop) → `@cline/llms` (provider gateway) → `@cline/shared` (types, zod schemas, hooks engine) |
| Extension UI | React 18.3 + Vite + Tailwind v4 + Radix/shadcn-style components, react-virtuoso, react-markdown + remark-gfm + rehype-highlight, mermaid, DOMPurify, framer-motion, Storybook |
| RPC (webview↔host) | gRPC-style "protobus" over VS Code postMessage: unary + streaming + cancellation, codegen'd service handler maps, record/replay middleware |
| Daemon (SDK) | Hub-spoke: singleton hub daemon on `127.0.0.1:25463`, WebSocket clients, worker "spokes" running `@cline/core`; lock-file discovery `~/.cline/locks/hub/owners/` |
| Storage | File-backed settings stores + debounced batched persistence (StateManager); SDK sessions: SQLite index + JSON snapshots under `~/.cline/data/sessions/`; shadow-git checkpoints |
| MCP | Official MCP SDK clients; stdio / SSE / streamable-HTTP transports; zod-validated JSON config; OAuth manager; chokidar settings watcher |
| Providers | Anthropic, OpenAI, Google, Bedrock, OpenRouter, Vertex, Azure, Cerebras/Groq, Ollama/LM Studio, any OpenAI-compatible endpoint; 30+ documented configs |
| AI plumbing | Provider gateway in `@cline/llms`; model-family-optimized planning prompts; patched dep `ollama-ai-provider-v2` [patch noted in root package.json] |

## Top Adoptable Patterns

1. **Layered agent SDK with one-way dependencies** (`shared → llms → agents → core → hosts`):
   one stateless loop, one stateful orchestrator, one provider gateway — each independently
   testable and reusable across hosts.
2. **Hub-spoke local daemon**: coordination-only hub on loopback with WebSocket
   client routing, worker processes owned by the daemon, SQLite index + JSON snapshots — sessions
   survive client restarts and a runaway agent cannot freeze the UI.
3. **Typed RPC over the UI transport ("protobus")**: request-id correlation, streaming with
   sequence numbers, cancellation registry, and record/replay middleware — a rigorous upgrade to
   ad-hoc postMessage/WebSocket message handling.

## What to Avoid (one line each)

- **Shadow-git checkpoint after every tool use**: Cline's own docs warn it "may use significant
  storage and slow down Cline" on big projects.
- **Permissive auto-approve defaults** (e.g. legacy `executeAllCommands: true`): the model-judged
  `requires_approval` flag as primary safety gate is non-deterministic and conflicts with
  ACUTE-CODE's human-approval-first layer.
- **Monorepo sprawl**: cron schedulers, messaging connectors, marketplace, enterprise remote
  config, patched/vendored dependencies — scope and maintenance burden far beyond ACUTE-CODE v1.

## Relevance to ACUTE-CODE

Cline is the single most architecturally relevant reference in our study set. Its SDK hub-spoke
model is nearly isomorphic to ACUTE-CODE's planned shape: a Tauri 2 UI (Cline: React 18 webview;
ours: React 18/TS) talking over a localhost channel (Cline: WebSocket to a loopback daemon;
ours: REST+WS to a Node sidecar) to a process that owns SQLite and runs agent workers (Cline:
spokes running `@cline/core`; ours: the sidecar running max-5 concurrent agents). Cline's own SDK
examples reportedly include "a Tauri desktop app with a Bun sidecar backend" and a VS Code
extension running sessions over RPC, which validates the exact process topology we chose. Beyond
topology, its Plan/Act mode split, category-based auto-approve UX with per-command "Always
approve", MCP hub with fingerprint-guarded reconcile loops, and compaction strategy (canonical
transcript + separate compaction artifact with hash validation) all map directly onto features in
our scope. The license (Apache-2.0) is compatible with our dependency policy, and the parts that
are off-limits (closed-source JetBrains plugin) or off-scope (cron, marketplace, enterprise
config) are cleanly separable. Verdict: **primary reference for sidecar architecture, approval
UX, and MCP integration; treat its storage defaults and permissive auto-approve stance as
anti-patterns for us.**

## Sources

- https://github.com/cline/cline (repo README, stars/forks, feature claims)
- https://github.com/cline/cline/blob/main/LICENSE
- https://github.com/cline/cline/blob/main/package.json (monorepo root manifest)
- https://github.com/cline/cline/blob/main/sdk/README.md (packages, Agent/createTool, ClineCore, examples)
- https://raw.githubusercontent.com/cline/cline/main/sdk/ARCHITECTURE.md (layering rules, seams, compaction, agenda, cron)
- https://github.com/cline/cline/blob/main/docs/cline-overview.mdx (forms, shared core)
- https://github.com/cline/cline/blob/main/docs/core-workflows/plan-and-act.mdx
- https://github.com/cline/cline/blob/main/docs/core-workflows/checkpoints.mdx
- https://github.com/cline/cline/blob/main/docs/core-workflows/task-management.mdx
- https://github.com/cline/cline/blob/main/docs/features/auto-approve.mdx (raw fetch)
- https://github.com/cline/cline/blob/main/docs/features/subagents.mdx
- https://github.com/cline/cline/blob/main/docs/sdk/tools.mdx (toolPolicies)
- https://github.com/cline/cline/blob/main/docs/sdk/architecture/hub-spoke.mdx
- https://api.github.com/repos/cline/cline/contents/apps/vscode/src (and subpaths: core, core/controller, core/controller/task, core/controller/checkpoints, core/storage, services, services/mcp, integrations, shared, hosts)
- https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/package.json
- https://github.com/cline/cline/blob/main/apps/vscode/src/services/mcp/McpHub.ts
- https://github.com/cline/cline/blob/main/apps/vscode/src/core/storage/StateManager.ts
- https://github.com/cline/cline/blob/main/apps/vscode/src/core/controller/grpc-handler.ts
- https://github.com/cline/cline/blob/main/apps/vscode/src/shared/AutoApprovalSettings.ts
- https://api.github.com/repos/cline/cline/contents/{apps, sdk, sdk/packages, sdk/packages/core, sdk/packages/core/src, sdk/packages/core/src/session, sdk/packages/core/src/session/stores, sdk/examples, docs, docs/core-workflows, docs/features, docs/provider-config, docs/sdk, docs/sdk/architecture, docs/mcp}
