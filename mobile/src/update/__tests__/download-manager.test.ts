/**
 * The download MANAGER's tests (R132-MU) — the state machine that outlives
 * the route, with faked floors (no native bridge anywhere near this file —
 * the updater.test.ts discipline: installer-floor.ts is the single
 * acute-installer import site, and this mock keeps the import chain from
 * ever loading it):
 *
 *   (a) MOUNT-MID-DOWNLOAD RE-ATTACH — the manager holds the live state
 *       through a route's death; a fresh subscriber renders from
 *       getState() and hears the next progress event.
 *   (b) "BUSY" NEVER ERRORS — the native single-flight rejection re-attaches
 *       to the live transfer the probe finds (the owner's exact repro:
 *       "it would say download already happening" as an error toast); a
 *       busy rejection whose transfer already ended settles quietly.
 *   (c) COMPLETED IS NEVER SILENTLY DESTROYED — a second Download tap for
 *       the SAME asset never calls downloadApk again (the cached APK is not
 *       deleted to re-download ~57 MB); a DIFFERENT asset legitimately
 *       starts a new lifecycle; discard clears the done state through the
 *       floor.
 *   (d) CANCEL CLEARS THE STATE — the "canceled" code classifies (the
 *       caution toast's cause), never errors; an ADOPTED transfer cancels
 *       without any JS promise to settle it.
 *   (e) ERROR RECORDS HONESTLY — a real failure mints the error state with
 *       the rejection's own message and the failed notice, and never blocks
 *       the retry.
 *   (MU2) THE MOUNT PROBE — probeNative adopts a live transfer the manager
 *       never knew (progress resumes; the adopted completion settles
 *       honestly — no JS promise exists to mint the cached file's path),
 *       prefers the remembered asset on a url match, and no-ops when the
 *       manager's own chain is already live.
 */

import { describe, expect, it, jest } from "@jest/globals";

import { DownloadManager, type DownloadNotice, type DownloadState } from "../download-manager";
import type { ApkAsset } from "../core";
import type { InstallerFloor, NativeDownloadResult } from "../installer-floor";

// The logcat trail is mocked quiet (the manager logs its "download start"
// line — assertions here are about STATE, not console noise).
jest.mock("../../lib/log", () => ({
  mobLog: () => undefined,
  mobWarn: () => undefined,
  mobError: () => undefined,
}));

// The native floor is mocked OUT of the jest suite (updater.test.ts's exact
// factory): every test below injects its own fake through the manager's deps.
jest.mock("../installer-floor", () => ({
  githubFetch: {
    fetchLatestReleaseJson: async (): Promise<never> => {
      throw new Error("the real github floor is mocked out of the jest suite");
    },
  },
  installerFloor: {
    downloadApk: async (): Promise<never> => {
      throw new Error("the real installer floor is mocked out of the jest suite");
    },
    cancelDownload: async () => false,
    deleteDownloadedApk: async () => true,
    installApk: async () => undefined,
    canRequestInstalls: async () => true,
    openInstallPermissionSettings: async () => true,
    getDownloadState: async () => ({ active: false, url: null, received: 0, total: 0 }),
    onProgress: () => () => undefined,
  },
}));

// ── the fixtures ────────────────────────────────────────────────────────────

const asset: ApkAsset = {
  url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/123",
  browserDownloadUrl:
    "https://github.com/testplay-byte/ACUTE-CODE/releases/download/v0.125.0/ACUTE-CODE_0.125.0_android-arm64.apk",
  name: "ACUTE-CODE_0.125.0_android-arm64.apk",
  size: 57_000_000,
};

/** A NEWER release — different urls, so its download is a new lifecycle. */
const otherAsset: ApkAsset = {
  url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/456",
  browserDownloadUrl:
    "https://github.com/testplay-byte/ACUTE-CODE/releases/download/v0.126.0/ACUTE-CODE_0.126.0_android-arm64.apk",
  name: "ACUTE-CODE_0.126.0_android-arm64.apk",
  size: 58_000_000,
};

const landed: NativeDownloadResult = {
  path: "/cache/updates/acute-ACUTE-CODE_0.125.0_android-arm64.apk",
  size: 57_000_000,
};

/** One macrotask — enough for the rejection → classification → probe chain
 * (all microtasks) to settle before the assertion reads the state. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ── the fake installer floor ────────────────────────────────────────────────

/**
 * The fake native side: downloadApk records the call and parks a
 * manually-settled promise (the native transfer), onProgress registers
 * url-filtered sinks the test emits through, getDownloadState answers a
 * scriptable witness, and the single-flight "busy"/"canceled" rejections
 * ride a per-call rejection queue (the fakeFetch discipline).
 */
