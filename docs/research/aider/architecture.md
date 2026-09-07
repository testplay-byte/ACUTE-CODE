<!-- last-reviewed: 2026-09-07 round-75 -->
# Aider — Architecture

All facts verified against the live repo (`main` branch) via raw file fetches and the aider.chat docs. Python codebase; entry point `aider = "aider.main:main"` (`pyproject.toml`); CLI surface defined with **argparse** in `aider/args.py` (`get_parser`) — not typer.

## 1. High-level shape (CLI application)

```
                          ┌────────────────────────────────────────────────────┐
                          │                 aider.main:main                     │
                          │      argparse CLI (args.py) · onboarding · urls     │
                          └───────────────┬────────────────────────────────────┘
                                          │ creates
          ┌───────────────────────────────┼───────────────────────────────────┐
          ▼                               ▼                                   ▼
 ┌─────────────────┐            ┌───────────────────┐               ┌────────────────────┐
 │ io.py           │            │ models.py         │               │ repo.py (GitPython)│
 │ InputOutput:    │            │ Model +           │               │ GitRepo: dirty     │
 │ input, output,  │            │ model-settings.yml│               │ check, commit,     │
 │ tool_error,     │            │ (edit_format,     │               │ diff, /undo via    │
 │ confirm_ask ... │            │ weak_model, ...)  │               │ commit_before_     │
 │ (terminal/GUI)  │            │ + litellm price   │               │ message; AI commit │
 └────────┬────────┘            │ JSON, 24h cache   │               │ messages           │
          │                     └─────────┬─────────┘               └─────────┬──────────┘
          ▼                               ▼                                   ▼
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ Coder  (aider/coders/base_coder.py, ~2500 lines — the agent loop)                  │
 │  run() → run_one() → send_message()                                                │
 │   • format_chat_chunks → ChatChunks(system, examples, readonly, repo-map, done,    │
 │     chat_files, cur, reminder) + Anthropic cache_control markers                   │
 │   • litellm.completion (streaming); retry w/ 0.125s→doubling backoff               │
 │   • get_edits → apply_edits_dry_run → prepare_to_edit (approval) → apply_edits     │
 │   • reflection loop (≤ max_reflections=3) on edit/lint/test failures               │
 │   • ChatSummary (history.py): background summarization on overflow                 │
 │   • per-exchange token + cost report; session totals; usage analytics event        │
 └───────┬──────────────────────────────┬─────────────────────────────┬───────────────┘
         ▼                              ▼                             ▼
 ┌────────────────┐          ┌──────────────────────┐    ┌────────────────────────┐
 │ repomap.py     │          │ Edit-format coders   │    │ linter.py / commands.py│
 │ RepoMap: tags  │          │ EditBlockCoder(diff) │    │ flake8 + tree-sitter   │
 │ (tree-sitter   │          │ EditBlockFenced,     │    │ lint; /run /test /lint │
 │ .scm queries), │          │ WholeFile, Patch,    │    │ /undo /diff /tokens    │
 │ MultiDiGraph + │          │ UnifiedDiff(+simple),│    │ /map /clear /commit ...│
 │ PageRank, bise │          │ Architect + editor   │    │ (in-chat commands)     │
 │ ct fit, disk-  │          │ variants, Ask, Help, │    └────────────────────────┘
 │ cache tags     │          │ Context (38 files)   │    benchmark/benchmark.py:
 └────────────────┘          └──────────────────────┘    225-task Exercism harness
```

Key structural facts (verified):

- **Coder class hierarchy** (`aider/coders/__init__.py` registry): `base_coder.Coder` is the loop; subclasses per edit format — `EditBlockCoder` (`edit_format="diff"`), `EditBlockFencedCoder`, `WholeFileCoder`, `PatchCoder`, `UnifiedDiffCoder` + `UnifiedDiffSimpleCoder`, `ArchitectCoder` with editor variants (`EditorEditBlockCoder`, `EditorWholeFileCoder`, `EditorDiffFencedCoder`), `ContextCoder`, plus non-editing `AskCoder`/`HelpCoder`. Factory: `Coder.create(main_model, edit_format, io, ...)` selects the class.
- **Model routing**: `aider/resources/model-settings.yml` — per model: `edit_format`, `weak_model_name`, `use_repo_map`, `lazy`, `reminder` (verified entries, e.g. `gpt-4-turbo: edit_format=udiff, use_repo_map=true, lazy=true`). `aider/models.py` caches litellm's `model_prices_and_context_window.json` in `~/.aider/caches/` with `CACHE_TTL = 60*60*24` (24h).
- **LLM access**: `aider/llm.py` is a `LazyLiteLLM` wrapper (defers the 1.5s litellm import), sets OpenRouter site/app env vars, `LITELLM_MODE=PRODUCTION`. `sendchat.py` enforces user/assistant alternation (inserting empty opposite-role messages) before sending.
- **Chat state**: `done_messages` / `cur_messages` / `summarized_done_messages`; `.aider.chat.history.md` on disk (filename verified in benchmark harness). `ChatChunks` (chat_chunks.py) splits the prompt into system / examples / done / repo / readonly_files / chat_files / cur / reminder, and `add_cache_control_headers()` marks chunk boundaries with Anthropic `cache_control: ephemeral` for prompt caching.

