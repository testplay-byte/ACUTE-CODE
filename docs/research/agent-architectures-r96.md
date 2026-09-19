<!-- last-reviewed: 2026-09-19 round-108 -->
# Agent architectures — the R96 research memo (Claude Code / Kilo Code / OpenCode / Cline / Aider / Goose)

**Why this exists (owner directive, R96 §0 item 16):** "Analyze any online
open-source agentic coding environments like Claude, Kilo Code, Open Code, and
such, which are popular and capable, so that we can look into them, work based
on them properly, handle things properly." This memo is workstream A; its
deliverable is the decision table at the bottom that feeds workstreams C
(tools: precision + power) and D (prompts + skills).

**Method.** Official documentation pages fetched live on 2026-09-13 via the
web-reader/search tooling, cross-checked against our own August-2026 reference
memos (`docs/research/*/`) where those already verified the source code, and
against our own tree where the decision touches ACUTE-CODE code (the read/edit/
search/skills implementation facts were re-verified at
`agent-core/src/tools/fs-ops.ts`, `plugins/filesystem.ts`, `plugins/search.ts`,
`plugins/skills.ts`, `agents/prompts.ts`, `agents/runtime.ts`, and the installed
`ai@7.0.73` package today). Anything not verified from a primary source is
marked **[UNVERIFIED]**. The Kilo "acquired by Anaconda" banner was live on
their docs during the fetch; Kilo's docs are mid-rename from "modes" to
"agents", which this memo reflects.

**Relationship to the Phase-0 memos.** `docs/research/{cline,opencode,kilocode,
aider,goose,hermes-agent,letta,openhands,metagpt,n8n}/` (verified 2026-08-21/22)
remain the deep source-level studies. This memo covers **what changed since**,
the two systems we had NOT covered at doc level (**Claude Code** and the
**Agent Skills open standard**), and the R96-specific comparisons (editing
model, search model, batching, skills discovery, completion discipline) the
earlier memos did not isolate. No code from any of these projects is copied —
pattern study only, as ADR practice has been all along.

---

## 1. What changed since our August 2026 memos (the 60-second delta)

1. **Kilo Code renamed "modes" → "agents"** and consolidated the tool
   surface to `read / glob / grep / edit / write / apply_patch / bash /
   webfetch / websearch / question / task / todowrite / todoread / plan /
   skill` (+ MCP namespaced tools + a Playwright MCP browser set). The legacy
   `read_file / write_file / replace_in_file / search_files /
   list_code_definition_names` names and their docs pages are retired (the
   legacy doc URLs now 404 — verified live). Orchestrator mode is formally
   **deprecated** in favor of the `task` subagent tool, confirming the
   delegation-as-task-tool convergence our memo predicted.
   (https://kilo.ai/docs/automate/tools,
   https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode)
