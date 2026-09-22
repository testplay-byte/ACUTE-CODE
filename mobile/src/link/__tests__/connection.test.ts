/**
 * connection.test.ts — the manager's state machine: probe order, pin
 * dispatch (bare-host vs URL), the relay rung (LAN first, relay last, 503
 * host_offline = retryable connectivity), the backoff ladder (5s→10s→30s,
 * reset on success), the R110 #1 hysteresis (two consecutive failed cycles
 * before connected→offline), the NetInfo debounce, no-overlap probe rounds,
 * trigger wakes, the fetch-like api(), and the sse() handle — all against
 * injected fakes (no React Native, no native bridge).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  ConnectionManager,
  HOST_OFFLINE_CODE,
  NotConnectedError,
  parseAppErrorCode,
  parseHealthBody,
  probeLadder,
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
  let network: ((event: { reachable: boolean }) => void) | null = null;
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
    fireNetworkChange(reachable: boolean) {
      network?.({ reachable });
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
/** The relay base URL exactly as the desktop builds it (v0.106.0). */
const RELAY = `https://acute-relay.anikuta.workers.dev/m/${MACHINE_ID}`;

function makeHost(overrides: Partial<StoredHost> = {}): StoredHost {
  return {
    machineId: MACHINE_ID,
    certFP: CERT_FP,
    hostLabel: "OWNER-PC",
    addrs: ["192.168.1.4"],
    port: 53411,
    relay: null,
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

/** The relay's clean "the desktop is offline" verdict (503 + the envelope). */
function hostOfflineBody(): string {
  return JSON.stringify({ error: { code: HOST_OFFLINE_CODE, message: "the desktop is offline" } });
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

/** A manager over a MUTABLE clock — the NetInfo debounce tests move time. */
function makeTimedManager(seed: { host: StoredHost; token: string }) {
  let nowMs = 1_750_000_000_000;
  const net = makeNet();
  const store = makeStore(seed);
  const trig = makeTriggers();
  const manager = new ConnectionManager({
    store: store.store,
    net: net.net,
    triggers: trig.triggers,
    now: () => nowMs,
  });
  return {
    manager,
    net,
    store,
    trig,
    tick(ms: number) {
      nowMs += ms;
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── parseHealthBody + parseAppErrorCode ─────────────────────────────────────

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

describe("parseAppErrorCode (the relay speaks the app's error envelope)", () => {
  it("parses the {error:{code,message}} shape", () => {
    expect(parseAppErrorCode(hostOfflineBody())).toBe("host_offline");
    expect(parseAppErrorCode(JSON.stringify({ error: { code: "busy", message: "…" } }))).toBe("busy");
  });

  it("returns null for non-JSON, off-shape, or empty-code bodies", () => {
    expect(parseAppErrorCode("not json")).toBeNull();
    expect(parseAppErrorCode(JSON.stringify({ ok: true }))).toBeNull();
    expect(parseAppErrorCode(JSON.stringify({ error: "flat" }))).toBeNull();
    expect(parseAppErrorCode(JSON.stringify({ error: { code: "", message: "…" } }))).toBeNull();
    expect(parseAppErrorCode(JSON.stringify({ error: { code: 7, message: "…" } }))).toBeNull();
  });
});

// ── the probe ladder (pure) ─────────────────────────────────────────────────

describe("probeLadder", () => {
  it("stored order first, the relay LAST — never duplicated", () => {
    expect(probeLadder(makeHost({ addrs: ["192.168.1.4", "192.168.1.5"] }))).toEqual([
      "192.168.1.4",
      "192.168.1.5",
    ]);
    expect(probeLadder(makeHost({ addrs: ["192.168.1.4", "192.168.1.5"], relay: RELAY }))).toEqual([
      "192.168.1.4",
      "192.168.1.5",
      RELAY,
    ]);
    // A stored addr equal to the relay (case-insensitive) is not probed twice.
    expect(probeLadder(makeHost({ addrs: [RELAY.toUpperCase(), "192.168.1.4"], relay: RELAY }))).toEqual([
      "192.168.1.4",
      RELAY,
    ]);
    expect(probeLadder(makeHost({ addrs: [], relay: RELAY }))).toEqual([RELAY]);
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

  it("probes with the R112 5s rung timeout (R110 #1a — a busy desktop can miss 3s)", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    expect(net.requests[0]?.timeoutMs).toBe(5_000);
  });

  it("pins bare-host addresses and NEVER pins URL (tunnel/relay) addresses", async () => {
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

// ── the relay rung (R112 — LAN first, relay fallback) ────────────────────────

describe("ConnectionManager — the relay rung", () => {
  it("probes the LAN rungs first, the relay LAST — off-LAN pairing still connects", async () => {
    const host = makeHost({ addrs: ["192.168.1.4", "192.168.1.5"], relay: RELAY });
    const { manager, net } = makeManager({ host, token: TOKEN });
    net.setHandler((o) =>
      o.url.startsWith("https://192.168.1.")
        ? ((): HttpResponse => { throw netError("network", "down"); })()
        : ok(healthBody()),
    );
    await manager.start();
    await settle();
    expect(net.requests.map((r) => r.url)).toEqual([
      "https://192.168.1.4:53411/health",
      "https://192.168.1.5:53411/health",
      `${RELAY}/health`,
    ]);
    // LAN rungs pin (TOFU); the relay rung never does (standard CA).
    expect(net.requests[0]?.pinSha256).toBe(CERT_FP);
    expect(net.requests[2]?.pinSha256).toBeNull();
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getActiveAddress()).toBe(RELAY);
  });

  it("connected over LAN; the LAN dies → the verification ladder fails over to the relay with NO offline flap", async () => {
    const host = makeHost({ addrs: ["192.168.1.4"], relay: RELAY });
    const { manager, net } = makeManager({ host, token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getActiveAddress()).toBe("192.168.1.4");

    // The LAN path dies; the relay (tunnel up) answers.
    net.setHandler((o) =>
      o.url.startsWith("https://192.168.1.4:")
        ? ((): HttpResponse => { throw netError("network", "lan down"); })()
        : ok(healthBody()),
    );
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "network" });
    await settle();
    // The verification probe found the relay rung — the state never left "connected".
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getActiveAddress()).toBe(RELAY);

    // api() now rides the relay: full URL, standard CA (no pin).
    net.setHandler((_o) => ok(JSON.stringify({ sessions: [] })));
    const res = await manager.api("/api/v1/sessions");
    expect(net.requests.at(-1)?.url).toBe(`${RELAY}/api/v1/sessions`);
    expect(net.requests.at(-1)?.pinSha256).toBeNull();
    expect(res.ok).toBe(true);
  });

  it("relay 503 host_offline = a retryable CONNECTIVITY failure — the pairing is NEVER wiped", async () => {
    const host = makeHost({ addrs: ["192.168.1.4"], relay: RELAY });
    const { manager, net, store } = makeManager({ host, token: TOKEN });
    // LAN dead + the desktop's tunnel down: the relay answers its clean 503.
    net.setHandler((o) =>
      o.url.startsWith("https://192.168.1.4:")
        ? ((): HttpResponse => { throw netError("network", "down"); })()
        : { status: 503, headers: {}, bodyText: hostOfflineBody() },
    );
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("offline"); // the honest verdict…
    expect(manager.getLastFailure()?.kind).toBe("network"); // …as CONNECTIVITY, not tls/auth
    expect(manager.getLastFailure()?.message).toContain("relay");
    expect(store.calls).not.toContain("clear"); // never an unpair trigger
    // …and the backoff ladder keeps retrying (retryable): the boot round
    // (2 rungs) at t=0, the 5s-backoff round (2 rungs) at t=5s.
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(net.requests).toHaveLength(4); // two full 2-rung rounds
    expect(manager.getStatus()).toBe("offline");
    // The 10s rung fires round 3 at t=15s — the ladder never gives up.
    await jest.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(net.requests).toHaveLength(6); // three full rounds
    expect(store.calls).not.toContain("clear"); // still never an unpair trigger
  });

  it("api() over the relay returns the 503 host_offline as a VALUE and verifies — never unpairs", async () => {
    const host = makeHost({ addrs: ["192.168.1.4"], relay: RELAY });
    const { manager, net, store } = makeManager({ host, token: TOKEN });
    net.setHandler((o) =>
      o.url.startsWith("https://192.168.1.4:")
        ? ((): HttpResponse => { throw netError("network", "down"); })()
        : ok(healthBody()),
    );
    await manager.start();
    await settle();
    expect(manager.getActiveAddress()).toBe(RELAY);

    net.setHandler((_o) => ({ status: 503, headers: {}, bodyText: hostOfflineBody() }));
    const result = await manager.api("/api/v1/sessions");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    await settle(); // the verification round ran (and failed — cycle 1)
    expect(net.requests.at(-1)?.url).toBe(`${RELAY}/health`);
    expect(manager.getStatus()).toBe("connected"); // hysteresis holds through cycle 1
    expect(store.calls).not.toContain("clear"); // NEVER a 401-style wipe
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

    // It drops again (an api() transport failure) — R110 #1b: the failure
    // triggers a VERIFICATION round at once (cycle 1 of a fresh count), the
    // state HOLDS connected, and the 5s backoff runs the deciding cycle.
    net.failWith("network", "dropped");
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "network" });
    await settle();
    expect(manager.getStatus()).toBe("connected"); // hysteresis: cycle 1 holds
    expect(net.requests).toHaveLength(8); // 6 probes + the failed api call + the failed verification
    await jest.advanceTimersByTimeAsync(4_999);
    expect(net.requests).toHaveLength(8);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.requests).toHaveLength(9); // cycle 2 — the deciding one
    expect(manager.getStatus()).toBe("offline");
    // Two consecutive failures → the next rung is 10s.
    await jest.advanceTimersByTimeAsync(9_999);
    expect(net.requests).toHaveLength(9);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.requests).toHaveLength(10);
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

  it("wakes immediately on foreground and (transition-gated) network-change triggers", async () => {
    const { manager, net, trig } = makeManager({ host: makeHost(), token: TOKEN });
    net.failWith("network", "down");
    await manager.start();
    await settle();
    expect(net.requests).toHaveLength(1);

    trig.fireForeground();
    await settle();
    expect(net.requests).toHaveLength(2);

    trig.fireNetworkChange(true);
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

// ── hysteresis (R110 #1b — the disconnect-loop root fix) ─────────────────────

describe("ConnectionManager hysteresis", () => {
  it("a transport failure VERIFIES with a probe — ONE failed cycle keeps the connected state", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(net.requests).toHaveLength(1);

    net.failWith("network", "dropped");
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "network" });
    await settle();
    expect(net.requests).toHaveLength(3); // the api call + the failed verification round
    expect(manager.getStatus()).toBe("connected"); // HYSTERESIS: cycle 1 holds
    expect(manager.getActiveAddress()).toBe("192.168.1.4"); // the live info holds too
    expect(manager.getLastFailure()?.kind).toBe("network"); // diagnostics still recorded

    // The 5s backoff runs the deciding cycle — THAT flips offline.
    await jest.advanceTimersByTimeAsync(4_999);
    expect(net.requests).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.requests).toHaveLength(4);
    expect(manager.getStatus()).toBe("offline");
    expect(manager.getActiveAddress()).toBeNull();
  });

  it("a transient blip heals invisibly: the verification probe SUCCEEDS, nothing ever flips", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("connected");

    // Only the api() call fails (the blip); the probe that follows succeeds.
    net.setHandler((o) =>
      o.url.endsWith("/api/v1/sessions")
        ? ((): HttpResponse => { throw netError("network", "blip"); })()
        : ok(healthBody()),
    );
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "network" });
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(net.requests).toHaveLength(3); // boot probe + the api call + ONE verification probe
    // No backoff timer is pending after a successful verification.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(net.requests).toHaveLength(3);
    expect(manager.getStatus()).toBe("connected");
  });

  it("a SUCCESS between failed cycles resets the two-count (consecutive means consecutive)", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();

    // Cycle 1 fails silently (still connected, 5s verification pending).
    net.failWith("network", "down");
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "network" });
    await settle();
    expect(manager.getStatus()).toBe("connected");

    // The host answers again before the verification cycle — the counter resets.
    net.setHandler((_o) => ok(healthBody()));
    const res = await manager.api("/api/v1/sessions");
    expect(res.ok).toBe(true);

    // The pending backoff cycle fires and fails — but it is a FRESH cycle 1.
    net.failWith("network", "down");
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(manager.getStatus()).toBe("connected"); // still only ONE consecutive failure
  });

  it("a TLS transport failure is definitive: offline + fatal immediately (re-pair territory)", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler((_o) => ok(healthBody()));
    await manager.start();
    await settle();
    net.failWith("tls", "certificate changed");
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "tls" });
    expect(manager.getStatus()).toBe("offline");
    expect(manager.getLastFailure()?.kind).toBe("tls");
    // Fatal — no auto-retry, ever: the boot probe + the failed api() call
    // itself, and NOTHING more (no verification round, no backoff retries).
    await jest.advanceTimersByTimeAsync(120_000);
    expect(net.requests).toHaveLength(2);
  });
});

