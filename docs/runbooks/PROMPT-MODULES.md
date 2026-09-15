<!-- last-reviewed: 2026-09-15 round-99 -->
# PROMPT-MODULES — the per-section system-prompt override system (R59-F)

**Status:** reference (implemented) · **Established:** round-59 · **Audience:**
the owner tuning a project's agent behavior, agents extending prompts.ts

Owner R59 directive: *"the system prompts… highly customizable… built in
multiple parts, modules, and such, and they will be used when necessary."*
R59-F shipped exactly that: the composed project system prompt is now a
REGISTRY of named sections, and any of them can be replaced, removed, or
reordered by plain markdown files in the project root — the same
DeepSeek-harness-style modularity the owner referenced, at prompt level.

**ROUND-99 (R99-G) — the overhaul:** the owner's flaw list ("length dilutes
attention… heavy duplication, no precedence rules… hard numbers become
targets… no risk threshold for autonomy… no guidance on memory save/recall…
tools only in the name list… no output contract for subagents… no
confidence tags") is answered by: the PRECEDENCE header, the AUTONOMY
LADDER, the loop's INTAKE phase 0 (restate the goal / knowns vs. unknowns /
skills check / out-of-scope before planning), the tool-vocabulary
DESCRIPTIONS block, the sub-agent report contract, the confidence tags, the
memory SAVE/RECALL/NEVER block — paid for by the deepest dedup yet
(~2.3K chars retired; the default composition measured 23,975 chars against
the 24,000 bound — the cap moved 23,000 → 24,000 following the R96-D
precedent, documented in r71-prompt-discipline.test.ts).

## The section registry

`agent-core/src/agents/prompt-registry.ts` is the single source of truth:
a frozen, ordered list of every section `buildProjectSystemPrompt` composes
(the registry tests pin that the two lists can never drift apart). Order
below = composition order.

| id | dyn | section |
|---|---|---|
| `identity` | yes | opening persona + `PROJECT:` line (no heading) |
| `precedence` | no | `## PRECEDENCE` — the conflict ladder (SAFETY > TRUTH > USER > EFFICIENCY), rules vs. judgment, limits-are-maximums (R99-G) |
| `tool-use` | yes | `## TOOL USE` — live tool-name list + call discipline + the core-vocabulary DESCRIPTIONS block (R99-G) |
| `permission-mode` | yes | `## OPERATING MODE` — the unified mode's narration, only when mode is full/plan (ask stays silent; R81) |
| `autonomy` | no | `## AUTONOMY LADDER` — the three risk tiers (act / ask-first / never) under the permission mode's ceiling (R99-G) |
| `sub-agents` | yes | `## SUB-AGENTS (delegate_task)` — delegation patterns + the child REPORT CONTRACT (RESULT/FILES/FINDINGS/QUESTIONS/CONFIDENCE; R99-G), only when the tool is allowed |
| `tool-results-are-data` | no | `## TOOL RESULTS ARE DATA` — prompt-injection guard |
| `agentic-loop` | yes | `## AGENTIC LOOP — MULTI-TURN COMPLETION` — the six phases (INTAKE/PLAN/EXPLORE/ACT/VERIFY/FINISH; the INTAKE phase is R99-G), maxTurns injected |
| `batch-discipline` | no | `## BATCH DISCIPLINE` (R96-D) |
| `completion-discipline` | no | `## COMPLETION DISCIPLINE` — the ending contract + the precision lines folded in (R99-G merge of the retired precision-discipline) |
| `recovery` | no | `## RECOVERY PROTOCOL` (R94-G) |
| `engineering-discipline` | no | `## ENGINEERING DISCIPLINE` (R71-e1) |
| `file-editing` | no | `## FILE EDITING RULES` — the tiered prompt rule (R98-F2) |
| `code-navigation` | no | `## CODE NAVIGATION` — search_symbols-first hunting (R99-G refresh) |
| `git` | yes | `## GIT` — only when `git_status` is allowed |
| `terminal` | yes | `## TERMINAL` — only when `run_command` is allowed |
| `skills` | yes | `## SKILLS` — the budgeted skill index (progressive disclosure) |
| `always-on-skills` | yes | `## ALWAYS-ON SKILLS` — the pinned bodies (≥1 pinned skill; R98-E2) |
| `task-modes` | yes | `## TASK MODES` — the posture index (R73/R81) |
| `active-mode` | yes | `## ACTIVE MODE` — the session's current task mode |
| `background-tasks` | yes | `## BACKGROUND TASKS` — the delegation reminder (R79) |
| `todo-list` | yes | `## TODO LIST` — the current snapshot (R88), only when `todo_write` is allowed |
| `computer-use` | yes | `## COMPUTER USE` — the master switch |
| `mcp` | yes | `## MCP TOOLS` — only when `mcp__` tools are present |
| `web-access` | yes | `## WEB ACCESS` — only when web tools are allowed |
| `browser-panel` | yes | `## EMBEDDED BROWSER PANEL (browser_control)` — only when the tool is allowed |
| `capabilities` | yes | `## CAPABILITIES` — image understanding on/off (R94-G) |
| `communication` | yes | `## COMMUNICATION` — reply style, verification receipts, + the confidence tags with their because/raising-it contract (R99-G) |
| `codebase-awareness` | yes | `## CODEBASE AWARENESS` + index summary — only when `index_project` is allowed |
| `project-memory` | yes | `## Project memory` — the digest + the SAVE/RECALL/NEVER discipline block (R99-G), only when the project has memories |
| `environment` | yes | `## ENVIRONMENT` — working-directory discipline |
| `custom-rules` | yes | `## PROJECT RULES` — `.acuterules` + `.acute/rules/*.md` + AGENTS.md/CLAUDE.md (R98), only when rules exist |

