/**
 * pairing.ts — the QR payload + manual-entry parser (LINKING-PROTOCOL §2).
 *
 * The QR encodes the EXACT pair/start response (R106-S2 pinned the field
 * order): {"v":1,"addrs":[…],"port":…,"certFP":"AA:BB:…","machineId":"…",
 * "pin":"00000000"-style 8 digits,"ttl":120000,"expiresAt":…}.
 *
 * Every malformed case surfaces as a TYPED error (never a thrown string), so
 * the pairing screen can render an honest, specific message. Manual entry
 * accepts the three fallback forms (R3 §4: a full URL must work TODAY so a
 * quick-tunnel URL can be typed by hand): "https://host:port" (tunnel — no
 * certificate pin, standard CA), "ip:port" (LAN), and a bare PIN (re-pair
 * against the stored host).
 */

// ── the QR payload ──────────────────────────────────────────────────────────

/** The normalized, validated QR payload — certFP is the canonical no-colon
 * lowercase 64-hex form acute-net consumes. */
export interface PairingPayload {
  v: 1;
  addrs: string[];
  port: number;
  certFP: string;
  machineId: string;
  pin: string;
  ttl: number;
  expiresAt: number;
}

export type PairingParseError =
  | { kind: "not-json" }
  | { kind: "not-object" }
  | { kind: "bad-version" }
  | { kind: "bad-addrs" }
  | { kind: "bad-port" }
  | { kind: "bad-certfp" }
  | { kind: "bad-machineid" }
  | { kind: "bad-pin" }
  | { kind: "bad-ttl" }
  | { kind: "expired" };

export type PairingParseResult =
  | { ok: true; value: PairingPayload }
  | { ok: false; error: PairingParseError };

/** 64 hex chars, no separators (machineId + the canonical certFP form). */
const HEX64 = /^[0-9a-fA-F]{64}$/;
/** 64 hex chars with the X509Certificate.fingerprint256 colons (16…:…:…). */
const HEX64_COLONS = /^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/;
/** The pairing PIN — 8 digits (R106-S1's rejection-sampled form). */
const PIN8 = /^\d{8}$/;

/** Normalize a fingerprint: accept colon-hex or bare hex → 64 lowercase hex. */
export function normalizeCertFP(text: string): string | null {
  const trimmed = text.trim();
  if (HEX64.test(trimmed)) return trimmed.toLowerCase();
  if (HEX64_COLONS.test(trimmed)) return trimmed.replace(/:/g, "").toLowerCase();
  return null;
}

/** Canonical → display form: "AA:BB:CC:…" (the desktop's spelling). */
export function formatCertFP(certFP: string): string {
  return (certFP.replace(/:/g, "").toUpperCase().match(/../g) ?? []).join(":");
}

/** The short fingerprint/certificate spelling for cards: "AA:BB:CC…:FF". */
export function shortCertFP(certFP: string): string {
  const bare = certFP.replace(/:/g, "").toUpperCase();
  return `${bare.slice(0, 6)}…${bare.slice(-4)}`;
}

/** The machineId's short spelling for cards: first 8 hex chars. */
export function shortMachineId(machineId: string): string {
  return machineId.replace(/:/g, "").slice(0, 8);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate the QR payload text. Validation order mirrors the contract
 * list; the first failure wins so users get ONE specific message, not a pile.
 */
export function parsePairingPayload(text: string, now: number = Date.now()): PairingParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "not-json" } };
  }
  if (!isPlainObject(raw)) return { ok: false, error: { kind: "not-object" } };

  if (raw.v !== 1) return { ok: false, error: { kind: "bad-version" } };

  const addrs = raw.addrs;
  if (
    !Array.isArray(addrs) ||
    addrs.length === 0 ||
    addrs.some((a) => typeof a !== "string" || a.trim() === "" || a.includes("/"))
  ) {
    return { ok: false, error: { kind: "bad-addrs" } };
  }

  const port = raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: { kind: "bad-port" } };
  }

  const certFP =
    typeof raw.certFP === "string" ? normalizeCertFP(raw.certFP) : null;
  if (certFP === null) return { ok: false, error: { kind: "bad-certfp" } };

  const machineId = typeof raw.machineId === "string" ? normalizeCertFP(raw.machineId) : null;
  if (machineId === null) return { ok: false, error: { kind: "bad-machineid" } };

  const pin = raw.pin;
  if (typeof pin !== "string" || !PIN8.test(pin)) {
    return { ok: false, error: { kind: "bad-pin" } };
  }

  const ttl = raw.ttl;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0) {
    return { ok: false, error: { kind: "bad-ttl" } };
  }

  const expiresAt = raw.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return { ok: false, error: { kind: "expired" } };
  }
  if (expiresAt <= now) return { ok: false, error: { kind: "expired" } };

  return {
    ok: true,
    value: {
      v: 1,
      addrs: (addrs as string[]).map((a) => a.trim()),
      port,
      certFP,
      machineId,
      pin,
      ttl,
      expiresAt,
    },
  };
}

