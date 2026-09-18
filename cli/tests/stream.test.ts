/**
 * ROUND-106 (R106-S3, CLI-DESIGN §6): the SSE READER units — canned byte
 * streams fed through a stubbed fetch, with chunk boundaries deliberately
 * MID-FRAME (inside the `data: ` prefix, inside the JSON payload, inside the
 * `\n\n` separator), plus the terminal-frame contract: done/stopped/error
 * stop reading early, a stream that dies without one gets the synthesized
 * STREAM_DISCONNECTED error frame (the R43 rule), the local-abort carve-out
 * never synthesizes, and non-2xx bodies become exactly ONE error frame.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../src/connection.js";
import { streamTurn } from "../src/stream.js";
import type { TurnFrame } from "../src/frames.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CONN: Connection = {
  baseUrl: "http://127.0.0.1:4600",
  token: "stream-token",
  source: "env",
  ownsSidecar: false,
  portalFile: null,
  port: 4600,
  spawned: null,
};

/** Build a 200 SSE Response whose body emits the given STRING chunks. */
function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Stub {
  calls: Array<{ url: string; init: RequestInit }>;
}

/** Install a fetch stub returning `responder(url, init)`; captures the calls. */
function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): Stub {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return await responder(url, init);
  });
  return { calls };
}

/** Collect every frame the reader delivers. */
function collect(frames: TurnFrame[]): (frame: TurnFrame) => boolean {
  return (frame) => {
    frames.push(frame);
    return false;
  };
}

describe("the SSE read loop (chunk boundaries mid-frame)", () => {
  it("a frame split INSIDE its JSON payload across two chunks still parses whole", async () => {
    stubFetch(() =>
      sseResponse([
        // ↓ three chunk boundaries land MID-JSON inside one frame
        'data: {"type":"text-del',
        'ta","delta":"wor",',
        '"text":"ld"}',
        "\n\n",
        'data: {"type":"done"}\n\n',
      ]),
    );
    const frames: TurnFrame[] = [];
    await streamTurn(CONN, "s1", "hi", collect(frames));
    expect(frames).toEqual([{ type: "text-delta", delta: "wor", text: "ld" }, { type: "done" }]);
  });

  it("a boundary inside the `data: ` prefix and inside the `\\n\\n` separator", async () => {
    stubFetch(() =>
      sseResponse([
        "da", // ← boundary inside the prefix
        "ta: ",
        '{"type":"text-delta","delta":"a"}',
        "\n", // ← the separator's FIRST newline…
        "\n", // …and its second, in separate chunks
        "data: ",
        '{"type":"text-delta","delta":"b"}\n',
        "\ndata: ",
        '{"type":"done"}',
        "\n\n",
      ]),
    );
    const frames: TurnFrame[] = [];
    await streamTurn(CONN, "s1", "hi", collect(frames));
    expect(frames.map((f) => f.type)).toEqual(["text-delta", "text-delta", "done"]);
    expect((frames[0] as { delta: string }).delta).toBe("a");
    expect((frames[1] as { delta: string }).delta).toBe("b");
  });

  it("non-data lines (SSE comments, event: lines) are skipped; multi-line frames keep only data", async () => {
    stubFetch(() =>
      sseResponse([
        ": stream opened\n",
        "event: message\n",
        'data: {"type":"text-delta","delta":"x"}\n',
        "\n",
        "ping\n\n",
        'data: {"type":"stopped"}\n\n',
      ]),
    );
    const frames: TurnFrame[] = [];
    await streamTurn(CONN, "s1", "hi", collect(frames));
    expect(frames).toEqual([{ type: "text-delta", delta: "x" }, { type: "stopped" }]);
  });

  it("malformed `data: ` payloads are skipped, never fatal", async () => {
    stubFetch(() =>
      sseResponse([
        "data: {not json at all}\n\n",
        "data: [1,2,3]\n\n", // an array is not a frame
        'data: {"type":""}\n\n', // empty type string is not a frame
        'data: {"type":"done"}\n\n',
      ]),
    );
    const frames: TurnFrame[] = [];
    await streamTurn(CONN, "s1", "hi", collect(frames));
    expect(frames).toEqual([{ type: "done" }]);
  });
});

