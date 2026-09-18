/**
 * ROUND-106 (R106-S3, CLI-DESIGN §3): the Bearer fetch wrapper. Every route
 * call goes through `apiFetch`; the sidecar's `{error:{code,message,
 * details?}}` envelope becomes a typed ApiError (the honest code + message
 * the routes send — never a raw status string).
 */
import type { Connection } from "./connection.js";

/** The sidecar's error envelope, typed (routes/helpers.ts errorBody). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** `409 CONFLICT: no API key …` — the one-line terminal form. */
  describe(): string {
    return `${this.status} ${this.code}: ${this.message}`;
  }
}

/** Unreachable-sidecar wrap (the acute.mjs `unreachable` line, typed). */
export class UnreachableError extends Error {
  readonly baseUrl: string;
  readonly causeText: string;

  constructor(baseUrl: string, causeText: string) {
    super(`unreachable ${baseUrl} — ${causeText} (is the sidecar running?)`);
    this.name = "UnreachableError";
    this.baseUrl = baseUrl;
    this.causeText = causeText;
  }
}

function errCause(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) {
      const detail = (cause as { code?: unknown; message?: unknown }).code ?? (cause as { message?: unknown }).message;
      if (detail !== undefined && detail !== null) return String(detail);
    }
    return err.message;
  }
  return String(err);
}

/** Parse a response body into the error envelope (or a plain-text fallback).
 * Exported for the SSE reader's non-2xx path (stream.ts). */
export function parseErrorEnvelope(status: number, text: string): ApiError {
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the raw body */
  }
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const envelope = (json as { error?: unknown }).error;
    if (envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)) {
      const raw = envelope as { code?: unknown; message?: unknown; details?: unknown };
      const code = typeof raw.code === "string" ? raw.code : `HTTP_${status}`;
      const message = typeof raw.message === "string" ? raw.message : JSON.stringify(json);
      const details =
        raw.details !== null && typeof raw.details === "object" && !Array.isArray(raw.details)
          ? (raw.details as Record<string, unknown>)
          : undefined;
      return new ApiError(status, code, message, details);
    }
  }
  const fallback = typeof text === "string" && text !== "" ? text.slice(0, 200) : `(empty body, HTTP ${status})`;
  return new ApiError(status, `HTTP_${status}`, fallback);
}

/** One authenticated call. Non-2xx → ApiError; network death → UnreachableError. */
export async function apiFetch<T>(
  conn: Connection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${conn.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${conn.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new UnreachableError(conn.baseUrl, errCause(err));
  }
  const text = await res.text();
  if (!res.ok) {
    throw parseErrorEnvelope(res.status, text);
  }
  if (text === "") {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/** GET /health (NO auth — the one open route) with a hard timeout. */
export async function healthFetch(
  baseUrl: string,
  timeoutMs = 2_000,
): Promise<{ status: string; app: string; version: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { status?: unknown; app?: unknown; version?: unknown };
    if (json.status !== "ok" || json.app !== "acute-code") return null;
    return {
      status: "ok",
      app: "acute-code",
      version: typeof json.version === "string" ? json.version : "?",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
