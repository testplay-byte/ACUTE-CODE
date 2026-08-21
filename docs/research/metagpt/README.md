# MetaGPT — Research Summary

> Target: <https://github.com/FoundationAgents/MetaGPT> (formerly `geekan/MetaGPT`)
> Verified against repo `main` branch on 2026-08-21 (README, LICENSE, `setup.py`, `requirements.txt`, and source files under `metagpt/`).

## What it is

MetaGPT brands itself as the "First AI Software Company" — a Python multi-agent framework that "assigns different roles to GPTs to form a collaborative entity for complex tasks." You feed it a one-line requirement; it emits a staged software-project dossier: user stories, competitive analysis, PRD, system design (with API/data structures and Mermaid diagrams), a task breakdown, and implementation + tests. Core philosophy, quoted from the README: **"Code = SOP(Team)"** — standard operating procedures are materialized in code and applied to a team of LLM-backed roles.

Internally (README): "MetaGPT includes product managers / architects / project managers / engineers." The repo also ships a QaEngineer role, plus many non-software roles (Researcher, Searcher, Sales, Teacher, DataInterpreter/DataAnalyst) and game environments (Werewolf, Minecraft, Stanford Town, Android). It is also the artifact behind the ICLR 2024 paper "Meta Programming for A Multi-Agent Collaborative Framework" (Hong et al.), and its successor product MGX (launched Feb 2025) is now the repo's flagship; the current default `generate_repo` team is MGX-style (`TeamLeader, ProductManager, Architect, Engineer2, DataAnalyst`) while the classic PM→Architect→PM→Engineer→QA SOP pipeline remains in the codebase (`use_fixed_sop`).

## License

- **SPDX: `MIT`** — verified verbatim from `LICENSE` on `main`: the canonical, unmodified MIT text, "Copyright (c) 2024 Chenglin Wu". No extra clauses, no commercial-use restrictions.
- Implication for ACUTE-CODE: MIT is inside our allowed set (MIT, Apache-2.0, BSD, ISC, MPL-2.0). However MetaGPT is a **Python** library, so it can never be a dependency of our Node/TS sidecar or Tauri shell regardless. We borrow **concepts only** — which MIT comfortably permits anyway.

## Tech stack (verified from `setup.py`, `requirements.txt`, repo tree)

| Layer | Technology |
|---|---|
| Language | Python 3.9+ (< 3.12 per README) |
| Packaging | `setuptools` via `setup.py` + `requirements.txt` (no `pyproject.toml`); pip package `metagpt` |
| Core data model | Pydantic ≥ 2.5.3 (Role, Action, Message, Team are all pydantic BaseModels) |
| LLM providers | `openai~=1.64`, `anthropic`, `zhipuai`, `google-generativeai`, plus Azure/Ollama/Groq via `config2.yaml` |
| Async runtime | `asyncio` (`Environment.run` gathers all non-idle roles concurrently) |
| CLI | `typer` / `fire` |
| Storage / artifacts | Local filesystem `workspace/<project>/` (docs, resources, tests) + `gitpython` for archiving; JSON serialization to `workspace/storage/team/team.json` for run recovery |
| Vector / RAG (optional) | faiss, lancedb, qdrant-client, meilisearch, llama-index extras |
| Rendering | Node.js + pnpm required; `setup.py` auto-installs `@mermaid-js/mermaid-cli` (npm) for diagram/PDF rendering |
| Misc | loguru, networkx, playwright, websockets, redis (optional) |
| Repo stats (2026-08) | ~69.9k stars, ~8.9k forks, 6,367 commits, ICLR 2024 paper |

## Top adoptable patterns (details in `patterns-for-acute-code.md`)

1. **Typed pub/sub message pool** — one shared environment bus; messages carry `cause_by` (producing action type) + `send_to` (address set); roles subscribe via `_watch(action types)` and `set_addresses(names)`; each role gets a private queue and per-role memory. One-line each: a clean, auditable blackboard that maps 1:1 onto SQLite + WS.
2. **SOP-as-data role specs** — each role is a declarative record (`profile/goal/constraints` + ordered `actions` + a `watch` list) so the whole team pipeline is configuration, not orchestration code.
3. **Stage-gated artifact pipeline + budget hard-stop** — every stage emits a reviewable document into a repo-shaped workspace (`docs/prd`, `docs/system_design`, `docs/task`, `tests/`), and a `CostManager` kills the run (`NoMoneyException`) when spend exceeds the "investment" — a natural fit for our human-approval gates and per-run budgets.

## What to avoid (one line each)

- **Whole-history prompting**: `Role._act` passes the role's entire memory (`rc.history`) to every action call — token blowout on long runs; use retrieval/summarization instead.
- **Fixed-SOP rigidity as the default**: MetaGPT itself demoted the classic fixed pipeline to `use_fixed_sop` and moved to the dynamic "RoleZero" tool-using agent — don't hardcode a single pipeline shape.
- **Filesystem-as-database**: artifacts, run state, and recovery all live on disk with npm-rendered PDFs — for us SQLite is the source of truth and rendering is a view concern.
- **Default broadcast routing** (`send_to = <all>`): every role buffers then filters — wasteful even at 5 agents; prefer explicit typed subscriptions.

## Relevance to ACUTE-CODE

MetaGPT is the strongest available reference for exactly our problem shape: a small, fixed team of specialist agents (their 4–5 roles ≈ our max-5 concurrent agents), collaborating through a shared message pool with typed subscriptions, producing a staged chain of reviewable artifacts. Its role/action/environment/message model is small (four pydantic classes + one loop) and translatable almost mechanically to our Node/TS sidecar (roles table + typed event bus + run loop in SQLite, mirrored to React over WS). Two of its ideas slot directly into our safety layer: budget-as-hard-stop (`invest()` + `NoMoneyException` ≈ per-run token/cost ceiling enforced by the sidecar) and stage-gated artifacts (each SOP step emits a durable document that a human can inspect and approve before the next role consumes it — MetaGPT gates by message type, we can gate by human approval). It is Python and MIT; we adopt zero code and only concepts, so there is no license exposure. The main cautionary tales are equally valuable: don't feed full history to every prompt, don't make the pipeline shape rigid, and don't scatter state across the filesystem when you own a database.

## Sources

- Repo root / README: https://github.com/FoundationAgents/MetaGPT
- LICENSE (verbatim): https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/LICENSE
- setup.py: https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/setup.py
- requirements.txt: https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/requirements.txt
- Source tree via GitHub API: https://api.github.com/repos/FoundationAgents/MetaGPT/contents/metagpt
- Official docs intro: https://docs.deepwisdom.ai/main/en/guide/get_started/introduction.html
