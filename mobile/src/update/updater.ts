/**
 * updater.ts — the companion's update ORCHESTRATION (R124, the owner's
 * first-improvement ruling: "within the Android application, there should
 * be an option to easily update it and download the latest version and be
 * able to install the APK").
 *
 * The pure grammar lives in core.ts (jest-pinned); the native + HTTP floors
 * live in installer-floor.ts (the single acute-installer import site). This
 * module owns the POLICY:
 *
 *   · ANONYMOUS-FIRST (R123's desktop inversion, mirrored): the check and
 *     the download both run anonymous by default; a saved GitHub token is
 *     a pure OPTIONAL accelerator — one retry leg on a 403 rate-limit /
 *     private-repo 404, never the default, so a dead token can never break
 *     an anonymous check. The token lives in SecureStore (the link
 *     secrets' custody class — never AsyncStorage).
 *   · THE DOWNLOAD never crosses the JS bridge (native OkHttp streaming to
 *     the private cache dir, live throttled progress events).
 *   · THE INSTALL hands the cached APK to the OS package installer through
 *     a FileProvider content URI — the system's own confirm dialog is the
 *     confirmation step an APK install deserves.
 *   · THE STARTUP AUTO-CHECK: once per 24 h, silent on failure (a startup
 *     check must never nag), its answer cached in AsyncStorage for the
 *     settings row's caption.
 *
 * Every exported function accepts optional DEPS (the floors) so the
 * orchestration itself is jest-testable without the native bridge.
 */

import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  interpretLatestRelease,
  type AppUpdateCheck,
  type ApkAsset,
} from "./core";
import {
  githubFetch,
  installerFloor,
  type GithubFetch,
  type InstallerFloor,
  type NativeDownloadResult,
} from "./installer-floor";

export type { AppUpdateCheck, ApkAsset };
export { formatBytes, compareVersions, parseReleaseTag, pickApkAsset } from "./core";

// ── the repo truth (the desktop updater's mirror, system.ts) ────────────────

const GITHUB_REPO = "testplay-byte/ACUTE-CODE";
export const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** The app's own version — the BUILD's app.json version embedded by
 * expo-constants (the same source the More hub's identity line reads). */
export const APP_VERSION: string = Constants.expoConfig?.version ?? "0.0.0";

// ── the optional token (SecureStore) ────────────────────────────────────────

const TOKEN_KEY = "acute.githubToken";

export async function getSavedGithubToken(): Promise<string | null> {
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    return token && token.trim() ? token.trim() : null;
  } catch {
    // A SecureStore failure must not break the anonymous check — it reads
    // as "no token", the honest degradation.
    return null;
  }
}

/** Save (or clear, on an empty string) the optional token. */
export async function saveGithubToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, trimmed);
}

export async function clearGithubToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Already gone — the outcome the caller wanted.
  }
}

// ── the check (anonymous-first, token-accelerated) ──────────────────────────

/** The injectable dependencies (tests fake both floors). */
export interface UpdateDeps {
  fetch?: GithubFetch;
  installer?: InstallerFloor;
  now?: () => number;
}

function isRateLimited(status: number, answer: { rateLimitRemaining: string | null; bodyText: string }): boolean {
  if (status !== 403) return false;
  if (answer.rateLimitRemaining === "0") return true;
  return /rate limit/i.test(answer.bodyText);
}

/**
 * Check for a newer release. Anonymous FIRST; on a 403 rate-limit or a 404
 * (private-repo shape), ONE retry with the saved token when one exists.
 * The answer is always one of the four honest states — never a throw.
 */
export async function checkForAppUpdate(deps: UpdateDeps = {}): Promise<AppUpdateCheck> {
  const fetch = deps.fetch ?? githubFetch;
  const now = deps.now ?? Date.now;
  /** Stamp a fresh answer with the clock (accepts the union minus its
   * checkedAt leg — a distributive strip so each state stays itself). */
  type Unchecked = AppUpdateCheck extends infer T
    ? T extends { checkedAt: number }
      ? Omit<T, "checkedAt">
      : T
    : never;
  const stamp = (check: Unchecked): AppUpdateCheck =>
    ({ ...check, checkedAt: now() }) as AppUpdateCheck;

  let token: string | null = null;
  try {
    token = await getSavedGithubToken();
  } catch {
    token = null;
  }

  try {
    const anonymousHeaders: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "acute-companion-updater",
    };
    let answer = await fetch.fetchLatestReleaseJson(GITHUB_LATEST_RELEASE_URL, anonymousHeaders);

    // The accelerator leg — ONLY on the two anonymous dead-ends, ONLY when
    // a token is saved. A dead token rejects the retry; the answer below
    // still tells the truth about what happened.
    if (isRateLimited(answer.status, answer) || answer.status === 404) {
      if (token) {
        answer = await fetch.fetchLatestReleaseJson(GITHUB_LATEST_RELEASE_URL, {
          ...anonymousHeaders,
          Authorization: `Bearer ${token}`,
        });
        if (isRateLimited(answer.status, answer)) {
          return stamp({ kind: "rate-limited", tokenTried: true });
        }
      } else if (isRateLimited(answer.status, answer)) {
        return stamp({ kind: "rate-limited", tokenTried: false });
      }
    }

    if (answer.status !== 200) {
      return stamp({ kind: "error", message: `GitHub answered HTTP ${answer.status}` });
    }

    let body: unknown;
    try {
      body = JSON.parse(answer.bodyText);
    } catch {
      return stamp({ kind: "error", message: "the release answer was not valid JSON" });
    }
    return stamp(interpretLatestRelease(body, APP_VERSION));
  } catch (e) {
    return stamp({
      kind: "error",
      message: e instanceof Error ? e.message : "the check failed",
    });
  }
}

