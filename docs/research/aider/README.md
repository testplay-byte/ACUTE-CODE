<!-- last-reviewed: 2026-09-19 round-108 -->
# Aider — Research Summary

**Target:** https://github.com/Aider-AI/aider · **Research date:** 2026-08-21 · **Researcher:** ACUTE-CODE research sub-agent
**Method:** every claim verified against the live repository (README, LICENSE.txt, pyproject.toml, requirements.txt, `aider/` source files fetched raw) and aider.chat docs; anything not directly verified is marked [UNVERIFIED].

## What it is

Aider is "AI pair programming in your terminal" — a mature CLI coding agent (~48.4k stars, ~13k commits) that lets an LLM edit files in a local git repo, auto-commits each change with an AI-generated message, and supports 100+ languages. Written in Python (pip package `aider-chat`, entry point `aider = "aider.main:main"`, `requires-python >=3.10,<3.15`). Signature capabilities: a tree-sitter-based **repo map** that condenses a whole codebase into a token-budgeted outline of key definitions; multiple **edit formats** (whole, SEARCH/REPLACE diff, diff-fenced, udiff, architect/editor split) matched per model; automatic lint/test hooks that feed errors back into a bounded reflection loop; per-exchange token and dollar-cost reporting; and a public, benchmark-driven leaderboard (polyglot benchmark: 225 Exercism exercises across C++, Go, Java, JavaScript, Python, Rust, scored by pass-rate-1 vs pass-rate-2 plus "% correctly formatted edits").

## License (verified)

**SPDX: `Apache-2.0`.** Confirmed three independent ways: GitHub API license endpoint (`spdx_id: Apache-2.0`), `LICENSE.txt` at repo root (standard "Apache License / Version 2.0" text), and the `pyproject.toml` classifier "License :: OSI Approved :: Apache Software License". **Compatible** with ACUTE-CODE's allowed dependency set (MIT, Apache-2.0, BSD, ISC, MPL-2.0). No GPL-family license in the project's own metadata. We study patterns only; no code copying (Apache-2.0 would additionally require NOTICE/attribution handling if code were ever vendored — not planned).

## Tech stack (verified from `pyproject.toml` + `requirements.txt` + source)

| Concern | Aider's choice | Notes |
|---|---|---|
| Language / runtime | Python 3.10–3.14 | CLI tool, pip/uv distributed, setuptools + setuptools_scm |
| CLI framework | `argparse` (`aider/args.py`, `get_parser`) | `typer` appears only as a transitive dep (via huggingface-hub) |
| LLM gateway | `litellm` 1.82.3 | all cloud/local providers; lazy-imported via `aider/llm.py` `LazyLiteLLM` |
| Code parsing | `grep-ast` 0.9.0 + `tree-sitter-language-pack` 0.13.0, `pygments` fallback | repo-map tags; per-language `.scm` queries |
| Graph ranking | `networkx` 3.4.2 + `scipy` | personalized PageRank over file-reference graph |
| Tokenization | `tiktoken` 0.12.0 | token budgets for map, history, cost math |
| Caching | `diskcache` | tags cache `.aider.tags.cache.v{N}` keyed by file mtime |
| Git | `GitPython` 3.1.45 | auto-commit, diffs, cherry-pick trick in edit harness |
| Fuzzy text | `diff-match-patch` 20241021, `difflib` | dmp line-mode apply; did-you-mean errors |
| CLI UX | `prompt-toolkit` 3.0.52, `rich` 14.3.3 | InputOutput abstraction in `aider/io.py` |
| Lint/test | `flake8` + tree-sitter-based linter (`aider/linter.py` imports grep-ast parsers) | auto-lint default on; auto-test off |
| Telemetry | `posthog` (opt-in, 10% rollout), `mixpanel` import present but inactive | `aider/analytics.py` |
| Web/docs | `beautifulsoup4`, `pypandoc`; `playwright` optional extra | URL/page context |
| Voice/watch | `sounddevice`, `soundfile`, `pydub`; `watchfiles`, `pexpect` | auxiliary input modes |
| Misc | `fastapi` (core dep; purpose not inspected — [UNVERIFIED]), `orjson`, `psutil`, `shtab`, `json5`, `jsonschema`, `backoff`, `httpx` | |
| On-disk artifacts | `.aider.chat.history.md` (verified via benchmark harness), `.aider.input.history` [UNVERIFIED], `~/.aider/caches/` (price JSON), `~/.aider/analytics.json` | |

