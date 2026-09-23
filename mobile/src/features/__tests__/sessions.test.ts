/**
 * sessions.test.ts — the transcript state machine: the persisted-event fold
 * (user/queued/assistant+thinking/tool/turn.error/approval pairing/unknown
 * types), the live-frame application (deltas, tool cards, queue chips,
 * approvals, terminal frames), the delivery ladder (R116-m — the user
 * bubble's sending → sent → delivered → failed rungs), the pure helpers,
 * the typed client paths + bodies, and the REMOTE mirror (R113-e — the
 * events-stream frames of ANOTHER device's turn, reduced through the same
 * applyLiveFrame) — injected fakes only, zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender, SseSender } from "../api";
import {
  abandonLiveTurn,
  appendToolInputRaw,
  applyLiveFrame,
  applySessionMetaPatch,
  beginLiveTurn,
  beginRemoteTurn,
  countProjectSessions,
  fetchSessionDetail,
  fetchSessions,
  filterByProject,
  foldSessionEvents,
  groupProjectSessions,
  isTerminalFrameType,
  isTurnRunning,
  openTurnStream,
  parseStreamFrame,
  patchSessionActiveMode,
  patchSessionPermissions,
  patchSessionSelectedModel,
  postQueue,
  postResolveQuestion,
  postSessionTodo,
  postStop,
  postSubAgentRetry,
  queueBody,
  rebaseRemoteTurn,
  reduceRemoteTurnFrame,
  sendBody,
  sessionStatusFromWire,
  sessionStatusLabel,
  subagentStatusLabel,
  sessionStatusTone,
  sessionTitle,
  shortModelId,
  thinkingPlaceholderVisible,
  toggleTodoAt,
  type LiveTurn,
  type SessionEventWire,
  type SessionRow,
  type TodoItemView,
  type TranscriptItem,
} from "../sessions";
import type { SseStream } from "@/link/connection";

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_000;

function event(seq: number, type: string, payload: unknown): SessionEventWire {
  return { seq, type, agentId: "agent_default", payload, ts: "2026-09-18T11:00:00Z" };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess_abcdef123456",
    projectId: "proj_acute",
    agentId: "agent_default",
    mode: "single",
    status: "queued",
    title: null,
    createdAt: "2026-09-18T10:00:00Z",
    updatedAt: "2026-09-18T11:00:00Z",
    parentSessionId: null,
    subRole: null,
    permissionMode: "ask",
    activeMode: null,
    taskId: null,
    // R114-d: the session's server-side selected model (null = the agent
    // default — every pre-R114 row reads as this).
    selectedModel: null,
    ...overrides,
  };
}

function makeApiSender(
  respond: (path: string, init: { method?: string; bodyText?: string }) => {
    status: number;
    bodyText: string;
  },
) {
  const calls: Array<{ path: string; init: { method?: string; bodyText?: string } }> = [];
  const sender: ApiSender = {
    async api(path, init = {}) {
      calls.push({ path, init });
      const response = respond(path, init);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: {},
        bodyText: response.bodyText,
      };
    },
  };
  return { sender, calls };
}

class FakeStream implements SseStream {
  readonly eventId: number;
  readonly openedWith: { url: string; method?: string; bodyText?: string };
  closed = false;
  constructor(openedWith: { url: string; method?: string; bodyText?: string }) {
    this.openedWith = openedWith;
    this.eventId = FakeStream.nextId++;
  }
  private static nextId = 1;
  addEventListener(): SseStream {
    return this;
  }
  close(): void {
    this.closed = true;
  }
}

function makeSseSender() {
  const opens: Array<{ url: string; method?: string; bodyText?: string }> = [];
  const sender: SseSender = {
    sse(path, init = {}) {
      const openedWith = { url: path, method: init.method, bodyText: init.bodyText };
      opens.push(openedWith);
      return new FakeStream(openedWith);
    },
  };
  return { sender, opens };
}

// ── the pure helpers ────────────────────────────────────────────────────────

describe("sessions — pure helpers", () => {
  it("titles honestly: the session's title, else the short id", () => {
    expect(sessionTitle(makeSession({ title: "Fix the parser" }))).toBe("Fix the parser");
    expect(sessionTitle(makeSession({ title: "   " }))).toBe("Session sess_abcdef1");
    expect(sessionTitle(makeSession())).toBe("Session sess_abcdef1");
  });

  it("tones the status for the row badge", () => {
    expect(sessionStatusTone("running")).toBe("warning");
    expect(sessionStatusTone("completed")).toBe("success");
    expect(sessionStatusTone("failed")).toBe("danger");
    expect(sessionStatusTone("cancelled")).toBe("danger");
    expect(sessionStatusTone("queued")).toBe("neutral");
  });

  it("R114-c: labels the status HONESTLY — the wire's words are machine truth, the badge speaks owner", () => {
    // The owner: "every session shows 'queued' — not good". A queued
    // session is OPEN (nothing is queued behind anything); completed is
    // DONE; cancelled is STOPPED. running/failed already read honestly.
    expect(sessionStatusLabel("queued")).toBe("open");
    expect(sessionStatusLabel("running")).toBe("running");
    expect(sessionStatusLabel("completed")).toBe("done");
    expect(sessionStatusLabel("failed")).toBe("failed");
    expect(sessionStatusLabel("cancelled")).toBe("stopped");
  });

  it("R114 audit: the sub-agent badge reads the same owner vocabulary (raw 'completed' never surfaces)", () => {
    expect(subagentStatusLabel("completed")).toBe("done");
    expect(subagentStatusLabel("cancelled")).toBe("stopped");
    expect(subagentStatusLabel("queued")).toBe("queued");
    expect(subagentStatusLabel("running")).toBe("running");
    expect(subagentStatusLabel("failed")).toBe("failed");
    // Unknown vocabulary passes through verbatim — never invents.
    expect(subagentStatusLabel("deferred")).toBe("deferred");
  });

  it("knows when a turn is in flight (the R44 status contract)", () => {
    expect(isTurnRunning(makeSession({ status: "running" }))).toBe(true);
    expect(isTurnRunning(makeSession({ status: "queued" }))).toBe(false);
    expect(isTurnRunning(makeSession({ status: "completed" }))).toBe(false);
  });

  it("filters by project client-side (the route has no server-side filter)", () => {
    const rows = [
      makeSession({ id: "a", projectId: "proj_1" }),
      makeSession({ id: "b", projectId: "proj_2" }),
      makeSession({ id: "c", projectId: null }),
    ];
    expect(filterByProject(rows, "proj_1").map((s) => s.id)).toEqual(["a"]);
    expect(filterByProject(rows, null)).toHaveLength(3);
  });
});

// ── the persisted fold ──────────────────────────────────────────────────────

describe("sessions — the persisted event fold", () => {
  it("folds user, queued, assistant(+thinking), and tool events in order", () => {
    const items = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "hello" }),
      event(2, "message.queued", { role: "user", content: "and one more thing" }),
      event(3, "message.assistant", {
        role: "assistant",
        content: "thinking about it",
        thinking: "the user greeted me",
        model: "glm-5.2",
      }),
      event(4, "tool.use", {
        role: "tool",
        toolName: "run_command",
        argsSummary: "pnpm test",
        ok: true,
        outputSummary: "3 passed",
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user", "user", "assistant", "tool"]);
    const [first, second, third, fourth] = items;
    expect(first.kind === "user" && first.queued).toBe(false);
    expect(second.kind === "user" && second.queued).toBe(true);
    // R116-m — the fold's delivery rungs: a settled row reads "delivered"
    // (never undefined for settled rows), a queued row reads "sending".
    expect(first.kind === "user" && first.status).toBe("delivered");
    expect(second.kind === "user" && second.status).toBe("sending");
    expect(third.kind === "assistant" && third.thinking).toBe("the user greeted me");
    expect(third.kind === "assistant" && third.model).toBe("glm-5.2");
    expect(fourth.kind === "tool" && fourth.ok).toBe(true);
    expect(fourth.kind === "tool" && fourth.outputSummary).toBe("3 passed");
  });

  it("folds turn.error honestly with the code + message", () => {
    const items = foldSessionEvents([
      event(1, "turn.error", { code: "PROVIDER_ERROR", message: "no API key" }),
    ]);
    const [first] = items;
    expect(first?.kind).toBe("error");
    expect(first?.kind === "error" && first.code).toBe("PROVIDER_ERROR");
    expect(first?.kind === "error" && first.message).toBe("no API key");
  });

  it("pairs approval.requested → approval.resolved into ONE card", () => {
    const items = foldSessionEvents([
      event(1, "approval.requested", {
        type: "approval.requested",
        approvalId: "appr_1",
        toolName: "run_command",
        argsSummary: "rm -r build",
        category: "destructive",
      }),
      event(2, "approval.resolved", {
        type: "approval.resolved",
        approvalId: "appr_1",
        decision: "denied",
      }),
    ]);
    expect(items).toHaveLength(1);
    const [first] = items;
    expect(first?.kind === "approval" && first.decision).toBe("denied");
    expect(first?.kind === "approval" && first.category).toBe("destructive");
  });

  it("renders unknown event types as dim meta lines (never a crash)", () => {
    const items = foldSessionEvents([
      event(1, "some.future.event", { anything: true }),
      event(2, "another.future.event", { more: "stuff" }),
    ]);
    expect(items[0]?.kind === "meta" && items[0].text).toBe("some.future.event");
    expect(items[1]?.kind === "meta" && items[1].text).toBe("another.future.event");
  });

  it("drops empty payloads quietly (no phantom bubbles)", () => {
    const items = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "   " }),
      event(2, "message.assistant", { role: "assistant", content: "" }),
    ]);
    expect(items).toHaveLength(0);
  });

  // ── R113-c: the rich fold — todo cards, question cards, attachment chips ──

  it("folds todo.update into ONE card carrying the LATEST snapshot (source rides)", () => {
    const items = foldSessionEvents([
      event(1, "message.user", { content: "build it" }),
      event(2, "todo.update", { todos: [{ content: "a", status: "pending" }] }),
      event(3, "todo.update", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] }),
    ]);
    const todos = items.filter((item) => item.kind === "todo");
    expect(todos).toHaveLength(1); // one card, never a stack
    expect(todos[0]?.kind === "todo" && todos[0].key).toBe("todos"); // stable key → in-place updates
    expect(
      todos[0]?.kind === "todo" && todos[0].todos.map((t) => `${t.content}:${t.status}`),
    ).toEqual(["a:completed", "b:in_progress"]);
    expect(todos[0]?.kind === "todo" && todos[0].source).toBe("agent");
    // the card sits AFTER the message it answers (positioned at the LATEST
    // todo event — the upsert never stacks a second card)
    const userIndex = items.findIndex((item) => item.kind === "user");
    const todoIndex = items.findIndex((item) => item.kind === "todo");
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(todoIndex).toBeGreaterThan(userIndex);
  });

  it("marks a user-edited todo list (the widget's manual edit)", () => {
    const items = foldSessionEvents([
      event(1, "todo.update", { todos: [{ content: "a", status: "completed" }], source: "user" }),
    ]);
    expect(items[0]?.kind === "todo" && items[0].source).toBe("user");
  });

  it("R120-P: toggleTodoAt — the kebab's checkable rows (completed ↔ pending; in_progress → completed)", () => {
    // the owner's item 33: the tap transition is a checkbox's own
    // semantics — the in_progress dot is the AGENT's word, never the
    // owner's lever, so tapping it completes (never reverts to pending).
    const todos: TodoItemView[] = [
      { content: "read the brief", status: "completed" },
      { content: "write the code", status: "in_progress" },
      { content: "ship it", status: "pending" },
    ];
    expect(toggleTodoAt(todos, 0)).toEqual([
      { content: "read the brief", status: "pending" },
      { content: "write the code", status: "in_progress" },
      { content: "ship it", status: "pending" },
    ]);
    expect(toggleTodoAt(todos, 1)).toEqual([
      { content: "read the brief", status: "completed" },
      { content: "write the code", status: "completed" },
      { content: "ship it", status: "pending" },
    ]);
    expect(toggleTodoAt(todos, 2)).toEqual([
      { content: "read the brief", status: "completed" },
      { content: "write the code", status: "in_progress" },
      { content: "ship it", status: "completed" },
    ]);
    // the input list is never mutated (the optimistic override is a new array)
    expect(todos[1]?.status).toBe("in_progress");
    // out-of-range indices are a no-op (the SAME array back), never a crash
    expect(toggleTodoAt(todos, -1)).toBe(todos);
    expect(toggleTodoAt(todos, 3)).toBe(todos);
    const empty: TodoItemView[] = [];
    expect(toggleTodoAt(empty, 0)).toBe(empty);
  });

  it("an EMPTY todo.update (the R88 clear) REMOVES the card", () => {
    const items = foldSessionEvents([
      event(1, "todo.update", { todos: [{ content: "a", status: "pending" }] }),
      event(2, "todo.update", { todos: [] }),
    ]);
    expect(items.filter((item) => item.kind === "todo")).toHaveLength(0);
  });

  it("folds agent-question.requested → pending card, resolved patches it IN PLACE", () => {
    const items = foldSessionEvents([
      event(1, "agent-question.requested", {
        questionId: "q_1",
        questions: [
          { question: "Which DB?", options: ["sqlite", "postgres"], allowCustom: false },
          { question: "Migrations?", options: [], allowCustom: true, placeholder: "your plan" },
        ],
      }),
      event(2, "agent-question.resolved", {
        questionId: "q_1",
        resolution: "answered",
        answers: ["sqlite", "hand-written"],
        sources: ["option", "custom"],
      }),
    ]);
    const questions = items.filter((item) => item.kind === "question");
    expect(questions).toHaveLength(1); // ONE card — the resolution patches, never stacks
    const card = questions[0];
    expect(card?.kind === "question" && card.resolution).toBe("answered");
    expect(card?.kind === "question" && card.answers).toEqual(["sqlite", "hand-written"]);
    expect(card?.kind === "question" && card.sources).toEqual(["option", "custom"]);
    expect(card?.kind === "question" && card.questions).toHaveLength(2);
    expect(card?.kind === "question" && card.questions[0]?.allowCustom).toBe(false);
    expect(card?.kind === "question" && card.questions[1]?.placeholder).toBe("your plan");
  });

  it("timeout/cancelled resolutions render honestly; orphans never crash the fold", () => {
    const timeout = foldSessionEvents([
      event(1, "agent-question.requested", { questionId: "q_9", questions: [{ question: "still there?" }] }),
      event(2, "agent-question.resolved", { questionId: "q_9", resolution: "timeout" }),
    ]);
    expect(timeout[0]?.kind === "question" && timeout[0].resolution).toBe("timeout");
    const orphan = foldSessionEvents([
      event(1, "agent-question.resolved", { questionId: "q_ghost", resolution: "cancelled", answers: [] }),
    ]);
    expect(orphan).toHaveLength(1); // the honest note card (questions empty)
    expect(orphan[0]?.kind === "question" && orphan[0].resolution).toBe("cancelled");
  });

  it("folds message.user attachments into chips (malformed rows dropped)", () => {
    const items = foldSessionEvents([
      event(1, "message.user", {
        content: "look at this",
        attachments: [
          { name: "photo.png", path: "attachments/photo.png", size: 2048 },
          { name: "notes.txt", size: 10 },
          { path: "no-name.txt" },
          "junk",
        ],
      }),
    ]);
    const user = items[0];
    expect(user?.kind === "user" && user.attachments).toEqual([
      { name: "photo.png", path: "attachments/photo.png", size: 2048 },
      { name: "notes.txt", size: 10 },
    ]);
    const bare = foldSessionEvents([event(2, "message.user", { content: "no files" })]);
    expect(bare[0]?.kind === "user" && bare[0].attachments).toBeNull();
  });
});

// ── the live stream ─────────────────────────────────────────────────────────

describe("sessions — the live turn state machine", () => {
  it("parses frames honestly: valid objects, and null for junk", () => {
    expect(parseStreamFrame('{"type":"text-delta","delta":"hi"}')).toEqual({
      type: "text-delta",
      delta: "hi",
    });
    expect(parseStreamFrame("not json")).toBeNull();
    expect(parseStreamFrame('"a string"')).toBeNull();
    expect(parseStreamFrame('{"delta":"no type"}')).toBeNull();
  });

  it("knows the three terminal frame types", () => {
    expect(isTerminalFrameType("done")).toBe(true);
    expect(isTerminalFrameType("stopped")).toBe(true);
    expect(isTerminalFrameType("error")).toBe(true);
    expect(isTerminalFrameType("text-delta")).toBe(false);
  });

  it("begins with the optimistic user card and the streaming phase", () => {
    const turn = beginLiveTurn([], "go", NOW);
    expect(turn.phase).toBe("streaming");
    expect(turn.items).toHaveLength(1);
    expect(turn.items[0]?.kind === "user" && turn.items[0].content).toBe("go");
    // R116-m — the ladder's first rung: the optimistic card sends.
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("sending");
    expect(turn.terminal).toBeNull();
  });

  it("streams text deltas into one live assistant with per-delta chunks", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "text-delta", delta: "Hel" }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "text-delta", delta: "lo" }, NOW + 2);
    expect(turn.items).toHaveLength(2); // user + one assistant
    const assistant = turn.items[1];
    expect(assistant?.kind === "assistant" && assistant.content).toBe("Hello");
    expect(assistant?.kind === "assistant" && assistant.chunks).toEqual(["Hel", "lo"]);
    expect(assistant?.kind === "assistant" && assistant.live).toBe(true);
  });

  it("streams thinking deltas into the same live item's thinking block", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "thinking-delta", delta: "hmm " }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "thinking-delta", delta: "ok" }, NOW + 2);
    const assistant = turn.items[1];
    expect(assistant?.kind === "assistant" && assistant.thinking).toBe("hmm ok");
  });

  it("runs tools live: call → running card, result → ok, output tail rides along", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "text-delta", delta: "running tests" }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "tool-call", toolName: "run_command", argsSummary: "pnpm test" }, NOW + 2);
    turn = applyLiveFrame(turn, { type: "tool-output", toolName: "run_command", chunk: "pass 1\n" }, NOW + 3);
    turn = applyLiveFrame(
      turn,
      { type: "tool-result", toolName: "run_command", argsSummary: "pnpm test", ok: true, outputSummary: "3 passed" },
      NOW + 4,
    );
    const tool = turn.items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" && tool.ok).toBe(true);
    expect(tool?.kind === "tool" && tool.outputTail).toBe("pass 1\n");
    expect(tool?.kind === "tool" && tool.outputSummary).toBe("3 passed");
    // the assistant segment was flushed (text → tool work → more text)
    const assistant = turn.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.live).toBe(false);
  });

  it("renders a FAILED tool honestly", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "tool-call", toolName: "run_command", argsSummary: "make" }, NOW + 1);
    turn = applyLiveFrame(
      turn,
      { type: "tool-result", toolName: "run_command", argsSummary: "make", ok: false },
      NOW + 2,
    );
    const tool = turn.items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" && tool.ok).toBe(false);
  });

  it("queue chips: user.queued lands, queued.delivered flips it to a delivered bubble", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "user.queued", seq: 7, content: "next?", ts: "t" }, NOW + 1);
    const queued = turn.items.find((item) => item.kind === "user" && item.key === "q7");
    expect(queued?.kind === "user" && queued.queued).toBe(true);
    // R116-m — the queue chip's clock glyph: the message waits (sending).
    expect(queued?.kind === "user" && queued.status).toBe("sending");
    turn = applyLiveFrame(turn, { type: "queued.delivered", seq: 7, content: "next?", ts: "t" }, NOW + 2);
    const delivered = turn.items.find((item) => item.kind === "user" && item.key === "q7");
    expect(delivered?.kind === "user" && delivered.queued).toBe(false);
    // R116-m — the delivery rung: the frame flips the chip to delivered (the
    // same rung the settled fold reads — the rehydrate never jumps).
    expect(delivered?.kind === "user" && delivered.status).toBe("delivered");
  });

  it("approval frames pair live: requested → resolved updates the same card", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "approval.requested", approvalId: "appr_9", toolName: "run_command", argsSummary: "deploy", category: "confirm" },
      NOW + 1,
    );
    turn = applyLiveFrame(turn, { type: "approval.resolved", approvalId: "appr_9", decision: "approved" }, NOW + 2);
    const approvals = turn.items.filter((item) => item.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.kind === "approval" && approvals[0].decision).toBe("approved");
  });

  // ── R113-c: the rich live frames — sub-agent cards, screenshots, todos ──

  it("subagent-status upserts ONE card per child through every transition", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "subagent-status", sessionId: "child_1", parentSessionId: "sess_1", status: "queued", task: "research the relay", role: "researcher" },
      NOW + 1,
    );
    turn = applyLiveFrame(
      turn,
      { type: "subagent-status", sessionId: "child_1", parentSessionId: "sess_1", status: "running", task: "research the relay", role: "researcher", code: "A1B2", model: "z-ai/glm-5.2:free", taskId: "task_7" },
      NOW + 2,
    );
    turn = applyLiveFrame(
      turn,
      { type: "subagent-status", sessionId: "child_1", parentSessionId: "sess_1", status: "failed", task: "research the relay", role: "researcher", code: "A1B2", detail: "stalled: no activity for 5m" },
      NOW + 3,
    );
    const cards = turn.items.filter((item) => item.kind === "subagent");
    expect(cards).toHaveLength(1); // ONE card, upserted by child sessionId
    const card = cards[0];
    expect(card?.kind === "subagent" && card.key).toBe("sub-child_1");
    expect(card?.kind === "subagent" && card.childSessionId).toBe("child_1");
    expect(card?.kind === "subagent" && card.status).toBe("failed");
    expect(card?.kind === "subagent" && card.role).toBe("researcher");
    expect(card?.kind === "subagent" && card.task).toBe("research the relay");
    expect(card?.kind === "subagent" && card.code).toBe("A1B2");
    expect(card?.kind === "subagent" && card.detail).toBe("stalled: no activity for 5m");
    // the latest frame wins wholesale (the upsert REPLACES the card — a frame
    // that omits model/taskId clears them; the runtime attaches model to
    // every frame a delegation emits, so this is the replace-only semantics)
    expect(card?.kind === "subagent" && card.model).toBeNull();
    expect(card?.kind === "subagent" && card.taskId).toBeNull();
    // the intermediate running frame DID carry them
    turn = applyLiveFrame(
      turn,
      { type: "subagent-status", sessionId: "child_1", parentSessionId: "sess_1", status: "running", task: "research the relay", role: "researcher", model: "z-ai/glm-5.2:free", taskId: "task_7" },
      NOW + 5,
    );
    const running = turn.items.find((item) => item.kind === "subagent");
    expect(running?.kind === "subagent" && running.model).toBe("z-ai/glm-5.2:free");
    expect(running?.kind === "subagent" && running.taskId).toBe("task_7");
    // a second child stacks its OWN card
    turn = applyLiveFrame(
      turn,
      { type: "subagent-status", sessionId: "child_2", parentSessionId: "sess_1", status: "running", task: "write tests", role: "coder" },
      NOW + 6,
    );
    expect(turn.items.filter((item) => item.kind === "subagent")).toHaveLength(2);
  });

  it("screenshot frames land image tiles keyed by frameId (empty ids drop)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "screenshot", frameId: "bs_1", tool: "browser_control" }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "screenshot", frameId: "", tool: "computer_use" }, NOW + 2);
    const images = turn.items.filter((item) => item.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.kind === "image" && images[0].key).toBe("img-bs_1");
    expect(images[0]?.kind === "image" && images[0].frameId).toBe("bs_1");
    expect(images[0]?.kind === "image" && images[0].tool).toBe("browser_control");
  });

  it("live agent-question frames: the ask lands pending, resolved patches the card", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "agent-question", sessionId: "sess_1", questionId: "q_5", questions: [{ question: "Deploy now?", options: ["yes", "no"] }] },
      NOW + 1,
    );
    let cards = turn.items.filter((item) => item.kind === "question");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind === "question" && cards[0].resolution).toBe("pending");
    expect(cards[0]?.kind === "question" && cards[0].questions[0]?.options).toEqual(["yes", "no"]);
    turn = applyLiveFrame(
      turn,
      { type: "agent-question.resolved", sessionId: "sess_1", questionId: "q_5", resolution: "answered", answers: ["yes"], sources: ["option"] },
      NOW + 2,
    );
    cards = turn.items.filter((item) => item.kind === "question");
    expect(cards).toHaveLength(1); // patched in place, never a second card
    expect(cards[0]?.kind === "question" && cards[0].resolution).toBe("answered");
    expect(cards[0]?.kind === "question" && cards[0].answers).toEqual(["yes"]);
  });

  it("live todo-updated frames upsert the ONE card (stable key, latest snapshot)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "todo-updated", sessionId: "sess_1", todos: [{ content: "a", status: "pending" }] }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "todo-updated", sessionId: "sess_1", todos: [{ content: "a", status: "completed" }] }, NOW + 2);
    const cards = turn.items.filter((item) => item.kind === "todo");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind === "todo" && cards[0].todos).toEqual([{ content: "a", status: "completed" }]);
    expect(cards[0]?.kind === "todo" && cards[0].key).toBe("todos");
  });

  it("the optimistic user card carries the send's attachment chips (R113-c)", () => {
    const turn = beginLiveTurn([], "here is the screenshot", NOW, [
      { name: "photo.png", path: "attachments/photo.png", size: 2048 },
    ]);
    const user = turn.items[0];
    expect(user?.kind === "user" && user.attachments).toEqual([
      { name: "photo.png", path: "attachments/photo.png", size: 2048 },
    ]);
    const bare = beginLiveTurn([], "plain", NOW);
    expect(bare.items[0]?.kind === "user" && bare.items[0].attachments).toBeNull();
  });

  it("renders the dim meta lines: continuation, retry, finish tokens", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "meta.continuation", iteration: 2 }, NOW + 1);
    turn = applyLiveFrame(
      turn,
      { type: "meta.retry", attempt: 2, totalAttempts: 6, remainingMs: 4000, errorClass: "rate_limit", message: "rate limited" },
      NOW + 2,
    );
    turn = applyLiveFrame(turn, { type: "finish", usage: { inputTokens: 10, outputTokens: 5 } }, NOW + 4);
    const texts = turn.items.filter((item) => item.kind === "meta").map((item) => (item.kind === "meta" ? item.text : ""));
    expect(texts).toContain("round 2");
    expect(texts.some((text) => text.includes("attempt 2/6"))).toBe(true);
    expect(texts.some((text) => text.includes("10 in · 5 out"))).toBe(true);
  });

  it("closes the turn on each terminal shape and carries the error's own words", () => {
    const done = applyLiveFrame(beginLiveTurn([], "go", NOW), { type: "done" }, NOW + 1);
    expect(done.terminal).toBe("done");
    expect(done.phase).toBe("idle");
    const stopped = applyLiveFrame(beginLiveTurn([], "go", NOW), { type: "stopped" }, NOW + 1);
    expect(stopped.terminal).toBe("stopped");
    const errored = applyLiveFrame(
      beginLiveTurn([], "go", NOW),
      { type: "error", status: 502, code: "PROVIDER_ERROR", message: "the key was rejected" },
      NOW + 1,
    );
    expect(errored.terminal).toBe("error");
    expect(errored.error?.code).toBe("PROVIDER_ERROR");
    expect(errored.error?.message).toBe("the key was rejected");
    const last = errored.items[errored.items.length - 1];
    expect(last?.kind === "error" && last.message).toBe("the key was rejected");
    // R116-m — the failed rung: the turn's in-flight user card marks failed.
    const user = errored.items.find((item) => item.kind === "user");
    expect(user?.kind === "user" && user.status).toBe("failed");
  });

  it("tolerates unknown frames: message-carrying ones dim, the rest drop", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "browser-viewport", message: "viewport changed" }, NOW + 1);
    const withMessage = turn.items.filter((item) => item.kind === "meta");
    expect(withMessage).toHaveLength(1);
    turn = applyLiveFrame(turn, { type: "computer-use", kind: "observation" }, NOW + 2);
    expect(turn.items.filter((item) => item.kind === "meta")).toHaveLength(1);
  });

  it("abandons honestly when the stream drops (the turn survives, R42)", () => {
    const streaming = beginLiveTurn([], "go", NOW);
    const abandoned = abandonLiveTurn(streaming);
    expect(abandoned.phase).toBe("idle");
    expect(abandoned.terminal).toBeNull();
  });
});

// ── the client ──────────────────────────────────────────────────────────────

describe("sessions — the typed client", () => {
  it("lists sessions and details through /api/v1", async () => {
    const session = makeSession();
    const { sender, calls } = makeApiSender((path) => ({
      status: 200,
      bodyText: JSON.stringify(
        path === "/api/v1/sessions?limit=50"
          ? { sessions: [session], total: 1 }
          : { ...session, events: [], lastSeq: 0 },
      ),
    }));
    const list = await fetchSessions(sender);
    expect(list.ok && list.data.sessions).toHaveLength(1);
    const detail = await fetchSessionDetail(sender, session.id);
    expect(detail.ok && detail.data.lastSeq).toBe(0);
    expect(calls[1]?.path).toBe(`/api/v1/sessions/${session.id}`);
  });

  it("posts stop and queue with the exact bodies", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ ok: true, stopped: true, seq: 3 }),
    }));
    const stop = await postStop(sender, "sess_1");
    expect(stop.ok && stop.data.ok).toBe(true);
    const queue = await postQueue(sender, "sess_1", "hello");
    expect(queue.ok && queue.data.seq).toBe(3);
    expect(queueBody("hello")).toBe('{"content":"hello"}');
    expect(calls[1]?.path).toBe("/api/v1/sessions/sess_1/queue");
    expect(calls[1]?.init.bodyText).toBe('{"content":"hello"}');
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("carries the queue's honest 409 NO_LIVE_TURN as an error outcome", async () => {
    const { sender } = makeApiSender(() => ({
      status: 409,
      bodyText:
        '{"error":{"code":"NO_LIVE_TURN","message":"no live turn for this session — send the message normally"}}',
    }));
    const outcome = await postQueue(sender, "sess_1", "hello");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("NO_LIVE_TURN");
  });

  it("opens the turn stream with POST + the composer's message", () => {
    const { sender, opens } = makeSseSender();
    const stream = openTurnStream(sender, "sess_1", "hello");
    expect((stream as FakeStream).closed).toBe(false);
    expect(opens[0]?.url).toBe("/api/v1/sessions/sess_1/messages/stream");
    expect(opens[0]?.method).toBe("POST");
    expect(opens[0]?.bodyText).toBe('{"content":"hello"}');
  });

  // ── R113-c: the per-send override bodies (the desktop composer's wire) ──

  it("assembles the send body: overrides ride ONLY when set (desktop parity)", () => {
    expect(sendBody("hello")).toBe('{"content":"hello"}');
    expect(sendBody("hello", {})).toBe('{"content":"hello"}');
    expect(sendBody("hello", { thinkingLevel: "default" })).toBe('{"content":"hello"}');
    expect(sendBody("hello", { attachments: [] })).toBe('{"content":"hello"}');
    expect(sendBody("hello", { model: "", providerId: "" })).toBe('{"content":"hello"}');
    const full = sendBody("hello", {
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
      thinkingLevel: "high",
      attachments: [{ name: "photo.png", path: "attachments/photo.png", size: 2048 }],
    });
    expect(JSON.parse(full)).toEqual({
      content: "hello",
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
      thinkingLevel: "high",
      attachments: [{ name: "photo.png", path: "attachments/photo.png", size: 2048 }],
    });
    // the xhigh rung is real vocabulary (R96-F) and rides verbatim
    expect(JSON.parse(sendBody("hi", { thinkingLevel: "xhigh" }))).toEqual({
      content: "hi",
      thinkingLevel: "xhigh",
    });
  });

  it("the queue body drops thinkingLevel but keeps the model pair + attachments (the route's own honesty)", () => {
    expect(queueBody("hello", { thinkingLevel: "high" })).toBe('{"content":"hello"}');
    const queued = queueBody("hello", {
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
      thinkingLevel: "high",
      attachments: [{ name: "a.txt" }],
    });
    expect(JSON.parse(queued)).toEqual({
      content: "hello",
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
      attachments: [{ name: "a.txt" }],
    });
  });

  it("opens the turn stream carrying the composer's overrides", () => {
    const { sender, opens } = makeSseSender();
    openTurnStream(sender, "sess_1", "hello", {
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
      thinkingLevel: "max",
      attachments: [{ name: "photo.png", path: "attachments/photo.png" }],
    });
    expect(JSON.parse(opens[0]?.bodyText ?? "")).toEqual({
      content: "hello",
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
      thinkingLevel: "max",
      attachments: [{ name: "photo.png", path: "attachments/photo.png" }],
    });
  });

  it("resolves ask_user questions through POST /agent-questions/:id/resolve", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ ok: true }),
    }));
    const outcome = await postResolveQuestion(sender, "q_1", ["yes"], ["option"]);
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.path).toBe("/api/v1/agent-questions/q_1/resolve");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.bodyText ?? "")).toEqual({ answers: ["yes"], sources: ["option"] });
    // sources are optional on the wire
    const bare = await postResolveQuestion(sender, "q_2", ["no"]);
    expect(bare.ok).toBe(true);
    expect(JSON.parse(calls[1]?.init.bodyText ?? "")).toEqual({ answers: ["no"] });
  });

  it("R120-P: posts the owner's whole todo list through POST /sessions/:id/todo (the R88 write route)", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 200,
      bodyText: JSON.stringify({
        ok: true,
        todos: [
          { content: "read the brief", status: "completed" },
          { content: "ship it", status: "pending" },
        ],
      }),
    }));
    const outcome = await postSessionTodo(sender, "sess 1", [
      { content: "read the brief", status: "completed" },
      { content: "ship it", status: "pending" },
    ]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.ok).toBe(true);
      expect(outcome.data.todos).toHaveLength(2);
    }
    expect(calls[0]?.path).toBe("/api/v1/sessions/sess%201/todo");
    expect(calls[0]?.init.method).toBe("POST");
    // the WHOLE list rides the body — the route's contract ({todos}, no
    // source field: the server writes source:"user" itself)
    expect(JSON.parse(calls[0]?.init.bodyText ?? "")).toEqual({
      todos: [
        { content: "read the brief", status: "completed" },
        { content: "ship it", status: "pending" },
      ],
    });
  });

  it("PATCHes the per-session operating mode + task mode (desktop parity)", async () => {
    const { sender, calls } = makeApiSender((path) => ({
      status: 200,
      bodyText: JSON.stringify(path.includes("permissions") ? { ...makeSession(), events: [], lastSeq: 0 } : makeSession({ activeMode: "deep-research" })),
    }));
    const permissions = await patchSessionPermissions(sender, "sess_1", "plan");
    expect(permissions.ok).toBe(true);
    expect(calls[0]?.path).toBe("/api/v1/sessions/sess_1/permissions");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.bodyText).toBe('{"mode":"plan"}');
    const active = await patchSessionActiveMode(sender, "sess_1", "deep-research");
    expect(active.ok && active.data.activeMode).toBe("deep-research");
    expect(calls[1]?.path).toBe("/api/v1/sessions/sess_1");
    expect(calls[1]?.init.bodyText).toBe('{"activeMode":"deep-research"}');
    const cleared = await patchSessionActiveMode(sender, "sess_1", null);
    expect(cleared.ok).toBe(true);
    expect(calls[2]?.init.bodyText).toBe('{"activeMode":null}');
  });
});

// ── the REMOTE mirror (R113-e — the events stream's turn frames) ────────────

describe("sessions — the remote mirror", () => {
  /** The persisted base: two folded rows (the PC's earlier conversation). */
  const base = foldSessionEvents([
    event(1, "message.user", { role: "user", content: "earlier ask" }),
    event(2, "message.assistant", { role: "assistant", content: "earlier answer", model: "z-ai/glm-5.2:free" }),
  ]);

  const remoteInput = (overrides: Partial<Parameters<typeof reduceRemoteTurnFrame>[0]> = {}) => ({
    live: null,
    remote: false,
    ownStream: false,
    baseItems: base,
    frame: { type: "text-delta", delta: "PC says" } as Record<string, unknown>,
    now: NOW,
    ...overrides,
  });

  it("begins with NO optimistic user card — the remote turn's message was typed on the other device", () => {
    const mirror = beginRemoteTurn(base);
    expect(mirror.phase).toBe("streaming");
    expect(mirror.terminal).toBeNull();
    expect(mirror.items).toEqual(base); // the base only — no live user card
    expect(mirror.sentContent).toBe("");
  });

  it("a remote frame with no overlay OPENS a mirror over the base and applies through the SAME reducer", () => {
    const result = reduceRemoteTurnFrame(remoteInput());
    expect(result).not.toBeNull();
    expect(result?.began).toBe(true);
    expect(result?.terminal).toBe(false);
    expect(result?.turn.items).toHaveLength(base.length + 1); // base + the live assistant
    const assistant = result?.turn.items[base.length];
    expect(assistant?.kind === "assistant" && assistant.content).toBe("PC says");
    expect(assistant?.kind === "assistant" && assistant.live).toBe(true);
  });

  it("the initiator's own frames are IGNORED while its stream is in flight (a mirror would double every delta)", () => {
    const own = beginLiveTurn(base, "my message", NOW);
    const result = reduceRemoteTurnFrame(remoteInput({ live: own, remote: false, ownStream: true }));
    expect(result).toBeNull();
  });

  it("an own overlay still streaming (stream dropped mid-flight) is ALSO authoritative — not replaced", () => {
    const own = beginLiveTurn(base, "my message", NOW); // phase streaming, terminal null
    const result = reduceRemoteTurnFrame(remoteInput({ live: own, remote: false, ownStream: false }));
    expect(result).toBeNull();
  });

  it("an ABANDONED own overlay is replaced by the mirror — the events stream carries the turn's remainder", () => {
    const abandoned = abandonLiveTurn(beginLiveTurn(base, "my message", NOW)); // phase idle, terminal null
    const result = reduceRemoteTurnFrame(remoteInput({ live: abandoned, remote: false, ownStream: false }));
    expect(result).not.toBeNull();
    expect(result?.began).toBe(true);
    // the fresh mirror opens over the BASE — the abandoned optimistic card is
    // gone (the next item after the base is the LIVE assistant, not a user card)
    expect(result?.turn.items).toHaveLength(base.length + 1);
    const tail = result?.turn.items[base.length];
    expect(tail?.kind === "assistant" && tail.live).toBe(true);
  });

  it("an ongoing remote mirror APPENDS (began=false): deltas merge into the same live assistant", () => {
    const first = reduceRemoteTurnFrame(remoteInput());
    expect(first?.began).toBe(true);
    const second = reduceRemoteTurnFrame(
      remoteInput({
        live: first?.turn ?? null,
        remote: true,
        frame: { type: "text-delta", delta: " more" },
      }),
    );
    expect(second?.began).toBe(false);
    expect(second?.turn.items).toHaveLength(base.length + 1);
    const assistant = second?.turn.items[base.length];
    expect(assistant?.kind === "assistant" && assistant.content).toBe("PC says more");
  });

  it("the terminal frame marks the mirror done — the screen rehydrates and the truth wins", () => {
    const opened = reduceRemoteTurnFrame(remoteInput());
    const terminal = reduceRemoteTurnFrame(
      remoteInput({ live: opened?.turn ?? null, remote: true, frame: { type: "done" } }),
    );
    expect(terminal?.terminal).toBe(true);
    expect(terminal?.turn.terminal).toBe("done");
    expect(terminal?.turn.phase).toBe("idle");
  });

  it("a frame AFTER the terminal opens a FRESH mirror over the current base — two turns never share one overlay", () => {
    const opened = reduceRemoteTurnFrame(remoteInput());
    const terminal = reduceRemoteTurnFrame(
      remoteInput({ live: opened?.turn ?? null, remote: true, frame: { type: "done" } }),
    );
    // The fresh base now includes the finished turn's persisted rows.
    const grownBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "earlier ask" }),
      event(2, "message.assistant", { role: "assistant", content: "earlier answer", model: "z-ai/glm-5.2:free" }),
      event(3, "message.user", { role: "user", content: "the PC's next ask" }),
    ]);
    const next = reduceRemoteTurnFrame(
      remoteInput({
        live: terminal?.turn ?? null,
        remote: true,
        baseItems: grownBase,
        frame: { type: "text-delta", delta: "turn two" },
      }),
    );
    expect(next?.began).toBe(true);
    expect(next?.turn.items).toHaveLength(grownBase.length + 1);
    expect(next?.turn.terminal).toBeNull(); // the new turn streams
  });

  it("rebaseRemoteTurn folds the fresh truth UNDER the streamed tail (the persisted user card lands under it)", () => {
    const opened = reduceRemoteTurnFrame(remoteInput());
    const mirror = opened?.turn as LiveTurn;
    // The rehydrate landed while the remote turn kept streaming: the base
    // grew by the persisted user card that STARTED the remote turn.
    const grownBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "earlier ask" }),
      event(2, "message.assistant", { role: "assistant", content: "earlier answer", model: "z-ai/glm-5.2:free" }),
      event(3, "message.user", { role: "user", content: "the PC's ask that started this turn" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, grownBase, base.length);
    // base + the one live assistant, with the new persisted row UNDER the tail
    expect(rebased.items).toHaveLength(grownBase.length + 1);
    const persistedUser = rebased.items[grownBase.length - 1];
    expect(persistedUser?.kind === "user" && persistedUser.content).toBe("the PC's ask that started this turn");
    const liveTail = rebased.items[grownBase.length];
    expect(liveTail?.kind === "assistant" && liveTail.content).toBe("PC says");
    expect(rebased.terminal).toBeNull(); // the mirror keeps streaming
  });

  it("rebaseRemoteTurn survives a shorter fresh base (a log trim keeps the live tail, no crash, no dupes)", () => {
    const opened = reduceRemoteTurnFrame(remoteInput());
    const mirror = opened?.turn as LiveTurn;
    const trimmed = foldSessionEvents([event(1, "message.user", { role: "user", content: "earlier ask" })]);
    const rebased = rebaseRemoteTurn(mirror, trimmed, base.length);
    // The trimmed truth + the live tail — the old base rows the mirror carried
    // are dropped wholesale (slice past the recorded split point).
    expect(rebased.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    const tail = rebased.items[rebased.items.length - 1];
    expect(tail?.kind === "assistant" && tail.content).toBe("PC says");
  });

  it("sessionStatusFromWire accepts exactly the closed union, honestly", () => {
    expect(sessionStatusFromWire("queued")).toBe("queued");
    expect(sessionStatusFromWire("running")).toBe("running");
    expect(sessionStatusFromWire("completed")).toBe("completed");
    expect(sessionStatusFromWire("failed")).toBe("failed");
    expect(sessionStatusFromWire("cancelled")).toBe("cancelled");
    expect(sessionStatusFromWire("Running")).toBeNull();
    expect(sessionStatusFromWire(undefined)).toBeNull();
    expect(sessionStatusFromWire(7)).toBeNull();
    expect(sessionStatusFromWire(null)).toBeNull();
  });

  it("countProjectSessions folds totals + running per project (null-project rows are nobody's)", () => {
    const rows = [
      makeSession({ id: "a", projectId: "proj_1", status: "running" }),
      makeSession({ id: "b", projectId: "proj_1", status: "completed" }),
      makeSession({ id: "c", projectId: "proj_2", status: "completed" }),
      makeSession({ id: "d", projectId: null, status: "running" }),
    ];
    expect(countProjectSessions(rows)).toEqual({
      proj_1: { total: 2, running: 1 },
      proj_2: { total: 1, running: 0 },
    });
    expect(countProjectSessions([])).toEqual({});
  });

  it("R114-c: groupProjectSessions groups for the accordion, order preserved (most-recent-first off the route)", () => {
    const rows = [
      makeSession({ id: "newest_1", projectId: "proj_1" }),
      makeSession({ id: "newest_2", projectId: "proj_2" }),
      makeSession({ id: "older_1", projectId: "proj_1" }),
      makeSession({ id: "no_project", projectId: null }),
      makeSession({ id: "older_2", projectId: "proj_1" }),
    ];
    const groups = groupProjectSessions(rows);
    expect(Object.keys(groups).sort()).toEqual(["proj_1", "proj_2"]);
    expect(groups.proj_1?.map((s) => s.id)).toEqual(["newest_1", "older_1", "older_2"]);
    expect(groups.proj_2?.map((s) => s.id)).toEqual(["newest_2"]);
    // null-project rows are nobody's (the accordion renders project rows only)
    expect(Object.values(groups).flat()).toHaveLength(4);
    expect(groupProjectSessions([])).toEqual({});
  });
});


