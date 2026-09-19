/**
 * connection.ts — the ONE manager that owns the link's runtime truth.
 *
 * State machine: unpaired → probing → connected → offline → (backoff) probing…
 *
 *   probing→connected   a /health probe answered (machine identity verified
 *                       when the health shape carries machineId)
 *   probing→offline     every stored address failed → backoff ladder
 *                       5s → 10s → 30s (cap), RESET on success
 *   connected→offline   an api()/sse() transport failure (host dropped)
 *   offline→probing     backoff timer · app foreground · network change ·
 *                       manual retry (the owner's §1.2 auto-reconnect ruling)
 *   any→unpaired        store empty at start · api() answered 401 (revoked —
 *                       LINKING-PROTOCOL §2: "the phone's next request is
 *                       rejected and it falls back to the pairing screen")
 *
 * TLS discipline (per address, R3 §4): bare-host LAN addresses ride the TOFU
 * pin when certFP is stored; full-URL (tunnel) addresses always ride standard
 * CA verification — Cloudflare's leaf is not the desktop's certificate.
 *
 * Everything injectable (store, transport, triggers, clock) — pure TS,
 * unit-tested without React Native in sight.
 */

import type { NetError, SseStream } from "@/types/acute-net";
import { mobLog, mobWarn } from "@/lib/log";
import { baseUrlFor, pinFor, type HttpRequestOptions, type NetTransport } from "./net";
import type { HostStore, StoredHost } from "./host-store";
import type { ConnectionTriggers } from "./triggers";

export type { HttpRequestOptions };
export type { StoredHost };
export type { SseStream };

// ── public shapes ───────────────────────────────────────────────────────────

export type ConnectionStatus = "unpaired" | "probing" | "connected" | "offline";

/** What a successful /health probe learned (the linkMode shape carries
 * machineId; the loopback shape — possible through a tunnel — does not). */
export interface LiveInfo {
  version: string;
  machineId: string | null;
}

/** The last probe/transport failure, for honest status lines. */
export interface LinkFailure {
  kind: "network" | "tls";
  message: string;
}

export interface ApiCallInit {
  method?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  timeoutMs?: number;
}

/** The fetch-like result — HTTP errors are VALUES here, transport throws. */
export interface ApiResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

/** Thrown by api()/sse() when the link isn't in the connected state. */
export class NotConnectedError extends Error {
  constructor(message = "not connected to the host") {
    super(message);
    this.name = "NotConnectedError";
  }
}

export interface ConnectionManagerDeps {
  store: HostStore;
  net: NetTransport;
  triggers: ConnectionTriggers;
  /** Injectable clock (tests); default Date.now. */
  now?(): number;
  /** Per-address /health probe timeout; default 3000. */
  probeTimeoutMs?: number;
}

// ── internals ───────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3_000;
const BACKOFF_LADDER_MS = [5_000, 10_000, 30_000] as const;

/** Parse a /health body — accepts BOTH listener shapes (R106-S1):
 * linkMode {ok, version, machineId} and loopback {status, app, version}. */
export function parseHealthBody(bodyText: string): LiveInfo | null {
  try {
    const raw: unknown = JSON.parse(bodyText);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.version !== "string" || obj.version === "") return null;
    const machineId = typeof obj.machineId === "string" ? obj.machineId : null;
    return { version: obj.version, machineId };
  } catch {
    return null;
  }
}

interface ManagerState {
  status: ConnectionStatus;
  host: StoredHost | null;
  token: string | null;
  activeAddr: string | null;
  live: LiveInfo | null;
  lastSeen: number | null;
  lastFailure: LinkFailure | null;
  /** True after a TLS/pin failure — the honest "re-pair" state; the backoff
   * timer stays silent until the user (or a foreground event) asks again. */
  fatal: boolean;
}

// ── the manager ─────────────────────────────────────────────────────────────

export class ConnectionManager {
  private readonly store: HostStore;
  private readonly net: NetTransport;
  private readonly triggers: ConnectionTriggers;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;