function fakeInstaller() {
  const downloadCalls: Array<{ url: string; fileName: string }> = [];
  const pending: Array<{
    resolve: (result: NativeDownloadResult) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const progressSinks: Array<{
    url: string;
    cb: (ev: { received: number; total: number; fraction: number }) => void;
  }> = [];
  const installCalls: Array<{ path: string }> = [];
  const deleteCalls: Array<{ path: string }> = [];
  let cancelCount = 0;
  /** Scripted rejections, shifted per downloadApk call. */
  const rejections: unknown[] = [];
  /** The live-transfer witness getDownloadState reads (R132-MU2's probe). */
  const probe: { active: boolean; url: string | null; received: number; total: number } = {
    active: false,
    url: null,
    received: 0,
    total: 0,
  };

  const installer: InstallerFloor = {
    downloadApk: (options) =>
      new Promise<NativeDownloadResult>((resolve, reject) => {
        downloadCalls.push({ url: options.url, fileName: options.fileName });
        const rejection = rejections.shift();
        if (rejection !== undefined) {
          reject(rejection);
          return;
        }
        pending.push({ resolve, reject });
        probe.active = true;
        probe.url = options.url;
      }),
    cancelDownload: async () => {
      cancelCount += 1;
      return pending.length > 0;
    },
    deleteDownloadedApk: async (options) => {
      deleteCalls.push({ path: options.path });
      return true;
    },
    installApk: async (options) => {
      installCalls.push({ path: options.path });
    },
    canRequestInstalls: async () => true,
    openInstallPermissionSettings: async () => true,
    getDownloadState: async () => ({ ...probe }),
    onProgress: (url, cb) => {
      const sink = { url, cb };
      progressSinks.push(sink);
      return () => {
        const i = progressSinks.indexOf(sink);
        if (i >= 0) progressSinks.splice(i, 1);
      };
    },
  };

  return {
    installer,
    downloadCalls,
    rejections,
    installCalls,
    deleteCalls,
    probe,
    get cancelCount() {
      return cancelCount;
    },
    /** The test's hand on the native side's throttled progress events. */
    emit(url: string, ev: { received: number; total: number; fraction: number }) {
      for (const sink of [...progressSinks]) {
        if (sink.url === url) sink.cb(ev);
      }
    },
    /** The transfer completes natively — its promise resolves to its caller. */
    complete(index: number, result: NativeDownloadResult) {
      probe.active = false;
      pending[index]?.resolve(result);
    },
    /** The transfer dies natively — its promise rejects to its caller. */
    fail(index: number, reason: unknown) {
      probe.active = false;
      pending[index]?.reject(reason);
    },
  };
}

// ── (a) the state outlives the route ────────────────────────────────────────

describe("R132-MU1 — the state outlives the route", () => {
  it("(a) holds the live state through a route's death — a fresh subscriber renders from getState() and hears the next event", () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer, now: () => 1234 });
    m.start(asset);
    expect(m.getState()).toMatchObject({ phase: "active", received: 0, total: asset.size });
    f.emit(asset.browserDownloadUrl, { received: 5_700_000, total: 57_000_000, fraction: 0.1 });
    // The "route unmounts" here — NO subscription is alive, yet the mirror
    // survives (the whole defect was this state living in useState):
    expect(m.getState()).toMatchObject({
      phase: "active",
      asset,
      received: 5_700_000,
      total: 57_000_000,
      startedAt: 1234,
    });
    // The re-mount: render from the snapshot, hear everything after it.
    const heard: DownloadState[] = [];
    m.subscribe((state) => heard.push(state));
    f.emit(asset.browserDownloadUrl, { received: 11_400_000, total: 57_000_000, fraction: 0.2 });
    expect(m.getState()).toMatchObject({ phase: "active", received: 11_400_000 });
    expect(heard[heard.length - 1]).toMatchObject({ phase: "active", received: 11_400_000 });
  });

  it("(a2) completion mints the done state from the manager's own chain — the re-mounted screen's ready-to-install card", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    const notices: DownloadNotice[] = [];
    m.subscribe((_state, notice) => notices.push(notice));
    m.start(asset);
    f.complete(0, landed);
    await flush();
    expect(m.getState()).toEqual({ phase: "done", asset, result: landed });
    expect(notices).toContainEqual({ kind: "completed", result: landed });
  });

  it("unsubscribe stops the listener (the route's unmount discipline)", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    const heard: DownloadNotice[] = [];
    const unsub = m.subscribe((_state, notice) => heard.push(notice));
    m.start(asset);
    unsub();
    f.complete(0, landed);
    await flush();
    expect(heard).toEqual([{ kind: "started" }]);
  });
});

