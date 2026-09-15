/**
 * ROUND-99 (R99-C, owner: "I click the update button in the application and
 * everything else happens automatically afterwards by itself without me
 * having to make any changes") — the STARTUP AUTO-CHECK + the app-wide
 * "an update is pending" signal.
 *
 * Two halves:
 *
 *  1. `initUpdateChecker()` — AppShell calls it once beside
 *     initDesktopNotifications/hydrateLinkOpeningMode. After a short
 *     post-boot delay (never blocking first paint), once the sidecar is
 *     reachable and NOT demo mode, and only when the persisted last-check
 *     timestamp is older than CHECK_INTERVAL_MS (24h), it runs the SAME
 *     server-side check the About tab's button uses (fetchSystemUpdates).
 *     On `updateAvailable`: (a) set the persisted pendingVersion the
 *     Sidebar's Settings dot + the About tab read, (b) fire ONE local
 *     toast ("ACUTE-CODE vX is available — review in Settings → About",
 *     clickable → /settings?tab=about), (c) advance the cadence stamp.
 *     FAILED checks are silent + honest: console.warn, never a toast, and
 *     the cadence stamp does NOT advance (a boot-time network hiccup is
 *     not news, and the next boot retries).
 *
 *  2. `useUpdateCheckerStore` — the persisted cross-cutting state
 *     (localStorage `acute-code.updates`, the theme-store persistence
 *     pattern): the autoCheck toggle (default ON), the lastCheckTs
 *     cadence stamp, and the pendingVersion flag. The Sidebar subscribes
 *     exactly the way it reads other cross-cutting stores
 *     (useProjectChatStore's appSidebarVisible).
 *
 * Self-healing on every boot: a pendingVersion that is no longer newer
 * than APP_VERSION is cleared — the update landed (the silent flow's
 * /R relaunch, ACUTE.bat, or a manual install), so the dot must never
 * outlive the release it announced.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fetchSystemUpdates, type SystemUpdateCheck } from "./api";
import { useConfigStore } from "./config-store";
// R99-C: the ONE local-toast surface (the R44-c idiom) — the clickable
// "review in Settings → About" leg rides the link param added this round.
import { pushLocalToast } from "../hooks/use-notifications";
import { APP_VERSION } from "./version";

/** The auto-check cadence: one silent check per 24h per machine. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** The post-boot delay before the FIRST readiness probe — the check must
 * never contend with first paint or the sidecar handshake. */
export const BOOT_DELAY_MS = 8_000;

/** Readiness retries after the first probe (the Tauri connect loop can
 * still be mid-handshake at 8s on a slow disk): each entry is the delay
 * before the NEXT probe. Exhausted → give up silently for this boot. */
export const SIDECAR_WAIT_RETRY_DELAYS_MS: readonly number[] = [10_000, 10_000, 10_000];

interface UpdateCheckerState {
  /** The auto-check toggle (Settings → About, default ON). */
  autoCheck: boolean;
  /** When the last COMPLETED (ok:true) check ran — the cadence stamp. */
  lastCheckTs: number;
  /** The pending update's version — the Sidebar's Settings dot + the
   * About tab's highlight read this; null = no pending update. */
  pendingVersion: string | null;
  setAutoCheck: (value: boolean) => void;
  setPendingVersion: (version: string | null) => void;
  markChecked: (ts: number) => void;
}

export const useUpdateCheckerStore = create<UpdateCheckerState>()(
  persist(
    (set) => ({
      autoCheck: true,
      lastCheckTs: 0,
      pendingVersion: null,
      setAutoCheck: (autoCheck) => set({ autoCheck }),
      setPendingVersion: (pendingVersion) => set({ pendingVersion }),
      markChecked: (lastCheckTs) => set({ lastCheckTs }),
    }),
    // The theme-store persistence pattern: one namespaced localStorage key
    // (the About tab's reset sweep lists it in LOCAL_STORAGE_KEYS — after
    // "Reset everything" the auto-check returns to its fresh-install ON).
    { name: "acute-code.updates", version: 1 },
  ),
);

