<!-- last-reviewed: 2026-09-17 round-102 -->
# ADR-0014: SSE streaming for chat turns (no WS gateway in v1)

- **Status:** ACCEPTED (backfilled round-17; decided in round-16)
- **Date:** 2026-08-23

## Context

Owner round-16: "show me the actual live responses… as the answers are being
created". ARCHITECTURE §6 planned a WS gateway (first-message auth frame,
subscriptions, event fan-out) — a large surface for a per-turn need, and the
UI is a per-session view today.

## Options considered

- **WS gateway per ARCHITECTURE §6** — full push channel; heavy, needed
  mostly by Phase 3 (approvals, multi-agent), overkill for one-turn
  streaming.
- **Polling the event log** — trivial but not live; owner explicitly wanted
  in-flight text and tool calls.
- **SSE on the turn route** — one request ↔ one turn, native browser EventSource
  semantics, abort-on-disconnect for free.

## Decision

Stream turns over `POST /sessions/:id/messages/stream` (SSE, bearer-walled):
normalized frames `text-delta | tool-call | tool-result | finish` + terminal
`done|error`; client disconnect aborts the provider call. The sync route
remains (CLI/tests/fixture mode). `streamAiSdkChat` mirrors `aiSdkChat` over
`streamText`; usage = awaited totals cross-checked against per-step
`finish-step` sums.

## Consequences

Live chat UX today with no gateway. When Phase 3 needs cross-session push
(approvals, delegation, workflow events) the WS gateway decision returns as
a NEW ADR; SSE may remain for per-turn text. Reversal cost: low (the runtime
emits normalized events; transports swap at the route).
