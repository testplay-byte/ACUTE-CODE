/**
 * ROUND-122 — the SELF-FEEDBACK LEDGER + REPORTER (agents/feedback-writer.ts
 * + storage/feedback-ledger.ts), pinned at the unit level:
 *
 *   1. LEDGER FILE — the honest empty state; the first append creates the
 *      file WITH its fixed header; entries accumulate whole (the
 *      serialized write chain guarantees no interleaving); clear wipes
 *      with the honest count; the events bus gets a settings-domain frame
 *      after every append/clear.
 *   2. ENTRY HEADER — the machine-written metadata block (session,
 *      project, agent/model, outcome, transcript size) rendered exactly;
 *      the null-safe branches (no project, no title).
 *   3. THE REPORTER — happy path (a real transcript from real session
 *      events → ONE fresh no-tools model call → the ledger carries header
 *      + the model's six-section body); the empty-transcript skip (no
 *      model call, no file); provider failure (never throws, error
 *      scrubbed of the API key); the empty-reply refusal; keyring-secret
 *      scrubbing of the transcript the model receives; the usage
 *      passthrough.
 *   4. ROUND-125 (R125-B) — the PHASE param + the STATUS bookkeeping: the
 *      mid-turn checkpoint's header Phase line + transcript banner + the
 *      prompt's checkpoint paragraph; the turn-end format staying
 *      byte-identical (phase omitted vs undefined); the registry's
 *      writing flag true DURING the model call and false + lastWriteTs/
 *      lastEntries after; and the early-return paths never stranding
 *      writing=true (the owner's "it did not show me the info of when it
 *      was being written" — the writer itself is now the source of that
 *      info).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendFeedbackEntry, clearFeedbackLedger, readFeedbackLedger, FEEDBACK_FILE_NAME } from "../src/storage/feedback-ledger";
import { buildFeedbackEntryHeader, runFeedbackWriter } from "../src/agents/feedback-writer";
// R125-B: the registry the writer reports into — read live DURING the fake
// chat's await to pin the in-flight writing state.
import { readFeedbackStatus, type FeedbackWriterStatus } from "../src/agents/feedback-status";
import { getEventsBus } from "../src/lib/events-bus";
import { appendSessionEvent } from "../src/storage/sessions";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import type { ChatFn } from "../src/agents/chat";

const KEY = "sk-or-vtest-r122writer";
const SECRET = "sk-secret-r122-0123456789abcdef";

const tempDir = mkdtempSync(join(tmpdir(), "acute-r122writer-"));
let dataDir = "";

beforeEach(() => {
  // A fresh dataDir per test: every ledger assertion starts from the
  // honest empty state, and one test's file can never leak into the next.
  dataDir = mkdtempSync(join(tempDir, "data-"));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** A no-tools fake ChatFn that records its inputs and returns a canned report. */
function fakeChat(text: string): { chat: ChatFn; inputs: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  const chat: ChatFn = async (input) => {
    inputs.push(input as unknown as Record<string, unknown>);
    return {
      text,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      toolCalls: [],
      finishReason: "stop",
      steps: [],
    };
  };
  return { chat, inputs };
}

/** A session with a REAL transcript: one user message, one tool round, one
 * assistant reply (the shapes appendSessionEvent persists). */
function sessionWithTranscript(db: SqliteDatabase, secretInToolOutput: boolean): string {
  const sessionId = `sess_${randomUUID()}`;
  appendSessionEvent(db, sessionId, {
    type: "message.user",
    agentId: null,
    payload: { content: "please fix the login bug" },
  });
  appendSessionEvent(db, sessionId, {
    type: "tool.use",
    agentId: null,
    payload: {
      toolName: "terminal",
      argsSummary: 'command: "npm test"',
      ok: true,
      outputSummary: secretInToolOutput ? `env leaked: ${SECRET}` : "3 passed",
    },
  });
  appendSessionEvent(db, sessionId, {
    type: "message.assistant",
    agentId: null,
    payload: { content: "The tests pass; the bug is fixed." },
  });
  return sessionId;
}