// ── R114-d: turn.started — the instant live-turn open ───────────────────────

describe("sessions — turn.started (R114-d)", () => {
  it("the OWN stream: the frame sets the turn's resolved model; the optimistic card never doubles", () => {
    let turn = beginLiveTurn([], "go", NOW);
    expect(turn.model).toBeNull();
    turn = applyLiveFrame(
      turn,
      { type: "turn.started", text: "go", model: "z-ai/glm-5.2:free", providerId: "openrouter" },
      NOW + 1,
    );
    expect(turn.model).toBe("z-ai/glm-5.2:free");
    // ONE user card — the optimistic one beginLiveTurn pushed (the frame
    // recognized it and did not stack a second bubble).
    const users = turn.items.filter((item) => item.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.kind === "user" && users[0].content).toBe("go");
    // R116-m — the ack rung: the PC's first frame flips the optimistic card
    // from "sending" to "sent" (the single check).
    expect(users[0]?.kind === "user" && users[0].status).toBe("sent");
  });

  it("the OWN stream: assistant cards created AFTER the frame carry the model (the live mono line)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "turn.started", text: "go", model: "glm-4.7", providerId: "z-ai" },
      NOW + 1,
    );
    turn = applyLiveFrame(turn, { type: "text-delta", delta: "hi" }, NOW + 2);
    const assistant = turn.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.model).toBe("glm-4.7");
    expect(assistant?.kind === "assistant" && assistant.live).toBe(true);
  });

  it("the REMOTE mirror: turn.started opens the overlay and renders the user bubble off the frame's own text", () => {
    const base = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "earlier ask" }),
    ]);
    const result = reduceRemoteTurnFrame({
      live: null,
      remote: false,
      ownStream: false,
      baseItems: base,
      frame: { type: "turn.started", text: "the PC's new ask", model: "glm-4.7", providerId: "z-ai" },
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.began).toBe(true);
    expect(result?.turn.model).toBe("glm-4.7");
    // The bubble is THERE — no waiting for the persisted-fold refetch.
    const users = result?.turn.items.filter((item) => item.kind === "user");
    expect(users).toHaveLength(2); // the base's earlier ask + the mirrored card
    expect(users?.[1]?.kind === "user" && users[1].content).toBe("the PC's new ask");
    // R116-m — the mirrored card is BORN from the ack frame itself: it
    // enters at the "sent" rung (accepted, processing).
    expect(users?.[1]?.kind === "user" && users[1].status).toBe("sent");
    // The placeholder math sees only the user card — the placeholder is due.
    expect(thinkingPlaceholderVisible(result?.turn as LiveTurn)).toBe(true);
  });

  it("the mirror's turn.started card is DROPPED when the persisted row lands (rebaseRemoteTurn never doubles)", () => {
    const base = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "earlier ask" }),
    ]);
    const opened = reduceRemoteTurnFrame({
      live: null,
      remote: false,
      ownStream: false,
      baseItems: base,
      frame: { type: "turn.started", text: "the PC's ask", model: "glm-4.7", providerId: "z-ai" },
      now: NOW,
    });
    const mirror = opened?.turn as LiveTurn;
    // The rehydrate: the fresh base carries the PERSISTED user card that
    // started the turn.
    const grownBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "earlier ask" }),
      event(2, "message.user", { role: "user", content: "the PC's ask" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, grownBase, base.length);
    const users = rebased.items.filter((item) => item.kind === "user");
    expect(users).toHaveLength(2); // persisted earlier ask + persisted THIS ask
    expect(users[1]?.kind === "user" && users[1].key).toBe("e2"); // the persisted card owns the slot
  });

  it("a malformed turn.started never crashes and never pushes an empty bubble", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "turn.started" }, NOW + 1);
    expect(turn.model).toBeNull();
    expect(turn.items.filter((item) => item.kind === "user")).toHaveLength(1);
  });
});