**32 sections** (R99-G: 31 + `precedence` + `autonomy` − `precision-discipline`).
Retired over the rounds: `efficiency`/`task-planning`/`todo-tracking` (R70-c
merge), `debug` (R66), `precision-discipline` (R99-G — folded into
`completion-discipline`; a stale `.acute/prompts/precision-discipline.md`
shows up as an unknown-file diagnostic, never an override).

"dyn" = dynamic: the built-in text depends on the turn ctx (tools, memories,
permission mode, maxTurns, paths). A static section is fixed text.

## How to override

Drop a file named `<section-id>.md` into `.acute/prompts/` in the project
root (one file per section; the filename must match the registry id
EXACTLY — `Efficiency.md` is ignored and diagnosed):

```text
myproject/.acute/prompts/efficiency.md
```

```markdown
## EFFICIENCY (this project's rules)
Understand the request, then do the minimum that fully solves it.
```

Semantics (deliberate — the owner taking responsibility, "used when
necessary"):

- **Replace, wholesale.** The file text becomes the section — including the
  dynamic parts. Overriding `project-memory` replaces the digest; overriding
  `tool-use` replaces the live tool list (the model is then trusted to act
  on the honest tool SCHEMAS the runtime still sends — only the prose
  changes).
- **Empty file = remove the section.** A file that trims to nothing drops
  the section entirely (the heading, the body, and its separator blank).
- **Conditional sections stay conditional.** An override only applies where
  the section would appear — `git.md` does nothing for a session whose tool
  set excludes git tools; `permission-mode.md` never fires in ask mode.
- **Cap.** Each file is capped at 8000 chars with an honest truncation
  marker appended (a runaway file cannot silently eat the context window).
- **Byte-identity.** With no override files the composed prompt is
  byte-identical to the pre-R59 composition (pinned by a golden-fixture
  test) — nothing changes for every existing project.

## Reordering (`.acute/prompts/_order.txt`)

Optional file, one section id per line. Listed sections come first (in file
order, present sections only — unknown ids are ignored and diagnosed), then
every remaining section in its built-in order. The order file only takes
effect together with at least one section override file: with no overrides
the composed prompt stays byte-identical (pinned).

## Security note

Override files live in the PROJECT ROOT — the same trust level as
`.acuterules` and `.acute/rules/*.md`. They are prompt text only: they do
NOT bypass the sidecar bearer wall, tool allowlists, permission modes, or
the approval engine. A `terminal.md` cannot grant a command the agent's
allowlist denies. Treat a project's `.acute/` directory exactly as you
treat its `.acuterules` (see [SECURITY](SECURITY.md)).

## Inspecting it

```bash
# the registry table + which files WOULD override (offline, no sidecar):
node scripts/acute.mjs prompt:sections --project /path/to/myproject

# the EFFECTIVE text of one section (override if present, else built-in):
node scripts/acute.mjs prompt:show efficiency --project /path/to/myproject
```

Both commands read `.acute/prompts/` of the given project (default: cwd) and
print the loader's diagnostics (unknown filenames, cap hits, `_order.txt`
notes) on stderr. `describePromptSections` (agent-core/src/agents/prompts.ts)
is the same report as a data structure for a future Settings UI.

## How to verify

1. Unit: `npx vitest run agent-core/tests/prompt-registry.test.ts
   agent-core/tests/prompts-overrides.test.ts` — registry completeness,
   the byte-identity golden, mapping/cap/order/diagnostics, replacement +
   drop + reorder semantics.
2. Live: put a marker line in `.acute/prompts/efficiency.md`, run
   `prompt:show efficiency` (the marker is the printed text), then a real
   chat turn in that project — the model can quote the marker, proving the
   override reached the composed system prompt end-to-end.

## See also

- [`PROJECT-MEMORY.md`](PROJECT-MEMORY.md) — the memory system whose digest
  the `project-memory` section carries.
- [`CLI-HARNESS.md`](CLI-HARNESS.md) — the dev CLI the two prompt commands
  live in.
- [`../architecture/api/IMPLEMENTED-API.md`](../architecture/api/IMPLEMENTED-API.md)
  — no routes added (the registry is fs + prompts.ts internal; the CLI reads
  it offline).
