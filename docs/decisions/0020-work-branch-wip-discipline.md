<!-- last-reviewed: 2026-09-12 round-94 -->
# ADR-0020: Work-branch WIP discipline for multi-file rounds

- **Status:** ACCEPTED (backfilled round-17; decided round-16)
- **Date:** 2026-08-23

## Context

A sandbox wipe destroyed an entire uncommitted round mid-flight (round-16
session event). The repo is the single source of truth; an uncommitted
working tree is worth nothing.

## Options considered

- **Commit WIP to `main` directly** — breaks "main is always green".
- **Work branch + WIP pushes at green milestones; merge when fully green.**

## Decision

Multi-file rounds run on `work/<round-slug>` from the start, with a
commit+push at every green milestone (backend green / frontend green /
docs). Merge to `main` only after verify + live battery + browser checks
pass; delete the branch after. Known gap (accepted): CI runs on `main` and
PRs only — WIP pushes are un-CI'd; if a branch spans sessions, open a draft
PR to get CI on it.

## Consequences

Wipe cost is capped at one milestone. `main` stays releasable; the launcher
updates owners from `main` safely. Slightly more git ceremony — codified in
WORKFLOW §3. Reversal: stop branching (keep the discipline anyway).