// ── 1. THE LEDGER FILE ───────────────────────────────────────────────────────

describe("R122: the feedback ledger file (storage/feedback-ledger.ts)", () => {
  it("read on a fresh directory: the honest empty state", () => {
    const ledger = readFeedbackLedger(dataDir);
    expect(ledger).toEqual({ exists: false, content: "", bytes: 0, updatedAt: null, entries: 0 });
  });

  it("the first append CREATES the file with its fixed header + the entry; meta is honest", async () => {
    await appendFeedbackEntry(dataDir, "## Entry — 2026-09-23T00:00:00.000Z\n\nbody one");
    const ledger = readFeedbackLedger(dataDir);
    expect(ledger.exists).toBe(true);
    expect(ledger.entries).toBe(1);
    expect(ledger.bytes).toBeGreaterThan(0);
    expect(ledger.updatedAt).not.toBeNull();
    // The cold-read contract: the file EXPLAINS ITSELF before the entries.
    expect(ledger.content.startsWith("# ACUTE-CODE — Agent Self-Feedback Ledger")).toBe(true);
    expect(ledger.content).toContain("never injected");
    // The separator + the entry body land after the header.
    expect(ledger.content).toContain("---");
    expect(ledger.content).toContain("## Entry — 2026-09-23T00:00:00.000Z");
    expect(ledger.content).toContain("body one");
  });

  it("entries accumulate whole — two appends, two headers, in order", async () => {
    await appendFeedbackEntry(dataDir, "## Entry — 2026-09-23T00:00:01.000Z\n\nfirst body");
    await appendFeedbackEntry(dataDir, "## Entry — 2026-09-23T00:00:02.000Z\n\nsecond body");
    const ledger = readFeedbackLedger(dataDir);
    expect(ledger.entries).toBe(2);
    expect(ledger.content.indexOf("first body")).toBeLessThan(ledger.content.indexOf("second body"));
  });

  it("CONCURRENT appends never interleave — the write chain serializes whole entries", async () => {
    const writes = Array.from({ length: 8 }, (_, i) =>
      appendFeedbackEntry(dataDir, `## Entry — 2026-09-23T00:00:0${i}.000Z\n\nbody-${i}`),
    );
    await Promise.all(writes);
    const ledger = readFeedbackLedger(dataDir);
    expect(ledger.entries).toBe(8);
    // Every entry's header is immediately followed by its own body (an
    // interleaved write would fuse headers to foreign bodies).
    const raw = readFileSync(join(dataDir, FEEDBACK_FILE_NAME), "utf8");
    for (let i = 0; i < 8; i += 1) {
      expect(raw).toContain(`## Entry — 2026-09-23T00:00:0${i}.000Z\n\nbody-${i}`);
    }
  });

  it("clear wipes the file and reports the honest entry count; clearing an absent file is a no-op", async () => {
    const absent = await clearFeedbackLedger(dataDir);
    expect(absent).toEqual({ entries: 0 });
    await appendFeedbackEntry(dataDir, "## Entry — a\n\none");
    await appendFeedbackEntry(dataDir, "## Entry — b\n\ntwo");
    const wiped = await clearFeedbackLedger(dataDir);
    expect(wiped).toEqual({ entries: 2 });
    expect(readFeedbackLedger(dataDir).exists).toBe(false);
  });

  it("every append and clear broadcasts a settings-domain frame on the events bus", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const unsubscribe = getEventsBus().subscribe((frame) => {
      const f = frame as unknown as Record<string, unknown>;
      if (f.type === "settings" && f.domain === "feedback") frames.push(f);
    });
    try {
      await appendFeedbackEntry(dataDir, "## Entry — c\n\nthree");
      await clearFeedbackLedger(dataDir);
      expect(frames.length).toBeGreaterThanOrEqual(2);
      // The frame carries the file META (the invalidation's payload), not
      // the content — the viewer refetches through GET /feedback/file.
      const appendFrame = frames[0] as { value?: Record<string, unknown> };
      expect(appendFrame.value).toMatchObject({ exists: true, entries: 1 });
      const clearFrame = frames[frames.length - 1] as { value?: Record<string, unknown> };
      expect(clearFrame.value).toMatchObject({ exists: false, entries: 0 });
    } finally {
      unsubscribe();
    }
  });
});

