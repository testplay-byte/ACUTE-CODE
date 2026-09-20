// ─────────────────────────────────────────────────────────────────────────────
// ROUND-106 (R106-S1, the sidecar mobile-link round): the MOBILE LINKING
// surface — the endpoints the Android companion pairs through and the
// frontend's Devices tab reads (docs/planning/LINKING-PROTOCOL.md §2/§5,
// ANDROID-R3-OWNER-RULINGS.md §1.2/§1.3/§1.4).
//
//   POST /api/v1/mobile/pair/start   — SHELL token only. Mints the ONE
//                                      active pairing session (8-digit PIN,
//                                      120s TTL, single-use; invalidates any
//                                      prior) and returns the QR payload.
//   POST /api/v1/mobile/pair/claim   — NO bearer auth (the wall exempts this
//                                      ONE path). TLS-listener-only: a claim
//                                      over the plaintext loopback listener
//                                      is 403 — the gate that keeps device
//                                      tokens from ever riding plaintext.
//   GET  /api/v1/mobile/devices      — shell token only: the Linked-devices
//                                      list (label, scopes, last seen).
//   DELETE /api/v1/mobile/devices/:id — shell token only: revoke = DELETE.
//   GET  /api/v1/mobile/link-info    — shell token only: the Devices tab's
//                                      one-shot status endpoint.
//
// The settings toggle itself (GET/PUT /settings/device-link) lives in
// routes/settings.ts with the other settings; its PUT drives the SAME
// controller (ctx.mobileLink) this module reads.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.js";
import { deviceAuthOf } from "./context.js";
import { errorBody } from "./helpers.js";
import { VERSION } from "../lib/version.js";
import { PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, requestArrivedOverTls } from "../lib/device-link.js";
import { getCloudConnectorStatus, normalizeRelayUrl } from "../lib/cloud-connector.js";
// R115-E2: the word-pair machine name (lib/machine-label.ts) — the friendly
// label every pairing surface below carries ADDITIVELY.
import { getMachineLabel } from "../lib/machine-label.js";
import {
  createMobileDevice,
  deleteMobileDevice,
  hashDeviceToken,
  listMobileDevices,
} from "../storage/mobile-devices.js";

/** The QR payload's protocol version (R3 §1.6: the wire protocol stays
 * versioned — v1 is the LAN link; the tunnel round grows WITHIN v:1). */
const QR_PAYLOAD_VERSION = 1;

/** The default label when the phone doesn't send one. */
const DEFAULT_DEVICE_LABEL = "Android device";

/** A sane label ceiling (a UI list row, not a bio). */
const MAX_LABEL_CHARS = 100;

/** Shell-only rejection: device tokens must never drive pairing, listing,
 * or revocation (the desktop owns the relationship — LINKING-PROTOCOL §2).
 * True = rejected (the caller returns its reply, already sent). */
function rejectDeviceTokens(request: FastifyRequest, reply: FastifyReply): boolean {
  if (deviceAuthOf(request) === null) return false;
  reply.code(403).send(
    errorBody("FORBIDDEN", "this route requires the shell token (device tokens are not allowed here)", {
      hint: "pairing, listing, and revoking devices are desktop-side actions",
    }),
  );
  return true;
}

/** True when the request rode the TLS device listener — the claim gate
 * (requestArrivedOverTls: Node's TLSSocket flag; inject()'s mock socket
 * leaves it undefined, which is exactly right — injected/plain requests
 * are NOT the device listener and must be rejected). */
function isOverTls(request: FastifyRequest): boolean {
  return requestArrivedOverTls(request);
}

/**
 * ROUND-115 (R115-E2): this machine's word-pair label for the pairing
 * surfaces — minted ONCE and persisted in the data dir
 * (`machine-label.json`, the vapid.json pattern), so the name the phone
 * home-screen shows survives restarts. Null only in the no-dataDir
 * hermetic builds (which cannot reach the pairing payloads anyway — the
 * 503s above fire first); callers fall back to hostname() exactly as the
 * pre-R115 wire did.
 */
async function machineLabelOf(ctx: RouteContext): Promise<string | null> {
  return ctx.dataDir !== undefined ? await getMachineLabel(ctx.dataDir) : null;
}

