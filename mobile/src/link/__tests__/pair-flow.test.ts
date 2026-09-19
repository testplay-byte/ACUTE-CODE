/**
 * pair-flow.test.ts — the pairing ladder against a mocked transport + store:
 * the happy QR path, every honest error mapping (401 + attemptsRemaining,
 * 410, unreachable, tls, wrong-host), the tunnel/TOFU paths, pin-only, and
 * the v0.106.0 relay rung (LAN-first relay-last order, the claim-response
 * capture, the relay's 503 host_offline verdict).
 */

import { describe, expect, it } from "@jest/globals";

import {
  candidateFromManual,
  candidateFromQr,
  ladderFor,
  pairWithHost,
  type PairCandidate,
} from "../pair-flow";
import type { HostStore, StoredHost, StoredPairing } from "../host-store";
import type { HttpRequestOptions, HttpResponse, NetTransport } from "../net";

const MACHINE_ID = "aa".repeat(32);
const CERT_FP = "bb".repeat(32);
const RESPONSE_FP = "11".repeat(32);
const DEVICE_TOKEN = "ff".repeat(32);
const NOW = 1_750_000_000_000;
/** The relay base URL exactly as the desktop builds it (v0.106.0 QR field). */
const RELAY = `https://acute-relay.anikuta.workers.dev/m/${MACHINE_ID}`;
const RELAY_B = `https://acute-relay-2.anikuta.workers.dev/m/${MACHINE_ID}`;

function netError(kind: string, message: string): { kind: string; message: string } {
  return { kind, message };
}

function ok(bodyText: string): HttpResponse {
  return { status: 200, headers: {}, bodyText };
}

function claimBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    deviceToken: DEVICE_TOKEN,
    deviceId: "d1",
    machine: { name: "OWNER-PC", version: "0.101.0" },
    certFP: RESPONSE_FP,
    addrs: ["192.168.1.4"],
    port: 53411,
    ...overrides,
  });
}

function healthBody(machineId: string = MACHINE_ID): string {
  return JSON.stringify({ ok: true, version: "0.101.0", machineId, linkMode: true });
}

/** The fake transport: /health and /pair/claim legs are steerable per test. */
function makeNet() {
  const requests: HttpRequestOptions[] = [];
  let healthHandler: (o: HttpRequestOptions) => HttpResponse = () => ok(healthBody());
  let claimHandler: (o: HttpRequestOptions) => HttpResponse = () => ok(claimBody());
  const net: NetTransport = {
    async request(options) {
      requests.push(options);
      if (options.url.endsWith("/health")) return healthHandler(options);
      return claimHandler(options);
    },
    openSse() {
      throw new Error("pairing never opens streams");
    },
  };
  return {
    net,
    requests,
    setHealth(next: (o: HttpRequestOptions) => HttpResponse) {
      healthHandler = next;
    },
    setClaim(next: (o: HttpRequestOptions) => HttpResponse) {
      claimHandler = next;
    },
    failHealth(kind: string, message = "down") {
      healthHandler = () => {
        throw netError(kind, message);
      };
    },
    failClaim(kind: string, message = "down") {
      claimHandler = () => {
        throw netError(kind, message);
      };
    },
  };
}

function makeStore(seed?: StoredPairing) {
  let saved: StoredPairing | null = seed ?? null;
  const calls: string[] = [];
  const store: HostStore = {
    async readHost() {
      calls.push("readHost");
      return saved?.host ?? null;
    },
    async readDeviceToken() {
      calls.push("readDeviceToken");
      return saved?.deviceToken ?? null;
    },
    async savePairing(pairing) {
      calls.push("savePairing");
      saved = pairing;
    },
    async clear() {
      calls.push("clear");
      saved = null;
    },
  };
  return { store, calls, get saved() { return saved; } };
}

function qrCandidate(): PairCandidate {
  return {
    kind: "qr",
    addrs: ["192.168.1.4", "192.168.1.5"],
    port: 53411,
    certFP: CERT_FP,
    machineId: MACHINE_ID,
    pin: "12345678",
    relay: null,
  };
}

function deps(net: ReturnType<typeof makeNet>, store: ReturnType<typeof makeStore>) {
  return { net: net.net, store: store.store, label: "Pixel 9", now: () => NOW };
}