// ── 2. THE ENTRY HEADER ──────────────────────────────────────────────────────

describe("R122: the machine-written entry header (buildFeedbackEntryHeader)", () => {
  const base = {
    ts: "2026-09-23T12:00:00.000Z",
    sessionId: "sess_abc",
    projectName: "my-app",
    projectId: "proj_1",
    agentName: "default",
    providerId: "openrouter",
    model: "test/model-1",
    turnOutcome: "ok",
    eventCount: 42,
    truncated: false,
  };

  it("renders the full metadata block (titled session, named project, ok turn)", () => {
    const header = buildFeedbackEntryHeader({ ...base, sessionTitle: "Fix the login bug" });
    expect(header.split("\n")).toEqual([
      "## Entry — 2026-09-23T12:00:00.000Z",
      "",
      '- **Session**: "Fix the login bug" (sess_abc)',
      "- **Project**: my-app (proj_1)",
      "- **Agent**: default · openrouter/test/model-1",
      "- **Turn outcome**: ok",
      "- **Transcript**: 42 events · full",
    ]);
  });

  it("the null-safe branches: untitled session, no project, failed outcome, truncated transcript", () => {
    const header = buildFeedbackEntryHeader({
      ...base,
      sessionTitle: null,
      projectName: null,
      projectId: null,
      turnOutcome: "failed (PROVIDER_ERROR)",
      truncated: true,
    });
    expect(header).toContain("- **Session**: (untitled) (sess_abc)");
    expect(header).toContain("- **Project**: none");
    expect(header).toContain("- **Turn outcome**: failed (PROVIDER_ERROR)");
    expect(header).toContain("- **Transcript**: 42 events · truncated (head+tail)");
  });
});

// ── 3. THE REPORTER ──────────────────────────────────────────────────────────

