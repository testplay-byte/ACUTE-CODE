/**
 * ROUND-120 (R120-H, owner item 43): the turn-end honesty laws — regression
 * tests for the mid-work SILENT stops.
 *
 * The audit of runStreamedAgentTurn's every exit path found three silent
 * exits; each test here pins one closed path (the law: a turn ends ONLY on
 * a real final answer, a user abort, or a surfaced error — NEVER a
 * clean-looking stop):
 *
 *  1. THE BUDGET FALL-OUT: the outer loop running out mid-tool-work used to
 *     return ok:true with an empty assistant marker + an SSE-only
 *     meta.continuation_complete frame (invisible on PC). Now: the honest
 *     ITERATION_LIMIT stop (persisted turn.error + 502 + the follow-up
 *     affordance + the real token spend) — pinned at the runtime level, at
 *     the sync twin (the sub-agent "completed" lie), and END-TO-END through
 *     the SSE route (the terminal frame is `error`, never `done`).
 *  2. THE MID-TOOL TRUNCATION: a stream that ends CLEANLY with tool-call
 *     events that never received results (or a tool-input-start whose
 *     arguments never completed) used to end the iteration as if nothing
 *     happened — the model's call vanished. Now: the honest truncation
 *     error → the retry ladder (rung 1 is immediate — the turn CONTINUES
 *     and completes), and with the network class switched off, the honest
 *     terminal PROVIDER_ERROR with the truncation text (never a silent
 *     completion).
 *  3. THE BLANK TAIL: a blank final iteration (no text, no tools) over an
 *     UNFINISHED todo plan used to end the turn silently (the R77 carve-out
 *     reads the whole turn). Now: exactly ONE feed-the-condition-back
 *     continuation; the R77 carve-out itself stays pinned for the no-plan
 *     shape (r77-blank-output.test.ts).
 *  4. THE STALL WATCHDOG (item 43's supervisor audit): the child watchdog
 *     used to read ONLY the event log — a healthy run_command (SSE-streamed
 *     terminal chunks, nothing persisted until it finishes, timeout_ms cap
 *     600 s) could out-silence the 300 s stall threshold and be reaped. Now:
 *     sampleChildWatch's liveActivityAt leg (fed by the forwarding emit)
 *     proves a still-streaming child alive; the pure leg is pinned here.
 *
 * ROUND-120 (R120-H, owner item 44): the RESUME path — "Continue re-reads
 * every file from scratch." The pure planners (isResumeRequest /
 * buildResumeContextNote / planResumeTurnContext / assembleHistory's widened
 * fidelity window) and the END-TO-END resume turn (prior tool results in-full
 * + the never-persisted context note + no re-read) are pinned below.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// The real adapter with ONLY the AI SDK mocked at the module boundary (the
// r58 hermetic pattern) — used by the ROUTE-level test; the runtime-level
// tests mock chatStream directly (the r77 pattern).
const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import {
  assembleHistory,
  buildResumeContextNote,
  isResumeRequest,
  planResumeTurnContext,
  runSingleAgentTurn,
  runStreamedAgentTurn,
} from "../src/agents/runtime";
import { sampleChildWatch } from "../src/agents/orchestrator";
import type { ChatFn, ChatTurnOutput, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import { appendSessionEvent, createSession, listSessionEvents, type SessionEvent } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { setRetrySettings } from "../src/storage/settings";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r120h";
const KEY = "sk-or-vtest-r120h";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r120h-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined as unknown as FastifyInstance;
  }
  db?.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const summarizerChat: ChatFn = async () => ({
  text: "SUMMARY: prior work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [],
});

function setup(name: string): { sessionId: string; keyring: ProviderKeyring; agentId: string } {
  const project = createProject(db, { name, rootPath: join(tempDir, name) });
  const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r120h-1" });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { sessionId: session.id, agentId: agent.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
}

/** Seed an unfinished todo plan (the todos-continuation's evidence class). */
function seedUnfinishedTodos(sessionId: string, agentId: string): void {
  appendSessionEvent(db, sessionId, {
    type: "todo.update",
    agentId,
    payload: {
      todos: [
        { content: "Read the notes file", status: "completed" },
        { content: "Write the summary", status: "in_progress" },
      ],
    },
  });
}

