/**
 * appearance-sync.ts — the appearance domain's server pair + the live-sync
 * leg (R113-e: "If I am on a specific settings page and I change the
 * settings from my Android device, then the settings do not appear to be
 * changing in live view [on the PC and vice versa]" — the phone's half;
 * R114-c: extended to the domain's FULL five-field shape — chatDensity /
 * chatTextSize / timestampsMode / toolActivity ride every GET, partial PUT,
 * and live frame alongside themeId+mode).
 *
 * The server is the source of truth for appearance (R113-a's domain;
 * R114-b's four chat fields):
 *   GET /api/v1/settings/appearance → {themeId: one of the six ids | null,
 *       mode: system|light|dark, chatDensity: comfortable|compact,
 *       chatTextSize: small|medium|large, timestampsMode: hidden|hover,
 *       toolActivity: detailed|compact|hidden} — null themeId = "no server
 *       preference", each client falls back to its LOCAL flavor; a missing
 *       chat field parses as its server default
 *   PUT /api/v1/settings/appearance {any subset of the five} — a partial
 *       patch; every PUT broadcasts {"type":"settings","domain":
 *       "appearance"} on the events bus so the change lands live on every
 *       other device (INCLUDING the phone that made it — hence the echo
 *       guard below).
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
 *     flip already applied optimistically; the PUT is fire-and-forget — and
 *     R128-W6: a PUT that cannot land is recorded PENDING, not lost — see
 *     the pending-patch machinery below).
 *   · startAppearanceSync()           — the live leg: hydrate on (re)connect
 *     AND on every hello (the resync — "server wins when reachable"), apply
 *     settings/appearance frames as they land. The theme provider
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
import { mobLog, mobWarn } from "@/lib/log";
// The theme module owns the appearance VALUE + its parser; this module never
// imports it at eval-danger (theme's require of THIS module is lazy, so the
// arrow is one-directional at load time: appearance-sync → design/theme).
import {
  parseAppearanceValue,
  type AppearanceValue,
  type ChatDensity,
  type ChatTextSize,
  type TimestampsMode,
  type ToolActivity,
} from "@/design/theme";
import type { EventsFrame } from "./events";

// ── the wire pair ───────────────────────────────────────────────────────────

/** GET /settings/appearance (the domain's stored value or the default). */
export async function fetchAppearance(sender: ApiSender): Promise<ApiOutcome<AppearanceValue>> {
  return apiJson<AppearanceValue>(sender, "/settings/appearance");
}

/**
 * The PATCH SHAPE — any subset of the domain's five fields (R114-c: the
 * four chat prefs join themeId/mode; every key is optional — the server's
 * partial-PUT semantics, one field per control flip). themeId may be null
 * to CLEAR the server preference.
 */
export type AppearancePatch = {
  themeId?: string | null;
  mode?: AppearanceValue["mode"];
  chatDensity?: ChatDensity;
  chatTextSize?: ChatTextSize;
  timestampsMode?: TimestampsMode;
  toolActivity?: ToolActivity;
};

/**
 * PUT /settings/appearance — a partial patch (see AppearancePatch); returns
 * the updated value; the route validates and 400s naming the field.
 */
