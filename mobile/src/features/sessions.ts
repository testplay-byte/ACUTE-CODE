/**
 * sessions.ts — the sessions/transcript/live-stream state machine (pure).
 *
 * THE WIRES (read from agent-core routes/sessions.ts + routes/sse.ts +
 * storage/sessions.ts — nothing invented):
 *
 *   GET /api/v1/sessions?limit=N&offset=N
 *        → {sessions: SessionRow[], total} — ordered created_at DESC; NO
 *          projectId filter exists server-side, so project filtering is a
 *          client-side fold (filterByProject below).
 *   GET /api/v1/sessions/:id
 *        → SessionRow & {events: SessionEvent[], lastSeq} — the persisted
 *          append-only event log. Event types the phone folds: message.user,
 *          message.queued, message.assistant (content/thinking/model/usage),
 *          tool.use (toolName/argsSummary/ok/outputSummary), turn.error,
 *          turn.warning, approval.requested, approval.resolved, debug.report,
 *          todo.update, agent-question.requested/resolved (R87 — the
 *          ask_user cards), session.reverted; anything else → a dim meta line.
 *          A session row with status "running" has a turn in flight (the
 *          runtime flips queued→running at turn start and back to queued at
 *          turn end — R44; terminal statuses are completed/failed/cancelled).
 *   POST /api/v1/sessions/:id/messages/stream  body {content, model?,
 *        providerId?, thinkingLevel?, attachments?} (R113-c — the composer's
 *        per-send overrides, the SAME fields the desktop composer rides)
 *        → SSE `data:` frames, each one StreamTurnEvent JSON (the shared
 *          union). Terminal frames: {type:"done"} · {type:"stopped"} ·
 *          {type:"error",status,code,message}. The turn SURVIVES a closed
 *          stream (R42) — the transcript rehydrate is always the truth.
 *   POST /api/v1/sessions/:id/stop   → {ok, stopped}  (idempotent honesty)
 *   POST /api/v1/sessions/:id/queue  body {content, model?, providerId?,
 *        attachments?} (thinkingLevel is validated-then-IGNORED server-side —
 *        a queued message carries no reasoning effort; the phone omits it)
 *        → 200 {ok, seq} · 409 NO_LIVE_TURN (the honest fallback to a normal
 *          send) · 409 CONFLICT on terminal sessions · 400 empty content.
 *   POST /api/v1/agent-questions/:id/resolve body {answers, sources?}
 *        → 200 {ok:true} · 404 unknown/expired id (the card's own timeout is
 *        the fallback) — the R87 ask_user answer API the phone now rides.
 *   PATCH /api/v1/sessions/:id/permissions body {mode: full|ask|plan}
 *        → the updated session detail — the composer's operating-mode
 *        switcher (the desktop's exact per-session PATCH; the NEXT turn).
 *   PATCH /api/v1/sessions/:id body {activeMode?: string|null}
 *        → the updated session row — the task-mode picker (validated against
 *        the SAME modes resolver GET /projects/:id/modes serves).
 *
 * The screen wires this module to acute-net via the manager's api()/sse();
 * everything here is pure TypeScript over injected values — unit-tested with
 * zero React Native in sight.
 */

import { apiJson, type ApiOutcome, type ApiSender, type SseSender } from "./api";
import type { SseStream } from "@/link/connection";

// ── wire shapes (agent-core storage/sessions.ts Session/SessionEvent, 1:1) ──

export type SessionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SessionRow {
  id: string;
  projectId: string | null;
  agentId: string | null;
  mode: string;
  status: SessionStatus;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  parentSessionId: string | null;
  subRole: string | null;
  permissionMode: string;
  activeMode: string | null;
  taskId: string | null;
}

export interface SessionEventWire {
  seq: number;
  type: string;
  agentId: string | null;
  payload: unknown;
  ts: string;
}

export interface SessionDetailWire extends SessionRow {
  events: SessionEventWire[];
  lastSeq: number;
}

// ── the transcript view model (what the screen renders) ─────────────────────

/** One ask_user question (agent-core agent-question.ts AgentQuestion, 1:1). */
export interface QuestionView {
  question: string;
  options: string[];
  allowCustom: boolean;
  placeholder: string | null;
}

/** One todo row (agent-core tools/todo.ts TodoItem, 1:1). */
export interface TodoItemView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** One attachment riding a user message (shared MessageAttachment display). */
export interface AttachmentView {
  name: string;
  path?: string;
  size?: number;
}

/** The per-send override fields the stream route accepts (R113-c) — the
 * desktop composer's exact wire additions. */
export interface SendOverrides {
  /** The full model id (e.g. "z-ai/glm-5.2:free"). */
  model?: string;
  /** The provider whose catalog the model was picked from. */
  providerId?: string;
  /** The reasoning-effort hint ("default" = provider default — omitted). */
  thinkingLevel?: string;
  /** The staged chips (name + path/size/text — the shared MessageAttachment). */
  attachments?: Array<{ name: string; path?: string; size?: number; text?: string | null }>;
}

/**
 * One rendered transcript row. The persisted fold and the live stream BOTH
 * produce these — the screen renders one list either way, and the rehydrate
 * (the truth) replaces the live list wholesale at turn end.
 */
