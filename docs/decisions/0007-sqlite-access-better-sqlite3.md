<!-- last-reviewed: 2026-09-12 round-98 -->
# ADR-0007: SQLite access — better-sqlite3 with hand-written numbered migrations

- **Status:** ACCEPTED (implementation-detail decision under the smaller-scope rule; surfaced per protocol)
- **Date:** 2026-08-21

## Context

The sidecar exclusively owns SQLite in WAL mode (SPEC §3). All references converge on migration-based, WAL-mode, single-writer SQLite (goose: sqlx + `schema_version` + numbered migrations; hermes: single-writer queue; opencode: migrating onto Drizzle/SQLite; synthesis §6). We need: synchronous fast reads/writes from one Node process, WAL, FTS5 (memory/skills recall, SPEC §F8), transactions for the append-only event log (ARCHITECTURE §5), and a migration story that runs on first boot with zero admin rights (SPEC §F11). Node 24.18 is the pinned baseline (ADR-0002).

## Options considered

- **A. better-sqlite3 (MIT)** — synchronous, the fastest Node SQLite binding; prebuilt Windows x64 binaries (no toolchain needed in CI); WAL, FTS5, transactions, user-auth extensions all supported; one native `.node` addon to ship (handled by ADR-0009 packaging). De-facto standard for local-first Node apps.
- **B. Drizzle ORM (Apache-2.0)** — TypeScript-first query builder; but it is a layer *over* a driver (itself typically better-sqlite3), adds `drizzle-kit` to the toolchain, and our access patterns (append-only event log, GROUP BY usage rollups, FTS5) are closer to raw SQL than to an object graph. License verified Apache-2.0.
- **C. `node:sqlite` built-in** — zero native addons, which is attractive for packaging; but on the Node 24 line it remains **experimental** (stability "Release candidate" only arrived at Node 25.7; verified 2026-08-21 against Node docs and nodejs/node#57445). Building the security-relevant audit/event storage on an experimental API is unnecessary risk while we are pinned to Node 24.

## Decision

**better-sqlite3 (MIT)** accessed only through `agent-core/src/storage/`, with **numbered plain-SQL migration files** applied in order and recorded in a `schema_migrations` table (goose discipline); a serialized write queue inside `storage/` enforces single-writer discipline (hermes pattern). No ORM — repository functions return typed rows via `@acute/shared` types.

## Consequences

One native addon ships with the sidecar bundle (ADR-0009 covers copying `.node` files next to the esbuild output). Schema changes are reviewable SQL diffs; Phase 2 authors the initial migration set from ARCHITECTURE §5. If `node:sqlite` reaches stable on a future Node LTS, migrating drivers is a contained change inside `storage/` (low-moderate reversal cost) and would let us drop the native addon; Drizzle remains a possible future add *on top of* better-sqlite3 without changing this decision's driver layer.