// ── 1. THE BUDGET FALL-OUT → the honest ITERATION_LIMIT stop ────────────────

describe("R120-H item 43: the outer-loop budget fall-out (mid-work cap)", () => {
  it("a tools-only turn that exhausts maxOuterLoops ends with the surfaced ITERATION_LIMIT error — never a silent empty ok", async () => {
    const { sessionId, keyring } = setup("R120H-Cap");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    // The model calls a (varying-args) tool EVERY iteration and never yields
    // final text — the fall-out shape (the only one that exits the loop by
    // completion rather than a break).
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      yield { type: "tool-call", toolName: "read_file", argsSummary: `path: f-${streamCalls}.txt`, args: { path: `f-${streamCalls}.txt` } };
      yield {
        type: "tool-result",
        toolName: "read_file",
        argsSummary: `path: f-${streamCalls}.txt`,
        args: { path: `f-${streamCalls}.txt` },
        ok: true,
        outputSummary: `contents of file ${streamCalls}`,
      };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "read every file then report",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    // The budget ran out mid-work: 5 SDK calls.
    expect(streamCalls).toBe(5);
    // THE LAW: not ok — the surfaced stop, not the fake completion.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("ITERATION_LIMIT");
      expect(String(outcome.message)).toContain("continuation budget");
      expect(String(outcome.message)).toContain("continue");
    }
    // The cap frame still rides the stream (mobile renders it)…
    const capEvent = emitted.find((e) => e.type === "meta.continuation_complete");
    expect(capEvent).toBeTruthy();
    // …and a visible retry/error affordance exists (meta.context_limit's
    // sibling) — plus the persisted turn.error the folded UI renders.
    const events = listSessionEvents(db, sessionId);
    const errEvent = events.find((e) => e.type === "turn.error");
    expect(errEvent).toBeDefined();
    expect((errEvent?.payload as { code?: string }).code).toBe("ITERATION_LIMIT");
    expect(String((errEvent?.payload as { message?: string }).message)).toContain("continuation budget");
    // The session rests retryable.
    expect(
      db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId),
    ).toMatchObject({ status: "queued" });
    // The real spend is recorded (5 × 10 input tokens).
    const usageRows = db
      .prepare("SELECT * FROM usage_events WHERE session_id = ?")
      .all(sessionId) as Array<{ input_tokens: number }>;
    expect(usageRows.length).toBe(1);
    expect(usageRows[0].input_tokens).toBe(50);
  });

  it("the SYNC twin mirrors the honest stop (a capped sub-agent never reports ok to its parent)", async () => {
    const { sessionId, keyring } = setup("R120H-CapSync");
    let chatCalls = 0;
    const chat: ChatFn = async () => {
      chatCalls += 1;
      const out: ChatTurnOutput = {
        text: "", // tools-only, no final text — the fall-out shape
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        toolCalls: [
          {
            name: "read_file",
            argsSummary: `path: s-${chatCalls}.txt`,
            args: { path: `s-${chatCalls}.txt` },
            ok: true,
            outputSummary: `sync file ${chatCalls}`,
          },
        ],
      };
      return out;
    };

    const outcome = await runSingleAgentTurn(
      { db, keyring, chat },
      sessionId,
      "read every file then report",
    );

    expect(chatCalls).toBe(5);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("ITERATION_LIMIT");
    }
    const errEvent = listSessionEvents(db, sessionId).find((e) => e.type === "turn.error");
    expect((errEvent?.payload as { code?: string }).code).toBe("ITERATION_LIMIT");
  });

  it("END-TO-END through the SSE route: the budget fall-out terminates the stream with an error frame, never done", async () => {
    app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) });
    // A tools-only streamText mock at the module boundary (the r58 pattern).
    let sdkCalls = 0;
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        sdkCalls += 1;
        yield { type: "tool-call", toolName: "read_file", input: { path: `r-${sdkCalls}.txt` } };
        yield { type: "tool-result", toolName: "read_file", input: { path: `r-${sdkCalls}.txt` }, output: "file body" };
        yield { type: "finish-step", usage: { inputTokens: 3, outputTokens: 2 } };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
      usage: Promise.resolve({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
    }));
    const agentRes = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name: "Cap Agent", providerId: "openrouter", model: "test/r120h-2", maxTurns: 8 },
    });
    const agentId = (agentRes.json() as { id: string }).id;
    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { agentId, mode: "single" },
    });
    const sessionId = (sessionRes.json() as { id: string }).id;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { content: "read all the files" },
    });
    expect(response.statusCode).toBe(200);
    const frames: Array<Record<string, unknown>> = [];
    for (const block of response.body.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
    }
    // 5 SDK calls before the cap.
    expect(sdkCalls).toBe(5);
    const terminal = frames.filter((f) => f.type === "done" || f.type === "error");
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe("error");
    expect(terminal[0].code).toBe("ITERATION_LIMIT");
    // The persisted error rides the event log too (the reload shows the card).
    expect(
      listSessionEvents(db, sessionId).some(
        (e) => e.type === "turn.error" && (e.payload as { code?: string }).code === "ITERATION_LIMIT",
      ),
    ).toBe(true);
  });
});

