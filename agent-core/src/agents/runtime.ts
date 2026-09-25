/**
 * Single-agent chat turn (ADR-0001 "single" mode). Round-16: the turn prep
 * is shared between the SYNC path (runSingleAgentTurn) and the STREAMED path
 * (runStreamedAgentTurn — live text deltas + tool events over SSE); both
 * persist the identical append-only event sequence (ADR-0010):
 * message.user → tool.use (one per executed call, as each completes) →
 * message.assistant (with per-reply usage+ms stats) → usage_events row.
 */
import type {
  MemoryPolicy,
  MessageAttachment,
  ModelReasoningSupport,
  PermissionMode,
  SessionStatus,
  ThinkingLevel,
  UsageRecord,
} from "shared";
// ROUND-70 (R70-c, D1): environment grounding — os metadata + the git probe.
import { execFile } from "node:child_process";
import * as os from "node:os";
import { getAgent, TOOL_NAMES } from "../storage/agents.js";
import { getProject } from "../storage/projects.js";
import type Database from "better-sqlite3";
import {
  ProviderKeyring,
  resolveKeyPool,
  resolveProvider,
} from "../providers/registry.js";
import { buildProjectTools, NO_TOOLS } from "../tools/index.js";
import { log, logTool, logTurnEnd, logTurnStart } from "../lib/log.js";
import {
  appendSessionEvent,
  // ROUND-79 (R79-a): the per-turn BACKGROUND TASKS reminder payload — this
  // session's uncollected addressed delegations (cheap guard first; the
  // taskHints/modeHints ephemeral pattern, one tier over).
  buildBackgroundTasksReminder,
  // ROUND-94 (R94-D1): the mid-turn injection's CLAIM — deleteQueuedMessage
  // is the same type-guarded consume the route's post-turn continuation
  // loop uses (never a double-take between the two consumers).
  deliverAllQueuedMessages,
  deliverQueuedMessage,
  deleteQueuedMessage,
  getSession,
  lastSessionSeq,
  latestTodoSnapshot,
  listSessionEvents,
  listUndeliveredQueuedMessages,
  type SessionEvent,
  maybeAutoTitleSession,
  // ROUND-117 (R117-b): the memory-policy 'on-start' first-turn probe + the
  // turn-end "memories saved this session" counter.
  sessionHasUserTurn,
  countSessionMemorySaves,
  recordUsage,
  setSessionStatus,
  touchSession,
  updateSessionActiveMode,
} from "../storage/sessions.js";
import type {
  ChatFn,
  ChatStepSnapshot,
  ChatTurnMessage,
  ChatTurnOutput,
  QueuedStepMessage,
  StreamChatFn,
} from "./chat.js";
// ROUND-70 (R70-b, D3): the sticky-result tool set (read_skill /
// memory_recall — instructions and durable facts survive replay stubbing).
// ROUND-94 (R94-D1): renderAttachments moved INTO chat.ts (the mid-turn
// queued-message injection builds its model-facing user message there);
// this module — assembleHistory — imports it back (see chat.ts's section
// header for the move's rationale).
import { isStickyResultTool, renderAttachments, readStreamPartialUsage } from "./chat.js";
import { buildProjectSystemPrompt, readCustomRules, type PromptEnvironment } from "./prompts.js";
// ROUND-94 (R94-G wiring): the vision-capability gate for the prompt's
// CAPABILITIES section — the SAME sessionHasVisionPath the screenshot tools
// refuse through (tools/plugins/computer-use.ts). No cycle: the plugin
// chain never imports this module.
import { sessionHasVisionPath } from "../tools/plugins/computer-use.js";
// ROUND-72 (R72-a): the deterministic task→skill matcher — scores this
// turn's user message against the effective skills' descriptions so the
// prompt's SKILLS section can carry an advisory "Task signal" line.
// ROUND-73 (R73-b): computeModeHints (same scorer, id-keyed) scores the
// TASK-MODE descriptions for the TASK MODES section's own signal line.
import { computeModeHints, computeTaskHints } from "./task-hints.js";
// ROUND-73 (R73-b): the task-modes resolver — the posture tier's ONE
// resolution (builtins + project .acute/agents/*.md customs, shadowing).
// prepareTurn threads its index + per-turn hints into the prompt, resolves
// the session's active mode, and applies a file-mode's tools NARROWING.
import { findMode, resolveEffectiveModes, type TaskMode } from "./modes.js";
// ROUND-70 (R70-b): the skills index resolves through the ONE shared
// resolver (DB skills + file skills + agent filter + computer-use gate).
import { resolveEffectiveSkills } from "../storage/skills-files.js";
import { getComputerUseSettings } from "../storage/computer-use.js";
import { getIndexSummary } from "../storage/index.js";
// ROUND-98 (R98-F3): the auto-index hook — prepareTurn's one guarded,
// fire-and-forget background refresh for the codebase symbol index.
import { maybeAutoIndexProject } from "../storage/auto-index.js";
// ROUND-44 (R44-a): the project memory digest for prompt injection.
import { memoryDigest, workspaceMemoryDigest } from "../storage/memory.js";
// R105-C: the provider lessons write (rate-limit reason telemetry).
import { recordProviderLesson } from "../storage/provider-lessons.js";
// ROUND-49: the memory master switch (Settings → Advanced).
import { getMemorySettings, getDebugSettings, getRetrySettings, getThinkingLoopSettings } from "../storage/settings.js";
import { getCatalogModel, lookupPricing, resolveModelReasoningSupport } from "../storage/models.js";
import { estimateMessageTokens, type ContextBudget } from "../context.js";
// ROUND-46 (R46-b): context compaction — summarize the over-budget head
// instead of silently dropping it.
// ROUND-125 (R125-C, D1): providerUsageAnchor — the ZCode-adopted token
// anchor (see agents/compaction.ts's R125-C header) built here at the two
// assembleWithCompaction call sites.
import { assembleWithCompaction, providerUsageAnchor, type SeqMessage } from "./compaction.js";

export type SqliteDatabase = Database.Database;

/**
 * Round-28 WS-F: read the latest todo.update snapshot from the session event
 * log. Returns true if ALL todo items are marked "completed" (vacuously true
 * if the model never called todo_write — no plan = not a completion blocker).
 * ROUND-96 (R96-B): no longer the STOP gate's other half — completion is
 * tool-less text by default now; this reads POSITIVE incompleteness evidence
 * for the ONE todos-continuation (a final text over an unfinished plan gets
 * exactly one user-role "finish the remaining items" continuation).
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

/** Completion-signal regex — ROUND-96 (R96-B) RETIRED AS THE GATE (research
 * finding #1, docs/research/agent-architectures-r96.md §9 row 1: every
 * mature system ends the turn on the model's own tool-less stop; our phrase
 * gate was the outlier and the root cause of the owner's "The last message
 * must have role=user" report — a tool-using final iteration without a
 * magic phrase forced an assistant-last continuation DeepSeek rejected).
 * The phrase list survives as ONE heuristic input: the todos-continuation
 * fires only when the final text BOTH lacks a signal AND the plan has
 * unfinished items (a "Done." over an unfinished plan is trusted — the model
 * said it was done). No trailing \b: the signal often ends the message, and
 * \b after a period requires a following word char (absent at end-of-string).
 * ROUND-58 (R58-c) heritage: the list carries the common final-summary
 * phrasings ("Task completed.", "The task is complete."). */
const COMPLETION_SIGNAL =
  /\b(Done\.|Task complete\.|Task completed\.|The task is complete\.|Finished\.|All set\.|All done\.)/i;

/** ROUND-96 (R96-B): the ONE todos-continuation's user-role message — rides
 * the pendingNudge machinery (in-memory only, never persisted; the next
 * provider call ends user-last by construction).
 * ROUND-117 (R117-c, A9): the ending phrase aligns with the completion
 * contract — one spelling ("the line: Task complete."), matching the
 * COMPLETION DISCIPLINE / COMPLETION_SIGNAL contract the main prompt pins. */
const TODOS_CONTINUATION_NUDGE =
  "Your todo list still has incomplete items. Continue the task and complete the remaining work now — call the tools you need. When everything is done, reply with a short final summary ending with the line: Task complete.";

/** ROUND-96 (R96-B): the belt-and-suspenders SHAPE nudge — appended at the
 * assembly boundary whenever the outgoing messages end assistant-role, so
 * no provider call ever goes out assistant-last (DeepSeek@OpenRouter rejects
 * that shape with a deterministic 400; several queued-message/sub-agent paths
 * can produce it). In-memory only; never persisted; never emitted. */
const ASSISTANT_LAST_SHAPE_NUDGE =
  "Continue — if more work remains, do it now with real tool calls; otherwise reply with your final summary.";

/** API.md §5.4: these session statuses refuse follow-up turns. */
const TERMINAL_STATUSES: readonly SessionStatus[] = ["completed", "failed", "cancelled"];

// ── ROUND-120 (R120-H, owner items 43 + 44): the turn-end honesty laws ──────
//
// Item 43 ("The agent stops midway — mid-command, mid-file-read, mid-write —
// with no model error and no visible cause"): the audit of every exit path of
// runStreamedAgentTurn found exactly three SILENT exits — the outer-loop
// budget falling out mid-tool-work (ok:true + an empty assistant marker + an
// SSE-only meta.continuation_complete frame the PC stream-store ignores), a
// stream that ends CLEANLY mid-tool-call (a tool-call event whose result
// never arrived — the R80 truncation guard in chat.ts only catches the
// zero-finish-step shape, so a cut after an earlier step's finish-step
// slipped through and the model's call silently vanished), and a blank final
// iteration over an UNFINISHED todo plan (the R77 carve-out reads the whole
// turn, so whitespace after real tool work ended the turn with no nudge).
// All three are closed below; the law they now obey: a turn ends ONLY on
// (a) a real final answer, (b) a user abort (labeled as such), or (c) a
// surfaced error (turn.error + the 502 envelope + the notification).
// ────────────────────────────────────────────────────────────────────────────

/** R120-H: the ITERATION_LIMIT stop's message — the R80 REQUEST_LIMIT
 * precedent's shape (the honest budget stop: name the cap, name the
 * affordance, never pretend the mid-work turn completed). */
function iterationLimitMessage(sessionId: string, maxOuterLoops: number): string {
  return (
    `the turn hit its continuation budget (${maxOuterLoops} model calls × the agent's maxTurns steps) ` +
    `while still mid-work for session ${sessionId} — the work done so far is preserved in the transcript; ` +
    'send a follow-up message (e.g. "continue") to resume from where it stopped'
  );
}

/** R120-H: the MID-TOOL truncation error — thrown when a provider stream ends
 * CLEANLY with tool-call events that never received their results (and/or a
 * tool-input-start whose arguments never completed). The wording carries the
 * NETWORK_PATTERNS phrase ("connection closed") so the classifier reads it as
 * `network` — transient, the retry ladder owns it — exactly like the R80
 * zero-finish-step truncation sibling in chat.ts. */
function midToolTruncationError(unresolvedCalls: number, openInputs: number): Error {
  const parts: string[] = [];
  if (unresolvedCalls > 0) {
    parts.push(`${unresolvedCalls} tool call${unresolvedCalls === 1 ? "" : "s"} streamed without results`);
  }
  if (openInputs > 0) {
    parts.push(`${openInputs} tool call argument stream${openInputs === 1 ? "" : "s"} never completed`);
  }
  return new Error(
    `provider stream ended mid-tool-call — ${parts.join("; ")}; the connection closed before the call completed (truncated output)`,
  );
}

/** R120-H (item 43): the ONE blank-tail continuation's nudge — fired when a
 * final iteration returns NO text and NO tools while the todo plan is
 * UNFINISHED (positive incompleteness evidence, the same evidence class the
 * R96-B todos-continuation reads). The R77 carve-out ("a tool-using turn
 * with no final text stays legitimate — the tools did the work") is
 * preserved for the no-plan / finished shapes; this only refuses to let
 * whitespace end a turn the plan itself says is mid-work. */
const BLANK_TAIL_CONTINUATION_NUDGE =
  "Your previous response in this turn was empty (no text, no tool calls) while the task is still unfinished. " +
  "Continue the task now — call the tools you need. When everything is done, reply with a short final summary " +
  'ending with the line: Task complete.';

// ── ROUND-120 (R120-H, item 44): the RESUME path — hand the model its working
// context instead of resetting it into re-discovery ──────────────────────────
//
// "'Continue' re-reads every file from scratch." The audit: a follow-up turn
// re-assembles history through assembleHistory, whose R58-c fidelity window
// keeps FULL tool-result summaries for only the last RECENT_TOOL_RESULTS=8
// tool.use events (everything older stubs to 200 chars) — so after a long
// mid-work turn, the model's "continue" rode a history where most of what it
// had already read was a stub, and re-reading was the honest move. The fix:
// on a resume-shaped send (a bare "continue"-vocabulary message) after a turn
// that did tool work, the assembly widens the fidelity window (bounded by the
// same MAX_TOOL_BLOCK_CHARS block cap) and rides ONE deterministic,
// never-persisted resume note that names what the prior turn already read /
// wrote / ran and tells the model not to redo it. No LLM call, no new event
// type — the note rides the in-memory nudge channel (pendingNudge's shape),
// and the event log stays byte-identical. ───────────────────────────────────

/** R120-H: the bare-resume vocabulary (single-phrase sends only — "continue",
 * "go on", "继续"…; a message that carries real content is a NEW instruction,
 * not a resume, and gets the ordinary assembly). */
const RESUME_REQUEST_PATTERN =
  /^(?:continue|go\s+on|keep\s+going|carry\s+on|resume|proceed|继续|继续任务|接着做|接着继续)[.!?。！？]*$/i;

/** R120-H: is this send a bare resume request? Exported for tests. */
export function isResumeRequest(content: string): boolean {
  return RESUME_REQUEST_PATTERN.test(content.trim());
}

/** R120-H: the resume turn's tool-result fidelity window (vs the default 8).
 * Bounded by assembleHistory's MAX_TOOL_BLOCK_CHARS block cap — the wider
 * window only decides WHICH lines escape the per-line 200-char stub. */
const RESUME_RECENT_TOOL_RESULTS = 40;

/** R120-H: cap on the resume note's per-tool lines (the note names the prior
 * work; the full list lives in the tool_results blocks above it). */
const RESUME_NOTE_TOOL_CAP = 30;

interface ResumeTurnContext {
  /** The deterministic resume note (rides every iteration of the turn). */
  note: string;
  /** The widened fidelity window for this turn's assemblies. */
  recentToolResults: number;
}

/** R120-H: best-effort path extraction from a persisted argsSummary — the
 * display string ("path: notes/a.txt, content: 12 chars") is the only
 * persisted argument record by design (raw args never persist). */
function pathFromArgsSummary(argsSummary: string): string | null {
  const match = /(?:^|,\s*)path:\s*([^,]+)/.exec(argsSummary);
  const path = match?.[1]?.trim();
  return path !== undefined && path !== "" ? path : null;
}

/** R120-H: the read-family (context the model already holds) vs the
 * write-family (work that already succeeded) vs commands. */
const RESUME_READ_TOOLS = new Set(["read_file", "list_dir", "search_files", "grep", "glob"]);
const RESUME_WRITE_TOOLS = new Set(["write_file", "edit_file", "create_dir", "delete_file"]);

/** R120-H: build the deterministic resume note from the PRIOR turn's
 * tool.use events (pure — exported for tests). */
export function buildResumeContextNote(
  priorToolUses: ReadonlyArray<{ toolName: string; argsSummary: string }>,
  recentToolResults: number,
): string {
  const read: string[] = [];
  const wrote: string[] = [];
  const ran: string[] = [];
  const other: string[] = [];
  for (const call of priorToolUses.slice(0, RESUME_NOTE_TOOL_CAP)) {
    const path = pathFromArgsSummary(call.argsSummary);
    const label = path ?? call.argsSummary.slice(0, 80);
    if (RESUME_READ_TOOLS.has(call.toolName)) read.push(`${call.toolName}: ${label}`);
    else if (RESUME_WRITE_TOOLS.has(call.toolName)) wrote.push(`${call.toolName}: ${label}`);
    else if (call.toolName === "run_command") ran.push(label);
    else other.push(`${call.toolName}: ${label}`);
  }
  const overflow = priorToolUses.length - Math.min(priorToolUses.length, RESUME_NOTE_TOOL_CAP);
  const lines: string[] = [];
  if (read.length > 0) lines.push(`- already read (contents above): ${read.join("; ")}`);
  if (wrote.length > 0) lines.push(`- already wrote/edited: ${wrote.join("; ")}`);
  if (ran.length > 0) lines.push(`- commands already run: ${ran.join("; ")}`);
  if (other.length > 0) lines.push(`- other tools already run: ${other.join("; ")}`);
  if (overflow > 0) lines.push(`- (and ${overflow} more earlier tool calls — see the tool_results blocks above)`);
  return (
    "[Resume context — the previous turn's work is preserved in the tool_results blocks above; do NOT restart the task from scratch.]\n" +
    "What the previous turn already did:\n" +
    lines.join("\n") +
    `\nThe most recent ${recentToolResults} tool results above are in full; older ones may be truncated. ` +
    "Continue the task from where that work stopped: do not re-read files whose contents you already have " +
    "(unless you changed them or need fresh content), and do not redo work that already succeeded. " +
    "Read a file again only when its content is genuinely absent from the context above."
  );
}

/** R120-H: plan the resume context for THIS turn — null unless the send is a
 * bare resume request AND the previous turn did tool work (there is working
 * context to hand over). Pure — exported for tests. `preTurnEvents` is the
 * event log snapshot taken BEFORE this turn's user message is appended. */
export function planResumeTurnContext(
  preTurnEvents: readonly SessionEvent[],
  content: string,
): ResumeTurnContext | null {
  if (!isResumeRequest(content)) return null;
  // The PRIOR turn's events: everything after the last message.user (a
  // queued-message flip keeps its original seq, so the last message.user by
  // list order is the prior turn's own opener — this turn's is not appended
  // yet by construction).
  let lastUserIdx = -1;
  for (let i = preTurnEvents.length - 1; i >= 0; i -= 1) {
    if (preTurnEvents[i].type === "message.user") {
      lastUserIdx = i;
      break;
    }
  }
  const tail = lastUserIdx === -1 ? preTurnEvents : preTurnEvents.slice(lastUserIdx + 1);
  const priorToolUses: Array<{ toolName: string; argsSummary: string }> = [];
  for (const ev of tail) {
    if (ev.type !== "tool.use") continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.toolName !== "string") continue;
    priorToolUses.push({
      toolName: payload.toolName,
      argsSummary: typeof payload.argsSummary === "string" ? payload.argsSummary : "",
    });
  }
  if (priorToolUses.length === 0) return null;
  return {
    note: buildResumeContextNote(priorToolUses, RESUME_RECENT_TOOL_RESULTS),
    recentToolResults: RESUME_RECENT_TOOL_RESULTS,
  };
}

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
// ROUND-75 (R75): PLAN_MODE_TOOLS moved to ./mode-policy.ts (the canonical
// home — the task-mode policy and the permission-mode gate share ONE list).
// Re-exported for the historical import surface (permission-modes.test.ts).
export { PLAN_MODE_TOOLS } from "./mode-policy.js";
import { PLAN_MODE_TOOLS } from "./mode-policy.js";

/**
 * ROUND-81 (R81): the per-OPERATING-MODE allowlist transformation
 * (undefined = no restriction). The unified picker's three values:
 * - "ask"/"full": every tool stays (full widens the ASK-TIER GATES only,
 *   through toolDeps.permissionMode → approvals.ts).
 * - "plan": the fixed read-only set above (PLAN MODE — the agent can plan,
 *   read, research; it cannot edit the project).
 * The retired "editor" value maps to "ask" at the storage layer
 * (sessions.ts LEGACY_PERMISSION_MODE_REMAP + migration 0029).
 */
export function modeAllowList(mode: PermissionMode): readonly string[] | undefined {
  if (mode === "plan") return PLAN_MODE_TOOLS;
  return undefined;
}

/**
 * ROUND-50 (R50-c1) / ROUND-81 (unified modes): the FINAL allowlist a turn
 * on this session passes to buildProjectTools — agent allowlist (ADR-0019:
 * []/undefined = ALL) → delegation-depth rules (children at the cap lose
 * delegate_task) → operating-mode intersection (plan only; full/ask pass
 * through — ask gates at the approval tier instead). An empty product
 * becomes the NO_TOOLS sentinel (an empty array would mean "ALL"
 * downstream). Shared by prepareTurn and the context-meter route so both
 * agree by construction.
 */
