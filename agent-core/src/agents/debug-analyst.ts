/**
 * ROUND-66 (R66-2-c, the owner's C1 directive): the CONTEXT-FREE DEBUG
 * ANALYST. Debug mode no longer makes the agent self-report (the R65
 * "## DEBUG MODE" prompt section is REMOVED — an agent grading its own
 * homework had every incentive to polish). Instead, AFTER a completed turn,
 * the stream route launches a COMPLETELY NEW conversation here: this module
 * renders the session's WHOLE event log (user request, every tool call with
 * its COMPLETE result, errors) into a readable transcript, hands it to a
 * fresh model call that has no tools and no stake in the outcome, and
 * streams the analysis back to the SSE as debug-delta frames. The report is
 * persisted by the route as a `debug.report` session event (assembleHistory
 * skips the type — follow-up turns never see it, so the owner's separation
 * directive holds: a follow-up user message NEVER includes the analysis).
 */
import type Database from "better-sqlite3";
import type { ProviderKeyring } from "../providers/registry.js";
import { listSessionEvents } from "../storage/sessions.js";
import type { ChatFn, StreamChatFn } from "./chat.js";

type SqliteDatabase = Database.Database;

/** Everything the analyst needs to run (the runtime's TurnDeps shape,
 * minus the turn machinery — the analyst never touches tools). */
export interface DebugAnalystDeps {
  db: SqliteDatabase;
  keyring: ProviderKeyring;
  /** Sync fallback when chatStream is absent (one-shot, no deltas). */
  chat: ChatFn;
  /** The streaming adapter — preferred: text deltas stream live to the SSE. */
  chatStream?: StreamChatFn;
}

/**
 * The analyst's system prompt — the whole personality. ~15 lines, deliberately
 * short: the transcript is the payload, the prompt only frames the report.
 */
const DEBUG_ANALYST_SYSTEM_PROMPT = [
  "You are a DEBUG ANALYST. You did NOT participate in the conversation below and have no stake in it — you are a fresh, context-free reviewer.",
  "Given the full transcript of an agent turn (user request, every tool call with its complete result, errors), produce a plain structured report:",
  "## What the task was",
  "## Tool-by-tool trace (one line per call: tool → outcome → was the result sane?)",
  "## Failures & anomalies (failed/refused calls, unexpected outputs, retries, loops)",
  "## Did the outcome satisfy the request (honest verdict)",
  "## Recommended fixes (concrete, numbered)",
  "Raw facts, no politeness, never invent events that are not in the transcript.",
].join("\n");

/** The analyst's temperature — the repo's agent default ("default" posture:
 * no per-send thinking level, no fancy tuning; a report needs consistency). */
const DEBUG_ANALYST_TEMPERATURE = 0.2;
/** A single completion — the analyst has NO tools, so there is nothing to loop. */
const DEBUG_ANALYST_MAX_TURNS = 1;

/** Hard cap on the transcript shipped to the analyst. HEAD+TAIL split: the
 * head keeps the original request + early plan, the tail keeps the most
 * recent tool work + the final answer (recent results are where "was the
 * outcome sane" is decided — the assembleHistory RECENT_TOOL_RESULTS
 * precedent). The middle collapses to an honest omission marker. */
const MAX_TRANSCRIPT_CHARS = 60_000;
const TRANSCRIPT_HEAD_CHARS = 24_000;

/** ROUND-34 pattern: scrub keyring-held secrets from the transcript before
 * it leaves the process boundary (tool outputs can inherit ACUTE_* env
 * values). Same rule as the runtime's scrubSecrets. */
function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}

/** eventCount semantics: the number of events WALKED in the session log. */
export interface DebugTranscript {
  transcript: string;
  truncated: boolean;
  eventCount: number;
}

/**
 * Render the session's append-only event log (ADR-0010) as a READABLE,
 * model-facing transcript: USER / ASSISTANT / TOOL / ERROR / APPROVAL lines
 * in seq order. This is the owner's "WHOLE conversation history + FULL tool
 * call responses" requirement: tool outputs ride their COMPLETE persisted
 * outputSummary (the runtime already scrubbed secrets + capped each summary
 * at 4000 chars head+tail at persist time — no further stubbing here).
 *
 * Skipped event types: `debug.report` (an earlier turn's analysis must never
 * leak into a later one — the same isolation assembleHistory applies), and
 * unknown types (todo.update etc. — noise for an analyst, no content).
 *
 * HARD CAP: the joined transcript stays under MAX_TRANSCRIPT_CHARS by
 * dropping WHOLE event blocks from the middle (head and tail kept) and
 * marking the gap with `…[N events omitted]…` — truncated is reported
 * honestly so the caller can say so.
 */
