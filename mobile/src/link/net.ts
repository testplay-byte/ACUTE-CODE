/**
 * The transport seam — the link layer's PURE networking contract.
 *
 * connection.ts and pair-flow.ts consume the `NetTransport` INTERFACE
 * (constructor-injected), which keeps them pure, unit-testable TS: tests pass
 * a fake transport; the app wires the real one from ./native-transport.ts
 * (the ONLY file that imports the acute-net module at runtime).
 *
 * Pin discipline lives here as pure helpers so every caller spells the
 * tunnel-vs-LAN rule identically (R3 §4):
 *
 *   bare-host address (LAN)  + stored certFP → pinSha256 (TOFU-pinned)
 *   full https:// URL (tunnel)               → NO pin (standard CA —
 *                                              Cloudflare's leaf is not the
 *                                              desktop's certificate)
 */

import type { HttpRequestOptions, HttpResponse, SseOptions, SseStream } from "@/types/acute-net";

export type { HttpRequestOptions, HttpResponse, SseOptions, SseStream };

/** The shape connection.ts + pair-flow.ts are tested against. */
export interface NetTransport {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
  openSse(options: SseOptions): SseStream;
}

/** A full https:// URL address (the tunnel form) — no TLS pin ever applies. */
export function isUrlAddress(addr: string): boolean {
  return addr.startsWith("https://");
}

/**
 * The per-call pin: the stored certificate fingerprint applies ONLY to
 * bare-host (LAN) addresses. `certFP` is the normalized 64-hex form.
 */
export function pinFor(addr: string, certFP: string | null): string | null {
  if (certFP === null) return null;
  return isUrlAddress(addr) ? null : certFP;
}

/** Build the base URL for one stored address: URLs carry their own port. */
export function baseUrlFor(addr: string, port: number): string {
  if (isUrlAddress(addr)) return addr.replace(/\/+$/, "");
  return `https://${addr}:${port}`;
}
