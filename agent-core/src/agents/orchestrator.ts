/**
 * ROUND-36 (ADR-0022): the sub-agent orchestrator.
 *
 * One module-level singleton per sidecar process. Responsibilities:
 * - delegateTask: create a CHILD session, acquire a key slot + semaphore
 *   permits, run the child turn (runSingleAgentTurn — the existing runtime,
 *   verbatim per PILLARS §1), and return the child's final report.
 * - Concurrency: total semaphore (orchestration.maxParallel) + per-key
 *   semaphore (orchestration.perKeyLimit); excess children stay queued.
 * - Key assignment: the LEAST-LOADED pool slot, preferring non-primary slots
 *   (the owner: pool keys serve sub-agents; the primary serves the main
 *   agent). No pool → the primary under the per-key limit.
 * - Crash recovery: failed children are retryable — the event log IS the
 *   resume point (R34 assembleHistory feeds tool results back), so a retry
 *   continuation genuinely resumes. A boot sweep flips stale `running`
 *   sessions to `failed`.
 * - Live status: `subagent-status` events emitted through the parent's
 *   stream on every state transition.
 */
import type Database from "better-sqlite3";
import { createSession, getSession, listSessionEvents, setSessionStatus } from "../storage/sessions.js";
import { getAgent } from "../storage/agents.js";
import { getOrchestrationSettings } from "../storage/settings.js";
import { ProviderKeyring } from "../providers/registry.js";
import { runSingleAgentTurn } from "./runtime.js";
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

export interface SubAgentEventPayload {
  type: "subagent-status";
  sessionId: string;
  parentSessionId: string;
  status: "queued" | "running" | "completed" | "failed";
  task: string;
  role: string;
  todosDone?: number;
  todosTotal?: number;
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
  ): Promise<{ ok: boolean; output: string; sessionId?: string }> {
    const { db, keyring, chat } = deps;
    const parent = getSession(db, parentSessionId);
    if (parent === undefined) {
      return { ok: false, output: "parent session not found" };
    }
    const agent = getAgent(db, parent.agentId ?? "");
    if (agent === undefined) {
      return { ok: false, output: "parent agent not found" };
    }
    const providerId = agent.providerId ?? "openrouter";

    // Child session: same project + agent config; the role frames the task.
    const child = createSession(db, {
      agentId: agent.id,
      mode: "single",
      projectId: parent.projectId,
      title: task.length > 60 ? `${task.slice(0, 60)}…` : task,
      parentSessionId,
      subRole: role,
    });

    const status = (s: SubAgentEventPayload["status"], extra?: Partial<SubAgentEventPayload>) => {
      emit?.({
        type: "subagent-status",
        sessionId: child.id,
        parentSessionId,
        status: s,
        task,
        role,
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

    status("running");
    setSessionStatus(db, child.id, "running");

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
      const outcome = await runSingleAgentTurn(
        { db, keyring: childKeyring, chat },
        child.id,
        `${framing}\n${renderTaskPrompt(task)}`,
        undefined,
        wrappedEmit,
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
      setSessionStatus(db, child.id, "failed");
      status("failed");
      // ROUND-40: notify the user the delegated task failed.
      getNotificationBus().publish(db, {
        kind: "subagent_failed",
        title: `Sub-agent (${role}) failed`,
        body: outcome.message.slice(0, 160),
        sessionId: child.id,
        projectId: parent.projectId ?? undefined,
      });
      return {
        ok: false,
        output: `[subagent session: ${child.id} | role: ${role}]\nSub-agent failed: ${outcome.message}`,
        sessionId: child.id,
      };
    } finally {
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
    const { db, keyring, chat } = deps;
    const child = getSession(db, childId);
    if (child === undefined || child.parentSessionId !== parentSessionId) {
      return { ok: false, message: `no child session ${childId} under ${parentSessionId}` };
    }
    const role = (SUB_ROLES as readonly string[]).includes(child.subRole ?? "")
      ? (child.subRole as SubRole)
      : "researcher";
    const agent = getAgent(db, child.agentId ?? "");
    const providerId = agent?.providerId ?? "openrouter";

    const status = (s: SubAgentEventPayload["status"]) => {
      emit?.({
        type: "subagent-status",
        sessionId: childId,
        parentSessionId,
        status: s,
        task: child.title ?? "",
        role,
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
      const outcome = await runSingleAgentTurn({ db, keyring: childKeyring, chat }, childId, content, undefined, wrappedEmit);
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
   * flip them to `failed` so they're retryable. Call at server start. */
  static sweepStaleRunning(db: SqliteDatabase): number {
    const stale = db
      .prepare("SELECT id FROM sessions WHERE status = 'running'")
      .all() as Array<{ id: string }>;
    for (const row of stale) {
      setSessionStatus(db, row.id, "failed");
    }
    return stale.length;
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
