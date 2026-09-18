/**
 * ROUND-107 (R107-c-impl, F6/F2): the ONE-SHOT's interactive asks — with a
 * TTY stdin (injected as `interactive: true`) the approval y/N and the
 * agent-question numbered prompts ride the turn; piped stdin keeps the
 * "decide in another terminal" hints (nothing may block on a dead stdin).
 * The prompts are injected (the real ones need a live terminal); the SSE
 * bodies + POST capture are stubbed like turn.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { colorKitFor } from "../src/color.js";
import type { Connection } from "../src/connection.js";
import type { CliContext } from "../src/context.js";
import { runOneShot } from "../src/commands/oneshot.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PLAIN_KIT = colorKitFor(false, {});

const CONN: Connection = {
  baseUrl: "http://127.0.0.1:4602",
  token: "oneshot-token",
  source: "env",
  ownsSidecar: false,
  portalFile: null,
  port: 4602,
  spawned: null,
};

/** GET /agents + POST /sessions rows (session bootstrap). */
const AGENT_ROW = {
  id: "a1",
  name: "default",
  role: "worker",
  providerId: null,
  model: null,
  isTemplate: false,
};
const SESSION_ROW = {
  id: "s1",
  projectId: null,
  agentId: "a1",
  mode: "single",
  status: "idle",
  title: "hi",
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

interface Post {
  url: string;
  method: string;
  body: unknown;
}

/** The full one-shot fetch stub: agents/sessions rows + the SSE stream,
 * recording every non-stream call (the decision + resolve POSTs). */
function stubOneShot(sseChunks: readonly string[]): Post[] {
  const posts: Post[] = [];
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      if (target.includes("/api/v1/agents")) {
        return new Response(JSON.stringify({ agents: [AGENT_ROW] }), { status: 200 });
      }
      if (target.endsWith("/api/v1/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify(SESSION_ROW), { status: 202 });
      }
      if (target.includes("/messages/stream")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of sseChunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      posts.push({
        url: target,
        method: String(init?.method ?? "GET"),
        body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  );
  return posts;
}

function makeCtx(overrides: Partial<CliContext> = {}): CliContext {
  return {
    stdout: () => {},
    stderr: () => {},
    kit: PLAIN_KIT,
    plain: true,
    quiet: false,
    json: false,
    autoApprove: false,
    config: {},
    flags: { print: "hi" },
    repoRoot: "/repo",
    conn: CONN,
    ...overrides,
  };
}

describe("runOneShot: the interactive asks (F6)", () => {
  it("interactive: the approval y/N and the question prompt POST their decisions", async () => {
    const posts = stubOneShot([
      'data: {"type":"approval.requested","approvalId":"apr_1","toolName":"run_command","argsSummary":"command: rm -rf /tmp/x","category":"destructive"}\n\n',
      'data: {"type":"agent-question","sessionId":"s1","questionId":"ask_1","questions":[{"question":"Proceed?","options":["yes","no"]}]}\n\n',
      'data: {"type":"done","usage":{"model":"m1","inputTokens":2,"outputTokens":2,"costUsd":0}}\n\n',
    ]);
    let approvalAsked = false;
    let questionAsked = false;
    const ctx = makeCtx();
    const code = await runOneShot(ctx, {
      interactive: true,
      prompts: {
        approval: (ask) => {
          approvalAsked = true;
          expect(ask.approvalId).toBe("apr_1");
          return Promise.resolve("approved" as const);
        },
        question: (ask) => {
          questionAsked = true;
          expect(ask.questionId).toBe("ask_1");
          expect(ask.questions[0]?.options).toEqual(["yes", "no"]);
          return Promise.resolve({ answers: ["yes"], sources: ["option" as const] });
        },
      },
    });
    expect(code).toBe(0);
    expect(approvalAsked).toBe(true);
    expect(questionAsked).toBe(true);
    await vi.waitFor(() => expect(posts.length).toBe(2));
    expect(posts).toContainEqual({
      url: "http://127.0.0.1:4602/api/v1/approvals/apr_1/decision",
      method: "POST",
      body: { decision: "approved" },
    });
    expect(posts).toContainEqual({
      url: "http://127.0.0.1:4602/api/v1/agent-questions/ask_1/resolve",
      method: "POST",
      body: { answers: ["yes"], sources: ["option"] },
    });
  });

  it("piped (the default): the hints render and NOTHING is POSTed — no blocking", async () => {
    const posts = stubOneShot([
      'data: {"type":"approval.requested","approvalId":"apr_1","toolName":"run_command","argsSummary":"command: rm -rf /tmp/x","category":"destructive"}\n\n',
      'data: {"type":"agent-question","sessionId":"s1","questionId":"ask_1","questions":[{"question":"Proceed?","options":["yes"]}]}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    let err = "";
    const ctx = makeCtx({
      stderr: (s) => {
        err += s;
      },
    });
    // no `interactive` → defaults to process.stdin.isTTY (false under vitest)
    const code = await runOneShot(ctx);
    expect(code).toBe(0);
    expect(err).toContain("decide in another terminal: acute raw POST /approvals/apr_1/decision");
    expect(err).toContain("resolve in another terminal: acute raw POST /agent-questions/ask_1/resolve");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts).toHaveLength(0);
  });

  it("the one-shot needs a prompt (the honest usage error)", async () => {
    stubOneShot([]);
    const code = await runOneShot(makeCtx({ flags: {} }));
    expect(code).toBe(1);
  });
});