// ── the happy paths ─────────────────────────────────────────────────────────

describe("pairWithHost — the QR happy path", () => {
  it("probes, claims, stores, and returns the exact host shape", async () => {
    const net = makeNet();
    const store = makeStore();
    net.setHealth((o) =>
      o.url.startsWith("https://192.168.1.4:")
        ? ((): HttpResponse => { throw netError("network", "down"); })()
        : ok(healthBody()),
    );
    const result = await pairWithHost(qrCandidate(), deps(net, store));

    // The ladder: health on both addrs (in order), then claim on the winner.
    expect(net.requests.map((r) => r.url)).toEqual([
      "https://192.168.1.4:53411/health",
      "https://192.168.1.5:53411/health",
      "https://192.168.1.5:53411/api/v1/mobile/pair/claim",
    ]);
    // Pinned on both health probes (bare hosts + known certFP).
    expect(net.requests[0]?.pinSha256).toBe(CERT_FP);
    expect(net.requests[1]?.pinSha256).toBe(CERT_FP);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deviceToken).toBe(DEVICE_TOKEN);
    expect(result.value.activeAddr).toBe("192.168.1.5");
    expect(result.value.live).toEqual({ version: "0.101.0", machineId: MACHINE_ID });
    expect(result.value.host).toEqual({
      machineId: MACHINE_ID,
      certFP: CERT_FP, // the QR's pin wins over the response's
      hostLabel: "OWNER-PC",
      addrs: ["192.168.1.5", "192.168.1.4"], // working addr first, deduped
      port: 53411,
      relay: null, // no relay anywhere ⇒ null
      pairedAt: NOW,
    });
    expect(store.saved?.deviceToken).toBe(DEVICE_TOKEN);
    expect(store.saved?.host).toEqual(result.value.host);
  });

  it("sends the claim as {pin, label} JSON", async () => {
    const net = makeNet();
    const store = makeStore();
    await pairWithHost(qrCandidate(), deps(net, store));
    const claim = net.requests.at(-1);
    expect(claim?.method).toBe("POST");
    expect(claim?.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(claim?.bodyText ?? "{}")).toEqual({ pin: "12345678", label: "Pixel 9" });
  });

  it("probes with the R112 5s rung timeout (claim gets 2×)", async () => {
    const net = makeNet();
    const store = makeStore();
    await pairWithHost(qrCandidate(), deps(net, store));
    expect(net.requests[0]?.timeoutMs).toBe(5_000);
    expect(net.requests.at(-1)?.timeoutMs).toBe(10_000);
  });
});

// ── the error ladder ────────────────────────────────────────────────────────

