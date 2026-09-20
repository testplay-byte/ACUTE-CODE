/**
 * ROUND-113 (R113-b) events-stream tests — the desktop's events-stream
 * client pins, split exactly like the module:
 *
 *  1. parseEventsFrameLine — the PURE parser: `data: {json}` lines parse,
 *     `: ping` heartbeats / blank lines / malformed payloads return null.
 *  2. openEventsStream — the transport: an SSE response's frames all fire
 *     onFrame in order; the comment heartbeat never does.
 *  3. handleEventsFrame — the dispatch:
 *     · hello → the resync sweep (sessions/projects/session/settings);
 *     · session frames → the DEBOUNCED session+sessions invalidation (a
 *       rapid burst collapses into ONE refetch; kind:"created" adds projects
 *       immediately);
 *     · turn frames → the remote mirror lands in the stream store (remote
 *       flag, live text) and TERMINAL frames additionally invalidate the
 *       folded log + usage + context meter;
 *     · project frames → the projects list;
 *     · settings frames → "appearance" applies into the theme store (no
 *       query), a known domain invalidates its own key, an unknown domain
 *       falls back to the ["settings"] prefix.
 *
 * Same driving pattern as stream-store.test.ts: a real QueryClient with an
 * invalidateQueries spy, module stores reset per test, SSE Responses stubbed
 * onto global fetch where the transport itself is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { useConfigStore } from "./config-store";
import { useStreamStore } from "./stream-store";
import { useActiveStreams } from "./active-streams";
import { useThemeStore } from "./theme-store";
import {
  handleEventsFrame,
  openEventsStream,
  parseEventsFrameLine,
  resetEventsStreamStateForTest,
  type EventsStreamFrame,
} from "./events-stream";

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const SID = "sess_remote_r113b";

/** A minimal session frame (the wire shape from agent-core events-bus.ts). */
function sessionFrame(over: Partial<Extract<EventsStreamFrame, { type: "session" }>> = {}): EventsStreamFrame {
  return {
    type: "session",
    sessionId: SID,
    projectId: null,
    kind: "event",
    ...over,
  };
}

beforeEach(() => {
  useConfigStore.setState({
    baseUrl: "http://sidecar.test",
    token: "tok_123",
    demoData: false,
  });
  // Isolate the module-level stores between tests.
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
  useActiveStreams.setState({ active: new Set<string>() });
  useThemeStore.setState({ themeId: "nova", mode: "dark" });
  resetEventsStreamStateForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetEventsStreamStateForTest();
});

describe("parseEventsFrameLine (the pure parser)", () => {
  it("parses a data: frame's JSON payload", () => {
    expect(parseEventsFrameLine('data: {"type":"hello"}')).toEqual({ type: "hello" });
    expect(
      parseEventsFrameLine(
        'data: {"type":"session","sessionId":"s1","projectId":null,"kind":"status","status":"running"}',
      ),
    ).toEqual({ type: "session", sessionId: "s1", projectId: null, kind: "status", status: "running" });
    expect(parseEventsFrameLine('data: {"type":"project","projectId":"p1","kind":"created"}')).toEqual({
      type: "project",
      projectId: "p1",
      kind: "created",
    });
  });

  it("returns null for the `: ping` heartbeat comment, blanks and non-data lines", () => {
    expect(parseEventsFrameLine(": ping")).toBeNull();
    expect(parseEventsFrameLine("")).toBeNull();
    expect(parseEventsFrameLine("event: session")).toBeNull();
  });

  it("returns null for a malformed JSON payload (never throws, never kills the stream)", () => {
    expect(parseEventsFrameLine("data: {not json")).toBeNull();
    expect(parseEventsFrameLine("data: ")).toBeNull();
  });
});

describe("openEventsStream (the transport)", () => {
  it("delivers every data frame in order and never fires for `: ping` comments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"hello"}\n\n',
          ": ping\n\n",
          'data: {"type":"session","sessionId":"s1","projectId":"p1","kind":"event","seq":7}\n\n',
          ": ping\n\n",
          'data: {"type":"settings","domain":"appearance","value":{"themeId":"bento","mode":"light"}}\n\n',
        ]),
      ),
    );

    const frames: EventsStreamFrame[] = [];
    await openEventsStream((frame) => {
      frames.push(frame);
    });

    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({ type: "hello" });
    expect(frames[1]).toMatchObject({ type: "session", sessionId: "s1", seq: 7 });
    expect(frames[2]).toMatchObject({ type: "settings", domain: "appearance" });
  });

  it("throws on non-2xx so the caller's reconnect loop can retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    );
    await expect(openEventsStream(() => undefined)).rejects.toThrow("HTTP 503");
  });

  it("sends the bearer token + Accept header to the events route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: {"type":"hello"}\n\n']));
    vi.stubGlobal("fetch", fetchMock);

    await openEventsStream(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/events/stream");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_123");
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });
});

