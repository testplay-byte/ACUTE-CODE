/**
 * ROUND-129 (R129-CTX2) — the context-steward gates (round-129.md §4
 * stages 3-7), the five-reference research synthesis's second wave:
 *
 *   · THE 90% AUTO-COMPACT GATE (AUTO_COMPACT_RATIO — the owner's exact
 *     words: "if… the context window has been utilized about 90%… then it
 *     will auto-start the compression without performing any of the next
 *     tasks"): a history between 90% and 100% of `available` NOW compacts
 *     (the pre-R129 gate waited for overflow); a history under 90% skips.
 *   · THE ANCHORED SUMMARY TEMPLATE (SUMMARIZER_SYSTEM_PROMPT's fixed
 *     sections — the convergent finding of all five studies).
 *   · THE DETERMINISTIC FILES APPENDIX (buildFilesAppendix — cline's
 *     guaranteed Files section) + the model-omission fold in
 *     runCompaction.
 *   · THE POST-COMPACT RE-INJECTION (ZCode D4 — recentReadPaths +
 *     reinjectedPaths + the reminder note in applyCompaction).
 *   · THE PREFLIGHT OUTPUT CAP (clampOutputTokens — zcode/omp's law).
 *   · REVERT = CONTEXT REVERT (the owner's ask: "reverting the messages
 *     should also revert the context to the previous stage") — pinned
 *     END-TO-END: reverting past a context.compact event resurrects the
 *     original messages and drops the summary.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyCompaction,
  AUTO_COMPACT_RATIO,
  buildFilesAppendix,
  planCompaction,
  recentReadPaths,
  reinjectionNoteMessage,
  SUMMARIZER_SYSTEM_PROMPT,
  type CompactionPayload,
  type SeqMessage,
} from "../src/agents/compaction";
import { clampOutputTokens } from "../src/agents/runtime";
import { appendSessionEvent, createSession, listSessionEvents, revertSession } from "../src/storage/sessions";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r129ctx2-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

/** N pairs of ~100-token messages (400 chars ≈ 100 tokens + 8 overhead). */
function manyPairs(n: number): SeqMessage[] {
  const out: SeqMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `task message ${i} `.repeat(20), throughSeq: i * 2 + 1 });
    out.push({ role: "assistant", content: `assistant reply ${i} `.repeat(20), throughSeq: i * 2 + 2 });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The 90% auto-compact gate
// ─────────────────────────────────────────────────────────────────────────────

