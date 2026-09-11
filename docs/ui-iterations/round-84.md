<!-- last-reviewed: 2026-09-11 round-90 -->
# Round 84 — the modularity round (Wave 2: the SCC break + the server.ts route split)

> **Backfilled in round-85.** The R84 session delivered code + CHANGELOG + status.json
> + MODULARITY-ASSESSMENT's progress section + the HANDOFF header, but the per-round
> evidence file required by WORKFLOW §5 was never written — this file reconstructs it
> from the commit trail (`8845069`, `4ff8a80`→`497a3ff`, `8ce6e08`, `c38bc8b`), the
> ORCHESTRATION-WORKLOG R84 entry, CHANGELOG 0.83.0, and status.json milestone 44.
> No new evidence is claimed beyond what those records already carry.

## Owner direction

The R80.5 audit's roadmap waves, owner-approved for execution: Wave 2 of the
modularity plan — (a) break the 25-file agents↔tools import cycle at the delegation
edge, (b) split server.ts by domain on the proven registerBrowserRoutes pattern.
Behavior-identical, test-guarded.

## What shipped (v0.83.0, work/r84-modularity, merged to main)

1. **Wave 2-c — the SCC break (commit `8845069`)**: `agents/sub-roles.ts` (the new
   leaf — SUB_ROLES/SubRole, imports nothing); orchestrator.ts re-imports + re-exports
   for byte-identical compat; `tools/plugins/delegation.ts` drops the static
   orchestrator import — the orchestrator arrives via the `ToolDeps.orchestrator`
   seam (type-only, erased at runtime) with a lazy dynamic-import singleton fallback
   at execution time.
2. **Wave 2-a — the route split (commits `4ff8a80`→`497a3ff`, 10 phases)**: 71 routes
   moved VERBATIM into 14 `routes/<domain>.ts` modules (sessions+chat 16/1,243 lines,
   providers 13/498, attachments 2/392, models 5/328, settings 8/265, agents 6/248,
   projects 8/206, ratings 4/166, skills 4/111, usage 2/65, modes 1/54, memory 2/49,
   + routes/context.ts RouteContext + helpers.ts) on the registerBrowserRoutes
   pattern; `buildServer` is the assembler calling each register function in the
   ORIGINAL registration order (Fastify wildcard precedence preserved); programmatic
   block moves with independent round-trip verifiers; every ROUND-N history comment
   intact. **server.ts: 5,719 → 2,439 lines (−57%).**

## Verification

- Agent-core 92 files / 1,867 tests green after EVERY phase; root 155 files / 2,825
  tests; e2e 12/12; lint + typechecks clean; license audit 134 CLEAN.
- A Tarjan SCC check over the runtime value-import graph reported zero cyclic SCCs
  *(R85 correction: the check's 90-file scope missed one benign 2-cycle —
  tools/registry.ts ↔ tools/plugins/mcp.ts, TOOL_NAME_RE, since R61; and the
  remaining-routes count was 52, not ~31 — see round-85.md §3)*.
- CI: push `8ce6e08` → run 34484344162 SUCCESS; the SCC-break push `8845069` → run
  34475792238 SUCCESS. Release v0.83.0.
- docs:check 188/0/0 (19 round-80 stamps refreshed per the cohort convention — R85
  later found several of those refreshes were stamp-only where content had drifted;
  see AGENT-MEMORY lesson #84).

## Open items handed to R85+ (all confirmed still open by the R85 audit)

- Wave 2-b (the turn-loop harness extraction) — NOT STARTED.
- The remaining server.ts domains: terminal, MCP, computer-use, diagnostics,
  approvals, vision + the SSE route (476 lines at R85 measure) + the 21-route
  unnamed tail the plan never listed (notifications, jobs, checkpoints, dialogs,
  plugins, index, keys, health).
- The DASHBOARD's R84 truth-sync (deferred to the next session).