// ── R114-d: the thinking placeholder's verdict ──────────────────────────────

describe("sessions — thinkingPlaceholderVisible (R114-d)", () => {
  it("visible while the turn streams with only the user card at the tail", () => {
    const own = beginLiveTurn([], "go", NOW);
    expect(thinkingPlaceholderVisible(own)).toBe(true);
    // The remote mirror needs its user card first (turn.started pushes it).
    const mirror = applyLiveFrame(
      beginRemoteTurn([]),
      { type: "turn.started", text: "hi", model: "m", providerId: "p" },
      NOW,
    );
    expect(thinkingPlaceholderVisible(mirror)).toBe(true);
    // A mirror with NO user card anywhere (a pre-turn.started frame) — no
    // anchor, no placeholder (never a guess).
    expect(thinkingPlaceholderVisible(beginRemoteTurn([]))).toBe(false);
  });

  it("retired by the first real content (text, thinking, or tool work) and by every terminal state", () => {
    const text = applyLiveFrame(beginLiveTurn([], "go", NOW), { type: "text-delta", delta: "x" }, NOW + 1);
    expect(thinkingPlaceholderVisible(text)).toBe(false);
    const think = applyLiveFrame(beginLiveTurn([], "go", NOW), { type: "thinking-delta", delta: "hmm" }, NOW + 1);
    expect(thinkingPlaceholderVisible(think)).toBe(false);
    const tooling = applyLiveFrame(
      beginLiveTurn([], "go", NOW),
      { type: "tool-input-start", toolCallId: "c1", toolName: "write_file" },
      NOW + 1,
    );
    expect(thinkingPlaceholderVisible(tooling)).toBe(false);
    const done = applyLiveFrame(beginLiveTurn([], "go", NOW), { type: "done" }, NOW + 1);
    expect(thinkingPlaceholderVisible(done)).toBe(false);
    expect(thinkingPlaceholderVisible(abandonLiveTurn(beginLiveTurn([], "go", NOW)))).toBe(false);
  });

  it("dim meta lines do NOT retire it (only real work does); a persisted tail card is not an anchor", () => {
    const meta = applyLiveFrame(beginLiveTurn([], "go", NOW), { type: "meta.retry", attempt: 1, totalAttempts: 3, remainingMs: 10, errorClass: "rate_limit", message: "waiting" }, NOW + 1);
    expect(thinkingPlaceholderVisible(meta)).toBe(true);
    // The base ends with a PERSISTED user card (the previous turn's) and the
    // mirror is fresh — no live-keyed anchor, no placeholder.
    const base = foldSessionEvents([event(1, "message.user", { content: "old ask" })]);
    expect(thinkingPlaceholderVisible(beginRemoteTurn(base))).toBe(false);
  });
});