// ── the download + install (the native floor, wrapped in policy) ────────────

/** A live download handle — the UI's one subscription. */
export interface DownloadHandle {
  /** Completion — resolves with the cached APK's path + size. */
  result: Promise<NativeDownloadResult>;
  /** Stop the transfer; `result` rejects with code "canceled". */
  cancel(): Promise<void>;
  /** Subscribe to throttled progress (~1% steps; fraction -1 while the
   * server stays silent about the total). Returns the unsubscribe. */
  onProgress(cb: (ev: { received: number; total: number; fraction: number }) => void): () => void;
}

/** Download the APK — ANONYMOUS-FIRST (the browser-facing URL needs no
 * auth on the public repo); on failure with a saved token, ONE retry on
 * the asset's API url with Accept: octet-stream (the token-friendly
 * surface). */
export function downloadAppUpdate(asset: ApkAsset, deps: UpdateDeps = {}): DownloadHandle {
  const installer = deps.installer ?? installerFloor;
  const listeners = new Set<(ev: { received: number; total: number; fraction: number }) => void>();
  // EVERY subscription made along the way is tracked — the final cleanup
  // tears them all down, whichever leg finished the transfer.
  const unsubs: Array<() => void> = [];
  const subscribe = (url: string) => {
    unsubs.push(
      installer.onProgress(url, (ev) => {
        for (const cb of listeners) cb(ev);
      })
    );
  };
  subscribe(asset.browserDownloadUrl);

  const fileName = `acute-${asset.name}`;
  const result = (async () => {
    try {
      return await installer.downloadApk({ url: asset.browserDownloadUrl, fileName });
    } catch (first) {
      const token = await getSavedGithubToken().catch(() => null);
      if (!token) throw first;
      // The token leg: the API url + octet-stream accept → 302 → the signed
      // object URL (the native OkHttp follows; auth drops cross-host).
      subscribe(asset.url);
      return installer.downloadApk({
        url: asset.url,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" },
        fileName,
      });
    }
  })();

  // Every subscription lives exactly as long as the transfer does.
  const cleanup = () => {
    while (unsubs.length) {
      const u = unsubs.pop();
      u?.();
    }
  };
  void result.finally(cleanup);

  return {
    result,
    cancel: async () => {
      await installer.cancelDownload();
    },
    onProgress: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Stop the in-flight download (the download card's cancel affordance —
 * the handle's promise then rejects with code "canceled"). */
export async function cancelAppUpdate(deps: UpdateDeps = {}): Promise<void> {
  await (deps.installer ?? installerFloor).cancelDownload();
}

/** Hand the cached APK to the OS installer (the system's own confirm step
 * is the confirmation an APK install deserves). */
export async function installAppUpdate(path: string, deps: UpdateDeps = {}): Promise<void> {
  await (deps.installer ?? installerFloor).installApk({ path });
}

/** The honest "may we install?" probe (the Android 8+ per-app runtime
 * grant — REQUEST_INSTALL_PACKAGES only opens the door; the user's toggle
 * walks through it). */
export async function canRequestInstalls(deps: UpdateDeps = {}): Promise<boolean> {
  return (deps.installer ?? installerFloor).canRequestInstalls();
}

/** One tap to this app's page in the system's "Install unknown apps"
 * screen — the recovery path when canRequestInstalls() says no. */
export async function openInstallPermissionSettings(deps: UpdateDeps = {}): Promise<boolean> {
  return (deps.installer ?? installerFloor).openInstallPermissionSettings();
}

// ── the startup auto-check (once per 24 h, AsyncStorage-backed) ──────────────

const LAST_CHECK_KEY = "acute.update.lastCheckAt";
const LAST_RESULT_KEY = "acute.update.lastResult";
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/**
 * The one-per-24 h silent check. Returns the fresh answer (for callers
 * that want it), caches it for the settings row, and NEVER throws — a
 * startup check must not nag. `force` bypasses the 24 h gate (the
 * settings screen's manual button calls checkForAppUpdate directly
 * instead).
 */
export async function maybeAutoCheck(deps: UpdateDeps = {}): Promise<AppUpdateCheck | null> {
  try {
    const last = Number((await AsyncStorage.getItem(LAST_CHECK_KEY)) ?? 0);
    if (Date.now() - last < TWENTY_FOUR_HOURS) return null;
    const result = await checkForAppUpdate(deps);
    await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    await AsyncStorage.setItem(LAST_RESULT_KEY, JSON.stringify(result));
    return result;
  } catch {
    // Cache failures are irrelevant to the check itself.
    try {
      const result = await checkForAppUpdate(deps);
      return result;
    } catch {
      return null;
    }
  }
}

/** The cached last answer for the settings row's caption ("v0.117.0
 * available · 57 MB") — null when no check ever ran or the cache is
 * unreadable (the row then shows the plain "Check for updates" caption). */
export async function getCachedCheck(): Promise<AppUpdateCheck | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_RESULT_KEY);
    return raw ? (JSON.parse(raw) as AppUpdateCheck) : null;
  } catch {
    return null;
  }
}

/** The fresh-answer write the manual check uses (so the settings row's
 * caption updates after a manual check too). */
export async function cacheCheckResult(result: AppUpdateCheck): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_RESULT_KEY, JSON.stringify(result));
    await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // Cache failures never fail the check.
  }
}
