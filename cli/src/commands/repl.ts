/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2/§4): the REPL — `acute` with no command.
 * readline + ONE status line, no TUI. Slash commands: /model /agent
 * /sessions /stop /compact /exit (+ /help). Ctrl-C discipline: during a
 * turn → stop + wait for the stopped frame; idle → clear the line;
 * double-press → exit 130. EOF (Ctrl-D) exits like /exit.
 */
import * as readline from "node:readline";
import { apiFetch } from "../api.js";
import {
  createSession,
  resolveAgentId,
  type AgentRow,
  type CliContext,
  type SessionRow,
} from "../context.js";
import { runStreamedTurn } from "../turn.js";
import { flagString } from "../flags.js";
import { trunc } from "../render/tools.js";

interface ModelCatalog {
  models: Array<{ id: string; name?: string }>;
  defaultModelId: string;
  recommendedModelIds: string[];
}

interface ConfiguredModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string | null;
}

export async function runRepl(ctx: CliContext): Promise<number> {
  const resumeId = flagString(ctx.flags, "session");
  let sessionId: string;
  let modelOverride: string | undefined = flagString(ctx.flags, "model") ?? ctx.config.model;

  if (resumeId !== undefined) {
    const existing = await apiFetch<SessionRow>(ctx.conn, "GET", `/sessions/${resumeId}`);
    sessionId = existing.id;
    ctx.stderr(
      ctx.kit.dim(`— session ${existing.id} · ${existing.title ?? "(untitled)"} · ${existing.status}\n`),
    );
  } else {
    const { agentId, note } = await resolveAgentId(ctx);
    const session = await createSession(ctx, agentId);
    sessionId = session.id;
    ctx.stderr(ctx.kit.dim(`— session ${session.id} · agent ${agentId}${note !== null ? ` (${note})` : ""}\n`));
  }
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ type: "cli.session", sessionId })}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr.isTTY === true ? process.stderr : process.stdout,
    prompt: ctx.plain ? "acute> " : ctx.kit.accent("acute> "),
  });

  let inTurn = false;
  let turnSigint: (() => void) | null = null;
  let idleSigints = 0;
  let idleSigintTimer: NodeJS.Timeout | null = null;
  let closed = false;
  /** The REPL's final exit code — the close promise resolves with THIS, so
   * the /exit + double-Ctrl-C paths flow through run()'s return (130) instead
   * of a process.exitCode assignment the bin shim would overwrite. */
  let replExitCode = 0;

  const exitRepl = (code: number): void => {
    replExitCode = code;
    if (closed) return;
    closed = true;
    rl.close();
  };

  // Ctrl-C routing (§4): raw-mode readline swallows the terminal signal —
  // its SIGINT event is THE handler.
  rl.on("SIGINT", () => {
    if (inTurn) {
      turnSigint?.();
      return;
    }
    idleSigints++;
    if (idleSigints > 1) {
      ctx.stderr(`\n${ctx.kit.red("— second Ctrl-C — exiting")}\n`);
      exitRepl(130);
      return;
    }
    // First idle press: clear the current line, re-prompt (§4).
    rl.write("");
    ctx.stderr("\n(press Ctrl-C again to exit)\n");
    rl.prompt();
    if (idleSigintTimer !== null) clearTimeout(idleSigintTimer);
    idleSigintTimer = setTimeout(() => {
      idleSigints = 0;
    }, 1_500);
    idleSigintTimer.unref?.();
  });

  rl.on("close", () => {
    if (!closed) closed = true;
  });

  const handleSlash = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    const spaceAt = trimmed.indexOf(" ");
    const command = spaceAt < 0 ? trimmed : trimmed.slice(0, spaceAt);
    const rest = spaceAt < 0 ? "" : trimmed.slice(spaceAt + 1).trim();
    switch (command) {
      case "/help":
        ctx.stderr(
          [
            "  /model [id]   show models, or set the per-turn model override",
            "  /agent [id]   show agents, or start a NEW session with that agent",
            "  /sessions     list recent sessions",
            "  /stop         stop the live turn (if any)",
            "  /compact      compact this session's context",
            "  /exit         exit the REPL (also: Ctrl-D)",
          ].join("\n") + "\n",
        );
        return;
      case "/model": {
        if (rest !== "") {
          modelOverride = rest;
          ctx.stderr(ctx.kit.dim(`— model override: ${rest}\n`));
          return;
        }
        const catalog = await apiFetch<ModelCatalog>(ctx.conn, "GET", "/models/catalog");
        const configured = await apiFetch<{ models: ConfiguredModel[] }>(ctx.conn, "GET", "/models/configured");
        ctx.stderr(
          ctx.kit.dim(`catalog default: ${catalog.defaultModelId} · recommended: ${catalog.recommendedModelIds.join(", ")}\n`),
        );
        ctx.stderr(ctx.kit.dim("configured rows (id · provider · model):\n"));
        for (const m of configured.models) {
          const mark = m.modelId === modelOverride ? " ←" : "";
          ctx.stderr(`  ${trunc(m.id, 28).padEnd(28)} ${m.providerId.padEnd(14)} ${m.modelId}${mark}\n`);
        }
        ctx.stderr(
          ctx.kit.dim(`— current override: ${modelOverride ?? "(agent default)"} — /model <id> to set\n`),
        );
        return;
      }
      case "/agent": {
        const { agents } = await apiFetch<{ agents: AgentRow[] }>(ctx.conn, "GET", "/agents?includeTemplates=false");
        if (rest !== "") {
          const session = await createSession(ctx, rest);
          sessionId = session.id;
          ctx.stderr(ctx.kit.dim(`— new session ${session.id} · agent ${rest}\n`));
          return;
        }
        for (const a of agents) {
          const mark = a.id === (await currentAgentId()) ? " ←" : "";
          ctx.stderr(
            `  ${a.id.padEnd(20)} ${trunc(a.name, 18).padEnd(18)} ${a.providerId ?? "-"} ${a.model ?? "-"}${mark}\n`,
          );
        }
        ctx.stderr(ctx.kit.dim("— /agent <id> starts a NEW session with that agent\n"));
        return;
      }
      case "/sessions": {
        const { sessions } = await apiFetch<{ sessions: SessionRow[] }>(ctx.conn, "GET", "/sessions?limit=20");
        for (const s of sessions) {
          const mark = s.id === sessionId ? " ←" : "";
          ctx.stderr(`  ${s.id}  ${trunc(s.title ?? "(untitled)", 32).padEnd(32)}  ${s.status}${mark}\n`);
        }
        return;
      }
      case "/stop": {
        if (!inTurn) {
          ctx.stderr(ctx.kit.dim("— no live turn\n"));
          return;
        }
        const json = await apiFetch<{ ok: boolean; stopped: boolean }>(
          ctx.conn,
          "POST",
          `/sessions/${sessionId}/stop`,
        );
        ctx.stderr(
          ctx.kit.dim(
            json.stopped === true ? "— stop posted — waiting for the stopped frame\n" : "— no live turn found\n",
          ),
        );
        return;
      }
      case "/compact": {
        const json = await apiFetch<{ compacted: boolean; reason?: string; tokensSaved?: number; droppedMessages?: number }>(
          ctx.conn,
          "POST",
          `/sessions/${sessionId}/compact`,
        );
        if (json.compacted === true) {
          ctx.stderr(
            ctx.kit.dim(
              `— compacted: ${json.tokensSaved ?? "?"} tokens saved, ${json.droppedMessages ?? "?"} messages dropped\n`,
            ),
          );
        } else {
          ctx.stderr(ctx.kit.dim(`— ${json.reason ?? "nothing to compact"}\n`));
        }
        return;
      }
      case "/exit":
        exitRepl(0);
        return;
      default:
        ctx.stderr(ctx.kit.dim(`unknown slash command: ${command} — /help\n`));
        return;
    }
  };

  const currentAgentId = async (): Promise<string | null> => {
    const session = await apiFetch<SessionRow>(ctx.conn, "GET", `/sessions/${sessionId}`).catch(() => null);
    return session?.agentId ?? null;
  };

  const promptApproval = async (
    ask: { approvalId: string; toolName: string; argsSummary: string; category: string },
  ): Promise<"approved" | "denied" | null> => {
    return await new Promise((resolve) => {
      const inner = readline.createInterface({ input: process.stdin, output: process.stderr });
      inner.question(`  approve ${ask.toolName}? [y/N] `, (answerText: string) => {
        inner.close();
        const answer = answerText.trim().toLowerCase();
        resolve(answer === "y" || answer === "yes" ? "approved" : "denied");
      });
    });
  };

  const onLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (!closed) rl.prompt();
      return;
    }
    if (trimmed.startsWith("/")) {
      void handleSlash(trimmed).catch((err: unknown) => {
        ctx.stderr(ctx.kit.red(`${err instanceof Error ? err.message : String(err)}\n`));
        if (!closed) rl.prompt();
      });
      return;
    }
    if (inTurn) {
      ctx.stderr(ctx.kit.dim("— a turn is already running (Ctrl-C stops it)\n"));
      rl.prompt();
      return;
    }
    inTurn = true;
    void (async () => {
      const code = await runStreamedTurn(ctx, {
        sessionId,
        content: trimmed,
        ...(modelOverride !== undefined ? { model: modelOverride } : {}),
        ...(ctx.plain ? {} : { promptApproval }),
        sigintRouter: (route) => {
          turnSigint = route;
        },
      });
      if (code !== 0 && !ctx.json) {
        ctx.stderr(ctx.kit.dim(`— turn exited ${code}\n`));
      }
    })()
      .catch((err: unknown) => {
        ctx.stderr(ctx.kit.red(`${err instanceof Error ? err.message : String(err)}\n`));
      })
      .finally(() => {
        inTurn = false;
        turnSigint = null;
        if (!closed) rl.prompt();
      });
  };

  rl.on("line", onLine);
  if (!ctx.quiet && !ctx.json) {
    ctx.stderr(ctx.kit.dim("acute REPL — /help for commands, Ctrl-D or /exit to leave\n"));
  }
  rl.prompt();

  return await new Promise<number>((resolve) => {
    rl.on("close", () => {
      if (ctx.json) {
        ctx.stdout(`${JSON.stringify({ type: "cli.exit", code: replExitCode })}\n`);
      }
      resolve(replExitCode);
    });
    // A hard process exit without readline closing (spawned-sidecar
    // teardown edge) still resolves honestly instead of hanging.
    process.once("exit", () => {
      resolve(replExitCode);
    });
  });
}