// ── R114-d: the live tool-input streaming (the write preview's feed) ────────

describe("sessions — tool-input streaming (R114-d)", () => {
  it("tool-input-start opens a RUNNING card keyed by toolCallId (idempotent on replays)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "tool-input-start", toolCallId: "call_1", toolName: "write_file" }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "tool-input-start", toolCallId: "call_1", toolName: "write_file" }, NOW + 2);
    const tools = turn.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1); // ONE card, never a stack
    expect(tools[0]?.kind === "tool" && tools[0].toolCallId).toBe("call_1");
    expect(tools[0]?.kind === "tool" && tools[0].ok).toBeNull();
    expect(tools[0]?.kind === "tool" && tools[0].inputRaw).toBe("");
  });

  it("tool-input-delta accumulates the partial-JSON raw on the matching card", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "tool-input-start", toolCallId: "call_1", toolName: "write_file" }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "tool-input-delta", toolCallId: "call_1", inputTextDelta: '{"path":"src/a.ts","con' }, NOW + 2);
    turn = applyLiveFrame(turn, { type: "tool-input-delta", toolCallId: "call_1", inputTextDelta: 'tent":"hello' }, NOW + 3);
    const tool = turn.items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" && tool.inputRaw).toBe('{"path":"src/a.ts","content":"hello');
    // A delta for an id we never saw grows nothing (joined mid-call).
    turn = applyLiveFrame(turn, { type: "tool-input-delta", toolCallId: "ghost", inputTextDelta: "junk" }, NOW + 4);
    const after = turn.items.find((item) => item.kind === "tool");
    expect(after?.kind === "tool" && after.inputRaw).toBe('{"path":"src/a.ts","content":"hello');
  });

  it("tool-call FINALIZES the streaming card (args land, raw stays); tool-result settles + spends the raw", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "tool-input-start", toolCallId: "call_1", toolName: "write_file" }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "tool-input-delta", toolCallId: "call_1", inputTextDelta: '{"path":"a.ts","content":"x"}' }, NOW + 2);
    turn = applyLiveFrame(turn, { type: "tool-call", toolName: "write_file", argsSummary: "path: a.ts, content: 1 chars" }, NOW + 3);
    let tools = turn.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1); // finalized IN PLACE — never a second card
    expect(tools[0]?.kind === "tool" && tools[0].argsSummary).toBe("path: a.ts, content: 1 chars");
    expect(tools[0]?.kind === "tool" && tools[0].inputRaw).not.toBeNull(); // preview rides until the result
    turn = applyLiveFrame(
      turn,
      { type: "tool-result", toolName: "write_file", argsSummary: "path: a.ts, content: 1 chars", ok: true, outputSummary: "wrote a.ts — 1 char" },
      NOW + 4,
    );
    tools = turn.items.filter((item) => item.kind === "tool");
    expect(tools[0]?.kind === "tool" && tools[0].ok).toBe(true);
    expect(tools[0]?.kind === "tool" && tools[0].outputSummary).toBe("wrote a.ts — 1 char");
    expect(tools[0]?.kind === "tool" && tools[0].inputRaw).toBeNull(); // spent
    expect(tools[0]?.kind === "tool" && tools[0].toolCallId).toBeNull();
    expect(tools[0]?.kind === "tool" && tools[0].live).toBe(false);
  });

  it("a tool-call with NO streaming input opens its card the classic way (non-streaming providers)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "tool-call", toolName: "run_command", argsSummary: "command: pnpm test" }, NOW + 1);
    const tool = turn.items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" && tool.toolCallId).toBeNull();
    expect(tool?.kind === "tool" && tool.inputRaw).toBeNull();
    expect(tool?.kind === "tool" && tool.argsSummary).toBe("command: pnpm test");
  });

  it("appendToolInputRaw keeps the HEAD past the cap (the path rides the head of write args)", () => {
    expect(appendToolInputRaw(null, "abc")).toBe("abc");
    expect(appendToolInputRaw("abc", "def")).toBe("abcdef");
    const big = "x".repeat(256 * 1024);
    expect(appendToolInputRaw(big, "more")).toBe(big); // saturated — frozen
    const head = "x".repeat(256 * 1024 - 3);
    expect(appendToolInputRaw(head, "abcdef")).toBe(`${head}abc`); // sliced at the cap
  });
});