export type TranscriptItem =
  | { kind: "user"; key: string; content: string; queued: boolean; attachments: AttachmentView[] | null }
  | {
      kind: "assistant";
      key: string;
      content: string;
      thinking: string | null;
      model: string | null;
      /** Live-only: the streaming deltas (each renders with its own
       * fade-in-up entrance); persisted items carry the merged content. */
      chunks: string[] | null;
      live: boolean;
    }
  | {
      kind: "tool";
      key: string;
      toolName: string;
      argsSummary: string;
      /** null while the call runs (live only — persisted rows always know). */
      ok: boolean | null;
      outputSummary: string | null;
      /** Live tail of a running tool (tool-output frames). */
      outputTail: string | null;
      live: boolean;
    }
  | {
      kind: "approval";
      key: string;
      approvalId: string;
      toolName: string;
      argsSummary: string;
      category: string;
      decision: string | null;
    }
  | {
      kind: "question";
      key: string;
      questionId: string;
      questions: QuestionView[];
      resolution: "pending" | "answered" | "timeout" | "cancelled";
      answers: string[] | null;
      sources: string[] | null;
    }
  | { kind: "todo"; key: string; todos: TodoItemView[]; source: "agent" | "user" }
  | {
      kind: "subagent";
      key: string;
      childSessionId: string;
      role: string;
      task: string;
      status: string;
      code: string | null;
      model: string | null;
      taskId: string | null;
      detail: string | null;
    }
  | { kind: "image"; key: string; frameId: string; tool: string; ts: string }
  | { kind: "meta"; key: string; text: string }
  | { kind: "error"; key: string; code: string; message: string }
  | { kind: "debug"; key: string; content: string; live: boolean };

// ── small pure helpers ──────────────────────────────────────────────────────

/** The honest list title: the session's own title, else a short id caption. */
export function sessionTitle(session: Pick<SessionRow, "id" | "title">): string {
  if (session.title !== null && session.title.trim() !== "") return session.title.trim();
  const short = session.id.slice(0, 12);
  return `Session ${short}`;
}

/** The status badge tone for the list rows (fixed semantic hues). */
export function sessionStatusTone(
  status: SessionStatus,
): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "running":
      return "warning";
    case "completed":
      return "success";
    case "failed":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

/** A turn is in flight on the desktop (the R44 status contract). */
export function isTurnRunning(session: Pick<SessionRow, "status">): boolean {
  return session.status === "running";
}

/** Client-side project filter — the sessions route has NO server-side
 * projectId param; the phone folds the recent list itself. */
export function filterByProject(
  sessions: SessionRow[],
  projectId: string | null,
): SessionRow[] {
  if (projectId === null) return sessions;
  return sessions.filter((s) => s.projectId === projectId);
}

// ── the persisted-event fold ─────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

/** Read a persisted todo.update payload's todos (tools/todo.ts TodoItem[]) —
 * null when absent/malformed; an EMPTY array is the R88 "cleared" state. */
function readTodoItems(raw: unknown): TodoItemView[] | null {
  if (!Array.isArray(raw)) return null;
  const todos: TodoItemView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (content === "") continue;
    const status =
      item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
    todos.push({ content: content.slice(0, 200), status });
  }
  return todos;
}

/** Read a persisted agent-question payload's questions (AgentQuestion[]). */
function readQuestionViews(raw: unknown): QuestionView[] {
  if (!Array.isArray(raw)) return [];
  const questions: QuestionView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const question = typeof item.question === "string" ? item.question.trim() : "";
    if (question === "") continue;
    const options = Array.isArray(item.options)
      ? item.options.filter((o): o is string => typeof o === "string" && o.trim() !== "")
      : [];
    questions.push({
      question,
      options,
      allowCustom: item.allowCustom === false ? false : true,
      placeholder: typeof item.placeholder === "string" ? item.placeholder : null,
    });
  }
  return questions;
}

/** Read a message.user payload's attachments (shared MessageAttachment[]). */
function readAttachmentViews(raw: unknown): AttachmentView[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const views: AttachmentView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name : "";
    if (name === "") continue;
    views.push({
      name,
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      ...(typeof item.size === "number" && Number.isFinite(item.size) ? { size: item.size } : {}),
    });
  }
  return views.length > 0 ? views : null;
}

/** ONE todo card per session — the latest snapshot, positioned at the LATEST
 * todo event (the desktop's live card semantics: the list updates in place,
 * never stacking a card per write). An EMPTY array (the R88 clear) REMOVES
 * the card — no list, nothing to show. */
const TODO_ITEM_KEY = "todos";

function upsertTodoItem(
  items: TranscriptItem[],
  todos: TodoItemView[],
  source: "agent" | "user",
): TranscriptItem[] {
  const rest = items.filter((item) => item.kind !== "todo");
  if (todos.length === 0) return rest;
  return [...rest, { kind: "todo", key: TODO_ITEM_KEY, todos, source }];
}

/** Fold the persisted event log → transcript items (pure, order-preserving).
 * Unknown event types render as dim meta lines (forward compatibility — the
 * phone never crashes on a frame the desktop learned after it). */
