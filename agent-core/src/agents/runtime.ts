/**
 * Single-agent chat turn (ADR-0001 "single" mode). Round-16: the turn prep
 * is shared between the SYNC path (runSingleAgentTurn) and the STREAMED path
 * (runStreamedAgentTurn — live text deltas + tool events over SSE); both
 * persist the identical append-only event sequence (ADR-0010):
 * message.user → tool.use (one per executed call, as each completes) →
 * message.assistant (with per-reply usage+ms stats) → usage_events row.
 */
import type { MessageAttachment, SessionStatus, ThinkingLevel, UsageRecord } from "shared";
import { getAgent, TOOL_NAMES } from "../storage/agents.js";
import { getProject } from "../storage/projects.js";
import type Database from "better-sqlite3";
import {
  ProviderKeyring,
  resolveProvider,
} from "../providers/registry.js";
import { buildProjectTools, NO_TOOLS } from "../tools/index.js";
import { log, logTool, logTurnEnd, logTurnStart } from "../lib/log.js";
import {
  appendSessionEvent,
  getSession,
  lastSessionSeq,
  listSessionEvents,
  maybeAutoTitleSession,
  recordUsage,
  setSessionStatus,
  touchSession,
} from "../storage/sessions.js";
import type { ChatFn, ChatStepSnapshot, ChatTurnMessage, ChatTurnOutput, StreamChatFn } from "./chat.js";
import { buildProjectSystemPrompt, readCustomRules } from "./prompts.js";
import { listEnabledSkills } from "../storage/skills.js";
import { getComputerUseSettings } from "../storage/computer-use.js";
import { getIndexSummary } from "../storage/index.js";
// ROUND-44 (R44-a): the project memory digest for prompt injection.
import { memoryDigest } from "../storage/memory.js";
// ROUND-49: the memory master switch (Settings → Advanced).
import { getMemorySettings } from "../storage/settings.js";
import { getCatalogModel, lookupPricing } from "../storage/models.js";
import { estimateMessageTokens, type ContextBudget } from "../context.js";
// ROUND-46 (R46-b): context compaction — summarize the over-budget head
// instead of silently dropping it.
import { assembleWithCompaction, type SeqMessage } from "./compaction.js";

export type SqliteDatabase = Database.Database;

/**
 * Round-28 WS-F: read the latest todo.update snapshot from the session event
 * log. Returns true if ALL todo items are marked "completed" (vacuously true
 * if the model never called todo_write — no plan = not a completion blocker).
 * Used by the inverted continueIfUnfinished heuristic: the outer loop
 * continues UNLESS (a) explicit completion signal AND (b) all todos done.
 */
function latestTodosAllDone(db: SqliteDatabase, sessionId: string): boolean {
  const events = listSessionEvents(db, sessionId);
  // Walk backwards to find the latest todo.update.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "todo.update") {
      const todos = (ev.payload as { todos?: Array<{ status?: string }> }).todos;
      if (!Array.isArray(todos) || todos.length === 0) return true; // no plan → not a blocker
      return todos.every((t) => t.status === "completed");
    }
  }
  return true; // no todo.update event → no plan → not a blocker
}

/** Completion-signal regex (6-e inverted heuristic — phrase matching was
 * brittle; now we require BOTH the signal AND all todos done to STOP). No
 * trailing \b: the signal often ends the message, and \b after a period
 * requires a following word char (absent at end-of-string).
 * ROUND-58 (R58-c): broadened with the common final-summary phrasings
 * ("Task completed.", "The task is complete.") — the owner's Windows field
 * report had the model finish the 3-file task with a summary that matched
 * NONE of the signals, so the outer loop forced another provider call on
 * the full history and the model regurgitated the session. */
const COMPLETION_SIGNAL =
  /\b(Done\.|Task complete\.|Task completed\.|The task is complete\.|Finished\.|All set\.|All done\.)/i;

/** API.md §5.4: these session statuses refuse follow-up turns. */
const TERMINAL_STATUSES: readonly SessionStatus[] = ["completed", "failed", "cancelled"];

// ── ROUND-49: nested delegation (sub-agents may delegate too) ───────────────

/**
 * The maximum session DEPTH at which delegate_task is still offered. A main
 * session is depth 0; its children 1; grandchildren 2; great-grandchildren 3.
 * A session at depth < MAX may spawn children (so chains up to
 * MAX_DELEGATION_DEPTH levels of sub-agents exist); at/beyond the cap the
 * runtime strips delegate_task from the tool set — the recursion guard that
 * keeps the fan-out finite by construction.
 */
export const MAX_DELEGATION_DEPTH = 3;

// ── ROUND-50 (R50-c1): permission modes — the composer's switcher ────────────

/**
 * PLAN mode's read-only/research tool set (owner spec, exact): research,
 * navigation, web, todos, memory, and delegation — but NO file mutation
 * (write_file/edit_file/create_dir/delete_file), NO run_command, NO
 * index_project (it writes to the DB + walks the tree). Applied as an
 * INTERSECTION with the agent's own allowlist, so a mode never widens it.
 */
export const PLAN_MODE_TOOLS: readonly string[] = [
  "read_file",
  "list_dir",
  "search_files",
  "search_code",
  "web_search",
  "web_fetch",
  "browser_control",
  "todo_write",
  "memory_save",
  "memory_recall",
  "memory_list",
  "delegate_task",
];

/**
 * The per-mode allowlist transformation (undefined = no restriction).
 * - "ask"/"full": every tool stays (full widens the ASK-TIER GATES only,
 *   through toolDeps.permissionMode → approvals.ts).
 * - "plan": the fixed read-only set above.
 * - "editor" (owner: "It will not go with any commands or any terminals"):
 *   EVERYTHING except run_command — file tools stay auto-approved as today,
 *   delete_file keeps its current ask-tier semantics.
 */
export function modeAllowList(mode: "full" | "ask" | "plan" | "editor"): readonly string[] | undefined {
  if (mode === "plan") return PLAN_MODE_TOOLS;
  if (mode === "editor") return TOOL_NAMES.filter((t) => t !== "run_command");
  return undefined;
}

/**
 * ROUND-50 (R50-c1): the FINAL allowlist a turn on this session passes to
 * buildProjectTools — agent allowlist (ADR-0019: []/undefined = ALL) →
 * delegation-depth rules (children at the cap lose delegate_task) →
 * permission-mode intersection (plan/editor). An empty product becomes the
 * NO_TOOLS sentinel (an empty array would mean "ALL" downstream). Shared by
 * prepareTurn and the context-meter route so both agree by construction.
 */
export function sessionToolAllowList(
  session: { id: string; parentSessionId: string | null; permissionMode: "full" | "ask" | "plan" | "editor" },
  agent: { allowedTools: readonly string[] },
  /** The delegation depth of `session` (delegationDepth) — pass it when you
   * already computed it; omitted = 0 (a main session — can delegate). */
  depth?: number,
): readonly string[] | undefined {
  const isChild = session.parentSessionId !== null;
  const canDelegate = (depth ?? 0) < MAX_DELEGATION_DEPTH;
  const withoutDelegate = (list: readonly string[]): readonly string[] =>
    (list.length === 0 ? (TOOL_NAMES as readonly string[]) : list).filter(
      (t) => t !== "delegate_task",
    );
  const childAllowList: readonly string[] | undefined = isChild
    ? canDelegate
      ? agent.allowedTools
      : withoutDelegate(agent.allowedTools)
    : agent.allowedTools;
  const modeAllow = modeAllowList(session.permissionMode);
  if (modeAllow === undefined) return childAllowList;
  const base =
    childAllowList === undefined || childAllowList.length === 0
      ? (TOOL_NAMES as readonly string[])
      : childAllowList;
  const filtered = base.filter((t) => modeAllow.includes(t));
  return filtered.length > 0 ? filtered : NO_TOOLS;
}

/**
 * ROUND-50 (R50-c1): the effective tool-NAME list a turn on this session
 * would receive — sessionToolAllowList projected onto TOOL_NAMES and
 * filtered by the memory master switch (buildProjectTools drops memory_*
 * when it's off). Serves the context-meter route's "system tools" slice so
 * the donut reflects the post-mode toolset. delegate_task rides along when
 * the allowlist permits it (the keyring/chat presence buildProjectTools
 * additionally requires is true on every production call path — routes and
 * delegation both pass them).
 */
export function effectiveToolNames(
  db: SqliteDatabase,
  session: { id: string; parentSessionId: string | null; permissionMode: "full" | "ask" | "plan" | "editor" },
  agent: { allowedTools: readonly string[] },
): string[] {
  const allowList = sessionToolAllowList(session, agent, delegationDepth(db, session.id));
  const base =
    allowList === undefined || allowList.length === 0
      ? (TOOL_NAMES as readonly string[])
      : TOOL_NAMES.filter((t) => allowList.includes(t));
  const memoryEnabled = getMemorySettings(db).enabled;
  return memoryEnabled === false ? base.filter((t) => !t.startsWith("memory_")) : [...base];
}

/**
 * Walks the parent_session_id chain to count how deep a session sits
 * (main = 0). Cycle-safe (a visited set + a hard hop cap): the chain is
 * written by the orchestrator's createSession so cycles cannot occur, but a
 * corrupted/hand-edited database must never hang a turn.
 */
/**
 * ROUND-49 (the live battery find): free/cheap models intermittently answer
 * a WORK request by DESCRIBING the tool call in text ("I'll delegate this to
 * a coder agent.\n\n```python\ndelegate_task(...)```") instead of emitting a
 * real tool call — the outer loop's zero-tool-break then ends the turn with
 * nothing done (exactly the owner's "the sub-agent did not actually do the
 * work" complaint). The nudge: ONE bounded extra iteration that appends a
 * correction message ("call the tool for real") — only when the reply's text
 * EVIDENCES tool intent (mentions an actual tool name or delegation words),
 * so conversational replies (ROUND-33's "hello, how are you" lesson) still
 * break immediately.
 */
const TOOL_INTENT_NUDGE =
  "You described an action but did not call any tool. Continue now by ACTUALLY CALLING the tool(s) — a real tool call, never text, pseudo-code, or a fenced block. If you believe the task is already complete, reply with a short final summary instead.";

/** True when a zero-tool reply text mentions a real tool name or delegation
 * words — the evidence threshold for spending the one nudge. */
function toolIntentMentioned(text: string, toolNames: readonly string[]): boolean {
  const lower = text.toLowerCase();
  if (/\bsub-?agents?\b|\bdelegat/.test(lower)) return true;
  for (const name of toolNames) {
    if (name.includes("_") && lower.includes(name)) return true;
  }
  return false;
}

// ── ROUND-51 (R51-f): the loop-hygiene guard ────────────────────────────────