// ── (b) "busy" classifies to re-attach ──────────────────────────────────────

describe("R132-MU3 — 'busy' NEVER errors", () => {
  it("(b) a 'busy' rejection re-attaches to the live transfer the probe finds — the owner's repro, healed", async () => {
    const f = fakeInstaller();
    // The native side already streams (the desync the probe heals — e.g. a
    // JS reload while OkHttp kept going):
    f.probe.active = true;
    f.probe.url = asset.browserDownloadUrl;
    f.probe.received = 22_800_000;
    f.probe.total = 57_000_000;
    f.rejections.push({ code: "busy", message: "a download is already running" });
    const m = new DownloadManager({ installer: f.installer });
    const notices: DownloadNotice[] = [];
    m.subscribe((_state, notice) => notices.push(notice));
    m.start(asset);
    await flush();
    // The live state shows — NEVER an error toast for a working download:
    expect(m.getState()).toMatchObject({ phase: "active", received: 22_800_000, total: 57_000_000 });
    expect(notices.find((n) => n.kind === "failed")).toBeUndefined();
    // And the adopted transfer's progress keeps flowing:
    f.emit(asset.browserDownloadUrl, { received: 34_200_000, total: 57_000_000, fraction: 0.6 });
    expect(m.getState()).toMatchObject({ received: 34_200_000 });
  });

  it("(b2) a 'busy' rejection whose transfer already ended settles quietly — no error, no stuck bar", async () => {
    const f = fakeInstaller();
    f.rejections.push({ code: "busy", message: "a download is already running" });
    const m = new DownloadManager({ installer: f.installer });
    const notices: DownloadNotice[] = [];
    m.subscribe((_state, notice) => notices.push(notice));
    m.start(asset);
    await flush();
    expect(m.getState()).toEqual({ phase: "idle" });
    expect(notices).toContainEqual({ kind: "reset" });
    expect(notices.find((n) => n.kind === "failed")).toBeUndefined();
  });
});

// ── (c) the completed state is never silently destroyed ─────────────────────

describe("R132-MU3 — completed is never silently destroyed", () => {
  it("(c) a completed result for the SAME asset is never re-downloaded — the install path rides the singleton", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    m.start(asset);
    f.complete(0, landed);
    await flush();
    expect(m.getState().phase).toBe("done");
    // The sheet's Download tap after completion (the sibling defect's repro —
    // the old path silently DELETED the cached APK and re-downloaded ~57 MB):
    m.start(asset);
    expect(f.downloadCalls).toHaveLength(1);
    expect(m.getState()).toEqual({ phase: "done", asset, result: landed });
    // The install path shows — driven from the singleton's own result:
    await m.install();
    expect(f.installCalls).toEqual([{ path: landed.path }]);
  });

  it("(c2) a completed result for a DIFFERENT asset (a newer release) legitimately starts a new lifecycle", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    m.start(asset);
    f.complete(0, landed);
    await flush();
    m.start(otherAsset);
    expect(f.downloadCalls).toHaveLength(2);
    expect(m.getState()).toMatchObject({ phase: "active", asset: otherAsset });
  });

  it("(c3) discard deletes the cached file through the floor and clears the done state (R130-D's affordance)", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    const notices: DownloadNotice[] = [];
    m.subscribe((_state, notice) => notices.push(notice));
    m.start(asset);
    f.complete(0, landed);
    await flush();
    await m.discard();
    expect(f.deleteCalls).toEqual([{ path: landed.path }]);
    expect(m.getState()).toEqual({ phase: "idle" });
    expect(notices).toContainEqual({ kind: "discarded" });
  });
});

// ── the mount probe (R132-MU2) ──────────────────────────────────────────────

