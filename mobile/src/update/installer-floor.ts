/**
 * installer-floor.ts — the SINGLE runtime import site of the
 * acute-installer native module inside src/ (the same discipline
 * native-transport.ts applies to acute-net: one import site, everything
 * testable consumes interfaces instead).
 *
 * The floor ALSO carries the GitHub HTTP leg for the update check — via
 * acuteNetTransport's plain request() (pinSha256 ABSENT → OkHttp's DEFAULT
 * public-CA verification; GitHub is not the TOFU-pinned desktop link, and
 * acute-net's request() already carries exactly that two-mode rule).
 */

import { acuteNetTransport } from "../link/native-transport";
import { AcuteInstaller, type NativeDownloadOptions, type NativeDownloadResult } from "../../modules/acute-installer";

// Re-exported so updater.ts + the screen never import the module directly.
export type { NativeDownloadOptions, NativeDownloadResult };

// ── the seams (what updater.ts consumes; what tests fake) ──────────────────

/** One anonymous-or-tokened GitHub HTTP answer, shape-normalized for the
 * check (rate-limit detection needs the X-RateLimit-Remaining header). */
export interface GithubHttpAnswer {
  status: number;
  bodyText: string;
  rateLimitRemaining: string | null;
}

export interface GithubFetch {
  fetchLatestReleaseJson(url: string, headers: Record<string, string>): Promise<GithubHttpAnswer>;
}

/** The native installer surface updater.ts consumes. */
export interface InstallerFloor {
  downloadApk(options: NativeDownloadOptions): Promise<NativeDownloadResult>;
  cancelDownload(): Promise<boolean>;
  installApk(options: { path: string }): Promise<void>;
  canRequestInstalls(): Promise<boolean>;
  openInstallPermissionSettings(): Promise<boolean>;
  /** Subscribe to the module's throttled progress events; returns the
   * unsubscribe. Events are filtered by url at THIS layer. */
  onProgress(
    url: string,
    cb: (ev: { received: number; total: number; fraction: number }) => void
  ): () => void;
}

// ── the real implementations ───────────────────────────────────────────────

/** The GitHub HTTP leg — acute-net's request() with NO pin (public CA). */
export const githubFetch: GithubFetch = {
  async fetchLatestReleaseJson(url, headers) {
    const res = await acuteNetTransport.request({
      url,
      method: "GET",
      headers,
      timeoutMs: 15000,
    });
    const h = (res.headers ?? {}) as Record<string, string>;
    const remaining =
      h["x-ratelimit-remaining"] ?? h["X-RateLimit-Remaining"] ?? null;
    return { status: res.status, bodyText: res.bodyText, rateLimitRemaining: remaining };
  },
};

/** The native floor — a thin typed passthrough + the url-filtered progress
 * subscription (the module emits for THE one in-flight download; the filter
 * keeps the contract honest if that ever changes). */
export const installerFloor: InstallerFloor = {
  downloadApk: (options) => AcuteInstaller.downloadApk(options),
  cancelDownload: () => AcuteInstaller.cancelDownload(),
  installApk: (options) => AcuteInstaller.installApk(options),
  canRequestInstalls: () => AcuteInstaller.canRequestInstalls(),
  openInstallPermissionSettings: () => AcuteInstaller.openInstallPermissionSettings(),
  onProgress(url, cb) {
    const subscription = AcuteInstaller.addListener("progress", (ev) => {
      if (ev.url !== url) return;
      cb({ received: ev.received, total: ev.total, fraction: ev.fraction });
    });
    return () => subscription.remove();
  },
};
