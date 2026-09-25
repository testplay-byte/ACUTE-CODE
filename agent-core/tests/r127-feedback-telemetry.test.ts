/**
 * ROUND-127 (R127-W7) — the FEEDBACK LEDGER TELEMETRY wave: the reporter's
 * transcript now opens with a MACHINE-WRITTEN context-telemetry block (the
 * owner's: "make the feedback ledger prompts much better, like they would
 * include the proper details which are necessary, like what was the context
 * of it, what were the total expected tokens around that time, what was
 * roughly available there").
 *
 * Pinned here, all through runFeedbackWriter with a fake ChatFn that
 * records the exact input the model would receive (the r122 pattern):
 *   1. THE ORDER LAW — mid-turn: the PARTIAL-turn banner FIRST, the
 *      telemetry block SECOND, the transcript body LAST (the system
 *      prompt's checkpoint paragraph keys on the transcript BEGINNING with
 *      the NOTE line); turn-end: the transcript OPENS with the telemetry
 *      block (no banner).
 *   2. THE ANCHORED LAW — a usage-bearing assistant event renders the
 *      provider-anchored number (the R125-C providerUsageAnchor, the same
 *      headline the live context meter shows); NO usage-bearing event
 *      renders the honest "no provider report yet" line — never a
 *      fabricated number.
 *   3. THE PROVENANCE LAW — the window line carries resolveTurnBudget's
 *      window/reserve/available with the meter's own source vocabulary
 *      ("your override" / "assumed 200k — unknown model").
 *   4. THE TOTALS LAW — the session's usage_events SUMs render verbatim
 *      (the context handler's totalsRow pattern), with "hit rate not
 *      reported" when no row ever reported a cached tier and "no usage
 *      rows yet" when nothing completed.
 *   5. THE PROMPT LAW — the system prompt teaches USING the telemetry
 *      (substring pins) while the SIX exact headings stay byte-exact (no
 *      seventh section).
 *   6. THE FILE LAW — the telemetry rides the TRANSCRIPT ONLY: the ledger
 *      file's entry (header + the model's six sections) carries no
 *      telemetry block.
 *   7. THE RESILIENCE LAW — a telemetry read failure never kills the entry
 *      (the never-throws contract): the block degrades to the honest
 *      unavailable line and the entry still lands.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFeedbackLedger } from "../src/storage/feedback-ledger";
import { runFeedbackWriter } from "../src/agents/feedback-writer";
import { appendSessionEvent, recordUsage } from "../src/storage/sessions";
import { upsertModel } from "../src/storage/models";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import type { ChatFn } from "../src/agents/chat";

const KEY = "sk-or-vtest-r127fbtelemetry";

const tempDir = mkdtempSync(join(tmpdir(), "acute-r127fbtelemetry-"));
let dataDir = "";

beforeEach(() => {
  // A fresh dataDir per test: every ledger assertion starts from the
  // honest empty state (the r122 pattern).
  dataDir = mkdtempSync(join(tempDir, "data-"));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** A no-tools fake ChatFn that records its inputs and returns a canned
 * six-section report (the r122 helper, verbatim). */
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

const SIX_SECTION_REPORT = [
  "### What I was trying to do",
  "Fix the login bug.",
  "",
  "### What actually happened",
  "The tests pass.",
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

/** The file's cold-read contract: EXACTLY these six headings, in order. */
const SIX_HEADINGS = [
  "### What I was trying to do",
  "### What actually happened",
  "### Issues & problems encountered",
  "### Glitches & anomalies noticed",
  "### Expectations vs reality",
  "### Suggested improvements",
];

/** A session with a REAL transcript (the r122 fixture shape) — the
 * assistant reply optionally carrying the provider's own usage report
 * (the payload shape the runtime persists per reply; the LAST message
 * event, so the post-anchor tail is empty and the anchor is exactly the
 * provider's number). */
function sessionWithTranscript(
  db: SqliteDatabase,
  opts: { usage?: { inputTokens: number; outputTokens: number } },
): string {
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
      outputSummary: "3 passed",
    },
  });
  appendSessionEvent(db, sessionId, {
    type: "message.assistant",
    agentId: null,
    payload: {
      content: "The tests pass; the bug is fixed.",
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    },
  });
  return sessionId;
}

