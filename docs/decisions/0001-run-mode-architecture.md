<!-- last-reviewed: 2026-09-11 round-90 -->
# ADR-0001: Run-mode architecture — single-agent default, orchestrator-driven auto-team, manual as advanced option

- **Status:** ACCEPTED (owner direction, 2026-08-21)
- **Date:** 2026-08-21

## Context

The original brief specified user-assembled teams (open project → pick agents → run). The owner explicitly reduced intervention: teams should form themselves from the task, with the default being a single agent doing everything. The owner also specified the canonical delegation topology: a cheaper orchestrator AI coordinating a highly capable worker that performs the actual tasks, and asked for future-proofing toward custom inter-agent communication.

## Options considered

- **Manual team assembly only** — maximal control, maximal friction; rejected as the default by the owner.
- **Auto-team only** — simplest mental model but removes the power-user escape hatch and makes single-task runs heavyweight.
- **Three explicit run modes** (single / auto / manual) over one shared engine — modes differ only in how the team is composed, not in how it runs.

## Decision

Sessions select one of three run modes: **single-agent (default)**; **auto-team**, where an orchestrator agent — routed by default to a cheaper model — analyzes the task, composes the team from templates/registry, and delegates with the context each worker needs (files, locations, constraints), while a powerful worker model does the heavy lifting; and **manual team** as the advanced option. All modes share the message bus, task board, 5-concurrent-agent cap with queueing, and per-agent transcripts. Team topology (roles, wiring, communication rules) is stored as data, not code.

## Consequences

The orchestration engine needs a composition step (orchestrator → team plan) before the run loop starts — a small added component that manual mode skips and single mode trivializes. Model routing must support "cheap model for orchestrator, strong model for workers" as a first-class configuration. Future custom topologies (custom communication graphs) become a data-format extension rather than an engine rewrite.
