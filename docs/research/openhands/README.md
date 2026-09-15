<!-- last-reviewed: 2026-09-12 round-98 -->
# OpenHands — Research Summary (for ACUTE-CODE)

Researched: 2026-08-21. Method: all claims verified against the live GitHub repos, raw manifests, and docs.openhands.dev unless marked [UNVERIFIED].

## What it is

OpenHands is an open-source (MIT) agentic software-engineing platform, ~84.7k stars. As of mid-2026 it has been restructured from a single monorepo into an ecosystem of focused repos:

| Repo | Role | Status |
|---|---|---|
| `OpenHands/OpenHands` (formerly `All-Hands-AI/OpenHands`) | **Agent Canvas** — the UI product: "self-hosted developer control center for coding agents and automations". Runs the OpenHands agent plus Claude Code, Codex, Gemini, or any ACP-compatible agent. | Active |
| `OpenHands/software-agent-sdk` | **Software Agent SDK** — Python + REST API for building agents (`openhands-sdk`, `openhands-tools`, `openhands-workspace`, `openhands-agent-server`). Source of truth for the agent runtime; underpins the OpenHands CLI and Cloud. Academic write-up: arXiv 2511.03690 (referenced in README; not independently fetched). | Active |
| `OpenHands/legacy` | Archived (2026-07-27) monorepo preserving the previous backend/server code. Classic controller/eventstream/runtime code has been removed from it; its architecture survives in docs. | Archived |
| `OpenHands/agent-canvas` | Archived stub; canvas code moved into `OpenHands/OpenHands`. [UNVERIFIED — not re-checked this pass] | Archived |
| `OpenHands/automation` | Automation Server: scheduled / event-driven agent runs. | Active (per docs component map) |
| Sandbox Server ("API and sandbox control plane") | Standalone sandbox hosting Agent Servers. | Active (per docs component map) |

## License (from LICENSE files)

- `OpenHands/OpenHands`: **MIT** — standard, unmodified text, "Copyright © 2025 OpenHands contributors". No exceptions, no Commons Clause.
- `OpenHands/software-agent-sdk`: **MIT** — standard text, "Copyright (c) 2026 OpenHands contributors".
- `OpenHands/legacy`: **MIT with a carve-out** — everything under `enterprise/` is governed by a separate `enterprise/LICENSE`; the rest is MIT. We have no reason to touch that archive.

**Compatibility verdict:** MIT is inside ACUTE-CODE's allowed dependency set (MIT/Apache-2.0/BSD/ISC/MPL-2.0). No GPL/AGPL/LGPL encountered anywhere consulted. Nothing in this research proposes copying code — patterns only — so no contamination risk.

## Tech stack (verified from package.json / pyproject.toml / docs)

| Layer | Technology |
|---|---|
| Canvas UI | React 19, React Router 7 (framework mode), Vite 8, Tailwind 4, Zustand 5, TanStack Query 5, Monaco, xterm, socket.io-client 4.8, axios; TypeScript 6; Electron 42 for desktop; Node >= 22.12 |
| Agent SDK (Python) | Python >= 3.12, Pydantic 2 (immutable typed models), provider-agnostic LLM wrapper |
| Agent Server | FastAPI >= 0.104 + uvicorn, websockets >= 12, Pydantic 2; server settings/secrets persisted as **flat locked JSON files** (`settings.json`, `secrets.json`, `workspaces.json`; atomic temp-rename writes + `fcntl`/`msvcrt` locking + optional cipher) — no SQL database anywhere; OpenAI-compatible gateway (optional) |
| Sandboxes | Docker / Kubernetes / remote API workspaces (opt-in) |
| Tests | Vitest, Playwright, Stryker (canvas); pytest + pre-commit (SDK) |

## Top adoptable patterns (one line each)

