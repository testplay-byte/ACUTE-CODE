/**
 * ROUND-67 (R67-B) tests — buildFullTurnText, the full-turn clipboard
 * builder for the owner's SECOND copy option ("The whole conversation of
 * it, all the thinking of it, all the tool calls within it, and everything
 * like that…", shown only when debug mode is on).
 *
 * Pins the export format (modeled on agent-core's debug-analyst
 * renderEvent style): the model/duration header, the narration/thinking
 * banner, [THINKING]/[TEXT] tagged lines, `--- TOOL n: name ---` separators
 * with args + ok/FAILED result lines, the approval block with its fields,
 * the FINAL ANSWER tail, empty-entry skipping, and the 100KB tail-keeping
 * truncation.
 */
import { describe, expect, it } from "vitest";
import { buildFullTurnText } from "./turn-copy";
import type { WorkingEntry } from "./api";

function thinking(text: string): WorkingEntry {
  return { type: "thinking", text, ts: "2026-09-06T10:00:01Z" };
}

function narration(content: string): WorkingEntry {
  return { type: "text", content, ts: "2026-09-06T10:00:02Z" };
}

function tool(
  seq: number,
  toolName: string,
  argsSummary: string,
  ok: boolean | null,
  outputSummary?: string,
): WorkingEntry {
  return {
    type: "tool",
    tool: { seq, toolName, argsSummary, ok, ts: "2026-09-06T10:00:03Z", ...(outputSummary !== undefined ? { outputSummary } : {}) },
  };
}

function approval(status: "pending" | "approved" | "denied" | "expired"): WorkingEntry {
  return {
    type: "approval",
    approvalId: "apv_1",
    toolName: "write_file",
    argsSummary: "path: a.txt, 120 chars",
    category: "filesystem",
    status,
    ts: "2026-09-06T10:00:04Z",
  };
}

