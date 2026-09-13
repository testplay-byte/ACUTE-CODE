/**
 * ROUND-96 (R96-H) unit tests — src/lib/unified-diff.ts, the chat diff
 * block's engine. Pinned shapes:
 *  · creates (before null) → ONE all-add hunk, new-side numbers only;
 *  · deletes (after null) → ONE all-del hunk, old-side numbers only;
 *  · edits → red/green/ctx rows with BOTH-side gutter numbers, classic
 *    "@@ -l,c +l,c @@" headers, 3 context lines, far context collapsed
 *    into separate hunks;
 *  · identical / empty inputs → identical:true, zero hunks;
 *  · the coarse fallback (over MAX_LCS_SIDE) stays TRUE (every changed line
 *    present) while flagging `coarse`;
 *  · the render cap COUNTS what it cut (never a silent truncation).
 */
import { describe, expect, it } from "vitest";
import { computeUnifiedDiff, DIFF_CONTEXT_LINES, splitDiffLines } from "./unified-diff";

describe("splitDiffLines (cat -n semantics)", () => {
  it("a trailing newline does not create a phantom final line", () => {
    expect(splitDiffLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitDiffLines("a\nb")).toEqual(["a", "b"]);
  });
  it("empty content is zero lines; lone newlines are real empty lines", () => {
    expect(splitDiffLines("")).toEqual([]);
    expect(splitDiffLines("\n\n")).toEqual(["", ""]);
    expect(splitDiffLines("\n")).toEqual([""]);
  });
});

describe("computeUnifiedDiff — creates and deletes (snapshot null sides)", () => {
  it("before === null renders one ALL-ADD hunk with new-side line numbers", () => {
    const d = computeUnifiedDiff(null, "line1\nline2\nline3");
    expect(d.hunks).toHaveLength(1);
    const rows = d.hunks[0].rows;
    expect(rows.map((r) => r.type)).toEqual(["add", "add", "add"]);
    expect(rows.map((r) => r.text)).toEqual(["line1", "line2", "line3"]);
    expect(rows.map((r) => r.newLine)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.oldLine === null)).toBe(true);
    expect(d.added).toBe(3);
    expect(d.removed).toBe(0);
    expect(d.identical).toBe(false);
    // A create starts the file: git's -0,0 shape.
    expect(d.hunks[0].header).toBe("@@ -0,0 +1,3 @@");
  });

  it("after === null renders one ALL-DEL hunk with old-side line numbers", () => {
    const d = computeUnifiedDiff("gone1\ngone2", null);
    expect(d.hunks).toHaveLength(1);
    const rows = d.hunks[0].rows;
    expect(rows.map((r) => r.type)).toEqual(["del", "del"]);
    expect(rows.map((r) => r.oldLine)).toEqual([1, 2]);
    expect(rows.every((r) => r.newLine === null)).toBe(true);
    expect(d.removed).toBe(2);
  });

  it("both null → identical (nothing to show)", () => {
    const d = computeUnifiedDiff(null, null);
    expect(d.identical).toBe(true);
    expect(d.hunks).toHaveLength(0);
  });
});