2. **Cline consolidated around "ClineCore"** with a 7-tool built-in set —
   `bash`, `editor`, **`read_files` (batch multi-file read)**, `apply_patch`,
   `search` (ripgrep-powered), `fetch_web`, `ask_question` — and explicitly
   maps the old XML-style names (`read_file`, `replace_in_file`,
   `execute_command`) to "legacy". Tasks now run through a shared SDK session
   layer. (https://docs.cline.bot/tools-reference/all-cline-tools)
3. **OpenCode shipped a native `skill` tool + Agent Skills support**, an
   experimental LSP tool, and a `doom_loop` permission key ("Recovery prompts
   when an agent appears stuck" — direct prior art for our workstream B).
   grep/glob remain ripgrep-backed and .gitignore-respecting.
   (https://opencode.ai/docs/tools/, https://opencode.ai/docs/skills/)
4. **Agent Skills became an open standard** (agentskills.io — "originally
   developed by Anthropic, released as an open standard") with a formal
   frontmatter spec and a 3-stage progressive-disclosure model; Claude Code,
   OpenCode (`.claude/skills/` compatible), Kilo, and Cline all support some
   dialect of it.
5. **Claude Code's tool roster keeps growing platform-side** (Agent/Task tools,
   LSP, Monitor, ToolSearch, Workflow, skills listing budgets, PowerShell as a
   first-class Windows shell) — but its *core coding loop* (Read/Edit/Write/
   Bash/Grep/Glob + exact-match editing + parallel calls) is unchanged in
   substance, which is the strongest signal in this whole memo: the field has
   converged on that core and innovates at the edges.
6. **Claude Code now ships task-tracking tools OFF by default on newer models**
   (TaskCreate/TaskGet/TaskList/TaskUpdate replace TodoWrite there; "On newer
   models, Claude keeps track of multi-step work without a written checklist,
   and the tools' definitions and reminders take up context").
   (https://code.claude.com/docs/en/tools, "Task tool availability")

---

## 2. Claude Code (Anthropic) — the reference implementation

Sources: https://code.claude.com/docs/en/tools (fetched 2026-09-13),
https://code.claude.com/docs/en/skills,
https://code.claude.com/docs/en/memory,
https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use,
https://www.anthropic.com/engineering/claude-code-best-practices.

### 2.1 Tool list (2026 state, v2.1.x — names exactly as used in permission rules)

Core coding set (the part that matters for our workstream C):

| Tool | Semantics (one line) |
|---|---|
| Read | File contents with line numbers; whole file from start; PARTIAL-view notice + `offset`/`limit` when over the token limit |
| Edit | Exact string replacement (`old_string`→`new_string`), no regex/fuzzy; uniqueness or `replace_all` |
| Write | Create or fully overwrite a file |
| NotebookEdit | Jupyter cell edits keyed by `cell_id` (replace/insert/delete) |
| Bash | Per-command process; Claude-managed timeout (2 min default / 10 min ceiling); backgrounding |
| PowerShell | Native Windows shell variant (same rule format) |
| Grep | ripgrep-backed content search; 3 output modes; .gitignore-respecting |
| Glob | Name-pattern file search; mtime-sorted; 100-file cap with truncation flag |
| LSP | Definitions/references/type errors/hover/symbols via language servers |
| Agent (Task) | Subagent with its own context window; single text result back |
| Skill | Executes a SKILL.md in the main conversation |
| TodoWrite / TaskCreate/TaskGet/TaskList/TaskUpdate | Checklist management (model-generation dependent) |
| AskUserQuestion | Multiple-choice clarification with options |
| WebFetch / WebSearch | URL→markdown extraction via a small model / backend search |
| Monitor | Background watch (command lines or WebSocket) fed back as events |
| ToolSearch | Loads deferred tools when tool search is enabled |

Edge/platform tools that exist but don't concern us directly: Artifact,
Cron*, EndConversation, Enter/ExitPlanMode, Enter/ExitWorktree, ListAgents,
List/ReadMcpResourceTool, PushNotification, RemoteTrigger, ReportFindings,
ScheduleWakeup, SendFeedback, SendMessage, SendUserFile, ShareOnboardingGuide,
TaskOutput/TaskStop, WaitForMcpServers, Workflow.

### 2.2 The editing model (the exact-match doctrine)

From the tools reference, Edit tool behavior:

- **Exact string replacement only.** "It doesn't use regex or fuzzy matching."
- **Three checks before an edit applies:**
  1. **Read-before-edit** — the file must have been read in the conversation
     (a *partial* read with a PARTIAL view notice doesn't count; viewing via
     `cat`/`nl`/`bat`/`head`/`tail`/`sed -n 'X,Yp'`/`grep`/`rg` on a single
     file with no pipes also counts).
  2. **Match** — `old_string` appears exactly; "a single character of
     whitespace or indentation difference is enough to miss."
  3. **Uniqueness** — exactly one occurrence, or `replace_all: true`.
- **Stale-read relaxation (v2.1.208+):** a file changed on disk after the last
  read can still be edited when the anchor matches current content exactly and
  unambiguously; the result *notes* the other changes so Claude re-reads before
  edits that depend on surrounding content.
- **Write** requires the same read-before-overwrite for existing files
  (newer models relax it under the same conditions as Edit).
- **Failure is a hard stop** — no fuzzy fallback ladder at all. Reliability
  comes from the read-first discipline + the model retrying with a longer
  anchor, not from tolerant matching.

### 2.3 The search model

- **Grep** = ripgrep with its regex syntax (not POSIX grep); errors include
  ripgrep's diagnostic so the model can correct the pattern; three output
  modes — `files_with_matches` (default, paths only), `content` (file+line,
  with `offset` paging and the honest "No entries at this offset" answer),
  `count` (per-file counts + a total that covers even truncated entries);
  `glob` and `type` scoping (e.g. `py`, `rust`); `multiline: true` for
  cross-line patterns; **respects .gitignore** (a direct path bypasses it).
- **Glob** = name patterns with `**`; results sorted by modification time,
  capped at 100 files with a truncation flag the model can narrow against;
  does NOT respect .gitignore by default (opt-in env var).
- **No ranking, no repo map** in the Aider sense — Claude Code relies on the
  model steering Grep/Glob plus the LSP tool for symbol navigation
  (definitions, references, workspaceSymbol search), plus subagents
  (Explore-type) for broad fan-out investigation that keeps the main context
  clean.

### 2.4 Batching / parallel tool calls

From the platform parallel-tool-use page:

- An assistant turn may carry **several `tool_use` blocks**; Claude 4+ models
  "make parallel tool calls by default when a request benefits from multiple
  tools."
- **Execution order is the harness's choice** — "run the calls concurrently
  (Promise.all, asyncio.gather), sequentially in the order they appear, or in
  any combination"; independent read-only ops are usually safe in parallel.
- **Results return together**: one `tool_result` per `tool_use`, all in the
  next user message, matched by `tool_use_id`, placed before any text content.
  A call you choose not to run still returns a `tool_result` with
  `is_error: true` and a brief explanation ("Not executed: the preceding
  write_file call failed."). Computer-use/browser member tools are the
  exception: run sequentially, stop at first failure.
- **The recommended prompt line** (verbatim from the docs): "For maximum
  efficiency, whenever you need to perform multiple independent operations,
  invoke all relevant tools simultaneously rather than sequentially." The
  stronger `<use_parallel_tool_calls>` block adds: "when reading 3 files, run
  3 tool calls in parallel… Err on the side of maximizing parallel tool calls
  rather than running too many tools sequentially."
- One documented hazard (a GitHub issue, May 2026): cancelling a parallel
  batch when one tool errors can corrupt thinking blocks — batching wants
  careful failure semantics [UNVERIFIED — issue report only].

### 2.5 Large-file / large-project handling

- **Read:** whole file from the start by default; over the token limit →
  first page + PARTIAL notice telling the model how much it got and how to
  continue; an explicit offset+limit that can't fit returns an *error* with
  the guidance "use a smaller limit, or search with Grep"; empty file → honest
  "exists but empty" notice; offset past EOF → the line count. Images are
  returned as (downscaled) visual content; PDFs page-ranged ≤20 pages;
  notebooks refused over 100 MB with recovery guidance.
- **Bash output:** inline ceiling ~30,000 chars for valid results (then a file
  path + short preview the model can Read/Grep), ~10,000 for failures
  (head+tail excerpt); read-back window configurable to 150,000
  (`BASH_MAX_OUTPUT_LENGTH`) / 128,000 inline (`bashOutputMaxChars`); exit-1
  is a *benign* result for `grep/rg/find/diff/test/[`/`git diff`/`git grep`
  (no-match ≠ failure).
- **No repo map.** Context economy comes from: subagents (separate context
  windows returning summaries), `--add-dir` scoping, `/clear` discipline,
  auto-compaction, and per-task skills. The best-practices guide is explicit
  that "the context window is the most important resource to manage" and
  prescribes subagents for investigation + adversarial review + `/batch`
  fan-out (5–30 subagents, each in its own worktree) for large migrations.
- **CLAUDE.md** (project memory): hierarchy `~/.claude/CLAUDE.md` →
  `./CLAUDE.md`/`.claude/CLAUDE.md` → `CLAUDE.local.md` (gitignored
  personal), plus managed-policy org files; **loaded root→cwd, concatenated
  (not overriding)**; subdirectory files load on demand when Claude touches
  files there; `@path` imports (≤4 hops deep); `.claude/rules/*.md` with a
  `paths:` frontmatter for path-scoped rules; guidance "target under 200
  lines per CLAUDE.md"; AGENTS.md interop via a one-line
  `@AGENTS.md` import; auto-memory capped at first 200 lines / 25 KB.

### 2.6 The skills system (the model for our workstream D)

From https://code.claude.com/docs/en/skills:

- **Format:** a folder + `SKILL.md` (YAML frontmatter + markdown body);
  follows the Agent Skills open standard with Claude Code extensions.
  Frontmatter fields: `name`, `description` (+ `when_to_use` appended),
  `argument-hint`, `arguments`, `disable-model-invocation`,
  `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`,
  `context: fork`, `agent`, `background`, `hooks`, `paths` (glob-gated
  activation), `shell`, `metadata`, `license`, `compatibility`.
- **Discovery:** skills live at enterprise/personal/project/nested/plugin
  locations; a name-resolution precedence decides conflicts (enterprise >
  personal > project; plugin skills namespaced `/plugin:skill`).
- **The listing is budgeted:** "skill descriptions are loaded into context so
  Claude knows what's available" — the listing scales at **1% of the model's
  context window** (`skillListingBudgetFraction`), each skill's combined
  description+when_to_use is **capped at 1,536 characters**
  (`skillListingMaxDescChars`); when the listing overflows, Claude Code drops
  descriptions "starting with the skills you invoke least." `/skill-doctor`
  reports each skill's context cost and usage so you can turn off dead weight.
- **Progressive disclosure:** description always in context; full body loads
  only on invocation (by the user `/name` or by Claude via the Skill tool);
  supporting files (`reference.md`, `examples.md`, `scripts/`) are loaded
  only when the skill points at them. "Keep SKILL.md under 500 lines."
- **Lifecycle:** the rendered SKILL.md enters the conversation **as a single
  message and stays across turns**; identical re-invocation adds only an
  "already loaded" note; after auto-compaction the most recent invocation of
  each skill is re-attached, **first 5,000 tokens each, within a combined
  25,000-token budget**, filled most-recent-first.
- **Invocation control:** `disable-model-invocation: true` (manual-only —
  the description leaves the listing entirely), `user-invocable: false`
  (Claude-only background knowledge), plus `Skill(name)` permission rules.
- **Advanced patterns we can borrow cheaply:** dynamic context injection
  (`!`command`` runs before the body reaches the model),
  `${CLAUDE_SKILL_DIR}` path substitution, `allowed-tools` per-invocation
  grants, `context: fork` + `agent: Explore` for isolated skills, and the
  bundled `/verify` + `/run` + `/run-skill-generator` trio that records a
  per-project launch recipe as a committed skill.

### 2.7 System-prompt discipline highlights

From the best-practices guide (the official, citable version of the "precision
discipline" folklore):

- **Verification:** "Give Claude a check it can run… It's the difference
  between a session you watch and one you walk away from" — with an evidence
  rule: "Have Claude show evidence rather than asserting success: the test
  output, the command it ran and what it returned, or a screenshot."
- **Explore → plan → implement → commit** as the recommended workflow shape;
  "If you could describe the diff in one sentence, skip the plan."
- **Anti-failure patterns by name:** the kitchen-sink session, correcting over
  and over, the over-specified CLAUDE.md, the trust-then-verify gap, the
  infinite exploration — each with a prescribed fix.
- **Completion is the model's own stop:** the loop ends when the model stops
  calling tools (`stop_reason: end_turn`); there is no completion-phrase
  heuristic anywhere in the documented behavior. Verification is the user's
  check or a Stop hook, not a regex on the final message.
- A community mirror of the full prompt assembly (27 tool descriptions,
  Plan/Explore/Task subagent prompts, compaction prompts) is maintained at
  https://github.com/Piebald-AI/claude-code-system-prompts — useful reading,
  **[UNVERIFIED]** as an official source (it is a reconstruction, updated per
  version).

---

## 3. Kilo Code — the VS Code agent that renamed everything

Sources: https://kilo.ai/docs/automate/tools,
https://kilo.ai/docs/automate/how-tools-work,
https://kilo.ai/docs/customize/custom-modes,
https://kilo.ai/docs/automate/tools/semantic-search,
https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode (deprecated
notice). The legacy SEARCH/REPLACE `replace_in_file` docs are gone from the
live site (404 — verified); the format itself remains documented in our
`docs/research/kilocode/` memo (verified at source level 2026-08-21).

### 3.1 Tool list (2026)

| Tool | Semantics |
|---|---|
| read | File contents with line numbers |
| glob | Files by glob pattern |
| grep | Content search with regex |
| edit | "Makes precise text replacements in a file" (the successor of replace_in_file) |
| write | Create new files or fully overwrite |
| apply_patch | Unified diffs ("used with certain models") |
| bash | Shell commands with configurable timeout + working dir |
| webfetch / websearch | URL fetch / web search (Exa or Parallel providers) |
| kilo-playwright_* | Browser automation via built-in Playwright MCP |
| {server}_{tool} | MCP tools, namespaced |
| question | Clarifying question with selectable options |
| task | Sub-agent child session (foreground or `background: true`) |
| todowrite / todoread | Session task lists |
| plan | Structured planning mode |
| skill | Invokes a reusable skill (Markdown instruction module) |
| agent_manager | VS Code worktree/local session manager |
| board_post / board_read | Experimental shared message board ("Kilo Swarm") |

Notable line from the tools overview: **"For multiple replacements in one
file, Kilo uses repeated edit calls or a patch-style edit when the model
supports it."** — i.e. even Kilo, the house that built the diff-edit UX,
treats multi-edit as *repeated single edits* or a patch format, not a
fuzzy-matching mega-tool.

### 3.2 Modes → agents; permissions

- Terminology moved from "modes" to "agents" (Code, Ask, Plan, Debug as the
  core four; Architect→Plan, Build→Code in the legacy migration map).
  Orchestrator mode is deprecated — "agents with full tool access now support
  subagents natively."
- Custom agents are markdown files (`.kilo/agents/*.md`) or `kilo.jsonc`
  entries with `mode: primary|subagent|all`, `permission` rules with **glob
  patterns, ordered, last-match-wins** (`edit: {"*.md": "allow", "*": "deny"}`),
  pinned `model`, `temperature`, `steps` (iteration cap that forces a
  text-only summary), and config precedence built-in → global → project →
  `.kilo/` → env.
- **Everything defaults to "ask"** — "No tools are auto-approved out of the
  box" (a direct answer to Cline's permissive-defaults anti-pattern).

### 3.3 The editing model (legacy format + today)

- The legacy `replace_in_file` SEARCH/REPLACE block format (the
  `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` triple with START/END
  markers and auto-formatting hazards) is documented in our kilocode memo;
  today's public tool list presents only `edit` (precise text replacement)
  and `apply_patch` (unified diff). The docs no longer publish the block
  format's spec [live-spec UNVERIFIED beyond the tool table].
- Their engineering blog ("Improving Diff Edits by 10%", June 2025) frames
  diff-edit reliability as an ongoing measurable problem — `write_to_file`
  fallbacks and whitespace-breaking auto-formatting are the cited failure
  classes (https://cline.bot blog cross-reference; the Kilo post itself is
  https://kilo.ai blog content) [UNVERIFIED — cited via search snippets].

### 3.4 Search + the semantic tier

- Baseline search = `glob` + `grep` (regex) + `read`, all ask-gated.
- **`semantic_search`** (part of Codebase Indexing, opt-in): embedding
  provider (OpenAI or Ollama) + **Qdrant** vector DB + tree-sitter chunking;
  natural-language query, optional `path` scope; results = file path +
  similarity score (default threshold 0.4, configurable; ≤50 results) + line
  range + code chunk; dual output (structured text for the model, JSON for
  the UI); files <1 MB. This is the only mainstream "smart search" that goes
  beyond ripgrep — and it is *opt-in infrastructure*, not the default path.

---

## 4. OpenCode — the provider-agnostic terminal agent

Sources: https://opencode.ai/docs/tools/, https://opencode.ai/docs/agents/,
https://opencode.ai/docs/skills/ (fetched 2026-09-13; "© Anomaly,
Last updated: Sep 13, 2026").

### 4.1 Tool list

| Tool | Semantics |
|---|---|
| bash | Shell commands in the project environment |
| edit | "Modify existing files using exact string replacements… the primary way the LLM modifies code" |
| write | Create new files or overwrite (gated by the `edit` permission together with `apply_patch`) |
| read | File contents; "supports reading specific line ranges for large files" |
| grep | Content search, full regex + file-pattern filtering (ripgrep under the hood, .gitignore respected; `.ignore` re-includes) |
| glob | Files by pattern, "sorted by modification time" |
| lsp (experimental) | goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / goToImplementation / call hierarchy (behind `OPENCODE_EXPERIMENTAL_LSP_TOOL=true`) |
| apply_patch | Patch files with `*** Add/Update/Move/Delete File:` marker lines (patchText, paths relative to project root) |
| skill | "Load a skill (a SKILL.md file) and return its content in the conversation" |
| todowrite | Task lists (disabled for subagents by default) |
| webfetch / websearch | Fetch / search (websearch only on their provider or via Exa/Parallel env flags) |
| question | Ask the user (header + question + options; multi-question batches) |
| (list, task) | Present as permission keys; `task` invokes subagents, with `permission.task` glob control over which subagents an agent may run |

Custom tools are config-declared functions; MCP servers add
`{prefix}_*` tools gated by the same permission system (wildcards allowed).

### 4.2 Agents, loop, permissions

- **Primary agents:** Build (all tools) and Plan (edit/bash "ask" — analysis
  without modification). **Subagents:** General (full tools minus todo),
  Explore (read-only, fast), Scout (external docs / dependency research,
  clones into a managed cache). Hidden system agents: compaction, title,
  summary. Switch with Tab or `@mention`; subagents spawn child sessions you
  can navigate (parent/child keybinds).
- **The loop:** `steps` (max iterations) forces a text-only response with a
  "special system prompt instructing it to respond with a summarization of
  its work and recommended remaining tasks" — a clean completion discipline:
  the model stops, or the budget stops it, no phrase-matching.
- **Permissions:** `"allow" | "ask" | "deny"` per tool key, **glob patterns
  matched against the tool name**, `edit` covering write+apply_patch, bash
  command-level patterns (`"git push": "ask"`, `"grep *": "allow"`) with
  last-match-wins, per-agent overrides, and a `doom_loop` key for
  stuck-agent recovery prompts.
- Known model-behavior gap (their tracker, Feb 2026): agents "favor bash,
  ignoring grep and glob tools" and shell out to `rg`/`grep` instead —
  tool-choice guidance in the prompt is not optional
  (https://github.com issue #14791) [UNVERIFIED — issue title/snippet only].

### 4.3 Skills (the discovery pattern worth copying)

- Locations: `.opencode/skills/<name>/SKILL.md` (project) +
  `~/.config/opencode/skills/` (global), **plus Claude-compatible
  `.claude/skills/` and `.agents/skills/`** — they adopted the standard's
  locations rather than inventing their own.
- Discovery: walk up from cwd to the git worktree loading any matching
  skills; frontmatter `name` + `description` required (name regex
  `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 chars, must match the directory;
  description 1–1024 chars), `license`/`compatibility`/`metadata` optional,
  unknown fields ignored.
- **The listing lives in the tool description:** the `skill` tool's
  description embeds an `<available_skills>` block (name + description per
  skill); the agent loads one by calling `skill({ name })`. Skill access is
  permission-gated with the same allow/ask/deny pattern globs, per agent.
- No body search — discovery is description-only (same as Claude Code's
  listing, minus the budget machinery).

---

## 5. Cline — plan/act, checkpoints, and the smallest tool surface

Sources: https://docs.cline.bot/tools-reference/all-cline-tools,
https://docs.cline.bot/features/plan-and-act,
https://docs.cline.bot/features/auto-approve,
https://docs.cline.bot/core-workflows/checkpoints.

### 5.1 Tools (ClineCore, 2026)

| Tool | Semantics |
|---|---|
| bash | Execute shell commands |
| editor | View and edit files |
| read_files | **Batch read multiple files** |
| apply_patch | Apply unified diffs to files |
| search | Ripgrep-powered codebase search |
| fetch_web | HTTP with HTML→markdown |
| ask_question | Ask the user for input |

"The model decides which tool to call, Cline runs it, then returns results
back to the model." Legacy XML-style names (`read_file`, `replace_in_file`,
`execute_command`) are explicitly mapped to the current runtime names —
**the SEARCH/REPLACE diff format our memo documented is legacy Cline
surface, retained for compatibility but no longer the documented core.**
Custom tools are plugin-registered (SDK/CLI/Kanban only), MCP rides alongside.

### 5.2 Editing model

Current docs describe `editor` + `apply_patch` without publishing a fuzzy
ladder; the historical SEARCH/REPLACE + diff-strategy behavior (with the
model marking commands `requires_approval`, auto-formatting breaking diff
matches, and "10% better diff edits" engineering work) is covered in our
`docs/research/cline/` memo. The trend line across Cline 2024→2026 is the
same as everyone's: exact-match anchors + structured failure + editor-side
diff rendering, with batch reads (`read_files`) to compensate for one-at-a-time
cost.

### 5.3 Plan/Act, approvals, checkpoints

- **Plan/Act:** Plan mode = read/search/discuss, no mutation; Act = execute;
  history carries across the switch; per-mode model selection is first-class
  (strong reasoner for Plan, fast model for Act); `/deep-planning` for large
  tasks; task-size guidance (small = Act-only, medium = Plan→Act, large =
  deep-planning).
- **Auto-approve tiers:** read project files / read all files / edit project
  / edit all / execute safe commands / execute all commands / browser / MCP /
  notifications — each an independent toggle; **safe-vs-approval-required is
  decided per command by the model's `requires_approval` flag** (examples:
  `npm run build` safe; `npm install`, `rm -rf`, `sed -i` require
  approval), not a fixed allowlist. YOLO mode = auto-approve everything
  (their own docs label it dangerous).
- **Checkpoints:** a **shadow git repository** (separate from the project's
  real git), a commit **after every tool use**, per-file snapshots, a diff
  viewer per checkpoint, and three restore modes — files only / task
  (conversation) only / both. Checkpoints + auto-approve is their stated
  formula for autonomy ("the cost of a mistake drops to nearly zero").
  Caveat documented: large repos pay a storage/perf cost.

---

## 6. Aider — the edit-format laboratory

Sources: https://aider.chat/docs/more/edit-formats.html,
https://aider.chat/docs/repomap.html,
https://aider.chat/docs/troubleshooting/edit-errors.html, plus our
source-verified `docs/research/aider/` memo (2026-08-21) for the ladder
internals.

### 6.1 Edit formats (per model)

- **whole** — full updated file in a fence (path just above it). Simplest,
  slowest, most reliable for weak models.
- **diff** — SEARCH/REPLACE blocks in git-merge-conflict-like markers
  (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`), path before the fence.
- **diff-fenced** — path inside the fence (Gemini-family fencing issues).
- **udiff** — simplified unified diff (created for GPT-4 Turbo's "lazy
  coding" elision tendency: `-class MathWeb:` / `+import sympy…`).
- **editor-diff / editor-whole** — architect mode: the architect model
  writes plain-text change instructions; a separate editor model converts
  them to edits.
- Model→format mapping lives in `model-settings.yml`; `--edit-format`
  overrides. The troubleshooting page's ladder for edit failures: add fewer
  files (context >~25k tokens degrades format compliance), use `/drop` and
  `/clear`, use a stronger model, fall back to `--edit-format whole`, or use
  architect mode.

### 6.2 The application ladder + reflection (source-verified in our memo)

Per block, `replace_most_similar_chunk`: **(a)** exact match → **(b)**
whitespace-flexible (`perfect_or_whitespace`) → **(c)** skip one spurious
leading blank line → **(d)** `try_dotdotdots` (`...` elisions inside
SEARCH/REPLACE); failing blocks are retried against every other chat file.
Deeper fallbacks (`flexible_search_and_replace`) cascade exact →
git-cherry-pick-in-a-temp-repo → diff-match-patch line mode, each crossed
with preprocessors (strip blank lines, relative-indent normalization,
reversed lines). **The SequenceMatcher fuzzy rung exists but is deliberately
disabled** behind an unconditional return — speculative matching corrupts
code and destroys auditability.

**Failure → reflection:** `apply_edits` raises a structured
`SearchReplaceNoExactMatch` report (failed block + did-you-mean lines at
similarity ≥0.6 + "REPLACE lines are already in file" detection + "The
other N blocks were applied successfully. Don't re-send them.") fed back to
the LLM, **up to `max_reflections = 3`**; lint (default on) and tests
(opt-in) feed the same loop; `apply_edits_dry_run` precedes real writes;
`allowed_to_edit` asks the human before touching files not in chat; every
accepted round auto-commits.

### 6.3 Repo map (large-project handling)

Tree-sitter def/ref tags → a weighted file graph → **personalized PageRank**
(seed = the files in the chat) → binary-search the rendered outline into a
token budget (**`--map-tokens` default 1k**, scaled to max_input/8, clamped
1024–4096). The map shows files with their key class/function signatures and
"⋮…" elisions; it expands when no files are in the chat. It is sent with
every change request — this is the only system of the five that does
symbol-graph context budgeting as a first-class mechanism.

---

## 7. Goose (Block) — brief

The extension model is MCP-native: extensions bring tools/resources/prompts
via MCP servers (70+ curated extensions), the agent runs as a Rust daemon
(`goosed`) behind desktop/CLI clients, and permissions are layered with
remembered arg-scoped grants (`tool:hash(args)`) plus a SQLite usage ledger
with cost provenance — all verified in our `docs/research/goose/` memo
(2026-08-21). Live doc URLs rotate (the current extensions page is
https://block-goose.mintlify.app/extensions via search; our earlier fetches
of the github-pages docs 404 now) [partially UNVERIFIED — cited from search
results + our memo]. Nothing in Goose changes the R96 C/D decisions; its
lesson remains "sidecar lifecycle + MCP everywhere," which we already
absorbed.

---

## 8. Cross-system comparison (the R96 view)

| Dimension | Claude Code | Kilo Code | OpenCode | Cline | Aider |
|---|---|---|---|---|---|
| Edit primitive | exact old/new (+`replace_all`) | `edit` exact + `apply_patch` | `edit` exact + `apply_patch` | `editor` + `apply_patch` (+ legacy SEARCH/REPLACE) | SEARCH/REPLACE blocks / whole / udiff per model |
| Fuzzy fallback | **none** | none documented | none | none documented | ladder: whitespace → blank-line → `...` elision → (dmp/cherry-pick); fuzzy rung disabled |
| Multi-edit | repeated Edit calls (MultiEdit historically) | "repeated edit calls or a patch-style edit" | repeated `edit` | apply_patch | multiple blocks per response |
| Read model | whole-file-first + PARTIAL paging + honest errors | read w/ line numbers | read + line ranges | `read_files` **batch** | whole files added to chat by the user/agent |
| Content search | Grep (ripgrep, 3 output modes, gitignore) | grep regex (+ optional semantic_search w/ Qdrant) | grep regex (ripgrep, gitignore) | `search` (ripgrep) | repo map (PageRank) + /grep-ish via chat |
| File search | Glob (mtime, 100 cap, truncation flag) | glob | glob (mtime) | via search | repo map |
| Symbol layer | LSP tool | tree-sitter (indexing) + semantic_search | LSP (experimental) | — | tree-sitter repo map |
| Batch calls | multiple tool_use per turn; parallel by default (Claude 4+); results batched in one user message | multiple tool calls per turn (standard) | multiple; subagents `@`-parallel | read_files batch tool; parallel calls | single response carries many blocks |
| Large projects | subagents + worktrees + /batch fan-out + compaction | semantic search + subagents | subagents (Explore/Scout) + compaction agent | checkpoints + plan/act | **repo map (token-budgeted PageRank)** |
| Skills | SKILL.md + budgeted listing + context:fork | skill tool (markdown modules) | skill tool w/ listing in tool description | Rules + skills | — (/commands + conventions file) |
| Completion discipline | model stops calling tools (end_turn); Stop hooks as gates | model stops; `steps` cap forces summary | model stops; `steps` cap forces summary text | model stops; plan/act cycle | model stops; reflection bounded ≤3 |
| Approval default | read tools no-prompt; Bash/Edit prompt (manual mode) | **everything asks** | allow by default, configurable | toggles + model-judged safe commands | `allowed_to_edit` gate |

**The convergence verdict:** every mature system (a) uses exact-match
anchored edits with hard failures, (b) treats a tool-less assistant message
as the completion signal, (c) runs a step's tool calls in parallel when the
model emits them, (d) keeps search = ripgrep-style regex + gitignore with
optional symbol/semantic layers on top, and (e) lists skills by
name+description and loads bodies on demand. The differentiators are
tolerance ladders (Aider only), repo maps (Aider only), checkpoints
(Cline/Claude), and skills budgets (Claude Code only).

---

## 9. What ACUTE-CODE should adopt (R96 decisions)

Grounding (our current state, re-verified today): `read_file` is
line-numbered with `offset`/`limit`, returns the whole file ≤256 KB
(`MAX_READ_BYTES`), head 32 KB + tail 32 KB + honest continuation marker
beyond; `edit_file` is single exact `oldString`/`newString`, fails on 0 or
>1 matches, with the R71 edit-streak escalation (2nd/3rd–4th/5th+ tiers);
`search_code` is single-line substring/regex with
case/whole_word/file_glob/max_results (50 default, 200 cap), 120-char
trimmed lines, static `IGNORED_DIRS`, depth 8 / 500 entries, **no .gitignore,
no context lines, no output modes, no match paging**; `search_files` is a
path-substring match; skills are DB-stored with name+description in the
prompt + `read_skill` (name + reference, 2-level progressive disclosure) +
R72 task hints; the runtime already executes one step's tool calls via
`Promise.all` (verified in the installed `ai@7.0.73` dist — the internal
`executeTools` helper wraps the step's calls in `Promise.all`), and
`continueIfUnfinished` re-calls the provider when
the final text lacks a `COMPLETION_SIGNAL` phrase (the R96-0 root cause).

### 9.1 The prioritized adopt/reject table (workstreams C + D)

| # | Decision | Source pattern | Priority | WS |
|---|---|---|---|---|
| 1 | **Completion = tool-less assistant message.** Kill the `COMPLETION_SIGNAL` phrase heuristic; end the turn when the model produces text and no tool calls; never re-call the provider with an assistant-last history (the DeepSeek "role=user" crash) | Claude Code / OpenCode / Cline / Kilo all stop on the model's own stop | **P0** | B/D |
| 2 | **Batching guidance in the main prompt** + keep SDK parallel execution; assert one event per call in the audit log (already true) | Anthropic's `<use_parallel_tool_calls>` language, adapted | **P0** | C |
| 3 | **read_file whole-file-first description + budget-linked head/tail**: description says "read whole; page only from the marker"; make the whole-read budget explicit and model-context-aware rather than a flat 256 KB | Claude Code Read (whole-file default, PARTIAL notice, honest errors) | **P0** | C |
| 4 | **edit_file multi-edit** (array of `{oldString,newString,replaceAll?}`), validated in order against the evolving buffer, atomic (all anchors pre-verified, one write), first-failure reported with the edit index | Kilo's "repeated edits" + Claude Code MultiEdit history | **P0** | C |
| 5 | **Edit fallback ladder (exact → whitespace-normalized) + structured did-you-mean error** ("N other edits not applied", nearest-line suggestions), never fuzzy-apply | Aider's ladder minus the disabled fuzzy rung | **P1** | C |
| 6 | **Unified diff in edit results** (before/after hunks) so workstream H can render red/green without re-reading | everyone's editor-side diffs | **P1** | C/H |
| 7 | **search_code: output modes (`files_with_matches` default, `content` with `-C` context lines, `count`), .gitignore respect + `.ignore` re-include, per-file grouped results, match-offset paging with honest no-entries notice, total-count with truncation flag** | Claude Code Grep | **P0** | C |
| 8 | **search_files: glob patterns (`**/*.ts`) + mtime sort + cap-with-truncation-flag** (keep substring as the degenerate mode) | Claude Code Glob | **P1** | C |
| 9 | **read-only tool calls run parallel by default; approval-gated calls serialize** (one approval card at a time) — a concurrency class distinction inside the executor, not a prompt change | Anthropic's "independent read-only ops are safe in parallel" + Cline's tiering | **P1** | C |
| 10 | **search_skills tool**: query over skill names, descriptions, reference names (and optionally cached body text); returns name+description+reference list with an honest "no matches"; prompt keeps a **budget-capped** name+description listing (cap the section ~2 KB; overflow drops to names-only for least-recently-used) | Claude Code skill listing budget (1% of context, 1536-char entries) + OpenCode's listing-in-tool-description | **P1** | D |
| 11 | **New seeded skills: planning, UI work, error-testing, large-project navigation** — methodology modules loaded via read_skill, NOT prompt sections | Claude Code bundled skills (/verify, /run) | **P1** | D |
| 12 | **Prompt precision section upgrade**: FILE EDITING RULES gains the Claude Code trio verbatim-equivalents (read-before-edit counts only a real read; one whitespace char breaks the match; include enough surrounding lines to be unique — or `replaceAll`) + "prefer edit_file over write_file for partial changes" | Claude Code Edit docs | **P0** | D |
| 13 | **Verification-before-done prompt section**: "show evidence, not assertions" (run the check, paste the exit code/output, iterate until pass) — folded into ENGINEERING DISCIPLINE | Anthropic best practices | **P1** | D |
| 14 | **Skill listing lifecycle**: re-invocation of identical content returns "already loaded" (cheap dedupe note); compaction re-attaches the most recent body of each active skill within a small budget | Claude Code skill lifecycle | **P2** | D |
| 15 | **Loop guard: raw-args comparison + warn-only** (the R96-0 fix) — OpenCode's `doom_loop` permission key shows recovery prompts are a tool-class concern | OpenCode doom_loop; owner directive | **P0** | B |
| 16 | **SKILL.md-compatible import/export for skills** (Agent Skills frontmatter as an interchange format), keeping DB storage internal | Agent Skills open standard | **P2** | D |
| 17 | **REJECT: fuzzy/SequenceMatcher edit application** | Aider deliberately disabled it | — | C |
| 18 | **REJECT: repo map (tree-sitter + PageRank) for R96** — keep `index_project` + injected summary; revisit only if the live-fire (workstream J) shows navigation failures on ~300-file projects | Aider (great but big) | — | C |
| 19 | **REJECT: semantic/embedding search for R96** (Kilo's Qdrant path) — infra-heavy; `search_code` upgrades + index are enough for this round | Kilo semantic_search | — | C |
| 20 | **REJECT: shadow-git checkpoints** — our per-edit `recordSnapshot` before/after store already covers restore; render it instead (WS H) | Cline checkpoints | — | H |

### 9.2 The opinionated notes the table compresses

**(a) read_file whole-file default.** The 256 KB cap is not the problem —
files under it ALREADY return whole; the problem is the description tells
the model to page ("page through with offset… instead of re-reading the
whole file"), and 256 KB ≈ 64k tokens can blow a free model's 32–64k
window. Adopt Claude Code's shape: whole-file by default under a
**context-aware budget** (start: ~48 KB / ~12k tokens for unknown models;
larger when the model's context is known — the estimator we already have
can drive it), PARTIAL-style marker with the exact continuation call beyond
it, and a description that says "read the whole file first; page only when
the result carries the truncation marker." Keep the single-line byte-slice
honesty (it's better than Claude Code's documented behavior on that edge).

**(b) edit_file multi-edit + fallback ladder.** Take Claude Code's strict
semantics as the contract (exact, unique-or-replaceAll, read-before-edit)
and Aider's *diagnostics* as the failure UX (which edit failed, nearest
lines, "the other N edits were not applied"). Atomicity: pre-validate every
anchor in sequence against the simulated buffer, then one write — a partial
multi-edit is unauditable and our snapshot/revert story keys on whole-file
states. The ladder: exact → whitespace-normalized (report that it matched
normalized, and still require post-normalization uniqueness) → structured
error with did-you-mean. Stop there. The git-cherry-pick and diff-match-patch
rungs are clever engineering Aider needed for weak 2023–24 models; our
models + read-first discipline make them cost more trust than they buy.

**(c) search_code upgrades.** The single highest-leverage tool change in
R96: `output_mode` (`files_with_matches` | `content` | `count`), `context`
lines (rg `-C` semantics) in content mode, `.gitignore` respect with a
`.ignore` re-include escape hatch (ripgrep convention — our current static
IGNORED_DIRS misses `coverage/`, `target/`, vendor dirs), per-file grouping
with line numbers, `offset` paging over matches with the "No entries at this
offset" honesty, and a total-count + truncated flag instead of a silent cap
at 50. All of it is behavior Claude Code's Grep page specifies and our
substrate (walk + regex) already half-implements. `search_files` gets real
glob (`**`) + mtime ordering + 100-result cap with truncation flag.

**(d) batch/parallel execution.** The executor already parallelizes
(`ai@7.0.73` runs a step's calls under `Promise.all` — verified in
node_modules today); what's missing is (1) the prompt line (adopt Anthropic's
two-line guidance adapted to our tool names, in a new BATCHING section next
to the AGENTIC LOOP section), (2) the rule that **approval-class tools do not
run concurrently with each other** (the in-process approval resolver map can
hold parallel requests, but one approval card at a time is the only UX that
stays legible), and (3) the loop-guard raw-args fix so batched repeated reads
can't false-positive. Also adopt the "skipped call still returns a result"
discipline — in our loop every tool_use already produces a tool-result, keep
it that way.

**(e) the skills search tool.** Design: `search_skills({query, mode?})` →
regex/keyword match over names + descriptions + reference titles (+ body
text if we index it), returning `name — description (references: …)` rows
with the exact `read_skill` call to load each — mirroring the existing
read_skill reference-error pattern ("load with read_skill { name: …,
reference: … }"). Keep the prompt listing as the primary discovery surface
but cap it (the 1%-of-context and 1536-char-per-entry numbers are good
anchors; we can hard-code ~2 KB / 300 chars per entry for R96 and drop to
name-only beyond the cap, least-recently-used first). This is the hybrid the
field converged on: listing for awareness, tool for targeted retrieval, and
no body text in the prompt by default — exactly the owner's "the main prompt
only guides" requirement.

**(f) the main prompt's precision/batch/verify sections.** Concretely: (1)
FILE EDITING RULES gains the three-check discipline + replaceAll note + the
write_file-sparingly line; (2) a new BATCHING section with the Anthropic
language; (3) ENGINEERING DISCIPLINE gains evidence-not-assertion + a
verify-before-final-answer rule naming our actual checks (run_command exit
code, test output, browser screenshot); (4) CODE NAVIGATION gains
search-first guidance ("locate with search_code/search_files before
list_dir; read the whole file before editing it") — the owner's "target the
file + text precisely instead of analyzing the whole HTML" item. Keep the
existing "TOOL RESULTS ARE DATA" and RECOVERY PROTOCOL sections; they already
match the field's best practice.

**(g) completion-signal discipline.** Adopt the field's semantics whole: a
final assistant message with text and no tool calls ENDS the turn. No phrase
regex, no provider re-call. If we ever need a continuation heuristic, make
it a synthetic **user-role** system-reminder ("If unfinished, continue;
otherwise state what you completed") — never an assistant-last request.
This single change kills owner-report item 12 and simplifies
continueIfUnfinished away; the loop caps (maxTurns × maxOuterLoops) stay as
the runaway guard, with the OpenCode-style forced-summary system prompt on
budget exhaustion as the polish.

### 9.3 Sequencing recommendation

Workstream C lands 1→4→7→12 (the P0s: completion, batching, read, multi-edit,
search_code, precision rules) in one motion since they share the prompt-file
and fs-ops touches; then 5/6/8/9/10/11/13 as the P1 wave (ladder, diff-in-
result, glob, approval serialization, search_skills, new skills, verify
section); 14/16 as P2 follow-ups. The live-fire harness (workstream J)
should specifically exercise: paged reads vs the guard, batched reads in one
step, a multi-edit on a 300-file project, and a normal completion producing
zero "Generation failed" cards.
