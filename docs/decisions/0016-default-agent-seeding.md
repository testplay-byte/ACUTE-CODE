<!-- last-reviewed: 2026-09-19 round-108 -->
# ADR-0016: Plug-and-play default agent ("Acute")

- **Status:** ACCEPTED (backfilled round-17; decided in round-15, renamed round-16)
- **Date:** 2026-08-23

## Context

Owner (round-15, after a dead-end "Create an agent in settings" on a fresh
install): "by default there is actually no need for any agents or anything
like that to be set up". Round-16: the agent is named **Acute** (owner: "we
should just name it Acute"), not a persona name.

## Options considered

- **Force first-run agent creation wizard** — more setup friction, exactly
  what the owner rejected.
- **Seed a working default agent at DB open** — zero-setup first message.

## Decision

`ensureDefaultAgent` runs at every DB open: if NO non-template agent exists
and the openrouter provider row is present, seed **Acute** (fixed id
`agt_default_nova` kept stable so sessions survive; provider
`openrouter`, model `stealth/ox-alpha`, maxTurns 40, coding prompt). An
unmodified seed row is renamed in place on upgrade; a user who renamed it
keeps their name. Never crowds existing agents.

## Consequences

Fresh installs chat out of the box (fresh-DB journey test is now a standing
gate). The fixed id is contractual. Users wanting other providers edit or
duplicate in Settings. Reversal: delete the row + seed call.