## 2. Repo map construction (`aider/repomap.py`, 867 lines — read in full)

1. **Tag extraction (tree-sitter).** Per file: language via `filename_to_lang`, parser via `grep_ast.tsl` (tree-sitter-language-pack), run the language's tags query; captures `name.definition.*` → `Tag(kind="def")`, `name.reference.*` → `Tag(kind="ref")`; `Tag = namedtuple("Tag", "rel_fname fname line name kind")`. Languages with defs but no ref query fall back to pygments name tokens as references.
2. **Caching.** `get_tags` uses `diskcache.Cache` at `.aider.tags.cache.v{CACHE_VERSION}`, keyed by filename, invalidated by mtime; SQLite errors trigger cache recreation, then an in-memory dict fallback. In-memory `map_cache`/`tree_cache`/`tree_context_cache` with refresh modes `auto/files/manual/always` (auto reuses cache unless the last build took >1s).
3. **Graph.** `get_ranked_tags` builds a `networkx.MultiDiGraph` — nodes are files; for each identifier shared between files, edges run referencer→definer with weight `= use_mul * sqrt(num_refs)` (sqrt dampens high-frequency mentions). Multipliers: identifier mentioned in the user's message ×10; snake/kebab/camel identifier ≥8 chars ×10; leading-underscore ×0.1; identifier defined in >5 files ×0.1; reference from a chat file ×50. Unreferenced definitions get 0.1-weight self-edges.
4. **Personalized PageRank.** `nx.pagerank(G, weight="weight", personalization=..., dangling=...)` with `personalize = 100/len(fnames)` given to chat files, mentioned files, and files whose path components match mentioned identifiers (so the map leans toward the current conversation); ZeroDivisionError fallback reruns without personalization. Each node's PageRank is distributed across its out-edges proportionally to weight → `ranked_definitions[(file, ident)]`; files already in chat are excluded from the map.
5. **Budget fitting.** `get_ranked_tags_map_uncached` binary-searches how many top-ranked tags to render: starts at `middle = max_map_tokens // 25`, renders via grep-ast `TreeContext` (definition lines + surrounding context, lines truncated to 100 chars), estimates tokens (samples every 100th line for long texts), accepts when within 15% of budget. "Important" files (README etc., `filter_important_files`) are prepended.
6. **Defaults & sizing.** `map_tokens=1024` default (`--map-tokens`); `map_mul_no_files=8` expands the map when no files are in chat yet; model-scaled default `Model.get_repo_map_tokens() = max_input_tokens/8` clamped to [1024, 4096]; base_coder warns when user sets map-tokens > 2× that.

## 3. Edit-format pipeline

Formats (docs + model-settings.yml): `whole` (full updated file in a fence), `diff` (SEARCH/REPLACE blocks; default for strong models), `diff-fenced` (path inside the fence; for Gemini-style models), `udiff` (simplified unified diff; used for GPT-4 Turbo to counter "lazy coding" elisions), `editor-diff`/`editor-whole` (architect mode: architect model writes plain-text change instructions, editor model converts to edits), `patch` (apply-patch style).

