/**
 * acute-installer — the JS surface of the ACUTE companion's APK update floor.
 *
 * One import for the whole app (src/update/updater.ts consumes this; screens
 * never do):
 *
 *   downloadApk(options) → Promise<{path, size}> — streaming download to the
 *       app's private cache, live "progress" events on the module
 *   cancelDownload() → Promise<boolean> — the honest stop button
 *   deleteDownloadedApk({path}) → Promise<boolean> — discard a cached update
 *       (R130-D, the owner's "delete it from there" ask; the path is
 *       validated on the native side against the module's own updates dir)
 *   installApk({path}) → Promise<void> — hands the cached APK to the OS
 *       package installer via a FileProvider content URI
 *   canRequestInstalls() → Promise<boolean> — the "Install unknown apps"
 *       runtime-grant probe (Android 8+)
 *   openInstallPermissionSettings() → Promise<boolean> — the one-tap path to
 *       this app's grant page in system settings
 *   getDownloadState() → Promise<{active, url, received, total}> (R132-MU2)
 *       The live-transfer PROBE: a direct read of the native call's fields
 *       (no throttle, no event) — the re-mounted update screen asks ONCE,
 *       and if the JS download state was lost (a reload-class desync) while
 *       OkHttp kept streaming in this module's process-lifetime scope, the
 *       UI re-attaches to the real transfer instead of showing a blank menu
 *       (and a second downloadApk would only reject "busy").
 *
 * The "progress" event fires ~1% steps while a download runs:
 *   { url, received, total, fraction } — fraction is -1 when the server
 *   sent no Content-Length (the UI shows honest byte counts then).
 *
 * The native side (android/…/AcuteInstallerModule.kt) carries the whole
 * lifecycle so an APK never crosses the JS bridge. TLS here is OkHttp's
 * DEFAULT verification (public CAs) — this floor talks to GitHub, not to
 * the pinned desktop link (that is acute-net's one job).
 */

import { NativeModule, requireNativeModule } from "expo";

/** Exactly the options bag AcuteInstallerModule.kt reads. */
export interface NativeDownloadOptions {
  url: string;
  /** Optional extra headers (e.g. a GitHub token for private-repo assets). */
  headers?: Record<string, string>;
  /** Cache-file name (sanitized on the native side). */
  fileName: string;
}

export interface NativeDownloadResult {
  /** Absolute path of the cached APK. */
  path: string;
  /** Bytes received (and written). */
  size: number;
}

/** R132-MU2 — the live-transfer probe's answer: {active:true, url, received,
 * total} while the module's one in-flight download streams ({total} is -1
 * when the server sent no Content-Length, the event grammar's own rule),
 * {active:false, url:null, received:0, total:0} when nothing runs. */
export interface NativeDownloadState {
  active: boolean;
  url: string | null;
  received: number;
  total: number;
}

type AcuteInstallerEventsMap = {
  progress: (ev: { url: string; received: number; total: number; fraction: number }) => void;
};

declare class AcuteInstallerNativeModule extends NativeModule<AcuteInstallerEventsMap> {
  downloadApk(options: NativeDownloadOptions): Promise<NativeDownloadResult>;
  cancelDownload(): Promise<boolean>;
  deleteDownloadedApk(options: { path: string }): Promise<boolean>;
  installApk(options: { path: string }): Promise<void>;
  canRequestInstalls(): Promise<boolean>;
  openInstallPermissionSettings(): Promise<boolean>;
  getDownloadState(): Promise<NativeDownloadState>;
}

export const AcuteInstaller = requireNativeModule<AcuteInstallerNativeModule>("AcuteInstaller");
