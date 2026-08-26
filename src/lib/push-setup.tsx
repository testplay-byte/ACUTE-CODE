/**
 * ROUND-42: Web Push client setup (owner: "I closed the window so it should
 * send me a notification after it has completed the task").
 *
 * <PushSetup /> (mounted once in AppShell) does three things on app boot:
 *   1. Registers /sw.js — the service worker that receives pushes while the
 *      window is CLOSED and shows the OS notification.
 *   2. Asks for the Notification permission ONCE (the browser prompt). If
 *      denied, we stay silent — in-app toasts keep working regardless.
 *   3. Subscribes the browser to our push service with the sidecar's VAPID
 *      public key and POSTs the subscription to the sidecar. Re-runs
 *      whenever the permission flips to "granted" (the user may allow later
 *      from the browser's site-settings), and re-subscribes if the browser
 *      rotated the subscription's keys (subscriptionchange is not reliably
 *      implemented, so we simply upsert on every boot).
 *
 * Demo mode (no sidecar): everything no-ops.
 */
import { useEffect } from "react";
import { useConfigStore } from "./config-store";

/** URL-safe base64 → Uint8Array (for PushManager's applicationServerKey). */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function fetchVapidPublicKey(): Promise<string | null> {
  const { baseUrl, token } = useConfigStore.getState();
  try {
    const res = await fetch(`${baseUrl}/api/v1/notifications/push/key`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { publicKey?: unknown };
    return typeof body.publicKey === "string" && body.publicKey !== ""
      ? body.publicKey
      : null;
  } catch {
    return null;
  }
}

async function postSubscription(subscription: PushSubscription): Promise<void> {
  const { baseUrl, token } = useConfigStore.getState();
  const json = subscription.toJSON();
  await fetch(`${baseUrl}/api/v1/notifications/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
    }),
  });
}

/** Ensure a subscription exists for THIS VAPID key + is known to the sidecar. */
async function ensureSubscription(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<void> {
  const existing = await registration.pushManager.getSubscription();
  if (existing !== null) {
    // Re-POST on every boot — upserts if the browser rotated the keys.
    await postSubscription(existing);
    return;
  }
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  await postSubscription(subscription);
}

let attemptedSubscribe = false;

/** Shared subscribe routine (boot + permission-granted + visibility paths). */
async function trySubscribe(): Promise<void> {
  if (attemptedSubscribe) return;
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const { baseUrl, token } = useConfigStore.getState();
    if (!baseUrl || !token) return; // demo mode — no sidecar
    const registration = await navigator.serviceWorker.register("/sw.js");
    const vapidPublicKey = await fetchVapidPublicKey();
    if (vapidPublicKey === null) return;
    attemptedSubscribe = true;
    await ensureSubscription(registration, vapidPublicKey);
  } catch {
    // Best-effort — the app works fully without push.
  }
}

/**
 * Mounted once by AppShell. Inert in demo mode / non-secure contexts /
 * browsers without push support (Safari's PushManager needs the app to be
 * installed — it simply no-ops there).
 */
export function PushSetup(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (!("PushManager" in window)) return;
    if (!window.isSecureContext) return;

    let cancelled = false;

    // 1) Register the service worker immediately (no permission needed).
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);

    // 2) Ask for the Notification permission. Chrome/Edge show the prompt on
    //    page load for localhost, but SOME builds suppress prompts without a
    //    recent user gesture — so we also retry on the FIRST user interaction.
    const requestPermissionNow = (): void => {
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "default") {
        // Already decided — grant path subscribes below; denial stays silent.
        if (Notification.permission === "granted") void trySubscribe();
        return;
      }
      void Notification.requestPermission().then((permission) => {
        if (!cancelled && permission === "granted") void trySubscribe();
      });
    };
    requestPermissionNow();

    const onFirstGesture = (): void => {
      requestPermissionNow();
    };
    window.addEventListener("pointerdown", onFirstGesture, { once: false });
    window.addEventListener("keydown", onFirstGesture, { once: false });

    // 3) Direct boot attempt (covers the already-granted case).
    void trySubscribe();

    // 4) When the tab becomes visible again (e.g. the user clicked a push
    //    notification), re-check the subscription — the key may have rotated
    //    or the permission changed while away.
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      void trySubscribe();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", onFirstGesture);
      window.removeEventListener("keydown", onFirstGesture);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
