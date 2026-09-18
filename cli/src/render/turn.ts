/**
 * ROUND-106 (R106-S3, CLI-DESIGN §4): the TEXT-MODE turn renderer — the
 * frame dispatcher that walks CLI-DESIGN §4 EXACTLY:
 *
 *   text-delta   → stdout verbatim through the markdown-lite machine;
 *   thinking     → ONE overwritten dim stderr line (count only off-TTY);
 *   tool-input   → the status line gains tool name + first streamed arg;
 *   tool cards   → accent `▸ name(args)`, live output beneath, ok/FAIL +
 *                  dim 140-char summary;
 *   meta.*       → dim status lines; subagent-status → `[A1] running · …`;
 *   approval     → yellow card (+ y/n in REPL / --auto-approve);
 *   terminal     → done/stopped/error with the exit-code semantics.
 *
 * Incremental only — nothing is ever re-rendered. `--quiet` keeps the
 * assistant text + terminal errors and drops every meta/card/status line.
 */
import type { ColorKit } from "../color.js";
import type { TurnFrame } from "../frames.js";
import { createMarkdownRenderer } from "./text.js";
import { StatusLine } from "./status.js";
import {
  approvalCard,
  doneLine,
  errorLine,
  subagentLine,
  toolCallLine,
  toolResultSummary,
  toolResultVerdict,
  trunc,
} from "./tools.js";

export interface ApprovalAsk {
  approvalId: string;
  toolName: string;
  argsSummary: string;
  category: string;
}

export interface TurnRendererOptions {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  kit: ColorKit;
  /** Markdown in plain mode (no color) — structure still consumed. */
  plain: boolean;
  quiet: boolean;
  /** The status line needs a TTY stderr (\r rewriting). */
  stderrTty: boolean;
  autoApprove: boolean;
  /** POST /approvals/:id/decision (fire-and-forget; errors noted dim). */
  decideApproval?: (approvalId: string, decision: "approved" | "denied") => Promise<void>;
  /** REPL's y/n ask; absent → the one-shot hint path. */
  promptApproval?: (ask: ApprovalAsk) => Promise<"approved" | "denied" | null>;
}

export interface TurnRenderer {
  /** Feed one frame; returns the EXIT CODE on terminal frames. */
  handle(frame: TurnFrame): number | undefined;
  /** Safety flush when the stream produced no terminal frame. */
  finish(): void;
}

interface FinishUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export function createTurnRenderer(options: TurnRendererOptions): TurnRenderer {
  const { stdout, stderr, kit, plain, quiet, autoApprove } = options;
  const status = new StatusLine(stderr, options.stderrTty && !quiet);
  const markdown = createMarkdownRenderer(kit, plain);
  let needNl = false; // stdout ended mid-line
  let thinkingChars = 0; // §4: off-TTY still counts
  let finishUsage: FinishUsage | undefined;
  const toolInputs = new Map<string, string>();

  /** Clear the status line + break a mid-line stdout before a block. */
  const startLine = (): void => {
    status.clear();
    if (needNl) {
      stdout("\n");
      needNl = false;
    }
  };

  const flushMarkdown = (): void => {
    status.clear();
    const out = markdown.finish();
    if (out !== "") {
      stdout(out);
      needNl = !out.endsWith("\n");
    }
  };

  const writeText = (delta: string): void => {
    status.clear();
    const out = markdown.push(delta);
    if (out !== "") {
      stdout(out);
      needNl = !out.endsWith("\n");
    }
  };