export function buildDebugTranscript(db: SqliteDatabase, sessionId: string): DebugTranscript {
  const events = listSessionEvents(db, sessionId);
  const blocks: string[] = [];
  for (const event of events) {
    const block = renderEvent(event);
    if (block !== null) blocks.push(block);
  }
  const joined = blocks.join("\n");
  if (joined.length <= MAX_TRANSCRIPT_CHARS) {
    return { transcript: joined, truncated: false, eventCount: events.length };
  }
  // Over budget: keep whole blocks from the head (up to TRANSCRIPT_HEAD_CHARS)
  // and then from the tail (until the head+tail+marker fits the hard cap).
  // The marker's length estimate uses blocks.length (≥ the final omitted
  // count, so the budget is conservative) and the two "\n" separators are
  // subtracted — the assembled transcript must stay under the HARD cap.
  const marker = `…[${blocks.length} events omitted]…`;
  const budgetForBlocks = MAX_TRANSCRIPT_CHARS - marker.length - 2;
  let headText = "";
  let headCount = 0;
  while (headCount < blocks.length && headText.length + blocks[headCount].length <= TRANSCRIPT_HEAD_CHARS) {
    headText += (headCount === 0 ? "" : "\n") + blocks[headCount];
    headCount += 1;
  }
  let tailText = "";
  let tailCount = 0;
  while (
    tailCount < blocks.length - headCount &&
    headText.length + tailText.length + blocks[blocks.length - 1 - tailCount].length <= budgetForBlocks
  ) {
    tailText = blocks[blocks.length - 1 - tailCount] + (tailCount === 0 ? "" : `\n${tailText}`);
    tailCount += 1;
  }
  // Degenerate guard: neither a head block nor a tail block fits (a single
  // event block larger than the whole budget — a giant pasted user message).
  // Slice the FIRST block's head and the LAST block's tail (the same string
  // when there is only one) so the transcript is never JUST the marker and
  // the request's start + the newest content survive.
  if (headCount === 0 && tailCount === 0 && blocks.length > 0) {
    // keep = budget minus the marker and its two "\n" separators — the
    // assembled length must stay under the HARD cap exactly.
    const keep = MAX_TRANSCRIPT_CHARS - "…[transcript truncated]…".length - 2;
    const head = blocks[0].slice(0, Math.ceil(keep / 2));
    const tail = blocks[blocks.length - 1].slice(-Math.floor(keep / 2));
    return {
      transcript: `${head}\n…[transcript truncated]…\n${tail}`,
      truncated: true,
      eventCount: events.length,
    };
  }
  const omitted = blocks.length - headCount - tailCount;
  const finalMarker = `…[${omitted} events omitted]…`;
  return {
    transcript: headCount + tailCount === blocks.length
      ? joined
      : `${headText}\n${finalMarker}\n${tailText}`,
    truncated: true,
    eventCount: events.length,
  };
}

/** Render ONE event to its transcript block; null when the type is skipped. */
function renderEvent(event: {
  type: string;
  payload: unknown;
}): string | null {
  const payload: Record<string, unknown> =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  if (event.type === "message.user") {
    const content = typeof payload.content === "string" ? payload.content : "";
    const lines = [`USER: ${content}`];
    // ROUND-50 attachment shape — name lines after the user text.
    const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    for (const a of rawAttachments) {
      if (typeof a === "object" && a !== null && typeof (a as { name?: unknown }).name === "string") {
        lines.push(`[attachment: ${(a as { name: string }).name}]`);
      }
    }
    return lines.join("\n");
  }
  if (event.type === "message.assistant") {
    // Stats-carrier events (empty content + usage) carry no words — skip,
    // same rule as the runtime's asChatMessage.
    const content = typeof payload.content === "string" ? payload.content : "";
    if (content === "") return null;
    return `ASSISTANT: ${content}`;
  }
  if (event.type === "tool.use") {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
    const argsSummary = typeof payload.argsSummary === "string" ? payload.argsSummary : "";
    const ok = payload.ok === false ? false : true;
    const outputSummary = typeof payload.outputSummary === "string" ? payload.outputSummary : "";
    // FULL output — the owner's requirement. No stubbing: the per-call cap
    // already happened at persist time (summarizeToolOutput, 4000 head+tail).
    return `TOOL ${toolName}(${argsSummary}) → ${ok ? "ok" : "FAILED"}${outputSummary !== "" ? `: ${outputSummary}` : ""}`;
  }
  if (event.type === "turn.error") {
    const code = typeof payload.code === "string" ? payload.code : "ERROR";
    const message = typeof payload.message === "string" ? payload.message : "";
    // The upstream reason (providerError) is where the actual failure lives
    // (429s, timeouts, schema errors) — append it when present.
    const providerError = typeof payload.providerError === "string" ? payload.providerError : "";
    return `ERROR ${code}: ${message}${providerError !== "" ? ` — ${providerError}` : ""}`;
  }
  if (event.type === "approval.requested") {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
    return `APPROVAL ${toolName}: pending`;
  }
  if (event.type === "approval.resolved") {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
    const decision = payload.decision === "approved" || payload.decision === "denied" ? payload.decision : "expired";
    return `APPROVAL ${toolName}: ${decision}`;
  }
  // debug.report: an earlier turn's analyst output — deliberately invisible
  // (the isolation the owner asked for). Unknown types: no content to read.
  return null;
}