describe("R132-MU2 — the mount probe", () => {
  it("adopts a live transfer the manager never knew — the bar resumes, and the adopted completion settles honestly", async () => {
    const f = fakeInstaller();
    f.probe.active = true;
    f.probe.url = asset.browserDownloadUrl;
    f.probe.received = 5_700_000;
    f.probe.total = 57_000_000;
    const m = new DownloadManager({ installer: f.installer });
    await m.probeNative();
    // No remembered asset — an honest minimal one synthesized from the url:
    expect(m.getState()).toMatchObject({
      phase: "active",
      received: 5_700_000,
      total: 57_000_000,
      asset: {
        browserDownloadUrl: asset.browserDownloadUrl,
        name: asset.name,
        size: asset.size,
      },
    });
    // The live wire keeps feeding the adopted state:
    f.emit(asset.browserDownloadUrl, { received: 11_400_000, total: 57_000_000, fraction: 0.2 });
    expect(m.getState()).toMatchObject({ received: 11_400_000 });
    // The adopted transfer's completion: no JS promise exists to mint the
    // cached file's path — the honest end is the quiet reset (pinned
    // caveat: re-downloading after THIS end is the pre-fix behavior):
    f.emit(asset.browserDownloadUrl, { received: 57_000_000, total: 57_000_000, fraction: 1 });
    expect(m.getState()).toEqual({ phase: "idle" });
  });

  it("prefers the remembered asset when the probe's url matches either of its legs", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    m.start(asset);
    f.complete(0, landed);
    await flush();
    await m.discard(); // idle again — but the manager REMEMBERS the asset
    f.probe.active = true;
    f.probe.url = asset.url; // the TOKEN leg's url — also a match
    f.probe.received = 1_000_000;
    f.probe.total = 57_000_000;
    await m.probeNative();
    expect(m.getState()).toMatchObject({ phase: "active", asset, received: 1_000_000 });
  });

  it("is a no-op when the manager's own chain is already live (fresher than any probe)", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    m.start(asset);
    f.probe.active = true;
    f.probe.url = "https://elsewhere.example/other.apk";
    f.probe.received = 999;
    await m.probeNative();
    expect(m.getState()).toMatchObject({ phase: "active", asset, received: 0 });
  });
});

// ── (d) cancel + (e) error ──────────────────────────────────────────────────

describe("R132-MU — cancel and the honest error", () => {
  it("(d) cancel settles the manager to idle — 'canceled' classifies (the caution toast's cause), never errors", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    const notices: DownloadNotice[] = [];
    m.subscribe((_state, notice) => notices.push(notice));
    m.start(asset);
    const stopping = m.cancel();
    f.fail(0, { code: "canceled", message: "the download was canceled" });
    await stopping;
    await flush();
    expect(m.getState()).toEqual({ phase: "idle" });
    expect(notices).toContainEqual({ kind: "canceled" });
    expect(notices.find((n) => n.kind === "failed")).toBeUndefined();
    expect(f.cancelCount).toBe(1);
  });

  it("(d2) a second start while active is a no-op — the single-flight law guarded in JS", () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    m.start(asset);
    m.start(otherAsset);
    expect(f.downloadCalls).toHaveLength(1);
    expect(m.getState()).toMatchObject({ phase: "active", asset });
  });

  it("(e) a real failure records the honest error state — the rejection's own message + the failed notice — and never blocks the retry", async () => {
    const f = fakeInstaller();
    const m = new DownloadManager({ installer: f.installer });
    const notices: DownloadNotice[] = [];
    m.subscribe((_state, notice) => notices.push(notice));
    m.start(asset);
    f.fail(0, { code: "network", message: "the download failed with HTTP 502" });
    await flush();
    expect(m.getState()).toEqual({
      phase: "error",
      asset,
      message: "the download failed with HTTP 502",
    });
    expect(notices).toContainEqual({ kind: "failed", message: "the download failed with HTTP 502" });
    // The error state is a record, not a lock:
    m.start(asset);
    expect(f.downloadCalls).toHaveLength(2);
    expect(m.getState()).toMatchObject({ phase: "active" });
  });

  it("(e2) cancel on an ADOPTED transfer settles without any JS promise — the native stop is the witness", async () => {
    const f = fakeInstaller();
    f.probe.active = true;
    f.probe.url = asset.browserDownloadUrl;
    f.probe.received = 5_700_000;
    f.probe.total = 57_000_000;
    const m = new DownloadManager({ installer: f.installer });
    await m.probeNative();
    const notices: DownloadNotice[] = [];
    m.subscribe((_state, notice) => notices.push(notice));
    await m.cancel();
    expect(m.getState()).toEqual({ phase: "idle" });
    expect(notices).toContainEqual({ kind: "canceled" });
    expect(f.cancelCount).toBe(1);
  });
});