describe("the POST shape", () => {
  it("the request targets the stream route with Bearer auth and the JSON body", async () => {
    const { calls } = stubFetch(() => sseResponse(['data: {"type":"done"}\n\n']));
    await streamTurn(CONN, "sess-42", "say hi", collect([]), { model: "m1", providerId: "openrouter" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:4600/api/v1/sessions/sess-42/messages/stream");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer stream-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      content: "say hi",
      model: "m1",
      providerId: "openrouter",
    });
  });

  it("undefined options stay OUT of the body (content only)", async () => {
    const { calls } = stubFetch(() => sseResponse(['data: {"type":"done"}\n\n']));
    await streamTurn(CONN, "s", "x", collect([]));
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ content: "x" });
  });
});

describe("the terminal-frame contract (R43)", () => {
  it("onFrame returning true stops reading EARLY — later frames never arrive", async () => {
    stubFetch(() =>
      sseResponse([
        'data: {"type":"text-delta","delta":"a"}\n\n',
        'data: {"type":"done"}\n\n',
        'data: {"type":"text-delta","delta":"after-done"}\n\n', // must NOT be read
      ]),
    );
    const frames: TurnFrame[] = [];
    const stopAtTerminal = (frame: TurnFrame): boolean =>
      frame.type === "done" || frame.type === "stopped" || frame.type === "error";
    await streamTurn(CONN, "s", "x", (frame) => {
      frames.push(frame);
      return stopAtTerminal(frame);
    });
    expect(frames.map((f) => f.type)).toEqual(["text-delta", "done"]);
  });

  it("a stream that ends WITHOUT a terminal frame gets the synthesized STREAM_DISCONNECTED", async () => {
    stubFetch(() => sseResponse(['data: {"type":"text-delta","delta":"partial…"}\n\n']));
    const frames: TurnFrame[] = [];
    await streamTurn(CONN, "s", "x", collect(frames));
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({
      type: "error",
      status: 0,
      code: "STREAM_DISCONNECTED",
      message: "The stream from the agent ended unexpectedly (connection interrupted).",
    });
  });

  it("the local-abort carve-out: an aborted signal NEVER synthesizes the disconnect", async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(() => sseResponse(['data: {"type":"text-delta","delta":"x"}\n\n'])); // completes, no terminal
    const frames: TurnFrame[] = [];
    await streamTurn(CONN, "s", "x", collect(frames), { signal: controller.signal });
    expect(frames).toEqual([{ type: "text-delta", delta: "x" }]); // no synthesized error
  });

  it("a fetch rejection PROPAGATES (the caller classifies) unless aborted", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(streamTurn(CONN, "s", "x", collect([]))).rejects.toThrow("fetch failed");
  });
});

describe("the non-2xx path (the envelope is JSON, not SSE)", () => {
  it("the error envelope becomes exactly ONE synthesized error frame — never a throw", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: "CONFLICT", message: "no API key stored for provider 'openrouter'" } }),
          { status: 409 },
        ),
    );
    const frames: TurnFrame[] = [];
    await streamTurn(CONN, "s", "x", collect(frames));
    expect(frames).toEqual([
      {
        type: "error",
        status: 409,
        code: "CONFLICT",
        message: "no API key stored for provider 'openrouter'",
      },
    ]);
  });

  it("a body-less failure (proxy 502) still yields one honest error frame", async () => {
    stubFetch(() => new Response("", { status: 502 }));
    const frames: TurnFrame[] = [];
    await streamTurn(CONN, "s", "x", collect(frames));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("error");
    expect((frames[0] as { code: string }).code).toBe("HTTP_502");
    expect((frames[0] as { message: string }).message).toBe("(empty body, HTTP 502)");
  });
});