describe("R122: the feedback reporter (runFeedbackWriter)", () => {
  it("happy path: one fresh no-tools model call; the ledger carries header + the model's body; usage passes through", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, false);
      const { chat, inputs } = fakeChat(
        "### What I was trying to do\nFix the login bug.\n\n### What actually happened\nThe tests pass.\n\n### Issues & problems encountered\nNothing to report.\n\n### Glitches & anomalies noticed\nNothing to report.\n\n### Expectations vs reality\nMet expectations.\n\n### Suggested improvements\nNone this turn.",
      );
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        {
          sessionId,
          sessionTitle: "Fix the login bug",
          projectId: null,
          projectName: null,
          agentName: "default",
          provider: { id: "openrouter", baseUrl: "https://example.test/v1", apiFormat: "chat-completions" },
          apiKey: KEY,
          model: "test/model-1",
          turnOutcome: "ok",
        },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, cachedInputTokens: null });
      }
      // ONE call, no tools, the whole transcript as the single user message.
      expect(inputs).toHaveLength(1);
      const input = inputs[0] as { system?: string; messages?: Array<{ role: string; content: string }>; tools?: unknown };
      expect(input.tools).toBeUndefined();
      expect(input.messages).toHaveLength(1);
      expect(input.messages?.[0].role).toBe("user");
      expect(input.messages?.[0].content).toContain("please fix the login bug");
      expect(input.messages?.[0].content).toContain("TOOL terminal(command: \"npm test\") → ok: 3 passed");
      // The system prompt carries the six exact headings (the file's
      // cold-read contract).
      expect(input.system).toContain("### What I was trying to do");
      expect(input.system).toContain("### Issues & problems encountered");
      expect(input.system).toContain("### Glitches & anomalies noticed");
      expect(input.system).toContain("### Expectations vs reality");
      expect(input.system).toContain("### Suggested improvements");
      // The ledger: header + model body, one entry.
      const ledger = readFeedbackLedger(dataDir);
      expect(ledger.entries).toBe(1);
      expect(ledger.content).toContain('- **Session**: "Fix the login bug"');
      expect(ledger.content).toContain("### What I was trying to do");
      expect(ledger.content).toContain("None this turn.");
    } finally {
      db.close();
    }
  });

  it("an EMPTY transcript is skipped honestly: no model call, no file, ok:false", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = `sess_${randomUUID()}`; // no events at all
      const { chat, inputs } = fakeChat("should never be called");
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        {
          sessionId,
          sessionTitle: null,
          projectId: null,
          projectName: null,
          agentName: "default",
          provider: { id: "openrouter", baseUrl: "https://example.test/v1" },
          apiKey: KEY,
          model: "test/model-1",
          turnOutcome: "ok",
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("empty");
      expect(inputs).toHaveLength(0);
      expect(readFeedbackLedger(dataDir).exists).toBe(false);
    } finally {
      db.close();
    }
  });

  it("a provider failure never throws: ok:false with the API key scrubbed out of the error", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, false);
      const chat: ChatFn = async () => {
        throw new Error(`provider exploded with key ${KEY} in the message`);
      };
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        {
          sessionId,
          sessionTitle: null,
          projectId: null,
          projectName: null,
          agentName: "default",
          provider: { id: "openrouter", baseUrl: "https://example.test/v1" },
          apiKey: KEY,
          model: "test/model-1",
          turnOutcome: "ok",
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain(KEY);
        expect(result.error).toContain("***");
      }
      expect(readFeedbackLedger(dataDir).exists).toBe(false);
    } finally {
      db.close();
    }
  });

  it("an EMPTY model reply is refused (never a hollow ledger entry)", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, false);
      const { chat } = fakeChat("   ");
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        {
          sessionId,
          sessionTitle: null,
          projectId: null,
          projectName: null,
          agentName: "default",
          provider: { id: "openrouter", baseUrl: "https://example.test/v1" },
          apiKey: KEY,
          model: "test/model-1",
          turnOutcome: "ok",
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("empty entry");
      expect(readFeedbackLedger(dataDir).exists).toBe(false);
    } finally {
      db.close();
    }
  });

  it("keyring secrets in tool outputs are scrubbed from the transcript the model receives", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, true);
      const { chat, inputs } = fakeChat("### What I was trying to do\nx");
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: SECRET }), chat, dataDir },
        {
          sessionId,
          sessionTitle: null,
          projectId: null,
          projectName: null,
          agentName: "default",
          provider: { id: "openrouter", baseUrl: "https://example.test/v1" },
          apiKey: KEY,
          model: "test/model-1",
          turnOutcome: "ok",
        },
      );
      const transcript = (inputs[0] as { messages?: Array<{ content: string }> }).messages?.[0].content ?? "";
      expect(transcript).not.toContain(SECRET);
      expect(transcript).toContain("***");
    } finally {
      db.close();
    }
  });
});

// ── 4. ROUND-125 (R125-B): the phase param + the status bookkeeping ─────────

