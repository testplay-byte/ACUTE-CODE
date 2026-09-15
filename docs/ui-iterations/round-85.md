<!-- last-reviewed: 2026-09-12 round-98 -->
# Round 85 — the structure re-assessment (the post-R84 audit + documentation truth round)

## 1. Owner direction (verbatim intent)

"i need you to work on a project for me… a full-fledged, highly modular, highly
customizable, mostly extension-based agentic coding IDE… analyze it properly,
understand it properly, and get a proper understanding of it by reading the
documents and such, and then give me a complete overview of how the current
structure looks. Is it proper, or are there some issues in it, or are there some
improvements which can be made… making sure that everything is done in such a way
that it does not affect other parts of the app that much. Everything is a separate
part of itself… This will allow for low-context agents to work on smaller parts of
the application without needing the context of the whole system… The modules will
be easily connectable with each other… the most key one, I think, is the DeepSeek
harness… You need to properly do the documentation too. You need to update the
current documentation and our current standing… If we need to change our structure
and such, then do let me know… create rules too if needed… after all the tasks have
been completed successfully send me a notification using NTFY.SH with the topic
NTFY-TOPIC-REDACTED… push all of it to github as… the environment clears sometimes
automatically so we are treating the github repo as a backup."

Extracted requirements (todo list): (1) deep analysis + understanding via the docs;
(2) a complete overview of the current structure; (3) honest assessment — proper?
issues? improvements?; (4) the low-context-agent / modularity / connectability lens;
(5) the DeepSeek-harness reference check; (6) documentation updates + current
standing; (7) tell the owner if structure changes are needed; (8) create rules if
needed; (9) push everything to GitHub (backup); (10) ntfy.sh notification, topic
`NTFY-TOPIC-REDACTED`.

## 2. Method

- Fresh clone at HEAD `c38bc8b` (R84 close-out, v0.83.0) on branch
  `work/r85-reassessment` (WORKFLOW §3 — multi-file round).
- Read-first per §1: HANDOFF, AGENTS, WORKFLOW, MODULE-BOUNDARIES,
  MODULARITY-ASSESSMENT (R80.5), PILLARS, EXTENSIBILITY, status.json,
  deepseek-harness notes + the round-2 deep study (agent-ctx/research/).
- **Three parallel analysis sweeps** (sub-agents, per the sanctioned pattern for
  parallel research): backend import-graph + sizes (Task 2-a), frontend anatomy +
  coupling (2-b), documentation truth audit (2-c).
- **The orchestrator spot-checked every load-bearing claim with its own eyes before
  writing** (file sizes re-measured, delegation.ts imports read directly, the
  registry↔mcp 2-cycle confirmed in both files, the dead sessions/ directory's zero
  importers verified, migrations/ADRs/round-files counted).
- Findings written into the normative docs the same round; docs-only — no code, no
  version bump (the R80.5 precedent for analysis rounds).

## 3. The verdict (what the owner asked, answered)

**Is it proper?** The process discipline and the extension surfaces are genuinely
top-decile (see §4): the tool-plugin registry, skills, task modes, MCP, and prompt
modules are real, fail-soft, drift-tested, and addable with one file and zero core
edits. R84's two structural wins are REAL and verified: server.ts 5,719→2,439 lines
(71 routes in 14 domain modules; buildServer the assembler) and the 25-file
agents↔tools cycle is dead (delegation.ts imports only the sub-roles leaf).

**Where it is NOT yet proper (the honest list):**

1. **R84's verification claims were overstated in three places** — "zero cyclic
   SCCs" (one benign 2-cycle remains: `tools/registry.ts:53` ↔
   `tools/plugins/mcp.ts:20`, TOOL_NAME_RE, since R61 — the check's 90-file scope
   missed it), "the remaining domains = terminal/MCP/computer/diagnostics/approvals/
   vision + SSE" (52 routes actually remain — 21 routes in ~9 unnamed groups were
   never on the plan: notifications ×7, jobs ×4, checkpoints/snapshots ×3, dialogs
   ×2, browser-checkpoints, projects/:id/index, GET /plugins, internal keys,
   /health), and the SSE route is 476 lines (392 was the stale R80.5-era figure).
