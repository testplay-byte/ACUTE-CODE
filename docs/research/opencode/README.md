<!-- last-reviewed: 2026-09-19 round-108 -->
# OpenCode — Research Summary

*Researched 2026-08-21 against the live repository and docs. Every claim below was verified by fetching the repo/docs unless marked [UNVERIFIED].*

## Canonical repository — what we found

There are **two distinct projects named "opencode"**; the task's primary URL is the wrong one today:

| URL | What it actually is | Status (verified) |
|---|---|---|
| `github.com/opencode-ai/opencode` | Legacy **Go** TUI/CLI agent ("A powerful AI coding agent. Built for the terminal."), 13.7k stars | **Archived** (last push 2025-09-18). Its GitHub page now displays the *current* OpenCode's marketing README (npm `opencode-ai`, opencode.ai), so it acts as a landing page. Not the source. |
| `github.com/anomalyco/opencode` | Current **TypeScript** OpenCode behind **opencode.ai** — "The open source coding agent.", ~200k stars, MIT, default branch `dev` | **Canonical.** npm package `opencode-ai` (v1.18.21). |

- Verified via GitHub API: `api.github.com/repos/sst/opencode` returns `full_name: "anomalyco/opencode"` — the repo was **transferred from SST to anomalyco**; old `sst/opencode` links still resolve.
- The FOCUS hints (TUI client ↔ TypeScript server, local HTTP API, multi-provider routing) match `anomalyco/opencode` only.

## What it is

An open-source, local-first AI coding agent built for the terminal. Running `opencode` starts a **local HTTP server** (default `127.0.0.1:4096`) **plus a TUI client** that talks to that server over the API; `opencode serve` runs the server headless. The same server serves a web client (`opencode web`), an Electron desktop app (beta), IDE plugins, and generated SDKs. Feature set: 75+ LLM providers (Vercel AI SDK + models.dev catalog), MCP and LSP integration, hook-based JS/TS plugins, markdown-defined agents (primary `build`/`plan` + subagents `general`/`explore`/`scout`), sessions with fork/revert/share/summarize, and an allow/ask/deny permission system covering bash, edit, webfetch, websearch, subagent dispatch, and more.

## License (verified from the LICENSE file)

- **SPDX: MIT** — `LICENSE` at root of `anomalyco/opencode@dev`: standard MIT text, `Copyright (c) 2025 opencode`.
- npm `opencode-ai@1.18.21` also declares `license: MIT`.
- **Verdict: compatible** with ACUTE-CODE's allow-list (MIT / Apache-2.0 / BSD / ISC / MPL-2.0). No GPL-family license anywhere we inspected. Constraint honored regardless: patterns only, no code copying.

## Tech-stack table (verified from manifests / source / docs)

| Layer | Technology | Evidence |
|---|---|---|
| Monorepo | Bun workspaces (`bun@1.3.14`) + Turborepo, `catalog:` versioning, oxlint, husky | root `package.json` |
| Runtime | Bun-first (`bun:sqlite`, Bun shell `$` in plugins); Node fallbacks (`sqlite.node.ts`, `db.node.ts` in CLI pkg) | `packages/core/src/database/`, `packages/opencode` |
| Domain core | `@opencode-ai/core` — Effect services: `session/`, `permission/`, `tool/`, `database/`, `event/`, `plugin/`, `project/`, `pty/`, `skill/`, `share/`, `oauth/`, `credential/`, … (29 dirs + 53 root modules) | `packages/core/src` listing |
| HTTP server | `@opencode-ai/server` — **Effect Http** (`effect/unstable/http`, `HttpApiBuilder`); OpenAPI 3.1 auto-served at `GET /doc` (`openapiPath: "/openapi.json"`); optional HTTP Basic auth (`OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`), CORS flags | `packages/server/src/routes.ts`, docs/server |
| Endpoint defaults | `127.0.0.1:4096`; `--hostname/--port/--cors/--mdns` flags | docs/server |
| Event transport | **SSE**: `GET /event` (first event `server.connected`), `GET /global/event`. No WS endpoints documented. A `ws` dependency exists in the CLI package — purpose [UNVERIFIED] (plausibly PTY/IDE relay) | docs/server, plugins docs, `packages/opencode/package.json` |
| TUI client | `@opencode-ai/tui` — TypeScript + **Solid.js rendered via OpenTUI** (`@opentui/solid`, `@opentui/core`); not Go, not React/Ink | `packages/tui/package.json` |
| Desktop client | `@opencode-ai/desktop` — **Electron 42** + SolidJS + `@lydell/node-pty` (not Tauri) | `packages/desktop/package.json` |
| Web | `opencode web` (SolidJS app; `packages/app`, `packages/web`) | root scripts, docs |
| LLM routing | Vercel **AI SDK** ecosystem: ~20 `@ai-sdk/*` packages (openai, anthropic, google, bedrock, azure, groq, xai, openai-compatible, …) + OpenRouter/GitLab/Venice providers; **models.dev** catalog supplies context/output limits | `packages/core/package.json`, docs/providers |
| Storage | **SQLite via Drizzle ORM**, Effect-wrapped: `opencode.db` under `~/.local/share/opencode/`, pragmas WAL / synchronous=NORMAL / busy_timeout=5000 / foreign_keys=ON, generated migrations; per-channel DB names (`opencode-<channel>.db`) for non-prod channels | `packages/core/src/database/database.ts` |
| Credentials | `~/.local/share/opencode/auth.json`; `/connect` flows: API keys, OAuth (device-code, browser), env-var keys | docs/providers |
| Config | `opencode.json` (project) / `~/.config/opencode/opencode.jsonc` (global, JSONC), `$schema: https://opencode.ai/config.json`; XDG paths via `xdg-basedir` | docs/providers, core deps |
| Plugins | JS/TS in `.opencode/plugins/` + global dir + npm packages (auto-installed with Bun to `~/.cache/opencode/node_modules/`); hooks: `tool.execute.before/after`, `event`, `shell.env`, `tool`, compaction hooks | docs/plugins |
| Agents | JSON in `opencode.json` or **markdown + YAML frontmatter** in `.opencode/agent(s)/`; `permission.task` globs gate subagent dispatch | docs/agents |
| Protocols | MCP (`@modelcontextprotocol/sdk`), ACP (`@agentclientprotocol/sdk`), tree-sitter (bash + powershell grammars) | `packages/opencode/package.json` |
| Windows | Runs natively but docs **strongly recommend WSL** | docs/windows-wsl |

