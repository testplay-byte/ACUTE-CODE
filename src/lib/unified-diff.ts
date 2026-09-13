/**
 * ROUND-96 (R96-H) — the client-side unified diff engine for the chat's
 * edit/write DIFF BLOCKS.
 *
 * The owner's ask (verbatim): "When it edits a file it does not show the
 * status properly, like which parts of the code it changed and how it
 * changed them. It was not precisely changing the things as modern IDEs do."
 *
 * The pre-R96 DiffDetail rendered api.ts's computeUnifiedDiff — a whole-file
 * LCS with NO hunk structure, NO gutter line numbers, and two silent caps
 * (lines past 500 per side vanished; the render truncated at 200 without a
 * marker). This module is the modern-IDE replacement:
 *
 *  · a compact LCS over LINES with common prefix/suffix trimming (the
 *    typical agent edit is a few lines inside a large file — the trim makes
 *    the O(n·m) table tiny in exactly that case);
 *  · an HONEST bound: a changed middle wider than MAX_LCS_SIDE lines falls
 *    back to a coarse whole-block replace (flagged `coarse`, never silently
 *    dropped lines);
 *  · classic unified HUNKS with 3 context lines and "@@ -l,c +l,c @@"
 *    headers — the collapsed-between-hunks shape every IDE shows;
 *  · per-row OLD/NEW line numbers for the +/− gutters;
 *  · a single row cap with a COUNT of what was cut (`truncated`), so the UI
 *    can say "…N more lines not shown" instead of lying by omission.
 *
 * Pure string → structure; no DOM, no dependencies. The create/delete
 * snapshot shapes (before/after null) render as single all-add / all-del
 * hunks with their one-sided numbers.
 */

/** One rendered diff row. `ctx` rows carry BOTH line numbers. */
export interface DiffRow {
  type: "add" | "del" | "ctx";
  text: string;
  /** 1-based line number in the BEFORE file (null on adds). */
  oldLine: number | null;
  /** 1-based line number in the AFTER file (null on dels). */
  newLine: number | null;
}

/** One unified hunk: the classic "@@ -a,b +c,d @@" header + its rows. */
export interface DiffHunk {
  header: string;
  rows: DiffRow[];
}

export interface UnifiedDiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** Total lines on each side (the honest file sizes, pre-trim). */
  beforeLines: number;
  afterLines: number;
  /** True when before === after (or both null) — nothing to show. */
  identical: boolean;
  /** True when the changed middle exceeded the LCS budget and the whole
   *  middle rendered as removed+added blocks (still a TRUE diff — every
   *  changed line shows — just not a minimal one). */
  coarse: boolean;
  /** Rows dropped by the MAX_RENDER_ROWS cap (the UI shows the honest
   *  "…N more lines not shown" note; never a silent cut). */
  truncated: number;
}

/** Context lines kept around each change when building hunks (git's 3). */
export const DIFF_CONTEXT_LINES = 3;

/**
 * LCS table bound. 1501² ≈ 2.25M table cells ≈ a few MB of transient
 * numbers — the guard that keeps a pathological mid-file rewrite of a
 * 20k-line bundle from allocating 400M cells.
 */
const MAX_LCS_SIDE = 1500;

/** Rendered-row cap (the block scrolls; past this the tail is cut WITH a
 * counted marker — the old engine cut at 200 silently). */
const MAX_RENDER_ROWS = 4000;

/**
 * Split content into diff lines with cat -n semantics: a single trailing
 * newline does not create a phantom final empty line ("a\nb\n" is 2 lines);
 * empty content is zero lines.
 */
export function splitDiffLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The classic hunk header range "@@ -oldStart,oldCount +newStart,newCount @@". */
function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/** Row factory keeping the 1-based numbering on the right side only. */
function row(type: DiffRow["type"], text: string, oldLine: number | null, newLine: number | null): DiffRow {
  return { type, text, oldLine, newLine };
}

/**
 * The line-level LCS between two SMALL middles. Prefix/suffix trimming is
 * done by the caller; this walks the DP table and backtracks.
 */
function lcsRows(a: string[], b: string[], oldBase: number, newBase: number): DiffRow[] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[i..] vs b[j..]. Row-major number table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(row("ctx", a[i], oldBase + i + 1, newBase + j + 1));
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(row("del", a[i], oldBase + i + 1, null));
      i++;
    } else {
      out.push(row("add", b[j], null, newBase + j + 1));
      j++;
    }
  }
  while (i < m) out.push(row("del", a[i], oldBase + i++ + 1, null));
  while (j < n) out.push(row("add", b[j], null, newBase + j++ + 1));
  return out;
}

/**
 * Group the full row list into unified hunks with DIFF_CONTEXT_LINES of
 * context: change runs separated by more than 2·context context rows split
 * into separate hunks; the far-away context between them is collapsed (the
 * modern-IDE shape — you see WHERE the edit landed, not the whole file).
 */
