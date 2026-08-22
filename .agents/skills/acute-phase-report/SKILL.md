---
name: acute-phase-report
description: Assemble the end-of-phase report for the ACUTE-CODE product owner. Use at the end of every build phase, before requesting approval to proceed to the next phase.
---

# Phase Report (ACUTE-CODE)

Every phase ends with a report to the product owner and NO next phase starts without explicit approval. The report contains, in this order:

1. **Deliverables** — what was built/produced, with file paths in the `acute-code/` repo.
2. **Acceptance checklist** — each exit criterion for the phase with actual PASS/FAIL status and evidence (test run output, command result, measurement).
3. **Demo instructions** — steps the owner can follow in under 2 minutes to see the phase working (also recorded in `docs/runbooks/DEMO.md` once there is a runnable app).
4. **Performance vs budget** — once the app boots: cold/warm start times and memory at idle (targets: <5s/<2s, <700 MB idle, <2.5 GB with 5 agents). Before that, state "not yet measurable" and why.
5. **Assumptions & ADRs** — every ADR accepted this phase, one line each; `[ASSUMPTION]`-tagged ADRs called out explicitly for review.
6. **Deferred & known issues** — what was cut and why, with ADR references where applicable.
7. **Open questions** — numbered, labeled `[BLOCKING]` or `[NON-BLOCKING]`, each with a recommended default. Cap 10 per phase; batch once.

## Rules

- Report facts as measured, never as hoped. A FAIL is reported as a FAIL.
- If CI exists, report its state (lint/typecheck/test/build/license audit).
- End the report by asking for explicit approval to begin the next phase.
