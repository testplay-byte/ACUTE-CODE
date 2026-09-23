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
 *       immediately); ROUND-114 (R114-e): kind:"meta" skips the debounce
 *       entirely (a preference patch is one tiny row write — the phone's
 *       model pick flips the desktop's composer the moment the frame lands);
 *     · turn frames → the remote mirror lands in the stream store (remote
 *       flag, live text) and TERMINAL frames additionally invalidate the
 *       folded log + usage + context meter; R114-e: turn.started opens the
 *       mirror INSTANTLY with the user text + resolved model;
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
// R115-E2: the device-created navigation bridge + the local-toast surface
// the busy guard rides (both consumed by the dispatcher under test).
import { useSessionNavStore } from "./session-nav-store";
import { useNotificationStreamStore } from "../hooks/use-notifications";
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
  // Isolate the module-level stores between tests (R114-e: the FULL
  // appearance shape — the appearance-frame tests assert the chat fields).
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
  useActiveStreams.setState({ active: new Set<string>() });
  useThemeStore.setState({
    themeId: "nova",
    mode: "dark",
    density: "comfortable",
    chatTextSize: "medium",
    timestampsMode: "hidden",
    activityMode: "detailed",
  });
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

  // ── ROUND-114 (R114-e): kind:"meta" — a preference patch (permissionMode /
  // activeMode / selectedModel) skips the debounce ENTIRELY so a phone-side
  // model pick flips the desktop's composer display the moment the frame
  // lands (the 300ms debounce would only add latency for zero dedupe value). ──
  it("kind:'meta' invalidates session+sessions IMMEDIATELY — no debounce, no timer left pending", () => {
    vi.useFakeTimers();
    const { qc, invalidateSpy } = makeQC();

    handleEventsFrame(qc, sessionFrame({
      kind: "meta",
      selectedModel: { providerId: "zai", model: "z-ai/glm-4.7" },
    }));

    // The invalidation fired SYNCHRONOUSLY — the composer's model display
    // seeds from the refetched session row's selectedModel.
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["session"]);
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["sessions"]);

    // And no debounced follow-up was armed (advancing the clock fires nothing).
    const callsAfterFrame = invalidateSpy.mock.calls.length;
    vi.advanceTimersByTime(600);
    expect(invalidateSpy.mock.calls.length).toBe(callsAfterFrame);
  });

  it("kind:'meta' with a cleared selectedModel (null) rides the same immediate path", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, sessionFrame({ kind: "meta", selectedModel: null }));
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["session"]);
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["sessions"]);
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

  // ── ROUND-114 (R114-e): turn.started — the opening frame opens the mirror
  // INSTANTLY with the phone's user text + the resolved model (the composer
  // flips to Stop + Queue within the frame's arrival; the "Thinking…"
  // placeholder's exact precondition holds until content lands). ──
  it("turn.started opens the mirror INSTANTLY with the user text + resolved model (the composer flip)", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, {
      type: "turn",
      sessionId: SID,
      frame: { type: "turn.started", text: "hey from the phone", model: "z-ai/glm-4.7", providerId: "zai" },
    });

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.remote).toBe(true);
    expect(slice?.liveTurn?.userText).toBe("hey from the phone");
    expect(slice?.liveTurn?.model).toBe("z-ai/glm-4.7");
    // No content yet — the empty-liveTurn placeholder's precondition; the
    // sidebar spinner mark is up.
    expect(slice?.liveTurn?.streamText).toBe("");
    expect(useActiveStreams.getState().active.has(SID)).toBe(true);
    // turn.started is NOT terminal: no invalidation (the debounced folded-log
    // refetch stays quiet until the turn ends).
    expect(invalidateSpy).not.toHaveBeenCalled();
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

  // ── ROUND-114 (R114-e): the appearance frame carries the FULL five-field
  // shape now — a phone-side chat-pref flip lands on the desktop live (the
  // theme store's echo guard suppresses the write-back PUT; theme-store.test
  // pins that half, this pins the DISPATCH half). ──
  it("settings 'appearance' applies ALL FIVE fields live (a phone's chat prefs land on the desktop)", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, {
      type: "settings",
      domain: "appearance",
      value: {
        themeId: "bento",
        mode: "dark",
        chatDensity: "compact",
        chatTextSize: "large",
        timestampsMode: "hover",
        toolActivity: "hidden",
      },
    });

    expect(useThemeStore.getState().themeId).toBe("bento");
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().density).toBe("compact");
    expect(useThemeStore.getState().chatTextSize).toBe("large");
    expect(useThemeStore.getState().timestampsMode).toBe("hover");
    expect(useThemeStore.getState().activityMode).toBe("hidden");
    // Still no query — the appearance state IS the store.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("a known settings domain invalidates ITS OWN query key; an unknown domain falls back to the ['settings'] prefix", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, { type: "settings", domain: "retry", value: { ladderEnabled: true } });
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["retry-settings"]);

    handleEventsFrame(qc, { type: "settings", domain: "some-future-domain", value: {} });
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["settings"]);
  });

  it("R122: the feedback domain invalidates BOTH the toggle query AND the ledger-file query (a live Self-Feedback tab converges)", () => {
    const { qc, invalidateSpy } = makeQC();
    // The frame fires on every settings PUT and on every ledger
    // append/clear — both cards must refetch, not just the toggle.
    handleEventsFrame(qc, {
      type: "settings",
      domain: "feedback",
      value: { exists: true, bytes: 4321, updatedAt: "2026-09-23T15:04:06Z", entries: 1 },
    });
    const keys = invalidatedKeys(invalidateSpy);
    expect(keys).toContainEqual(["feedback-settings"]);
    expect(keys).toContainEqual(["feedback-file"]);
    expect(keys).not.toContainEqual(["settings"]);
  });
