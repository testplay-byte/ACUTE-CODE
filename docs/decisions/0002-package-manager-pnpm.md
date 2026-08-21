# ADR-0002: pnpm workspaces as the package manager / monorepo tool

- **Status:** ACCEPTED (owner delegated the choice, 2026-08-21: "most reliable and functional")
- **Date:** 2026-08-21

## Context

ACUTE-CODE spans three TypeScript workspaces (frontend, agent-core sidecar, shared types) plus the Rust shell. The stack table fixes the layers but not the JS package manager. Installed base: Node 24.18 + npm 11.16; bun 1.3.14 also present; pnpm was missing (now installed, 11.22.0).

## Options considered

- **A. npm workspaces** — zero extra install; slower installs, weaker dependency isolation (hoisting surprises), no built-in license listing suitable for audit.
- **B. pnpm workspaces** — strict, content-addressed store (disk- and RAM-friendly on an 8 GB machine), first-class workspace filtering, `pnpm licenses ls` feeds the compliance audit directly.
- **C. Bun** — fastest runtime+manager, but younger ecosystem; native-module builds (better-sqlite3) and Tauri tooling have more edge cases.

## Decision

**pnpm workspaces** (Option B). Reliability and audit support beat marginal install convenience.

## Consequences

Every contributor/runbook step uses pnpm (SETUP.md). `pnpm licenses ls --json` becomes the data source for `docs/compliance/dependency-licenses.md` in CI, failing on GPL/AGPL/LGPL. Node 24 + pnpm 11 are the pinned baseline. Reversal cost: low-moderate (workspaces port between managers).
