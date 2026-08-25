<!-- last-reviewed: 2026-08-25 round-35 -->
# Goose (Block / AAIF) — Research Summary

**Target:** https://github.com/block/goose (repo now presented as `aaif-goose/goose` — project governance moved to the Agentic AI Foundation under the Linux Foundation; the `block/goose` URL still resolves)
**Researched:** 2026-08-21, `main` branch. All claims verified against the repository this date unless marked [UNVERIFIED].

## What it is

Goose is an open-source, extensible, general-purpose AI agent that runs locally on the user's machine. Per the README it is "your native open source AI agent — desktop app, CLI, and API", "Built in Rust for performance and portability", usable beyond coding (research, writing, automation, data analysis). It ships three delivery surfaces over a shared Rust core:

- **Desktop app** (Electron + React) for macOS, Linux, Windows
- **CLI** (`goose`, incl. a TUI) 
- **API / server** (`goose serve`) — the same agent runtime the desktop spawns, also deployable remotely

Tool capability is MCP-first: "Connect to 70+ extensions via the Model Context Protocol open standard." It supports 40+ LLM providers (Anthropic, OpenAI, Google, Ollama, OpenRouter, Azure, Bedrock, Groq, xAI, Snowflake, and OpenAI-compatible gateways), plus "CLI providers" and "ACP providers" (it can delegate the whole agent loop to external agents such as Claude Code or Codex via the Agent Client Protocol).

## License

- **SPDX: Apache-2.0** — verified from the raw `LICENSE` file: unmodified Apache License 2.0, "Copyright 2024 Block, Inc." No dual-licensing, no exceptions. `Cargo.toml` (`license = "Apache-2.0"`) and `ui/desktop/package.json` agree.
- **Compatibility verdict: COMPATIBLE** with ACUTE-CODE's allowed dependency set (MIT, Apache-2.0, BSD, ISC, MPL-2.0). Note Apache-2.0 §6 excludes trademark rights — the "goose" name/logo may not be reused. We study patterns only; no code copying (project policy regardless of license).

## Tech stack (verified from manifests)

| Layer | Technology |
|---|---|
| Agent core | Rust (edition 2021), Cargo workspace `crates/*` (workspace version 1.26.0 at time of research) |
| Key crates | `goose` (agent, session, permission, config), `goose-cli`, `goose-mcp` (builtin MCP servers), `goose-providers` / `goose-provider-types`, `goose-agent`, `goose-context-management`, `goose-sdk`, `goose-acp-macros` |
| Agent runtime process | `goose serve` ("goosed") — HTTP(S) server, ACP endpoint at `/acp`, `/status`, `/health`, secret-key auth, optional self-signed TLS + SHA-256 fingerprint pinning |
| Desktop shell | Electron 43.4.0, Electron Forge 7, Vite 8 |
| Desktop UI | React 19, TypeScript ~5.9, Radix Themes 3, Tailwind CSS 4, framer-motion, react-intl |
| UI-side protocols | `@agentclientprotocol/sdk` 1.3 (ACP), `@mcp-ui/client`, `@modelcontextprotocol/ext-apps` |
| UI monorepo | pnpm workspace: `ui/desktop`, `ui/sdk`, `ui/goose-binary`, `ui/text` |
| Sessions | SQLite via sqlx (WAL mode) at `~/.local/share/goose/sessions/sessions.db` (schema v16; legacy `.jsonl` retained but unmigrated) |
| Config | `~/.config/goose/config.yaml` (YAML); API keys in OS keychain or `secrets.yaml`; tool-permission grants in `permissions/tool_permissions.json` |
| Testing | vitest + Testing Library + Playwright (UI); tokio tests, wiremock (Rust) |

## Top adoptable patterns (details in `patterns-for-acute-code.md`)

1. **UI-process ↔ agent-runtime split with lease lifecycle** — Electron spawns `goose serve --platform desktop --host 127.0.0.1 --port <random>` as a child process, passes a secret via env, polls `/status` for readiness, and refcounts windows per backend lease; last window out tears the backend down. Direct analog to our Tauri shell + Node sidecar.
2. **Layered permission model** — four global modes (auto / approve / smart_approve / chat) + per-tool tri-state overrides (Always Allow / Ask Before / Never Allow) + a remembered-decision store keyed by `tool_name:blake3(args)` with expiry and atomic writes.
3. **MCP-first extension registry in declarative config** — extensions declared as typed YAML entries (stdio / streamable-http / builtin / platform / frontend / inline-python), each contributing tools *and* prompt instructions; dynamic mid-session enable requires explicit user approval.

## What to avoid

- **Autonomous-by-default**: goose "operates autonomously by default" (full file modification without approval). Contradicts ACUTE-CODE's human-approval safety layer — default must be ask/approve.
- **Fail-open security gate**: the OSV malicious-package check fails open on network/HTTP/JSON errors ("OSV HTTP error; failing open."). For our safety posture, safety checks should fail closed or degrade to a mandatory user prompt.
- **Config/storage sprawl**: config.yaml + secrets.yaml + tool_permissions.json + sessions.db + legacy .jsonl + custom_providers/*.json. Consolidate into SQLite + one secrets store.
- **No subagent concurrency cap**: `subagent_handler.rs` has no semaphore/queue — only `max_turns`. We need a hard cap (5) enforced in the runtime, not just a prompt hint.
- **Deprecated transports kept for compatibility**: `Sse` variant retained "only for config file compatibility" with tools permanently unavailable — dead weight we should not replicate.

## Relevance to ACUTE-CODE

Goose is the single most directly comparable open project to ACUTE-CODE's architecture: a UI process (Electron/React) owning presentation, and a separate agent-runtime process (`goose serve`) owning the LLM loop, tools, sessions, and provider secrets, talking over localhost HTTP+WS with token auth — the same shape as our Tauri shell + Node/TS sidecar over localhost REST+WS with SQLite. Goose's answers to exactly our problem set — backend readiness/health polling, per-window backend leases, process cleanup escalation (SIGTERM → SIGKILL, `taskkill /f /t` on Windows), SQLite session ledger with monotonic ordering and fork-by-copy, layered permission modes with argument-hashed remembered grants, MCP extension declarations with per-extension timeouts and env-var passthrough — are all battle-tested and independently verifiable in the repo. We should adopt the lifecycle and permission patterns wholesale (as patterns, reimplemented in Node/TS), adopt the SQLite session design almost verbatim conceptually, and deliberately diverge on defaults (approval-first, fail-closed, hard concurrency cap of 5). Apache-2.0 licensing keeps any future dependency option open, though nothing needs to be depended on.

## Sources

- https://github.com/block/goose
- https://raw.githubusercontent.com/block/goose/main/README.md
- https://raw.githubusercontent.com/block/goose/main/LICENSE
- https://raw.githubusercontent.com/block/goose/main/Cargo.toml
- https://api.github.com/repos/block/goose/contents/ (and subpaths: `crates`, `crates/goose/src`, `crates/goose/src/{session,permission,agents,gateway,bin}`, `crates/goose-mcp/src`, `crates/goose-cli/src/commands`, `crates/goose-providers/src`, `documentation/docs`, `ui`, `ui/desktop/src`)
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/package.json
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/src/gooseServe.ts
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/src/gooseServeLeaseRegistry.ts
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/goose-architecture/goose-architecture.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/goose-architecture/extensions-design.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/getting-started/using-extensions.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/getting-started/providers.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/remote-goose-server.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/sessions/session-management.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/managing-tools/goose-permissions.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/managing-tools/tool-permissions.md