  const decide = (approvalId: string, decision: "approved" | "denied"): void => {
    const post = options.decideApproval?.(approvalId, decision);
    if (post === undefined) return;
    post
      .then(() => {
        stderr(kit.dim(`  approval ${approvalId} ${decision}\n`));
      })
      .catch((err: unknown) => {
        stderr(
          kit.red(
            `  approval decision failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
      });
  };

  const handleApproval = (frame: ApprovalAsk): void => {
    startLine();
    for (const line of approvalCard(kit, frame)) stderr(`${line}\n`);
    if (autoApprove) {
      stderr(kit.dim("  --auto-approve: deciding approved …\n"));
      decide(frame.approvalId, "approved");
      return;
    }
    if (options.promptApproval !== undefined) {
      const asked = options.promptApproval(frame);
      asked
        .then((answer) => {
          if (answer !== null) decide(frame.approvalId, answer);
          else stderr(kit.dim("  (no decision — the ask stays open)\n"));
        })
        .catch(() => {
          stderr(kit.dim("  (prompt failed — the ask stays open)\n"));
        });
      return;
    }
    stderr(
      `  decide in another terminal: ${kit.bold(
        `acute raw POST /approvals/${frame.approvalId}/decision '{"decision":"approved"}'`,
      )}\n`,
    );
    stderr(kit.dim("  (or rerun with --auto-approve; the stream stays open until it resolves)\n"));
  };

  const handle = (frame: TurnFrame): number | undefined => {
    const type = frame.type as string;
    switch (type) {
      case "text-delta": {
        const f = frame as { delta?: unknown; text?: unknown };
        const delta =
          typeof f.delta === "string" ? f.delta : typeof f.text === "string" ? f.text : "";
        if (delta !== "") writeText(delta);
        return undefined;
      }
      case "thinking-delta": {
        // Counted even off-TTY (§4: non-TTY counts only).
        const f = frame as { delta?: unknown };
        const delta = typeof f.delta === "string" ? f.delta : "";
        thinkingChars += delta.length;
        status.set(kit.dim(`thinking… (${thinkingChars} chars)`.padEnd(40)));
        return undefined;
      }
      case "tool-input-start": {
        const f = frame as { toolCallId: string; toolName: string };
        status.set(kit.dim(`▸ ${f.toolName} · preparing arguments…`));
        return undefined;
      }
      case "tool-input-delta": {
        const f = frame as { toolCallId: string; inputTextDelta: string };
        const soFar = (toolInputs.get(f.toolCallId) ?? "") + f.inputTextDelta;
        toolInputs.set(f.toolCallId, soFar);
        status.set(kit.dim(trunc(`▸ preparing arguments: ${soFar}`, 72)));
        return undefined;
      }
      case "tool-call": {
        const f = frame as { toolName: string; argsSummary: string };
        if (!quiet) {
          startLine();
          stdout(`${toolCallLine(kit, f.toolName, f.argsSummary ?? "")} `);
        }
        return undefined;
      }
      case "tool-output": {
        if (quiet) return undefined;
        const f = frame as { chunk?: unknown };
        if (typeof f.chunk === "string") stdout(f.chunk);
        return undefined;
      }
      case "tool-result": {
        if (!quiet) {
          const f = frame as { ok?: unknown; outputSummary?: unknown };
          stdout(` ${toolResultVerdict(kit, f.ok !== false)}\n`);
          const summary = toolResultSummary(
            typeof f.outputSummary === "string" ? f.outputSummary : undefined,
          );
          if (summary !== null) stdout(`${kit.dim(`      ${summary}`)}\n`);
        }
        return undefined;
      }
      case "meta.continuation": {
        const f = frame as { iteration?: unknown; reason?: unknown };
        if (!quiet) {
          startLine();
          const reason = typeof f.reason === "string" ? ` · ${f.reason}` : "";
          stdout(`${kit.dim(`— continuing (iteration ${f.iteration ?? "?"}${reason})`)}\n`);
        }
        return undefined;
      }
      case "meta.retry": {
        const f = frame as {
          attempt?: unknown;
          totalAttempts?: unknown;
          remainingMs?: unknown;
          errorClass?: unknown;
          providerError?: unknown;
        };
        if (!quiet) {
          startLine();
          const wait = Math.ceil(Number(f.remainingMs ?? 0) / 1000);
          const detail =
            typeof f.providerError === "string" && f.providerError !== ""
              ? ` · ${trunc(f.providerError, 90)}`
              : "";
          stdout(
            `${kit.dim(
              `— retrying (${f.attempt ?? "?"}/${f.totalAttempts ?? "?"} · ${f.errorClass ?? "?"}) in ${wait}s${detail}`,
            )}\n`,
          );
        }
        return undefined;
      }
      case "meta.key": {
        const f = frame as { key?: { attempt?: unknown; totalKeys?: unknown }; message?: unknown };
        if (!quiet) {
          startLine();
          stdout(`${kit.dim(`— key pool: ${f.message ?? ""} (attempt ${f.key?.attempt ?? "?"}/${f.key?.totalKeys ?? "?"})`)}\n`);
        }
        return undefined;
      }
      case "meta.queue_continue": {
        const f = frame as { count?: unknown; recovery?: unknown };
        if (!quiet) {
          startLine();
          const why = f.recovery === true ? "resuming with your queued message" : "continuing with queued messages";
          stdout(`${kit.dim(`— ${why} (${f.count ?? "?"} left)`)}\n`);
        }
        return undefined;
      }
      case "meta.overflow_recovery": {
        const f = frame as { message?: unknown };
        if (!quiet) {
          startLine();
          stdout(`${kit.dim(`— ${f.message ?? "context overflow recovered — retrying"}`)}\n`);
        }
        return undefined;
      }
      case "meta.compaction": {
        const f = frame as { tokensSaved?: unknown; droppedMessages?: unknown };
        if (!quiet) {
          startLine();
          stdout(
            `${kit.dim(
              `— context compacted: ${f.tokensSaved ?? "?"} tokens saved, ${f.droppedMessages ?? "?"} messages dropped`,
            )}\n`,
          );
        }
        return undefined;
      }
      case "meta.context_limit": {
        if (!quiet) {
          startLine();
          const f = frame as { tokens?: unknown; limit?: unknown };
          stdout(`${kit.dim(`— context limit reached (${f.tokens ?? "?"} of ${f.limit ?? "?"} tokens)`)}\n`);
        }
        return undefined;
      }
      case "meta.request_limit": {
        if (!quiet) {
          startLine();
          const f = frame as { requests?: unknown; limit?: unknown };
          stdout(`${kit.dim(`— request limit reached (${f.requests ?? "?"} of ${f.limit ?? "?"})`)}\n`);
        }
        return undefined;
      }
      case "meta.continuation_complete": {
        if (!quiet) {
          startLine();
          const f = frame as { iterations?: unknown };
          stdout(`${kit.dim(`— outer loop cap reached (${f.iterations ?? "?"} iterations)`)}\n`);
        }
        return undefined;
      }
      case "subagent-status": {
        if (!quiet) {
          startLine();
          stdout(`${subagentLine(kit, frame as Parameters<typeof subagentLine>[1])}\n`);
        }
        return undefined;
      }
      case "approval.requested": {
        handleApproval(frame as unknown as ApprovalAsk);
        return undefined;
      }
      case "approval.resolved": {
        const f = frame as { approvalId?: unknown; decision?: unknown; remember?: unknown };
        if (!quiet) {
          startLine();
          const remember = typeof f.remember === "string" ? ` (remember ${f.remember})` : "";
          stderr(kit.dim(`— approval ${f.approvalId ?? "?"} ${f.decision ?? "?"}${remember}\n`));
        }
        return undefined;
      }
      case "finish": {
        const f = frame as { usage?: FinishUsage };
        finishUsage = f.usage;
        return undefined;
      }
      case "done": {
        flushMarkdown();
        if (!quiet) {
          startLine();
          const f = frame as { usage?: Parameters<typeof doneLine>[1] };
          stdout(`${doneLine(kit, f.usage ?? finishUsage)}\n`);
        }
        return 0;
      }
      case "stopped": {
        flushMarkdown();
        if (!quiet) {
          startLine();
          stdout(`${kit.dim("— stopped by user")}\n`);
        }
        return 0;
      }
      case "error": {
        flushMarkdown();
        status.clear();
        const f = frame as { code?: unknown; message?: unknown };
        stderr(`${errorLine(kit, {
          code: typeof f.code === "string" ? f.code : undefined,
          message: typeof f.message === "string" ? f.message : "unknown error",
        })}\n`);
        return 1;
      }
      default:
        return undefined; // unknown frames ignored (version skew, §7.2)
    }
  };

  return {
    handle,
    finish: () => {
      flushMarkdown();
      status.clear();
    },
  };
}