describe("handleEventsFrame (the dispatch)", () => {
  function makeQC() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    return { qc, invalidateSpy };
  }

  /** Collect the query keys an invalidateQueries spy was called with (the
   * structural mock type keeps the helper free of vitest generics). */
  function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[][] {
    return spy.mock.calls.map((call) => (call[0] as { queryKey: unknown[] }).queryKey);
  }

  it("hello → the resync sweep: sessions, projects, session details, settings", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, { type: "hello" });
    expect(invalidatedKeys(invalidateSpy)).toEqual(
      expect.arrayContaining([["sessions"], ["projects"], ["session"], ["settings"]]),
    );
  });

  it("session frames invalidate session+sessions DEBOUNCED — a rapid burst collapses into ONE refetch", () => {
    vi.useFakeTimers();
    const { qc, invalidateSpy } = makeQC();

    // Five frames inside the window (a streaming turn's per-event frames).
    for (let i = 0; i < 5; i += 1) {
      handleEventsFrame(qc, sessionFrame({ seq: i + 1 }));
    }

    // Nothing fired yet — the trailing debounce is still pending.
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    // Exactly ONE ["session"] + ONE ["sessions"] invalidation for the burst.
    const sessionKeys = invalidatedKeys(invalidateSpy).filter(
      (k) => k.length === 1 && k[0] === "session",
    );
    const sessionsKeys = invalidatedKeys(invalidateSpy).filter(
      (k) => k.length === 1 && k[0] === "sessions",
    );
    expect(sessionKeys).toHaveLength(1);
    expect(sessionsKeys).toHaveLength(1);
  });

  it("session kind:'created' invalidates the projects list immediately (not debounced)", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, sessionFrame({ kind: "created" }));
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["projects"]);
  });

  it("project frames invalidate the projects list", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, { type: "project", projectId: "p_new", kind: "created" });
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["projects"]);
  });

  it("turn frames land in the stream store as a REMOTE mirror (remote flag + live text)", () => {
    const { qc } = makeQC();
    handleEventsFrame(qc, { type: "turn", sessionId: SID, frame: { type: "thinking-delta", delta: "Reason" } });
    handleEventsFrame(qc, { type: "turn", sessionId: SID, frame: { type: "text-delta", delta: "Hello" } });

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.remote).toBe(true);
    expect(slice?.streamBusy).toBe(false);
    // The shared reducer's own-stream semantics carry over byte-for-byte:
    // text starting COMPLETES the in-flight thought (it moves into the
    // working section) and the presumptive-final text streams below.
    expect(slice?.liveTurn?.streamText).toBe("Hello");
    expect(slice?.liveTurn?.working).toEqual([
      expect.objectContaining({ type: "thinking", text: "Reason" }),
    ]);
    // The sidebar spinner mark: a turn IS running on the server.
    expect(useActiveStreams.getState().active.has(SID)).toBe(true);
  });

  it("non-terminal turn frames do NOT invalidate the usage/context queries", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, { type: "turn", sessionId: SID, frame: { type: "text-delta", delta: "x" } });
    const keys = invalidatedKeys(invalidateSpy).map((k) => k.join("/"));
    expect(keys).not.toContain("usage");
    expect(keys).not.toContain("session-context");
  });

  it("a TERMINAL turn frame (done) invalidates the folded log + usage + context meter", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, { type: "turn", sessionId: SID, frame: { type: "done" } });
    expect(invalidatedKeys(invalidateSpy)).toEqual(
      expect.arrayContaining([["session"], ["sessions"], ["usage"], ["session-context"]]),
    );
  });

  it("terminal stopped/error frames carry the same invalidation set", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, { type: "turn", sessionId: SID, frame: { type: "stopped" } });
    handleEventsFrame(qc, { type: "turn", sessionId: SID, frame: { type: "error", status: 502, code: "PROVIDER_ERROR", message: "upstream" } });
    const sessionKeys = invalidatedKeys(invalidateSpy).filter(
      (k) => k.length === 1 && k[0] === "session",
    );
    expect(sessionKeys).toHaveLength(2);
  });

  it("a malformed turn frame (no object/type) is dropped, not guessed", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, { type: "turn", sessionId: SID, frame: "not-an-object" });
    handleEventsFrame(qc, { type: "turn", sessionId: SID, frame: { noType: true } });
    expect(useStreamStore.getState().bySession[SID]).toBeUndefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("settings 'appearance' applies into the theme store (no query invalidation)", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, {
      type: "settings",
      domain: "appearance",
      value: { themeId: "clay", mode: "light" },
    });

    expect(useThemeStore.getState().themeId).toBe("clay");
    expect(useThemeStore.getState().mode).toBe("light");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("a known settings domain invalidates ITS OWN query key; an unknown domain falls back to the ['settings'] prefix", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, { type: "settings", domain: "retry", value: { ladderEnabled: true } });
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["retry-settings"]);

    handleEventsFrame(qc, { type: "settings", domain: "some-future-domain", value: {} });
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["settings"]);
  });
});
