/**
 * pairing.ts — the QR payload + manual-entry parser (LINKING-PROTOCOL §2).
 *
 * The QR encodes the EXACT pair/start response (R106-S2 pinned the field
 * order): {"v":1,"addrs":[…],"port":…,"certFP":"AA:BB:…","machineId":"…",
 * "pin":"00000000"-style 8 digits,"ttl":120000,"expiresAt":…}.
 *
 * v0.106.0 (R112): the payload gained an OPTIONAL `relay` field — the cloud
 * relay's base URL (`https://<relay-host>/m/<machineId>`), so the phone can
 * reach the desktop from any network once the desktop's cloud connector
 * opens its tunnel. Absent = LAN/tunnel-only pairing (every pre-v0.106 QR
 * still parses); present-but-invalid = the honest typed `bad-relay` error
 * (never a silent drop). Unknown EXTRA fields are ignored (forward-compat:
 * future desktops may add fields without breaking older phones).
 *
 * R116-D: `machineLabel` (the desktop's word-pair name, "Confused Coconut")
 * graduated from ignored-extra to KNOWN-optional — the QR's payload now
 * carries it through to the confirm screen (the owner's verdict #14: the
 * confirm card should show the PC's name). Every OTHER unknown field stays
 * ignored (the forward-compat contract holds).
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
  /** OPTIONAL (v0.106.0): the cloud relay base URL
   *  (`https://<relay-host>/m/<machineId>`) — null when the QR carries none.
   *  The phone appends `/api/v1/…` exactly like any base URL; it rides
   *  standard CA verification (never the TOFU pin). */
  relay: string | null;
  /** OPTIONAL (R116-D): the desktop's word-pair name ("Confused Coconut") —
   *  carried when the QR has one so the confirm screen can show the PC's
   *  name and the pairing moment can type it in; null when absent. A KNOWN
   *  optional field — unknown OTHER fields are still ignored. */
  machineLabel?: string | null;
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
  | { kind: "bad-relay" }
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
/** The relay URL cap (the v0.106.0 pairing contract). */
const RELAY_MAX_LENGTH = 200;
/** No whitespace anywhere in a relay URL (machine-generated, zero excuses). */
const RELAY_WHITESPACE = /\s/;

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

/**
 * Validate an optional relay base URL (the v0.106.0 field): must be a string
 * starting with "https://", at most 200 chars, no whitespace anywhere.
 * Returns the URL verbatim (it is stored as the base — the phone appends
 * `/api/v1/…` paths), or null when the value is absent/invalid — the caller
 * decides which of those two null cases it is (the QR parser rejects; the
 * claim-response capture falls back).
 */
export function parseRelayUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  if (!value.startsWith("https://")) return null;
  if (value.length > RELAY_MAX_LENGTH) return null;
  if (RELAY_WHITESPACE.test(value)) return null;
  return value;
}

/** The PIN's display spelling — the 8 digits grouped 4+4 ("1234 5678"). */
export function formatPin(pin: string): string {
  return pin.length === 8 ? `${pin.slice(0, 4)} ${pin.slice(4)}` : pin;
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

  // The optional relay (v0.106.0): absent = fine (every older QR parses);
  // present-but-invalid = the honest typed error, never a silent drop. A
  // non-string value counts as present-and-invalid (the contract is strict).
  if (raw.relay !== undefined && raw.relay !== null && parseRelayUrl(raw.relay) === null) {
    return { ok: false, error: { kind: "bad-relay" } };
  }
  const relay = parseRelayUrl(raw.relay);

  // machineLabel (R116-D): now a KNOWN optional field — present + a non-empty
  // string ⇒ carried (trimmed); anything else ⇒ null. scan.tsx re-stringifies
  // the parsed value, so this is what rides the route params to the confirm
  // screen's identity tier + the pairing moment's typed name.
  const machineLabel =
    typeof raw.machineLabel === "string" && raw.machineLabel.trim() !== ""
      ? raw.machineLabel.trim()
      : null;

  // Unknown EXTRA fields are deliberately ignored (forward-compat: the
  // desktop may grow fields; only the ones above are contract).
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
      relay,
      machineLabel,
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
  /**
   * OPTIONAL alternative LAN hosts (R118-F, round-118 §1 item 53): the
   * smart-paste's EXTRA addresses (`values.addresses.slice(1)` — the desktop's
   * copied pairing text carries the FULL address ladder, and the first
   * address is not always the reachable one on multi-adapter machines).
   * Validated + deduped onto the lan target by parseManualEntry; ignored by
   * the tunnel/pin-only forms (a hand-edited address drops them — the manual
   * screen clears the stash on every address edit, so they only ever ride
   * an UNTOUCHED paste).
   */
  altHosts?: string[];
}

