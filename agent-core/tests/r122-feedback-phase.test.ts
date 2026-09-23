/**
 * ROUND-122 — the SELF-FEEDBACK PHASE on the streamed turn route
 * (POST /sessions/:id/messages/stream): the post-turn ledger writer,
 * wired at the route level through the REAL server (buildServer) with
 * only the AI SDK mocked at the module boundary (the r58 hermetic
 * pattern — streamText drives the turn, generateText drives the
 * reporter's one-shot call).
 *
 *   1. OFF (the default): an ok turn writes NO ledger, spends NO extra
 *      model call — the phase is a total no-op.
 *   2. ON + an OK turn: after the stream closes, ONE detached reporter
 *      call → ONE ledger entry (machine header + the model's body, the
 *      header carrying the ok outcome + the agent's provider/model);
 *      ZERO feedback frames in the SSE body; ZERO feedback session
 *      events (the conversation stays clean — the owner's separation
 *      contract); the reporter's spend recorded with origin 'feedback';
 *      the done frame still the LAST frame (the phase never touches the
 *      stream's lifecycle).
 *   3. ON + a REAL failure (the turn's provider 500s): the entry still
 *      lands — the header carries the failed outcome, and the
 *      transcript the reporter received carries the persisted ERROR
 *      line (the debug analyst's exact ≥500 gate).
 *   4. ON + a validation 404 (unknown session): no phase at all — a
 *      turn that never ran has nothing to report.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The real adapter with ONLY the AI SDK mocked at the module boundary
// (the r58 pattern; generateText joins the factory because the feedback
// reporter rides the SYNC chat adapter).
const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));

import { listSessionEvents } from "../src/storage/sessions";
import { setFeedbackSettings } from "../src/storage/settings";
import { readFeedbackLedger } from "../src/storage/feedback-ledger";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r122phase";
const KEY = "sk-or-vtest-r122phase";

const tempDir = mkdtempSync(join(tmpdir(), "acute-r122phase-"));
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    dataDir,
  });
  streamTextMock.mockReset();
  generateTextMock.mockReset();
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

async function createSession(): Promise<string> {
  const agentRes = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "Chat Agent",
      systemPrompt: "You are terse.",
      providerId: "openrouter",
      model: "test/model-1",
      temperature: 0.2,
      maxTurns: 8,
    },
  });
  expect(agentRes.statusCode).toBe(201);
  const agent = agentRes.json() as { id: string };
  const sessionRes = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { agentId: agent.id, mode: "single" },
  });
  expect(sessionRes.statusCode).toBe(202);
  return (sessionRes.json() as { id: string }).id;
}

/** Parse the hijacked SSE body into its data frames. */
function parseSse(body: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
  }
  return frames;
}

