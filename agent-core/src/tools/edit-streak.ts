/**
 * ROUND-71 (R71-e2, D2): the per-session CONSECUTIVE EDIT-FAILURE COUNTER —
 * cline's progressive-failure-escalation pattern ("the crown jewel" per the
 * R71-b research), ported for our edit_file tool.
 *
 * The failure mode: a model whose edit_file anchor does not match keeps
 * retrying variations of the SAME stale anchor. Every failure used to return
 * the identical one-liner ("oldString not found in 'x'"), so the model had
 * no signal that its understanding of the file was out of date and no
 * instruction to re-read — it just burned turns until the loop guard's
 * consecutive-failure stop (runtime.ts, 6 calls) killed the whole turn.
 *
 * The fix (pure feedback-string logic, mirroring cline's
 * writeToFileMissingContentError): a per-SESSION counter of consecutive
 * edit_file anchor failures; the failure TEXT escalates as the streak grows:
 *
 *   1st failure — the existing honest error, unchanged (it already says
 *                 exactly what went wrong; spamming advice on a single
 *                 miss would be noise);
 *   2nd         — re-read the file, copy the anchor EXACTLY;
 *   3rd/4th     — you MUST change your approach (read the exact region, or
 *                 rewrite the whole file with write_file);
 *   5th+        — refuse the pattern: stop editing, read the file fresh,
 *                 state the actual current content, then choose a verified
 *                 anchor or write_file.
 *
 * RESET on any successful edit_file (a success proves the model's file view
 * is current again — the streak is about staleness, not about the model
 * being "bad"). Only ANCHOR failures count ("edit failed: …" — the
 * not-found / ambiguous-anchor outcomes from fs-ops.editFile); a missing
 * file or a containment error is a different failure with its own remedy.
 *
 * Storage: a module-level Map<sessionId, count>. This is in-process, in
 * memory, and NEVER persisted — like the loop-guard streaks, it is machine
 * feedback about a flailing pattern, not a fact about the conversation. The
 * counter is capped at 999 (the displayed ordinal stays honest, the number
 * cannot grow without bound); entries live for the process lifetime (one
 * number per session — bounded by the session count, deleted on the next
 * successful edit). Tests reset the whole map through the exported seam.
 */
import type { ToolResult } from "./registry.js";

/** The counter's hard cap — display stays an honest ordinal, growth stops. */
const MAX_STREAK = 999;

const streaks = new Map<string, number>();

/** Read a session's current consecutive-failure count (0 = clean). */
export function editStreakCount(sessionId: string): number {
  return streaks.get(sessionId) ?? 0;
}

/** Record one more consecutive edit_file failure; returns the NEW count. */
export function recordEditFailure(sessionId: string): number {
  const next = Math.min((streaks.get(sessionId) ?? 0) + 1, MAX_STREAK);
  streaks.set(sessionId, next);
  return next;
}

/** Reset a session's streak (called on every SUCCESSFUL edit_file). */
export function resetEditStreak(sessionId: string): void {
  streaks.delete(sessionId);
}

/** Test seam: wipe every streak (keeps suites independent of call order). */
export function resetEditStreaksForTest(): void {
  streaks.clear();
}

/** English ordinal for the escalation text (1st, 2nd, 3rd, 4th, 11th, …). */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * The escalation suffix for a streak of `count` consecutive anchor
 * failures — APPENDED to edit_file's existing honest error text (the base
 * error keeps naming the cause; the suffix adds the strategy). "" for a
 * first failure. Tier boundaries per the R71-d design: 2 / 3 / 5.
 */
export function editFailureSuffix(count: number): string {
  if (count <= 1) return "";
  if (count === 2) {
    return (
      ` (2nd consecutive edit failure — re-read the file with read_file and copy the anchor EXACTLY ` +
      `from the current content.)`
    );
  }
  if (count < 5) {
    return (
      ` (${ordinal(count)} consecutive edit failure — you MUST change your approach: ` +
      `read_file the exact region, or use write_file to rewrite the whole file. ` +
      `Do not retry the same anchor.)`
    );
  }
  return (
    ` (${ordinal(count)} consecutive edit failure — refusing this pattern. Stop editing: ` +
    `read_file the file fresh, state the actual current content region containing your target, ` +
    `and choose edit_file with a verified anchor or write_file.)`
  );
}

/**
 * Does this edit_file result count toward the streak? Only ANCHOR failures
 * do — fs-ops.editFile's "edit failed: …" outcomes (not found / ambiguous
 * anchor). A missing file or a path-containment error has a different
 * remedy and must not trigger the re-read escalation.
 */
export function isEditAnchorFailure(result: ToolResult): boolean {
  return result.ok === false && result.output.startsWith("edit failed:");
}
