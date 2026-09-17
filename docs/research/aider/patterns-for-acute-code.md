<!-- last-reviewed: 2026-09-17 round-102 -->
# Aider — Patterns for ACUTE-CODE

Aider is Apache-2.0 and Python; ACUTE-CODE is Tauri 2 + React 18/TS + Node/TS sidecar (SQLite via localhost REST+WS, max 5 concurrent agents, human-approval safety layer). We adopt **concepts and algorithms only** — never code. Every "WHAT" below was verified in the aider repo/docs (see Sources).

---

## Pattern 1 — Token-budgeted repo map (tree-sitter tags + personalized PageRank)

**WHAT (in Aider).** `aider/repomap.py` extracts per-file definition/reference tags via tree-sitter `.scm` queries (defs = `name.definition.*`, refs = `name.reference.*`; pygments fallback where no ref query). Builds a `networkx.MultiDiGraph` of files (edge referencer→definer per shared identifier, weight = multiplier × √num_refs; multipliers: chat-mentioned identifiers ×10, chat-file references ×50, noisy/common identifiers ×0.1), runs **personalized PageRank** (chat files, mentioned files, and identifier-matching paths get `100/num_files`), then **binary-searches** the number of top-ranked definitions so the rendered `TreeContext` outline fits the token budget within 15% (default 1024 tokens; model-scaled `max_input/8` clamped [1024, 4096]; ×8 expansion when no files are in chat). Tags cached by mtime in diskcache (`.aider.tags.cache.v{N}`) with SQLite-error fallback to memory.

**WHY (fits ACUTE-CODE).** Our agents must reason about whole repos they cannot fit in context. This is the field-proven answer to context economy: deterministic, provider-independent, incremental, cheap (no embeddings, no extra LLM calls). Personalization makes the map *conversation-aware* — ideal when 5 concurrent agents each hold a different task focus over one shared codebase.

**HOW (maps to our stack).**
- Node sidecar: `web-tree-sitter` (WASM grammars) or native `node-tree-sitter` bindings to emit def/ref tags; persist tags + mtime in **SQLite** (`tags(file_path, mtime, symbol, kind, line)`) — replaces diskcache, gives all 5 agents one shared, concurrent-safe cache with per-workspace rows.
- Ranking: ~30-line power-iteration PageRank in TS, or `graphology` (MIT) for the graph; snapshot per-agent ranks in SQLite with the personalization set = files that agent touched/discussed.
- Budget fit: same bisection over tag count against each model's token budget; per-component token ledger mirroring aider's `ChatChunks` split (system / repo-map / chat-files / reminder) so the UI can show where context goes.
- React: render the map as a collapsible file/symbol tree fed over WS (aider prints plain text; same data, better presentation).

---

## Pattern 2 — Model-matched edit formats + layered application + bounded reflection

**WHAT (in Aider).** `model-settings.yml` picks each model's best edit format (`diff`, `diff-fenced`, `udiff`, `whole`, `editor-*`, with `lazy`/`use_repo_map` flags). SEARCH/REPLACE blocks are parsed with tolerant-but-structured markers and applied via a **degradation ladder**: exact → whitespace-flexible → skip spurious blank line → `...` elision-tolerant (`try_dotdotdots`); deeper fallbacks cascade exact → git-cherry-pick-in-temp-repo → diff-match-patch line-mode, each with blank-line/relative-indent preprocessing; failing blocks are retried against other chat files. Failures raise a **structured error** (failed block + did-you-mean lines ≥0.6 similarity + "N other blocks applied, don't re-send them") that is fed back to the LLM, up to `max_reflections = 3`; lint (default on) and test (opt-in) outputs feed the same reflection loop; `apply_edits_dry_run` precedes real writes; `allowed_to_edit` asks human permission before touching files not in chat; every accepted round is auto-committed.

**WHY.** Reliable, auditable file editing is ACUTE-CODE's core loop. Aider proves: (a) structured edits + narrow, explicit tolerance beat free-form diffs; (b) retry-with-diagnosis beats silent fuzzy fixes (they deliberately disabled their fuzzy rung); (c) lint/test evidence closes the loop — and hands our human-approval layer concrete artifacts to display.

