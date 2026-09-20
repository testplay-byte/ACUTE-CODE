/**
 * api.ts — the features' typed request seam.
 *
 * The wire protocol (LINKING-PROTOCOL §3): the phone speaks the desktop's
 * EXISTING /api/v1 surface — same routes, same shapes, same error envelope
 * ({error: {code, message}} — agent-core routes/helpers.ts errorBody).
 * This module turns the manager's fetch-like api() into typed outcomes the
 * pure feature modules (approvals/sessions/outbox) can consume and the unit
 * tests can fake — ConnectionManager satisfies ApiSender structurally, so
 * nothing here imports React Native.
 *
 * Transport failures are NOT caught here: api() throws NetError only after
 * the manager has already transitioned the link offline, and the screens'
 * loaders own the "host offline" render. HTTP errors are VALUES (ApiOutcome).
 */

import type { ApiCallInit, ApiResult, SseStream } from "@/link/connection";

// ── the seams ───────────────────────────────────────────────────────────────

/** The minimal request surface the feature clients consume. */
export interface ApiSender {
  api(path: string, init?: ApiCallInit): Promise<ApiResult>;
}

/** The minimal stream surface (the live turn + the outbox flush). */
export interface SseSender {
  sse(path: string, init?: ApiCallInit): SseStream;
}

// ── the error envelope (agent-core errorBody, 1:1) ─────────────────────────

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

/** Every client call resolves to this — no throws for HTTP-level truth. */
export type ApiOutcome<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** The route prefix the whole sidecar speaks under. */
export const API_PREFIX = "/api/v1";

/** "approvals?status=pending" → "/api/v1/approvals?status=pending". */
export function apiPath(path: string): string {
  return `${API_PREFIX}${path}`;
}

/** Parse a non-2xx body's {error:{code,message}} envelope — honest fallback
 * for non-JSON or off-shape bodies (the status is always true). */
export function parseApiError(status: number, bodyText: string): ApiError {
  try {
    const raw: unknown = JSON.parse(bodyText);
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const err = (raw as Record<string, unknown>).error;
      if (typeof err === "object" && err !== null) {
        const { code, message } = err as Record<string, unknown>;
        if (typeof code === "string" && typeof message === "string") {
          return { status, code, message };
        }
      }
    }
  } catch {
    // fall through to the honest fallback
  }
  return {
    status,
    code: `HTTP_${status}`,
    message: bodyText.slice(0, 200) || `the host answered HTTP ${status}`,
  };
}

/** Parse a 2xx body as JSON; null when it is not valid JSON. */
export function parseJsonBody<T>(bodyText: string): T | null {
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    return null;
  }
}

/**
 * R114-f: the 204 twin — the routes that answer NO BODY (PUT
 * /providers/:id/key, DELETE /models/:id, DELETE /providers/:id all send
 * 204 with an empty payload). apiJson would read that empty string as
 * BAD_JSON; here an EMPTY 2xx body IS the success value ({ok:true,
 * data:null}). A non-empty body still parses honestly (never a fabricated
 * value), and HTTP errors stay values exactly like apiJson.
 */
export async function apiJsonNoBody(
  sender: ApiSender,
  path: string,
  init: ApiCallInit = {},
): Promise<ApiOutcome<null>> {
  const res = await sender.api(apiPath(path), init);
  if (!res.ok) {
    return { ok: false, error: parseApiError(res.status, res.bodyText) };
  }
  if (res.bodyText.trim() === "") {
    return { ok: true, data: null };
  }
  const data = parseJsonBody<unknown>(res.bodyText);
  if (data === null) {
    return {
      ok: false,
      error: {
        status: res.status,
        code: "BAD_JSON",
        message: "the host's response was not valid JSON",
      },
    };
  }
  // A JSON body on a no-content route is unexpected but not a failure —
  // the write itself succeeded.
  return { ok: true, data: null };
}

/**
 * The one client call every feature reuses: GET/POST + JSON in, typed
 * outcome out. HTTP errors → {ok:false,error}; a 2xx with a broken body →
 * {ok:false, BAD_JSON} (honest — never a fabricated value); transport
 * failures propagate (the manager owns the offline transition).
 */
export async function apiJson<T>(
  sender: ApiSender,
  path: string,
  init: ApiCallInit = {},
): Promise<ApiOutcome<T>> {
  const res = await sender.api(apiPath(path), init);
  if (!res.ok) {
    return { ok: false, error: parseApiError(res.status, res.bodyText) };
  }
  const data = parseJsonBody<T>(res.bodyText);
  if (data === null) {
    return {
      ok: false,
      error: {
        status: res.status,
        code: "BAD_JSON",
        message: "the host's response was not valid JSON",
      },
    };
  }
  return { ok: true, data };
}