// ── 2. THE MID-TOOL TRUNCATION → the ladder continues, or the error surfaces ─

describe("R120-H item 43: the clean-close mid-tool truncation", () => {
  it("a stream that ends mid-tool-call retries through the ladder (rung 1 is immediate) and the turn COMPLETES — never a silent stop", async () => {
    const { sessionId, keyring } = setup("R120H-Trunc1");
    const emitted: Array<Record<string, unknown>> = [];
    const seenRequests: Array<Array<{ role: string; content: string }>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      seenRequests.push(input.messages.map((m) => ({ role: m.role, content: m.content })));
      if (streamCalls === 1) {
        // The cut: text streams, the tool call ARRIVES, its result never
        // does — the generator just ends (a clean-close drop after an
        // earlier finish-step, invisible to the R80 guard).
        yield { type: "text-delta", delta: "Reading the notes file now." };
        yield { type: "tool-call", toolName: "read_file", argsSummary: "path: notes.txt", args: { path: "notes.txt" } };
        return;
      }
      // The retry (rung 1 = 0 ms, immediate): the model sees the flushed
      // partial in history and concludes.
      yield { type: "text-delta", delta: "Done — the notes are in order. Task complete." };
      yield { type: "finish", usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "read notes.txt and report",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    // The turn CONTINUED (the ladder's fresh attempt), not stopped.
    expect(streamCalls).toBe(2);
    // The retry was VISIBLE (the meta.retry card the UI renders).
    const retryFrame = emitted.find((e) => e.type === "meta.retry");
    expect(retryFrame).toBeTruthy();
    expect(retryFrame?.errorClass).toBe("network");
    // The partial work survived into the retry's history (the R75 flush).
    expect(seenRequests[1].some((m) => m.content.includes("Reading the notes file now."))).toBe(true);
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });

  it("a stream that ends mid-tool-ARGUMENTS (input-start, no call) is the same honest truncation", async () => {
    const { sessionId, keyring } = setup("R120H-Trunc2");
    setRetrySettings(db, { autoRetryNetwork: false }); // fail fast → the terminal path
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      yield { type: "text-delta", delta: "Writing the file." };
      yield { type: "tool-input-start", toolCallId: "c1", toolName: "write_file" };
      yield { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"path":"a.t' };
      return; // arguments never completed, no finish
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "write a.txt",
      () => undefined,
    );

    expect(streamCalls).toBe(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(String(outcome.details?.providerError)).toContain("mid-tool-call");
      expect(String(outcome.details?.providerError)).toContain("argument stream");
    }
    const errEvent = listSessionEvents(db, sessionId).find((e) => e.type === "turn.error");
    expect((errEvent?.payload as { errorClass?: string }).errorClass).toBe("network");
    // The partial text was persisted (no silent loss) — a follow-up
    // "continue" resumes from it.
    const assistantEvents = listSessionEvents(db, sessionId).filter((e) => e.type === "message.assistant");
    expect(assistantEvents.some((e) => (e.payload as { content?: string }).content === "Writing the file.")).toBe(true);
  });

  it("with the network class disabled, the dangling tool-call ends as the surfaced PROVIDER_ERROR — never a clean completion", async () => {
    const { sessionId, keyring } = setup("R120H-Trunc3");
    setRetrySettings(db, { autoRetryNetwork: false });
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "tool-call", toolName: "read_file", argsSummary: "path: x.txt", args: { path: "x.txt" } };
      // No tool-result, no finish — the cut.
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "read x.txt",
      () => undefined,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(String(outcome.details?.providerError)).toContain("1 tool call streamed without results");
    }
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(true);
  });
});