**HOW.**
- Sidecar edit engine in TS: parse SEARCH/REPLACE blocks; ladder exact → whitespace-normalized → elision-tolerant; log every attempt to SQLite (`edit_attempts(block, strategy, outcome)`) for analytics and UI diff preview. Skip the git-cherry-pick rung (heavy); adopt the diff-match-patch concept via the `diff-match-patch` npm package (Apache-2.0) only if the first rungs prove insufficient in our own evals.
- Reflection as an explicit state machine: `PROPOSE → DRY-RUN → APPROVE → APPLY → (LINT/TEST) → REFLECT(≤3) → DONE | ESCALATE`, streamed as WS events and rendered as a steppable timeline in React. ESCALATE routes to a human instead of aider's terminal confirm.
- Git discipline: one commit per accepted edit round with a generated message (cheap model, like aider's commit-message model); record pre-message SHA like `commit_before_message` for one-click undo.
- Model→format registry as data in SQLite, editable in the Settings UI (mirrors model-settings.yml).

---

## Pattern 3 — Externalized model settings + pricing with live cost accounting

**WHAT.** `models.py` + `model-settings.yml`: per-model edit format, weak/editor models, repo-map usage, reminder style. Pricing from litellm's community `model_prices_and_context_window.json`, cached 24h under `~/.aider/caches/`. Every exchange computes cost via `litellm.completion_cost` with a manual fallback (`compute_costs_from_tokens`; cache-hit ≈ 0.1× input price, Anthropic cache-write ×1.25) and prints "Cost: $x message, $y session", accumulating session totals.

**WHY.** ACUTE-CODE is cloud-API-only; per-agent cost attribution and a live, data-driven model catalog are table stakes for our analytics promises, and keeping model behavior in data (not code) lets us tune per-model quirks without releases.

**HOW.**
- SQLite tables: `models(name, settings_json, prices_json, fetched_at)`; sidecar job syncs prices from LiteLLM's price JSON (MIT-licensed data) on a 24h refresh, with manual per-token overrides.
- LLM-call middleware in the sidecar wraps every request: capture usage (prompt/completion/cache-hit/cache-write), compute cost, append `usage_events(agent_id, task_id, tokens_in, tokens_out, cache_hit, cache_write, cost_usd, ts)`; aggregate per agent / task / session.
- React dashboard: per-agent and per-session token & cost charts over WS — replaces aider's terminal printout; hard per-agent budget alerts enforced before send.

---

## Pattern 4 — Benchmark-driven evaluation discipline

**WHAT.** Aider ships a public polyglot benchmark (`benchmark/benchmark.py`): 225 Exercism exercises × 6 languages; per exercise it runs aider, runs unit tests, and on failure feeds the test errors back as the next instructions for up to `tries` rounds — yielding pass-rate-1 (first attempt) vs pass-rate-2 (final) plus % well-formed edits, malformed-response counts, syntax/indentation errors, lazy-comment counts, and cost. The leaderboard records model, edit format, exact command, aider version+commit, tokens, and total cost for every run. Additionally `search_replace.py` contains a self-contained grading harness (`main()`) that compares edit-application strategies over directories of test cases as a pass/fail matrix.

**WHY.** Choosing models and edit strategies for ACUTE-CODE must be evidence-based and reproducible; recording harness version + config + cost with every score is what makes comparisons trustworthy over time.

**HOW.**
- Start local: an edit-application corpus (SEARCH/REPLACE blocks + expected file states) run as property/unit tests in the sidecar — grades our ladder deterministically, no LLM needed.
- Later: a mini coding-benchmark runner (Exercism-style tasks) in the sidecar with pass-rate-1/2, well-formedness, and cost per run; every run stored in SQLite (`eval_runs(model, format, prompt_variant, score, cost_usd, harness_sha, ts)`) and rendered as comparison tables in React.
- Use it to tune our own edit ladder and default model choices — exactly how aider uses its harness.

---

## Pattern 5 — Chunked context assembly + summarization on overflow

**WHAT.** `ChatChunks` assembles prompts from labeled components (system / examples / done / repo-map / readonly files / chat files / current / reminder) with per-component token accounting and Anthropic `cache_control` markers at stable chunk boundaries for prompt caching. When `done_messages` exceeds the token limit, a background thread (`ChatSummary`) summarizes old turns with the weak model; messages are validated for role alternation before send; a token-gated reminder re-asserts key instructions near the end.

**WHY.** Long agent sessions on real tasks overflow context; silent truncation or a crash is unacceptable. Per-component accounting also enables per-agent context budgets (5 concurrent agents) and cache-friendly message layouts that cut cost on cloud APIs.

**HOW.** Sidecar prompt builder emits chunked messages + a per-chunk token ledger (snapshot per turn in SQLite); background summarization job with a cheap model and an explicit "summarized history" boundary in the UI timeline; strict role-alternation validation before send; per-agent token budget enforcement with a warning state in React. If we adopt Anthropic models, replicate the cache_control boundary trick.

---

## What to avoid (with reasons)

1. **Fuzzy edit application by default** — aider keeps a SequenceMatcher ≥0.8 rung but deliberately disabled it (unreachable `return`); silent speculative matching risks corrupting code and destroys auditability. Any fuzzy rung we add must be opt-in, logged, and visible in the approval diff.
2. **Regex leniency in response parsing** — aider tolerates marker-length typos (`<{5,9}`) and fuzzy-guesses filenames (cutoff 0.8); helpful for humans in a terminal, but in a multi-agent product prefer strict structured output + one corrective retry, and count parse failures as a model-quality metric.
3. **Terminal-centric I/O** — `io.py`/prompt-toolkit/blocking-`confirm_ask` shape doesn't translate; our equivalent is typed WS events to React with async approval gates. Port the semantics, not the shape.
4. **Cloud telemetry** — even privacy-careful opt-in PostHog (10% rollout, UUID threshold, model-name redaction) conflicts with our local-first promise; all analytics stay in local SQLite.
5. **Unconditional auto-commit** — aider commits every accepted edit round by default; our human-approval layer must interpose (approval before commit, or auto-commit only inside explicitly sandboxed task workspaces).
6. **pip-scale peripheral surface** — voice, browser automation, doc scraping, watch mode, pandoc are scope creep for a v1 workbench; adopt the core (map, edits, costs, evals) and skip the periphery until proven necessary.

---

## Sources

- https://github.com/Aider-AI/aider (README)
- https://api.github.com/repos/Aider-AI/aider/license
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
- https://raw.githubusercontent.com/Aider-AI/aider/main/benchmark/benchmark.py
- https://github.com/Aider-AI/aider/tree/main/aider/coders (tree listing)