// ── R114-d: the screenshot frame's TRUE shape ───────────────────────────────

describe("sessions — the screenshot frame (R114-d)", () => {
  it("carries sessionId/frameId/tool/note; the caption payload is the note (never a ts)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "screenshot", sessionId: "sess_1", frameId: "bs_9", tool: "browser_control", note: "browser panel" },
      NOW + 1,
    );
    const image = turn.items.find((item) => item.kind === "image");
    expect(image?.kind === "image" && image.frameId).toBe("bs_9");
    expect(image?.kind === "image" && image.tool).toBe("browser_control");
    expect(image?.kind === "image" && image.note).toBe("browser panel");
    expect(image?.kind === "image" && image.key).toBe("img-bs_9");
  });

  it("a frame without a note still lands (the caption renders the tool alone); empty ids drop", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "screenshot", sessionId: "s", frameId: "cu_1", tool: "screenshot" }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "screenshot", sessionId: "s", frameId: "", tool: "zoom" }, NOW + 2);
    const images = turn.items.filter((item) => item.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.kind === "image" && images[0].note).toBe("");
  });
});

// ── R114-d: the meta frame's in-place patch + the selected-model client ─────

describe("sessions — the session meta patch (R114-d)", () => {
  it("present keys overwrite; absent keys leave the row untouched", () => {
    const row = makeSession({ selectedModel: { providerId: "openrouter", model: "z-ai/glm-5.2:free" } });
    const flipped = applySessionMetaPatch(row, { permissionMode: "full" });
    expect(flipped.permissionMode).toBe("full");
    expect(flipped.selectedModel).toEqual({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });
    expect(flipped.activeMode).toBeNull();
    const cleared = applySessionMetaPatch(flipped, { selectedModel: null });
    expect(cleared.selectedModel).toBeNull();
    expect(cleared.permissionMode).toBe("full"); // untouched by the model flip
    const posture = applySessionMetaPatch(cleared, { activeMode: "deep-research" });
    expect(posture.activeMode).toBe("deep-research");
    // Nothing carried → the row IS the row (a stable identity, no churn).
    expect(applySessionMetaPatch(row, {})).toEqual(row);
  });

  it("PATCHes the session's server-side selected model — pair, and null clears", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 200,
      bodyText: JSON.stringify(makeSession({ selectedModel: { providerId: "z-ai", model: "glm-4.7" } })),
    }));
    const set = await patchSessionSelectedModel(sender, "sess_1", { providerId: "z-ai", model: "glm-4.7" });
    expect(set.ok && set.data.selectedModel).toEqual({ providerId: "z-ai", model: "glm-4.7" });
    expect(calls[0]?.path).toBe("/api/v1/sessions/sess_1");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(calls[0]?.init.bodyText ?? "")).toEqual({ model: { providerId: "z-ai", model: "glm-4.7" } });
    const cleared = await patchSessionSelectedModel(sender, "sess_1", null);
    expect(cleared.ok).toBe(true);
    expect(JSON.parse(calls[1]?.init.bodyText ?? "")).toEqual({ model: null });
  });

  it("shortModelId trims the provider prefix + caps the tail", () => {
    expect(shortModelId("z-ai/glm-4.7")).toBe("glm-4.7");
    expect(shortModelId("glm-4.7")).toBe("glm-4.7");
    expect(shortModelId("openrouter/deepseek/deepseek-chat-v3.1-long")).toBe("deepseek/deepseek-cha…");
    expect(shortModelId("")).toBe("");
  });
});

// ── R116-m: the delivery ladder (the user bubble's tick rungs) ──────────────

describe("sessions — the delivery ladder (R116-m)", () => {
  it("the optimistic card sends; turn.started acks it to sent (the own stream's full climb)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("sending");
    turn = applyLiveFrame(
      turn,
      { type: "turn.started", text: "go", model: "glm-4.7", providerId: "z-ai" },
      NOW + 1,
    );
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("sent");
  });

  it("the rehydrated fold REPLACES the optimistic card with a settled delivered row (the truth wins)", () => {
    // The turn ended — the rehydrate's folded log carries the message as a
    // settled message.user row (the optimistic card is gone wholesale).
    const settled = foldSessionEvents([event(1, "message.user", { content: "go" })]);
    const user = settled[0];
    expect(user?.kind === "user" && user.key).toBe("e1"); // the persisted row owns the slot
    expect(user?.kind === "user" && user.status).toBe("delivered");
  });

  it("an unseen queued.delivered seq lands already delivered (the frame is the delivery notice)", () => {
    const turn = applyLiveFrame(
      beginLiveTurn([], "go", NOW),
      { type: "queued.delivered", seq: 9, content: "late", ts: "t" },
      NOW + 1,
    );
    const card = turn.items.find((item) => item.kind === "user" && item.key === "q9");
    expect(card?.kind === "user" && card.queued).toBe(false);
    expect(card?.kind === "user" && card.status).toBe("delivered");
  });

  it("the error frame marks the turn's in-flight card failed — a DELIVERED card never flips, an undefined status stays clean", () => {
    // A legacy base row (a producer that never picked a rung) + the turn's
    // own card + a queued message that was already delivered mid-turn.
    const legacy: TranscriptItem[] = [
      { kind: "user", key: "e1", content: "old ask", queued: false, attachments: null, ts: null },
    ];
    let turn = beginLiveTurn(legacy, "go", NOW);
    turn = applyLiveFrame(turn, { type: "user.queued", seq: 3, content: "next?", ts: "t" }, NOW + 1);
    turn = applyLiveFrame(turn, { type: "queued.delivered", seq: 3, content: "next?", ts: "t" }, NOW + 2);
    turn = applyLiveFrame(
      turn,
      { type: "error", status: 500, code: "PROVIDER_ERROR", message: "boom" },
      NOW + 3,
    );
    const own = turn.items.find((item) => item.key === `live-user-${NOW}`);
    const deliveredMidTurn = turn.items.find((item) => item.key === "q3");
    const legacyRow = turn.items.find((item) => item.key === "e1");
    // the turn's own in-flight card (still "sent"/"sending") marks failed
    expect(own?.kind === "user" && own.status).toBe("failed");
    // the delivered queued message did NOT fail — its delivery is settled
    expect(deliveredMidTurn?.kind === "user" && deliveredMidTurn.status).toBe("delivered");
    // the legacy row without a rung stays undefined (clean history)
    expect(legacyRow?.kind === "user" && legacyRow.status).toBeUndefined();
  });

  it("an abandoned stream never marks failed (the turn SURVIVES server-side, R42)", () => {
    const abandoned = abandonLiveTurn(beginLiveTurn([], "go", NOW));
    const user = abandoned.items[0];
    expect(user?.kind === "user" && user.status).toBe("sending"); // honest: unknown, not failed
  });
});

// ── R118-D: the processing rung — the PC has STARTED WORKING ────────────────

describe("sessions — the processing rung (R118-D)", () => {
  it("the first content frame after the ack promotes the user card to processing — EXACTLY once", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "turn.started", text: "go", model: "glm-4.7", providerId: "z-ai" },
      NOW + 1,
    );
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("sent");
    // the first delta = the PC's first word of work: sent → processing
    turn = applyLiveFrame(turn, { type: "text-delta", delta: "Hel" }, NOW + 2);
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("processing");
    // EXACTLY once: further deltas leave it alone — once the assistant card
    // lands it owns the tail, and the guard reads === "sent" anyway
    turn = applyLiveFrame(turn, { type: "text-delta", delta: "lo" }, NOW + 3);
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("processing");
    expect(turn.items.filter((item) => item.kind === "user")).toHaveLength(1);
  });

  it("turn.started itself never promotes — the ack is the sent rung, not work", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "turn.started", text: "go", model: "glm-4.7", providerId: "z-ai" },
      NOW + 1,
    );
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("sent");
  });

  it("user.queued / queued.delivered never promote — the queue landing is not the PC working", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "turn.started", text: "go", model: "glm-4.7", providerId: "z-ai" },
      NOW + 1,
    );
    // The acked card is the LAST item and sits at "sent" — exactly the shape
    // the promotion would mis-fire on without the queue-pair exclusion.
    turn = applyLiveFrame(turn, { type: "user.queued", seq: 5, content: "next?", ts: "t" }, NOW + 2);
    const own = turn.items.find((item) => item.key === `live-user-${NOW}`);
    expect(own?.kind === "user" && own.status).toBe("sent"); // untouched
    const queued = turn.items.find((item) => item.kind === "user" && item.key === "q5");
    expect(queued?.kind === "user" && queued.status).toBe("sending");
    turn = applyLiveFrame(turn, { type: "queued.delivered", seq: 5, content: "next?", ts: "t" }, NOW + 3);
    const delivered = turn.items.find((item) => item.kind === "user" && item.key === "q5");
    expect(delivered?.kind === "user" && delivered.status).toBe("delivered");
    expect(own?.kind === "user" && own.status).toBe("sent"); // STILL never promoted
  });

  it("the error frame flips a processing card to failed (the widened finder)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      { type: "turn.started", text: "go", model: "glm-4.7", providerId: "z-ai" },
      NOW + 1,
    );
    turn = applyLiveFrame(turn, { type: "text-delta", delta: "working" }, NOW + 2);
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("processing");
    turn = applyLiveFrame(
      turn,
      { type: "error", status: 502, code: "PROVIDER_ERROR", message: "the key was rejected" },
      NOW + 3,
    );
    expect(turn.items[0]?.kind === "user" && turn.items[0].status).toBe("failed");
  });

  it("the REMOTE mirror inherits the promotion free — the same reducer drives it", () => {
    const base = foldSessionEvents([event(1, "message.user", { content: "earlier ask" })]);
    const opened = reduceRemoteTurnFrame({
      live: null,
      remote: false,
      ownStream: false,
      baseItems: base,
      frame: { type: "turn.started", text: "the PC's ask", model: "glm-4.7", providerId: "z-ai" },
      now: NOW,
    });
    const mirror = opened?.turn as LiveTurn;
    const mirrored = mirror.items.find((item) => item.kind === "user" && item.content === "the PC's ask");
    expect(mirrored?.kind === "user" && mirrored.status).toBe("sent");
    const worked = reduceRemoteTurnFrame({
      live: mirror,
      remote: true,
      ownStream: false,
      baseItems: base,
      frame: { type: "text-delta", delta: "hi" },
      now: NOW + 1,
    });
    const promoted = (worked?.turn as LiveTurn).items.find(
      (item) => item.kind === "user" && item.content === "the PC's ask",
    );
    expect(promoted?.kind === "user" && promoted.status).toBe("processing");
  });
});

// ── R114-d: the folded rows carry their timestamps ──────────────────────────

describe("sessions — message timestamps ride the fold (R114-d)", () => {
  it("user and assistant items carry the event's ts (the timestampsMode gate renders, never invents)", () => {
    const items = foldSessionEvents([
      event(1, "message.user", { content: "hi" }),
      event(2, "message.assistant", { content: "hello", model: "glm-4.7" }),
    ]);
    expect(items[0]?.kind === "user" && items[0].ts).toBe("2026-09-18T11:00:00Z");
    expect(items[1]?.kind === "assistant" && items[1].ts).toBe("2026-09-18T11:00:00Z");
    // Live cards: beginLiveTurn stamps the turn-time ISO.
    const turn = beginLiveTurn([], "go", 5_000);
    expect(turn.items[0]?.kind === "user" && turn.items[0].ts).toBe("1970-01-01T00:00:05.000Z");
  });
});

// ── R117-d2: the live sub-agent stream + the honest error fold ──────────────