export function sessionToolAllowList(
  session: { id: string; parentSessionId: string | null; permissionMode: PermissionMode },
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
  session: { id: string; parentSessionId: string | null; permissionMode: PermissionMode },
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
 * ROUND-73 (R73-b): the CUSTOM-MODE tool narrowing — a FILE-sourced task
 * mode may declare a `tools` frontmatter list, and while that mode is ACTIVE
 * the session's tool allowlist is INTERSECTED with it. Rules (mirroring the
 * permission-mode intersection at every step):
 *   · Only NARROWS, never widens — the mode's list can only REMOVE names
 *     from the post-permission-mode allowlist.
 *   · Names are validated against the REAL registered tool set (TOOL_NAMES,
 *     ADR-0019's vocabulary): an unknown name in a mode file (a typo, a
 *     syntactically-plausible slug, an mcp__ dynamic name) is DROPPED
 *     honestly — a custom mode can never conjure a tool that does not
 *     exist. If that leaves the mode with no known tools, the honest
 *     product is NO_TOOLS (the mode asked for nothing real).
 *   · An empty intersection → the NO_TOOLS sentinel (buildProjectTools
 *     treats []/undefined as ALL — the same empty-case semantics the
 *     permission modes use at line ~1290).
 *   · Builtins declare NO tools list → untouched allowlist (the default
 *     posture's toolset is the post-permission-mode set, byte-identical).
 *   · No active mode / a stale-cleared mode (undefined) → untouched.
 */
export function narrowAllowListByTaskMode(
  allowList: readonly string[] | undefined,
  activeTaskMode: TaskMode | undefined,
): readonly string[] | undefined {
  const modeTools = activeTaskMode?.tools;
  if (
    activeTaskMode === undefined ||
    activeTaskMode.source !== "file" ||
    modeTools === undefined ||
    modeTools.length === 0
  ) {
    return allowList;
  }
  // Validate against the real registry vocabulary — unknown names drop.
  const known = modeTools.filter((tool) => (TOOL_NAMES as readonly string[]).includes(tool));
  if (known.length === 0) {
    return NO_TOOLS;
  }
  const base =
    allowList === undefined || allowList.length === 0
      ? (TOOL_NAMES as readonly string[])
      : allowList;
  // NO_TOOLS already means "register nothing" — the intersection keeps it.
  const filtered = base.filter((tool) => known.includes(tool));
  return filtered.length > 0 ? filtered : NO_TOOLS;
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

/** ROUND-71 (R71-e2, D5): the system line the overflow-recovery path emits so
 * the user SEES that a context-window overflow was caught, the conversation
 * was auto-compacted, and the turn is being retried (the meta-frame pattern
 * used by meta.compaction / meta.context_limit — SSE-only, never persisted,
 * never model-facing). */
const OVERFLOW_RECOVERY_NOTE = "[context overflow → auto-compacted conversation → retrying]";

/** ROUND-94 (R94-D1, Part 2b — the owner's v0.91.0 field report: mid-task the
 * generation died with "Generation failed: unknown object", classified
 * `unknown` → fail-fast → an instant dead end): the wait before the ONE
 * unknown-class-with-PROGRESS retry. 5 s sits inside the short 3–7 s window
 * the fix calls for and is deliberately NOT a new rung of lib/retry.ts's
 * ladder (that module stays read-only this round; the ask was a single
 * bounded extra attempt, not a new schedule shape) — waitForRetry still
 * provides the abort-aware wait so a user Stop cuts it short, and the
 * meta.retry frame keeps it visible on the stream while it runs. */
const UNKNOWN_PROGRESS_RETRY_MS = 5_000;

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

// ── ROUND-51 (R51-f) → ROUND-96 (R96-B): the loop-hygiene guard ────────────

/**
 * ROUND-51 (R51-f, owner: "It takes up way too many steps… It should work in
 * an optimized way"): the loop-hygiene guard, ported IN SPIRIT from
 * deepseek-harness's `guard/repeat-tool-reminder` plugin (MIT © 2026 DeepSeek
 * — ideas only, no code copied; the study lives at
 * docs/research/deepseek-harness-notes.md).
 *
 * ROUND-96 (R96-B) — THE CONTRACT CHANGE, the owner's explicit directive:
 * "The loop guard should not be one that will stop but it will only warn the
 * user and it will pass the generation, pass the workflow, and everything
 * like that." The R51 STOP action is GONE (REPEAT_STOP and the failure
 * threshold no longer end turns — the R51 stop was what the owner watched
 * kill a healthy paged read of one file mid-task). What remains:
 *
 *   1. WARN + NUDGE (deepseek-harness's advisory core, restored): when one
 *      exact call repeats REPEAT_NUDGE times consecutively — identity is
 *      (toolName, canonical RAW args; R96-B threads the raw args through
 *      ChatToolCall/StreamChatEvent so paged reads with DIFFERENT offsets
 *      never match) — a persisted `turn.warning` event + a live
 *      {type:"turn.warning"} SSE frame surface the honest non-fatal note,
 *      and a user-role correction rides the NEXT outer iteration's
 *      in-memory message list (the TOOL_INTENT_NUDGE machinery — never
 *      persisted). Re-warns every REPEAT_NUDGE further identical calls
 *      (3, 6, 9… — their [3, 5, 8] schedule, no spam).
 *   2. FAILURES warn, never stop: MAX_CONSECUTIVE_FAILURES failing calls in
 *      a row (any args) fire the same warning + nudge; a later failure run
 *      re-warns the same way.
 *   3. IDENTICAL RESPONSES (the owner's other loop shape: "the model is
 *      responding with the exact same things again and again"): the
 *      assistant's per-iteration final TEXT is tracked; the SAME trimmed
 *      text IDENTICAL_TEXT_WARN times in a row with NO intervening tool
 *      activity fires the same warning + a ONE-per-turn nudge.
 *
 * The honest backstops that remain terminal: maxTurns × maxOuterLoops (the
 * turn's own caps) and REQUEST_LIMIT/CONTEXT_LIMIT (R80 caps, not the loop
 * guard). Scope: PER-TURN (fresh per runSingleAgentTurn /
 * runStreamedAgentTurn). The streak resets when a call DIFFERS (name or
 * canonical args); the failure counter resets on ANY successful call; the
 * identical-text streak resets on ANY tool activity or a different text.
 *
 * Observability: a persisted `turn.warning` session event (unknown to
 * assembleHistory — never model-facing; tolerated by the folded-log fold)
 * + the live {type:"turn.warning"} frame the stream store maps onto the
 * live turn's NOTE line (the R75 meta.retry/note channel — amber, non-fatal;
 * TurnErrorCard never sees it). Logger lines loop_guard.warn carry name +
 * counts only, never args/outputs/secrets.
 */

/** ROUND-51 (R51-f): consecutive identical calls before the first
 * warning+nudge (deepseek-harness's first threshold — 3 in their defaults
 * [3, 5, 8] too). ROUND-96 (R96-B): also the RE-WARN cadence (3, 6, 9…). */
export const REPEAT_NUDGE = 3;

/** ROUND-51 (R51-f) → ROUND-96 (R96-B): RETIRED — the REPEAT_STOP=5 hard stop
 * is gone per the owner's warn-only directive. The constant is deleted; the
 * re-warn cadence above owns the schedule. (Kept here as a comment so the
 * next reader stops looking for it.) */

/** ROUND-51 (R51-f): consecutive FAILED calls (any args) before the warning +
 * nudge — catches hammering loops the exact-match chain alone would miss
 * (e.g. read_file a, read_file b, read_file c … all failing). ROUND-96
 * (R96-B): warns, never stops. */
export const MAX_CONSECUTIVE_FAILURES = 6;

/** ROUND-96 (R96-B): identical consecutive assistant TEXTS before the
 * identical-response warning (the owner: "responding with the exact same
 * things again and again" — 2 repeats → warn on the 3rd occurrence). */
export const IDENTICAL_TEXT_WARN = 3;

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
 * ROUND-51 (R51-f): the canonical identity of a call's arguments — the stable
 * key-sort + stringify; anything unstringifiable degrades to String(args)
 * instead of throwing. ROUND-96 (R96-B): the guard is now fed the RAW args
 * (chat.ts threads them as ChatToolCall.args / the streamed tool events'
 * `args`), so {path, offset: 5000, limit: 5000} and {path, offset: 10000,
 * limit: 5000} — IDENTICAL display summaries ("path: x") but DIFFERENT
 * calls — no longer collide. String inputs (a legacy summary, a direct
 * onToolCall test) pass through verbatim.
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

/** ROUND-96 (R96-B): the warning families the guard reports. */
export type LoopWarningKind = "repeat" | "failure" | "identical_text";

/** ROUND-96 (R96-B): one guard verdict per observation — WARN-ONLY. */
export interface LoopGuardAction {
  action: "continue" | "warn";
  /** present on "warn" — which detector fired. */
  kind?: LoopWarningKind;
  /** present on "warn" — the ready-to-inject user-role correction (rides the
   * next outer iteration's in-memory message list; never persisted). */
  nudge?: string;
  /** present on "warn" — the user-facing non-fatal warning text (the
   * persisted turn.warning payload's message + the live frame's message). */
  reason?: string;
  /** present on "warn" — the count that fired (streak / failures / repeats),
   * for the persisted payload's diagnostics. */
  count?: number;
}

/** ROUND-51 (R51-f) → ROUND-96 (R96-B): the pure, per-turn guard (see the
 * section comment). onToolCall observes every executed call; onAssistantText
 * observes each iteration's final text when it used ZERO tools (the
 * conversational shape — any tool activity resets the text streak). */
export interface LoopGuard {
  onToolCall(toolName: string, args: unknown, ok: boolean): LoopGuardAction;
  onAssistantText(text: string): LoopGuardAction;
}

/**
 * ROUND-51 (R51-f): create a fresh per-turn guard. Pure state machine — no
 * DB, no clock, no I/O — so tests hit the thresholds directly and both turn
 * paths (sync + streamed) share one implementation. ROUND-96 (R96-B): the
 * state machine is WARN-ONLY (the owner's directive — the generation always
 * passes through).
 */
export function createLoopGuard(): LoopGuard {
  let lastKey: string | null = null;
  let repeatStreak = 0;
  let lastRepeatWarnStreak = 0;
  let consecutiveFailures = 0;
  let lastFailureWarn = 0;
  let lastText: string | null = null;
  let sameTextStreak = 0;

  return {
    onToolCall(toolName: string, args: unknown, ok: boolean): LoopGuardAction {
      // Any tool activity resets the identical-text chain — the owner's
      // "exact same response" loop shape is text-only repetition.
      lastText = null;
      sameTextStreak = 0;

      const key = `${toolName}\u0000${canonicalToolArgs(args)}`;
      if (key === lastKey) {
        repeatStreak += 1;
      } else {
        lastKey = key;
        repeatStreak = 1;
        lastRepeatWarnStreak = 0;
      }
      // Any successful call clears the failure run; failures of ANY args
      // (identical or not) accumulate.
      consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
      if (ok) lastFailureWarn = 0;

      // WARN (never stop — the R96-B contract): the re-warn cadence keeps it
      // honest without spam — at 3 the correction lands, at 6/9/… it repeats
      // while the loop actually persists.
      if (repeatStreak >= REPEAT_NUDGE && repeatStreak - lastRepeatWarnStreak >= REPEAT_NUDGE) {
        lastRepeatWarnStreak = repeatStreak;
        return {
          action: "warn",
          kind: "repeat",
          count: repeatStreak,
          reason:
            `Loop guard: ${toolName} was called ${repeatStreak} times in a row with identical arguments — ` +
            "still running; nudging the model to change its approach.",
          nudge:
            `You have called ${toolName} with identical arguments ${repeatStreak} times in a row with no progress. ` +
            "Stop repeating: re-read the last result, change your approach, or ask the owner. " +
            "If the task is genuinely complete, finish with your summary.",
        };
      }
      if (
        consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
        consecutiveFailures - lastFailureWarn >= MAX_CONSECUTIVE_FAILURES
      ) {
        lastFailureWarn = consecutiveFailures;
        return {
          action: "warn",
          kind: "failure",
          count: consecutiveFailures,
          reason:
            `Loop guard: ${consecutiveFailures} consecutive tool calls failed (last: ${toolName}) — ` +
            "still running; nudging the model to change its approach.",
          nudge:
            `Your last ${consecutiveFailures} tool calls failed in a row. Re-read the error output, fix the cause ` +
            "(arguments, path, permission), or take a different approach. If the task cannot proceed, say so and " +
            "finish with your summary.",
        };
      }
      return { action: "continue" };
    },
    onAssistantText(text: string): LoopGuardAction {
      const trimmed = text.trim();
      // Blank text is not a response — the R77 NO_OUTPUT guard owns that.
      if (trimmed === "") return { action: "continue" };
      if (trimmed === lastText) {
        sameTextStreak += 1;
      } else {
        lastText = trimmed;
        sameTextStreak = 1;
      }
      if (sameTextStreak >= IDENTICAL_TEXT_WARN) {
        return {
          action: "warn",
          kind: "identical_text",
          count: sameTextStreak,
          reason:
            `Loop guard: the model repeated the exact same response ${sameTextStreak} times — ` +
            "still running; nudging it to continue properly.",
          nudge:
            `You have produced the exact same response ${sameTextStreak} times in a row. Do not repeat yourself — ` +
            "either continue the actual work with real tool calls, or give your final summary.",
        };
      }
      return { action: "continue" };
    },
  };
}

/**
 * ROUND-96 (R96-B): surface one guard warning — the persisted `turn.warning`
 * session event (the durable, reload-safe record; assembleHistory skips the
 * type so it is never model-facing) + the live {type:"turn.warning"} SSE
 * frame (the stream store maps it onto the live turn's NOTE line — the
 * non-fatal amber channel, never TurnErrorCard). Payload diagnostics carry
 * the tool name + counts only, never args/outputs/secrets (the R51 rule).
 */
function persistLoopWarning(
  db: SqliteDatabase,
  sessionId: string,
  agentId: string,
  emit: ((event: unknown) => void) | undefined,
  warning: { kind: LoopWarningKind; message: string; count?: number; toolName?: string },
): void {
  appendSessionEvent(db, sessionId, {
    type: "turn.warning",
    agentId,
    payload: {
      kind: warning.kind,
      message: warning.message,
      ...(warning.toolName !== undefined ? { toolName: warning.toolName } : {}),
      ...(warning.count !== undefined ? { count: warning.count } : {}),
    },
  });
  emit?.({
    type: "turn.warning",
    sessionId,
    kind: warning.kind,
    message: warning.message,
  });
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
       * complete; the provider itself did not fail either.
       * ROUND-77 (R77): NO_OUTPUT = the model returned a blank response
       * (whitespace-only, zero tool calls — the free-model flake observed
       * live in the T5 battery). Status 502 for the same honest-failure
       * rule: the requested work did not happen.
       * ROUND-80 (R80, owner: "the chat ends without any error message or
       * anything some times"): CONTEXT_LIMIT / REQUEST_LIMIT = the 800k-token
       * and 200-request guards ended the turn. Pre-R80 these broke the loop
       * with ok:true (a SILENT stop — no error card, no retry); they now
       * carry the honest terminal path (persisted turn.error + 502).
       * ROUND-96 (R96-B): LOOP_GUARD is RETIRED as a PRODUCED code — the
       * loop-hygiene guard is WARN-ONLY now (the owner's directive: "it will
       * only warn the user and it will pass the generation"); it warns via
       * the persisted turn.warning event + the live turn.warning frame and
       * NEVER ends a turn. The union member stays for the historical
       * persisted turn.error rows + the streamed route's error-frame type
       * (pre-R96 sessions must keep rendering) — nothing produces it since
       * this round. */
      code:
        | "NOT_FOUND"
        | "CONFLICT"
        | "ABORTED"
        | "PROVIDER_ERROR"
        | "PROVIDER_DISABLED"
        | "LOOP_GUARD"
        | "NO_OUTPUT"
        | "CONTEXT_LIMIT"
        | "REQUEST_LIMIT"
        /** ROUND-120 (R120-H, item 43): the outer-loop budget ran out while
         * the model was still mid-work (tools-only final iteration) — the
         * honest stop (persisted turn.error + 502) that replaced the silent
         * ok:true fall-out. */
        | "ITERATION_LIMIT";
      message: string;
      details?: Record<string, unknown>;
    };

export interface TurnDeps {
  db: SqliteDatabase;
  keyring: ProviderKeyring;
  chat: ChatFn;
  /** Streaming adapter (round-16); the streamed turn refuses without one. */
  chatStream?: StreamChatFn;
  /**
   * ROUND-64 (R64-e, owner: per-API-key usage stats): the key-pool slot this
   * turn's provider key comes from — set by the orchestrator on a CHILD's
   * deps from the slot it acquired (load-spreading; ADR-0022 heritage).
   * ROUND-92 (R92-D): the slot is now the turn's STARTING key, not a
   * constraint — children receive the PARENT keyring unchanged (the full
   * pool) and the runner begins from this slot's entry, juggling to the
   * next untried key on key-attributable failures (auth / rate_limit).
   * Omitted (main-session turns, HTTP retry routes) = slot 0, the PRIMARY
   * key — the honest default: those turns historically resolved
   * keyring.get(provider.id), which IS the primary. Flows into recordUsage's
   * third parameter (via the runner's activeKeySlot) so the usage_events row
   * attributes its tokens/cost to the key that paid them.
   */
  keySlot?: number;
  /**
   * R93-B4 (the owner: "it should be able to utilize only that one single
   * API key to run the sub-agents too"): the parent turn's EFFECTIVE
   * model pair (the per-send override, or the agent row's own provider +
   * model — exactly what prepareTurn resolved, non-null by the R92-B
   * override-first gate). The delegation plugin threads it in from
   * ToolDeps.mainModel so the orchestrator can fall children back onto it
   * when the agent row carries NO durable pair (the R91/R92 NULL rows +
   * seeded templates) — before R93 a NULL row with no subagentModel meant
   * every child 409'd "has no providerId/model configured" and the
   * delegation hung as a failure. The explicit orchestration.subagentModel
   * setting still wins; the agent row's OWN durable pair still beats the
   * per-send transient.
   */
  mainModel?: { providerId: string; modelId: string };
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
 *
 * ROUND-70 (R70-b, D3): STICKY RESULT LINES. read_skill and memory_recall
 * results are exempt from BOTH the per-line stub and the block-cap stub:
 * a loaded skill body is INSTRUCTIONS the model is supposed to follow for
 * the rest of the task — evaporating it on outer-loop replay (the 200-char
 * stub after 8 later tool calls) made the model drop its own procedure
 * mid-task, the exact failure the R70-A analysis flagged. memory_recall is
 * exempt for the same reason (durable project facts, tiny, and the same
 * "instructions not data" character). Sticky lines yield ONLY in the
 * pathological last-resort case (a block that stays over MAX_TOOL_BLOCK_CHARS
 * even after every non-sticky line stubbed — e.g. dozens of loaded skill
 * bodies): they then truncate to STICKY_STUB_CHARS with an explicit
 * "call read_skill again" marker, so even the degradation self-heals.
 */
const RECENT_TOOL_RESULTS = 8;
const OLD_TOOL_STUB_CHARS = 200;
const MAX_TOOL_BLOCK_CHARS = 48_000;
const STICKY_STUB_CHARS = 8_000;

interface PendingToolLine {
  text: string;
  sticky: boolean;
}

export function assembleHistory(
  db: SqliteDatabase,
  sessionId: string,
  /** ROUND-120 (R120-H, item 44): the tool-result fidelity window — how many
   * of the NEWEST tool.use events keep their full output summaries (the rest
   * stub to OLD_TOOL_STUB_CHARS). Absent = the R58-c default of 8; a resume
   * turn passes the wider RESUME_RECENT_TOOL_RESULTS window so the model's
   * "continue" rides its actual working context instead of 200-char stubs
   * (the "re-reads every file" regression). */
  opts?: { recentToolResults?: number },
): SeqMessage[] {
  const events = listSessionEvents(db, sessionId);
  const messages: SeqMessage[] = [];
  let pendingToolLines: PendingToolLine[] = [];
  let pendingToolSeq = 0;
  // ROUND-58 (R58-c): seqs of the last RECENT_TOOL_RESULTS tool.use events —
  // these keep full output summaries in the replay; everything older stubs.
  // ROUND-120 (R120-H): the window is the caller's opt (default unchanged).
  const recentWindow = Math.max(1, opts?.recentToolResults ?? RECENT_TOOL_RESULTS);
  const toolUseSeqs: number[] = [];
  for (const ev of events) {
    if (ev.type === "tool.use") toolUseSeqs.push(ev.seq);
  }
  const recentToolSeqs = new Set(toolUseSeqs.slice(-recentWindow));

  const flushTools = () => {
    if (pendingToolLines.length === 0) return;
    // ROUND-58 (R58-c): bound the block — stub from the OLDEST lines first
    // until the joined block is under MAX_TOOL_BLOCK_CHARS.
    let text = pendingToolLines.map((l) => l.text).join("\n");
    for (let i = 0; i < pendingToolLines.length && text.length > MAX_TOOL_BLOCK_CHARS; i++) {
      // R70-b D3: sticky lines (read_skill / memory_recall) are never
      // stubbed by the block cap — only the second, last-resort pass below
      // can touch them.
      if (pendingToolLines[i].sticky) continue;
      if (pendingToolLines[i].text.length > OLD_TOOL_STUB_CHARS) {
        pendingToolLines[i].text = `${pendingToolLines[i].text.slice(0, OLD_TOOL_STUB_CHARS)}…[older result truncated]`;
      }
      text = pendingToolLines.map((l) => l.text).join("\n");
    }
    // R70-b D3 last resort: bounded context is the HARD invariant — if the
    // block is still over the cap (only possible with many huge sticky
    // bodies), sticky lines truncate to STICKY_STUB_CHARS, oldest first,
    // with the honest reload marker.
    for (let i = 0; i < pendingToolLines.length && text.length > MAX_TOOL_BLOCK_CHARS; i++) {
      if (pendingToolLines[i].text.length > STICKY_STUB_CHARS) {
        pendingToolLines[i].text = `${pendingToolLines[i].text.slice(0, STICKY_STUB_CHARS)}…[skill instructions truncated — call read_skill again to reload them]`;
      }
      text = pendingToolLines.map((l) => l.text).join("\n");
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
      // ROUND-70 (R70-b, D3): sticky tools (read_skill / memory_recall)
      // never hit the per-line 200-char stub — instructions and durable
      // facts must survive the whole task. See the header comment.
      const sticky = isStickyResultTool(toolName);
      if (!recentToolSeqs.has(event.seq) && !sticky && line.length > OLD_TOOL_STUB_CHARS) {
        line = `${line.slice(0, OLD_TOOL_STUB_CHARS)}…[older result truncated]`;
      }
      pendingToolLines.push({ text: line, sticky });
      pendingToolSeq = event.seq;
    }
  }
  flushTools();
  return messages;
}

/* ── ROUND-75 (R75): provider-error classification moved to the pure module
 * ./error-classification.ts (the retry ladder in lib/retry.ts needs the
 * class WITHOUT importing this 2.8k-line runtime — a cycle otherwise).
 * Re-exported below so the historical import surface (tests, debug-analyst)
 * is unchanged. ──────────────────────────────────────────────────────────── */
export {
  CLASS_MESSAGES,
  classifyProviderError,
  extractRetryAfterMs,
  isTransientApiFailure,
  providerErrorDetail,
  providerFailureMessage,
  unwrapRetryError,
  MAX_RETRY_AFTER_MS,
  type ProviderErrorClass,
  type ProviderErrorClassification,
} from "./error-classification.js";
import {
  classifyProviderError,
  extractRetryAfterMs,
  providerErrorDetail,
  providerFailureMessage,
  type ProviderErrorClass,
} from "./error-classification.js";
import { isTransientApiFailure } from "./error-classification.js";
import {
  clearActiveRetryWait,
  effectiveRungWaitMs,
  formatRetryWaitMs,
  registerActiveRetryWait,
  resolveRetrySchedule,
  waitForRetry,
} from "../lib/retry.js";

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
export function persistTurnError(
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
    /** ROUND-71 (R71-e2, D4): the provider-error class, when one was
     * classified (additive payload field — older readers ignore it). */
    errorClass?: ProviderErrorClass;
    /** ROUND-75 (R75): total attempts when the transient-API retry ladder
     * ran (1 = no ladder). Additive payload field — the error card renders
     * "failed after N attempts" only when > 1. */
    attempts?: number;
    /** ROUND-97 (R97-E): the tokens the FAILED turn actually spent — the
     * completed iterations' totals + the failed call's streamed-so-far (the
     * owner: "if a model fails, then it does not show me the total number of
     * tokens sent, total number of tokens received…"). Additive payload
     * field; the error card renders the line when present. */
    usage?: { inputTokens: number; outputTokens: number };
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
      ...(args.errorClass !== undefined ? { errorClass: args.errorClass } : {}),
      ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
      ...(args.usage !== undefined ? { usage: args.usage } : {}),
    },
  });
  // The turn is over (not mid-flight) — `queued` keeps the session open for
  // a retry and out of sweepStaleRunning's crash path at the next boot.
  if (getSession(db, args.sessionId)?.status === "running") {
    setSessionStatus(db, args.sessionId, "queued");
  }
  return event.ts;
}

/**
 * ROUND-117 (R117-b) — the turn-end MEMORY CAPTURE step. The root fix for
 * "memory formation is voluntary": the honest, deterministic version of
 * auto-capture, run in the same terminal path that persists the turn's
 * success (usage row + status reset + auto-title). It makes NO LLM call and
 * invents nothing:
 *
 *   · The DURABLE writers are elsewhere and event-driven — compaction
 *     summaries persist into project memory at compaction time
 *     (agents/compaction.ts, the episodic bridge) and the model's own
 *     memory_save calls need no help.
 *   · There is NO session-close event in the event vocabulary (sessions rest
 *     at `queued`, open for the next message) — so the "session digest line
 *     when a session with ≥N tool calls ends" is deliberately NOT persisted:
 *     no hook exists to hang it on, and a fabricated one is not honest.
 *     Compaction is the session-summary channel that actually exists.
 *   · What THIS step owns is the honesty counter: how many memories the
 *     session has produced so far (successful memory_save tool calls +
 *     compaction-summary rows), appended as a `memory.saved` event
 *     {saved, agentSaved, systemSaved} — a future UI wave renders
 *     "memories saved this session"; unknown event types are skipped by
 *     every existing reader (the context.compact precedent), so no UI change
 *     rides this wave.
 *
 * Gated like the digest: a bound project + the master switch + the agent's
 * policy != 'none'. Zero saves → no event (a zero-count row is noise).
 */
function captureTurnEndMemory(
  db: SqliteDatabase,
  args: { sessionId: string; agentId: string; projectId: string | null; memoryPolicy: MemoryPolicy },
): void {
  if (args.projectId === null) return;
  if (args.memoryPolicy === "none") return;
  if (!getMemorySettings(db).enabled) return;
  const { agentSaved, systemSaved } = countSessionMemorySaves(db, args.sessionId);
  const saved = agentSaved + systemSaved;
  if (saved === 0) return;
  appendSessionEvent(db, args.sessionId, {
    type: "memory.saved",
    agentId: args.agentId,
    payload: { saved, agentSaved, systemSaved },
  });
}

/** Everything a turn needs after validation (shared by sync + streamed). */
interface PreparedTurn {
  session: NonNullable<ReturnType<typeof getSession>>;
  agent: NonNullable<ReturnType<typeof getAgent>>;
  provider: { id: string; baseUrl: string; apiFormat?: string };
  /** ROUND-92 (R92-D): the FIRST key of the resolved pool (pool[0] — the
   * primary when one exists). Kept as a field for every pre-R92 consumer
   * of the prepared pair; the turn runners now read the STARTING key from
   * keyPool below (the orchestrator's reserved slot for children). */
  apiKey: string;
  /** ROUND-92 (R92-D): the provider's DEDUPED key pool (resolveKeyPool —
   * slot order, same-value slots collapsed, empties dropped). Non-empty by
   * the gate below; the turn runners juggle through it on key-attributable
   * failures. Never logged, never emitted. */
  keyPool: Array<{ slot: number; key: string }>;
  model: string;
  /** ROUND-114 (R114-b): the EFFECTIVE provider id (the three-tier ladder —
   * override → session.selectedModel → agent row; identical to provider.id,
   * carried separately so the streamed runner's turn.started frame names the
   * tier-resolved provider without re-deriving it). */
  providerId: string;
  tools: Awaited<ReturnType<typeof buildProjectTools>> | undefined;
  system: string;
  /** ROUND-50 (R50-c1): the per-send thinking level, threaded to the chat
   * adapters (chat.ts buildModel). Not persisted. */
  thinkingLevel?: ThinkingLevel;
  /** ROUND-95 (R95-E, THE R95-B E-CONTRACT): the EFFECTIVE model's detected
   * reasoning capability (resolveModelReasoningSupport — null = unknown,
   * NEVER blocked on). Threaded to the chat adapters so buildThinkingFetch
   * can map the level onto the model's own effort ladder, and read by the
   * streamed thinking-loop retry to de-escalate honestly. */
  reasoningSupport: ModelReasoningSupport | null;
}

/**
 * ROUND-92 (R92-D): the pool entry a turn STARTS from — the orchestrator's
 * RESERVED slot when that slot still holds a key in the (deduped) pool
 * (children: load-spreading; the reservation ran over the same pool), else
 * pool[0] (the primary, or the first pool key when no primary exists — a
 * pool made only of _SLOT entries is a valid provider configuration).
 */
function initialKeyPoolEntry(
  keyPool: Array<{ slot: number; key: string }>,
  reservedSlot: number,
): { slot: number; key: string } {
  return keyPool.find((entry) => entry.slot === reservedSlot) ?? keyPool[0]!;
}

/* ── ROUND-70 (R70-c, D1): per-turn environment grounding ────────────────────
 *
 * R70-A's #1 issue: the composed prompt never said WHICH OS/shell the agent
 * was commanding — the model guessed (the live reports show cmd.exe-style
 * launches from POSIX models and vice versa). prepareTurn now computes the
 * real machine state once per turn and the ENVIRONMENT section renders it;
 * the TERMINAL section teaches only the actual platform's syntax.
 *
 * Contract: NEVER block the turn on this — every probe is timeout-guarded
 * (git ~1.5s) and degrades to honest display strings ("not a git repo" /
 * "unknown"). Nothing here is cached across turns (prepareTurn IS the
 * per-turn cache).
 */

/** Hard guard for each git probe call (~1.5s per the R70-c spec). */
const GIT_PROBE_TIMEOUT_MS = 1_500;

/** One execFile call that ALWAYS resolves (ok:false on error/timeout) — a
 * failed probe is display data ("unknown"), never a turn failure. */
function execFileQuiet(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, stdout: string, stderr: string): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, stdout, stderr });
    };
    try {
      const child = execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 64 },
        (err, stdout, stderr) => {
          done(err === null, String(stdout ?? ""), String(stderr ?? ""));
        },
      );
      // Belt-and-braces: execFile's own timeout kills the child, but a
      // PATH-resolution hang must never hold the turn either — the unref'd
      // guard timer resolves and kills regardless.
      const guard = setTimeout(() => {
        done(false, "", "guard timeout");
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, timeoutMs + 250);
      guard.unref();
    } catch {
      done(false, "", "spawn failed");
    }
  });
}