// ── manual entry (the fallback forms) ───────────────────────────────────────

/** The manual entry fields as the pairing screen collects them. */
export interface ManualEntryInput {
  /** "https://host:port" (tunnel) or "host:port"/"ip:port" (LAN). Empty = bare PIN. */
  address: string;
  /** The 8-digit pairing PIN. */
  pin: string;
  /**
   * OPTIONAL certificate fingerprint (the desktop's manual fallback shows it
   * in mono text). LAN manual pairing cannot verify a self-signed cert under
   * standard CA rules, so copying the fingerprint makes the manual LAN path
   * as strong as the QR path; omitting it is allowed (the claim response
   * then supplies it — TOFU over the PIN-gated claim).
   */
  certFP?: string;
}

export type ManualTarget =
  | {
      /** A full https:// URL — the tunnel form: NO pin, standard CA (R3 §4). */
      kind: "tunnel";
      url: string;
      pin: string;
    }
  | {
      /** A bare host + port — the LAN form; certFP null = TOFU at claim. */
      kind: "lan";
      host: string;
      port: number;
      certFP: string | null;
      pin: string;
    }
  | {
      /** A bare PIN — re-pair against the ALREADY-STORED host (revoked token). */
      kind: "pin-only";
      pin: string;
    };

export type ManualParseError =
  | { kind: "bad-pin" }
  | { kind: "bad-address" }
  | { kind: "bad-certfp" };

export type ManualParseResult =
  | { ok: true; value: ManualTarget }
  | { ok: false; error: ManualParseError };

/** host:port — a hostname/IPv4, or a bracketed IPv6 literal ("[fe80::1]"). */
const HOST_PORT = /^(\[[^\]]+\]|[^\s:/]+):([0-9]{1,5})$/;

/**
 * Parse the manual entry. The address field decides the form:
 * "https://…" → tunnel; "host:port" → LAN; empty → bare PIN (pin-only).
 */
export function parseManualEntry(input: ManualEntryInput): ManualParseResult {
  const pin = input.pin.trim();
  if (!PIN8.test(pin)) return { ok: false, error: { kind: "bad-pin" } };

  const address = input.address.trim();
  if (address === "") return { ok: true, value: { kind: "pin-only", pin } };

  if (address.toLowerCase().startsWith("https://")) {
    // The tunnel form — normalize to origin (strip any trailing path/slash).
    let rest = address.slice("https://".length);
    const slash = rest.indexOf("/");
    if (slash >= 0) rest = rest.slice(0, slash);
    rest = rest.replace(/\/+$/, "");
    if (rest === "") return { ok: false, error: { kind: "bad-address" } };
    return { ok: true, value: { kind: "tunnel", url: `https://${rest}`, pin } };
  }

  if (address.toLowerCase().startsWith("http://")) {
    // TLS is mandatory (LINKING-PROTOCOL §5) — plaintext is refused honestly.
    return { ok: false, error: { kind: "bad-address" } };
  }

  const match = HOST_PORT.exec(address);
  if (match === null) return { ok: false, error: { kind: "bad-address" } };
  const host = match[1];
  const port = Number.parseInt(match[2], 10);
  if (port < 1 || port > 65535) {
    return { ok: false, error: { kind: "bad-address" } };
  }

  const certFP = input.certFP !== undefined && input.certFP.trim() !== ""
    ? normalizeCertFP(input.certFP)
    : null;
  if (input.certFP !== undefined && input.certFP.trim() !== "" && certFP === null) {
    return { ok: false, error: { kind: "bad-certfp" } };
  }

  return { ok: true, value: { kind: "lan", host, port, certFP, pin } };
}
