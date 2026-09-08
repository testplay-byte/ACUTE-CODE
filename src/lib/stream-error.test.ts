/**
 * ROUND-43 stream/store/streaming tests — no silent catches on failed turns.
 *
 *  1. toProjectChatItems folds a persisted `turn.error` event into an error
 *     timeline item (below the failed user message, keeping partial work).
 *  2. streamSessionMessage synthesizes a terminal error frame when the HTTP
 *     stream dies WITHOUT one (socket close without end — the silent-death
 *     path), and does NOT synthesize one after a proper done/stopped frame.
 *  3. The stream store: an SSE {type:"error"} frame sets the live error
 *     state (model threaded from details); {type:"stopped"} — the user stop —
 *     sets NO error state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  streamSessionMessage,
  toProjectChatItems,
  type SessionEvent,
  type StreamTurnEvent,
} from "./api";
import { useStreamStore } from "./stream-store";
import { useActiveStreams } from "./active-streams";
import { useConfigStore } from "./config-store";

function sseResponse(frames: string[]): Response {
    const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  useConfigStore.setState({
    baseUrl: "http://sidecar.test",
    token: "tok_123",
    demoData: false,
  });
  // Isolate the module-level store between tests.
  useStreamStore.setState({ bySession: {} });
  useActiveStreams.setState({ active: new Set<string>() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 1. Folding: turn.error becomes an error timeline item ───────────────────

describe("toProjectChatItems: turn.error folding (ROUND-43)", () => {
  it("folds user message + error item below it (the reload no longer shows nothing)", () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: "message.user",
        agentId: "agt_1",
        payload: { role: "user", content: "summarize the README" },
        ts: "2026-08-26T14:04:00Z",
      },
      {
        seq: 2,
        type: "turn.error",
        agentId: "agt_1",
        payload: {
          code: "PROVIDER_ERROR",
          message: "provider 'openrouter' call failed for session sess_x",
          model: "z-ai/glm-5.2:free",
          providerId: "openrouter",
          providerError: "429 Too Many Requests",
          userSeq: 1,
        },
        ts: "2026-08-26T14:05:00Z",
      },
    ];

    const items = toProjectChatItems(events);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "user", seq: 1, content: "summarize the README" });
    expect(items[1]).toMatchObject({
      kind: "error",
      seq: 2,
      code: "PROVIDER_ERROR",
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
      providerError: "429 Too Many Requests",
      userSeq: 1,
      ts: "2026-08-26T14:05:00Z",
    });
  });

  it("keeps the partial turn (tools) that ran before the failure", () => {
    const events: SessionEvent[] = [
      { seq: 1, type: "message.user", agentId: null, payload: { role: "user", content: "do it" }, ts: "t1" },
      {
        seq: 2,
        type: "tool.use",
        agentId: null,
        payload: { role: "tool", toolName: "read_file", argsSummary: "path: a.ts", ok: true },
        ts: "t2",
      },
      {
        seq: 3,
        type: "turn.error",
        agentId: null,
        payload: { code: "PROVIDER_ERROR", message: "failed", providerError: "500", userSeq: 1 },
        ts: "t3",
      },
    ];
    const items = toProjectChatItems(events);
    expect(items.map((i) => i.kind)).toEqual(["user", "turn", "error"]);
    const turn = items[1];
    expect(turn.kind === "turn" && turn.working).toHaveLength(1);
  });

  it("tolerates a turn.error with a sparse payload (defaults, no crash)", () => {
    const events: SessionEvent[] = [
      { seq: 1, type: "message.user", agentId: null, payload: { role: "user", content: "hi" }, ts: "t1" },
      { seq: 2, type: "turn.error", agentId: null, payload: {}, ts: "t2" },
    ];
    const items = toProjectChatItems(events);
    expect(items[1]).toMatchObject({ kind: "error", code: "PROVIDER_ERROR" });
    expect(items[1]).not.toHaveProperty("model");
  });
});

// ── 2. Abnormal stream end synthesizes a terminal error frame ───────────────

describe("streamSessionMessage terminal-frame synthesis (ROUND-43)", () => {
  it("synthesizes STREAM_DISCONNECTED when the stream ends without a terminal frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"text-delta","delta":"partial "}\n\n',
          // socket dies — no done/error/stopped frame
        ]),
      ),
    );

    const seen: StreamTurnEvent[] = [];
    await streamSessionMessage("sess_x", "hello", (e) => seen.push(e));

    expect(seen.some((e) => e.type === "text-delta")).toBe(true);
    const synth = seen.find((e) => e.type === "error");
    expect(synth).toMatchObject({ type: "error", code: "STREAM_DISCONNECTED" });
  });

  it("does NOT synthesize after a proper done frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"text-delta","delta":"hi"}\n\n',
          `data: ${JSON.stringify({
            type: "done",
            assistantMessage: { seq: 2, role: "assistant", agentId: "a", content: "hi", ts: "t" },
            usage: {
              agentId: "a",
              sessionId: "sess_x",
              provider: "openrouter",
              model: "m",
              inputTokens: 1,
              outputTokens: 1,
              costUsd: 0,
              ts: "t",
            },
          })}\n\n`,
        ]),
      ),
    );

    const seen: StreamTurnEvent[] = [];
    await streamSessionMessage("sess_x", "hello", (e) => seen.push(e));
    expect(seen.some((e) => e.type === "done")).toBe(true);
    expect(seen.some((e) => e.type === "error")).toBe(false);
  });

  it("ROUND-58 (R58-cf): a LOCALLY ABORTED signal never synthesizes STREAM_DISCONNECTED (a stop is not a disconnect)", async () => {
    // Some fetch implementations end the body "cleanly" (done === true, no
    // throw) when the local AbortController fires instead of rejecting the
    // read — before R58-cf that path synthesized a terminal error frame and
    // the UI showed "Generation failed" after a deliberate Stop.
    const controller = new AbortController();
    const encoder = new TextEncoder();
    // The body ends WITHOUT a terminal frame AND the signal is aborted — the
    // exact post-abort shape.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"type":"text-delta","delta":"partial "}\n\n'));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      ),
    );
    controller.abort();

    const seen: StreamTurnEvent[] = [];
    await streamSessionMessage("sess_x", "hello", (e) => seen.push(e), {
      signal: controller.signal,
    });

    expect(seen.some((e) => e.type === "text-delta")).toBe(true);
    expect(seen.some((e) => e.type === "error")).toBe(false);
  });

  it("ROUND-58 (R58-cf): an abort-flavored reader REJECTION propagates (no synthesized frame) so the store classifies it", async () => {
    // The webview's reader-level abort message ("body stream buffer was
    // aborted") — the rejection must bubble up to the store's catch, which
    // classifies by the deliberate-stop flag, never by this message.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"x"}\n\n'));
        c.error(new DOMException("body stream buffer was aborted", "AbortError"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      ),
    );

    const seen: StreamTurnEvent[] = [];
    await expect(
      streamSessionMessage("sess_x", "hello", (e) => seen.push(e)),
    ).rejects.toThrow(/abort/i);
    expect(seen.some((e) => e.type === "error")).toBe(false);
  });
});

// ── 3. Store: error frames surface; stops do not ────────────────────────────

describe("stream store error handling (ROUND-43)", () => {
  it("an SSE error frame sets the live error state with the model threaded from details", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          `data: ${JSON.stringify({
            type: "error",
            status: 502,
            code: "PROVIDER_ERROR",
            message: "provider 'openrouter' call failed for session sess_x",
            details: {
              providerError: "429 Too Many Requests",
              model: "z-ai/glm-5.2:free",
              userSeq: 1,
              errorTs: "2026-08-26T14:05:00.000Z",
            },
          })}\n\n`,
        ]),
      ),
    );

    const promise = useStreamStore.getState().startStream("sess_err", "hello");
    // The store's fetch resolves once the (immediately-closed) stream ends.
    return promise.then(() => {
      const slice = useStreamStore.getState().bySession.sess_err;
      expect(slice?.liveError).toMatchObject({
        code: "PROVIDER_ERROR",
        model: "z-ai/glm-5.2:free",
        providerError: "429 Too Many Requests",
        errorTs: "2026-08-26T14:05:00.000Z",
      });
      expect(slice?.streamBusy).toBe(false);
    });
  });

  it("a user stop ({type:'stopped'}) sets NO error state — stop is not an error", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(['data: {"type":"stopped"}\n\n'])),
    );

    return useStreamStore.getState().startStream("sess_stop", "hello").then(() => {
      const slice = useStreamStore.getState().bySession.sess_stop;
      expect(slice?.liveError).toBeNull();
      expect(slice?.sendError).toBeNull();
    });
  });

  it("a network rejection (non-abort) sets the live error state", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    return useStreamStore.getState().startStream("sess_net", "hello").then(() => {
      const slice = useStreamStore.getState().bySession.sess_net;
      expect(slice?.liveError).toMatchObject({ code: "NETWORK_ERROR" });
      expect(slice?.liveError?.message).toContain("Failed to fetch");
    });
  });

  it("a DELIBERATE user stop (abortStream flagged, then the abort rejection) sets NO error state — R58-cf", async () => {
    // The owner's bug: the local abort surfaced as "Generation failed" +
    // "body stream buffer was aborted". The store now classifies by the
    // DELIBERATE flag abortStream armed BEFORE the rejection, not by the
    // (fetch-implementation-specific) abort message.
    const rejects: Array<(reason: Error) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () => new Promise<Response>((_resolve, reject) => { rejects.push(reject); }),
      ),
    );

    const promise = useStreamStore.getState().startStream("sess_abort", "hello");
    // The user clicks Stop BEFORE the abort rejection can land (the flag
    // arms synchronously — that is the whole classification contract).
    useStreamStore.getState().abortStream("sess_abort");
    // The stream fetch then dies with the abort-flavored error (the grace
    // hard-abort / the webview's reader-level message).
    rejects[0](new Error("body stream buffer was aborted"));

    await promise;
    const slice = useStreamStore.getState().bySession.sess_abort;
    expect(slice?.liveError).toBeNull();
    expect(slice?.sendError).toBeNull();
    // Clean terminal stopped state (NOT the frozen error state).
    expect(slice?.liveTurn?.stopped).toBe(true);
    expect(slice?.liveTurn?.stoppedByUser).toBe(true);
    expect(slice?.lastTurnStoppedByUser).toBe(true);
    expect(slice?.streamBusy).toBe(false);
  });
});

// ── ROUND-77 (R77): the non-2xx envelope rides the error frame ───────────────
// The owner: "show the actual error messages too, which were returned from
// the API". A pre-hijack rejection (validation / auth / 409 / PROVIDER_DISABLED)
// answers JSON, not SSE — the old branch hardcoded code "PROVIDER_ERROR" and
// dropped the envelope's details, so the error card showed the wrong class
// with no context. The frame now carries the REAL code + message + details.
describe("streamSessionMessage non-2xx envelope preservation (ROUND-77)", () => {
  it("a 409 PROVIDER_DISABLED JSON envelope becomes an error frame with the REAL code, message, and details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "PROVIDER_DISABLED",
              message: "Provider 'openrouter' is disabled — enable it in Settings → Models & Providers",
              details: { providerError: "provider disabled at boot" },
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const seen: StreamTurnEvent[] = [];
    await streamSessionMessage("sess_x", "hello", (e) => seen.push(e));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "error",
      status: 409,
      code: "PROVIDER_DISABLED",
      message: "Provider 'openrouter' is disabled — enable it in Settings → Models & Providers",
    });
    // The details ride the frame (the stream store reads providerError /
    // errorClass / attempts from here).
    expect((seen[0] as { details?: Record<string, unknown> }).details).toMatchObject({
      providerError: "provider disabled at boot",
    });
  });

  it("an envelope WITHOUT a code falls back UNAUTHORIZED for 401, PROVIDER_ERROR otherwise", async () => {
    for (const [status, fallback] of [
      [401, "UNAUTHORIZED"],
      [500, "PROVIDER_ERROR"],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { message: `http ${status} failure` } }), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      const seen: StreamTurnEvent[] = [];
      await streamSessionMessage("sess_x", "hello", (e) => seen.push(e));
      expect(seen[0]).toMatchObject({ type: "error", status, code: fallback });
    }
  });

  it("a non-JSON body keeps the honest status fallback text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>gateway crashed</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const seen: StreamTurnEvent[] = [];
    await streamSessionMessage("sess_x", "hello", (e) => seen.push(e));
    expect(seen[0]).toMatchObject({ type: "error", code: "PROVIDER_ERROR" });
    expect((seen[0] as { message: string }).message).toContain("sidecar answered HTTP 502");
  });
});