// ── NetInfo debounce (R110 #1c) ──────────────────────────────────────────────

describe("ConnectionManager — NetInfo wake discipline", () => {
  it("same-verdict callbacks never probe; real transitions do — at most one per 5s", async () => {
    const { manager, net, trig, tick } = makeTimedManager({ host: makeHost(), token: TOKEN });
    net.failWith("network", "down");
    await manager.start();
    await settle();
    expect(net.requests).toHaveLength(1); // the boot probe

    // First sighting: a transition (memory null → reachable) → wake → probe.
    trig.fireNetworkChange(true);
    await settle();
    expect(net.requests).toHaveLength(2);

    // Same-verdict callbacks (cost/SSID detail churn) are not news.
    trig.fireNetworkChange(true);
    trig.fireNetworkChange(true);
    await settle();
    expect(net.requests).toHaveLength(2);

    // Dropping offline: bookkeeping only — never a probe.
    trig.fireNetworkChange(false);
    await settle();
    expect(net.requests).toHaveLength(2);

    // A real return transition, but WITHIN 5s of the last processed event → debounced.
    trig.fireNetworkChange(true);
    await settle();
    expect(net.requests).toHaveLength(2);

    // Once the burst settles past the window, the standing verdict wakes ONCE.
    tick(5_000);
    trig.fireNetworkChange(true);
    await settle();
    expect(net.requests).toHaveLength(3);
  });

  it("the foreground wake stays IMMEDIATE (no debounce — the owner's ruling)", async () => {
    const { manager, net, trig } = makeTimedManager({ host: makeHost(), token: TOKEN });
    net.failWith("network", "down");
    await manager.start();
    await settle();
    expect(net.requests).toHaveLength(1);

    trig.fireForeground();
    await settle();
    expect(net.requests).toHaveLength(2);

    trig.fireForeground();
    await settle();
    expect(net.requests).toHaveLength(3);
  });
});

