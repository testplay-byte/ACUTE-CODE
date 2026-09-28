<!-- last-reviewed: 2026-09-28 round-131 -->
# PROJECT MEMORY — the agent memory system (implemented R44)

**Status:** reference (implemented) · **Established:** round-44 · **Audience:**
agents extending the memory system, the owner verifying it works

Round-44 shipped the owner-directed memory system: agents persist durable
per-project knowledge and get it auto-injected into every later turn. This
runbook documents the shipped reality (originally specced in the R44 dispatch
plan; there was never an in-repo "plan" doc — this file IS the reference).

Not to be confused with [`AGENT-MEMORY.md`](AGENT-MEMORY.md) — that file is
the numbered lessons list for agents working ON this repo.

## The memory table (migration `0015_memory.sql`)

`memory` (per project): `id` (`mem_…`), `project_id`, `kind`
(`fact|decision|preference|note`, default `note`), `content` (trimmed, capped
at 4000 chars), `source` (default `agent`), `created_at`, `updated_at`; index
on `(project_id, updated_at DESC)`. The migration also appends the three
tools to seeded template-agent allowlists (the 0014 `json_insert` pattern,
idempotent, audit-logged as actor `migration-0015`) — see
[`MAINTENANCE.md`](MAINTENANCE.md) recipe (a) for why that step is mandatory.

## The three tools (`agent-core/src/tools/memory.ts`)

| Tool | Behavior |
|---|---|
| `memory_save {content, kind?}` | Persists one memory (kind validated case-insensitively; content trimmed, ≤4000 chars — over-cap surfaces as an `ok:false` tool error, never a raw SQLite exception). |
| `memory_recall {query?, limit?}` | LIKE search over content+kind (wildcards escaped, case-insensitive), content-substring matches ranked before kind-only, newest-first, default limit 12. |
| `memory_list {limit?}` | Newest-first listing (rowid tie-break so same-millisecond bursts keep insertion order). |

All three degrade gracefully (`ok:false` with a readable reason) outside a
project session — the no-deps pattern from `todo_write`.

## Digest injection (every project turn)

`prepareTurn` (`agent-core/src/agents/runtime.ts`) passes
`memoryDigest(db, session.projectId)` for project sessions;
`buildProjectSystemPrompt` injects it as a
`## Project memory (persisted across sessions)` section (after CODEBASE
AWARENESS, before ENVIRONMENT) **only when non-empty**. The digest is
importance-ranked `• [kind] content` lines (kind weight × recency decay)
capped at **~1500 chars with whole-line granularity** (an overflowing line is
dropped whole; a single line longer than the whole budget is hard-sliced +
ellipsized) — cheap, bounded, prompt-safe. The prompt also tells the agent
when to save vs recall (gated on the `memory_save` tool being allowed), and
**R98-F1** added the save-discipline line: durable decisions, corrections,
and user preferences go into `memory_save` AS THEY ARE DISCOVERED — never
batched for later (the golden fixture re-pinned).

## The Memory tab + the REST surface

Right sidebar → **Memory** (Brain icon; singleton tab, `openMemory`) renders
`src/components/right-sidebar/MemoryPanel.tsx`: memories grouped by kind with
colored chips, hover-revealed delete (with spinner), 5s polling, empty-state
explaining what lands here, footer hint "Auto-loaded into every agent turn".

**R98-F1 (owner: "implement our proper memory functionality")** — the panel
gained the WRITE side: the header's `+` opens an add-memory form (kind picker
+ content textarea; the kind picker IS the importance control — the table's
importance model is the kind weight, there is deliberately no importance
column), and each row's Pencil expands an inline editor (content + kind).

REST surface: `GET /projects/:id/memory` (newest-first, cap 100),
`DELETE /projects/:id/memory/:memoryId`, plus the R98-F1 pair — `POST
/projects/:id/memory` (201 insert / 200 dedup-refresh on an exact duplicate;
rows sourced `"owner"`) and `PUT /projects/:id/memory/:memoryId` (partial
content/kind patch). The AGENT's channel during turns is still the
`memory_save` tool; the write routes are the owner's manual surface, and
REST-created rows are marked `source:"owner"` so the audit trail stays
legible.

## The `.acute/` workspace (round-131 — the project root's own drawer)

