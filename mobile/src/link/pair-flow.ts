/**
 * pair-flow.ts — the pairing ladder: validate → probe → claim → store.
 *
 * Every failure is a TYPED, honestly-messaged value (never a thrown string):
 *
 *   unreachable     every address failed at the network layer (host off /
 *                   wrong LAN) — "retry", never "re-pair"
 *   tls             the pinned fingerprint did not match — re-pair territory
 *   wrong-pin       401 from claim (+ attemptsRemaining when the host says so)
 *   window-closed   410 — the 120s PIN window expired or was consumed
 *   wrong-host      /health answered with a DIFFERENT machineId
 *   bad-response    the claim answered 200 but the body is not the contract
 *
 * The claim carries {pin, label} where label is the phone's device model
 * (expo-device at the screen layer — pure function here). On success the
 * pairing is PERSISTED via the host store (the single source of truth) and
 * returned for the connection manager to adopt.
 */

import { baseUrlFor, pinFor, type HttpResponse, type NetTransport } from "./net";
import type { HostStore, StoredHost } from "./host-store";
import { parseHealthBody, type LiveInfo } from "./connection";
import type { ManualTarget, PairingPayload } from "./pairing";

// ── inputs + results ────────────────────────────────────────────────────────

/** The normalized pairing input — built from the QR payload or manual entry. */
export interface PairCandidate {
  kind: "qr" | "tunnel" | "lan" | "pin-only";
  /** Ordered addresses: bare hosts and/or one full https URL. */
  addrs: string[];
  port: number;
  /** The TOFU fingerprint when known (QR/manual-with-fingerprint); null ⇒
   * standard CA + TOFU from the claim response (tunnel / bare LAN entry). */
  certFP: string | null;
  /** Known when the QR carried it; null ⇒ captured from /health. */
  machineId: string | null;
  pin: string;
}

export interface PairSuccess {
  deviceToken: string;
  host: StoredHost;
  /** What the winning /health probe learned (version for the host card). */
  live: LiveInfo;
  /** The address that answered — becomes the connection's active address. */
  activeAddr: string;
}

export type PairFailure =
  | { kind: "unreachable"; message: string }
  | { kind: "tls"; message: string }
  | { kind: "wrong-pin"; attemptsRemaining?: number; message: string }
  | { kind: "window-closed"; message: string }
  | { kind: "wrong-host"; message: string }
  | { kind: "bad-response"; message: string };

export type PairResult = { ok: true; value: PairSuccess } | { ok: false; error: PairFailure };

export interface PairFlowDeps {
  net: NetTransport;
  store: HostStore;
  /** The phone's label for the desktop's device list (Device.modelName). */
  label: string;
  now?(): number;
  probeTimeoutMs?: number;
}

// ── claim wire shapes (R106-S1, pinned by its tests) ────────────────────────

interface ClaimRequestBody {
  pin: string;
  label?: string;
}

interface ClaimResponseBody {
  deviceToken: string;
  deviceId: string;
  machine: { name: string; version: string };
  certFP: string;
  addrs: string[];
  port: number;
}

const CLAIM_PATH = "/api/v1/mobile/pair/claim";

function netErrorMessage(err: { message?: string }, fallback: string): string {
  return typeof err.message === "string" && err.message !== "" ? err.message : fallback;
}

// ── the ladder ──────────────────────────────────────────────────────────────

/** Build the PairCandidate from the parsed QR payload. */
export function candidateFromQr(payload: PairingPayload): PairCandidate {
  return {
    kind: "qr",
    addrs: payload.addrs,
    port: payload.port,
    certFP: payload.certFP,
    machineId: payload.machineId,
    pin: payload.pin,
  };
}

