/**
 * ROUND-106 (R106-S1): the per-machine DEVICE-LINK CERTIFICATE.
 *
 * The auto-reconnect guarantee's substrate (ANDROID-R3-OWNER-RULINGS.md
 * §1.2, the owner's ruling: PC off/on → the phone reconnects with ZERO
 * re-setup): the self-signed TLS certificate is generated ONCE per
 * machine and PERSISTED next to web-push's vapid.json (the exact
 * directory-resolution pattern — `<dataDir>/device-link-cert.json`, the
 * db dir / .dev dir, machine-scoped and gitignored by nature). Because
 * the file survives restarts, the SHA-256 fingerprint the phone
 * TOFU-pinned at pairing time stays valid forever — the phone's pinned
 * fingerprint is the ONLY trust anchor (SANs are generous/irrelevant to
 * pinning), so a stable cert = a stable link.
 *
 * Certificate shape: 2048-bit RSA, CN="ACUTE-CODE", 10-year validity,
 * sha256 signature, SANs = IP 127.0.0.1 + DNS localhost + this machine's
 * current LAN IPv4s (regenerated never — the LAN list rides the QR/pairing
 * payload instead, which is fresh per pairing; the cert's SANs are
 * best-effort courtesy only).
 *
 * The FINGERPRINT exposed here (`certFP`) is Node's canonical
 * X509Certificate.fingerprint256 — the SHA-256 of the DER cert in the
 * standard colon-hex format (AA:BB:…, 32 bytes). machineId derives from
 * it (the lowercase hex without colons) — the stable per-machine id the
 * QR payload and /health carry: same file forever → same id forever.
 *
 * Generation uses the `selfsigned` npm package (MIT, pure JS — pkijs +
 * @peculiar/x509, both in the license allowlist).
 */
import { X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { createSocket } from "node:dgram";
import { generate as generateSelfSigned } from "selfsigned";

/** The persisted file's name — sits NEXT TO vapid.json in the data dir. */
export const DEVICE_CERT_FILENAME = "device-link-cert.json";

/** 10 years — the cert must outlive any reasonable ownership horizon
 * because rotating it forces every paired phone to re-pair (the honest
 * response to a machine swap per LINKING-PROTOCOL §2). */
const CERT_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface DeviceCertificate {
  /** PEM private key (PKCS#8) — feeds https.createServer. */
  key: string;
  /** PEM certificate — feeds https.createServer. */
  cert: string;
  /** SHA-256 of the DER cert, colon-hex (Node's canonical form, uppercase). */
  certFP: string;
  /** Stable per-machine id — the lowercase hex fingerprint, no colons. */
  machineId: string;
}

interface PersistedCert {
  cert: string;
  key: string;
}

let cached: DeviceCertificate | null = null;

/* ── ROUND-118 (R118-F, round-118.md §1 item 53): the DEFAULT-ROUTE probe ──
 *
 * The problem: `addrs` is a plain interface enumeration, and on Windows the
 * non-internal IPv4 set includes VIRTUAL adapters (WSL/Hyper-V 172.2x,
 * Docker 172.17, VPN 10.x, APIPA 169.254.x) — the old first-octet sort put
 * ALL of them before the real 192.168.x NIC, so the phone burned its 5s
 * probe budget on addresses that can never answer, and a hand-copied FIRST
 * address was usually the wrong one. The fix: ask the OS which interface
 * actually owns the default route — a dgram udp4 socket `connect(53,
 * "8.8.8.8")` performs ONLY a local routing-table lookup (NO packet is
 * sent — a UDP connect just pins the default destination and binds the
 * local endpoint), so `sock.address().address` is the default-route
 * interface's IPv4, i.e. the one address the OS itself would use to reach
 * the internet. ~500ms budget (an unreachable/offline machine must never
 * stall the sidecar's boot); module-cached; failure → null (the ordering
 * simply falls back to the numeric sort). */

/** The probe's wall-clock budget — the sidecar never waits longer than this
 * for a routing-table lookup (offline installs, air-gapped labs). */
const PREFERRED_LAN_PROBE_BUDGET_MS = 500;

/** The sync cache `lanIPv4Addresses()` reads (null = no preferred IP known). */
let preferredLanIp: string | null = null;
/** The single-flight probe promise (success AND failure both cache — one
 * probe per process, no retry storm). */
let preferredLanIpProbe: Promise<string | null> | null = null;

/**
 * R118-F: detect this machine's default-route LAN IPv4 (the interface the
 * OS would use to reach the internet) via a dgram udp4 connect — no packet
 * leaves the machine. Resolves null on any failure (no route, budget
 * exceeded, non-IPv4 endpoint); the result is module-cached either way.
 */
export async function detectPreferredLanIp(): Promise<string | null> {
  if (preferredLanIpProbe === null) {
    preferredLanIpProbe = probeDefaultRouteLanIp().then((ip) => {
      preferredLanIp = ip;
      return ip;
    });
  }
  return preferredLanIpProbe;
}

/** The raw probe — one udp4 socket, one budget, one honest null. */
function probeDefaultRouteLanIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    let settled = false;
    const settle = (ip: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // close() throws on an already-closed socket — never let cleanup
      // turn a clean null into a crash.
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(ip);
    };
    const timer = setTimeout(() => settle(null), PREFERRED_LAN_PROBE_BUDGET_MS);
    // The error listener stays attached for the socket's whole life — an
    // unhandled 'error' on a dgram socket would kill the sidecar.
    sock.once("error", () => settle(null));
    sock.connect(53, "8.8.8.8", () => {
      const local = sock.address();
      settle(
        typeof local === "object" && local !== null && local.family === "IPv4"
          ? local.address
          : null,
      );
    });
  });
}