describe("sessions — the live sub-agent stream (R117-d2)", () => {
  /** One subagent-status frame for child_1 (the entry's only birth path). */
  const statusFrame = (status: string) => ({
    type: "subagent-status",
    sessionId: "child_1",
    parentSessionId: "sess_parent",
    status,
    task: "research the relay",
    role: "researcher",
    code: "A1B2",
    model: "z-ai/glm-5.2:free",
  });
  /** One subagent-event envelope for child_1 (the child's inner frame rides
   * `inner` — the runtime also stamps the child's sessionId inside). */
  const eventFrame = (inner: Record<string, unknown>) => ({
    type: "subagent-event",
    sessionId: "child_1",
    parentSessionId: "sess_parent",
    inner: { sessionId: "child_1", ...inner },
  });

  it("a status frame BIRTHS the live entry (the map's shape) beside the card", () => {
    let turn = beginLiveTurn([], "go", NOW);
    expect(turn.subagentLive).toBeUndefined(); // absent until the first frame
    turn = applyLiveFrame(turn, statusFrame("queued"), NOW + 1);
    const entry = turn.subagentLive?.["child_1"];
    expect(entry).toBeDefined();
    expect(entry?.childSessionId).toBe("child_1");
    expect(entry?.parentSessionId).toBe("sess_parent");
    expect(entry?.status).toBe("queued");
    expect(entry?.text).toBe("");
    expect(entry?.thinking).toBe("");
    expect(entry?.toolCalls).toBe(0);
    expect(entry?.lastActivity).toBeNull();
    expect(entry?.updatedAtMs).toBe(NOW + 1);
    // the card is the SAME frame's other half — ONE card, no new item kinds
    expect(turn.items.filter((item) => item.kind === "subagent")).toHaveLength(1);
  });

  it("inner deltas accumulate: thinking flags, text appends (streamed `delta` AND the sync path's `text`), the stamp moves", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, statusFrame("running"), NOW + 1);
    turn = applyLiveFrame(turn, eventFrame({ type: "thinking-delta", delta: "plan" }), NOW + 2);
    turn = applyLiveFrame(turn, eventFrame({ type: "thinking-delta", delta: " more" }), NOW + 3);
    turn = applyLiveFrame(turn, eventFrame({ type: "text-delta", delta: "Hello" }), NOW + 4);
    // the SYNC path's step snapshots ride the same frame type as `text`
    turn = applyLiveFrame(turn, eventFrame({ type: "text-delta", text: " world" }), NOW + 5);
    const entry = turn.subagentLive?.["child_1"];
    expect(entry?.thinking).toBe("plan more");
    expect(entry?.text).toBe("Hello world");
    expect(entry?.updatedAtMs).toBe(NOW + 5);
    // the deltas NEVER land as items — the optimistic user card + the ONE
    // status card are the whole transcript
    expect(turn.items).toHaveLength(2);
  });

  it("tool-call frames count + become the last-activity word; tool-results settle it with the ✓/✗ verdict (results never count)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, statusFrame("running"), NOW + 1);
    turn = applyLiveFrame(
      turn,
      eventFrame({ type: "tool-call", toolName: "read_file", argsSummary: "path: src/a.ts" }),
      NOW + 2,
    );
    turn = applyLiveFrame(
      turn,
      eventFrame({ type: "tool-call", toolName: "edit_file", argsSummary: "path: src/b.ts" }),
      NOW + 3,
    );
    expect(turn.subagentLive?.["child_1"]?.toolCalls).toBe(2);
    expect(turn.subagentLive?.["child_1"]?.lastActivity).toBe("edit_file path: src/b.ts");
    turn = applyLiveFrame(
      turn,
      eventFrame({ type: "tool-result", toolName: "read_file", ok: true, outputSummary: "42 lines" }),
      NOW + 4,
    );
    expect(turn.subagentLive?.["child_1"]?.lastActivity).toBe("read_file ✓ 42 lines");
    expect(turn.subagentLive?.["child_1"]?.toolCalls).toBe(2);
    turn = applyLiveFrame(
      turn,
      eventFrame({ type: "tool-result", toolName: "edit_file", ok: false }),
      NOW + 5,
    );
    expect(turn.subagentLive?.["child_1"]?.lastActivity).toBe("edit_file ✗");
  });

  it("a running status frame RESETS the accumulators (a retry re-starts the child); a terminal frame keeps the frozen tail", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, statusFrame("running"), NOW + 1);
    turn = applyLiveFrame(turn, eventFrame({ type: "text-delta", delta: "partial" }), NOW + 2);
    turn = applyLiveFrame(turn, eventFrame({ type: "thinking-delta", delta: "hmm" }), NOW + 3);
    turn = applyLiveFrame(
      turn,
      eventFrame({ type: "tool-call", toolName: "read_file", argsSummary: "path: a" }),
      NOW + 4,
    );
    // completed → the frozen tail rides (the settle bridge while the
    // rehydrate lands)
    turn = applyLiveFrame(turn, statusFrame("completed"), NOW + 5);
    expect(turn.subagentLive?.["child_1"]?.status).toBe("completed");
    expect(turn.subagentLive?.["child_1"]?.text).toBe("partial");
    expect(turn.subagentLive?.["child_1"]?.toolCalls).toBe(1);
    // a fresh running (the owner's Retry took) → cleared, the PC's rule
    turn = applyLiveFrame(turn, statusFrame("running"), NOW + 6);
    expect(turn.subagentLive?.["child_1"]?.text).toBe("");
    expect(turn.subagentLive?.["child_1"]?.thinking).toBe("");
    expect(turn.subagentLive?.["child_1"]?.toolCalls).toBe(0);
    // lastActivity CARRIES across status frames (the PC's own semantics)
    expect(turn.subagentLive?.["child_1"]?.lastActivity).toBe("read_file path: a");
  });

  it("envelopes for an UNKNOWN child drop (no entry, no mutation) — the PC's guard; malformed inner/ids drop too", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(
      turn,
      {
        type: "subagent-event",
        sessionId: "ghost",
        parentSessionId: "sess_parent",
        inner: { type: "text-delta", delta: "boo" },
      },
      NOW + 1,
    );
    expect(turn.subagentLive).toBeUndefined();
    turn = applyLiveFrame(turn, statusFrame("running"), NOW + 2);
    // malformed inner (not a record)
    turn = applyLiveFrame(
      turn,
      { type: "subagent-event", sessionId: "child_1", parentSessionId: "sess_parent", inner: "junk" },
      NOW + 3,
    );
    // missing child sessionId
    turn = applyLiveFrame(
      turn,
      {
        type: "subagent-event",
        sessionId: "",
        parentSessionId: "sess_parent",
        inner: { type: "text-delta", delta: "x" },
      },
      NOW + 4,
    );
    // an inner frame the phone doesn't fold (finish) — falls through quietly
    turn = applyLiveFrame(
      turn,
      {
        type: "subagent-event",
        sessionId: "child_1",
        parentSessionId: "sess_parent",
        inner: { type: "finish", usage: { inputTokens: 5, outputTokens: 2 } },
      },
      NOW + 5,
    );
    expect(turn.subagentLive?.["child_1"]?.text).toBe("");
    expect(turn.subagentLive?.["child_1"]?.toolCalls).toBe(0);
    expect(turn.items.filter((item) => item.kind === "subagent")).toHaveLength(1);
  });

  it("two children keep SEPARATE entries (the map is keyed by child session id)", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, statusFrame("running"), NOW + 1);
    turn = applyLiveFrame(
      turn,
      {
        type: "subagent-status",
        sessionId: "child_2",
        parentSessionId: "sess_parent",
        status: "running",
        task: "write tests",
        role: "coder",
      },
      NOW + 2,
    );
    turn = applyLiveFrame(turn, eventFrame({ type: "text-delta", delta: "one" }), NOW + 3);
    turn = applyLiveFrame(
      turn,
      {
        type: "subagent-event",
        sessionId: "child_2",
        parentSessionId: "sess_parent",
        inner: { type: "text-delta", delta: "two" },
      },
      NOW + 4,
    );
    expect(turn.subagentLive?.["child_1"]?.text).toBe("one");
    expect(turn.subagentLive?.["child_2"]?.text).toBe("two");
    expect(Object.keys(turn.subagentLive ?? {})).toHaveLength(2);
  });
});

describe("sessions — the honest error fold (R117-d2)", () => {
  it("the persisted turn.error fold reads errorClass + attempts (additive; absent/malformed → null)", () => {
    const items = foldSessionEvents([
      event(1, "message.user", { content: "go" }),
      event(2, "turn.error", {
        code: "PROVIDER_ERROR",
        message: "the key was rejected",
        model: "z-ai/glm-5.2:free",
        providerId: "z-ai",
        providerError: "raw provider text",
        userSeq: 1,
        errorClass: "rate_limit",
        attempts: 3,
      }),
      event(3, "turn.error", { code: "NO_OUTPUT", message: "blank", attempts: "not-a-number" }),
    ]);
    const errors = items.filter((item) => item.kind === "error");
    expect(errors).toHaveLength(2);
    const rich = errors[0];
    expect(rich?.kind === "error" && rich.errorClass).toBe("rate_limit");
    expect(rich?.kind === "error" && rich.attempts).toBe(3);
    const bare = errors[1];
    expect(bare?.kind === "error" && bare.errorClass).toBeNull();
    expect(bare?.kind === "error" && bare.attempts).toBeNull(); // never a guess
  });

  it("the LIVE error frame carries the honesty fields off its details object (both live + the card)", () => {
    const errored = applyLiveFrame(
      beginLiveTurn([], "go", NOW),
      {
        type: "error",
        status: 502,
        code: "PROVIDER_ERROR",
        message: "quota spent",
        details: { errorClass: "rate_limit", attempts: 6, queuedKept: 2 },
      },
      NOW + 1,
    );
    expect(errored.error?.errorClass).toBe("rate_limit");
    expect(errored.error?.attempts).toBe(6);
    const card = errored.items[errored.items.length - 1];
    expect(card?.kind === "error" && card.errorClass).toBe("rate_limit");
    expect(card?.kind === "error" && card.attempts).toBe(6);
    // a frame with NO details renders neither field (older sidecars)
    const bare = applyLiveFrame(
      beginLiveTurn([], "go", NOW),
      { type: "error", status: 502, code: "PROVIDER_ERROR", message: "boom" },
      NOW + 1,
    );
    expect(bare.error?.errorClass).toBeNull();
    expect(bare.error?.attempts).toBeNull();
  });

  // ── R119-P (round-119 §1 item F): the provider's RAW error text threads
  // through BOTH reducers — the owner's TokenHarbor report (a region_blocked
  // answer read as an unexplained generic failure on the phone, while the
  // PC showed it). The persisted fold reads payload.providerError; the live
  // frame reads details.providerError (+ details.classMessage).
  it("R119-P: the persisted turn.error fold reads providerError (the raw provider text)", () => {
    const items = foldSessionEvents([
      event(1, "message.user", { content: "go" }),
      event(2, "turn.error", {
        code: "PROVIDER_ERROR",
        message: "provider 'tokenharbor' call failed for session sess_1",
        model: "qwen3.8-flash:free",
        providerId: "tokenharbor",
        providerError: "region_blocked: your region is not supported",
        userSeq: 1,
        errorClass: "region",
      }),
      event(3, "turn.error", { code: "NO_OUTPUT", message: "blank" }),
    ]);
    const errors = items.filter((item) => item.kind === "error");
    expect(errors).toHaveLength(2);
    const rich = errors[0];
    expect(rich?.kind === "error" && rich.providerError).toBe(
      "region_blocked: your region is not supported",
    );
    // Absent on the wire → null (never a guess; older sidecars).
    const bare = errors[1];
    expect(bare?.kind === "error" && bare.providerError).toBeNull();
  });

  it("R119-P: the LIVE error frame reads details.providerError + details.classMessage (both live + the card)", () => {
    const errored = applyLiveFrame(
      beginLiveTurn([], "go", NOW),
      {
        type: "error",
        status: 502,
        code: "PROVIDER_ERROR",
        message: "the provider call failed",
        details: {
          errorClass: "rate_limit",
          attempts: 6,
          providerError: "429 rate limited: free-models-per-day quota exhausted",
          classMessage: "the provider is out of quota",
        },
      },
      NOW + 1,
    );
    expect(errored.error?.providerError).toBe("429 rate limited: free-models-per-day quota exhausted");
    expect(errored.error?.classMessage).toBe("the provider is out of quota");
    const card = errored.items[errored.items.length - 1];
    expect(card?.kind === "error" && card.providerError).toBe(
      "429 rate limited: free-models-per-day quota exhausted",
    );
    expect(card?.kind === "error" && card.classMessage).toBe("the provider is out of quota");
    // a frame with NO details renders none (older sidecars)
    const bare = applyLiveFrame(
      beginLiveTurn([], "go", NOW),
      { type: "error", status: 502, code: "PROVIDER_ERROR", message: "boom" },
      NOW + 1,
    );
    expect(bare.error?.providerError).toBeNull();
    expect(bare.error?.classMessage).toBeNull();
  });
});

