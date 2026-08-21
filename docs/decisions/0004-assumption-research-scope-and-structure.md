# ADR-0004: [ASSUMPTION] Phase 0 research scope and memo structure

- **Status:** ACCEPTED (assumption — surfaced for owner review)
- **Date:** 2026-08-21

## Context

The brief mandates six reference analyses (Cline, OpenCode, Hermes Agent, MetaGPT, OpenHands, Kilo Code) and adds "and many other good ones need to be researched too". The orchestrator recommended three extras (Aider, Goose, Letta/MemGPT); the owner approved "those two" — an ambiguous count against a list of three. The owner also asked for research "in proper dedicated folders with proper format, like proper hierarchy… so that multiple parts of them are documented well", while the brief's §5 sketched flat single-file memos.

## Options considered

- **Scope:** exactly two of the three recommended extras (ambiguous which two) vs all three.
- **Structure:** one flat memo per project vs a dedicated folder per project with multiple documents.

## Decision

1. Research **all three** extras — the superset; each has a distinct payoff (Aider: repo-map & edit reliability; Goose: MCP-first + daemon split; Letta: memory architecture). Total: nine references.
2. Each reference gets a dedicated folder `docs/research/<slug>/` containing three documents: `README.md` (executive summary + verdict), `architecture.md` (system design), `patterns-for-acute-code.md` (adoption mapping). A top-level `docs/research/README.md` indexes and synthesizes them.

## Consequences

Slightly longer Phase 0 wall-clock and richer structure than the brief's flat-file sketch, in exchange for clearer navigation and room to extend a reference's folder later without restructuring. If the owner intended only two extras, the third memo costs nothing to keep. Constraint discovered: the build system's sub-agent concurrency is limited to two simultaneous research agents, so the nine dispatches run in waves rather than all at once.
