/**
 * ROUND-77 (R77): the blank-output guard — the live-battery find.
 *
 * The T5 long-conversation battery's turn 10: glm-5.2:free "answered" with a
 * run of newlines — no text, no tool calls — and the streamed turn COMPLETED
 * ok with a whitespace assistant message. The requested file edit silently
 * never happened while the UI showed a normal (empty) reply. The guard: a
 * turn whose entire output is blank AND ran zero tool calls fails honestly
 * (NO_OUTPUT 502 + a persisted turn.error with the actionable message); a
 * tool-using turn with no final text stays legitimate (the tools did the
 * work); a whitespace text reply with tool calls stays ok.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runStreamedAgentTurn } from "../src/agents/runtime";
import type { ChatFn, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-r77-blank";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r77-blank-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
  const project = createProject(db, { name, rootPath: join(tempDir, name) });
  const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r77-1" });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
}

const summarizerChat: ChatFn = async () => ({
  text: "SUMMARY: prior work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [],
});

describe("R77: the blank-output guard (the whitespace-reply flake)", () => {
  it("a WHITESPACE-ONLY reply with zero tool calls → NO_OUTPUT 502 + the persisted turn.error (never a fake empty success)", async () => {
    const { sessionId, keyring } = setup("R77-Blank");
    const emitted: Array<Record<string, unknown>> = [];
    // The exact T5 turn-10 shape: the model streams newlines, then finishes.
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "\n\n\n\n\n" };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "append the status section",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("NO_OUTPUT");
      expect(String(outcome.message)).toContain("empty response");
      expect(String(outcome.message)).toContain("resend");
      expect(outcome.details?.providerError).toContain("whitespace");
    }
    // The honest error is persisted — the timeline shows it after the blank
    // assistant event; the error card's Retry re-sends.
    const events = listSessionEvents(db, sessionId);
    const errEvent = events.find((e) => e.type === "turn.error");
    expect(errEvent).toBeDefined();
    expect((errEvent?.payload as { code?: string }).code).toBe("NO_OUTPUT");
    expect((errEvent?.payload as { providerError?: string }).providerError).toContain("whitespace");
    // The session stays retryable (persistTurnError resets to queued).
    expect(
      db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId),
    ).toMatchObject({ status: "queued" });
    // The token spend was real — a usage row exists for the burned call.
    const usageRows = db
      .prepare("SELECT * FROM usage_events WHERE session_id = ?")
      .all(sessionId) as unknown[];
    expect(usageRows.length).toBe(1);
  });

  it("a TOOL-USING turn with no final text stays OK (the tools did the work)", async () => {
    const { sessionId, keyring } = setup("R77-Tools-NoText");
    let calls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool-call", toolName: "write_file", argsSummary: "path: a.txt" };
        yield {
          type: "tool-result",
          toolName: "write_file",
          argsSummary: "path: a.txt",
          ok: true,
          outputSummary: "wrote 12 bytes",
        };
        // No trailing text — the R35 empty-marker path.
      } else {
        // Iteration 2: the model concludes with real text (the natural
        // tool → conclusion pattern).
        yield { type: "text-delta", delta: "Done — the file is written." };
      }
      yield { type: "finish", usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "write the file",
      () => undefined,
    );

    expect(outcome.ok).toBe(true);
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });

  it("a tool-using turn whose SECOND call is blank ALSO stays OK (the tools did the work — the guard reads the TURN, not the last iteration)", async () => {
    const { sessionId, keyring } = setup("R77-Tools-BlankTail");
    let calls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool-call", toolName: "write_file", argsSummary: "path: b.txt" };
        yield {
          type: "tool-result",
          toolName: "write_file",
          argsSummary: "path: b.txt",
          ok: true,
          outputSummary: "wrote 8 bytes",
        };
        yield { type: "text-delta", delta: "File written." };
      } else {
        // The follow-up iteration streams only whitespace (the flake) —
        // but the turn ALREADY has text + a tool call: not blank.
        yield { type: "text-delta", delta: "  \n\n" };
      }
      yield { type: "finish", usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "write the file",
      () => undefined,
    );

    expect(outcome.ok).toBe(true);
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });

  it("a REAL text reply (with or after whitespace) stays OK — the guard only fires on fully-blank turns", async () => {
    const { sessionId, keyring } = setup("R77-Real-Text");
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "\n\n" };
      yield { type: "text-delta", delta: "Done — the section is appended." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 9, totalTokens: 14 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "append the section",
      () => undefined,
    );

    expect(outcome.ok).toBe(true);
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });
});

// Silence vitest's "no tests without assertions" lint on the vi import used
// by future timed cases in this file.
vi.useRealTimers();
