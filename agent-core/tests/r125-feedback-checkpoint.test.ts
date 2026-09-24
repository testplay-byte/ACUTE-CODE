/**
 * ROUND-125 (R125-B) — the MID-TURN CHECKPOINT + the STATUS frames on the
 * streamed turn route (POST /sessions/:id/messages/stream), wired through
 * the REAL server (buildServer) with only the AI SDK mocked at the module
 * boundary (the r122-feedback-phase hermetic pattern — streamText drives
 * the turn, generateText drives every reporter call).
 *
 *   1. THE CHECKPOINT FIRES: a turn whose stream yields THREE failed
 *      tool-results (ok:false) and then STAYS IN FLIGHT past the settle
 *      window arms exactly ONE mid-turn checkpoint — the SSE body carries
 *      the meta.feedback STATUS frames (writing → written, phase
 *      "mid-turn", the live entry count), the ledger gains the checkpoint
 *      entry (the Phase line + the "in flight" outcome + the banner-led
 *      transcript the reporter received), the turn's own done frame is
 *      still the LAST frame, and NO entry content ever rides a frame (the
 *      separation law — status only). After the stream closes, the
 *      turn-end phase appends its own entry (no Phase line) and its
 *      meta.feedback frames ride the EVENTS BUS only (the phone-mirror
 *      path — the initiator's body stays clean).
 *   2. THE SETTLE GUARD: three failures immediately followed by the turn's
 *      finish stand the checkpoint DOWN (the stream closes inside the ~2 s
 *      window — the turn-end entry covers it): no mid-turn entry, no
 *      feedback frames in the body, exactly one turn-end entry.
 *   3. THE ENABLED GATE (default OFF): a troubled turn that outlives the
 *      settle window with the toggle OFF never launches the checkpoint —
 *      no reporter call, no entry, no frames.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The real adapter with ONLY the AI SDK mocked at the module boundary
// (the r122 pattern; generateText serves every reporter call — the
// checkpoint's AND the turn-end phase's).
const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));

import { setFeedbackSettings } from "../src/storage/settings";
import { readFeedbackLedger } from "../src/storage/feedback-ledger";
import { getEventsBus } from "../src/lib/events-bus";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { FEEDBACK_CHECKPOINT_SETTLE_MS } from "../src/agents/feedback-status";

const TOKEN = "test-token-r125checkpoint";
const KEY = "sk-or-vtest-r125checkpoint";

const tempDir = mkdtempSync(join(tmpdir(), "acute-r125checkpoint-"));
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

/** A TROUBLED turn's provider stream: `failures` failed tool round-trips
 * (ok:false — what the route's send() counter watches), then an optional
 * in-flight HOLD (the turn stays open past the checkpoint's settle window),
 * then the completion text. */
const troubledStream = (failures: number, holdMs: number): { fullStream: AsyncGenerator<Record<string, unknown>>; totalUsage: Promise<unknown>; usage: Promise<unknown> } => ({
  fullStream: (async function* () {
    for (let i = 0; i < failures; i += 1) {
      yield { type: "tool-call", toolName: "terminal", input: { command: `npm test ${i}` } };
      yield {
        type: "tool-result",
        toolName: "terminal",
        input: { command: `npm test ${i}` },
        output: { ok: false, output: "exit 1 — the suite exploded" },
      };
    }
    if (holdMs > 0) {
      // The hold keeps the TURN in flight (the checkpoint's settle window
      // expires while the runtime is still awaiting the provider stream).
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    }
    yield { type: "text-delta", text: "Recovered — reporting honestly." };
    yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 10 } };
  })(),
  totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
  usage: Promise.resolve({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
});