  private state: ManagerState = {
    status: "unpaired",
    host: null,
    token: null,
    activeAddr: null,
    live: null,
    lastSeen: null,
    lastFailure: null,
    fatal: false,
  };

  private readonly listeners = new Set<() => void>();
  private unsubTriggers: (() => void)[] = [];
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private probeInFlight = false;
  private probeQueued = false;
  private started = false;
  /** True once start()'s store read resolved — the router gate's signal that
   * "unpaired" is a VERDICT, not a transient pre-boot state. */
  private booted = false;

  constructor(deps: ConnectionManagerDeps) {
    this.store = deps.store;
    this.net = deps.net;
    this.triggers = deps.triggers;
    this.now = deps.now ?? Date.now;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Load the store, subscribe the triggers, and begin probing if paired.
   * Idempotent (React strict-mode double-mount safe). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const [host, token] = await Promise.all([this.store.readHost(), this.store.readDeviceToken()]);
    if (host !== null && token !== null) {
      this.state = { ...this.state, host, token };
      this.booted = true;
      void this.probeRound();
    } else {
      // Facts without a token honestly read as unpaired (a crash mid-save
      // can never leave us half-connected — hostStore writes the token last).
      this.state = { ...this.state, host: null, token: null };
      this.booted = true;
    }
    this.unsubTriggers = [
      this.triggers.onForeground(() => this.wake("foreground")),
      this.triggers.onNetworkChange(() => this.wake("network")),
    ];
    this.notify();
  }

  /** Tear down subscriptions + timers (tests; app teardown). */
  stop(): void {
    for (const unsub of this.unsubTriggers) unsub();
    this.unsubTriggers = [];
    this.clearBackoffTimer();
    this.started = false;
  }

  // ── read side ─────────────────────────────────────────────────────────────

  getStatus(): ConnectionStatus {
    return this.state.status;
  }

  /** The store read has resolved — safe to route on the status. */
  isReady(): boolean {
    return this.booted;
  }

  getHost(): StoredHost | null {
    return this.state.host;
  }

  getLiveInfo(): LiveInfo | null {
    return this.state.live;
  }

  /** Epoch ms of the last time the host answered anything. */
  getLastSeen(): number | null {
    return this.state.lastSeen;
  }

  getLastFailure(): LinkFailure | null {
    return this.state.lastFailure;
  }

  /** The address that answered the last successful probe (diagnostics/URLs). */
  getActiveAddress(): string | null {
    return this.state.activeAddr;
  }

  /** Subscribe to every state change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── write side ────────────────────────────────────────────────────────────

  /** Manual retry (the retry button): probe now, whatever the ladder says. */
  retryNow(): void {
    this.wake("manual");
  }

