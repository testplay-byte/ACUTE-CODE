// @vitest-environment node
//
// ROUND-73 (R73-d) — the generalized SYSTEM-REMINDERS round, pinned:
//   D1. renderReminder — the ONE renderer for every fenced system reminder.
//       The conventions case is BYTE-IDENTICAL to the R72-d
//       conventionReminder() format (tools/dir-conventions.ts now
//       delegates; r72-dir-conventions.test.ts staying green UNMODIFIED is
//       the acceptance gate — the bytes below re-state that suite's pinned
//       format plus one fresh case, so the contract lives in two places).
//   D2. The other kinds (task-mode, note) render with the SAME structural
//       format — leading blank line + "--- <label>" line + verbatim text +
//       the kind's closing fence. Shape pins, not full bytes: the exact
//       task-mode/note closers are this round's design and may evolve; the
//       STRUCTURE is the contract every consumer rides.
//   D3. ReminderBudget — R71's anti-question-padding/anti-noise discipline
//       as a per-turn, instance-scoped ledger: allows/mark, idempotence,
//       the max (default 3, custom values), the issued snapshot, and NO
//       cross-contamination between instances (purity: no fs, no db, no
//       module state — two budgets in one process never see each other).
import { describe, expect, it } from "vitest";

import {
  REMINDER_BUDGET_DEFAULT,
  ReminderBudget,
  renderReminder,
  type ReminderSpec,
} from "../src/agents/system-reminders";
import { conventionReminder, type DirConvention } from "../src/tools/dir-conventions";

/* ── D1: renderReminder — the conventions case, byte-identical ────────────── */

describe("R73-d D1: conventions — BYTE-IDENTITY with the R72-d format", () => {
  it("the exact R72-d pin #1: AGENTS.md source, short excerpt — every byte re-stated inline", () => {
    // The pinned expectation from tests/r72-dir-conventions.test.ts, copied
    // verbatim — if the renderer drifts one byte, this fails before the
    // r72 suite does.
    const rendered = renderReminder({
      kind: "conventions",
      label: "[conventions from a/b/AGENTS.md apply to this file]",
      text: "RULES",
    });
    expect(rendered).toBe(
      "\n\n--- [conventions from a/b/AGENTS.md apply to this file]\nRULES\n--- (end conventions — the file content above is unaffected)",
    );
  });

  it("the exact R72-d pin #2: a CLAUDE.md source with a multi-line excerpt — byte-exact, line positions included", () => {
    const rendered = renderReminder({
      kind: "conventions",
      label: "[conventions from docs/CLAUDE.md apply to this file]",
      text: "X\nY",
    });
    expect(rendered).toBe(
      "\n\n--- [conventions from docs/CLAUDE.md apply to this file]\nX\nY\n--- (end conventions — the file content above is unaffected)",
    );
    // Line positions (the structure the r72 suite pins the same way).
    const lines = rendered.split("\n");
    expect(lines[2]).toBe("--- [conventions from docs/CLAUDE.md apply to this file]");
    expect(lines[3]).toBe("X");
    expect(lines[4]).toBe("Y");
    expect(lines[5]).toBe("--- (end conventions — the file content above is unaffected)");
  });

  it("a fresh case: the honest truncation-marker excerpt rides VERBATIM (trailing newline and all) between the fences", () => {
    const excerpt = `${"R".repeat(2_000)}\n…[truncated, 2000 of 3500 chars]…`;
    const rendered = renderReminder({
      kind: "conventions",
      label: "[conventions from pkg/AGENTS.md apply to this file]",
      text: excerpt,
    });
    expect(rendered).toBe(
      `\n\n--- [conventions from pkg/AGENTS.md apply to this file]\n${excerpt}\n--- (end conventions — the file content above is unaffected)`,
    );
    // Nothing munged, nothing trimmed — the renderer is dumb on purpose.
    expect(rendered).toContain(excerpt);
    expect(rendered.indexOf(excerpt)).toBeGreaterThan(0);
  });

  it("the delegation pin: for real DirConvention inputs, renderReminder(conventions) === conventionReminder()", () => {
    // tools/dir-conventions.ts now delegates to this renderer — this pins
    // the WIRING (a future re-bespoking of conventionReminder shows up
    // here even if the r72 suite's own format pins were relaxed).
    const cases: ReadonlyArray<DirConvention> = [
      { dir: "a/b", file: "a/b/AGENTS.md", excerpt: "RULES" },
      { dir: "docs", file: "docs/CLAUDE.md", excerpt: "# Rules\n\n- tests here use vitest\n" },
      { dir: "pkg", file: "pkg/AGENTS.md", excerpt: `${"R".repeat(2_000)}\n…[truncated, 2000 of 3500 chars]…` },
    ];
    for (const convention of cases) {
      const viaRenderer = renderReminder({
        kind: "conventions",
        label: `[conventions from ${convention.file} apply to this file]`,
        text: convention.excerpt,
      });
      expect(viaRenderer).toBe(conventionReminder(convention));
    }
  });

  it("renderReminder is pure: the same spec renders the same bytes every time (no hidden state)", () => {
    const spec: ReminderSpec = {
      kind: "conventions",
      label: "[conventions from a/AGENTS.md apply to this file]",
      text: "stable",
    };
    expect(renderReminder(spec)).toBe(renderReminder(spec));
    expect(renderReminder({ ...spec })).toBe(renderReminder({ ...spec }));
  });
});

/* ── D2: the other kinds — the same structural format (shape pins) ───────── */