## Top adoptable patterns (one line each)

1. **Token-budgeted repo map** — tree-sitter def/ref tags → weighted file graph → personalized PageRank → binary-search the rendered outline into a ~1k-token budget (scaled to `max_input/8`, clamped 1024–4096); whole-repo awareness without embeddings or whole files.
2. **Model-matched edit formats + degradation-ladder application + bounded reflection** — SEARCH/REPLACE blocks applied exact → whitespace-tolerant → elision-tolerant (plus a git-cherry-pick / diff-match-patch fallback cascade), with structured failure reports fed back to the LLM for up to 3 automatic repair rounds.
3. **Per-message cost telemetry + public eval discipline** — every exchange logs prompt/completion/cache tokens and dollars (litellm price table, 24h cache, manual fallback math incl. cache-hit 0.1x / cache-write 1.25x), and model quality is ranked by a reproducible 225-exercise benchmark with pass-rate-1/2 and well-formedness metrics.

## What to avoid (one line each)

- **Terminal-shaped architecture** — the coder loop is coupled to `InputOutput`/prompt-toolkit and blocking `confirm_ask`; our event-driven sidecar + WS UI must port semantics, not shape.
- **Opt-in cloud telemetry (PostHog)** — even privacy-careful (opt-in, 10% UUID rollout, model-name redaction) it violates local-first; keep analytics in SQLite.
- **Regex leniency in response parsing** — marker typos tolerated (`<{5,9}`), filenames fuzzy-guessed (cutoff 0.8); fine for humans, but strict schemas + counted parse failures are healthier for a multi-agent product.
- **Silent fuzzy edit application** — the SequenceMatcher rung (`replace_closest_edit_distance`) is deliberately disabled behind an unconditional `return`; speculative matching corrupts code and destroys auditability.

## Relevance to ACUTE-CODE verdict

Aider is the single most relevant prior art for ACUTE-CODE's core problems: context economy over a real codebase, reliable structured edits, and cost-visible model usage. Its Apache-2.0 license means we can freely read its algorithms and prompt/error designs and re-implement them in TypeScript — the repo map (tags → weighted graph → personalized PageRank → token-budget bisection) maps almost 1:1 onto a Node sidecar using web-tree-sitter with our SQLite replacing diskcache; the edit pipeline (dry-run apply → structured error → ≤3 reflections, human confirmation before touching un-added files) is exactly the posture our human-approval layer wants; and its benchmark gives a template for evidence-based model selection before we commit to defaults. What we leave behind: terminal I/O coupling, cloud telemetry, and lenient parsing. Aider is Python; we adopt concepts, never code.

## Sources

- https://github.com/Aider-AI/aider (README, repo stats)
- https://api.github.com/repos/Aider-AI/aider/license (SPDX confirmation)
- https://raw.githubusercontent.com/Aider-AI/aider/main/LICENSE.txt
- https://raw.githubusercontent.com/Aider-AI/aider/main/pyproject.toml
- https://raw.githubusercontent.com/Aider-AI/aider/main/requirements.txt
- https://aider.chat/docs/repomap.html
- https://aider.chat/docs/more/edit-formats.html
- https://aider.chat/docs/leaderboards/
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/editblock_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/search_replace.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/udiff_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/chat_chunks.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/analytics.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/models.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/resources/model-settings.yml
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/args.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/benchmark/benchmark.py
