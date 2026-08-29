/**
 * ROUND-49: the TOOL-INTENT NUDGE (live-battery find). Free/cheap models
 * intermittently answer a work request by DESCRIBING the tool call in text
 * ("I'll delegate this to a coder agent.\n\n```python\ndelegate_task(...)```")
 * instead of emitting a real tool call — the outer loop's zero-tool-break
 * then ended the turn with NOTHING done. The fix: when a zero-tool reply
 * EVIDENCES tool intent (names a tool / announces delegation), the runtime
 * spends the turn's ONE in-memory nudge ("actually call the tool") and runs
 * another iteration; conversational replies still break immediately, and a
 * second zero-tool reply breaks for good (bounded — no loops).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { createAgent } from "../src/storage/agents";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { runSingleAgentTurn, runStreamedAgentTurn } from "../src/agents/runtime";
import type { ChatFn, ChatTurnMessage, StreamChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";

const KEY = "sk-test-nudge";
let tempDir = "";
let db: SqliteDatabase;

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** A chat stub with scripted per-call behavior + call recording. */
function scriptedChat(behaviors: Array<Awaited<ReturnType<ChatFn>>>): {
  chat: ChatFn;
  calls: ChatTurnMessage[][];
} {
  const calls: ChatTurnMessage[][] = [];
  let i = 0;
  const chat: ChatFn = async (input) => {
    calls.push(input.messages.map((m) => ({ ...m })));
    const behavior = behaviors[Math.min(i, behaviors.length - 1)];
    i += 1;
    return behavior;
  };
  return { chat, calls };
}

const intentText =
  "I'll run a sub-agent to handle this task. Let me delegate it to a coder agent.\n\n" +
    "```python\ndelegate_task(\n    role=\"coder\",\n    task=\"Create a folder called ShortStories\"\n)\n```";
const conversational = "Hello! I'm doing great, thanks for asking. How can I help you today?";
const toolCallResult = {
  text: "Creating the folder now.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [{ name: "create_dir", argsSummary: "path: ShortStories", ok: true, outputSummary: "ok" }],
};

describe("ROUND-49: tool-intent nudge (zero-tool replies that announce work)", () => {
  it("nudges ONCE when the zero-tool reply names a tool / announces delegation — the next iteration carries the nudge and the tool call lands", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-nudge-"));
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const project = createProject(db, { name: "Nudge", rootPath: tempDir });
    const agent = createAgent(db, { name: "Nudge Agent", providerId: "openrouter", model: "test/nudge-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    // Call 1: intent text, no tools. Call 2+: a real tool call, then done.
    const { chat, calls } = scriptedChat([
      { text: intentText, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] },
      { ...toolCallResult },
      { text: "Done. Folder created.", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, session.id, "create the ShortStories folder");
    expect(outcome.ok).toBe(true);

    // The nudge rode iteration 2's in-memory message list (never persisted).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const secondCall = calls[1];
    const lastMessage = secondCall[secondCall.length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toContain("ACTUALLY CALLING the tool");

    // The tool call actually executed (event log carries the tool.use).
    const events = listSessionEvents(db, session.id);
    const toolUse = events.find((e) => e.type === "tool.use");
    expect(toolUse?.payload).toMatchObject({ toolName: "create_dir" });

    // The nudge itself is NOT in the persisted log (machine correction only).
    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain("ACTUALLY CALLING the tool");
  });

  it("conversational zero-tool replies still break immediately (no nudge — the ROUND-33 lesson holds)", async () => {
    const { chat, calls } = scriptedChat([
      { text: conversational, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] },
    ]);
    const project = createProject(db, { name: "Nudge2", rootPath: join(tempDir, "p2") });
    const agent = createAgent(db, { name: "Nudge Agent 2", providerId: "openrouter", model: "test/nudge-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, session.id, "hello, how are you?");
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1); // no second iteration — nothing spent
  });

  it("a SECOND zero-tool reply after the nudge breaks for good (bounded — one nudge per turn)", async () => {
    const { chat, calls } = scriptedChat([
      { text: intentText, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] },
      { text: intentText, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] },
      { text: "should never run", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] },
    ]);
    const project = createProject(db, { name: "Nudge3", rootPath: join(tempDir, "p3") });
    const agent = createAgent(db, { name: "Nudge Agent 3", providerId: "openrouter", model: "test/nudge-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, session.id, "delegate the folder creation");
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2); // the nudged retry happened; the second stall ENDED the turn
  });
});

describe("ROUND-49: tool-intent nudge — the STREAMED path (the main agent's route)", () => {
  it("a streamed zero-tool intent reply gets the one nudge; the nudged iteration calls the tool", async () => {
    const project = createProject(db, { name: "NudgeS", rootPath: join(tempDir, "pS") });
    const agent = createAgent(db, { name: "Nudge Agent S", providerId: "openrouter", model: "test/nudge-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    const seenMessages: ChatTurnMessage[][] = [];
    let call = 0;
    const chatStream: StreamChatFn = async function* (input) {
      seenMessages.push(input.messages.map((m) => ({ ...m })));
      call += 1;
      if (call === 1) {
        // The intent-text stall: announces delegation, calls nothing.
        yield { type: "text-delta", delta: intentText };
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        return;
      }
      if (call === 2) {
        // The nudged iteration: actually calls the tool.
        yield { type: "text-delta", delta: "Creating it now." };
        yield { type: "tool-call", toolName: "create_dir", argsSummary: "path: ShortStories" };
        yield { type: "tool-result", toolName: "create_dir", argsSummary: "path: ShortStories", ok: true, outputSummary: "directory ready" };
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        return;
      }
      // Subsequent iterations: the task is complete — text only, no tools.
      yield { type: "text-delta", delta: "Done. Folder created." };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };

    const noOpChat: ChatFn = async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, toolCalls: [] });
    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: noOpChat, chatStream },
      session.id,
      "create the ShortStories folder via a sub-agent",
      () => undefined,
    );
    expect(outcome.ok).toBe(true);
    expect(call).toBe(3); // intent-stall → nudged tool call → completion
    // The nudge rode the second streamed call's message list (in-memory only).
    const lastMessage = seenMessages[1][seenMessages[1].length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toContain("ACTUALLY CALLING the tool");
    // The tool call executed (event log).
    const events = listSessionEvents(db, session.id);
    expect(events.some((e) => e.type === "tool.use")).toBe(true);
    // The nudge is NOT persisted.
    expect(JSON.stringify(events)).not.toContain("ACTUALLY CALLING the tool");
  });
});