// ── 3. THE BLANK TAIL over an unfinished plan → ONE continuation ────────────

describe("R120-H item 43: the blank tail over an unfinished todo plan", () => {
  it("a blank final iteration with UNFINISHED todos gets ONE feed-the-condition-back continuation, then completes", async () => {
    const { sessionId, keyring, agentId } = setup("R120H-BlankTail");
    seedUnfinishedTodos(sessionId, agentId);
    const seenRequests: Array<Array<{ role: string; content: string }>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      seenRequests.push(input.messages.map((m) => ({ role: m.role, content: m.content })));
      if (streamCalls === 1) {
        // Tools-only iteration — the model is mid-work, the loop continues.
        yield { type: "tool-call", toolName: "read_file", argsSummary: "path: notes.txt", args: { path: "notes.txt" } };
        yield {
          type: "tool-result",
          toolName: "read_file",
          argsSummary: "path: notes.txt",
          args: { path: "notes.txt" },
          ok: true,
          outputSummary: "the notes",
        };
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      } else if (streamCalls === 2) {
        // The whitespace flake — no text, no tools. Old behavior: the turn
        // ended here silently (R77's carve-out reads the whole turn). New:
        // the plan is unfinished → ONE continuation nudge.
        yield { type: "text-delta", delta: "   \n\n" };
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } };
      } else {
        // The nudged call does the real work and concludes.
        yield { type: "text-delta", delta: "The summary is written. Task complete." };
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      }
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "read notes.txt and write the summary",
      () => undefined,
    );

    expect(outcome.ok).toBe(true);
    // The turn CONTINUED past the blank tail — three calls, not two.
    expect(streamCalls).toBe(3);
    // The nudge rode the third call's in-memory messages (never persisted).
    const thirdRequest = seenRequests[2];
    expect(thirdRequest.some((m) => m.content.includes("empty (no text, no tool calls)"))).toBe(true);
    expect(
      listSessionEvents(db, sessionId).some(
        (e) => e.type === "message.user" && (e.payload as { content?: string }).content?.includes("empty (no text"),
      ),
    ).toBe(false);
  });

  it("a SECOND blank after the nudge falls back to the R77 carve-out (bounded once per turn)", async () => {
    const { sessionId, keyring, agentId } = setup("R120H-BlankTail2");
    seedUnfinishedTodos(sessionId, agentId);
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield { type: "tool-call", toolName: "read_file", argsSummary: "path: n.txt", args: { path: "n.txt" } };
        yield {
          type: "tool-result",
          toolName: "read_file",
          argsSummary: "path: n.txt",
          args: { path: "n.txt" },
          ok: true,
          outputSummary: "n",
        };
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      } else {
        // Blank forever (the flake persisting) — one nudge, then the
        // tools-did-the-work reading ends the turn (r77's pinned law).
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } };
      }
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "read n.txt",
      () => undefined,
    );

    expect(streamCalls).toBe(3); // 1 (tools) + 2 (blank, blank) — bounded
    expect(outcome.ok).toBe(true);
  });
});

// ── 4. THE STALL WATCHDOG's live-activity leg (the healthy-long-tool reap) ──