describe("buildFullTurnText (ROUND-67 R67-B)", () => {
  it("the full format: header, narration banner, thinking/tool/text ordering, final answer", () => {
    const out = buildFullTurnText({
      working: [
        thinking("I should inspect the file first."),
        narration("Reading the target file now."),
        tool(4, "read_file", "path: a.txt", true, "read 120 lines"),
        tool(5, "write_file", "path: a.txt", false, "EACCES: permission denied"),
        narration("The write failed; reporting honestly."),
      ],
      finalText: "The file was NOT written — a permission error blocked it.",
      model: "z-ai/glm-5.2",
      ms: 8420.6,
    });

    // The export header: model + duration (ms rounded).
    expect(out.startsWith("=== ACUTE-CODE turn export (debug) ===\n")).toBe(true);
    expect(out).toContain("Model: z-ai/glm-5.2 | Duration: 8421ms");

    // The narration banner rides the FIRST thinking/text entry.
    expect(out.indexOf("--- USER NARRATION / THINKING ---")).toBeLessThan(
      out.indexOf("[THINKING] I should inspect the file first."),
    );
    // Thinking + narration keep their order, tools interleave BETWEEN them.
    expect(out.indexOf("[THINKING] I should inspect the file first.")).toBeLessThan(
      out.indexOf("[TEXT] Reading the target file now."),
    );
    expect(out.indexOf("[TEXT] Reading the target file now.")).toBeLessThan(
      out.indexOf("--- TOOL 1: read_file ---"),
    );
    expect(out.indexOf("--- TOOL 2: write_file ---")).toBeLessThan(
      out.indexOf("[TEXT] The write failed; reporting honestly."),
    );

    // Tool blocks: args + result lines; ok and FAILED shapes.
    expect(out).toContain("args: path: a.txt");
    expect(out).toContain("result: ok — read 120 lines");
    expect(out).toContain("result: FAILED — EACCES: permission denied");

    // The final answer closes the export.
    expect(out.endsWith("--- FINAL ANSWER ---\nThe file was NOT written — a permission error blocked it.")).toBe(true);
  });

  it("tool numbering is a running index (TOOL 1, TOOL 2 …) and output-less tools say so", () => {
    const out = buildFullTurnText({
      working: [
        tool(11, "browser_control", "action: click, selector: #go", true),
        tool(12, "browser_control", "action: read", true, ""),
      ],
      finalText: "Done.",
    });
    expect(out).toContain("--- TOOL 1: browser_control ---");
    expect(out).toContain("--- TOOL 2: browser_control ---");
    // ok:true with an empty/absent outputSummary → the honest "(no output)".
    expect(out).toContain("result: ok — (no output)");
  });

  it("a FAILED tool without an output summary still reads as FAILED", () => {
    const out = buildFullTurnText({ working: [tool(3, "run_command", "cmd: npm test", false)], finalText: "Failed." });
    expect(out).toContain("result: FAILED — (no output)");
  });

  it("model/duration fall back honestly when the turn carried neither", () => {
    const out = buildFullTurnText({ working: [], finalText: "Plain answer." });
    expect(out).toContain("Model: unknown | Duration: ?ms");
    expect(out).toContain("--- FINAL ANSWER ---\nPlain answer.");
    // No working entries → no narration banner, no tool blocks.
    expect(out).not.toContain("--- USER NARRATION / THINKING ---");
  });

  it("approval entries render their own block with tool, status, args, category", () => {
    const denied: WorkingEntry = {
      type: "approval",
      approvalId: "apv_2",
      toolName: "run_command",
      argsSummary: "cmd: npm test",
      category: "shell",
      status: "denied",
      ts: "2026-09-06T10:00:05Z",
    };
    const out = buildFullTurnText({
      working: [approval("approved"), denied],
      finalText: "Approved then denied.",
    });
    expect(out).toContain("--- APPROVAL: write_file (approved) ---");
    expect(out).toContain("args: path: a.txt, 120 chars");
    expect(out).toContain("category: filesystem");
    expect(out).toContain("--- APPROVAL: run_command (denied) ---");
  });

  it("approval extras ride when present: remember + sub-agent attribution", () => {
    const entry: WorkingEntry = {
      type: "approval",
      approvalId: "apv_1",
      toolName: "write_file",
      argsSummary: "path: a.txt, 120 chars",
      category: "filesystem",
      status: "approved",
      remember: "always",
      subAgentId: "ag_child_7",
      ts: "2026-09-06T10:00:04Z",
    };
    const out = buildFullTurnText({ working: [entry], finalText: "ok" });
    expect(out).toContain("remember: always");
    expect(out).toContain("sub-agent: ag_child_7");
  });

  it("empty working entries and an empty final answer are skipped honestly", () => {
    const out = buildFullTurnText({
      working: [thinking("   "), narration(""), { type: "tool", tool: { seq: 1, toolName: "read_file", argsSummary: "", ok: true, ts: "t" } }],
      finalText: "  ",
    });
    // No narration banner (no non-empty thinking/text), no FINAL ANSWER.
    expect(out).not.toContain("--- USER NARRATION / THINKING ---");
    expect(out).not.toContain("--- FINAL ANSWER ---");
    // The tool block still renders (a tool call is a fact, args just empty).
    expect(out).toContain("--- TOOL 1: read_file ---");
    expect(out).toContain("args: \n");
  });

  it("an in-flight tool (ok:null, live rows) reads as pending", () => {
    const out = buildFullTurnText({ working: [tool(2, "read_file", "path: b.ts", null)], finalText: "" });
    expect(out).toContain("result: pending (call in flight)");
  });

  it("ROUND-68 (R68-A): a live screenshot marker renders as the honest one-line fact — the bytes are ephemeral, and it never counts as a tool", () => {
    const shot: WorkingEntry = { type: "screenshot", frameId: "f-1", tool: "zoom", ts: "2026-09-06T10:00:04Z" };
    const out = buildFullTurnText({
      working: [tool(7, "screenshot", "full display", true, "captured"), shot],
      finalText: "Done.",
    });
    // The marker line rides AFTER the tool block that captured it (the
    // capture moment) and names the capturing tool.
    expect(out).toContain("[screenshot captured by zoom]");
    expect(out.indexOf("--- TOOL 1: screenshot ---")).toBeLessThan(out.indexOf("[screenshot captured by zoom]"));
    // A capture is NOT a tool call: only ONE tool block exists.
    expect(out).not.toContain("--- TOOL 2:");
  });

  it("huge turns are capped at ~100KB, tail-kept, with an honest truncation marker", () => {
    const huge = "x".repeat(150_000);
    const out = buildFullTurnText({ working: [thinking(huge)], finalText: "The verdict.", model: "m" });
    expect(out.length).toBeLessThanOrEqual(100_000);
    expect(out.startsWith("…[turn export truncated — head omitted, tail kept]…")).toBe(true);
    // Tail-kept: the final answer survives the cap.
    expect(out.endsWith("--- FINAL ANSWER ---\nThe verdict.")).toBe(true);
  });
});
