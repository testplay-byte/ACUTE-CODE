/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the SESSIONS command group —
 * `acute sessions ls|show|events|ctx|rm|resume|rename` over
 * GET/PATCH/DELETE /sessions…, GET /sessions/:id/context, and
 * POST /sessions/:id/compact-free reads. `resume` hands the session to the
 * REPL (the interactive continuation); everything else prints and exits.
 */
import { apiFetch } from "../api.js";
import type { CliContext, SessionRow } from "../context.js";
import { flagString } from "../flags.js";
import { trunc } from "../render/tools.js";

/** GET /sessions/:id's enriched row ({...session, events, lastSeq}). */
interface SessionDetail extends SessionRow {
  events: Array<{ seq: number; type: string; ts: string; payload: Record<string, unknown> | null }>;
  lastSeq: number;
}

/** GET /sessions/:id/context (routes/sessions.ts ROUND-83 shape). */
interface ContextReport {
  model: string;
  providerId: string;
  contextWindow: number;
  contextWindowSource: string;
  usedTokens: number;
  usedTokensBasis: string;
  breakdown: {
    systemPrompt: number;
    systemTools: number;
    memory: number;
    messages: number;
    meta: number;
    mcpTools: number;
  };
  sessionTotals: {
    inputTokens: number;
    outputTokens: number;
    providerCalls: number;
    requests: number;
    costUsd: number;
  };
}

const USAGE = `usage:
  acute sessions ls [--limit N]       recent sessions (id, title, status, updatedAt)
  acute sessions show <id>            one session + its event log
  acute sessions events <id> [--limit N]
                                      the event log tail (default 40)
  acute sessions ctx <id>             context-window usage (tokens, %)
  acute sessions rm <id>              DELETE the session (204)
  acute sessions rename <id> <title>  PATCH the session title
  acute sessions resume <id>          continue the session in the REPL`;

function limitFlag(ctx: CliContext, fallback: number): number {
  const raw = Number(flagString(ctx.flags, "limit") ?? fallback);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : fallback;
}

/** One compact event row (the acute.mjs chat:events shape). */
function eventLine(event: SessionDetail["events"][number]): string {
  const payload = event.payload;
  let brief = "";
  if (payload !== null && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.content === "string") brief = trunc(p.content.replace(/\s+/g, " "), 90);
    else if (typeof p.toolName === "string") {
      brief = `${p.toolName}(${typeof p.argsSummary === "string" ? p.argsSummary : ""}) ${
        p.ok === false ? "FAIL" : "ok"
      }`;
    } else if (typeof p.message === "string") {
      brief = trunc(`${typeof p.code === "string" ? `${p.code}: ` : ""}${p.message}`, 90);
    } else brief = trunc(JSON.stringify(p), 90);
  }
  return `${String(event.seq).padStart(4)}  ${event.type.padEnd(18)} ${brief}`;
}