function buildHunks(rows: DiffRow[], context: number): DiffHunk[] {
  const isChange = (r: DiffRow): boolean => r.type !== "ctx";
  const changeIdx: number[] = [];
  rows.forEach((r, i) => {
    if (isChange(r)) changeIdx.push(i);
  });
  if (changeIdx.length === 0) return [];
  // Merge change indices into groups (gap ≤ 2·context stays one hunk).
  const groups: Array<[number, number]> = [];
  let start = changeIdx[0];
  let prev = changeIdx[0];
  for (const idx of changeIdx.slice(1)) {
    if (idx - prev <= 2 * context + 1) {
      prev = idx;
    } else {
      groups.push([start, prev]);
      start = idx;
      prev = idx;
    }
  }
  groups.push([start, prev]);

  const hunks: DiffHunk[] = [];
  for (const [firstChange, lastChange] of groups) {
    const from = Math.max(0, firstChange - context);
    const to = Math.min(rows.length - 1, lastChange + context);
    const slice = rows.slice(from, to + 1);
    let oldStart: number | null = null;
    let newStart: number | null = null;
    let oldCount = 0;
    let newCount = 0;
    for (const r of slice) {
      if (r.type !== "add") {
        if (oldStart === null && r.oldLine !== null) oldStart = r.oldLine;
        oldCount += 1;
      }
      if (r.type !== "del") {
        if (newStart === null && r.newLine !== null) newStart = r.newLine;
        newCount += 1;
      }
    }
    // A one-sided hunk (pure adds / pure dels) anchors its EMPTY side at
    // the line BEFORE the other side's first row — git's exact shapes
    // ("@@ -0,0 +1,3 @@" for a create at the top, "@@ -3,2 +2,0 @@" for a
    // mid-file deletion).
    if (oldCount === 0) {
      const firstAdd = slice.find((r) => r.type === "add");
      oldStart = firstAdd !== undefined ? Math.max(0, (firstAdd.newLine ?? 1) - 1) : 0;
    }
    if (newCount === 0) {
      const firstDel = slice.find((r) => r.type === "del");
      newStart = firstDel !== undefined ? Math.max(0, (firstDel.oldLine ?? 1) - 1) : 0;
    }
    if (oldStart === null) oldStart = newStart ?? 0;
    if (newStart === null) newStart = oldStart;
    hunks.push({ header: hunkHeader(oldStart, oldCount, newStart, newCount), rows: slice });
  }
  return hunks;
}

/**
 * Compute the unified diff between a snapshot's before/after content.
 * `before === null` is a file CREATE (all adds); `after === null` is a
 * DELETE (all dels) — the snapshot API's exact shapes (fs-ops records
 * before-content null on creates; a delete records after-content null).
 */
export function computeUnifiedDiff(
  before: string | null,
  after: string | null,
  context: number = DIFF_CONTEXT_LINES,
): UnifiedDiffResult {
  if (before === null && after === null) {
    return { hunks: [], added: 0, removed: 0, beforeLines: 0, afterLines: 0, identical: true, coarse: false, truncated: 0 };
  }
  const oldLines = before === null ? [] : splitDiffLines(before);
  const newLines = after === null ? [] : splitDiffLines(after);
  const beforeLines = oldLines.length;
  const afterLines = newLines.length;
  const stats = (rows: DiffRow[]): { added: number; removed: number } => {
    let added = 0;
    let removed = 0;
    for (const r of rows) {
      if (r.type === "add") added += 1;
      else if (r.type === "del") removed += 1;
    }
    return { added, removed };
  };

  let rows: DiffRow[];
  let coarse = false;

  if (before === null) {
    // Create: one all-add hunk, numbered on the new side.
    rows = newLines.map((t, i) => row("add", t, null, i + 1));
  } else if (after === null) {
    // Delete: one all-del hunk, numbered on the old side.
    rows = oldLines.map((t, i) => row("del", t, i + 1, null));
  } else {
    // Trim the common prefix/suffix, LCS the middle.
    let p = 0;
    const maxP = Math.min(beforeLines, afterLines);
    while (p < maxP && oldLines[p] === newLines[p]) p++;
    let s = 0;
    while (s < maxP - p && oldLines[beforeLines - 1 - s] === newLines[afterLines - 1 - s]) s++;
    const midOld = oldLines.slice(p, beforeLines - s);
    const midNew = newLines.slice(p, afterLines - s);
    if (midOld.length === 0 && midNew.length === 0) {
      rows = [];
    } else if (midOld.length === 0 || midNew.length === 0) {
      // Pure insertion or pure deletion in the middle.
      rows = [
        ...midOld.map((t, i) => row("del", t, p + i + 1, null)),
        ...midNew.map((t, i) => row("add", t, null, p + i + 1)),
      ];
    } else if (midOld.length > MAX_LCS_SIDE || midNew.length > MAX_LCS_SIDE) {
      // Coarse fallback: the whole middle replaces (every changed line still
      // shows; only minimality is lost). Flagged — never silent.
      coarse = true;
      rows = [
        ...midOld.map((t, i) => row("del", t, p + i + 1, null)),
        ...midNew.map((t, i) => row("add", t, null, p + i + 1)),
      ];
    } else {
      rows = lcsRows(midOld, midNew, p, p);
    }
    // Re-attach the trimmed context so hunks can show lines AROUND changes.
    const prefix = oldLines.slice(0, p).map((t, i) => row("ctx", t, i + 1, i + 1));
    const suffix = oldLines.slice(beforeLines - s).map((t, i) => row("ctx", t, beforeLines - s + i + 1, afterLines - s + i + 1));
    rows = [...prefix, ...rows, ...suffix];
  }

  const { added, removed } = stats(rows);
  const truncated = Math.max(0, rows.length - MAX_RENDER_ROWS);
  if (truncated > 0) rows = rows.slice(0, MAX_RENDER_ROWS);
  return {
    hunks: buildHunks(rows, context),
    added,
    removed,
    beforeLines,
    afterLines,
    // No add/del rows anywhere == nothing changed (an identical pair also
    // collapses to zero changes after the prefix/suffix trim).
    identical: added === 0 && removed === 0,
    coarse,
    truncated,
  };
}
