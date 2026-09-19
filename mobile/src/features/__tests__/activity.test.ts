/**
 * activity.test.ts — the live activity store + frame parser's contract
 * (R109: the live notifications stream the bell + badges ride) + the
 * controller's R110 #1e leg: a stream transport error clears the dead handle
 * without flipping the global status (the manager's hysteresis owns that),
 * and the stream re-opens cleanly on the next verified state change.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

// The pure core under test — the native transport chain is mocked so no
// React Native bridge is ever touched (the link-layer convention).
jest.mock("@/link/runtime", () => ({ getLinkManager: () => ({}) }));

import { ActivityController, ActivityStore, parseActivityFrame } from "../activity";
import { ConnectionManager } from "@/link/connection";
import type { HostStore, StoredHost } from "@/link/host-store";
import type { HttpRequestOptions, HttpResponse, NetTransport, SseStream } from "@/link/net";
import type { SseError, SseEvent } from "@/types/acute-net";
import type { ConnectionTriggers } from "@/link/triggers";

describe("parseActivityFrame", () => {
  it("parses the hello frame", () => {
    expect(parseActivityFrame(JSON.stringify({ type: "hello", unread: 3 }))).toEqual({
      type: "hello",
      unread: 3,
    });
  });

  it("parses a notification record", () => {
    const row = {
      id: "n1",
      ts: "2026-09-19T10:00:00Z",
      kind: "approval",
      title: "Command needs approval",
      body: "rm -rf …",
      sessionId: "s1",
      projectId: "p1",
      read: 0,
    };
    const frame = parseActivityFrame(JSON.stringify(row));
    expect(frame).toEqual({ type: "notification", ...row });
  });

  it("non-JSON and unknown shapes are honest nulls", () => {
    expect(parseActivityFrame("not json")).toBeNull();
    expect(parseActivityFrame(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseActivityFrame(JSON.stringify({ type: "hello", unread: "many" }))).toBeNull();
  });
});

describe("ActivityStore", () => {
  it("unread counts set, live rows increment + dedupe", () => {
    const store = new ActivityStore();
    store.setUnread(2);
    expect(store.getState().unread).toBe(2);
    const row = {
      id: "n1",
      ts: "2026-09-19T10:00:00Z",
      kind: "task",
      title: "done",
      body: "",
      sessionId: null,
      projectId: null,
      read: 0 as const,
    };
    store.applyLiveNotification(row);
    expect(store.getState().unread).toBe(3);
    // The same row re-delivered does not double-count.
    store.applyLiveNotification(row);
    expect(store.getState().unread).toBe(3);
    expect(store.getState().latest).toHaveLength(1);
  });

  it("a read notification does not bump unread", () => {
    const store = new ActivityStore();
    store.applyLiveNotification({
      id: "n2",
      ts: "2026-09-19T10:00:00Z",
      kind: "task",
      title: "done",
      body: "",
      sessionId: null,
      projectId: null,
      read: 1,
    });
    expect(store.getState().unread).toBe(0);
  });

  it("markRead decrements once and updates the row", () => {
    const store = new ActivityStore();
    store.applyPage({
      notifications: [
        {
          id: "a",
          ts: "2026-09-19T10:00:00Z",
          kind: "task",
          title: "t",
          body: "",
          sessionId: null,
          projectId: null,
          read: 0,
        },
      ],
      unread: 1,
    });
    expect(store.markRead("a")).toBeUndefined();
    expect(store.getState().unread).toBe(0);
    expect(store.getState().latest[0]?.read).toBe(1);
    // Marking twice does not go negative.
    store.markRead("a");
    expect(store.getState().unread).toBe(0);
  });

  it("markAllRead zeroes and flips every row", () => {
    const store = new ActivityStore();
    store.applyPage({
      notifications: [
        {
          id: "a",
          ts: "2026-09-19T10:00:00Z",
          kind: "task",
          title: "t",
          body: "",
          sessionId: null,
          projectId: null,
          read: 0,
        },
        {
          id: "b",
          ts: "2026-09-19T11:00:00Z",
          kind: "error",
          title: "e",
          body: "",
          sessionId: null,
          projectId: null,
          read: 0,
        },
      ],
      unread: 2,
    });
    store.markAllRead();
    expect(store.getState().unread).toBe(0);
    expect(store.getState().latest.every((n) => n.read === 1)).toBe(true);
  });

  it("subscribers fire on changes", () => {
    const store = new ActivityStore();
    let fired = 0;
    const unsub = store.subscribe(() => {
      fired += 1;
    });
    store.setUnread(1);
    store.setUnread(1); // no-op — no fire
    unsub();
    store.setUnread(2);
    expect(fired).toBe(1);
  });

  it("the ring caps at 30 rows, newest first", () => {
    const store = new ActivityStore();
    for (let i = 0; i < 35; i += 1) {
      store.applyLiveNotification({
        id: `n${i}`,
        ts: "2026-09-19T10:00:00Z",
        kind: "task",
        title: `t${i}`,
        body: "",
        sessionId: null,
        projectId: null,
        read: 1,
      });
    }
    expect(store.getState().latest).toHaveLength(30);
    expect(store.getState().latest[0]?.id).toBe("n34");
  });
});

// ── the controller's live-stream leg (R110 #1e) ─────────────────────────────

describe("ActivityController — the stream rides the manager's hysteresis", () => {
  const MACHINE_ID = "aa".repeat(32);
  const TOKEN = "cc".repeat(32);

  class FakeSseStream implements SseStream {
    readonly eventId: number;
    readonly openedWith: HttpRequestOptions;
    closed = false;
    private readonly errorListeners = new Set<(err: SseError) => void>();
    private static nextId = 1;

    constructor(openedWith: HttpRequestOptions) {
      this.openedWith = openedWith;
      this.eventId = FakeSseStream.nextId++;
    }

    addEventListener(type: "data", listener: (ev: SseEvent) => void): SseStream;
    addEventListener(type: "error", listener: (err: SseError) => void): SseStream;
    addEventListener(type: "close", listener: () => void): SseStream;
    addEventListener(type: string, listener: unknown): SseStream {
      if (type === "error") this.errorListeners.add(listener as (err: SseError) => void);
      return this;
    }

    close(): void {
      this.closed = true;
    }

    emitError(err: SseError): void {
      for (const listener of this.errorListeners) listener(err);
    }
  }

  function makeEnv() {
    const requests: HttpRequestOptions[] = [];
    const streams: FakeSseStream[] = [];
    let handler: (o: HttpRequestOptions) => HttpResponse = () => ({ status: 404, headers: {}, bodyText: "" });
    const net: NetTransport = {
      async request(options) {
        requests.push(options);
        return handler(options);
      },
      openSse(options) {
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
    const activity = new ActivityStore();
    const controller = new ActivityController(activity);
    return {
      manager,
      activity,
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
  const page = (): HttpResponse => ({
    status: 200,
    headers: {},
    bodyText: JSON.stringify({ notifications: [], unread: 0 }),
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

  it("holds the stream while connected+foreground, and a TRANSIENT error re-opens it without any offline flap", async () => {
    const env = makeEnv();
    env.setHandler((o) => (o.url.endsWith("/health") ? health() : page()));
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.manager.getStatus()).toBe("connected");
    expect(env.streams).toHaveLength(1);
    expect(env.activity.getState().streamLive).toBe(true);
    expect(env.streams[0]?.openedWith.url).toBe("https://192.168.1.4:53411/api/v1/notifications/stream");

    // The blip: the stream's transport dies. The manager VERIFIES (probe
    // succeeds — the handler is healthy) and the controller drops the dead
    // handle + re-opens on the verified state change. The link NEVER flips.
    env.streams[0]?.emitError({ kind: "network", message: "blip" });
    await settle();
    expect(env.manager.getStatus()).toBe("connected");
    expect(env.streams).toHaveLength(2); // re-opened cleanly
    expect(env.activity.getState().streamLive).toBe(true);
  });

  it("a REAL outage: the hysteresis verdict flips the link offline, the stream is dropped — and the reconnect refreshes + re-opens", async () => {
    const env = makeEnv();
    env.setHandler((o) => (o.url.endsWith("/health") ? health() : page()));
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    // The host dies: the stream errors, the verification round fails (cycle
    // 1 — the state holds), the 5s cycle decides offline.
    env.failWith("network", "dead");
    env.streams[0]?.emitError({ kind: "network", message: "stream died" });
    await settle();
    expect(env.manager.getStatus()).toBe("connected");
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(env.manager.getStatus()).toBe("offline");
    expect(env.activity.getState().streamLive).toBe(false);

    // The host returns: a foreground wake reconnects — the unread page
    // refreshes and the stream re-opens (R42 discipline, unchanged).
    env.setHandler((o) => (o.url.endsWith("/health") ? health() : page()));
    env.fireForeground();
    await settle();
    expect(env.manager.getStatus()).toBe("connected");
    expect(env.streams.length).toBeGreaterThanOrEqual(2);
    expect(env.activity.getState().streamLive).toBe(true);
    // The refresh path ran on the reconnect (the true unread page).
    expect(env.requests.some((r) => r.url.endsWith("/api/v1/notifications?limit=30"))).toBe(true);
  });

  it("backgrounding closes the stream; foregrounding re-opens it (R42)", async () => {
    const env = makeEnv();
    env.setHandler((o) => (o.url.endsWith("/health") ? health() : page()));
    await env.manager.start();
    await settle();
    env.controller.start({ manager: env.manager });
    await settle();
    expect(env.streams).toHaveLength(1);

    env.controller.setForeground(false);
    expect(env.activity.getState().streamLive).toBe(false);
    expect(env.streams[0]?.closed).toBe(true);

    env.controller.setForeground(true);
    expect(env.streams).toHaveLength(2);
    expect(env.activity.getState().streamLive).toBe(true);
  });
});