/**
 * ROUND-51 (R51-f, owner: "It takes up way too many steps… It should work in
 * an optimized way"): the loop-hygiene guard, ported IN SPIRIT from
 * deepseek-harness's `guard/repeat-tool-reminder` plugin (MIT © 2026 DeepSeek
 * — ideas only, no code copied; the study lives at
 * docs/research/deepseek-harness-notes.md). A model stuck in a no-progress
 * loop — re-calling the SAME tool with the SAME arguments, or hammering a
 * failing call — used to burn every remaining SDK step and every remaining
 * outer iteration (maxTurns × maxOuterLoops provider round-trips) before the
 * loop's own caps ended the turn. The guard watches the executed-call
 * sequence and acts twice:
 *
 *   1. NUDGE (advisory, deepseek-harness's core idea): when one exact call
 *      repeats REPEAT_NUDGE times consecutively, a user-role correction
 *      message rides the NEXT outer iteration's in-memory message list
 *      (the same machinery as ROUND-49's TOOL_INTENT_NUDGE — never
 *      persisted; it is a machine correction, not a chat turn).
 *   2. STOP (our hard divergence — their guard is advisory-only, our owner
 *      explicitly asked for step efficiency): when the streak reaches
 *      REPEAT_STOP, or MAX_CONSECUTIVE_FAILURES calls fail in a row (any
 *      args — a model hammering a denied/failing call is exactly the loop
 *      worth breaking), the turn ends honestly: persisted turn.error event
 *      (R42/R43 rule — LOUD, persisted, retryable) + a 502 envelope with
 *      code LOOP_GUARD. NOT a throw; partial work is already persisted.
 *
 * Scope: PER-TURN (fresh per runSingleAgentTurn / runStreamedAgentTurn — a
 * new user message is a fresh context, matching their per-agent reset on
 * user interjection). The streak resets when a call DIFFERS (name or
 * canonical args); the failure counter resets on ANY successful call.
 *
 * Observability (v1 choice): the existing logger carries the firing
 * (loop_guard.nudge / loop_guard.stop lines — name + argsSummary only, never
 * outputs/secrets) and the turn result note + persisted turn.error make it
 * visible in the transcript. No new SSE event types were invented — the
 * streamed path's normal error frame ({type:'error'} with code LOOP_GUARD,
 * which TurnErrorCard renders) closes the live stream honestly.
 */

/** ROUND-51 (R51-f): consecutive identical calls before the nudge message
 * (deepseek-harness's first threshold — 3 in their defaults [3, 5, 8] too). */
export const REPEAT_NUDGE = 3;

/** ROUND-51 (R51-f): consecutive identical calls before the honest STOP
 * (their guard only reminds; our owner's directive needs a hard floor). */
export const REPEAT_STOP = 5;

/** ROUND-51 (R51-f): consecutive FAILED calls (any args) before the honest
 * STOP — catches hammering loops their exact-match chain alone would miss
 * (e.g. read_file a, read_file b, read_file c … all failing). */
export const MAX_CONSECUTIVE_FAILURES = 6;

/** Deep key-sort so two argument objects that differ only in property order
 * canonicalize identically (the deepseek-harness guard's exact-match rule —
 * `sortJsonValue` + `canonicalize` there). Pure; no cycles can arrive from
 * JSON-parsed args, but the caller may hand us anything, so the stringify is
 * guarded anyway. */
function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * ROUND-51 (R51-f): the canonical identity of a call's arguments. Our chat
 * adapters expose the compact `argsSummary` STRING (chat.ts is outside this
 * round's ownership), so strings pass through verbatim — identical raw args
 * always produce an identical summary. Objects (possible from future
 * adapters / direct onToolCall use) get the stable key-sort + stringify, and
 * anything unstringifiable degrades to String(args) instead of throwing.
 * Honest v1 limitation: two DIFFERENT calls can share a summary (two same-
 * length `content` bodies both render "content: 100 chars") — a rare false
 * positive that only ever produces a nudge/stop the model can answer by
 * changing arguments, and the honest fix (threading raw args through
 * ChatToolCall) belongs to a future chat.ts round.
 */
export function canonicalToolArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    const stringified = JSON.stringify(sortJsonKeys(args));
    return stringified ?? String(args);
  } catch {
    return String(args);
  }
}

/** ROUND-51 (R51-f): one guard verdict per executed tool call. */
export interface LoopGuardAction {
  action: "continue" | "nudge" | "stop";
  /** present on "nudge" — the ready-to-inject user-role message. */
  nudge?: string;
  /** present on "stop" — the honest end-of-turn message (also the log line
   * and the persisted turn.error message). */
  reason?: string;
}

/** ROUND-51 (R51-f): the pure, per-turn guard (see the section comment). */
export interface LoopGuard {
  onToolCall(toolName: string, args: unknown, ok: boolean): LoopGuardAction;
}

/**
 * ROUND-51 (R51-f): create a fresh per-turn guard. Pure state machine — no
 * DB, no clock, no I/O — so tests hit the thresholds directly and both turn
 * paths (sync + streamed) share one implementation.
 */
export function createLoopGuard(): LoopGuard {
  let lastKey: string | null = null;
  let repeatStreak = 0;
  let consecutiveFailures = 0;
  let nudgedThisStreak = false;
  let stopReason: string | null = null;

  return {
    onToolCall(toolName: string, args: unknown, ok: boolean): LoopGuardAction {
      // Once stopped, stay stopped — a caller that keeps feeding (it
      // shouldn't; both paths break immediately) never re-arms the guard.
      if (stopReason !== null) return { action: "stop", reason: stopReason };

      const key = `${toolName}\u0000${canonicalToolArgs(args)}`;
      if (key === lastKey) {
        repeatStreak += 1;
      } else {
        lastKey = key;
        repeatStreak = 1;
        nudgedThisStreak = false;
      }
      // Any successful call clears the failure run; failures of ANY args
      // (identical or not) accumulate.
      consecutiveFailures = ok ? 0 : consecutiveFailures + 1;

      if (repeatStreak >= REPEAT_STOP) {
        stopReason = `Loop guard: stopped after ${repeatStreak} identical consecutive calls to ${toolName} — likely a no-progress loop.`;
        return { action: "stop", reason: stopReason };
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `Loop guard: stopped after ${consecutiveFailures} consecutive failed tool calls (last: ${toolName}) — likely a no-progress loop.`;
        return { action: "stop", reason: stopReason };
      }
      // One nudge per streak: at 3 the model gets the correction; if it
      // ignores it and keeps repeating, the STOP at 5 ends the turn — no
      // reminder spam in between (their [3, 5, 8] re-reminds; we escalate).
      if (!nudgedThisStreak && repeatStreak >= REPEAT_NUDGE) {
        nudgedThisStreak = true;
        return {
          action: "nudge",
          nudge:
            `You have called ${toolName} with identical arguments ${repeatStreak} times in a row with no progress. ` +
            "Stop repeating: re-read the last result, change your approach, or ask the owner. " +
            "If the task is genuinely complete, finish with your summary.",
        };
      }
      return { action: "continue" };
    },
  };
}

export function delegationDepth(db: SqliteDatabase, sessionId: string): number {
  let depth = 0;
  let cursor: string | null = sessionId;
  const seen = new Set<string>([sessionId]);
  const MAX_HOPS = 32;
  while (cursor !== null && depth <= MAX_HOPS) {
    const row = getSession(db, cursor);
    if (row === undefined || row.parentSessionId === null) break;
    if (seen.has(row.parentSessionId)) break;
    seen.add(row.parentSessionId);
    depth += 1;
    cursor = row.parentSessionId;
  }
  return depth;
}

export interface AssistantMessage {
  seq: number;
  role: "assistant";
  agentId: string;
  content: string;
  ts: string;
}

export type TurnOutcome =
  | { ok: true; assistantMessage: AssistantMessage; usage: UsageRecord }
  | {
      ok: false;
      status: 404 | 409 | 499 | 502;
      /** ROUND-42: ABORTED = the user explicitly stopped the stream.
       * ROUND-47: PROVIDER_DISABLED = the provider row is enabled=false.
       * ROUND-51 (R51-f): LOOP_GUARD = the loop-hygiene guard ended a
       * no-progress turn (identical-call streak or consecutive failures).
       * Carries status 502 so the streamed route's `status >= 500` rule
       * fires the honest task_failed notification — the task did NOT
       * complete; the provider itself did not fail either. */
      code: "NOT_FOUND" | "CONFLICT" | "ABORTED" | "PROVIDER_ERROR" | "PROVIDER_DISABLED" | "LOOP_GUARD";
      message: string;
      details?: Record<string, unknown>;
    };

export interface TurnDeps {
  db: SqliteDatabase;
  keyring: ProviderKeyring;
  chat: ChatFn;
  /** Streaming adapter (round-16); the streamed turn refuses without one. */
  chatStream?: StreamChatFn;
}

/** Narrows an event payload back to the {role, content} chat shape we write.
 * ROUND-50 (R50-c1): message.user payloads may carry `attachments` — the
 * validated send-route list; they ride along for assembleHistory's rendering. */
