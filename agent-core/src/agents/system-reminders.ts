/**
 * ROUND-73 (R73-d): SYSTEM-REMINDERS — the ONE generalized renderer for the
 * fenced reminder blocks the agent appends to tool outputs and turn content,
 * plus the per-turn budget that keeps them rare.
 *
 * WHY (the R73 queue's own words): "a generalized system-reminder injector —
 * ONE mechanism for AGENTS.md injections, mode-switch notices,
 * lessons-ledger affordances instead of bespoke strings". R72-d shipped the
 * first such reminder (read_file's per-directory conventions excerpt,
 * tools/dir-conventions.ts) with a bespoke string builder. R73 adds a second
 * consumer (switch_mode's activation notice, the R73-b wave) and the lessons
 * ledger is on the queue — a bespoke format per consumer would drift apart:
 * each would re-invent fences, labels, and separation disclaimers, and each
 * would re-invent its own anti-noise discipline. This module is the one
 * mechanism.
 *
 * THE RENDERER CONTRACT:
 *   - Output structure, every kind: "\n\n--- <label>\n<text>\n<closing
 *     fence>". A leading blank line + "---" fences + a caller-owned label
 *     line make the block visibly SEPARATE from the content it rides with,
 *     and the closing fence states that separation explicitly — so the model
 *     can always tell content from reminder, and a text that itself contains
 *     "---" cannot be mistaken for the closer (the R72-d design,
 *     generalized).
 *   - BYTE-IDENTITY: renderReminder({ kind: "conventions", label, text })
 *     reproduces the R72-d conventionReminder() output EXACTLY — tools/
 *     dir-conventions.ts now delegates to this renderer, and the proof is
 *     tests/r72-dir-conventions.test.ts staying green UNMODIFIED (the
 *     acceptance gate), with the pinned bytes re-stated in
 *     tests/r73-system-reminders.test.ts.
 *   - Pure and dumb: no caps, no validation, no fs, no db. Content policy
 *     lives at the call site (dir-conventions caps its excerpt at 2,000
 *     chars; the modes wave will cap its own bodies). The renderer munges
 *     nothing — the label and text ride verbatim.
 *
 * CONSUMERS: tools/dir-conventions.ts (today — the delegation IS the
 * byte-identity proof); the switch_mode activation notice (the R73-b wave
 * next); lessons-ledger affordances (future). KINDS: "conventions" (rides
 * read_file output — the closer disclaims the file content), "task-mode"
 * (rides mode-switch output — the closer disclaims the surrounding content),
 * "note" (the generic escape hatch: anything else that must reach the model
 * as a clearly-separated system note rather than tool- or user-authored
 * content).
 *
 * THE BUDGET (ReminderBudget): R71's anti-question-padding / anti-noise
 * discipline, made reusable. A reminder is context the model did not ask
 * for; a turn full of them is noise that buries the one that mattered. ONE
 * budget per turn (the turn integration constructs it), at most
 * REMINDER_BUDGET_DEFAULT (3) reminders issued per turn, each reminder
 * keyed so a repeat within the turn is refused. In-memory and
 * INSTANCE-scoped — deliberately NOT module state: two budgets never
 * cross-contaminate, the lifetime is exactly the turn's (no reset seam, no
 * process-global map growth), and purity is testable without fixtures.
 * This is a finer-grained sibling of dir-conventions' session-once map:
 * that one dedups across a session at the tool layer; this one bounds a
 * single turn across ALL reminder kinds.
 */

/** The reminder families the renderer knows. Drives only the closing fence;
 * the label and text are fully caller-owned. */
export type ReminderKind = "conventions" | "task-mode" | "note";

/** One reminder to render: which family it belongs to, the header line's
 * label (caller-owned — the conventions label is its bracketed "[conventions
 * from …]" sentence), and the verbatim body text. */
export interface ReminderSpec {
  kind: ReminderKind;
  label: string;
  text: string;
}

/**
 * The closing fence per kind. The conventions line is BYTE-PINNED (the R72-d
 * format r72-dir-conventions.test.ts asserts); the other two follow the same
 * shape — name what ended, disclaim what the reminder is not part of.
 */
const CLOSING_FENCE: Readonly<Record<ReminderKind, string>> = {
  conventions: "--- (end conventions — the file content above is unaffected)",
  "task-mode": "--- (end task mode — the surrounding content is unaffected)",
  note: "--- (end note — the surrounding content is unaffected)",
};

/**
 * Render one fenced system reminder:
 * "\n\n--- <label>\n<text>\n<closing fence>". Pure, synchronous, no I/O —
 * same spec in, same bytes out, every time. See the module header for the
 * structure rationale and the byte-identity contract with the R72-d
 * conventions reminder.
 */
export function renderReminder(spec: ReminderSpec): string {
  return `\n\n--- ${spec.label}\n${spec.text}\n${CLOSING_FENCE[spec.kind]}`;
}

/** Default per-turn reminder allowance — see the module header (R71's
 * anti-noise discipline: three unrequested notes per turn is already a lot). */
export const REMINDER_BUDGET_DEFAULT = 3;

/**
 * Per-turn reminder budget: at most `max` DISTINCT reminders per turn, each
 * keyed by the caller (e.g. "conventions:pkg" or "mode:plan"). Construct one
 * per turn; call `allows(key)` before injecting, `mark(key)` after. Pure
 * in-memory instance state — no fs, no db, no module globals, lifetime =
 * the instance's (the turn's). `mark` is idempotent for a seen key and a
 * no-op once the budget is exhausted, so `issued.length <= max` always
 * holds: the ledger never lies, and a caller that skipped `allows` forfeits
 * its mark rather than corrupting the count. This is a reminder, not a
 * gate — nothing here ever throws.
 */
export class ReminderBudget {
  private readonly seen = new Set<string>();
  private readonly issuedKeys: string[] = [];

  constructor(private readonly max: number = REMINDER_BUDGET_DEFAULT) {}

  /** True iff this key is unseen AND the budget has room. A pure check —
   * marking happens only via mark(). */
  allows(key: string): boolean {
    return !this.seen.has(key) && this.issuedKeys.length < this.max;
  }

  /** Record a key as issued. Idempotent (seen key → no-op); a no-op once
   * the budget is full (see the class doc). */
  mark(key: string): void {
    if (this.seen.has(key) || this.issuedKeys.length >= this.max) return;
    this.seen.add(key);
    this.issuedKeys.push(key);
  }

  /** The keys issued so far, in issue order — a snapshot copy (the internal
   * ledger stays private; two reads never alias each other). */
  get issued(): readonly string[] {
    return [...this.issuedKeys];
  }
}