describe("R120-H item 43: the child stall watchdog vs a healthy long tool run", () => {
  /** The exact shape the event log shows mid-run_command: one persisted
   * tool.use (the PREVIOUS command), then a long silent stretch while the
   * current command streams terminal chunks over SSE (nothing persists
   * until it finishes). */
  function seedChildWithToolUse(name: string): string {
    const { sessionId, agentId } = setup(name);
    appendSessionEvent(db, sessionId, {
      type: "tool.use",
      agentId,
      payload: {
        role: "tool",
        toolName: "run_command",
        argsSummary: "command: npm test",
        ok: true,
        outputSummary: "all tests passed",
      },
    });
    return sessionId;
  }

  it("a child with LIVE emit activity inside the threshold is NEVER stall-reaped — even when the event log has gone silent past the threshold", () => {
    const sessionId = seedChildWithToolUse("R120H-Watch1");
    const now = Date.now();
    // The last persisted event is 10 minutes old (a long build command is
    // running) and the run started 10 minutes ago — the RAW R52-b/R107-b
    // signal would call this stalled at the 60s threshold used here.
    db.prepare("UPDATE session_events SET ts = ? WHERE session_id = ?").run(
      new Date(now - 10 * 60_000).toISOString().replace("T", " ").replace("Z", ""),
      sessionId,
    );
    // …but the forwarding emit pushed a terminal chunk 5 s ago: LIVE.
    const watch = sampleChildWatch(db, sessionId, now - 10 * 60_000, 60_000, 0, 1, now - 5_000);
    expect(watch.stalled).toBe(false);
    // The raw event age stays honest (the panel still shows the truth).
    expect(watch.lastEventAgeMs).toBeGreaterThan(9 * 60_000);
  });

  it("a child whose live activity ALSO went silent past the threshold still stalls (the genuine-hang shape is unchanged)", () => {
    const sessionId = seedChildWithToolUse("R120H-Watch2");
    const now = Date.now();
    db.prepare("UPDATE session_events SET ts = ? WHERE session_id = ?").run(
      new Date(now - 10 * 60_000).toISOString().replace("T", " ").replace("Z", ""),
      sessionId,
    );
    // No emit activity for 10 minutes either — a real hang.
    expect(sampleChildWatch(db, sessionId, now - 10 * 60_000, 60_000, 0, 1, now - 10 * 60_000).stalled).toBe(true);
  });

  it("channel-less children (no liveActivityAt) keep the exact R107-b semantics", () => {
    const sessionId = seedChildWithToolUse("R120H-Watch3");
    const now = Date.now();
    db.prepare("UPDATE session_events SET ts = ? WHERE session_id = ?").run(
      new Date(now - 10 * 60_000).toISOString().replace("T", " ").replace("Z", ""),
      sessionId,
    );
    // No liveActivityAt argument at all — the pre-R120-H call shape.
    expect(sampleChildWatch(db, sessionId, now - 10 * 60_000, 60_000, 0, 1).stalled).toBe(true);
    // Fresh events + a fresh start stay healthy without the leg.
    const fresh = seedChildWithToolUse("R120H-Watch4");
    expect(sampleChildWatch(db, fresh, now - 30_000, 60_000, 0, 1).stalled).toBe(false);
  });
});

// ── 5. ITEM 44: the "continue" resume path (the re-read-everything fix) ─────

