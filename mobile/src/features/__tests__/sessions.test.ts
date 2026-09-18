/**
 * sessions.test.ts — the transcript state machine: the persisted-event fold
 * (user/queued/assistant+thinking/tool/turn.error/approval pairing/unknown
 * types), the live-frame application (deltas, tool cards, queue chips,
 * approvals, terminal frames), the pure helpers, and the typed client paths
 * + bodies — injected fakes only, zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender, SseSender } from "../api";
import {
  abandonLiveTurn,
  applyLiveFrame,
  beginLiveTurn,
  fetchSessionDetail,
  fetchSessions,
  filterByProject,
  foldSessionEvents,
  isTerminalFrameType,
  isTurnRunning,
  openTurnStream,
  parseStreamFrame,
  postQueue,
  postStop,
  queueBody,
  sessionStatusTone,
  sessionTitle,
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
      event(2, "todo.update", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }),
    ]);
    expect(items[0]?.kind === "meta" && items[0].text).toBe("some.future.event");
    expect(items[1]?.kind === "meta" && items[1].text).toBe("todos — 1/2 done");
  });

  it("drops empty payloads quietly (no phantom bubbles)", () => {
    const items = foldSessionEvents([
      event(1, "message.user", { role: "user", content: "   " }),
      event(2, "message.assistant", { role: "assistant", content: "" }),
    ]);
    expect(items).toHaveLength(0);
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

  it("renders the dim meta lines: continuation, retry, sub-agent, finish tokens", () => {
    let turn = beginLiveTurn([], "go", NOW);
    turn = applyLiveFrame(turn, { type: "meta.continuation", iteration: 2 }, NOW + 1);
    turn = applyLiveFrame(
      turn,
      { type: "meta.retry", attempt: 2, totalAttempts: 6, remainingMs: 4000, errorClass: "rate_limit", message: "rate limited" },
      NOW + 2,
    );
    turn = applyLiveFrame(
      turn,
      { type: "subagent-status", status: "running", task: "t", role: "researcher", code: "A1B2" },
      NOW + 3,
    );
    turn = applyLiveFrame(turn, { type: "finish", usage: { inputTokens: 10, outputTokens: 5 } }, NOW + 4);
    const texts = turn.items.filter((item) => item.kind === "meta").map((item) => (item.kind === "meta" ? item.text : ""));
    expect(texts).toContain("round 2");
    expect(texts.some((text) => text.includes("attempt 2/6"))).toBe(true);
    expect(texts.some((text) => text.includes("researcher A1B2 running"))).toBe(true);
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
});
