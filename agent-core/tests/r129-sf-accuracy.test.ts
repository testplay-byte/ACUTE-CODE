/**
 * ROUND-129 (R129-SF) — the feedback reporter's ACCURACY SET (round-129.md
 * §1 Wave SF; the owner's verdict: "the self feedback is not proper. It
 * sometimes wrongly addresses the things"):
 *
 *   · THE TOOL-OUTCOMES PREAMBLE — the machine-counted per-tool tally
 *     (ok/FAILED + each failing tool's first one-liner) rides the
 *     transcript BEFORE the body, so a misread tool result can never
 *     become a misattributed issue.
 *   · THE PROMPT'S EVIDENCE LAWS — CONFIRMED/SUSPECTED labeling, the
 *     tool-outcomes non-contradiction law, the attribution law (the
 *     application's defects vs the MODEL's own mistakes), and the dedup
 *     law — all substring-pinned.
 *   · THE ORDER LAW (extended) — banner → telemetry → tool outcomes →
 *     previously-reported → the transcript body.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runFeedbackWriter } from "../src/agents/feedback-writer";
import { appendSessionEvent } from "../src/storage/sessions";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import type { ChatFn } from "../src/agents/chat";

const KEY = "sk-or-vtest-r129sf";

const tempDir = mkdtempSync(join(tmpdir(), "acute-r129sf-"));
let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tempDir, "data-"));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

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

function sessionWithTools(db: SqliteDatabase): string {
  const sessionId = `sess-${randomUUID()}`;
  appendSessionEvent(db, sessionId, {
    type: "message.user",
    agentId: "agt_x",
    payload: { role: "user", content: "run the build and read the config" },
  });
  appendSessionEvent(db, sessionId, {
    type: "tool.use",
    agentId: "agt_x",
    payload: {
      role: "tool",
      toolName: "run_command",
      argsSummary: "cmd: npm run build",
      ok: true,
      outputSummary: "built in 3s",
    },
  });
  appendSessionEvent(db, sessionId, {
    type: "tool.use",
    agentId: "agt_x",
    payload: {
      role: "tool",
      toolName: "run_command",
      argsSummary: "cmd: npm test",
      ok: false,
      outputSummary: "exit 1 — 2 tests failed: login.spec.ts, config.spec.ts",
    },
  });
  appendSessionEvent(db, sessionId, {
    type: "tool.use",
    agentId: "agt_x",
    payload: {
      role: "tool",
      toolName: "read_file",
      argsSummary: "path: config.json",
      ok: true,
      outputSummary: "{ }",
    },
  });
  appendSessionEvent(db, sessionId, {
    type: "message.assistant",
    agentId: "agt_x",
    payload: { role: "assistant", content: "done" },
  });
  return sessionId;
}

describe("R129-SF: the tool-outcomes preamble (machine-counted)", () => {
  it("renders the per-tool ok/FAILED tally + the failing tool's first one-liner, BEFORE the transcript body", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTools(db);
      const { chat, inputs } = fakeChat("### What I was trying to do\nx");
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat, dataDir },
        {
          sessionId,
          sessionTitle: "sf test",
          projectName: null,
          projectId: null,
          agentName: "Acute",
          provider: { id: "openrouter", baseUrl: null, apiFormat: "openai" },
          apiKey: KEY,
          model: "z-ai/glm-5.2:free",
          turnOutcome: "completed",
          phase: "turn-end",
        },
      );
      expect(result.ok).toBe(true);
      const transcript = (inputs[0] as { messages?: Array<{ content: string }> }).messages?.[0].content ?? "";
      expect(transcript).toContain("TOOL OUTCOMES (machine-counted over the whole session");
      expect(transcript).toContain("· read_file: 1 ok");
      expect(transcript).toContain("· run_command: 1 ok / 1 FAILED");
      expect(transcript).toContain('first failure: "exit 1 — 2 tests failed');
      // THE ORDER LAW (extended): telemetry FIRST, tool outcomes SECOND,
      // previously reported THIRD, the body LAST.
      const telemetryAt = transcript.indexOf("CONTEXT TELEMETRY (machine-measured");
      const outcomesAt = transcript.indexOf("TOOL OUTCOMES (machine-counted");
      const previousAt = transcript.indexOf("PREVIOUSLY REPORTED IN THIS LEDGER");
      const bodyAt = transcript.indexOf("run the build and read the config");
      expect(telemetryAt).toBeGreaterThanOrEqual(0);
      expect(outcomesAt).toBeGreaterThan(telemetryAt);
      expect(previousAt).toBeGreaterThan(outcomesAt);
      expect(bodyAt).toBeGreaterThan(previousAt);
      // The fresh ledger's honest line.
      expect(transcript).toContain("(this is the first entry)");
    } finally {
      db.close();
    }
  });

  it("a session with NO tool calls renders the honest no-tool-calls line", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = `sess-${randomUUID()}`;
      appendSessionEvent(db, sessionId, {
        type: "message.user",
        agentId: "agt_x",
        payload: { role: "user", content: "just a question" },
      });
      appendSessionEvent(db, sessionId, {
        type: "message.assistant",
        agentId: "agt_x",
        payload: { role: "assistant", content: "an answer" },
      });
      const { chat, inputs } = fakeChat("### What I was trying to do\nx");
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat, dataDir },
        {
          sessionId,
          sessionTitle: null,
          projectName: null,
          projectId: null,
          agentName: "Acute",
          provider: { id: "openrouter", baseUrl: null, apiFormat: "openai" },
          apiKey: KEY,
          model: "z-ai/glm-5.2:free",
          turnOutcome: "completed",
          phase: "turn-end",
        },
      );
      expect(result.ok).toBe(true);
      const transcript = (inputs[0] as { messages?: Array<{ content: string }> }).messages?.[0].content ?? "";
      expect(transcript).toContain("· no tool calls in this session");
    } finally {
      db.close();
    }
  });
});

describe("R129-SF: the prompt's evidence laws (substring pins)", () => {
  it("carries the tool-outcomes law, the CONFIRMED/SUSPECTED evidence law, the attribution law, and the dedup law", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTools(db);
      const { chat, inputs } = fakeChat("### What I was trying to do\nx");
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat, dataDir },
        {
          sessionId,
          sessionTitle: null,
          projectName: null,
          projectId: null,
          agentName: "Acute",
          provider: { id: "openrouter", baseUrl: null, apiFormat: "openai" },
          apiKey: KEY,
          model: "z-ai/glm-5.2:free",
          turnOutcome: "completed",
          phase: "turn-end",
        },
      );
      const system = (inputs[0] as { system?: string }).system ?? "";
      expect(system).toContain("TOOL OUTCOMES (ROUND-129)");
      expect(system).toContain("may not CONTRADICT it");
      expect(system).toContain("EVIDENCE LAW (ROUND-129)");
      expect(system).toContain("CONFIRMED");
      expect(system).toContain("SUSPECTED");
      expect(system).toContain("Never present a SUSPECTED issue as CONFIRMED");
      expect(system).toContain("ATTRIBUTION LAW (ROUND-129)");
      expect(system).toContain("attribute it to the model plainly");
      expect(system).toContain("DEDUP LAW (ROUND-129)");
      // The six-heading contract stays byte-exact (no seventh section).
      for (const heading of [
        "### What I was trying to do",
        "### What actually happened",
        "### Issues & problems encountered",
        "### Glitches & anomalies noticed",
        "### Expectations vs reality",
        "### Suggested improvements",
      ]) {
        expect(system).toContain(heading);
      }
    } finally {
      db.close();
    }
  });
});
