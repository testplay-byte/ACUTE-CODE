<!-- last-reviewed: 2026-09-12 round-94 -->
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
newest-first `• [kind] content` lines capped at **~1500 chars with whole-line
granularity** (an overflowing line is dropped whole; a single line longer than
the whole budget is hard-sliced + ellipsized) — cheap, bounded, prompt-safe.
The prompt also tells the agent when to save vs recall (gated on the
`memory_save` tool being allowed).

## The Memory tab + the delete route

Right sidebar → **Memory** (Brain icon; singleton tab, `openMemory`) renders
`src/components/right-sidebar/MemoryPanel.tsx`: memories grouped by kind with
colored chips, hover-revealed delete (with spinner), 5s polling, empty-state
explaining what lands here, footer hint "Auto-loaded into every agent turn".

REST surface: `GET /projects/:id/memory` (newest-first, cap 100) and
`DELETE /projects/:id/memory/:memoryId` — read + prune only. There is
deliberately **no REST create**: memory is the agent's channel, so what the
agent saved is the audit trail of what it knew.

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