/** "0.96.0" vs "0.97.0" per-segment — the same tolerant tuple walk the
 * sidecar's /system/updates runs (leading v tolerated, short forms too). */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isNaN(part) ? 0 : part));
  const a = parse(candidate);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

/** One place, two callers: the scheduled check AND the About tab's manual
 * "Check for updates" both sync the badge from the same answer — an
 * available release sets the pending flag, an up-to-date answer clears it
 * (the manual button "refreshes the badge state" by construction). */
export function syncPendingVersionFromResult(result: SystemUpdateCheck): void {
  if (!result.ok) return;
  const store = useUpdateCheckerStore.getState();
  if (result.updateAvailable === true && typeof result.latest === "string" && result.latest !== "") {
    if (store.pendingVersion !== result.latest) store.setPendingVersion(result.latest);
  } else if (store.pendingVersion !== null) {
    store.setPendingVersion(null);
  }
}

/** True when the sidecar is reachable and the app is NOT in demo mode —
 * the same readiness shape NotificationStreamStarter gates on. Read via
 * getState() so the probe loop never needs a React context. */
function sidecarReady(): boolean {
  const { demoData, token, connection } = useConfigStore.getState();
  return !demoData && token !== null && token !== "" && connection === "connected";
}

/** The scheduled check itself (exported for the update-checker's own tests
 * + diagnostics). Never throws — a failed check is a console.warn, and the
 * cadence stamp only advances on a COMPLETED (ok:true) answer so the next
 * boot retries honestly. */
export async function runScheduledUpdateCheck(): Promise<void> {
  const { autoCheck, lastCheckTs } = useUpdateCheckerStore.getState();
  if (!autoCheck) return;
  if (Date.now() - lastCheckTs < CHECK_INTERVAL_MS) return;
  try {
    const result = await fetchSystemUpdates();
    if (!result.ok) {
      console.warn(
        "[update-checker] the scheduled update check failed:",
        result.error ?? result.reason ?? "unknown reason",
      );
      return;
    }
    useUpdateCheckerStore.getState().markChecked(Date.now());
    syncPendingVersionFromResult(result);
    if (result.updateAvailable === true && result.latest) {
      // ONE toast, clickable (the link keeps it on screen until dismissed —
      // the Toaster's actionable-toast rule this round documents); the
      // durable signal is the Sidebar dot + the About card, not the toast.
      pushLocalToast(
        `ACUTE-CODE v${result.latest} is available`,
        "Review and install it in Settings → About.",
        "task_complete",
        "/settings?tab=about",
      );
    }
  } catch (err) {
    console.warn("[update-checker] the scheduled update check failed:", err);
  }
}

/** App-start init (AppShell mounts this once). Self-heals a stale pending
 * flag FIRST (the update landed through any path — the flag must not
 * outlive its release), then schedules the cadence-gated check without
 * ever blocking first paint. */
export function initUpdateChecker(): void {
  const { pendingVersion } = useUpdateCheckerStore.getState();
  if (pendingVersion !== null && !isNewerVersion(pendingVersion, APP_VERSION)) {
    useUpdateCheckerStore.getState().setPendingVersion(null);
  }
  const probe = (attempt: number) => {
    if (sidecarReady()) {
      void runScheduledUpdateCheck();
      return;
    }
    const nextDelay = SIDECAR_WAIT_RETRY_DELAYS_MS[attempt];
    if (nextDelay === undefined) {
      // Silent + honest: a demo-mode/dev session or a sidecar that never
      // came up this boot is not news (the manual button still works).
      console.warn("[update-checker] the sidecar never became reachable — skipping this boot's check");
      return;
    }
    setTimeout(() => probe(attempt + 1), nextDelay);
  };
  setTimeout(() => probe(0), BOOT_DELAY_MS);
}
