<!-- last-reviewed: 2026-09-12 round-98 -->
# ADR-0002: pnpm workspaces as the package manager / monorepo tool

- **Status:** ACCEPTED (owner delegated the choice, 2026-08-21)
- **Date:** 2026-08-21

## Context

ACUTE-CODE spans three TS packages (frontend, agent-core sidecar, shared types) plus the Rust shell. The owner asked for "the most appropriate, most reliable and functional" option. Existing toolchain: Node 24.18, npm 11.16, Bun 1.3.14; pnpm was missing (installed 11.22.0 during Phase 0).

## Options considered

- **npm workspaces** — zero install, but slower installs, looser phantom-dependency isolation, and no built-in license report worth using.
- **pnpm workspaces** — strict dependency isolation (important for a license-audited closed-source product), fast content-addressed installs, `pnpm licenses list` feeds the compliance audit directly, mature Tauri/AI-SDK ecosystem compatibility.
- **Bun workspaces** — fastest, already installed; but younger runtime, and native-module edge cases (better-sqlite3) plus a smaller track record for Tauri sidecar builds add risk.

## Decision

pnpm workspaces, installed globally (done).

## Consequences

Every contributor/CI image needs pnpm (corepack or `npm i -g pnpm` — documented in SETUP.md). The license audit script uses `pnpm licenses list --json`. Bun remains usable for one-off scripts if ever needed, but the product does not depend on it.