export type ManualTarget =
  | {
      /** A full https:// URL — the tunnel form: NO pin, standard CA (R3 §4). */
      kind: "tunnel";
      url: string;
      pin: string;
    }
  | {
      /** A bare host + port — the LAN form; certFP null = TOFU at claim.
       * altHosts (R118-F): the EXTRA LAN hosts from a multi-address paste,
       * validated + deduped (the primary host excluded); the pairing ladder
       * probes them in order after the primary. */
      kind: "lan";
      host: string;
      port: number;
      certFP: string | null;
      pin: string;
      altHosts?: string[];
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
 * R118-F: validate + dedupe the smart-paste's alternative LAN hosts onto the
 * manual lan target. Each entry may arrive as "host:port" (the smart-paste's
 * `addresses.slice(1)` — the desktop's copied ladder) or already-bare (the
 * pairing screen's own stash round-trip): a "host:port" entry must carry a
 * valid port, which is then stripped (the ladder rides the target's ONE
 * port — the desktop serves a single TLS port). Invalid entries are DROPPED,
 * never fatal (a bad extra must not kill an otherwise-good paste); the
 * primary host and duplicates (case-insensitive) are excluded.
 */
function normalizeAltHosts(host: string, altHosts: string[] | undefined): string[] {
  if (altHosts === undefined) return [];
  const seen = new Set<string>([host.toLowerCase()]);
  const out: string[] = [];
  for (const raw of altHosts) {
    const trimmed = raw.trim();
    // "host:port" (the paste shape) — the port validates, then drops.
    const withPort = /^(\[[^\]]+\]|[A-Za-z0-9][A-Za-z0-9.\-]{0,253}):([0-9]{1,5})$/.exec(trimmed);
    let bare: string | null = null;
    if (withPort !== null) {
      const port = Number.parseInt(withPort[2], 10);
      if (port >= 1 && port <= 65535) bare = withPort[1];
    } else if (/^(\[[^\]]+\]|[A-Za-z0-9][A-Za-z0-9.\-]{0,253})$/.test(trimmed)) {
      bare = trimmed;
    }
    if (bare === null) continue;
    const key = bare.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bare);
  }
  return out;
}

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
    // The tunnel form — normalize to origin (strip any trailing path/slash),
    // EXCEPT the cloud relay's room path `/m/<machineId>` (v0.106.0): that
    // path IS the address (it routes to the desktop's room at the relay),
    // so it is preserved with its hex normalized to the canonical lowercase
    // (the relay README's "manual pairing URL" carrier of the relay). Every
    // other path is still stripped — plain tunnel URLs stay origin-only.
    let rest = address.slice("https://".length);
    let path = "";
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      path = rest.slice(slash);
      rest = rest.slice(0, slash);
    }
    rest = rest.replace(/\/+$/, "");
    if (rest === "") return { ok: false, error: { kind: "bad-address" } };
    const relayRoom = /^\/m\/([0-9a-fA-F]{64})\/?$/.exec(path);
    const url =
      relayRoom !== null ? `https://${rest}/m/${relayRoom[1].toLowerCase()}` : `https://${rest}`;
    return { ok: true, value: { kind: "tunnel", url, pin } };
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

  // R118-F: the smart-paste's extra LAN hosts ride the target (validated +
  // deduped; omitted entirely when none survive, so the wire shape stays
  // byte-identical for every pre-R118 caller).
  const altHosts = normalizeAltHosts(host, input.altHosts);
  return altHosts.length > 0
    ? { ok: true, value: { kind: "lan", host, port, certFP, pin, altHosts } }
    : { ok: true, value: { kind: "lan", host, port, certFP, pin } };
}

// ── smart paste (R115-D: the desktop's "Copy pairing text" companion) ──────