describe("computeUnifiedDiff — edits (hunks, context, gutters)", () => {
  it("a one-line change keeps 3 context rows on each side with BOTH-side numbers", () => {
    const before = "l1\nl2\nl3\nl4\nl5\nl6\nl7";
    const after = "l1\nl2\nl3\nCHANGED\nl5\nl6\nl7";
    const d = computeUnifiedDiff(before, after);
    expect(d.identical).toBe(false);
    expect(d.hunks).toHaveLength(1);
    const rows = d.hunks[0].rows;
    // ctx(l1,l2,l3) + del(l4) + add(CHANGED) + ctx(l5,l6,l7)
    expect(rows.map((r) => r.type)).toEqual(["ctx", "ctx", "ctx", "del", "add", "ctx", "ctx", "ctx"]);
    const del = rows.find((r) => r.type === "del");
    const add = rows.find((r) => r.type === "add");
    expect(del?.text).toBe("l4");
    expect(del?.oldLine).toBe(4);
    expect(del?.newLine).toBeNull();
    expect(add?.text).toBe("CHANGED");
    expect(add?.newLine).toBe(4);
    expect(add?.oldLine).toBeNull();
    // ctx rows carry both numbers.
    expect(rows[0].oldLine).toBe(1);
    expect(rows[0].newLine).toBe(1);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.coarse).toBe(false);
  });

  it("changes far apart split into SEPARATE hunks; the far context is collapsed", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 5\n", "FIVE\n").replace("line 50\n", "FIFTY\n");
    const d = computeUnifiedDiff(before, after);
    expect(d.hunks).toHaveLength(2);
    // Each hunk is change + 3 ctx = at most 8 rows (1 del + 1 add + 6 ctx).
    for (const h of d.hunks) {
      expect(h.rows.length).toBeLessThanOrEqual(2 + 2 * DIFF_CONTEXT_LINES);
      expect(h.rows.some((r) => r.type !== "ctx")).toBe(true);
    }
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
    // The header carries the true positions (hunk 2 sits around line 47-53).
    expect(d.hunks[1].header).toContain("-47,7");
  });

  it("adjacent changes separated by ≤ 2·context context rows MERGE into one hunk", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    // Changes at index 1 and 5 — gap of 3 context rows (c,d,e) ≤ 2*3+1 → one hunk.
    const after = ["a", "B", "c", "d", "e", "F", "g", "h"].join("\n");
    const d = computeUnifiedDiff(before, after);
    expect(d.hunks).toHaveLength(1);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
  });

  it("pure insertion: new lines only, old-side numbers stay continuous", () => {
    const d = computeUnifiedDiff("a\nb\nc", "a\nb\nINSERTED\nMORE\nc");
    expect(d.hunks).toHaveLength(1);
    const rows = d.hunks[0].rows;
    expect(rows.filter((r) => r.type === "add").map((r) => r.text)).toEqual(["INSERTED", "MORE"]);
    expect(rows.filter((r) => r.type === "del")).toHaveLength(0);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
    // ctx numbering after the insertion shifts to the NEW side (a=1/1, b=2/2, c=3/5).
    const tail = rows[rows.length - 1];
    expect(tail.text).toBe("c");
    expect(tail.oldLine).toBe(3);
    expect(tail.newLine).toBe(5);
  });

  it("pure deletion: removed lines only", () => {
    const d = computeUnifiedDiff("a\nb\nc\nd", "a\nd");
    expect(d.removed).toBe(2);
    expect(d.added).toBe(0);
    expect(d.hunks[0].rows.filter((r) => r.type === "del").map((r) => r.text)).toEqual(["b", "c"]);
  });
});

describe("computeUnifiedDiff — honest edges", () => {
  it("identical content → identical:true, zero hunks, zero counts", () => {
    const d = computeUnifiedDiff("same\nall\nthe\nway", "same\nall\nthe\nway");
    expect(d.identical).toBe(true);
    expect(d.hunks).toHaveLength(0);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it("empty ↔ empty is identical; empty ↔ content is a full add/del", () => {
    expect(computeUnifiedDiff("", "").identical).toBe(true);
    expect(computeUnifiedDiff("", "x").added).toBe(1);
    expect(computeUnifiedDiff("x", "").removed).toBe(1);
  });

  it("a changed middle beyond the LCS bound falls back COARSE — every changed line still present", () => {
    const n = 2000;
    const before = Array.from({ length: n }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: n }, (_, i) => `new ${i}`).join("\n");
    const d = computeUnifiedDiff(before, after);
    expect(d.coarse).toBe(true);
    expect(d.added).toBe(n);
    expect(d.removed).toBe(n);
    // The whole middle shows (no silent drops) — one del block + one add block.
    const flat = d.hunks.flatMap((h) => h.rows);
    expect(flat.filter((r) => r.type === "del")).toHaveLength(n);
    expect(flat.filter((r) => r.type === "add")).toHaveLength(n);
  });

  it("the render cap COUNTS the cut rows instead of truncating silently", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n");
    const d = computeUnifiedDiff(null, big);
    expect(d.truncated).toBe(1000);
    const shown = d.hunks.reduce((sum, h) => sum + h.rows.length, 0);
    expect(shown).toBe(4000);
  });

  it("a small edit inside a huge file trims the prefix/suffix (cheap, exact)", () => {
    const lines = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`);
    const before = lines.join("\n");
    const after = before.replace("line 500", "EDITED");
    const d = computeUnifiedDiff(before, after);
    expect(d.coarse).toBe(false);
    expect(d.truncated).toBe(0);
    expect(d.hunks).toHaveLength(1);
    // 2 change rows (del + add) + 3 ctx before + 3 ctx after.
    expect(d.hunks[0].rows.length).toBe(2 + 2 * DIFF_CONTEXT_LINES);
    expect(d.beforeLines).toBe(900);
    expect(d.afterLines).toBe(900);
  });
});