function asChatMessage(
  event: { type: string; payload: unknown },
): (ChatTurnMessage & { attachments?: MessageAttachment[] }) | undefined {
  if (event.type !== "message.user" && event.type !== "message.assistant") return undefined;
  if (typeof event.payload !== "object" || event.payload === null) return undefined;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.content !== "string") return undefined;
  // ROUND-35 (review fix #3): thinking-only / stats-carrier segments have
  // empty content — sending {role:"assistant", content:""} makes
  // Anthropic-protocol endpoints 400. Skip them for history.
  if (event.type === "message.assistant" && payload.content === "") return undefined;
  // ROUND-50 (R50-c1): tolerate older rows / hand-written payloads — only a
  // well-formed array of {name} objects counts as attachments.
  const rawAttachments = payload.attachments;
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments.filter(
        (a): a is MessageAttachment =>
          typeof a === "object" && a !== null && typeof (a as { name?: unknown }).name === "string",
      )
    : undefined;
  return {
    role: event.type === "message.user" ? "user" : "assistant",
    content: payload.content,
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * ROUND-50 (R50-c1): render a message.user event's attachments into the
 * model-facing content AFTER the user text. The RAW event payload stays
 * clean ({role, content, attachments}) — this block exists only in the
 * model-facing history, so the display never shows it. Binary/unreadable
 * attachments (text: null) render a one-line placeholder instead.
 */
function renderAttachments(content: string, attachments: readonly MessageAttachment[]): string {
  let out = content;
  for (const a of attachments) {
    out +=
      typeof a.text === "string" && a.text !== ""
        ? `\n\n--- attached file: ${a.name} ---\n${a.text}\n--- end of ${a.name} ---`
        : `\n\n--- attached file: ${a.name} (no readable text) ---`;
  }
  return out;
}

/**
 * ROUND-34 (review fix #2/#3): scrub keyring-held secrets from tool output
 * BEFORE persisting AND before emitting over SSE — one helper, both paths.
 */
function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * ROUND-34 (Cline-pattern tool feedback): fold the append-only event log into
 * a model-facing conversation that INCLUDES tool results — the fix for
 * multi-step tasks. Event order is user → tool.use×N → assistant, so the
 * model previously saw its own replies but never what its tools returned;
 * outer-loop iteration 2+ would re-plan blind (or repeat work). Now the
 * history carries a <tool_results> block after each assistant turn. The
 * markers keep tool output as DATA, never instructions (injection guard);
 * old events without an outputSummary still fold (ok flag only).
 *
 * ROUND-46 (R46-b): every message is annotated with the seq of the LAST
 * event that contributed to it (message events carry their own seq; a
 * tool_results block carries the seq of the final tool.use folded into
 * it) — the compaction filter needs seq anchors, and revert/fork inherit
 * compaction events for free because assembly stays pure.
 */
/**
 * ROUND-58 (R58-c, owner: "after completing the task it started to
 * hallucinate… it copied and pasted the whole session"): history replay
 * capping. Every outer-loop iteration re-sends the ENTIRE event log to the
 * provider, and every tool.use line carried up to 4000 chars of raw tool
 * output inside a USER-role <tool_results> block — on a long multi-tool
 * session that is tens of KB of stale output the model was invited to echo
 * back (weak/free models regurgitate giant user blobs verbatim). The fix:
 * only the last RECENT_TOOL_RESULTS calls keep their full output summary;
 * older ones collapse to a short stub (name + args + ok + the first
 * OLD_TOOL_STUB_CHARS of output), and each replayed <tool_results> block is
 * bounded to MAX_TOOL_BLOCK_CHARS total (stubbing from the OLDEST lines
 * first — recent results stay full). Fidelity where it matters (the model
 * just used these), compaction where it doesn't.
 */
const RECENT_TOOL_RESULTS = 8;
const OLD_TOOL_STUB_CHARS = 200;
const MAX_TOOL_BLOCK_CHARS = 48_000;

export function assembleHistory(db: SqliteDatabase, sessionId: string): SeqMessage[] {
  const events = listSessionEvents(db, sessionId);
  const messages: SeqMessage[] = [];
  let pendingToolLines: string[] = [];
  let pendingToolSeq = 0;
  // ROUND-58 (R58-c): seqs of the last RECENT_TOOL_RESULTS tool.use events —
  // these keep full output summaries in the replay; everything older stubs.
  const toolUseSeqs: number[] = [];
  for (const ev of events) {
    if (ev.type === "tool.use") toolUseSeqs.push(ev.seq);
  }
  const recentToolSeqs = new Set(toolUseSeqs.slice(-RECENT_TOOL_RESULTS));

  const flushTools = () => {
    if (pendingToolLines.length === 0) return;
    // ROUND-58 (R58-c): bound the block — stub from the OLDEST lines first
    // until the joined block is under MAX_TOOL_BLOCK_CHARS.
    let text = pendingToolLines.join("\n");
    for (let i = 0; i < pendingToolLines.length && text.length > MAX_TOOL_BLOCK_CHARS; i++) {
      if (pendingToolLines[i].length > OLD_TOOL_STUB_CHARS) {
        pendingToolLines[i] = `${pendingToolLines[i].slice(0, OLD_TOOL_STUB_CHARS)}…[older result truncated]`;
      }
      text = pendingToolLines.join("\n");
    }
    messages.push({
      role: "user",
      content: `<tool_results>\n${text}\n</tool_results>`,
      throughSeq: pendingToolSeq,
    });
    pendingToolLines = [];
    pendingToolSeq = 0;
  };

  for (const event of events) {
    if (event.type === "message.user" || event.type === "message.assistant") {
      flushTools();
      const msg = asChatMessage(event);
      if (msg)
        messages.push({
          role: msg.role,
          // ROUND-50 (R50-c1): user attachments render into the model-facing
          // content here (assistant events never carry them).
          content:
            msg.role === "user" && msg.attachments !== undefined
              ? renderAttachments(msg.content, msg.attachments)
              : msg.content,
          throughSeq: event.seq,
        });
    } else if (event.type === "tool.use") {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
      const argsSummary = typeof payload.argsSummary === "string" ? payload.argsSummary : "";
      const ok = payload.ok === false ? false : true;
      const outputSummary =
        typeof payload.outputSummary === "string" && payload.outputSummary.length > 0
          ? payload.outputSummary
          : null;
      // Review fix #7 (R37 review M2: the original replace was a no-op —
      // "\/" in a JS string literal is just "/"): neutralize the closing
      // marker inside tool output so injected content can't escape the
      // <tool_results> data block. A zero-width joiner breaks the sequence
      // without changing what the model reads.
      const safeOutput = outputSummary?.replace(
        /<\/tool_results>/g,
        "<\u200b/tool_results>",
      );
      let line =
        `${toolName}(${argsSummary}) → ${ok ? "ok" : "FAILED"}${safeOutput ? `: ${safeOutput}` : ""}`;
      // ROUND-58 (R58-c): older tool results stub to OLD_TOOL_STUB_CHARS —
      // see the assembleHistory section comment. The RECENT set keeps full
      // fidelity (the model is actively working with those).
      if (!recentToolSeqs.has(event.seq) && line.length > OLD_TOOL_STUB_CHARS) {
        line = `${line.slice(0, OLD_TOOL_STUB_CHARS)}…[older result truncated]`;
      }
      pendingToolLines.push(line);
      pendingToolSeq = event.seq;
    }
  }
  flushTools();
  return messages;
}

/** Error text for a 502 envelope — scrubbed of the API key, then length-capped. */
function providerErrorDetail(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw.split(apiKey).join("***");
  return scrubbed.length > 500 ? `${scrubbed.slice(0, 500)}…` : scrubbed;
}

/**
 * ROUND-43 (owner: "if for some reason our model failed to get a response…
 * it just outright silently dies… I only see the message which I sent and
 * below it I don't see anything else at all"). ROOT CAUSE: a failed turn
 * persisted ONLY the user message — the provider error lived in the 502
 * envelope + a task_failed notification row, never in the session's event
 * timeline, so a reload showed a conversation that ends at the user bubble
 * forever. This helper appends a `turn.error` event (the type
 * listSubAgents already reads) carrying the reason, model, provider, and the
 * failed turn's user-message seq, and returns the session to `queued` so the
 * turn stays retryable (and the boot sweep doesn't flip it to `failed`).
 * Deliberate user stops (ABORTED) never call this — a stop is not an error.
 */
function persistTurnError(
  db: SqliteDatabase,
  args: {
    sessionId: string;
    agentId: string;
    userSeq: number;
    code: string;
    message: string;
    model: string;
    providerId: string;
    providerError: string;
    keySecrets: readonly string[];
  },
): string {
  const event = appendSessionEvent(db, args.sessionId, {
    type: "turn.error",
    agentId: args.agentId,
    payload: {
      code: args.code,
      message: args.message,
      model: args.model,
      providerId: args.providerId,
      providerError: scrubSecrets(args.providerError, args.keySecrets),
      userSeq: args.userSeq,
    },
  });
  // The turn is over (not mid-flight) — `queued` keeps the session open for
  // a retry and out of sweepStaleRunning's crash path at the next boot.
  if (getSession(db, args.sessionId)?.status === "running") {
    setSessionStatus(db, args.sessionId, "queued");
  }
  return event.ts;
}

/** Everything a turn needs after validation (shared by sync + streamed). */
interface PreparedTurn {
  session: NonNullable<ReturnType<typeof getSession>>;
  agent: NonNullable<ReturnType<typeof getAgent>>;
  provider: { id: string; baseUrl: string; apiFormat?: string };
  apiKey: string;
  model: string;
  tools: Awaited<ReturnType<typeof buildProjectTools>> | undefined;
  system: string;
  /** ROUND-50 (R50-c1): the per-send thinking level, threaded to the chat
   * adapters (chat.ts buildModel). Not persisted. */
  thinkingLevel?: ThinkingLevel;
}

/** Shared pre-flight: validation, provider/key resolution, tools, system,
 * history. modelOverride lets one call use a different model than the
 * agent's default (the chat UI's per-send model picker). */
async function prepareTurn(
  db: SqliteDatabase,
  keyring: ProviderKeyring,
  sessionId: string,
  modelOverride?: string,
  /** ROUND-36: the chat fn (delegate_task spawns child turns through it). */
  chatForTools?: ChatFn,
  /** ROUND-50 (R50-b, owner: the sub-agent panel must stream "the actual raw
   * data, the raw thinking, the raw text of it… just like the main agent"):
   * the STREAMING adapter. The streamed turn passes its deps.chatStream here
   * so toolDeps carries it — the delegate_task tool then hands it to the
   * orchestrator, and delegated children run runStreamedAgentTurn (live
   * text/thinking deltas + tool events through the subagent-event envelope)
   * instead of the sync step-snapshot path. Absent on the plain sync route —
   * sync parents keep spawning sync children (fail-fast ask semantics for
   * channel-less runs are unchanged, see the ROUND-48 comments below). */
  chatStreamForTools?: StreamChatFn,
  /** ROUND-36 (streamed turns): forward live subagent-status events to SSE.
   * ROUND-48 (R48-e1): also passed by the SYNC path for emitted sub-agent
   * children (the orchestrator's wrappedEmit) — see interactiveApprovals. */
  emitForTools?: (event: unknown) => void,
  /** ROUND-37 (approvals): the live turn's abort signal — pending approvals
   * deny on abort. ROUND-48 (R48-e1): now also forwarded by the sync path
   * for sub-agent children (the parent's stop propagates to the child). */
  signalForTools?: AbortSignal,
  /** ROUND-50 (R50-c1): the composer's per-send thinking level. Returned on
   * PreparedTurn for the turn runners to hand to the chat adapters. */
  thinkingLevel?: ThinkingLevel,
): Promise<PreparedTurn | { error: Extract<TurnOutcome, { ok: false }> }> {
  const session = getSession(db, sessionId);
  if (session === undefined) {
    return { error: { ok: false, status: 404, code: "NOT_FOUND", message: `no session with id ${sessionId}` } };
  }
  if (TERMINAL_STATUSES.includes(session.status)) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `session ${sessionId} is ${session.status} and no longer accepts messages`,
      },
    };
  }
  if (session.agentId === null) {
    return { error: { ok: false, status: 409, code: "CONFLICT", message: `session ${sessionId} has no bound agent` } };
  }
  const agent = getAgent(db, session.agentId);
  if (agent === undefined) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `session agent ${session.agentId} no longer exists`,
      },
    };
  }
  if (agent.providerId === null || agent.model === null) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `agent '${agent.name}' has no providerId/model configured`,
        details: { agentId: agent.id, field: "providerId" },
      },
    };
  }
  const provider = resolveProvider(db, agent.providerId);
  if (provider === undefined || provider.baseUrl === null) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `agent '${agent.name}' references provider '${agent.providerId}' without a usable baseUrl`,
        details: { agentId: agent.id, providerId: agent.providerId },
      },
    };
  }
  // ROUND-47 (R47-b): honor provider.enabled at turn time. Disabling a
  // provider in Settings is an explicit owner choice (pull a misbehaving
  // key/endpoint out of rotation); a turn must NOT silently run against it
  // anyway. Same prepareTurn error path as the missing-key 409 below — no
  // user event is appended, so the session stays clean and the retry after
  // re-enabling starts from scratch. The UI renders the honest error card
  // from the 409 envelope (the streamed path emits it as {type:'error'}).
  if (provider.enabled === false) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "PROVIDER_DISABLED",
        message: `Provider '${provider.name}' is disabled — enable it in Settings → Models & Providers`,
        details: { providerId: provider.id },
      },
    };
  }
  const apiKey = keyring.get(provider.id);
  if (apiKey === undefined) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message:
          `no API key for provider '${provider.id}' — set ${ProviderKeyring.envVarName(provider.id)} ` +
          "in the sidecar environment",
        details: { providerId: provider.id },
      },
    };
  }
  const project = session.projectId !== null ? getProject(db, session.projectId) : undefined;
  if (session.projectId !== null && project === undefined) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `session ${sessionId} references missing project ${session.projectId}`,
      },
    };
  }
  // Tools: the project set, intersected with the agent's allowlist when one
  // is set (ADR-0019). Empty/omitted allowlist = ALL tools (the default
  // agents rely on this; an explicit non-empty list is a real restriction).
  //
  // round-27 fix: the `deps` arg (db/sessionId/agentId/seq) was NEVER passed
  // before — so todo_write returned "todo tracking unavailable" and the
  // write_file/edit_file/delete_file snapshot recording (checkpoints) were
  // silently dead in real turns while the tools existed on paper. Now wired
  // so todos persist + every mutating tool records a revertible snapshot.
  // ROUND-49 (owner directives: sub-agents are "exactly like how the main
  // agent works — the ONLY difference is the separate context and API keys",
  // and "that same session should not be used for the sub-agents either"):
  //
  //  NESTED DELEGATION. A session at depth d (main = 0, child of main = 1,
  //  grandchild = 2, …) may keep spawning sub-agents while d <
  //  MAX_DELEGATION_DEPTH — a sub-agent can itself delegate, exactly like the
  //  main agent. At/beyond the cap delegate_task is stripped from the tool
  // set (the recursion guard — depth is bounded by construction, so the
  // fan-out can never cycle or run away).
  //
  //  CONTEXT ISOLATION. Sub-agent children NEVER receive the project memory
  // digest in their system prompt — their context is the delegated task text
  // alone (plus project facts like the codebase index). Stale memories were
  // actively poisoning sub-agent turns with wrong "you have no file tools"
  // beliefs; the digest now flows ONLY into main-session turns, and only
  // when the memory master switch (Settings → Advanced) is on.
  const isChild = session.parentSessionId !== null;
  const memoryEnabled = getMemorySettings(db).enabled;
  // ROUND-50 (R50-c1): the depth feeds the shared sessionToolAllowList
  // helper below (children at/beyond the delegation cap lose delegate_task).
  const depth = delegationDepth(db, session.id);
  const turnSeq = lastSessionSeq(db, session.id) + 1;
  // ROUND-50 (R50-c1): the session's permission mode (migration 0020; the
  // composer's switcher). Sub-agent children copied their parent's mode at
  // delegation (orchestrator.ts), so the same enforcement applies to them
  // through this exact path — no extra wiring.
  const permissionMode = session.permissionMode;
  // ROUND-36 (ADR-0022): keyring + chat let the delegate_task tool spawn
  // child turns; `emit` is added per-path (the streamed turn forwards live
  // subagent-status events onto its SSE).
  const toolDeps = {
    db,
    sessionId: session.id,
    agentId: agent.id,
    seq: turnSeq,
    projectId: session.projectId ?? undefined,
    keyring,
    ...(chatForTools !== undefined ? { chat: chatForTools } : {}),
    // ROUND-50 (R50-b): the streaming adapter rides the same deps object so
    // delegate_task can hand it to the orchestrator — children delegated from
    // a STREAMED parent turn then stream live (see chatStreamForTools above).
    ...(chatStreamForTools !== undefined ? { chatStream: chatStreamForTools } : {}),
    ...(emitForTools !== undefined ? { emit: emitForTools } : {}),
    // ROUND-48 (R48-e1, owner: "sub-agents … they should be an almost exact
    // copy of the main agent — same functioning, same workings, only
    // different context… they will have tool access and can ask for
    // permission"): interactive = an emit channel EXISTS. Previously
    // `emitForTools !== undefined && session.parentSessionId === null` —
    // sub-agent children were ALWAYS non-interactive because the
    // orchestrator never forwarded its wrappedEmit into prepareTurn, so
    // every ask-tier approval (non-auto commands, web_fetch/
    // browser_control to non-allowlisted hosts) failed FAST with a deny
    // note instead of asking the owner. A child WITH an emit channel
    // (delegateTask from a live streamed parent turn) is now interactive:
    // its approval.requested/resolved events ride the parent's SSE as
    // `subagent-event` envelopes (the orchestrator's wrappedEmit wraps
    // them) and the existing decision route resolves the child's waiter.
    // Channel-less runs (the plain sync route POST /sessions/:id/messages,
    // retryChild without emit) STILL fail fast — no UI channel to ask on,
    // same security posture as ROUND-37. The ask-tier RULES themselves are
    // unchanged: nobody bypasses allowlists; children can now ASK, the
    // owner decides.
    interactiveApprovals: emitForTools !== undefined,
    ...(signalForTools !== undefined ? { signal: signalForTools } : {}),
    appendEvent: (event: {
      type: "approval.requested" | "approval.resolved";
      agentId: string;
      payload: Record<string, unknown>;
    }) => {
      appendSessionEvent(db, session.id, event);
    },
    // ROUND-49: the memory master switch rides the deps so buildProjectTools
    // can drop the memory_* tools entirely when the system is off.
    memoryEnabled,
    // ROUND-50 (R50-c1): the permission mode rides the deps so the approval
    // gates can widen ("full" auto-approves ask-tier decisions; the
    // denylist-supreme refusals stay hard in every mode — approvals.ts).
    permissionMode,
    // ROUND-61 (R61): the turn's main model for the computer-use vision
    // relay ("main" mode = describe screenshots with THIS model when its
    // row supports vision). providerId/model are resolved above (override
    // or agent defaults) — both non-null by the gate earlier in prepareTurn.
    mainModel: {
      providerId: agent.providerId,
      modelId: modelOverride && modelOverride.trim() !== "" ? modelOverride.trim() : agent.model,
    },
  };
  // ROUND-40 → ROUND-49 (owner: "sub-agents … exactly like how the main agent
  // works. Everything about it should be the same — the only difference is
  // the separate context and API keys"). History: ROUND-40 fixed the
  // ["__none__"] sentinel that stripped EVERY tool from children (the
  // default "Acute" agent ships with allowedTools=[] which per ADR-0019
  // means "ALL tools"). ROUND-49 goes further: children BELOW the delegation
  // depth cap now keep delegate_task too (nested sub-agents); only sessions
  // at/beyond MAX_DELEGATION_DEPTH have it stripped (the recursion guard).
  // The `[]`-allowlist path passes the agent list through UNCHANGED so an
  // empty list keeps meaning "ALL tools, including delegation".
  //
  // ROUND-50 (R50-c1): PERMISSION-MODE TOOL RESTRICTION — the shared
  // sessionToolAllowList helper intersects the (post-allowlist,
  // post-delegation-depth) list with the mode's set:
  //   plan   → PLAN_MODE_TOOLS (read-only/research);
  //   editor → everything except run_command (owner: no terminals);
  //   ask/full → no restriction (full widens the ask-tier GATES only).
  // The intersection can only NARROW (a mode never widens the agent's own
  // allowlist), and an EMPTY product must mean "no tools" — buildProjectTools
  // treats []/undefined as ALL (ADR-0019), so the NO_TOOLS sentinel carries
  // the empty case (tools/index.ts).
  const allowListWithMode = sessionToolAllowList(session, agent, depth);
  const tools =
    project !== undefined
      ? await buildProjectTools(project.rootPath, allowListWithMode, toolDeps)
      : undefined;
  // ROUND-40: the system prompt's toolNames must reflect the EXACT tool set the
  // model will actually receive. The old code rebuilt tools from
  // `agent.allowedTools` here — for a child that lied in two ways: (a) it
  // included delegate_task (children don't get it), and (b) for the default
  // agent ([] = ALL) it would have listed delegate_task too. Reuse the already-
  // built `tools` object so the prompt and the live toolset are always in sync.
  const system = project
    ? buildProjectSystemPrompt({
        projectName: project.name,
        rootPath: project.rootPath,
        toolNames: tools ? Object.keys(tools) : [],
        customRules: readCustomRules(project.rootPath),
        // Round-28 WS-F: inject the agent's maxTurns budget into the AGENTIC
        // LOOP section so the model knows how many tool round-trips it has.
        maxTurns: agent.maxTurns,
        // Round-28 WS-G: inject the codebase index summary (if the project
        // has been indexed) so the agent has codebase awareness without
        // needing list_dir + read_file every turn.
        indexSummary: session.projectId !== null ? getIndexSummary(db, session.projectId) ?? undefined : undefined,
        // ROUND-44 (R44-a) → ROUND-49: inject the newest project memories so
        // the agent starts every turn knowing the project's durable
        // knowledge — but ONLY in MAIN sessions while the memory master
        // switch is on. Sub-agent children run with independent context (no
        // digest), and a disabled memory system injects nothing anywhere.
        // Empty digest (no memories yet) → undefined → no prompt section.
        memoryDigest:
          memoryEnabled && !isChild && session.projectId !== null
            ? memoryDigest(db, session.projectId) || undefined
            : undefined,
        // ROUND-50 (R50-c1): narrate the active permission mode (full/plan/
        // editor; "ask" stays silent — the default posture is already
        // narrated by the TERMINAL/WEB ACCESS sections). The toolNames list
        // above already reflects the post-mode tool set (the tools object
        // was built from the mode-filtered allowlist).
        permissionMode,
        // ROUND-61 (R61): the enabled-skills index (progressive disclosure —
        // names + one-liners; bodies load via read_skill) and the
        // computer-use master-switch state (the always-on discipline
        // section rides the tools that are already in toolNames — the
        // plugin only registers them when the switch is on).
        skills: listEnabledSkills(db).map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
        computerUse: (() => {
          const cu = getComputerUseSettings(db);
          return { enabled: cu.enabled, posture: cu.permission };
        })(),
      })
    : agent.systemPrompt;
  return {
    session,
    agent,
    // ROUND-37: apiFormat rides along so chat.ts can branch per provider
    // (chat-completions | anthropic-messages | responses).
    provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
    apiKey,
    model: modelOverride && modelOverride.trim() !== "" ? modelOverride.trim() : agent.model,
    tools,
    system,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}