/**
 * The smart-paste outcome — the fields the manual screen fills from ONE
 * clipboard read. `certFP` rides along only when the text carried a full
 * colon-hex fingerprint.
 *
 * R118-F (round-118 §1 item 53): `addresses` carries EVERY host:port the
 * text contained (the desktop's copied pairing text is the FULL address
 * ladder since R118 — the first address is not always the reachable one on
 * multi-adapter Windows machines). `address` stays `addresses[0]` (the
 * primary) so every pre-R118 consumer is unchanged; the manual screen
 * stashes `addresses.slice(1)` as the pairing ladder's extra rungs.
 */
export interface PairingTextValues {
  /** The address as typed: "host:port" (LAN) or a full "https://…" URL. */
  address: string;
  /** EVERY host:port the text carried, in order — address is [0] (R118-F). */
  addresses: string[];
  /** The 8-digit pairing PIN. */
  pin: string;
  /** The certificate fingerprint (canonical bare lowercase hex), when present. */
  certFP?: string;
}

/** "PIN 12345678" / "pin: 12345678" / "PIN12345678" — the desktop's marker. */
const PIN_MARKER = /pin[^\d]{0,6}(\d{8})/i;
/** A full https URL (tunnel origin or the cloud relay's room path). */
const HTTPS_URL = /https:\/\/[^\s<>"'·]+/i;
/** host:port search form (hostname / IPv4 / bracketed IPv6 + a 1–5 digit port). */
const HOST_PORT_SEARCH = /(\[[0-9a-fA-F:]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.\-]{0,253}):([0-9]{1,5})/g;
/** The desktop's manual-block fingerprint spelling (32 colon-separated bytes). */
const CERT_FP_SEARCH = /(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}/;
/** Any hex-ish char — flanks that disqualify an 8-digit run as "the PIN". */
const HEXISH = /[0-9a-fA-F]/;

/**
 * Parse the desktop's copied pairing text — the exact "Copy pairing text"
 * format `addr1:port · addr2:port · … · PIN 12345678` (the FULL address
 * ladder since R118-F) — and the loose formats humans actually produce
 * (host:port plus an 8-digit number anywhere, an optional "PIN" marker, a
 * trailing fingerprint). Pure; null = nothing usable on the clipboard (the
 * caller shows ONE honest line, never a red card).
 */
export function parsePairingText(text: string): PairingTextValues | null {
  let work = text.trim();
  if (work === "") return null;

  // 1. The fingerprint FIRST — its hex must never masquerade as the PIN or
  //    bleed into the address scan.
  let certFP: string | undefined;
  const fp = CERT_FP_SEARCH.exec(work);
  if (fp !== null) {
    const normalized = normalizeCertFP(fp[0]);
    if (normalized !== null) {
      certFP = normalized;
      work = work.replace(fp[0], " ");
    }
  }

  // 2. The addresses: a full https URL wins (tunnel / relay room — a URL
  //    is a DIFFERENT kind of entry, so it rides alone); otherwise EVERY
  //    host:port whose port is actually in range is collected — R118-F's
  //    collect-ALL scan (the desktop's ladder carries several). Each match
  //    is REMOVED from the work string as it is collected, so no address's
  //    digits can masquerade as the PIN in step 3.
  const addresses: string[] = [];
  const url = HTTPS_URL.exec(work);
  if (url !== null) {
    addresses.push(url[0].replace(/[.,;:]+$/, ""));
    work = work.replace(url[0], " ");
  } else {
    for (const match of work.matchAll(HOST_PORT_SEARCH)) {
      const port = Number.parseInt(match[2], 10);
      if (port < 1 || port > 65535) continue;
      addresses.push(match[0]);
      work = work.replace(match[0], " ");
    }
  }
  if (addresses.length === 0) return null;
  const address = addresses[0];

  // 3. The PIN: the "PIN" marker when present; otherwise the LAST standalone
  //    8-digit run — flanked by non-hex chars so fingerprints, relay room
  //    machineIds, and partial numbers can never win.
  let pin: string | null = null;
  const marker = PIN_MARKER.exec(work);
  if (marker !== null) {
    pin = marker[1];
  } else {
    const runs = /\d{8}/g;
    for (const match of work.matchAll(runs)) {
      const before = match.index > 0 ? work[match.index - 1] : "";
      const after = match.index + 8 < work.length ? work[match.index + 8] : "";
      if (HEXISH.test(before) || HEXISH.test(after)) continue;
      pin = match[0];
    }
  }
  if (pin === null) return null;

  return certFP === undefined
    ? { address, addresses, pin }
    : { address, addresses, pin, certFP };
}
