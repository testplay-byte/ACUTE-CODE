import type { WorkingEntry } from "./api";

/**
 * ROUND-67 (R67-B, the owner's SECOND copy option): the full-turn
 * clipboard builder. Owner spec: "The whole conversation of it, all the
 * thinking of it, all the tool calls within it, and everything like that…
 * This option will only be shown as the other copy option when the debug
 * option in the advanced settings has been turned on."
 *
 * Renders ONE assistant turn as a readable text export — the style is
 * modeled on agent-core's agents/debug-analyst.ts renderEvent (the
 * context-free analyst's transcript renderer): one line per event, tool
 * calls as `--- TOOL n: name ---` separators with args + result lines,
 * thinking/narration as tagged lines, the final answer last.
 * ROUND-68 (R68-A): live `screenshot` capture markers render as honest
 * one-line facts (`[screenshot captured by <tool>]`) — the rasters are
 * ephemeral server-side, so the bytes are always gone by copy time.
 *
 * HONESTY NOTE (documented deliberately): tool outputs ride the persisted
 * `outputSummary` — the runtime already caps each summary at 4000 chars
 * (head+tail, summarizeToolOutput) at emit time — so this export carries
 * those SUMMARIES, not the raw tool output. There is no larger copy
 * source client-side: the raw output never crosses the wire.
 *
 * PURE function (no store imports, no React): both the folded
 * AssistantTurn footer (AgentChatPanel) and the live-completed footer build
 * their `fullCopyText` from the same shape.
 */

/** Input shape shared by both call sites. */
export interface FullTurnTextInput {
  /** The turn's working entries in order (thinking / text / tool /
   * approval — and, ROUND-68 R68-A, live-only `screenshot` markers). */
  working: WorkingEntry[];
  /** The final answer (folded: AssistantTurnItem.finalText; live: streamText). */
  finalText: string;
  /** The model that ran the turn (header line). */
  model?: string;
  /** The turn duration in ms (header line). */
  ms?: number;
}

/** Hard cap on the export (~100KB) — a clipboard is not a file dump. When
 * exceeded, the HEAD is dropped (the final answer + most recent tool work
 * at the tail is where the verdict lives — the debug-analyst
 * head-and-tail precedent) and an honest truncation marker leads. */
const MAX_TURN_EXPORT_CHARS = 100_000;
const TURN_EXPORT_TRUNCATION_NOTE = "…[turn export truncated — head omitted, tail kept]…";

/**
 * Build the full-turn clipboard text. Empty working entries and an empty
 * final answer are skipped honestly (a thinking-only turn exports no FINAL
 * ANSWER block; a bare answer exports just the header + the answer).
 */
export function buildFullTurnText(input: FullTurnTextInput): string {
  const blocks: string[] = [
    "=== ACUTE-CODE turn export (debug) ===",
    `Model: ${input.model ?? "unknown"} | Duration: ${input.ms !== undefined ? Math.round(input.ms) : "?"}ms`,
  ];
  // The narration/thinking banner is emitted once, before the first
  // thinking-or-text entry, wherever it lands in the sequence.
  let narrationHeaderEmitted = false;
  let toolCount = 0;
  for (const entry of input.working) {
    if (entry.type === "thinking") {
      const text = entry.text.trim();
      if (text === "") continue;
      if (!narrationHeaderEmitted) {
        blocks.push("", "--- USER NARRATION / THINKING ---");
        narrationHeaderEmitted = true;
      }
      blocks.push(`[THINKING] ${text}`);
    } else if (entry.type === "text") {
      const content = entry.content.trim();
      if (content === "") continue;
      if (!narrationHeaderEmitted) {
        blocks.push("", "--- USER NARRATION / THINKING ---");
        narrationHeaderEmitted = true;
      }
      blocks.push(`[TEXT] ${content}`);
    } else if (entry.type === "tool") {
      const tool = entry.tool;
      toolCount += 1;
      blocks.push("", `--- TOOL ${toolCount}: ${tool.toolName} ---`);
      blocks.push(`args: ${tool.argsSummary}`);
      if (tool.ok === null) {
        // Live rows only (in-flight calls) — the persisted log always has a
        // concrete boolean.
        blocks.push("result: pending (call in flight)");
      } else if (tool.ok) {
        blocks.push(`result: ok — ${tool.outputSummary ?? "(no output)"}`);
      } else {
        blocks.push(`result: FAILED — ${tool.outputSummary ?? "(no output)"}`);
      }
    } else if (entry.type === "screenshot") {
      // ROUND-68 (R68-A): a live capture marker — the PNG bytes are EPHEMERAL
      // server-side (never persisted), so by copy time they are gone: the
      // export carries the honest one-line fact, not an image. Still does
      // NOT bump toolCount (a capture is not a tool call).
      blocks.push(`[screenshot captured by ${entry.tool}]`);
    } else {
      // approval: the human-in-the-loop checkpoint, with its own fields.
      blocks.push("", `--- APPROVAL: ${entry.toolName} (${entry.status}) ---`);
      blocks.push(`args: ${entry.argsSummary}`);
      blocks.push(`category: ${entry.category}`);
      if (entry.remember !== undefined) blocks.push(`remember: ${entry.remember}`);
      if (entry.subAgentId !== undefined) blocks.push(`sub-agent: ${entry.subAgentId}`);
    }
  }
  const finalText = input.finalText.trim();
  if (finalText !== "") {
    blocks.push("", "--- FINAL ANSWER ---", finalText);
  }
  let out = blocks.join("\n");
  if (out.length > MAX_TURN_EXPORT_CHARS) {
    const keep = MAX_TURN_EXPORT_CHARS - TURN_EXPORT_TRUNCATION_NOTE.length - 1;
    out = `${TURN_EXPORT_TRUNCATION_NOTE}\n${out.slice(-keep)}`;
  }
  return out;
}