/** The branch + dirty state of the project's worktree, or the honest
 * fallbacks: "not a git repo" / "unknown". NEVER throws. */
async function probeGitState(rootPath: string): Promise<{ gitBranch: string; gitDirty: boolean }> {
  const branchResult = await execFileQuiet(
    "git",
    ["-C", rootPath, "rev-parse", "--abbrev-ref", "HEAD"],
    GIT_PROBE_TIMEOUT_MS,
  );
  if (!branchResult.ok) {
    const notARepo = /not a git repository|must be run in a work tree/i.test(branchResult.stderr);
    return { gitBranch: notARepo ? "not a git repo" : "unknown", gitDirty: false };
  }
  const branch = branchResult.stdout.trim();
  // Detached HEAD: --abbrev-ref prints the literal "HEAD" — report it
  // honestly rather than pretending it is a branch name.
  const gitBranch = branch === "" ? "unknown" : branch === "HEAD" ? "HEAD (detached)" : branch;
  const statusResult = await execFileQuiet(
    "git",
    ["-C", rootPath, "status", "--porcelain"],
    GIT_PROBE_TIMEOUT_MS,
  );
  // A failed status probe leaves dirty=false — the model still gets the
  // branch; the D4 dirty-worktree discipline holds regardless.
  const gitDirty = statusResult.ok ? statusResult.stdout.trim() !== "" : false;
  return { gitBranch, gitDirty };
}

/** The turn's PromptEnvironment (D1): OS mapped from process.platform, the
 * shell exec.ts ACTUALLY spawns through (spawn(…, {shell:true}) = cmd.exe on
 * Windows, /bin/sh on POSIX), the local date, and the git state.
 * ROUND-83 (R83): exported — the context-meter route builds the SAME
 * environment grounding the real turn's system prompt carries, so the
 * meter's estimate counts every section (the audit's §2.2). */
