/**
 * appearance-sync.ts — the appearance domain's server pair + the live-sync
 * leg (R113-e: "If I am on a specific settings page and I change the
 * settings from my Android device, then the settings do not appear to be
 * changing in live view [on the PC and vice versa]" — the phone's half).
 *
 * The server is the source of truth for appearance (R113-a's domain):
 *   GET /api/v1/settings/appearance → {themeId: one of the six ids | null,
 *       mode: system|light|dark} — null themeId = "no server preference",
 *       each client falls back to its LOCAL default
 *   PUT /api/v1/settings/appearance {themeId?, mode?} — a partial patch;
 *       every PUT broadcasts {"type":"settings","domain":"appearance"} on
 *       the events bus so the change lands live on every other device
 *       (INCLUDING the phone that made it — hence the echo guard below).
 *
 * THE ECHO GUARD (the desktop theme-store's exact semantics, ported): while
 * a server-pushed/hydrated value is being applied through the theme setters,
 * the write-through PUT is suppressed — otherwise applying {"themeId":
 * "bento"} off the events stream would PUT {"themeId":"bento"} right back,
 * the sidecar would broadcast another settings frame, and every device
 * would loop forever.
 *
 * SPLIT (deliberate, mirroring events-stream.ts's shape):
 *   · fetchAppearance / putAppearance — the typed wire pair (injectable
 *     sender; no React Native).
 *   · applyServerAppearanceValue()    — PURE-ish: shape-check + the echo
 *     guard around an injected control (the theme provider's setters).
 *   · pushAppearancePatch()           — the guarded write-through (the local
 *     flip already applied optimistically; the PUT is fire-and-forget and a
 *     failure is silent — the local value stays, the next successful PUT
 *     re-converges the devices).
 *   · startAppearanceSync()           — the live leg: hydrate on (re)connect
 *     AND on every hello (the resync — "server wins when reachable"),
 *     apply settings/appearance frames as they land. The theme provider
 *     mounts this once; tests drive it with fake manager/events.
 *
 * The theme module itself (src/design/theme.tsx) owns the appearance VALUE
 * + parseAppearanceValue + the context. This module imports ONLY that
 * parser eagerly (theme's require of THIS module is always lazy, so the
 * dependency arrow is one-directional at load time — no eval cycle); the
 * theme setters reach back for pushAppearancePatch/
 * applyServerAppearanceValue through a lazy require.
 */

import { apiJson, type ApiOutcome, type ApiSender } from "./api";
// The theme module owns the appearance VALUE + its parser; this module never
// imports it at eval-danger (theme's require of THIS module is lazy, so the
// arrow is one-directional at load time: appearance-sync → design/theme).
import { parseAppearanceValue, type AppearanceValue } from "@/design/theme";
import type { EventsFrame } from "./events";

// ── the wire pair ───────────────────────────────────────────────────────────

/** GET /settings/appearance (the domain's stored value or the default). */
export async function fetchAppearance(sender: ApiSender): Promise<ApiOutcome<AppearanceValue>> {
  return apiJson<AppearanceValue>(sender, "/settings/appearance");
}

/**
 * PUT /settings/appearance — a partial patch ({themeId?, mode?}; themeId may
 * be null to CLEAR the server preference). Returns the updated value; the
 * route validates and 400s naming the field.
 */
export async function putAppearance(
  sender: ApiSender,
  patch: { themeId?: string | null; mode?: AppearanceValue["mode"] },
): Promise<ApiOutcome<AppearanceValue>> {
  return apiJson<AppearanceValue>(sender, "/settings/appearance", {
    method: "PUT",
    bodyText: JSON.stringify(patch),
  });
}

// ── the echo guard + the two apply paths ────────────────────────────────────

/** True while a server value is being applied through the control — the
 * write-through in pushAppearancePatch checks this and skips the PUT. */
let applyingRemoteAppearance = false;

/** Test seam: clear the echo guard between cases. */
export function resetAppearanceSyncForTest(): void {
  applyingRemoteAppearance = false;
}

