/**
 * ROUND-87 (R87, owner: "giving it the ability to ask the user questions
 * midway through. It will ask questions and the user can select from the
 * options or maybe he can type in a custom response and such. He can answer
 * multiple questions this way.") — the INTERACTIVE AGENT QUESTION.
 *
 * browser-checkpoint.ts is the pattern: an agent tool needs someone OUTSIDE
 * this sidecar to act while the tool waits. There the someone is the owner
 * watching a countdown; here it is the owner ANSWERING QUESTIONS mid-task:
 *
 *   tool (agent-core)                           chat card (frontend)
 *   ───────────────────────────                 ───────────────────────
 *   askUser(emit, params)        ──SSE──▶       stream-store intercept
 *     questions: [{question,                    → the question card(s):
 *       options?, allowCustom?}]                  option pills + custom input
 *     promise pends on this map ◀──REST──── POST /agent-questions/:id/resolve
 *                                                (api.resolveAgentQuestion)
 *
 * TWO frames ride the turn's SSE stream (`ToolDeps.emit` — the same channel
 * the browser-checkpoint + approval frames use): "agent-question" when the
 * ask opens and "agent-question.resolved" when it settles (answered |
 * timeout | cancelled) so the card collapses even when the wait TIMES OUT
 * with no owner answer.
 *
 * PERSISTENCE: both transitions are appended as session events
 * (agent-question.requested / agent-question.resolved — ADR-0010's
 * append-only event log, the same fold path approvals ride), so the card
 * survives a reload exactly like an approval row does.
 *
 * The 10-minute cap: an owner may be away — the turn should not hang
 * forever, and the model gets an honest "unanswered" it can proceed from.
 */

import { appendSessionEvent } from "./storage/sessions.js";
import type { SqliteDatabase } from "./storage/db.js";

/** One question the agent asks the owner. */
export interface AgentQuestion {
  /** The question itself, ≤ 500 chars. */
  question: string;
  /** 2-8 preset answers the owner can pick as pills. */
  options?: string[];
  /** May the owner type a free-text answer (default true)? */
  allowCustom?: boolean;
  /** Placeholder for the custom input. */
  placeholder?: string;
}

/** How an ask can end: the owner answered, the wait timed out, or the turn
 * was aborted (cancelled — the model sees an honest stop note). */
export type AgentQuestionResolution = "answered" | "timeout" | "cancelled";

/** Where an answer came from (display fidelity for the folded card). */
export type AgentAnswerSource = "option" | "custom";

export const ASK_USER_TIMEOUT_MS = 10 * 60_000;
export const ASK_USER_MAX_QUESTIONS = 10;
export const ASK_USER_MAX_QUESTION_CHARS = 500;
export const ASK_USER_MAX_OPTIONS = 8;
export const ASK_USER_MAX_OPTION_CHARS = 200;

/** The SSE frame that opens the question card. */
export interface AgentQuestionFrame {
  type: "agent-question";
  sessionId: string;
  questionId: string;
  questions: AgentQuestion[];
}

/** The SSE frame that collapses the card. */
export interface AgentQuestionResolvedFrame {
  type: "agent-question.resolved";
  sessionId: string;
  questionId: string;
  resolution: AgentQuestionResolution;
  answers?: string[];
  sources?: AgentAnswerSource[];
}

export interface AskUserResult {
  resolution: AgentQuestionResolution;
  answers: string[];
  sources: AgentAnswerSource[];
}

/** Normalize + validate the raw tool input questions. Returns null (and the
 * reason) when the input is unusable — the tool turns that into an honest
 * {ok:false} the model can fix. */
