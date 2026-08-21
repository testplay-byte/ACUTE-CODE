/**
 * Risk-categorization policy. Phase 2 replaces these tables with the real
 * per-tool policy engine; the categorize() contract stays.
 *
 * Fail-closed by design (SPEC F6 / ARCHITECTURE §7): anything that is not on
 * the explicit read-only safelist lands on at least "confirm". Unknown commands
 * are never auto-approved.
 */
import type { ToolPermission } from "shared";

/**
 * Risk tier for a prospective tool action. Extends shared's ToolPermission
 * with a fourth tier for irreversible operations (typed confirmation).
 */
export type ActionCategory = ToolPermission | "destructive";

/** Explicitly safelisted read-only commands eligible for "auto". */
const AUTO_PATTERNS: readonly RegExp[] = [
  /^(ls|dir|cat|type)(\s|$)/i,
  /^git\s+(status|diff|log)(\s|$)/i,
];

const BLOCKED_PATTERNS: readonly RegExp[] = [
  /^format\s+[a-z]:/i,
  /^del\s+\/[sq]/i,
  /^rmdir\s+\/s/i,
  /^remove-item\s+.*-recurse/i,
];

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /git\s+push\s+.*(--force\b|-f\b)/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*f/i,
];

/**
 * True when the command is an `rm` invocation whose flags include -r and/or
 * -f (in any combination or position, e.g. `rm -rf`, `rm -fr`, `rm -i -rf`,
 * `rm target -r`). Pure token scan — no environment access.
 */
function hasRecursiveOrForceRm(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if ((tokens[0] ?? "").toLowerCase() !== "rm") return false;
  return tokens.slice(1).some(
    (token) => /^-[a-z]*[rf]/i.test(token) || token === "--recursive" || token === "--force",
  );
}

export function categorize(action: string): ActionCategory {
  const normalized = action.trim();
  if (hasRecursiveOrForceRm(normalized)) return "blocked";
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) return "blocked";
  }
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) return "destructive";
  }
  if (AUTO_PATTERNS.some((pattern) => pattern.test(normalized))) return "auto";
  return "confirm";
}

/** Stub for the approval UI: the real version returns per-policy explanations. */
export function riskNote(action: string): string {
  return `[${categorize(action)}] review before approving: ${action}`;
}
