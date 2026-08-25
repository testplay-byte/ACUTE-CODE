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
    emit?: (event: SubAgentEventPayload) => void,
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
      // ROUND-38 fix: the prompt previously used `\\n` (literal backslash-n)
      // in the template literal, so the framing + task arrived as ONE run-on
      // line — the sub-agent never parsed its role/instructions properly and
      // routinely failed to act (owner: "sub-agents were not able to create
      // files"). Real newlines now.
      const outcome = await runSingleAgentTurn(
        { db, keyring: childKeyring, chat },
        child.id,
        `${framing}\n\nTASK: ${task}\n\nComplete this task now using your tools. When finished, reply with a concise report of what you did and found.`,
      );
      if (outcome.ok) {
        setSessionStatus(db, child.id, "completed");
        const progress = this.progressOf(db, child.id);
        status("completed", progress);
        return {
          ok: true,
          output: `[subagent session: ${child.id} | role: ${role}]\\nSub-agent completed.\\n\\n${outcome.assistantMessage.content}`,
          sessionId: child.id,
        };
      }
      setSessionStatus(db, child.id, "failed");
      status("failed");
      return {
        ok: false,
        output: `[subagent session: ${child.id} | role: ${role}]\\nSub-agent failed: ${outcome.message}`,
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
    emit?: (event: SubAgentEventPayload) => void,
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
    // ROUND-38 fix: same `\\n` → `\n` newline bug as delegateTask (the retry
    // prompt was a single run-on line).
    const content = hasProgress
      ? `${ROLE_FRAMING[role]}\n\nYou were interrupted while working on this task. Your completed work so far is in your history (including tool results). Continue from where you stopped and finish the task, then reply with a concise final report.`
      : `${ROLE_FRAMING[role]}\n\nTASK: ${child.title ?? "the assigned task"}\n\nComplete this task now using your tools. When finished, reply with a concise report.`;

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
      const outcome = await runSingleAgentTurn({ db, keyring: childKeyring, chat }, childId, content);
      if (outcome.ok) {
        setSessionStatus(db, childId, "completed");
        status("completed");
        return { ok: true, message: "sub-agent completed" };
      }
      setSessionStatus(db, childId, "failed");
      status("failed");
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