2. **The turn-loop debt grew**: runtime.ts 3,192→3,369; the sync/streamed runners
   share **378 byte-identical comment-stripped lines (78% of the sync runner's
   body)**; `prepareTurn` is 447 lines with 10 positional args. Wave 2-b never
   started — it is now risk #1.
3. **The frontend declined since R80.5**: api.ts 3,821→3,959, stream-store.ts
   1,891→1,936 (the 687-line `handleStreamEvent` now spans 42 event-type
   comparisons with 17 cross-store side-effect sites), ModelsProvidersTab
   3,006→3,304 (now the largest component; 4 full dialogs inside), AgentChatPanel
   2,757. Zero extension seams, zero React.lazy (one static bundle for 51K lines of
   components), a 559-line DEAD directory (`src/components/sessions/` — zero
   importers since R49), and `WorkingSection.tsx` (1,888 — the shared turn
   renderer) is a fifth god component nobody flagged, imported cross-feature by
   SubAgentPanel. Wave 3 untouched.
4. **SQL confinement is worse than documented**: 22 statements outside storage/ in
   7 files (the R80.5 audit said ~12) — `approvals.ts` alone holds 11 (an entire
   inline persistence layer never counted), and the R84 split RELOCATED the usage
   SUMs to `routes/sessions.ts:714/753` instead of fixing them. `storage/db.ts`'s
   "only code that issues SQL" header remains false.
5. **The docs drifted hardest exactly where agents trust them most** (fixed this
   round — §7): MODULE-BOUNDARIES §3's route recipe told agents to edit server.ts
   and "not preemptively create routes/" AFTER the split was live; §4 presented the
   dead cycle as current; MAINTENANCE §e had the same wrong recipe; HANDOFF §3's
   verify-from was 4 rounds stale and §6.1's was 9 rounds stale; round-84.md was
   never written; the board/index stopped at round-81; ORCHESTRATION-WORKLOG had a
   6-round gap (R76-R81); TESTING.md carried R75 counts; IMPLEMENTED-API missed 1
   route (GET /providers/:id/models-config, shipped round-19).
6. **Systemic doc-gate gaps**: docs:check strips backticked paths before checking
   (deleted-file references pass — EXTENSIBILITY referenced the deleted
   TaskModePicker.tsx), CI runs it `continue-on-error` with an obsolete rationale,
   and sub-package READMEs (agent-core/tests/src-tauri/scripts) are outside its
   walk entirely — agent-core/README.md still describes the Phase-2 skeleton.

**Scores (R80.5 → R85):** built-properly 7→**7.5** · backend agent-editability
6.5→**7** · frontend agent-editability 4→**3.5** (trend negative until Wave 3) ·
doc-truth 7→**6 at audit time → ~8 after this round's fixes**.

## 4. The low-context-agent lens (the owner's core question)

| Task type today | Files a low-context agent must touch | Verdict |
|---|---|---|
| Add a built-in tool | 5 + test (recipe pinned by drift tests) | **A** — the strongest surface |
| Add a skill / task mode / prompt override | 1 .md file | **A** |
| Add an external plugin (.mjs) | 1 file, zero repo edits | **B+** (no execute-time isolation/ctx yet) |
| Add a REST route | routes/<domain>.ts + api.ts + IMPLEMENTED-API + test | **B** (post-R84 — was C; the recipe is now written down correctly) |
| Add a stream event type | 4 files incl. whole-file context on stream-store.ts | **D** — the most expensive small task in the repo |
| Add a right-sidebar panel / message variant | 3-4 files, hot files | **D** |
| Change turn behavior | runtime.ts whole-system context (duplicated runners) | **F until Wave 2-b** |

**Module connectability**: the sanctioned seams are real and few — ToolDeps (the
tools↔everything seam, now documented as such), RouteContext (routes), the
append-only session event log (the cross-process truth), the Zustand store
subscriptions. The graph is a DAG; the fences hold; the rules are now written where
agents read them.

## 5. The DeepSeek-harness reference (owner's key repo)

