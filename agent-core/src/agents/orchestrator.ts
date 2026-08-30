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
 * - Key assignment: the LEAST-LOADED pool slot, preferring non-primary slots
 *   (the owner: pool keys serve sub-agents; the primary serves the main
 *   agent). No pool → the primary under the per-key limit.
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
  createSession,
  getSession,
  listSessionEvents,
  setSessionStatus,
  subAgentCode,
} from "../storage/sessions.js";
// ROUND-52 (R52-b): the shared turn registry — children register their own
// AbortController so POST /sessions/:id/stop can stop a sub-agent directly,
// and the supervisor can abort a stalled one.
import { registerTurn, unregisterTurn, getTurnStopReason, abortTurn } from "../lib/turn-registry.js";
import { getAgent } from "../storage/agents.js";
import { getOrchestrationSettings } from "../storage/settings.js";
import { ProviderKeyring } from "../providers/registry.js";
import { runSingleAgentTurn, runStreamedAgentTurn } from "./runtime.js";
import type { TurnDeps } from "./runtime.js";
// ROUND-40: sub-agent transitions publish app-level notifications so the user
// sees when a delegated task completes or fails (even if they navigated away).
import { getNotificationBus } from "../lib/notification-bus.js";

export type SqliteDatabase = Database.Database;

/** Roles map to the seeded templates' framing (children run the PARENT's
 * provider/model/temperature — templates carry no provider config). */
const SUB_ROLES = ["planner", "researcher", "coder", "reviewer", "tester"] as const;
export type SubRole = (typeof SUB_ROLES)[number];

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
   */
  private tryReserveSlot(
    db: SqliteDatabase,
    keyring: ProviderKeyring,
    providerId: string,
    childId: string,
  ): number | null {
    const { maxParallel, perKeyLimit } = getOrchestrationSettings(db);
    if (this.active.size >= maxParallel) return null;
    const pool = keyring.getPool(providerId);
    // Prefer non-primary slots (owner: pool keys are for sub-agents), then
    // least-loaded, then lowest slot number.
    const candidates = [...pool]
      .map((c) => ({ ...c, load: this.keyActive.get(this.keyId(providerId, c.slot)) ?? 0 }))
      .filter((c) => c.load < perKeyLimit)
      .sort((a, b) => {
        const aPrimary = a.slot === 0 ? 1 : 0;
        const bPrimary = b.slot === 0 ? 1 : 0;
        if (aPrimary !== bPrimary) return aPrimary - bPrimary;
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

  /** Poll until a slot frees up (the queued child stays `queued` in the UI). */
  private async acquireSlot(
    db: SqliteDatabase,
    keyring: ProviderKeyring,
    providerId: string,
    childId: string,
  ): Promise<number> {
    for (;;) {
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
  ): Promise<{ ok: boolean; output: string; sessionId?: string }> {
    const { db, keyring, chat, chatStream } = deps;
    const parent = getSession(db, parentSessionId);
    if (parent === undefined) {
      return { ok: false, output: "parent session not found" };
    }
    const agent = getAgent(db, parent.agentId ?? "");
    if (agent === undefined) {
      return { ok: false, output: "parent agent not found" };
    }
    const providerId = agent.providerId ?? "openrouter";
    // ROUND-50 (R50-b): the effective child model, resolved ONCE — the
    // turn's modelOverride (R43-5) AND the `model` field on every
    // subagent-status frame below (the stats footer's model line).
    const subagentModel = getOrchestrationSettings(db).subagentModel;
    const modelOverride = subagentModel ?? undefined;
    const effectiveModel = subagentModel ?? agent.model;

    // Child session: same project + agent config; the role frames the task.
    // ROUND-50 (R50-c1): the child COPIES the parent's permission mode — a
    // delegated sub-agent can never outrun the posture the owner picked for
    // the conversation (plan-mode parents spawn read-only children; editor
    // children get no run_command; full-mode children auto-approve ask-tier
    // gates). Enforcement happens in the child's own prepareTurn turn.
    const child = createSession(db, {
      agentId: agent.id,
      mode: "single",
      projectId: parent.projectId,
      title: task.length > 60 ? `${task.slice(0, 60)}…` : task,
      parentSessionId,
      subRole: role,
      permissionMode: parent.permissionMode,
    });

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
        model: effectiveModel,
        ...extra,
      });
    };
    status("queued");

    // Acquire concurrency + key slot (reserves atomically; queues when full).
    const slot = await this.acquireSlot(db, keyring, providerId, child.id);
    this.runs = this.runs.map((r) =>
      r.childId === child.id ? { ...r, parentSessionId } : r,
    );

    // The child runs with a keyring VIEW of just its assigned slot — the
    // per-child key never leaks into other turns' scrubbing or lookups.
    const slotKey = keyring.getPool(providerId).find((p) => p.slot === slot)?.key ?? "";
    const childKeyring = new ProviderKeyring({
      [ProviderKeyring.slotEnvVarName(providerId, slot)]: slotKey,
      [ProviderKeyring.slotEnvVarName(providerId, 0)]: slotKey,
    });

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
      const framing = ROLE_FRAMING[role];
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
      const childDeps = { db, keyring: childKeyring, chat };
      const outcome =
        chatStream !== undefined && wrappedEmit !== undefined
          ? await runStreamedAgentTurn(
              { ...childDeps, chatStream },
              child.id,
              `${framing}\n${renderTaskPrompt(task)}`,
              wrappedEmit,
              // R43-5: the temporary sub-agent model override (null = inherit
              // the agent's model — prepareTurn falls back to agent.model).
              modelOverride,
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
              `${framing}\n${renderTaskPrompt(task)}`,
              modelOverride,
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
          projectId: parent.projectId ?? undefined,
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
        projectId: parent.projectId ?? undefined,
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
      this.releaseSlot(providerId, slot, child.id);
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
    const subagentModel = getOrchestrationSettings(db).subagentModel;
    const modelOverride = subagentModel ?? undefined;
    const effectiveModel = subagentModel ?? agent?.model ?? "unknown";

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

    const slot = await this.acquireSlot(db, keyring, providerId, childId);
    this.runs = this.runs.map((r) =>
      r.childId === childId ? { ...r, parentSessionId } : r,
    );
    const slotKey = keyring.getPool(providerId).find((p) => p.slot === slot)?.key ?? "";
    const childKeyring = new ProviderKeyring({
      [ProviderKeyring.slotEnvVarName(providerId, slot)]: slotKey,
      [ProviderKeyring.slotEnvVarName(providerId, 0)]: slotKey,
    });

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
      const childDeps = { db, keyring: childKeyring, chat };
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
      this.releaseSlot(providerId, slot, childId);
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
      .prepare("SELECT id FROM sessions WHERE status = 'running'")
      .all() as Array<{ id: string }>;
    let swept = 0;
    for (const row of stale) {
      const events = listSessionEvents(db, row.id);
      const last = events[events.length - 1];
      if (last !== undefined && last.type === "message.assistant") {
        // Idle after a completed turn — the conversation is alive.
        setSessionStatus(db, row.id, "queued");
      } else {
        setSessionStatus(db, row.id, "failed");
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
