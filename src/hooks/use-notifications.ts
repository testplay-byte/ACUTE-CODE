/**
 * ROUND-40 (task 3-b frontend): the React Query + SSE subscription hook for
 * the notification system.
 *
 * Layering:
 *   - useNotificationStreamStore (zustand): ONE shared store holding the
 *     live-SSE-driven unread count + the latest-pushed notification record
 *     + a "lastSeq" ticker. Multiple components (Bell + Toaster) read from
 *     the SAME store → ONE SSE connection backs the whole UI.
 *   - useNotifications() (react-query): the consumer hook — list query +
 *     mark-read/mark-all-read mutations. Used by the Bell's dropdown.
 *   - <NotificationStreamStarter /> (AppShell-mounted once): opens the SSE
 *     stream on app boot with exponential-backoff auto-reconnect. Pushes
 *     hello + each new record into BOTH the store (for the live unread
 *     badge) AND the react-query cache (for the bell's list).
 *
 * Demo/fixture mode (useConfigStore.demoData===true, or baseUrl/token
 * empty): the starter never opens a stream. The Bell + Toaster render
 * nothing (the store's unread stays 0 + lastNotification stays null).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { useConfigStore } from "../lib/config-store";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationKind,
  type NotificationRecord,
} from "../lib/notifications-api";

/** The react-query cache key for the notifications list. */
export const NOTIFICATIONS_QUERY_KEY = ["notifications"] as const;

/**
 * Stream store — shared between the Bell (unread badge), the Toaster (new-
 * arrival ticker), and the dropdown (cached list). The SSE subscription in
 * <NotificationStreamStarter/> writes here; mutations in useNotifications()
 * ALSO write here (optimistic decrement on mark-read) so the badge updates
 * instantly without waiting for the next SSE frame.
 */
interface NotificationStreamState {
  /** Current unread count — drives the bell's badge. */
  unread: number;
  /** Bumps on each new live notification — the Toaster subscribes to this. */
  lastSeq: number;
  /** The most recent live notification record (the Toaster reads this on
   * each lastSeq change). */
  lastNotification: NotificationRecord | null;
  /** Connection status (for a future "live" indicator on the bell). */
  status: "idle" | "connecting" | "connected" | "reconnecting" | "demo";
  /** Set the authoritative unread count (hello frame or mutation result). */
  setUnread: (n: number) => void;
  /** Push a new live notification: bumps unread + the ticker. */
  pushNotification: (n: NotificationRecord) => void;
  /** ROUND-44 (R44-c): push a LOCAL (client-side) toast — bumps the ticker
   * + last record WITHOUT touching the unread badge (the message is
   * informational, not an unread notification row). */
  pushLocal: (n: NotificationRecord) => void;
  /** Decrement unread by 1 (used after mark-one-read optimistic update). */
  decrementUnread: () => void;
  /** Update the connection status (live indicator). */
  setStatus: (s: NotificationStreamState["status"]) => void;
  /** Reset everything (e.g. when switching out of demo mode). */
  reset: () => void;
}

export const useNotificationStreamStore = create<NotificationStreamState>(
  (set) => ({
    unread: 0,
    lastSeq: 0,
    lastNotification: null,
    status: "idle",
    setUnread: (unread) => set({ unread }),
    pushNotification: (n) =>
      set((s) => ({
        unread: s.unread + 1,
        lastSeq: s.lastSeq + 1,
        lastNotification: n,
      })),
    pushLocal: (n) =>
      set((s) => ({
        lastSeq: s.lastSeq + 1,
        lastNotification: n,
      })),
    decrementUnread: () =>
      set((s) => ({ unread: Math.max(0, s.unread - 1) })),
    setStatus: (status) => set({ status }),
    reset: () =>
      set({ unread: 0, lastSeq: 0, lastNotification: null, status: "idle" }),
  }),
);