describe("sessions — the sub-agent control routes (R117-d2)", () => {
  it("POSTs the retry on the parent/child route with the exact body (and stop on a CHILD is the same route family)", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ ok: true, message: "re-delegated", stopped: true }),
    }));
    const retry = await postSubAgentRetry(sender, "sess_parent", "child_1");
    expect(retry.ok && retry.data.message).toBe("re-delegated");
    expect(calls[0]?.path).toBe("/api/v1/sessions/sess_parent/subagents/child_1/retry");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.bodyText).toBe("{}");
    // R52-b: the SAME postStop the SubAgentCard's Stop affordance rides — on
    // the CHILD id directly (the route stops registered children).
    const stop = await postStop(sender, "child_1");
    expect(stop.ok && stop.data.stopped).toBe(true);
    expect(calls[1]?.path).toBe("/api/v1/sessions/child_1/stop");
    expect(calls[1]?.init.method).toBe("POST");
  });

  it("carries the retry's honest 409/502 refusals as error outcomes", async () => {
    const { sender } = makeApiSender((path) =>
      path.endsWith("/retry")
        ? { status: 409, bodyText: JSON.stringify({ error: { code: "CONFLICT", message: "sub-agent child_1 is already running" } }) }
        : { status: 200, bodyText: "{}" },
    );
    const outcome = await postSubAgentRetry(sender, "sess_parent", "child_1");
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("CONFLICT");
    expect(!outcome.ok && outcome.error.message).toContain("already running");
  });
});

// ── R119-A — the queued-message position law + the measured thinking span ──

describe("sessions — rebaseRemoteTurn's queued-position law (R119-A)", () => {
  /** The persisted base: one settled exchange. */
  const base = foldSessionEvents([
    event(1, "message.user", { role: "user", content: "earlier ask" }),
    event(2, "message.assistant", { role: "assistant", content: "earlier answer", model: "z-ai/glm-5.2:free" }),
  ]);

  /** A remote mirror streaming one live assistant segment over the base. */
  function streamingMirror(extraFrames: Array<Record<string, unknown>> = []): LiveTurn {
    let opened = reduceRemoteTurnFrame({
      live: null,
      remote: false,
      ownStream: false,
      baseItems: base,
      frame: { type: "text-delta", delta: "PC says" },
      now: NOW,
    });
    for (const frame of extraFrames) {
      opened = reduceRemoteTurnFrame({
        live: opened?.turn ?? null,
        remote: true,
        ownStream: false,
        baseItems: base,
        frame,
        now: NOW,
      });
    }
    if (opened === null) throw new Error("the mirror did not open");
    return opened.turn;
  }

  it("a folded message.queued row moves to the END of the live tail — after the in-progress items, never above them (§1 item 7)", () => {
    const mirror = streamingMirror();
    // The rehydrate landed mid-turn: the fresh base carries the opening user
    // row AND a waiting queued message at its LOG position (early).
    const grownBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "earlier ask" }),
      event(2, "message.assistant", { role: "assistant", content: "earlier answer", model: "z-ai/glm-5.2:free" }),
      event(3, "message.queued", { role: "user", content: "the waiting one" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, grownBase, base.length);
    // the settled base (2 rows), then the LIVE tail, then the STILL-QUEUED
    // row at the very end — never above the processing section
    expect(rebased.items).toHaveLength(4);
    expect(rebased.items[1]?.kind === "assistant" && rebased.items[1].live).toBe(false);
    const live = rebased.items[2];
    expect(live?.kind === "assistant" && live.live).toBe(true);
    const last = rebased.items[3];
    expect(last?.kind === "user" && last.queued).toBe(true);
    expect(last?.kind === "user" && last.content).toBe("the waiting one");
  });

  it("a folded queued row the live tail already mirrors (the events stream's user.queued frame) is DROPPED — one waiting row, the live one", () => {
    const mirror = streamingMirror([
      { type: "user.queued", seq: 7, content: "the waiting one", ts: "2026-09-18T11:00:01Z" },
    ]);
    const grownBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "earlier ask" }),
      event(2, "message.assistant", { role: "assistant", content: "earlier answer", model: "z-ai/glm-5.2:free" }),
      event(3, "message.queued", { role: "user", content: "the waiting one" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, grownBase, base.length);
    // exactly ONE waiting row survives — the live q-row owns the slot
    const waiting = rebased.items.filter((item) => item.kind === "user" && item.queued);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.kind === "user" && waiting[0].key).toBe("q7");
    // and it rides the very end, after the live assistant
    const tail = rebased.items[rebased.items.length - 1];
    expect(tail?.kind === "user" && tail.queued).toBe(true);
  });

  it("a DELIVERED folded row (message.queued flipped to message.user in place) never moves — its settled log position stands", () => {
    const mirror = streamingMirror();
    const grownBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "earlier ask" }),
      event(2, "message.assistant", { role: "assistant", content: "earlier answer", model: "z-ai/glm-5.2:free" }),
      event(3, "message.user", { role: "user", content: "the delivered one" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, grownBase, base.length);
    // the delivered row rides its log position (index 2), the live tail after
    expect(rebased.items).toHaveLength(4);
    expect(rebased.items.map((item) => item.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(rebased.items[2]?.kind === "user" && rebased.items[2].queued).toBe(false);
    expect(rebased.items[2]?.kind === "user" && rebased.items[2].content).toBe("the delivered one");
    expect(rebased.items[3]?.kind === "assistant" && rebased.items[3].live).toBe(true);
  });
});

describe("sessions — the measured thinking span rides the fold (R119-A)", () => {
  it("a message.assistant with thinking + thinkingMs carries the measured span; invalid/absent spans stay absent (never a guess)", () => {
    const [measured] = foldSessionEvents([
      event(1, "message.assistant", { role: "assistant", content: "", thinking: "hmm", thinkingMs: 6_400 }),
    ]);
    expect(measured?.kind === "assistant" && measured.thinkingMs).toBe(6_400);
    const [zero] = foldSessionEvents([
      event(2, "message.assistant", { role: "assistant", content: "", thinking: "hmm", thinkingMs: 0 }),
    ]);
    expect(zero?.kind === "assistant" && zero.thinkingMs).toBeUndefined();
    const [negative] = foldSessionEvents([
      event(3, "message.assistant", { role: "assistant", content: "", thinking: "hmm", thinkingMs: -50 }),
    ]);
    expect(negative?.kind === "assistant" && negative.thinkingMs).toBeUndefined();
    const [notNumber] = foldSessionEvents([
      event(4, "message.assistant", { role: "assistant", content: "", thinking: "hmm", thinkingMs: "8000" }),
    ]);
    expect(notNumber?.kind === "assistant" && notNumber.thinkingMs).toBeUndefined();
    const [absent] = foldSessionEvents([
      event(5, "message.assistant", { role: "assistant", content: "", thinking: "hmm" }),
    ]);
    expect(absent?.kind === "assistant" && absent.thinkingMs).toBeUndefined();
  });
});

// ── R120-CM: the center's honest rows (§1 items 40/41) ──────────────────────

describe("sessions — the fold renders the write/edit/command rows (R120-CM, item 40)", () => {
  it("a persisted write turn folds to tool rows that carry everything the rows render: name, path summary, verdict, output", () => {
    const items = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "make the changes" }),
      event(2, "message.assistant", { role: "assistant", content: "", thinking: "planning", thinkingMs: 3_000, model: "m" }),
      event(3, "tool.use", { role: "tool", toolName: "write_file", argsSummary: "path: src/new.ts, content: export const A = 1; …", ok: true, outputSummary: "wrote 96 bytes to 'src/new.ts'" }),
      event(4, "tool.use", { role: "tool", toolName: "edit_file", argsSummary: "path: src/a.ts, oldString: x, newString: y", ok: true, outputSummary: "Edited 'src/a.ts': 2 replacements, +12 −3 lines" }),
      event(5, "tool.use", { role: "tool", toolName: "run_command", argsSummary: "command: npm test", ok: true, outputSummary: "ok [exit code: 0]" }),
      event(6, "message.assistant", { role: "assistant", content: "done", model: "m" }),
    ]);
    // Every write/edit/create call survives the fold as a TOOL ROW's data —
    // the TurnBlock's well renders each one (the item model never drops them).
    const tools = items.filter((item) => item.kind === "tool");
    expect(tools.map((t) => (t.kind === "tool" ? t.toolName : ""))).toEqual([
      "write_file",
      "edit_file",
      "run_command",
    ]);
    const write = tools[0];
    expect(write?.kind === "tool" && write.argsSummary).toBe("path: src/new.ts, content: export const A = 1; …");
    expect(write?.kind === "tool" && write.ok).toBe(true);
    expect(write?.kind === "tool" && write.outputSummary).toBe("wrote 96 bytes to 'src/new.ts'");
    const edit = tools[1];
    expect(edit?.kind === "tool" && edit.outputSummary).toBe("Edited 'src/a.ts': 2 replacements, +12 −3 lines");
    const command = tools[2];
    expect(command?.kind === "tool" && command.argsSummary).toBe("command: npm test");
    // A FAILED write carries its false verdict (the danger row's own data).
    const [failedWrite] = foldSessionEvents([
      event(7, "tool.use", { role: "tool", toolName: "write_file", argsSummary: "path: src/locked.ts, content: …", ok: false, outputSummary: "path is outside the project root" }),
    ]);
    expect(failedWrite?.kind === "tool" && failedWrite.ok).toBe(false);
  });
});

describe("sessions — the live tool-frame association is content-keyed (R120-CM, items 40/41a)", () => {
  /** Drive one own turn through the frame list (the plain reducer harness). */
  function turnOf(frames: Array<Record<string, unknown>>): LiveTurn {
    let turn = beginLiveTurn([], "fix both files", NOW);
    let t = NOW;
    for (const frame of frames) {
      turn = applyLiveFrame(turn, frame, t);
      t += 10;
    }
    return turn;
  }

  it("parallel same-name calls keep their OWN rows: paths, args, and +A/−B verdicts never cross-wire", () => {
    // The AI SDK's generation order for two parallel edit_file calls in one
    // step — input A completes, input B completes, then the executed results
    // settle (either order; here the natural A-then-B). The pre-R120-CM
    // reverse() match landed A's frames on B's card: card A never got its
    // argsSummary (its PATH never rendered) and the two results swapped.
    const turn = turnOf([
      { type: "turn.started", text: "fix both files", model: "m", providerId: "p" },
      { type: "tool-input-start", toolCallId: "call_A", toolName: "edit_file" },
      { type: "tool-input-delta", toolCallId: "call_A", inputTextDelta: '{"path": "src/a.ts", "oldString": "x"' },
      { type: "tool-input-start", toolCallId: "call_B", toolName: "edit_file" },
      { type: "tool-input-delta", toolCallId: "call_B", inputTextDelta: '{"path": "src/b.ts", "oldString": "y"' },
      { type: "tool-call", toolName: "edit_file", argsSummary: "path: src/a.ts, oldString: x, newString: x2" },
      { type: "tool-call", toolName: "edit_file", argsSummary: "path: src/b.ts, oldString: y, newString: y2" },
      { type: "tool-result", toolName: "edit_file", argsSummary: "path: src/a.ts, oldString: x, newString: x2", ok: true, outputSummary: "Edited 'src/a.ts': 1 replacement, +2 −1 lines" },
      { type: "tool-result", toolName: "edit_file", argsSummary: "path: src/b.ts, oldString: y, newString: y2", ok: true, outputSummary: "Edited 'src/b.ts': 1 replacement, +3 −0 lines" },
      { type: "done" },
    ]);
    const tools = turn.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(2);
    const a = tools[0];
    const b = tools[1];
    // Card A = the FIRST call: its args, its result — never B's.
    expect(a?.kind === "tool" && a.argsSummary).toBe("path: src/a.ts, oldString: x, newString: x2");
    expect(a?.kind === "tool" && a.outputSummary).toBe("Edited 'src/a.ts': 1 replacement, +2 −1 lines");
    expect(a?.kind === "tool" && a.ok).toBe(true);
    expect(b?.kind === "tool" && b.argsSummary).toBe("path: src/b.ts, oldString: y, newString: y2");
    expect(b?.kind === "tool" && b.outputSummary).toBe("Edited 'src/b.ts': 1 replacement, +3 −0 lines");
    expect(b?.kind === "tool" && b.toolCallId).toBeNull(); // spent at the settle, exactly one call's lifecycle
  });

  it("out-of-order results still land on their own cards (the frame's argsSummary names the call)", () => {
    const turn = turnOf([
      { type: "turn.started", text: "go", model: "m", providerId: "p" },
      { type: "tool-input-start", toolCallId: "call_A", toolName: "write_file" },
      { type: "tool-input-delta", toolCallId: "call_A", inputTextDelta: '{"path": "src/one.ts"' },
      { type: "tool-call", toolName: "write_file", argsSummary: "path: src/one.ts, content: one" },
      { type: "tool-input-start", toolCallId: "call_B", toolName: "write_file" },
      { type: "tool-input-delta", toolCallId: "call_B", inputTextDelta: '{"path": "src/two.ts"' },
      { type: "tool-call", toolName: "write_file", argsSummary: "path: src/two.ts, content: two" },
      // B finished FIRST (the faster write settles first) — the result still
      // lands on B's card because its argsSummary names it.
      { type: "tool-result", toolName: "write_file", argsSummary: "path: src/two.ts, content: two", ok: true, outputSummary: "wrote 3 bytes to 'src/two.ts'" },
      { type: "tool-result", toolName: "write_file", argsSummary: "path: src/one.ts, content: one", ok: true, outputSummary: "wrote 3 bytes to 'src/one.ts'" },
    ]);
    const tools = turn.items.filter((item) => item.kind === "tool");
    expect(tools[0]?.kind === "tool" && tools[0].outputSummary).toBe("wrote 3 bytes to 'src/one.ts'");
    expect(tools[1]?.kind === "tool" && tools[1].outputSummary).toBe("wrote 3 bytes to 'src/two.ts'");
    // The still-running A card kept its streaming raw until its own result.
    expect(tools[0]?.kind === "tool" && tools[0].inputRaw).toBeNull();
  });

  it("tool-output tails land on the card whose command the frame carries (parallel run_commands never cross)", () => {
    const turn = turnOf([
      { type: "turn.started", text: "go", model: "m", providerId: "p" },
      { type: "tool-call", toolName: "run_command", argsSummary: "command: npm test" },
      { type: "tool-call", toolName: "run_command", argsSummary: "command: npm run lint" },
      // exec.ts rides the RAW command in tool-output's argsSummary.
      { type: "tool-output", toolName: "run_command", argsSummary: "npm run lint", chunk: "lint: clean" },
      { type: "tool-output", toolName: "run_command", argsSummary: "npm test", chunk: "tests: 3 passed" },
    ]);
    const tools = turn.items.filter((item) => item.kind === "tool");
    expect(tools[0]?.kind === "tool" && tools[0].outputTail).toBe("tests: 3 passed");
    expect(tools[1]?.kind === "tool" && tools[1].outputTail).toBe("lint: clean");
  });

  it("a frame with NO argsSummary falls back to the OLDEST running card of the name (sequential order)", () => {
    const turn = turnOf([
      { type: "turn.started", text: "go", model: "m", providerId: "p" },
      { type: "tool-call", toolName: "read_file", argsSummary: "path: src/a.ts" },
      { type: "tool-call", toolName: "read_file", argsSummary: "path: src/b.ts" },
      // An older sidecar's result frame without argsSummary: the FIRST call
      // completes first — the oldest running card is the honest target.
      { type: "tool-result", toolName: "read_file", ok: true, outputSummary: "120 lines" },
    ]);
    const tools = turn.items.filter((item) => item.kind === "tool");
    expect(tools[0]?.kind === "tool" && tools[0].ok).toBe(true);
    expect(tools[0]?.kind === "tool" && tools[0].outputSummary).toBe("120 lines");
    expect(tools[1]?.kind === "tool" && tools[1].ok).toBeNull();
  });
});

