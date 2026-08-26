/*
 * ACUTE-CODE service worker (ROUND-42).
 *
 * WHY THIS EXISTS (owner: "I sent another message and this time I closed the
 * window so it should send me a notification after it has completed the
 * task"): a closed browser window cannot run page JavaScript, so the R41
 * in-page `new Notification(...)` can never fire once the tab is gone. This
 * service worker + the Push API is the ONLY standards-based way to deliver a
 * desktop notification from a web app to a closed window: the sidecar sends
 * the message through the browser's push service (authenticated with our
 * VAPID keypair), the browser wakes THIS worker even with zero tabs open,
 * and it shows the OS notification. Clicking it opens (or focuses) the app
 * at the notification's session.
 *
 * Payload shape — mirrors agent-core/src/lib/web-push.ts PushPayload:
 *   { id, title, body, kind, sessionId, projectId, ts }
 *
 * Dedup: `tag` = the notification id. When the app IS open the page may also
 * fire an in-page Notification with the same tag — the browser REPLACES
 * (never stacks) same-tag notifications, so the user sees exactly one.
 *
 * Served from /sw.js (Vite copies the public/ dir to the root; localhost is
 * a secure context so SW + push work in dev).
 */

const APP_URL = new URL("/", self.registration.scope).toString();

self.addEventListener("install", () => {
  // Activate immediately — no waiting tabs needed for a first install.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** The icon: the Acute mark (accent tile + white A), rendered as a data URL. */
const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#FF6B2C"/><path d="M22 45 L32 21 L42 45" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M26.5 37 H37.5" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round" fill="none"/></svg>',
  );

/** Badge tint per kind (status tones, theme-independent). */
function toneForKind(kind) {
  switch (kind) {
    case "task_complete":
    case "subagent_complete":
      return "#10B981";
    case "task_failed":
    case "subagent_failed":
      return "#EF4444";
    case "permission_request":
      return "#F59E0B";
    default:
      return "#FF6B2C";
  }
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (payload === null || typeof payload !== "object") return;
  const n = payload;

  event.waitUntil(
    (async () => {
      // If a window client is VISIBLE, the in-page path already owns the
      // surface (in-app toast, fired over SSE) — showing an OS notification
      // too would be double-spam for someone looking at the screen.
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const visible = clientList.some((c) => c.visibilityState === "visible");
      if (visible) return;

      await self.registration.showNotification(n.title || "Acute", {
        body: typeof n.body === "string" ? n.body : "",
        tag: n.id,
        icon: ICON,
        badge: ICON,
        // Windows toasts ignore these color hints, but they help on
        // platforms that honor them.
        color: toneForKind(n.kind),
        data: {
          sessionId: n.sessionId ?? null,
          projectId: n.projectId ?? null,
        },
        requireInteraction: n.kind === "permission_request",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target =
    data.projectId && data.sessionId
      ? `${APP_URL}project/${encodeURIComponent(data.projectId)}/chat?session=${encodeURIComponent(data.sessionId)}`
      : APP_URL;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an existing app window if one is open (any URL) — then navigate
      // it to the notification's session; otherwise open a new one.
      for (const client of clientList) {
        if (new URL(client.url).origin === new URL(APP_URL).origin) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(target);
            } catch {
              /* navigate() can throw for uncontrolled clients — focus alone is fine */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
