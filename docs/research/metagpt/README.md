<!-- last-reviewed: 2026-08-30 round-53 -->
# MetaGPT — Research Summary

> Target: <https://github.com/FoundationAgents/MetaGPT> (org: FoundationAgents; default branch `main`; README still carries old `geekan/MetaGPT` links). Package `metagpt 1.0.0`.
> Every claim below was verified against the repository on 2026-08-21 (README, LICENSE, `setup.py`, `requirements.txt`, and source under `metagpt/`). Anything not independently checked is marked [UNVERIFIED].

## What it is

MetaGPT brands itself as the "First AI Software Company, Towards Natural Language Programming" — a Python multi-agent framework that "assigns different roles to GPTs to form a collaborative entity" (~69.9k stars, ~8.9k forks, 6,367 commits, created 2023-06-30, last push 2026-01-21). You give it a one-line requirement; it produces a staged software-project dossier: user stories, competitive analysis, PRD, system design (APIs, data structures, Mermaid diagrams), task breakdown, code, and tests. Core philosophy, quoted from the README: **"Code = SOP(Team)"** — standard operating procedures materialized in code and applied to a team of LLM-backed roles. README: "Internally, MetaGPT includes product managers / architects / project managers / engineers"; the repo also ships QaEngineer plus non-software roles (Researcher, Searcher, Sales, Teacher, Assistant, Data Interpreter/DataAnalyst). It is the artifact behind the ICLR 2024 paper "Meta{GPT}: Meta Programming for A Multi-Agent Collaborative Framework" (Hong et al., cited in README BibTeX).

Two generations coexist in the codebase:

1. **Classic SOP pipeline** (what made it famous): fixed roles wired by message subscriptions — `UserRequirement -> WritePRD -> WriteDesign -> WriteTasks -> WriteCode -> WriteTest/RunCode/DebugError` — kept behind `use_fixed_sop` on RoleZero-style roles.
2. **RoleZero / MGX generation** (current default): `RoleZero` ("A role who can think and act dynamically", `metagpt/roles/di/role_zero.py`) — LLM-driven tool use (Editor, Terminal, Browser), a Planner, BM25 tool recommender, up to 50 react iterations. The default CLI team (`metagpt/software_company.py::generate_repo`) hires `TeamLeader, ProductManager, Architect, Engineer2, DataAnalyst` (all from `metagpt/roles/di/` except PM/Architect); the classic ProjectManager / Engineer-with-review / QaEngineer hires are commented out there. MGX (mgx.dev, launched Feb 2025 per README news) is their flagship product built on this.

## License (verified from the LICENSE file)

- **SPDX: `MIT`** — canonical, unmodified MIT text; "Copyright (c) 2024 Chenglin Wu". Cross-checked: GitHub API `license.spdx_id = "MIT"`. No extra clauses, no commercial restrictions.
- **What it means for ACUTE-CODE**: MIT is inside our allowed set (MIT, Apache-2.0, BSD, ISC, MPL-2.0); no GPL-family exposure anywhere. It is also a Python package, so it can never be a runtime dependency of our Tauri/Node product regardless — we adopt **concepts, not code** (which MIT permits comfortably anyway).

## Tech stack (verified from `setup.py`, `requirements.txt`, repo tree)

| Layer | Technology |
|---|---|
| Language | Python `>=3.9, <3.12` (`setup.py python_requires`) |
| Packaging | `setup.py` + `requirements.txt` (no pyproject); pip package `metagpt 1.0.0`; Docker + devcontainer; console script `metagpt = metagpt.software_company:app` |
| Core data model | Pydantic v2 (`pydantic>=2.5.3`) — Role, Action, Message, Team, Environment are all BaseModels |
| LLM providers (core reqs) | `openai~=1.64.0`, `anthropic==0.47.2`, `dashscope`, `zhipuai`, `qianfan`, `google-generativeai`, `spark_ai_python`, `volcengine[ark]`; selected via `~/.metagpt/config2.yaml` (api_type/model/base_url/api_key) |
| Resilience / tokens | `tenacity==8.2.3`, `tiktoken==0.7.0` (token accounting for the CostManager) |
| Async runtime | asyncio core; `aiohttp==3.8.6`, `websockets >=10,<12`, `httpx` |
| CLI | `typer==0.9.0` (+ `fire==0.4.0`) |
| Storage / artifacts | Per-project workspace on the filesystem (`docs/prd`, `docs/system_design`, `docs/task`, `docs/code_summary`, `docs/code_plan_and_change`, `tests/`, `srcs/`, `resources/`) via `ProjectRepo` over `GitRepository` (`gitpython`); run state serialized to `team.json` under `SERDESER_PATH = workspace/storage` |
| Code analysis | `tree_sitter`, `grep-ast`, `unidiff`, `networkx` (task graphs) |
| Browser / rendering | `playwright>=1.26`; `setup.py` npm-installs `@mermaid-js/mermaid-cli` globally (Node.js + pnpm documented prerequisites) |
| Optional extras | RAG via llama-index 0.10 stack (faiss, qdrant, chroma, lancedb, meilisearch), selenium, google/ddg search, Android ML stack (tensorflow/torch) |
| UI | None in this repo — CLI/library only (MGX web app is a separate product [UNVERIFIED beyond README news link]) |