describe("pairWithHost — honest error mappings", () => {
  it("maps claim 401 with attemptsRemaining", async () => {
    const net = makeNet();
    const store = makeStore();
    net.setClaim(() => ({ status: 401, headers: {}, bodyText: JSON.stringify({ attemptsRemaining: 2 }) }));
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    const error = result.ok ? null : result.error;
    expect(error?.kind).toBe("wrong-pin");
    const wrongPin = error !== null && error.kind === "wrong-pin" ? error : null;
    expect(wrongPin?.attemptsRemaining).toBe(2);
    expect(wrongPin?.message).toContain("2 attempts left");
  });

  it("maps claim 401 WITHOUT the hint (attemptsRemaining undefined)", async () => {
    const net = makeNet();
    const store = makeStore();
    net.setClaim(() => ({ status: 401, headers: {}, bodyText: "{}" }));
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    const error = result.ok ? null : result.error;
    expect(error?.kind).toBe("wrong-pin");
    const wrongPin = error !== null && error.kind === "wrong-pin" ? error : null;
    expect(wrongPin?.attemptsRemaining).toBeUndefined();
  });

  it("maps claim 410 to window-closed with the re-generate message", async () => {
    const net = makeNet();
    const store = makeStore();
    net.setClaim(() => ({ status: 410, headers: {}, bodyText: "{}" }));
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("window-closed");
    expect(result.error.message).toContain("new PIN");
  });

  it("maps every-address-unreachable to the retry message", async () => {
    const net = makeNet();
    const store = makeStore();
    net.failHealth("network");
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unreachable");
    expect(result.error.message).toContain("could not reach");
  });

  it("maps a TLS/pin mismatch to the honest re-pair message", async () => {
    const net = makeNet();
    const store = makeStore();
    net.failHealth("tls", "fingerprint mismatch");
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("tls");
    expect(result.error.message).toContain("re-pair");
  });

  it("maps a machineId mismatch to wrong-host", async () => {
    const net = makeNet();
    const store = makeStore();
    net.setHealth(() => ok(healthBody("dd".repeat(32))));
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("wrong-host");
  });

  it("maps a malformed 200 claim body to bad-response", async () => {
    const net = makeNet();
    const store = makeStore();
    net.setClaim(() => ok("{not json"));
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad-response");
  });

  it("maps a non-token device claim to bad-response (validation of the 64-hex token)", async () => {
    const net = makeNet();
    const store = makeStore();
    net.setClaim(() => ok(claimBody({ deviceToken: "short" })));
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad-response");
    expect(store.calls).not.toContain("savePairing");
  });

  it("maps a claim-time transport failure to unreachable (host died mid-pairing)", async () => {
    const net = makeNet();
    const store = makeStore();
    net.failClaim("network");
    const result = await pairWithHost(qrCandidate(), deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unreachable");
  });

  it("fails honestly when the store cannot save the pairing", async () => {
    const net = makeNet();
    const calls: string[] = [];
    const store: HostStore = {
      async readHost() {
        return null;
      },
      async readDeviceToken() {
        return null;
      },
      async savePairing() {
        calls.push("savePairing");
        throw new Error("disk full");
      },
      async clear() {},
    };
    const result = await pairWithHost(qrCandidate(), { net: net.net, store, label: "Pixel 9", now: () => NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad-response");
    expect(result.error.message).toContain("save");
  });
});

// ── the manual forms ────────────────────────────────────────────────────────

describe("pairWithHost — manual + tunnel forms", () => {
  it("tunnels with NO pin and TOFUs the response fingerprint + LAN fallbacks", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = candidateFromManual({
      kind: "tunnel",
      url: "https://abc.trycloudflare.com",
      pin: "87654321",
    });
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    // The tunnel probe + claim carried NO pin (standard CA).
    expect(net.requests[0]?.pinSha256).toBeNull();
    expect(net.requests[1]?.pinSha256).toBeNull();
    if (!result.ok) return;
    expect(result.value.host.certFP).toBe(RESPONSE_FP); // TOFU from the claim
    expect(result.value.host.addrs).toEqual([
      "https://abc.trycloudflare.com", // the working address first…
      "192.168.1.4", // …then the desktop's own LAN list (reconnect ladder)
    ]);
    expect(result.value.host.machineId).toBe(MACHINE_ID); // captured from /health
  });

  it("manual LAN without a fingerprint TOFUs the claim's fingerprint too", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = candidateFromManual({
      kind: "lan",
      host: "192.168.1.4",
      port: 53411,
      certFP: null,
      pin: "87654321",
    });
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    expect(net.requests[0]?.pinSha256).toBeNull();
    if (!result.ok) return;
    expect(result.value.host.certFP).toBe(RESPONSE_FP);
  });

  it("manual LAN WITH a fingerprint probes pinned (the desktop's fallback text)", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = candidateFromManual({
      kind: "lan",
      host: "192.168.1.4",
      port: 53411,
      certFP: CERT_FP,
      pin: "87654321",
    });
    await pairWithHost(candidate, deps(net, store));
    expect(net.requests[0]?.pinSha256).toBe(CERT_FP);
    expect(net.requests[1]?.pinSha256).toBe(CERT_FP);
  });

  it("pin-only re-pairs against the STORED host with its stored pin", async () => {
    const net = makeNet();
    const stored: StoredHost = {
      machineId: MACHINE_ID,
      certFP: CERT_FP,
      hostLabel: "OWNER-PC",
      addrs: ["192.168.1.7"],
      port: 53411,
      relay: null,
      pairedAt: 999,
    };
    const store = makeStore({ deviceToken: "ee".repeat(32), host: stored });
    const candidate = candidateFromManual({ kind: "pin-only", pin: "11223344" });
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    expect(net.requests[0]?.url).toBe("https://192.168.1.7:53411/health");
    expect(net.requests[0]?.pinSha256).toBe(CERT_FP);
    if (!result.ok) return;
    // The working (stored) address first, then the desktop's fresh LAN list.
    expect(result.value.host.addrs).toEqual(["192.168.1.7", "192.168.1.4"]);
  });

  it("pin-only re-pairs through the STORED relay when the stored LAN is gone", async () => {
    const net = makeNet();
    const stored: StoredHost = {
      machineId: MACHINE_ID,
      certFP: CERT_FP,
      hostLabel: "OWNER-PC",
      addrs: ["192.168.1.7"],
      port: 53411,
      relay: RELAY,
      pairedAt: 999,
    };
    const store = makeStore({ deviceToken: "ee".repeat(32), host: stored });
    const candidate = candidateFromManual({ kind: "pin-only", pin: "11223344" });
    net.setHealth((o) =>
      o.url.startsWith("https://192.168.1.7:")
        ? ((): HttpResponse => { throw netError("network", "down"); })()
        : ok(healthBody()),
    );
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    expect(net.requests.map((r) => r.url)).toEqual([
      "https://192.168.1.7:53411/health",
      `${RELAY}/health`,
      `${RELAY}/api/v1/mobile/pair/claim`,
    ]);
    expect(net.requests[1]?.pinSha256).toBeNull(); // the relay rung — standard CA
    if (!result.ok) return;
    expect(result.value.host.relay).toBe(RELAY); // preserved through the re-pair
  });

  it("pin-only without a stored host fails honestly", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = candidateFromManual({ kind: "pin-only", pin: "11223344" });
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unreachable");
    expect(result.error.message).toContain("no saved host");
    expect(net.requests).toHaveLength(0);
  });
});

