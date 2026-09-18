/**
 * acute-net — the JS surface of the ACUTE companion's native networking floor.
 *
 * One import for the whole app (src/link/* consumes this; screens never do):
 *
 *   request(options) → Promise<HttpResponse>
 *   openSse(options) → SseStream — a small EventSource-like handle
 *                        { addEventListener("data"|"error"|"close", fn), close() }
 *
 * The native module (android/…/AcuteNetModule.kt, OkHttp) carries BOTH the
 * pinned-TLS fetch and the SSE stream so the TOFU certificate pin is enforced
 * at the socket layer. Reconnect/backoff logic does NOT live here or in
 * Kotlin — src/link/connection.ts owns it; this wrapper just multiplexes the
 * module's "data" | "error" | "close" events to the right stream by eventId.
 */

import { NativeModule, requireNativeModule } from "expo";

// ── the native surface (see android/src/main/java/expo/modules/acutenet) ────

/** Exactly the options bag AcuteNetModule.kt reads. */
export interface NativeNetOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
  timeoutMs: number;
  pinSha256: string | null;
}

interface NativeHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

type AcuteNetEventsMap = {
  data: (ev: { eventId: number; data: string; event?: string }) => void;
  error: (ev: { eventId: number; kind: string; message: string; status?: number }) => void;
  close: (ev: { eventId: number }) => void;
};

declare class AcuteNetNativeModule extends NativeModule<AcuteNetEventsMap> {
  request(options: NativeNetOptions): Promise<NativeHttpResponse>;
  openSse(options: NativeNetOptions): number;
  closeSse(eventId: number): void;
}

const Native = requireNativeModule<AcuteNetNativeModule>("AcuteNet");

// ── public types ────────────────────────────────────────────────────────────

export interface HttpRequestOptions {
  /** Full https:// URL — TLS is mandatory; the token never rides plaintext. */
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Raw request body (send JSON.stringify(...) yourself — no silent magic). */
  bodyText?: string;
  /** Whole-exchange timeout for request(); connect timeout for openSse(). */
  timeoutMs?: number;
  /**
   * TOFU certificate pin: SHA-256 of the host's leaf certificate, 64 hex
   * chars, NO colons. When present, EXACTLY that certificate is accepted.
   * When absent, standard CA verification runs (the Cloudflare-tunnel path).
   */
  pinSha256?: string | null;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export type NetErrorKind = "network" | "tls" | "http" | "canceled" | "bad-argument" | "unknown";

/** Every acute-net failure throws/reports as this — kind is the decision input:
 * "tls" ⇒ the certificate changed (honest re-pair), "network" ⇒ host offline
 * (honest retry), "http" ⇒ the host answered (status carried). */
export class NetError extends Error {
  readonly kind: NetErrorKind;
  readonly status?: number;

