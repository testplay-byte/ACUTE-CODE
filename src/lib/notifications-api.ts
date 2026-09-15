/**
 * ROUND-40 (task 3-b frontend): client for the sidecar's notifications API.
 * Mirrors the request/stream patterns in src/lib/api.ts but is intentionally
 * self-contained — the notifications routes are a separate concern from the
 * project/session/agent backend, so a small local client avoids dragging in
 * the fixture adapter indirection.
 *
 * Contract (do NOT modify backend; agent-core storage/notifications.ts +
 * server.ts:1620-1686):
 *   GET    /api/v1/notifications?unread=1&limit=50 → { notifications, unread }
 *   POST   /api/v1/notifications/:id/read          → { ok, unread }
 *   POST   /api/v1/notifications/read-all           → { ok, cleared, unread: 0 }
 *   GET    /api/v1/notifications/stream             → SSE (text/event-stream)
 *
 * The stream's `data:` frames are EITHER a one-shot `{type:"hello",unread}`
 * greeting on connect OR a full NotificationRecord on each new publish. The
 * fetch + ReadableStream + TextDecoder + split-on-"\n\n" pattern is the
 * IDENTICAL pattern src/lib/api.ts:streamSessionMessage uses (line 1136-1190)
 * — EventSource can't set the Authorization header, so we use fetch-stream.
 */
import { useConfigStore } from "./config-store";

/** Notification kinds — must match agent-core storage/notifications.ts. */
export type NotificationKind =
  | "task_complete"
  | "task_failed"
  | "permission_request"
  | "subagent_queued"
  | "subagent_running"
  | "subagent_complete"
  | "subagent_failed";

/** Stored notification record (returned by every route).
 * R99-C: `link` is a CLIENT-ONLY field — server records never carry it;
 * local toasts (pushLocalToast) set it to make the toast ACTIONABLE (the
 * Toaster navigates there on click and keeps the toast until dismissed). */
export interface NotificationRecord {
  id: string;
  ts: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  sessionId: string | null;
  projectId: string | null;
  read: 0 | 1;
  /** R99-C: an in-app route a LOCAL toast navigates to on click
   * ("/settings?tab=about" for the update-available ping). Absent on
   * every server-published record. */
  link?: string | null;
}

/** GET /notifications response shape. */
interface ListResponse {
  notifications: NotificationRecord[];
  unread: number;
}

/** POST /notifications/:id/read response shape. */
interface MarkReadResponse {
  ok: boolean;
  unread: number;
}

/** POST /notifications/read-all response shape. */
interface MarkAllReadResponse {
  ok: boolean;
  cleared: number;
  unread: number;
}

/**
 * Minimal request helper — same shape as src/lib/api.ts:93-134. baseUrl +
 * bearer token come from useConfigStore. Throws Error on non-2xx (the
 * callers in use-notifications.ts handle retry/optimism — they don't need
 * the structured ApiError envelope).
 */
async function request<T>(
  path: string,
  init?: { method?: string; json?: unknown },
): Promise<T> {
  const { baseUrl, token } = useConfigStore.getState();
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch (cause) {
    throw new Error(
      `notifications request failed at ${baseUrl} (${String(cause)})`,
    );
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const envelope =
      body && typeof body === "object" && "error" in body
        ? ((body as { error?: { code?: string; message?: string } }).error)
        : undefined;
    throw new Error(
      envelope?.message ?? `notifications request failed with HTTP ${res.status}`,
    );
  }
  return body as T;
}

/**
 * GET /notifications — list newest-first.
 * - `unreadOnly=true` filters to unread only.
 * - `limit` (default 50, server caps at 200) bounds the page.
 */
export async function listNotifications(opts?: {
  unreadOnly?: boolean;
  limit?: number;
}): Promise<{ notifications: NotificationRecord[]; unread: number }> {
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set("unread", "1");
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<ListResponse>(`/notifications${qs ? `?${qs}` : ""}`);
}

/** POST /notifications/:id/read — mark one read; throws on 404. */
export async function markNotificationRead(
  id: string,
): Promise<{ ok: boolean; unread: number }> {
  return request<MarkReadResponse>(
    `/notifications/${encodeURIComponent(id)}/read`,
    { method: "POST" },
  );
}

/** POST /notifications/read-all — clear every unread. */
export async function markAllNotificationsRead(): Promise<{
  ok: boolean;
  cleared: number;
  unread: number;
}> {
  return request<MarkAllReadResponse>(`/notifications/read-all`, {
    method: "POST",
  });
}

/** SSE event — the initial hello (with the unread count) OR a full record. */
export type NotificationStreamEvent =
  | { type: "hello"; unread: number }
  | NotificationRecord;

/**
 * Live SSE subscription: GET /notifications/stream with the bearer token in
 * the Authorization header. The connection is held open until `signal`
 * aborts OR the server closes the stream. Frames are separated by `\n\n`;
 * each frame's payload is a single `data: {json}` line — the hello frame is
 * sent once on connect, then each published notification is pushed.
 *
 * Implementation: VERBATIM mirror of src/lib/api.ts:streamSessionMessage
 * (line 1136-1190) — getReader() + TextDecoder + `\n\n` split + `JSON.parse(
 * line.slice(6))`. Same loop, same try/skip malformed-frame guard. The
 * caller (use-notifications.ts:<NotificationStreamStarter/>) owns the
 * reconnect loop (exponential backoff: 1s → 2s → 4s → capped 15s).
 *
 * Throws on non-2xx (so the caller's reconnect loop fires) and on reader
 * errors. On a normal stream end (server closed), returns cleanly — the
 * caller still triggers a reconnect.
 */
export async function streamNotifications(
  onEvent: (event: NotificationStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = useConfigStore.getState();
  const res = await fetch(`${baseUrl}/api/v1/notifications/stream`, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  });
  if (!res.ok || !res.body) {
    // Non-2xx: surface as a thrown error so the caller's reconnect loop can
    // retry after backoff.
    throw new Error(`notifications stream failed with HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)) as NotificationStreamEvent);
          } catch {
            /* skip malformed frame */
          }
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
}
