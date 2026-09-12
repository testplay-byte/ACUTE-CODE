/**
 * ROUND-36 (ADR-0022): the sub-agent orchestrator.
 *
 * One module-level singleton per sidecar process. Responsibilities:
 * - delegateTask: create a CHILD session, acquire a key slot + semaphore
 *   permits, run the child turn (ROUND-50/R50-b: runStreamedAgentTurn when the
 *   delegating turn streams — live raw deltas through the subagent-event
 *   envelope; runSingleAgentTurn as the sync fallback, verbatim per PILLARS
 *   §1), and return the child's final report.
 * - Concurrency: total semaphore (orchestration.maxParallel) + per-key
 *   semaphore (orchestration.perKeyLimit); excess children stay queued.
 * - Key assignment: the LEAST-LOADED pool slot (ROUND-92/R92-D: no primary
 *   bias — all keys serve everyone now; the primary is simply slot 0).
 *   The slot RESERVATION is load-spreading + concurrency-capping only —
 *   the child receives the PARENT keyring unchanged (the full pool) and
 *   starts from the reserved slot's key, juggling to the next key on
 *   key-attributable failures (runtime.ts's turn runners).
 * - ROUND-43 (R43-5, owner directive): orchestration.subagentModel — when
 *   set, EVERY child turn runs on that model id (passed as runSingleAgentTurn's
 *   modelOverride); when null (default) children inherit the seeded agent's
 *   model exactly as before. The override changes what CHILDREN run on — the
 *   parent's model is never touched.
 * - Crash recovery: failed children are retryable — the event log IS the
 *   resume point (R34 assembleHistory feeds tool results back), so a retry
 *   continuation genuinely resumes. A boot sweep flips stale `running`
 *   sessions to `failed`.
 * - Live status: `subagent-status` events emitted through the parent's
 *   stream on every state transition.
 */
import type Database from "better-sqlite3";
import {
  appendDelegationCollected,
  appendSessionEvent,
  BACKGROUND_TASK_REMINDER_CAP,
  childTerminalText,
  collectedChildIds,
  createSession,
  getSession,
  listSessionEvents,
  listSubAgents,
  setSessionStatus,
  subAgentCode,
  type Session,
  type SubAgentStatus,
} from "../storage/sessions.js";
import type { Agent } from "../storage/agents.js";
// ROUND-75 (R75): the retry-ladder's active-wait registry — the watchdog
// consults it so a child legitimately waiting out a 5/10/30-minute
// transient-API retry is never stall-killed (no persisted events during a
// wait is EXPECTED, not a hang).
import { getActiveRetryWait } from "../lib/retry.js";
// ROUND-52 (R52-b): the shared turn registry — children register their own
// AbortController so POST /sessions/:id/stop can stop a sub-agent directly,
// and the supervisor can abort a stalled one.
import { registerTurn, unregisterTurn, getTurnStopReason, abortTurn } from "../lib/turn-registry.js";
import { getAgent } from "../storage/agents.js";
import { getOrchestrationSettings } from "../storage/settings.js";
import { resolveKeyPool, type ProviderKeyring } from "../providers/registry.js";
import { runSingleAgentTurn, runStreamedAgentTurn, type TurnModelOverride } from "./runtime.js";
import type { TurnDeps } from "./runtime.js";
// ROUND-40: sub-agent transitions publish app-level notifications so the user
// sees when a delegated task completes or fails (even if they navigated away).
import { getNotificationBus } from "../lib/notification-bus.js";
// ROUND-79 (R79-a): background-settlement + detached-crash log lines (the
// fire-and-forget run has no caller to return to — the log is the trace).
import { log } from "../lib/log.js";

export type SqliteDatabase = Database.Database;

/** ROUND-82: the override's provider when it carries one (the provider-scoped
 * subagentModel ref {providerId, modelId}) — undefined for bare string
 * overrides and blank providerIds. Used to key the child's slot reservation
 * (and its usage attribution) on the EFFECTIVE provider (see runChildTurn). */
function overrideProviderId(
  override: TurnModelOverride | undefined,
): string | undefined {
  if (override === undefined || typeof override === "string") return undefined;
  const pid = typeof override.providerId === "string" ? override.providerId.trim() : "";
  return pid !== "" ? pid : undefined;
}

/** Roles map to the seeded templates' framing (children run the PARENT's
 * provider/model/temperature — templates carry no provider config).
 * ROUND-84 (R84, Wave 2-c): the vocabulary lives in the sub-roles LEAF
 * (agents/sub-roles.ts) — re-imported here; the value-import from the
 * delegation plugin (the 25-file SCC's root cause) is gone. */
import { SUB_ROLES, type SubRole } from "./sub-roles.js";
export type { SubRole };

const ROLE_FRAMING: Record<SubRole, string> = {
  planner:
    "You are acting as a PLANNER sub-agent. Produce a concise, ordered plan for the task with acceptance criteria per step. Do not implement.",
  researcher:
    "You are acting as a RESEARCHER sub-agent. Investigate and report findings with concrete file paths and evidence. Flag uncertainty explicitly.",
  coder:
    "You are acting as a CODER sub-agent. Write precise, minimal diffs that implement exactly the assigned task. Follow existing conventions.",
  reviewer:
    "You are acting as a REVIEWER sub-agent. Review the work for correctness, security, and clarity; cite files and severity; propose minimal fixes.",
  tester:
    "You are acting as a TESTER sub-agent. Design and run checks that prove the task's acceptance criteria; report exact reproduction steps for failures.",
};

/** ROUND-79 (R79-a, the orchestrator round): the task_id grammar — one
 * leading alphanumeric, then alphanumerics/dots/underscores/hyphens, 1-64
 * characters total. Kept deliberately tight: an address the model has to
 * REPRODUCE in a later delegate_task {"resume":"..."} call, so no spaces,
 * no unicode, no colons that could bleed into JSON-ish phrasing. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** ROUND-79 (R79-a): the outstanding-background fan-out cap — a parent may
 * hold at most this many queued|running children WITH a task_id before
 * further BACKGROUND delegations are refused honestly (runaway-queue
 * guard; the global orchestration.maxParallel semaphore still caps actual
 * parallelism — this stops an unbounded backlog, not concurrency). */
const BACKGROUND_TASK_CAP = 10;

/** ROUND-79 (R79-a): the resume WAIT's session-status poll interval (the
 * model never sleep-polls — RESUME is the wait; this is the internal
 * cadence of that wait, ~300ms per the plan). */
const RESUME_POLL_MS = 300;

/** ROUND-79 (R79-a): the collected-report return — the header + the final
 * report from the SHARED extraction (childTerminalText: the last non-empty
 * message.assistant — the exact text the Sub-agents panel row shows as
 * `report`, so the tool result and the panel can never disagree). Used by
 * the completed path and the post-retry path of resumeTask. */
function collectOutcome(
  db: SqliteDatabase,
  child: SubAgentStatus,
): { ok: boolean; output: string } {
  const header = `[subagent session: ${child.id}${child.taskId !== null ? ` | task_id: ${child.taskId}` : ""} | role: ${child.subRole ?? "researcher"}]`;
  const { report } = childTerminalText(db, child.id);
  if (report === null) {
    return {
      ok: true,
      output: `${header}\nSub-agent completed, but its log holds no final report text (no non-empty assistant message) — its session is preserved for inspection.`,
    };
  }
  return { ok: true, output: `${header}\nSub-agent completed.\n\n${report}` };
}

/**
 * ROUND-39 (owner: "the sub-agents were apparently not capable enough. The
 * sub-agents were only able to respond one time and they were not able to
 * perform complex tasks like multi-stage tasks like the main agent could. I
 * want the sub-agents to get all the capabilities of the main one"). The
 * task-prompt suffix that turns the framing into a full, multi-stage
 * directive. Mandates tool use (the screenshot showed sub-agents writing a
 * text reply that DESCRIBED the first step without actually calling any
 * tools — premature text-only response). Tells the model it has many tool
 * round-trips available (maxTurns×maxOuterLoops). Tells it to use todo_write
 * to track multi-step work. Tells it to ONLY produce a final text summary
 * when the task is genuinely complete.
 */
