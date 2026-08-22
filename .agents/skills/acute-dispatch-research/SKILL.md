---
name: acute-dispatch-research
description: Dispatch a research sub-agent to analyze a reference project for the ACUTE-CODE build. Use whenever the orchestrator needs reference-project analysis, library evaluation, or a docs/research memo produced — including follow-up research in later phases.
---

# Dispatch Research (ACUTE-CODE)

Produce verified reference-project analyses in `acute-code/docs/research/`. One sub-agent per reference project; run them in the background and in parallel.

## Sub-agent brief template

Send the Agent tool (subagent_type `general-purpose`, run_in_background) a prompt containing, in this order:

1. **Role**: "You are the RESEARCHER sub-agent for ACUTE-CODE" — a local-first, closed-source Windows multi-agent workbench (Tauri 2 shell, React 18/TS UI, Node/TS sidecar owning SQLite via localhost REST+WS; cloud LLM APIs only; human-approval safety layer; max 5 concurrent agents).
2. **Target**: project name + primary repo URL. If the URL 404s or has moved, find the canonical repo and record the redirect.
3. **Verification rule**: every claim must come from the actual repo (README, docs, source tree, package manifests, LICENSE) via web fetch/search — never memory alone. Mark anything unverifiable `[UNVERIFIED]`.
4. **Deliverables** — exactly three files under `C:\Users\khurr\Desktop\ZCODE\ACUTE_CODE\acute-code\docs\research\<slug>\`:
   - `README.md` — executive summary: what it is, exact SPDX license from the LICENSE file, tech-stack table, top 2–3 adoptable patterns (one line each), what to avoid (one line each), and a "relevance to ACUTE-CODE" verdict paragraph.
   - `architecture.md` — process/component model, module map, data flow, storage, extension points; include one ASCII diagram.
   - `patterns-for-acute-code.md` — per pattern: WHAT it is in the reference, WHY it fits ACUTE-CODE, HOW it maps to our stack (Tauri/Node sidecar/SQLite); then "what to avoid" with reasons (complexity, license risk, scope mismatch).
5. **Focus hints**: pass the known starting points for that project (e.g., Cline's Plan/Act modes, OpenCode's client-server split, Hermes memory tiers, MetaGPT role topology, OpenHands Agent Server REST, Kilo parallel agents, Aider repo map, Goose MCP-first extensions, Letta memory blocks).
6. **Constraints**: study patterns only, never propose copying code. Flag license incompatibility with our allowed set (MIT, Apache-2.0, BSD, ISC, MPL-2.0; GPL/AGPL/LGPL forbidden for dependencies — reading GPL code to learn is fine, copying is not).
7. **Return contract** (§8 of the brief): the final message must state (1) what it did, (2) artifacts produced with paths, (3) open questions / `[UNVERIFIED]` items.

## After dispatch

Verify each memo exists and is substantive (read the README at minimum). Re-dispatch weak or missing outputs to a fresh agent rather than patching them yourself. Then update `docs/research/README.md` (the cross-project index) yourself — synthesis is the orchestrator's job, not the sub-agent's.
