<!-- last-reviewed: 2026-08-30 round-54 -->
# ADR-0024: Approval engine v1 (interactive run_command permission)

**Status:** Accepted (round 37, 2026-08-25)
**Owner directive:** unapproved commands must "properly and clearly highlight
it with me and ask me for permission and wait for my permission on it… give
me options to allow it always or allow it this time".

## Context

`run_command` existed since round 24 but fail-closed on anything outside a
static SAFE_PREFIX list with a refusal string — the "approval engine" was a
stub (approvals table never written; `categorize()` never called; two
conflicting policy lists in exec.ts vs approvals.ts). API.md §7 documented
routes/events that never existed.

## Decision

1. **One policy engine** (`agent-core/src/approvals.ts`), fail-closed, layered:
   - BLOCKED (denylist-supreme: `rm -r/-f`, `sudo`, `curl`/`wget`/`ssh`/`nc`,
     `format`, dev servers, …) → **deny forever**, no prompt;
   - DESTRUCTIVE (`git push --force`, `git reset --hard`, `git clean -f`) →
     **ask ALWAYS** — never rule-able (hard rule: no "always allow" for
     destructive ops; the route silently downgrades `remember=always` to
     `once` for them);
   - AUTO (read-only + build/test: ls/cat/grep, git status/diff/log, npm/pnpm
     test/build/lint, cargo check/build, tsc…) → run. `npm install`, `git
     commit`, `yarn`, `pip` moved from the old auto list to **ask**; `env`
     and `echo` dropped;
   - project-scoped "always allow" rule (**exact** command match,
     `approval_rules` table) → run;
   - everything else → **ask**.
2. **The interactive wait is an in-process resolver map** (approvalId →
   resolver), resolved by `POST /api/v1/approvals/:id/decision` — no DB
   polling. Rows are the audit trail; the boot sweep expires crash-orphaned
   pending rows (fail-closed) and wakes any zombie waiters.
3. **Timeouts/abort deny**: 120s default; the waiter races the turn's abort
   signal (the SDK alone may not cancel pending tool promises).
4. **Non-interactive turns fail fast**: sync turns and sub-agent children
   deny a non-auto command immediately with a clear note (no 120s burn).
   Interactive = streamed parent turn (`emit` present, not a child session).
5. **Events**: `approval.requested` / `approval.resolved` ride the turn's SSE
   stream AND persist into the session event log (they fold into the turn's
   working section — the exchange renders after reload).
6. **Routes**: `GET /api/v1/approvals?status=pending&projectId=` +
   `POST /api/v1/approvals/:id/decision {decision, remember?}`.
7. **Migration 0009**: approvals gains `project_id`/`remember`/`expires_at`;
   new `approval_rules` table.
8. **Structured logging** (lib/log.ts): approval lifecycle, turn lifecycle,
   and tool calls (name + argsSummary ONLY — never outputs, never key
   values) log as JSON lines to stdout + `.dev/acute.log` (gitignored,
   `ACUTE_LOG_PATH`/`ACUTE_LOG_LEVEL` env overrides).

## Consequences

- exec.ts's static gate is retired — `decideCommand()` is the single source
  of truth (`isSafeCommand` remains as a thin mirror for older tests).
- The frontend ApprovalCard (in WorkingSection.tsx) shows Allow once /
  Always allow / Deny; the decision calls the route and the turn resumes.
- Sub-agent approval propagation (children asking through the parent's UI)
  is future work — children simply never get interactive approvals in v1.
