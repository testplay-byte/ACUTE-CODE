<!-- last-reviewed: 2026-08-30 round-54 -->
# ADR-0005: Dev tooling — ESLint 9 (flat) + typescript-eslint, Vitest, GitHub Actions CI

- **Status:** ACCEPTED (implementation-detail decision under the smaller-scope rule; surfaced per protocol)
- **Date:** 2026-08-22

## Context

Phase 1 requires CI green across lint, typecheck, test, build, and license audit. The stack table fixes languages/frameworks but not dev tooling. Tooling licenses must fall inside the allowlist (MIT, Apache-2.0, BSD, ISC, MPL-2.0).

## Options considered

- **Lint**: ESLint 9 flat config + typescript-eslint (BSD-2-Clause) vs Biome (single tool, faster, younger) vs OxLint. 
- **Test**: Vitest (MIT) vs Jest (BSD; heavier, slower TS integration) vs node:test (built-in, fewer ergonomics).
- **CI**: GitHub Actions (owner already offered a private repo + token for offloading heavy work) vs local-only scripts.

## Decision

**ESLint 9 flat + typescript-eslint, Vitest, GitHub Actions**, with a single `pnpm verify` local script mirroring CI exactly (so "works on my machine" and CI cannot drift). No Prettier in v1 — ESLint stylistic rules suffice; revisit if formatting churn becomes a problem. CI additionally runs `cargo check` on `src-tauri` once Rust is in the toolchain.

## Consequences

One lint/test/CI convention across all TS workspaces; fast watch-mode tests; CI requires the owner to eventually provide the private GitHub repo (local `pnpm verify` is the interim gate — the workflow file ships now and runs when a remote exists; realized via ADR-0012). Biome/OxLint remain a possible future swap via ADR if lint speed ever matters.

**Addendum (2026-08-22, Phase 2):** the license-audit script gained SPDX OR-expression parsing — a choice expression such as `(AFL-2.1 OR BSD-3-Clause)` (the `json-schema` dependency) passes when at least one branch is allowlisted; copyleft branches are still rejected by the GPL check first. Parser support only: the allowlist policy itself is unchanged.
