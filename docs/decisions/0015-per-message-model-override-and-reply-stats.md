<!-- last-reviewed: 2026-08-30 round-54 -->
# ADR-0015: Per-message model override + per-reply stats on assistant events

- **Status:** ACCEPTED (backfilled round-17; decided in round-16)
- **Date:** 2026-08-23

## Context

Owner round-16: show model selection at the composer, context window, and
per-reply telemetry (time, tokens in/out, tok/s). Model choice lived only on
the agent record; replies had no timing/usage payload.

## Options considered

- **Agent-only model + client-side timing** — no context meter accuracy, no
  server truth, per-send switching impossible.
- **Model override per message + stats persisted on the event** — server
  truth, works for both sync and streamed turns.

## Decision

Both turn routes accept optional `model` (overrides the agent's model for
that call, non-persisted). Assistant events carry
`usage{inputTokens,outputTokens}, ms, model` in the payload; usage_events
rows record the ACTUAL model used. UI renders chips + ctx meter from these.

## Consequences

Per-send experimentation without editing agents; historical replies show the
model that produced them. Stats payload is now part of the event contract —
consumers must tolerate its absence on pre-R16 events. Reversal: additive;
ignore fields.
