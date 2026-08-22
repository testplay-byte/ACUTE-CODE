# ADR-0004: [ASSUMPTION] Phase 0 research scope — all three recommended extras — and per-reference folder structure

- **Status:** ACCEPTED (assumption surfaced for owner review in Phase 0 report)
- **Date:** 2026-08-21
- **Tags:** [ASSUMPTION]

## Context

Two small ambiguities in the owner's Phase 0 direction: (1) the owner approved "those two" extra references, but three had been recommended (Aider, Goose, Letta) — which two was never specified; (2) the owner asked for research "in proper dedicated folders with proper hierarchy and format… so that multiple parts of them are documented well," which goes beyond the brief's original single flat memo per project (`<name>-analysis.md`).

## Options considered

- Ask which two extras were meant — burns a blocking question on a low-stakes scope detail; the smaller-scope rule says decide and flag.
- Two extras (guess which) vs all three — taking all three is a strict superset of any reading of the instruction.
- Flat memo vs folder-per-reference — flat matches the original brief text; folders match the owner's newer, more specific instruction, which supersedes.

## Decision

Research all nine references (six mandatory + Aider, Goose, Letta), each as a dedicated folder `docs/research/<slug>/` containing three files: `README.md` (executive summary + verdict), `architecture.md` (deep architecture with diagram), `patterns-for-acute-code.md` (adopt/avoid mapping). A cross-project index at `docs/research/README.md` is written by the orchestrator.

## Consequences

Slightly more research time (nine dispatches instead of eight); materially better-organized memos that can grow addenda per reference without reformatting. If the owner meant only two extras, the third memo costs nothing to keep. Reversal is trivial (delete a folder).
