/**
 * core.ts — the updater's PURE core (R124: the owner's "update functionality
 * for the Android application" — this is the phone's own update lifecycle,
 * independent of the desktop link).
 *
 * EVERYTHING here is dependency-free TypeScript: no native imports, no
 * SecureStore, no fetch — the jest suite (__tests__/core.test.ts) covers
 * every branch. The runtime orchestration lives in updater.ts; the native
 * floor lives in installer-floor.ts.
 *
 * THE GRAMMAR:
 *   AppUpdateCheck — one honest answer, four states (up-to-date /
 *     available / rate-limited / error). Every UI state the update screen
 *     renders is one of these — no booleans to combine, no "loading" that
 *     lies about what happened.
 *   ApkAsset — the ONE deliverable the Mobile APK workflow ships
 *     (`ACUTE-CODE_<version>_android-arm64.apk`, ROUND-109's ABI ruling;
 *     the older `app-arm64-v8a-release.apk` shape stays tolerated for
 *     checks against historical releases).
 */

// ── the shapes ──────────────────────────────────────────────────────────────

/** The APK asset as the check understands it. */
export interface ApkAsset {
  /** The asset's API url — the token-friendly surface (Accept: octet-stream
   * → 302 to a signed object URL; OkHttp follows and drops the auth header
   * on the cross-host hop, which is exactly right). */
  url: string;
  /** The browser-facing URL — the ANONYMOUS leg (redirects included). */
  browserDownloadUrl: string;
  name: string;
  /** Bytes, when GitHub reported it (it always does for attached assets). */
  size: number | null;
}

/** One honest check answer — every state the UI renders. */
export type AppUpdateCheck =
  | { kind: "up-to-date"; current: string; latest: string; checkedAt: number }
  | {
      kind: "available";
      current: string;
      latest: string;
      version: string;
      /** The release title (e.g. "v0.117.0 — …") or the tag. */
      title: string;
      /** The release body — plain text notes, rendered as-is (honest, no
       * markdown parser in the updater card). */
      notes: string;
      apk: ApkAsset | null;
      checkedAt: number;
    }
  | {
      kind: "rate-limited";
      /** True when the retry WITH a saved token still hit the limit. */
      tokenTried: boolean;
      checkedAt: number;
    }
  | { kind: "error"; message: string; checkedAt: number };

// ── version grammar ─────────────────────────────────────────────────────────

/** "v0.117.0" | "0.117.0" → "0.117.0"; anything unparsable → null. */
export function parseReleaseTag(tag: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Semver-ish comparison: -1 | 0 | 1 (nulls sort last — a broken remote
 * version must never read as "newer"). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  const as = pa.split(".").map(Number);
  const bs = pb.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (as[i]! < bs[i]!) return -1;
    if (as[i]! > bs[i]!) return 1;
  }
  return 0;
}

// ── asset grammar ───────────────────────────────────────────────────────────

/** The Mobile APK workflow's deliverable shapes, newest first:
 * `ACUTE-CODE_0.117.0_android-arm64.apk` (R122+ naming) then the older
 * `app-arm64-v8a-release.apk`. Anything else is not the phone's binary. */
export function pickApkAsset(assets: Array<Record<string, unknown>>): ApkAsset | null {
  const isApk = (a: Record<string, unknown>) =>
    typeof a.name === "string" && a.name.toLowerCase().endsWith(".apk");
  const candidates = assets.filter(isApk);
  const preferred = candidates.find(
    (a) => typeof a.name === "string" && /_android-arm64\.apk$/i.test(a.name)
  );
  const legacy = candidates.find(
    (a) => typeof a.name === "string" && /^app-arm64-v8a-release\.apk$/i.test(a.name)
  );
  const chosen = preferred ?? legacy ?? null;
  if (!chosen) return null;
  return {
    url: String(chosen.url ?? ""),
    browserDownloadUrl: String(chosen.browser_download_url ?? chosen.url ?? ""),
    name: String(chosen.name ?? "app.apk"),
    size: typeof chosen.size === "number" ? chosen.size : null,
  };
}

// ── the release interpretation (pure — tests feed it JSON bodies) ──────────

/** Interpret a releases/latest JSON body → the check answer. The network
 * leg (updater.ts) wraps this; every branch of this function is pinned by
 * a test. */
export function interpretLatestRelease(body: unknown, currentVersion: string): AppUpdateCheck {
  if (typeof body !== "object" || body === null) {
    return { kind: "error", message: "the release answer was not an object", checkedAt: Date.now() };
  }
  const obj = body as Record<string, unknown>;
  const tag = typeof obj.tag_name === "string" ? obj.tag_name : "";
  const latest = parseReleaseTag(tag);
  if (latest === null) {
    return {
      kind: "error",
      message: `the release tag "${tag || "(none)"}" is not a version`,
      checkedAt: Date.now(),
    };
  }
  const compared = compareVersions(currentVersion, latest);
  if (compared >= 0) {
    return { kind: "up-to-date", current: currentVersion, latest, checkedAt: Date.now() };
  }
  const assets = Array.isArray(obj.assets) ? (obj.assets as Array<Record<string, unknown>>) : [];
  return {
    kind: "available",
    current: currentVersion,
    latest,
    version: latest,
    title: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : `v${latest}`,
    notes: typeof obj.body === "string" ? obj.body : "",
    apk: pickApkAsset(assets),
    checkedAt: Date.now(),
  };
}

/** "57 MB" / "1.2 GB" — the one byte formatter the update surfaces need
 * (the card's size line, the progress bar's counts). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}