describe("R125-B: the mid-turn checkpoint phase (runFeedbackWriter phase param)", () => {
  const MID_TURN_REPORT = "### What I was trying to do\nFix the login bug.\n\n### What actually happened\nThis is a mid-turn checkpoint of a turn that has not finished — the checkpoint fired because calls kept failing.\n\n### Issues & problems encountered\nterminal failed 3 times.\n\n### Glitches & anomalies noticed\nNothing to report.\n\n### Expectations vs reality\nNot met — the task is still outstanding.\n\n### Suggested improvements\nNone this turn.";

  it("the header builder: phase \"mid-turn\" inserts the Phase line; \"turn-end\" and OMITTED are byte-identical (the R122 format)", () => {
    // The additive contract in one pin: only the mid-turn entry carries the
    // marker, and the two turn-end spellings are the SAME bytes (an old
    // entry and a new turn-end entry are indistinguishable — the file's
    // grammar and the viewer's parser are untouched).
    const midTurn = buildFeedbackEntryHeader({ ...headerBase, phase: "mid-turn" });
    expect(midTurn).toContain("- **Phase**: mid-turn checkpoint (turn still in flight)");
    // The Phase line sits between the outcome and the transcript lines.
    expect(midTurn.indexOf("- **Turn outcome**")).toBeLessThan(midTurn.indexOf("- **Phase**"));
    expect(midTurn.indexOf("- **Phase**")).toBeLessThan(midTurn.indexOf("- **Transcript**"));

    const explicitTurnEnd = buildFeedbackEntryHeader({ ...headerBase, phase: "turn-end" });
    const omittedPhase = buildFeedbackEntryHeader({ ...headerBase });
    expect(explicitTurnEnd).toBe(omittedPhase);
    expect(explicitTurnEnd).not.toContain("- **Phase**");
  });

  it("mid-turn: the transcript the model receives carries the machine-written PARTIAL-turn banner; the system prompt carries the checkpoint paragraph", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, false);
      const { chat, inputs } = fakeChat(MID_TURN_REPORT);
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        {
          sessionId,
          sessionTitle: null,
          projectId: null,
          projectName: null,
          agentName: "default",
          provider: { id: "openrouter", baseUrl: "https://example.test/v1" },
          apiKey: KEY,
          model: "test/model-1",
          turnOutcome: "in flight (mid-turn checkpoint)",
          phase: "mid-turn",
        },
      );
      expect(result.ok).toBe(true);
      expect(inputs).toHaveLength(1);
      const input = inputs[0] as { system?: string; messages?: Array<{ content: string }> };
      // The banner LEADS the transcript — the prompt's checkpoint paragraph
      // keys on its exact opening words.
      expect(input.messages?.[0].content.startsWith("NOTE: this is a PARTIAL turn (mid-turn checkpoint)")).toBe(true);
      expect(input.messages?.[0].content).toContain("please fix the login bug");
      // The system prompt knows what a checkpoint entry should focus on
      // (the six-section contract itself stays identical).
      expect(input.system).toContain("MID-TURN CHECKPOINTS (ROUND-125)");
      expect(input.system).toContain("### What I was trying to do");
      // The ledger entry: the Phase line + the checkpoint outcome.
      const ledger = readFeedbackLedger(dataDir);
      expect(ledger.entries).toBe(1);
      expect(ledger.content).toContain("- **Phase**: mid-turn checkpoint (turn still in flight)");
      expect(ledger.content).toContain("- **Turn outcome**: in flight (mid-turn checkpoint)");
      expect(ledger.content).toContain("mid-turn checkpoint of a turn that has not finished");
    } finally {
      db.close();
    }
  });

  it("turn-end (explicit and omitted): NO banner in the transcript — the R122 prompt input is byte-identical", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, false);
      const { chat: chatA, inputs: inputsA } = fakeChat("### What I was trying to do\nx");
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat: chatA, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      const { chat: chatB, inputs: inputsB } = fakeChat("### What I was trying to do\nx");
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat: chatB, dataDir },
        { ...baseWriterParams(sessionId), phase: "turn-end" },
      );
      const transcriptA = (inputsA[0] as { messages?: Array<{ content: string }> }).messages?.[0].content ?? "";
      const transcriptB = (inputsB[0] as { messages?: Array<{ content: string }> }).messages?.[0].content ?? "";
      expect(transcriptA.startsWith("NOTE: this is a PARTIAL turn")).toBe(false);
      expect(transcriptA).toBe(transcriptB);
      // And the ledger's two entries carry NO Phase line at all.
      expect(readFeedbackLedger(dataDir).content).not.toContain("- **Phase**");
    } finally {
      db.close();
    }
  });
});

