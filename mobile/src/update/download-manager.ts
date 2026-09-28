/**
 * download-manager.ts — R132-MU1: the download state that OUTLIVES the route.
 *
 * The owner's defect, in his words: "sometimes the downloading options
 * would disappear and would not be shown even though the download was
 * happening, and if I click check for updates and click download again, it
 * would say download already happening, which was not a good experience."
 *
 * The root cause was SCOPE: the native OkHttp transfer lives for the
 * process lifetime (AcuteInstallerModule's activeCall), but every byte of
 * the UI's download state was component-local useState in the ROUTE — a
 * back-navigation mid-download destroyed the mirror while the transfer kept
 * running, and the re-mounted screen had NOTHING to render (the mount
 * effect read only the cached CHECK). Tapping Download again then hit the
 * native single-flight "busy" rejection, which the old catch classified as
 * a generic failure → an error toast for a download that was working.
 *
 * This module is the fix's center: a module-scope manager — the same
 * lifetime class as the native floor it mirrors — owning ONE active
 * download lifecycle:
 *
 *   · start(asset)        — one flight (the native law); a COMPLETED result
 *                           for the same asset is never silently destroyed
 *                           (R132-MU3: tapping Download again must show the
 *                           install card, not delete the cached APK and
 *                           re-download ~57 MB).
 *   · subscribe(listener) — the route re-renders FROM the manager; a
 *                           back-navigation mid-download changes nothing.
 *   · probeNative()       — the R132-MU2 re-attach: ask the native side
 *                           ONCE whether a transfer is live; when the JS
 *                           state was lost (a reload-class desync) the
 *                           manager adopts the real transfer's progress.
 *   · cancel/discard/install — the affordances, driven from the singleton's
 *                           own state so they work on a re-mounted screen.
 *
 * Deliberately FRAMEWORK-FREE (pure TypeScript + a listener set — no React
 * imports) so the state machine tests cleanly; the screen's whole job is
 * subscribe → render. updater.ts's downloadAppUpdate handle factory stays
 * the plumbing; this file wraps ONE lifecycle around it.
 *
 * The notice grammar (what subscribers hear alongside each new state):
 *   started    — a transfer began (the bar snaps to 0)
 *   progress   — received/total moved (the bar times to the fraction)
 *   completed  — the APK landed (result mints the done state)
 *   canceled   — the user stopped it (the caution toast's cause)
 *   failed     — a REAL failure, message included (the error toast's cause)
 *   discarded  — the landed APK was deleted (R130-D's affordance)
 *   reset      — the active state cleared with no user-visible terminal
 *                event (a busy rejection whose transfer had already ended,
 *                or an ADOPTED transfer completing — see the adoption note)
 *
 * "busy" NEVER reaches the screen as an error (R132-MU3): it is the native
 * single-flight law speaking — a download IS running — so the manager
 * re-attaches to it instead of classifying a failure.
 */

import type { ApkAsset } from "./core";
import { mobLog } from "../lib/log";
import {
  cancelAppUpdate,
  deleteDownloadedUpdate,
  downloadAppUpdate,
  installAppUpdate,
  type DownloadHandle,
} from "./updater";
import {
  installerFloor,
  type InstallerFloor,
  type NativeDownloadResult,
  type NativeDownloadState,
} from "./installer-floor";

// ── the shapes ──────────────────────────────────────────────────────────────

/** The manager's whole truth — every UI state the update screen renders for
 * a download is one of these four phases (the check grammar's discipline,
 * applied to the transfer). */
export type DownloadState =
  | { phase: "idle" }
  | { phase: "active"; asset: ApkAsset; received: number; total: number; startedAt: number }
  | { phase: "done"; asset: ApkAsset; result: NativeDownloadResult }
  | { phase: "error"; asset: ApkAsset; message: string };

/** The transition cause subscribers hear with each new state. */
export type DownloadNotice =
  | { kind: "started" }
  | { kind: "progress" }
  | { kind: "completed"; result: NativeDownloadResult }
  | { kind: "canceled" }
  | { kind: "failed"; message: string }
  | { kind: "discarded" }
  | { kind: "reset" };

/** The injectable seams (the updater's own deps grammar — tests fake the
 * installer floor; the app runs the real one). */
export interface DownloadManagerDeps {
  installer?: InstallerFloor;
  now?: () => number;
}

// ── the rejection taxonomy (the native promise's honest codes) ──────────────

/** The native module rejects with a {code, message} object (the same shape
 * the pre-R132 screen's catch read inline); "canceled" and "busy" are
 * classifications, never failures. */
