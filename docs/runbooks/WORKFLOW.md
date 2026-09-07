<!-- last-reviewed: 2026-09-07 round-75 -->
# WORKFLOW — the session spine

**Normative.** `AGENTS.md` = the rules, `HANDOFF.md` = the state; this file
is the process that carries a round from owner message to merged, verified,
documented work. If docs conflict: state wins for facts, this file wins for
process. Established round-17 (owner direction: "let's go based on a proper
workflow … not blindly"), codifying what rounds 9–16 actually proved.

## 1. Session start ritual (in order)

1. Environment: restore or verify per `SANDBOX-RESTORE.md` — secrets staged
   (lengths verified, never echoed), repo cloned at tip, remote sanitized,
   `pnpm verify` green **with your own eyes**, repo confirmed PRIVATE via API.
2. Read: `HANDOFF.md` §3/§9 → `AGENT-MEMORY.md` (all lessons) → the tail of
   `docs/agent/ORCHESTRATION-WORKLOG.md` (last session) →
   `ui-iterations/README.md` (board) → the runbook for the task at hand.
3. Re-read the owner's last message top-to-bottom and extract **every**
   numbered requirement into a todo list (lesson #3). Never infer approval
   from praise; he gates one screen at a time.
4. Branch decision: trivial fix → `main`; anything multi-file →
   `work/<round-slug>` **immediately** (§3).

## 2. Round cadence

- One owner verdict round = one implementation cycle = one round file entry
  (`ui-iterations/round-NN.md`, next free number; write the session→file
  mapping inside it).
- Owner-pointed defects are fixed **in the session** that hears about them.
- Phase gates (SPEC) still apply for phase-level scope; rounds are the inner
  loop between gates. Scope changes beyond SPEC/ARCHITECTURE need an ADR
  (STATUS: PROPOSED) + owner approval.

## 3. Branch policy (lesson #33, normative)

- `main` is always green: `pnpm verify` + the applicable live battery.
- Multi-file rounds run on `work/<round-slug>` with a WIP commit+push at
  **every green milestone** (backend green / frontend green / docs) — a
  sandbox wipe must never cost more than one milestone.
- Merge to `main` only after §4 gates pass. Known gap: CI triggers on
  `main` pushes and PRs only — work-branch WIP pushes are un-CI'd by design
  (merge is the gate); if a work branch lives more than one session, open a
  draft PR to get CI on it.
- Delete the work branch (local + remote) after merge.
- Sub-agents: OPTIONAL, never default (owner revision 2026-08-23) — use for
  genuinely parallel research/audit sweeps; verify their findings before
  acting on them; implementation is done inline.

## 4. Implementation loop (per feature/fix)

1. Spec check → within SPEC/ARCHITECTURE? If not: ADR PROPOSED first.
2. Code inline, with unit tests (AI SDK mocked — no live model calls, ever).
3. `pnpm verify` green, seen with your own eyes (`export PATH` for pnpm in
   every shell).
4. **Live battery** for anything touching agents/projects/tools/streaming —
   per `TESTING.md` (fresh DB, single-invocation boot, disk assertions as
   ground truth, outcome-based polls).
5. **Browser verification + VLM pass** for anything UI — per `TESTING.md`
   (live stack, screenshots at 1920×1080 + tall viewport, machine-verified,
   zero console errors). Since R44 the machine verification is a **VLM UI
   pass**: agent-browser screenshots of every key screen (all settings tabs,
   all right-sidebar tabs, light/dark, a viewport sweep) analyzed with the
   vision model against a checklist — it caught two real bugs a human pass
   missed (an unreachable settings tab, dashboard cards linking to a dead
   route). Run it before declaring a UI round done; also VLM-verify the NAV
   path to any new screen, not just its deep link (lesson #63).
6. Live smoke turn against the real provider after any tool/SDK wiring
   (lesson #9). Model: the current free default `z-ai/glm-5.2:free`
   (R43+; `stealth/ox-alpha` is dead) — expect free-tier 429s; the
   OpenRouter fallback chain rides through them.

## 5. Documentation duties per round (definition of done)

- `ui-iterations/round-NN.md`: owner direction quoted, per-request changes,
  verification evidence (screenshots, disk asserts, CI run id), open items.
- `ui-iterations/README.md` board row + round list updated.
- **ADR** when a non-trivial decision was made (new dependency, architecture
  or pattern change, policy). Small assumptions → `[ASSUMPTION]` surfaced to
  the owner instead. Never renumber; continue from the last.
- `AGENT-MEMORY.md` appended when a mistake cost real time or produced an
  owner correction (mistake → root cause → rule; append-only).
- `HANDOFF.md` §3/§9 refreshed (dates, counts, tip, next steps).
- `DESIGN-SYSTEM.md` when UI tokens/anatomy changed; `ROADMAP.md` statuses
  refreshed; `docs/status.json` updated for the dashboard when milestones
  move.
- **Worklog snapshot** closes the session: append the session entry to the
  live worklog, copy it to `docs/agent/ORCHESTRATION-WORKLOG.md`, commit
  "Worklog snapshot refresh: <round>", push with the round.

## 6. Merge / push / CI / notify checklist (in order)

- [ ] verify green · [ ] live battery / browser checks pass
- [ ] secret scan of staged files (patterns; lengths never printed, #14)
- [ ] repo PRIVATE via API (#15)
- [ ] merge → push `main` → watch CI to SUCCESS (~4–6 min; a client timeout
      is NOT a failure — re-query, #8); record the run id
- [ ] `curl -d "<no secrets>" https://ntfy.sh/TASKISDONE`
- [ ] dashboard published if status moved (`node scripts/dashboard/publish-dashboard.mjs`)
- [ ] worklog snapshot commit; branch cleanup

## 7. Question protocol (round-adapted)

Batch once per round when genuinely needed: numbered, ≤10, each
`[BLOCKING]`/`[NON-BLOCKING]` with a recommended default; check docs and
code first — never ask what's already answered.

## 8. Interruptions & handover

- Wipe/restore = `SANDBOX-RESTORE.md`; nothing uncommitted matters (#33).
- HANDOFF must always be fresh enough that a cold successor can pick up:
  if a session dies mid-round, the work branch holds the recoverable state.
