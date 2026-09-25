/**
 * events.test.ts — the phone's live-view contract (R113-e): the wire parser
 * (every frame shape from R113-a's events-bus, malformed frames honestly
 * null), the pure store (epochs + listener semantics), the controller's
 * DISPATCH (hello → resync, session frames → the ~1s debounced batch, turn
 * frames → listeners only, project/settings bumps), and the stream lifecycle
 * (the activity controller's exact R42/R110-#1e discipline, verified against
 * a real ConnectionManager over a fake transport).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

// The pure core under test — the native transport chain is mocked so no
// React Native bridge is ever touched (the link-layer convention).
jest.mock("@/link/runtime", () => ({ getLinkManager: () => ({}) }));

import {
  EventsController,
  EventsStore,
  parseEventsFrame,
  turnFrameRecord,
  type EventsFrame,
} from "../events";
import { ConnectionManager } from "@/link/connection";
import type { HostStore, StoredHost } from "@/link/host-store";
import type { HttpRequestOptions, HttpResponse, NetTransport, SseStream } from "@/link/net";
import type { SseError, SseEvent } from "@/types/acute-net";
import type { ConnectionTriggers } from "@/link/triggers";

// ── the wire parser ─────────────────────────────────────────────────────────

describe("parseEventsFrame", () => {
  it("parses the hello frame", () => {
    expect(parseEventsFrame(JSON.stringify({ type: "hello" }))).toEqual({ type: "hello" });
  });

  it("parses a session frame with every optional field present", () => {
    const raw = JSON.stringify({
      type: "session",
      sessionId: "sess_1",
      projectId: "proj_1",
      kind: "event",
      seq: 7,
      status: "running",
    });
    expect(parseEventsFrame(raw)).toEqual({
      type: "session",
      sessionId: "sess_1",
      projectId: "proj_1",
      kind: "event",
      seq: 7,
      status: "running",
    });
  });

  it("omits the optional fields (never undefined) and nulls a missing projectId", () => {
    const frame = parseEventsFrame(JSON.stringify({ type: "session", sessionId: "s", kind: "status" }));
    expect(frame).toEqual({ type: "session", sessionId: "s", projectId: null, kind: "status" });
    if (frame?.type === "session") {
      expect("seq" in frame).toBe(false);
      expect("status" in frame).toBe(false);
    }
  });

  it("parses a turn frame with its inner mirror untouched", () => {
    const mirror = { type: "text-delta", delta: "hi" };
    const frame = parseEventsFrame(JSON.stringify({ type: "turn", sessionId: "s", frame: mirror }));
    expect(frame).toEqual({ type: "turn", sessionId: "s", frame: mirror });
  });

  it("parses project and settings frames", () => {
    expect(parseEventsFrame(JSON.stringify({ type: "project", projectId: "p", kind: "created" }))).toEqual({
      type: "project",
      projectId: "p",
      kind: "created",
    });
    expect(
      parseEventsFrame(JSON.stringify({ type: "settings", domain: "appearance", value: { themeId: null, mode: "dark" } })),
    ).toEqual({ type: "settings", domain: "appearance", value: { themeId: null, mode: "dark" } });
  });

  // ── R114-b/R114-d: the META frame — a session-level preference flip ──────

  it("R114-d: parses a meta frame with only the field(s) the change touched (absent keys stay absent)", () => {
    const modelOnly = parseEventsFrame(
      JSON.stringify({
        type: "session",
        sessionId: "sess_1",
        projectId: "proj_1",
        kind: "meta",
        selectedModel: { providerId: "z-ai", model: "glm-4.7" },
      }),
    );
    expect(modelOnly).toEqual({
      type: "session",
      sessionId: "sess_1",
      projectId: "proj_1",
      kind: "meta",
      selectedModel: { providerId: "z-ai", model: "glm-4.7" },
    });
    if (modelOnly?.type === "session" && modelOnly.kind === "meta") {
      expect("permissionMode" in modelOnly).toBe(false);
      expect("activeMode" in modelOnly).toBe(false);
    }
    const modeOnly = parseEventsFrame(
      JSON.stringify({ type: "session", sessionId: "s", kind: "meta", permissionMode: "full" }),
    );
    expect(modeOnly).toEqual({
      type: "session",
      sessionId: "s",
      projectId: null,
      kind: "meta",
      permissionMode: "full",
    });
    // activeMode/selectedModel carry null for a CLEAR (the wire contract).
    const cleared = parseEventsFrame(
      JSON.stringify({ type: "session", sessionId: "s", kind: "meta", selectedModel: null, activeMode: null }),
    );
    expect(cleared).toEqual({
      type: "session",
      sessionId: "s",
      projectId: null,
      kind: "meta",
      selectedModel: null,
      activeMode: null,
    });
  });

  it("R114-d: a malformed selectedModel pair drops the frame whole (never a guess)", () => {
    expect(
      parseEventsFrame(
        JSON.stringify({ type: "session", sessionId: "s", kind: "meta", selectedModel: { providerId: "x" } }),
      ),
    ).toBeNull();
    expect(
      parseEventsFrame(
        JSON.stringify({ type: "session", sessionId: "s", kind: "meta", selectedModel: "glm-4.7" }),
      ),
    ).toBeNull();
  });

  it("non-JSON, wrong-typed and unknown shapes are honest nulls", () => {
    expect(parseEventsFrame("not json")).toBeNull();
    expect(parseEventsFrame(": ping")).toBeNull();
    expect(parseEventsFrame(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseEventsFrame(JSON.stringify({ type: "session", kind: "event" }))).toBeNull(); // no sessionId
    expect(parseEventsFrame(JSON.stringify({ type: "session", sessionId: 1, kind: "event" }))).toBeNull();
    expect(parseEventsFrame(JSON.stringify({ type: "session", sessionId: "s", kind: "weird" }))).toBeNull();
    // R128-W3: "deleted" joined the project-frame vocabulary (the desktop
    // announces deletions) — the honest-null pin moves to a genuinely
    // unknown kind.
    expect(parseEventsFrame(JSON.stringify({ type: "project", projectId: "p", kind: "purged" }))).toBeNull();
    expect(parseEventsFrame(JSON.stringify({ type: "project", projectId: "p", kind: "deleted" }))).toEqual({
      type: "project",
      projectId: "p",
      kind: "deleted",
    });
    expect(parseEventsFrame(JSON.stringify({ type: "settings", value: 1 }))).toBeNull();
    expect(parseEventsFrame(JSON.stringify("hello"))).toBeNull();
    expect(parseEventsFrame(JSON.stringify([1, 2]))).toBeNull();
  });
});

describe("turnFrameRecord — the mirror's shape check", () => {
  it("passes a record with a string type through verbatim", () => {
    expect(turnFrameRecord({ type: "done" })).toEqual({ type: "done" });
    expect(turnFrameRecord({ type: "text-delta", delta: "x", extra: 1 })).toEqual({
      type: "text-delta",
      delta: "x",
      extra: 1,
    });
  });

  it("rejects non-objects, arrays, and objects without a string type", () => {
    expect(turnFrameRecord(null)).toBeNull();
    expect(turnFrameRecord("done")).toBeNull();
    expect(turnFrameRecord(42)).toBeNull();
    expect(turnFrameRecord([1])).toBeNull();
    expect(turnFrameRecord({ delta: "x" })).toBeNull();
    expect(turnFrameRecord({ type: 7 })).toBeNull();
  });
});

// ── the pure store ──────────────────────────────────────────────────────────

describe("EventsStore", () => {
  it("epoch listeners fire on every bump and unsubscribe cleanly", () => {
    const store = new EventsStore();
    let fired = 0;
    const unsub = store.subscribe(() => {
      fired += 1;
    });
    store.bumpSessions();
    store.bumpProjects();
    store.bumpSettings();
    store.setStreamLive(true);
    store.setStreamLive(true); // no-op — no fire
    unsub();
    store.bumpProjects();
    expect(fired).toBe(4);
  });

  it("hello resyncs all three worlds at once", () => {
    const store = new EventsStore();
    store.resync();
    const state = store.getState();
    expect(state).toEqual({
      streamLive: false,
      sessionsEpoch: 1,
      projectsEpoch: 1,
      settingsEpoch: 1,
    });
  });

  it("a settled session batch moves sessions AND projects (counts change), settings stays", () => {
    const store = new EventsStore();
    store.bumpSessions();
    expect(store.getState().sessionsEpoch).toBe(1);
    expect(store.getState().projectsEpoch).toBe(1);
    expect(store.getState().settingsEpoch).toBe(0);
  });

  it("project and settings bumps are scoped to their own world", () => {
    const store = new EventsStore();
    store.bumpProjects();
    expect(store.getState()).toEqual({
      streamLive: false,
      sessionsEpoch: 0,
      projectsEpoch: 1,
      settingsEpoch: 0,
    });
    store.bumpSettings();
    expect(store.getState().settingsEpoch).toBe(1);
    expect(store.getState().sessionsEpoch).toBe(0);
  });

  it("frame listeners receive every frame VERBATIM, and a throwing watcher never kills the stream", () => {
    const store = new EventsStore();
    const seen: EventsFrame[] = [];
    const good = (frame: EventsFrame): void => {
      seen.push(frame);
    };
    store.subscribeFrames(good);
    // The bug-carrier: throws on the FIRST frame it receives.
    store.subscribeFrames(() => {
      throw new Error("a watcher's bug must not kill the stream");
    });
    store.subscribeFrames((frame) => {
      // still reached — the events-bus contract
      if (frame.type === "settings") seen.push(frame);
    });

    expect(() => {
      store.notifyFrame({ type: "hello" });
      store.notifyFrame({ type: "settings", domain: "appearance", value: null });
    }).not.toThrow();

    expect(seen).toEqual([
      { type: "hello" },
      { type: "settings", domain: "appearance", value: null },
      { type: "settings", domain: "appearance", value: null },
    ]);
  });

  it("subscribeFrames unsubscribes cleanly", () => {
    const store = new EventsStore();
    let count = 0;
    const unsub = store.subscribeFrames(() => {
      count += 1;
    });
    store.notifyFrame({ type: "hello" });
    unsub();
    store.notifyFrame({ type: "hello" });
    expect(count).toBe(1);
  });
});

// ── the controller's dispatch (the transport-free seam) ─────────────────────

describe("EventsController — the dispatch", () => {
  let store: EventsStore;
  let controller: EventsController;

  const sessionFrame = (seq: number): EventsFrame => ({
    type: "session",
    sessionId: "sess_1",
    projectId: "proj_1",
    kind: "event",
    seq,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    store = new EventsStore();
    controller = new EventsController(store);
  });

  afterEach(() => {
    controller.resetForTest();
    jest.useRealTimers();
  });

  it("hello → the resync: all three worlds move IMMEDIATELY (no debounce)", () => {
    controller.handleFrame({ type: "hello" });
    expect(store.getState()).toEqual({
      streamLive: false,
      sessionsEpoch: 1,
      projectsEpoch: 1,
      settingsEpoch: 1,
    });
  });

  it("session frames batch into ONE trailing refresh (~1s) — a streaming turn never storms the lists", async () => {
    controller.handleFrame(sessionFrame(1));
    controller.handleFrame(sessionFrame(2));
    controller.handleFrame(sessionFrame(3));
    // Nothing yet — the burst is still collapsing.
    expect(store.getState().sessionsEpoch).toBe(0);
    await jest.advanceTimersByTimeAsync(999);
    expect(store.getState().sessionsEpoch).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    // ONE refetch for the whole burst, moving sessions AND projects.
    expect(store.getState().sessionsEpoch).toBe(1);
    expect(store.getState().projectsEpoch).toBe(1);
    expect(store.getState().settingsEpoch).toBe(0);
  });

  it("a second burst re-arms the debounce (the timer resets per frame)", async () => {
    controller.handleFrame(sessionFrame(1));
    await jest.advanceTimersByTimeAsync(700);
    controller.handleFrame(sessionFrame(2)); // re-arms
    await jest.advanceTimersByTimeAsync(700);
    expect(store.getState().sessionsEpoch).toBe(0); // still inside the new window
    await jest.advanceTimersByTimeAsync(300);
    expect(store.getState().sessionsEpoch).toBe(1);
  });

  it("project frames bump the projects world immediately", () => {
    controller.handleFrame({ type: "project", projectId: "p_new", kind: "created" });
    expect(store.getState().projectsEpoch).toBe(1);
    expect(store.getState().sessionsEpoch).toBe(0);
    expect(store.getState().settingsEpoch).toBe(0);
  });

  it("settings frames bump the settings world immediately", () => {
    controller.handleFrame({ type: "settings", domain: "appearance", value: { themeId: "bento", mode: "dark" } });
    expect(store.getState().settingsEpoch).toBe(1);
    expect(store.getState().sessionsEpoch).toBe(0);
    expect(store.getState().projectsEpoch).toBe(0);
  });

  it("R114-d: META frames move NO epoch (the open session screen applies the carried value in place) but reach listeners verbatim", async () => {
    const seen: EventsFrame[] = [];
    store.subscribeFrames((frame) => {
      seen.push(frame);
    });
    controller.handleFrame({
      type: "session",
      sessionId: "sess_1",
      projectId: null,
      kind: "meta",
      selectedModel: { providerId: "z-ai", model: "glm-4.7" },
    });
    await jest.advanceTimersByTimeAsync(1_500);
    expect(store.getState()).toEqual({
      streamLive: false,
      sessionsEpoch: 0,
      projectsEpoch: 0,
      settingsEpoch: 0,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      type: "session",
      sessionId: "sess_1",
      projectId: null,
      kind: "meta",
      selectedModel: { providerId: "z-ai", model: "glm-4.7" },
    });
  });

  it("turn frames move NO epoch (the open session screen owns the mirror) but reach frame listeners verbatim", async () => {
    const seen: EventsFrame[] = [];
    store.subscribeFrames((frame) => {
      seen.push(frame);
    });
    controller.handleFrame({ type: "turn", sessionId: "sess_1", frame: { type: "text-delta", delta: "hi" } });
    await jest.advanceTimersByTimeAsync(1_500);
    expect(store.getState()).toEqual({
      streamLive: false,
      sessionsEpoch: 0,
      projectsEpoch: 0,
      settingsEpoch: 0,
    });
    expect(seen).toEqual([{ type: "turn", sessionId: "sess_1", frame: { type: "text-delta", delta: "hi" } }]);
  });

  it("every frame reaches the listeners (dispatch never swallows the raw copy)", () => {
    const seen: EventsFrame[] = [];
    store.subscribeFrames((frame) => {
      seen.push(frame);
    });
    controller.handleFrame({ type: "hello" });
    controller.handleFrame(sessionFrame(1));
    controller.handleFrame({ type: "project", projectId: "p", kind: "created" });
    controller.handleFrame({ type: "settings", domain: "retry", value: 3 });
    expect(seen.map((f) => f.type)).toEqual(["hello", "session", "project", "settings"]);
  });
});

// ── the controller's live-stream leg (the R42 discipline) ───────────────────

describe("EventsController — the stream rides the manager's hysteresis", () => {
  const MACHINE_ID = "aa".repeat(32);
  const TOKEN = "cc".repeat(32);

  class FakeSseStream implements SseStream {
    readonly eventId: number;
    readonly openedWith: HttpRequestOptions;
    closed = false;
    private readonly dataListeners = new Set<(ev: SseEvent) => void>();
    private readonly errorListeners = new Set<(err: SseError) => void>();
    private readonly closeListeners = new Set<() => void>();
    private static nextId = 1;

    constructor(openedWith: HttpRequestOptions) {
      this.openedWith = openedWith;
      this.eventId = FakeSseStream.nextId++;
    }

    addEventListener(type: "data", listener: (ev: SseEvent) => void): SseStream;
    addEventListener(type: "error", listener: (err: SseError) => void): SseStream;
    addEventListener(type: "close", listener: () => void): SseStream;
    addEventListener(type: string, listener: unknown): SseStream {
      if (type === "data") this.dataListeners.add(listener as (ev: SseEvent) => void);
      if (type === "error") this.errorListeners.add(listener as (err: SseError) => void);
      if (type === "close") this.closeListeners.add(listener as () => void);
      return this;
    }

    close(): void {
      this.closed = true;
    }

    emitData(data: string): void {
      for (const listener of this.dataListeners) listener({ data });
    }

    emitError(err: SseError): void {
      for (const listener of this.errorListeners) listener(err);
    }

    /** R127-W8 — the host's clean stream end (sidecar restart / relay-DO
     * hibernation): fires the close listeners exactly as the real transport
     * would. */
    emitClose(): void {
      for (const listener of this.closeListeners) listener();
    }
  }

  function makeEnv() {
    const requests: HttpRequestOptions[] = [];
    const streams: FakeSseStream[] = [];
    let handler: (o: HttpRequestOptions) => HttpResponse = () => ({ status: 404, headers: {}, bodyText: "" });
    // R127-W8 — the open-failure leg: when set, the NEXT openSse throws (the
    // controller's catch path rides the same reconnect ladder).
    let openSseError: { kind: string; message: string } | null = null;
    const net: NetTransport = {
      async request(options) {
        requests.push(options);
        return handler(options);
      },
      openSse(options) {
        if (openSseError !== null) {
          const err = openSseError;
          openSseError = null;
          throw err;
        }
        const stream = new FakeSseStream(options);
        streams.push(stream);
        return stream;
      },
    };
    const host: StoredHost = {
      machineId: MACHINE_ID,
      certFP: "bb".repeat(32),
      hostLabel: "OWNER-PC",
      addrs: ["192.168.1.4"],
      port: 53411,
      relay: null,
      pairedAt: 1_000,
    };
    const store: HostStore = {
      async readHost() {
        return host;
      },
      async readDeviceToken() {
        return TOKEN;
      },
      async savePairing() {},
      async clear() {},
    };
    let foreground: (() => void) | null = null;
    const triggers: ConnectionTriggers = {
      onForeground(callback) {
        foreground = callback;
        return () => {
          foreground = null;
        };
      },
      onNetworkChange() {
        return () => {};
      },
    };
    const manager = new ConnectionManager({
      store,
      net,
      triggers,
      now: () => 1_750_000_000_000,
    });
    const events = new EventsStore();
    const controller = new EventsController(events);
    return {
      manager,
      events,
      controller,
      requests,
      streams,
      setHandler(next: (o: HttpRequestOptions) => HttpResponse) {
        handler = next;
      },
      failWith(kind: string, message: string) {
        handler = () => {
          throw { kind, message };
        };
      },
      failNextOpenSse(kind: string, message: string) {
        openSseError = { kind, message };
      },
      fireForeground() {
        foreground?.();
      },
    };
  }

  const health = (): HttpResponse => ({
    status: 200,
    headers: {},
    bodyText: JSON.stringify({ ok: true, version: "0.106.0", machineId: MACHINE_ID, linkMode: true }),
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("holds the stream while connected+foreground, dispatches its frames, and a TRANSIENT blip re-opens without any offline flap", async () => {
    const env = makeEnv();
    env.setHandler((o) => (o.url.endsWith("/health") ? health() : health()));
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.manager.getStatus()).toBe("connected");
    expect(env.streams).toHaveLength(1);
    expect(env.events.getState().streamLive).toBe(true);
    expect(env.streams[0]?.openedWith.url).toBe("https://192.168.1.4:53411/api/v1/events/stream");

    // The server's hello + a session frame ride the stream → the resync +
    // (after the debounce) the batch land in the store.
    env.streams[0]?.emitData(JSON.stringify({ type: "hello" }));
    expect(env.events.getState().sessionsEpoch).toBe(1);
    expect(env.events.getState().settingsEpoch).toBe(1);
    env.streams[0]?.emitData(
      JSON.stringify({ type: "session", sessionId: "s", projectId: "p", kind: "event", seq: 1 }),
    );
    await jest.advanceTimersByTimeAsync(1_000);
    expect(env.events.getState().sessionsEpoch).toBe(2);

    // The blip: the transport dies, the manager VERIFIES (healthy) — the
    // handle is dropped and re-opened, the link NEVER flips (R110 #1e).
    env.streams[0]?.emitError({ kind: "network", message: "blip" });
    await settle();
    expect(env.manager.getStatus()).toBe("connected");
    expect(env.streams).toHaveLength(2);
    expect(env.events.getState().streamLive).toBe(true);
  });

  it("backgrounding closes the stream; foregrounding re-opens it (R42)", async () => {
    const env = makeEnv();
    env.setHandler((o) => (o.url.endsWith("/health") ? health() : health()));
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    env.controller.setForeground(false);
    expect(env.events.getState().streamLive).toBe(false);
    expect(env.streams[0]?.closed).toBe(true);

    env.controller.setForeground(true);
    expect(env.streams).toHaveLength(2);
    expect(env.events.getState().streamLive).toBe(true);
  });

  it("a REAL outage flips the link offline (the manager's verdict) and the stream is dropped", async () => {
    const env = makeEnv();
    env.setHandler((o) => (o.url.endsWith("/health") ? health() : health()));
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    env.failWith("network", "dead");
    env.streams[0]?.emitError({ kind: "network", message: "stream died" });
    await settle();
    expect(env.manager.getStatus()).toBe("connected"); // hysteresis holds
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(env.manager.getStatus()).toBe("offline");
    expect(env.events.getState().streamLive).toBe(false);
  });

  it("malformed frames on the stream are skipped honestly — the stream keeps dispatching after them", async () => {
    const env = makeEnv();
    env.setHandler((o) => (o.url.endsWith("/health") ? health() : health()));
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();

    const seen: EventsFrame[] = [];
    env.events.subscribeFrames((frame) => {
      seen.push(frame);
    });
    env.streams[0]?.emitData("not json at all");
    env.streams[0]?.emitData(JSON.stringify({ type: "mystery" }));
    env.streams[0]?.emitData(JSON.stringify({ type: "hello" }));
    await settle();

    expect(seen).toEqual([{ type: "hello" }]);
    expect(env.events.getState().sessionsEpoch).toBe(1); // the hello resync ran
  });

  // ── R127-W8 — the reconnect ladder (the desktop EventStreamStarter's
  // port; the R127-Ra root cause #2: one stream error used to leave the
  // phone deaf to ALL live frames until an unrelated poke). The error kind
  // here is deliberately "protocol" — the manager's sse() leg only routes
  // tls/network kinds into its probe, so NOTHING pokes the controller: the
  // ladder is the ONLY re-open path under test. ──────────────────────────

  it("R127-W8: a stream error with no manager verdict retries after 1s, then 2s (the desktop ladder)", async () => {
    const env = makeEnv();
    env.setHandler(() => health());
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    // First drop → the retry arms at the ladder's floor (1s).
    env.streams[0]?.emitError({ kind: "unknown", message: "frame parse died" });
    expect(env.events.getState().streamLive).toBe(false);
    await jest.advanceTimersByTimeAsync(999);
    expect(env.streams).toHaveLength(1); // still waiting
    await jest.advanceTimersByTimeAsync(1);
    expect(env.streams).toHaveLength(2); // the 1s retry re-opened
    expect(env.events.getState().streamLive).toBe(true);

    // Second drop → the ladder DOUBLED (2s).
    env.streams[1]?.emitError({ kind: "unknown", message: "died again" });
    await jest.advanceTimersByTimeAsync(1_999);
    expect(env.streams).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(env.streams).toHaveLength(3);
  });

  it("R127-W8: the host's clean CLOSE (relay/DO hibernation, sidecar restart) rides the same ladder", async () => {
    const env = makeEnv();
    env.setHandler(() => health());
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    env.streams[0]?.emitClose(); // no error, no manager probe — pure close
    expect(env.events.getState().streamLive).toBe(false);
    await jest.advanceTimersByTimeAsync(999);
    expect(env.streams).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(env.streams).toHaveLength(2);
    // The hello-on-reconnect resync fires when the host answers.
    env.streams[1]?.emitData(JSON.stringify({ type: "hello" }));
    expect(env.events.getState().sessionsEpoch).toBe(1);
  });

  it("R127-W8: a successful open + HELLO resets the ladder to 1s (the desktop's hello leg)", async () => {
    const env = makeEnv();
    env.setHandler(() => health());
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();

    env.streams[0]?.emitError({ kind: "unknown", message: "drop" });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(env.streams).toHaveLength(2);
    env.streams[1]?.emitData(JSON.stringify({ type: "hello" })); // proven live

    // Without the reset this drop would retry at 2s; with it, 1s.
    env.streams[1]?.emitError({ kind: "unknown", message: "drop again" });
    await jest.advanceTimersByTimeAsync(999);
    expect(env.streams).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(env.streams).toHaveLength(3);
  });

  it("R127-W8: backgrounding CANCELS the pending retry; foregrounding re-opens FRESH (no backoff wait)", async () => {
    const env = makeEnv();
    env.setHandler(() => health());
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    env.streams[0]?.emitError({ kind: "unknown", message: "drop" }); // retry armed at 1s
    env.controller.setForeground(false); // the R42 gate — intentional silence
    await jest.advanceTimersByTimeAsync(15_000);
    expect(env.streams).toHaveLength(1); // the retry was CANCELLED, not fired

    env.controller.setForeground(true);
    expect(env.streams).toHaveLength(2); // re-opened immediately — fresh, 0ms
    expect(env.events.getState().streamLive).toBe(true);
  });

  it("R127-W8: the link going offline STOPS the loop — no retry ever re-opens a stream the R42 gate closed", async () => {
    const env = makeEnv();
    env.setHandler(() => health());
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    // A network-kind error → the manager probes; the host is dead, so the
    // hysteresis verdict lands offline (the existing REAL-outage path).
    env.failWith("network", "dead");
    env.streams[0]?.emitError({ kind: "network", message: "stream died" });
    await settle();
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(env.manager.getStatus()).toBe("offline");

    // The offline flip cleared the pending retry (sync's R42 leg) — a long
    // wait must NOT silently grow new streams.
    const countAfterOffline = env.streams.length;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(env.streams).toHaveLength(countAfterOffline);
    expect(env.events.getState().streamLive).toBe(false);
  });

  it("R127-W8: an OPEN failure (sse throws) rides the same ladder — the desktop's catch leg", async () => {
    const env = makeEnv();
    env.setHandler(() => health());
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    env.failNextOpenSse("network", "open blew up");
    env.streams[0]?.emitError({ kind: "unknown", message: "drop" });
    await jest.advanceTimersByTimeAsync(1_000);
    // The retry's openStream THREW (caught + honest) — the next retry arms at
    // the doubled 2s; the ladder, not a crash, owns the recovery.
    expect(env.streams).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(env.streams).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(env.streams).toHaveLength(2);
    expect(env.events.getState().streamLive).toBe(true);
  });
});