  /** A probe round: try every stored address in order; LAN-first (§1.4).
   *
   * ROUND-109 (the reliability fix): a per-address "tls" failure (a REAL
   * CertificateException after the Kotlin-side reclassification) no longer
   * breaks the ladder on the spot — the next stored address still gets its
   * probe (the stale-IP-now-serves-another-TLS-host case). The ladder's
   * exhaustion + a witnessed tls failure is what makes the state FATAL
   * (the honest re-pair signal); every other shape backs off and retries. */
  private async probeRound(): Promise<void> {
    if (this.probeInFlight) {
      this.probeQueued = true;
      return;
    }
    const { host, token } = this.state;
    if (host === null || token === null) return;
    this.probeInFlight = true;
    this.setState({ status: "probing", fatal: false, lastFailure: null });

    let tlsFailure: LinkFailure | null = null;
    for (const addr of host.addrs) {
      try {
        const res = await this.net.request({
          url: `${baseUrlFor(addr, host.port)}/health`,
          method: "GET",
          headers: {},
          bodyText: undefined,
          timeoutMs: this.probeTimeoutMs,
          pinSha256: pinFor(addr, host.certFP),
        });
        if (res.status !== 200) {
          mobLog("link", "probe answered, wrong status", { addr, status: res.status });
          continue; // answered, wrong shape — next addr
        }
        const health = parseHealthBody(res.bodyText);
        if (health === null) continue;
        // The identity check — skipped when we never learned a machineId
        // (the pathological tunnel edge: pair-flow stored ""). A mismatch is
        // a DIFFERENT machine (stale/reassigned address) — skip it honestly,
        // never authenticate to it.
        if (
          host.machineId !== "" &&
          health.machineId !== null &&
          health.machineId !== host.machineId
        ) {
          mobWarn("link", "probe answered with a DIFFERENT machine — skipping", { addr });
          continue;
        }
        mobLog("link", "probe connected", { addr, version: health.version });
        this.onProbeSuccess(addr, health);
        this.probeInFlight = false;
        if (this.probeQueued) {
          this.probeQueued = false;
          void this.probeRound();
        }
        return;
      } catch (err) {
        const kind = (err as NetError).kind;
        if (kind === "tls") {
          // A REAL certificate mismatch on THIS address (the Kotlin side now
          // reserves "tls" for CertificateException verdicts only). Record it
          // and CONTINUE the ladder — another stored address may still be the
          // pinned host. If none is, the exhaustion below sets fatal honestly.
          mobWarn("link", "probe tls mismatch on one address — ladder continues", { addr });
          tlsFailure = tlsFailure ?? {
            kind: "tls",
            message:
              (err as NetError).message ??
              "the host's certificate no longer matches the pinned fingerprint",
          };
          continue;
        }
        // network/unknown — this address is unreachable; try the next.
        continue;
      }
    }

    this.probeInFlight = false;
    this.onProbeFailure(tlsFailure);
    if (this.probeQueued) {
      this.probeQueued = false;
      void this.probeRound();
    }
  }

  private onProbeSuccess(addr: string, health: LiveInfo): void {
    this.consecutiveFailures = 0; // the ladder resets on success
    this.clearBackoffTimer();
    this.setState({
      status: "connected",
      activeAddr: addr,
      live: health,
      lastSeen: this.now(),
      fatal: false,
      lastFailure: null,
    });
  }

  private onProbeFailure(tlsFailure: LinkFailure | null): void {
    this.consecutiveFailures += 1;
    const failure: LinkFailure =
      tlsFailure ?? {
        kind: "network",
        message: "the host did not answer on any stored address",
      };
    mobWarn("link", `probe round failed (${failure.kind}) — attempt ${this.consecutiveFailures}`, {
      message: failure.message,
    });
    this.setState({
      status: "offline",
      activeAddr: null,
      live: null,
      lastFailure: failure,
      fatal: tlsFailure !== null,
    });
    if (tlsFailure === null) {
      this.scheduleBackoffProbe();
    }
  }

