/**
 * ROUND-75 (R75): TASK-MODE POLICY — the hard enforcement layer the six
 * builtin task modes (plan / debug / build / review / explore / refactor)
 * never had. Until this module, a task mode was PURE PROMPT SUGGESTION:
 * the mode body said "NO EDITS" in prose, but the turn's tool set still
 * carried write_file / edit_file / run_command, so a plan-mode agent could
 * (and did — the owner's R75 report) edit files and run commands the moment
 * the model ignored the prose. The permission-mode system (full/ask/plan/
 * editor, R50-c1) was always hard-enforced via allowlist intersection;
 * this module extends the SAME mechanism to task modes.
 *
 * DESIGN (mirrors the permission-mode rules exactly):
 *   · Only NARROWS, never widens — a policy set can only REMOVE names
 *     from the post-permission-mode, post-agent, post-frontmatter
 *     allowlist. Composition order in prepareTurn:
 *       agent allowlist → delegation depth → permission mode
 *       → custom-mode `tools` frontmatter (R73) → task-mode policy (HERE).
 *   · plan      → READ-ONLY: PLAN_MODE_TOOLS verbatim (the R50-c1 owner
 *                 spec — research, navigation, web, todos, memory,
 *                 delegation; no file mutation, no run_command, no
 *                 index_project).
 *   · review    → READ-ONLY: plan's set + the git inspectors
 *                 (git_status/git_diff/git_log), analyze_image, and
 *                 job_status — a reviewer reads code and history, never
 *                 writes it.
 *   · explore   → READ-ONLY: the same read-only superset as review —
 *                 exploration is search/read/web, zero side effects.
 *   · debug     → NO ALLOWLIST NARROWING (a debugger must edit files to
 *                 fix the bug). Its restriction lives in approvals.ts:
 *                 run_command demotes to the AUTO tier only (read-only,
 *                 build, test commands) — interactive/destructive tiers
 *                 are denied with an honest switch_mode note (R75).
 *   · build     → FULL (no narrowing) — the default working posture.
 *   · refactor  → FULL (no narrowing) — behavior-preserving edits still
 *                 need the full toolset; the body's prose carries the
 *                 discipline.
 *   · Custom modes (.acute/agents/*.md): no builtin policy by id UNLESS
 *     they shadow a builtin id (a custom "plan" is still a plan). The
 *     R73 frontmatter `tools` list intersects with the policy — a custom
 *     shadow of plan that lists write_file gets the write dropped:
 *     a read-only mode stays read-only, however it was declared.
 *   · `switch_mode` is in every read-only set (the escape hatch — the
 *     model can always leave the posture it is stuck in; the R73-b
 *     dark-tools honesty rule).
 *
 * The toolset AND the system prompt's toolNames both reflect the narrowed
 * list (prepareTurn builds both from the same allowlist) — the model never
 * sees a write tool it cannot call (ADR-0019's vocabulary honesty).
 *
 * Pure module: no DB, no I/O, never throws. The allowlist intersection
 * happens in ONE place (prepareTurn) and the SAME set governs built-in,
 * external (.mjs), and MCP (mcp__*) tools — buildProjectTools filters all
 * three through the allowlist uniformly, so this policy is the single
 * chokepoint.
 */

import type { TaskMode } from "./modes.js";
import { NO_TOOLS } from "../tools/index.js";

/**
 * PLAN mode's read-only/research tool set (owner spec, exact) — the R50-c1
 * list, moved here from runtime.ts (R75) so both the permission-mode gate
 * and the task-mode policy share ONE canonical definition. runtime.ts
 * re-exports it for the historical import surface. Research, navigation,
 * web, todos, memory, and delegation — but NO file mutation (write_file/
 * edit_file/create_dir/delete_file), NO run_command, NO index_project (it
 * writes to the DB + walks the tree). Applied as an INTERSECTION with the
 * agent's own allowlist, so a mode never widens it.
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
  // ROUND-73 (R73-b follow-up): switching a task mode is an observation-
  // level SESSION-STATE change (no files, no commands, no network) — the
  // same D4 honesty rule, now for the TASK MODES section: plan permission
  // mode advertises the mode index + the "consider switch_mode FIRST"
  // task-signal line, so the switch must not be dark there. It is also the
  // natural pairing: plan PERMISSION mode × plan TASK MODE.
  "switch_mode",
];

/**
 * Read-only observations the review/explore postures add on top of plan's
 * set: the git inspectors (a reviewer reads history), the image analyzer
 * (screenshots/diagrams are observations), and job polling (watching a
 * build run is not mutating it). job_stop is deliberately NOT here —
 * killing a process is a side effect.
 */
const READ_ONLY_EXTRAS: readonly string[] = [
  "git_status",
  "git_diff",
  "git_log",
  "analyze_image",
  "job_status",
];

/** The builtin ids whose posture is HARD read-only (UI badges + prose). */
export const TASK_MODE_READ_ONLY: ReadonlySet<string> = new Set(["plan", "review", "explore"]);

/**
 * The per-builtin-id tool policy: the allowlist a session with that task
 * mode active is intersected down to. Absent id (debug / build / refactor /
 * any custom id) → no narrowing (FULL; debug's command-tier gate lives in
 * approvals.ts, build/refactor are working postures, customs carry only
 * their own R73 frontmatter narrowing).
 */
export const TASK_MODE_TOOL_POLICY: Readonly<Record<string, readonly string[]>> = {
  plan: PLAN_MODE_TOOLS,
  review: [...PLAN_MODE_TOOLS, ...READ_ONLY_EXTRAS],
  explore: [...PLAN_MODE_TOOLS, ...READ_ONLY_EXTRAS],
};

/**
 * Intersect the turn's allowlist with the active task mode's policy.
 * Undefined / no active mode / a mode with no policy entry (debug, build,
 * refactor, custom ids) → the allowlist passes through UNTOUCHED.
 * The NO_TOOLS sentinel semantics match narrowAllowListByTaskMode: an
 * empty intersection must mean "register nothing", never "all" — the
 * caller passes the sentinel through (never []).
 */
export function narrowAllowListByTaskModePolicy(
  allowList: readonly string[] | undefined,
  activeTaskMode: TaskMode | undefined,
): readonly string[] | undefined {
  if (activeTaskMode === undefined) return allowList;
  const policy = TASK_MODE_TOOL_POLICY[activeTaskMode.id];
  if (policy === undefined) return allowList;
  // undefined / [] mean "ALL" (ADR-0019) — ALL ∩ policy = the policy itself.
  if (allowList === undefined || allowList.length === 0) return policy;
  // NO_TOOLS already means "register nothing" — the intersection keeps it.
  if (allowList.includes(NO_TOOLS[0])) return allowList;
  const filtered = allowList.filter((tool) => policy.includes(tool));
  return filtered.length > 0 ? filtered : NO_TOOLS;
}

/** True when the mode (by id) is a hard read-only posture. */
export function isReadOnlyTaskMode(modeId: string | null | undefined): boolean {
  return modeId !== null && modeId !== undefined && TASK_MODE_READ_ONLY.has(modeId);
}