export async function runSingleAgentTurn(
  deps: TurnDeps,
  sessionId: string,
  content: string,
  modelOverride?: string,
  /** ROUND-40: optional live-event forwarder. When set (the orchestrator
   * passes a wrapped emit for sub-agent children), the sync loop forwards
   * each tool-call / tool-result / text / continuation event to it so the
   * parent's UI can watch the child work in real time — parity with the
   * streamed main-agent path. Absent on the plain sync route. */
  emit?: (event: unknown) => void,
  /** ROUND-48 (R48-e1): the parent turn's abort signal — the child's pending
   * approvals deny on abort (fail-closed) and the outer loop stops BETWEEN
   * iterations with an honest ABORTED outcome (mirroring the streamed
   * path's stop semantics; a stop is not an error, so no turn.error is
   * persisted). Absent on the plain sync route. */
  signal?: AbortSignal,
  /** ROUND-50 (R50-c1): the composer's per-send thinking level — threaded
   * to the chat adapter (chat-completions reasoning.effort). NOT persisted;
   * sub-agents never inherit it (the orchestrator calls without it). */
  thinkingLevel?: ThinkingLevel,
  /** ROUND-50 (R50-c1): the send's attachments — persisted on the
   * message.user event payload (alongside role/content) and rendered into
   * the model-facing history by assembleHistory. */
  attachments?: MessageAttachment[],
): Promise<TurnOutcome> {
  const { db, keyring, chat } = deps;
  // ROUND-48 (R48-e1): forward emit AND signal into the turn prep so the
  // child's toolDeps carries both — interactiveApprovals becomes true for
  // emitted children (the owner's "sub-agents can ask for permission") and
  // run_command/web_fetch/browser_control ask-tiers wait on the owner's
  // decision instead of failing fast.
  // ROUND-50 (R50-b): NO chatStream on the sync path — a sync turn's children
  // stay sync (the orchestrator's fallback branch), preserving the exact
  // pre-R50-b behavior for channel-less runs.
  const prepared = await prepareTurn(
    db,
    keyring,
    sessionId,
    modelOverride,
    chat,
    undefined,
    emit,
    signal,
    thinkingLevel,
  );
  if ("error" in prepared) return prepared.error;
  const { session, agent, provider, apiKey, model, tools, system } = prepared;
  const syncStartedAt = Date.now();
  logTurnStart(session.id, agent.id, model, false);

  // First message flips a queued session to running (API.md §5 semantics).
  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  const userEvent = appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    // ROUND-50 (R50-c1): attachments ride the raw payload (display data);
    // assembleHistory renders them into the model-facing content.
    payload: {
      role: "user",
      content,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    },
  });

  const keySecrets = keyring.list();

  // ROUND-39 (owner: "sub-agents were only able to respond one time and they
  // were not able to perform complex tasks like multi-stage tasks like the
  // main agent could"). The sync path (used by the orchestrator for
  // sub-agents) previously did ONE chat() call — which CAN iterate up to
  // maxTurns tool round-trips internally, but had NO outer loop to continue
  // beyond a single chat completion. The streamed path (main agent) has an
  // outer loop up to maxOuterLoops. We mirror that here so sub-agents get
  // full multi-round parity: each iteration can do up to maxTurns tool
  // round-trips; if the model keeps calling tools, the outer loop kicks off
  // another iteration with the accumulated history (tool results included).
  const maxOuterLoops = agent.maxOuterLoops ?? 5;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // ROUND-50 (R50-c1): cached prompt tokens, accumulated per provider call
  // into the turn's single usage_events row (context-meter cache hit rate).
  let totalCachedInputTokens = 0;
  let lastAssistantEvent: { seq: number; ts: string; content: string } | null = null;
  let lastError: { ok: false; status: 502; code: "PROVIDER_ERROR"; message: string; details: { providerError: string } } | null = null;
  // ROUND-48 (R48-e1): set when the loop exits via the between-iterations
  // abort check (a deliberate parent stop) — distinct from a provider error.
  let stoppedBySignal = false;
  // ROUND-48 (R48-e1, stretch): count of steps the adapter reported LIVE via
  // onStepFinish. When > 0 the tool/text events for THIS chat() call were
  // already emitted as they happened — the post-call batch emission is
  // skipped (no duplicates). Adapters/stubs without the callback keep the
  // ROUND-40 post-call behavior.
  let liveStepsEmitted = 0;
  // ROUND-49: the intent-nudge state (see TOOL_INTENT_NUDGE). One nudge per
  // turn max; the nudge message rides the NEXT iteration's in-memory message
  // list only (never persisted — it is a machine correction, not a chat turn).
  let nudgeUsed = false;
  let pendingNudge: ChatTurnMessage | null = null;
  // ROUND-51 (R51-f): the loop-hygiene guard (per-turn — see the section
  // comment near createLoopGuard). The sync path observes each executed call
  // in the post-call audit loop below (one feed per call — onStepFinish live
  // frames carry the same calls and are NOT double-counted).
  const loopGuard = createLoopGuard();
  let guardNudge: ChatTurnMessage | null = null;
  let loopGuardStop: string | null = null;

  for (let outerIter = 0; outerIter < maxOuterLoops; outerIter++) {
    // ROUND-48 (R48-e1): a child whose parent was stopped finishes the
    // in-flight chat() iteration (its events persist — the work done is
    // real) and then STOPS here instead of starting the next one. Pending
    // child approvals already denied on abort (fail-closed, approvals.ts).
    if (signal?.aborted === true) {
      stoppedBySignal = true;
      break;
    }
    // ROUND-48 (R48-e1, stretch): reset the per-call live-step counter — the
    // flag must reflect THIS chat() call, not earlier iterations.
    liveStepsEmitted = 0;
    // ROUND-34: history INCLUDES tool results (multi-step fix — Cline parity).
    // Re-assembled each iteration so the model sees the prior iteration's
    // tool results + assistant text.
    const rawMessages = assembleHistory(db, session.id);
    const budget: ContextBudget = {
      contextWindow: getModelContextWindow(db, provider.id, model),
      maxOutputTokens: 32_768,
      margin: 8_000,
    };
    // ROUND-46 (R46-b): compaction instead of a silent hard trim. The sync
    // path (sub-agents) has no SSE emit — the compacted event lands in the
    // session log either way and later iterations reuse it.
    const { messages } = await assembleWithCompaction(rawMessages, budget, {
      db,
      sessionId: session.id,
      chat,
      provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
      apiKey,
      model,
    });
    if (pendingNudge !== null) {
      messages.push(pendingNudge);
      pendingNudge = null;
    }
    // ROUND-51 (R51-f): the loop guard's nudge rides the same in-memory path
    // as the intent nudge (next iteration only, never persisted). Mutually
    // exclusive with it by construction: the intent nudge fires only on
    // zero-tool iterations, the guard nudge only on tool-using ones.
    if (guardNudge !== null) {
      messages.push(guardNudge);
      guardNudge = null;
    }

    const startedAt = Date.now();
    let result: ChatTurnOutput;
    try {
      result = await chat({
        provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
        apiKey,
        model,
        system,
        messages,
        temperature: agent.temperature,
        maxTurns: agent.maxTurns,
        ...(tools !== undefined ? { tools } : {}),
        // ROUND-50 (R50-c1): the per-send thinking level (chat-completions
        // reasoning.effort injection — see chat.ts buildThinkingFetch).
        ...(prepared.thinkingLevel !== undefined ? { thinkingLevel: prepared.thinkingLevel } : {}),
        // ROUND-48 (R48-e1, stretch): LIVE per-step events. A single chat()
        // call can run maxTurns tool round-trips internally; without this
        // hook the parent UI sees nothing until the WHOLE call completes.
        // The adapter (generateText's onStepFinish) reports each finished
        // step and we forward tool-call/tool-result/text events as they
        // land — the same event shapes as the post-call batch below.
        ...(emit !== undefined
          ? {
              onStepFinish: (step: ChatStepSnapshot) => {
                liveStepsEmitted += 1;
                for (const call of step.toolCalls) {
                  emit({ type: "tool-call", sessionId: session.id, toolName: call.name, argsSummary: call.argsSummary });
                  emit({
                    type: "tool-result",
                    sessionId: session.id,
                    toolName: call.name,
                    ok: call.ok,
                    ...(call.outputSummary !== undefined
                      ? { outputSummary: scrubSecrets(call.outputSummary, keySecrets) }
                      : {}),
                  });
                }
                if (step.text !== "") {
                  emit({ type: "text-delta", sessionId: session.id, text: step.text });
                }
              },
            }
          : {}),
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      lastError = {
        ok: false,
        status: 502,
        code: "PROVIDER_ERROR",
        message: `provider '${provider.id}' call failed for session ${session.id}`,
        details: { providerError: providerErrorDetail(normalized, apiKey) },
      };
      break;
    }
    const ms = Date.now() - startedAt;
    totalInputTokens += result.usage.inputTokens;
    totalOutputTokens += result.usage.outputTokens;
    totalCachedInputTokens += result.usage.cachedInputTokens ?? 0;

    // Audit trail: one event per executed tool call, in order (ADR-0010 log).
    for (const call of result.toolCalls) {
      appendSessionEvent(db, session.id, {
        type: "tool.use",
        agentId: agent.id,
        payload: {
          role: "tool",
          toolName: call.name,
          argsSummary: call.argsSummary,
          ok: call.ok,
          ...(call.outputSummary !== undefined
            ? { outputSummary: scrubSecrets(call.outputSummary, keySecrets) }
            : {}),
        },
      });
      // ROUND-51 (R51-f): feed the loop-hygiene guard AFTER the call's own
      // event is persisted — the audit trail stays complete regardless of
      // what the guard decides. A stop is only FLAGGED here (the iteration's
      // assistant message still lands below); the break happens after it.
      const guardAction = loopGuard.onToolCall(call.name, call.argsSummary, call.ok);
      if (guardAction.action === "stop") {
        loopGuardStop = guardAction.reason ?? "Loop guard: stopped — no progress.";
        log("warn", "loop_guard.stop", {
          sessionId: session.id,
          agentId: agent.id,
          reason: loopGuardStop,
        });
      } else if (guardAction.action === "nudge" && guardAction.nudge !== undefined) {
        guardNudge = { role: "user", content: guardAction.nudge };
        log("info", "loop_guard.nudge", {
          sessionId: session.id,
          agentId: agent.id,
          toolName: call.name,
          repeatStreak: REPEAT_NUDGE,
        });
      }
    }

    // ROUND-40: forward live tool events to the parent's UI when an emit is
    // attached (sub-agent children). The streamed main-agent path emits
    // these from inside chatStream; the sync path emits them here, after
    // each chat() completion, so the parent sees the child's tool calls +
    // results + assistant text as they happen (not just the final report).
    // ROUND-48 (R48-e1, stretch): when the adapter reported steps LIVE
    // (onStepFinish above), these were already emitted per step — skip the
    // batch to avoid duplicates.
    if (emit !== undefined && liveStepsEmitted === 0) {
      for (const call of result.toolCalls) {
        emit({ type: "tool-call", sessionId: session.id, toolName: call.name, argsSummary: call.argsSummary });
        emit({
          type: "tool-result",
          sessionId: session.id,
          toolName: call.name,
          ok: call.ok,
          ...(call.outputSummary !== undefined ? { outputSummary: scrubSecrets(call.outputSummary, keySecrets) } : {}),
        });
      }
    }

    const assistantEvent = appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: {
        role: "assistant",
        content: result.text,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        ms,
        model,
      },
    });
    lastAssistantEvent = { seq: assistantEvent.seq, ts: assistantEvent.ts, content: result.text };

    // ROUND-40: forward the assistant text + a finish marker (one shot — the
    // sync path has no token deltas, but this is still a big UX win: the
    // parent sees the child's intermediate + final replies as they land).
    // ROUND-48 (R48-e1, stretch): live steps already emitted each step's text
    // (step texts concatenate to result.text) — only the finish marker is
    // still needed here.
    if (emit !== undefined && liveStepsEmitted === 0) {
      emit({ type: "text-delta", sessionId: session.id, text: result.text });
    }
    if (emit !== undefined) {
      emit({ type: "finish", sessionId: session.id });
    }

    // ROUND-51 (R51-f): the guard's hard threshold fired during this
    // iteration — stop the outer loop BEFORE spending another provider call
    // on the same no-progress pattern (the turn closes through the honest
    // loop-guard exit below the loop).
    if (loopGuardStop !== null) break;

    // ROUND-33 (owner report: "hello, how are you" kept planning + running
    // tools in an infinite loop): an iteration that produced a text reply
    // with ZERO tool calls is a CONVERSATIONAL response — break. ROUND-49
    // exception: when the text EVIDENCES tool intent (it names a tool /
    // announces delegation) the model stalled on the announce — spend the
    // turn's ONE intent-nudge and let it try again for real.
    if (result.toolCalls.length === 0) {
      if (
        !nudgeUsed &&
        tools !== undefined &&
        toolIntentMentioned(result.text, Object.keys(tools))
      ) {
        nudgeUsed = true;
        pendingNudge = { role: "user", content: TOOL_INTENT_NUDGE };
        continue;
      }
      break;
    }

    // Inverted continueIfUnfinished (mirrors the streamed path): for
    // tool-using iterations, continue UNLESS BOTH (a) explicit completion
    // signal AND (b) all todos completed.
    const hasCompletionSignal = COMPLETION_SIGNAL.test(result.text);
    const todosDone = latestTodosAllDone(db, session.id);
    if (hasCompletionSignal && todosDone) {
      break;
    }
    // ROUND-40: announce the continuation so the parent UI can show the
    // child is still working (another tool round-trip incoming).
    if (emit !== undefined) {
      emit({ type: "meta.continuation", sessionId: session.id, iteration: outerIter + 1, maxOuterLoops });
    }
  }

  // ROUND-48 (R48-e1): a deliberate stop between iterations is NOT a
  // provider failure — mirror runStreamedAgentTurn's abort semantics
  // exactly: logTurnEnd(ok=false), return the 499 ABORTED envelope, and
  // persist NO turn.error (R42/R43 rule: a stop is not an error). Work
  // completed by earlier iterations is already persisted in the event log;
  // the orchestrator marks the child failed and reports the stop honestly.
  // ROUND-58 (R58-c): also record the real usage of completed iterations +
  // reset the session status (the orchestrator's own "failed" set for
  // stopped children still lands AFTER this — final state stays designed;
  // any non-orchestrated caller gets the honest `queued` resting state).
  if (stoppedBySignal) {
    if (lastAssistantEvent !== null && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      recordUsage(db, {
        agentId: agent.id,
        sessionId: session.id,
        provider: provider.id,
        model,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedInputTokens: totalCachedInputTokens,
        costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
        ts: lastAssistantEvent.ts,
      });
      touchSession(db, session.id);
    }
    if (getSession(db, session.id)?.status === "running") {
      setSessionStatus(db, session.id, "queued");
    }
    logTurnEnd(session.id, false, Date.now() - syncStartedAt, totalInputTokens, totalOutputTokens);
    return {
      ok: false,
      status: 499,
      code: "ABORTED",
      message: `turn aborted for session ${session.id} — stopped by user`,
    };
  }

  // ROUND-51 (R51-f): loop-guard stop — the honest end for a no-progress
  // loop. Same shape as the provider-error path (persisted turn.error + 502
  // envelope; the R42/R43 rule: LOUD, persisted, retryable) but the message
  // names the guard, not a provider. Partial work is already in the event
  // log; the usage row still records the tokens actually spent (honest
  // accounting — the burn was real).
  if (loopGuardStop !== null) {
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "LOOP_GUARD",
      message: loopGuardStop,
      model,
      providerId: provider.id,
      providerError: loopGuardStop,
      keySecrets,
    });
    const usage: UsageRecord = {
      agentId: agent.id,
      sessionId: session.id,
      provider: provider.id,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: totalCachedInputTokens,
      costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
      // A guard stop always follows at least one tool-using iteration, so an
      // assistant event exists — the userSeq fallback is pure defensiveness.
      ts: lastAssistantEvent !== null ? lastAssistantEvent.ts : userEvent.ts,
    };
    recordUsage(db, usage);
    touchSession(db, session.id);
    logTurnEnd(session.id, false, Date.now() - syncStartedAt, totalInputTokens, totalOutputTokens);
    return {
      ok: false,
      status: 502,
      code: "LOOP_GUARD",
      message: loopGuardStop,
    };
  }

  if (lastAssistantEvent === null) {
    // No iteration produced an assistant event — provider errored on iter 0.
    // ROUND-43: persist the failure into the session timeline (the owner's
    // silent-death bug — nothing used to land in the event log) before
    // returning the 502 envelope.
    const fallback = lastError ?? {
      ok: false as const,
      status: 502 as const,
      code: "PROVIDER_ERROR" as const,
      message: `provider '${provider.id}' call failed for session ${session.id}`,
      details: { providerError: "no response produced" },
    };
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "PROVIDER_ERROR",
      message: fallback.message,
      model,
      providerId: provider.id,
      providerError:
        typeof fallback.details?.providerError === "string"
          ? fallback.details.providerError
          : "no response produced",
      keySecrets,
    });
    return fallback;
  }

  // ROUND-43: a provider failure on a LATER iteration (after partial replies)
  // still ends the turn abnormally — persist the error event so the timeline
  // shows the failure after the partial work instead of ending silently.
  if (lastError !== null) {
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "PROVIDER_ERROR",
      message: lastError.message,
      model,
      providerId: provider.id,
      providerError: String(lastError.details.providerError),
      keySecrets,
    });
  }

  const usage: UsageRecord = {
    agentId: agent.id,
    sessionId: session.id,
    provider: provider.id,
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    // ROUND-50 (R50-c1): 0 when no provider call reported a cached tier —
    // recorded as a plain 0 (not null) because at least one call ran.
    cachedInputTokens: totalCachedInputTokens,
    costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
    ts: lastAssistantEvent.ts,
  };
  recordUsage(db, usage);
  touchSession(db, session.id);
  // ROUND-44 (live-battery find): a SUCCESSFUL turn used to leave the session
  // in "running" forever (only the error path reset it) — sessions then read
  // as live in the UI forever and revert() 409s on a "running" session that
  // finished minutes ago. Mirror the error path: back to `queued` (the
  // resting state — sessions stay open for the next message).
  if (getSession(db, session.id)?.status === "running") {
    setSessionStatus(db, session.id, "queued");
  }
  // ROUND-38: auto-rename the session after the first assistant reply lands
  // (owner: sessions should rename after the first interaction, like the
  // reference repos). No-op once the title is no longer the default.
  maybeAutoTitleSession(db, session.id);
  logTurnEnd(session.id, true, Date.now() - syncStartedAt, totalInputTokens, totalOutputTokens);

  return {
    ok: true,
    assistantMessage: {
      seq: lastAssistantEvent.seq,
      role: "assistant",
      agentId: agent.id,
      content: lastAssistantEvent.content,
      ts: lastAssistantEvent.ts,
    },
    usage,
  };
}

