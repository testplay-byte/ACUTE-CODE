/**
 * log.ts — the [ACUTE-MOB] console trail (the owner's R109 ask: "proper
 * console logging for everything"). One tiny pure seam:
 *
 *   mobLog("link", "probe failed", { addr, code })
 *   → console.log("[ACUTE-MOB] link · probe failed", { addr, code })
 *
 * Every subsystem tags its own scope ("link", "stream", "outbox", "boot",
 * "pair", "activity", "config", …) so Android Studio's logcat filter
 * `tag:ReactNativeJS [ACUTE-MOB]` (mobile/README.md) shows the whole
 * phone-side story. Fail-open: logging must never throw.
 */

type LogDetail = unknown;

export function mobLog(scope: string, message: string, detail?: LogDetail): void {
  try {
    if (detail === undefined) {
      console.log(`[ACUTE-MOB] ${scope} · ${message}`);
    } else {
      console.log(`[ACUTE-MOB] ${scope} · ${message}`, detail);
    }
  } catch {
    // Logging is diagnostics — never a crash surface.
  }
}

/** The warn leg — recoverable failures the owner should see in logcat. */
export function mobWarn(scope: string, message: string, detail?: LogDetail): void {
  try {
    if (detail === undefined) {
      console.warn(`[ACUTE-MOB] ${scope} · ${message}`);
    } else {
      console.warn(`[ACUTE-MOB] ${scope} · ${message}`, detail);
    }
  } catch {
    // Logging is diagnostics — never a crash surface.
  }
}

/** The error leg — hard failures (transitions to offline, stream deaths). */
export function mobError(scope: string, message: string, detail?: LogDetail): void {
  try {
    if (detail === undefined) {
      console.error(`[ACUTE-MOB] ${scope} · ${message}`);
    } else {
      console.error(`[ACUTE-MOB] ${scope} · ${message}`, detail);
    }
  } catch {
    // Logging is diagnostics — never a crash surface.
  }
}