/** Build the PairCandidate from a parsed manual target. */
export function candidateFromManual(target: ManualTarget): PairCandidate {
  switch (target.kind) {
    case "tunnel":
      return {
        kind: "tunnel",
        addrs: [target.url],
        port: 443,
        certFP: null, // standard CA — the tunnel path never pins (R3 §4)
        machineId: null,
        pin: target.pin,
      };
    case "lan":
      return {
        kind: "lan",
        addrs: [target.host],
        port: target.port,
        certFP: target.certFP,
        machineId: null,
        pin: target.pin,
      };
    case "pin-only":
      // pin-only resolves against the STORED host inside pairWithHost — the
      // candidate carries an empty ladder; the stored host fills it in.
      return { kind: "pin-only", addrs: [], port: 0, certFP: null, machineId: null, pin: target.pin };
  }
}

/**
 * The full ladder. Pure orchestration over the injected transport + store —
 * the connection manager is NOT involved until the screen adopts the result.
 */
export async function pairWithHost(
  candidate: PairCandidate,
  deps: PairFlowDeps,
): Promise<PairResult> {
  const now = deps.now ?? Date.now;
  const probeTimeoutMs = deps.probeTimeoutMs ?? 3_000;

  let input = candidate;

  // pin-only: the stored host supplies the ladder (re-pair after revoke).
  if (input.kind === "pin-only") {
    const stored = await deps.store.readHost();
    if (stored === null) {
      return {
        ok: false,
        error: {
          kind: "unreachable",
          message:
            "no saved host to re-pair against — enter the desktop's address, or scan its QR code",
        },
      };
    }
    input = {
      kind: "pin-only",
      addrs: stored.addrs,
      port: stored.port,
      certFP: stored.certFP,
      machineId: stored.machineId,
      pin: input.pin,
    };
  }

  // ── step 1: probe the address ladder in order (LAN first) ────────────────
  let workingAddr: string | null = null;
  let live: LiveInfo | null = null;
  let tlsFailure: { message: string } | null = null;
  let sawWrongHost = false;

  for (const addr of input.addrs) {
    try {
      const res = await deps.net.request({
        url: `${baseUrlFor(addr, input.port)}/health`,
        method: "GET",
        headers: {},
        bodyText: undefined,
        timeoutMs: probeTimeoutMs,
        pinSha256: pinFor(addr, input.certFP),
      });
      if (res.status !== 200) continue;
      const health = parseHealthBody(res.bodyText);
      if (health === null) continue;
      if (input.machineId !== null && health.machineId !== null && health.machineId !== input.machineId) {
        // A different machine answers here (stale/reassigned address) — keep
        // climbing the ladder, remember it for the honest final message.
        sawWrongHost = true;
        continue;
      }
      workingAddr = addr;
      live = health;
      break;
    } catch (err) {
      const kind = (err as { kind?: string }).kind;
      if (kind === "tls") {
        tlsFailure = { message: netErrorMessage(err as { message?: string }, "certificate mismatch") };
        break;
      }
      continue; // network — next address
    }
  }

  if (tlsFailure !== null) {
    return {
      ok: false,
      error: {
        kind: "tls",
        message:
          "the host's certificate no longer matches the one saved on this phone — unpair and re-pair from the desktop's QR code",
      },
    };
  }
  if (workingAddr === null || live === null) {
    if (sawWrongHost) {
      return {
        ok: false,
        error: {
          kind: "wrong-host",
          message: "a different ACUTE machine answers at this address — generate a new QR on the right desktop",
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "unreachable",
        message:
          input.kind === "tunnel"
            ? "could not reach the host — check the URL and that the desktop is running"
            : "could not reach the host on any of its addresses — is the desktop on and links enabled?",
      },
    };
  }

  // ── step 2: claim the PIN over the working address ───────────────────────
  const claimBody: ClaimRequestBody = { pin: input.pin, label: deps.label };
  let claimRes: HttpResponse;
  try {
    claimRes = await deps.net.request({
      url: `${baseUrlFor(workingAddr, input.port)}${CLAIM_PATH}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify(claimBody),
      timeoutMs: probeTimeoutMs * 2,
      pinSha256: pinFor(workingAddr, input.certFP),
    });
  } catch (err) {
    const kind = (err as { kind?: string }).kind;
    if (kind === "tls") {
      return {
        ok: false,
        error: {
          kind: "tls",
          message:
            "the host's certificate no longer matches the one saved on this phone — unpair and re-pair from the desktop's QR code",
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "unreachable",
        message: netErrorMessage(err as { message?: string }, "the host stopped answering during pairing"),
      },
    };
  }

  if (claimRes.status === 401) {
    // Wrong PIN — the honest hint rides attemptsRemaining when present.
    let attemptsRemaining: number | undefined;
    try {
      const body: unknown = JSON.parse(claimRes.bodyText);
      const raw = (body as { attemptsRemaining?: unknown }).attemptsRemaining;
      if (typeof raw === "number") attemptsRemaining = raw;
    } catch {
      // The hint is optional — the message stands without it.
    }
    const suffix =
      attemptsRemaining !== undefined ? ` — ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} left` : "";
    return {
      ok: false,
      error: {
        kind: "wrong-pin",
        attemptsRemaining,
        message: `that PIN was not accepted${suffix}`,
      },
    };
  }

  if (claimRes.status === 410) {
    return {
      ok: false,
      error: {
        kind: "window-closed",
        message: "the pairing window closed — generate a new PIN on the desktop and try again",
      },
    };
  }

  if (claimRes.status !== 200) {
    return {
      ok: false,
      error: {
        kind: "bad-response",
        message: `the desktop answered HTTP ${claimRes.status} during pairing`,
      },
    };
  }

  // ── step 3: absorb the claim response into the stored host ───────────────
  let body: ClaimResponseBody;
  try {
    const parsed: unknown = JSON.parse(claimRes.bodyText);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    body = parsed as ClaimResponseBody;
  } catch {
    return { ok: false, error: { kind: "bad-response", message: "the pairing answer was malformed" } };
  }

  if (
    typeof body.deviceToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.deviceToken) ||
    typeof body.machine !== "object" ||
    body.machine === null ||
    typeof body.machine.name !== "string" ||
    !Array.isArray(body.addrs) ||
    body.addrs.some((a) => typeof a !== "string") ||
    body.addrs.length === 0 ||
    typeof body.port !== "number"
  ) {
    return {
      ok: false,
      error: { kind: "bad-response", message: "the pairing answer was malformed" },
    };
  }

  // TOFU: when the input had no fingerprint (tunnel/manual), the claim's
  // certFP becomes the pinned identity for FUTURE LAN connections. The
  // response's certFP needs normalizing (colon-hex on the wire).
  const responseFP = typeof body.certFP === "string" ? body.certFP.replace(/:/g, "").toLowerCase() : null;
  const certFP = input.certFP ?? (responseFP && /^[0-9a-f]{64}$/.test(responseFP) ? responseFP : null);

  // The stored machineId: the QR's (already verified) or /health's captured
  // one. "" only in the pathological tunnel+loopback-health+certless edge —
  // the connection manager then skips the identity check (the token is the
  // auth), never false-mismatches.
  const machineId =
    input.machineId ?? live.machineId ?? (certFP !== null ? certFP : (responseFP ?? ""));

  // The stored ladder: the working address FIRST (it demonstrably works),
  // then the desktop's own LAN list (from the claim) for future reconnects —
  // deduplicated, order preserved (tunnel-ready, R3 §4).
  const addrs = dedupe([workingAddr, ...body.addrs]);

  const host: StoredHost = {
    machineId,
    certFP,
    hostLabel: body.machine.name !== "" ? body.machine.name : "ACUTE host",
    addrs,
    port: body.port,
    pairedAt: now(),
  };

  const success: PairSuccess = { deviceToken: body.deviceToken, host, live, activeAddr: workingAddr };

  // ── step 4: persist (the store is the single source of truth) ────────────
  try {
    await deps.store.savePairing({ deviceToken: body.deviceToken, host });
  } catch {
    // A failed save honestly fails the pairing — never a "connected" state
    // that evaporates on the next launch.
    return {
      ok: false,
      error: { kind: "bad-response", message: "could not save the pairing on this device" },
    };
  }

  return { ok: true, value: success };
}

function dedupe(addrs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