export async function putAppearance(
  sender: ApiSender,
  patch: AppearancePatch,
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

/** Test seam: clear the echo guard + the pending-patch machinery between cases. */
export function resetAppearanceSyncForTest(): void {
  applyingRemoteAppearance = false;
  pendingAppearancePatch = null;
  pendingFlushAttempts = 0;
  appearanceSyncError = null;
  for (const listener of appearanceSyncListeners) listener();
  appearanceSyncListeners.clear();
}

/** Test seam: read the guard (the "remote apply doesn't echo" pin). */
export function isApplyingRemoteAppearance(): boolean {
  return applyingRemoteAppearance;
}

/** The theme control the provider injects (its own setters — all six of
 * the domain's fields as of R114-c). */
export interface AppearanceControl {
  setTheme(themeId: string): void;
  setMode(mode: AppearanceValue["mode"]): void;
  setChatDensity(density: ChatDensity): void;
  setChatTextSize(size: ChatTextSize): void;
  setTimestampsMode(mode: TimestampsMode): void;
  setToolActivity(activity: ToolActivity): void;
}

/**
 * Apply a SERVER-pushed appearance value (the boot hydration AND the
 * events-stream settings frame both land here — one path, one echo guard).
 * Shape-checked via parseAppearanceValue (in design/theme.tsx — never a
 * guess); returns whether a valid value applied. themeId === null means
 * "no server preference" — the local flavor stands (the R113-a GET default),
 * so only the mode + the four chat prefs apply in that case. A chat pref
 * missing from the wire already parsed as its server default, so all five
 * present keys ride through.
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
    control.setChatDensity(parsed.chatDensity);
    control.setChatTextSize(parsed.chatTextSize);
    control.setTimestampsMode(parsed.timestampsMode);
    control.setToolActivity(parsed.toolActivity);
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

// ── R128-W6 — the pending-patch machinery (no silent hello-revert) ──────────
//
// The round's smoking gun's second half: the OLD write-through dropped a PUT
// that could not go out (offline) or failed (transport/HTTP) — "the local
// value stands, the next successful PUT re-converges". But the next thing to
// happen after a relay blip is a RECONNECT: the hello hydrates the SERVER's
// value back over the local fix, so a flip made while disconnected was
// silently reverted ("hidden" came back every time). The cure: a patch that
// cannot land is recorded PENDING, and every connect/hello boundary FLUSHES
// it BEFORE the server→local apply — the pending flush WINS over the server
// apply, so the hydrate then reads the server ECHOING our own fix. Bounded at
// PENDING_FLUSH_MAX_ATTEMPTS failed flushes: the patch is dropped (the local
// change is honestly lost), an error state surfaces (appearanceSyncStatus +
// the Appearance settings screen's inline row + the [ACUTE-MOB] logcat
// trail), and the hydration proceeds — converge with the story told.

/** The flush bound — after this many FAILED flush attempts the patch gives up. */
export const PENDING_FLUSH_MAX_ATTEMPTS = 3;

let pendingAppearancePatch: AppearancePatch | null = null;
let pendingFlushAttempts = 0;
let appearanceSyncError: string | null = null;
const appearanceSyncListeners = new Set<() => void>();

/** The surfaced sync state (the Appearance settings screen's inline error row
 * + the tests' observable seam; purely informational — no data integrity
 * rides it, the values below are the sync story, never the pref values). */
export interface AppearanceSyncStatus {
  /** The un-acknowledged patch awaiting its flush (null when none). */
  pending: AppearancePatch | null;
  /** Failed flush attempts of the CURRENT pending patch (0 when none). */
  flushAttempts: number;
  /** The give-up error (null while healthy; cleared by the next landed PUT). */
  error: string | null;
}

/** Read the sync state (pure — the tests + the settings row's source). */
export function appearanceSyncStatus(): AppearanceSyncStatus {
  return {
    pending: pendingAppearancePatch,
    flushAttempts: pendingFlushAttempts,
    error: appearanceSyncError,
  };
}

/** Subscribe to sync-state changes (the Appearance settings screen's inline
 * row re-renders off this; the unsubscribe exists for unmount/tests). */
export function subscribeAppearanceSyncStatus(listener: () => void): () => void {
  appearanceSyncListeners.add(listener);
  return () => {
    appearanceSyncListeners.delete(listener);
  };
}

function notifyAppearanceSyncListeners(): void {
  for (const listener of appearanceSyncListeners) listener();
}

/** Record a patch that could not land — merged field-by-field into any
 * existing pending (a second offline flip widens the pending set; a re-flip
 * of the same field wins, exactly like the server's partial-PUT semantics). */
function recordPendingPatch(patch: AppearancePatch): void {
  if (Object.keys(patch).length === 0) return;
  pendingAppearancePatch =
    pendingAppearancePatch === null
      ? { ...patch }
      : { ...pendingAppearancePatch, ...patch };
  notifyAppearanceSyncListeners();
}

/** A patch (or its fields) LANDED on the server: drop those fields from the
 * pending set; an emptied pending resets the attempt count, and any surfaced
 * error clears (the connection is proven healthy again). */
function markPatchLanded(patch: AppearancePatch): void {
  let changed = false;
  if (pendingAppearancePatch !== null) {
    const next: Record<string, unknown> = { ...pendingAppearancePatch };
    for (const key of Object.keys(patch)) delete next[key];
    if (Object.keys(next).length === 0) {
      pendingAppearancePatch = null;
      pendingFlushAttempts = 0;
    } else {
      pendingAppearancePatch = next as AppearancePatch;
    }
    changed = true;
  }
  if (appearanceSyncError !== null) {
    appearanceSyncError = null;
    changed = true;
  }
  if (changed) notifyAppearanceSyncListeners();
}

/** The give-up copy (pinned by the tests; the Appearance settings screen's
 * inline row renders the same string). */
export const APPEARANCE_SYNC_GAVE_UP =
  "Appearance change didn't reach the desktop after 3 tries — set it again once reconnected.";

/** Flush the pending patch at a connect/hello boundary. Returns true
 * SYNCHRONOUSLY when nothing was pending (the normal path keeps the
 * pre-R128 synchronous hydration shape — no promise hop between a hello and
 * its GET); otherwise a promise of whether the hydration should proceed:
 * true when the flush landed or after the give-up (the patch is dropped +
 * the error surfaced — converge honestly), false while a failed flush still
 * has attempts left (the local value stands this round; the next hello
 * retries). */
function flushPendingAppearancePatch(target: AppearancePushTarget): true | Promise<boolean> {
  if (pendingAppearancePatch === null) return true;
  const patch = pendingAppearancePatch;
  return putAppearance(target, patch)
    .then(
      (outcome) => (outcome.ok ? "landed" : "failed"),
      () => "failed", // transport — the attempt accounting owns it
    )
    .then((result) => {
      if (result === "landed") {
        markPatchLanded(patch);
        mobLog("sync", "appearance patch flushed on reconnect", { ...patch });
        return true;
      }
      return noteFailedFlush(patch);
    });
}

/** A failed flush attempt: count it; at the bound, give up (drop the patch,
 * surface the honest error) and let the hydration converge; below the bound,
 * keep protecting the local value for the next boundary. */
function noteFailedFlush(patch: AppearancePatch): boolean {
  pendingFlushAttempts += 1;
  if (pendingFlushAttempts >= PENDING_FLUSH_MAX_ATTEMPTS) {
    // Give up: the change is honestly lost — say so, converge, move on.
    pendingAppearancePatch = null;
    pendingFlushAttempts = 0;
    appearanceSyncError = APPEARANCE_SYNC_GAVE_UP;
    mobWarn("sync", "appearance patch flush gave up after 3 attempts", { ...patch });
    notifyAppearanceSyncListeners();
    return true;
  }
  mobWarn("sync", "appearance patch flush failed — retrying at the next hello", {
    attempt: pendingFlushAttempts,
  });
  notifyAppearanceSyncListeners();
  return false;
}

/**
 * Push one local appearance change to the server (the optimistic
 * write-through behind the theme provider's setters). STRICTLY optional:
 * the local flip already applied (the click is the UX source; the server is
 * the sync backbone). Skipped while applying a remote value (the echo
 * guard). R128-W6: a PUT that cannot go out (not connected) or fails
 * (transport/HTTP) is recorded PENDING — the next connect/hello flushes it
 * BEFORE the server→local apply, so a local flip can never again be silently
 * reverted by the hydration that follows a relay blip.
 */
export function pushAppearancePatch(
  target: AppearancePushTarget,
  patch: AppearancePatch,
): void {
  if (applyingRemoteAppearance) return; // echo guard — see the doc above
  if (target.getStatus() !== "connected") {
    recordPendingPatch(patch); // offline — pending, not lost
    return;
  }
  void putAppearance(target, patch)
    .then((outcome) => {
      if (outcome.ok) {
        markPatchLanded(patch);
        return;
      }
      recordPendingPatch(patch); // HTTP-level failure — pending, not lost
    })
    .catch(() => {
      recordPendingPatch(patch); // transport loss — pending, not lost
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
 *   · on (re)connect  → FLUSH any pending patch first (R128-W6), then
 *     hydrate: GET the server's appearance and apply it (the server wins
 *     when reachable — the spec's sync semantic, now never able to silently
 *     revert an un-acknowledged local fix);
 *   · on hello        → the same flush-then-hydrate (the resync — the phone
 *     may have missed changes while its events stream was down; a double GET
 *     right after a connect is the honest price, idempotent by construction);
 *   · on settings/appearance frames → apply live (the echo guard inside
 *     applyServerAppearanceValue stops the PUT-back loop).
 *
 * A transport failure of the HYDRATION is silent — the locally persisted
 * value is the offline fallback; a failure of a local flip's PUT is NOT
 * silent anymore: the patch goes pending and rides the next boundary (the
 * machinery above), bounded at 3 attempts with an honest give-up.
 */
export function startAppearanceSync(
  apply: (value: unknown) => boolean,
  env: AppearanceSyncEnv,
): () => void {
  const hydrateFromServer = (): void => {
    void fetchAppearance(env.manager)
      .then((outcome) => {
        if (outcome.ok) apply(outcome.data);
      })
      .catch(() => {
        // transport — silent; the local persisted value stands
      });
  };
  const hydrate = (): void => {
    // R128-W6 — THE PENDING FLUSH WINS OVER THE SERVER APPLY: any patch the
    // phone could not PUT goes out FIRST; only after it lands (or nothing
    // was pending, or the bound was hit) does the hydration read the server
    // — which now echoes our own fix instead of silently reverting it.
    const flushed = flushPendingAppearancePatch(env.manager);
    if (flushed === true) {
      // nothing pending — the pre-R128 synchronous hydration shape
      hydrateFromServer();
      return;
    }
    void flushed.then((proceed) => {
      if (!proceed) {
        return; // the flush failed with attempts left — the local value stands
      }
      hydrateFromServer();
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