export async function buildPromptEnvironment(rootPath: string): Promise<PromptEnvironment> {
  const now = new Date();
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const pad = (n: number): string => String(n).padStart(2, "0");
  const { gitBranch, gitDirty } = await probeGitState(rootPath);
  return {
    osPlatform:
      process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
    osRelease: os.release(),
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    currentDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${weekdays[now.getDay()]})`,
    gitBranch,
    gitDirty,
  };
}

/** ROUND-82 (R82, the owner's custom-provider routing fix): a per-send
 * model override. The composer's picker captures BOTH the model id AND the
 * provider it was picked under — historically the wire dropped the
 * providerId and prepareTurn resolved the provider from the AGENT row
 * alone (the default agent is openrouter → custom models went verbatim to
 * OpenRouter → "No endpoints found"). The union keeps the bare-string
 * shape working for every existing caller (the orchestrator's
 * subagentModel, tests); the object shape carries the provider routing. */
export type TurnModelOverride = string | { model: string; providerId?: string };

/** Normalize any override shape to the resolved pair. A blank model (or a
 * blank providerId) degrades to undefined — the agent defaults apply. */
function normalizeModelOverride(
  override: TurnModelOverride | undefined,
): { model: string; providerId: string | undefined } | undefined {
  if (override === undefined) return undefined;
  if (typeof override === "string") {
    const model = override.trim();
    return model === "" ? undefined : { model, providerId: undefined };
  }
  const model = typeof override.model === "string" ? override.model.trim() : "";
  if (model === "") return undefined;
  const providerId =
    typeof override.providerId === "string" && override.providerId.trim() !== ""
      ? override.providerId.trim()
      : undefined;
  return { model, providerId };
}

/** Shared pre-flight: validation, provider/key resolution, tools, system,
 * history. modelOverride lets one call use a different model than the
 * agent's default (the chat UI's per-send model picker) — and since R82,
 * a DIFFERENT PROVIDER too (the picker's provider grouping is real: the
 * override's providerId, when present, is resolved INSTEAD of the agent's
 * — every guard below (baseUrl, enabled, key) then runs against the
 * effective provider, so context window, cost, the vision relay, and the
 * retry ladder all key on the provider that actually serves the call). */
async function prepareTurn(
  db: SqliteDatabase,
  keyring: ProviderKeyring,
  sessionId: string,
  modelOverride?: TurnModelOverride,
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
  /** ROUND-72 (R72-a): the CURRENT turn's incoming user message text — the
   * `content` the turn runners received (raw, nothing stripped). prepareTurn
   * runs BEFORE the message.user event is appended, so the incoming text
   * can only arrive here, not from the event log. Used solely to compute the
   * per-turn task hints (computeTaskHints — deterministic, free); absent on
   * no-message callers (none today) → no hints, byte-identical prompt. */
  turnUserMessage?: string,
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
  // ROUND-92 (R92-B, the owner's v0.89.0 dead-end report: "Generation failed:
  // agent acute has no provider ID/model configured" even after picking the
  // new provider's model in the composer): the OVERRIDE-FIRST gate. R91-A's
  // force-delete resets referencing agents to provider_id = NULL, model =
  // NULL (resetAgentsProvider) — a state no mainstream flow produced before.
  // The old gate checked the AGENT ROW here, BEFORE the per-send override was
  // normalized below, so a send that carried a complete {model, providerId}
  // pair (the picker writes it on EVERY send since R82) could never satisfy
  // it: the dead end. The normalization now runs FIRST and the gate fires only
  // when the EFFECTIVE pair is incomplete. A half-pair override (model without
  // providerId, or vice versa) still 409s with the same message: "agent 'X'
  // has no providerId/model configured" remains TRUE then — the send didn't
  // carry a complete pair either. A CONFIGURED agent + no override is
  // byte-for-byte the old behavior (overrideNorm undefined → the agent row
  // decides).
  //
  // ROUND-114 (R114-b): a NEW middle tier — the session's SERVER-SIDE selected
  // model (sessions.model_provider + model_id, migration 0041; PATCH
  // /sessions/:id { model } sets it). The resolution is now THREE-tier,
  // strictly in this order: per-send override → session.selectedModel → agent
  // row. Rationale: the desktop's pick used to live only in localStorage, so
  // the phone ("Auto"), a fresh browser, and the CLI silently disagreed about
  // the next turn's model; the session row is now the cross-device truth.
  // Tier semantics, side by side:
  //   · a COMPLETE send override wins outright (the one-shot pick — the
  //     override-first gate R92-B pinned, byte-identical for old callers);
  //   · a HALF override (model without providerId — the orchestrator's
  //     subagentModel string arm) contributes its model and falls through
  //     for the provider (session tier, then the agent row), mirroring how
  //     the fallback chain already worked between override and agent;
  //   · no override → session.selectedModel when set (both sides — the
  //     route only persists complete pairs), else the agent row: an
  //     absent pair composes byte-identically to the pre-R114 behavior;
  //   · the incomplete-pair 409 below fires exactly as before when the
  //     effective pair is still missing a side (e.g. the R91-A NULL agent
  //     with no session model and no override).
  const modelOverrideNorm = normalizeModelOverride(modelOverride);
  const effectiveProviderId =
    modelOverrideNorm?.providerId ?? session.selectedModel?.providerId ?? agent.providerId;
  const effectiveModelId =
    modelOverrideNorm?.model ?? session.selectedModel?.model ?? agent.model;
  if (effectiveProviderId === null || effectiveModelId === null) {
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
  // ROUND-82: the EFFECTIVE provider — the override's providerId when the
  // send carried one (the composer's provider-grouped picker), else the
  // agent's. Every guard below runs against this, so a custom provider is
  // resolved, enabled-checked, and key-checked exactly like the agent's own.
  const overrideNamesProvider = modelOverrideNorm?.providerId !== undefined;
  const provider = resolveProvider(db, effectiveProviderId);
  if (provider === undefined || provider.baseUrl === null) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message:
          overrideNamesProvider
            ? `model override references provider '${effectiveProviderId}' without a usable baseUrl`
            : `agent '${agent.name}' references provider '${agent.providerId}' without a usable baseUrl`,
        details: { agentId: agent.id, providerId: effectiveProviderId },
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
  // ROUND-92 (R92-D, the owner's multi-key pool): resolve the provider's
  // DEDUPED key pool — the primary (slot 0) plus every ACUTE_PROVIDER_<ID>_SLOT<N>
  // the shell injected, with duplicate VALUES collapsed (the same key saved
  // into two slots is ONE key). A turn is only keyless when the pool is
  // EMPTY. The pre-R92 message named the env var; the owner-facing fix
  // points at the UI where keys are added now (the shell persists them via
  // Credential Manager — the env var is an implementation detail of the
  // spawn injection, not something the owner should hand-set).
  const keyPool = resolveKeyPool(keyring, provider.id);
  if (keyPool.length === 0) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message:
          `no API key for provider '${provider.id}' — ` +
          "add one or more keys in Settings → Models & Providers",
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
  // ROUND-98 (R98-F3): AUTO-INDEX — the cheapest honest hook for the index's
  // background freshness keeper (the owner: "Look into indexing… essential
  // for larger projects with a lot of files, folders, subfolders"). ONE SQL
  // staleness probe per turn; when the project's index rows are missing or
  // >10 minutes stale, a guarded fire-and-forget reindexProject is scheduled
  // (setImmediate — the walk lands in the event loop's idle stretch, never
  // in the turn's critical path). In-flight + attempt-cooldown guards keep
  // it to at most one background walk per project at a time, retried at
  // most once per 10 minutes; failures are swallowed (search_symbols
  // reports the honest state; index_project is the manual refresher).
  // prepareTurn runs for EVERY turn (sync + streamed + sub-agent children)
  // — the staleness gate is what makes this "first turn + every 10 minutes"
  // rather than "every turn".
  if (project !== undefined) {
    maybeAutoIndexProject(db, project.id, project.rootPath);
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
  // ROUND-117 (R117-b): the dead flag comes ALIVE — agents.memory_policy
  // now governs digest injection (and the memory_* tool registration — the
  // policy rides toolDeps below; the memory plugin drops its whole family
  // on 'none', the honest tool-drop exactly like the master switch):
  //   · 'none'       → no digest, no memory tools, for that agent's sessions;
  //   · 'on-start'   → the digest flows ONLY on the session's FIRST turn
  //                    (sessionHasUserTurn: both turn runners append the
  //                    turn's message.user event AFTER prepareTurn, so "no
  //                    prior user event" IS "this is the first turn" — no
  //                    extra session flag needed);
  //   · 'every-turn' → every turn (the pre-R117 behavior, the CREATE default).
  // The policy can only NARROW the master switch's on-state; a disabled
  // memory system stays fully dark regardless of policy.
  const memoryPolicy: MemoryPolicy = agent.memoryPolicy;
  const memoryDigestOn =
    memoryEnabled &&
    !isChild &&
    session.projectId !== null &&
    memoryPolicy !== "none" &&
    (memoryPolicy === "every-turn" ||
      (memoryPolicy === "on-start" && !sessionHasUserTurn(db, session.id)));
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
    // ROUND-117 (R117-b): the agent's memory policy rides the deps so the
    // memory plugin can drop the whole family on 'none' (the honest
    // tool-drop — see the memoryDigestOn block above for the digest half).
    memoryPolicy,
    // ROUND-50 (R50-c1): the permission mode rides the deps so the approval
    // gates can widen ("full" auto-approves ask-tier decisions; the
    // denylist-supreme refusals stay hard in every mode — approvals.ts).
    permissionMode,
    // ROUND-61 (R61): the turn's main model for the computer-use vision
    // relay ("main" mode = describe screenshots with THIS model when its
    // row supports vision). providerId/model are the EFFECTIVE pair resolved
    // above (override or agent defaults — non-null by the override-first
    // gate; an override on a NULL agent flows through here too, ROUND-92).
    mainModel: {
      providerId: effectiveProviderId,
      modelId: effectiveModelId,
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
  // ROUND-73 (R73-b): the TASK-MODE resolution — ONE call, the same
  // resolver switch_mode and the /modes route sit on (builtins always; the
  // project's .acute/agents/*.md customs + shadowing when a root exists).
  // It must run BEFORE buildProjectTools because a FILE-mode's frontmatter
  // `tools` list NARROWS the allowlist (a custom mode can only narrow, never
  // widen — the permission-mode rule, applied one step later). Builtins
  // declare no tools → no narrowing, byte-identical toolset.
  const modeResolution = resolveEffectiveModes(project !== undefined ? project.rootPath : undefined);
  // ROUND-73 (R73-b): the session's ACTIVE mode — session.activeMode
  // (PATCH /sessions/:id or switch_mode) resolved through the same list. A
  // mode that no longer resolves (its .acute/agents file was removed) is
  // STALE: best-effort clear the row (the storage-level writer, updated_at
  // bump included) and carry the honest note for THIS turn only — the
  // session keeps running in the default posture instead of silently
  // resurrecting a vanished guide.
  let activeTaskMode: TaskMode | undefined;
  let clearedModeNote: string | undefined;
  if (session.activeMode !== null) {
    activeTaskMode = findMode(modeResolution.modes, session.activeMode);
    if (activeTaskMode === undefined) {
      updateSessionActiveMode(db, session.id, null);
      clearedModeNote =
        `task mode '${session.activeMode}' from a previous turn no longer exists ` +
        "(its .acute/agents file was removed) — active mode cleared";
    }
  }
  const allowListWithTaskMode = narrowAllowListByTaskMode(allowListWithMode, activeTaskMode);
  // ROUND-81 (R81, ADR-0029): the task-mode POLICY tier is RETIRED —
  // enforcement now lives ENTIRELY in the operating mode (full/ask/plan
  // above). Postures are non-enforcing guidance the agent self-selects
  // (switch_mode); a read-only PLAN session is narrowed by the permission
  // gate BEFORE this point, so the toolset below is the final one. The R73
  // frontmatter `tools` narrowing above survives (opt-in, custom-file only,
  // narrow-only — the extension surface documented in EXTENSIBILITY.md).
  const tools =
    project !== undefined
      ? await buildProjectTools(project.rootPath, allowListWithTaskMode, toolDeps)
      : undefined;
  // ROUND-70 (R70-c, D1): the turn's REAL environment — OS/shell/date/git,
  // computed here (per turn, never cached across turns, never blocking:
  // the git probe degrades to honest fallback strings). Projectless
  // sessions run agent.systemPrompt — no environment to ground.
  const environment = project !== undefined ? await buildPromptEnvironment(project.rootPath) : undefined;
  // ROUND-40: the system prompt's toolNames must reflect the EXACT tool set the
  // model will actually receive. The old code rebuilt tools from
  // `agent.allowedTools` here — for a child that lied in two ways: (a) it
  // included delegate_task (children don't get it), and (b) for the default
  // agent ([] = ALL) it would have listed delegate_task too. Reuse the already-
  // built `tools` object so the prompt and the live toolset are always in sync.
  // ROUND-72 (R72-a): the effective skills hoisted — the SAME list feeds the
  // prompt's SKILLS section and the task-hint matcher, so a hint can never
  // name a skill the section doesn't list (one resolver, one truth; the
  // computer-use gate + agent allowlist are respected by construction).
  // ROUND-98 (R98-E2): the always-load tier rides the SAME resolution — the
  // map no longer strips the pinned fields: a skill resolveEffectiveSkills
  // marked alwaysLoad carries its FULL body (loaded from the same source
  // read_skill uses), and prompts.ts composes it into the "## ALWAYS-ON
  // SKILLS" section. This is the ONLY runtime change the tier needed — the
  // resolution itself (DB column, file frontmatter, shadow precedence,
  // gates) already lives in storage/skills-files.ts, so read_skill,
  // search_skills, the prompt index, and the pinned bodies can never
  // disagree. Unpinned entries keep the exact pre-R98 {name, description}
  // shape (the fields are conditionally spread, never set to undefined).
  const effectiveSkills = resolveEffectiveSkills(db, {
    ...(project !== undefined ? { projectRoot: project.rootPath, projectScope: project.id } : {}),
    ...(agent.skills.length > 0 ? { agentSkills: agent.skills } : {}),
  }).map((skill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.alwaysLoad === true
      ? { alwaysLoad: true, ...(skill.body !== undefined ? { body: skill.body } : {}) }
      : {}),
  }));
  // ROUND-72 (R72-a): the per-turn task hints — this turn's user message
  // scored against those same descriptions (pure deterministic matching,
  // zero cost). EPHEMERAL: rendered into this turn's system prompt only,
  // never persisted. No message (or no matching signal) → undefined/empty →
  // no advisory line, byte-identical composition.
  const taskHints =
    turnUserMessage !== undefined ? computeTaskHints(turnUserMessage, effectiveSkills) : undefined;
  // ROUND-73 (R73-b): the per-turn MODE hints — the same message scored
  // against the resolved task modes' descriptions (computeModeHints, the
  // R72-a scorer reused verbatim). EPHEMERAL like taskHints: rendered into
  // this turn's TASK MODES section, never persisted, never auto-activated.
  const modeHints =
    turnUserMessage !== undefined ? computeModeHints(turnUserMessage, modeResolution.modes) : undefined;
  // ROUND-79 (R79-a): the per-turn BACKGROUND TASKS reminder — this
  // session's children WITH a delegate_task_id whose reports have NOT been
  // collected yet (no delegation.collected event on THIS session's log
  // naming the child). The CHEAP GUARD runs first inside the builder (one
  // indexed LIMIT 1 probe), so a session without addressed children —
  // every pre-R79 session, every ordinary turn — composes byte-identically
  // at negligible cost. EPHEMERAL like taskHints/modeHints: rebuilt from
  // live rows every turn, rendered into THIS turn's system prompt only,
  // never persisted (the event log owns the durable collected markers).
  const backgroundTasks = buildBackgroundTasksReminder(db, session.id);
  // ROUND-88 (R88, owner: the floating to-do widget): the session's CURRENT
  // todo snapshot — the agent's own todo_write history OR the owner's manual
  // edit (the widget's route). Non-empty → the CURRENT TODO LIST prompt
  // section (source:"user" emphasized). Cheap: one backward walk of the
  // session's events (latestTodoSnapshot returns at the first hit).
  const todoList = latestTodoSnapshot(db, session.id);
  const system = project
    ? buildProjectSystemPrompt({
        projectName: project.name,
        rootPath: project.rootPath,
        toolNames: tools ? Object.keys(tools) : [],
        customRules: readCustomRules(project.rootPath),
        // ROUND-70 (R70-c, D1): OS/shell/date/git grounding.
        environment,
        // Round-28 WS-F: inject the agent's maxTurns budget into the AGENTIC
        // LOOP section so the model knows how many tool round-trips it has.
        maxTurns: agent.maxTurns,
        // ROUND-70 (R70-c, D2): the outer-iteration cap, mentioned honestly
        // in the merged AGENTIC LOOP section (the same default the turn
        // runners apply — agent.maxOuterLoops ?? 5).
        maxOuterLoops: agent.maxOuterLoops ?? 5,
        // Round-28 WS-G: inject the codebase index summary (if the project
        // has been indexed) so the agent has codebase awareness without
        // needing list_dir + read_file every turn.
        indexSummary: session.projectId !== null ? getIndexSummary(db, session.projectId) ?? undefined : undefined,
        // ROUND-44 (R44-a) → ROUND-49 → ROUND-117 (R117-b): inject the newest
        // project memories so the agent starts its turn knowing the project's
        // durable knowledge — but ONLY in MAIN sessions while the memory
        // master switch is on AND the agent's memory_policy allows THIS turn
        // (memoryDigestOn above: 'none' never, 'on-start' first turn only,
        // 'every-turn' always). Sub-agent children run with independent
        // context (no digest), and a disabled memory system injects nothing
        // anywhere. The digest strings flow even when EMPTY ("" — no saved
        // memories): prompts.ts then renders the honest "No memories saved
        // yet" line so the model KNOWS the memory surface exists; the
        // undefined cases above (gates closed) compose no section at all.
        // The digest budget scales with richness (memory.ts digestBudget:
        // 1,500 chars at ≤30 rows, 3,000 beyond).
        memoryDigest:
          memoryDigestOn && session.projectId !== null
            ? memoryDigest(db, session.projectId)
            : undefined,
        // ROUND-117 (R117-b): the WORKSPACE digest — the cross-project tier
        // (the owner's identity/preferences/environment truths, curated via
        // REST). Composes ABOVE the project digest under the SAME gates
        // (prompts.ts renders "## Workspace memory" over "## Project
        // memory"); "" when the tier is empty (the honest-empty line still
        // renders when BOTH tiers are empty).
        memoryWorkspaceDigest: memoryDigestOn ? workspaceMemoryDigest(db) : undefined,
        // ROUND-50 (R50-c1): narrate the active permission mode (full/plan/
        // editor; "ask" stays silent — the default posture is already
        // narrated by the TERMINAL/WEB ACCESS sections). The toolNames list
        // above already reflects the post-mode tool set (the tools object
        // was built from the mode-filtered allowlist).
        permissionMode,
        // ROUND-61 (R61) → ROUND-70 (R70-b): the enabled-skills index
        // (progressive disclosure — names + one-liners; bodies load via
        // read_skill). Resolution goes through the ONE shared resolver
        // (storage/skills-files.ts) so the prompt and read_skill can never
        // disagree:
        //   · D1 — file-based skills (project .acute/skills/ + user-global
        //     ~/.agents/skills/) join the DB skills (DB rows shadow files;
        //     project beats global);
        //   · D4 — the computer-use builtin is gated out while the master
        //     switch is off (its tools are dark; read_skill refuses it too);
        //   · D5 — a NON-EMPTY agent.skills allowlist filters the set by
        //     name (per-agent curation; empty/undefined = all — the field
        //     was stored since R61 but never read until now).
        // ROUND-72 (R72-a): the hoisted effectiveSkills + the task hints
        // computed against the turn's user message (see above).
        skills: effectiveSkills,
        // ROUND-72 (R72-a): the advisory "Task signal" line's payload —
        // undefined/empty (no message, or no skill scored) composes nothing.
        ...(taskHints !== undefined && taskHints.length > 0 ? { taskHints } : {}),
        // ROUND-73 (R73-b): the TASK MODES section's payload — the
        // available-mode index (id+name+description, the switch_mode
        // vocabulary), the per-turn mode hints (undefined/empty composes no
        // signal line), the ACTIVE mode's deep module (absent while
        // modeless), and the one-turn honest note when a stale active mode
        // was cleared above. Every field strictly gated: a caller without
        // them composes byte-identically (the golden fixture's proof).
        taskModes: modeResolution.modes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description,
        })),
        ...(modeHints !== undefined && modeHints.length > 0 ? { modeHints } : {}),
        // ROUND-79 (R79-a): the BACKGROUND TASKS section's payload — this
        // turn's uncollected addressed delegations. Strictly optional
        // spread like taskHints/modeHints: undefined or empty composes
        // nothing (byte-identical; the golden fixture's proof).
        ...(backgroundTasks !== undefined && backgroundTasks.tasks.length > 0
          ? { backgroundTasks }
          : {}),
        // ROUND-88 (R88): the CURRENT TODO LIST section's payload — the
        // latest snapshot when one EXISTS and is non-empty (an empty array is
        // the widget's "cleared" state → no section, byte-identical).
        ...(todoList !== undefined && todoList.todos.length > 0 ? { todoList } : {}),
        ...(activeTaskMode !== undefined
          ? { activeTaskMode: { id: activeTaskMode.id, name: activeTaskMode.name, body: activeTaskMode.body } }
          : {}),
        ...(clearedModeNote !== undefined ? { clearedModeNote } : {}),
        computerUse: (() => {
          const cu = getComputerUseSettings(db);
          return { enabled: cu.enabled, posture: cu.permission };
        })(),
        // ROUND-94 (R94-G wiring): the session's vision path for the
        // CAPABILITIES section (no-vision → the one-line "never call
        // screenshot tools" instruction; vision → the converse MAY line).
        // The EFFECTIVE pair (the send's override when present — the same
        // pair the turn runs with) — a queued continuation turn's override
        // re-resolves per turn here too.
        hasVisionPath: sessionHasVisionPath(db, {
          providerId: effectiveProviderId,
          modelId: effectiveModelId,
        }),
        // ROUND-65 (R65) → ROUND-66 (R66, C1): the debug-mode switch
        // (Settings → Advanced). The R65 prompt-side self-report is GONE —
        // the agent's prompt never changes. The flag is threaded for the
        // ROUTE-side post-turn debug analyst (server.ts's runDebugAnalystPhase:
        // a fresh context-free model call over the whole transcript, streamed
        // into a dedicated section; never fed back into the history).
        debugMode: getDebugSettings(db).enabled,
      })
    : agent.systemPrompt;
  return {
    session,
    agent,
    // ROUND-37: apiFormat rides along so chat.ts can branch per provider
    // (chat-completions | anthropic-messages | responses).
    provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
    // ROUND-92 (R92-D): the first pool key (compat field — see PreparedTurn)
    // and the full pool for the runners' juggling.
    apiKey: keyPool[0]!.key,
    keyPool,
    // ROUND-92 (R92-B): the EFFECTIVE model — the override's when the send
    // carried one, the agent's otherwise; non-null by the override-first gate
    // (an override model on a NULL agent flows to the chat adapters exactly
    // like a configured agent's default does).
    model: effectiveModelId,
    // ROUND-114 (R114-b): the EFFECTIVE provider id rides PreparedTurn so
    // the streamed runner's turn.started frame can name the provider that
    // will actually serve the call without re-deriving the tier ladder.
    providerId: effectiveProviderId,
    tools,
    system,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    // ROUND-95 (R95-E): the effective model's DETECTED reasoning capability
    // — a plain storage read (null = unknown; the R95-B contract says the
    // consumer NEVER blocks on it). Resolved for the OVERRIDE's provider+model
    // when the send carried one, the agent's otherwise — the same pair the
    // adapters below call with.
    reasoningSupport: resolveModelReasoningSupport(db, effectiveProviderId, effectiveModelId),
  };
}

/** R107-b (F4 parity): fresh read of a possibly-narrowed signal's abort
 * state. The sync loop's loop-top guard narrows `signal.aborted` to false
 * for TS's static flow, but the abort lands DURING the awaited chat call —
 * the catch must observe the LIVE value (a plain function boundary is where
 * the narrowing honestly resets). */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runSingleAgentTurn(
  deps: TurnDeps,
  sessionId: string,
  content: string,
  modelOverride?: TurnModelOverride,
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
  // ROUND-78 (R78, owner: "General Settings 重试配置"): the per-class
  // auto-retry switches, read ONCE per turn (the ladder gate below consults
  // the cache — no per-rung DB reads while a 30-minute rung waits). A
  // disabled class fails fast through the honest terminal path (attempts:1).
  const retrySettings = getRetrySettings(db);
  // ROUND-80 (R80, owner: "in the settings retry customization is
  // needed"): the CUSTOMIZABLE schedule, resolved once per turn from those
  // same settings — the ladder rungs, the total attempts, and the provider
  // call timeout all come from here now (the R75 constants are the DEFAULTS
  // the resolver falls back to, so default behavior is byte-identical).
  const retrySchedule = resolveRetrySchedule(retrySettings);
  /** R78: is auto-retry ON for this transient class? Non-transient classes
   * are already excluded by isTransientApiFailure — false here just means
   * "fail fast" for a class the owner switched off.
   * ROUND-94 (R94-D1): malformed_response defaults ON — no per-class settings
   * switch exists for it (adding one needs storage + route + UI work outside
   * this round's file ownership), and the owner's field report demands the
   * class never dead-ends ("Generation failed: unknown object"). */
  const retryClassEnabled = (cls: ProviderErrorClass): boolean =>
    cls === "rate_limit"
      ? retrySettings.autoRetryRateLimit
      : cls === "timeout"
        ? retrySettings.autoRetryTimeout
        : cls === "network"
          ? retrySettings.autoRetryNetwork
          : cls === "malformed_response"
            ? true
            : false;
  // ROUND-48 (R48-e1): forward emit AND signal into the turn prep so the
  // child's toolDeps carries both — interactiveApprovals becomes true for
  // emitted children (the owner's "sub-agents can ask for permission") and
  // run_command/web_fetch/browser_control ask-tiers wait on the owner's
  // decision instead of failing fast.
  // ROUND-50 (R50-b): NO chatStream on the sync path — a sync turn's children
  // stay sync (the orchestrator's fallback branch), preserving the exact
  // pre-R50-b behavior for channel-less runs.
  // ROUND-72 (R72-a): the turn's incoming `content` rides along so
  // prepareTurn can compute the per-turn task hints (the sync path serves
  // BOTH plain sync turns and sub-agent children — both get the advisory
  // line the same way).
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
    content,
  );
  if ("error" in prepared) return prepared.error;
  const { session, agent, provider, model, tools, system } = prepared;
  // ROUND-92 (R92-D, the owner's multi-key pool with automatic juggling):
  // the turn's key state. The turn STARTS from the orchestrator-reserved
  // slot's entry (children — load-spreading) or the primary (main turns),
  // and on a key-ATTRIBUTABLE failure (auth / rate_limit) with an UNTRIED
  // key remaining, the catch below swaps apiKey/activeKeySlot forward and
  // retries the SAME call immediately (a fresh key has fresh quota — no
  // ladder wait). activeKeySlot always names the key the CURRENT attempt
  // uses, so every recordUsage below attributes the spend to the key that
  // actually paid it (successful attempt — or the last attempted key when
  // the turn fails). One key in the pool (the common case) is byte-identical
  // to the pre-R92 single-key world: nothing to swap to.
  const startEntry = initialKeyPoolEntry(prepared.keyPool, deps.keySlot ?? 0);
  const startPoolIndex = prepared.keyPool.indexOf(startEntry);
  let apiKey = startEntry.key;
  let activeKeySlot = startEntry.slot;
  let keyRotationIndex = startPoolIndex;
  const syncStartedAt = Date.now();
  logTurnStart(session.id, agent.id, model, false);

  // First message flips a queued session to running (API.md §5 semantics).
  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  // ROUND-78 (R78): queue PRE-FLIP — deliver every lingering undelivered
  // queued message (seq order) BEFORE this turn's own user event. The
  // crash/stop recovery contract: a queue left behind by an aborted stream
  // (ABORTED keeps the queue — Stop does not purge it) or a sidecar kill
  // always eventually delivers, in order, ahead of the new message. No
  // frames are emitted on the sync path (there is no SSE here); the folded
  // event log owns the render — the flipped rows are ordinary message.user
  // events exactly where they were queued.
  deliverAllQueuedMessages(db, session.id);

  // ROUND-120 (R120-H, item 44): the resume planner's pre-turn snapshot (the
  // sync twin of the streamed runner's — the sync REST route can carry a
  // user's "continue" just as well as the SSE route does).
  const preTurnEvents = listSessionEvents(db, session.id);
  const resumeTurnContext = planResumeTurnContext(preTurnEvents, content);

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
  // ROUND-83 (R83): did ANY provider call this turn report a cached tier?
  // When NO call did, the usage row writes cachedInputTokens = NULL (the
  // shared type's documented contract — "null when the provider didn't
  // report a cached tier"), so the meter's hit-rate line renders "— not
  // reported" instead of a fabricated 0% (the audit's §2.10).
  let sawCachedReport = false;
  // ROUND-83 (R83): the sync path's SDK-call counter (the streamed path
  // always had one) — rides the usage row as provider_calls so the usage
  // screens can say "N turns · M provider calls" honestly (§2.9: a
  // 5-iteration turn records 1 "request" today — the label lied).
  let totalRequests = 0;
  let lastAssistantEvent: { seq: number; ts: string; content: string } | null = null;
  let lastError:
    | {
        ok: false;
        status: 502;
        code: "PROVIDER_ERROR";
        message: string;
        details: { providerError: string; errorClass?: ProviderErrorClass; classMessage?: string; attempts?: number };
      }
    | null = null;
  // R107-b (F5): the R80 CONTEXT/REQUEST guard stop, mirrored onto the sync
  // path (sub-agent children + the sync HTTP route) — pre-R107 these guards
  // existed ONLY in runStreamedAgentTurn, so a sync sub-agent could burn
  // unbounded provider calls with no 200-request stop and an over-budget
  // context with no honest CONTEXT_LIMIT exit. Same contract as the streamed
  // twin: the guards break the loop with this stop set, and the post-loop
  // exit persists the honest turn.error + usage + the 502 — never a silent
  // ok:true stop mid-task.
  let guardStop: { code: "CONTEXT_LIMIT" | "REQUEST_LIMIT"; message: string } | null = null;
  // R107-b (F5): the R77 blank-output guard's TURN-level tool-call count —
  // "did ANY tool run this turn" (the per-iteration result.toolCalls.length
  // the conversational-break rule reads is not that signal).
  let turnToolCalls = 0;
  // ROUND-48 (R48-e1): set when the loop exits via the between-iterations
  // abort check (a deliberate parent stop) — distinct from a provider error.
  let stoppedBySignal = false;
  // ROUND-71 (R71-e2, D5): overflow-recovery state (ONE recovery per turn —
  // cline's generateAssistantMessageWithOverflowRecovery). overflowRecovered
  // guards the once-per-turn rule; forceCompaction arms the NEXT iteration's
  // assembleWithCompaction to plan a compaction even when the internal token
  // ESTIMATE says the history fits (a provider-rejected overflow is the
  // ground truth — our ±15% estimate is the guess that missed it).
  let overflowRecovered = false;
  // ROUND-75 (R75): the transient-API retry ladder's used rungs this turn
  // (0 = none yet; capped at the resolved schedule's rung count — 5 rungs
  // → 6 total attempts at the R75 defaults, R80-customizable).
  let providerRetries = 0;
  let forceCompaction = false;
  // ROUND-94 (R94-D1, Part 2b — the owner's v0.91.0 field report: the
  // generation died mid-task with "Generation failed: unknown object", an
  // error no pattern predicted, and the turn was an INSTANT dead end): the
  // ONE unknown-class-with-PROGRESS retry on the SYNC path (sub-agent
  // children die the same way the main turn does). `unknown` stays
  // fail-fast by default (the R75 contract — no evidence waiting helps an
  // unclassified failure) EXCEPT when the dying turn already did real work
  // (persisted tool results / an assistant reply): one bounded extra
  // attempt after a short delay, then the existing honest terminal path.
  // Counted separately from providerRetries so the ladder's rung indexing
  // is untouched, but it rides the same `attempts` arithmetic so the error
  // card never under-reports what ran.
  let unknownProgressRetries = 0;
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
  // ROUND-96 (R96-B): the pending nudge's PROVENANCE — "todos" (the ONE
  // todos-continuation over an unfinished plan) or "identical_text" (the
  // guard's identical-response correction). Marks the NEXT provider call as a
  // post-final continuation: a failure on THAT call must not torch the
  // already-persisted final answer (the DeepSeek "The last message must have
  // role=user" report — the turn completed, then the forced extra call
  // failed, and the UI said "Generation failed" over finished work).
  let pendingNudgeKind: "todos" | "identical_text" | null = null;
  let postFinalContinuation = false;
  // ROUND-96 (R96-B): the todos-continuation + the identical-text nudge are
  // each ONE per turn (bounded by construction — see the completion rule at
  // the loop bottom).
  let todosContinuationUsed = false;
  let identicalTextNudgeUsed = false;
  // ROUND-51 (R51-f): the loop-hygiene guard (per-turn — see the section
  // comment near createLoopGuard). The sync path observes each executed call
  // in the post-call audit loop below (one feed per call — onStepFinish live
  // frames carry the same calls and are NOT double-counted).
  // ROUND-96 (R96-B): WARN-ONLY (the owner's directive) — the guard's warns
  // persist turn.warning events + nudge the next iteration; nothing stops.
  const loopGuard = createLoopGuard();
  let guardNudge: ChatTurnMessage | null = null;
  // ROUND-120 (R120-H, item 43): the ITERATION_LIMIT + blank-tail flags —
  // the sync twin of the streamed runner's (a sub-agent child hitting the
  // cap mid-work used to return ok:true to the parent, which marked the
  // half-done child completed — the exact R75 "sub-agent completed" lie
  // pattern; the honest stop mirrors the streamed law).
  let loopCapMidWork = false;
  let blankTailContinuationUsed = false;

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
    // ROUND-120 (R120-H, item 44): the resume turn's widened fidelity window
    // (the streamed twin's contract — the sync REST route's "continue" rides
    // the same working-context hand-over).
    const rawMessages = assembleHistory(
      db,
      session.id,
      resumeTurnContext !== null ? { recentToolResults: resumeTurnContext.recentToolResults } : undefined,
    );
    // ROUND-83 (R83): the shared budget — resolveTurnBudget honors the
    // owner's per-model max_output_tokens (the audit's §2.8) and is the
    // SAME number the context meter reports (§2.5: one truth).
    const budget: TurnBudget = resolveTurnBudget(db, provider.id, model);
    // ROUND-46 (R46-b): compaction instead of a silent hard trim. The sync
    // path (sub-agents) has no SSE emit — the compacted event lands in the
    // session log either way and later iterations reuse it.
    // ROUND-71 (R71-e2, D5): forceCompaction is armed by the overflow-
    // recovery path below (provider-rejected overflow → force a compaction
    // on this retry regardless of the estimate).
    // ROUND-125 (R125-C, D1): the provider-usage token anchor — ZCode
    // methods/compact.ts buildProviderUsageTokenOverride's law: the last
    // persisted usage-bearing assistant event's PROVIDER-reported
    // inputTokens + the estimated tail after it replaces the local estimate
    // in the over-budget gate (the estimate stays the fallback; null when
    // the session has no usage row yet). The extra event-log read is the
    // price of the pure, jest-pinnable seam — the same SELECT
    // assembleHistory and assembleWithCompaction already run this iteration.
    const anchor = providerUsageAnchor(listSessionEvents(db, session.id), rawMessages);
    const { messages } = await assembleWithCompaction(
      rawMessages,
      budget,
      {
        db,
        sessionId: session.id,
        chat,
        provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
        apiKey,
        model,
      },
      // R125-C (D1): the anchor threads as tokenOverride; an empty object
      // is behavior-identical to the old `undefined` (planCompaction gates
      // on force === true and a finite-positive override).
      {
        ...(forceCompaction ? { force: true } : {}),
        ...(anchor !== null ? { tokenOverride: anchor } : {}),
      },
    );
    forceCompaction = false;
    if (pendingNudge !== null) {
      messages.push(pendingNudge);
      pendingNudge = null;
      // ROUND-96 (R96-B): a todos/identical-text nudge riding THIS call makes
      // it a post-final continuation (see the state comment above) — its
      // failure must never fail the already-completed turn.
      postFinalContinuation = pendingNudgeKind !== null;
      pendingNudgeKind = null;
    } else {
      postFinalContinuation = false;
    }
    // ROUND-51 (R51-f): the loop guard's nudge rides the same in-memory path
    // as the intent nudge (next iteration only, never persisted). Mutually
    // exclusive with it by construction: the intent nudge fires only on
    // zero-tool iterations, the guard nudge only on tool-using ones.
    if (guardNudge !== null) {
      messages.push(guardNudge);
      guardNudge = null;
    }
    // ROUND-120 (R120-H, item 44): the resume note rides every iteration of
    // the resume turn (in-memory only — the streamed twin's contract).
    if (resumeTurnContext !== null) {
      messages.push({ role: "user", content: resumeTurnContext.note });
    }
    // ROUND-96 (R96-B): the MESSAGES-SHAPE GUARANTEE — no provider call ever
    // goes out assistant-last (DeepSeek@OpenRouter rejects the shape with a
    // deterministic 400: "The last message must have role=user"; the
    // todos-continuation, queued-message flips, and sub-agent histories can
    // all assemble that way). Belt-and-suspenders at EVERY call boundary.
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      messages.push({ role: "user", content: ASSISTANT_LAST_SHAPE_NUDGE });
    }

    // ── R107-b (F5): the R80 guard stops, MIRRORED from the streamed runner
    // (verbatim contract — model-relative budget, 200-request ceiling, the
    // honest guardStop exit instead of a silent ok:true). The sync path
    // serves EVERY sub-agent child and the sync HTTP route; pre-R107 a sync
    // sub-agent could burn unbounded calls with no request stop at all. ──
    const usedTokens = estimateMessageTokens(messages);
    // Context guard (6-f R-F5 → ROUND-83 → R107-b sync parity): abort if the
    // assembled context exceeds the model's OWN budget line (window − output
    // reserve − margin — the same `available` the compaction trigger and the
    // donut's budget marker use; ONE truth).
    if (usedTokens > budget.available) {
      emit?.({ type: "meta.context_limit", sessionId: session.id, tokens: usedTokens, limit: budget.available });
      guardStop = {
        code: "CONTEXT_LIMIT",
        message:
          `the turn's assembled context exceeded the model's budget for session ${session.id} ` +
          `(${usedTokens} tokens > ${budget.available} available of a ${budget.contextWindow}-token window) — ` +
          "start a new session, or compact the older context (POST /sessions/:id/compact)",
      };
      break;
    }
    // Request guard (6-f R-F6 → R107-b sync parity): abort if > 200 total
    // requests (OpenRouter rate limits apply even on 0-cost models). The
    // follow-up message continues from the event log.
    if (totalRequests > 200) {
      emit?.({ type: "meta.request_limit", sessionId: session.id, requests: totalRequests, limit: 200 });
      guardStop = {
        code: "REQUEST_LIMIT",
        message: `the turn exceeded 200 provider requests (${totalRequests}) for session ${session.id} — send a follow-up message to continue from where it stopped`,
      };
      break;
    }

    const startedAt = Date.now();
    let result: ChatTurnOutput;
    try {
      // ROUND-83 (R83): one SDK call per outer iteration (the streamed path's
      // counter parity — rides the usage row as provider_calls).
      totalRequests++;
      result = await chat({
        provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
        apiKey,
        model,
        system,
        messages,
        temperature: agent.temperature,
        maxTurns: agent.maxTurns,
        // ROUND-80 (R80): the CUSTOMIZABLE provider-call ceiling (Settings
        // → General → retry config; 600 s = the old hardcoded default).
        timeoutMs: retrySchedule.timeoutMs,
        // R107-b (F4): the turn's stop surface threads into the SYNC adapter
        // too — aiSdkChat combines it with the timeout signal (the streamed
        // twin's pattern), so an owner Stop / parent cascade / supervisor
        // stall abort reaches the IN-FLIGHT call instead of waiting out the
        // full ceiling. Absent (plain callers) → byte-identical behavior.
        ...(signal !== undefined ? { signal } : {}),
        ...(tools !== undefined ? { tools } : {}),
        // ROUND-50 (R50-c1): the per-send thinking level (chat-completions
        // reasoning.effort injection — see chat.ts buildThinkingFetch).
        ...(prepared.thinkingLevel !== undefined ? { thinkingLevel: prepared.thinkingLevel } : {}),
        // ROUND-95 (R95-E): the model's detected reasoning capability — the
        // sync sub-agent path threads it too, so a child's chat-completions
        // call maps its (parent-inherited-absent, so usually absent) level
        // onto the model's own ladder exactly like the streamed path would.
        ...(prepared.reasoningSupport !== null ? { reasoningSupport: prepared.reasoningSupport } : {}),
        // ROUND-96 (R96-J): the resolved output cap rides the wire as
        // max_tokens when the SDK sends none (the paid-model credits catch
        // — OpenRouter prices an unspecified cap at the model's FULL default).
        maxOutputTokens: budget.maxOutputTokens,
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
      // R107-b (F4 parity): a deliberate stop surfacing as the SDK's abort
      // throw (the signal now reaches generateText) is NOT a provider
      // failure — mirror the streamed catch's early signal check so an
      // owner-stop mid-call routes straight to the loop-top ABORTED path,
      // never through the ladder's phantom "retrying" frame (an AbortError
      // would otherwise classify as `timeout` — transient — and burn a rung
      // before the abort-aware wait releases). The helper reads the LIVE
      // state: TS narrows `signal.aborted` to false after the loop-top
      // guard, but the abort lands DURING the awaited call.
      if (isSignalAborted(signal)) {
        stoppedBySignal = true;
        break;
      }
      const normalized = error instanceof Error ? error : new Error(String(error));
      // ROUND-71 (R71-e2, D5): context-window OVERFLOW RECOVERY — classify
      // the failure; when the provider itself rejected the request as too
      // large (and nothing from this call reached the log yet), force a
      // compaction and RETRY once instead of dying. One recovery per turn;
      // a second overflow lands in the honest terminal message below.
      const classified = classifyProviderError(normalized);
      // ROUND-78 (R78): the real-text userMessage must be key-scrubbed at THIS
      // boundary — the pure classifier cannot know the key (its signature is
      // deliberately key-less), so every emission below uses this scrubbed
      // line (the same rule providerError already follows; a raw provider
      // body quoting the key must never reach a frame or an envelope).
      const classMessage = scrubSecrets(classified.userMessage, keySecrets);
      // R105-C: the LESSON write — every rate_limit whose body/status says
      // WHY (quota | rate | capacity) upserts the (provider, model, reason)
      // row (migration 0039). Placed BEFORE the key-swap branch so a lesson
      // lands even when a pool juggle handles the failure; write-only
      // telemetry (recordProviderLesson never throws), no UI this round.
      if (classified.class === "rate_limit" && classified.rateLimitReason !== undefined) {
        recordProviderLesson(db, provider.id, model, classified.rateLimitReason);
      }
      // ── ROUND-96 (R96-B): a POST-COMPLETION failure must not fail the
      // turn. The owner's exact report: "The agent completed its task
      // properly and finished the chat properly but after it completed it,
      // it said that there was an error… The last message must have
      // role=user. / Attempts: 2". The failing call here was a CONTINUATION
      // launched after the model's final answer was already persisted (the
      // todos-continuation / the identical-text nudge — pre-R96-B it was the
      // phrase-gate continuation). The completed answer stands; the honest
      // residue is a non-fatal turn.warning, never a "Generation failed"
      // card over finished work. ──
      if (postFinalContinuation && lastAssistantEvent !== null) {
        persistLoopWarning(db, session.id, agent.id, emit, {
          kind: "identical_text",
          message: `continuation failed after the completed answer — ${classMessage} (the answer above stands)`,
        });
        if (totalInputTokens > 0 || totalOutputTokens > 0) {
          recordUsage(
            db,
            {
              agentId: agent.id,
              sessionId: session.id,
              provider: provider.id,
              model,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
              costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
              ts: lastAssistantEvent.ts,
            },
            activeKeySlot,
            { providerCalls: totalRequests, origin: "turn" },
          );
        }
        touchSession(db, session.id);
        if (getSession(db, session.id)?.status === "running") {
          setSessionStatus(db, session.id, "queued");
        }
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
          usage: {
            agentId: agent.id,
            sessionId: session.id,
            provider: provider.id,
            model,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
            costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
            ts: lastAssistantEvent.ts,
          },
        };
      }
      // ROUND-92 (R92-D, the owner's spec: "If one API key fails, then it
      // will automatically try the next API key in line and so forth"): the
      // API-key POOL JUGGLING. A key-ATTRIBUTABLE failure (auth — the key
      // was rejected; rate_limit — THIS key's quota is spent) with an
      // UNTRIED key left in the pool swaps apiKey/activeKeySlot forward
      // and retries the SAME call IMMEDIATELY, with NO ladder wait — a
      // fresh key has fresh quota. The compensation mirrors the ladder's
      // continue (outerIter -= 1), just with delay 0. Network / timeout /
      // context / unknown failures are NOT key-attributable: they skip this
      // branch and keep the existing overflow/ladder/terminal paths.
      // The meta.key frame (SSE) mirrors meta.retry's shape — it carries
      // pool INDEXES and the reason only, never a key value. On the plain
      // sync route emit is undefined (no SSE — nothing is emitted); an
      // emitted sub-agent child forwards the frame to the parent's stream.
      if (
        (classified.class === "auth" || classified.class === "rate_limit") &&
        keyRotationIndex + 1 < prepared.keyPool.length
      ) {
        keyRotationIndex += 1;
        apiKey = prepared.keyPool[keyRotationIndex]!.key;
        activeKeySlot = prepared.keyPool[keyRotationIndex]!.slot;
        emit?.({
          type: "meta.key",
          sessionId: session.id,
          key: {
            attempt: keyRotationIndex + 1,
            totalKeys: prepared.keyPool.length,
            reason: classified.class,
          },
          message:
            `${classMessage} — switching to API key ${keyRotationIndex + 1} of ${prepared.keyPool.length} ` +
            `(${classified.class === "auth" ? "key rejected" : "key rate limited"}), retrying immediately`,
        });
        log("warn", "provider.key_swap", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
          keyIndex: keyRotationIndex + 1,
          totalKeys: prepared.keyPool.length,
          reason: classified.class,
        });
        // The immediate retry re-runs THIS iteration (the ladder's
        // compensation pattern, delay 0 — bounded by the pool size).
        outerIter -= 1;
        continue;
      }
      if (
        classified.class === "context_window_exceeded" &&
        !overflowRecovered &&
        // A retry iteration must REMAIN — a recovery `continue` on the last
        // iteration would otherwise fall out of the loop with no error set
        // (the turn must never swallow an overflow as a fake success).
        outerIter < maxOuterLoops - 1 &&
        liveStepsEmitted === 0
      ) {
        overflowRecovered = true;
        forceCompaction = true;
        // The visible recovery note (the same meta-frame pattern as
        // meta.compaction / meta.context_limit — SSE-only, never persisted).
        emit?.({ type: "meta.overflow_recovery", sessionId: session.id, message: OVERFLOW_RECOVERY_NOTE });
        log("warn", "provider.overflow_recovery", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
        });
        continue;
      }
      // ROUND-75 (R75): the TRANSIENT-API RETRY LADDER — the owner's spec.
      // rate_limit / network / timeout failures retry per the schedule
      // [immediate → 1.5 min → 5 min → 10 min → 30 min → terminal]; every
      // other class (auth, overflow — handled above, unknown) fails fast.
      // The retry re-runs THIS iteration (outerIter is compensated below),
      // history re-assembles from the event log, and the SSE meta.retry
      // frames keep the stream alive + the countdown visible. A user stop
      // during the wait aborts the wait immediately and routes through the
      // loop-top signal guard (a stop is never an error).
      // ROUND-78 (R78): the per-class switches gate the ladder — a class the
      // owner switched OFF (Settings → General → retry config) skips it and
      // falls through to the honest terminal path (attempts stays 1, the
      // real provider text rides the error card).
      if (
        isTransientApiFailure(classified.class) &&
        retryClassEnabled(classified.class) &&
        providerRetries < retrySchedule.ladderMs.length
      ) {
        providerRetries += 1;
        // ROUND-96 (R96-B, the owner: "There might be some rate limiting on
        // the models... try to look into that properly too and manage them
        // accordingly"): a rate_limit failure carrying the provider's own
        // Retry-After (seconds or HTTP-date — APICallError.responseHeaders,
        // unwrapped from any RetryError by extractRetryAfterMs) REPLACES the
        // schedule rung for this attempt — the provider said when it will
        // serve us; honoring it is both faster (Retry-After 5s beats a 90s
        // rung) and kinder (retrying early just re-429s). Header-less 429s
        // keep the owner's R75 schedule; the SDK's internal maxRetries:4
        // exponential layer (2s→4s→8s→16s) already ran underneath by the
        // time we see the failure, so "exponential backoff between attempts"
        // is the COMPOSED system's property.
        const scheduleMs = retrySchedule.ladderMs[providerRetries - 1];
        const retryAfterMs = classified.class === "rate_limit" ? extractRetryAfterMs(normalized) : null;
        // R105-C: the reason-aware rung — a QUOTA rate limit (daily caps,
        // free-models-per-day, credits) floors the wait at 10 minutes
        // (retrying in 90 s against a daily cap just re-burns the attempt);
        // every other reason keeps the pre-R105 semantics byte-identical
        // (Retry-After replaces the rung when present, else the schedule).
        const waitMs = effectiveRungWaitMs(scheduleMs, retryAfterMs, classified.rateLimitReason);
        const attempt = providerRetries + 1;
        const emitRetry = (remainingMs: number): void => {
          emit?.({
            type: "meta.retry",
            sessionId: session.id,
            attempt,
            totalAttempts: retrySchedule.totalAttempts,
            waitMs,
            remainingMs,
            retryAt: Date.now() + remainingMs,
            errorClass: classified.class,
            // R105-C: the additive reason field (quota | rate | capacity —
            // present only on rate_limit) so the retry card / future
            // ModelsProviders surfacing can say WHY, not just that.
            rateLimitReason: classified.rateLimitReason,
            // R78: the scrubbed real text (see the catch's classMessage const).
            classMessage,
            // R78: the provider's REAL scrubbed error text (unwrapped from
            // any RetryError by providerErrorDetail) — the live retry card
            // shows what the API actually said, not a generic class line.
            // R92-D: scrubbed against EVERY keyring-held key (multi-key:
            // the failing attempt's key may differ from the swap target).
            providerError: scrubSecrets(providerErrorDetail(normalized, apiKey), keySecrets),
            // R96-B: the wait line names the provider-advised source when
            // the header won ("retrying after the provider's Retry-After:
            // 5 s"), else the schedule phrasing.
            message:
              retryAfterMs !== null
                ? `${classMessage} — the provider asked to wait; retrying (attempt ${attempt} of ${retrySchedule.totalAttempts}) after ${formatRetryWaitMs(waitMs)} (Retry-After)`
                : `${classMessage} — retrying (attempt ${attempt} of ${retrySchedule.totalAttempts}) in ${formatRetryWaitMs(remainingMs)}`,
          });
        };
        emitRetry(waitMs);
        log("warn", "provider.retry_ladder", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
          attempt,
          totalAttempts: retrySchedule.totalAttempts,
          waitMs,
          errorClass: classified.class,
          // R105-C: the reason rides the structured log (and the lessons
          // row) so post-hoc analysis can separate quota burn from
          // throttling without re-reading provider bodies.
          rateLimitReason: classified.rateLimitReason,
        });
        registerActiveRetryWait({
          sessionId: session.id,
          attempt,
          totalAttempts: retrySchedule.totalAttempts,
          waitMs,
          startedAt: Date.now(),
          until: Date.now() + waitMs,
        });
        const waitOutcome = await waitForRetry({ waitMs, signal, onTick: emitRetry });
        clearActiveRetryWait(session.id);
        // ROUND-92 (R92-D): the ladder retry starts a FRESH pool rotation
        // from the ORIGINAL key (the documented choice: the wait may
        // outlive the quota window, and the original key is the preferred
        // one — children: the reserved slot; main turns: the primary). If
        // the retried call fails key-attributably again, the rotation
        // re-engages from scratch (each rung may burn the whole pool once).
        apiKey = prepared.keyPool[startPoolIndex]!.key;
        activeKeySlot = prepared.keyPool[startPoolIndex]!.slot;
        keyRotationIndex = startPoolIndex;
        if (waitOutcome === "completed") {
          // The retry re-runs THIS iteration — compensate the for-increment
          // so the ladder never spends the outer-loop budget (bounded by
          // providerRetries, never infinite). (An abort landing in the
          // deadline race still self-corrects: the next call throws on the
          // aborted signal and the catch routes to ABORTED.)
          outerIter -= 1;
        }
        // Aborted during the wait (user stop) → the plain continue: the
        // loop-top signal guard breaks out and the stopped flow returns the
        // honest ABORTED outcome.
        continue;
      }
      // ── ROUND-94 (R94-D1, Part 2b): the ONE unknown-with-PROGRESS retry.
      // The ladder above only serves the transient classes; `unknown` stays
      // fail-fast by R75's contract — EXCEPT when the dying turn already did
      // real work (a previous iteration's persisted tool results / assistant
      // reply; lastAssistantEvent non-null is exactly that signal on the
      // sync path — every completed iteration ends with its assistant
      // append). The owner's dead end was precisely this shape: sub-agents
      // had run, work was real, and an unclassifiable provider error
      // ("Generation failed: unknown object") torched it instantly. ONE
      // bounded extra attempt after a short wait, visible on the stream,
      // then the existing honest terminal path below. ──
      if (
        classified.class === "unknown" &&
        unknownProgressRetries === 0 &&
        lastAssistantEvent !== null &&
        // A retry iteration must REMAIN (the overflow guard's rule — a
        // recovery `continue` on the last iteration would fall out of the
        // loop with no error set, faking success).
        outerIter < maxOuterLoops - 1
      ) {
        unknownProgressRetries = 1;
        emit?.({
          type: "meta.retry",
          sessionId: session.id,
          // The single extra attempt: 2 of 2 — the card the UI already
          // renders (attempt/totalAttempts/waitMs/…), the same frame shape
          // the ladder emits, so no frontend change is needed.
          attempt: 2,
          totalAttempts: 2,
          waitMs: UNKNOWN_PROGRESS_RETRY_MS,
          remainingMs: UNKNOWN_PROGRESS_RETRY_MS,
          retryAt: Date.now() + UNKNOWN_PROGRESS_RETRY_MS,
          errorClass: classified.class,
          classMessage,
          providerError: scrubSecrets(providerErrorDetail(normalized, apiKey), keySecrets),
          message: `${classMessage} — provider error, retrying (attempt 2 of 2) in ${formatRetryWaitMs(UNKNOWN_PROGRESS_RETRY_MS)}`,
        });
        log("warn", "provider.unknown_progress_retry", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
          attempt: 2,
          waitMs: UNKNOWN_PROGRESS_RETRY_MS,
          errorClass: classified.class,
        });
        registerActiveRetryWait({
          sessionId: session.id,
          attempt: 2,
          totalAttempts: 2,
          waitMs: UNKNOWN_PROGRESS_RETRY_MS,
          startedAt: Date.now(),
          until: Date.now() + UNKNOWN_PROGRESS_RETRY_MS,
        });
        const waitOutcome = await waitForRetry({ waitMs: UNKNOWN_PROGRESS_RETRY_MS, signal });
        clearActiveRetryWait(session.id);
        // The fresh pool rotation the ladder uses (the wait may outlive a
        // quota window; the original key is the preferred one).
        apiKey = prepared.keyPool[startPoolIndex]!.key;
        activeKeySlot = prepared.keyPool[startPoolIndex]!.slot;
        keyRotationIndex = startPoolIndex;
        if (waitOutcome === "completed") {
          // Re-run THIS iteration — compensated like every recovery path so
          // the extra attempt never spends the outer-loop budget.
          outerIter -= 1;
        }
        // Aborted during the wait → the loop-top signal guard owns the
        // honest ABORTED outcome.
        continue;
      }
      lastError = {
        ok: false,
        status: 502,
        code: "PROVIDER_ERROR",
        message: providerFailureMessage(provider.id, session.id, classified, overflowRecovered, providerRetries + unknownProgressRetries + 1),
        // R71-e2 D4: the class + the class-specific honest line ride the
        // envelope additively (existing readers only look at providerError).
        // R75: attempts (ladder rungs used + the initial call) — additive.
        details: {
          // R92-D: scrubbed against every keyring-held key (multi-key world).
          providerError: scrubSecrets(providerErrorDetail(normalized, apiKey), keySecrets),
          errorClass: classified.class,
          // R78: the scrubbed real text (the catch's classMessage const).
          classMessage,
          // R75: the total attempts (ladder rungs + the R94-D1 unknown
          // progress retry + the initial call) — the card's honest count.
          attempts: providerRetries + unknownProgressRetries + 1,
        },
      };
      break;
    }
    const ms = Date.now() - startedAt;
    totalInputTokens += result.usage.inputTokens;
    totalOutputTokens += result.usage.outputTokens;
    totalCachedInputTokens += result.usage.cachedInputTokens ?? 0;
    // ROUND-83 (R83): undefined cachedInputTokens = the provider didn't
    // report a cache tier (chat.ts maps usage.inputTokenDetails.
    // cacheReadTokens) — track it so the usage row can write NULL instead
    // of a fake 0 when NO call reported one.
    if (typeof result.usage.cachedInputTokens === "number") sawCachedReport = true;

    // Audit trail: one event per executed tool call, in order (ADR-0010 log).
    for (const call of result.toolCalls) {
      // R107-b (F5): the TURN-level count for the blank-output guard below.
      turnToolCalls += 1;
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
          // ── R128-W5: ADDITIVE call identity + call order (the streamed
          //    twin's fields — see the tool-result persist site in
          //    runStreamedAgentTurn). callSeq: turnToolCalls was JUST
          //    incremented above, so it is this call's 1-based CALL index
          //    within the turn (the batch iterates in call order); the fold
          //    sorts contiguous tool rows by it, seq stays the tiebreak. ──
          ...(typeof call.toolCallId === "string" && call.toolCallId !== ""
            ? { toolCallId: call.toolCallId }
            : {}),
          callSeq: turnToolCalls,
        },
      });
      // ROUND-51 (R51-f) → ROUND-96 (R96-B): feed the loop-hygiene guard
      // AFTER the call's own event is persisted — the audit trail stays
      // complete regardless of what the guard decides. The feed uses the RAW
      // args (chat.ts threads them as ChatToolCall.args) — the R51 feed of
      // the argsSummary DISPLAY string is what false-positived the owner's
      // healthy paged read (summarizeArgs drops numeric args, so every page
      // of one file looked identical). A warn persists turn.warning +
      // queues the nudge for the NEXT outer iteration; NOTHING stops.
      const guardAction = loopGuard.onToolCall(call.name, call.args ?? call.argsSummary, call.ok);
      if (guardAction.action === "warn" && guardAction.reason !== undefined) {
        persistLoopWarning(db, session.id, agent.id, emit, {
          kind: guardAction.kind ?? "repeat",
          message: guardAction.reason,
          ...(guardAction.count !== undefined ? { count: guardAction.count } : {}),
          toolName: call.name,
        });
        if (guardAction.nudge !== undefined) {
          guardNudge = { role: "user", content: guardAction.nudge };
        }
        log("warn", "loop_guard.warn", {
          sessionId: session.id,
          agentId: agent.id,
          kind: guardAction.kind,
          toolName: call.name,
          count: guardAction.count,
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

    // ROUND-33 (owner report: "hello, how are you" kept planning + running
    // tools in an infinite loop): an iteration that produced a text reply
    // with ZERO tool calls is a CONVERSATIONAL response — break. ROUND-49
    // exception: when the text EVIDENCES tool intent (it names a tool /
    // announces delegation) the model stalled on the announce — spend the
    // turn's ONE intent-nudge and let it try again for real.
    // ROUND-96 (R96-B): the identical-response detector observes every
    // zero-tool iteration's text (any tool activity above resets its chain).
    if (result.toolCalls.length === 0) {
      const textWarn = loopGuard.onAssistantText(result.text);
      if (textWarn.action === "warn" && textWarn.reason !== undefined) {
        persistLoopWarning(db, session.id, agent.id, emit, {
          kind: "identical_text",
          message: textWarn.reason,
          ...(textWarn.count !== undefined ? { count: textWarn.count } : {}),
        });
        log("warn", "loop_guard.warn", {
          sessionId: session.id,
          agentId: agent.id,
          kind: "identical_text",
          count: textWarn.count,
        });
        // The ONE identical-text correction (bounded per turn): give the
        // model a chance to do the real work; a repeated text after it ends
        // the turn through the normal break below (the warning stands).
        if (!identicalTextNudgeUsed && textWarn.nudge !== undefined) {
          identicalTextNudgeUsed = true;
          pendingNudge = { role: "user", content: textWarn.nudge };
          pendingNudgeKind = "identical_text";
          continue;
        }
      }
      if (
        !nudgeUsed &&
        tools !== undefined &&
        toolIntentMentioned(result.text, Object.keys(tools))
      ) {
        nudgeUsed = true;
        pendingNudge = { role: "user", content: TOOL_INTENT_NUDGE };
        continue;
      }
      // ROUND-120 (R120-H, item 43): the BLANK-TAIL continuation — the sync
      // twin of the streamed runner's rule (a blank final iteration over an
      // UNFINISHED todo plan gets ONE feed-the-condition-back nudge; the R77
      // carve-out stands for the no-plan / finished shapes).
      if (
        result.text.trim() === "" &&
        turnToolCalls > 0 &&
        !blankTailContinuationUsed &&
        !latestTodosAllDone(db, session.id) &&
        // A retry iteration must REMAIN (the recovery paths' rule).
        outerIter < maxOuterLoops - 1
      ) {
        blankTailContinuationUsed = true;
        pendingNudge = { role: "user", content: BLANK_TAIL_CONTINUATION_NUDGE };
        continue;
      }
      break;
    }

    // ROUND-96 (R96-B, research finding #1 — completion = the model's own
    // stop): a tool-using iteration whose text is NON-EMPTY is the SDK's
    // natural end (its internal loop only stops when the model stops
    // calling tools — or the generous maxTurns cap binds, the accepted
    // edge). The R58-c phrase gate is RETIRED as the gate; the phrase now
    // only helps the todos-continuation decide. The ONE compromise for the
    // R58 heritage (a model that "finished" over an UNFINISHED plan):
    // unfinished todos + a signal-less text → exactly ONE user-role
    // continuation; after it (or with a signal / no plan) the turn ends.
    if (result.text.trim() !== "") {
      const todosDone = latestTodosAllDone(db, session.id);
      const hasCompletionSignal = COMPLETION_SIGNAL.test(result.text);
      if (
        !todosDone &&
        !hasCompletionSignal &&
        !todosContinuationUsed &&
        // A retry iteration must REMAIN (the recovery paths' rule — a
        // continuation `continue` on the last iteration would fall out of
        // the loop with no error set).
        outerIter < maxOuterLoops - 1
      ) {
        todosContinuationUsed = true;
        pendingNudge = { role: "user", content: TODOS_CONTINUATION_NUDGE };
        pendingNudgeKind = "todos";
        continue;
      }
      break;
    }
    // Tools only, no text — the model is mid-work (the round-28 directive:
    // automatically continue the research → save → restart cycle): the outer
    // loop re-invokes with the re-assembled history.
    // ROUND-40: announce the continuation so the parent UI can show the
    // child is still working (another tool round-trip incoming).
    // ROUND-120 (R120-H, item 43): reaching this branch on the LAST iteration
    // is the fall-out shape — the model is mid-work and the budget just ran
    // out. The flag routes the post-loop exit through the honest
    // ITERATION_LIMIT stop (the streamed twin's law).
    if (outerIter === maxOuterLoops - 1) {
      loopCapMidWork = true;
    }
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
  // ROUND-96 (R96-B): the completion break can exit the loop BETWEEN the
  // parent's abort and the next loop-top check — the R48-e1 contract still
  // owns the turn: a stopped child reports the honest stop even when its
  // in-flight iteration completed with a final answer (the work persists,
  // the report says aborted — never a fake "completed" child after a stop).
  if (!stoppedBySignal && signal?.aborted === true) stoppedBySignal = true;
  if (stoppedBySignal) {
    if (lastAssistantEvent !== null && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      recordUsage(
        db,
        {
          agentId: agent.id,
          sessionId: session.id,
          provider: provider.id,
          model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
          costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
          ts: lastAssistantEvent.ts,
        },
        // ROUND-64 (R64-e) → ROUND-92 (R92-D): attribute the partial spend
        // to the key serving the CURRENT attempt (the swap keeps it honest).
        activeKeySlot,
        // ROUND-83 (R83): the turn's real SDK-call count rides the row.
        { providerCalls: totalRequests, origin: "turn" },
      );
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

  // ROUND-51 (R51-f) → ROUND-96 (R96-B): the loop-guard STOP exit is DELETED —
  // the guard is WARN-ONLY now (the owner's directive: "it will only warn the
  // user and it will pass the generation"). No-progress loops end through the
  // turn's own caps (maxTurns × maxOuterLoops) with the warnings persisted.

  // ── R107-b (F5): the R80 CONTEXT/REQUEST guard stop, mirrored from the
  // streamed runner's post-loop exit (the LOOP_GUARD pattern — the
  // silent-stop fix): persist the honest turn.error (the error card's Retry
  // re-sends the message; persistTurnError resets the session to `queued` so
  // it stays retryable), record the real token spend of the completed
  // iterations, and return the 502 — never the pre-R107 ok:true fallthrough
  // that ended a sync sub-agent mid-task with no error, no card, and no
  // retry affordance. Checked BEFORE the no-assistant-event block below: a
  // guard firing on iteration 0 (the giant-context shape) leaves
  // lastAssistantEvent null, and that block's generic PROVIDER_ERROR
  // fallback would misreport the honest code. ──
  if (guardStop !== null) {
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: guardStop.code,
      message: guardStop.message,
      model,
      providerId: provider.id,
      providerError: guardStop.message,
      keySecrets,
    });
    if (lastAssistantEvent !== null && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      recordUsage(
        db,
        {
          agentId: agent.id,
          sessionId: session.id,
          provider: provider.id,
          model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
          costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
          ts: lastAssistantEvent.ts,
        },
        // R92-D: the LAST attempted key (the swap kept it current).
        activeKeySlot,
        // ROUND-83 (R83): the turn's real SDK-call count rides the row.
        { providerCalls: totalRequests, origin: "turn" },
      );
    }
    touchSession(db, session.id);
    logTurnEnd(session.id, false, Date.now() - syncStartedAt, totalInputTokens, totalOutputTokens);
    log("warn", "turn.guard_stop", {
      sessionId: session.id,
      agentId: agent.id,
      code: guardStop.code,
      model,
      providerId: provider.id,
    });
    return {
      ok: false,
      status: 502,
      code: guardStop.code,
      message: guardStop.message,
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
      // R71-e2 D4: the classified class, when the failure went through the
      // classifier (the no-response fallback default carries none).
      ...(fallback.details?.errorClass !== undefined ? { errorClass: fallback.details.errorClass } : {}),
      // R75: the attempts count, when the retry ladder ran before the
      // iter-0 death (immediate-retry rung).
      ...(fallback.details?.attempts !== undefined ? { attempts: fallback.details.attempts } : {}),
      keySecrets,
    });
    return fallback;
  }

  // ROUND-120 (R120-H, item 43): the ITERATION_LIMIT stop — the sync twin
  // (sub-agent children + the sync REST route). Pre-R120-H a child that hit
  // the maxOuterLoops cap mid-work returned ok:true, the orchestrator marked
  // it completed, and the parent model was told the half-done work SUCCEEDED
  // — the R75 "sub-agent completed" lie pattern, back through the budget
  // cap. The honest stop mirrors the streamed law: persist turn.error,
  // record the real spend, return the 502 (autoRetryClassOf reads a non-
  // PROVIDER_ERROR code as never-retryable, matching CONTEXT_LIMIT's rule).
  if (loopCapMidWork && lastError === null) {
    const iterationLimitMessageText = iterationLimitMessage(session.id, maxOuterLoops);
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "ITERATION_LIMIT",
      message: iterationLimitMessageText,
      model,
      providerId: provider.id,
      providerError: iterationLimitMessageText,
      keySecrets,
    });
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      recordUsage(
        db,
        {
          agentId: agent.id,
          sessionId: session.id,
          provider: provider.id,
          model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
          costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
          ts: lastAssistantEvent.ts,
        },
        activeKeySlot,
        { providerCalls: totalRequests, origin: "turn" },
      );
    }
    touchSession(db, session.id);
    logTurnEnd(session.id, false, Date.now() - syncStartedAt, totalInputTokens, totalOutputTokens);
    log("warn", "turn.iteration_limit", {
      sessionId: session.id,
      agentId: agent.id,
      code: "ITERATION_LIMIT",
      maxOuterLoops,
      model,
      providerId: provider.id,
    });
    return {
      ok: false,
      status: 502,
      code: "ITERATION_LIMIT",
      message: iterationLimitMessageText,
      details: {
        providerError: iterationLimitMessageText,
        model,
        userSeq: userEvent.seq,
        maxOuterLoops,
      },
    };
  }

  // ROUND-43 → ROUND-75 (R75): a provider failure on a LATER iteration
  // (after partial replies) still ends the turn abnormally — persist the
  // error event so the timeline shows the failure after the partial work
  // instead of ending silently. R75 FIX (the "sub-agent completed" lie):
  // this block used to persist turn.error and then FALL THROUGH to the
  // ok:true return — the orchestrator marked the child completed, fired
  // subagent_complete, and told the parent model the half-done work
  // succeeded (the owner's "the agent stops halfway and shows no error").
  // Now it mirrors the streamed twin exactly: record the real usage of the
  // completed iterations (the LOOP_GUARD precedent — the spend was real),
  // persist the error, reset to `queued` (persistTurnError does), and
  // return the 502 — the orchestrator marks the child failed and the
  // parent decides what to do with the truth.
  if (lastError !== null) {
    if (lastAssistantEvent !== null && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      recordUsage(
        db,
        {
          agentId: agent.id,
          sessionId: session.id,
          provider: provider.id,
          model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
          costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
          ts: lastAssistantEvent.ts,
        },
        // R92-D: the LAST attempted key (the swap kept it current).
        activeKeySlot,
        // ROUND-83 (R83): the turn's real SDK-call count rides the row.
        { providerCalls: totalRequests, origin: "turn" },
      );
    }
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "PROVIDER_ERROR",
      message: lastError.message,
      model,
      providerId: provider.id,
      providerError: String(lastError.details.providerError),
      // R71-e2 D4: the classified class rides the persisted payload.
      ...(lastError.details.errorClass !== undefined ? { errorClass: lastError.details.errorClass } : {}),
      // R75: the attempts count, when the retry ladder ran.
      ...(lastError.details.attempts !== undefined ? { attempts: lastError.details.attempts } : {}),
      keySecrets,
    });
    logTurnEnd(session.id, false, Date.now() - syncStartedAt, totalInputTokens, totalOutputTokens);
    return {
      ok: false,
      status: 502,
      code: "PROVIDER_ERROR",
      message: lastError.message,
      details: {
        providerError: String(lastError.details.providerError),
        errorClass: lastError.details.errorClass,
        classMessage: lastError.details.classMessage,
        attempts: lastError.details.attempts,
      },
    };
  }

  // ── R107-b (F5): the R77 blank-output guard, mirrored from the streamed
  // runner — a turn whose ENTIRE output is blank (no visible text AND zero
  // tool calls across the WHOLE turn) is the free-models' whitespace-reply
  // flake the R107-b review found still live on EVERY sub-agent child: the
  // sync path returned ok:true with a whitespace assistant message while the
  // requested work silently never happened. A tool-using turn with no final
  // text stays legitimate (the tools did the work — the R35 empty-marker
  // path), and a user STOP can never reach here (aborts exit through the
  // stoppedBySignal return above). Mirror the loop-guard exit: persist the
  // honest turn.error (the error card's Retry re-sends the message), record
  // the real token spend, and return the 502 — never a fake "completed"
  // empty reply. lastAssistantEvent is non-null here (the null case returned
  // above) — its content is the LAST iteration's text, and turnToolCalls
  // counts the whole turn: zero-tool turns break after ONE iteration, so
  // `turnToolCalls === 0 && lastAssistantEvent.content.trim() === ""` is
  // exactly the streamed twin's `turnToolCalls === 0 && lastText.trim() === ""`. ──
  if (turnToolCalls === 0 && lastAssistantEvent.content.trim() === "") {
    const blankMessage =
      `the model returned an empty response (no text, no tool calls) for session ${session.id} — resend the message`;
    const blankProviderError =
      "empty response — the model produced only whitespace (a free-model flake); the requested work did not happen";
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "NO_OUTPUT",
      message: blankMessage,
      model,
      providerId: provider.id,
      providerError: blankProviderError,
      keySecrets,
    });
    const blankUsage: UsageRecord = {
      agentId: agent.id,
      sessionId: session.id,
      provider: provider.id,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
      costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
      ts: lastAssistantEvent.ts,
    };
    recordUsage(db, blankUsage, activeKeySlot, { providerCalls: totalRequests, origin: "turn" });
    touchSession(db, session.id);
    logTurnEnd(session.id, false, Date.now() - syncStartedAt, totalInputTokens, totalOutputTokens);
    log("warn", "turn.blank_output", {
      sessionId: session.id,
      agentId: agent.id,
      model,
      providerId: provider.id,
    });
    return {
      ok: false,
      status: 502,
      code: "NO_OUTPUT",
      message: blankMessage,
      details: { providerError: blankProviderError, model, userSeq: userEvent.seq },
    };
  }

  const usage: UsageRecord = {
    agentId: agent.id,
    sessionId: session.id,
    provider: provider.id,
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    // ROUND-50 (R50-c1) → ROUND-83 (R83): NULL when no provider call
    // reported a cached tier (the shared type's documented contract — a
    // provider without cache reporting shows "— not reported", never a
    // fabricated 0% hit rate; the audit's §2.10).
    cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
    costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
    ts: lastAssistantEvent.ts,
  };
  // ROUND-64 (R64-e): keySlot attributes the successful turn's spend.
  // ROUND-83 (R83): providerCalls rides the row (the usage screens' honest
  // "N turns · M provider calls" line).
  recordUsage(db, usage, activeKeySlot, { providerCalls: totalRequests, origin: "turn" });
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
  // ROUND-117 (R117-b): the turn-end memory capture step (same terminal
  // path as the usage row + status reset above — see captureTurnEndMemory).
  captureTurnEndMemory(db, {
    sessionId: session.id,
    agentId: agent.id,
    projectId: session.projectId,
    memoryPolicy: agent.memoryPolicy,
  });
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
  modelOverride?: TurnModelOverride,
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
  /** ROUND-114 (R114-b): emit the opening `turn.started` frame — the EARLY
   * live-turn signal (user text + resolved model/provider) that flips the
   * OTHER device into "processing" state and renders the user bubble there
   * BEFORE the persisted fold refetch. Default OFF: the sse route passes it
   * TRUE for the POST's own first turn ONLY (queue-continuation turns and
   * the orchestrator's streamed children already have live context — the
   * watcher saw user.queued / subagent-status frames; a re-announcement
   * would be noise, and a child's frame would nest oddly inside the
   * subagent-event envelope). */
  emitTurnStarted?: boolean,
): Promise<StreamedTurnOutcome> {
  const { db, keyring, chat, chatStream } = deps;
  // ROUND-78 (R78, owner: "General Settings 重试配置"): the per-class
  // auto-retry switches, read ONCE per turn (the ladder gate below consults
  // the cache — no per-rung DB reads while a 30-minute rung waits). A
  // disabled class fails fast through the honest terminal path (attempts:1).
  const retrySettings = getRetrySettings(db);
  // ROUND-80 (R80, owner: "in the settings retry customization is
  // needed"): the CUSTOMIZABLE schedule, resolved once per turn from those
  // same settings — the ladder rungs, the total attempts, and the provider
  // call timeout all come from here now (the R75 constants are the DEFAULTS
  // the resolver falls back to, so default behavior is byte-identical).
  const retrySchedule = resolveRetrySchedule(retrySettings);
  /** R78: is auto-retry ON for this transient class? Non-transient classes
   * are already excluded by isTransientApiFailure — false here just means
   * "fail fast" for a class the owner switched off.
   * ROUND-94 (R94-D1): malformed_response defaults ON — no per-class settings
   * switch exists for it (adding one needs storage + route + UI work outside
   * this round's file ownership), and the owner's field report demands the
   * class never dead-ends ("Generation failed: unknown object"). */
  const retryClassEnabled = (cls: ProviderErrorClass): boolean =>
    cls === "rate_limit"
      ? retrySettings.autoRetryRateLimit
      : cls === "timeout"
        ? retrySettings.autoRetryTimeout
        : cls === "network"
          ? retrySettings.autoRetryNetwork
          : cls === "malformed_response"
            ? true
            : false;
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
    // ROUND-72 (R72-a): the turn's incoming `content` rides along so
    // prepareTurn can compute the per-turn task hints (the streamed main
    // path and its streamed children share this exact call).
    content,
  );
  if ("error" in prepared) return prepared.error;
  const { session, agent, provider, model, providerId, tools, system } = prepared;
  // ── ROUND-114 (R114-b): the OPENING frame — turn.started. Emitted the
  // instant prepareTurn succeeds, BEFORE setSessionStatus/appendSessionEvent
  // and before any loop-top queue delivery: it MUST be the turn's FIRST
  // frame. Nothing reached the OTHER device until the first text/tool delta
  // before this — the desktop's send button never flipped when the phone
  // sent, and the phone showed nothing while the PC's turn was preparing.
  // The frame carries the USER text (so a remote client renders the user
  // bubble immediately, before the persisted fold refetch) and the RESOLVED
  // effective model + provider (the three-tier ladder's verdict, so a
  // remote UI can label the live turn honestly instead of "Auto"). It is
  // NOT persisted (the message.user append below is the durable record) and
  // rides the route's send() wrapper → the events-bus mirror automatically
  // (it is a normal emitted frame). The INITIATING client receives it too —
  // intended and benign: its reducer treats it as the turn's opening frame.
  if (emitTurnStarted === true) {
    emit({ type: "turn.started", text: content, model, providerId });
  }
  // ROUND-92 (R92-D, the owner's multi-key pool with automatic juggling):
  // the turn's key state — identical contract to the sync runner above (see
  // the twin comment there). The STREAMED twist: the swap branch in the
  // catch below flushes the in-flight partial segment BEFORE the retry, so
  // the re-assembled history includes everything the model already said
  // (the R75 ladder's flush precedent — no silent loss on a key swap).
  const startEntry = initialKeyPoolEntry(prepared.keyPool, deps.keySlot ?? 0);
  const startPoolIndex = prepared.keyPool.indexOf(startEntry);
  let apiKey = startEntry.key;
  let activeKeySlot = startEntry.slot;
  let keyRotationIndex = startPoolIndex;

  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  logTurnStart(session.id, agent.id, model, true);

  // ROUND-78 (R78): queue PRE-FLIP — deliver every lingering undelivered
  // queued message (seq order) BEFORE this turn's own user event. The
  // crash/stop recovery contract: a queue left behind by an ABORTED turn
  // (Stop does NOT purge the queue — the chips persist) or a sidecar kill
  // always eventually delivers, in order, ahead of the new message. No
  // frames are emitted here — the folded log the UI refetches owns the
  // render (the flipped rows are ordinary message.user events exactly
  // where they were queued); the loop-top delivery below emits the live
  // queued.delivered frames for messages queued DURING this turn.
  deliverAllQueuedMessages(db, session.id);

  // ROUND-120 (R120-H, item 44): snapshot the log BEFORE this turn's user
  // message lands — the resume planner reads the PRIOR turn's events (tool
  // work to hand over) off this snapshot.
  const preTurnEvents = listSessionEvents(db, session.id);
  const resumeTurnContext = planResumeTurnContext(preTurnEvents, content);

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

  // ROUND-83 (R83): the shared budget — resolveTurnBudget honors the owner's
  // per-model max_output_tokens (the audit's §2.8) and is the SAME number the
  // context meter reports (§2.5: one truth). Computed once per turn (the
  // window/limit rows don't change mid-turn); the guard below reads
  // budget.available.
  const budget: TurnBudget = resolveTurnBudget(db, provider.id, model);

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
  // ROUND-83 (R83): did ANY finish frame this turn carry a cached tier?
  // (chat.ts omits cachedInputTokens from the frame when the provider
  // didn't report one — the NULL-vs-0 honesty for the usage row.)
  let sawCachedReport = false;
  let lastAssistantEvent: { seq: number; ts: string; content: string } | null = null;
  let lastText = "";
  // R77 (the live-battery find): TURN-level tool-call count — the blank-
  // output guard below needs "did ANY tool run this turn", not the
  // per-iteration count the conversational-break rule reads.
  let turnToolCalls = 0;
  // ── R128-W5 (the toolCallId/callSeq threading): the per-turn CALL-ORDER
  //    ledger. tool.use rows persist at RESULT time (completion order), so
  //    the id→callSeq map recorded at the streamed tool-call emit site below
  //    is what lets the persisted payload carry CALL order (the frontend
  //    fold sorts contiguous tool rows by it; seq stays the tiebreak). This
  //    declaration + the two emit/persist sites that consume it are the ONLY
  //    R128-W5 footprint in this file (another round's wave owns the rest).
  //    ──
  let turnCallSeq = 0;
  const callSeqByToolCallId = new Map<string, number>();
  // ROUND-49: the intent-nudge state (see TOOL_INTENT_NUDGE) — same contract
  // as the sync path: one nudge per turn, in-memory only, never persisted.
  let nudgeUsed = false;
  let pendingNudge: ChatTurnMessage | null = null;
  // ROUND-96 (R96-B): the pending nudge's PROVENANCE + the post-completion
  // continuation flag — see the sync twin's state comment (a todos /
  // identical-text continuation's failure must never fail the turn; the
  // completed answer stands).
  let pendingNudgeKind: "todos" | "identical_text" | null = null;
  let postFinalContinuation = false;
  let todosContinuationUsed = false;
  let identicalTextNudgeUsed = false;
  // ROUND-51 (R51-f) → ROUND-96 (R96-B): the loop-hygiene guard (per-turn).
  // The streamed path feeds it LIVE at each tool-result event — with the RAW
  // args (chat.ts threads them on the tool events; the R51 feed of the
  // argsSummary display string is what false-positived the owner's healthy
  // paged read). WARN-ONLY: warnings persist turn.warning events + emit the
  // live turn.warning frames + queue the nudge for the next outer iteration;
  // NOTHING stops mid-stream (the owner's directive — the generation passes).
  const loopGuard = createLoopGuard();
  let guardNudge: ChatTurnMessage | null = null;
  // ROUND-80 (R80, owner: "the chat ends without any error message or
  // anything some times"): the CONTEXT/REQUEST guard stops. The pre-R80
  // guards emitted SSE-only meta frames (which no frontend ever rendered)
  // and broke the loop with ok:true — the chat just STOPPED mid-task with
  // no error, no card, no retry affordance (a silent stop). Now they set
  // this stop (code + honest actionable message) and the post-loop exit
  // mirrors LOOP_GUARD: persisted turn.error + usage + the 502 outcome.
  let guardStop: { code: "CONTEXT_LIMIT" | "REQUEST_LIMIT"; message: string } | null = null;
  // ROUND-71 (R71-e2, D5): overflow-recovery state — same contract as the
  // sync path above (ONE forced-compaction + retry per turn, armed by the
  // catch below when the provider itself rejected the request as too large).
  let overflowRecovered = false;
  // ROUND-75 (R75): the transient-API retry ladder's used rungs this turn
  // (0 = none yet; capped at the resolved schedule's rung count — 5 rungs
  // → 6 total attempts at the R75 defaults, R80-customizable).
  let providerRetries = 0;
  // ROUND-94 (R94-D1, Part 2b — see the sync twin's comment above): the ONE
  // unknown-class-with-PROGRESS retry. This is the STREAMED main turn — the
  // owner's exact dead end ("Generation failed: unknown object" mid-task,
  // fail-fast, no retry). `unknown` stays fail-fast by default EXCEPT when
  // the dying turn already did real work (persisted tool results / streamed
  // text): one bounded extra attempt after a short delay, visible on the
  // stream (a meta.retry frame — the card the UI already renders), then the
  // existing honest terminal path. Counted separately from providerRetries
  // so the ladder's rung indexing is untouched, but it rides the same
  // `attempts` arithmetic so the error card never under-reports what ran.
  let unknownProgressRetries = 0;
  let forceCompaction = false;
  // ROUND-95 (R95-E): the thinking-loop state. `thinkingLoopRetries` — the
  // ONE de-escalating retry a ThinkingLoopError buys (the streamed adapter's
  // reasoning-stall watchdog, chat.ts — the owner: "The models would
  // apparently get stuck in the thinking loop… they won't even get out of
  // the thinking"); a SECOND occurrence fails honestly through the terminal
  // path (waiting cannot heal a reasoning loop, so this class never rides
  // the R75 wait schedule). `effectiveThinkingLevel` — the level the
  // chatStream calls actually run with: the owner's pick until a
  // thinking-loop retry DE-ESCALATES it (medium/high/max → low; an
  // already-low/default level or a non-reasoning model → default, i.e.
  // reasoning excluded — the only further step down there is). Counted in
  // the same `attempts` arithmetic as the other retries.
  let thinkingLoopRetries = 0;
  let effectiveThinkingLevel = prepared.thinkingLevel;
  // ROUND-120 (R120-H, item 43): set when the loop FALLS OUT at the cap
  // while the model is still mid-work (a tools-only final iteration — the
  // old silent ok:true stop; see the ITERATION_LIMIT exit after the loop).
  let loopCapMidWork = false;
  // ROUND-120 (R120-H, item 43): the ONE blank-tail continuation (see
  // BLANK_TAIL_CONTINUATION_NUDGE) — bounded per turn like its siblings.
  let blankTailContinuationUsed = false;

  for (let outerIter = 0; outerIter < maxOuterLoops; outerIter++) {
    // ROUND-78 (R78, owner: "the message QUEUES and is auto-delivered right
    // after the current tool call completes; the agent reads it with full
    // context and continues"): LOOP-TOP DELIVERY. Messages queued while the
    // turn was streaming flip to message.user HERE — before this
    // iteration's history assembly, so the model sees the user's message
    // (with the tool results it follows) in THIS iteration. Delivery never
    // consumes outer-loop budget (outerIter is untouched — this is not an
    // iteration), and on iteration 0 with pre-flipped events nothing
    // remains (a no-op). Each delivery emits a queued.delivered frame so
    // the live chip moves into the transcript.
    // ROUND-94 (R94-D1): the STEP-BOUNDARY injection below now claims most
    // mid-turn messages EARLIER (right after a completed tool call, inside
    // the same SDK call — the owner's position contract). This loop-top
    // remains the safety net for what the boundaries cannot reach: a
    // message landing after the final step's last boundary (during the
    // tail text / after the SDK call returned but before the outer loop
    // iterates, e.g. during a ladder wait's fresh iteration). Both
    // consumers claim through the same type-guarded storage row, so a
    // message is delivered by exactly one of them — never both.
    const pendingQueued = listUndeliveredQueuedMessages(db, session.id);
    for (const queuedEvent of pendingQueued) {
      deliverQueuedMessage(db, session.id, queuedEvent.seq);
      const queuedPayload =
        queuedEvent.payload !== null && typeof queuedEvent.payload === "object"
          ? (queuedEvent.payload as Record<string, unknown>)
          : null;
      const queuedContent =
        queuedPayload !== null && typeof queuedPayload.content === "string" ? queuedPayload.content : "";
      emit({
        type: "queued.delivered",
        seq: queuedEvent.seq,
        content: queuedContent,
        ts: queuedEvent.ts,
      });
    }
    // Re-assemble messages from the event log — ROUND-34: now WITH tool
    // results, so iteration 2+ sees exactly what its tools did instead of
    // re-planning blind (the multi-step fix).
    // ROUND-120 (R120-H, item 44): a resume turn assembles through the
    // WIDENED fidelity window — the prior turn's tool results stay in-full
    // (bounded by the MAX_TOOL_BLOCK_CHARS block cap), so "continue" rides
    // the working context instead of 200-char stubs.
    const rawMessages = assembleHistory(
      db,
      session.id,
      resumeTurnContext !== null ? { recentToolResults: resumeTurnContext.recentToolResults } : undefined,
    );
    // ROUND-46 (R46-b): compaction instead of a silent hard trim — the
    // streamed path surfaces a meta.compaction event so the UI can show
    // that earlier context was summarized. usedTokens derives from the
    // final message list (the 800K context guard keeps its gate).
    // ROUND-71 (R71-e2, D5): forceCompaction is armed by the overflow-
    // recovery path in the catch below (provider-rejected overflow → force
    // a compaction on this retry regardless of the token estimate).
    // ROUND-125 (R125-C, D1): the provider-usage token anchor — the SYNC
    // twin's comment above applies verbatim (ZCode
    // buildProviderUsageTokenOverride's law; the provider's own number +
    // the estimated tail after it replaces the estimate in the gate, with
    // the estimate as the no-usage-row fallback).
    const anchor = providerUsageAnchor(listSessionEvents(db, session.id), rawMessages);
    const compaction = await assembleWithCompaction(
      rawMessages,
      budget,
      {
        db,
        sessionId: session.id,
        chat,
        provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
        apiKey,
        model,
      },
      // R125-C (D1): the anchor threads as tokenOverride; an empty object
      // is behavior-identical to the old `undefined` (planCompaction gates
      // on force === true and a finite-positive override).
      {
        ...(forceCompaction ? { force: true } : {}),
        ...(anchor !== null ? { tokenOverride: anchor } : {}),
      },
    );
    forceCompaction = false;
    const messages = compaction.messages;
    if (pendingNudge !== null) {
      messages.push(pendingNudge);
      pendingNudge = null;
      // ROUND-96 (R96-B): a todos/identical-text nudge riding THIS call makes
      // it a post-final continuation (see the state comment above) — its
      // failure must never fail the already-completed turn.
      postFinalContinuation = pendingNudgeKind !== null;
      pendingNudgeKind = null;
    } else {
      postFinalContinuation = false;
    }
    // ROUND-51 (R51-f): the loop guard's nudge rides the same in-memory path
    // as the intent nudge (next iteration only, never persisted).
    if (guardNudge !== null) {
      messages.push(guardNudge);
      guardNudge = null;
    }
    // ROUND-120 (R120-H, item 44): the resume note rides EVERY iteration of
    // the resume turn (in-memory only, never persisted — the nudge channel's
    // shape; it names the prior turn's reads/writes and forbids the re-read).
    if (resumeTurnContext !== null) {
      messages.push({ role: "user", content: resumeTurnContext.note });
    }
    // ROUND-96 (R96-B): the MESSAGES-SHAPE GUARANTEE — no provider call ever
    // goes out assistant-last (DeepSeek@OpenRouter rejects the shape with a
    // deterministic 400: "The last message must have role=user"; the
    // todos-continuation, queued-message flips, and sub-agent histories can
    // all assemble that way). Belt-and-suspenders at EVERY call boundary.
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      messages.push({ role: "user", content: ASSISTANT_LAST_SHAPE_NUDGE });
    }
    const usedTokens = estimateMessageTokens(messages);
    if (compaction.compacted && compaction.detail !== undefined) {
      // ROUND-125 (R125-C, D2): the live frame carries the typed decision's
      // dual numbers + reason (additive — old frontends ignore the new
      // keys; ZCode's AutoCompactDecision log context is the twin). The
      // guards keep absent fields absent (a detail built from a pre-R125
      // payload shape can never occur — detail is only set on a fresh
      // compaction — but the optionals stay honest).
      emit({
        type: "meta.compaction",
        tokensSaved: compaction.detail.tokensSaved,
        droppedMessages: compaction.detail.droppedMessages,
        throughSeq: compaction.detail.throughSeq,
        ...(compaction.detail.tokenCount !== undefined ? { tokenCount: compaction.detail.tokenCount } : {}),
        ...(compaction.detail.tokenSource !== undefined ? { tokenSource: compaction.detail.tokenSource } : {}),
        ...(compaction.detail.estimatedTokens !== undefined
          ? { estimatedTokens: compaction.detail.estimatedTokens }
          : {}),
        ...(compaction.detail.threshold !== undefined ? { threshold: compaction.detail.threshold } : {}),
        ...(compaction.detail.reason !== undefined ? { reason: compaction.detail.reason } : {}),
      });
    }

    // Context guard (6-f R-F5 → ROUND-83): abort if the assembled context
    // exceeds the model's OWN budget line (window − output reserve −
    // margin — the same `available` the compaction trigger and the donut's
    // budget marker use; ONE truth, R83 §2.5/§2.6). The pre-R83 guard was a
    // hardcoded 800K: on a 1M-window model it fired BEFORE compaction could
    // (compaction triggers at window−41K), and the message told the owner to
    // "run /compact" — a command that did not exist (the audit's honesty
    // violation). Now: model-relative, and the R83 POST /sessions/:id/compact
    // route makes the affordance real. ROUND-80 (R80): the break carries the
    // guardStop — the turn ends through the honest terminal path below
    // (persisted turn.error + 502), never a silent ok:true stop.
    if (usedTokens > budget.available) {
      emit({ type: "meta.context_limit", tokens: usedTokens, limit: budget.available });
      guardStop = {
        code: "CONTEXT_LIMIT",
        message:
          `the turn's assembled context exceeded the model's budget for session ${session.id} ` +
          `(${usedTokens} tokens > ${budget.available} available of a ${budget.contextWindow}-token window) — ` +
          "start a new session, or compact the older context (POST /sessions/:id/compact)",
      };
      break;
    }
    // Request guard (6-f R-F6): abort if > 200 total requests (OpenRouter
    // rate limits apply even on 0-cost models). ROUND-80 (R80): same honest
    // stop — the follow-up message continues from the event log.
    if (totalRequests > 200) {
      emit({ type: "meta.request_limit", requests: totalRequests, limit: 200 });
      guardStop = {
        code: "REQUEST_LIMIT",
        message: `the turn exceeded 200 provider requests (${totalRequests}) for session ${session.id} — send a follow-up message to continue from where it stopped`,
      };
      break;
    }

    // Emit a continuation event so the frontend can show "Continuing…" (the
    // streaming bubble from WS-D2 handles this event type).
    // ROUND-96 (R96-B): the reason widens — the outer loop continues for
    // mid-work iterations (tools, no final text) and the todos-continuation,
    // not the retired phrase gate.
    if (outerIter > 0) {
      emit({ type: "meta.continuation", iteration: outerIter, reason: "continuing" });
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
    // ROUND-83 (R83): iterSawCached — this iteration's finish frame DID
    // report a cache tier (the stats carrier's payload then carries the
    // value; absence = not reported, the meter's actual block reads NULL).
    let iterCachedInputTokens = 0;
    let iterSawCached = false;
    let iterToolCalls = 0;
    // ROUND-120 (R120-H, item 43): the truncation witnesses — every tool-call
    // event must resolve to a tool-result event (and every tool-input-start
    // to its completing tool-call) before a stream ends CLEANLY. A mismatch
    // means the connection dropped mid-call: the guard after the for-await
    // throws the honest truncation error instead of letting the call vanish.
    let iterToolCallEvents = 0;
    let iterToolResultEvents = 0;
    let iterOpenToolInputs = 0;
    totalRequests++;

    /** ROUND-35 (review fix #5): reasoning can run 10s of KB — cap the
     * persisted thinking at 4000 chars, head+tail like tool outputs. */
    const capThinking = (text: string): string => {
      if (text.length <= 4000) return text;
      const omitted = text.length - 4000;
      return `${text.slice(0, 2000)}\n…[thinking truncated ${omitted} chars]…\n${text.slice(-2000)}`;
    };

    let statsCarrierNeeded = false;

    // ── ROUND-94 (R94-D1, the owner's v0.91.0 field report: "the queued
    // prompt should be INJECTED MID-TURN at a TOOL-CALL BOUNDARY… the
    // transcript shows it AT THAT POSITION — after the tool result, not
    // right after the original user message"): the STEP-BOUNDARY injection
    // state for THIS SDK call. The adapter (chat.ts's prepareStep) calls
    // consumeQueuedForStep at every boundary where the PRIOR step completed
    // tool calls; this side CLAIMS one queue entry (delete — the same
    // atomic type-guarded storage claim the route's post-turn continuation
    // uses, so the two consumers can never double-take) and records it as
    // PENDING rather than persisting immediately. WHY deferred: the SDK may
    // run prepareStep BEFORE this for-await has processed the completed
    // step's tool-result parts (fullStream is an ordered queue, not a
    // rendezvous — the internal step loop does not wait on our consumer),
    // and an immediate append could land the user row BEFORE the tool
    // results it must follow. The flush runs at the FIRST part observed
    // AFTER the claim — ordered after ALL of the prior step's parts by
    // stream construction — so the persisted event position and the SSE
    // frame position are exactly "after the tool result". ──
    let pendingQueuedInjection: {
      seq: number;
      ts: string;
      content: string;
      attachments?: MessageAttachment[];
    } | null = null;

    /** R94-D1: the claim side — ONE entry per boundary, FIFO (seq order,
     * like every other consumer). Returns the storage payload shape
     * ({content, attachments?}) for the adapter's model-facing message. */
    const consumeQueuedForStep = (): QueuedStepMessage | null => {
      const queued = listUndeliveredQueuedMessages(db, session.id);
      const first = queued[0];
      if (first === undefined) return null;
      const queuedStepPayload =
        first.payload !== null && typeof first.payload === "object"
          ? (first.payload as Record<string, unknown>)
          : null;
      const queuedStepContent =
        queuedStepPayload !== null && typeof queuedStepPayload.content === "string"
          ? queuedStepPayload.content
          : "";
      const queuedStepAttachments =
        queuedStepPayload !== null && Array.isArray(queuedStepPayload.attachments)
          ? (queuedStepPayload.attachments as MessageAttachment[])
          : undefined;
      // THE CLAIM: delete the queued row FIRST (the continuation loop's own
      // consume step — same function, same type-guarded WHERE clause). Both
      // are synchronous better-sqlite3 statements on the single Node thread,
      // so list → delete can never interleave with the route's post-turn
      // loop: the row is either claimed here or stays `message.queued` for
      // the next consumer. A false return (vanished mid-tick, defensive)
      // leaves the boundary empty.
      if (!deleteQueuedMessage(db, session.id, first.seq)) return null;
      // The R82 per-send override fields (model/providerId) in the payload
      // are deliberately dropped: they steer a FRESH continuation turn's
      // routing, while a mid-turn injection rides the CURRENT turn's
      // in-flight model by construction — the SDK call is already running.
      pendingQueuedInjection = {
        seq: first.seq,
        ts: first.ts,
        content: queuedStepContent,
        ...(queuedStepAttachments !== undefined && queuedStepAttachments.length > 0
          ? { attachments: queuedStepAttachments }
          : {}),
      };
      return {
        content: queuedStepContent,
        ...(queuedStepAttachments !== undefined && queuedStepAttachments.length > 0
          ? { attachments: queuedStepAttachments }
          : {}),
      };
    };

    /** R94-D1: the flush side — persist the claimed message at the CURRENT
     * stream position + announce it with the frame the frontend already
     * renders. Idempotent (a null pending is a no-op), so it is safe to
     * call at every part, at stream end, and in the catch. */
    const flushPendingInjection = (): void => {
      if (pendingQueuedInjection === null) return;
      const injection = pendingQueuedInjection;
      pendingQueuedInjection = null;
      // (a) The PERSIST: a fresh message.user event — the exact payload
      // shape the normal send path appends (raw content + attachments; the
      // model-facing attachment RENDERING happens in assembleHistory for
      // every later iteration and in chat.ts's prepareStep for the in-flight
      // call). Appending NOW lands the row after the last persisted
      // tool.use of the completed step — the position the owner asked for.
      appendSessionEvent(db, session.id, {
        type: "message.user",
        agentId: agent.id,
        payload: {
          role: "user",
          content: injection.content,
          ...(injection.attachments !== undefined ? { attachments: injection.attachments } : {}),
        },
      });
      // (b) The FRAME: the exact shape the loop-top delivery emits — the
      // frontend's queued.delivered handler moves the chip (keyed by the
      // ORIGINAL queued seq) to an ordinary user bubble at the live
      // position; the folded log owns the render after the refetch
      // (content-deduped there — no double bubble).
      emit({
        type: "queued.delivered",
        seq: injection.seq,
        content: injection.content,
        ts: injection.ts,
      });
    };

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
                usage: {
                  inputTokens: iterInputTokens,
                  outputTokens: iterOutputTokens,
                  ...(iterSawCached ? { cachedInputTokens: iterCachedInputTokens } : {}),
                },
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
        // ROUND-80 (R80): the CUSTOMIZABLE provider-call ceiling (Settings
        // → General → retry config; 600 s = the old hardcoded default).
        timeoutMs: retrySchedule.timeoutMs,
        ...(tools !== undefined ? { tools } : {}),
        // ROUND-50 (R50-c1): the per-send thinking level (chat-completions
        // reasoning.effort injection — see chat.ts buildThinkingFetch).
        // ROUND-95 (R95-E): the EFFECTIVE level — the owner's pick until the
        // thinking-loop retry de-escalates it — plus the model's DETECTED
        // reasoning capability so the adapter maps the level onto the
        // model's own effort ladder and bounds its reasoning budget.
        ...(effectiveThinkingLevel !== undefined ? { thinkingLevel: effectiveThinkingLevel } : {}),
        ...(prepared.reasoningSupport !== null ? { reasoningSupport: prepared.reasoningSupport } : {}),
        // ROUND-96 (R96-J): the resolved output cap rides the wire as
        // max_tokens when the SDK sends none (the paid-model credits catch
        // — OpenRouter prices an unspecified cap at the model's FULL default).
        maxOutputTokens: budget.maxOutputTokens,
        ...(signal !== undefined ? { signal } : {}),
        // ROUND-94 (R94-D1): the STEP-BOUNDARY claim the adapter's prepareStep
        // calls at every completed-tool-call boundary — the mid-turn
        // injection (the sync runner deliberately passes NO such callback:
        // its callers — the sync REST route + orchestrator children — have no
        // live registered notify turn, so POST /queue 409s and the queue is
        // always empty there; wiring it would be dead code).
        consumeQueuedForStep,
        // ROUND-97 (R97-D, owner: "we should give the user the option in the
        // settings to turn it on or off. By default it will be turned off so
        // that the model can think as much as it needs to"): the thinking-loop
        // guard's ARMING config from Settings → General. enabled:false (the
        // default) → NO watchdog in the adapter; enabled:true → the owner's
        // own thresholds (stallSeconds → stallMs, reasoningBytesKB → bytes).
        thinkingLoop: (() => {
          const tl = getThinkingLoopSettings(db);
          return {
            enabled: tl.enabled,
            stallMs: tl.stallSeconds * 1000,
            reasoningBytes: tl.reasoningBytesKB * 1024,
          };
        })(),
      })) {
        // ROUND-94 (R94-D1): the claimed injection lands HERE — at the first
        // part observed after the claim, i.e. strictly after all of the
        // completed step's parts were processed (see the deferred-flush WHY
        // above). Every part checks; a no-pending call is a cheap null test.
        flushPendingInjection();
        if (event.type === "tool-result") {
          // handled below with a scrubbed outputSummary — do NOT emit raw.
        } else if (event.type === "tool-call") {
          // ROUND-96 (R96-B): the adapter threads the RAW args for the guard's
          // exact-match identity — they are NEVER forwarded over SSE (write
          // bodies/paths ride them; the wire shape stays byte-identical to
          // the pre-R96-B frames).
          // R128-W5: the frame's toolCallId (chat.ts threads the SDK part id
          // now) rides the wire copy through the rest-spread — and is
          // recorded HERE, at CALL time, with its per-turn callSeq: the
          // tool.use row persists later (at result time — completion order),
          // so this map is what restores CALL order for the fold.
          turnCallSeq += 1;
          if (typeof event.toolCallId === "string" && event.toolCallId !== "") {
            callSeqByToolCallId.set(event.toolCallId, turnCallSeq);
          }
          const { args: _toolArgs, ...wireToolCall } = event;
          emit(wireToolCall);
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
          // R120-H: an input stream OPENED — one more witness (closed by the
          // completing tool-call below).
          iterOpenToolInputs += 1;
          if (iterText.trim() !== "" || iterThinking.trim() !== "") {
            flushSegment(false);
            statsCarrierNeeded = true;
          }
        } else if (event.type === "tool-call") {
          iterToolCalls += 1;
          turnToolCalls += 1;
          // R120-H: the call ARRIVED (arguments complete) — close the open
          // input witness and count the call as pending its result.
          iterOpenToolInputs = 0;
          iterToolCallEvents += 1;
          // ROUND-35: flush the message-so-far BEFORE the tool runs, so the
          // tool work lands between message segments (owner directive).
          if (iterText.trim() !== "" || iterThinking.trim() !== "") {
            flushSegment(false);
            statsCarrierNeeded = true; // stats attach at iteration end instead
          }
        } else if (event.type === "tool-result") {
          // R120-H: the pending call RESOLVED (the invariant's happy path).
          iterToolResultEvents += 1;
          // Persist each tool call the moment it completes (live ordering).
          // ROUND-34 (review fix #3): scrub the output summary BEFORE it is
          // emitted over SSE AND persisted — the UI must never see secrets.
          // ROUND-96 (R96-B): the RAW args ride the event for the guard below
          // but never the wire — the emitted copy drops them (same rule as
          // the tool-call branch above).
          const outputSummary =
            event.outputSummary !== undefined
              ? scrubSecrets(event.outputSummary, keySecrets)
              : null;
          // Always emit the tool-result (scrubbed when it carries output) —
          // the UI's live rows key off these events. R128-W5: the frame's
          // toolCallId rides the wire copy through the rest-spread (the
          // id-first attachment in the stream store).
          const { args: _toolResultArgs, ...wireToolResult } = event;
          emit({ ...wireToolResult, ...(outputSummary !== null ? { outputSummary } : {}) });
          appendSessionEvent(db, session.id, {
            type: "tool.use",
            agentId: agent.id,
            payload: {
              role: "tool",
              toolName: event.toolName,
              argsSummary: event.argsSummary,
              ok: event.ok,
              ...(outputSummary !== null ? { outputSummary } : {}),
              // ── R128-W5: ADDITIVE call identity + call order. toolCallId
              //    is the same id the wire frames carry (the live store's
              //    id-first attachment); callSeq is the per-turn CALL-order
              //    counter recorded at the tool-call emit site above — the
              //    fold sorts contiguous tool rows by it (seq stays the
              //    stable tiebreak). Old rows without either field keep
              //    folding exactly as before. ──
              ...(typeof event.toolCallId === "string" && event.toolCallId !== ""
                ? { toolCallId: event.toolCallId }
                : {}),
              ...(typeof event.toolCallId === "string" && event.toolCallId !== ""
                ? callSeqByToolCallId.has(event.toolCallId)
                  ? { callSeq: callSeqByToolCallId.get(event.toolCallId) }
                  : {}
                : {}),
            },
          });
          logTool(session.id, event.toolName, event.argsSummary, event.ok);
          // ROUND-51 (R51-f) → ROUND-96 (R96-B): feed the loop-hygiene guard
          // LIVE — the call's event is already persisted + emitted above, so
          // the audit trail stays complete whatever the guard decides. The
          // feed uses the RAW args (event.args — chat.ts threads them; the
          // R51 feed of the argsSummary display string is what false-positived
          // the owner's healthy paged read: summarizeArgs drops numeric args,
          // so every page of one file looked identical). WARN-ONLY: the warn
          // persists a turn.warning event + emits the live frame + queues
          // the nudge for the next outer iteration — the generation PASSES
          // (the owner's directive; the mid-stream stop is gone).
          const guardAction = loopGuard.onToolCall(event.toolName, event.args ?? event.argsSummary, event.ok);
          if (guardAction.action === "warn" && guardAction.reason !== undefined) {
            persistLoopWarning(db, session.id, agent.id, emit, {
              kind: guardAction.kind ?? "repeat",
              message: guardAction.reason,
              ...(guardAction.count !== undefined ? { count: guardAction.count } : {}),
              toolName: event.toolName,
            });
            if (guardAction.nudge !== undefined) {
              guardNudge = { role: "user", content: guardAction.nudge };
            }
            log("warn", "loop_guard.warn", {
              sessionId: session.id,
              agentId: agent.id,
              kind: guardAction.kind,
              toolName: event.toolName,
              count: guardAction.count,
            });
          }
        } else if (event.type === "finish") {
          iterInputTokens = event.usage.inputTokens;
          iterOutputTokens = event.usage.outputTokens;
          // ROUND-50 (R50-c1): cached prompt tokens ride the finish frame
          // (0 when the provider didn't report a cached tier).
          // ROUND-83 (R83): the ABSENCE of the field is the "not reported"
          // signal — track it for the usage row's NULL-vs-0 honesty.
          iterCachedInputTokens = event.cachedInputTokens ?? 0;
          if (typeof event.cachedInputTokens === "number") {
            sawCachedReport = true;
            iterSawCached = true;
          }
        }
      }
      // ROUND-120 (R120-H, item 43): the MID-TOOL truncation invariant. A
      // CLEAN stream end (no error part, no throw) with tool-call events
      // that never received results — or a tool-input-start whose arguments
      // never completed — is a dropped connection the R80 zero-finish-step
      // guard cannot see (an EARLIER step already emitted its finish-step).
      // Throwing here routes the condition through the catch: the partial
      // segment flush, the classifier (network — the wording), the retry
      // ladder, and on give-up the honest terminal error. The call must
      // never silently vanish under a normal-looking iteration end.
      const unresolvedToolCalls = iterToolCallEvents - iterToolResultEvents + iterOpenToolInputs;
      if (unresolvedToolCalls > 0) {
        throw midToolTruncationError(
          iterToolCallEvents - iterToolResultEvents,
          iterOpenToolInputs,
        );
      }
      // ROUND-94 (R94-D1): the stream ended cleanly — a healthy stream
      // always ends each step with a finish-step part (the part loop's flush
      // already handled any claim), but a claim that raced the very last
      // part must never be dropped: the queued row is already DELETED, so
      // this defensive flush is the difference between "delivered" and
      // "lost". Idempotent (null pending → no-op).
      flushPendingInjection();
    } catch (error) {
      // ROUND-94 (R94-D1): flush any claimed-but-unpersisted injection FIRST
      // — the claim already deleted the queued row, so not persisting it here
      // would LOSE the message; and it must land BEFORE the partial-segment
      // flush below (the segment's text streamed AFTER the injection point,
      // so the log order is [tool results] [injected user message] [partial
      // text] on every exit: abort, retry, and terminal alike).
      flushPendingInjection();
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
          recordUsage(
            db,
            {
              agentId: agent.id,
              sessionId: session.id,
              provider: provider.id,
              model,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
              costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
              ts: lastAssistantEvent.ts,
            },
            // ROUND-64 (R64-e) → ROUND-92 (R92-D): attribute the partial spend
            // to the key serving the CURRENT attempt (the swap keeps it honest).
            activeKeySlot,
            // ROUND-83 (R83): the turn's real SDK-call count rides the row.
            { providerCalls: totalRequests, origin: "turn" },
          );
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
      // ROUND-71 (R71-e2, D5): context-window OVERFLOW RECOVERY — classify
      // the failure; when the provider itself rejected the request as too
      // large, nothing from this iteration reached the log yet (context-
      // window rejections land BEFORE the first token — cline's "no partial
      // tool calls" guard), and no recovery ran this turn: emit the visible
      // recovery line, arm the forced compaction, and RETRY once. A retry
      // that overflows again (or recovery that found nothing to compact)
      // falls through to the honest terminal path below.
      const classified = classifyProviderError(normalized);
      // ROUND-78 (R78): the real-text userMessage must be key-scrubbed at THIS
      // boundary — the pure classifier cannot know the key (its signature is
      // deliberately key-less), so every emission below uses this scrubbed
      // line (the same rule providerError already follows; a raw provider
      // body quoting the key must never reach a frame or an envelope).
      const classMessage = scrubSecrets(classified.userMessage, keySecrets);
      // R105-C: the LESSON write — every rate_limit whose body/status says
      // WHY (quota | rate | capacity) upserts the (provider, model, reason)
      // row (migration 0039). Placed BEFORE the key-swap branch so a lesson
      // lands even when a pool juggle handles the failure; write-only
      // telemetry (recordProviderLesson never throws), no UI this round.
      if (classified.class === "rate_limit" && classified.rateLimitReason !== undefined) {
        recordProviderLesson(db, provider.id, model, classified.rateLimitReason);
      }
      // ── ROUND-96 (R96-B): a POST-COMPLETION failure must not fail the
      // turn (the streamed twin of the sync runner's branch). The owner's
      // exact report: "The agent completed its task properly and finished
      // the chat properly but after it completed it, it said that there was
      // an error… The last message must have role=user. / Attempts: 2".
      // The failing call here was a CONTINUATION launched after the model's
      // final answer was already persisted (the todos-continuation / the
      // identical-text nudge). The completed answer stands; the honest
      // residue is a non-fatal turn.warning + the done frame, never a
      // "Generation failed" card over finished work. ──
      // (lastAssistantEvent is assigned inside the stream-event/flush closures
      // — TS cannot track that here, so the guard reads it through an
      // explicitly-typed local instead of the impossible `never` narrowing.)
      const completedAnswer = lastAssistantEvent as { seq: number; ts: string; content: string } | null;
      if (postFinalContinuation && completedAnswer !== null) {
        // The continuation's partial segment (if it streamed anything before
        // dying) persists first — the R58-c partial-work-survives rule; the
        // log then owns [completed answer][partial fragment] honestly.
        flushSegment(true);
        persistLoopWarning(db, session.id, agent.id, emit, {
          kind: "identical_text",
          message: `continuation failed after the completed answer — ${classMessage} (the answer above stands)`,
        });
        if (totalInputTokens > 0 || totalOutputTokens > 0) {
          recordUsage(
            db,
            {
              agentId: agent.id,
              sessionId: session.id,
              provider: provider.id,
              model,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
              costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
              ts: completedAnswer.ts,
            },
            activeKeySlot,
            { providerCalls: totalRequests, origin: "turn" },
          );
        }
        touchSession(db, session.id);
        if (getSession(db, session.id)?.status === "running") {
          setSessionStatus(db, session.id, "queued");
        }
        logTurnEnd(session.id, true, Date.now() - startedAt, totalInputTokens, totalOutputTokens);
        return {
          ok: true,
          assistantMessage: {
            seq: completedAnswer.seq,
            role: "assistant",
            agentId: agent.id,
            content: completedAnswer.content,
            ts: completedAnswer.ts,
          },
          usage: {
            agentId: agent.id,
            sessionId: session.id,
            provider: provider.id,
            model,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
            costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
            ts: completedAnswer.ts,
          },
        };
      }
      // ROUND-92 (R92-D, the owner's multi-key pool with automatic
      // juggling): the STREAMED twin of the sync runner's swap branch —
      // auth / rate_limit with an UNTRIED key left → swap apiKey/
      // activeKeySlot forward and retry the SAME call IMMEDIATELY (no
      // ladder wait; a fresh key has fresh quota). The partial streamed
      // segment is FLUSHED first (the R75 ladder's flush precedent) so the
      // retry's re-assembled history keeps everything the model already
      // said — no silent loss on a key swap. Network / timeout / context /
      // unknown failures are NOT key-attributable: they keep the existing
      // overflow/ladder/terminal paths below. The meta.key frame mirrors
      // meta.retry's shape (indexes + reason only — NEVER a key value), so
      // the live chat can show "switching to API key 2 of 3…".
      if (
        (classified.class === "auth" || classified.class === "rate_limit") &&
        keyRotationIndex + 1 < prepared.keyPool.length
      ) {
        keyRotationIndex += 1;
        apiKey = prepared.keyPool[keyRotationIndex]!.key;
        activeKeySlot = prepared.keyPool[keyRotationIndex]!.slot;
        emit({
          type: "meta.key",
          sessionId: session.id,
          key: {
            attempt: keyRotationIndex + 1,
            totalKeys: prepared.keyPool.length,
            reason: classified.class,
          },
          message:
            `${classMessage} — switching to API key ${keyRotationIndex + 1} of ${prepared.keyPool.length} ` +
            `(${classified.class === "auth" ? "key rejected" : "key rate limited"}), retrying immediately`,
        });
        log("warn", "provider.key_swap", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
          keyIndex: keyRotationIndex + 1,
          totalKeys: prepared.keyPool.length,
          reason: classified.class,
        });
        // The partial text/thinking persists now (stats unknown — the
        // finish frame never arrived); the immediate retry re-assembles
        // history from the log and CONTINUES from it, exactly like the
        // ladder's re-run (outerIter compensated — delay 0, bounded by the
        // pool size).
        flushSegment(true);
        outerIter -= 1;
        continue;
      }
      if (
        classified.class === "context_window_exceeded" &&
        !overflowRecovered &&
        // A retry iteration must REMAIN — a recovery `continue` on the last
        // iteration would otherwise fall out of the loop with no error set
        // (the turn must never swallow an overflow as a fake success).
        outerIter < maxOuterLoops - 1 &&
        iterToolCalls === 0 &&
        iterText.trim() === "" &&
        iterThinking.trim() === ""
      ) {
        overflowRecovered = true;
        forceCompaction = true;
        emit({ type: "meta.overflow_recovery", sessionId: session.id, message: OVERFLOW_RECOVERY_NOTE });
        log("warn", "provider.overflow_recovery", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
        });
        continue;
      }
      // ── ROUND-95 (R95-E): the THINKING-LOOP de-escalating retry. The
      // streamed adapter's reasoning-stall watchdog (chat.ts
      // ThinkingLoopError — >24KB of reasoning with no text, tool call, or
      // finish for 120s) classifies as `thinking_loop`, which is NOT a
      // transient ladder class (waiting cannot heal a reasoning loop). The
      // ONE bounded response: retry the iteration IMMEDIATELY with the
      // effective thinking level DE-ESCALATED — medium/high/max drop to
      // "low"; an already-low/default level, or a model the catalog marks
      // NOT reasoning-capable, drops to "default" (reasoning excluded
      // entirely — the only step further down). The meta.retry frame rides
      // the existing card mechanism (same shape the ladder emits — the
      // frontend needs no change), with the reason stating plainly that the
      // model was stuck reasoning and the retry downgraded the thinking
      // level. A SECOND ThinkingLoopError on the de-escalated retry falls
      // through to the honest terminal path below (thinkingLoopRetries stays
      // 1, attempts = 2 — the card never under-reports). ──
      if (
        classified.class === "thinking_loop" &&
        thinkingLoopRetries === 0 &&
        // A retry iteration must REMAIN (the overflow guard's rule).
        outerIter < maxOuterLoops - 1
      ) {
        thinkingLoopRetries = 1;
        // The de-escalation ladder (see the state comment above): supported
        // === false or an already-minimal level → default (excluded);
        // anything higher → low.
        effectiveThinkingLevel =
          prepared.reasoningSupport?.supported === false ||
          prepared.thinkingLevel === undefined ||
          prepared.thinkingLevel === "default" ||
          prepared.thinkingLevel === "low"
            ? "default"
            : "low";
        const downgradeNote =
          effectiveThinkingLevel === "default"
            ? "with reasoning excluded for the retry"
            : "with the thinking level downgraded to low";
        emit({
          type: "meta.retry",
          sessionId: session.id,
          // The single extra attempt: 2 of 2 — the card the UI already
          // renders (attempt/totalAttempts/waitMs/…), the same frame shape
          // the ladder and the unknown-progress retry emit.
          attempt: 2,
          totalAttempts: 2,
          waitMs: 0,
          remainingMs: 0,
          retryAt: Date.now(),
          errorClass: classified.class,
          classMessage,
          providerError: scrubSecrets(providerErrorDetail(normalized, apiKey), keySecrets),
          message: `${classMessage} — the model was stuck in a reasoning loop; retrying (attempt 2 of 2) immediately ${downgradeNote}`,
        });
        log("warn", "provider.thinking_loop_retry", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
          attempt: 2,
          fromLevel: prepared.thinkingLevel ?? "default",
          toLevel: effectiveThinkingLevel,
        });
        // The flushed partial reasoning/text persists now (the R75 flush
        // precedent — the retry's re-assembled history keeps what the model
        // already produced); the retry re-runs THIS iteration immediately
        // (compensated like every recovery path — no wait to register, no
        // outer-loop budget spent).
        flushSegment(true);
        outerIter -= 1;
        continue;
      }
      // ROUND-75 (R75): the TRANSIENT-API RETRY LADDER — the owner's spec.
      // rate_limit / network / timeout failures retry per the schedule
      // [immediate → 1.5 min → 5 min → 10 min → 30 min → terminal]; every
      // other class (auth, overflow — handled above, unknown) fails fast
      // through the honest terminal path below. Before re-running the
      // iteration the PARTIAL streamed text is flushed to the event log
      // (the R58-c abort-path precedent) so the retry's re-assembled
      // history includes everything the model already said. The wait is
      // abort-aware (a user stop cuts it short and routes through the
      // catch's signal.aborted path above on the next throw) and ticks
      // meta.retry heartbeats (SSE keep-alive + live countdown).
      // ROUND-78 (R78): the per-class switches gate the ladder — a class the
      // owner switched OFF (Settings → General → retry config) skips it and
      // falls through to the honest terminal path (attempts stays 1, the
      // real provider text rides the error card).
      //
      // R97-J (m7): EVERY failed attempt's streamed-so-far is real spend —
      // accumulate it HERE (once per catch, before any retry branch). The
      // pre-fix terminal path read only the FINAL error's symbol, so a
      // ladder whose attempt 1 streamed 50K tokens and died reported only
      // attempt 2's instant death. The totals now carry the full burn; the
      // terminal path below reports them directly.
      const attemptUsage = readStreamPartialUsage(normalized);
      if (attemptUsage !== null) {
        totalInputTokens += attemptUsage.inputTokens;
        totalOutputTokens += attemptUsage.outputTokens;
      }
      if (
        isTransientApiFailure(classified.class) &&
        retryClassEnabled(classified.class) &&
        providerRetries < retrySchedule.ladderMs.length
      ) {
        providerRetries += 1;
        // ROUND-96 (R96-B, the owner: "There might be some rate limiting on
        // the models... try to look into that properly too and manage them
        // accordingly"): a rate_limit failure carrying the provider's own
        // Retry-After (seconds or HTTP-date — APICallError.responseHeaders,
        // unwrapped from any RetryError by extractRetryAfterMs) REPLACES the
        // schedule rung for this attempt — the provider said when it will
        // serve us; honoring it is both faster (Retry-After 5s beats a 90s
        // rung) and kinder (retrying early just re-429s). Header-less 429s
        // keep the owner's R75 schedule; the SDK's internal maxRetries:4
        // exponential layer (2s→4s→8s→16s) already ran underneath by the
        // time we see the failure, so "exponential backoff between attempts"
        // is the COMPOSED system's property.
        const scheduleMs = retrySchedule.ladderMs[providerRetries - 1];
        const retryAfterMs = classified.class === "rate_limit" ? extractRetryAfterMs(normalized) : null;
        // R105-C: the reason-aware rung (see the streamed catch's identical
        // block for the full rationale) — quota floors at 10 minutes; every
        // other reason is byte-identical pre-R105 behavior.
        const waitMs = effectiveRungWaitMs(scheduleMs, retryAfterMs, classified.rateLimitReason);
        const attempt = providerRetries + 1;
        const emitRetry = (remainingMs: number): void => {
          emit({
            type: "meta.retry",
            sessionId: session.id,
            attempt,
            totalAttempts: retrySchedule.totalAttempts,
            waitMs,
            remainingMs,
            retryAt: Date.now() + remainingMs,
            errorClass: classified.class,
            // R105-C: the additive reason field (quota | rate | capacity —
            // present only on rate_limit).
            rateLimitReason: classified.rateLimitReason,
            // R78: the scrubbed real text (see the catch's classMessage const).
            classMessage,
            // R78: the provider's REAL scrubbed error text (unwrapped from
            // any RetryError by providerErrorDetail) — the live retry card
            // shows what the API actually said, not a generic class line.
            // R92-D: scrubbed against EVERY keyring-held key (multi-key:
            // the failing attempt's key may differ from the swap target).
            providerError: scrubSecrets(providerErrorDetail(normalized, apiKey), keySecrets),
            // R96-B: the wait line names the provider-advised source when
            // the header won ("retrying after the provider's Retry-After:
            // 5 s"), else the schedule phrasing.
            message:
              retryAfterMs !== null
                ? `${classMessage} — the provider asked to wait; retrying (attempt ${attempt} of ${retrySchedule.totalAttempts}) after ${formatRetryWaitMs(waitMs)} (Retry-After)`
                : `${classMessage} — retrying (attempt ${attempt} of ${retrySchedule.totalAttempts}) in ${formatRetryWaitMs(remainingMs)}`,
          });
        };
        emitRetry(waitMs);
        log("warn", "provider.retry_ladder", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
          attempt,
          totalAttempts: retrySchedule.totalAttempts,
          waitMs,
          errorClass: classified.class,
          // R105-C: the reason rides the structured log (and the lessons
          // row) so post-hoc analysis can separate quota burn from
          // throttling without re-reading provider bodies.
          rateLimitReason: classified.rateLimitReason,
        });
        registerActiveRetryWait({
          sessionId: session.id,
          attempt,
          totalAttempts: retrySchedule.totalAttempts,
          waitMs,
          startedAt: Date.now(),
          until: Date.now() + waitMs,
        });
        const waitOutcome = await waitForRetry({ waitMs, signal, onTick: emitRetry });
        clearActiveRetryWait(session.id);
        // ROUND-92 (R92-D): the ladder retry starts a FRESH pool rotation
        // from the ORIGINAL key (the documented choice: the wait may
        // outlive the quota window, and the original key is the preferred
        // one — children: the reserved slot; main turns: the primary). If
        // the retried call fails key-attributably again, the rotation
        // re-engages from scratch (each rung may burn the whole pool once).
        apiKey = prepared.keyPool[startPoolIndex]!.key;
        activeKeySlot = prepared.keyPool[startPoolIndex]!.slot;
        keyRotationIndex = startPoolIndex;
        // The partial text/thinking persists now (stats unknown — the
        // finish frame never arrived); the retry iteration re-assembles
        // history from the log and CONTINUES from it. (In the aborted case
        // the abort path's own flush becomes a no-op on the now-empty
        // segment — the partial work is never lost or duplicated.)
        flushSegment(true);
        if (waitOutcome === "completed") {
          // The retry re-runs THIS iteration — compensate the for-increment
          // so the ladder never spends the outer-loop budget (bounded by
          // providerRetries, never infinite).
          outerIter -= 1;
        }
        // Aborted during the wait (user stop) → the plain continue: the
        // re-run call throws immediately on the aborted signal and the
        // catch's signal.aborted path above returns the honest ABORTED
        // outcome. (An abort landing in the deadline race self-corrects
        // the same way.)
        continue;
      }
      // ── ROUND-94 (R94-D1, Part 2b — the STREAMED twin of the sync branch
      // above): the ONE unknown-with-PROGRESS retry. `unknown` stays
      // fail-fast by the R75 contract, EXCEPT when the dying turn already
      // did real work — persisted tool results (turnToolCalls > 0), a
      // flushed assistant segment (lastAssistantEvent), or text currently
      // streaming unflushed (iterText). The owner's exact dead end:
      // sub-agents had finished their calls, the generation then died with
      // "Generation failed: unknown object" (a shape no pattern predicted),
      // and the turn failed FAST with the whole task torched. ONE bounded
      // extra attempt after a short wait, VISIBLE on the stream (the
      // meta.retry card the UI already renders — the same frame shape the
      // ladder emits), then the existing honest terminal path below. ──
      if (
        classified.class === "unknown" &&
        unknownProgressRetries === 0 &&
        (turnToolCalls > 0 || lastAssistantEvent !== null || iterText.trim() !== "") &&
        // A retry iteration must REMAIN (the overflow guard's rule — a
        // recovery `continue` on the last iteration would fall out of the
        // loop with no error set, faking success).
        outerIter < maxOuterLoops - 1
      ) {
        unknownProgressRetries = 1;
        emit({
          type: "meta.retry",
          sessionId: session.id,
          // The single extra attempt: 2 of 2 — the card the UI already
          // renders (attempt/totalAttempts/waitMs/…), the same frame shape
          // the ladder emits, so no frontend change is needed.
          attempt: 2,
          totalAttempts: 2,
          waitMs: UNKNOWN_PROGRESS_RETRY_MS,
          remainingMs: UNKNOWN_PROGRESS_RETRY_MS,
          retryAt: Date.now() + UNKNOWN_PROGRESS_RETRY_MS,
          errorClass: classified.class,
          classMessage,
          providerError: scrubSecrets(providerErrorDetail(normalized, apiKey), keySecrets),
          message: `${classMessage} — provider error, retrying (attempt 2 of 2) in ${formatRetryWaitMs(UNKNOWN_PROGRESS_RETRY_MS)}`,
        });
        log("warn", "provider.unknown_progress_retry", {
          sessionId: session.id,
          agentId: agent.id,
          providerId: provider.id,
          model,
          attempt: 2,
          waitMs: UNKNOWN_PROGRESS_RETRY_MS,
          errorClass: classified.class,
        });
        registerActiveRetryWait({
          sessionId: session.id,
          attempt: 2,
          totalAttempts: 2,
          waitMs: UNKNOWN_PROGRESS_RETRY_MS,
          startedAt: Date.now(),
          until: Date.now() + UNKNOWN_PROGRESS_RETRY_MS,
        });
        const waitOutcome = await waitForRetry({ waitMs: UNKNOWN_PROGRESS_RETRY_MS, signal });
        clearActiveRetryWait(session.id);
        // The fresh pool rotation the ladder uses (the wait may outlive a
        // quota window; the original key is the preferred one).
        apiKey = prepared.keyPool[startPoolIndex]!.key;
        activeKeySlot = prepared.keyPool[startPoolIndex]!.slot;
        keyRotationIndex = startPoolIndex;
        // The partial text/thinking persists now (the ladder's flush
        // precedent — the retry iteration re-assembles history from the log
        // and CONTINUES from it; the partial work is never lost).
        flushSegment(true);
        if (waitOutcome === "completed") {
          // Re-run THIS iteration — compensated like every recovery path so
          // the extra attempt never spends the outer-loop budget.
          outerIter -= 1;
        }
        // Aborted during the wait → the re-run call throws on the aborted
        // signal and the catch's signal.aborted path above returns the
        // honest ABORTED outcome.
        continue;
      }
      // ROUND-75 (R75): the partial streamed text survives THIS exit too —
      // the R58-c abort flush, extended to the terminal error path (the
      // owner's "no silent loss" rule: abort, retry, and terminal failure
      // all keep what the model already said). The flush lands the
      // in-flight segment (stats unknown — the finish frame never came),
      // so the transcript shows the partial work followed by the error
      // card, and a follow-up "continue" resumes from it.
      flushSegment(true);
      // R75: the usage of completed iterations is real spend — record it
      // (the LOOP_GUARD + sync-swallow precedent; the pre-R75 error path
      // dropped it). The const capture keeps TS's flow analysis stable
      // across the awaits above (closure-assigned variables lose their
      // narrowing at await points).
      // (The cast tells TS the truth the closure hides: flushSegment — the
      // only writer — may have assigned a real event; without it TS narrows
      // the declaration's `null` through the whole catch.)
      const lastAssistantForUsage = lastAssistantEvent as { seq: number; ts: string; content: string } | null;
      if (lastAssistantForUsage !== null && (totalInputTokens > 0 || totalOutputTokens > 0)) {
        recordUsage(
          db,
          {
            agentId: agent.id,
            sessionId: session.id,
            provider: provider.id,
            model,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
            costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
            ts: lastAssistantForUsage.ts,
          },
          activeKeySlot,
          // ROUND-83 (R83): the turn's real SDK-call count rides the row.
          { providerCalls: totalRequests, origin: "turn" },
        );
      }
      logTurnEnd(session.id, false, Date.now() - startedAt, totalInputTokens, totalOutputTokens);
      // ROUND-43: persist the failure into the session timeline BEFORE
      // returning — otherwise the owner's reload shows a conversation that
      // ends at his message with no error and no retry (the silent-death
      // bug). The error event lands right after the user message, so the UI
      // renders the error card directly below it.
      // R92-D: scrubbed against every keyring-held key (multi-key world);
      // persistTurnError re-scrubs on its own side too (belt + braces).
      const providerErrorText = scrubSecrets(providerErrorDetail(normalized, apiKey), keySecrets);
      // R71-e2 D4: the class rides the message (the pinned prefix is kept)
      // and the envelope; D5's terminal line names the twice-overflow case.
      // R75: the attempts count (ladder rungs used + the initial call)
      // rides the message + payload + envelope — the error card says
      // "failed after N attempts" when the ladder ran.
      // R94-D1: the ONE unknown-progress retry counts too — the card never
      // under-reports what ran.
      // R95-E: the ONE thinking-loop de-escalating retry counts as well
      // (a second ThinkingLoopError lands here at attempts = 2).
      const attempts = providerRetries + unknownProgressRetries + thinkingLoopRetries + 1;
      const message = providerFailureMessage(provider.id, session.id, classified, overflowRecovered, attempts);
      // ROUND-97 (R97-E): the FAILED turn's real token spend — the completed
      // iterations' totals PLUS every failed attempt's streamed-so-far (the
      // catch above accumulates readStreamPartialUsage per attempt since
      // R97-J m7, so the totals ARE the full burn; the final attempt's
      // dribble rides in them). The owner's "if a model fails, then it does
      // not show me the total number of tokens sent, total number of tokens
      // received" report.
      const failedUsage =
        totalInputTokens > 0 || totalOutputTokens > 0
          ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
          : undefined;
      const errorTs = persistTurnError(db, {
        sessionId: session.id,
        agentId: agent.id,
        userSeq: userEvent.seq,
        code: "PROVIDER_ERROR",
        message,
        model,
        providerId: provider.id,
        providerError: providerErrorText,
        errorClass: classified.class,
        attempts,
        ...(failedUsage !== undefined ? { usage: failedUsage } : {}),
        keySecrets,
      });
      return {
        ok: false,
        status: 502,
        code: "PROVIDER_ERROR",
        message,
        details: {
          providerError: providerErrorText,
          errorClass: classified.class,
          // R78: the scrubbed real text (the catch's classMessage const).
          classMessage,
          model,
          userSeq: userEvent.seq,
          // R75: the total attempts (1 = no ladder ran) — the live error
          // card's "failed after N attempts" line + the task_failed
          // notification's body both read it.
          attempts,
          // R97-E: the FAILED turn's real token spend — the live error card's
          // "Tokens sent ↑ / received ↓" line reads it (the persisted
          // turn.error carries the same number; the folded card matches).
          ...(failedUsage !== undefined ? { usage: failedUsage } : {}),
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
          usage: {
            inputTokens: iterInputTokens,
            outputTokens: iterOutputTokens,
            ...(iterSawCached ? { cachedInputTokens: iterCachedInputTokens } : {}),
          },
          ms: iterMs,
          model,
        },
      });
    }
    statsCarrierNeeded = false;

    // ROUND-33 FIX (owner report: "hello, how are you" kept planning +
    // running tools in an infinite loop): an iteration that produced a text
    // reply with ZERO tool calls is a CONVERSATIONAL response — the model
    // considered the request answered. Continuing would force the model to
    // invent work nobody asked for. Break immediately. ROUND-49 exception:
    // when the text EVIDENCES tool intent (it names a tool / announces
    // delegation) the model stalled on the announce — spend the turn's ONE
    // intent-nudge and let it try again for real.
    // ROUND-96 (R96-B): the identical-response detector observes every
    // zero-tool iteration's text (any tool activity above resets its chain) —
    // the streamed twin of the sync path's wiring.
    if (iterToolCalls === 0) {
      const textWarn = loopGuard.onAssistantText(iterAllText);
      if (textWarn.action === "warn" && textWarn.reason !== undefined) {
        persistLoopWarning(db, session.id, agent.id, emit, {
          kind: "identical_text",
          message: textWarn.reason,
          ...(textWarn.count !== undefined ? { count: textWarn.count } : {}),
        });
        log("warn", "loop_guard.warn", {
          sessionId: session.id,
          agentId: agent.id,
          kind: "identical_text",
          count: textWarn.count,
        });
        // The ONE identical-text correction (bounded per turn): give the
        // model a chance to do the real work; a repeated text after it ends
        // the turn through the normal break below (the warning stands).
        if (!identicalTextNudgeUsed && textWarn.nudge !== undefined) {
          identicalTextNudgeUsed = true;
          pendingNudge = { role: "user", content: textWarn.nudge };
          pendingNudgeKind = "identical_text";
          continue;
        }
      }
      if (
        !nudgeUsed &&
        tools !== undefined &&
        toolIntentMentioned(iterAllText, Object.keys(tools))
      ) {
        nudgeUsed = true;
        pendingNudge = { role: "user", content: TOOL_INTENT_NUDGE };
        continue;
      }
      // ROUND-120 (R120-H, item 43): the BLANK-TAIL continuation — a blank
      // final iteration (no text, no tools) over an UNFINISHED todo plan is
      // positive mid-work evidence: feed the condition back to the model
      // ONCE instead of letting whitespace end the turn silently. The R77
      // carve-out stands for the no-plan / finished shapes (a tool-using
      // turn with no final text is legitimate — the tools did the work).
      if (
        iterAllText.trim() === "" &&
        turnToolCalls > 0 &&
        !blankTailContinuationUsed &&
        !latestTodosAllDone(db, session.id) &&
        // A retry iteration must REMAIN (the recovery paths' rule).
        outerIter < maxOuterLoops - 1
      ) {
        blankTailContinuationUsed = true;
        pendingNudge = { role: "user", content: BLANK_TAIL_CONTINUATION_NUDGE };
        continue;
      }
      break;
    }

    // ROUND-96 (R96-B, research finding #1 — completion = the model's own
    // stop): a tool-using iteration whose text is NON-EMPTY is the SDK's
    // natural end (its internal loop only stops when the model stops
    // calling tools — or the generous maxTurns cap binds, the accepted
    // edge). The R58-c phrase gate is RETIRED as the gate; the phrase now
    // only helps the todos-continuation decide. The ONE compromise for the
    // R58 heritage (a model that "finished" over an UNFINISHED plan):
    // unfinished todos + a signal-less text → exactly ONE user-role
    // continuation; after it (or with a signal / no plan) the turn ends.
    // (This is the streamed twin of the sync path's rule — the pre-R96-B
    // inverted heuristic here is what forced the assistant-last continuation
    // DeepSeek rejected with "The last message must have role=user".)
    if (iterAllText.trim() !== "") {
      const todosDone = latestTodosAllDone(db, session.id);
      const hasCompletionSignal = COMPLETION_SIGNAL.test(iterAllText);
      if (
        !todosDone &&
        !hasCompletionSignal &&
        !todosContinuationUsed &&
        // A retry iteration must REMAIN (the recovery paths' rule — a
        // continuation `continue` on the last iteration would fall out of
        // the loop with no error set).
        outerIter < maxOuterLoops - 1
      ) {
        todosContinuationUsed = true;
        pendingNudge = { role: "user", content: TODOS_CONTINUATION_NUDGE };
        pendingNudgeKind = "todos";
        continue;
      }
      break;
    }
    // Last iteration — emit a cap-reached event so the UI knows.
    // ROUND-120 (R120-H, item 43): reaching HERE means the final iteration
    // ran tools with NO closing text (the only shape that falls out of the
    // loop instead of breaking) — the model is STILL MID-WORK and the budget
    // ran out. The flag routes the post-loop exit through the honest
    // ITERATION_LIMIT stop; the frame stays for the clients that render it
    // (mobile does; the PC stream-store ignores it — the error card is the
    // surface BOTH platforms actually show).
    if (outerIter === maxOuterLoops - 1) {
      loopCapMidWork = true;
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
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          ...(sawCachedReport ? { cachedInputTokens: totalCachedInputTokens } : {}),
        },
        ms,
        model,
      },
    });
    lastAssistantEvent = { seq: fallback.seq, ts: fallback.ts, content: lastText };
  }

  // ROUND-80 (R80): the context/request guard stop — the LOOP_GUARD
  // pattern exactly (the silent-stop fix): persist the honest turn.error
  // (the error card's Retry re-sends the message; the session resets to
  // queued so it stays retryable), record the real token spend, and return
  // the 502 — never the pre-R80 ok:true that ended the chat with no error.
  if (guardStop !== null) {
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: guardStop.code,
      message: guardStop.message,
      model,
      providerId: provider.id,
      providerError: guardStop.message,
      keySecrets,
    });
    const guardUsage: UsageRecord = {
      agentId: agent.id,
      sessionId: session.id,
      provider: provider.id,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
      costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
      ts: lastAssistantEvent.ts,
    };
    recordUsage(db, guardUsage, activeKeySlot, { providerCalls: totalRequests, origin: "turn" });
    touchSession(db, session.id);
    logTurnEnd(session.id, false, ms, totalInputTokens, totalOutputTokens);
    log("warn", "turn.guard_stop", {
      sessionId: session.id,
      agentId: agent.id,
      code: guardStop.code,
      model,
      providerId: provider.id,
    });
    return {
      ok: false,
      status: 502,
      code: guardStop.code,
      message: guardStop.message,
    };
  }

  // ROUND-120 (R120-H, item 43): the ITERATION_LIMIT stop — the loop fell
  // out at its budget cap while the model was still calling tools (see the
  // loop-bottom flag). The pre-R120-H behavior: ok:true + the empty-marker
  // assistant event + the SSE-only meta.continuation_complete frame — the
  // owner's exact "stops midway — mid-command, mid-file-read, mid-write —
  // with no model error and no visible cause" report (the PC stream-store
  // ignores the frame, so the stop was invisible everywhere but mobile).
  // The R80 REQUEST_LIMIT precedent is the law: the honest stop persists
  // turn.error (the card's Retry re-sends the message — and the follow-up
  // "continue" genuinely resumes from the preserved event log, which now
  // also rides the item-44 resume context), records the real token spend,
  // and returns the 502 so the route's error branch + the task_failed
  // notification fire. NEVER a clean-looking empty completion.
  if (loopCapMidWork && guardStop === null) {
    const iterationLimitMessageText = iterationLimitMessage(session.id, maxOuterLoops);
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "ITERATION_LIMIT",
      message: iterationLimitMessageText,
      model,
      providerId: provider.id,
      providerError: iterationLimitMessageText,
      keySecrets,
    });
    const capUsage: UsageRecord = {
      agentId: agent.id,
      sessionId: session.id,
      provider: provider.id,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
      costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
      ts: lastAssistantEvent.ts,
    };
    recordUsage(db, capUsage, activeKeySlot, { providerCalls: totalRequests, origin: "turn" });
    touchSession(db, session.id);
    logTurnEnd(session.id, false, ms, totalInputTokens, totalOutputTokens);
    log("warn", "turn.iteration_limit", {
      sessionId: session.id,
      agentId: agent.id,
      code: "ITERATION_LIMIT",
      maxOuterLoops,
      model,
      providerId: provider.id,
    });
    return {
      ok: false,
      status: 502,
      code: "ITERATION_LIMIT",
      message: iterationLimitMessageText,
      details: {
        providerError: iterationLimitMessageText,
        model,
        userSeq: userEvent.seq,
        maxOuterLoops,
      },
    };
  }

  // ROUND-77 (R77, the live-battery find — the T5 turn-10 flake): a turn
  // whose ENTIRE output is blank — no visible text AND zero tool calls —
  // is the free-models' whitespace-reply flake (glm-5.2:free "answered"
  // with a run of newlines; the requested file edit silently never
  // happened while the turn completed ok and the UI showed a normal,
  // empty reply). Guarding ONLY the streamed path (where the flake was
  // observed live): a tool-using turn with no final text is legitimate
  // (the tools DID the work — the R35 empty-marker path), and a user STOP
  // can never reach here (aborts exit through the catch's ABORTED return).
  // Mirror the loop-guard exit: persist an honest turn.error (the error
  // card's Retry re-sends the message), record the real token spend, and
  // return the 502 — never a fake "completed" empty reply.
  if (turnToolCalls === 0 && lastText.trim() === "") {
    const blankMessage =
      `the model returned an empty response (no text, no tool calls) for session ${session.id} — resend the message`;
    const blankProviderError =
      "empty response — the model produced only whitespace (a free-model flake); the requested work did not happen";
    persistTurnError(db, {
      sessionId: session.id,
      agentId: agent.id,
      userSeq: userEvent.seq,
      code: "NO_OUTPUT",
      message: blankMessage,
      model,
      providerId: provider.id,
      providerError: blankProviderError,
      keySecrets,
    });
    const blankUsage: UsageRecord = {
      agentId: agent.id,
      sessionId: session.id,
      provider: provider.id,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
      costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
      ts: lastAssistantEvent.ts,
    };
    recordUsage(db, blankUsage, activeKeySlot, { providerCalls: totalRequests, origin: "turn" });
    touchSession(db, session.id);
    logTurnEnd(session.id, false, ms, totalInputTokens, totalOutputTokens);
    log("warn", "turn.blank_output", {
      sessionId: session.id,
      agentId: agent.id,
      model,
      providerId: provider.id,
    });
    return {
      ok: false,
      status: 502,
      code: "NO_OUTPUT",
      message: blankMessage,
      details: { providerError: blankProviderError, model, userSeq: userEvent.seq },
    };
  }

  const usage: UsageRecord = {
    agentId: agent.id,
    sessionId: session.id,
    provider: provider.id,
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    // ROUND-50 (R50-c1) → ROUND-83 (R83): NULL when no provider call
    // reported a cached tier (the shared type's documented contract — a
    // provider without cache reporting shows "— not reported", never a
    // fabricated 0% hit rate; the audit's §2.10).
    cachedInputTokens: sawCachedReport ? totalCachedInputTokens : null,
    costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
    ts: lastAssistantEvent.ts,
  };
  // ROUND-64 (R64-e): keySlot attributes the successful turn's spend.
  // ROUND-83 (R83): providerCalls rides the row (the usage screens' honest
  // "N turns · M provider calls" line).
  recordUsage(db, usage, activeKeySlot, { providerCalls: totalRequests, origin: "turn" });
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
  // ROUND-117 (R117-b): the turn-end memory capture step (the streamed
  // twin's terminal path — same step as the sync runner above).
  captureTurnEndMemory(db, {
    sessionId: session.id,
    agentId: agent.id,
    projectId: session.projectId,
    memoryPolicy: agent.memoryPolicy,
  });
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

/**
 * ROUND-83 (R83): where the context window CAME from — the honest source
 * label the context meter renders ("your override" / "catalog default" /
 * "assumed 200k — unknown model"). `getModelContextWindow` collapses this
 * into a bare number; the meter route needs the provenance so a silent
 * 200K guess can never masquerade as a measured window (the audit's §2.7:
 * a 1M-window model showed ~5× fuller than reality; a 32K model showed 3%
 * while the provider was about to reject the request).
 */
export type ContextWindowSource = "override" | "catalog" | "default";

/** ROUND-83 (R83): the ONE budget both the turn loop and the meter route use. */
export interface TurnBudget extends ContextBudget {
  /** Provenance of contextWindow: models-table override | catalog | 200K default. */
  contextWindowSource: ContextWindowSource;
  /** The behavioral line: contextWindow − maxOutputTokens − margin. */
  available: number;
}

/**
 * ROUND-83 (R83): ONE budget, computed ONCE, used by BOTH the meter route
 * and the turn runners (the audit's §2.5: the donut and the compaction
 * trigger previously disagreed — the displayed number was never the number
 * that drove behavior). Resolution:
 *   · contextWindow — models-table override → catalog → 200_000, with source;
 *   · maxOutputTokens — models.max_output_tokens → catalog.maxOutputTokens
 *     → 32_768. The owner's per-model output limit is stored and editable
 *     since migration 0004 but was NEVER read by the runtime (the audit's
 *     §2.8) — both budget sites hardcoded 32_768. Now the owner's edit is
 *     the truth; the catalog's provider cap is the fallback; 32_768 is the
 *     last resort for unknown models.
 *   · margin — 8_000 (unchanged: system-prompt + schema slack);
 *   · available = contextWindow − maxOutputTokens − margin — the same line
 *     compaction triggers on and (R83) the context guard stops at.
 */
export function resolveTurnBudget(db: SqliteDatabase, providerId: string, modelId: string): TurnBudget {
  const row = db
    .prepare("SELECT context_window, max_output_tokens FROM models WHERE provider_id = ? AND model_id = ?")
    .get(providerId, modelId) as { context_window: number | null; max_output_tokens: number | null } | undefined;
  const catalog = getCatalogModel(modelId);
  const contextWindow = row?.context_window ?? catalog?.contextWindow ?? 200_000;
  const contextWindowSource: ContextWindowSource =
    row?.context_window !== null && row?.context_window !== undefined
      ? "override"
      : catalog !== undefined
        ? "catalog"
        : "default";
  const maxOutputTokens = row?.max_output_tokens ?? catalog?.maxOutputTokens ?? 32_768;
  const margin = 8_000;
  return {
    contextWindow,
    contextWindowSource,
    maxOutputTokens,
    margin,
    available: contextWindow - maxOutputTokens - margin,
  };
}