// ── ROUND-115 (R115-E2): the DEVICE-SOURCED created frame — the phone
// minted a session (POST /sessions rode a device token) and the desktop
// should land in its chat: the session-nav store when idle, the linked
// local toast ("New session from your phone", the Toaster's actionable
// R99-C idiom) when a turn is streaming here. ──
describe("R115-E2: device-sourced created frames route the desktop", () => {
  beforeEach(() => {
    useSessionNavStore.setState({ navSeq: 0, lastNav: null });
    useNotificationStreamStore.setState({
      unread: 0,
      lastSeq: 0,
      lastNotification: null,
      status: "idle",
    });
  });

  it("idle → the session-nav store gets the chat URL (the Toaster openSession shape)", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(
      qc,
      sessionFrame({ kind: "created", projectId: "proj_7", source: "device" }),
    );
    expect(useSessionNavStore.getState().lastNav).toEqual({
      url: `/project/proj_7/chat?session=${SID}`,
    });
    // The standard created invalidations still fired (the list refetch
    // rides along with the navigation).
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["projects"]);
    // No toast for the idle leg — navigation is the whole story.
    expect(useNotificationStreamStore.getState().lastNotification).toBeNull();
  });

  it("busy (a turn streaming here) → the linked local toast instead, NO navigation", () => {
    const { qc } = makeQC();
    useActiveStreams.setState({ active: new Set(["sess_local_busy"]) });
    handleEventsFrame(
      qc,
      sessionFrame({ kind: "created", projectId: "proj_7", source: "device" }),
    );
    expect(useSessionNavStore.getState().lastNav).toBeNull();
    const n = useNotificationStreamStore.getState().lastNotification;
    expect(n?.title).toBe("New session from your phone");
    expect(n?.body).toBe("Tap to open it.");
    // The Open action: the toast's link is the SAME chat URL (a linked
    // local toast is persistent + clickable — the R99-C actionable idiom).
    expect(n?.link).toBe(`/project/proj_7/chat?session=${SID}`);
  });

  it("a shell-sourced created frame (no source key) never navigates nor toasts", () => {
    const { qc, invalidateSpy } = makeQC();
    handleEventsFrame(qc, sessionFrame({ kind: "created", projectId: "proj_7" }));
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(["projects"]);
    expect(useSessionNavStore.getState().lastNav).toBeNull();
    expect(useNotificationStreamStore.getState().lastNotification).toBeNull();
  });

  it("a device-sourced frame with projectId null has nowhere to route — invalidations only", () => {
    const { qc } = makeQC();
    handleEventsFrame(
      qc,
      sessionFrame({ kind: "created", projectId: null, source: "device" }),
    );
    expect(useSessionNavStore.getState().lastNav).toBeNull();
    expect(useNotificationStreamStore.getState().lastNotification).toBeNull();
  });
});
});