## Top adoptable patterns (one line each)

1. **OpenAPI-contract-first local server** — declare the localhost API once; serve the spec at `/doc` and *generate* every client SDK from it, so TUI/web/desktop/IDE/plugins can never drift from the server.
2. **`allow`/`ask`/`deny` permission grammar** — per-tool rules with glob granularity (last match wins), merged with per-agent overrides, resolved via REST (`POST /session/:id/permissions/:id`) with once/always/reject + suggested safe pattern — a complete minimal human-approval layer.
3. **Session as first-class resource** — list/create/patch/delete plus `/fork`, `/revert`/`/unrevert`, `/children` (subagent child sessions), `/share`, `/summarize` on one resource.
4. **Provider = config record naming an npm AI-SDK package** — `provider.<id>.npm` + `options.baseURL/apiKey` (`{env:VAR}`, `{file:path}` substitution) + a `models` map, enriched from models.dev.

## What to avoid (one line each)

- **Effect as the core framework** — deep Effect (incl. `effect/unstable/*`) everywhere; steep, churn-prone, unnecessary for our sidecar.
- **Default-allow permissions** — most tools default to "allow" (only `doom_loop`, `external_directory` ask); the inverse of our human-approval-first mandate.
- **Bun-only assumptions** — `bun:sqlite`, Bun shell in plugin API, Bun npm auto-install at startup bind us to one runtime and add supply-chain risk.
- **In-process plugins with shell access** — plugins get `$` (shell) + SDK client inside the server, unsandboxed; wrong threat model for a closed-source workbench.
- **Electron desktop / WSL-first Windows** — we are Tauri + native Windows; their choices are anti-patterns for us.

## Relevance to ACUTE-CODE

OpenCode is the closest architectural cousin among the agents studied: a TypeScript local server owning SQLite behind a loopback REST API + event stream, with thin clients (TUI, web, desktop) as pure API consumers — exactly ACUTE-CODE's Tauri-shell ↔ Node-sidecar topology. It also nails three of our hardest problems with clean shapes: multi-provider routing (AI-SDK package + config + models.dev catalog), human approvals (the allow/ask/deny permission system with programmatic resolution endpoints), and multi-agent (markdown agents with `permission.task` gating subagent dispatch, child sessions). The divergences are equally useful: OpenCode optimizes for openness and developer extensibility (in-process plugins, default-allow, Bun, Electron), while ACUTE-CODE needs a locked-down, closed-source, approval-first product on native Windows. Adopt the contract shapes (OpenAPI-first server, event bus with handshake, permission grammar, session model, provider config format); reject the trust defaults and runtime bets. MIT license keeps all of it safely referenceable.

## Sources

- https://github.com/opencode-ai/opencode (legacy landing page)
- https://api.github.com/repos/opencode-ai/opencode (archived Go repo metadata)
- https://api.github.com/repos/sst/opencode (resolves to anomalyco/opencode)
- https://api.github.com/repos/anomalyco/opencode (canonical metadata)
- https://registry.npmjs.org/opencode-ai/latest
- https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE
- https://raw.githubusercontent.com/anomalyco/opencode/dev/package.json
- https://api.github.com/repos/anomalyco/opencode/contents/packages?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/tui?ref=dev
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/package.json
- https://api.github.com/repos/anomalyco/opencode/contents/packages/core/src?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/core/src/session?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/core/src/database?ref=dev
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/database/database.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/server/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/server/src/routes.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/desktop/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/package.json
- https://opencode.ai/docs/ (index)
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/windows-wsl
