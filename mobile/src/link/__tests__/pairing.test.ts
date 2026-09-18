/**
 * pairing.test.ts — the QR payload parser (happy + every malformed case)
 * and the three manual fallback forms.
 */

import { describe, expect, it } from "@jest/globals";

import {
  formatCertFP,
  normalizeCertFP,
  parseManualEntry,
  parsePairingPayload,
  shortCertFP,
  shortMachineId,
} from "../pairing";

const NOW = 1_750_000_000_000;

/** A fully-valid QR payload — the R106-S2 wire shape, field order exact. */
function validQr(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    addrs: ["192.168.1.4", "192.168.1.5"],
    port: 53411,
    certFP: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    machineId: "aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd",
    pin: "12345678",
    ttl: 120000,
    expiresAt: NOW + 100_000,
    ...overrides,
  });
}

describe("parsePairingPayload", () => {
  it("accepts the happy path and normalizes certFP to bare lowercase hex", () => {
    const result = parsePairingPayload(validQr(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.v).toBe(1);
    expect(result.value.addrs).toEqual(["192.168.1.4", "192.168.1.5"]);
    expect(result.value.port).toBe(53411);
    expect(result.value.certFP).toBe(
      "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    );
    expect(result.value.pin).toBe("12345678");
    expect(result.value.ttl).toBe(120000);
    expect(result.value.expiresAt).toBe(NOW + 100_000);
  });

  it("accepts a bare 64-hex certFP (no colons) as the alternative form", () => {
    const result = parsePairingPayload(
      validQr({ certFP: "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899" }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.certFP).toHaveLength(64);
  });

  it("rejects text that is not JSON", () => {
    const result = parsePairingPayload("not json at all", NOW);
    expect(result).toEqual({ ok: false, error: { kind: "not-json" } });
  });

  it("rejects a JSON array (not an object)", () => {
    const result = parsePairingPayload("[1,2,3]", NOW);
    expect(result).toEqual({ ok: false, error: { kind: "not-object" } });
  });

  it("rejects the wrong protocol version", () => {
    const result = parsePairingPayload(validQr({ v: 2 }), NOW);
    expect(result).toEqual({ ok: false, error: { kind: "bad-version" } });
  });

  it("rejects an empty addrs array", () => {
    const result = parsePairingPayload(validQr({ addrs: [] }), NOW);
    expect(result).toEqual({ ok: false, error: { kind: "bad-addrs" } });
  });

  it("rejects non-string or blank address entries", () => {
    expect(parsePairingPayload(validQr({ addrs: ["192.168.1.4", 5] }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-addrs" },
    });
    expect(parsePairingPayload(validQr({ addrs: ["  "] }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-addrs" },
    });
  });

  it("rejects out-of-range, non-integer, and missing ports", () => {
    expect(parsePairingPayload(validQr({ port: 0 }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-port" },
    });
    expect(parsePairingPayload(validQr({ port: 65536 }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-port" },
    });
    expect(parsePairingPayload(validQr({ port: 53.5 }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-port" },
    });
  });

  it("rejects malformed certFP (wrong length, non-hex, wrong colon count)", () => {
    expect(parsePairingPayload(validQr({ certFP: "AA:BB" }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-certfp" },
    });
    expect(
      parsePairingPayload(validQr({ certFP: "zz" + "a".repeat(62) }), NOW),
    ).toEqual({ ok: false, error: { kind: "bad-certfp" } });
    // 30 colons instead of 31 — a truncated fingerprint must not pass.
    expect(
      parsePairingPayload(validQr({ certFP: "AA:".repeat(30) + "AA".repeat(4) }), NOW),
    ).toEqual({ ok: false, error: { kind: "bad-certfp" } });
  });

  it("rejects a malformed machineId", () => {
    expect(parsePairingPayload(validQr({ machineId: "short" }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-machineid" },
    });
  });

  it("rejects PINs that are not exactly 8 digits", () => {
    expect(parsePairingPayload(validQr({ pin: "1234567" }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-pin" },
    });
    expect(parsePairingPayload(validQr({ pin: "123456789" }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-pin" },
    });
    expect(parsePairingPayload(validQr({ pin: "1234567a" }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-pin" },
    });
  });

  it("rejects a non-positive ttl", () => {
    expect(parsePairingPayload(validQr({ ttl: 0 }), NOW)).toEqual({
      ok: false,
      error: { kind: "bad-ttl" },
    });
  });

  it("rejects an expired payload (expiresAt in the past)", () => {
    expect(parsePairingPayload(validQr({ expiresAt: NOW - 1 }), NOW)).toEqual({
      ok: false,
      error: { kind: "expired" },
    });
    expect(parsePairingPayload(validQr({ expiresAt: NOW }), NOW)).toEqual({
      ok: false,
      error: { kind: "expired" },
    });
  });
});

describe("parseManualEntry", () => {
  it("parses the tunnel URL form (pin stays null on the candidate later)", () => {
    const result = parseManualEntry({ address: "https://abc-xyz.trycloudflare.com", pin: "87654321" });
    expect(result).toEqual({
      ok: true,
      value: { kind: "tunnel", url: "https://abc-xyz.trycloudflare.com", pin: "87654321" },
    });
  });

  it("normalizes a tunnel URL with port, path, and trailing slash", () => {
    const result = parseManualEntry({ address: "https://host.example.com:8443/some/path/", pin: "87654321" });
    expect(result).toEqual({
      ok: true,
      value: { kind: "tunnel", url: "https://host.example.com:8443", pin: "87654321" },
    });
  });

  it("refuses plaintext http:// (TLS is mandatory)", () => {
    const result = parseManualEntry({ address: "http://192.168.1.4:53411", pin: "87654321" });
    expect(result).toEqual({ ok: false, error: { kind: "bad-address" } });
  });

  it("parses the ip:port LAN form", () => {
    const result = parseManualEntry({ address: "192.168.1.4:53411", pin: "87654321" });
    expect(result).toEqual({
      ok: true,
      value: { kind: "lan", host: "192.168.1.4", port: 53411, certFP: null, pin: "87654321" },
    });
  });

  it("parses a hostname and a bracketed IPv6 with port", () => {
    expect(parseManualEntry({ address: "office-desktop.local:53411", pin: "87654321" })).toEqual({
      ok: true,
      value: { kind: "lan", host: "office-desktop.local", port: 53411, certFP: null, pin: "87654321" },
    });
    expect(parseManualEntry({ address: "[fe80::1]:53411", pin: "87654321" })).toEqual({
      ok: true,
      value: { kind: "lan", host: "[fe80::1]", port: 53411, certFP: null, pin: "87654321" },
    });
  });

  it("accepts an optional fingerprint on the LAN form and validates it", () => {
    const good = parseManualEntry({
      address: "192.168.1.4:53411",
      pin: "87654321",
      certFP: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    });
    const lanCert = good.ok && good.value.kind === "lan" ? good.value.certFP : "UNREACHED";
    expect(lanCert).toBe("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");
    const bad = parseManualEntry({ address: "192.168.1.4:53411", pin: "87654321", certFP: "not-hex" });
    expect(bad).toEqual({ ok: false, error: { kind: "bad-certfp" } });
  });

  it("parses the bare-PIN (re-pair) form when the address is empty", () => {
    expect(parseManualEntry({ address: "", pin: "87654321" })).toEqual({
      ok: true,
      value: { kind: "pin-only", pin: "87654321" },
    });
  });

  it("refuses address forms without a port and garbage addresses", () => {
    expect(parseManualEntry({ address: "192.168.1.4", pin: "87654321" })).toEqual({
      ok: false,
      error: { kind: "bad-address" },
    });
    expect(parseManualEntry({ address: "what is this", pin: "87654321" })).toEqual({
      ok: false,
      error: { kind: "bad-address" },
    });
    expect(parseManualEntry({ address: "192.168.1.4:99999", pin: "87654321" })).toEqual({
      ok: false,
      error: { kind: "bad-address" },
    });
  });

  it("refuses a malformed PIN in every form", () => {
    expect(parseManualEntry({ address: "", pin: "1234" })).toEqual({
      ok: false,
      error: { kind: "bad-pin" },
    });
    expect(parseManualEntry({ address: "192.168.1.4:53411", pin: "12345678a" })).toEqual({
      ok: false,
      error: { kind: "bad-pin" },
    });
  });
});

describe("fingerprint display helpers", () => {
  const FP = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

  it("normalizeCertFP accepts both wire forms and rejects garbage", () => {
    expect(normalizeCertFP(FP)).toBe(FP);
    expect(normalizeCertFP(formatCertFP(FP))).toBe(FP);
    expect(normalizeCertFP("nope")).toBeNull();
  });

  it("formatCertFP produces the desktop's colon spelling", () => {
    expect(formatCertFP(FP)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it("shortCertFP and shortMachineId abbreviate for cards", () => {
    expect(shortCertFP(FP)).toBe("AABBCC…8899");
    expect(shortMachineId(FP)).toBe("aabbccdd");
  });
});