## Top adoptable patterns (one line each; details in `patterns-for-acute-code.md`)

1. **SOP-as-subscription graph** — roles subscribe to message types (`_watch([WritePRD])`), so the PM→Architect→PM→Engineer→QA pipeline emerges from subscriptions instead of a central orchestrator script.
2. **Typed message pool with per-role inboxes + full audit log** — every Message carries `cause_by`/`sent_from`/`send_to` (+ structured payload); the environment appends each to a shared history and delivers into private per-role queues.
3. **Stage-gated artifacts with review lifecycle + budget hard-stop** — each SOP step emits a durable document (`status: draft/underreview/approved/done`) into a git-archived workspace, while `Team.invest()` + `NoMoneyException` cap runaway spend per round.

## What to avoid (one line each)

- **RoleZero-style autonomy** (LLM picks tools/commands, `max_react_loop=50`) — nondeterministic and cost-unbounded; conflicts with a human-approval-first design.
- **Whole-history prompting** — actions run over the role's entire memory (`todo.run(self.rc.history)`); token blowout on long runs.
- **Filesystem-as-database** — state scattered across workspace files + npm-rendered PDFs + git-commit archiving; we own SQLite and should make it the source of truth.
- **Default broadcast routing** (`send_to = <all>`) — every role buffers then filters; wasteful even at 5 agents.
- **Copying code** — it is Python; nothing to vendor into Tauri/Node (MIT would even permit porting, but concepts transfer cleanly).

## Relevance to ACUTE-CODE — verdict

MetaGPT is the strongest available reference for exactly ACUTE-CODE's problem shape: a small, fixed team of specialist agents (their 4–5 roles map neatly onto our max-5 concurrent agents), coordinating through a shared message pool with typed subscriptions, producing a staged chain of reviewable artifacts rather than chat noise. Its role/action/environment/message model is small — four Pydantic classes plus one loop — and translates almost mechanically onto our stack (roles + subscriptions + messages as SQLite tables in the Node sidecar, mirrored to React over WS). Two ideas slot directly into our safety layer: budget-as-hard-stop (`invest()` + per-round `_check_balance()` ≈ per-run cost ceiling enforced outside the agents) and stage-gated artifacts (each SOP step emits a durable document a human can inspect and approve before the next role consumes it — MetaGPT gates by message type; we can gate by human approval). It is MIT and Python: zero license exposure, zero code reuse, concepts only. Its cautionary tales are equally valuable: don't feed full history to every prompt, don't hardcode one pipeline shape (they demoted their own fixed SOP to a flag), and don't scatter state across files when you own a database. Verdict: **adopt the orchestration skeleton (subscriptions, typed pool, artifact lifecycle, budget loop); reject the autonomy model (RoleZero) and the filesystem-first state design.**

## Sources

- https://github.com/FoundationAgents/MetaGPT (README, tree, stats)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/README.md (roles line, Data Interpreter, ICLR 2024 BibTeX, MGX news)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/LICENSE
- https://api.github.com/repos/FoundationAgents/MetaGPT (SPDX, metadata)
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/setup.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/requirements.txt
- https://github.com/FoundationAgents/MetaGPT/tree/main/metagpt
- https://github.com/FoundationAgents/MetaGPT/tree/main/metagpt/roles
- https://github.com/FoundationAgents/MetaGPT/tree/main/metagpt/actions
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/software_company.py
- https://raw.githubusercontent.com/FoundationAgents/MetaGPT/main/metagpt/roles/__init__.py
