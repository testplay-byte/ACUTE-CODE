<!-- last-reviewed: 2026-08-25 round-35 -->
# ADR-0019: Project-scoped 7-tool set is THE tool catalog; allowlist enforced

- **Status:** ACCEPTED (backfilled round-17; enforcement added round-17)
- **Date:** 2026-08-23

## Context

The SPEC-era tool list (`file_read/file_write/file_edit/shell_exec/
web_search`) drifted from reality (7 project tools, ADR-0014-era fixes):
validation accepted names that don't exist and rejected ones that do
(sub-agent audit G1-a/G1-b, verified). `agent.allowedTools` was stored but
never enforced — every agent got every tool, which delegation (PILLARS §9)
cannot ship on.

## Options considered

- **Keep the catalog in docs only** — three sources of truth, already bit us.
- **Single source in code, enforced at build time** — names and behavior
  can't drift.

## Decision

`TOOL_NAMES` (storage/agents.ts) IS the canonical list —
`list_dir, read_file, write_file, edit_file, create_dir, delete_file,
search_files` — feeding server validation; the frontend `TOOL_CATALOG`
mirrors it; a drift-guard test pins both. `buildProjectTools(root,
allowedTools?)` intersects with the agent's allowlist when non-empty
(**empty = ALL tools**, matching every default); `prepareTurn` passes the
agent's list. All schemas wrapped in `jsonSchema()` (AI SDK v7 requirement,
lesson #9).

## Consequences

Agents can be honestly restricted (a reviewer without write, a researcher
without delete) before delegation exists; SPEC-era names 400 with a clear
message. Adding a tool = update the list + tests in one commit. Reversal:
trivial.
