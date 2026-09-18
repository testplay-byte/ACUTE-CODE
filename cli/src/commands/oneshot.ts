/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2/§6): the ONE-SHOT — `acute -p "prompt"`:
 * create session (or continue --session) → stream → exit code from the
 * terminal frame. The M1 smallest-useful-thing, now over attach-or-spawn.
 *
 * ROUND-107 (R107-c-impl, F6): with a TTY stdin the one-shot now prompts
 * for approvals (y/N) and agent questions (numbered) instead of stalling
 * on the "decide in another terminal" hint; piped stdin keeps the hint
 * (the CI/script contract — nothing may block on a dead stdin).
 */
import { apiFetch } from "../api.js";
import { createSession, resolveAgentId, type CliContext, type SessionRow } from "../context.js";
import { runStreamedTurn } from "../turn.js";
import { flagString } from "../flags.js";
import { askAgentQuestion, askApproval, type ApprovalAsk, type QuestionAnswer, type QuestionAsk } from "../prompts.js";

/** The interactive asks the one-shot installs (F6) — injectable for tests;
 * the defaults are the shared terminal prompts (prompts.ts). */
export interface OneShotPrompts {
  approval: (ask: ApprovalAsk) => Promise<"approved" | "denied" | null>;
  question: (ask: QuestionAsk) => Promise<QuestionAnswer | null>;
}

export interface OneShotOptions {
  /** Interactive asks present? Default: `process.stdin.isTTY` (F6). */
  interactive?: boolean;
  /** Test injection for the two ask implementations. */
  prompts?: OneShotPrompts;
}

export async function runOneShot(
  ctx: CliContext,
  options: OneShotOptions = {},
): Promise<number> {
  const prompt = flagString(ctx.flags, "print");
  if (prompt === undefined) {
    ctx.stderr('one-shot needs a prompt: acute -p "say hi"\n');
    return 1;
  }
  const model = flagString(ctx.flags, "model") ?? ctx.config.model;
  const resumeId = flagString(ctx.flags, "session");

  let sessionId: string;
  if (resumeId !== undefined) {
    // Continue an existing session — verify it exists for the honest 404.
    const existing = await apiFetch<SessionRow>(ctx.conn, "GET", `/sessions/${resumeId}`);
    sessionId = existing.id;
    if (!ctx.quiet && !ctx.json) {
      ctx.stderr(
        ctx.kit.dim(`— session ${existing.id} · ${existing.title ?? "(untitled)"} · ${existing.status}\n`),
      );
    }
  } else {
    const { agentId, note } = await resolveAgentId(ctx);
    const title = prompt.replace(/\s+/g, " ").slice(0, 60);
    const session = await createSession(ctx, agentId, title);
    sessionId = session.id;
    if (!ctx.quiet && !ctx.json) {
      const which = note !== null ? ` (${note})` : "";
      ctx.stderr(ctx.kit.dim(`— session ${session.id} · agent ${agentId}${which}\n`));
    }
  }

  if (ctx.json) {
    // NDJSON lifecycle: the session line rides stdout before the frames.
    ctx.stdout(
      `${JSON.stringify({ type: "cli.session", sessionId, ...(model !== undefined ? { model } : {}) })}\n`,
    );
  }

  // F6: prompt for approvals/questions when stdin can actually answer.
  const interactive = options.interactive ?? process.stdin.isTTY === true;
  const prompts: OneShotPrompts = options.prompts ?? {
    approval: askApproval,
    question: askAgentQuestion,
  };
  return runStreamedTurn(ctx, {
    sessionId,
    content: prompt,
    ...(model !== undefined ? { model } : {}),
    ...(interactive
      ? { promptApproval: prompts.approval, promptQuestion: prompts.question }
      : {}),
  });
}
