/**
 * pair-flow.ts — the pairing ladder: validate → probe → claim → store.
 *
 * Every failure is a TYPED, honestly-messaged value (never a thrown string):
 *
 *   unreachable     every address failed at the network layer (host off /
 *                   wrong LAN — or the relay answered 503 host_offline, the
 *                   clean "the desktop is offline at the cloud" verdict) —
 *                   "retry", never "re-pair"
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
 *
 * v0.106.0 (R112): the ladder is LAN-first, relay-last — the optional relay
 * base URL (from the QR or the claim response) is one more rung for the SAME
 * machineId, probed AFTER every stored address (the owner's "local OR
 * internet, automatic" ruling). The claim response's relay, when it carries
 * one, WINS over the QR's (the desktop is the authority on its own relay).
 *
 * R116-D (round-116 §1.1 — THE round's #1 bug, the phone-side half): a
 * MANUAL LAN form without a fingerprint probes with pinSha256 null, so the
 * desktop's self-signed cert fails standard-CA verification and surfaces as
 * a "tls" failure. That verdict used to carry the misleading "certificate
 * no longer matches" re-pair message — for that candidate it is a LIE: this
 * phone simply never saved the cert. The tls mapping is now manual-aware
 * (`manualTlsGuidance`); every existing message for the QR path is unchanged.
 */

import { baseUrlFor, pinFor, type HttpResponse, type NetTransport } from "./net";
import type { HostStore, StoredHost } from "./host-store";
import { parseHealthBody, type LiveInfo } from "./connection";
import { parseRelayUrl } from "./pairing";
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
  /** OPTIONAL cloud relay base URL (v0.106.0): probed AFTER every addr —
   *  full URL, standard CA, same machineId identity check. Null = none. */
  relay: string | null;
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
  /** OPTIONAL (v0.106.0): the relay base URL — the claim response wins over
   *  the QR's when both carry one (the desktop is the authority). */
  relay?: string;
}

const CLAIM_PATH = "/api/v1/mobile/pair/claim";

// ── the manual-TLS honest guidance (R116-D, round-116 §1.1) ──────────────────

/**
 * The manual-LAN TLS guidance — one line, copy.md vocabulary. A manual LAN
 * pairing without the fingerprint can NEVER verify the desktop's self-signed
 * cert (there is nothing saved to trust); the honest fix is the QR (or the
 * full pairing text, which carries the fingerprint — R116-E adds it to the
 * desktop's "Copy pairing text"). The QR path's tls message is untouched.
 */
export const MANUAL_TLS_GUIDANCE =
  "This desktop's certificate isn't saved on this phone — scan the QR code, or paste the full pairing text (it includes the fingerprint).";

/**
 * Pure: the guidance applies EXACTLY when the candidate is a MANUAL LAN form
 * with no fingerprint (candidateFromManual "lan", certFP null — TOFU at
 * claim). QR/tunnel/pin-only candidates return null (their tls failures keep
 * the existing messages).
 */
export function manualTlsGuidance(candidate: PairCandidate): string | null {
  if (candidate.kind === "lan" && candidate.certFP === null) return MANUAL_TLS_GUIDANCE;
  return null;
}

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
    relay: payload.relay,
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
        relay: null,
      };
    case "lan":
      // R118-F (round-118 §1 item 53): the manual lan ladder carries the
      // smart-paste's EXTRA hosts as further rungs — the QR path always
      // probed a whole ladder while the manual path died "unreachable" on
      // its ONE rung whenever that address was a virtual adapter. The
      // probe loop, pinFor, claim, storage: zero changes.
      return {
        kind: "lan",
        addrs: [target.host, ...(target.altHosts ?? [])],
        port: target.port,
        certFP: target.certFP,
        machineId: null,
        pin: target.pin,
        relay: null,
      };
    case "pin-only":
      // pin-only resolves against the STORED host inside pairWithHost — the
      // candidate carries an empty ladder; the stored host fills it in.
      return { kind: "pin-only", addrs: [], port: 0, certFP: null, machineId: null, pin: target.pin, relay: null };
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
  // R112: 5s per rung (was 3s) — a busy desktop mid-turn can miss a 3s probe.
  const probeTimeoutMs = deps.probeTimeoutMs ?? 5_000;

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
      relay: stored.relay,
    };
  }

  // ── step 1: probe the address ladder in order (LAN first, relay last) ───
  // The relay is one more rung for the SAME machineId: a full https URL, so
  // baseUrlFor/pinFor already give it standard-CA treatment (never the TOFU
  // pin), and /health is proxied to the desktop while its tunnel is up. When
  // the desktop is offline the relay answers a clean 503 {error:{code:
  // "host_offline"}} — that is "address not usable now" (the ladder continues
  // / the round fails retryably), NEVER an auth failure.
  const ladder = ladderFor(input);
  let workingAddr: string | null = null;
  let live: LiveInfo | null = null;
  let tlsFailure: { message: string } | null = null;
  let sawWrongHost = false;

  for (const addr of ladder) {
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
        // R116-D: a manual-LAN TOFU probe dying at the handshake is NOT a
        // mismatch — this phone never saved the cert. One honest line.
        message: manualTlsGuidance(input) ??
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
          // R116-D: same manual-aware mapping at the claim rung.
          message: manualTlsGuidance(input) ??
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

  // The relay: the claim response's wins (the desktop is the authority on
  // its own relay); an invalid/absent response field falls back to the QR's;
  // neither ⇒ null. parseRelayUrl keeps the exact wire spelling (https, ≤200
  // chars, whitespace-free — invalid values are ignored, not fatal, here).
  const relay = parseRelayUrl(body.relay) ?? input.relay ?? null;

  // The stored ladder: the working address FIRST (it demonstrably works),
  // then the desktop's own LAN list (from the claim) for future reconnects —
  // deduplicated, order preserved (tunnel-ready, R3 §4). The relay lives in
  // its OWN field (probed last by the connection ladder), so a stored addr
  // that happens to equal it is filtered out — never probed twice.
  const addrs = dedupe([workingAddr, ...body.addrs]).filter(
    (a) => relay === null || a.toLowerCase() !== relay.toLowerCase(),
  );

  const host: StoredHost = {
    machineId,
    certFP,
    hostLabel: body.machine.name !== "" ? body.machine.name : "ACUTE host",
    addrs,
    port: body.port,
    relay,
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

/** The probe ladder for a pairing candidate: every stored address in order,
 * then the relay rung LAST (LAN first, internet fallback — R112). */
export function ladderFor(candidate: PairCandidate): string[] {
  if (candidate.relay === null) return candidate.addrs;
  const relayKey = candidate.relay.toLowerCase();
  const addrs = candidate.addrs.filter((a) => a.toLowerCase() !== relayKey);
  return [...addrs, candidate.relay];
}