  /** The ladder: 5s → 10s → 30s (cap). Foreground/manual wake resets nothing. */
  private scheduleBackoffProbe(): void {
    this.clearBackoffTimer();
    const rung = Math.min(this.consecutiveFailures, BACKOFF_LADDER_MS.length) - 1;
    const delay = BACKOFF_LADDER_MS[Math.max(rung, 0)];
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      void this.probeRound();
    }, delay);
  }

  private clearBackoffTimer(): void {
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  /** Foreground / network-change / manual: probe NOW (unless mid-probe). */
  private wake(source: "foreground" | "network" | "manual"): void {
    if (this.state.status === "unpaired") return;
    if (this.state.status === "connected" && source !== "manual") return;
    this.clearBackoffTimer();
    void this.probeRound();
  }

  // ── the fetch-like api ────────────────────────────────────────────────────

  private requireConnected(): { token: string; url: string; pin: string | null } {
    const { host, token, activeAddr, status } = this.state;
    if (status !== "connected" || host === null || token === null || activeAddr === null) {
      throw new NotConnectedError();
    }
    return {
      token,
      url: baseUrlFor(activeAddr, host.port),
      pin: pinFor(activeAddr, host.certFP),
    };
  }

  /**
   * The authenticated request: Bearer token, base URL, per-address pin. HTTP
   * errors are returned as values; transport failures throw NetError AND
   * transition the link offline (a fresh probe ladder starts). A 401 means
   * the token was revoked — the store is cleared and the link falls back to
   * unpaired (the pairing screen), exactly per LINKING-PROTOCOL §2.
   */
  async api(path: string, init: ApiCallInit = {}): Promise<ApiResult> {
    const { token, url, pin } = this.requireConnected();
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.headers ?? {}) };
    if (init.bodyText !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    try {
      const res = await this.net.request({
        url: `${url}${path}`,
        method,
        headers,
        bodyText: init.bodyText,
        timeoutMs: init.timeoutMs,
        pinSha256: pin,
      });
      this.onHostAnswered();
      if (res.status === 401) {
        // Revoked (or corrupted) device token — the honest fallback.
        void this.fallBackToUnpaired();
      }
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        headers: res.headers,
        bodyText: res.bodyText,
      };
    } catch (err) {
      const netErr = err as NetError;
      this.onTransportFailure(netErr);
      throw netErr;
    }
  }

  /**
   * The authenticated SSE stream (the turn stream is POST + JSON bodyText).
   * Returns the EventSource-like handle; transport-level stream failures
   * transition the link offline exactly like api() failures.
   */
  sse(path: string, init: ApiCallInit = {}): SseStream {
    const { token, url, pin } = this.requireConnected();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.headers ?? {}) };
    if (init.bodyText !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    const stream = this.net.openSse({
      url: `${url}${path}`,
      method: init.method ?? "GET",
      headers,
      bodyText: init.bodyText,
      timeoutMs: init.timeoutMs,
      pinSha256: pin,
    });
    stream.addEventListener("error", (err) => {
      if (err.kind === "tls" || err.kind === "network") {
        this.onTransportFailure(err);
      }
    });
    return stream;
  }

  /** The host answered — refresh lastSeen (staleness is information). */
  private onHostAnswered(): void {
    this.state = { ...this.state, lastSeen: this.now() };
    this.notify();
  }

  /** A transport failure while connected: offline + a fresh probe ladder. */
  private onTransportFailure(err: { kind: string; message: string }): void {
    if (this.state.status !== "connected") return;
    this.consecutiveFailures = 0; // a fresh ladder after a live connection drop
    this.setState({
      status: "offline",
      activeAddr: null,
      live: null,
      lastFailure: { kind: err.kind === "tls" ? "tls" : "network", message: err.message },
      fatal: err.kind === "tls",
    });
    if (err.kind !== "tls") this.scheduleBackoffProbe();
  }

  // ── pairing-side write paths ──────────────────────────────────────────────

  /**
   * Absorb a successful pairing (pair-flow already persisted it — the store
   * is the source of truth, this only refreshes the live manager) and land
   * in the connected state directly.
   */
  adoptPairedHost(pairing: {
    deviceToken: string;
    host: StoredHost;
    activeAddr: string;
    live: LiveInfo;
  }): void {
    this.consecutiveFailures = 0;
    this.clearBackoffTimer();
    this.state = {
      status: "connected",
      host: pairing.host,
      token: pairing.deviceToken,
      activeAddr: pairing.activeAddr,
      live: pairing.live,
      lastSeen: this.now(),
      lastFailure: null,
      fatal: false,
    };
    this.notify();
  }

  /** "Unpair this device" (settings) or the revoked-token fallback. */
  async unpair(): Promise<void> {
    await this.store.clear();
    this.fallBackToUnpairedState();
  }

  private async fallBackToUnpaired(): Promise<void> {
    await this.store.clear();
    this.fallBackToUnpairedState();
  }

  private fallBackToUnpairedState(): void {
    this.clearBackoffTimer();
    this.consecutiveFailures = 0;
    this.state = {
      status: "unpaired",
      host: null,
      token: null,
      activeAddr: null,
      live: null,
      lastSeen: null,
      lastFailure: null,
      fatal: false,
    };
    this.notify();
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private setState(patch: Partial<ManagerState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