export function normalizeQuestions(
  raw: unknown,
): { ok: true; questions: AgentQuestion[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "questions must be a non-empty array" };
  }
  if (raw.length > ASK_USER_MAX_QUESTIONS) {
    return { ok: false, reason: `too many questions (max ${ASK_USER_MAX_QUESTIONS} per ask)` };
  }
  const questions: AgentQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, reason: "each question must be an object" };
    }
    const record = item as Record<string, unknown>;
    const question =
      typeof record.question === "string" ? record.question.trim() : "";
    if (question === "") {
      return { ok: false, reason: "each question needs a non-empty 'question'" };
    }
    if (question.length > ASK_USER_MAX_QUESTION_CHARS) {
      return { ok: false, reason: `question too long (max ${ASK_USER_MAX_QUESTION_CHARS} chars)` };
    }
    const normalized: AgentQuestion = { question };
    if (record.options !== undefined) {
      if (!Array.isArray(record.options) || record.options.length < 2) {
        return { ok: false, reason: "'options' must be an array of at least 2 choices" };
      }
      if (record.options.length > ASK_USER_MAX_OPTIONS) {
        return { ok: false, reason: `too many options (max ${ASK_USER_MAX_OPTIONS} per question)` };
      }
      const options: string[] = [];
      for (const option of record.options) {
        if (typeof option !== "string" || option.trim() === "") {
          return { ok: false, reason: "every option must be a non-empty string" };
        }
        options.push(option.trim().slice(0, ASK_USER_MAX_OPTION_CHARS));
      }
      normalized.options = options;
    }
    if (record.allowCustom !== undefined) {
      if (typeof record.allowCustom !== "boolean") {
        return { ok: false, reason: "'allowCustom' must be a boolean" };
      }
      normalized.allowCustom = record.allowCustom;
    }
    if (record.placeholder !== undefined) {
      if (typeof record.placeholder !== "string") {
        return { ok: false, reason: "'placeholder' must be a string" };
      }
      normalized.placeholder = record.placeholder.slice(0, 200);
    }
    questions.push(normalized);
  }
  return { ok: true, questions };
}

// ─────────────────────── the pending-question registry ──────────────────────

/** One open ask (the ask_user tool's pending promise). */
export interface PendingAgentQuestion {
  questionId: string;
  sessionId: string;
  agentId: string;
  questions: AgentQuestion[];
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (result: AskUserResult) => void;
}

const pending = new Map<string, PendingAgentQuestion>();

let questionCounter = 0;
function nextQuestionId(): string {
  questionCounter += 1;
  return `ask_${Date.now().toString(36)}_${questionCounter.toString(36)}`;
}

export function pendingAgentQuestionCount(): number {
  return pending.size;
}

/** Test hook: drop everything in flight as a timeout (never crash a tool
 * that legitimately handles the no-answer outcome). */
export function resetAgentQuestionsForTest(): void {
  for (const entry of pending.values()) {
    entry.settle({ resolution: "timeout", answers: [], sources: [] });
  }
  pending.clear();
}

export interface AskUserDeps {
  /** The turn's SSE emitter (ToolDeps.emit) — the live question card's
   * channel. Required: no live stream means no one to ask. */
  emit: (event: unknown) => void;
  /** The live turn's abort signal — an aborted turn cancels the ask. */
  signal?: AbortSignal;
  /** Persistence (ADR-0010's append-only event log — the same path the
   * approval + todo tools ride): both transitions are appended so the card
   * folds back after reload. */
  db: SqliteDatabase;
  sessionId: string;
  agentId: string;
}

/**
 * Open an ask: emit the "agent-question" frame (the card mounts), pend on
 * the map, and wait for the owner (REST resolve), the timeout, or an abort.
 * Returns the honest result either way — the tool formats it for the model.
 */