const TASK_SUFFIX = `

TASK: {{TASK}}

You are an autonomous sub-agent with the SAME tools and capabilities as the main agent. You have MANY tool round-trips available — do NOT stop after one tool call. Use your tools to ACTUALLY DO THE WORK, not just describe what you would do.

REQUIRED APPROACH for non-trivial tasks:
1. Call todo_write FIRST with a step-by-step plan (one todo per concrete sub-task).
2. Execute each todo in order, calling the appropriate tools (list_dir, read_file, write_file, edit_file, run_command, web_search, web_fetch, etc.).
3. After each tool result, decide the next step based on what you observed — iterate until the task is fully complete.
4. Mark each todo in_progress when you start it, completed when its acceptance criterion is met.
5. ONLY when ALL todos are completed, write a concise final report summarizing what you did, the files you changed, and any important findings.

DO NOT:
- Write a text reply that says "I'll start by..." or "Step 1: ..." without an accompanying tool call. That is NOT doing the work.
- Stop after a single tool call if there is more work to do.
- Reply with a plan only — execute the plan.
- Produce a "final report" until the work is actually finished (the parent agent reads your final reply as your deliverable).

Begin now: call todo_write with your plan, then execute it.`;

/** Renders the task suffix with the actual task text substituted in. */
function renderTaskPrompt(task: string): string {
  return TASK_SUFFIX.replace("{{TASK}}", task);
}

/** ROUND-52 (R52-b): the supervisor's heartbeat sample of a running child —
 * what the main agent (and the sub-agent panel) can see about a child WITHOUT
 * waiting for it to finish: what it last did, how long ago, how far along its
 * todos are, how many tool calls it has made. Carried on `running` status
 * frames as `watch`. */
export interface SubAgentWatchSample {
  /** ms since the child's LAST persisted event (message/tool) — the stall signal. */
  lastEventAgeMs: number;
  /** The child's last tool call ("run_command …") or message kind. */
  lastActivity: string;
  /** Total tool.use events so far. */
  toolCount: number;
  todosDone: number;
  todosTotal: number;
  /** Wall-clock ms since the child started running. */
  elapsedMs: number;
  /** True when lastEventAgeMs exceeds the stall threshold — the watchdog
   * is about to abort the child (the frame that carries this is a warning). */
  stalled: boolean;
}

export interface SubAgentEventPayload {
  type: "subagent-status";
  sessionId: string;
  parentSessionId: string;
  status: "queued" | "running" | "completed" | "failed";
  task: string;
  role: string;
  /** ROUND-48 (R48-e1): deterministic 4-char [A-Z0-9] code of the child
   * session (subAgentCode(child.id)) — same value as the `code` field on
   * GET /sessions/:id/subagents rows, so the UI can join the live status
   * stream to the polled list + approval attribution by either id or code. */
  code: string;
  /** ROUND-79 (R79-a): the parent's own address for this child
   * (sessions.delegate_task_id) when the delegation is addressable — the
   * same value as the `taskId` field on the polled /subagents row, so the
   * Sub-agents panel's task chip joins the live frames by it. Absent on
   * unaddressed delegations (pre-R79 frames are unchanged). */
  taskId?: string;
  todosDone?: number;
  todosTotal?: number;
  /** ROUND-50 (R50-b, owner: the sub-agent stats footer must show "the model
   * which was being used"): the model the child turn ACTUALLY runs on —
   * orchestration.subagentModel ?? agent.model, resolved at delegation time
   * and attached to every status frame this delegation emits (queued/
   * running/completed/failed), so the UI can render it before the first
   * usage_events row lands in the polled /subagents row. */
  model?: string;
  /** ROUND-52 (R52-b): the supervisor's heartbeat sample (running frames
   * only) — live "what is this sub-agent doing" stats for the panel. */
  watch?: SubAgentWatchSample;
  /** ROUND-52 (R52-b): a human-readable one-liner for terminal frames —
   * e.g. "stopped by the owner" or "stalled: no activity for 5m" — so the
   * UI can show WHY a child failed instead of a bare status. */
  detail?: string;
}

/** ROUND-52 (R52-b): sample a running child's supervision stats — pure
 * (db reads only), exported for unit tests. `startedAt` is the delegation's
 * wall-clock start. */
export function sampleChildWatch(
  db: SqliteDatabase,
  childId: string,
  startedAt: number,
  stallTimeoutMs: number,
  todosDone: number,
  todosTotal: number,
): SubAgentWatchSample {
  const events = listSessionEvents(db, childId);
  const last = events[events.length - 1];
  let lastActivity = "waiting for its first model response";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.type === "tool.use") {
      const name = (ev.payload as { toolName?: string }).toolName ?? "tool";
      const summary = (ev.payload as { argsSummary?: string }).argsSummary ?? "";
      lastActivity = `${name} ${summary}`.trim().slice(0, 120);
      break;
    }
    if (ev.type === "message.assistant") {
      lastActivity = "wrote an assistant message";
      break;
    }
  }
  // ts is an ISO string (SessionEvent.ts) — parse for the age math.
  const lastTs = last !== undefined ? Date.parse(last.ts) : Date.now();
  const lastEventAgeMs = Math.max(0, Date.now() - (Number.isNaN(lastTs) ? Date.now() : lastTs));
  return {
    lastEventAgeMs,
    lastActivity,
    toolCount: events.filter((e) => e.type === "tool.use").length,
    todosDone,
    todosTotal,
    elapsedMs: Date.now() - startedAt,
    stalled: lastEventAgeMs > stallTimeoutMs,
  };
}

/** Live registry entry (semaphore bookkeeping). */
interface ChildRun {
  childId: string;
  parentSessionId: string;
  keySlot: number;
}

class Orchestrator {
  /** key `slot:<providerId>:<slot>` → active children count. */
  private readonly keyActive = new Map<string, number>();
  private readonly active = new Set<string>();
  private runs: ChildRun[] = [];

  private keyId(providerId: string, slot: number): string {
    return `${providerId}:${slot}`;
  }

  /**
   * Atomically RESERVE a slot (total semaphore + per-key semaphore + key
   * assignment in one synchronous step — a check-then-increment race let two
   * children through on one permit; reservation must be indivisible).
   * Returns the slot, or null when no capacity is free right now.
   *
   * ROUND-92 (R92-D): the pool is the DEDUPED one (resolveKeyPool — the same
   * derivation prepareTurn uses), so perKeyLimit caps per distinct KEY
   * VALUE, and the ROUND-36 "prefer non-primary slots so the primary isn't
   * burdened" bias is GONE: one pool serves everyone (main agent included).
   * Ordering is least-loaded, then lowest slot number — the reservation
   * itself is load-spreading + concurrency-capping; which key a child
   * actually runs on (and what it swaps to on failure) is the turn runner's
   * juggling, seeded from this slot via TurnDeps.keySlot.
   */
  private tryReserveSlot(
    db: SqliteDatabase,
    keyring: ProviderKeyring,
    providerId: string,
    childId: string,
  ): number | null {
    const { maxParallel, perKeyLimit } = getOrchestrationSettings(db);
    if (this.active.size >= maxParallel) return null;
    const pool = resolveKeyPool(keyring, providerId);
    // Least-loaded first, then lowest slot number (R92-D: no primary bias).
    const candidates = [...pool]
      .map((c) => ({ ...c, load: this.keyActive.get(this.keyId(providerId, c.slot)) ?? 0 }))
      .filter((c) => c.load < perKeyLimit)
      .sort((a, b) => {
        if (a.load !== b.load) return a.load - b.load;
        return a.slot - b.slot;
      });
    const chosen = candidates[0];
    if (chosen === undefined) return null;
    // Reserve.
    this.active.add(childId);
    this.keyActive.set(this.keyId(providerId, chosen.slot), chosen.load + 1);
    this.runs.push({ childId, parentSessionId: "", keySlot: chosen.slot });
    return chosen.slot;
  }

