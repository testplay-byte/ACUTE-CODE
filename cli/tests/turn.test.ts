/**
 * ROUND-106 (R106-S3, CLI-DESIGN §6): the streamed-turn DRIVER units —
 * runStreamedTurn's exit-code synthesis over the text + NDJSON renderers:
 * done/stopped → 0, error frame → 1, and the R43 rule end-to-end (a stream
 * that dies without a terminal frame gets the synthesized
 * STREAM_DISCONNECTED error frame → exit 1). Fetch is stubbed with canned
 * SSE bodies; no server, no signals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { colorKitFor } from "../src/color.js";
import type { Connection } from "../src/connection.js";
import type { CliContext } from "../src/context.js";
import { runStreamedTurn } from "../src/turn.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PLAIN_KIT = colorKitFor(false, {});

const CONN: Connection = {
  baseUrl: "http://127.0.0.1:4601",
  token: "turn-token",
  source: "env",
  ownsSidecar: false,
  portalFile: null,
  port: 4601,
  spawned: null,
};

interface Harness {
  ctx: CliContext;
  out: string;
  err: string;
}

/** A text-mode CliContext capturing stdout/stderr. */
function makeCtx(overrides: Partial<CliContext> = {}): Harness {
  let out = "";
  let err = "";
  const ctx: CliContext = {
    stdout: (s: string) => {
      out += s;
    },
    stderr: (s: string) => {
      err += s;
    },
    kit: PLAIN_KIT,
    plain: true,
    quiet: false,
    json: false,
    autoApprove: false,
    config: {},
    flags: {},
    repoRoot: "/repo",
    conn: CONN,
    ...overrides,
  };
  return { ctx, get out() { return out; }, get err() { return err; } };
}

/** Install a fetch stub returning a 200 SSE Response with these chunks. */
function stubSse(chunks: readonly string[]): void {
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    async (): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    },
  );
}

describe("runStreamedTurn exit codes (the terminal-frame contract)", () => {
  it("a done turn → exit 0, the text flows, the usage line rides stdout", async () => {
    stubSse([
      'data: {"type":"text-delta","delta":"Hello"}\n\n',
      'data: {"type":"text-delta","delta":" there.\\n"}\n\n',
      'data: {"type":"done","usage":{"model":"m1","inputTokens":9,"outputTokens":3,"costUsd":0}}\n\n',
    ]);
    const h = makeCtx();
    const code = await runStreamedTurn(h.ctx, { sessionId: "s1", content: "hi" });
    expect(code).toBe(0);
    expect(h.out).toContain("Hello there.");
    expect(h.out).toContain("— done · m1 · 9 in · 3 out");
    expect(h.err).toBe("");
  });

  it("a stopped turn → exit 0 with the dim stopped line", async () => {
    stubSse(['data: {"type":"stopped"}\n\n']);
    const h = makeCtx();
    expect(await runStreamedTurn(h.ctx, { sessionId: "s1", content: "hi" })).toBe(0);
    expect(h.out).toContain("— stopped by user");
  });

  it("an error frame → exit 1 with the red envelope on stderr", async () => {
    stubSse([
      'data: {"type":"text-delta","delta":"Trying.\\n"}\n\n',
      'data: {"type":"error","status":409,"code":"CONFLICT","message":"no API key stored for provider \'openrouter\'"}\n\n',
    ]);
    const h = makeCtx();
    expect(await runStreamedTurn(h.ctx, { sessionId: "s1", content: "hi" })).toBe(1);
    expect(h.err).toContain("stream error CONFLICT: no API key stored for provider 'openrouter'");
  });

  it("a stream that dies WITHOUT a terminal frame → STREAM_DISCONNECTED → exit 1 (R43)", async () => {
    stubSse(['data: {"type":"text-delta","delta":"partial answer…"}\n\n']); // then the body ENDS
    const h = makeCtx();
    expect(await runStreamedTurn(h.ctx, { sessionId: "s1", content: "hi" })).toBe(1);
    expect(h.out).toContain("partial answer…");
    expect(h.err).toContain("stream error STREAM_DISCONNECTED:");
    expect(h.err).toContain("ended unexpectedly");
  });

  it("a non-2xx stream POST → the envelope error frame → exit 1", async () => {
    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> =>
        new Response(JSON.stringify({ error: { code: "RATE_LIMIT", message: "slow down" } }), { status: 429 }),
    );
    const h = makeCtx();
    expect(await runStreamedTurn(h.ctx, { sessionId: "s1", content: "hi" })).toBe(1);
    expect(h.err).toContain("stream error RATE_LIMIT: slow down");
  });

  it("network death PROPAGATES (the caller classifies — never a fake exit code)", async () => {
    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> => {
        throw new TypeError("fetch failed");
      },
    );
    const h = makeCtx();
    await expect(runStreamedTurn(h.ctx, { sessionId: "s1", content: "hi" })).rejects.toThrow("fetch failed");
  });
});

describe("runStreamedTurn in --mode json (NDJSON passthrough)", () => {
  it("frames pass through VERBATIM, one per line; done → exit 0", async () => {
    stubSse([
      'data: {"type":"text-delta","delta":"hi"}\n\n',
      'data: {"type":"done","usage":{"model":"m1","inputTokens":1,"outputTokens":1,"costUsd":0}}\n\n',
    ]);
    const h = makeCtx({ json: true, plain: true });
    const code = await runStreamedTurn(h.ctx, { sessionId: "s1", content: "hi" });
    expect(code).toBe(0);
    const lines = h.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"type":"text-delta","delta":"hi"}');
    expect(lines[1]).toBe('{"type":"done","usage":{"model":"m1","inputTokens":1,"outputTokens":1,"costUsd":0}}');
  });

  it("the synthesized disconnect frame rides the NDJSON log too — exit 1", async () => {
    stubSse(['data: {"type":"text-delta","delta":"x"}\n\n']);
    const h = makeCtx({ json: true, plain: true });
    expect(await runStreamedTurn(h.ctx, { sessionId: "s1", content: "hi" })).toBe(1);
    const last = h.out.trimEnd().split("\n").pop() ?? "";
    expect(JSON.parse(last)).toEqual({
      type: "error",
      status: 0,
      code: "STREAM_DISCONNECTED",
      message: "The stream from the agent ended unexpectedly (connection interrupted).",
    });
  });
});
