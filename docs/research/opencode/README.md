# OpenCode — Research Summary

**Target of study:** OpenCode, the open-source AI coding agent (terminal / desktop / IDE), by the team behind SST (now rebranded **Anomaly**).
**Research date:** 2026-08-21. All claims verified against the live repository and docs unless marked `[UNVERIFIED]`.

## Canonical repository — what we found

There are **two distinct projects named "opencode"**. This matters because the task's primary URL resolved to the wrong one:

| URL | What it actually is | Status |
|---|---|---|
| `github.com/opencode-ai/opencode` | A **different** project: Go-based CLI/TUI, MIT, 13.7k stars | **Archived Sep 18, 2025**; README says "Archived: Project has Moved" → `charmbracelet/crush`. Not our target. |
| `github.com/anomalyco/opencode` | The TypeScript OpenCode behind **opencode.ai** (formerly `sst/opencode`; org SST → Anomaly) | **Canonical.** ~200k stars, 25.8k forks, default branch `dev`, npm package `opencode-ai`. |

The focus hints (TUI client ↔ TypeScript server, local HTTP/WS API) match `anomalyco/opencode` only. Web search confirms the `sst/opencode → anomalyco/opencode` transfer (the repo page itself carries no rename notice; the SST heritage is visible only in root `sst.config.ts`).

## What it is

An open-source, local-first AI coding agent ("The open source coding agent") that runs as a **TypeScript server process exposing an OpenAPI-described local HTTP API with an SSE/WS event stream**, fronted by interchangeable clients: a terminal TUI, a desktop app (beta), IDE extensions (VS Code etc.), and a web console. Two built-in agents — `build` (full access) and `plan` (read-only) — switched with Tab. Multi-provider LLM support (75+ providers via Vercel AI SDK + the Models.dev catalog), MCP + LSP integration, plugin system in JS/TS, and an ask/allow/deny permission system for bash/edit/webfetch.

## License

**SPDX: MIT** — verified from `LICENSE` on branch `dev`: standard MIT text, `Copyright (c) 2025 opencode`. **Compatible** with ACUTE-CODE's allowed dependency set (MIT/Apache-2.0/BSD/ISC/MPL-2.0). Even so, our policy is patterns-only; no code copying regardless.

## Tech-stack table (verified from repo manifests and source)

| Layer | Technology |
|---|---|
| Language / runtime | TypeScript (ESM) on **Bun** (runtime, test runner, lockfile) |
| Monorepo | Turborepo (`turbo.json`), ~32 packages under `packages/` |
| Server | **Effect v4-beta HTTP stack** (`effect/unstable/http`, `@effect/platform-node`) — not Hono/Express; OpenAPI 3.1 generated via `OpenApi.fromApi` |
| Default endpoint | `http://127.0.0.1:4096` (port 0 → prefers 4096, then any free port); optional mDNS discovery; basic-auth via `OPENCODE_SERVER_PASSWORD` |
| Event transport | SSE (`GET /event`, first event `server.connected`; `GET /global/event`) per docs; `dev` source adds a `WebSocketTracker` — WS migration in progress |
| TUI client | TypeScript with **OpenTUI + SolidJS** (`@opencode-ai/tui`) — the old Go/bubbletea TUI is gone |
| Client SDK | `@opencode-ai/sdk`; the internal `@opencode-ai/client` is **code-generated** from the server's API spec (`@opencode-ai/httpapi-codegen` + `@opencode-ai/protocol`) |
| LLM access | Vercel **AI SDK** + **Models.dev** catalog; per-provider npm packages (e.g. `@ai-sdk/openai-compatible`) |
| Storage (legacy) | JSON file store: one pretty-printed JSON per entity under `<data>/storage` (`session/<projectID>/<sessionID>.json`, `message/…`, `part/…`), per-file reentrant locks, numbered migrations |
| Storage (current direction) | **SQLite via Drizzle ORM** — `storage/schema.ts` re-exports Drizzle tables from `@opencode-ai/core` (Session, Message, Part, Todo, Project, Account, SessionShare, Workspace); dedicated `effect-drizzle-sqlite` / `effect-sqlite-node` packages |
| Typechecking | `tsgo` (`@typescript/native-preview`) |
| Config | `opencode.json`/`jsonc` (global + project), merged not replaced; JSON schema at `https://opencode.ai/config.json` |

## Top adoptable patterns (one line each)

1. **Protocol-as-single-source-of-truth + codegen**: one typed protocol package drives server route validation, the OpenAPI spec, and the generated client SDK — eliminate client/server drift by construction.
2. **Ask/allow/deny permission config with regex/string filters, deny-overrides, and an approval round-trip over the API** (`POST /session/:id/permissions/:permissionID`) — exactly the shape of a human-approval safety layer.
3. **Composite model IDs + catalog-driven provider config** (`provider/model-id`, Models.dev metadata, `{env:VAR}`/`{file:path}` secret indirection) — clean multi-provider routing without hardcoding vendor knowledge.

## What to avoid (one line each)

- **Effect v4-beta "unstable" HTTP stack** — heavy FP abstraction and moving-target APIs; a plain Node router (Fastify/Express) is far cheaper to own for our sidecar.
- **One-JSON-file-per-entity storage** — OpenCode is itself migrating off it to SQLite; we should start with SQLite from day one.
- **Plugins that auto-install npm packages at startup and can override built-in tools by name** — supply-chain and safety risk; our closed-source workbench should ship vetted, built-in extension points instead.

## Relevance to ACUTE-CODE

OpenCode is the most architecturally congruent reference studied so far: a local TypeScript server owning sessions, agents, tool execution, and LLM routing behind a localhost REST + streaming-event API, with thin clients (TUI/desktop/IDE/web) that are pure API consumers. That is a 1:1 match for ACUTE-CODE's "Node/TS sidecar owning SQLite via localhost REST+WS, React UI inside Tauri" split — the transferable parts are the API shape (resource-oriented session/message endpoints plus a global event stream), the permission/approval round-trip for bash and edits, catalog-driven multi-provider routing, and the protocol-codegen discipline. The divergences are equally instructive: we avoid Bun (stay on plain Node for the sidecar), avoid Effect, use SQLite from the start, cap at 5 concurrent agents rather than unbounded sessions, and keep the plugin surface closed and vetted. License (MIT) poses no dependency risk. Verdict: **adopt the client/server split, API/event design, permission model, and provider-config format; skip the runtime, FP framework, and storage legacy.**

## Sources

- https://github.com/opencode-ai/opencode (archived Go project — verified NOT our target)
- https://github.com/anomalyco/opencode (canonical repo, README, tree, stats)
- https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE
- https://opencode.ai/ , https://opencode.ai/docs/
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/config/
- https://opencode.ai/docs/sdk/
- https://api.github.com/repos/anomalyco/opencode/contents/packages?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/opencode/src?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/opencode/src/storage?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/opencode/src/session?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/opencode/src/server?ref=dev
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/storage.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/schema.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/server.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/client/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/package.json
- https://news.ycombinator.com/item?id=44482504 (sst/opencode identity)