/** The reporter's generateText result (the sync adapter's read surface). */
const REPORT_TEXT = [
  "### What I was trying to do",
  "Run the failing suite and fix it.",
  "",
  "### What actually happened",
  "Nothing to report.",
  "",
  "### Issues & problems encountered",
  "terminal failed repeatedly.",
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

function reporterResult(): Record<string, unknown> {
  return {
    text: REPORT_TEXT,
    usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
    steps: [],
  };
}

/** The phases are fire-and-forget — poll the ledger until N entries land. */
async function waitForEntries(count: number, timeoutMs = 4000): Promise<ReturnType<typeof readFeedbackLedger>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ledger = readFeedbackLedger(dataDir);
    if (ledger.entries >= count) return ledger;
    if (Date.now() > deadline) throw new Error(`waitForEntries: only ${ledger.entries}/${count} entries landed`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("R125-B: the mid-turn checkpoint on the stream route", () => {
  it("three failed tool-results + the turn still in flight → ONE checkpoint entry + the STATUS frames in the body + the turn-end entry after close", async () => {
    const sessionId = await createSession();
    setFeedbackSettings(db, { enabled: true });
    // 5 failures (the threshold crosses at 3 — the extra two pin the
    // ONE-checkpoint-per-turn latch), held open well past the settle window.
    streamTextMock.mockImplementation(() => troubledStream(5, FEEDBACK_CHECKPOINT_SETTLE_MS + 1200));
    generateTextMock.mockImplementation(() => reporterResult());

    // The events-bus mirror: the turn-end phase's frames land here AFTER
    // the stream closes (the phone-mirror path R125-B documents).
    const busFrames: Array<Record<string, unknown>> = [];
    const unsubscribe = getEventsBus().subscribe((frame) => {
      const f = frame as unknown as Record<string, unknown>;
      if (f.type === "turn") {
        const inner = f.frame as Record<string, unknown> | undefined;
        if (inner !== undefined && inner.type === "meta.feedback") busFrames.push(inner);
      }
    });

    try {
      const frames = await streamTurn(sessionId, "run the tests and fix them");

      // (a) The STATUS frames in the OWN stream's body — writing → written,
      // phase "mid-turn", the live entry count; and NOTHING ELSE (the
      // frames carry status only — no section headings, no entry body).
      const feedbackFrames = frames.filter((f) => f.type === "meta.feedback");
      expect(feedbackFrames).toHaveLength(2);
      expect(feedbackFrames[0]).toMatchObject({ sessionId, stage: "writing", phase: "mid-turn" });
      expect(feedbackFrames[1]).toMatchObject({ sessionId, stage: "written", phase: "mid-turn", entries: 1 });
      const serialized = JSON.stringify(feedbackFrames);
      expect(serialized).not.toContain("What I was trying to do");
      expect(serialized).not.toContain("terminal failed repeatedly");

      // (b) The turn's own terminal frame is STILL the last body frame —
      // the checkpoint never touches the stream's lifecycle.
      expect(frames[frames.length - 1]).toMatchObject({ type: "done" });

      // (c) The checkpoint entry: the Phase line + the in-flight outcome +
      // the banner-led transcript (the first reporter call).
      expect(generateTextMock).toHaveBeenCalledTimes(2);
      const checkpointCall = generateTextMock.mock.calls[0][0] as {
        system?: string;
        messages?: Array<{ content: string }>;
        tools?: unknown;
      };
      expect(checkpointCall.tools).toBeUndefined();
      expect(checkpointCall.system).toContain("MID-TURN CHECKPOINTS (ROUND-125)");
      expect(checkpointCall.messages?.[0].content.startsWith("NOTE: this is a PARTIAL turn (mid-turn checkpoint)")).toBe(true);
      expect(checkpointCall.messages?.[0].content).toContain("TOOL terminal");
      const ledger = await waitForEntries(2);
      expect(ledger.entries).toBe(2);
      expect(ledger.content).toContain("- **Phase**: mid-turn checkpoint (turn still in flight)");
      expect(ledger.content).toContain("- **Turn outcome**: in flight (mid-turn checkpoint)");
      // ONE checkpoint only (the 4th and 5th failures did not re-arm).
      expect(ledger.content.split("- **Phase**: mid-turn checkpoint").length - 1).toBe(1);
      // The turn-end entry (the second reporter call) carries NO banner and
      // NO Phase line — the R122 format, byte-identical.
      const turnEndCall = generateTextMock.mock.calls[1][0] as { messages?: Array<{ content: string }> };
      expect(turnEndCall.messages?.[0].content.startsWith("NOTE: this is a PARTIAL turn")).toBe(false);
      expect(ledger.content).toContain("- **Turn outcome**: ok");
      expect(ledger.content).not.toContain("- **Phase**: turn-end");

      // (d) The turn-end phase's frames rode the EVENTS BUS (published
      // after res.end() — the initiator's body never sees them, but the
      // phone mirror / desktop watcher does): writing + written, phase
      // "turn-end", the 2-entry count.
      const turnEndFrames = busFrames.filter((f) => f.phase === "turn-end");
      expect(turnEndFrames.map((f) => f.stage)).toEqual(["writing", "written"]);
      expect(turnEndFrames[1]).toMatchObject({ entries: 2 });

      // (e) R83 discipline: BOTH reporter calls metered (origin feedback).
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE origin = 'feedback'")
        .all() as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  it("the SETTLE GUARD: failures immediately followed by the turn's finish stand the checkpoint down (the turn-end entry covers it)", async () => {
    const sessionId = await createSession();
    setFeedbackSettings(db, { enabled: true });
    // The turn finishes ~instantly after the 3rd failure — inside the
    // settle window, so the checkpoint's timer is cancelled at close.
    streamTextMock.mockImplementation(() => troubledStream(3, 0));
    generateTextMock.mockImplementation(() => reporterResult());

    const frames = await streamTurn(sessionId, "run the tests");
    // ZERO feedback frames in the body — the checkpoint never launched, and
    // the turn-end phase's frames ride the events bus only (after close).
    expect(frames.filter((f) => f.type === "meta.feedback")).toHaveLength(0);
    expect(frames[frames.length - 1]).toMatchObject({ type: "done" });
    // Exactly ONE entry — the turn-end summary (no Phase line, no banner).
    const ledger = await waitForEntries(1);
    await new Promise((resolve) => setTimeout(resolve, 150)); // let any stray checkpoint prove its absence
    expect(readFeedbackLedger(dataDir).entries).toBe(1);
    expect(ledger.content).not.toContain("- **Phase**");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0] as { messages?: Array<{ content: string }> };
    expect(call.messages?.[0].content.startsWith("NOTE: this is a PARTIAL turn")).toBe(false);
  });

  it("the ENABLED GATE (default OFF): a troubled turn that outlives the settle window never launches the checkpoint", async () => {
    const sessionId = await createSession();
    // The toggle stays OFF (the default). The turn outlives the settle
    // window so the timer DOES fire — and the enabled gate inside the
    // launcher is what refuses (not the timer cancel).
    streamTextMock.mockImplementation(() => troubledStream(3, FEEDBACK_CHECKPOINT_SETTLE_MS + 400));
    generateTextMock.mockImplementation(() => reporterResult());

    const frames = await streamTurn(sessionId, "run the tests");
    expect(frames.filter((f) => f.type === "meta.feedback")).toHaveLength(0);
    // Give the (disabled) checkpoint a moment to prove its absence.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(readFeedbackLedger(dataDir).exists).toBe(false);
  });
});
