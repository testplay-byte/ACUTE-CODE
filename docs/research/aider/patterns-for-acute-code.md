# Aider — Patterns for ACUTE-CODE

Aider is Apache-2.0 and Python; ACUTE-CODE is Tauri 2 + React 18/TS + Node/TS sidecar (SQLite via localhost REST+WS). We adopt **concepts and algorithms**, never code. Every pattern below was verified in the aider repo/docs (see Sources).

---

## Pattern 1 — Token-budgeted repo map (tree-sitter tags + personalized PageRank)

**WHAT (in Aider).** `aider/repomap.py` extracts per-file definition/reference tags with tree-sitter (grep-ast `.scm` queries), builds a file graph (referencer→definer edges, weight = multiplier × √num_refs; chat-mentioned identifiers ×10, chat-file refs ×50, noisy/common idents ×0.1), runs **personalized PageRank** biased toward files in the current conversation, then **binary-searches** the number of top-ranked definitions so the rendered outline fits a token budget (default 1k, model-scaled to `max_input/8` clamped 1024–4096, expanded when no files are in chat). Tags are cached by mtime in diskcache; rendered with grep-ast `TreeContext` (definition lines + context, 100-char truncation).

**WHY (fits ACUTE-CODE).** Our agents must reason about whole repos they cannot fit in context. This is the field-proven answer to context economy: deterministic, provider-independent, incremental, and cheap (no embeddings, no LLM calls). The personalization trick makes the map *conversation-aware* — perfect for 5 concurrent agents each with their own task focus.

**HOW (maps to our stack).**
- Node sidecar: use `web-tree-sitter` (or prebuilt native grammars, e.g. via `tree-sitter` WASM per language) to emit def/ref tags; store tags + mtime in **SQLite** (`tags(file_path, mtime, symbol, kind, line)`), replacing diskcache — gives us concurrent-agent-safe shared cache with per-workspace rows.
- Ranking: a small PageRank implementation (~30 LOC power iteration) or `graphology` (MIT) for the file graph; persist rank snapshots per agent session with the personalization set = files that agent touched/discussed.
- Budget fit: same binary search over tag count against the model's token budget, with a per-component token ledger mirroring aider's `ChatChunks` accounting (system/map/chat-files split).
- React UI: render the map as a collapsible file/symbol tree (aider renders plain text; we can do better with the same data).

---

## Pattern 2 — Model-matched edit formats + layered application + bounded reflection

**WHAT (in Aider).** A registry (`model-settings.yml` → `Model`) picks each model's best edit format (diff/diff-fenced/udiff/whole/editor-*). SEARCH/REPLACE blocks are parsed with tolerant regexes (`<{5,9}` etc.) and applied via a **degradation ladder**: exact match → uniform-indent shift → skip spurious blank line → `...` elisions; failing blocks are retried against other chat files; a SequenceMatcher fuzzy rung exists but is deliberately disabled. Failures produce a **structured error message** (failed block + did-you-mean similar lines ≥0.6 + "N other blocks applied, don't re-send them") that is fed back to the LLM, up to `max_reflections = 3`; lint and test output feed the same reflection loop; every accepted round is auto-committed; `apply_edits_dry_run` precedes real writes.

**WHY.** Reliable, auditable file editing is ACUTE-CODE's core loop. Aider demonstrates that (a) strict-ish structured edits + limited tolerant normalization beat free-form diffs, (b) retry-with-diagnosis beats silent fuzzy fixes, and (c) lint/test evidence closes the loop — which also gives our human-approval layer concrete artifacts to show.

