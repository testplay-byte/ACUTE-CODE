/**
 * ROUND-87 (R87, owner: "giving it the ability to ask the user questions
 * midway through … select from the options or … type in a custom response …
 * answer multiple questions") — the ask_user tool end-to-end.
 *
 * Coverage:
 *  · normalizeQuestions: the validation ladder (shape, counts, lengths).
 *  · askUser + resolveAgentQuestion: the full round trip — the frames
 *    emitted (agent-question / agent-question.resolved), the session events
 *    persisted (agent-question.requested / agent-question.resolved), the
 *    answers aligned per question, and the sources (option | custom).
 *  · The unknown-id + wrong-answer-count 404/400 contract (the resolve
 *    route's shapes).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  askUser,
  normalizeQuestions,
  pendingAgentQuestionCount,
  resetAgentQuestionsForTest,
  resolveAgentQuestion,
} from "../src/agent-question";
import { listSessionEvents } from "../src/storage/sessions";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r87ask";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r87ask-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
  resetAgentQuestionsForTest();
});

afterAll(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
});

function req(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  const inject: Record<string, unknown> = { method, url, headers: { authorization: `Bearer ${TOKEN}` } };
  if (body !== undefined) inject.payload = body;
  return app.inject(inject as never);
}

describe("R87 normalizeQuestions", () => {
  it("validates the ladder", () => {
    expect(normalizeQuestions(undefined).ok).toBe(false);
    expect(normalizeQuestions([]).ok).toBe(false);
    expect(normalizeQuestions([{ question: "" }]).ok).toBe(false);
    expect(normalizeQuestions([{ question: "Which?", options: ["only one"] }]).ok).toBe(false);
    expect(normalizeQuestions([{ question: "Which?", options: "yes" }]).ok).toBe(false);
    expect(normalizeQuestions(Array(11).fill({ question: "q" })).ok).toBe(false);
    expect(normalizeQuestions([{ question: "Which?", options: ["a", "b"], allowCustom: false, placeholder: "hint" }]).ok).toBe(true);
  });
});

describe("R87 askUser round trip", () => {
  it("emits both frames, persists both events, and returns the aligned answers", async () => {
    const events: unknown[] = [];
    const emit = (event: unknown) => events.push(event);
    const asked = askUser(
      { emit, db, sessionId: "ses_ask", agentId: "agt_default_nova" },
      {
        sessionId: "ses_ask",
        agentId: "agt_default_nova",
        questions: [
          { question: "Which approach?", options: ["Fast", "Safe"], allowCustom: true, placeholder: "or describe" },
          { question: "Ship today?", options: ["Yes", "No"], allowCustom: false },
        ],
      },
    );
    await vi.waitFor(() => expect(pendingAgentQuestionCount()).toBe(1));
    const openFrame = events[0] as { type: string; sessionId: string; questionId: string; questions: Array<{ question: string }> };
    expect(openFrame.type).toBe("agent-question");
    expect(openFrame.sessionId).toBe("ses_ask");
    expect(openFrame.questions[0].question).toBe("Which approach?");

    const resolved = resolveAgentQuestion(
      (events[0] as { questionId: string }).questionId,
      ["Safe", "Yes"],
      ["option", "option"],
    );
    expect(resolved).toBe(true);
    const result = await asked;
    expect(result.resolution).toBe("answered");
    expect(result.answers).toEqual(["Safe", "Yes"]);

    // The resolved frame carries the answers.
    expect(events[1]).toMatchObject({ type: "agent-question.resolved", resolution: "answered", answers: ["Safe", "Yes"] });

    // Both transitions persisted as session events.
    const types = listSessionEvents(db, "ses_ask").map((e) => e.type);
    expect(types).toContain("agent-question.requested");
    expect(types).toContain("agent-question.resolved");
  });

  it("settles as timeout via the test hook", async () => {
    const events: unknown[] = [];
    const asked = askUser(
      { emit: (e) => events.push(e), db, sessionId: "ses_t", agentId: "agt_default_nova" },
      { sessionId: "ses_t", agentId: "agt_default_nova", questions: [{ question: "Q?" }] },
    );
    resetAgentQuestionsForTest();
    const result = await asked;
    expect(result.resolution).toBe("timeout");
    expect(events.some((e) => (e as { type: string }).type === "agent-question.resolved")).toBe(true);
  });
});

describe("R87 POST /agent-questions/:id/resolve", () => {
  it("404s unknown ids, 400s malformed bodies, 200s the real answer", async () => {
    const unknown = await req("POST", "/api/v1/agent-questions/ask_missing/resolve", { answers: ["x"] });
    expect(unknown.statusCode).toBe(404);

    const malformed = await req("POST", "/api/v1/agent-questions/ask_x/resolve", { answers: "not-an-array" });
    expect(malformed.statusCode).toBe(400);

    // Open a real ask and answer it through the route.
    const events: unknown[] = [];
    const asked = askUser(
      { emit: (e) => events.push(e), db, sessionId: "ses_route", agentId: "agt_default_nova" },
      { sessionId: "ses_route", agentId: "agt_default_nova", questions: [{ question: "Proceed?", options: ["Yes", "No"] }] },
    );
    await vi.waitFor(() => expect(pendingAgentQuestionCount()).toBe(1));
    const questionId = (events[0] as { questionId: string }).questionId;

    // Wrong answer count → 404 (stale card shape).
    const mismatched = await req("POST", `/api/v1/agent-questions/${questionId}/resolve`, { answers: [] });
    expect(mismatched.statusCode).toBe(404);

    const ok = await req("POST", `/api/v1/agent-questions/${questionId}/resolve`, { answers: ["Yes"], sources: ["option"] });
    expect(ok.statusCode).toBe(200);
    expect((await asked).answers).toEqual(["Yes"]);
  });
});
