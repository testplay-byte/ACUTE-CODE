# Aider — Architecture

Verified against the live repo (source tree `aider/`, `aider/coders/`) and aider.chat docs. Python codebase; entry point `aider = "aider.main:main"` in `pyproject.toml`.

## 1. High-level shape (CLI application)

```
                         ┌──────────────────────────────────────────────────────────┐
                         │                      aider.main:main                      │
                         │   typer CLI (args.py, ~200 options) · onboarding · urls   │
                         └───────────────┬──────────────────────────────────────────┘
                                         │ creates
         ┌───────────────────────────────┼───────────────────────────────────────┐
         ▼                               ▼                                       ▼
┌─────────────────┐            ┌──────────────────┐                    ┌────────────────────┐
│ io.py           │            │ models.py        │                    │ repo.py (GitPython)│
│ InputOutput:    │            │ Model(ModelSettings)                  │ GitRepo: dirty     │
│ input, output,  │            │ model-settings.yml│                    │ check, commit,     │
│ tool_error, ... │            │ + ModelInfoManager│                    │ diff, undo, commit │
│ (tty / GUI /    │            │ (prices, 24h TTL  │                    │ message via weak   │
│  web variants)  │            │  cache of litellm │                    │ model              │
└────────┬────────┘            │  price JSON)      │                    └─────────┬──────────┘
          │                     └────────┬─────────┘                              │
          ▼                              ▼                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Coder  (aider/coders/base_coder.py — the agent loop)                                │
│  run() → get_input() → run_one() → send_message()                                   │
│   • format_chat_chunks → ChatChunks(system, repo-map, readonly, chat files, reminder)│
│   • sendchat.send → litellm.completion (streaming, reasoning-tag handling)           │
│   • get_edits / apply_edits_dry_run / allowed_to_edit / apply_edits                  │
│   • auto_commit(edited)  • auto-lint → auto-test → reflection loop (≤3)              │
│   • ChatSummary (history.py): background summarization when history too big          │
│   • per-exchange token+cost report; session totals                                  │
└───────┬──────────────────────────────┬──────────────────────────────┬───────────────┘
        ▼                              ▼                              ▼
┌────────────────┐          ┌─────────────────────┐       ┌──────────────────────┐
│ repomap.py     │          │ Edit-format coders  │       │ linter.py / commands │
│ RepoMap: tags  │          │ EditBlockCoder      │       │ flake8+tree-sitter   │
│ (grep-ast /    │          │ WholeFileCoder      │       │ lint, /run /test     │
│ tree-sitter),  │          │ UnifiedDiffCoder,   │       │ /undo /diff /tokens  │
│ PageRank graph │          │ ArchitectCoder +    │       │ /cost /map /clear ...│
│ (networkx),    │          │ editor variants,    │       │ (commands.py)        │
│ diskcache      │          │ AskCoder, Help...   │       └──────────────────────┘
└────────────────┘          └─────────────────────┘
```

Key structural facts:

- **Package layout** (`aider/`): `main.py`, `args.py`, `io.py`, `models.py`, `sendchat.py`, `repomap.py`, `repo.py`, `linter.py`, `commands.py`, `history.py`, `analytics.py`, `llm.py` (+ FastAPI local server for the weak/editor model), `watch.py`/`watch_prompts.py` (watch mode), `voice.py`, `scrape.py`, plus `coders/` (38 files), `queries/` (tree-sitter `.scm` query files), `resources/`.
- **Coder class hierarchy**: `base_coder.Coder` is the loop; one subclass per edit format — `editblock_coder` (diff), `editblock_fenced_coder` (diff-fenced), `wholefile_coder`, `udiff_coder` (+ `udiff_simple`), `architect_coder` (delegates editing to an editor model using `editor_editblock_coder` / `editor_whole_coder`), `ask_coder`, `help_coder`, `context_coder`, `patch_coder`, plus legacy "func" variants. `Coder.create(main_model, edit_format, io, ...)` factory.
- **Model routing**: `models.Model` copies fields from `model-settings.yml` (mergeable with user YAML); selects default `edit_format`, `use_repo_map`, `use_temperature`, `extra_params`, `reminder`, weak/editor models. Pricing comes from litellm's `model_prices_and_context_window.json` cached 24 h under `~/.aider/caches/`, with OpenRouter scrape fallback.
- **Chat state**: `done_messages` / `cur_messages` / `summarized_done_messages`; `.aider.chat.history.md` chat log + `.aider.input.history` on disk; `ChatChunks` (chat_chunks.py) splits prompt into system / repo-map / readonly-files / chat-files / reminder parts so token accounting is per-component.

## 2. Repo map construction (`aider/repomap.py`, verified in source)

