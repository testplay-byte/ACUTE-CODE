# Aider — Research Summary

**Target:** https://github.com/Aider-AI/aider · **Research date:** 2026-08-21 · **Researcher:** ACUTE-CODE research sub-agent
**Method:** all claims verified against the live repository (README, LICENSE.txt, pyproject.toml, requirements.txt, `aider/` source files) and aider.chat docs unless marked [UNVERIFIED].

## What it is

Aider is "AI pair programming in your terminal" — a mature, CLI-first coding agent (48k+ stars) that lets an LLM edit files in a local git repo, auto-commits each change with an AI-generated message, and supports 100+ languages. It is written in Python (pip package `aider-chat`, entry point `aider.main:main`, Python >=3.10,<3.15). Signature capabilities: a tree-sitter-based **repo map** that condenses an entire codebase into a token-budgeted "map" of key definitions; multiple **edit formats** (whole-file, search/replace diff, unified diff, architect/editor split) matched to each model's strengths; automatic lint/test hooks with reflection loops; per-exchange token and dollar-cost reporting; and a public, benchmark-driven leaderboard (polyglot benchmark: 225 Exercism exercises across C++, Go, Java, JavaScript, Python, Rust, scored by pass-rate-1 / pass-rate-2).

## License

**Apache-2.0** — verified directly from `LICENSE.txt` at repo root ("Apache License / Version 2.0, January 2004"); the `pyproject.toml` classifier confirms ("License :: OSI Approved :: Apache Software License"). **Compatible** with ACUTE-CODE's allowed dependency set (MIT, Apache-2.0, BSD, ISC, MPL-2.0). We study it for patterns only; no code copying (Apache-2.0 would also require attribution/NOTICE handling if code were vendored — not planned).

## Tech stack (verified from `pyproject.toml` + `requirements/requirements.txt`)

| Concern | Aider's choice | Notes |
|---|---|---|
| Language / runtime | Python 3.10–3.14 | CLI tool, pip/uv distributed |
| CLI framework | `typer` + `rich`, `prompt-toolkit` | args.py defines full CLI surface |
| LLM gateway | `litellm` | one call layer over all cloud/local providers |
| Code parsing | `grep-ast` + `tree-sitter-language-pack`, `pygments` fallback | repo map tags; SCM query files per language |
| Graph ranking | `networkx` (PageRank), `scipy` (sparse matrices) | repo map file ranking |
| Caching | `diskcache` | tags cache keyed by file mtime; model-price cache 24 h TTL |
| Git | `GitPython` | auto-commit, diff, cherry-pick tricks in edit harness |
| Fuzzy text matching | `difflib` (SequenceMatcher), `google-diff-match-patch` | edit application + did-you-mean errors |
| Tokenization | `tiktoken` / `tokenizers` (onnx) | budget estimation |
| Lint / test | `flake8` (basic + tree-sitter fallbacks), user `test_cmd` | auto-lint/auto-test after edits |
| Local LLM server | `fastapi`, `uvicorn`, `json5` | serves the "weak/editor" model via `/docs/llm-suffix` |
| Voice / browser / watch | `sounddevice`, `soundfile`, `numpy`; `playwright`; `watchfiles` | auxiliary input modes |
| Web scraping | `beautifulsoup4`, `pypandoc` | doc/pages added to context, playwrigh docs format |
| Telemetry | `posthog` (opt-in, 10% rollout), legacy `mixpanel` (disabled) | analytics.py |
| History | chat log `.aider.chat.history.md`, input history, `.aider.tags.cache.v{N}/` | on-disk artifacts |

## Top adoptable patterns

1. **Token-budgeted repo map via tree-sitter tags + personalized PageRank** — rank definitions by graph centrality weighted toward files in the conversation, then binary-search the rendered tree to fit a token budget; solves whole-codebase awareness without embedding everything.
2. **Model-matched edit formats with layered fuzzy application and reflection retry** — search/replace blocks applied via a degradation ladder (exact → whitespace-tolerant → elision-tolerant), with structured failure messages fed back to the LLM (max 3 reflections) and an explicit "don't re-send already-applied blocks" instruction.
3. **Per-model settings registry + externalized pricing with live cost accounting** — `model-settings.yml` (edit format, repo-map usage, temperature, extra params per model) and litellm's community price JSON (cached, 24 h) driving a "Tokens/Cost per message & session" report after every exchange.

## What to avoid

1. **Dead fuzzy-match path** — `replace_closest_edit_distance` (SequenceMatcher ≥ 0.8) exists in `editblock_coder.py` but sits behind an unconditional `return`; silent speculations by fuzzy edit application can corrupt code. Adopt explicit degradation ladder, and keep each rung observable.
2. **Terminal-shaped architecture** — `InputOutput` abstraction, prompt-toolkit loop, and print-based reporting are deeply CLI-coupled; ACUTE-CODE needs event-driven (WS) equivalents, not ports of the I/O layer.
3. **Opt-in cloud telemetry (PostHog)** — even privacy-careful (opt-in, 10% UUID-threshold rollout, model-name redaction) violates local-first; keep all analytics in local SQLite.
4. **Regex-anchored response parsing with silent leniency** — marker regexes tolerate `<{5,9}` length typos and filename guesses (fuzzy, cutoff 0.8); helpful for humans, but for a multi-agent workbench prefer strict schemas + one retry with a corrective prompt, so parse failures are measurable.

## Relevance to ACUTE-CODE verdict

Aider is the single most relevant reference for ACUTE-CODE's "agent edits files reliably" core. Its repo map is a proven, license-clean (Apache-2.0) answer to our biggest context-economy problem — we can reimplement the concept (tree-sitter defs/refs graph + personalized PageRank + token-budget binary search) in the Node sidecar using `web-tree-sitter`/native grammars, persisting the tags cache in SQLite instead of diskcache. Its edit-format pipeline (structured search/replace with a whitespace/elision-tolerant application ladder plus bounded reflection against lint/test output) maps directly onto our human-approval layer: every proposed edit can be diff-previewed, applied atomically, and rolled back via git. Its cost-tracking discipline (per-exchange and per-session token/cost accounting from a cached external price table) is exactly what our SQLite usage ledger needs. The main things to leave behind are the terminal-centric I/O, cloud telemetry, and the dead fuzzy-application code path. Note aider is Python; we adopt concepts and algorithms, not code.

## Sources

- https://github.com/Aider-AI/aider (README, repo stats, tech-stack signals)
- https://raw.githubusercontent.com/Aider-AI/aider/main/LICENSE.txt (Apache-2.0 text)
- https://raw.githubusercontent.com/Aider-AI/aider/main/pyproject.toml
- https://raw.githubusercontent.com/Aider-AI/aider/main/requirements/requirements.txt
- https://aider.chat/docs/more/edit-formats.html
- https://aider.chat/docs/repomap.html
- https://aider.chat/docs/leaderboards/
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/models.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/analytics.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/editblock_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/search_replace.py
- https://github.com/Aider-AI/aider/tree/main/aider/coders and /tree/main/aider (source tree listings)