describe("R129-CTX2 the 90% auto-compact gate (AUTO_COMPACT_RATIO)", () => {
  it("the ratio is 0.9 (the owner's own number)", () => {
    expect(AUTO_COMPACT_RATIO).toBe(0.9);
  });

  it("a history UNDER 90% of available skips (the old below_threshold law holds)", () => {
    // ROOMY-ish budget: available = 600 - 100 - 100 = 400; auto line = 360.
    const budget = { contextWindow: 600, maxOutputTokens: 100, margin: 100 };
    // 3 pairs ≈ 6 messages ≈ ~660 tokens > 360 → compact. 1 pair ≈ 220 < 360 → skip.
    const skip = planCompaction(manyPairs(1), budget);
    expect(skip.decision).toBe("skip");
    expect(skip.reason).toBe("below_threshold");
    expect(skip.threshold).toBe(360);
  });

  it("a history BETWEEN 90% and 100% of available NOW compacts (the pre-R129 gate waited for overflow)", () => {
    // TIGHT budget: available = 400, auto line = 360. A history whose
    // estimate lands between 360 and 400 compacts NOW — the headroom the
    // owner asked for ("without performing any of the next tasks").
    // Build the in-between shape directly: one ~386-token message pair
    // (1700 letters ≈ 1700/4.5 ≈ 378 tokens + 8 overhead ≈ 386).
    const messages: SeqMessage[] = [
      { role: "user", content: "x".repeat(1700), throughSeq: 1 },
      { role: "assistant", content: "ok", throughSeq: 2 },
    ];
    const plan = planCompaction(messages, { contextWindow: 600, maxOutputTokens: 100, margin: 100 });
    // The estimate of the pair (~373+8) sits between 360 and 400: the old
    // gate skipped it; the new gate compacts.
    expect(plan.decision).toBe("compact");
    expect(plan.reason).toBe("above_threshold");
    expect(plan.tokenSource).toBe("estimated");
    expect(plan.tokenCount).toBeGreaterThan(360);
    expect(plan.tokenCount).toBeLessThanOrEqual(400);
  });

  it("force still bypasses the gate verbatim (the overflow-recovery path is untouched)", () => {
    const plan = planCompaction(manyPairs(1), { contextWindow: 600, maxOutputTokens: 100, margin: 100 }, true);
    expect(plan.decision).toBe("compact");
    expect(plan.reason).toBe("forced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The anchored summary template
// ─────────────────────────────────────────────────────────────────────────────

describe("R129-CTX2 the anchored summary template (SUMMARIZER_SYSTEM_PROMPT)", () => {
  it("carries the five fixed sections (the state-not-prose law)", () => {
    for (const section of ["## Objective", "## Key decisions", "## Work state", "## Relevant files", "## Next move"]) {
      expect(SUMMARIZER_SYSTEM_PROMPT).toContain(section);
    }
  });

  it("carries the exact-string + prior-summary merge laws (the hallucination guards)", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("VERBATIM");
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("anything you drop from it is lost forever");
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("THE TRANSCRIPT WINS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The deterministic Files appendix + the re-injection paths
// ─────────────────────────────────────────────────────────────────────────────

function toolBlock(lines: string[]): SeqMessage {
  return { role: "user", content: `<tool_results>\n${lines.join("\n")}\n</tool_results>`, throughSeq: 99 };
}

describe("R129-CTX2 buildFilesAppendix (cline's guaranteed Files section)", () => {
  it("derives the deduped, order-preserving file list + the commands from the rendered tool lines", () => {
    const appendix = buildFilesAppendix([
      toolBlock([
        "read_file(path: src/a.ts) → ok: the body",
        "run_command(cmd: npm test) → ok: 3 passed",
        "write_file(path: src/a.ts, content: 33 chars) → ok: wrote 1 line",
        "edit_file(path: lib.ts, 2 replacements, +4 −1 lines) → ok",
        "read_file(path: src/a.ts) → ok: re-read body",
        "run_command(cmd: npm test) → ok: 3 passed again",
      ]),
    ]);
    expect(appendix).toContain("## Files (complete, from the event log)");
    expect(appendix).toContain("- src/a.ts");
    expect(appendix).toContain("- lib.ts");
    expect(appendix).toContain("## Commands run");
    expect(appendix).toContain("- npm test");
    // Dedupe: each path + command appears ONCE.
    expect(appendix.match(/- src\/a\.ts/g)?.length).toBe(1);
    expect(appendix.match(/- npm test/g)?.length).toBe(1);
  });

  it("no tool content → the empty string (nothing to append)", () => {
    expect(buildFilesAppendix([{ role: "user", content: "just prose", throughSeq: 1 }])).toBe("");
  });
});

describe("R129-CTX2 recentReadPaths (ZCode D4's source list)", () => {
  it("the ≤5 MOST RECENTLY READ distinct paths, newest first", () => {
    const paths = recentReadPaths([
      toolBlock([
        "read_file(path: old1.ts) → ok: body",
        "read_file(path: a.ts) → ok: body",
        "read_file(path: b.ts) → ok: body",
        "read_file(path: c.ts) → ok: body",
        "read_file(path: d.ts) → ok: body",
        "read_file(path: e.ts) → ok: body",
        "read_file(path: f.ts) → ok: body",
        "read_file(path: a.ts) → ok: re-read",
      ]),
    ]);
    expect(paths).toEqual(["a.ts", "f.ts", "e.ts", "d.ts", "c.ts"]);
  });

  it("writes do not qualify (only the read families feed the reminder)", () => {
    const paths = recentReadPaths([
      toolBlock(["write_file(path: w.ts, content: 5 chars) → ok", "edit_file(path: e.ts, 1 replacement) → ok"]),
    ]);
    expect(paths).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The post-compact re-injection (applyCompaction's reminder)
// ─────────────────────────────────────────────────────────────────────────────

describe("R129-CTX2 the re-injection reminder (applyCompaction)", () => {
  const base: SeqMessage[] = [
    { role: "user", content: "the original task", throughSeq: 1 },
    { role: "assistant", content: "the original reply", throughSeq: 2 },
    { role: "user", content: "the kept tail", throughSeq: 5 },
  ];

  it("a payload WITH reinjectedPaths renders [summary, reminder, …kept]", () => {
    const compact: CompactionPayload = {
      summary: "SUMMARY",
      throughSeq: 2,
      droppedMessages: 2,
      tokensSaved: 0,
      reinjectedPaths: ["src/a.ts", "lib.ts"],
    };
    const out = applyCompaction(base, compact);
    expect(out.length).toBe(3);
    expect(out[0].content).toContain("SUMMARY");
    expect(out[1].content).toContain("[context reminder]");
    expect(out[1].content).toContain("src/a.ts, lib.ts");
    expect(out[1].content).toContain("Re-read any of them you still need");
    expect(out[2].content).toBe("the kept tail");
  });

  it("a payload WITHOUT the field renders exactly as before (the additive contract)", () => {
    const compact: CompactionPayload = { summary: "SUMMARY", throughSeq: 2, droppedMessages: 2, tokensSaved: 0 };
    const out = applyCompaction(base, compact);
    expect(out.length).toBe(2);
    expect(out[0].content).toContain("SUMMARY");
    expect(out[1].content).toBe("the kept tail");
  });

  it("reinjectionNoteMessage is the pinned one-liner", () => {
    const note = reinjectionNoteMessage(["a.ts"]);
    expect(note.role).toBe("user");
    expect(note.throughSeq).toBe(0);
    expect(note.content).toContain("[context reminder]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The preflight output cap (clampOutputTokens)
// ─────────────────────────────────────────────────────────────────────────────

describe("R129-CTX2 clampOutputTokens (the preflight output cap)", () => {
  it("a healthy window keeps the model cap VERBATIM (byte-identical pre-R129 behavior)", () => {
    expect(clampOutputTokens(32_768, 200_000, 10_000)).toBe(32_768);
  });

  it("a filling window clamps to window − used − 1000 (the free-model 400 killer)", () => {
    expect(clampOutputTokens(32_768, 40_000, 35_000)).toBe(4_000);
  });

  it("a degenerate clamp floors at 1024 (the context guard owns the true overflow)", () => {
    expect(clampOutputTokens(32_768, 40_000, 39_500)).toBe(1024);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Revert = context revert (the owner's ask, end-to-end)
// ─────────────────────────────────────────────────────────────────────────────

describe("R129-CTX2 revert restores the pre-compaction context (end-to-end)", () => {
  it("reverting past a context.compact event resurrects the original messages and drops the summary", () => {
    const session = createSession(db, { agentId: "agt_x", mode: "single", projectId: null, title: "revert test" });
    const sessionId = session.id;
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId: "agt_x",
      payload: { role: "user", content: "the original task" },
    });
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId: "agt_x",
      payload: { role: "assistant", content: "the original reply" },
    });
    // The compaction event (as runCompaction persists it — summary +
    // throughSeq covering both messages).
    appendSessionEvent(db, sessionId, {
      type: "context.compact",
      agentId: null,
      payload: {
        summary: "SUMMARY: the task was done",
        throughSeq: 2,
        droppedMessages: 2,
        tokensSaved: 50,
        reinjectedPaths: ["a.ts"],
      },
    });
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId: "agt_x",
      payload: { role: "user", content: "post-compaction follow-up" },
    });

    // BEFORE the revert: the event log carries the compaction (the fold
    // would apply it).
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "context.compact")).toBe(true);

    // Revert with keepThroughSeq = 3 (the first seq to DELETE — the
    // compaction event): everything from the compact on is rewound, the
    // original exchange stays.
    const result = revertSession(db, sessionId, 3);
    expect(result.ok).toBe(true);

    const after = listSessionEvents(db, sessionId);
    // The compaction event is GONE — the context reverted with the messages.
    expect(after.some((e) => e.type === "context.compact")).toBe(false);
    // The original messages are BACK (the whole point).
    const contents = after.map((e) => (e.payload as { content?: string }).content ?? "");
    expect(contents).toContain("the original task");
    expect(contents).toContain("the original reply");
    expect(contents).not.toContain("post-compaction follow-up");
    // No summary anywhere in the log.
    expect(contents.join(" ")).not.toContain("SUMMARY:");
  });
});