export function foldSessionEvents(events: SessionEventWire[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const event of events) {
    const payload = isRecord(event.payload) ? event.payload : {};
    switch (event.type) {
      case "message.user": {
        const content = readString(payload, "content") ?? "";
        if (content.trim() === "") break;
        items.push({
          kind: "user",
          key: `e${event.seq}`,
          content,
          queued: false,
          attachments: readAttachmentViews(payload.attachments),
        });
        break;
      }
      case "message.queued": {
        const content = readString(payload, "content") ?? "";
        if (content.trim() === "") break;
        items.push({
          kind: "user",
          key: `e${event.seq}`,
          content,
          queued: true,
          attachments: readAttachmentViews(payload.attachments),
        });
        break;
      }
      case "message.assistant": {
        const content = readString(payload, "content") ?? "";
        const thinking = readString(payload, "thinking");
        const model = readString(payload, "model");
        if (content.trim() === "" && (thinking === null || thinking.trim() === "")) break;
        items.push({
          kind: "assistant",
          key: `e${event.seq}`,
          content,
          thinking: thinking !== null && thinking.trim() !== "" ? thinking : null,
          model,
          chunks: null,
          live: false,
        });
        break;
      }
      case "tool.use": {
        const toolName = readString(payload, "toolName") ?? "tool";
        const argsSummary = readString(payload, "argsSummary") ?? "";
        const ok = payload.ok === true;
        const outputSummary = readString(payload, "outputSummary");
        items.push({
          kind: "tool",
          key: `e${event.seq}`,
          toolName,
          argsSummary,
          ok,
          outputSummary,
          outputTail: null,
          live: false,
        });
        break;
      }
      case "turn.error": {
        const code = readString(payload, "code") ?? "ERROR";
        const message = readString(payload, "message") ?? "the turn failed";
        items.push({ kind: "error", key: `e${event.seq}`, code, message });
        break;
      }
      case "turn.warning": {
        const message = readString(payload, "message");
        if (message === null) break;
        items.push({ kind: "meta", key: `e${event.seq}`, text: message });
        break;
      }
      case "approval.requested": {
        const approvalId = readString(payload, "approvalId");
        if (approvalId === null) break;
        items.push({
          kind: "approval",
          key: `e${event.seq}`,
          approvalId,
          toolName: readString(payload, "toolName") ?? "tool",
          argsSummary: readString(payload, "argsSummary") ?? "",
          category: readString(payload, "category") ?? "confirm",
          decision: null,
        });
        break;
      }
      case "approval.resolved": {
        const approvalId = readString(payload, "approvalId");
        const decision = readString(payload, "decision");
        if (approvalId === null || decision === null) break;
        // Update the matching card in place — the transcript keeps ONE card
        // per approval (requested → resolved), not two.
        const target = [...items]
          .reverse()
          .find((item) => item.kind === "approval" && item.approvalId === approvalId);
        if (target !== undefined && target.kind === "approval") {
          const index = items.indexOf(target);
          items[index] = { ...target, decision };
        } else {
          items.push({
            kind: "approval",
            key: `e${event.seq}`,
            approvalId,
            toolName: "tool",
            argsSummary: "",
            category: "confirm",
            decision,
          });
        }
        break;
      }
      case "debug.report": {
        const content = readString(payload, "content") ?? "";
        if (content.trim() === "") break;
        items.push({ kind: "debug", key: `e${event.seq}`, content, live: false });
        break;
      }
      case "todo.update": {
        const todos = readTodoItems(payload.todos);
        if (todos === null) break;
        // ONE card, the LATEST snapshot (the desktop's live card semantics).
        const nextItems = upsertTodoItem(items, todos, payload.source === "user" ? "user" : "agent");
        items.length = 0;
        items.push(...nextItems);
        break;
      }
      case "agent-question.requested": {
        const questionId = readString(payload, "questionId");
        if (questionId === null) break;
        const questions = readQuestionViews(payload.questions);
        if (questions.length === 0) break;
        items.push({
          kind: "question",
          key: `e${event.seq}`,
          questionId,
          questions,
          resolution: "pending",
          answers: null,
          sources: null,
        });
        break;
      }
      case "agent-question.resolved": {
        const questionId = readString(payload, "questionId");
        if (questionId === null) break;
        const resolution =
          payload.resolution === "answered"
            ? "answered"
            : payload.resolution === "cancelled"
              ? "cancelled"
              : "timeout";
        const answers = Array.isArray(payload.answers)
          ? payload.answers.filter((a): a is string => typeof a === "string")
          : null;
        const sources = Array.isArray(payload.sources)
          ? payload.sources.filter((s): s is string => typeof s === "string")
          : null;
        // Patch the matching card in place (the desktop's questionIndex fold).
        const target = [...items]
          .reverse()
          .find((item) => item.kind === "question" && item.questionId === questionId);
        if (target !== undefined && target.kind === "question") {
          const index = items.indexOf(target);
          items[index] = { ...target, resolution, answers, sources };
        } else {
          // An orphan resolution (the requested event predates a log trim) —
          // the honest note card, questions empty.
          items.push({
            kind: "question",
            key: `e${event.seq}`,
            questionId,
            questions: [],
            resolution,
            answers,
            sources,
          });
        }
        break;
      }
      case "session.reverted": {
        items.push({ kind: "meta", key: `e${event.seq}`, text: "the conversation was rewound here" });
        break;
      }
      default: {
        // Unknown type — a dim, honest line (never a crash, never silence).
        items.push({ kind: "meta", key: `e${event.seq}`, text: event.type });
        break;
      }
    }
  }
  return items;
}

