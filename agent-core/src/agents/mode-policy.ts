/**
 * ROUND-81 (R81, ADR-0029): MODE POLICY — the enforcement tier of the
 * UNIFIED OPERATING MODES. The owner's one-picker redesign folded the old
 * six-builtin task-mode picker (R73/R75) and the four-value permission
 * switcher (R50-c1) into exactly THREE operating modes:
 *
 *   · full — FULL ACCESS: every tool, zero approval prompts. The agent
 *     decides autonomously how to work (research / plan / build / debug /
 *     edit) and switches POSTURES via switch_mode as the task's shape
 *     changes.
 *   · ask  — ASK (default): every tool, but ask-tier gates wait on the
 *     owner before important commands/changes.
 *   · plan — PLAN: read-only — the agent can plan, read, and research,
 *     but cannot edit the project or run mutating commands.
 *
 * THE SEPARATION OF POWERS (what R81 changed):
 *   · ENFORCEMENT lives ONLY here: the operating mode drives the tool
 *     allowlist (modeAllowList in runtime.ts consumes PLAN_MODE_TOOLS)
 *     and the approval gates (approvals.ts — full widens ask-tier
 *     decisions). The retired "editor" value reads as "ask" (storage
 *     remap + migration 0029).
 *   · The old R75 task-mode policy tier (TASK_MODE_TOOL_POLICY,
 *     TASK_MODE_READ_ONLY, narrowAllowListByTaskModePolicy, the debug
 *     command tier, the owner-pin) is RETIRED: task modes are now
 *     NON-ENFORCING posture guidance the agent self-selects. A session
 *     that needs to be read-only is in PLAN mode (enforced below); a
 *     "plan"/"review"/"explore" POSTURE in Full/Ask shapes HOW the agent
 *     works but no longer removes tools. Migration 0029 preserves the R75
 *     guarantee for historical sessions (read-only postures → permission
 *     'plan', fail-closed).
 *
 * DESIGN (unchanged invariants):
 *   · Only NARROWS, never widens — the mode set can only REMOVE names
 *     from the post-agent, post-delegation-depth allowlist. Composition
 *     order in prepareTurn:
 *       agent allowlist → delegation depth → operating mode (HERE, via
 *       runtime's modeAllowList) → custom-posture `tools` frontmatter (R73,
 *     opt-in narrowing that survives as an extension surface).
 *   · The toolset AND the system prompt's toolNames both reflect the
 *     narrowed list (prepareTurn builds both from the same allowlist) —
 *     the model never sees a write tool it cannot call (ADR-0019's
 *     vocabulary honesty).
 *   · `switch_mode` is in the plan set (the agent can always manage its
 *     POSTURE pointer — an observation-level act; the R73-b dark-tools
 *     honesty rule). No tool can change the OPERATING mode: that is the
 *     owner's picker alone (PATCH /sessions/:id/permissions).
 *
 * Pure module: no DB, no I/O, never throws. The allowlist intersection
 * happens in ONE place (runtime.ts sessionToolAllowList) and the SAME set
 * governs built-in, external (.mjs), and MCP (mcp__*) tools —
 * buildProjectTools filters all three through the allowlist uniformly, so
 * this policy is the single chokepoint.
 */

/**
 * PLAN mode's read-only/research tool set — the canonical definition of
 * what a PLAN session may call. runtime.ts imports it for the
 * operating-mode gate (modeAllowList).
 *
 * Research, navigation, web, todos, memory, and delegation — but NO file
 * mutation (write_file/edit_file/create_dir/delete_file), NO run_command,
 * NO index_project (it writes to the DB + walks the tree). Applied as an
 * INTERSECTION with the agent's own allowlist, so a mode never widens it.
 *
 * ROUND-81: the R75 READ_ONLY_EXTRAS (the retired review/explore task
 * modes' superset) are folded in — the git inspectors, analyze_image, and
 * job_status are pure observations, and the unified PLAN mode is the sole
 * read-only tier now, so it carries the full read-only vocabulary.
 */
export const PLAN_MODE_TOOLS: readonly string[] = [
  "read_file",
  "list_dir",
  "search_files",
  "search_code",
  "web_search",
  "web_fetch",
  "browser_control",
  "todo_write",
  "memory_save",
  "memory_recall",
  "memory_list",
  "delegate_task",
  // ROUND-70 (R70-b): reading a skill is an observation exactly like
  // memory_recall — the prompt's SKILLS section says "call read_skill
  // FIRST", so plan mode must not advertise the index while the loader
  // is dark (the D4 dark-tools honesty rule, applied to the mode gate).
  "read_skill",
  // ROUND-73 (R73-b follow-up) / ROUND-81: posture management is an
  // observation-level SESSION-STATE change (no files, no commands, no
  // network) — the agent in PLAN mode still picks its posture
  // discipline; the D4 honesty rule keeps the tool advertised.
  "switch_mode",
  // ROUND-75 (R75, retired review/explore sets) / ROUND-81: read-only
  // observations a reviewer/explorer needs — the git inspectors read
  // history, analyze_image reads screenshots/diagrams, job_status
  // watches a running build. job_stop is deliberately NOT here (killing
  // a process is a side effect).
  "git_status",
  "git_diff",
  "git_log",
  "analyze_image",
  "job_status",
];
