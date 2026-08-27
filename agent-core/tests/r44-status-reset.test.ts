/**
 * ROUND-44 regression (live-battery find): a SUCCESSFUL turn used to leave
 * the session in "running" forever — only the failure path (R43) reset the
 * status back to "queued". Symptoms in the wild: sessions read as live in
 * the UI indefinitely, and POST /sessions/:id/revert answered 409 "cannot
 * revert a running session" for turns that finished minutes ago (found while
 * live-testing the R44 revert UI against a real streamed battery turn).
 *
 * These tests pin BOTH completion paths (streamed + sync) to the resting
 * state, and prove the downstream effect: revert succeeds on a finished
 * session.
 *
 * Hermetic pattern shared with r43-turn-error.test.ts: the real aiSdkChat
 * adapter with ONLY the AI SDK mocked at the module boundary — no network,
 * no real keys.
 */
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { aiSdkChat } from "../src/agents/chat";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import { listSessionEvents } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r44-status";
const KEY = "sk-or-vtest-r44s";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r44s-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "All done.",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

async function createAgentAndSession(): Promise<{ sessionId: string }> {
  const agentRes = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "Status Agent",
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
  const session = sessionRes.json() as { id: string };
  return { sessionId: session.id };
}

function sessionStatus(sessionId: string): string {
  const row = db
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId) as { status: string };
  return row.status;
}

/** A healthy provider stream: one text-delta burst then finish. */
async function* healthyChatStream(): AsyncGenerator<
  import("../src/agents/chat").StreamChatEvent
> {
  yield { type: "text-delta", delta: "All done." };
}

describe("ROUND-44: successful turns return the session to `queued`", () => {
  it("STREAMED path: status is queued after a successful streamed turn (was stuck at running)", async () => {
    const { sessionId } = await createAgentAndSession();

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
        chatStream: healthyChatStream,
      },
      sessionId,
      "do the thing",
      () => undefined,
    );

    expect(outcome.ok).toBe(true);
    // THE FIX: the resting state after success, mirroring the R43 error path.
    expect(sessionStatus(sessionId)).toBe("queued");

    // And the downstream effect that surfaced the bug: revert now succeeds
    // on the finished session (it 409'd on "running" before the fix).
    const revertRes = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/revert`,
      payload: { keepThroughSeq: 1 },
    });
    expect(revertRes.statusCode).toBe(200);
    const types = listSessionEvents(db, sessionId).map((e) => e.type);
    expect(types).toContain("session.reverted");
  });

  it("SYNC path (POST /sessions/:id/messages): status is queued after a successful turn", async () => {
    const { sessionId } = await createAgentAndSession();

    const res = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "do the other thing" },
    });
    expect(res.statusCode).toBe(200);

    expect(sessionStatus(sessionId)).toBe("queued");
  });
});