/** Test seam: read the guard (the "remote apply doesn't echo" pin). */
export function isApplyingRemoteAppearance(): boolean {
  return applyingRemoteAppearance;
}

/** The theme control the provider injects (its own setTheme/setMode). */
export interface AppearanceControl {
  setTheme(themeId: string): void;
  setMode(mode: AppearanceValue["mode"]): void;
}

/**
 * Apply a SERVER-pushed appearance value (the boot hydration AND the
 * events-stream settings frame both land here — one path, one echo guard).
 * Shape-checked via parseAppearanceValue (in design/theme.tsx — never a
 * guess); returns whether a valid value applied. themeId === null means
 * "no server preference" — the local flavor stands (the R113-a GET default),
 * so only the mode applies in that case.
 */
export function applyServerAppearanceValue(
  value: unknown,
  control: AppearanceControl,
): boolean {
  const parsed = parseAppearanceValue(value);
  if (parsed === null) return false;
  applyingRemoteAppearance = true;
  try {
    if (parsed.themeId !== null) control.setTheme(parsed.themeId);
    control.setMode(parsed.mode);
  } finally {
    applyingRemoteAppearance = false;
  }
  return true;
}

/** The push target: an ApiSender that also knows its connection status
 * (the link manager satisfies this structurally). */
export interface AppearancePushTarget extends ApiSender {
  getStatus(): string;
  subscribe(listener: () => void): () => void;
}

/**
 * Push one local appearance change to the server (the optimistic
 * write-through behind the theme provider's setters). STRICTLY optional:
 * the local flip already applied (the click is the UX source; the server is
 * the sync backbone). Skipped while applying a remote value (the echo
 * guard) and while not connected (the local value stands as the offline
 * fallback — the next successful PUT re-converges). A failed PUT is a
 * silent no-op.
 */
export function pushAppearancePatch(
  target: AppearancePushTarget,
  patch: { themeId?: string | null; mode?: AppearanceValue["mode"] },
): void {
  if (applyingRemoteAppearance) return; // echo guard — see the doc above
  if (target.getStatus() !== "connected") return;
  void putAppearance(target, patch).catch(() => {
    // transport loss — silent; the local value stays the offline fallback
  });
}

// ── the live leg ────────────────────────────────────────────────────────────

/** The environment startAppearanceSync drives (fakes in the tests). */
export interface AppearanceSyncEnv {
  manager: AppearancePushTarget;
  events: { subscribeFrames(listener: (frame: EventsFrame) => void): () => void };
}

/**
 * Start the live sync (the theme provider mounts this once, for the app's
 * lifetime — the returned unsubscribe exists for correctness/tests):
 *
 *   · on (re)connect  → hydrate: GET the server's appearance and apply it
 *     (the server wins when reachable — the spec's sync semantic);
 *   · on hello        → hydrate again (the resync — the phone may have
 *     missed changes while its events stream was down; a double GET right
 *     after a connect is the honest price, idempotent by construction);
 *   · on settings/appearance frames → apply live (the echo guard inside
 *     applyServerAppearanceValue stops the PUT-back loop).
 *
 * A transport failure anywhere is silent — the locally persisted value is
 * the offline fallback and the next successful round re-converges.
 */
export function startAppearanceSync(
  apply: (value: unknown) => boolean,
  env: AppearanceSyncEnv,
): () => void {
  const hydrate = (): void => {
    void fetchAppearance(env.manager)
      .then((outcome) => {
        if (outcome.ok) apply(outcome.data);
      })
      .catch(() => {
        // transport — silent; the local persisted value stands
      });
  };
  let lastStatus = env.manager.getStatus();
  if (lastStatus === "connected") hydrate();
  const unsubManager = env.manager.subscribe(() => {
    const next = env.manager.getStatus();
    if (next === "connected" && lastStatus !== "connected") hydrate();
    lastStatus = next;
  });
  const unsubFrames = env.events.subscribeFrames((frame) => {
    if (frame.type === "hello") {
      hydrate();
      return;
    }
    if (frame.type === "settings" && frame.domain === "appearance") {
      apply(frame.value);
    }
  });
  return () => {
    unsubManager();
    unsubFrames();
  };
}