  /**
   * Poll until a slot frees up (the queued child stays `queued` in the UI).
   * R93-B4 (the owner: "I looked at running some sub-agent tasks but
   * apparently it was NOT able to run the sub-agent tasks at all, most
   * probably because of only one API key"): an EMPTY POOL fails FAST —
   * the infinite poll below could never resolve without the owner adding
   * a key, so the child hung `queued` forever while the parent's
   * delegate_task never returned (the real "not able to run sub-agent
   * tasks" failure). A busy pool (maxParallel children running, or
   * perKeyLimit reached) keeps polling — that is legitimate queueing and
   * resolves on its own as children finish. Returns the reserved slot, or
   * the "EMPTY_POOL" marker the caller turns into an honest failure.
   */
  private async acquireSlot(
    db: SqliteDatabase,
    keyring: ProviderKeyring,
    providerId: string,
    childId: string,
  ): Promise<number | "EMPTY_POOL"> {
    for (;;) {
      // R93-B4: the empty-pool gate FIRST — a pool with zero keys can never
      // free up on its own (the owner must add a key in Settings).
      if (resolveKeyPool(keyring, providerId).length === 0) return "EMPTY_POOL";
      const slot = this.tryReserveSlot(db, keyring, providerId, childId);
      if (slot !== null) return slot;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private releaseSlot(providerId: string, slot: number, childId: string): void {
    const key = this.keyId(providerId, slot);
    const next = (this.keyActive.get(key) ?? 1) - 1;
    if (next <= 0) this.keyActive.delete(key);
    else this.keyActive.set(key, next);
    this.active.delete(childId);
    this.runs = this.runs.filter((r) => r.childId !== childId);
  }

  /** Count completed todos from the child log (progress for status events). */
  private progressOf(db: SqliteDatabase, childId: string): { todosDone: number; todosTotal: number } {
    let todosDone = 0;
    let todosTotal = 0;
    for (const ev of listSessionEvents(db, childId)) {
      if (ev.type !== "todo.update") continue;
      const todos = (ev.payload as { todos?: Array<{ status?: string }> }).todos;
      if (Array.isArray(todos) && todos.length > 0) {
        todosTotal = todos.length;
        todosDone = todos.filter((t) => t.status === "completed").length;
      }
    }
    return { todosDone, todosTotal };
  }

  /**
   * Delegate a subtask: creates the child session, runs it to completion
   * (concurrency-limited), and returns the child's final report.
   *
   * ROUND-79 (R79-a): the child-run machinery this method used to carry
   * inline (creation → framing → slot → keyring view → registry →
   * watchdog → wrapped emit → run → terminal + notify + release) is
   * EXTRACTED into runChildTurn below so the BLOCKING path and the new
   * BACKGROUND path (delegateBackground) share ONE implementation — the
   * observable blocking behavior is unchanged (the existing suite is the
   * regression gate). New surface: the optional taskId — the parent's own
   * address for this delegation (validated + duplicate-checked upstream);
   * a BLOCKING delegation with task_id writes `delegation.collected` on
   * the parent log at completion, because the report was delivered inline
   * and the per-turn BACKGROUND TASKS reminder must never nag about it.
   */
  async delegateTask(
    deps: TurnDeps,
    parentSessionId: string,
    task: string,
    role: SubRole,
    /** ROUND-40: widened from (SubAgentEventPayload) => void to
     * (unknown) => void so the SAME channel can carry both subagent-status
     * envelopes (queued/running/completed/failed) AND subagent-event
     * envelopes wrapping the child's live tool/text events. The parent's
     * SSE emit already accepts unknown; this just stops artificially
     * narrowing it. */
    emit?: (event: unknown) => void,
    /** ROUND-48 (R48-e1): the parent turn's abort signal. Forwarded into the
     * child's runSingleAgentTurn so (a) pending child approvals deny on
     * abort (fail-closed) and (b) the child's outer loop stops BETWEEN
     * iterations with an honest ABORTED outcome when the owner stops the
     * parent. The delegate_task tool passes its toolDeps.signal (the live
     * parent turn's signal). */
    signal?: AbortSignal,
    /** ROUND-79 (R79-a): the parent's own address for this delegation —
     * validated (TASK_ID_RE) and duplicate-checked against this parent's
     * children (ANY status: an address is handed out once) BEFORE any
     * child is created. On completion the parent log gains a
     * delegation.collected event naming this child (the uniform collected
     * rule: a blocking task_id is collected when its report is delivered
     * inline; a background task at resume). */
    taskId?: string,
  ): Promise<{ ok: boolean; output: string; sessionId?: string }> {
    const resolved = this.resolveDelegation(deps, parentSessionId, task, taskId);
    if (typeof resolved === "string") {
      return { ok: false, output: resolved };
    }
    const child = this.createChildSession(
      deps,
      resolved.parent,
      resolved.agent,
      parentSessionId,
      task,
      role,
      resolved.taskId,
    );
    const result = await this.runChildTurn(
      deps,
      {
        parentSessionId,
        parent: resolved.parent,
        child,
        task,
        role,
        // The delegation input: role framing + the multi-stage mandate.
        content: `${ROLE_FRAMING[role]}\n${renderTaskPrompt(task)}`,
        providerId: resolved.providerId,
        modelOverride: resolved.modelOverride,
        effectiveModel: resolved.effectiveModel,
        emit,
        signal,
      },
    );
    // ROUND-79 (R79-a): a BLOCKING delegation with task_id marks itself
    // COLLECTED at completion — the tool result (report OR failure line)
    // was delivered inline, so the per-turn reminder must never list this
    // task again. EXCEPT when the parent turn was aborted mid-call (the
    // tool result was abandoned — the model never read it): the reminder
    // then honestly keeps listing the task so a later turn can resume it.
    if (resolved.taskId !== undefined && signal?.aborted !== true) {
      appendDelegationCollected(deps.db, parentSessionId, {
        taskId: resolved.taskId,
        childId: child.id,
        childCode: subAgentCode(child.id),
      });
    }
    return result;
  }

  /**
   * ROUND-79 (R79-a, the orchestrator round): delegate a subtask in the
   * BACKGROUND — create the child, emit the queued frame, kick off the
   * DETACHED run, and return IMMEDIATELY with the receipt (task_id,
   * session id, code, role, model + the resume instructions).
   *
   * Semantics (the plan's contract, verbatim):
   *  - NEVER awaited by the tool call: the run carries its own
   *    fulfill/reject handlers, so there is structurally no unhandled
   *    rejection.
   *  - The run acquires its concurrency slot INSIDE the shared machinery —
   *    a full semaphore leaves the child honestly `queued` while this call
   *    has already returned.
   *  - The full watchdog/turn-registry/notification machinery rides the
   *    shared path exactly as for blocking children.
   *  - The wrapped emit is BEST-EFFORT (try/catch, swallow): a background
   *    child routinely OUTLIVES the parent turn's SSE stream, and a write
   *    on the dead stream must never kill the run.
   *  - PARENT-TURN ABORT STILL CASCADES (deliberate, documented choice):
   *    the child receives the same parent signal the blocking path
   *    forwards, so the owner's Stop on the parent stops the background
   *    spend too — no zombie children after the owner said stop. A
   *    normally ENDED parent turn never aborts its controller (only the
   *    stop route does), so a healthy background child outlives the turn.
   *  - The child's completion does NOT write delegation.collected (the
   *    report was not delivered anywhere yet): the per-turn reminder keeps
   *    listing it as COMPLETED until delegate_task {"resume":"<task_id>"}
   *    collects it.
   */
  async delegateBackground(
    deps: TurnDeps,
    parentSessionId: string,
    task: string,
    role: SubRole,
    /** REQUIRED (validated): the parent's address for this delegation. */
    taskId: string,
    emit?: (event: unknown) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; output: string; sessionId?: string }> {
    const resolved = this.resolveDelegation(deps, parentSessionId, task, taskId);
    if (typeof resolved === "string") {
      return { ok: false, output: resolved };
    }
    // The background-only gate: the ≥10 outstanding fan-out cap (the
    // runaway-queue guard; the global semaphore still caps real
    // parallelism). Honest refusal LISTING the outstanding tasks.
    const capRefusal = this.backgroundCapRefusal(deps.db, parentSessionId);
    if (capRefusal !== null) {
      return { ok: false, output: capRefusal };
    }
    const child = this.createChildSession(
      deps,
      resolved.parent,
      resolved.agent,
      parentSessionId,
      task,
      role,
      resolved.taskId,
    );
    const code = subAgentCode(child.id);
    // DETACHED run — the shared machinery, fire-and-forget. Its synchronous
    // prefix (the queued status frame + the first atomic slot reservation
    // attempt) executes before the first await, so the queued frame is on
    // the parent's stream before this call returns.
    this.runChildTurn(
      deps,
      {
        parentSessionId,
        parent: resolved.parent,
        child,
        task,
        role,
        content: `${ROLE_FRAMING[role]}\n${renderTaskPrompt(task)}`,
        providerId: resolved.providerId,
        modelOverride: resolved.modelOverride,
        effectiveModel: resolved.effectiveModel,
        emit,
        signal,
        // The background tolerance: the child outlives the parent's SSE
        // stream — every emit through this run is best-effort.
        bestEffortEmit: true,
      },
    ).then(
      (result) => {
        // The terminal status frame + the owner notification already rode
        // the shared path; the REPORT itself stays in the child's log for
        // resume (nothing delivered it inline anywhere).
        log("info", "delegation.background.settled", {
          child: child.id,
          taskId,
          ok: result.ok,
        });
      },
      (error) => {
        // DETACHED-FAILURE HONESTY: runChildTurn settles its own failures
        // through its return value — an exception HERE means the machinery
        // itself broke. The child must never stay `running` silently: flip
        // it failed, emit the failed frame (best-effort — the stream may be
        // long gone), and notify the owner. Every step is itself guarded:
        // the honesty path must never crash the process.
        try {
          setSessionStatus(deps.db, child.id, "failed");
          try {
            emit?.({
              type: "subagent-status",
              sessionId: child.id,
              parentSessionId,
              status: "failed",
              task,
              role,
              code,
              taskId,
              model: resolved.effectiveModel,
              detail: `background run crashed: ${error instanceof Error ? error.message : String(error)}`,
            });
          } catch {
            /* best-effort frame — the stream is gone */
          }
          getNotificationBus().publish(deps.db, {
            kind: "subagent_failed",
            title: `Sub-agent (${role}) failed`,
            body: `background run crashed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160),
            sessionId: child.id,
            projectId: resolved.parent.projectId ?? undefined,
          });
        } catch {
          /* never crash the process from the honesty path */
        }
        log("warn", "delegation.background.crashed", {
          child: child.id,
          taskId,
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    ).catch(() => {
      /* belt: the handlers above must never themselves reject */
    });
    // The receipt — returned IMMEDIATELY (the run is detached).
    return {
      ok: true,
      output:
        `[background task: ${taskId} | subagent session: ${child.id} | code: ${code} | role: ${role} | model: ${resolved.effectiveModel}]\n` +
        "The task is running in the background — it does NOT block you; continue your own work in the meantime.\n" +
        "Its live progress is visible to the owner in the Sub-agents panel.\n" +
        `Call delegate_task {"resume":"${taskId}"} to WAIT for it and collect its final report.\n` +
        "Its status is listed in your next turn's system prompt — do NOT poll; resume waits.",
      sessionId: child.id,
    };
  }

  /**
   * ROUND-79 (R79-a, the orchestrator round): the COLLECT path —
   * delegate_task {"resume": "<task_id | child session id | 4-char code>"}.
   *
   * Resolution among the PARENT's children, in precedence order:
   * delegate_task_id match → session id → subAgentCode. Then:
   *  - `completed`  → return the final report (the SAME last-non-empty
   *    message.assistant extraction listSubAgents uses — childTerminalText)
   *    + append `delegation.collected` to the PARENT log (idempotent).
   *  - `queued|running` → WAIT: poll the session status ~300ms until
   *    terminal, then handle as completed/failed. The wait is bounded by
   *    the child's OWN lifecycle (stall watchdog, retry ladder, owner
   *    Stop). The parent turn's abort signal is honored → the honest
   *    "still running" line (resume in a later turn).
   *  - `failed` (or `cancelled`) → the retryChild continuation path
   *    (ADR-0022 §3: the event log IS the resume point), awaited; on
   *    success the report + collected event ride the completed path.
   */
  async resumeTask(
    deps: TurnDeps,
    parentSessionId: string,
    address: string,
    emit?: (event: unknown) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; output: string }> {
    const { db } = deps;
    const trimmed = address.trim();
    const children = listSubAgents(db, parentSessionId);
    // Resolution precedence: task_id → session id → code (case-insensitive:
    // codes are [A-Z0-9]; a model typing lowercase must still be understood).
    const child =
      children.find((c) => c.taskId !== null && c.taskId === trimmed) ??
      children.find((c) => c.id === trimmed) ??
      children.find((c) => c.code === trimmed.toUpperCase());
    if (child === undefined) {
      return {
        ok: false,
        output: this.addressableChildrenOutput(
          db,
          parentSessionId,
          `No sub-agent of this session matches "${trimmed}" — resume accepts a task_id, a child session id, or a 4-char code.`,
        ),
      };
    }
    let status = child.status;
    if (status === "queued" || status === "running") {
      // The WAIT (the R71 no-polling discipline's other half: the MODEL
      // never sleep-polls — RESUME is the wait). Poll the child's session
      // status every ~300ms until it goes terminal; bounded by the child's
      // own lifecycle, never by an artificial timeout here.
      for (;;) {
        if (signal?.aborted === true) {
          return {
            ok: false,
            output:
              `[subagent session: ${child.id}${child.taskId !== null ? ` | task_id: ${child.taskId}` : ""} | role: ${child.subRole ?? "researcher"}]\n` +
              "The sub-agent is STILL RUNNING — this wait was interrupted. Resume it in a later turn (delegate_task {\"resume\":\"...\"}) to collect its final report; do not re-delegate the task.",
          };
        }
        await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_MS));
        const fresh = getSession(db, child.id);
        if (fresh === undefined) {
          return { ok: false, output: `the sub-agent session ${child.id} no longer exists` };
        }
        status = fresh.status;
        if (status !== "queued" && status !== "running") break;
      }
    }
    if (status === "completed") {
      // Idempotent collect: re-resuming an already-collected child returns
      // the report again (harmless) without appending a second event.
      if (child.taskId !== null && !collectedChildIds(db, parentSessionId).has(child.id)) {
        appendDelegationCollected(db, parentSessionId, {
          taskId: child.taskId,
          childId: child.id,
          childCode: child.code,
        });
      }
      return collectOutcome(db, child);
    }
    // failed | cancelled → the retryChild continuation path, awaited.
    const retry = await this.retryChild(deps, parentSessionId, child.id, emit);
    if (!retry.ok) {
      return {
        ok: false,
        output:
          `[subagent session: ${child.id}${child.taskId !== null ? ` | task_id: ${child.taskId}` : ""} | role: ${child.subRole ?? "researcher"}]\n` +
          `The sub-agent failed again on resume: ${retry.message}\nIts partial progress is preserved in its session — resume again later, inspect its session, or report the situation to the user.`,
      };
    }
    if (child.taskId !== null && !collectedChildIds(db, parentSessionId).has(child.id)) {
      appendDelegationCollected(db, parentSessionId, {
        taskId: child.taskId,
        childId: child.id,
        childCode: child.code,
      });
    }
    const refreshed = listSubAgents(db, parentSessionId).find((c) => c.id === child.id) ?? child;
    return collectOutcome(db, refreshed);
  }

  /**
   * ROUND-79 (R79-a): the honest addressable list — every child of the
   * parent with its three addresses (task_id when it has one, session id,
   * 4-char code), role, and status. Served on unknown-address resume and
   * on a task-less + resume-less delegate_task call: the cheap affordance
   * that lets the model retry with a REAL address immediately (and see
   * what there is to resume at all).
   */
  addressableChildrenOutput(db: SqliteDatabase, parentSessionId: string, intro: string): string {
    const children = listSubAgents(db, parentSessionId);
    if (children.length === 0) {
      return (
        `${intro}\n` +
        "This session has no sub-agent children yet. Delegate one with delegate_task {task: \"…\", role: \"researcher\"} — the call then WAITS and returns its final report; add task_id + background:true for a fire-and-forget run you later collect with {\"resume\":\"<task_id>\"}."
      );
    }
    const shown = children.slice(0, BACKGROUND_TASK_REMINDER_CAP);
    const rows = shown.map(
      (c) =>
        `- ${c.taskId !== null ? `task_id: ${c.taskId} | ` : ""}session: ${c.id} | code: ${c.code} | role: ${c.subRole ?? "researcher"} | status: ${c.status}`,
    );
    const more = children.length - shown.length;
    const example = children.find((c) => c.taskId !== null)?.taskId ?? children[0]!.code;
    return (
      `${intro}\n` +
      `Addressable sub-agents of this session (resume by task_id, session id, or 4-char code — e.g. delegate_task {"resume":"${example}"}):\n` +
      `${rows.join("\n")}${more > 0 ? `\n…and ${more} more` : ""}`
    );
  }

  /**
   * ROUND-79 (R79-a): resolve + validate a delegation target — the gate
   * BOTH entry points (blocking + background) share. Returns the resolved
   * bundle (with the TRIMMED taskId), or an honest refusal string.
   * Validation order: task non-empty → task_id grammar → task_id
   * uniqueness among the parent's children (ANY status — an address is
   * handed out once) → parent/agent existence.
   */
  private resolveDelegation(
    deps: TurnDeps,
    parentSessionId: string,
    task: string,
    taskId?: string,
  ):
    | {
        parent: Session;
        agent: Agent;
        providerId: string;
        modelOverride: TurnModelOverride | undefined;
        effectiveModel: string;
        taskId: string | undefined;
      }
    | string {
    const { db } = deps;
    // ROUND-79 (R79-a): validate task non-empty (the plugin guards this too
    // — the orchestrator re-validates for direct callers; the sub-agent
    // sees ONLY this text).
    if (task.trim() === "") {
      return "task must be a non-empty string (the sub-agent cannot see this conversation — the task text is its entire brief)";
    }
    let trimmedTaskId: string | undefined;
    if (taskId !== undefined) {
      trimmedTaskId = taskId.trim();
      if (trimmedTaskId === "") {
        return "task_id must be a non-empty string when provided";
      }
      if (!TASK_ID_RE.test(trimmedTaskId)) {
        return (
          `task_id "${trimmedTaskId}" is invalid — it must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ ` +
          "(one leading alphanumeric, then alphanumerics/dots/underscores/hyphens, at most 64 characters)"
        );
      }
      const duplicate = this.duplicateTaskIdRefusal(db, parentSessionId, trimmedTaskId);
      if (duplicate !== null) {
        return duplicate;
      }
    }
    const parent = getSession(db, parentSessionId);
    if (parent === undefined) {
      return "parent session not found";
    }
    const agent = getAgent(db, parent.agentId ?? "");
    if (agent === undefined) {
      return "parent agent not found";
    }
    const providerId = agent.providerId ?? deps.mainModel?.providerId ?? "openrouter";
    // ROUND-50 (R50-b): the effective child model, resolved ONCE — the
    // turn's modelOverride (R43-5) AND the `model` field on every
    // subagent-status frame below (the stats footer's model line).
    // ROUND-82 (R82, §2.4.5): subagentModel is now the provider-scoped ref
    // {providerId, modelId} — the modelOverride object routes the child
    // turns to the NIM/custom provider (prepareTurn's effective-provider
    // resolution); the status frames show the bare model id as before.
    // R93-B4 (the owner: "it should be able to utilize only that one single
    // API key to run the sub-agents too"): the FALLBACK CHAIN. When no
    // explicit subagentModel is set, the agent row's OWN durable pair wins
    // (unchanged); when the row carries NO pair (the R91/R92 NULL rows,
    // seeded templates, a force-deleted provider's reset) the PARENT
    // TURN's effective pair — ToolDeps.mainModel threaded through
    // TurnDeps — takes over: the child rides the same provider (and its
    // key pool) the parent is running on, exactly like the owner's
    // single-key workflow expects. Before R93 that case 409'd every
    // child with "has no providerId/model configured".
    const subagentModel = getOrchestrationSettings(db).subagentModel;
    const agentRowConfigured =
      (agent.providerId !== null && agent.providerId !== "") &&
      (agent.model !== null && agent.model !== "");
    const fallbackOverride =
      subagentModel !== null
        ? { model: subagentModel.modelId, providerId: subagentModel.providerId }
        : agentRowConfigured
          ? undefined
          : deps.mainModel !== undefined
            ? { model: deps.mainModel.modelId, providerId: deps.mainModel.providerId }
            : undefined;
    return {
      parent,
      agent,
      providerId,
      modelOverride: fallbackOverride,
      effectiveModel: subagentModel?.modelId ?? agent.model ?? deps.mainModel?.modelId ?? "unknown",
      taskId: trimmedTaskId,
    };
  }

  /** ROUND-79 (R79-a): duplicate-address refusal — an address is handed
   * out ONCE per parent (any status, forever: completed tasks keep their
   * address reserved too, so resume can never resolve the wrong child).
   * Returns null when the taskId is free. */
  private duplicateTaskIdRefusal(
    db: SqliteDatabase,
    parentSessionId: string,
    taskId: string,
  ): string | null {
    const existing = listSubAgents(db, parentSessionId).find((c) => c.taskId === taskId);
    if (existing === undefined) return null;
    return (
      `task_id "${taskId}" is already used by a sub-agent of this session (status: ${existing.status}, role: ${existing.subRole ?? "researcher"}, session: ${existing.id}). ` +
      `Each task_id must be unique among this session's delegations — pick a different one, or resume the existing task: delegate_task {"resume":"${taskId}"}.`
    );
  }

  /** ROUND-79 (R79-a): the ≥10-outstanding fan-out guard (background only)
   * — a parent already holding BACKGROUND_TASK_CAP children in
   * queued|running WITH a task_id is refused further background
   * delegations, LISTING the outstanding tasks honestly (the runaway
   * queue-backlog guard; the global semaphore still caps real
   * parallelism). Returns null when under the cap. */
  private backgroundCapRefusal(db: SqliteDatabase, parentSessionId: string): string | null {
    const outstanding = listSubAgents(db, parentSessionId).filter(
      (c) => c.taskId !== null && (c.status === "queued" || c.status === "running"),
    );
    if (outstanding.length < BACKGROUND_TASK_CAP) return null;
    const listed = outstanding
      .slice(0, BACKGROUND_TASK_CAP)
      .map(
        (c) =>
          `- ${c.taskId} (${c.status}, role: ${c.subRole ?? "researcher"}, session: ${c.id})`,
      )
      .join("\n");
    const more = outstanding.length - BACKGROUND_TASK_CAP;
    return (
      `Too many outstanding background tasks: this session already holds ${outstanding.length} addressable children in queued|running state (the cap is ${BACKGROUND_TASK_CAP}). ` +
      `Wait for them (delegate_task {"resume":"<task_id>"} waits and collects the report), or let the owner stop one from the Sub-agents panel.\nOutstanding tasks:\n${listed}${more > 0 ? `\n…and ${more} more` : ""}`
    );
  }

  /**
   * ROUND-79 (R79-a): the shared child CREATION (extracted from the old
   * delegateTask inline block — both entry points create the child
   * identically): same project + agent config, the role frames the task,
   * the parent's permission mode (R50-c1) + active task mode (R75) are
   * copied, and the parent's task address rides migration 0028's
   * delegate_task_id (absent for unaddressed delegations).
   */
  private createChildSession(
    deps: TurnDeps,
    parent: Session,
    agent: Agent,
    parentSessionId: string,
    task: string,
    role: SubRole,
    taskId?: string,
  ): Session {
    return createSession(deps.db, {
      agentId: agent.id,
      mode: "single",
      projectId: parent.projectId,
      title: task.length > 60 ? `${task.slice(0, 60)}…` : task,
      parentSessionId,
      subRole: role,
      // ROUND-50 (R50-c1): the child COPIES the parent's permission mode — a
      // delegated sub-agent can never outrun the posture the owner picked for
      // the conversation (plan-mode parents spawn read-only children; editor
      // children get no run_command; full-mode children auto-approve ask-tier
      // gates). Enforcement happens in the child's own prepareTurn turn.
      permissionMode: parent.permissionMode,
      // ROUND-75 (R75): the child COPIES the parent's active task mode —
      // the R50-c1 inheritance rule, one tier down. A plan-mode parent
      // spawns read-only children (the mode-policy allowlist applies at
      // the child's own prepareTurn); a debug-mode parent's children keep
      // the diagnostics command tier. Delegated work can never outrun the
      // posture the owner picked for the conversation.
      activeMode: parent.activeMode,
      // ROUND-79 (R79-a): the parent's own address for this delegation
      // (validated + duplicate-checked upstream; omitted = unaddressed,
      // the pre-R79 shape).
      ...(taskId !== undefined ? { taskId } : {}),
    });
  }

  /**
   * ROUND-79 (R79-a): the EXTRACTED child-run machinery — the ONE path
   * blocking and background delegations share (creation happened in the
   * caller; this runs the child to a terminal state): queued frame →
   * concurrency slot → per-slot keyring VIEW → turn-registry registration
   * → stall watchdog → wrapped live-forwarding emit → the streamed/sync
   * turn → terminal status + owner notification → release. Returns the
   * same {ok, output, sessionId} shape the blocking path always returned
   * (byte-identical output strings — the regression gate).
   */
  private async runChildTurn(
    deps: TurnDeps,
    ctx: {
      parentSessionId: string;
      parent: Session;
      child: Session;
      task: string;
      role: SubRole;
      /** The child's first user message (role framing + task prompt). */
      content: string;
      providerId: string;
      modelOverride: TurnModelOverride | undefined;
      effectiveModel: string;
      emit?: (event: unknown) => void;
      signal?: AbortSignal;
      /** ROUND-79 (R79-a): background runs swallow emit errors (the child
       * outlives the parent's SSE stream). Blocking runs keep the
       * historical propagate semantics. */
      bestEffortEmit?: boolean;
    },
  ): Promise<{ ok: boolean; output: string; sessionId: string }> {
    const { db, keyring, chat, chatStream } = deps;
    const { parentSessionId, child, task, role, providerId, signal } = ctx;
    // ROUND-79 (R79-a): BEST-EFFORT emit for background children — every
    // status frame + every forwarded child event rides the parent's SSE,
    // and that stream can (and routinely does) close while a background
    // child is still running. A throwing emit is swallowed; the run is
    // unaffected. The blocking path keeps the pre-R79 propagate semantics
    // (observably identical).
    const emit =
      ctx.bestEffortEmit === true && ctx.emit !== undefined
        ? (event: unknown): void => {
            try {
              ctx.emit!(event);
            } catch {
              /* best-effort: the parent's stream is gone — the child keeps running */
            }
          }
        : ctx.emit;
    const taskId = child.taskId;

    const status = (s: SubAgentEventPayload["status"], extra?: Partial<SubAgentEventPayload>) => {
      emit?.({
        type: "subagent-status",
        sessionId: child.id,
        parentSessionId,
        status: s,
        task,
        role,
        code: subAgentCode(child.id),
        // ROUND-50 (R50-b): the stats footer's model — resolved at delegation
        // time so it is available from the FIRST frame (queued) onward.
        model: ctx.effectiveModel,
        // ROUND-79 (R79-a): the delegation address rides every frame when
        // the child is addressable (the panel's task_id chip joins on it).
        ...(taskId !== null ? { taskId } : {}),
        ...extra,
      });
    };
    status("queued");

    // Acquire concurrency + key slot (reserves atomically; queues when full).
    // ROUND-82 close-out: the child's EFFECTIVE provider — the provider-scoped
    // subagentModel override (R82 §2.4.5) can route the child turns to a
    // provider OTHER than the parent agent's (NIM/custom gateway). The slot
    // reservation and the release below key on it, so the load-spreading
    // counts against the provider that actually serves the child turns.
    const effectiveProviderId = overrideProviderId(ctx.modelOverride) ?? providerId;
    const slot = await this.acquireSlot(db, keyring, effectiveProviderId, child.id);
    // R93-B4: an EMPTY key pool fails FAST and HONESTLY (see acquireSlot) —
    // the child is marked failed with the actionable message, the parent's
    // delegate_task returns it as the tool result, and the owner is
    // notified. Never a silent forever-queued child.
    if (slot === "EMPTY_POOL") {
      const emptyPoolLine =
        `Sub-agent could not start: the provider "${effectiveProviderId}" has no API keys configured. ` +
        "Sub-agents share the provider's key pool with the main agent — add at least one key in Settings → Models & Providers, then re-delegate.";
      setSessionStatus(db, child.id, "failed");
      status("failed", { detail: emptyPoolLine });
      getNotificationBus().publish(db, {
        kind: "subagent_failed",
        title: `Sub-agent (${role}) could not start`,
        body: `No API keys configured for provider "${effectiveProviderId}"`,
        sessionId: child.id,
        projectId: ctx.parent.projectId ?? undefined,
      });
      return {
        ok: false,
        output: `[subagent session: ${child.id} | role: ${role}]\n${emptyPoolLine}`,
        sessionId: child.id,
      };
    }
    this.runs = this.runs.map((r) =>
      r.childId === child.id ? { ...r, parentSessionId } : r,
    );

    // ROUND-92 (R92-D, the owner's explicit requirement: "These API keys will
    // be used for the subagents too"): the ROUND-36/64 per-child keyring VIEW
    // (one slot's key aliased into slot 0) is GONE — the child receives the
    // PARENT keyring unchanged, so prepareTurn resolves the FULL deduped pool
    // for it exactly like a main turn. The reserved slot still matters, twice:
    //   · TurnDeps.keySlot seeds the runner's STARTING key (load-spreading —
    //     initialKeyPoolEntry picks the reserved slot's entry);
    //   · usage attribution starts on the reserved slot and follows every
    //     juggling swap (the runner's activeKeySlot).
    // A child whose reserved key fails (auth / rate_limit) now JUGGLES to the
    // next pool key inside its own turn instead of dying (the pre-R92 view
    // made every other key invisible to the child's prepareTurn).

    // ── ROUND-52 (R52-b): the CHILD SUPERVISOR ────────────────────────────
    // The owner: "if the subagent or agents are taking up way too much time
    // then the main agent can take a look at the subagents stats like what it
    // is currently doing has it run into anything or it has steered to some
    // other path… so take proper steps." While the child runs:
    //   1. its own AbortController is REGISTERED in the shared turn registry
    //      → the owner's Stop button (POST /sessions/:id/stop) now works on
    //      sub-agents exactly like on the main agent; a parent abort still
    //      cascades (the listener below forwards it). Registered BEFORE the
    //      first `running` frame so a stop aimed at that frame's session id
    //      always lands.
    //   2. a watchdog samples the child's session every childWatchdogMs and
    //      emits a RUNNING heartbeat frame carrying `watch` (last activity,
    //      age, tool count, todos, elapsed) — the live "what is it doing"
    //      stats for the sub-agent panel AND the audit trail of supervision.
    //   3. STALL DETECTION: no persisted child events for childStallTimeoutMs
    //      (a hung command, a dead provider, an infinite wait) → the watchdog
    //      aborts the child and the delegate result reports the stall
    //      honestly to the parent (which then decides: re-delegate, check the
    //      terminal, or report to the owner).
    const orchestration = getOrchestrationSettings(db);
    const childAbort = new AbortController();
    registerTurn(child.id, childAbort);
    let stallReport: string | null = null;
    const onParentAbort = (): void => {
      // Parent stop cascades to the child (R48-e1 semantics preserved).
      // ROUND-79 (R79-a): applies to background children too — the
      // documented choice (see delegateBackground): the owner's Stop on
      // the parent stops the background spend; no zombie children.
      if (!childAbort.signal.aborted) childAbort.abort();
    };
    if (signal !== undefined) {
      // An ALREADY-aborted parent (R48-e1: the pre-flight check must still
      // hold — the child never calls the provider) aborts the child NOW;
      // a live parent aborts it later via the listener.
      if (signal.aborted) childAbort.abort();
      else signal.addEventListener("abort", onParentAbort, { once: true });
    }

    status("running");
    setSessionStatus(db, child.id, "running");

    const runStartedAt = Date.now();
    const watchdog = setInterval(() => {
      if (childAbort.signal.aborted) return;
      const progress = this.progressOf(db, child.id);
      const watch = sampleChildWatch(
        db,
        child.id,
        runStartedAt,
        orchestration.childStallTimeoutMs,
        progress.todosDone,
        progress.todosTotal,
      );
      // ROUND-75 (R75): a child in a TRANSIENT-API retry wait is ALIVE by
      // construction (the ladder's waitForRetry holds it between provider
      // attempts — up to 30 min on the final rung, far past the 5-min stall
      // threshold). The registry entry is the live truth: never stall-kill
      // a waiting child; surface the wait instead.
      const retryWait = getActiveRetryWait(child.id);
      if (retryWait !== undefined) {
        const remaining = Math.max(0, retryWait.until - Date.now());
        status("running", {
          watch: {
            ...watch,
            stalled: false,
            lastActivity:
              `waiting to retry the provider (attempt ${retryWait.attempt}/${retryWait.totalAttempts}, ` +
              `${Math.ceil(remaining / 1000)}s remaining — transient failure)`,
          },
        });
        return;
      }
      if (watch.stalled) {
        stallReport =
          `stalled — no activity for ${Math.round(watch.lastEventAgeMs / 1000)}s ` +
          `(last: ${watch.lastActivity}); the supervisor stopped it`;
        abortTurn(child.id, "stall");
        return;
      }
      status("running", { watch });
    }, orchestration.childWatchdogMs);

    try {
      // ROUND-40 (owner: "sub-agents should be highly capable and reliable,
      // just like the original agent"). Three fixes shipped together:
      //  1. The child now receives a FULL tool set (ALL tools minus
      //     delegate_task) — see runtime.ts ROUND-40. Previously the default
      //     agent's [] allowlist tripped a ["__none__"] sentinel that stripped
      //     every tool, so the child could only write a one-shot text reply.
      //  2. The child's system-prompt toolNames now matches its real tool set.
      //  3. LIVE FORWARDING: we wrap the parent's emit so every child
      //     tool-call / tool-result / text-delta / continuation event rides
      //     the parent's SSE channel as a `subagent-event` envelope. The
      //     parent UI can now watch the child work in real time (tool calls
      //     appearing as they happen, intermediate + final text), not just
      //     the final status poll. This is the "manage them properly / make
      //     them function properly" the owner asked for.
      const wrappedEmit = emit
        ? (event: unknown) =>
            emit({
              type: "subagent-event",
              sessionId: child.id,
              parentSessionId,
              inner: event,
            })
        : undefined;
      // ROUND-50 (R50-b, owner: "It should be streamed live just like how it
      // gets handled on the main agent"): when the delegating turn runs the
      // STREAMED path (deps.chatStream present — the delegate_task toolDeps
      // forwards it, see runtime.ts prepareTurn) AND we have an emit channel
      // to forward through, the child runs runStreamedAgentTurn — the SAME
      // turn path as the main agent, so the parent's SSE carries the child's
      // LIVE raw stream (thinking-delta / text-delta / tool-call /
      // tool-result / finish-with-usage) inside the subagent-event envelope,
      // and the sub-agent panel renders it in real time instead of waiting
      // for the 600ms polled event log. Both paths return the identical
      // TurnOutcome shape, so the ok/failed handling below is unchanged.
      //
      // NO chatStream (the plain sync route, HTTP retry, or a chat stub)
      // → the SYNC fallback below, EXACTLY as before R50-b: runSingleAgentTurn
      // with onStepFinish step snapshots. Channel-less runs must keep the
      // fail-fast ask semantics (ROUND-48) — the streamed path REQUIRES an
      // emit, so no emit + chatStream still means sync (runStreamedAgentTurn
      // takes emit as a required argument).
      // ROUND-64 (R64-e) → ROUND-92 (R92-D): keySlot = the acquired slot —
      // the child's STARTING key + usage attribution (see the comment above
      // the run). The keyring is the PARENT'S (full pool — one pool serves
      // everyone now).
      const childDeps: TurnDeps = { db, keyring, chat, keySlot: slot };
      const outcome =
        chatStream !== undefined && wrappedEmit !== undefined
          ? await runStreamedAgentTurn(
              { ...childDeps, chatStream },
              child.id,
              ctx.content,
              wrappedEmit,
              // R43-5: the temporary sub-agent model override (null = inherit
              // the agent's model — prepareTurn falls back to agent.model).
              ctx.modelOverride,
              // ROUND-52 (R52-b): the child's OWN signal — aborts when the
              // owner stops this sub-agent directly, when the parent turn
              // stops (cascades via onParentAbort above), or when the
              // supervisor detects a stall. Between-iteration stop +
              // approval denial on abort are unchanged (R48-e1 semantics).
              childAbort.signal,
            )
          : await runSingleAgentTurn(
              childDeps,
              child.id,
              ctx.content,
              ctx.modelOverride,
              wrappedEmit,
              childAbort.signal,
            );
      if (outcome.ok) {
        setSessionStatus(db, child.id, "completed");
        const progress = this.progressOf(db, child.id);
        status("completed", progress);
        // ROUND-40: notify the user the delegated task finished.
        getNotificationBus().publish(db, {
          kind: "subagent_complete",
          title: `Sub-agent (${role}) completed`,
          body: task.slice(0, 120),
          sessionId: child.id,
          projectId: ctx.parent.projectId ?? undefined,
        });
        // ROUND-39: real newlines (the old `\\n` produced literal "\n" text
        // in the parent's view of the sub-agent's report).
        return {
          ok: true,
          output: `[subagent session: ${child.id} | role: ${role}]\nSub-agent completed.\n\n${outcome.assistantMessage.content}`,
          sessionId: child.id,
        };
      }
      // ROUND-52 (R52-b): terminal frames + the parent's tool result now
      // carry WHY the child failed: stopped by the owner (Stop button on the
      // sub-agent card), stalled (supervisor watchdog), or a real error.
      const stopReason = getTurnStopReason(child.id);
      const detail =
        stallReport !== null
          ? stallReport
          : stopReason === "owner"
            ? "stopped by the owner"
            : outcome.code === "ABORTED"
              ? "aborted (parent turn stopped)"
              : undefined;
      setSessionStatus(db, child.id, "failed");
      status("failed", detail !== undefined ? { detail } : undefined);
      // ROUND-40: notify the user the delegated task failed.
      getNotificationBus().publish(db, {
        kind: "subagent_failed",
        title:
          stopReason === "owner"
            ? `Sub-agent (${role}) stopped by the owner`
            : stallReport !== null
              ? `Sub-agent (${role}) stalled — supervisor stopped it`
              : `Sub-agent (${role}) failed`,
        body: (stallReport ?? outcome.message).slice(0, 160),
        sessionId: child.id,
        projectId: ctx.parent.projectId ?? undefined,
      });
      const failureLine =
        stallReport !== null
          ? `Sub-agent STALLED and was stopped by the supervisor: ${stallReport}. Decide deliberately: re-delegate the task (delegate_task), investigate what it was doing, or report the situation to the user — do not silently retry.`
          : stopReason === "owner"
            ? `Sub-agent was STOPPED BY THE OWNER mid-task. Its partial progress is preserved in its session (${child.id}). Do NOT re-delegate or continue the stopped work unless the user asks.`
            : `Sub-agent failed: ${outcome.message}`;
      return {
        ok: false,
        output: `[subagent session: ${child.id} | role: ${role}]\n${failureLine}`,
        sessionId: child.id,
      };
    } finally {
      clearInterval(watchdog);
      if (signal !== undefined) signal.removeEventListener("abort", onParentAbort);
      unregisterTurn(child.id, childAbort);
      // ROUND-82: release under the EFFECTIVE provider (the pool the slot
      // was acquired from — a mismatched key would leak the reservation).
      this.releaseSlot(effectiveProviderId, slot, child.id);
    }
  }
  /**
   * Retry a failed/stale child (ADR-0022 §3): the event log IS the resume
   * point — a continuation message re-runs with all prior progress (R34
   * history assembly feeds tool results back). Runs through the same
   * concurrency gates.
   */
  async retryChild(
    deps: TurnDeps,
    parentSessionId: string,
    childId: string,
    /** ROUND-40: widened to (unknown) => void (see delegateTask). */
    emit?: (event: unknown) => void,
  ): Promise<{ ok: boolean; message: string }> {
    const { db, keyring, chat, chatStream } = deps;
    const child = getSession(db, childId);
    if (child === undefined || child.parentSessionId !== parentSessionId) {
      return { ok: false, message: `no child session ${childId} under ${parentSessionId}` };
    }
    const role = (SUB_ROLES as readonly string[]).includes(child.subRole ?? "")
      ? (child.subRole as SubRole)
      : "researcher";
    const agent = getAgent(db, child.agentId ?? "");
    const providerId = agent?.providerId ?? "openrouter";
    // ROUND-50 (R50-b): same effective-model resolution as delegateTask —
    // the turn's modelOverride + the `model` on every status frame.
    // ROUND-82 (R82, §2.4.5): the provider-scoped ref routes the retried
    // child to its provider (see delegateTask's comment).
    const subagentModel = getOrchestrationSettings(db).subagentModel;
    // R93-B4: the same fallback chain as resolveDelegation — the agent row's
    // durable pair, else the parent turn's effective pair (TurnDeps.mainModel).
    const agentRowConfigured =
      agent !== undefined &&
      agent.providerId !== null &&
      agent.providerId !== "" &&
      agent.model !== null &&
      agent.model !== "";
    const modelOverride =
      subagentModel !== null
        ? { model: subagentModel.modelId, providerId: subagentModel.providerId }
        : agentRowConfigured
          ? undefined
          : deps.mainModel !== undefined
            ? { model: deps.mainModel.modelId, providerId: deps.mainModel.providerId }
            : undefined;
    const effectiveModel = subagentModel?.modelId ?? agent?.model ?? deps.mainModel?.modelId ?? "unknown";

    const status = (s: SubAgentEventPayload["status"]) => {
      emit?.({
        type: "subagent-status",
        sessionId: childId,
        parentSessionId,
        status: s,
        task: child.title ?? "",
        role,
        code: subAgentCode(childId),
        // ROUND-50 (R50-b): the stats footer's model line.
        model: effectiveModel,
      });
    };

    // Produce anything at all? → resume; otherwise re-send the task.
    const hasProgress = listSessionEvents(db, childId).some(
      (e) => e.type === "tool.use" || e.type === "message.assistant",
    );
    // ROUND-39: retry uses the same multi-stage mandate as delegateTask
    // (todo tracking, tool iteration, no premature text replies). When the
    // child already has progress (interrupted mid-task), it continues from
    // where it stopped — its completed work is in its history (tool results
    // included, per the assembleHistory fix).
    const content = hasProgress
      ? `${ROLE_FRAMING[role]}\n\nYou were interrupted while working on this task. Your completed work so far is in your history (including tool results). Continue from where you stopped — call todo_write to refresh your plan if needed, then execute the remaining steps. Only write a final report when the task is genuinely complete.`
      : `${ROLE_FRAMING[role]}\n${renderTaskPrompt(child.title ?? "the assigned task")}`;

    // ROUND-82 close-out: retryChild needs the same effective-provider
    // resolution as delegateTask/runChildTurn — the retried child routes to
    // the override's provider when the owner set a provider-scoped
    // subagentModel ref between attempts (the R82-TESTS retry pin).
    const effectiveProviderId = overrideProviderId(modelOverride) ?? providerId;
    const slot = await this.acquireSlot(db, keyring, effectiveProviderId, childId);
    // R93-B4: the retry path gets the same honest EMPTY_POOL failure (see
    // runChildTurn) — a retried child whose provider lost its keys fails
    // fast with the actionable message instead of hanging forever.
    if (slot === "EMPTY_POOL") {
      const emptyPoolLine =
        `Retry refused: the provider "${effectiveProviderId}" has no API keys configured. ` +
        "Add at least one key in Settings → Models & Providers, then retry the sub-agent.";
      setSessionStatus(db, childId, "failed");
      status("failed");
      getNotificationBus().publish(db, {
        kind: "subagent_failed",
        title: `Sub-agent (${role}) retry could not start`,
        body: `No API keys configured for provider "${effectiveProviderId}"`,
        sessionId: childId,
        projectId: child.projectId ?? undefined,
      });
      return { ok: false, message: emptyPoolLine };
    }
    this.runs = this.runs.map((r) =>
      r.childId === childId ? { ...r, parentSessionId } : r,
    );
    // ROUND-92 (R92-D): the retried child shares the PARENT keyring too (the
    // per-child view is gone — see runChildTurn); the re-acquired slot seeds
    // its starting key + usage attribution, and the runner juggles the pool
    // on key-attributable failures.

    status("running");
    setSessionStatus(db, childId, "running");
    try {
      // ROUND-40: same live-forwarding as delegateTask — wrap the parent's
      // emit so the retried child's tool/text events ride the SSE channel.
      const wrappedEmit = emit
        ? (event: unknown) =>
            emit({
              type: "subagent-event",
              sessionId: childId,
              parentSessionId,
              inner: event,
            })
        : undefined;
      // ROUND-50 (R50-b): same streamed-vs-sync branch as delegateTask. The
      // HTTP retry route passes neither chatStream nor emit (no SSE channel
      // to stream on) → the sync fallback, exactly as before R50-b. A future
      // channel-backed retry (or a retried child inside a live streamed
      // parent turn) streams the retried attempt live instead.
      // ROUND-64 (R64-e) → ROUND-92 (R92-D): keySlot = the re-acquired slot —
      // the retried child's starting key + usage attribution; the keyring is
      // the PARENT'S (full pool, juggling on failure).
      const childDeps: TurnDeps = { db, keyring, chat, keySlot: slot };
      const outcome =
        chatStream !== undefined && wrappedEmit !== undefined
          ? await runStreamedAgentTurn(
              { ...childDeps, chatStream },
              childId,
              content,
              wrappedEmit,
              // R43-5: retries honor the same sub-agent model override as
              // fresh delegations (null = inherit the agent's model).
              modelOverride,
            )
          : await runSingleAgentTurn(childDeps, childId, content, modelOverride, wrappedEmit);
      if (outcome.ok) {
        setSessionStatus(db, childId, "completed");
        status("completed");
        // ROUND-40: retry-completion also notifies.
        getNotificationBus().publish(db, {
          kind: "subagent_complete",
          title: `Sub-agent (${role}) completed`,
          body: (child.title ?? "the assigned task").slice(0, 120),
          sessionId: childId,
          projectId: child.projectId ?? undefined,
        });
        return { ok: true, message: "sub-agent completed" };
      }
      setSessionStatus(db, childId, "failed");
      status("failed");
      getNotificationBus().publish(db, {
        kind: "subagent_failed",
        title: `Sub-agent (${role}) failed`,
        body: outcome.message.slice(0, 160),
        sessionId: childId,
        projectId: child.projectId ?? undefined,
      });
      return { ok: false, message: outcome.message };
    } finally {
      // ROUND-82: release under the EFFECTIVE provider (see runChildTurn).
      this.releaseSlot(effectiveProviderId, slot, childId);
    }
  }

  /** Boot sweep (ADR-0022 §3): a dead sidecar leaves `running` sessions —
   * flip them to `failed` so they're retryable. Call at server start.
   *
   * ROUND-42 FIX: a session whose last event is an assistant reply merely
   * FINISHED a turn earlier (parent sessions intentionally stay `running`
   * so they accept the next message — `completed` is a TERMINAL status).
   * Flipping those to `failed` killed every idle conversation on every
   * sidecar restart ("session … is failed and no longer accepts messages").
   * Now: last event = message.assistant → back to `queued` (idle, alive);
   * anything else (user message / tool.use with no closing reply — a genuine
   * mid-turn crash) → `failed` as ADR-0022 intended. */
  static sweepStaleRunning(db: SqliteDatabase): number {
    const stale = db
      .prepare("SELECT id, agent_id FROM sessions WHERE status = 'running'")
      .all() as Array<{ id: string; agent_id: string | null }>;
    let swept = 0;
    for (const row of stale) {
      const events = listSessionEvents(db, row.id);
      const last = events[events.length - 1];
      if (last !== undefined && last.type === "message.assistant") {
        // Idle after a completed turn — the conversation is alive.
        setSessionStatus(db, row.id, "queued");
      } else {
        // ROUND-75 (R75): a genuine mid-turn crash (the sidecar died while
        // the turn streamed — the timeline ends at a user message or tool
        // use with no closing reply). The pre-R75 sweep flipped these to
        // TERMINAL `failed` with NOTHING written to the timeline: the
        // owner's reload showed a conversation that simply stops mid-work
        // (no error card — one of the exact "it just outright stops there"
        // reports), and the next send 409'd "session is failed and no
        // longer accepts messages". Now the sweep writes the honest
        // turn.error event (the R43 persistTurnError pattern — an
        // INTERRUPTED card lands right after the cut-off work) and resets
        // to `queued`, the same resting state every other turn failure
        // uses: the session stays retryable and the interruption is
        // VISIBLE, forever, in the timeline.
        const lastUser = [...events].reverse().find((e) => e.type === "message.user");
        appendSessionEvent(db, row.id, {
          type: "turn.error",
          agentId: row.agent_id,
          payload: {
            code: "INTERRUPTED",
            message:
              "session interrupted — the app restarted while this response was being generated " +
              "(no provider error; the work above is preserved — send a message to continue)",
            ...(lastUser !== undefined ? { userSeq: lastUser.seq } : {}),
          },
        });
        setSessionStatus(db, row.id, "queued");
        swept += 1;
      }
    }
    return swept;
  }
}

/** Module-level singleton: one sidecar process = one orchestrator (the
 * semaphores coordinate across ALL parent turns in the process). */
export { Orchestrator };
let singleton: Orchestrator | null = null;
export function getOrchestrator(): Orchestrator {
  singleton ??= new Orchestrator();
  return singleton;
}

export { SUB_ROLES };
// ROUND-84 (R84): the canonical home is agents/sub-roles.ts (the leaf);
// this re-export keeps every pre-R84 import site byte-identical.