describe("R73-d D2: task-mode and note — same structure, kind-specific closer", () => {
  it("task-mode: blank-line separator, '--- <label>' line, verbatim text, the task-mode closing fence", () => {
    const notice = renderReminder({
      kind: "task-mode",
      label: "[task mode: plan is active until cleared]",
      text: "Plan before code: read, list unknowns, propose, wait for the owner's go-ahead.",
    });
    expect(notice.startsWith("\n\n--- ")).toBe(true);
    const lines = notice.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("--- [task mode: plan is active until cleared]");
    expect(lines[3]).toBe("Plan before code: read, list unknowns, propose, wait for the owner's go-ahead.");
    expect(lines.at(-1)).toBe("--- (end task mode — the surrounding content is unaffected)");
  });

  it("note: the generic escape hatch renders with the same fenced shape and its own closer", () => {
    const note = renderReminder({ kind: "note", label: "[memory ledger affordance]", text: "One fact was recalled." });
    expect(note.startsWith("\n\n--- ")).toBe(true);
    const lines = note.split("\n");
    expect(lines[2]).toBe("--- [memory ledger affordance]");
    expect(lines[3]).toBe("One fact was recalled.");
    expect(lines.at(-1)).toBe("--- (end note — the surrounding content is unaffected)");
  });

  it("a text that itself contains '---' stays BETWEEN the fences — the closer is the last line (the R72-d disambiguation, generalized)", () => {
    const notice = renderReminder({
      kind: "note",
      label: "[mixed content]",
      text: "rules:\n--- not the closer\nmore rules",
    });
    const lines = notice.split("\n");
    expect(lines).toContain("--- not the closer");
    expect(lines.at(-1)).toBe("--- (end note — the surrounding content is unaffected)");
    expect(lines.at(-1)).not.toBe("--- not the closer");
  });

  it("all three kinds share the structure: '\\n\\n--- <label>\\n<text>\\n<closer>' — one mechanism, three families", () => {
    const specs: ReadonlyArray<ReminderSpec> = [
      { kind: "conventions", label: "[conventions from a/AGENTS.md apply to this file]", text: "A" },
      { kind: "task-mode", label: "[task mode: build is active]", text: "B" },
      { kind: "note", label: "[a note]", text: "C" },
    ];
    for (const spec of specs) {
      const out = renderReminder(spec);
      expect(out.startsWith("\n\n--- ")).toBe(true);
      expect(out.endsWith(")")).toBe(true);
      expect(out).toContain(`\n--- ${spec.label}\n${spec.text}\n---`);
    }
  });
});

/* ── D3: ReminderBudget — the per-turn anti-noise ledger ──────────────────── */

describe("R73-d D3: ReminderBudget — allows/mark/idempotence", () => {
  it("an unseen key is allowed, a marked key never re-issues (once per turn per key)", () => {
    const budget = new ReminderBudget();
    expect(budget.allows("conventions:pkg")).toBe(true);
    budget.mark("conventions:pkg");
    expect(budget.allows("conventions:pkg")).toBe(false);
    expect(budget.allows("conventions:pkg")).toBe(false);
  });

  it("mark is idempotent: marking a seen key twice issues it once", () => {
    const budget = new ReminderBudget();
    budget.mark("mode:plan");
    budget.mark("mode:plan");
    budget.mark("mode:plan");
    expect(budget.issued).toEqual(["mode:plan"]);
  });

  it("mark at an exhausted budget is a no-op — the ledger never exceeds max", () => {
    const budget = new ReminderBudget(2);
    budget.mark("a");
    budget.mark("b");
    budget.mark("c"); // a caller that skipped allows() forfeits the mark
    expect(budget.issued).toEqual(["a", "b"]);
    expect(budget.allows("c")).toBe(false);
  });

  it("default budget: REMINDER_BUDGET_DEFAULT === 3; the 4th NEW key is refused once three issued", () => {
    expect(REMINDER_BUDGET_DEFAULT).toBe(3);
    const budget = new ReminderBudget(); // no argument → the default
    for (const key of ["conventions:pkg", "conventions:docs", "mode:plan"]) {
      expect(budget.allows(key)).toBe(true);
      budget.mark(key);
    }
    expect(budget.allows("note:lessons")).toBe(false); // max reached
    expect(budget.issued).toEqual(["conventions:pkg", "conventions:docs", "mode:plan"]);
  });

  it("custom max 1: one reminder per turn, the second NEW key refused", () => {
    const budget = new ReminderBudget(1);
    expect(budget.allows("mode:debug")).toBe(true);
    budget.mark("mode:debug");
    expect(budget.allows("conventions:pkg")).toBe(false);
    expect(budget.issued).toEqual(["mode:debug"]);
  });

  it("issued is a snapshot copy: mutating one read never reaches the ledger", () => {
    const budget = new ReminderBudget();
    budget.mark("a");
    const first = budget.issued;
    (first as string[]).push("forged");
    expect(budget.issued).toEqual(["a"]);
    expect(budget.issued).not.toBe(first);
  });

  it("instance purity: two budgets in one process never cross-contaminate (no module state, no fs, no db)", () => {
    const turnOne = new ReminderBudget();
    const turnTwo = new ReminderBudget(1);
    turnOne.mark("conventions:pkg");
    // Turn one's mark does not leak into turn two…
    expect(turnTwo.allows("conventions:pkg")).toBe(true);
    // …and turn two's smaller max does not leak into turn one.
    expect(turnOne.allows("mode:plan")).toBe(true);
    expect(turnTwo.allows("mode:plan")).toBe(true);
    turnTwo.mark("mode:plan");
    expect(turnTwo.allows("conventions:pkg")).toBe(false); // max 1, its own
    expect(turnOne.allows("conventions:docs")).toBe(true); // still room, its own
    expect(turnOne.issued).toEqual(["conventions:pkg"]);
    expect(turnTwo.issued).toEqual(["mode:plan"]);
  });
});