/** The writer params every test shares (the r122 shape). */
function baseWriterParams(
  sessionId: string,
): Parameters<typeof runFeedbackWriter>[1] {
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

/** The transcript content the fake chat received (ONE call, ONE user
 * message — the reporter's shape). */
function receivedTranscript(inputs: Array<Record<string, unknown>>): string {
  expect(inputs).toHaveLength(1);
  const input = inputs[0] as {
    system?: string;
    messages?: Array<{ role: string; content: string }>;
    tools?: unknown;
  };
  expect(input.tools).toBeUndefined();
  expect(input.messages).toHaveLength(1);
  expect(input.messages?.[0].role).toBe("user");
  return input.messages?.[0].content ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────

describe("R127-W7: the feedback reporter's context telemetry", () => {
  it("THE ORDER LAW (mid-turn): the PARTIAL-turn banner leads, the telemetry block follows, the transcript body closes — in that exact order", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {});
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        {
          ...baseWriterParams(sessionId),
          turnOutcome: "in flight (mid-turn checkpoint)",
          phase: "mid-turn",
        },
      );
      expect(result.ok).toBe(true);
      const content = receivedTranscript(inputs);
      // The banner is STILL the transcript's opening line — the system
      // prompt's checkpoint paragraph keys on its exact opening words.
      expect(content.startsWith("NOTE: this is a PARTIAL turn (mid-turn checkpoint)")).toBe(true);
      const bannerIdx = content.indexOf("NOTE: this is a PARTIAL turn");
      const telemetryIdx = content.indexOf("CONTEXT TELEMETRY (machine-measured, this turn):");
      const bodyIdx = content.indexOf("USER: please fix the login bug");
      expect(telemetryIdx).toBeGreaterThan(bannerIdx);
      expect(bodyIdx).toBeGreaterThan(telemetryIdx);
      // The transcript body itself is intact after the preamble.
      expect(content).toContain('TOOL terminal(command: "npm test") → ok: 3 passed');
      expect(content).toContain("ASSISTANT: The tests pass; the bug is fixed.");
    } finally {
      db.close();
    }
  });

  it("THE ORDER LAW (turn-end): no banner — the transcript OPENS with the telemetry block", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {});
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      expect(result.ok).toBe(true);
      const content = receivedTranscript(inputs);
      expect(content.startsWith("CONTEXT TELEMETRY (machine-measured, this turn):")).toBe(true);
      expect(content).not.toContain("NOTE: this is a PARTIAL turn");
      expect(content).toContain("USER: please fix the login bug");
    } finally {
      db.close();
    }
  });

  it("THE ANCHORED LAW: a usage-bearing assistant reply (inputTokens 50000, empty post-anchor tail) renders EXACTLY \"50000 (provider-anchored)\"", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {
        usage: { inputTokens: 50_000, outputTokens: 1_200 },
      });
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      const content = receivedTranscript(inputs);
      expect(content).toContain("· context used at last provider call: 50000 (provider-anchored)");
      expect(content).not.toContain("no provider report yet");
    } finally {
      db.close();
    }
  });

  it("THE HONEST FALLBACK: no usage-bearing event → \"no provider report yet (turn died before first reply)\" + \"no usage rows yet\" — never a fabricated number", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {});
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      const content = receivedTranscript(inputs);
      expect(content).toContain(
        "· context used at last provider call: no provider report yet (turn died before first reply)",
      );
      // No usage rows either — an ABSENCE is never dressed up as a
      // measured 0.
      expect(content).toContain(
        "· session totals at write time: no usage rows yet (no completed provider call)",
      );
      expect(content).not.toContain("(provider-anchored)");
      expect(content).not.toContain("hit rate 0%");
    } finally {
      db.close();
    }
  });

  it("THE PROVENANCE LAW (default): the unknown model renders the assumed-200k window line VERBATIM (window · reserve · available)", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {});
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      const content = receivedTranscript(inputs);
      // resolveTurnBudget's default resolution, in the METER's own
      // vocabulary: 200k window (source "default"), 32768 reserve,
      // available = 200000 − 32768 − 8000.
      expect(content).toContain(
        "· context window: 200000 tokens (assumed 200k — unknown model) · output reserve: 32768 · available: 159232",
      );
    } finally {
      db.close();
    }
  });

  it("THE PROVENANCE LAW (override): the owner's models-table override renders the window line with \"your override\"", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      upsertModel(db, "openrouter", {
        modelId: "test/model-1",
        contextWindow: 1_000_000,
        maxOutputTokens: 8_192,
      });
      const sessionId = sessionWithTranscript(db, {});
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      const content = receivedTranscript(inputs);
      // available = 1000000 − 8192 − 8000 = 983808 — the same arithmetic
      // the context meter's donut renders.
      expect(content).toContain(
        "· context window: 1000000 tokens (your override) · output reserve: 8192 · available: 983808",
      );
    } finally {
      db.close();
    }
  });

  it("THE PROVENANCE LAW (catalog): a catalog model with no override renders the \"catalog default\" window line", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {});
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId), model: "z-ai/glm-5.2:free" },
      );
      const content = receivedTranscript(inputs);
      // The static catalog's glm-5.2 row (256000 window, 230400 output
      // cap): available = 256000 − 230400 − 8000. Golden pin — re-pin if
      // the catalog's row ever changes (the repo's pin philosophy).
      expect(content).toContain(
        "· context window: 256000 tokens (catalog default) · output reserve: 230400 · available: 17600",
      );
    } finally {
      db.close();
    }
  });

  it("THE TOTALS LAW: the usage_events SUMs render verbatim — cached rows compute the hit rate, cache-less rows render \"not reported\"", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {
        usage: { inputTokens: 50_000, outputTokens: 1_200 },
      });
      // The context handler's totalsRow inputs, seeded exactly: one row
      // with a cached tier, one without (SUM(cached) stays 800 across the
      // NULL — the raw SUM, never a fabricated 0%).
      recordUsage(db, {
        agentId: null,
        sessionId,
        provider: "openrouter",
        model: "test/model-1",
        inputTokens: 1_200,
        outputTokens: 300,
        cachedInputTokens: 800,
        costUsd: 0,
        ts: "2026-09-23T12:00:00.000Z",
      });
      recordUsage(db, {
        agentId: null,
        sessionId,
        provider: "openrouter",
        model: "test/model-1",
        inputTokens: 3_000,
        outputTokens: 500,
        costUsd: 0,
        ts: "2026-09-23T12:01:00.000Z",
      });
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      const content = receivedTranscript(inputs);
      // 4200 in / 800 out / 800 cached over 2 turns; the hit rate is
      // round(800/4200·100) = 19%.
      expect(content).toContain(
        "· session totals at write time: 4200 in / 800 out / 800 cached (hit rate 19%) over 2 turns",
      );
    } finally {
      db.close();
    }
  });

  it("THE TOTALS LAW (no cached tier anywhere): the hit rate renders \"not reported\" — never a fabricated 0%", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {
        usage: { inputTokens: 50_000, outputTokens: 1_200 },
      });
      recordUsage(db, {
        agentId: null,
        sessionId,
        provider: "openrouter",
        model: "test/model-1",
        inputTokens: 500,
        outputTokens: 100,
        costUsd: 0,
        ts: "2026-09-23T12:00:00.000Z",
      });
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      const content = receivedTranscript(inputs);
      expect(content).toContain(
        "· session totals at write time: 500 in / 100 out / 0 cached (hit rate not reported) over 1 turns",
      );
    } finally {
      db.close();
    }
  });

  it("THE PROMPT LAW: the system prompt teaches USING the telemetry AND the six headings stay byte-exact (no seventh section)", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {});
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      expect(inputs).toHaveLength(1);
      const system = (inputs[0] as { system?: string }).system ?? "";
      // The telemetry-teaching paragraph — substring pins.
      expect(system).toContain("machine-written CONTEXT TELEMETRY block");
      expect(system).toContain("measured, not estimated by you");
      expect(system).toContain("context was at 61% of the 200k window");
      expect(system).toContain("Never restate the whole block");
      expect(system).toContain("never invent a number the block does not carry");
      // The file's cold-read contract — byte-exact: EXACTLY the six
      // headings, in order, and nothing else that starts with "### ".
      const headingLines = system.split("\n").filter((line) => line.startsWith("### "));
      expect(headingLines).toEqual(SIX_HEADINGS);
    } finally {
      db.close();
    }
  });

  it("THE FILE LAW: the telemetry rides the TRANSCRIPT ONLY — the ledger entry (machine header + six sections) carries no telemetry block", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {
        usage: { inputTokens: 50_000, outputTokens: 1_200 },
      });
      const { chat } = fakeChat(SIX_SECTION_REPORT);
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      expect(result.ok).toBe(true);
      const ledger = readFeedbackLedger(dataDir);
      expect(ledger.entries).toBe(1);
      // The header + the model's six sections — the R122 file format,
      // untouched by construction (the telemetry block never lands in the
      // file; only the MODEL's own prose may cite the numbers).
      expect(ledger.content).toContain("## Entry — ");
      expect(ledger.content).toContain("### What I was trying to do");
      expect(ledger.content).not.toContain("CONTEXT TELEMETRY");
      expect(ledger.content).not.toContain("· context window:");
    } finally {
      db.close();
    }
  });

  it("THE RESILIENCE LAW: a telemetry read failure never kills the entry — the block degrades to the honest unavailable line", async () => {
    const db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const sessionId = sessionWithTranscript(db, {});
      // Sabotage ONLY the telemetry's first read: the models table the
      // budget resolves from. The transcript (session_events) is intact,
      // so buildDebugTranscript succeeds and the write must proceed.
      db.exec("DROP TABLE models");
      const { chat, inputs } = fakeChat(SIX_SECTION_REPORT);
      const result = await runFeedbackWriter(
        { db, keyring: new ProviderKeyring(), chat, dataDir },
        { ...baseWriterParams(sessionId) },
      );
      expect(result.ok).toBe(true);
      const content = receivedTranscript(inputs);
      expect(content).toContain("CONTEXT TELEMETRY (machine-measured, this turn):");
      expect(content).toContain("telemetry unavailable");
      expect(content).toContain("do not guess them");
      // The transcript body is unaffected and the entry still lands.
      expect(content).toContain("USER: please fix the login bug");
      expect(readFeedbackLedger(dataDir).entries).toBe(1);
    } finally {
      db.close();
    }
  });
});