/** Streaming turn outcome: same shape as the sync turn. */
export type StreamedTurnOutcome = TurnOutcome;

/**
 * STREAMED turn (round-16): identical persistence/ordering to the sync turn
 * (user event → tool.use events as each call completes → assistant event
 * with usage+ms → usage row), but every stream event is emitted LIVE via
 * `emit` so the UI can render text deltas and tool calls as they happen.
 */
export async function runStreamedAgentTurn(
  deps: TurnDeps,
  sessionId: string,
  content: string,
  emit: (event: unknown) => void,
  modelOverride?: string,
  signal?: AbortSignal,
  /** ROUND-50 (R50-c1): the composer's per-send thinking level — threaded
   * to the streaming adapter (chat-completions reasoning.effort). NOT
   * persisted; sub-agents never inherit it (the orchestrator calls without
   * it — children keep "default"). */
  thinkingLevel?: ThinkingLevel,
  /** ROUND-50 (R50-c1): the send's attachments — persisted on the
   * message.user event payload and rendered into the model-facing history
   * by assembleHistory. */
  attachments?: MessageAttachment[],
): Promise<StreamedTurnOutcome> {
  const { db, keyring, chat, chatStream } = deps;
  // ROUND-34: values the keyring holds — scrubbed from persisted tool output
  // summaries (run_command inherits process.env which carries ACUTE_* keys).
  const keySecrets = keyring.list().filter((v) => v.length >= 8);
  if (chatStream === undefined) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "streaming is not available in this build",
    };
  }
  const prepared = await prepareTurn(
    db,
    keyring,
    sessionId,
    modelOverride,
    chat,
    // ROUND-50 (R50-b): forward the streaming adapter so this turn's
    // delegate_task toolDeps carries it — children delegated from a streamed
    // turn run the STREAMED path themselves (live raw deltas to the UI).
    chatStream,
    emit,
    signal,
    // ROUND-50 (R50-c1): the per-send thinking level.
    thinkingLevel,
  );
  if ("error" in prepared) return prepared.error;
  const { session, agent, provider, apiKey, model, tools, system } = prepared;

  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  logTurnStart(session.id, agent.id, model, true);

  const userEvent = appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    // ROUND-50 (R50-c1): attachments ride the raw payload (display data);
    // assembleHistory renders them into the model-facing content.
    payload: {
      role: "user",
      content,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    },
  });

  const budget: ContextBudget = {
    contextWindow: getModelContextWindow(db, provider.id, model),
    maxOutputTokens: 32_768,
    margin: 8_000,
  };

  // Round-28 WS-F: multi-turn agentic continuation (owner R28 directive:
  // "It should automatically continue… 4, 5, 6, or 7 iterations… research →
  // save files → restart → next research"). The AI SDK's internal multi-step
  // loop (maxTurns tool round-trips) is ONE "SDK call". The OUTER loop here
  // starts a NEW SDK call when the task isn't genuinely complete — the
  // conversation context (with the previous assistant message + tool results)
  // is re-assembled from the event log each iteration.
  const maxOuterLoops = agent.maxOuterLoops ?? 5;
  const startedAt = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // ROUND-50 (R50-c1): cached prompt tokens — accumulated from the finish
  // frames (chat.ts reads usage.inputTokenDetails.cacheReadTokens) into the
  // turn's single usage_events row (context-meter cache hit rate).
  let totalCachedInputTokens = 0;
  let totalRequests = 0;
  let lastAssistantEvent: { seq: number; ts: string; content: string } | null = null;
  let lastText = "";
  // ROUND-49: the intent-nudge state (see TOOL_INTENT_NUDGE) — same contract
  // as the sync path: one nudge per turn, in-memory only, never persisted.
  let nudgeUsed = false;
  let pendingNudge: ChatTurnMessage | null = null;
  // ROUND-51 (R51-f): the loop-hygiene guard (per-turn). The streamed path
  // feeds it LIVE at each tool-result event, so a no-progress loop is
  // stopped MID-STREAM — before the model burns the rest of this SDK call's
  // steps, let alone another outer iteration (the owner's exact complaint).
  const loopGuard = createLoopGuard();
  let guardNudge: ChatTurnMessage | null = null;
  let loopGuardStop: string | null = null;

  for (let outerIter = 0; outerIter < maxOuterLoops; outerIter++) {
    // Re-assemble messages from the event log — ROUND-34: now WITH tool
    // results, so iteration 2+ sees exactly what its tools did instead of
    // re-planning blind (the multi-step fix).
    const rawMessages = assembleHistory(db, session.id);
    // ROUND-46 (R46-b): compaction instead of a silent hard trim — the
    // streamed path surfaces a meta.compaction event so the UI can show
    // that earlier context was summarized. usedTokens derives from the
    // final message list (the 800K context guard keeps its gate).
    const compaction = await assembleWithCompaction(rawMessages, budget, {
      db,
      sessionId: session.id,
      chat,
      provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
      apiKey,
      model,
    });
    const messages = compaction.messages;
    if (pendingNudge !== null) {
      messages.push(pendingNudge);
      pendingNudge = null;
    }
    // ROUND-51 (R51-f): the loop guard's nudge rides the same in-memory path
    // as the intent nudge (next iteration only, never persisted).
    if (guardNudge !== null) {
      messages.push(guardNudge);
      guardNudge = null;
    }
    const usedTokens = estimateMessageTokens(messages);
    if (compaction.compacted && compaction.detail !== undefined) {
      emit({
        type: "meta.compaction",
        tokensSaved: compaction.detail.tokensSaved,
        droppedMessages: compaction.detail.droppedMessages,
        throughSeq: compaction.detail.throughSeq,
      });
    }

    // Context guard (6-f R-F5): abort if assembled context > 800K tokens
    // (the 1M window is a LIMIT, not headroom; 200+ tool round-trips approach
    // 500KB of tool I/O alone).
    if (usedTokens > 800_000) {
      emit({ type: "meta.context_limit", tokens: usedTokens, limit: 800_000 });
      break;
    }
    // Request guard (6-f R-F6): abort if > 200 total requests (OpenRouter
    // rate limits apply even on 0-cost models).
    if (totalRequests > 200) {
      emit({ type: "meta.request_limit", requests: totalRequests, limit: 200 });
      break;
    }

    // Emit a continuation event so the frontend can show "Continuing…" (the
    // streaming bubble from WS-D2 handles this event type).
    if (outerIter > 0) {
      emit({ type: "meta.continuation", iteration: outerIter, reason: "incomplete_todos" });
    }

    let iterText = "";
    let iterThinking = "";
    // ROUND-37: measured thinking duration per segment ("Thought for Ns").
    // Starts at the first reasoning delta; freezes when the segment's text
    // begins (the thought is done the moment the model starts writing).
    let iterThinkingStart: number | null = null;
    let iterThinkingMs: number | null = null;
    let iterAllText = ""; // never reset — completion-signal detection across segments
    let iterInputTokens = 0;
    let iterOutputTokens = 0;
    // ROUND-50 (R50-c1): this iteration's cached prompt tokens.
    let iterCachedInputTokens = 0;
    let iterToolCalls = 0;
    totalRequests++;

    /** ROUND-35 (review fix #5): reasoning can run 10s of KB — cap the
     * persisted thinking at 4000 chars, head+tail like tool outputs. */
    const capThinking = (text: string): string => {
      if (text.length <= 4000) return text;
      const omitted = text.length - 4000;
      return `${text.slice(0, 2000)}\n…[thinking truncated ${omitted} chars]…\n${text.slice(-2000)}`;
    };

    let statsCarrierNeeded = false;

    /** ROUND-35 (owner: tool calls "should show within the chat at the point
     * of the tools being called… afterwards it should continue with the
     * message"): when a tool call arrives mid-message, flush the text-so-far
     * as an interim assistant SEGMENT so the event log (and the UI) renders
     * text → tool work → more text. */
    const flushSegment = (withStats: boolean): boolean => {
      if (iterText.trim() === "" && iterThinking.trim() === "") return false;
      const iterMs = Date.now() - startedAt;
      const thinkingMs =
        iterThinkingMs !== null
          ? iterThinkingMs
          : iterThinkingStart !== null
            ? Date.now() - iterThinkingStart
            : null;
      const ev = appendSessionEvent(db, session.id, {
        type: "message.assistant",
        agentId: agent.id,
        payload: {
          role: "assistant",
          content: iterText,
          ...(iterThinking.trim() !== ""
            ? {
                thinking: capThinking(iterThinking),
                ...(thinkingMs !== null && thinkingMs > 0 ? { thinkingMs } : {}),
              }
            : {}),
          ...(withStats
            ? {
                usage: { inputTokens: iterInputTokens, outputTokens: iterOutputTokens },
                ms: iterMs,
                model,
              }
            : {}),
        },
      });
      if (iterText.trim() !== "") {
        lastAssistantEvent = { seq: ev.seq, ts: ev.ts, content: iterText };
      }
      iterText = "";
      iterThinking = "";
      iterThinkingStart = null;
      iterThinkingMs = null;
      return true;
    };

    try {
      for await (const event of chatStream({
        provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
        apiKey,
        model,
        system,
        messages,
        temperature: agent.temperature,
        maxTurns: agent.maxTurns,
        ...(tools !== undefined ? { tools } : {}),
        // ROUND-50 (R50-c1): the per-send thinking level (chat-completions
        // reasoning.effort injection — see chat.ts buildThinkingFetch).
        ...(prepared.thinkingLevel !== undefined ? { thinkingLevel: prepared.thinkingLevel } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })) {
        if (event.type === "tool-result") {
          // handled below with a scrubbed outputSummary — do NOT emit raw.
        } else {
          emit(event);
        }
        if (event.type === "text-delta") {
          // ROUND-37: the first text token completes the in-flight thought —
          // freeze its measured duration ("Thought for Ns").
          if (iterThinkingStart !== null && iterThinkingMs === null) {
            iterThinkingMs = Date.now() - iterThinkingStart;
          }
          iterText += event.delta;
          iterAllText += event.delta;
        } else if (event.type === "thinking-delta") {
          if (iterThinkingStart === null) iterThinkingStart = Date.now();
          iterThinking += event.delta;
        } else if (event.type === "tool-input-start") {
          // ROUND-58 (R58-c): the model started generating this call's
          // ARGUMENTS — any text before it is final. Flush the interim
          // segment at the same boundary the UI now renders (text → live
          // file-write preview → tool result), so the persisted event-log
          // ordering matches the live stream. (The tool-call branch below
          // keeps its own flush — idempotent once this one ran.)
          if (iterText.trim() !== "" || iterThinking.trim() !== "") {
            flushSegment(false);
            statsCarrierNeeded = true;
          }
        } else if (event.type === "tool-call") {
          iterToolCalls += 1;
          // ROUND-35: flush the message-so-far BEFORE the tool runs, so the
          // tool work lands between message segments (owner directive).
          if (iterText.trim() !== "" || iterThinking.trim() !== "") {
            flushSegment(false);
            statsCarrierNeeded = true; // stats attach at iteration end instead
          }
        } else if (event.type === "tool-result") {
          // Persist each tool call the moment it completes (live ordering).
          // ROUND-34 (review fix #3): scrub the output summary BEFORE it is
          // emitted over SSE AND persisted — the UI must never see secrets.
          const outputSummary =
            event.outputSummary !== undefined
              ? scrubSecrets(event.outputSummary, keySecrets)
              : null;
          // Always emit the tool-result (scrubbed when it carries output) —
          // the UI's live rows key off these events.
          emit({ ...event, ...(outputSummary !== null ? { outputSummary } : {}) });
          appendSessionEvent(db, session.id, {
            type: "tool.use",
            agentId: agent.id,
            payload: {
              role: "tool",
              toolName: event.toolName,
              argsSummary: event.argsSummary,
              ok: event.ok,
              ...(outputSummary !== null ? { outputSummary } : {}),
            },
          });
          logTool(session.id, event.toolName, event.argsSummary, event.ok);
          // ROUND-51 (R51-f): feed the loop-hygiene guard LIVE — the call's
          // event is already persisted + emitted above, so the audit trail
          // stays complete whatever the guard decides. STOP breaks out of the
          // for-await immediately (its implicit iterator return() ends the
          // adapter stream): honest trade-off — the aborted call's finish
          // frame never arrives, so its tokens are under-counted in the
          // usage row, but the very waste the guard exists to stop is
          // stopped. NUDGE queues the correction for the next iteration.
          const guardAction = loopGuard.onToolCall(event.toolName, event.argsSummary, event.ok);
          if (guardAction.action === "stop") {
            loopGuardStop = guardAction.reason ?? "Loop guard: stopped — no progress.";
            log("warn", "loop_guard.stop", {
              sessionId: session.id,
              agentId: agent.id,
              reason: loopGuardStop,
            });
            break;
          }
          if (guardAction.action === "nudge" && guardAction.nudge !== undefined) {
            guardNudge = { role: "user", content: guardAction.nudge };
            log("info", "loop_guard.nudge", {
              sessionId: session.id,
              agentId: agent.id,
              toolName: event.toolName,
              repeatStreak: REPEAT_NUDGE,
            });
          }
        } else if (event.type === "finish") {
          iterInputTokens = event.usage.inputTokens;
          iterOutputTokens = event.usage.outputTokens;
          // ROUND-50 (R50-c1): cached prompt tokens ride the finish frame
          // (0 when the provider didn't report a cached tier).
          iterCachedInputTokens = event.cachedInputTokens ?? 0;
        }
      }
    } catch (error) {
      // ROUND-42: a deliberate user stop (POST /sessions/:id/stop) is not a
      // provider failure — return a distinct ABORTED outcome so the route can
      // skip the task_failed notification and the UI can render "Stopped".
      // ROUND-43: also do NOT persist a turn.error — a stop is not an error.
      if (signal?.aborted === true) {
        // ROUND-58 (R58-c, owner: "stopping should show a dedicated stopped-
        // by-user message, not a generation-failed error, and the sidebar must
        // stop showing processing"): the abort previously returned WITHOUT
        // (a) persisting the in-flight partial segment — the streamed text
        // vanished from the transcript on the next refetch, so a follow-up
        // "continue" lost the partial work; (b) resetting the session status
        // — the row stayed "running" until the next sidecar boot, so the
        // left-sidebar spinner spun forever after a stop. Now: flush the
        // partial text/thinking (stats unknown — the finish frame never
        // arrived), record the usage of COMPLETED iterations (honest
        // accounting — the spend was real), touch, and reset to `queued`.
        flushSegment(true);
        if (lastAssistantEvent !== null && (totalInputTokens > 0 || totalOutputTokens > 0)) {
          recordUsage(db, {
            agentId: agent.id,
            sessionId: session.id,
            provider: provider.id,
            model,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: totalCachedInputTokens,
            costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
            ts: lastAssistantEvent.ts,
          });
        }
        touchSession(db, session.id);
        if (getSession(db, session.id)?.status === "running") {
          setSessionStatus(db, session.id, "queued");
        }
        logTurnEnd(session.id, false, Date.now() - startedAt, totalInputTokens, totalOutputTokens);
        return {
          ok: false,
          status: 499,
          code: "ABORTED",
          message: `turn aborted for session ${session.id} — stopped by user`,
        };
      }
      const normalized = error instanceof Error ? error : new Error(String(error));
      logTurnEnd(session.id, false, Date.now() - startedAt, totalInputTokens, totalOutputTokens);
      // ROUND-43: persist the failure into the session timeline BEFORE
      // returning — otherwise the owner's reload shows a conversation that
      // ends at his message with no error and no retry (the silent-death
      // bug). The error event lands right after the user message, so the UI
      // renders the error card directly below it.
      const providerErrorText = providerErrorDetail(normalized, apiKey);
      const message = `provider '${provider.id}' call failed for session ${session.id}`;
      const errorTs = persistTurnError(db, {
        sessionId: session.id,
        agentId: agent.id,
        userSeq: userEvent.seq,
        code: "PROVIDER_ERROR",
        message,
        model,
        providerId: provider.id,
        providerError: providerErrorText,
        keySecrets,
      });
      return {
        ok: false,
        status: 502,
        code: "PROVIDER_ERROR",
        message,
        details: {
          providerError: providerErrorText,
          model,
          userSeq: userEvent.seq,
          // ROUND-43: the persisted event's ts — the live UI matches on it to
          // swap the streamed error card for the folded one (no duplicates).
          errorTs,
        },
      };
    }

    totalInputTokens += iterInputTokens;
    totalOutputTokens += iterOutputTokens;
    totalCachedInputTokens += iterCachedInputTokens;
    lastText = iterAllText;

    // ROUND-35: flush the iteration's FINAL segment (with stats). Interim
    // segments were already flushed at each tool call. REVIEW FIX #1: when
    // the iteration's text all preceded the tool calls (no trailing text),
    // the final flush is a NO-OP — append a stats-carrier event (empty
    // content + usage) so the reply badges + ctx meter survive. History
    // skips it (asChatMessage) and the UI merges its stats into the last
    // message (toProjectChatItems).
    const finalFlushed = flushSegment(true);
    if (statsCarrierNeeded && !finalFlushed) {
      const iterMs = Date.now() - startedAt;
      appendSessionEvent(db, session.id, {
        type: "message.assistant",
        agentId: agent.id,
        payload: {
          role: "assistant",
          content: "",
          usage: { inputTokens: iterInputTokens, outputTokens: iterOutputTokens },
          ms: iterMs,
          model,
        },
      });
    }
    statsCarrierNeeded = false;

    // ROUND-51 (R51-f): the guard stopped the stream mid-iteration — end the
    // turn honestly instead of spending another outer iteration on it (the
    // turn closes through the loop-guard exit below the loop).
    if (loopGuardStop !== null) break;

    // ROUND-33 FIX (owner report: "hello, how are you" kept planning +
    // running tools in an infinite loop): an iteration that produced a text
    // reply with ZERO tool calls is a CONVERSATIONAL response — the model
    // considered the request answered. Continuing would force the model to
    // invent work nobody asked for. Break immediately. ROUND-49 exception:
    // when the text EVIDENCES tool intent (it names a tool / announces
    // delegation) the model stalled on the announce — spend the turn's ONE
    // intent-nudge and let it try again for real.
    if (iterToolCalls === 0) {
      if (
        !nudgeUsed &&
        tools !== undefined &&
        toolIntentMentioned(iterAllText, Object.keys(tools))
      ) {
        nudgeUsed = true;
        pendingNudge = { role: "user", content: TOOL_INTENT_NUDGE };
        continue;
      }
      break;
    }

    // Inverted continueIfUnfinished (6-e fix — phrase matching was brittle):
    // for tool-using iterations, continue UNLESS BOTH (a) explicit completion
    // signal AND (b) all todos completed.
    const hasCompletionSignal = COMPLETION_SIGNAL.test(iterAllText);
    const todosDone = latestTodosAllDone(db, session.id);
    if (hasCompletionSignal && todosDone) {
      break;
    }
    // Last iteration — emit a cap-reached event so the UI knows.
    if (outerIter === maxOuterLoops - 1) {
      emit({ type: "meta.continuation_complete", iterations: maxOuterLoops });
    }
  }

  const ms = Date.now() - startedAt;

  // If no iteration produced text (edge case: model only called tools with no
  // final message), append an empty assistant marker so the event log closes
  // cleanly + the UI can resolve.
  if (lastAssistantEvent === null) {
    const fallback = appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: {
        role: "assistant",
        content: lastText,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        ms,
        model,
      },
    });
    lastAssistantEvent = { seq: fallback.seq, ts: fallback.ts, content: lastText };
  }

  // ROUND-51 (R51-f): loop-guard stop — the honest end for a no-progress
  // loop, mirroring the sync path: persisted turn.error (R42/R43 rule — the
  // reload shows the failure; the SSE route's generic error frame already
  // closed the live stream with code LOOP_GUARD) + a 502 envelope + the
  // usage row for the tokens actually spent. persistTurnError resets the
  // session to `queued` so the turn stays retryable.
  if (loopGuardStop !== null) {
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "LOOP_GUARD",
      message: loopGuardStop,
      model,
      providerId: provider.id,
      providerError: loopGuardStop,
      keySecrets,
    });
    const usage: UsageRecord = {
      agentId: agent.id,
      sessionId: session.id,
      provider: provider.id,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: totalCachedInputTokens,
      costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
      ts: lastAssistantEvent.ts,
    };
    recordUsage(db, usage);
    touchSession(db, session.id);
    logTurnEnd(session.id, false, ms, totalInputTokens, totalOutputTokens);
    return {
      ok: false,
      status: 502,
      code: "LOOP_GUARD",
      message: loopGuardStop,
    };
  }

  const usage: UsageRecord = {
    agentId: agent.id,
    sessionId: session.id,
    provider: provider.id,
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    // ROUND-50 (R50-c1): 0 when no provider call reported a cached tier —
    // recorded as a plain 0 (not null) because at least one call ran.
    cachedInputTokens: totalCachedInputTokens,
    costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
    ts: lastAssistantEvent.ts,
  };
  recordUsage(db, usage);
  touchSession(db, session.id);
  // ROUND-44 (live-battery find): same reset as the sync path — a finished
  // streamed turn must not leave the session stuck in "running".
  if (getSession(db, session.id)?.status === "running") {
    setSessionStatus(db, session.id, "queued");
  }
  // ROUND-38: auto-rename after the first streamed assistant reply (same
  // rule as the sync path — owner directive: sessions rename after the
  // first interaction).
  maybeAutoTitleSession(db, session.id);
  logTurnEnd(session.id, true, ms, totalInputTokens, totalOutputTokens);

  return {
    ok: true,
    assistantMessage: {
      seq: lastAssistantEvent.seq,
      role: "assistant",
      agentId: agent.id,
      content: lastText,
      ts: lastAssistantEvent.ts,
    },
    usage,
  };
}