export async function runSessionsCommand(ctx: CliContext, rest: readonly string[]): Promise<number> {
  const [sub, ...args] = rest;
  const positional = args.filter((a) => !a.startsWith("--"));
  const id = positional[0];

  switch (sub ?? "ls") {
    case "ls": {
      const limit = limitFlag(ctx, 20);
      const { sessions, total } = await apiFetch<{ sessions: SessionRow[]; total: number }>(
        ctx.conn,
        "GET",
        `/sessions?limit=${limit}`,
      );
      if (ctx.json) {
        ctx.stdout(`${JSON.stringify({ sessions, total })}\n`);
        return 0;
      }
      ctx.stderr(ctx.kit.dim(`${sessions.length} session(s)\n`));
      for (const s of sessions) {
        ctx.stdout(
          `${s.id}  ${trunc(s.title ?? "(untitled)", 32).padEnd(32)}  ${String(s.status).padEnd(9)}  ${s.updatedAt}\n`,
        );
      }
      return 0;
    }
    case "show": {
      if (id === undefined) {
        ctx.stderr(`${USAGE}\n`);
        return 1;
      }
      const detail = await apiFetch<SessionDetail>(ctx.conn, "GET", `/sessions/${id}`);
      if (ctx.json) {
        ctx.stdout(`${JSON.stringify(detail)}\n`);
        return 0;
      }
      ctx.stderr(
        ctx.kit.dim(
          `${detail.id} · ${detail.title ?? "(untitled)"} · ${detail.status} · ${detail.mode} · agent ${detail.agentId ?? "-"}\n`,
        ),
      );
      ctx.stderr(ctx.kit.dim(`${detail.events.length} events (lastSeq ${detail.lastSeq})\n`));
      for (const e of detail.events) ctx.stdout(`${eventLine(e)}\n`);
      return 0;
    }
    case "events": {
      if (id === undefined) {
        ctx.stderr(`${USAGE}\n`);
        return 1;
      }
      const limit = limitFlag(ctx, 40);
      const detail = await apiFetch<SessionDetail>(ctx.conn, "GET", `/sessions/${id}`);
      const tail = detail.events.slice(-limit);
      if (ctx.json) {
        ctx.stdout(`${JSON.stringify({ id: detail.id, events: tail })}\n`);
        return 0;
      }
      ctx.stderr(
        ctx.kit.dim(
          `${detail.id} · ${detail.title ?? "(untitled)"} · ${detail.status} · ${detail.events.length} events (showing last ${tail.length})\n`,
        ),
      );
      for (const e of tail) ctx.stdout(`${eventLine(e)}\n`);
      return 0;
    }
    case "ctx": {
      if (id === undefined) {
        ctx.stderr(`${USAGE}\n`);
        return 1;
      }
      const report = await apiFetch<ContextReport>(ctx.conn, "GET", `/sessions/${id}/context`);
      if (ctx.json) {
        ctx.stdout(`${JSON.stringify(report)}\n`);
        return 0;
      }
      const pct =
        report.contextWindow > 0 ? `${((report.usedTokens / report.contextWindow) * 100).toFixed(1)}%` : "?";
      ctx.stdout(
        `${report.model} (${report.providerId}) · window ${report.contextWindow.toLocaleString()} tokens\n`,
      );
      ctx.stdout(`used ${report.usedTokens.toLocaleString()} (${pct} of window · ${report.usedTokensBasis})\n`);
      const b = report.breakdown;
      ctx.stdout(
        ctx.kit.dim(
          `  system ${b.systemPrompt} · tools ${b.systemTools} · memory ${b.memory} · messages ${b.messages} · meta ${b.meta} · mcp ${b.mcpTools}\n`,
        ),
      );
      const t = report.sessionTotals;
      ctx.stdout(
        ctx.kit.dim(
          `  session: ${t.requests} requests · ${t.inputTokens} in · ${t.outputTokens} out · $${t.costUsd}\n`,
        ),
      );
      return 0;
    }
    case "rm": {
      if (id === undefined) {
        ctx.stderr(`${USAGE}\n`);
        return 1;
      }
      await apiFetch(ctx.conn, "DELETE", `/sessions/${id}`);
      if (ctx.json) {
        ctx.stdout(`${JSON.stringify({ removed: id })}\n`);
        return 0;
      }
      ctx.stdout(`removed session ${id}\n`);
      return 0;
    }
    case "rename": {
      if (id === undefined || positional.length < 2) {
        ctx.stderr("usage: acute sessions rename <id> <title>\n");
        return 1;
      }
      const title = positional.slice(1).join(" ").trim();
      if (title === "") {
        ctx.stderr("rename needs a non-empty title\n");
        return 1;
      }
      const updated = await apiFetch<SessionRow>(ctx.conn, "PATCH", `/sessions/${id}`, { title });
      if (ctx.json) {
        ctx.stdout(`${JSON.stringify(updated)}\n`);
        return 0;
      }
      ctx.stdout(`renamed ${updated.id} → ${updated.title ?? "(untitled)"}\n`);
      return 0;
    }
    case "resume": {
      if (id === undefined) {
        ctx.stderr(`${USAGE}\n`);
        return 1;
      }
      // Verify for the honest 404, then hand the session to the REPL.
      await apiFetch<SessionDetail>(ctx.conn, "GET", `/sessions/${id}`);
      const { runRepl } = await import("./repl.js");
      ctx.flags = { ...ctx.flags, session: id };
      return runRepl(ctx);
    }
    default:
      ctx.stderr(`unknown sessions subcommand: ${sub}\n${USAGE}\n`);
      return 1;
  }
}