Both studies verified first-hand (R51 + the round-2 deep study,
`agent-ctx/research/deepseek-harness-round2.md` — public, MIT, 267 leaf packages,
Cordis kernel, the arXiv composability paper). Standing verdict: Cordis-style
everything-is-a-plugin machinery stays NOT adopted (right call at this scale —
ADR-0025 scoped adoption to the tool layer, which shipped and holds). The R85
check confirms the three original "future candidates" are all shipped
(context-overflow recovery, addressable/resumable delegation, progressive-disclosure
skills). The round-2 study's ranked adaptation candidates remain queued behind the
structural waves: **C2 per-tool declared `timeoutMs` with structured TOOL_TIMEOUT
results (top pick — S/M, low risk, high value)**, C3 mode-policy-as-folded-events +
cache-stable narration, C4 tool-result spill. The alignment conclusion for the
owner: ACUTE-CODE's plugin registry + computed catalog + fail-soft loading IS the
DeepSeek-harness pattern, scoped correctly; the gap to close is the frontend seam
(Wave 3) and the turn-loop harness (Wave 2-b), not more plugin machinery.

## 6. What the owner should decide next (the R86 scoping)

In priority order (full reasoning in MODULARITY-ASSESSMENT §10):
1. **Wave 2-b** — the turn-loop harness extraction (risk #1).
2. **Finish the server.ts split** (52 routes, pattern proven).
3. **Wave 3** — the frontend seams (api.ts split → stream-event handler registry →
   component decompositions → delete the dead sessions/ directory).
4. **Wave 1 leftovers** — 22 SQL statements into storage/, the benign 2-cycle,
   ReminderBudget, docs:check gating.

## 7. Documentation fixed this round (the truth-sync)

P0 (actively misleading — fixed): MODULE-BOUNDARIES §1/§2/§3/§4 REWRITTEN to the
post-R84 reality; MAINTENANCE §e + the map; HANDOFF §1/§3/§4/§6/§9; round-84.md
backfilled + round-85.md written; board rows 82-85 + the index round list.
P1: IMPLEMENTED-API (models-config route + anchor), TESTING counts (2,825/155),
status.json (16→26 tools + round 85 + milestone 45), EXTENSIBILITY
(deleted TaskModePicker refs), ROADMAP (unfrozen from round-75), ARCHITECTURE
(reconciliation note), ORCHESTRATION-WORKLOG (R76-R81 backfill + R85 entry),
CHANGELOG entry, README (the tauri CLI line), SPEC (status line), docs/README
(CONTEXT-METER indexed; surface count unified), AGENT-MEMORY lessons #84-#85.
P2 (flagged, left as documented follow-ups): sub-package READMEs regeneration,
docs:check backtick-path checking + CI gating.

## 8. Verification (this round)

- Docs-only round: no code, no tests affected; version stays 0.83.0.
- `node scripts/docs/check-stale.mjs` run before commit — expected green (the
  round-81 stamp cohort bumped per DOC-STANDARDS §8 where content was genuinely
  refreshed; first-line-only diffs verified with git diff).
- Every number in this file re-measured at `c38bc8b` by the orchestrator or a
  sub-agent and cross-checked (sizes via `wc -l`, imports read directly, counts
  via `ls | wc -l`).

## 9. Rules created/updated (the owner's "create rules too if needed")

- **MODULE-BOUNDARIES.md** — the normative editing contract, rewritten to the
  post-R84 reality (the route recipe, the dead-cycle section converted to
  keep-it-a-DAG rules, the SQL exception list, migration numbers, sync points).
- **AGENT-MEMORY lesson #84** (stamp-only cohort refreshes over-claim freshness —
  a content-verification step is required when the round changed the world the doc
  describes) and **lesson #85** (verification claims must be exact-scoped and
  re-runnable — the "zero cyclic SCCs" claim's 90-file scope is why it survived
  review while being false at HEAD).

## 10. Delivery

Branch `work/r85-reassessment` → merged to `main` → pushed (the repo is the backup
per the owner's directive). ntfy.sh notification sent to the owner's topic
`NTFY-TOPIC-REDACTED` on completion. No DASHBOARD publish (no status movement —
v0.83.0 unchanged; the DASHBOARD's R84 sync remains the documented next-session
task).
