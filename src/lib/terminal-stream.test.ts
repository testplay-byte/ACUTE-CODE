/**
 * ROUND-44 (R44-e) — streaming terminal client tests.
 *
 *   1. parseSseDataBlock: the exported SSE frame-block parser — data payload
 *      extraction, `: ping` heartbeat comments ignored, multi-line data
 *      joined, no-space `data:` tolerated, comment-only blocks → null.
 *   2. runProjectTerminalStream: frames fire as they arrive (stdout/stderr/
 *      exit), heartbeat comment frames never reach onFrame, malformed JSON
 *      is skipped, a non-200 endpoint throws (so the panel can fall back),
 *      a stream that dies without a terminal frame synthesizes an error
 *      frame (the ROUND-43 silent-death lesson), and the AbortSignal is
 *      threaded into fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  parseSseDataBlock,
  runProjectTerminalStream,
  type TerminalStreamFrame,
} from "./api";
import { useConfigStore } from "./config-store";

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  useConfigStore.setState({
    baseUrl: "http://sidecar.test",
    token: "tok_123",
    demoData: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 1. The SSE frame-block parser ───────────────────────────────────────────

describe("parseSseDataBlock (ROUND-44 R44-e)", () => {
  it("extracts the payload of a data frame block", () => {
    expect(parseSseDataBlock('data: {"type":"stdout","text":"hello\\n"}')).toBe(
      '{"type":"stdout","text":"hello\\n"}',
    );
  });

  it("returns null for a heartbeat comment frame", () => {
    expect(parseSseDataBlock(": ping")).toBeNull();
    expect(parseSseDataBlock(":ping")).toBeNull();
  });

  it("ignores comment lines inside a mixed block and keeps the data", () => {
    const block = ": ping\ndata: {\"type\":\"exit\",\"code\":0,\"ms\":12}";
    expect(parseSseDataBlock(block)).toBe('{"type":"exit","code":0,"ms":12}');
  });

  it("tolerates a data line without the space and joins multi-line data per the SSE spec", () => {
    expect(parseSseDataBlock("data:{\"a\":1}")).toBe('{"a":1}');
    // The SSE spec concatenates multiple data: lines with \n.
    expect(parseSseDataBlock("data: line1\ndata: line2")).toBe("line1\nline2");
  });

  it("returns null for an empty or non-data block", () => {
    expect(parseSseDataBlock("")).toBeNull();
    expect(parseSseDataBlock("event: custom\nid: 7")).toBeNull();
  });
});

// ── 2. The streaming terminal client ────────────────────────────────────────

describe("runProjectTerminalStream (ROUND-44 R44-e)", () => {
  it("fires onFrame for every frame in order and resolves on stream end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"stdout","text":"hell"}\n\n',
          'data: {"type":"stdout","text":"o\\n"}\n\n',
          'data: {"type":"stderr","text":"warning"}\n\n',
          'data: {"type":"exit","code":0,"ms":42}\n\n',
        ]),
      ),
    );
    const frames: TerminalStreamFrame[] = [];
    await runProjectTerminalStream("prj_1", "echo hello", (f) => frames.push(f));

    expect(frames).toEqual([
      { type: "stdout", text: "hell" },
      { type: "stdout", text: "o\n" },
      { type: "stderr", text: "warning" },
      { type: "exit", code: 0, ms: 42 },
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://sidecar.test/api/v1/projects/prj_1/terminal/stream",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          Authorization: "Bearer tok_123",
        }),
        body: JSON.stringify({ command: "echo hello" }),
      }),
    );
  });

  it("ignores heartbeat comment frames and skips malformed JSON frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          ": ping\n\n",
          'data: {"type":"stdout","text":"chunk"}\n\n',
          "data: {not json}\n\n",
          'data: {"type":"exit","code":1,"ms":5}\n\n',
        ]),
      ),
    );
    const frames: TerminalStreamFrame[] = [];
    await runProjectTerminalStream("prj_1", "false", (f) => frames.push(f));

    expect(frames).toEqual([
      { type: "stdout", text: "chunk" },
      { type: "exit", code: 1, ms: 5 },
    ]);
  });

  it("synthesizes an error frame when the stream dies without a terminal frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(['data: {"type":"stdout","text":"partial"}\n\n'])),
    );
    const frames: TerminalStreamFrame[] = [];
    await runProjectTerminalStream("prj_1", "longcmd", (f) => frames.push(f));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ type: "stdout", text: "partial" });
    expect(frames[1]?.type).toBe("error");
  });

  it("throws ApiError with the envelope message on a non-200 endpoint (panel fallback path)", async () => {
    // Fresh Response per call — a Response body can only be consumed once.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        jsonResponse(404, { error: { code: "NOT_FOUND", message: "no project with id prj_1" } }),
      ),
    );
    const frames: TerminalStreamFrame[] = [];
    await expect(
      runProjectTerminalStream("prj_1", "echo hi", (f) => frames.push(f)),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      runProjectTerminalStream("prj_1", "echo hi", (f) => frames.push(f)),
    ).rejects.toMatchObject({ status: 404, message: "no project with id prj_1" });
    // No frames fired — the caller falls back to the sync terminal route.
    expect(frames).toEqual([]);
  });

  it("threads the AbortSignal into fetch so Stop works", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(['data: {"type":"exit","code":0,"ms":1}\n\n']),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await runProjectTerminalStream("prj_1", "echo hi", () => {}, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