export function askUser(
  deps: AskUserDeps,
  params: { sessionId: string; agentId: string; questions: AgentQuestion[] },
): Promise<AskUserResult> {
  const questionId = nextQuestionId();
  const { emit } = deps;
  return new Promise<AskUserResult>((resolve) => {
    const persist = (type: "agent-question.requested" | "agent-question.resolved", payload: Record<string, unknown>): void => {
      try {
        appendSessionEvent(deps.db, deps.sessionId, { type, agentId: deps.agentId, payload: { questionId, ...payload } });
      } catch {
        // best-effort — the live frame already went out
      }
    };
    const timer = setTimeout(() => {
      settle({ resolution: "timeout", answers: [], sources: [] });
    }, ASK_USER_TIMEOUT_MS);
    const onAbort = () => settle({ resolution: "cancelled", answers: [], sources: [] });
    if (deps.signal !== undefined) {
      if (deps.signal.aborted) {
        clearTimeout(timer);
        resolve({ resolution: "cancelled", answers: [], sources: [] });
        return;
      }
      deps.signal.addEventListener("abort", onAbort, { once: true });
    }
    // A function DECLARATION (hoisted) — the timer + abort callbacks above
    // may reference it before its textual position.
    function settle(result: AskUserResult): void {
      pending.delete(questionId);
      clearTimeout(timer);
      if (deps.signal !== undefined) deps.signal.removeEventListener("abort", onAbort);
      try {
        const frame: AgentQuestionResolvedFrame = {
          type: "agent-question.resolved",
          sessionId: params.sessionId,
          questionId,
          resolution: result.resolution,
          ...(result.resolution === "answered"
            ? { answers: result.answers, sources: result.sources }
            : {}),
        };
        emit(frame);
      } catch {
        // The stream may already be closed — the card's own countdown is
        // the fallback. Never let the resolution path throw.
      }
      persist("agent-question.resolved", {
        resolution: result.resolution,
        ...(result.resolution === "answered"
          ? { answers: result.answers, sources: result.sources }
          : {}),
      });
      resolve(result);
    }
    pending.set(questionId, {
      questionId,
      sessionId: params.sessionId,
      agentId: params.agentId,
      questions: params.questions,
      startedAt: Date.now(),
      timer,
      settle,
    });
    try {
      const frame: AgentQuestionFrame = {
        type: "agent-question",
        sessionId: params.sessionId,
        questionId,
        questions: params.questions,
      };
      emit(frame);
    } catch {
      // The frame never reached the frontend — no card, no one to answer.
      clearTimeout(timer);
      pending.delete(questionId);
      resolve({
        resolution: "cancelled",
        answers: [],
        sources: [],
      });
      return;
    }
    try {
      persist("agent-question.requested", { questions: params.questions });
    } catch {
      // best-effort persistence
    }
  }).catch(() => ({ resolution: "cancelled", answers: [], sources: [] })) as Promise<AskUserResult>;
}

/**
 * The REST resolve entry point (POST /agent-questions/:id/resolve). The
 * answers array is aligned to the questions array (one per question, in
 * order); sources records option-pick vs custom-typed per answer for the
 * card's display. Returns false when the id is unknown/expired or the
 * payload shape is wrong (the route answers 404/400).
 */
export function resolveAgentQuestion(
  questionId: string,
  answers: unknown,
  sources?: unknown,
): boolean {
  const entry = pending.get(questionId);
  if (entry === undefined) return false;
  if (!Array.isArray(answers) || answers.length !== entry.questions.length) {
    return false;
  }
  const cleanAnswers: string[] = [];
  for (const answer of answers) {
    if (typeof answer !== "string") return false;
    cleanAnswers.push(answer.slice(0, 2000));
  }
  const cleanSources: AgentAnswerSource[] = cleanAnswers.map((_, index) => {
    const source = Array.isArray(sources) ? sources[index] : undefined;
    return source === "custom" ? "custom" : "option";
  });
  entry.settle({ resolution: "answered", answers: cleanAnswers, sources: cleanSources });
  return true;
}

/** The pending ask's normalized questions (the resolve route re-validates
 * against them; also the test surface). */
export function getPendingAgentQuestion(questionId: string): PendingAgentQuestion | undefined {
  return pending.get(questionId);
}