  constructor(kind: NetErrorKind, message: string, status?: number) {
    super(message);
    this.name = "NetError";
    this.kind = kind;
    this.status = status;
  }
}

export interface SseEvent {
  /** The `event:` field when the frame carried one (undefined = default data frames). */
  event?: string;
  /** The frame's `data:` lines joined with "\n". */
  data: string;
}

export interface SseError {
  message: string;
  kind: NetErrorKind;
  status?: number;
}

/** Listener shapes per addEventListener type — the EventSource spelling. */
export type SseDataListener = (ev: SseEvent) => void;
export type SseErrorListener = (err: SseError) => void;
export type SseCloseListener = () => void;

/** The stream handle — the surface src/link/connection.ts re-exposes. */
export interface SseStream {
  /** The native stream id (multiplexing key; diagnostics only). */
  readonly eventId: number;
  addEventListener(type: "data", listener: SseDataListener): SseStream;
  addEventListener(type: "error", listener: SseErrorListener): SseStream;
  addEventListener(type: "close", listener: SseCloseListener): SseStream;
  /** Cancel the stream. Safe to call more than once; no "close" fires after. */
  close(): void;
}

// ── request ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const PIN_PATTERN = /^[0-9a-fA-F]{64}$/;

function normalizePin(pin: string | null | undefined): string | null {
  if (pin === undefined || pin === null) return null;
  if (!PIN_PATTERN.test(pin)) {
    throw new NetError("bad-argument", "pinSha256 must be 64 hex characters (no colons)");
  }
  return pin.toLowerCase();
}

function toNativeOptions(options: HttpRequestOptions): NativeNetOptions {
  if (typeof options.url !== "string" || !options.url.startsWith("https://")) {
    throw new NetError("bad-argument", "options.url must be an https:// URL (TLS is mandatory)");
  }
  return {
    url: options.url,
    method: options.method ?? "GET",
    headers: options.headers ?? {},
    bodyText: options.bodyText ?? null,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pinSha256: normalizePin(options.pinSha256),
  };
}

/** Rejections from the native module arrive as Errors carrying `.code`
 * (the Expo CodedException bridge); fall back honestly if a code is absent. */
const KNOWN_ERROR_KINDS: readonly NetErrorKind[] = [
  "network",
  "tls",
  "http",
  "canceled",
  "bad-argument",
];

function toNetError(err: unknown): NetError {
  if (err instanceof NetError) return err;
  const e = err as { code?: unknown; message?: unknown; status?: unknown };
  const rawCode = typeof e?.code === "string" ? e.code : "unknown";
  const kind: NetErrorKind = KNOWN_ERROR_KINDS.includes(rawCode as NetErrorKind)
    ? (rawCode as NetErrorKind)
    : "unknown";
  const message = typeof e?.message === "string" && e.message !== "" ? e.message : "acute-net request failed";
  const status = typeof e?.status === "number" ? e.status : undefined;
  return new NetError(kind, message, status);
}

/** A pinned-TLS (or standard-CA) HTTP request. Rejects with NetError. */
export async function request(options: HttpRequestOptions): Promise<HttpResponse> {
  let nativeOptions: NativeNetOptions;
  try {
    nativeOptions = toNativeOptions(options);
  } catch (err) {
    throw toNetError(err);
  }
  try {
    return await Native.request(nativeOptions);
  } catch (err) {
    throw toNetError(err);
  }
}

// ── openSse — event multiplexing by eventId ─────────────────────────────────

interface SseRegistration {
  data: Set<SseDataListener>;
  error: Set<SseErrorListener>;
  close: Set<SseCloseListener>;
}

const streams = new Map<number, SseRegistration>();
let wired = false;

/** Subscribe once to the module's three events and fan out by eventId. */
function ensureEventWiring(): void {
  if (wired) return;
  wired = true;
  Native.addListener("data", (ev) => {
    const stream = streams.get(ev.eventId);
    if (stream === undefined) return;
    const frame: SseEvent = { event: ev.event, data: ev.data };
    for (const listener of stream.data) listener(frame);
  });
  Native.addListener("error", (ev) => {
    const stream = streams.get(ev.eventId);
    if (stream === undefined) return;
    const kind = toNetError({ code: ev.kind, message: ev.message }).kind;
    const failure: SseError = { kind, message: ev.message, status: ev.status };
    for (const listener of stream.error) listener(failure);
  });
  Native.addListener("close", (ev) => {
    const stream = streams.get(ev.eventId);
    if (stream === undefined) return;
    streams.delete(ev.eventId);
    for (const listener of stream.close) listener();
  });
}

/** The SSE options — the same bag as request(); method defaults to GET (the
 * turn stream is POST with a JSON bodyText). */
export interface SseOptions extends HttpRequestOptions {
  method?: string;
}

/**
 * Open a long-lived SSE request. The body is parsed server-side (data: lines,
 * blank-line frame split, event: field support) and every frame is delivered
 * through "data" listeners as it lands — no buffering, gzip transparent.
 * Reconnect logic is the caller's (src/link/connection.ts); close() cancels
 * cleanly (no "close" listener fires for a caller-initiated close).
 */
export function openSse(options: SseOptions): SseStream {
  ensureEventWiring();
  const nativeOptions = toNativeOptions(options);
  const eventId = Native.openSse(nativeOptions);
  const registration: SseRegistration = {
    data: new Set(),
    error: new Set(),
    close: new Set(),
  };
  streams.set(eventId, registration);
  let closed = false;
  const handle: SseStream = {
    eventId,
    addEventListener(type, listener) {
      if (closed) return handle;
      registration[type].add(listener as never);
      return handle;
    },
    close() {
      if (closed) return;
      closed = true;
      streams.delete(eventId);
      Native.closeSse(eventId);
    },
  };
  return handle;
}