describe("R125-B: the writer's STATUS bookkeeping (the registry reports)", () => {
  it("writing=true DURING the model call; false + lastWriteTs + lastEntries after a successful write", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, false);
      // The fake chat READS THE REGISTRY at the moment the writer is
      // awaiting it — the mid-flight snapshot the owner never got to see.
      let midFlight: FeedbackWriterStatus | null = null;
      const chat: ChatFn = async () => {
        midFlight = readFeedbackStatus();
        return {
          text: "### What I was trying to do\nx",
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          toolCalls: [],
          finishReason: "stop",
          steps: [],
        };
      };
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId), phase: "mid-turn" },
      );
      expect(result.ok).toBe(true);
      // The in-flight state: writing, the phase, the session, a start time.
      expect(midFlight).not.toBeNull();
      expect((midFlight as unknown as FeedbackWriterStatus).writing).toBe(true);
      expect((midFlight as unknown as FeedbackWriterStatus).phase).toBe("mid-turn");
      expect((midFlight as unknown as FeedbackWriterStatus).sessionId).toBe(sessionId);
      expect((midFlight as unknown as FeedbackWriterStatus).startedAt).not.toBeNull();
      // The completed state: idle + the honest outcome/entries/timestamp.
      const after = readFeedbackStatus();
      expect(after.writing).toBe(false);
      expect(after.lastWriteTs).not.toBeNull();
      expect(after.lastWriteOutcome).toBe("written");
      expect(after.lastEntries).toBe(1);
      expect(after.lastError).toBeNull();
    } finally {
      db.close();
    }
  });

  it("the early-return paths never strand writing=true — a failed write ends with the honest failed outcome", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      // The empty-transcript early return: beginFeedbackWrite ran, the body
      // returned before any model call — the registry must still END.
      const sessionId = `sess_${randomUUID()}`; // no events at all
      const { chat, inputs } = fakeChat("should never be called");
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      expect(result.ok).toBe(false);
      expect(inputs).toHaveLength(0);
      const status = readFeedbackStatus();
      expect(status.writing).toBe(false);
      expect(status.lastWriteOutcome).toBe("failed");
      expect(status.lastError).toContain("empty");

      // The provider-failure early return — same law.
      const sessionId2 = sessionWithTranscript(db, false);
      const throwingChat: ChatFn = async () => {
        throw new Error("provider exploded");
      };
      const result2 = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat: throwingChat, dataDir },
        { ...baseWriterParams(sessionId2) },
      );
      expect(result2.ok).toBe(false);
      expect(readFeedbackStatus().writing).toBe(false);
      expect(readFeedbackStatus().lastWriteOutcome).toBe("failed");
      expect(readFeedbackStatus().lastError).toContain("provider exploded");
    } finally {
      db.close();
    }
  });
});

/** R125-B: the writer params every extension test shares (the R122 shape). */
function baseWriterParams(sessionId: string): Parameters<typeof runFeedbackWriter>[1] {
  return {
    sessionId,
    sessionTitle: null,
    projectId: null,
    projectName: null,
    agentName: "default",
    provider: { id: "openrouter", baseUrl: "https://example.test/v1" },
    apiKey: KEY,
    model: "test/model-1",
    turnOutcome: "ok",
  };
}

/** R125-B: the header-base fixture shared with describe #2's `base` — kept
 * separate so the R122 pins above stay untouched. */
const headerBase = {
  ts: "2026-09-23T12:00:00.000Z",
  sessionId: "sess_abc",
  sessionTitle: null as string | null,
  projectName: "my-app" as string | null,
  projectId: "proj_1" as string | null,
  agentName: "default",
  providerId: "openrouter",
  model: "test/model-1",
  turnOutcome: "ok",
  eventCount: 42,
  truncated: false,
};
