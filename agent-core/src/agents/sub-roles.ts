/**
 * ROUND-84 (R84, Wave 2-c of the R80.5 modularity audit): the sub-role
 * vocabulary, lifted to a LEAF module.
 *
 * SUB_ROLES/SubRole previously lived in agents/orchestrator.ts — and the
 * delegation PLUGIN's value-import of them (plus getOrchestrator) was the
 * root cause of the 25-file tools↔agents SCC (delegation → orchestrator →
 * runtime → tools/index → registry → delegation): ESM-legal, but no layer
 * boundary existed between the tool layer and the orchestration layer.
 *
 * This module imports NOTHING. The vocabulary is a domain constant both
 * layers need; the leaf placement lets the tool layer depend on the WORDS
 * without depending on the ORCHESTRATOR. orchestrator.ts re-exports both
 * for every pre-R84 importer (byte-identical compat).
 */

/** The five seeded sub-agent roles (SPEC §F2; ADR-0022's delegation roles). */
export const SUB_ROLES = ["planner", "researcher", "coder", "reviewer", "tester"] as const;

export type SubRole = (typeof SUB_ROLES)[number];
