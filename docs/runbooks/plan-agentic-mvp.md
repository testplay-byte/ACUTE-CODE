<!-- last-reviewed: 2026-08-24 round-32 -->
# Plan — Agentic Coding MVP (owner directive, 2026-08-22)

The owner set the **first goal**: a full-fledged working agentic coding
system — projects with native folder selection, sessions/memory/context/
skills/models per project, real file write/edit capability, a UI cloned from
the `project-chat` design demo, tested live against
`C:\Users\khurr\Desktop\ACUTEST`.

Product vision (recorded, expands SPEC §1): ACUTE-CODE is three products in
one — **(a)** a coding environment (Cline/Kilo Code/OpenCode class),
**(b)** a full agentic system (OpenHands/CrewAI class), **(c)** an automation
platform (n8n class). Everything built now must keep those futures additive.
Current agents/sessions screens are drafts; this plan makes the core real.

## Milestones

| # | Deliverable | Proof |
|---|---|---|
| M1 | Projects backend: SQLite migration 0003 (`projects` + `sessions.project_id`), REST CRUD, tree + file-read endpoints; Tauri native folder picker (`pick_folder`, rfd); browser fallback | unit tests + curl |
| M2 | Agentic file tools in the sidecar: `list_dir` / `read_file` / `write_file` / `edit_file`, path-containment sandboxed to the project root, wired through ChatFn into the turn loop; every call appended to the session event log (audit trail) | unit tests w/ stubbed fetch |
| M3 | Project-chat UI cloned from the demo: resizable Explorer/Code/Chat panels, message anatomy (user/ai/thought/actions/diff), live data (real tree, real file view, real turns) | browser screenshots |
| M4 | Live end-to-end on `ACUTEST`: project → session → "create X" prompt → files actually written | CLI + fs assertions |

## Security posture for this MVP ([ASSUMPTION] — ADR pending owner ratification)

- Tools are **path-containment sandboxed** to the project root (resolve +
  prefix check; `..` and absolute escapes rejected).
- Reads/lists: auto-approved. Writes/edits inside the root: auto-approved
  **for this MVP** because the owner explicitly commissioned live coding on
  his own test folder; every action is recorded in the append-only session
  log (ADR-0010) for audit. Anything outside the root or shell-execution is
  **denied outright** (denylist-supreme, fail-closed — SPEC hard rule intact).
- The interactive approval modal (per-write confirm) lands with Phase 3
  proper; until then this tradeoff is explicit and documented, never silent.

## Deferred (documented, not forgotten)

n8n-style automations/scheduling: research note captured in
`docs/research/n8n/`; architecture kept additive so `scheduling/` becomes its
own sidecar domain later. Dashboard deep-redesign follows once the coding
core works (owner: quality over speed, core first).