/** Test hook — force the cached preferred IP (null resets to "never probed",
 * so the next detectPreferredLanIp() re-probes). Mirrors
 * resetDeviceCertificateForTest's role for the cert cache. */
export function setPreferredLanIpForTest(ip: string | null): void {
  preferredLanIp = ip;
  preferredLanIpProbe = ip === null ? null : Promise.resolve(ip);
}

/** This machine's non-internal IPv4 addresses (the QR payload's `addrs`
 * list — tunnel-ready: ALWAYS an array, never a single host, per R3 §4).
 *
 * R118-F ordering (additive — `v` stays 1, only the ORDER changes, and
 * ordering was never contractual): after the numeric sort, (a) the cached
 * default-route IP (when known) moves to index 0 — the phone's FIRST probe
 * hits the address that actually answers; (b) 169.254.* (APIPA — a
 * link-local autoconfig address that can never pair) sorts LAST. On a
 * single-NIC, no-APIPA machine the output is byte-identical to R106. */
export function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // IPv4, non-internal (skip 127.0.0.1 / link-local management faces).
      if (entry.family === "IPv4" && !entry.internal) {
        out.push(entry.address);
      }
    }
  }
  // Stable-ish ordering: numeric sort keeps the list deterministic per boot
  // (the phone retries addresses in order; a shuffled list still works).
  out.sort((a, b) => {
    const pa = Number(a.split(".")[0]);
    const pb = Number(b.split(".")[0]);
    return pa === pb ? a.localeCompare(b) : pa - pb;
  });
  // (a) R118-F: the default-route NIC FIRST — the one address the OS itself
  // would use, so the QR's first probe and the copied text's first entry are
  // the best one. A preferred IP that is not among the reported NICs (or is
  // already first) leaves the list untouched.
  if (preferredLanIp !== null) {
    const idx = out.indexOf(preferredLanIp);
    if (idx > 0) {
      out.unshift(out.splice(idx, 1)[0]);
    }
  }
  // (b) R118-F: APIPA (169.254.*) LAST — a stable partition, everything
  // else keeps the order it just had.
  const apipa = out.filter((a) => a.startsWith("169.254."));
  if (apipa.length > 0 && apipa.length < out.length) {
    const real = out.filter((a) => !a.startsWith("169.254."));
    out.length = 0;
    out.push(...real, ...apipa);
  }
  return out;
}

/** Parse a PEM cert into the canonical fingerprint + machineId pair.
 * Throws on a non-PEM/corrupt input (the caller treats a corrupt file as
 * "regenerate" — same tolerance as vapid.json). */
function certificateFromPems(pems: PersistedCert): DeviceCertificate {
  const x509 = new X509Certificate(pems.cert);
  const certFP = x509.fingerprint256;
  return {
    key: pems.key,
    cert: pems.cert,
    certFP,
    machineId: certFP.replace(/:/g, "").toLowerCase(),
  };
}

/**
 * Load (or generate ONCE + persist) this machine's device-link certificate.
 * Mirrors web-push.ts's ensureVapidKeys exactly: read the JSON file next to
 * the db → validate → cache in-module; missing/corrupt → regenerate + write
 * (mode 0600, best-effort persist — an unwritable dir still yields a working
 * cert for THIS process, and a regenerated cert simply forces a re-pair,
 * the honest degraded mode). Async because selfsigned 5.x generation is
 * async (WebCrypto-backed).
 */
export async function ensureDeviceCertificate(dataDir: string): Promise<DeviceCertificate> {
  if (cached !== null) return cached;
  const certPath = join(dataDir, DEVICE_CERT_FILENAME);
  try {
    const parsed = JSON.parse(readFileSync(certPath, "utf8")) as Partial<PersistedCert>;
    if (typeof parsed.cert === "string" && typeof parsed.key === "string") {
      cached = certificateFromPems({ cert: parsed.cert, key: parsed.key });
      return cached;
    }
  } catch {
    /* missing or corrupt — regenerate below (the vapid.json tolerance) */
  }
  const pems = await generateSelfSigned([{ name: "commonName", value: "ACUTE-CODE" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: new Date(Date.now() + CERT_VALIDITY_MS),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true, clientAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 7, ip: "127.0.0.1" },
          { type: 2, value: "localhost" },
          // Generous/irrelevant to pinning (the phone pins certFP, never the
          // hostname) — but browsers/tools connecting by LAN IP get a
          // matching SAN instead of a hard error.
          ...lanIPv4Addresses().map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  cached = certificateFromPems({ cert: pems.cert, key: pems.private });
  try {
    writeFileSync(
      certPath,
      `${JSON.stringify({ cert: cached.cert, key: cached.key }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    // Non-fatal (the vapid.json rule): this process links fine; the cert
    // simply regenerates next boot and paired phones re-pair once.
    console.error("[device-link] could not persist the machine certificate:", err);
  }
  return cached;
}

/** Test hook — drop the in-module cache (a fresh dataDir re-reads). */
export function resetDeviceCertificateForTest(): void {
  cached = null;
}
