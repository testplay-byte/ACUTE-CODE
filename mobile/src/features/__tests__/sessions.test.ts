/**
 * sessions.test.ts — the transcript state machine: the persisted-event fold
 * (user/queued/assistant+thinking/tool/turn.error/approval pairing/unknown
 * types), the live-frame application (deltas, tool cards, queue chips,
 * approvals, terminal frames), the pure helpers, the typed client paths
 * + bodies, and the REMOTE mirror (R113-e — the events-stream frames of
 * ANOTHER device's turn, reduced through the same applyLiveFrame) —
 * injected fakes only, zero React Native.
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
  postStop,
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
  type LiveTurn,
  type SessionEventWire,
  type SessionRow,
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
    turn = applyLiveFrame(turn, { type: "queued.delivered", seq: 7, content: "next?", ts: "t" }, NOW + 2);
    const delivered = turn.items.find((item) => item.kind === "user" && item.key === "q7");
    expect(delivered?.kind === "user" && delivered.queued).toBe(false);
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