R131-F shipped the owner-directed workspace scaffold: "it will create a hidden
folder or our own folder where it will store its own things… or temporary
things… so that the actual folder does not get affected by it." Every project
root carries the app's OWN drawer, and `memory/` is one of its four subfolders
— the file-carried complement to the DB-backed memory table above.

```
<root>/.acute/downloads/     files fetched/downloaded for the project
<root>/.acute/tools/         the agent's self-built tools (see EXTENSIBILITY's
                             create-tool skill — the tool-creation convention)
<root>/.acute/memory/        file-carried memory artifacts (the drawer this
                             runbook's section is about)
<root>/.acute/tmp/           scratch space for one task's intermediates
<root>/.acute/workspace.json  the MARKER: {version, createdAt, appVersion}
```

**The law** (`agent-core/src/storage/workspace.ts`,
`ensureProjectWorkspace`):

- **Scaffolded at create**: `POST /projects` creates the drawer + the four
  subfolders + writes the marker. The Scratchpad root
  (`<dataDir>/scratchpad`) is healed the same way at every boot (the
  previously-used-folder path — this is also the legacy cure for the vanished
  cwd behind the ledger's `spawn cmd.exe ENOENT` reports: a missing root is
  re-created at boot, and `run_command` now pre-checks the cwd and names the
  DIRECTORY in its refusal).
- **Resume, never re-scaffold**: the marker file is the "previously used"
  signal. When present, missing subfolders are HEALED and the marker is never
  rewritten — `createdAt` is the workspace's own history and survives every
  open. (A corrupt/unparseable marker still counts as present: subfolders
  heal, the file stays as-is.)
- **Only `.acute/`**: the scaffold never touches any other file in the root —
  no enumeration, no cleanup, no deletion. The user's actual project files
  are the user's.
- **Hidden, not unreachable**: the Files tree hides dot-dirs (fs-ops.ts), so
  `.acute/` never appears in the explorer — but the agent's tools reach it
  like any path (`list_dir .acute/tools` works; `read_file` reads the marker).
- **Where consumers write**: the pre-R131 `.acute/` consumers keep their own
  subfolders (`skills/`, `prompts/`, `agents/`, `plugins/`,
  `computer-use/audit.jsonl`) — the scaffold creates the FOUR named folders
  only and leaves everything else it finds in place. New consumers that need
  the drawer's subfolders write to `downloads/` (fetched files),
  `tools/` (the create-tool convention), `memory/` (file-carried memory),
  `tmp/` (per-task scratch). A scaffold failure degrades honestly: the
  project still works (`workspaceWarning` on the create response; logged at
  boot) — never a failed create.
- **Honest scope note (round-131)**: the R131 browser download pipeline
  writes `<root>/downloads/` (the ROUND-115 pin it shipped under) — the
  `.acute/downloads/` drawer is the pinned location for NEW consumers; the
  alignment of the browser path is a flagged follow-up, not a silent
  re-point.

Pins: `agent-core/tests/r131-workspace.test.ts` (the two paths, the
never-touch law, the boot heal, the dot-dir hide + tool reach).

## How to verify (the live-battery pattern)

1. **Save in one turn:** with tools allowed, ask the agent to remember a
   distinctive fact about the project (e.g. "remember that the build entry is
   scripts/dev.mjs"). Assert the tool event + `GET /projects/:id/memory` row.
2. **Recall in a NO-TOOLS turn:** send a second turn with tool calls disabled
   (or simply ask a question the digest answers). The fact can only arrive
   via the injected digest — a correct answer proves the injection path
   end-to-end (this exact battery ran live in R44: save → persisted →
   auto-injected → recall confirmed in a no-tools turn).
3. Reload the app: the Memory tab shows the row; delete it there and confirm
   the next turn no longer knows the fact.

## See also

- [`MAINTENANCE.md`](MAINTENANCE.md) — the how-to-add-a-tool recipe using this
  system as the worked example.
- [`../architecture/api/IMPLEMENTED-API.md`](../architecture/api/IMPLEMENTED-API.md)
  — the memory routes + tools contract.

<!-- R131-X: THE DOWNLOADS DECISION (the coherence wave's re-point): browser
     downloads (the agent-side download ACTION + the native right-click
     Save-image-as pipeline) land in <projectRoot>/.acute/downloads/ — the
     owner's hidden-folder isolation directive. The Files tree LISTS .acute
     (the .github exception pattern) so the owner can browse his downloads;
     legacy installs' existing <root>/downloads/ files stay where they are
     (nothing migrates, nothing deletes). -->