function rejectionCode(e: unknown): string | null {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** The honest failure message — the rejection's own words when it carries
 * any (the native side writes real ones: "the download failed with HTTP
 * 502"), the generic line only as the last resort. */
function rejectionMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (e instanceof Error && e.message) return e.message;
  return "the download failed";
}

/** Same deliverable = same download urls (a fresh check of the same release
 * answers byte-identical urls; a NEW release's urls differ, and its
 * download is legitimately a new lifecycle). */
function sameAsset(a: ApkAsset, b: ApkAsset): boolean {
  return a.browserDownloadUrl === b.browserDownloadUrl && a.url === b.url;
}

// ── the manager ─────────────────────────────────────────────────────────────

export class DownloadManager {
  private state: DownloadState = { phase: "idle" };
  private listeners = new Set<(state: DownloadState, notice: DownloadNotice) => void>();
  /** The live handle while OUR chain owns the transfer. */
  private handle: DownloadHandle | null = null;
  /** An ADOPTED transfer's progress unsubscriber — adopted means the
   * native side runs a call whose JS promise we do not hold (a reload-class
   * desync), so progress events are the only live wire. */
  private adoptedUnsub: (() => void) | null = null;
  /** The last asset a lifecycle started with — the probe's url match. */
  private lastAsset: ApkAsset | null = null;
  private readonly deps: DownloadManagerDeps;
  private readonly now: () => number;

  constructor(deps: DownloadManagerDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** The current snapshot (immutable-by-replacement: every transition mints
   * a new object, so a held snapshot never mutates under its reader). */
  getState(): DownloadState {
    return this.state;
  }

  /** Subscribe to transitions; returns the unsubscribe. The listener is NOT
   * called on subscribe — a fresh subscriber (a re-mounted screen) renders
   * from getState() and hears only what happens next. */
  subscribe(listener: (state: DownloadState, notice: DownloadNotice) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Start (or deliberately re-tap) the download for one asset.
   *
   * R132-MU3's two guards, in the manager where they survive the route:
   *   · active → a no-op — the native side is single-flight ("busy"), and
   *     the UI already shows the live card;
   *   · done for THIS asset → a no-op — the cached APK is never silently
   *     deleted by a re-download; the ready-to-install card is the answer.
   * A done result for a DIFFERENT asset (a newer release checked while an
   * old APK sits cached) legitimately starts a new lifecycle. */
  start(asset: ApkAsset): void {
    const current = this.state;
    if (current.phase === "active") return;
    if (current.phase === "done" && sameAsset(current.asset, asset)) return;
    this.detachAdopted();
    this.lastAsset = asset;
    // The logcat trail the route used to own (the owner's R109 ask — the
    // story must not lose its "download start" line just because the state
    // moved out of the route).
    mobLog("update", "download start", { name: asset.name });

    const handle = downloadAppUpdate(asset, this.deps);
    this.handle = handle;
    this.transition(
      { phase: "active", asset, received: 0, total: asset.size ?? 0, startedAt: this.now() },
      { kind: "started" },
    );

    const unsubProgress = handle.onProgress((ev) => {
      if (this.handle !== handle || this.state.phase !== "active") return;
      this.transition(
        {
          ...this.state,
          received: ev.received,
          total: ev.total > 0 ? ev.total : this.state.total,
        },
        { kind: "progress" },
      );
    });

    void handle.result
      .then((result) => {
        unsubProgress();
        if (this.handle !== handle || this.state.phase !== "active") return;
        this.handle = null;
        this.transition({ phase: "done", asset, result }, { kind: "completed", result });
      })
      .catch((e: unknown) => {
        unsubProgress();
        if (this.handle !== handle) return;
        this.handle = null;
        const code = rejectionCode(e);
        if (code === "canceled") {
          this.transition({ phase: "idle" }, { kind: "canceled" });
          return;
        }
        if (code === "busy") {
          // R132-MU3: the native single-flight rejection — a download IS
          // running; NEVER an error. Re-attach to the live transfer (the
          // probe tells which one); if it already ended, settle quietly.
          void this.adoptLiveTransfer();
          return;
        }
        const message = rejectionMessage(e);
        this.transition({ phase: "error", asset, message }, { kind: "failed", message });
      });
  }

  /** R132-MU2 — the mount probe: ONE question to the native side. When the
   * manager is idle but a transfer is live (the JS state was lost to a
   * reload-class desync while OkHttp kept streaming), adopt it — the
   * re-mounted screen shows the real progress instead of a blank menu, and
   * the sheet's Download tap can never error-toast a working download. */
  async probeNative(): Promise<void> {
    // Our own chain is fresher than any probe — and done/error mean the
    // native side is settled too (the manager's state and activeCall move
    // together for lifecycles we own).
    if (this.state.phase !== "idle") return;
    await this.adoptLiveTransfer();
  }

  /** Stop the live transfer. OUR handle's promise settles the state through
   * the "canceled" rejection; an ADOPTED transfer rejects no promise we
   * hold, so the native stop is the whole truth we get — the state settles
   * here. Best-effort, like the pre-R132 screen's cancel: a failed stop
   * leaves the transfer running and the state honestly still active. */
  async cancel(): Promise<void> {
    if (this.state.phase !== "active") return;
    if (this.handle !== null) {
      try {
        await this.handle.cancel();
      } catch {
        // The chain keeps the state honest: no rejection, no transition.
      }
      return;
    }
    try {
      await cancelAppUpdate(this.deps);
    } catch {
      // Best-effort here too — but an adopted transfer has no chain, so we
      // settle regardless: the user's stop is the terminal event we own.
    }
    this.detachAdopted();
    this.transition({ phase: "idle" }, { kind: "canceled" });
  }

  /** R130-D — discard the landed APK: the floor deletes the file, the
   * manager forgets the completed result (a failure propagates — the
   * screen's catch owns the toast, and the done state survives it). */
  async discard(): Promise<void> {
    const current = this.state;
    if (current.phase !== "done") return;
    await deleteDownloadedUpdate(current.result.path, this.deps);
    this.transition({ phase: "idle" }, { kind: "discarded" });
  }

  /** Hand the landed APK to the OS installer. Errors propagate (the screen
   * owns the toast + the grant re-probe); the done state deliberately
   * survives — the OS installer's confirm screen is the flow's owner now. */
  async install(): Promise<void> {
    const current = this.state;
    if (current.phase !== "done") return;
    await installAppUpdate(current.result.path, this.deps);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private floor(): InstallerFloor {
    return this.deps.installer ?? installerFloor;
  }

  /** The probe — belt-and-braces means exactly that: a failed probe answer
   * changes nothing (null), it never throws into the caller. */
  private async probeFloor(): Promise<NativeDownloadState | null> {
    try {
      return await this.floor().getDownloadState();
    } catch {
      return null;
    }
  }

  /** Adopt whatever the probe finds. Called from the mount probe (state
   * idle) and from the "busy" classification (state active with a dead
   * handle — the optimistic start that never became ours). */
  private async adoptLiveTransfer(): Promise<void> {
    const probe = await this.probeFloor();
    if (!probe || !probe.active) {
      // Nothing live (or the probe failed): settle any optimistic active
      // state the busy rejection left behind — quietly, with no terminal
      // event to toast (nobody canceled; nothing failed on OUR say-so).
      if (this.state.phase === "active" && this.handle === null) {
        this.detachAdopted();
        this.transition({ phase: "idle" }, { kind: "reset" });
      }
      return;
    }
    const url = probe.url ?? "";
    const asset = this.assetForUrl(url, probe);
    this.handle = null;
    this.detachAdopted();
    this.transition(
      {
        phase: "active",
        asset,
        received: probe.received,
        total: probe.total > 0 ? probe.total : (asset.size ?? 0),
        startedAt: this.now(),
      },
      { kind: "progress" },
    );
    // The adopted transfer's live wire: progress events on ITS url (the
    // probe's url — whichever leg, anonymous or token, is actually running).
    this.adoptedUnsub = this.floor().onProgress(url, (ev) => {
      if (this.state.phase !== "active") return;
      this.transition(
        {
          ...this.state,
          received: ev.received,
          total: ev.total > 0 ? ev.total : this.state.total,
        },
        { kind: "progress" },
      );
      if (ev.fraction >= 1) {
        // The native completion emit (fraction 1.0 fires exactly once, on
        // the success path, after activeCall is already null). An adopted
        // transfer's result promise belongs to a dead closure — the cached
        // APK's PATH is unknowable from here — so the honest end is a quiet
        // reset to idle. Lifecycles the manager OWNS mint the done state
        // through their own chain; this is only the reload-class desync's
        // landing.
        this.detachAdopted();
        this.transition({ phase: "idle" }, { kind: "reset" });
      }
    });
  }

  /** The adopted transfer's asset — the remembered one when the probe's url
   * matches either of its legs (the common case: OUR download, its JS state
   * lost); else an honest minimal asset synthesized from the url itself. */
  private assetForUrl(url: string, probe: NativeDownloadState): ApkAsset {
    const remembered = this.lastAsset;
    if (
      remembered !== null &&
      (remembered.browserDownloadUrl === url || remembered.url === url)
    ) {
      return remembered;
    }
    return {
      url,
      browserDownloadUrl: url,
      name: url.split("/").pop() || "update.apk",
      size: probe.total > 0 ? probe.total : null,
    };
  }

  private detachAdopted(): void {
    if (this.adoptedUnsub !== null) {
      this.adoptedUnsub();
      this.adoptedUnsub = null;
    }
  }

  private transition(next: DownloadState, notice: DownloadNotice): void {
    this.state = next;
    // Snapshot the set — a listener unsubscribing mid-notification is safe.
    for (const listener of [...this.listeners]) {
      listener(next, notice);
    }
  }
}

/** THE manager — module scope, process lifetime: the native floor's own
 * lifetime class, which is the whole point (a back-navigation mid-download
 * changes nothing; a re-mount renders the live state). */
export const downloadManager = new DownloadManager();
