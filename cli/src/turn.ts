/**
 * ROUND-106 (R106-S3, CLI-DESIGN §4): the shared streamed-turn driver —
 * one POST /sessions/:id/messages/stream rendered by the text or NDJSON
 * renderer, with the Ctrl-C discipline:
 *
 *   1st press DURING a turn → POST /sessions/:id/stop, keep reading until
 *   the stopped frame (10s give-up, then exit 1);
 *   2nd press → exit 130 immediately.
 *
 * The one-shot installs the process SIGINT handler directly; the REPL
 * routes its readline SIGINT events through `sigintRouter` (raw-mode
 * readline swallows the terminal signal).
 */
import { apiFetch } from "./api.js";
import type { CliContext } from "./context.js";
import type { AgentAnswerSource, TurnFrame } from "./frames.js";
import { streamTurn } from "./stream.js";
import {
  createTurnRenderer,
  type ApprovalAsk,
  type QuestionAnswer,
  type QuestionAsk,
} from "./render/turn.js";
import { createJsonRenderer } from "./render/json.js";

export interface TurnRunOptions {
  sessionId: string;
  content: string;
  model?: string;
  /** REPL's y/n ask (text mode only). */
  promptApproval?: (ask: ApprovalAsk) => Promise<"approved" | "denied" | null>;
  /** ROUND-107 (F2): the numbered agent-question ask (text mode only). */
  promptQuestion?: (ask: QuestionAsk) => Promise<QuestionAnswer | null>;
  /** REPL signal routing (see header); absent → process SIGINT is used. */
  sigintRouter?: (route: (() => void) | null) => void;
  /** json mode: lifecycle events ride this (cli.* lines). */
  lifecycle?: (event: Record<string, unknown>) => void;
}

const GIVE_UP_MS = 10_000;

export async function runStreamedTurn(ctx: CliContext, options: TurnRunOptions): Promise<number> {
  const jsonRenderer = ctx.json
    ? createJsonRenderer({ stdout: ctx.stdout })
    : null;
  const textRenderer = jsonRenderer === null
    ? createTurnRenderer({
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        kit: ctx.kit,
        plain: ctx.plain,
        quiet: ctx.quiet,
        stderrTty: process.stderr.isTTY === true,
        autoApprove: ctx.autoApprove,
        ...(options.promptApproval !== undefined ? { promptApproval: options.promptApproval } : {}),
        ...(options.promptQuestion !== undefined ? { promptQuestion: options.promptQuestion } : {}),
        decideApproval: (approvalId, decision) =>
          apiFetch(ctx.conn, "POST", `/approvals/${approvalId}/decision`, { decision }),
        decideQuestion: (questionId: string, answers: string[], sources: AgentAnswerSource[]) =>
          apiFetch(ctx.conn, "POST", `/agent-questions/${questionId}/resolve`, { answers, sources }),
      })
    : null;

  let exitCode: number | undefined;
  let sigints = 0;
  let giveUp: NodeJS.Timeout | null = null;

  const stopTurn = (): void => {
    apiFetch(ctx.conn, "POST", `/sessions/${options.sessionId}/stop`)
      .then((json: unknown) => {
        if (!ctx.quiet && !ctx.json) {
          ctx.stderr(ctx.kit.dim(`— stop posted (${JSON.stringify(json)})\n`));
        }
      })
      .catch((err: unknown) => {
        ctx.stderr(ctx.kit.red(`— stop POST failed: ${err instanceof Error ? err.message : String(err)}\n`));
      });
  };

  const onSigint = (): void => {
    sigints++;
    if (sigints > 1) {
      ctx.stderr(`\n${ctx.kit.red("— second Ctrl-C — exiting now")}\n`);
      process.exit(130);
    }
    ctx.stderr(`\n${ctx.kit.yellow(`— Ctrl-C — POSTing /sessions/${options.sessionId}/stop …`)}\n`);
    stopTurn();
    // If no terminal frame lands within 10s of the stop, give up honestly.
    giveUp = setTimeout(() => {
      ctx.stderr(`${ctx.kit.red("— no stopped/done frame within 10s of the stop POST — exiting")}\n`);
      process.exit(1);
    }, GIVE_UP_MS);
    giveUp.unref?.();
  };

  const useProcessSigint = options.sigintRouter === undefined;
  if (useProcessSigint) {
    process.on("SIGINT", onSigint);
  } else {
    options.sigintRouter!(onSigint);
  }

  try {
    await streamTurn(
      ctx.conn,
      options.sessionId,
      options.content,
      (frame: TurnFrame): boolean => {
        const code = jsonRenderer !== null ? jsonRenderer.handle(frame) : textRenderer!.handle(frame);
        if (code !== undefined) {
          exitCode = code;
          return true; // terminal frame — stop reading (break-on-terminal)
        }
        return false;
      },
      { model: options.model },
    );
    if (exitCode === undefined) {
      // Every stream path synthesizes a terminal frame (stream.ts R43 rule);
      // reaching here means an abort carve-out — the honest exit-1.
      textRenderer?.finish();
      exitCode = 1;
    }
  } finally {
    if (useProcessSigint) {
      process.off("SIGINT", onSigint);
    } else {
      options.sigintRouter!(null);
    }
    if (giveUp !== null) clearTimeout(giveUp);
  }
  return exitCode;
}
