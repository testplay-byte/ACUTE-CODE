/**
 * ROUND-98 (R98-J, owner: task complete / failed / permission needed →
 * "it will send me a notification on my PC") — the DESKTOP-NOTIFICATION
 * BRIDGE over tauri-plugin-notification.
 *
 * IPC surface (the EXACT commands this module invokes — no npm package,
 * the raw window.__TAURI__.core.invoke channel that withGlobalTauri
 * injects, same as src/lib/native-browser.ts):
 *
 *   · plugin:notification|notify  { options: { title, body } }
 *     (the Rust command's parameter is `options: NotificationData`;
 *     NotificationData is #[serde(rename_all="camelCase")] so its two
 *     fields ride as title/body inside the options wrapper)
 *   · plugin:notification|is_permission_granted  → boolean | null
 *     (null = not yet determined — the "default" state)
 *   · plugin:notification|request_permission     → PermissionState
 *     ("granted" / "denied" / "default" / "prompt")
 *
 * NOTE (the discovery that shaped this module): tauri-plugin-notification
 * >= 2.3 ALSO injects a window.Notification POLYFILL into every webview —
 * the Toaster's old web-API path would silently become a Tauri path and
 * DOUBLE-FIRE with this bridge. The Toaster's in-page Notification code
 * is therefore web-only now (isTauri() guard there); this module is the
 * ONE Tauri-side spelling.
 *
 * The three rules every notifyDesktop call follows:
 *   1. WEB MODE is a no-op (isTauri() from lib/sidecar — one source of
 *      truth for shell detection; the plain browser keeps using the
 *      Web-Notification path in Toaster.tsx).
 *   2. VISIBILITY: fires only when document.visibilityState !== "visible"
 *      — the Toaster's existing ROUND-42 rule, made uniform for all three
 *      kinds (a watching owner sees the in-app toast; a backgrounded one
 *      gets the OS notification; never both).
 *   3. THE SETTINGS GATE: an in-memory cached enabled flag (default ON —
 *      the pre-R98 behavior shipped notifications enabled). The settings
 *      card (SettingsPage's DesktopNotificationsCard) pushes every
 *      confirmed flip here LIVE via setDesktopNotificationsEnabled, so a
 *      flip applies to the very next record without a restart.
 *
 * Permission: is_permission_granted is checked per fire; a null answer
 * triggers request_permission exactly ONCE (the first time a notification
 * is actually needed — never a cold-start prompt). "denied" skips
 * silently; every path swallows its errors — the SSE stream must never
 * die because an OS notification failed.
 */
import { isTauri } from "./sidecar";

/** The three kinds that graduate from in-app toast to the owner's PC.
 * subagent_* transitions stay in-app ONLY (chatter, not decisions). */
export type DesktopNotificationKind = "task_complete" | "task_failed" | "permission_request";

export interface DesktopNotificationInput {
  title: string;
  body?: string;
  kind: DesktopNotificationKind;
}

type TauriInvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** `__TAURI__.core.invoke` — null outside the desktop shell. */
function tauriInvoke(): TauriInvokeFn | null {
  if (!isTauri()) return null;
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: TauriInvokeFn } } })
    .__TAURI__;
  if (tauri === undefined || typeof tauri?.core?.invoke !== "function") return null;
  return tauri.core.invoke;
}

/** The settings gate's in-memory cache (default ON). */
let enabled = true;

/** The one-shot request_permission guard — asked once, ever. */
let permissionRequested = false;

/** The LIVE settings push (the settings card calls this on every confirmed
 * flip + every fresh GET — see DesktopNotificationsCard). */
export function setDesktopNotificationsEnabled(value: boolean): void {
  enabled = value;
}

/** Read-side of the gate (tests + diagnostics). */
export function isDesktopNotificationsEnabled(): boolean {
  return enabled;
}

/** True when the OS-level permission is granted; requests it once if the
 * state is still undetermined. Never throws. */
async function permissionGranted(): Promise<boolean> {
  const invoke = tauriInvoke();
  if (invoke === null) return false;
  try {
    const granted = (await invoke("plugin:notification|is_permission_granted")) as
      | boolean
      | null;
    if (granted === true) return true;
    if (granted === false) return false; // denied — skip silently
    // null = not yet determined → request ONCE, when first needed.
    if (permissionRequested) return false;
    permissionRequested = true;
    const state = (await invoke("plugin:notification|request_permission")) as string;
    return state === "granted";
  } catch {
    return false; // plugin missing / IPC failed — never propagate
  }
}

/**
 * Fire one desktop notification (the three rules in the module docblock:
 * settings gate → web no-op → visibility rule → permission). Always
 * resolves — the SSE fan-out must never await-and-die on this.
 */
export async function notifyDesktop(input: DesktopNotificationInput): Promise<void> {
  if (!enabled) return; // the settings gate
  const invoke = tauriInvoke();
  if (invoke === null) return; // web mode — the Toaster owns that path
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  if (!(await permissionGranted())) return;
  try {
    await invoke("plugin:notification|notify", {
      options: { title: input.title, body: input.body ?? "" },
    });
  } catch {
    // The OS refused (quiet hours, plugin hiccup) — the in-app toast still
    // rendered; swallow.
  }
}

/**
 * App-start init (AppShell mounts this once): a best-effort permission
 * PRE-CHECK — warms the plugin's answer so the first real notification
 * isn't the first IPC round-trip. Deliberately does NOT request (a
 * cold-start permission prompt with nothing to show for it is noise);
 * the request happens once, when a notification is first needed.
 */
export function initDesktopNotifications(): void {
  const invoke = tauriInvoke();
  if (invoke === null) return;
  void invoke("plugin:notification|is_permission_granted").catch(() => undefined);
}