// ── the live stream frames (the mobile subset of shared StreamTurnEvent) ────

/**
 * The frames the phone KNOWS. The full desktop union is wider (browser-*,
 * computer-use, …) — unknown frames are tolerated (parseStreamFrame returns
 * the raw record; applyLiveFrame renders a `message`-carrying unknown as a
 * dim meta line and ignores the rest). Forward compatibility by decree.
 */
export type StreamTurnFrame =
  | { type: "text-delta"; delta: string }
  | { type: "thinking-delta"; delta: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-call"; toolName: string; argsSummary: string }
  | { type: "tool-result"; toolName: string; argsSummary: string; ok: boolean; outputSummary?: string }
  | { type: "tool-output"; toolName: string; argsSummary?: string; chunk: string }
  | { type: "meta.continuation"; iteration: number; reason?: string }
  | {
      type: "meta.retry";
      attempt: number;
      totalAttempts: number;
      remainingMs: number;
      errorClass: string;
      message: string;
    }
  | { type: "user.queued"; seq: number; content: string; ts: string }
  | { type: "queued.delivered"; seq: number; content: string; ts: string }
  | { type: "meta.queue_continue"; count: number; recovery?: boolean }
  | { type: "meta.key"; message: string }
  | { type: "meta.overflow_recovery"; message: string }
  | { type: "meta.compaction"; tokensSaved: number; droppedMessages: number }
  | { type: "meta.context_limit"; tokens: number; limit: number }
  | { type: "meta.request_limit"; requests: number; limit: number }
  | { type: "meta.continuation_complete"; iterations: number }
  | {
      type: "subagent-status";
      sessionId: string;
      parentSessionId: string;
      status: "queued" | "running" | "completed" | "failed";
      task: string;
      role: string;
      code?: string;
      model?: string;
      taskId?: string | null;
      detail?: string;
    }
  | {
      type: "agent-question";
      sessionId: string;
      questionId: string;
      questions: Array<{ question: string; options?: string[]; allowCustom?: boolean; placeholder?: string }>;
    }
  | {
      type: "agent-question.resolved";
      sessionId: string;
      questionId: string;
      resolution: "answered" | "timeout" | "cancelled";
      answers?: string[];
      sources?: string[];
    }
  | { type: "todo-updated"; sessionId: string; todos: TodoItemView[]; source?: "agent" | "user" }
  | { type: "screenshot"; frameId: string; tool: string; ts: string }
  | {
      type: "approval.requested";
      approvalId: string;
      toolName: string;
      argsSummary: string;
      category: string;
    }
  | { type: "approval.resolved"; approvalId: string; decision: string; remember?: string }
  | { type: "finish"; usage?: { inputTokens: number; outputTokens: number; totalTokens?: number } }
  | { type: "done"; queuedKept?: number }
  | { type: "stopped" }
  | { type: "error"; status: number; code: string; message: string }
  | { type: "debug-start" }
  | { type: "debug-delta"; delta: string }
  | { type: "debug-done"; content: string; model: string }
  | { type: "debug-error"; message: string }
  | { type: string; [extra: string]: unknown };

/** Parse one SSE data frame (raw JSON text) into a frame record — null on
 * non-JSON or a non-object body (the phone drops it honestly, never crashes). */
export function parseStreamFrame(data: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(data);
    if (!isRecord(raw) || typeof raw.type !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

/** Is this frame one of the three TERMINAL shapes? (The stream closes on it.) */
export function isTerminalFrameType(type: string): boolean {
  return type === "done" || type === "stopped" || type === "error";
}

// ── the live turn state machine ─────────────────────────────────────────────

export type LivePhase = "idle" | "streaming" | "stopping";

export interface LiveTurn {
  phase: LivePhase;
  /** The transcript (persisted base + live items appended in order). */
  items: TranscriptItem[];
  /** The message that started the turn (the optimistic user card). */
  sentContent: string;
  /** Set when a terminal frame arrived — the screen closes + rehydrates. */
  terminal: "done" | "stopped" | "error" | null;
  /** The error frame's payload when terminal === "error". */
  error: { code: string; message: string } | null;
}

/** Cap on the live assistant's delta chunks — beyond it the oldest chunks
 * merge (keeps the per-delta entrance cheap on very long replies). */
const MAX_LIVE_CHUNKS = 240;

/**
 * Begin a turn: the optimistic user card lands immediately (carrying the
 * chips the message was sent with — R113-c, so the phone's own send shows
 * its attachments before the rehydrate confirms them), phase streams.
 */
export function beginLiveTurn(
  baseItems: TranscriptItem[],
  content: string,
  now: number,
  attachments: AttachmentView[] | null = null,
): LiveTurn {
  return {
    phase: "streaming",
    items: [
      ...baseItems,
      {
        kind: "user",
        key: `live-user-${now}`,
        content,
        queued: false,
        attachments,
      },
    ],
    sentContent: content,
    terminal: null,
    error: null,
  };
}

function liveItemKey(now: number, suffix: string): string {
  return `live-${now}-${suffix}`;
}

/**
 * Apply one parsed frame to the live turn (pure — returns a NEW state).
 * Unknown frames: a `message` string renders as a dim meta line, everything
 * else is ignored. Terminal frames set `terminal` + phase idle; the screen
 * then closes the stream and rehydrates from GET /sessions/:id (the truth).
 */
export function applyLiveFrame(turn: LiveTurn, frame: Record<string, unknown>, now: number): LiveTurn {
  const type = typeof frame.type === "string" ? frame.type : "";
  const items = [...turn.items];
  const next: LiveTurn = { ...turn, items };

  const pushAssistantDelta = (delta: string, thinking: boolean): void => {
    if (delta === "") return;
    const last = items[items.length - 1];
    if (last !== undefined && last.kind === "assistant" && last.live) {
      const chunks = last.chunks ?? [last.content];
      const target = thinking ? "thinking" : "text";
      const merged =
        chunks.length >= MAX_LIVE_CHUNKS && target === "text"
          ? mergeOldestChunks(chunks)
          : chunks;
      if (thinking) {
        // Thinking rides the same live item (the collapsible dim block).
        items[items.length - 1] = {
          ...last,
          thinking: (last.thinking ?? "") + delta,
        };
      } else {
        items[items.length - 1] = {
          ...last,
          content: last.content + delta,
          chunks: [...merged, delta],
        };
      }
      return;
    }
    items.push({
      kind: "assistant",
      key: liveItemKey(now, `a${items.length}`),
      content: thinking ? "" : delta,
      thinking: thinking ? delta : null,
      model: null,
      chunks: thinking ? [] : [delta],
      live: true,
    });
  };

  /** Tool frames flush the live assistant segment (the runtime's own
   * flushSegment semantics: text → tool work → more text). */
  const flushAssistant = (): void => {
    const last = items[items.length - 1];
    if (last !== undefined && last.kind === "assistant" && last.live) {
      items[items.length - 1] = { ...last, live: false };
    }
  };

  switch (type) {
    case "text-delta": {
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      pushAssistantDelta(delta, false);
      break;
    }
    case "thinking-delta": {
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      pushAssistantDelta(delta, true);
      break;
    }
    case "tool-input-start": {
      flushAssistant();
      const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
      items.push({ kind: "meta", key: liveItemKey(now, `ti${items.length}`), text: `preparing ${toolName}…` });
      break;
    }
    case "tool-input-delta": {
      break; // the compact preview tier — the phone stays quiet on it
    }
    case "tool-call": {
      flushAssistant();
      items.push({
        kind: "tool",
        key: liveItemKey(now, `t${items.length}`),
        toolName: typeof frame.toolName === "string" ? frame.toolName : "tool",
        argsSummary: typeof frame.argsSummary === "string" ? frame.argsSummary : "",
        ok: null,
        outputSummary: null,
        outputTail: null,
        live: true,
      });
      break;
    }
    case "tool-result": {
      flushAssistant();
      const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
      const ok = frame.ok === true;
      const outputSummary = typeof frame.outputSummary === "string" ? frame.outputSummary : null;
      // Complete the LAST running call with this name (matches by tool name;
      // the runtime emits call → result pairs in order).
      const target = [...items]
        .reverse()
        .find(
          (item) =>
            item.kind === "tool" && item.toolName === toolName && item.ok === null,
        );
      if (target !== undefined && target.kind === "tool") {
        const index = items.indexOf(target);
        items[index] = {
          ...target,
          ok,
          outputSummary: outputSummary ?? target.outputSummary,
          outputTail: target.outputTail,
          live: false,
        };
      } else {
        items.push({
          kind: "tool",
          key: liveItemKey(now, `t${items.length}`),
          toolName,
          argsSummary: typeof frame.argsSummary === "string" ? frame.argsSummary : "",
          ok,
          outputSummary,
          outputTail: null,
          live: false,
        });
      }
      break;
    }
    case "tool-output": {
      const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
      const chunk = typeof frame.chunk === "string" ? frame.chunk : "";
      const target = [...items]
        .reverse()
        .find((item) => item.kind === "tool" && item.toolName === toolName && item.live);
      if (target !== undefined && target.kind === "tool") {
        const index = items.indexOf(target);
        items[index] = {
          ...target,
          outputTail: (target.outputTail ?? "") + chunk,
        };
      }
      break;
    }
    case "meta.continuation": {
      flushAssistant();
      const iteration = typeof frame.iteration === "number" ? frame.iteration : 0;
      items.push({ kind: "meta", key: liveItemKey(now, `c${items.length}`), text: `round ${iteration}` });
      break;
    }
    case "meta.retry": {
      const attempt = typeof frame.attempt === "number" ? frame.attempt : 0;
      const total = typeof frame.totalAttempts === "number" ? frame.totalAttempts : 0;
      const message = typeof frame.message === "string" ? frame.message : "retrying";
      items.push({
        kind: "meta",
        key: liveItemKey(now, `r${items.length}`),
        text: `retrying — attempt ${attempt}/${total} · ${message}`,
      });
      break;
    }
    case "user.queued": {
      const content = typeof frame.content === "string" ? frame.content : "";
      const seq = typeof frame.seq === "number" ? frame.seq : 0;
      items.push({ kind: "user", key: `q${seq}`, content, queued: true, attachments: null });
      break;
    }
    case "queued.delivered": {
      const content = typeof frame.content === "string" ? frame.content : "";
      const seq = typeof frame.seq === "number" ? frame.seq : 0;
      const target = items.find((item) => item.kind === "user" && item.key === `q${seq}`);
      if (target !== undefined && target.kind === "user") {
        const index = items.indexOf(target);
        items[index] = { ...target, content, queued: false };
      } else {
        items.push({ kind: "user", key: `q${seq}`, content, queued: false, attachments: null });
      }
      break;
    }
    case "meta.queue_continue": {
      const count = typeof frame.count === "number" ? frame.count : 0;
      items.push({
        kind: "meta",
        key: liveItemKey(now, `qc${items.length}`),
        text: `continuing with your queued message (${count} waiting)`,
      });
      break;
    }
    case "meta.key":
    case "meta.overflow_recovery": {
      const message = typeof frame.message === "string" ? frame.message : type;
      items.push({ kind: "meta", key: liveItemKey(now, `m${items.length}`), text: message });
      break;
    }
    case "meta.compaction": {
      const saved = typeof frame.tokensSaved === "number" ? frame.tokensSaved : 0;
      items.push({
        kind: "meta",
        key: liveItemKey(now, `cmp${items.length}`),
        text: `context compacted — ${saved} tokens saved`,
      });
      break;
    }
    case "meta.context_limit":
    case "meta.request_limit": {
      const message = `the turn hit the ${type === "meta.context_limit" ? "context" : "request"} limit`;
      items.push({ kind: "meta", key: liveItemKey(now, `l${items.length}`), text: message });
      break;
    }
    case "meta.continuation_complete": {
      break; // the turn's own terminal frame follows — stay quiet
    }
    case "subagent-status": {
      // R113-c: the REAL card (the desktop's SubAgentCard semantics) — ONE
      // card per CHILD, upserted by its sessionId through every transition
      // (queued → running → completed/failed). Live-only by design: the
      // parent's persisted log carries no per-transition events, so the
      // rehydrate folds the delegate_task tool cards instead (the desktop's
      // own honesty limit, mirrored).
      flushAssistant();
      const childSessionId = typeof frame.sessionId === "string" ? frame.sessionId : "";
      const role = typeof frame.role === "string" ? frame.role : "sub-agent";
      const task = typeof frame.task === "string" ? frame.task : "";
      const status = typeof frame.status === "string" ? frame.status : "queued";
      const card = {
        kind: "subagent" as const,
        key: `sub-${childSessionId}`,
        childSessionId,
        role,
        task,
        status,
        code: typeof frame.code === "string" ? frame.code : null,
        model: typeof frame.model === "string" ? frame.model : null,
        taskId: typeof frame.taskId === "string" ? frame.taskId : null,
        detail: typeof frame.detail === "string" ? frame.detail : null,
      };
      const existing = items.findIndex(
        (item) => item.kind === "subagent" && item.childSessionId === childSessionId,
      );
      if (existing >= 0) {
        items[existing] = card;
      } else {
        items.push(card);
      }
      break;
    }
    case "todo-updated": {
      // The LIVE todo card — same ONE-card upsert the persisted fold runs
      // (the stable key means the row updates in place, exactly the way the
      // desktop's working-stream card does).
      const todos = readTodoItems(frame.todos) ?? [];
      const nextItems = upsertTodoItem(
        items,
        todos,
        frame.source === "user" ? "user" : "agent",
      );
      items.length = 0;
      items.push(...nextItems);
      break;
    }
    case "agent-question": {
      flushAssistant();
      const questionId = typeof frame.questionId === "string" ? frame.questionId : "";
      if (questionId === "") break;
      const questions = readQuestionViews(frame.questions);
      if (questions.length === 0) break;
      items.push({
        kind: "question",
        key: `q-${questionId}`,
        questionId,
        questions,
        resolution: "pending",
        answers: null,
        sources: null,
      });
      break;
    }
    case "agent-question.resolved": {
      const questionId = typeof frame.questionId === "string" ? frame.questionId : "";
      const resolution =
        frame.resolution === "answered"
          ? "answered"
          : frame.resolution === "cancelled"
            ? "cancelled"
            : "timeout";
      const answers = Array.isArray(frame.answers)
        ? frame.answers.filter((a): a is string => typeof a === "string")
        : null;
      const sources = Array.isArray(frame.sources)
        ? frame.sources.filter((s): s is string => typeof s === "string")
        : null;
      const target = [...items]
        .reverse()
        .find((item) => item.kind === "question" && item.questionId === questionId);
      if (target !== undefined && target.kind === "question") {
        const index = items.indexOf(target);
        items[index] = { ...target, resolution, answers, sources };
      }
      break;
    }
    case "screenshot": {
      // R68-A parity: the inline capture tile lands AT THE CAPTURE MOMENT
      // (interleaved with the tool rows). LIVE-ONLY — rasters are ephemeral
      // server-side (10-min TTL, LRU 12, never persisted); the folded log
      // carries no screenshots by design, on both ends.
      const frameId = typeof frame.frameId === "string" ? frame.frameId : "";
      if (frameId === "") break;
      items.push({
        kind: "image",
        key: `img-${frameId}`,
        frameId,
        tool: typeof frame.tool === "string" ? frame.tool : "tool",
        ts: typeof frame.ts === "string" ? frame.ts : "",
      });
      break;
    }
    case "approval.requested": {
      flushAssistant();
      const approvalId = typeof frame.approvalId === "string" ? frame.approvalId : "";
      items.push({
        kind: "approval",
        key: liveItemKey(now, `ap${items.length}`),
        approvalId,
        toolName: typeof frame.toolName === "string" ? frame.toolName : "tool",
        argsSummary: typeof frame.argsSummary === "string" ? frame.argsSummary : "",
        category: typeof frame.category === "string" ? frame.category : "confirm",
        decision: null,
      });
      break;
    }
    case "approval.resolved": {
      const approvalId = typeof frame.approvalId === "string" ? frame.approvalId : "";
      const decision = typeof frame.decision === "string" ? frame.decision : "";
      const target = [...items]
        .reverse()
        .find((item) => item.kind === "approval" && item.approvalId === approvalId);
      if (target !== undefined && target.kind === "approval") {
        const index = items.indexOf(target);
        items[index] = { ...target, decision };
      }
      break;
    }
    case "finish": {
      const usage = isRecord(frame.usage) ? frame.usage : null;
      if (usage !== null) {
        const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
        const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
        items.push({
          kind: "meta",
          key: liveItemKey(now, `f${items.length}`),
          text: `finish — ${input} in · ${output} out`,
        });
      }
      break;
    }
    case "debug-start": {
      items.push({
        kind: "debug",
        key: liveItemKey(now, `d${items.length}`),
        content: "",
        live: true,
      });
      break;
    }
    case "debug-delta": {
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      const target = [...items].reverse().find((item) => item.kind === "debug" && item.live);
      if (target !== undefined && target.kind === "debug") {
        const index = items.indexOf(target);
        items[index] = { ...target, content: target.content + delta };
      }
      break;
    }
    case "debug-done": {
      const content = typeof frame.content === "string" ? frame.content : "";
      const target = [...items].reverse().find((item) => item.kind === "debug" && item.live);
      if (target !== undefined && target.kind === "debug") {
        const index = items.indexOf(target);
        items[index] = { ...target, content, live: false };
      } else {
        items.push({ kind: "debug", key: liveItemKey(now, `d${items.length}`), content, live: false });
      }
      break;
    }
    case "debug-error": {
      const message = typeof frame.message === "string" ? frame.message : "the debug analyst failed";
      const target = [...items].reverse().find((item) => item.kind === "debug" && item.live);
      if (target !== undefined && target.kind === "debug") {
        const index = items.indexOf(target);
        items[index] = { ...target, content: message, live: false };
      } else {
        items.push({ kind: "meta", key: liveItemKey(now, `de${items.length}`), text: message });
      }
      break;
    }
    case "done": {
      next.phase = "idle";
      next.terminal = "done";
      break;
    }
    case "stopped": {
      next.phase = "idle";
      next.terminal = "stopped";
      break;
    }
    case "error": {
      next.phase = "idle";
      next.terminal = "error";
      next.error = {
        code: typeof frame.code === "string" ? frame.code : "ERROR",
        message: typeof frame.message === "string" ? frame.message : "the turn failed",
      };
      items.push({
        kind: "error",
        key: liveItemKey(now, `err${items.length}`),
        code: next.error.code,
        message: next.error.message,
      });
      break;
    }
    default: {
      // Unknown frame — a message-carrying one renders as a dim line; the
      // rest are dropped (forward compatibility, never a crash).
      if (typeof frame.message === "string" && frame.message !== "") {
        items.push({ kind: "meta", key: liveItemKey(now, `u${items.length}`), text: frame.message });
      }
      break;
    }
  }

  return next;
}

/** Merge the two oldest live chunks (the cap's compaction step). */
function mergeOldestChunks(chunks: string[]): string[] {
  if (chunks.length < 2) return chunks;
  return [chunks[0] + chunks[1], ...chunks.slice(2)];
}

/** The stream ended WITHOUT a terminal frame (close event, or the app
 * backgrounded): the turn survives server-side (R42) — mark the phase idle
 * and let the screen rehydrate; the transcript is the truth. */
export function abandonLiveTurn(turn: LiveTurn): LiveTurn {
  return { ...turn, phase: "idle", terminal: null };
}

// ── the client (injectable sender) ─────────────────────────────────────────

/** GET the recent session list (the route's own order: created_at DESC). */
export async function fetchSessions(
  sender: ApiSender,
  opts: { limit?: number } = {},
): Promise<ApiOutcome<{ sessions: SessionRow[]; total: number }>> {
  const limit = opts.limit ?? 50;
  return apiJson<{ sessions: SessionRow[]; total: number }>(
    sender,
    `/sessions?limit=${limit}`,
  );
}

/** GET one session + its persisted event log. */
export async function fetchSessionDetail(
  sender: ApiSender,
  id: string,
): Promise<ApiOutcome<SessionDetailWire>> {
  return apiJson<SessionDetailWire>(sender, `/sessions/${encodeURIComponent(id)}`);
}

/** The stream send's body — content + the composer's per-send overrides
 * (R113-c), assembled EXACTLY the way the desktop composer assembles it:
 * `thinkingLevel: "default"` and empty attachments are OMITTED (the backend
 * treats absent = provider default; an override rides only when set). Pure. */
export function sendBody(content: string, overrides: SendOverrides = {}): string {
  return JSON.stringify({
    content,
    ...(overrides.model !== undefined && overrides.model !== "" ? { model: overrides.model } : {}),
    ...(overrides.providerId !== undefined && overrides.providerId !== ""
      ? { providerId: overrides.providerId }
      : {}),
    ...(overrides.thinkingLevel !== undefined && overrides.thinkingLevel !== "default"
      ? { thinkingLevel: overrides.thinkingLevel }
      : {}),
    ...(overrides.attachments !== undefined && overrides.attachments.length > 0
      ? { attachments: overrides.attachments }
      : {}),
  });
}

/** The live-turn stream: POST + the composer's message + overrides. */
export function openTurnStream(
  sender: SseSender,
  sessionId: string,
  content: string,
  overrides: SendOverrides = {},
): SseStream {
  return sender.sse(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
    method: "POST",
    bodyText: sendBody(content, overrides),
  });
}

/** POST stop — the running turn aborts server-side; the stream's own
 * {type:"stopped"} frame (or the rehydrate) confirms it. */
export async function postStop(
  sender: ApiSender,
  sessionId: string,
): Promise<ApiOutcome<{ ok: boolean; stopped: boolean }>> {
  return apiJson<{ ok: boolean; stopped: boolean }>(
    sender,
    `/sessions/${encodeURIComponent(sessionId)}/stop`,
    { method: "POST", bodyText: "{}" },
  );
}

/** The queue body — content validates exactly like the send routes. The
 * queue's OWN override fields (model/providerId/attachments — R82) ride when
 * set; thinkingLevel is deliberately ABSENT (the route validates the shape
 * then ignores it — a queued message carries no reasoning effort). */
export function queueBody(content: string, overrides: SendOverrides = {}): string {
  return sendBody(content, {
    model: overrides.model,
    providerId: overrides.providerId,
    attachments: overrides.attachments,
  });
}

/** POST queue — 409 NO_LIVE_TURN is the honest fallback to a normal send. */
export async function postQueue(
  sender: ApiSender,
  sessionId: string,
  content: string,
  overrides: SendOverrides = {},
): Promise<ApiOutcome<{ ok: boolean; seq: number }>> {
  return apiJson<{ ok: boolean; seq: number }>(
    sender,
    `/sessions/${encodeURIComponent(sessionId)}/queue`,
    { method: "POST", bodyText: queueBody(content, overrides) },
  );
}

/** POST /agent-questions/:id/resolve — the ask_user card's answer (R87).
 * 404 = unknown/expired id (the card's own timeout already settled it). */
export async function postResolveQuestion(
  sender: ApiSender,
  questionId: string,
  answers: string[],
  sources?: string[],
): Promise<ApiOutcome<{ ok: boolean }>> {
  return apiJson<{ ok: boolean }>(
    sender,
    `/agent-questions/${encodeURIComponent(questionId)}/resolve`,
    {
      method: "POST",
      bodyText: JSON.stringify({
        answers,
        ...(sources !== undefined ? { sources } : {}),
      }),
    },
  );
}

/** PATCH /sessions/:id/permissions — the operating-mode switcher (the
 * desktop's exact per-session PATCH; full|ask|plan, applied to the NEXT
 * turn). Returns the updated session detail. */
export async function patchSessionPermissions(
  sender: ApiSender,
  sessionId: string,
  mode: "full" | "ask" | "plan",
): Promise<ApiOutcome<SessionDetailWire>> {
  return apiJson<SessionDetailWire>(
    sender,
    `/sessions/${encodeURIComponent(sessionId)}/permissions`,
    { method: "PATCH", bodyText: JSON.stringify({ mode }) },
  );
}

/** PATCH /sessions/:id — the task-mode picker: activeMode is a mode id from
 * GET /projects/:id/modes (validated against the SAME resolver server-side)
 * or null to clear. Returns the updated session row. */
export async function patchSessionActiveMode(
  sender: ApiSender,
  sessionId: string,
  activeMode: string | null,
): Promise<ApiOutcome<SessionRow>> {
  return apiJson<SessionRow>(sender, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    bodyText: JSON.stringify({ activeMode }),
  });
}
