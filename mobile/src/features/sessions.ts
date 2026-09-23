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
 *
 * ROUND-113 (R113-e — the phone's live view): the REMOTE mirror machinery
 * below (beginRemoteTurn / rebaseRemoteTurn / reduceRemoteTurnFrame) rides
 * the events stream (features/events.ts, GET /api/v1/events/stream's
 * {type:"turn",sessionId,frame} frames — the exact StreamTurnEvent the
 * initiating socket received, published by R113-a's bus): a turn started on
 * the PC streams LIVE on the phone through the SAME applyLiveFrame reducer
 * the phone's own sends use, and the initiator guard keeps an own stream
 * authoritative (no doubled deltas).
 *
 * ROUND-114 (R114-d — the honest transcript): turn.started (the R114-b
 * early frame) opens the mirror INSTANTLY (the remote user bubble renders
 * off the frame's own text + the resolved model labels the turn), the
 * tool-input-delta frames the phone previously ignored now feed a LIVE
 * WRITE PREVIEW (the running card's accumulated partial-JSON raw), and the
 * screenshot frame carries its true {sessionId, frameId, tool, note} shape.
 * User/assistant items carry `ts` (the timestampsMode pref), the tool items
 * carry toolCallId/inputRaw, and SessionRow carries the server-side
 * selectedModel (PATCH {model} + the meta frame's live sync).
 *
 * ROUND-117 (R117-d2 — the mobile multi-agent parity leg): the phone now
 * folds the `subagent-event` ENVELOPES the parent's stream mirrors (the
 * child's live raw stream — orchestrator.ts's wrappedEmit wraps every child
 * frame as {type:"subagent-event", sessionId: <child>, parentSessionId,
 * inner: <the child's own StreamTurnEvent>}; sse.ts's send() mirrors them to
 * the events bus like every other frame, so BOTH the own stream and the
 * remote mirror carry them). The child's thinking/text/tool deltas
 * accumulate on an IN-PLACE `subagentLive` map on the live turn (keyed by
 * child session id — the SubAgentCard's live data source: text appends,
 * tool calls count, thinking flags, a last-activity word + a freshness
 * stamp), and the subagent-status frames create/reset those entries (the
 * PC's stream-store reset rule: a "running" frame clears the accumulators —
 * a retry re-starts the child). The map is ADDITIVE machinery — no new
 * TranscriptItem kind; the card reads it. Plus the sub-agent control
 * routes (POST /sessions/:id/stop on the CHILD directly — R52-b — and
 * POST /sessions/:parent/subagents/:child/retry — ADR-0022's resume) and
 * the honest error fold (turn.error's additive errorClass/attempts fields
 * since R43/R75 — the error card's class chip + attempts line).
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
  /** R114-d (the R114-b wire): the session's SERVER-SIDE selected model —
   * the persistent tier between the per-send override and the agent row
   * (both-null = follow the agent default). GET list/detail carry it;
   * PATCH /sessions/:id {model} sets/clears it; the meta frame syncs it
   * live. The composer pill reads it as its honest no-override label. */
  selectedModel: SessionSelectedModel | null;
}

/** The selected-model pair as the wire carries it (R114-b, verbatim). */
export interface SessionSelectedModel {
  providerId: string;
  model: string;
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

/**
 * R116-m → R118-D — the delivery ladder a user bubble's body renders
 * (chat.md's round-118 amendment — the tick ladder is RETIRED, the state
 * rides the message body; additive — no wire change):
 *   sending     the optimistic card / a queued or outbox row (dull + veil)
 *   sent        the PC acked the message (turn.started — the ack rung)
 *   processing  the PC has STARTED WORKING (the first content/progress
 *               frame after the ack — the breathing accent edge)
 *   delivered   the message settled into the persisted log / a queued row
 *               was delivered into a turn (the settled fold)
 *   failed      the turn's stream died with an error frame (danger edge)
 * A user item WITHOUT a status renders the settled shape (rows from
 * producers this ladder never touched stay clean — the render layer's
 * contract).
 */
export type UserDeliveryStatus = "sending" | "sent" | "processing" | "delivered" | "failed";

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
  | {
      kind: "user";
      key: string;
      content: string;
      queued: boolean;
      attachments: AttachmentView[] | null;
      /** R114-d: the message's own clock (the persisted event's ts; the live
       * cards carry the turn-time ISO). null = nothing to render — the
       * timestampsMode pref gates the display, never the data. */
      ts: string | null;
      /** R116-m: the delivery ladder's rung (the bubble's tick). OPTIONAL —
       * only the rungs this wave can PROVE set it; undefined renders no
       * glyph (clean history from any producer that never picked a rung). */
      status?: UserDeliveryStatus;
    }
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
      /** R114-d: the event's ts (persisted) or the turn-time ISO (live). */
      ts: string | null;
      /** R119-A — the event's MEASURED thinking duration in ms (the wire's
       * additive `thinkingMs`, emitted by the runtime alongside `thinking`
       * since Round 37 — the PC's "Thought for Ns" label reads the same
       * field). The TurnBlock's collapsed rail summarizes it; absent/invalid
       * → undefined (older sidecars, thinking-less segments) and the rail
       * reads the plain "Thought" word, never a guess. Live items never
       * carry it (the live rail shows the live word instead). */
      thinkingMs?: number | null;
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
      /** R114-d: the streaming input's toolCallId (tool-input-start/-delta
       * association — null when the card was opened by tool-call directly). */
      toolCallId: string | null;
      /** R114-d: the accumulated PARTIAL-JSON args raw (tool-input-delta
       * frames) — the live write preview's source. Cleared when the call
       * settles (tool-result) exactly the way the desktop strips liveInput. */
      inputRaw: string | null;
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
  | { kind: "image"; key: string; frameId: string; tool: string; note: string }
  | {
      /** R114-d — the THINKING PLACEHOLDER: rendered by the session screen
       * while a live turn streams with no assistant content yet (the
       * thinkingPlaceholderVisible verdict). Never produced by the fold or
       * the reducer — a display-only synthetic item. */
      kind: "thinking";
      key: string;
      model: string | null;
    }
  | { kind: "meta"; key: string; text: string }
  | {
      kind: "error";
      key: string;
      code: string;
      message: string;
      /** R117-d2 — the provider-error class, when one was classified (the
       * turn.error payload's additive field since R43/R71; the live error
       * frame's details carry it too). null/absent = no chip renders. */
      errorClass?: string | null;
      /** R117-d2 — the total attempts when the transient retry ladder ran
       * (the turn.error payload's additive field since R75; 1 = no ladder).
       * The card renders the attempts line only when > 1. */
      attempts?: number | null;
      /** R119-P — the provider's RAW error text (the wire's providerError:
       * ≤4000 chars, already scrubbed server-side since R78/R80). Carried
       * by BOTH the live error frame's details and the persisted
       * turn.error payload — the PC's TurnErrorCard already prefers it;
       * mobile used to DROP it, so a region/auth rejection read as a
       * generic failure on the phone. null/absent = the wire carried none
       * (older sidecars, validation refusals) — the card keeps the generic
       * line only. */
      providerError?: string | null;
      /** R119-P — the classified human one-liner (the live error frame's
       * details.classMessage — "the provider is out of quota" tier). The
       * persisted fold never carries it; it rides Copy details, never the
       * card body (the RAW provider text + the generic line already carry
       * the story). */
      classMessage?: string | null;
    }
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

/**
 * R114-c — the HUMAN status label (the owner: "every session shows
 * 'queued' — not good"). The wire's vocabulary is machine truth; the badge
 * says what the OWNER means: a queued session is OPEN (waiting for a
 * message, nothing queued behind anything), completed is DONE, cancelled
 * STOPPED. running/failed already read honestly. Pure — every status row
 * (the projects accordion, the session header) renders through this.
 */
export function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case "queued":
      return "open";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
  }
}

/**
 * R114 audit — the sub-agent badge reads the same owner vocabulary as the
 * session badges (the wire's subagent-status vocabulary is machine truth:
 * queued/completed/cancelled surface raw otherwise). Pure.
 */
export function subagentStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return status;
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

/** ── ROUND-120 (why): ── the owner's item 33 — the kebab's Task list entry
 *  with CHECKABLE rows (the R88 owner-write route exists, so the rows act).
 *  The tap transition: completed → pending, pending/in_progress → completed
 *  (a checkbox's own semantics — the in_progress dot is the AGENT's word,
 *  never the owner's lever). Pure + exported for the tests. */
export function toggleTodoAt(todos: TodoItemView[], index: number): TodoItemView[] {
  if (index < 0 || index >= todos.length) return todos;
  return todos.map((todo, i) =>
    i === index
      ? { ...todo, status: todo.status === "completed" ? "pending" : "completed" }
      : todo,
  );
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
          ts: event.ts,
          // R116-m — a settled row rebuilt from the wire: the message IS in
          // the persisted log, so "delivered" is the honest default rung
          // (history reads delivered, never undefined for settled rows).
          status: "delivered",
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
          ts: event.ts,
          // R116-m — the queued row's badge coexists with the clock glyph:
          // the message sits in the server-side queue, not yet delivered.
          status: "sending",
        });
        break;
      }
      case "message.assistant": {
        const content = readString(payload, "content") ?? "";
        const thinking = readString(payload, "thinking");
        const model = readString(payload, "model");
        if (content.trim() === "" && (thinking === null || thinking.trim() === "")) break;
        // R119-A — the measured thinking duration (additive since Round 37,
        // emitted only alongside a non-empty `thinking`): read it honestly —
        // finite and > 0, else absent (never a guess).
        const thinkingMsRaw = payload.thinkingMs;
        const thinkingMs =
          typeof thinkingMsRaw === "number" && Number.isFinite(thinkingMsRaw) && thinkingMsRaw > 0
            ? thinkingMsRaw
            : null;
        items.push({
          kind: "assistant",
          key: `e${event.seq}`,
          content,
          thinking: thinking !== null && thinking.trim() !== "" ? thinking : null,
          model,
          chunks: null,
          live: false,
          ts: event.ts,
          ...(thinkingMs !== null ? { thinkingMs } : {}),
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
          toolCallId: null,
          inputRaw: null,
        });
        break;
      }
      case "turn.error": {
        const code = readString(payload, "code") ?? "ERROR";
        const message = readString(payload, "message") ?? "the turn failed";
        // R117-d2 — the honesty fields the payload has carried since
        // R43/R75 (additive): the classified provider-error class + the
        // retry ladder's exhausted attempt count. Absent/malformed → null
        // (the card renders neither chip; never a guess).
        // R119-P — the provider's RAW error text: the payload has carried
        // providerError since R78/R80 and the PC's TurnErrorCard already
        // prefers it — mobile used to drop it, so a region/auth rejection
        // read as an unexplained generic failure on the phone.
        items.push({
          kind: "error",
          key: `e${event.seq}`,
          code,
          message,
          errorClass: readString(payload, "errorClass"),
          attempts:
            typeof payload.attempts === "number" && Number.isFinite(payload.attempts)
              ? payload.attempts
              : null,
          providerError: readString(payload, "providerError"),
        });
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
  | { type: "turn.started"; text: string; model: string; providerId: string }
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
      /** R117-d2 — the child's LIVE raw stream mirrored onto the parent's
       * channel (orchestrator.ts's wrappedEmit): `sessionId` is the CHILD,
       * `inner` the child's own StreamTurnEvent (text-delta/thinking-delta/
       * tool-call/tool-result/…). The phone accumulates the inner deltas on
       * the live turn's `subagentLive` map — the frames NEVER land as
       * transcript items (mobile-scale mirror of the PC's stream-store). */
      type: "subagent-event";
      sessionId: string;
      parentSessionId: string;
      inner: unknown;
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
  | { type: "screenshot"; sessionId: string; frameId: string; tool: string; note?: string }
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

/**
 * R117-d2 — ONE LIVE SUB-AGENT's accumulated stream state: the SubAgentCard's
 * live data source (the mobile-scale mirror of the PC's stream-store
 * SubAgentLiveEntry). An entry is BORN from a `subagent-status` frame (the
 * only frame family that knows the child's role/task/parent) and then
 * accumulates the child's inner deltas off `subagent-event` envelopes:
 *   · text       — inner text-delta frames append (streamed `delta` tokens,
 *                  the sync path's per-step `text` snapshots — both shapes
 *                  ride the same frame type, exactly as the PC reads them)
 *   · thinking   — inner thinking-delta frames append (the card's
 *                  "thinking…" flag derives from it)
 *   · toolCalls  — inner tool-call frames count (the current attempt)
 *   · lastActivity — the latest tool step's one-line summary
 *   · updatedAtMs  — the last frame that touched this child (freshness)
 * RESET RULE (the PC's own): a `subagent-status` frame with status
 * "running" clears the accumulators — a retry re-starts the child, so the
 * live view starts fresh; a terminal status keeps the frozen tail (the
 * card bridges the settle while the rehydrate lands).
 */
export interface SubAgentLiveEntry {
  childSessionId: string;
  /** The delegating PARENT session (the retry route's first path segment). */
  parentSessionId: string;
  /** The latest subagent-status frame's verdict (raw wire vocabulary). */
  status: string;
  /** The child's live text so far (inner text-delta frames append). */
  text: string;
  /** The child's live thinking so far (inner thinking-delta frames append). */
  thinking: string;
  /** Count of inner tool-call frames in the CURRENT attempt. */
  toolCalls: number;
  /** Human one-line summary of the child's latest tool step (null before
   * the first tool frame). */
  lastActivity: string | null;
  /** Wall-clock ms of the last frame that touched this child (the reducer's
   * own `now` — pure + testable, like every other stamp here). */
  updatedAtMs: number;
}

export interface LiveTurn {
  phase: LivePhase;
  /** The transcript (persisted base + live items appended in order). */
  items: TranscriptItem[];
  /** The message that started the turn (the optimistic user card). */
  sentContent: string;
  /** R114-d: the turn's RESOLVED model (turn.started's `model` — the
   * three-tier ladder's verdict). Feeds the thinking placeholder's label
   * and the live assistant cards' mono line; null until the frame lands
   * (or when an older sidecar never sends it — the placeholder then reads
   * "Thinking" alone, never a guess). */
  model: string | null;
  /** Set when a terminal frame arrived — the screen closes + rehydrates. */
  terminal: "done" | "stopped" | "error" | null;
  /** The error frame's payload when terminal === "error". R117-d2: the
   * payload now carries the honesty fields the wire rides in `details`
   * (errorClass/attempts — the error card's class chip + attempts line). */
  error: TurnErrorLive | null;
  /** R117-d2 — the LIVE SUB-AGENT map, keyed by CHILD session id (absent
   * until the first subagent-status frame — additive state, never an item
   * kind; the SubAgentCard reads its entry for the live render + the
   * Stop/Retry affordances). */
  subagentLive?: Record<string, SubAgentLiveEntry>;
}

/** R117-d2 — the live error frame's payload: code + message + the honesty
 * fields the route's `details` object carries (errorClass/attempts, both
 * additive — absent on validation refusals + older sidecars).
 * R119-P — details.providerError (the provider's RAW scrubbed body —
 * TokenHarbor's region_blocked verdict, verbatim) + details.classMessage
 * (the classified human line) now thread through too; both additive. */
export interface TurnErrorLive {
  code: string;
  message: string;
  errorClass?: string | null;
  attempts?: number | null;
  providerError?: string | null;
  classMessage?: string | null;
}

/** Cap on the live assistant's delta chunks — beyond it the oldest chunks
 * merge (keeps the per-delta entrance cheap on very long replies). */
const MAX_LIVE_CHUNKS = 240;

/** R114-d: cap on a running tool card's accumulated input raw (~256KB,
 * head-kept — `path` precedes `content` in write_file/edit_file args, so the
 * head carries the path; the desktop's MAX_STREAMING_INPUT_BYTES twin). */
const MAX_TOOL_INPUT_RAW = 256 * 1024;

/** The live timestamps' source: the reducer receives `now` in ms — the
 * items carry ISO strings (the render layer formats; the reducer stays
 * pure + testable). */
function isoAt(now: number): string {
  return new Date(now).toISOString();
}

/**
 * R114-d — append one tool-input delta to a running card's partial-args raw,
 * keeping the HEAD past the cap (the path argument rides the head of the
 * JSON; tail-keeping would orphan it). Exported for the tests. */
export function appendToolInputRaw(prev: string | null, delta: string): string {
  const base = prev ?? "";
  if (base.length >= MAX_TOOL_INPUT_RAW) return base;
  const next = base + delta;
  return next.length > MAX_TOOL_INPUT_RAW ? next.slice(0, MAX_TOOL_INPUT_RAW) : next;
}

/** R117-d2 — the last-activity word's length cap (the PC's own 72 — one
 * quiet line, never a wall). */
const SUBAGENT_ACTIVITY_CAP = 72;

/**
 * R117-d2 — human one-line summary of the child's latest tool step (the
 * SubAgentCard's live activity line — the PC's summarizeToolActivity twin):
 * a tool-call names the call + its args; a tool-result names the call + its
 * ✓/✗ verdict + output excerpt. Pure; exported for the tests.
 */
export function summarizeSubAgentToolActivity(
  inner: Record<string, unknown>,
  kind: "tool-call" | "tool-result",
): string {
  const toolName = typeof inner.toolName === "string" ? inner.toolName : "tool";
  if (kind === "tool-call") {
    const args = typeof inner.argsSummary === "string" ? inner.argsSummary.trim() : "";
    return `${toolName}${args !== "" ? ` ${args}` : ""}`.slice(0, SUBAGENT_ACTIVITY_CAP);
  }
  const out = typeof inner.outputSummary === "string" ? inner.outputSummary.trim() : "";
  const mark = inner.ok === true ? "✓" : "✗";
  return out !== ""
    ? `${toolName} ${mark} ${out}`.slice(0, SUBAGENT_ACTIVITY_CAP)
    : `${toolName} ${mark}`;
}

/**
 * R117-d2 — upsert one child's LIVE entry off a `subagent-status` frame (the
 * entry's only birth + reset path): status/parent always from the frame, the
 * accumulators RESET on a fresh "running" (the retry re-start rule — the
 * PC's stream-store semantics verbatim) and carried otherwise (the frozen
 * tail bridges the settle while the rehydrate lands). Pure.
 */
export function upsertSubAgentLiveEntry(
  map: Record<string, SubAgentLiveEntry> | undefined,
  frame: {
    childSessionId: string;
    parentSessionId: string;
    status: string;
    now: number;
  },
): Record<string, SubAgentLiveEntry> {
  const prev = map?.[frame.childSessionId];
  const restarted = frame.status === "running";
  return {
    ...(map ?? {}),
    [frame.childSessionId]: {
      childSessionId: frame.childSessionId,
      parentSessionId: frame.parentSessionId,
      status: frame.status,
      text: restarted ? "" : prev?.text ?? "",
      thinking: restarted ? "" : prev?.thinking ?? "",
      toolCalls: restarted ? 0 : prev?.toolCalls ?? 0,
      lastActivity: prev?.lastActivity ?? null,
      updatedAtMs: frame.now,
    },
  };
}

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
        ts: isoAt(now),
        // R116-m — the ladder's first rung: the card is optimistic until the
        // PC's turn.started ack flips it (the clock glyph meanwhile).
        status: "sending",
      },
    ],
    sentContent: content,
    model: null,
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

  // R118-D — THE PROCESSING RUNG: any frame that is NOT the ack itself
  // (turn.started) and not the queue pair (user.queued / queued.delivered)
  // means the PC has started WORKING — the LAST item, if it is a user card
  // still sitting at "sent", flips to "processing" (exactly once: the guard
  // reads === "sent", and once an assistant/tool card lands it owns the tail
  // so the user card is never re-examined). The remote mirror inherits the
  // promotion free — it rides the same reducer. No wire change.
  if (type !== "turn.started" && type !== "user.queued" && type !== "queued.delivered") {
    const last = items[items.length - 1];
    if (last !== undefined && last.kind === "user" && last.status === "sent") {
      items[items.length - 1] = { ...last, status: "processing" };
    }
  }

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
      model: turn.model,
      chunks: thinking ? [] : [delta],
      live: true,
      ts: isoAt(now),
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
    case "turn.started": {
      // R114-d — the turn's FIRST frame: the resolved effective model (the
      // placeholder + the live assistant cards name it) and, on a REMOTE
      // mirror, the user bubble rendered from the frame's own text — no
      // waiting for the persisted-fold refetch. On the OWN stream the
      // optimistic card beginLiveTurn pushed is already up (key prefix
      // "live-user-"), so the bubble never doubles.
      // R116-m — the ack rung: the frame is the PC's FIRST word after
      // ACCEPTING the message, so the user card it names flips to "sent"
      // (the single check) whichever branch rendered it.
      const model =
        typeof frame.model === "string" && frame.model.trim() !== "" ? frame.model : null;
      if (model !== null) next.model = model;
      const last = items[items.length - 1];
      const ownOptimistic =
        last !== undefined && last.kind === "user" && last.key.startsWith("live-user-");
      if (ownOptimistic && last !== undefined && last.kind === "user") {
        items[items.length - 1] = { ...last, status: "sent" };
      } else {
        const text = typeof frame.text === "string" ? frame.text : "";
        if (text.trim() !== "") {
          items.push({
            kind: "user",
            key: liveItemKey(now, `tsu${items.length}`),
            content: text,
            queued: false,
            attachments: null,
            ts: isoAt(now),
            // The mirrored card is born from the ack frame itself — the
            // message was accepted, so it enters at the "sent" rung.
            status: "sent",
          });
        }
      }
      break;
    }
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
      // R114-d: the model started STREAMING this call's JSON arguments — a
      // running tool card opens NOW (the write preview's home). The old
      // "preparing X…" meta line is gone: the card carries the name, the
      // live status, and (once deltas land) the streaming args themselves.
      // Idempotent on a replayed start frame — one card per toolCallId.
      flushAssistant();
      const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
      const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
      if (
        toolCallId !== "" &&
        items.some((item) => item.kind === "tool" && item.toolCallId === toolCallId)
      ) {
        break;
      }
      items.push({
        kind: "tool",
        key: liveItemKey(now, `ti${items.length}`),
        toolName,
        argsSummary: "",
        ok: null,
        outputSummary: null,
        outputTail: null,
        live: true,
        toolCallId: toolCallId !== "" ? toolCallId : null,
        inputRaw: "",
      });
      break;
    }
    case "tool-input-delta": {
      // R114-d — THE WRITE PREVIEW'S FEED (deliberately ignored since R113-c:
      // the owner: "writing a file was not shown properly on mobile while PC
      // streamed it"). The growing JSON-args prefix accumulates on the
      // running card the matching tool-input-start opened; the renderer's
      // tolerant extractor (features/streaming-args.ts) pulls
      // path/content-so-far out of it. Association is by toolCallId; a
      // delta for an id we never saw grows nothing (the final tool-call
      // frame still renders the row — the desktop's joined-mid-call rule).
      const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
      const delta = typeof frame.inputTextDelta === "string" ? frame.inputTextDelta : "";
      if (delta === "") break;
      const target =
        toolCallId !== ""
          ? [...items]
              .reverse()
              .find((item) => item.kind === "tool" && item.toolCallId === toolCallId)
          : [...items]
              .reverse()
              .find((item) => item.kind === "tool" && item.live && item.inputRaw !== null);
      if (target !== undefined && target.kind === "tool") {
        const index = items.indexOf(target);
        items[index] = { ...target, inputRaw: appendToolInputRaw(target.inputRaw, delta) };
      }
      break;
    }
    case "tool-call": {
      flushAssistant();
      // R114-d: finalize the card the streaming input opened (the wire's
      // tool-call carries NO toolCallId — match the running card by name;
      // the raw STAYS until the result, exactly the desktop's liveInput
      // lifecycle). No streaming input ever seen (a non-streaming provider
      // or a joined-mid-call gap) → the card opens here, as before.
      const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
      const argsSummary = typeof frame.argsSummary === "string" ? frame.argsSummary : "";
      const target = [...items]
        .reverse()
        .find(
          (item) =>
            item.kind === "tool" && item.toolName === toolName && item.inputRaw !== null,
        );
      if (target !== undefined && target.kind === "tool") {
        const index = items.indexOf(target);
        items[index] = { ...target, argsSummary, live: true };
        break;
      }
      items.push({
        kind: "tool",
        key: liveItemKey(now, `t${items.length}`),
        toolName,
        argsSummary,
        ok: null,
        outputSummary: null,
        outputTail: null,
        live: true,
        toolCallId: null,
        inputRaw: null,
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
          // R114-d: the settled card keeps its place + args; the streaming
          // preview raw is spent (the result summary owns the story now) —
          // the desktop's liveInput-strip twin.
          toolCallId: null,
          inputRaw: null,
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
          toolCallId: null,
          inputRaw: null,
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
      items.push({
        kind: "user",
        key: `q${seq}`,
        content,
        queued: true,
        attachments: null,
        ts: typeof frame.ts === "string" ? frame.ts : null,
        // R116-m — the queue chip's clock glyph: the message waits in the
        // server-side queue (the badge coexists with the tick).
        status: "sending",
      });
      break;
    }
    case "queued.delivered": {
      const content = typeof frame.content === "string" ? frame.content : "";
      const seq = typeof frame.seq === "number" ? frame.seq : 0;
      const target = items.find((item) => item.kind === "user" && item.key === `q${seq}`);
      if (target !== undefined && target.kind === "user") {
        const index = items.indexOf(target);
        // R116-m — the delivery rung: the queued message was delivered INTO
        // the agent's turn (the log flips it to message.user — the same
        // "delivered" the settled fold reads, so the rehydrate never jumps).
        items[index] = { ...target, content, queued: false, status: "delivered" };
      } else {
        items.push({
          kind: "user",
          key: `q${seq}`,
          content,
          queued: false,
          attachments: null,
          ts: typeof frame.ts === "string" ? frame.ts : null,
          // R116-m — an unseen seq lands already delivered (the frame is the
          // delivery notice itself).
          status: "delivered",
        });
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
      // R117-d2: the SAME frame family also upserts the child's LIVE entry on
      // the turn's subagentLive map (the card's live data source — see
      // SubAgentLiveEntry). The card upsert + the map upsert share one
      // frame because the status frame is the ONLY place the child's
      // role/task/parent ride the wire.
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
      if (childSessionId !== "") {
        next.subagentLive = upsertSubAgentLiveEntry(next.subagentLive, {
          childSessionId,
          parentSessionId: typeof frame.parentSessionId === "string" ? frame.parentSessionId : "",
          status,
          now,
        });
      }
      break;
    }
    case "subagent-event": {
      // R117-d2 — the child's LIVE raw stream, mirrored onto the parent's
      // channel as {type:"subagent-event", sessionId: <child>,
      // parentSessionId, inner}. MOBILE SCALE of the PC's stream-store
      // handling: the inner deltas accumulate on the child's LIVE entry
      // (text appends, thinking appends, tool calls count, the latest tool
      // step becomes the last-activity word) — never a transcript item.
      // An envelope for a child with NO live entry drops (the PC's own
      // prev-undefined guard: the entry is born from a status frame, and
      // deltas for an unknown child would have nowhere honest to land).
      // Inner approvals/finish/meta frames fall through untouched: the
      // approvals INBOX (GET /approvals lists child approvals too) owns the
      // decision surface on mobile, and the terminal statuses ride the
      // next subagent-status frame anyway.
      const childSessionId = typeof frame.sessionId === "string" ? frame.sessionId : "";
      const prevMap = next.subagentLive;
      const prev = childSessionId !== "" ? prevMap?.[childSessionId] : undefined;
      if (childSessionId === "" || prevMap === undefined || prev === undefined) break;
      const inner = isRecord(frame.inner) ? frame.inner : null;
      if (inner === null) break; // malformed envelope — never a guess
      const innerType = typeof inner.type === "string" ? inner.type : "";
      let text = prev.text;
      let thinking = prev.thinking;
      let toolCalls = prev.toolCalls;
      let lastActivity = prev.lastActivity;
      if (innerType === "text-delta") {
        // Streamed children send token-level `delta`s; the sync path sends
        // per-step snapshots as `text` — accumulate whichever the frame
        // carries (the PC's exact twin).
        const chunk =
          typeof inner.delta === "string"
            ? inner.delta
            : typeof inner.text === "string"
              ? inner.text
              : "";
        if (chunk !== "") text = prev.text + chunk;
      } else if (innerType === "thinking-delta") {
        const delta = typeof inner.delta === "string" ? inner.delta : "";
        if (delta !== "") thinking = prev.thinking + delta;
      } else if (innerType === "tool-call") {
        toolCalls = prev.toolCalls + 1;
        lastActivity = summarizeSubAgentToolActivity(inner, "tool-call");
      } else if (innerType === "tool-result") {
        lastActivity = summarizeSubAgentToolActivity(inner, "tool-result");
      }
      next.subagentLive = {
        ...prevMap,
        [childSessionId]: {
          ...prev,
          text,
          thinking,
          toolCalls,
          lastActivity,
          updatedAtMs: now,
        },
      };
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
      // R114-d: the frame's TRUE shape is {sessionId, frameId, tool, note?}
      // (computer-use + browser both emit `note`, never a ts) — the caption
      // now reads `tool · note` instead of the always-empty ts the old type
      // invented.
      const frameId = typeof frame.frameId === "string" ? frame.frameId : "";
      if (frameId === "") break;
      items.push({
        kind: "image",
        key: `img-${frameId}`,
        frameId,
        tool: typeof frame.tool === "string" ? frame.tool : "tool",
        note: typeof frame.note === "string" ? frame.note : "",
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
      // R117-d2 — the honesty fields the route's `details` object rides
      // (additive: errorClass since the R71 classification, attempts since
      // the R75 ladder; both absent on validation refusals + older
      // sidecars — the card renders neither chip then).
      // R119-P — details.providerError: the provider's RAW scrubbed body
      // (the round-119 §1 item F fix — the owner's TokenHarbor report read
      // as a generic failure on the phone because BOTH mobile reducers
      // dropped it while the PC showed it). details.classMessage (the
      // classified human line) rides along when present.
      const details = isRecord(frame.details) ? frame.details : null;
      next.error = {
        code: typeof frame.code === "string" ? frame.code : "ERROR",
        message: typeof frame.message === "string" ? frame.message : "the turn failed",
        errorClass:
          details !== null && typeof details.errorClass === "string"
            ? details.errorClass
            : null,
        attempts:
          details !== null && typeof details.attempts === "number" && Number.isFinite(details.attempts)
            ? details.attempts
            : null,
        providerError:
          details !== null && typeof details.providerError === "string"
            ? details.providerError
            : null,
        classMessage:
          details !== null && typeof details.classMessage === "string"
            ? details.classMessage
            : null,
      };
      // R116-m → R118-D — the failed rung: the turn's OWN user card (the
      // last one still in flight — "sending", "sent", or "processing") flips
      // to "failed" while the overlay lives; the rehydrate that follows swaps
      // in the truth (the persisted row reads "delivered" — the message DID
      // reach the log; the error card below carries the turn's failure
      // story). Cards at any other rung are untouched (a delivered queued
      // message did NOT fail; an undefined status stays clean — the additive
      // discipline).
      const inFlight = [...items]
        .reverse()
        .find(
          (item) =>
            item.kind === "user" &&
            (item.status === "sending" ||
              item.status === "sent" ||
              item.status === "processing"),
        );
      if (inFlight !== undefined && inFlight.kind === "user") {
        const index = items.indexOf(inFlight);
        items[index] = { ...inFlight, status: "failed" };
      }
      items.push({
        kind: "error",
        key: liveItemKey(now, `err${items.length}`),
        code: next.error.code,
        message: next.error.message,
        errorClass: next.error.errorClass ?? null,
        attempts: next.error.attempts ?? null,
        providerError: next.error.providerError ?? null,
        classMessage: next.error.classMessage ?? null,
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

/** The item kinds that mean the agent is already WORKING — once any of them
 * lands after the turn's user card, the thinking placeholder is spent (the
 * R114-d rule: only text/thinking DELTAS or real tool work replace it; dim
 * meta lines do not). */
const THINKING_PROGRESS_KINDS: ReadonlySet<string> = new Set([
  "assistant",
  "tool",
  "approval",
  "question",
  "todo",
  "subagent",
  "image",
  "error",
  "debug",
]);

/**
 * R114-d — is the THINKING PLACEHOLDER due? True while a live turn streams
 * with NO assistant content arrived yet (no text/thinking deltas, no tool
 * work — only the turn's own user card sits at the tail, live-keyed).
 * False once real content lands (the first delta replaces it), on every
 * terminal/abandoned state, and when the tail's user card is not THIS
 * turn's (a persisted row — nothing live to anchor the placeholder to).
 * Pure — the screen calls it per render, the tests pin the verdicts.
 */
export function thinkingPlaceholderVisible(turn: LiveTurn): boolean {
  if (turn.phase !== "streaming" || turn.terminal !== null) return false;
  let lastUserIdx = -1;
  for (let i = turn.items.length - 1; i >= 0; i -= 1) {
    if (turn.items[i]?.kind === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return false;
  const card = turn.items[lastUserIdx];
  if (card === undefined || card.kind !== "user" || !card.key.startsWith("live-")) {
    return false;
  }
  for (let i = lastUserIdx + 1; i < turn.items.length; i += 1) {
    const item = turn.items[i];
    if (item !== undefined && THINKING_PROGRESS_KINDS.has(item.kind)) return false;
  }
  return true;
}

// ── the REMOTE mirror (R113-e — the phone's live view of ANOTHER device's
// turn, fed by the events stream's {type:"turn"} frames) ──────────────────

/**
 * Begin a REMOTE turn's mirror: another device started this turn, and the
 * events stream mirrors every frame the initiating socket receives. The
 * overlay carries the current base + the mirrored frames — no optimistic
 * user card of OURS (R114-d: the turn's own turn.started frame renders the
 * OTHER device's message as the user card the moment it lands; before that
 * frame the placeholder math sees only the base). No clock: the mirror has
 * no optimistic card to key off a timestamp (the own-turn begin's only
 * `now` consumer).
 */
export function beginRemoteTurn(baseItems: TranscriptItem[]): LiveTurn {
  return {
    phase: "streaming",
    items: [...baseItems],
    sentContent: "",
    model: null,
    terminal: null,
    error: null,
  };
}

/**
 * Fold a fresh rehydrate under a remote mirror's live tail: the persisted
 * log (the user card that STARTED the remote turn, appended tool rows)
 * lands under the frames streamed since the mirror opened. `baseCount` is
 * the base length the mirror was LAST rebased onto — everything after it
 * in the mirror's items is the live tail. Pure; a shorter fresh base (a
 * log trim) safely drops the tail's anchor row.
 *
 * ROUND-119 (R119-A — the queued-message position law, round-119 §1 item 7):
 * a folded `message.queued` row rides its LOG position — right after the
 * last persisted event, which early in a turn is right after the opening
 * user message — so `[...freshBase, ...tail]` rendered the waiting chip
 * ABOVE the in-progress items (the owner: "the queued message renders just
 * below the first message instead of after the currently-processing
 * section"). The STILL-QUEUED folded rows now move to the END of the live
 * tail (after the in-progress items); a folded queued row the tail already
 * mirrors as a LIVE q-row (the events stream carried the queue route's
 * user.queued frame onto the mirror) is dropped — the live row owns the
 * slot, content-identical, and flips in place on queued.delivered, exactly
 * the head-dedupe discipline below.
 */
export function rebaseRemoteTurn(
  turn: LiveTurn,
  baseItems: TranscriptItem[],
  baseCount: number,
): LiveTurn {
  const rawTail = turn.items.slice(baseCount);
  // R114-d: turn.started's mirrored user card (the frame's own text, pushed
  // so the bubble rendered BEFORE the persisted fold refetch) duplicates the
  // message.user row the fresh base now carries — drop the LIVE one (the
  // persisted card owns the slot; content-identical, key-stable). Anything
  // else folds exactly as before.
  let tail = rawTail;
  if (rawTail.length > 0) {
    const head = rawTail[0];
    const last = baseItems.length > 0 ? baseItems[baseItems.length - 1] : undefined;
    if (
      head?.kind === "user" &&
      head.key.startsWith("live-") &&
      last?.kind === "user" &&
      last.content === head.content
    ) {
      tail = rawTail.slice(1);
    }
  }
  // R119-A — pull the STILL-QUEUED folded rows out of the fresh base and
  // re-append them AFTER the live tail. Delivered rows (the log flips
  // message.queued → message.user IN PLACE) ride their settled positions —
  // the law moves only what is still WAITING.
  const queuedFolded: Array<TranscriptItem & { kind: "user" }> = [];
  const settledBase: TranscriptItem[] = [];
  for (const item of baseItems) {
    if (item.kind === "user" && item.queued) queuedFolded.push(item);
    else settledBase.push(item);
  }
  if (queuedFolded.length === 0) {
    return { ...turn, items: [...settledBase, ...tail] };
  }
  const unmirrored = queuedFolded.filter(
    (row) =>
      !tail.some(
        (live) => live.kind === "user" && live.queued && live.content === row.content,
      ),
  );
  return { ...turn, items: [...settledBase, ...tail, ...unmirrored] };
}

/** One remote-turn decision off the events stream — the screen drives the
 * side effects, this pure reducer owns the verdict (unit-tested). */
export interface RemoteTurnInput {
  /** The current overlay (null = none). */
  live: LiveTurn | null;
  /** The current overlay is a REMOTE mirror (the screen tracks it). */
  remote: boolean;
  /** This screen holds the initiating stream (its own POST is streaming). */
  ownStream: boolean;
  /** The current persisted base (a fresh mirror opens over it). */
  baseItems: TranscriptItem[];
  /** The mirrored frame, shape-checked (events.turnFrameRecord). */
  frame: Record<string, unknown>;
  now: number;
}

export interface RemoteTurnResult {
  /** The next overlay (always non-null when the result exists). */
  turn: LiveTurn;
  /** A fresh remote mirror was opened this frame (the caller records the
   * base split point + pulls the truth in). */
  began: boolean;
  /** A terminal frame landed — the caller rehydrates; the truth wins. */
  terminal: boolean;
}

/**
 * The remote-turn frame decision (R113-e, pure):
 *   · null → IGNORE: this device's own turn is in flight (the initiating
 *     POST stream renders this exact frame — the bus mirrors it back too —
 *     and a mirror would double every delta).
 *   · otherwise → apply the frame through the SAME applyLiveFrame reducer
 *     the own stream uses (thinking/caret/tool-running/queue chips render
 *     identically), opening a fresh mirror when none is active — or when
 *     the previous mirror already went terminal (a NEW turn must never
 *     append to a dead one), or when converting an ABANDONED own overlay
 *     (its stream died mid-turn; the events stream carries the remainder).
 */
export function reduceRemoteTurnFrame(input: RemoteTurnInput): RemoteTurnResult | null {
  const prev = input.live;
  if (prev !== null && !input.remote) {
    // An OWN overlay. Live (streaming/stopping, or the stream still held) →
    // the initiator's own reader owns this frame. Abandoned (phase idle, no
    // terminal, stream dropped) → fall through: the fresh mirror below
    // replaces it and the events stream carries the turn's remainder.
    const ownInFlight = input.ownStream || (prev.phase !== "idle" && prev.terminal === null);
    if (ownInFlight) return null;
  }
  const began = prev === null || !input.remote || prev.terminal !== null;
  const turn = began ? beginRemoteTurn(input.baseItems) : prev;
  const next = applyLiveFrame(turn, input.frame, input.now);
  return { turn: next, began, terminal: next.terminal !== null };
}

/** A session frame's `status` field → the closed union — null when it is
 * not a known status (never a guess; the header badge keeps its truth). */
export function sessionStatusFromWire(value: unknown): SessionStatus | null {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return null;
}

/** R114-d — one {kind:"meta"} session frame's carried preference changes
 * (the R114-b wire: only the field(s) this change touched ride — absent
 * keys stay absent, never undefined). Extracted as its own type so the
 * session screen's in-place patch + the tests share ONE shape. */
export interface SessionMetaPatch {
  permissionMode?: string;
  activeMode?: string | null;
  selectedModel?: SessionSelectedModel | null;
}

/**
 * R114-d — apply a meta frame's carried fields to the CURRENT session row
 * IN PLACE (the instant label flip — no refetch round-trip): present keys
 * overwrite, absent keys leave the row untouched, and the caller keeps its
 * wider type (the screen's detail carries events/lastSeq). Pure — pinned
 * by tests; the screen's debounced rehydrate stays the truth backstop.
 */
export function applySessionMetaPatch<T extends SessionRow>(row: T, patch: SessionMetaPatch): T {
  let next = row;
  if (patch.permissionMode !== undefined) {
    next = { ...next, permissionMode: patch.permissionMode };
  }
  if (patch.activeMode !== undefined) {
    next = { ...next, activeMode: patch.activeMode };
  }
  if (patch.selectedModel !== undefined) {
    next = { ...next, selectedModel: patch.selectedModel };
  }
  return next;
}

/**
 * R114-d — the compact model id for the header subtitle + anywhere a long
 * provider-prefixed id would wrap: the segment after the last "/" (the
 * provider prefix), capped at 22 chars with an ellipsis. Pure.
 */
export function shortModelId(modelId: string): string {
  const bare = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  return bare.length > 22 ? `${bare.slice(0, 21)}…` : bare;
}

/** Per-project session stats folded client-side (the sessions route has NO
 * server-side projectId filter): the total + how many are RUNNING right
 * now — the projects tab's count line + live dots. */
export function countProjectSessions(
  sessions: SessionRow[],
): Record<string, { total: number; running: number }> {
  const stats: Record<string, { total: number; running: number }> = {};
  for (const session of sessions) {
    if (session.projectId === null) continue;
    const cur = stats[session.projectId] ?? { total: 0, running: 0 };
    cur.total += 1;
    if (session.status === "running") cur.running += 1;
    stats[session.projectId] = cur;
  }
  return stats;
}

/**
 * R114-c — the projects accordion's session fold: sessions grouped by
 * projectId, the list's own order preserved (created_at DESC off the route,
 * so each group is already most-recent-first). Project-less sessions are
 * skipped. Pure — the memo in projects.tsx keys on the folded 200.
 */
export function groupProjectSessions(
  sessions: SessionRow[],
): Record<string, SessionRow[]> {
  const groups: Record<string, SessionRow[]> = {};
  for (const session of sessions) {
    if (session.projectId === null) continue;
    const cur = groups[session.projectId];
    if (cur === undefined) {
      groups[session.projectId] = [session];
    } else {
      cur.push(session);
    }
  }
  return groups;
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
 * {type:"stopped"} frame (or the rehydrate) confirms it. R117-d2: the SAME
 * route stops a registered SUB-AGENT child directly (R52-b — the child's own
 * turn-registry entry aborts, the parent turn continues and gets the honest
 * "stopped by the owner" report; the SubAgentCard's Stop affordance rides it). */
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

/**
 * R117-d2 — POST /sessions/:parent/subagents/:child/retry — the SubAgentCard's
 * Retry affordance (ADR-0022's resume: the child re-runs from its own event
 * log, re-acquiring a concurrency slot). The parent id is the LIVE entry's
 * own parentSessionId (the subagent-status frame's), the child the card's.
 * 200 → the retried child's queued/running status frames follow on the
 * stream; 404 = unknown child under that parent; 409 = already running;
 * 502 = the provider refused the re-run (the honest failure note).
 */
export async function postSubAgentRetry(
  sender: ApiSender,
  parentSessionId: string,
  childSessionId: string,
): Promise<ApiOutcome<{ ok: boolean; message: string }>> {
  return apiJson<{ ok: boolean; message: string }>(
    sender,
    `/sessions/${encodeURIComponent(parentSessionId)}/subagents/${encodeURIComponent(childSessionId)}/retry`,
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

/** ── ROUND-120 (why): ── POST /sessions/:id/todo — the owner's manual todo
 *  write (the R88 route the desktop's floating widget rides; the body is
 *  {todos: [{content, status}]}, the whole list at once, source:"user" so
 *  the agent SEES the owner's edit on its next turn). 200 carries the
 *  persisted list back; 404 = unknown session; 409 = no bound agent. */
export async function postSessionTodo(
  sender: ApiSender,
  sessionId: string,
  todos: TodoItemView[],
): Promise<ApiOutcome<{ ok: boolean; todos: TodoItemView[] }>> {
  return apiJson<{ ok: boolean; todos: TodoItemView[] }>(
    sender,
    `/sessions/${encodeURIComponent(sessionId)}/todo`,
    { method: "POST", bodyText: JSON.stringify({ todos }) },
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

/**
 * R114-d — PATCH /sessions/:id {model}: the session's SERVER-SIDE selected
 * model (the R114-b contract: a complete {providerId, model} pair validated
 * server-side against the configured providers + models/catalog, or null to
 * clear back to the agent default). Returns the updated session row; the
 * {kind:"meta", selectedModel} frame the setter publishes flips every open
 * device's label live. The local per-send override stays a SEPARATE tier
 * (sendBody) — this row is what the other devices see.
 */
export async function patchSessionSelectedModel(
  sender: ApiSender,
  sessionId: string,
  model: SessionSelectedModel | null,
): Promise<ApiOutcome<SessionRow>> {
  return apiJson<SessionRow>(sender, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    bodyText: JSON.stringify({ model }),
  });
}