// ── the relay rung (v0.106.0, R112) ──────────────────────────────────────────

describe("pairWithHost — the relay rung", () => {
  it("ladderFor: LAN addresses first, the relay LAST, never duplicated", () => {
    expect(ladderFor({ ...qrCandidate(), relay: null })).toEqual(["192.168.1.4", "192.168.1.5"]);
    expect(ladderFor({ ...qrCandidate(), relay: RELAY })).toEqual([
      "192.168.1.4",
      "192.168.1.5",
      RELAY,
    ]);
    // A stored addr equal to the relay (case-insensitive) is not probed twice.
    expect(
      ladderFor({ ...qrCandidate(), addrs: [RELAY.toUpperCase(), "192.168.1.4"], relay: RELAY }),
    ).toEqual(["192.168.1.4", RELAY]);
    expect(ladderFor({ ...qrCandidate(), addrs: [], relay: RELAY })).toEqual([RELAY]);
  });

  it("probes LAN first then the relay; the relay rung rides standard CA (no pin)", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = { ...qrCandidate(), relay: RELAY };
    // LAN dead, relay live — the phone off the desktop's network pairs anyway.
    net.setHealth((o) =>
      o.url.startsWith("https://192.168.1.")
        ? ((): HttpResponse => { throw netError("network", "down"); })()
        : ok(healthBody()),
    );
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    expect(net.requests.map((r) => r.url)).toEqual([
      "https://192.168.1.4:53411/health",
      "https://192.168.1.5:53411/health",
      `${RELAY}/health`,
      `${RELAY}/api/v1/mobile/pair/claim`,
    ]);
    // LAN rungs pin (TOFU); the relay rung never does (standard CA).
    expect(net.requests[0]?.pinSha256).toBe(CERT_FP);
    expect(net.requests[2]?.pinSha256).toBeNull();
    expect(net.requests[3]?.pinSha256).toBeNull();
    if (!result.ok) return;
    expect(result.value.activeAddr).toBe(RELAY);
    // The relay lives in its OWN field; the stored addrs are the LAN list.
    expect(result.value.host.relay).toBe(RELAY);
    expect(result.value.host.addrs).toEqual(["192.168.1.4"]);
    expect(store.saved?.host.relay).toBe(RELAY);
  });

  it("the claim response's relay WINS over the QR's (the desktop is the authority)", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = { ...qrCandidate(), relay: RELAY };
    net.setClaim(() => ok(claimBody({ relay: RELAY_B })));
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.host.relay).toBe(RELAY_B);
  });

  it("an invalid claim-response relay falls back to the QR's (never fatal)", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = { ...qrCandidate(), relay: RELAY };
    net.setClaim(() => ok(claimBody({ relay: "http://not-tls.example.com/m/x" })));
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.host.relay).toBe(RELAY);
  });

  it("an absent claim-response relay keeps the QR's", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = { ...qrCandidate(), relay: RELAY };
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.host.relay).toBe(RELAY);
  });

  it("manual entry of the relay's room URL pairs THROUGH the relay and stores the claim's relay (v0.106.0)", async () => {
    const net = makeNet();
    const store = makeStore();
    // The owner types the full relay address by hand (camera denied, off-LAN):
    // https://<relay>/m/<machineId> — parseManualEntry preserves the room path.
    // The tunnel is up (we pair through it), so the claim carries the relay.
    net.setClaim(() => ok(claimBody({ relay: RELAY })));
    const candidate = candidateFromManual({
      kind: "tunnel",
      url: RELAY,
      pin: "87654321",
    });
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(true);
    // The ladder is exactly the relay room rung — no pin (standard CA).
    expect(net.requests.map((r) => r.url)).toEqual([
      `${RELAY}/health`,
      `${RELAY}/api/v1/mobile/pair/claim`,
    ]);
    expect(net.requests[0]?.pinSha256).toBeNull();
    if (!result.ok) return;
    expect(result.value.activeAddr).toBe(RELAY);
    // The stored host: the claim's relay (the desktop is the authority), the
    // LAN list from the claim, and the relay-equal working addr filtered out
    // of addrs (the relay lives in its OWN field, probed last).
    expect(result.value.host.relay).toBe(RELAY);
    expect(result.value.host.addrs).toEqual(["192.168.1.4"]);
    expect(result.value.host.machineId).toBe(MACHINE_ID);
  });

  it("the relay's 503 host_offline is UNREACHABLE (retryable) — never wrong-pin/tls", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = { ...qrCandidate(), relay: RELAY };
    // LAN dead + the desktop's tunnel down: the relay answers its clean 503.
    net.setHealth((o) =>
      o.url.startsWith("https://192.168.1.")
        ? ((): HttpResponse => { throw netError("network", "down"); })()
        : {
            status: 503,
            headers: {},
            bodyText: JSON.stringify({ error: { code: "host_offline", message: "the desktop is offline" } }),
          },
    );
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unreachable");
    expect(result.error.message).toContain("could not reach");
    expect(store.calls).not.toContain("savePairing");
    expect(net.requests).toHaveLength(3); // both LAN rungs + the relay rung
  });

  it("a relay /health with the WRONG machineId is skipped (identity check holds)", async () => {
    const net = makeNet();
    const store = makeStore();
    const candidate = { ...qrCandidate(), relay: RELAY, addrs: [] };
    net.setHealth(() => ok(healthBody("dd".repeat(32))));
    const result = await pairWithHost(candidate, deps(net, store));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("wrong-host");
    expect(net.requests.map((r) => r.url)).toEqual([`${RELAY}/health`]);
  });
});

// ── candidate builders ──────────────────────────────────────────────────────

describe("candidate builders", () => {
  it("candidateFromQr carries every QR field — relay included", () => {
    expect(candidateFromQr({
      v: 1,
      addrs: ["h"],
      port: 1,
      certFP: "c",
      machineId: "m",
      pin: "p",
      ttl: 1000,
      expiresAt: 2,
      relay: RELAY,
    })).toEqual({
      kind: "qr",
      addrs: ["h"],
      port: 1,
      certFP: "c",
      machineId: "m",
      pin: "p",
      relay: RELAY,
    });
    // No relay in the QR ⇒ null on the candidate.
    expect(
      candidateFromQr({
        v: 1,
        addrs: ["h"],
        port: 1,
        certFP: "c",
        machineId: "m",
        pin: "p",
        ttl: 1000,
        expiresAt: 2,
        relay: null,
      }).relay,
    ).toBeNull();
  });
});