/**
 * ROUND-112 (R112-a): the phone's cloud reachability address —
 * `<relayBase>/m/<machineId>` — carried by the QR payload, the claim
 * response, and link-info ONLY while the cloud connector's tunnel is
 * CONNECTED. The field is strictly ADDITIVE (v stays 1; old 0.105.0 phones
 * ignore unknown fields), and the relayUrl is slash-normalized before
 * composing so a trailing slash can never produce `//m/…`.
 */
function relayAddressOf(machineId: string | null): string | null {
  if (machineId === null) return null;
  const status = getCloudConnectorStatus();
  if (status.state !== "connected") return null;
  const base = normalizeRelayUrl(status.relayUrl);
  if (base === "") return null;
  return `${base}/m/${machineId}`;
}

export function registerMobileRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db, mobileLink } = ctx;
  // ── POST /api/v1/mobile/pair/start — the QR payload's mint ───────────
  scope.post("/mobile/pair/start", async (request, reply) => {
    if (rejectDeviceTokens(request, reply)) return reply;
    if (mobileLink === undefined) {
      return reply.code(503).send(
        errorBody("UNAVAILABLE", "device links are unavailable on this sidecar (no machine data dir)"),
      );
    }
    const status = mobileLink.status();
    if (!status.enabled) {
      return reply.code(503).send(
        errorBody("UNAVAILABLE", "device links are disabled — enable the link before pairing", {
          hint: "PUT /api/v1/settings/device-link {enabled:true}",
        }),
      );
    }
    const pairing = mobileLink.beginPairing();
    if (pairing === null) {
      // beginPairing refuses while the listener is down (status.enabled
      // above is the same fact read twice — this is the honest backstop).
      return reply.code(503).send(
        errorBody("UNAVAILABLE", "the device listener is not running — cannot pair right now"),
      );
    }
    // THE QR PAYLOAD (the frontend encodes exactly this). `addrs` is an
    // ordered ARRAY (LAN IPv4s today, a tunnel URL joins later — R3 §4's
    // tunnel-ready rule: never a single host field). certFP is the
    // TOFU-pinned SHA-256; machineId is the stable per-machine id.
    // ROUND-112: `relay` joins ADDITIVELY — the cloud connector's guest
    // address, present only while the tunnel is live (0.105.0 phones
    // ignore it; 0.106.0 phones put it after the LAN ladder).
    // ROUND-115 (R115-E2): `machineLabel` joins the same way — the minted
    // word-pair name ("Confused Coconut") the phone shows on its home
    // screen + the PC's pairing dialog. STRICTLY ADDITIVE: v stays 1 and
    // every v1 field keeps its name and value (old phones ignore it).
    const relay = relayAddressOf(status.machineId);
    const machineLabel = await machineLabelOf(ctx);
    return {
      v: QR_PAYLOAD_VERSION,
      addrs: status.addrs,
      port: status.port,
      certFP: status.certFP,
      machineId: status.machineId,
      pin: pairing.pin,
      ttl: PAIRING_TTL_MS,
      expiresAt: pairing.expiresAt,
      ...(relay !== null ? { relay } : {}),
      ...(machineLabel !== null ? { machineLabel } : {}),
    };
  });

  // ── POST /api/v1/mobile/pair/claim — the phone's one unauthenticated hop.
  // The wall exempts this path from the bearer check (server.ts); EVERY
  // other protection lives HERE, in order:
  //   1. TLS gate — plaintext loopback claims die with 403 before any
  //      session state is touched (a device token must never ride
  //      plaintext; the phone TOFU-pins the cert the claim rides).
  //   2. Body shape — {pin: 8 digits, label?}.
  //   3. Session — live? single-use? attempts left? (the 410/401 ladder.)
  //   4. Mint — randomBytes(32) hex token, SHA-256 hash stored.
  scope.post("/mobile/pair/claim", async (request, reply) => {
    if (!isOverTls(request)) {
      return reply.code(403).send(
        errorBody("FORBIDDEN", "pairing claims must arrive over the TLS device listener"),
      );
    }
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply.code(400).send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    if (typeof raw.pin !== "string" || !/^\d{8}$/.test(raw.pin)) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.pin must be the 8-digit pairing PIN", { field: "body.pin" }),
      );
    }
    let label = DEFAULT_DEVICE_LABEL;
    if (raw.label !== undefined && raw.label !== null) {
      if (typeof raw.label !== "string" || raw.label.trim() === "") {
        return reply.code(400).send(
          errorBody("VALIDATION", "body.label must be a non-blank string", { field: "body.label" }),
        );
      }
      label = raw.label.trim().slice(0, MAX_LABEL_CHARS);
    }
    if (mobileLink === undefined) {
      // No controller = no listener could ever have served this TLS socket;
      // unreachable in practice, honest 410 when it is.
      return reply.code(410).send(errorBody("GONE", "no active pairing session"));
    }
    const attempt = mobileLink.attemptClaim(raw.pin);
    if (attempt.result === "gone") {
      // Expired, consumed (single-use), never started, or killed by the
      // 5-wrong-PIN ceiling — the phone falls back to "ask the desktop to
      // re-open the pairing window".
      return reply.code(410).send(errorBody("GONE", "no active pairing session (expired, used, or invalidated)"));
    }
    if (attempt.result === "wrong-pin") {
      return reply.code(401).send(
        errorBody("UNAUTHORIZED", "invalid pairing PIN", {
          attemptsRemaining: attempt.attemptsLeft,
          maxAttempts: PAIRING_MAX_ATTEMPTS,
          ...(attempt.attemptsLeft === 0
            ? { note: "too many wrong attempts — the pairing session was invalidated" }
            : {}),
        }),
      );
    }
    // Correct PIN — the session is already consumed (single-use). Mint the
    // long-lived device token (NO expiry by default — the R3 §1.3 ruling;
    // lastSeenAt tracks staleness, revocation is the owner's act).
    const deviceToken = randomBytes(32).toString("hex");
    const deviceId = randomUUID();
    createMobileDevice(db, { id: deviceId, label, tokenHash: hashDeviceToken(deviceToken) });
    const status = mobileLink.status();
    // What the phone persists (Keystore + its link record — LINKING-PROTOCOL
    // §2: token + certFP + addresses, nothing more). ROUND-112: `relay` is
    // the additive cloud address, present only while the tunnel is live.
    // ROUND-115 (R115-E2): machine.name becomes the minted word-pair label
    // (the phone stores it as its hostLabel) — hostname() stays the honest
    // fallback for the no-dataDir builds; `version` is untouched.
    const relay = relayAddressOf(status.machineId);
    const machineLabel = await machineLabelOf(ctx);
    return {
      deviceToken,
      deviceId,
      machine: {
        name: machineLabel ?? hostname(),
        version: VERSION,
      },
      certFP: status.certFP,
      addrs: status.addrs,
      port: status.port,
      ...(relay !== null ? { relay } : {}),
    };
  });

  // ── GET /api/v1/mobile/devices — the Linked-devices list ─────────────
  scope.get("/mobile/devices", async (request, reply) => {
    if (rejectDeviceTokens(request, reply)) return reply;
    return { devices: listMobileDevices(db) };
  });

  // ── DELETE /api/v1/mobile/devices/:id — revoke (DELETE the row) ──────
  scope.delete("/mobile/devices/:id", async (request, reply) => {
    if (rejectDeviceTokens(request, reply)) return reply;
    const { id } = request.params as Record<string, string>;
    const revoked = deleteMobileDevice(db, id);
    if (!revoked) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no linked device with id ${id}`));
    }
    return { ok: true, revoked: id };
  });

  // ── GET /api/v1/mobile/link-info — the Devices tab's one-shot status ──
  scope.get("/mobile/link-info", async (request, reply) => {
    if (rejectDeviceTokens(request, reply)) return reply;
    if (mobileLink === undefined) {
      return reply.code(503).send(
        errorBody("UNAVAILABLE", "device links are unavailable on this sidecar (no machine data dir)"),
      );
    }
    const status = mobileLink.status();
    const active = mobileLink.activePairing();
    // ROUND-112: the additive cloud address while the tunnel is live (the
    // Devices tab's "Reachable over the internet" hint reads this).
    // ROUND-115 (R115-E2): `machineLabel` rides additively too (the Devices
    // tab's pairing dialog reads the friendly name off the pair/start
    // payload; this endpoint carries it for symmetry + future consumers).
    const relay = relayAddressOf(status.machineId);
    const machineLabel = await machineLabelOf(ctx);
    return {
      enabled: status.enabled,
      port: status.port,
      addrs: status.addrs,
      certFP: status.certFP,
      machineId: status.machineId,
      activePairing: active === null ? null : { pin: active.pin, expiresAt: active.expiresAt },
      ...(relay !== null ? { relay } : {}),
      ...(machineLabel !== null ? { machineLabel } : {}),
    };
  });
}