**HOW.**
- Sidecar implements the ladder in TS: exact → whitespace-normalized → elision-tolerant; every applied/failed block logged to SQLite (`edit_attempts` table: block, strategy used, outcome) for analytics and UI diff preview.
- Reflection as an explicit agent-loop state machine: `PROPOSE → APPLY → (LINT/TEST) → REFLECT(≤3) → DONE|ESCALATE`, surfaced over WS to React as steppable timeline events; escalation can trigger human approval instead of aider's terminal confirm.
- Git discipline: one commit per accepted edit round with generated message (we can use the weak/cheap model like aider's commit-message model), giving free undo for agents.
- Model→format registry as data (JSON in SQLite, editable in Settings UI), mirroring model-settings.yml.

---

## Pattern 3 — Per-model settings registry + externalized pricing + live cost accounting

**WHAT.** `models.py` + `model-settings.yml`: per-model edit format, repo-map usage/tokens, temperature policy, extra params, weak/editor models, aliases. Pricing from litellm's community `model_prices_and_context_window.json`, cached 24 h, OpenRouter scrape fallback. Every exchange prints "Tokens: X sent / Cost: $x message, $y session" with provider cache-hit pricing handled (Anthropic 1.25×/0.1×).

**WHY.** ACUTE-CODE is cloud-API-only with a hard budget reality; per-agent cost attribution and a live model catalog are table stakes for the analytics we promised, and a data-driven registry avoids hardcoding model behavior in code.

**HOW.**
- SQLite tables: `models(name, settings_json, prices_json, fetched_at)` — prices synced from LiteLLM's price JSON (its repo is MIT-licensed data) with a 24 h refresh job in the sidecar.
- Sidecar middleware wraps every LLM call: capture usage (prompt/completion/cache tokens), compute cost, write to `usage_events(agent_id, task_id, tokens_in, tokens_out, cache_hit, cost_usd, ts)`; aggregate per agent/session/task.
- React dashboard: per-agent and per-session cost/token charts fed over WS — replaces aider's terminal printout.

---

## Pattern 4 — Benchmark-driven model evaluation discipline

**WHAT.** Aider ships a public polyglot benchmark (225 Exercism exercises × 6 languages; pass-rate-1/2 metrics) and a leaderboard where each run records model, aider version + commit hash, edit format, exact command, cost, and date. Internally, `aider/coders/search_replace.py` is a self-contained harness that grades edit-application strategies (search-and-replace vs diff-match-patch vs git-cherry-pick) as pass/fail/WROSG tables against a local test corpus (directory list "150"/"1500", partly copied from OpenAI's editbench).

**WHY.** Choosing models/edit strategies for ACUTE-CODE should be evidence-based and reproducible, not vibes; the "record version+format+cost with every score" habit makes comparisons trustworthy.

**HOW.**
- Keep a small local eval suite (edit-application unit corpus first: search/replace blocks + expected files — directly gradable in Node with property tests), later a mini coding-benchmark runner in the sidecar.
- Store every eval run in SQLite (`eval_runs(model, prompt_variant, strategy, score, cost, ts, git_sha_of_harness)`) and render comparison tables in the React UI.
- Use it to tune our own edit ladder (which rungs actually help) exactly as aider does.

---

## Pattern 5 — Conversation-aware context assembly (ChatChunks) + summarization on overflow

**WHAT.** Prompts are assembled from labeled components (system / repo-map / readonly files / chat files / reminder) with per-component token accounting; a token-gated "reminder" re-asserts key instructions near the end; when history exceeds `max_chat_history_tokens`, a background thread summarizes old messages with the weak model and swaps them in; context-window exhaustion is a detected, handled error with diagnostics.

**WHY.** Long agent sessions on real tasks overflow context; silently truncating or crashing is unacceptable. Per-component accounting also enables our per-agent context budget enforcement (5 concurrent agents).

**HOW.** Sidecar prompt builder emits chunked messages + a token ledger per chunk (SQLite `context_windows` snapshot per turn); background summarization job (cheap model) with explicit "summarized history" boundary in the UI timeline; hard per-agent token budgets enforced before send, with a UI warning state.

---

## What to avoid (with reasons)

1. **Fuzzy edit application by default** — aider keeps a SequenceMatcher≥0.8 fuzzy rung but has it disabled behind a bare `return`; silent speculative matching risks corrupting code and destroys auditability. If we add fuzzy matching, it must be opt-in per strategy, logged, and shown in the approval diff.
2. **Regex leniency for response parsing** — aider tolerates marker-length typos (`<{5,9}`) and fuzzy-guesses filenames (cutoff 0.8). For a multi-agent product this hides model misbehavior; prefer strict structured output + one corrective retry, and *count* parse failures as a quality metric.
3. **Terminal-centric I/O layer** — `io.py`/prompt-toolkit design doesn't translate; our equivalent is typed WS events to React. Don't port the shape, port the semantics.
4. **Cloud telemetry** — even opt-in PostHog (with 10% rollout and model-name redaction) conflicts with local-first; all analytics stay in SQLite.
5. **Anthropomorphic auto-commit without human gates** — aider auto-commits everything; ACUTE-CODE's human-approval safety layer must interpose (approval before commit, or auto-commit only in explicitly sandboxed tasks).
6. **pip-scale optional surface** — voice, browser automation, doc scraping, watch mode, pypandoc… are scope creep for us; adopt the core (map, edits, costs, evals) and skip the periphery until proven needed.

---

## Sources

- https://github.com/Aider-AI/aider (overview, features)
- https://raw.githubusercontent.com/Aider-AI/aider/main/LICENSE.txt (Apache-2.0)
- https://raw.githubusercontent.com/Aider-AI/aider/main/pyproject.toml
- https://raw.githubusercontent.com/Aider-AI/aider/main/requirements/requirements.txt
- https://aider.chat/docs/repomap.html
- https://aider.chat/docs/more/edit-formats.html
- https://aider.chat/docs/leaderboards/
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/editblock_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/search_replace.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/models.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/analytics.py
- https://github.com/Aider-AI/aider/tree/main/aider and /tree/main/aider/coders (tree listings)
