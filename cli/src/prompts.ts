/**
 * ROUND-107 (R107-c-impl, F6/F2): the terminal ASK helpers shared by the
 * REPL and the one-shot. Each opens a throwaway readline interface on the
 * real stdin/stderr (the REPL's own approval pattern — its main interface
 * keeps running; the inner one closes after one exchange), writes the
 * question, and resolves the answer. NULL means "could not ask/answer" —
 * the caller leaves the ask OPEN (the sidecar's own timeout is the
 * fallback), exactly like the approval prompt's null.
 */
import * as readline from "node:readline";
import type { AgentAnswerSource, AgentQuestionItem } from "./frames.js";
import { trunc } from "./render/tools.js";

/** The approval ask shape (render/turn.ts ApprovalAsk). */
export interface ApprovalAsk {
  approvalId: string;
  toolName: string;
  argsSummary: string;
  category: string;
}

/** The agent-question ask (render/turn.ts QuestionAsk). */
export interface QuestionAsk {
  questionId: string;
  questions: AgentQuestionItem[];
}

/** The answer set for one ask — one answer per question, in order, with
 * its source (option pick vs custom text) for the resolve POST. */
export interface QuestionAnswer {
  answers: string[];
  sources: AgentAnswerSource[];
}

/** The y/N approval ask (moved verbatim from the REPL — F6 gives the
 * one-shot the same prompt when stdin is a terminal). */
export function askApproval(ask: ApprovalAsk): Promise<"approved" | "denied" | null> {
  return new Promise((resolve) => {
    const inner = readline.createInterface({ input: process.stdin, output: process.stderr });
    inner.question(`  approve ${ask.toolName}? [y/N] `, (answerText: string) => {
      inner.close();
      const answer = answerText.trim().toLowerCase();
      resolve(answer === "y" || answer === "yes" ? "approved" : "denied");
    });
    inner.on("close", () => resolve(null));
  });
}

/** One answer line → (answer, source): a number in range picks that
 * option; any other non-empty text is a custom answer when the question
 * allows one. */
function parseAnswer(
  text: string,
  question: AgentQuestionItem,
): { answer: string; source: AgentAnswerSource } | null {
  const trimmed = text.trim();
  const options = Array.isArray(question.options) ? question.options : [];
  if (/^\d+$/.test(trimmed)) {
    const pick = Number(trimmed);
    if (pick >= 1 && pick <= options.length) {
      return { answer: options[pick - 1], source: "option" };
    }
    return null; // a number OUT of range is never a custom answer
  }
  if (trimmed !== "" && question.allowCustom !== false) {
    return { answer: trimmed, source: "custom" };
  }
  return null;
}

/** MAX_MISSES bounds the re-ask loop — a hopeless session (piped garbage,
 * a stuck terminal) resolves null and leaves the ask open instead of
 * spinning forever. */
const MAX_MISSES = 5;

/** The numbered agent-question ask (F2): walks the questions in order, one
 * answer each (the resolve route requires answers.length === questions.length
 * — there is no multi-select, one pick per question). */
export function askAgentQuestion(ask: QuestionAsk): Promise<QuestionAnswer | null> {
  return new Promise((resolve) => {
    const inner = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answers: string[] = [];
    const sources: AgentAnswerSource[] = [];
    let index = 0;
    let misses = 0;
    let settled = false;
    const finish = (result: QuestionAnswer | null): void => {
      if (settled) return;
      settled = true;
      inner.close();
      resolve(result);
    };
    inner.on("close", () => finish(null)); // EOF mid-ask — honest null
    const askNext = (): void => {
      if (settled) return; // the interface closed mid-ask — nothing left to ask
      const question = ask.questions[index];
      if (question === undefined) {
        finish({ answers, sources });
        return;
      }
      const options = Array.isArray(question.options) ? question.options : [];
      const hint =
        options.length > 0
          ? question.allowCustom === false
            ? `[1-${options.length}]`
            : `[1-${options.length} or your own text]`
          : "your answer";
      inner.question(
        `  ${index + 1}/${ask.questions.length}: ${trunc(question.question, 80)}\n  answer ${hint}: `,
        (text: string) => {
          const parsed = parseAnswer(text, question);
          if (parsed === null) {
            misses++;
            if (misses >= MAX_MISSES) {
              finish(null); // the ask stays open — the sidecar timeout is the fallback
              return;
            }
            askNext(); // same question again (index untouched)
            return;
          }
          answers.push(parsed.answer);
          sources.push(parsed.source);
          misses = 0;
          index++;
          askNext();
        },
      );
    };
    askNext();
  });
}
