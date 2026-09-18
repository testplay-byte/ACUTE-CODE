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

/** This machine's non-internal IPv4 addresses (the QR payload's `addrs`
 * list — tunnel-ready: ALWAYS an array, never a single host, per R3 §4). */
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