describe("sessions — rebaseRemoteTurn's mid-turn twin dedupe (R120-CM, item 41a)", () => {
  it("a mid-turn rehydrate renders the opener, the settled tools, and the flushed segments EXACTLY ONCE (the persisted twins drop the live copies)", () => {
    // The remote mirror streams a write turn on the phone while the events
    // bus's event frames trigger the debounced rehydrate — the persisted log
    // already carries the opener user row, the first tool.use, and the
    // flushed assistant segment. The old head-only dedupe left ALL of them
    // doubled (the split-in-two transcript).
    let mirror = beginRemoteTurn([]);
    const frames: Array<Record<string, unknown>> = [
      { type: "turn.started", text: "add a file", model: "m1", providerId: "p" },
      { type: "text-delta", delta: "making it" },
      { type: "tool-input-start", toolCallId: "A", toolName: "write_file" },
      { type: "tool-input-delta", toolCallId: "A", inputTextDelta: '{"path": "src/new.ts", "content": "x' },
      { type: "tool-call", toolName: "write_file", argsSummary: "path: src/new.ts, content: x" },
      { type: "tool-result", toolName: "write_file", argsSummary: "path: src/new.ts, content: x", ok: true, outputSummary: "wrote 1 byte to 'src/new.ts'" },
      { type: "text-delta", delta: " and done" },
    ];
    let t = NOW;
    for (const frame of frames) {
      mirror = applyLiveFrame(mirror, frame, t);
      t += 10;
    }
    // The rehydrate: the persisted log now carries the opener + the flushed
    // first segment + the completed write (the second segment still streams).
    const freshBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "add a file" }),
      event(2, "message.assistant", { role: "assistant", content: "making it", model: "m1" }),
      event(3, "tool.use", { role: "tool", toolName: "write_file", argsSummary: "path: src/new.ts, content: x", ok: true, outputSummary: "wrote 1 byte to 'src/new.ts'" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, freshBase, 0);
    const kinds = rebased.items.map((item) => item.kind);
    // ONE user row, ONE settled first segment, ONE settled tool row, then the
    // still-streaming second segment (its persisted twin has NOT landed — a
    // segment flushes only at the next tool boundary or the turn's end).
    expect(kinds).toEqual(["user", "assistant", "tool", "assistant"]);
    const users = rebased.items.filter((item) => item.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.kind === "user" && users[0].key).toBe("e1"); // the persisted card owns the slot
    const tools = rebased.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.kind === "tool" && tools[0].outputSummary).toBe("wrote 1 byte to 'src/new.ts'");
    const liveTail = rebased.items[rebased.items.length - 1];
    expect(liveTail?.kind === "assistant" && liveTail.live).toBe(true);
    expect(liveTail?.kind === "assistant" && liveTail.content).toBe(" and done");
  });

  it("a still-RUNNING tool has no persisted twin and keeps streaming through the rebase", () => {
    let mirror = beginRemoteTurn([]);
    mirror = applyLiveFrame(mirror, { type: "turn.started", text: "go", model: "m", providerId: "p" }, NOW);
    mirror = applyLiveFrame(mirror, { type: "tool-input-start", toolCallId: "A", toolName: "edit_file" }, NOW + 1);
    mirror = applyLiveFrame(mirror, { type: "tool-input-delta", toolCallId: "A", inputTextDelta: '{"path": "src/a.ts"' }, NOW + 2);
    // The persisted log grew past the opener (an approval, say) — the running
    // edit row keeps its live streaming raw.
    const freshBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "go" }),
      event(2, "approval.requested", { approvalId: "ap1", toolName: "edit_file", argsSummary: "path: src/a.ts", category: "confirm" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, freshBase, 0);
    const tools = rebased.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.kind === "tool" && tools[0].ok).toBeNull();
    expect(tools[0]?.kind === "tool" && tools[0].inputRaw).toBe('{"path": "src/a.ts"');
  });

  it("identical repeat segments stay count-honest: two persisted twins consume two live twins, a third live copy survives", () => {
    let mirror = beginRemoteTurn([]);
    mirror = applyLiveFrame(mirror, { type: "turn.started", text: "go", model: "m", providerId: "p" }, NOW);
    mirror = applyLiveFrame(mirror, { type: "text-delta", delta: "OK" }, NOW + 1);
    mirror = applyLiveFrame(mirror, { type: "tool-input-start", toolCallId: "A", toolName: "read_file" }, NOW + 2);
    mirror = applyLiveFrame(mirror, { type: "text-delta", delta: "OK" }, NOW + 3);
    const freshBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "go" }),
      event(2, "message.assistant", { role: "assistant", content: "OK", model: "m" }),
      event(3, "tool.use", { role: "tool", toolName: "read_file", argsSummary: "path: src/a.ts", ok: true, outputSummary: "5 lines" }),
      event(4, "message.assistant", { role: "assistant", content: "OK", model: "m" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, freshBase, 0);
    const assistants = rebased.items.filter((item) => item.kind === "assistant");
    expect(assistants).toHaveLength(2);
    // The tail's RUNNING read kept streaming — a still-streaming card has no
    // content key (no argsSummary yet), so it never pairs with a persisted
    // twin. Honest residual, documented: a mirror that BLIPPED past a call's
    // tool-call/tool-result frames keeps the ghost running row until the
    // turn's terminal rehydrate replaces the whole overlay with the fold.
    const runningTools = rebased.items.filter((item) => item.kind === "tool" && item.ok === null);
    expect(runningTools).toHaveLength(1);
    const settledTools = rebased.items.filter((item) => item.kind === "tool" && item.ok === true);
    expect(settledTools).toHaveLength(1);
    expect(settledTools[0]?.kind === "tool" && settledTools[0].key).toBe("e3");
  });

  it("queued rows pair with nothing — the R119-A law still owns their slot (the live q-row wins)", () => {
    let mirror = beginRemoteTurn([]);
    mirror = applyLiveFrame(mirror, { type: "turn.started", text: "go", model: "m", providerId: "p" }, NOW);
    mirror = applyLiveFrame(mirror, { type: "text-delta", delta: "working" }, NOW + 1);
    mirror = applyLiveFrame(mirror, { type: "user.queued", seq: 9, content: "the next one", ts: "2026-09-18T11:00:01Z" }, NOW + 2);
    const freshBase = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "go" }),
      event(2, "message.queued", { role: "user", content: "the next one" }),
    ]);
    const rebased = rebaseRemoteTurn(mirror, freshBase, 0);
    const waiting = rebased.items.filter((item) => item.kind === "user" && item.queued);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.kind === "user" && waiting[0].key).toBe("q9"); // the LIVE row owns the slot
    const users = rebased.items.filter((item) => item.kind === "user");
    expect(users).toHaveLength(2); // the persisted opener + the live queued row — no doubling
  });
});

// ── R120-CM (item 41a): the live reducer's accumulation ORDER ───────────────

describe("sessions — the live reducer accumulates in FRAME order (R120-CM, item 41a)", () => {
  /** Drive one own turn through the frame list (the plain reducer harness). */
  function turnOf(frames: Array<Record<string, unknown>>): LiveTurn {
    let turn = beginLiveTurn([], "go", NOW);
    let t = NOW;
    for (const frame of frames) {
      turn = applyLiveFrame(turn, frame, t);
      t += 10;
    }
    return turn;
  }

  it("think → text → tool → think → text lands EXACTLY in emission order — no segment ever leaps an earlier one", () => {
    // The reasoning-model stream the owner watched "appear in the wrong
    // order": segment 1 (thinking + text), a tool boundary that FLUSHES it,
    // then segment 2 (more thinking + the closing text). The items must
    // read back in exactly this wire order.
    const turn = turnOf([
      { type: "turn.started", text: "go", model: "m", providerId: "p" },
      { type: "thinking-delta", delta: "plan A" },
      { type: "text-delta", delta: "Working" },
      { type: "tool-input-start", toolCallId: "c1", toolName: "read_file" },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"path": "src/a.ts"' },
      { type: "tool-call", toolName: "read_file", argsSummary: "path: src/a.ts" },
      { type: "tool-result", toolName: "read_file", argsSummary: "path: src/a.ts", ok: true, outputSummary: "12 lines" },
      { type: "thinking-delta", delta: "plan B" },
      { type: "text-delta", delta: " Done" },
      { type: "done" },
    ]);
    // ONE user card, then segment 1, the tool, segment 2 — nothing else.
    expect(turn.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const seg1 = turn.items[1];
    expect(seg1?.kind === "assistant" && seg1.thinking).toBe("plan A");
    expect(seg1?.kind === "assistant" && seg1.content).toBe("Working");
    expect(seg1?.kind === "assistant" && seg1.live).toBe(false); // flushed by the tool boundary
    const tool = turn.items[2];
    expect(tool?.kind === "tool" && tool.argsSummary).toBe("path: src/a.ts");
    const seg2 = turn.items[3];
    expect(seg2?.kind === "assistant" && seg2.thinking).toBe("plan B");
    expect(seg2?.kind === "assistant" && seg2.content).toBe(" Done");
  });

  it("the fold of the SAME wire emits the same order (live rendering == settled rendering — the seam is honest)", () => {
    // The persisted log the runtime writes for that same turn: the opener,
    // segment 1 flushed at the tool boundary, the tool.use row, segment 2
    // flushed at the turn's end. The fold must read back the SAME sequence
    // the live reducer produced — the item stream's order contract.
    const items = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "go" }),
      event(2, "message.assistant", { role: "assistant", content: "Working", thinking: "plan A", model: "m" }),
      event(3, "tool.use", { role: "tool", toolName: "read_file", argsSummary: "path: src/a.ts", ok: true, outputSummary: "12 lines" }),
      event(4, "message.assistant", { role: "assistant", content: " Done", thinking: "plan B", model: "m" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(items[1]?.kind === "assistant" && items[1].content).toBe("Working");
    expect(items[3]?.kind === "assistant" && items[3].content).toBe(" Done");
  });

  it("text deltas arriving AFTER a tool result open a NEW segment after the tool — never merge backward into the flushed one", () => {
    const turn = turnOf([
      { type: "turn.started", text: "go", model: "m", providerId: "p" },
      { type: "text-delta", delta: "first" },
      { type: "tool-call", toolName: "run_command", argsSummary: "command: ls" },
      { type: "tool-result", toolName: "run_command", argsSummary: "command: ls", ok: true, outputSummary: "ok" },
      { type: "text-delta", delta: "second" },
    ]);
    expect(turn.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(turn.items[1]?.kind === "assistant" && turn.items[1].content).toBe("first");
    expect(turn.items[3]?.kind === "assistant" && turn.items[3].content).toBe("second");
    // the chunk merging stays IN-ORDER (the oldest two fold first — a
    // memory cap, never a reorder)
    let merged = beginLiveTurn([], "go", NOW);
    merged = applyLiveFrame(merged, { type: "turn.started", text: "go", model: "m", providerId: "p" }, NOW);
    for (let i = 0; i < 250; i += 1) {
      merged = applyLiveFrame(merged, { type: "text-delta", delta: `w${i} ` }, NOW + i);
    }
    const seg = merged.items[1];
    const text = seg?.kind === "assistant" && seg.chunks !== null ? seg.chunks.join("") : "";
    expect(text.startsWith("w0 w1 w2")).toBe(true);
    expect(text.endsWith("w249 ")).toBe(true);
  });
});