1. **Tag extraction (grep-ast + tree-sitter).** Per file: `filename_to_lang` → load parser → load language-specific tags query (`.scm` under `aider/queries/`). Captures with prefix `name.definition.*` become `Tag(kind="def")`, `name.reference.*` become `Tag(kind="ref")` — `Tag = namedtuple("Tag", "rel_fname fname line name kind")`. Languages with defs but no ref queries (e.g. C++) get references backfilled via pygments name tokens.
2. **Caching.** `get_tags` uses a `diskcache.Cache` (`.aider.tags.cache.v{CACHE_VERSION}`) keyed by filename, invalidated by mtime; on SQLite errors it deletes/recreates the cache, then falls back to an in-memory dict.
3. **Graph.** `get_ranked_tags` builds a `networkx.MultiDiGraph`: files are nodes; for each identifier, edges run referencer→definer. Edge weight = `use_mul * sqrt(num_refs)` with multipliers: identifiers mentioned in chat ×10; snake/kebab/camel identifiers ≥8 chars ×10; leading-underscore idents ×0.1; idents defined in >5 files ×0.1; references from chat files ×50. Unreferenced definitions get 0.1-weight self-edges.
4. **Personalized PageRank.** `nx.pagerank(G, weight="weight", personalization=..., dangling=...)` where chat files, mentioned files, and files matching mentioned identifiers get `100/len(fnames)` personalization (so the map leans toward the current conversation). Each node's rank is then distributed across out-edges proportionally to weight, accumulating `ranked_definitions[(file, ident)]`.
5. **Budget fitting.** `get_ranked_tags_map` binary-searches how many top-ranked tags fit: starts at `max_map_tokens // 25`, renders with `TreeContext` (grep-ast; lines-of-interest + surrounding context, lines truncated to 100 chars), estimates tokens (sampling ~100 lines for long texts), accepts when within 15% error. Result memoized (`map_cache`/`last_map`, refresh modes auto/manual/drop/files).
6. **Defaults.** `--map-tokens` defaults to 1k; model-driven sizing via `get_repo_map_tokens()` = `max_input_tokens/8` clamped to 1024–4096; budget multiplied up (`map_mul_no_files`) when no files are in chat yet. Output: a compact per-file outline of the most-referenced classes/functions with signatures and key definition lines.

## 3. Edit-format pipeline

Formats (docs + source): `whole` (full file rewrite), `diff` (SEARCH/REPLACE blocks, default for strong models), `diff-fenced` (path inside fence, for Gemini), `udiff` (simplified unified diff, for GPT-4 Turbo to curb "lazy coding"), `editor-diff`/`editor-whole` (architect mode: architect model instructs, editor model edits), `patch` (apply-patch style). `models.py` picks the default per model via exact-then-substring YAML rules.

**Application ladder for `diff` blocks** (`editblock_coder.py`):

1. **Parse**: regexes for `<{5,9} SEARCH`, `={5,9}` divider, `>{5,9} REPLACE` (tolerant of marker-length drift). Filename from the 3 lines above the block: exact → basename → `difflib.get_close_matches` (cutoff 0.8) → last seen `current_filename`. ```bash fenced blocks are intercepted as shell commands instead.
2. **Apply, per block** via `replace_most_similar_chunk`: (a) exact line match; (b) uniform leading-whitespace shift tolerated (`replace_part_with_missing_leading_whitespace`); (c) one spurious leading blank line skipped; (d) `try_dotdotdots` supports `...` elisions inside SEARCH/REPLACE. A SequenceMatcher fuzzy rung (`replace_closest_edit_distance`, ratio ≥ 0.8, ±10% length) exists but is **currently disabled behind an unconditional `return`** in main.
3. **Multi-file fallback**: if a block fails on its named file, it is tried against every other chat file.
4. **Failure message**: raises `ValueError` with a structured "SearchReplaceNoExactMatch" report — the failed block, did-you-mean lines (`find_similar_lines`, ratio ≥ 0.6), whether REPLACE lines already exist in the file, whitespace guidance, and "The other N blocks were applied successfully. Don't re-send them."
5. **Reflection loop** (base_coder): the error text is fed back to the LLM; up to `max_reflections = 3`. After successful edits: `auto_lint` (flake8/basic/tree-sitter linter) and `auto_test` (user `test_cmd`) each optionally reflect their error output back the same way, each followed by an auto-commit ("Ran the linter" / "Ran tests"). `apply_edits_dry_run` gates real writes; every accepted edit round is auto-committed by `GitRepo` with an AI-generated commit message.

## 4. Chat / coder loop details (base_coder.py, verified)

- `run_one()` → `init_before_message` (records head SHA → `commit_before_message`) → preprocess input (`check_for_file_mentions`, `check_for_urls`, scrape web pages) → `send_message()`.
- Prompt assembly = `ChatChunks`: system prompt (fence/platform/shell prompts) + repo-map + readonly files + chat files (+images) + token-gated reminder; `warm_cache` may pre-warm provider caches in a background thread.
- Response handling: stream display incl. reasoning tags; `FinishReasonLength` triggers continuation; assistant reply appended, then `apply_updates` (dry-run → permission via `allowed_to_edit` → apply), `auto_commit`, `move_back_cur_messages`.
- **Context management**: `ChatSummary.summarize` (using weak+main models) runs in a background thread when `done_messages` exceeds `max_chat_history_tokens`; on `ContextWindowExceededError` aider prints exhaustion diagnostics and switches behavior.
- **Cost accounting**: per exchange, reads `completion.usage` (prompt/completion tokens, provider cache-hit fields), computes cost via `litellm.completion_cost` falling back to `compute_costs_from_tokens` (per-token prices; Anthropic cache write ×1.25, read ×0.10, DeepSeek cache-hit price), prints "Tokens: … sent / Cost: $x message, $y session", accumulates session totals, emits analytics event.
- **Telemetry**: `analytics.py` — PostHog events (enabled/disable/optin flags, default opt-in required), 10% rollout via UUID-hex threshold, model name redacted to first token, optional local JSONL log (`AIDER_ANALYTICS_LOG`); legacy Mixpanel path disabled.

## Sources

- https://github.com/Aider-AI/aider/tree/main/aider and /tree/main/aider/coders
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/editblock_coder.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/search_replace.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/models.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/aider/analytics.py
- https://raw.githubusercontent.com/Aider-AI/aider/main/pyproject.toml
- https://aider.chat/docs/repomap.html
- https://aider.chat/docs/more/edit-formats.html
