<!-- last-reviewed: 2026-09-07 round-75 -->
# PROMPT-MODULES — the per-section system-prompt override system (R59-F)

**Status:** reference (implemented) · **Established:** round-59 · **Audience:**
the owner tuning a project's agent behavior, agents extending prompts.ts

Owner R59 directive: *"the system prompts… highly customizable… built in
multiple parts, modules, and such, and they will be used when necessary."*
R59-F shipped exactly that: the composed project system prompt is now a
REGISTRY of named sections, and any of them can be replaced, removed, or
reordered by plain markdown files in the project root — the same
DeepSeek-harness-style modularity the owner referenced, at prompt level.

## The section registry

`agent-core/src/agents/prompt-registry.ts` is the single source of truth:
a frozen, ordered list of every section `buildProjectSystemPrompt` composes
(the registry tests pin that the two lists can never drift apart). Order
below = composition order.

| id | dyn | section |
|---|---|---|
| `identity` | yes | opening persona + `PROJECT:` line (no heading) |
| `tool-use` | yes | `## TOOL USE` — live tool-name list + call discipline |
| `permission-mode` | yes | `## PERMISSION MODE` — only when mode is full/plan/editor (ask stays silent) |
| `sub-agents` | yes | `## SUB-AGENTS (delegate_task)` — only when the tool is allowed |
| `tool-results-are-data` | no | `## TOOL RESULTS ARE DATA` — prompt-injection guard |
| `agentic-loop` | yes | `## AGENTIC LOOP — MULTI-TURN COMPLETION` (maxTurns injected) |
| `efficiency` | no | `## EFFICIENCY — FEWEST STEPS THAT FULLY SOLVE THE TASK` |
| `file-editing` | no | `## FILE EDITING RULES` |
| `code-navigation` | no | `## CODE NAVIGATION` |
| `git` | yes | `## GIT` — only when `git_status` is allowed |
| `terminal` | yes | `## TERMINAL` — only when `run_command` is allowed |
| `task-planning` | no | `## TASK PLANNING` |
| `todo-tracking` | yes | `## TODO TRACKING` — only when `todo_write` is allowed |
| `web-access` | yes | `## WEB ACCESS` — only when web tools are allowed |
| `browser-panel` | yes | `## EMBEDDED BROWSER PANEL (browser_control)` — only when the tool is allowed |
| `communication` | no | `## COMMUNICATION` |
| `codebase-awareness` | yes | `## CODEBASE AWARENESS` + index summary — only when `index_project` is allowed |
| `project-memory` | yes | `## Project memory` — only when the project has memories |
| `environment` | yes | `## ENVIRONMENT` — working-directory discipline |
| `custom-rules` | yes | `## PROJECT RULES` — `.acuterules` + `.acute/rules/*.md`, only when rules exist |

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