**Parse** (`editblock_coder.py::find_original_update_blocks`): tolerant regexes `^<{5,9} SEARCH`, `^={5,9}>?\s*$`, `^>{5,9} REPLACE`; filename from the 3 lines above the block — exact match → basename → `difflib.get_close_matches` (cutoff 0.8) → last-seen filename; ```` ```bash ```` blocks are intercepted as shell commands; fence is chosen dynamically to not collide with file content.

**Apply, per block** (`replace_most_similar_chunk`): (a) exact match; (b) whitespace-flexible (`perfect_or_whitespace`); (c) skip one spurious leading blank line; (d) `try_dotdotdots` handles `...` elisions inside SEARCH/REPLACE; failing blocks are retried against every other file in chat. A SequenceMatcher fuzzy rung (`replace_closest_edit_distance`, ratio ≥0.8) exists but is **deliberately disabled** behind an unconditional `return`. New file = empty SEARCH block; append = empty SEARCH against an existing file.

**Deeper fallbacks** (`search_replace.py`): `flexible_search_and_replace` cascades strategies — exact `search_and_replace` → `git_cherry_pick_osr_onto_o` (commit original/search/replace in a temp git repo, cherry-pick `--minimal`) → `dmp_lines_apply` (diff-match-patch in line mode) — each crossed with preprocessors (strip blank lines, `RelativeIndenter` indentation normalization, reversed lines).

**Failure → reflection**: `apply_edits` raises `ValueError` with a structured report: `SearchReplaceNoExactMatch` header, the failed block, did-you-mean lines (`find_similar_lines`, ratio ≥0.6), "REPLACE lines are already in file" detection, and "The other N blocks were applied successfully. Don't re-send them." `base_coder.apply_updates` catches it, increments `num_malformed_responses`, and sets `reflected_message`; `run_one` re-sends it to the LLM up to `max_reflections = 3`.

## 4. Chat / coder loop details (`base_coder.py` — verified)

- **Loop**: `run_one()` → `init_before_message` (records head SHA into `commit_before_message` for `/undo`) → preprocess input (`check_for_file_mentions` — offers to add mentioned files, incl. identifier→filename stem matches ≥5 chars; `check_for_urls` — offers to scrape pages) → `send_message()` → `apply_updates()` → auto-commit → lint/test.
- **Approval gate**: `prepare_to_edit` → `allowed_to_edit(path)` asks "Create new file?" / "Allow edits to file that has not been added to the chat?" before any write outside chat files.
- **Post-edit verification**: `auto_lint` (default **on**) runs `linter.py` (flake8 basic + tree-sitter basic-lint fallbacks); `auto_test` (default **off**) runs the user's test command; each failure prompts "Attempt to fix lint/test errors?" and feeds errors back as another `reflected_message`; each stage auto-commits ("Ran the linter", etc.).
- **Robustness**: LLM call retries with `retry_delay = 0.125`s doubling until `RETRY_TIMEOUT` for retryable litellm exceptions.
- **Context management**: `ChatSummary` (history.py) runs in a background thread when `done_messages` exceeds the token limit, summarizing with the weak model; messages validated for role alternation before send (`sendchat.sanity_check_messages`).
- **Cost accounting**: per exchange reads `completion.usage` (prompt/completion, cache-hit/write tokens); cost via `litellm.completion_cost` with fallback `compute_costs_from_tokens` (per-token prices; cache-hit ≈ 0.1× input price, Anthropic cache-write ×1.25); prints "Cost: $x message, $y session"; accumulates `total_cost`; emits a `message_send` analytics event with the full usage record.
- **Telemetry** (`analytics.py`): PostHog only (mixpanel code inactive), opt-in prompted to 10% of users (`PERCENT = 10`, UUID-hex threshold), anonymous uuid4 in `~/.aider/analytics.json` (`uuid`, `permanently_disable`, `asked_opt_in`), unknown model names redacted to `prefix/REDACTED`, optional local JSONL logfile; any PostHog error silently disables analytics.

## 5. Benchmark harness (`benchmark/benchmark.py`, 1059 lines — verified)

`run_test_real` per Exercism exercise: reads `.meta/config.json` (solution/test/example file sets) and `.docs/instructions*.md`, restores pristine solution files, then `for i in range(tries)`: run aider with the instructions → run the unit tests → if errors, set `instructions = errors` and retry. Metrics: pass-rate-1 (first attempt) vs pass-rate-2 (final), `% well-formed = 1 - malformed_responses/completed`, syntax/indentation-error counts, "lazy comment" counting (`^[+]? *[#].* [.][..] ` style regex), timeouts, durations; results per run in `.aider.results.json`, chat log in `.aider.chat.history.md`. The leaderboard page publishes model, edit format, exact command, aider version/commit, tokens and total cost per run.

## Sources

- https://github.com/Aider-AI/aider (README)
- https://github.com/Aider-AI/aider/tree/main/aider/coders (directory listing)
- https://api.github.com/repos/Aider-AI/aider/contents/benchmark
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/editblock_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/search_replace.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/udiff_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/chat_chunks.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/__init__.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/history.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/sendchat.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/analytics.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/models.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/llm.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/args.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/resources/model-settings.yml
- https://raw.githubusercontent.com/Aider-AI/aider/main/benchmark/benchmark.py
- https://aider.chat/docs/repomap.html
- https://aider.chat/docs/more/edit-formats.html
- https://aider.chat/docs/leaderboards/
- https://raw.githubusercontent.com/Aider-AI/aider/main/pyproject.toml