describe("R120-H item 44: the resume planners (pure)", () => {
  it("isResumeRequest: the bare-resume vocabulary — and real content is a NEW instruction, never a resume", () => {
    for (const yes of ["continue", "Continue.", "go on", "keep going", "carry on", "resume", "proceed", "继续", "继续任务", "接着做", "  continue  ", "continue!"]) {
      expect(isResumeRequest(yes)).toBe(true);
    }
    for (const no of ["continue reading the file", "now write the summary", "继续，然后写总结", "go on and check the build", ""]) {
      expect(isResumeRequest(no)).toBe(false);
    }
  });

  it("buildResumeContextNote: the read/write/run/other buckets, the cap, and the do-not-re-read law", () => {
    const note = buildResumeContextNote(
      [
        { toolName: "read_file", argsSummary: "path: notes/a.txt" },
        { toolName: "search_files", argsSummary: "query: TODO" },
        { toolName: "write_file", argsSummary: "path: notes/b.txt, content: 12 chars" },
        { toolName: "run_command", argsSummary: "command: npm test" },
        { toolName: "todo_write", argsSummary: "3 todos" },
      ],
      40,
    );
    expect(note).toContain("[Resume context");
    expect(note).toContain("already read (contents above): read_file: notes/a.txt; search_files: query: TODO");
    expect(note).toContain("already wrote/edited: write_file: notes/b.txt");
    expect(note).toContain("commands already run: command: npm test");
    expect(note).toContain("other tools already run: todo_write: 3 todos");
    expect(note).toContain("do not re-read files whose contents you already have");
    expect(note).toContain("The most recent 40 tool results above are in full");
    // The cap: 30 lines named, the overflow line honest.
    const many = Array.from({ length: 33 }, (_, i) => ({ toolName: "read_file", argsSummary: `path: f${i}.txt` }));
    const capped = buildResumeContextNote(many, 40);
    expect(capped).toContain("and 3 more earlier tool calls");
  });

  it("planResumeTurnContext: null unless the send is a bare resume AND the prior turn did tool work", () => {
    const userMsg = (seq: number): SessionEvent => ({
      seq,
      type: "message.user",
      agentId: "agt",
      payload: { role: "user", content: "do the thing" },
      ts: new Date(0).toISOString(),
    });
    const toolUse = (seq: number, path: string): SessionEvent => ({
      seq,
      type: "tool.use",
      agentId: "agt",
      payload: { role: "tool", toolName: "read_file", argsSummary: `path: ${path}`, ok: true, outputSummary: "x" },
      ts: new Date(0).toISOString(),
    });
    // A real instruction → null (the ordinary assembly).
    expect(planResumeTurnContext([userMsg(1), toolUse(2, "a.txt")], "now write the summary")).toBeNull();
    // A resume with NO prior tool work → null (nothing to hand over).
    expect(planResumeTurnContext([userMsg(1)], "continue")).toBeNull();
    // The resume shape: the tail after the last message.user is the prior
    // turn's tool work, and the note names it.
    const planned = planResumeTurnContext([userMsg(1), toolUse(2, "a.txt"), toolUse(3, "b.txt")], "continue");
    expect(planned).not.toBeNull();
    expect(planned?.recentToolResults).toBe(40);
    expect(planned?.note).toContain("read_file: a.txt");
    expect(planned?.note).toContain("read_file: b.txt");
    expect(planned?.note).toContain("do not re-read files");
  });

  it("assembleHistory's widened fidelity window: the resume window keeps older tool results in-full where the default stubs them", () => {
    const { sessionId, agentId } = setup("R120H-Window");
    // 12 tool reads, each with a >200-char result: the default window keeps
    // only the LAST 8 in-full; the resume window (40) keeps all 12.
    for (let i = 0; i < 12; i += 1) {
      appendSessionEvent(db, sessionId, {
        type: "tool.use",
        agentId,
        payload: {
          role: "tool",
          toolName: "read_file",
          argsSummary: `path: file-${i}.txt`,
          ok: true,
          outputSummary: `FILE-${i} CONTENT `.repeat(20) + `TAIL-${i}`,
        },
      });
    }
    const defaultHistory = assembleHistory(db, sessionId);
    const defaultJoined = defaultHistory.map((m) => m.content).join("\n");
    expect(defaultJoined).toContain("TAIL-11"); // newest 8: 4..11
    expect(defaultJoined).not.toContain("TAIL-3"); // stubbed at 200 chars
    expect(defaultJoined).toContain("[older result truncated]");
    const resumeHistory = assembleHistory(db, sessionId, { recentToolResults: 40 });
    const resumeJoined = resumeHistory.map((m) => m.content).join("\n");
    for (let i = 0; i < 12; i += 1) {
      expect(resumeJoined).toContain(`TAIL-${i}`); // every result in-full
    }
    expect(resumeJoined).not.toContain("[older result truncated]");
  });
});