/** POST a message through the streamed route and return the SSE frames. */
async function streamTurn(sessionId: string, content: string): Promise<Array<Record<string, unknown>>> {
  const response = await authInject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/messages/stream`,
    payload: { content },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  return parseSse(response.body as string);
}

/** The main turn's provider stream (call 1): one tool round-trip + a
 * completion-signaled text (the r58 turnStream shape). */
const turnStream = (): { fullStream: AsyncGenerator<Record<string, unknown>>; totalUsage: Promise<unknown>; usage: Promise<unknown> } => ({
  fullStream: (async function* () {
    yield { type: "tool-call", toolName: "write_file", input: { path: "a.txt", content: "hi" } };
    yield {
      type: "tool-result",
      toolName: "write_file",
      input: { path: "a.txt", content: "hi" },
      output: { ok: true, output: "wrote 2 bytes" },
    };
    yield { type: "text-delta", text: "Task completed. The file is written." };
    yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 10 } };
  })(),
  totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
  usage: Promise.resolve({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
});

/** The REPORTER's generateText result (the sync adapter's read surface). */
const REPORT_TEXT = [
  "### What I was trying to do",
  "Create a.txt with the content hi.",
  "",
  "### What actually happened",
  "write_file returned ok; the turn completed.",
  "",
  "### Issues & problems encountered",
  "Nothing to report.",
  "",
  "### Glitches & anomalies noticed",
  "Nothing to report.",
  "",
  "### Expectations vs reality",
  "Met expectations.",
  "",
  "### Suggested improvements",
  "None this turn.",
].join("\n");

function reporterResult(text = REPORT_TEXT): Record<string, unknown> {
  return {
    text,
    usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
    steps: [],
  };
}

/** The phase is fire-and-forget — poll the ledger until the entry lands. */
async function waitForEntry(timeoutMs = 4000): Promise<ReturnType<typeof readFeedbackLedger>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ledger = readFeedbackLedger(dataDir);
    if (ledger.entries > 0) return ledger;
    if (Date.now() > deadline) throw new Error("waitForEntry: the ledger entry never landed");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("R122: the self-feedback phase on the stream route", () => {
  it("OFF (the default): an ok turn writes NO ledger and spends NO extra model call", async () => {
    const sessionId = await createSession();
    streamTextMock.mockImplementation(() => turnStream());

    const frames = await streamTurn(sessionId, "create a.txt");
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(frames[frames.length - 1]).toMatchObject({ type: "done" });
    // Give the (disabled) phase a moment to prove its absence, then assert.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readFeedbackLedger(dataDir).exists).toBe(false);
  });

  it("ON + an OK turn: one entry after the stream, ZERO feedback frames, ZERO feedback events, usage origin feedback, done still last", async () => {
    const sessionId = await createSession();
    setFeedbackSettings(db, { enabled: true });
    streamTextMock.mockImplementation(() => turnStream());
    generateTextMock.mockImplementation(() => reporterResult());

    const frames = await streamTurn(sessionId, "create a.txt");

    // (a) The stream itself is UNTOUCHED: no feedback frames of any kind,
    // and the done frame is still the terminal frame.
    const types = frames.map((f) => f.type);
    for (const type of types) {
      expect(String(type).toLowerCase().includes("feedback")).toBe(false);
    }
    expect(types[types.length - 1]).toBe("done");

    // (b) The reporter ran ONCE, no-tools, with the six-heading system
    // prompt and the WHOLE transcript as the single user message.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0] as {
      system?: string;
      messages?: Array<{ role: string; content: string }>;
      tools?: unknown;
    };
    expect(call.tools).toBeUndefined();
    expect(call.system).toContain("### What I was trying to do");
    expect(call.system).toContain("### Suggested improvements");
    expect(call.messages).toHaveLength(1);
    expect(call.messages?.[0].content).toContain("create a.txt");
    expect(call.messages?.[0].content).toContain("TOOL write_file");

    // (c) The ledger entry: machine header (ok outcome, the agent's
    // provider/model) + the model's six-section body.
    const ledger = await waitForEntry();
    expect(ledger.entries).toBe(1);
    expect(ledger.content).toContain("- **Session**:");
    expect(ledger.content).toContain("- **Agent**: Chat Agent · openrouter/test/model-1");
    expect(ledger.content).toContain("- **Turn outcome**: ok");
    expect(ledger.content).toContain("### What I was trying to do");
    expect(ledger.content).toContain("None this turn.");

    // (d) The conversation stays CLEAN: no feedback-shaped session event
    // (and no debug.report either — debug is off).
    const eventTypes = listSessionEvents(db, sessionId).map((e) => e.type);
    for (const type of eventTypes) {
      expect(String(type).toLowerCase().includes("feedback")).toBe(false);
    }
    expect(eventTypes).not.toContain("debug.report");

    // (e) The reporter's spend: ONE usage row with origin 'feedback'.
    const rows = db
      .prepare("SELECT origin, provider, model FROM usage_events WHERE origin = 'feedback'")
      .all() as Array<{ origin: string; provider: string; model: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "feedback", provider: "openrouter", model: "test/model-1" });

    // (f) The setting row stays OFF-neutral: the phase read it live, it
    // was never mutated by the phase itself.
    expect(setFeedbackSettings(db, {})).toEqual({ enabled: true });
  });

  it("ON + a REAL failure (the turn's provider 500s): the entry still lands, with the failed outcome and the ERROR line in the transcript", async () => {
    const sessionId = await createSession();
    setFeedbackSettings(db, { enabled: true });
    streamTextMock.mockImplementation(() => {
      throw new Error("the turn's provider 500'd");
    });
    generateTextMock.mockImplementation(() => reporterResult("### What I was trying to do\nThe request that failed.\n\n### What actually happened\nThe provider 500'd.\n\n### Issues & problems encountered\nPROVIDER_ERROR on every attempt.\n\n### Glitches & anomalies noticed\nNothing to report.\n\n### Expectations vs reality\nNot met.\n\n### Suggested improvements\nNone this turn."));

    const frames = await streamTurn(sessionId, "create a.txt");
    // The turn failed for real: the terminal frame is error.
    expect(frames[frames.length - 1]).toMatchObject({ type: "error" });

    // The entry landed with the FAILED outcome, and the transcript the
    // reporter received carried the persisted ERROR line.
    const ledger = await waitForEntry();
    expect(ledger.entries).toBe(1);
    expect(ledger.content).toContain("- **Turn outcome**: failed (");
    const call = generateTextMock.mock.calls[0][0] as { messages?: Array<{ content: string }> };
    expect(call.messages?.[0].content).toContain("ERROR ");

    // The failure event is persisted (the honest transcript) but NO
    // feedback-shaped event exists.
    const eventTypes = listSessionEvents(db, sessionId).map((e) => e.type);
    expect(eventTypes).toContain("turn.error");
    for (const type of eventTypes) {
      expect(String(type).toLowerCase().includes("feedback")).toBe(false);
    }
  });

  it("ON + a validation failure (unknown session): no phase at all — a turn that never ran has nothing to report", async () => {
    setFeedbackSettings(db, { enabled: true });
    streamTextMock.mockImplementation(() => turnStream());
    generateTextMock.mockImplementation(() => reporterResult());

    const response = await authInject({
      method: "POST",
      url: "/api/v1/sessions/sess_does-not-exist/messages/stream",
      payload: { content: "hello" },
    });
    // The unknown session is refused INSIDE the stream (the SSE contract:
    // the route is already streaming when the guard fires) — an honest
    // error frame, never a done.
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    expect(frames[frames.length - 1]).toMatchObject({ type: "error" });
    expect(frames.map((f) => f.type)).not.toContain("done");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(readFeedbackLedger(dataDir).exists).toBe(false);
  });
});