/**
 * ROUND-44 (R44-c, owner directive: complete the agentic coding environment):
 * the app's toast surface. No standalone toast utility existed — the Toaster
 * (components/notifications/Toaster.tsx) renders whatever lands in the stream
 * store — so local (client-side) confirmations reuse EXACTLY that machinery:
 * a synthetic NotificationRecord pushed via `pushLocal` renders as a normal
 * bottom-right toast card (auto-dismiss 6s for the default `task_complete`
 * kind; persistent kinds like `task_failed` stay until dismissed) without
 * inflating the Bell's unread badge.
 *
 * ROUND-99 (R99-C): the optional `link` turns a local toast into an
 * ACTIONABLE one — the Toaster navigates there on click and keeps the
 * toast on screen until dismissed (a toast that needs a click must
 * outlive 1.5s; the R64-c auto-dismiss covers read-only pings).
 */
export function pushLocalToast(
  title: string,
  body?: string,
  kind: NotificationKind = "task_complete",
  link?: string,
): void {
  useNotificationStreamStore.getState().pushLocal({
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    kind,
    title,
    body: body ?? null,
    sessionId: null,
    projectId: null,
    read: 1,
    ...(link !== undefined ? { link } : {}),
  });
}

/**
 * useNotifications — the consumer hook for the bell's dropdown.
 *
 * Returns:
 *   - notifications: NotificationRecord[] (newest-first, from react-query).
 *   - unread: number (live-SSE-driven, from the stream store — updates
 *     without a refetch).
 *   - isLoading: boolean (initial list fetch).
 *   - markRead(id): mutation fn (invalidates + optimistic decrement).
 *   - markAllRead(): mutation fn (invalidates + sets unread to 0).
 *
 * The query is keyed by the data source ("demo"|"live") — exactly like
 * use-sessions.ts — so flipping demoData off (via useSidecarHealth) refetches
 * from the live sidecar. In demo mode the query is disabled (the sidecar
 * doesn't exist; the bell shows nothing).
 *
 * This hook does NOT open the SSE stream — that's <NotificationStreamStarter/>
 * mounted once in AppShell. Multiple components can call useNotifications()
 * without opening multiple streams (the store is the single source of truth).
 */
export function useNotifications() {
  const qc = useQueryClient();
  const source = useConfigStore((s) => (s.demoData ? "demo" : "live"));

  const query = useQuery({
    queryKey: [...NOTIFICATIONS_QUERY_KEY, source],
    queryFn: () => listNotifications({ limit: 50 }),
    enabled: source === "live",
    staleTime: 30_000,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: (data, id) => {
      // Optimistically mark the row read in the cache so the dropdown updates
      // without waiting for the next list refetch.
      qc.setQueryData<{ notifications: NotificationRecord[]; unread: number } | undefined>(
        [...NOTIFICATIONS_QUERY_KEY, source],
        (cur) => {
          if (!cur) return cur;
          return {
            notifications: cur.notifications.map((n) =>
              n.id === id ? { ...n, read: 1 as const } : n,
            ),
            unread: Math.max(0, cur.unread - 1),
          };
        },
      );
      // The server's authoritative unread count comes back with the response
      // — trust it (it may differ if a new notification arrived via SSE
      // between the request and the response).
      useNotificationStreamStore.getState().setUnread(data.unread);
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      qc.setQueryData<{ notifications: NotificationRecord[]; unread: number } | undefined>(
        [...NOTIFICATIONS_QUERY_KEY, source],
        (cur) => {
          if (!cur) return cur;
          return {
            notifications: cur.notifications.map((n) => ({
              ...n,
              read: 1 as const,
            })),
            unread: 0,
          };
        },
      );
      useNotificationStreamStore.getState().setUnread(0);
    },
  });

  return {
    notifications: query.data?.notifications ?? [],
    unread: query.data?.unread ?? 0,
    isLoading: query.isLoading,
    markRead: markReadMutation.mutate,
    markAllRead: markAllReadMutation.mutate,
    markReadPending: markReadMutation.isPending,
    markAllReadPending: markAllReadMutation.isPending,
  };
}
