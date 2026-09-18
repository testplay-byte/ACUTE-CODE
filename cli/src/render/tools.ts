/**
 * ROUND-106 (R106-S3, CLI-DESIGN §4): the TOOL CARDS — `▸ toolName(args)`
 * in accent, live output streaming beneath, ` ok`/`FAIL` + a dim 140-char
 * result summary. Pure frame→string functions (the M1 test contract:
 * recorded frame fixtures in, exact strings out).
 */
import type { ColorKit } from "../color.js";
import type { AgentQuestionItem } from "../frames.js";

/** One-line truncation with the repo's ellipsis form. */
export function trunc(value: unknown, max: number): string {
  const str = String(value ?? "");
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

/** `▸ toolName(argsSummary)` — the tool-call card line. */
export function toolCallLine(kit: ColorKit, toolName: string, argsSummary: string): string {
  const args = argsSummary === "" ? "" : `(${trunc(argsSummary, 100)})`;
  return kit.accent(`▸ ${toolName}${args}`);
}

/** The result tail: ` ok` / `FAIL` (colored) for the card's line. */
export function toolResultVerdict(kit: ColorKit, ok: boolean): string {
  return ok ? kit.green("ok") : kit.red("FAIL");
}

/** The dim indented result summary (140 chars, one line, whitespace-folded). */
export function toolResultSummary(outputSummary: string | undefined): string | null {
  if (typeof outputSummary !== "string" || outputSummary === "") return null;
  return trunc(outputSummary.replace(/\s+/g, " "), 140);
}

/** The approval card (§4: yellow) — the block shown around the y/n ask. */
export function approvalCard(
  kit: ColorKit,
  frame: { toolName: string; argsSummary: string; category: string; approvalId: string },
): string[] {
  return [
    kit.yellow(kit.bold("── approval requested ──")),
    kit.yellow(`${frame.toolName}(${trunc(frame.argsSummary, 100)})`),
    `  category ${frame.category} · approval id ${kit.bold(frame.approvalId)}`,
  ];
}

/** ROUND-107 (R107-c-impl, F2): the agent-question card — the approvalCard
 * pattern applied to ask_user: yellow header, one block per question
 * (question + numbered options + the custom-text hint), question id last. */
export function questionCard(
  kit: ColorKit,
  frame: { questionId: string; questions: AgentQuestionItem[] },
): string[] {
  const lines: string[] = [kit.yellow(kit.bold("── agent question ──"))];
  const total = frame.questions.length;
  frame.questions.forEach((question, i) => {
    lines.push(kit.yellow(`${i + 1}/${total}: ${trunc(question.question, 100)}`));
    const options = Array.isArray(question.options) ? question.options : [];
    options.forEach((option, j) => {
      lines.push(`  ${j + 1}) ${trunc(option, 100)}`);
    });
    if (options.length === 0) {
      lines.push("  (free text)");
    } else if (question.allowCustom === false) {
      lines.push(`  (pick 1-${options.length})`);
    } else {
      lines.push(`  (1-${options.length}, or type your own answer)`);
    }
  });
  lines.push(`  question id ${kit.bold(frame.questionId)}`);
  return lines;
}

/** `— done · model · N in · N out · $cost` (§4 terminal frame). */
export interface DoneUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export function doneLine(kit: ColorKit, usage: DoneUsage | undefined): string {
  const parts: string[] = [];
  if (usage !== null && typeof usage === "object") {
    if (typeof usage.model === "string" && usage.model !== "") parts.push(usage.model);
    if (typeof usage.inputTokens === "number") parts.push(`${usage.inputTokens} in`);
    if (typeof usage.outputTokens === "number") parts.push(`${usage.outputTokens} out`);
    if (typeof usage.costUsd === "number" && usage.costUsd > 0) parts.push(`$${usage.costUsd}`);
  }
  return kit.dim(parts.length === 0 ? "— done" : `— done · ${parts.join(" · ")}`);
}

/** The dim meta status lines (§4: retry|key|queue_continue|compaction|…). */
export function metaLine(text: string): string {
  return text;
}

/** `[A1] running · task…` — the subagent-status line (§4). */
export function subagentLine(
  kit: ColorKit,
  frame: { code?: string; status?: string; task?: string; role?: string },
): string {
  const code = typeof frame.code === "string" && frame.code !== "" ? frame.code : "?";
  const status = typeof frame.status === "string" && frame.status !== "" ? frame.status : "?";
  const task = trunc(frame.task ?? "", 70);
  const role = typeof frame.role === "string" && frame.role !== "" ? ` · ${frame.role}` : "";
  return kit.dim(`[${code}] ${status}${role} · ${task}`);
}

/** The error frame's red envelope line (§4 terminal frame). */
export function errorLine(kit: ColorKit, frame: { code?: string; message: string }): string {
  const code = typeof frame.code === "string" && frame.code !== "" ? `${frame.code}: ` : "";
  return kit.red(`stream error ${code}${frame.message}`);
}
