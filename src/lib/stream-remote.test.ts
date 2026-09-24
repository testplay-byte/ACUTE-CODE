/**
 * ROUND-113 (R113-b) stream-store REMOTE-MIRROR tests — the events stream's
 * turn frames replayed into the live transcript by ingestRemoteFrame:
 *
 *  1. An OWN stream in flight → the frame is IGNORED (the initiating
 *     client's own reader renders that turn; a mirror would double-render).
 *  2. Idle → the frame lands through the SAME reducer the own path uses:
 *     thinking/text accumulate, tool calls mirror as working entries
 *     (ok:null = the running badge), queue chips push, and the slice is
 *     marked remote:true with the sidebar spinner running.
 *  3. A terminal frame (done/error) applies its terminal effects FIRST
 *     (lastAssistantSeq, the live error card) and retires the mirror after
 *     the beat — liveTurn clears, liveError survives (the folded
 *     turn.error event takes over via the panel's errorTs match).
 *  4. A live frame after a terminal one cancels the pending retire (a new
 *     turn is streaming — the mirror must not vanish under it).
 *  5. An own startStream TAKES the slice back from the mirror (remote
 *     flips false), and mirrored frames of the OWN turn stay ignored while
 *     streamBusy is true (the double-render protection, end-to-end).
 *
 * Same driving pattern as stream-store.test.ts: stub global fetch with an
 * SSE Response carrying the frames, drive the store, assert on the slices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { useConfigStore } from "./config-store";
import { setQueryClient } from "./query-client";
import { useStreamStore, clearStreamSessionProjectsForTest } from "./stream-store";
import { useActiveStreams } from "./active-streams";
import type { StreamTurnEvent } from "./api";

function sseResponse(frames: StreamTurnEvent[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const SID = "sess_mirror_r113b";

beforeEach(() => {
  useConfigStore.setState({
    baseUrl: "http://sidecar.test",
    token: "tok_123",
    demoData: false,
  });
  setQueryClient(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
  useActiveStreams.setState({ active: new Set<string>() });
  clearStreamSessionProjectsForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stream store remote mirror (ROUND-113 R113-b)", () => {
  it("an OWN stream in flight → the mirrored frame is ignored (no double-render)", () => {
    // Seed an own-stream slice exactly as startStream leaves it mid-turn
    // (busy, own liveTurn rendering the initiating client's frames).
    useStreamStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [SID]: {
          liveTurn: {
            startedAtMs: Date.now(),
            working: [],
            streamText: "own text",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          },
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: 0,
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
          feedbackEvent: null,
        },
      },
    }));

    useStreamStore.getState().ingestRemoteFrame(SID, { type: "text-delta", delta: "remote!" });

    // The own stream's frames own the render — the mirrored delta never landed.
    expect(useStreamStore.getState().bySession[SID]?.liveTurn?.streamText).toBe("own text");
  });

  it("idle session → frames land through the shared reducer as a REMOTE mirror (text, tools, queue chips)", () => {
    const ingest = useStreamStore.getState().ingestRemoteFrame;

    ingest(SID, { type: "thinking-delta", delta: "Planning" });
    ingest(SID, { type: "text-delta", delta: "Hello " });
    ingest(SID, { type: "text-delta", delta: "world" });
    ingest(SID, { type: "tool-call", toolName: "read_file", argsSummary: "src/a.ts" });
    ingest(SID, {
      type: "user.queued",
      seq: 12,
      content: "follow-up from the phone",
      ts: "2026-09-01T10:00:00Z",
    });

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.remote).toBe(true);
    expect(slice?.streamBusy).toBe(false); // a mirror never owns a fetch
    // The shared reducer's own-stream segmentation carries over
    // byte-for-byte: a tool call FLUSHES the streamed text into the
    // working section (R64-c — intermediate answers render between tool
    // sections), so the live tail is empty and the section holds the
    // thinking entry, the text entry, and the in-flight tool row.
    expect(slice?.liveTurn?.streamText).toBe("");
    expect(slice?.liveTurn?.working).toEqual([
      expect.objectContaining({ type: "thinking", text: "Planning" }),
      expect.objectContaining({ type: "text", content: "Hello world" }),
      expect.objectContaining({ type: "tool" }),
    ]);
    // The tool mirrors as an in-flight working entry — the running badge's
    // source (ok === null), exactly like an own stream's tool row.
    const toolEntry = slice?.liveTurn?.working.find((e) => e.type === "tool");
    expect(toolEntry).toMatchObject({ type: "tool", tool: { toolName: "read_file", ok: null } });
    // The queue chip renders from the mirror (the phone queued a message).
    expect(slice?.queued).toHaveLength(1);
    expect(slice?.queued[0]).toMatchObject({ seq: 12, content: "follow-up from the phone" });
    // The sidebar spinner is ON — a turn is running server-side.
    expect(useActiveStreams.getState().active.has(SID)).toBe(true);

    // A tool RESULT settles the mirrored row (the running badge clears).
    ingest(SID, {
      type: "tool-result",
      toolName: "read_file",
      argsSummary: "src/a.ts",
      ok: true,
      outputSummary: "42 lines",
    });
    const settled = useStreamStore
      .getState()
      .bySession[SID]?.liveTurn?.working.find((e) => e.type === "tool");
    expect(settled).toMatchObject({ type: "tool", tool: { ok: true, outputSummary: "42 lines" } });
  });

  it("terminal done → terminal effects apply, then the mirror RETIRES after the beat (spinner stops, queue hands off)", () => {
    vi.useFakeTimers();
    const ingest = useStreamStore.getState().ingestRemoteFrame;

    ingest(SID, { type: "text-delta", delta: "final answer" });
    ingest(SID, {
      type: "done",
      assistantMessage: {
        seq: 41,
        role: "assistant",
        agentId: "ag_1",
        content: "final answer",
        ts: "2026-09-01T10:00:05Z",
      },
      usage: {
        agentId: "ag_1",
        sessionId: SID,
        provider: "openrouter",
        model: "m",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0,
        ts: "2026-09-01T10:00:05Z",
      },
    });

    // Terminal effects landed FIRST — the rating key rides the live turn
    // until the fold takes over.
    expect(useStreamStore.getState().bySession[SID]?.liveTurn?.lastAssistantSeq).toBe(41);

    // …and the spinner stops the moment the turn is over server-side.
    expect(useActiveStreams.getState().active.has(SID)).toBe(false);

    // Pre-retire: the mirror is still visible while the folded log catches up.
    expect(useStreamStore.getState().bySession[SID]?.liveTurn).not.toBeNull();

    vi.advanceTimersByTime(1_500);

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.liveTurn).toBeNull();
    expect(slice?.remote).toBe(false);
    // The queue state hands off to the refetched folded log.
    expect(slice?.queued).toEqual([]);
    expect(slice?.deliveredQueued).toEqual([]);
  });

  it("terminal error → the live error card SURVIVES the retire (the folded turn.error takes over later)", () => {
    vi.useFakeTimers();
    const ingest = useStreamStore.getState().ingestRemoteFrame;

    ingest(SID, { type: "text-delta", delta: "partial" });
    ingest(SID, {
      type: "error",
      status: 502,
      code: "PROVIDER_ERROR",
      message: "upstream exploded",
    });

    expect(useStreamStore.getState().bySession[SID]?.liveError).toMatchObject({
      code: "PROVIDER_ERROR",
      message: "upstream exploded",
    });

    vi.advanceTimersByTime(1_500);

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.liveTurn).toBeNull();
    expect(slice?.liveError).toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("a LIVE frame after a terminal one cancels the pending retire — a new turn is streaming", () => {
    vi.useFakeTimers();
    const ingest = useStreamStore.getState().ingestRemoteFrame;

    ingest(SID, { type: "text-delta", delta: "turn one" });
    ingest(SID, { type: "stopped" });
    // 1s into the 1.5s retire window, a NEW turn's first frame lands.
    vi.advanceTimersByTime(1_000);
    ingest(SID, { type: "text-delta", delta: "turn two" });
    vi.advanceTimersByTime(1_000);

    // The retire was called off: the fresh remote turn is still live (and
    // its frames reset the slice — turn one's text does not leak in).
    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.liveTurn?.streamText).toBe("turn two");
    expect(slice?.remote).toBe(true);
    expect(useActiveStreams.getState().active.has(SID)).toBe(true);
  });

  it("an own startStream TAKES the slice back from the mirror; mirrored frames of the OWN turn stay ignored while busy", async () => {
    // A remote mirror is live…
    useStreamStore.getState().ingestRemoteFrame(SID, { type: "text-delta", delta: "phone's turn" });
    expect(useStreamStore.getState().bySession[SID]?.remote).toBe(true);

    // …then this desktop sends its own message (the phone's turn ended
    // server-side between the frames — the own POST succeeds).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "text-delta", delta: "own text" },
          {
            type: "done",
            assistantMessage: {
              seq: 9,
              role: "assistant",
              agentId: "ag_1",
              content: "own text",
              ts: "2026-09-01T10:01:00Z",
            },
            usage: {
              agentId: "ag_1",
              sessionId: SID,
              provider: "openrouter",
              model: "m",
              inputTokens: 1,
              outputTokens: 1,
              costUsd: 0,
              ts: "2026-09-01T10:01:00Z",
            },
          },
        ]),
      ),
    );

    // The own turn's frames ALSO arrive mirrored on the events stream (the
    // bus echoes the initiator's own frames back to it) — while the own
    // stream is busy they must be ignored.
    const echoMirrors = () => {
      useStreamStore.getState().ingestRemoteFrame(SID, { type: "text-delta", delta: "ECHO" });
    };

    const own = useStreamStore.getState().startStream(SID, "desktop message");
    // The store flipped to own ownership the moment the turn started.
    expect(useStreamStore.getState().bySession[SID]?.remote).toBe(false);

    echoMirrors();
    await own;

    // The own frames rendered; the mirrored echo never doubled them.
    expect(useStreamStore.getState().bySession[SID]?.liveTurn?.streamText).toBe("own text");
  });

  it("a terminal frame with NO live mirror is a pure invalidation story (nothing to retire)", () => {
    vi.useFakeTimers();
    // Joined the stream after the turn's last real frame: the first frame
    // we see IS the terminal one.
    useStreamStore.getState().ingestRemoteFrame(SID, { type: "stopped" });

    expect(useStreamStore.getState().bySession[SID]).toBeUndefined();
    vi.advanceTimersByTime(2_000);
    expect(useStreamStore.getState().bySession[SID]).toBeUndefined();
  });
});

// ── ROUND-114 (R114-e): turn.started — the instant remote mirror open ────────

describe("stream store remote mirror · turn.started (ROUND-114 R114-e)", () => {
  it("turn.started opens the mirror INSTANTLY with the user text + resolved model (the composer flip)", () => {
    useStreamStore.getState().ingestRemoteFrame(SID, {
      type: "turn.started",
      text: "hey from the phone",
      model: "z-ai/glm-4.7",
      providerId: "zai",
    });

    const slice = useStreamStore.getState().bySession[SID];
    // The mirror is OPEN and marked remote — remoteRunning keys off exactly
    // this (slice.remote + liveTurn + !stopped), so the composer flips to
    // Stop + Queue within the frame's arrival, not after the folded refetch.
    expect(slice?.remote).toBe(true);
    expect(slice?.streamBusy).toBe(false);
    expect(slice?.liveTurn).not.toBeNull();
    expect(slice?.liveTurn?.stopped).toBe(false);
    // The turn's resolved model + the phone's user text ride the live turn
    // (the panel renders the user bubble + the honest model label from
    // them while the folded log catches up).
    expect(slice?.liveTurn?.model).toBe("z-ai/glm-4.7");
    expect(slice?.liveTurn?.userText).toBe("hey from the phone");
    // The sidebar spinner marks the session as running server-side.
    expect(useActiveStreams.getState().active.has(SID)).toBe(true);
    // No content yet — the "Thinking…" placeholder's exact precondition
    // (empty text + thinking + working), verified on the store shape.
    expect(slice?.liveTurn?.streamText).toBe("");
    expect(slice?.liveTurn?.streamThinking).toBe("");
    expect(slice?.liveTurn?.working).toEqual([]);
  });

  it("turn.started followed by deltas keeps streaming normally (the mirror never resets mid-turn)", () => {
    const ingest = useStreamStore.getState().ingestRemoteFrame;
    ingest(SID, { type: "turn.started", text: "hi", model: "m1", providerId: "p1" });
    ingest(SID, { type: "text-delta", delta: "answer" });

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.liveTurn?.userText).toBe("hi");
    expect(slice?.liveTurn?.model).toBe("m1");
    expect(slice?.liveTurn?.streamText).toBe("answer");
  });

  it("an OWN stream in flight → the mirrored turn.started is ignored (no double user text)", () => {
    // Seed an own-stream slice exactly as startStream leaves it mid-turn.
    useStreamStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [SID]: {
          liveTurn: {
            startedAtMs: Date.now(),
            working: [],
            streamText: "",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          },
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: "own message",
          lastLiveEndMs: 0,
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
          feedbackEvent: null,
        },
      },
    }));

    useStreamStore.getState().ingestRemoteFrame(SID, {
      type: "turn.started",
      text: "echo of own message",
      model: "m",
      providerId: "p",
    });

    // The own reader owns the render: the mirrored opening frame never
    // stamped userText/model onto the OWN live turn.
    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.remote).toBe(false);
    expect(slice?.liveTurn?.userText).toBeUndefined();
    expect(slice?.liveTurn?.model).toBeUndefined();
    expect(slice?.pendingEcho).toBe("own message");
  });

  it("turn.started after a retired turn opens a FRESH mirror (reset, no stale userText/model)", () => {
    vi.useFakeTimers();
    const ingest = useStreamStore.getState().ingestRemoteFrame;
    ingest(SID, { type: "turn.started", text: "turn one", model: "m1", providerId: "p1" });
    ingest(SID, { type: "stopped" });
    vi.advanceTimersByTime(1_500);
    // The retire cleared the mirror.
    expect(useStreamStore.getState().bySession[SID]?.liveTurn).toBeNull();

    ingest(SID, { type: "turn.started", text: "turn two", model: "m2", providerId: "p2" });
    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.remote).toBe(true);
    expect(slice?.liveTurn?.userText).toBe("turn two");
    expect(slice?.liveTurn?.model).toBe("m2");
  });
});