describe("R120-H item 44: the END-TO-END resume turn ('continue' after a mid-work stop)", () => {
  it("a 'continue' after the ITERATION_LIMIT stop rides the FULL prior tool results + the never-persisted context note — the model re-reads nothing", async () => {
    const { sessionId, keyring } = setup("R120H-Resume");
    const longBody = (i: number): string => `FILE-${i} ${"x".repeat(300)} TAIL-${i}`;

    // Turn 1 — the owner's exact shape: the model reads files every
    // iteration and never yields final text, so the budget runs out
    // mid-work (the honest ITERATION_LIMIT stop).
    let turn1Calls = 0;
    const turn1Stream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      turn1Calls += 1;
      yield { type: "tool-call", toolName: "read_file", argsSummary: `path: file-${turn1Calls}.txt`, args: { path: `file-${turn1Calls}.txt` } };
      yield {
        type: "tool-result",
        toolName: "read_file",
        argsSummary: `path: file-${turn1Calls}.txt`,
        args: { path: `file-${turn1Calls}.txt` },
        ok: true,
        outputSummary: longBody(turn1Calls),
      };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };
    const turn1 = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream: turn1Stream },
      sessionId,
      "read all the files",
      () => undefined,
    );
    expect(turn1Calls).toBe(5);
    expect(turn1.ok).toBe(false);
    if (!turn1.ok) expect(turn1.code).toBe("ITERATION_LIMIT");

    // Turn 2 — the owner's "continue". The mock model is the oracle: it
    // asserts its OWN request and answers from context without a single
    // tool call.
    let resumeRequest: Array<{ role: string; content: string }> | null = null;
    const turn2Stream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      resumeRequest = input.messages.map((m) => ({ role: m.role, content: m.content }));
      // The oracle answers from context — the resume must make re-reading
      // unnecessary, and the mock never calls a tool.
      yield { type: "text-delta", delta: "Resumed from context — file 5's tail is TAIL-5. Task complete." };
      yield { type: "finish", usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } };
    };
    const turn2 = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream: turn2Stream },
      sessionId,
      "continue",
      () => undefined,
    );

    expect(turn2.ok).toBe(true);
    const request: Array<{ role: string; content: string }> = resumeRequest ?? [];
    const joined = request.map((m) => m.content).join("\n");
    // (a) The PRIOR TOOL RESULTS ride in-full — the widened window (not the
    // 200-char stubs): the tail marker of the OLDEST read (file 1) is
    // present verbatim.
    expect(joined).toContain("TAIL-1");
    expect(joined).toContain("TAIL-5");
    // (b) The deterministic RESUME NOTE rides the request (in-memory)…
    expect(joined).toContain("[Resume context");
    expect(joined).toContain("already read (contents above): read_file: file-1.txt");
    expect(joined).toContain("do not re-read files whose contents you already have");
    // …but NEVER the event log (the note is not a message.user).
    const persisted = listSessionEvents(db, sessionId);
    expect(
      persisted.some((e) => e.type === "message.user" && String((e.payload as { content?: string }).content).includes("[Resume context")),
    ).toBe(false);
    // (c) The follow-up genuinely completed — a real final answer.
    if (turn2.ok) {
      expect(turn2.assistantMessage.content).toContain("TAIL-5");
    }
  });

  it("a 'continue' with NO prior tool work is the ordinary assembly (no note, no widened window)", async () => {
    const { sessionId, keyring } = setup("R120H-Resume2");
    // Turn 1: a plain conversational answer, no tools.
    const turn1Stream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "Hello — what would you like me to do?" };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };
    await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream: turn1Stream },
      sessionId,
      "hello",
      () => undefined,
    );
    // Turn 2: "continue" — nothing to hand over, the note must NOT ride.
    let joined2 = "";
    const turn2Stream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      joined2 = input.messages.map((m) => m.content).join("\n");
      yield { type: "text-delta", delta: "There is nothing in progress to continue — give me a task. Task complete." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };
    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream: turn2Stream },
      sessionId,
      "continue",
      () => undefined,
    );
    expect(outcome.ok).toBe(true);
    expect(joined2).not.toContain("[Resume context");
  });
});