/** Scrub a provider error the runtime's providerErrorDetail way: the API key
 * out, then length-capped. */
function analystErrorDetail(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = apiKey !== "" ? raw.split(apiKey).join("***") : raw;
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed;
}

export type DebugAnalystResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * Run the context-free debug analyst for one session: render the transcript,
 * send it as a SINGLE fresh user message (no tools, no history of its own —
 * the model has literally nothing but the system prompt + the transcript),
 * and stream the reply out through `emit` as debug-delta frames.
 *
 * Never throws: provider failures return { ok: false, error } (scrubbed) so
 * the route can send an honest debug-error frame without breaking the turn.
 */
export async function runDebugAnalyst(
  deps: DebugAnalystDeps,
  params: {
    sessionId: string;
    /** The resolved provider triple, exactly as prepareTurn passes it to
     * the chat adapters (the streaming adapter needs baseUrl + apiFormat to
     * build the client — the route resolves it once and hands it through). */
    provider: { id: string; baseUrl: string | null; apiFormat?: string };
    apiKey: string;
    model: string;
    /** SSE frame sink (the route's send). Deltas arrive as
     * { type: "debug-delta", sessionId, delta } — the frontend's
     * stream-store keys the live debug section off its OWN session id, so
     * the frame's sessionId is informational. */
    emit: (event: unknown) => void;
  },
): Promise<DebugAnalystResult> {
  const keySecrets = deps.keyring.list().filter((v) => v.length >= 8);
  let transcript: string;
  try {
    // The transcript sees FULL tool output — scrub keyring secrets the same
    // way the runtime scrubs persisted output summaries.
    const built = buildDebugTranscript(deps.db, params.sessionId);
    transcript = scrubSecrets(built.transcript, keySecrets);
  } catch (error) {
    return { ok: false, error: `debug analyst: transcript build failed: ${String(error).slice(0, 200)}` };
  }

  const input = {
    provider: params.provider,
    apiKey: params.apiKey,
    model: params.model,
    system: DEBUG_ANALYST_SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: transcript }],
    temperature: DEBUG_ANALYST_TEMPERATURE,
    maxTurns: DEBUG_ANALYST_MAX_TURNS,
    // NO tools — the analyst observes, it never acts.
  };

  try {
    let content = "";
    if (deps.chatStream !== undefined) {
      // The streamed path — the SAME adapter invocation shape the runtime's
      // runStreamedAgentTurn uses (for-await over the normalized events);
      // only text deltas matter: they stream live AND accumulate.
      for await (const event of deps.chatStream(input)) {
        if (event.type === "text-delta") {
          content += event.delta;
          params.emit({ type: "debug-delta", sessionId: params.sessionId, delta: event.delta });
        }
      }
    } else {
      // Sync fallback (no streaming adapter in this build): one-shot call,
      // no deltas — the caller renders the final content at once.
      const result = await deps.chat(input);
      content = result.text;
    }
    if (content.trim() === "") {
      return { ok: false, error: "debug analyst: the model returned an empty report" };
    }
    return { ok: true, content };
  } catch (error) {
    return { ok: false, error: analystErrorDetail(error, params.apiKey) };
  }
}
