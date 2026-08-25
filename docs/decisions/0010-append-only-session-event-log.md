<!-- last-reviewed: 2026-08-25 round-35 -->
# ADR-0010: Session transcripts — append-only event log, not in-place message mutation

- **Status:** ACCEPTED (implementation-detail decision under the smaller-scope rule; surfaced per protocol)
- **Date:** 2026-08-21

## Context

Sessions need full per-agent transcripts, browsable history, live streaming to the UI, crash-safe resume, and an audit-consistent record of approvals (SPEC §F3, §F6, §F8). Two proven storage shapes exist in the references: goose's `messages` table (rows updated/amended as the session lives) and OpenHands' event-sourced log — one immutable JSON row per event, state rebuilt by replay (research/openhands, "Event model"; synthesis §6 explicitly recommends the OpenHands pattern for us).

## Options considered

- **A. Append-only `session_events` table + query-time projections** — every fact (user message, assistant delta flush, tool call, tool result, approval step, task move, interruption) is an insert with a per-session monotonic `seq`; UI reads/streams ordered events; session status and task counts are small derived state updated alongside.
- **B. In-place message rows (goose shape)** — familiar CRUD, but every mid-flight edit (streaming parts, retries, revisions) becomes an UPDATE, replaying history becomes ambiguous, and crash-recovery needs tombstones. Goose additionally needs timestamp-clamping logic to keep ordering monotonic — a smell (research/goose, "Write ordering is monotonic by construction").

## Decision

**Option A** (the directed pattern): `session_events` is insert-only; nothing in the system ever updates or deletes an event row (ARCHITECTURE §5.1). "Editing" is a new event; session state is a projection maintained in the same transaction as the append.

## Consequences

Crash recovery degenerates to "sessions without a terminal event are `interrupted`" — no transcript can be half-written (ARCHITECTURE §2.4). WS backfill after reconnect is exact: `afterSeq` + ordered rows (api/API.md §5.6). Streaming deltas are buffered and flushed at part boundaries to bound write amplification (ARCHITECTURE §5.2). Costs: storage grows monotonically (acceptable: text rows, SQLite handles GBs; a future compaction can derive summaries without deleting the log), and queries for "final message list" need an event-type filter — a fixed view per mode. Reversal cost: high by design — the event log becomes the system's memory; that permanence is the feature.
