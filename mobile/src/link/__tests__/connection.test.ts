/**
 * connection.test.ts — the manager's state machine: probe order, pin
 * dispatch (bare-host vs URL), the backoff ladder (5s→10s→30s, reset on
 * success), trigger wakes, the fetch-like api(), and the sse() handle —
 * all against injected fakes (no React Native, no native bridge).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  ConnectionManager,
  NotConnectedError,
  parseHealthBody,
  type ConnectionStatus,
} from "../connection";
import type { HostStore, StoredHost } from "../host-store";
import type { HttpRequestOptions, HttpResponse, NetTransport, SseStream } from "../net";
import type { SseError, SseEvent } from "@/types/acute-net";
import type { ConnectionTriggers } from "../triggers";

// ── fakes ───────────────────────────────────────────────────────────────────

type Handler = (options: HttpRequestOptions) => HttpResponse;

function netError(kind: string, message: string): { kind: string; message: string } {
  return { kind, message };
}

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

  emitError(err: SseError): void {
    for (const listener of this.errorListeners) listener(err);
  }
}

function makeNet() {
  const requests: HttpRequestOptions[] = [];
  const streams: FakeSseStream[] = [];
  let handler: Handler = () => ({ status: 404, headers: {}, bodyText: "" });
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
  return {
    net,
    requests,
    streams,
    setHandler(next: Handler) {
      handler = next;
    },
    failWith(kind: string, message: string) {
      handler = () => {
        throw netError(kind, message);
      };
    },
  };
}

function makeStore(seed?: { host: StoredHost; token: string }) {
  let host: StoredHost | null = seed?.host ?? null;
  let token: string | null = seed?.token ?? null;
  const calls: string[] = [];
  const store: HostStore = {
    async readHost() {
      calls.push("readHost");
      return host;
    },
    async readDeviceToken() {
      calls.push("readDeviceToken");
      return token;
    },
    async savePairing(pairing) {
      host = pairing.host;
      token = pairing.deviceToken;
      calls.push("savePairing");
    },
    async clear() {
      host = null;
      token = null;
      calls.push("clear");
    },
  };
  return { store, calls };
}

function makeTriggers() {
  let foreground: (() => void) | null = null;
  let network: (() => void) | null = null;
  const triggers: ConnectionTriggers = {
    onForeground(callback) {
      foreground = callback;
      return () => {
        foreground = null;
      };
    },
    onNetworkChange(callback) {
      network = callback;
      return () => {
        network = null;
      };
    },
  };
  return {
    triggers,
    fireForeground() {
      foreground?.();
    },
    fireNetworkChange() {
      network?.();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

// ── fixtures ────────────────────────────────────────────────────────────────

const MACHINE_ID = "aa".repeat(32);
const CERT_FP = "bb".repeat(32);
const TOKEN = "cc".repeat(32);

function makeHost(overrides: Partial<StoredHost> = {}): StoredHost {
  return {
    machineId: MACHINE_ID,
    certFP: CERT_FP,
    hostLabel: "OWNER-PC",
    addrs: ["192.168.1.4"],
    port: 53411,
    pairedAt: 1_000,
    ...overrides,
  };
}

function healthBody(machineId: string = MACHINE_ID): string {
  return JSON.stringify({ ok: true, version: "0.101.0", machineId, linkMode: true });
}

function ok(bodyText: string): HttpResponse {
  return { status: 200, headers: {}, bodyText };
}

function makeManager(seed?: { host: StoredHost; token: string }) {
  const net = makeNet();
  const store = makeStore(seed);
  const trig = makeTriggers();
  const manager = new ConnectionManager({
    store: store.store,
    net: net.net,
    triggers: trig.triggers,
    now: () => 1_750_000_000_000,
  });
  return { manager, net, store, trig };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── parseHealthBody ─────────────────────────────────────────────────────────

describe("parseHealthBody", () => {
  it("parses the device-listener shape (ok/version/machineId)", () => {
    expect(parseHealthBody(healthBody())).toEqual({
      version: "0.101.0",
      machineId: MACHINE_ID,
    });
  });

  it("parses the loopback shape too (the tunnel edge)", () => {
    expect(parseHealthBody(JSON.stringify({ status: "ok", app: "acute", version: "1.2.3" }))).toEqual({
      version: "1.2.3",
      machineId: null,
    });
  });

  it("rejects non-JSON and version-less bodies", () => {
    expect(parseHealthBody("not json")).toBeNull();
    expect(parseHealthBody(JSON.stringify({ ok: true }))).toBeNull();
  });
});

// ── lifecycle + probing ─────────────────────────────────────────────────────

describe("ConnectionManager lifecycle", () => {
  it("starts unpaired with an empty store and probes nothing", async () => {
    const { manager, net } = makeManager();
    expect(manager.getStatus()).toBe("unpaired");
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("unpaired");
    expect(net.requests).toHaveLength(0);
  });

  it("probes the address ladder IN ORDER and lands connected on the first healthy one", async () => {
    const host = makeHost({ addrs: ["192.168.1.4", "192.168.1.5"] });
    const { manager, net } = makeManager({ host, token: TOKEN });
    // First address unreachable, second healthy — order must be respected.
    net.setHandler((o) =>
      o.url.startsWith("https://192.168.1.4:") ? ((): HttpResponse => { throw netError("network", "down"); })() : ok(healthBody()),
    );
    await manager.start();
    await settle();
    expect(net.requests).toHaveLength(2);
    expect(net.requests[0]?.url).toBe("https://192.168.1.4:53411/health");
    expect(net.requests[1]?.url).toBe("https://192.168.1.5:53411/health");
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getActiveAddress()).toBe("192.168.1.5");
    expect(manager.getLiveInfo()).toEqual({ version: "0.101.0", machineId: MACHINE_ID });
    expect(manager.getLastSeen()).toBe(1_750_000_000_000);
  });

  it("pins bare-host addresses and NEVER pins URL (tunnel) addresses", async () => {
    const host = makeHost({ addrs: ["https://abc.trycloudflare.com", "192.168.1.4"] });
    const { manager, net } = makeManager({ host, token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getActiveAddress()).toBe("https://abc.trycloudflare.com");
    expect(net.requests[0]?.url).toBe("https://abc.trycloudflare.com/health");
    expect(net.requests[0]?.pinSha256).toBeNull(); // tunnel — standard CA
    // The LAN fallback would pin (force it by failing the URL first).
    const { manager: m2, net: n2 } = makeManager({ host, token: TOKEN });
    n2.setHandler((o) =>
      o.url.startsWith("https://abc")
        ? ((): HttpResponse => { throw netError("network", "down"); })()
        : ok(healthBody()),
    );
    await m2.start();
    await settle();
    expect(m2.getStatus()).toBe("connected");
    expect(n2.requests[0]?.pinSha256).toBeNull();
    expect(n2.requests[1]?.pinSha256).toBe(CERT_FP); // LAN — the TOFU pin
  });

  it("probes WITHOUT a pin when no certFP is stored (tunnel-paired host)", async () => {
    const host = makeHost({ certFP: null });
    const { manager, net } = makeManager({ host, token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    expect(net.requests[0]?.pinSha256).toBeNull();
    expect(manager.getStatus()).toBe("connected");
  });

  it("skips an address whose health answers with a DIFFERENT machineId", async () => {
    const host = makeHost({ addrs: ["192.168.1.4", "192.168.1.5"] });
    const { manager, net } = makeManager({ host, token: TOKEN });
    net.setHandler((o) =>
      o.url.startsWith("https://192.168.1.4:") ? ok(healthBody("dd".repeat(32))) : ok(healthBody()),
    );
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getActiveAddress()).toBe("192.168.1.5");
  });

  it("goes offline when every address fails or mismatches", async () => {
    const host = makeHost({ addrs: ["192.168.1.4", "192.168.1.5"] });
    const { manager, net } = makeManager({ host, token: TOKEN });
    net.setHandler(() => ok(healthBody("dd".repeat(32))));
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("offline");
    expect(manager.getLiveInfo()).toBeNull();
  });
});

// ── the backoff ladder ──────────────────────────────────────────────────────

describe("ConnectionManager backoff ladder", () => {
  it("walks 5s → 10s → 30s → 30s (cap), resetting after a success", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.failWith("network", "down");
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("offline");

    // Rung 1 → next probe after 5s.
    expect(net.requests).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(net.requests).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.requests).toHaveLength(2);

    // Rung 2 → 10s.
    await jest.advanceTimersByTimeAsync(9_999);
    expect(net.requests).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.requests).toHaveLength(3);

    // Rung 3 → 30s.
    await jest.advanceTimersByTimeAsync(29_999);
    expect(net.requests).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.requests).toHaveLength(4);

    // Rung 4+ → capped at 30s.
    await jest.advanceTimersByTimeAsync(29_999);
    expect(net.requests).toHaveLength(4);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.requests).toHaveLength(5);

    // The host comes back — connected, ladder reset.
    net.setHandler(() => ok(healthBody()));
    await jest.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(net.requests).toHaveLength(6);

    // It drops again (an api() transport failure) — the fresh ladder starts at 5s.
    net.failWith("network", "dropped");
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "network" });
    expect(manager.getStatus()).toBe("offline");
    expect(net.requests).toHaveLength(7); // 6 probes + the failed api call
    await jest.advanceTimersByTimeAsync(4_999);
    expect(net.requests).toHaveLength(7);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.requests).toHaveLength(8);
  });

  it("does NOT auto-retry after a TLS (certificate) failure — the honest re-pair state", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.failWith("tls", "fingerprint mismatch");
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("offline");
    expect(manager.getLastFailure()?.kind).toBe("tls");
    // A full ladder of time passes — no probe fires.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(net.requests).toHaveLength(1);
  });

  it("wakes immediately on foreground and network-change triggers", async () => {
    const { manager, net, trig } = makeManager({ host: makeHost(), token: TOKEN });
    net.failWith("network", "down");
    await manager.start();
    await settle();
    expect(net.requests).toHaveLength(1);

    trig.fireForeground();
    await settle();
    expect(net.requests).toHaveLength(2);

    trig.fireNetworkChange();
    await settle();
    expect(net.requests).toHaveLength(3);
    expect(manager.getStatus()).toBe("offline");
  });

  it("retryNow() probes even while connected (the manual retry button)", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("connected");
    manager.retryNow();
    await settle();
    expect(net.requests).toHaveLength(2);
    expect(manager.getStatus()).toBe("connected");
  });
});

// ── api() + sse() ───────────────────────────────────────────────────────────

describe("ConnectionManager api()", () => {
  it("sends Bearer + base URL + pin, and maps status→ok", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler((o) =>
      o.url.endsWith("/health")
        ? ok(healthBody())
        : o.url.endsWith("/api/v1/settings/device-link")
          ? { status: 403, headers: {}, bodyText: "{}" } // a shell-only route for device tokens
          : ok(JSON.stringify({ sessions: [] })),
    );
    await manager.start();
    await settle();
    const result = await manager.api("/api/v1/sessions", { method: "GET" });
    const last = net.requests.at(-1);
    expect(last?.url).toBe("https://192.168.1.4:53411/api/v1/sessions");
    expect(last?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(last?.pinSha256).toBe(CERT_FP);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe(JSON.stringify({ sessions: [] }));

    const forbidden = await manager.api("/api/v1/settings/device-link");
    expect(forbidden.ok).toBe(false);
    expect(forbidden.status).toBe(403);
  });

  it("throws NotConnectedError when the link is not connected", async () => {
    const { manager } = makeManager();
    await expect(manager.api("/api/v1/sessions")).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("answers 401 as a value AND falls back to unpaired (revoked token)", async () => {
    const { manager, net, store } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler(() => ok(healthBody()));
    await manager.start();
    await settle();
    net.setHandler(() => ({ status: 401, headers: {}, bodyText: "{}" }));
    const result = await manager.api("/api/v1/sessions");
    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
    await settle();
    expect(manager.getStatus()).toBe("unpaired");
    expect(store.calls).toContain("clear");
    expect(manager.getHost()).toBeNull();
  });

  it("a transport failure throws NetError AND transitions offline", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler(() => ok(healthBody()));
    await manager.start();
    await settle();
    net.failWith("network", "dropped");
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "network" });
    expect(manager.getStatus()).toBe("offline");
  });
});

describe("ConnectionManager sse()", () => {
  it("opens the stream with auth + body, and a network error transitions offline", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler(() => ok(healthBody()));
    await manager.start();
    await settle();

    const stream = manager.sse("/api/v1/sessions/s1/messages/stream", {
      method: "POST",
      bodyText: JSON.stringify({ text: "hello" }),
    }) as FakeSseStream;
    expect(net.streams).toHaveLength(1);
    expect(stream.openedWith.url).toBe("https://192.168.1.4:53411/api/v1/sessions/s1/messages/stream");
    expect(stream.openedWith.method).toBe("POST");
    expect(stream.openedWith.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(stream.openedWith.bodyText).toBe(JSON.stringify({ text: "hello" }));
    expect(stream.openedWith.pinSha256).toBe(CERT_FP);
    expect(manager.getStatus()).toBe("connected");

    net.streams[0]?.emitError({ kind: "network", message: "stream died" });
    expect(manager.getStatus()).toBe("offline");

    stream.close();
    expect(stream.closed).toBe(true);
  });

  it("throws NotConnectedError when the link is not connected", () => {
    const { manager } = makeManager();
    expect(() => manager.sse("/api/v1/sessions/s1/messages/stream")).toThrow(NotConnectedError);
  });
});

// ── pairing-side writes ─────────────────────────────────────────────────────

describe("ConnectionManager pairing-side writes", () => {
  it("adoptPairedHost lands connected without touching the store (pair-flow saved)", async () => {
    const { manager, net, store } = makeManager();
    const host = makeHost({ addrs: ["192.168.1.9"] });
    manager.adoptPairedHost({
      deviceToken: TOKEN,
      host,
      activeAddr: "192.168.1.9",
      live: { version: "0.102.0", machineId: MACHINE_ID },
    });
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getHost()).toEqual(host);
    expect(net.requests).toHaveLength(0);
    expect(store.calls).not.toContain("savePairing");
  });

  it("unpair() clears the store and the state", async () => {
    const { manager, store } = makeManager({ host: makeHost(), token: TOKEN });
    await manager.start();
    await manager.unpair();
    expect(manager.getStatus()).toBe("unpaired");
    expect(manager.getHost()).toBeNull();
    expect(store.calls).toContain("clear");
  });

  it("notifies subscribers on every transition", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    const statuses: ConnectionStatus[] = [];
    manager.subscribe(() => statuses.push(manager.getStatus()));
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    expect(statuses).toContain("probing");
    expect(statuses).toContain("connected");
  });
});