// ── no overlapping probe rounds (R110 #1d) ──────────────────────────────────

describe("ConnectionManager — probe rounds never overlap", () => {
  /** A net whose requests hang on a deferred until the test releases them. */
  function makeHangingNet() {
    const requests: HttpRequestOptions[] = [];
    let release: ((res: HttpResponse | null) => void) | null = null;
    const net: NetTransport = {
      async request(options) {
        requests.push(options);
        return await new Promise<HttpResponse>((resolve, reject) => {
          release = (res) => (res === null ? reject(netError("network", "down")) : resolve(res));
        });
      },
      openSse() {
        throw new Error("not used here");
      },
    };
    return {
      net,
      requests,
      releaseNext(res: HttpResponse | null) {
        release?.(res);
        release = null;
      },
    };
  }

  it("wakes during an in-flight round queue; the queue drains to exactly ONE follow-up round", async () => {
    const hanging = makeHangingNet();
    const store = makeStore({ host: makeHost(), token: TOKEN });
    const trig = makeTriggers();
    const manager = new ConnectionManager({
      store: store.store,
      net: hanging.net,
      triggers: trig.triggers,
      now: () => 1_750_000_000_000,
    });
    void manager.start();
    await settle();
    expect(hanging.requests).toHaveLength(1); // the boot round hangs in-flight

    // Three wakes arrive while the round runs — they must NOT overlap it.
    trig.fireForeground();
    trig.fireForeground();
    trig.fireNetworkChange(true);
    await settle();
    expect(hanging.requests).toHaveLength(1);

    // The round succeeds → the queue drains to exactly one follow-up round.
    hanging.releaseNext(ok(healthBody()));
    await settle();
    expect(hanging.requests).toHaveLength(2);
    hanging.releaseNext(ok(healthBody()));
    await settle();
    expect(hanging.requests).toHaveLength(2); // collapsed — no storm
    expect(manager.getStatus()).toBe("connected");
  });

  it("a FAILED round DROPS its queued wakes — the backoff ladder owns the next attempt", async () => {
    const hanging = makeHangingNet();
    const store = makeStore({ host: makeHost(), token: TOKEN });
    const trig = makeTriggers();
    const manager = new ConnectionManager({
      store: store.store,
      net: hanging.net,
      triggers: trig.triggers,
      now: () => 1_750_000_000_000,
    });
    void manager.start();
    await settle();
    expect(hanging.requests).toHaveLength(1);

    trig.fireForeground(); // queued while the boot round hangs
    // The round FAILS — the queued wake is dropped, the 5s backoff schedules.
    hanging.releaseNext(null);
    await settle();
    expect(manager.getStatus()).toBe("offline");
    expect(hanging.requests).toHaveLength(1); // NO immediate follow-up round

    await jest.advanceTimersByTimeAsync(4_999);
    expect(hanging.requests).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    hanging.releaseNext(ok(healthBody()));
    await settle();
    expect(hanging.requests).toHaveLength(2); // the LADDER fired it — not the wake
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

  it("a transport failure throws NetError and VERIFIES (offline only after the hysteresis verdict)", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler(() => ok(healthBody()));
    await manager.start();
    await settle();
    net.failWith("network", "dropped");
    await expect(manager.api("/api/v1/sessions")).rejects.toMatchObject({ kind: "network" });
    await settle();
    expect(manager.getStatus()).toBe("connected"); // cycle 1 holds — no flap
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(manager.getStatus()).toBe("offline"); // cycle 2 decides
  });
});

describe("ConnectionManager sse()", () => {
  it("opens the stream with auth + body; a transient error VERIFIES — the status never flips (R110 #1e)", async () => {
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

    // A transient stream error: the manager VERIFIES (the host is healthy —
    // the probe succeeds) and the GLOBAL status never flips offline.
    net.streams[0]?.emitError({ kind: "network", message: "stream died" });
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(net.requests.at(-1)?.url).toBe("https://192.168.1.4:53411/health");

    stream.close();
    expect(stream.closed).toBe(true);
  });

  it("a stream error while the host is REALLY down: two failed cycles flip offline", async () => {
    const { manager, net } = makeManager({ host: makeHost(), token: TOKEN });
    net.setHandler(() => ok(healthBody()));
    await manager.start();
    await settle();
    const stream = manager.sse("/api/v1/sessions/s1/messages/stream") as FakeSseStream;

    net.failWith("network", "dead");
    net.streams[0]?.emitError({ kind: "network", message: "stream died" });
    await settle(); // the verification round fails — cycle 1
    expect(manager.getStatus()).toBe("connected");
    await jest.advanceTimersByTimeAsync(5_000);
    await settle(); // cycle 2 — the deciding one
    expect(manager.getStatus()).toBe("offline");
    stream.close();
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

// ── R118-B: the multi-host surface (spec §5.5) ──────────────────────────────

describe("ConnectionManager — the R118-B multi-host surface", () => {
  const MACHINE_ID2 = "dd".repeat(32);
  const CERT_FP2 = "ee".repeat(32);
  const TOKEN2 = "ff".repeat(32);

  function makeHostB(): StoredHost {
    return makeHost({
      machineId: MACHINE_ID2,
      certFP: CERT_FP2,
      hostLabel: "STUDIO-PC",
      addrs: ["192.168.1.9"],
    });
  }

  /** A MULTI-host fake: the list + the active pointer + per-host tokens,
   *  mirroring hostStore's real contract (upsert/set-active/remove-falls). */
  function makeMultiStore(
    hosts: StoredHost[],
    tokens: Record<string, string>,
    activeId: string | null,
  ) {
    const state = { hosts: [...hosts], tokens: { ...tokens }, activeId };
    const calls: string[] = [];
    const store: HostStore = {
      async readHost() {
        calls.push("readHost");
        return (state.hosts.find((h) => h.machineId === state.activeId) ?? null);
      },
      async readActiveHost() {
        calls.push("readActiveHost");
        return state.hosts.find((h) => h.machineId === state.activeId) ?? null;
      },
      async listHosts() {
        calls.push("listHosts");
        return [...state.hosts];
      },
      async readDeviceToken(machineId) {
        calls.push("readDeviceToken");
        const id = machineId ?? state.activeId;
        return id === null ? null : (state.tokens[id] ?? null);
      },
      async setActiveHost(machineId) {
        calls.push(`setActiveHost:${machineId}`);
        state.activeId = machineId;
      },
      async savePairing(pairing) {
        calls.push("savePairing");
        const next = state.hosts.filter((h) => h.machineId !== pairing.host.machineId);
        state.hosts = [...next, pairing.host];
        state.tokens[pairing.host.machineId] = pairing.deviceToken;
        state.activeId = pairing.host.machineId;
      },
      async removeHost(machineId) {
        calls.push(`removeHost:${machineId}`);
        state.hosts = state.hosts.filter((h) => h.machineId !== machineId);
        delete state.tokens[machineId];
        if (state.activeId === machineId) {
          state.activeId = state.hosts[0]?.machineId ?? null;
        }
      },
      async clear() {
        calls.push("clear");
        state.hosts = [];
        state.tokens = {};
        state.activeId = null;
      },
    };
    return { store, calls, state };
  }

  function makeMultiManager() {
    const net = makeNet();
    const store = makeMultiStore(
      [makeHost(), makeHostB()],
      { [MACHINE_ID]: TOKEN, [MACHINE_ID2]: TOKEN2 },
      MACHINE_ID,
    );
    const trig = makeTriggers();
    const manager = new ConnectionManager({
      store: store.store,
      net: net.net,
      triggers: trig.triggers,
      now: () => 1_750_000_000_000,
    });
    return { manager, net, store, trig };
  }

  it("listHosts() answers the store's whole list (the switcher's rows)", async () => {
    const { manager, store } = makeMultiManager();
    const list = await manager.listHosts();
    expect(list.map((h) => h.hostLabel)).toEqual(["OWNER-PC", "STUDIO-PC"]);
    expect(store.calls).toContain("listHosts");
  });

  it("switchHost swaps the link: pointer write, teardown, a FRESH probe onto the new desktop", async () => {
    const { manager, net, store } = makeMultiManager();
    // Both desktops are healthy; the ladder answer must match the machine.
    net.setHandler((o) =>
      o.url.startsWith("https://192.168.1.9") ? ok(healthBody(MACHINE_ID2)) : ok(healthBody()),
    );
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getHost()?.machineId).toBe(MACHINE_ID);
    expect(manager.getActiveAddress()).toBe("192.168.1.4");

    const statuses: ConnectionStatus[] = [];
    manager.subscribe(() => statuses.push(manager.getStatus()));
    await manager.switchHost(MACHINE_ID2);
    await settle();

    expect(store.calls).toContain(`setActiveHost:${MACHINE_ID2}`);
    // Subscribers saw probing → connected (spec §2.5), never a dead jump.
    expect(statuses).toContain("probing");
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getHost()?.machineId).toBe(MACHINE_ID2);
    expect(manager.getActiveAddress()).toBe("192.168.1.9");
    expect(net.requests.at(-1)?.url).toBe("https://192.168.1.9:53411/health");
  });

  it("an in-flight probe for the OLD host never reports onto the new link (the generation bump)", async () => {
    const store = makeMultiStore(
      [makeHost(), makeHostB()],
      { [MACHINE_ID]: TOKEN, [MACHINE_ID2]: TOKEN2 },
      MACHINE_ID,
    );
    const requests: HttpRequestOptions[] = [];
    const hanging = new Map<string, (res: HttpResponse) => void>();
    const net: NetTransport = {
      async request(options) {
        requests.push(options);
        if (options.url.startsWith("https://192.168.1.4")) {
          // Host A's rungs hang until the test releases them.
          return new Promise<HttpResponse>((resolve) => {
            hanging.set("A", resolve);
          });
        }
        return ok(healthBody(MACHINE_ID2));
      },
      openSse() {
        throw new Error("unused in this test");
      },
    };
    const manager = new ConnectionManager({
      store: store.store,
      net,
      triggers: makeTriggers().triggers,
      now: () => 1_750_000_000_000,
    });
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("probing"); // A's probe never answered

    await manager.switchHost(MACHINE_ID2);
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getHost()?.machineId).toBe(MACHINE_ID2);
    expect(manager.getActiveAddress()).toBe("192.168.1.9");

    // The stale round resolves LATE with A's healthy verdict — the
    // generation check abandons it: an old host's success must never claim
    // the new link.
    hanging.get("A")?.(ok(healthBody()));
    await settle();
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getHost()?.machineId).toBe(MACHINE_ID2);
    expect(manager.getActiveAddress()).toBe("192.168.1.9");
  });

  it("a 401 removes ONLY the active host — the survivor takes over, the store is never cleared", async () => {
    const { manager, net, store } = makeMultiManager();
    net.setHandler((o) => {
      if (o.url.endsWith("/health")) {
        return o.url.startsWith("https://192.168.1.9") ? ok(healthBody(MACHINE_ID2)) : ok(healthBody());
      }
      return { status: 401, headers: {}, bodyText: "" }; // the revoked token
    });
    await manager.start();
    await settle();
    expect(manager.getStatus()).toBe("connected");

    const res = await manager.api("/api/v1/notifications?limit=1");
    expect(res.ok).toBe(false);
    await settle(); // unpair() → removeHost(A) → the survivor probes fresh

    expect(store.calls).toContain(`removeHost:${MACHINE_ID}`);
    expect(store.calls).not.toContain("clear");
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getHost()?.machineId).toBe(MACHINE_ID2);
    // The other desktop survives in the store.
    expect((await manager.listHosts()).map((h) => h.machineId)).toEqual([MACHINE_ID2]);
  });

  it("removeHost drops one desktop: the active link falls to the survivor, probed fresh", async () => {
    const { manager, net, store } = makeMultiManager();
    net.setHandler((o) =>
      o.url.startsWith("https://192.168.1.9") ? ok(healthBody(MACHINE_ID2)) : ok(healthBody()),
    );
    await manager.start();
    await settle();
    expect(manager.getHost()?.machineId).toBe(MACHINE_ID);

    await manager.removeHost(MACHINE_ID);
    await settle();

    expect(store.calls).toContain(`removeHost:${MACHINE_ID}`);
    expect(store.calls).not.toContain("clear");
    expect(manager.getStatus()).toBe("connected");
    expect(manager.getHost()?.machineId).toBe(MACHINE_ID2);
  });
});