/** Compute cost from the models table pricing (round-24). */
export function computeCost(
  db: SqliteDatabase,
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = lookupPricing(db, providerId, modelId);
  // ROUND-62 (owner: "i am unable to configure the per million input and
  // output token price for the models properly"): pricing sides are
  // INDEPENDENT — a model priced per-side (input-only, output-only, or one
  // side left unknown) costs what its KNOWN sides cost, not a hard $0. The
  // pre-R62 `either-null → 0` gate silently zeroed every partially-priced
  // turn, which is exactly the "price config doesn't work" report.
  const inputCost =
    pricing.inputPricePerMtok === null ? 0 : (inputTokens / 1_000_000) * pricing.inputPricePerMtok;
  const outputCost =
    pricing.outputPricePerMtok === null ? 0 : (outputTokens / 1_000_000) * pricing.outputPricePerMtok;
  return inputCost + outputCost;
}

/**
 * Look up the model's context window. Resolution order (ROUND-50 R50-c1,
 * shared by the turn budget and the context-meter route):
 *   1. the models table row for (providerId, model) — the owner's override;
 *   2. the built-in catalog's contextWindow (storage/models.ts CatalogModel);
 *   3. 200 000 (the pre-R50 fallback).
 */
export function getModelContextWindow(db: SqliteDatabase, providerId: string, modelId: string): number {
  const row = db
    .prepare("SELECT context_window FROM models WHERE provider_id = ? AND model_id = ?")
    .get(providerId, modelId) as { context_window: number | null } | undefined;
  return row?.context_window ?? getCatalogModel(modelId)?.contextWindow ?? 200_000;
}