1. **Headless Agent Server**: the agent runtime is a standalone REST + WebSocket service (`openhands-agent-server`, FastAPI) that any client — CLI, browser UI, automations — drives over `POST /conversations`, `POST /conversations/{id}/run|pause`, `POST /conversations/{id}/events/respond_to_confirmation`, and `WS /sockets/events/{conversation_id}` (with cursor-based replay via `resend_mode=since&after_timestamp`) without embedding agent code.
2. **Event-sourced sessions**: each conversation is an append-only log of typed immutable events plus one separately-persisted mutable state snapshot, enabling deterministic replay, resume, UI-as-observer, and read-only auxiliary services (persistence, stuck-detection, security).
3. **Opt-in isolation at the workspace boundary**: agent code is identical across Local/Docker/Remote workspaces; sandboxing is a deployment choice behind a narrow interface — their own V1 design lesson ("sandboxing should be opt-in, not universal") directly validates ACUTE-CODE's no-sandbox v1.

## What to avoid (one line each)

- **One JSON file per event on disk** (`events/event-00000-*.json`) — we own SQLite; a WAL-mode append-only table beats thousands of tiny files on Windows.
- **Secrets persisted inside conversation state** — they must encrypt state at rest (`OH_SECRET_KEY`); we should keep credentials in the OS keychain, never in our DB.
- **Letting applications share code with the agent core** — their documented V0 failure mode (CLI/web UI polluted the core with conditionals); keep the Tauri UI strictly behind the sidecar API.
- **Blocking-only delegation** — their `TaskToolSet` sub-agents are strictly synchronous/sequential; insufficient for our up-to-5 concurrent agents with a human-approval gate.
- **The legacy `enterprise/` carve-out and archived monorepo** — stale, split-licensed; study the current SDK repo instead.

## Relevance to ACUTE-CODE

OpenHands is the closest architectural cousin we have studied: a UI client (Canvas: React + WebSocket) talking to a headless agent service (Agent Server: REST for control, WebSocket for streaming) that persists event-sourced conversations as append-only per-event files plus one state snapshot behind an orchestrator that owns state, with the reasoning agent, tools, and execution environment cleanly separated — the same shape as our Tauri shell + Node sidecar + SQLite design, and MIT-licensed with no copyleft exposure. Three specific findings raise our confidence: (a) their V0→V1 redesign explicitly concluded that sandboxing must be opt-in and applications must talk to agents via APIs rather than embedding them — precisely our v1 decisions; (b) their event schema carries per-action security-risk fields and a `UserRejectObservation` type for confirmation mode, a proven precedent for our human-approval layer; (c) their delegation model (typed sub-agent registry + resumable sub-conversations returning structured `TaskObservation`s) is a blueprint for our 5-agent delegation, needing only an async/approval-aware extension. We should adopt the patterns and none of the code.

## Sources

- https://github.com/All-Hands-AI/OpenHands (redirects to OpenHands/OpenHands)
- https://raw.githubusercontent.com/All-Hands-AI/OpenHands/main/LICENSE
- https://raw.githubusercontent.com/OpenHands/OpenHands/main/package.json
- https://github.com/OpenHands/software-agent-sdk
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/LICENSE
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/pyproject.toml
- https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-agent-server/openhands/agent_server
- https://docs.openhands.dev/
- https://docs.openhands.dev/llms.txt
- https://docs.openhands.dev/sdk
- https://docs.openhands.dev/sdk/arch/overview.md
- https://docs.openhands.dev/sdk/arch/design.md
- https://docs.openhands.dev/openhands/usage/architecture/backend
- https://github.com/OpenHands/legacy
- https://raw.githubusercontent.com/OpenHands/legacy/main/LICENSE
- https://github.com/OpenHands/agent-canvas
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/conversation_router.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/event_router.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/sockets.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/persistence/store.py
- https://api.github.com/repos/OpenHands/software-agent-sdk/contents/openhands-agent-server/openhands/agent_server (directory listing)
- https://api.github.com/repos/OpenHands/automation (repo metadata: MIT, active)
- https://docs.openhands.dev/sdk/arch/design.md
- https://docs.openhands.dev/sdk/arch/security.md
- https://docs.openhands.dev/sdk/guides/task-tool-set.md
- https://www.openhands.dev/blog/the-path-to-openhands-v1
