<!-- last-reviewed: 2026-08-25 round-36 -->
# Hermes Agent (Nous Research) — Research Summary

**Target:** ACUTE-CODE reference-project analysis
**Date:** 2026-08-21
**Canonical repo:** https://github.com/NousResearch/hermes-agent (verified; tagline: "The agent that grows with you" / "The self-improving AI agent built by Nous Research")

## What it is

Hermes Agent is Nous Research's open-source, self-hosted, CLI-first AI agent framework (released February 2026, `v0.20.x`). Its distinguishing claim is a **built-in learning loop**: the agent curates its own persistent memory (`MEMORY.md` / `USER.md`), writes reusable **skills** from experience (SKILL.md files it authors itself), improves those skills during use, and runs persistently across sessions — reachable via 25+ messaging-platform gateways (Telegram, Discord, Slack, WhatsApp, Signal, and more) plus a full terminal TUI. It is model-agnostic (Nous Portal, OpenRouter, OpenAI, Anthropic, custom endpoints) and execution-backend-agnostic (local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox). A cron scheduler, subagent delegation, MCP client/server support, and trajectory export for RL training round out the platform.

## License

**SPDX: `MIT`** — verified directly from `LICENSE` at repo root: "MIT License / Copyright (c) 2025 Nous Research".
**Compatibility: fully compatible** with ACUTE-CODE's allowed dependency set (MIT, Apache-2.0, BSD, ISC, MPL-2.0). No GPL-family code in the core. One git submodule (`tinker-atropos`, RL training) exists; its license is [UNVERIFIED] but it is irrelevant to us — we study patterns only, copy nothing.

## Tech stack (verified from `pyproject.toml`, source tree, docs)

| Layer | Technology |
|---|---|
| Language | Python >=3.11,<3.14 (installed via Astral `uv`) |
| Runtime entry points | `run_agent.py` (AIAgent core + loop, ~560 KB), `cli.py` (~447 KB), `gateway/run.py`, `acp_adapter/` (VS Code/Zed/JetBrains), `batch_runner.py` |
| Storage | SQLite, single file `~/.hermes/hermes.db`, WAL mode, single-writer queue, FTS5 full-text index (`hermes_state.py`, `hermes_state_schema.py`) |
| Memory | Markdown files `~/.hermes/memories/MEMORY.md` + `USER.md` + SQLite mirror (`memories`, `memories_fts` tables) |
| Skills | File-based SKILL.md folders (`~/.hermes/skills/`, `.hermes/skills/`), agentskills.io standard, SQLite index (`skills`, `skills_fts`) |
| UI | Terminal TUI (`prompt_toolkit` + `rich`), slash commands, streaming tool output |
| Gateway/servers | FastAPI, uvicorn, websockets |
| LLM access | `openai` SDK + `httpx`; 3 API modes (chat_completions, codex_responses, anthropic); 18+ providers, OAuth, credential pools |
| Other deps | pydantic, croniter, psutil, Pillow; Node.js, ripgrep, ffmpeg as side dependencies |
| Tools | 70+ tools in 28 toolsets, static registry (`tools/registry.py`) with AST auto-discovery |
| Scale | ~25,000 tests across ~1,250 files |

## Top adoptable patterns (details in `patterns-for-acute-code.md`)

1. **Two-tier markdown memory with frozen-snapshot injection** — bounded `MEMORY.md`/`USER.md` stores are injected into the system prompt once per session as an immutable snapshot; mid-session writes update disk + SQLite mirror immediately but never mutate the live prompt, preserving provider prefix-cache and protecting against memory-prompt-injection mid-turn.
2. **Self-authored skills as procedural memory** — the agent converts repeated/complex task trajectories into SKILL.md files (frontmatter: name, description, when_to_use, pattern, tags), auto-registered as slash commands, security-scanned on write (trust tiers + 100+ threat regexes + structural limits), and self-improved during use.
3. **Tiered command approval with a non-bypassable floor** — hardline patterns (disk wipe, fork bombs, etc.) can never be bypassed even in "YOLO" mode; user deny rules outrank bypass switches; approval routing is context-aware (interactive panel vs async pending vs cron auto-deny).

## What to avoid (one line each)

- **Monolithic core files** — `run_agent.py` (~560 KB) and `cli.py` (~447 KB) concentrate the loop, prompting, and dispatch in single files; ACUTE-CODE's Node sidecar should stay modular per concern.
- **Python-stack lock-in** — every mechanism here is idiomatic Python; port the *patterns*, not the code, to our Tauri + TypeScript sidecar.
- **Regex-only security scanning as sole gate** — Hermes itself acknowledges this by fail-closed parsing and trust tiers; for ACUTE-CODE make the human-approval layer primary, heuristics secondary.
- **10-subagent default concurrency** — Hermes defaults to 10 concurrent children with warnings above; our 5-agent cap is stricter and should stay that way (subagent cost multiplies linearly, per their own warning).

## Relevance to ACUTE-CODE

Hermes Agent is **highly relevant** — arguably the closest architectural cousin among agent frameworks for what ACUTE-CODE plans. It validates, in production, three pillars of our design: (1) **local-first SQLite state** — a single `~/.hermes/hermes.db` in WAL mode with a single-writer queue and FTS5 indexing maps almost one-to-one onto our Node sidecar owning SQLite over localhost REST+WS; (2) **human-gated mutation** — Hermes stages memory writes for approval and runs tiered command approval, directly paralleling our safety layer (we should copy the "hardline floor that no bypass can cross" concept and the fail-closed parser limits); (3) **agent-written memory and skills** — the markdown-plus-SQLite-mirror memory tier and the self-authored skills loop are exactly the persistence model we sketched. Its "stable → context → volatile" prompt-tier discipline and "system prompt never changes mid-conversation" rule solve the same prompt-cache and injection problems we will face. The mismatch is stack (Python vs our Tauri/Node/TS) and scope (messaging gateway breadth, RL trajectory tooling, 7 execution backends — all out of scope for us), plus file sizes that show what to avoid as our sidecar grows. Study `tools/memory_tool.py`, `agent/memory_provider.py`, `tools/registry.py`, `tools/approval.py`, and `tools/delegate_tool.py` as the canonical references.

## Sources

- https://github.com/nousresearch/hermes-agent (canonical repo, verified)
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/LICENSE
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/pyproject.toml
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/AGENTS.md
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/memory_tool.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/skills_guard.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/registry.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/approval.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/delegate_tool.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_provider.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_manager.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/context_engine.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/prompt_builder.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_state_schema.py
- https://api.github.com/repos/NousResearch/hermes-agent/git/trees/main (+ nested `agent/`, `tools/`, `docs/` trees)
- https://hermes-agent.nousresearch.com/docs/ (docs index)
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
