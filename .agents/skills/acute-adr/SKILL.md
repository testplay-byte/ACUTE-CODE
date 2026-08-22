---
name: acute-adr
description: Record an architecture/decision record for the ACUTE-CODE project. Use whenever a non-trivial decision is made — library choice, data-model change, API shape, trade-off resolution, or a smaller-scope assumption made without the owner's explicit input.
---

# ADR Creation (ACUTE-CODE)

1. Find the next free sequential number N in `acute-code/docs/decisions/` (never reuse or renumber). File: `NNN-short-kebab-title.md`.
2. Copy the structure from `acute-code/docs/decisions/TEMPLATE.md`: **Context → Options considered → Decision → Consequences**.
3. Tag the title with `[ASSUMPTION]` when the decision was made under the smaller-scope rule (implementation-detail ambiguity resolved without the owner). Assumption ADRs must be listed in the next phase report.
4. Keep it decision-focused: why the options were on the table, what tipped it, what we now live with. Link related ADRs and research memos by path.

## Guardrails

- Decisions that conflict with the fixed tech stack, the v1 feature scope, or licensing rules require the owner's written approval BEFORE the ADR is accepted — mark such an ADR `STATUS: PROPOSED` until then.
- Pattern-adoption decisions informed by research must cite the relevant `docs/research/<slug>/` memo.
