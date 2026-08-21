# ADR-0001: Orchestration run modes — single-agent default, orchestrator-driven auto-team

- **Status:** ACCEPTED (owner decision, 2026-08-21)
- **Date:** 2026-08-21

## Context

The original brief specified user-assembled teams (open a project, assemble a team). The owner explicitly revised this: team assembly must not require user intervention — the system should compose the team itself from the task, and the default experience should be simple. The owner also asked for a "cheaper orchestrator AI + powerful capable worker" topology and for future-proofing toward highly customizable multi-agent communication.

## Options considered

- **A. Manual team assembly only** — user picks agents each session. Maximum control, but exactly the friction the owner rejected.
- **B. Fully automatic teams only** — system always spawns a team. Simple, but wastes tokens/cost on trivial tasks and removes user control.
- **C. Three run modes** — single-agent (default), auto-team, manual team (advanced).

## Decision

Adopt **Option C**. Sessions run in one of three modes: (1) **Single-agent** — one agent, one model, full toolset; the zero-config default. (2) **Auto-team** — an orchestrator agent, routed by default to a cheaper model, analyzes the task, composes a team from templates/registry, delegates with the context each worker needs (files, locations, constraints), monitors and integrates; the powerful worker model does the heavy lifting. (3) **Manual team** — explicit user selection, minimal UI in v1. All modes share the message bus, task board, transcripts, and the 5-concurrent-agent hard cap with queueing. Team topology (roles, wiring, communication rules) is stored as data, not code, so custom topologies remain possible without engine changes.

## Consequences

The engine must support delegation/planning as a first-class agent capability from Phase 3, and the orchestrator role needs its own default model routing (cheap) distinct from worker routing (powerful). Slightly more design work in Phase 3 than a single fixed pipeline; in exchange, cost stays proportional to task size and the owner never assembles anything unless they want to. Reversal cost: moderate — modes are session-level configuration, so any mode can be demoted later without touching storage.
