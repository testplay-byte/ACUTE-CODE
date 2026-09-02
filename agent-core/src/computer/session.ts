/**
 * ROUND-61 (R61): the singleton ControlSession — doc 01 §4 + doc 03.
 *
 * Owns: the snapshot store (state_id → immutable snapshot, keep-last-8,
 * TTL 120 s, CONSUMED after any element write — doc 03 §1), the frame
 * registry (frame_id → capture-time window state, staleness key for
 * coordinate actions, keep-last-8, max age 10 s), held-button ownership,
 * the kill switch (enforced, not advisory — doc 08 §2), and the monitor
 * ring (stats + newest-first events for the owner's mini-window directive:
 * "in a mini window it will show the details and their stats while the
 * agent is using computers").
 *
 * One session per sidecar process (the doc's singleton rule). resetForTests
 * is the only reset path — production never resets mid-flight.
 */
import type {
  ComputerUseEvent,
  ComputerUseEventKind,
  ComputerUseSessionState,
  FrameInfo,
  RasterMeta,
  Snapshot,
} from "./types.js";

const SNAPSHOT_KEEP = 8;
const SNAPSHOT_TTL_MS = 120_000;
const FRAME_KEEP = 8;
export const MAX_FRAME_AGE_MS = 10_000;
const EVENT_RING_CAP = 200;

interface StoredSnapshot {
  snapshot: Snapshot;
  consumed: boolean;
}

interface HeldButton {
  scope: { pid: number; windowId: number };
  /** Where the press landed (global) — the kill-switch release point. */
  point: { x: number; y: number };
}

export class ComputerSession {
  private snapshots = new Map<string, StoredSnapshot>();
  private frames = new Map<string, FrameInfo>();
  private nextSnapshotId = 0;
  private nextFrameId = 0;
  private nextEventSeq = 0;
  private events: ComputerUseEvent[] = [];
  private killSwitch = false;
  private held: HeldButton | null = null;
  private startedAt: number | null = null;
  private stats = {
    actionsSent: 0,
    actionsRefused: 0,
    observations: 0,
    visionCalls: 0,
  };
  private backendKind: string = "unknown";
  private stopReason: string | null = null;

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  /** Implicit session open on the first action/observation (doc 01 §4). */
  ensureStarted(backendKind: string): void {
    this.backendKind = backendKind;
    if (this.startedAt === null) {
      this.startedAt = Date.now();
      this.killSwitch = false;
      this.stopReason = null;
      this.stats = { actionsSent: 0, actionsRefused: 0, observations: 0, visionCalls: 0 };
      this.record("session_start", "Computer-control session started", undefined, {
        backend: backendKind,
      });
    }
  }

  /**
   * The kill switch (stop_computer_control). Enforced: every subsequent
   * call is refused with kill_switch_active. Releases a button held by
   * THIS session (the only sanctioned auto-release). Returns the release
   * point so the backend can send the physical mouse-up.
   */
  stop(reason: string): { releasedHeld: { point: { x: number; y: number } } | null } {
    this.killSwitch = true;
    this.stopReason = reason;
    const released = this.held ? { point: this.held.point } : null;
    this.held = null;
    this.record("session_stop", `Session stopped: ${reason}`, undefined, { releasedHeld: !!released });
    return { releasedHeld: released };
  }

  isKillSwitchActive(): boolean {
    return this.killSwitch;
  }

  active(): boolean {
    return this.startedAt !== null && !this.killSwitch;
  }

  /* ── held button ownership (doc 08 §2) ───────────────────────────────── */

  holdButton(scope: { pid: number; windowId: number }, point: { x: number; y: number }): void {
    this.held = { scope, point };
  }

  /** Only the owner (this session, after a successful down) may release. */
  takeHeldForRelease(): HeldButton | null {
    return this.held;
  }

  clearHeld(): void {
    this.held = null;
  }

  hasHeld(): boolean {
    return this.held !== null;
  }

  /* ── snapshots (doc 03 §1) ───────────────────────────────────────────── */

  registerSnapshot(snapshot: Omit<Snapshot, "stateId" | "createdAt">): Snapshot {
    const stateId = `s-${++this.nextSnapshotId}`;
    const full: Snapshot = {
      ...snapshot,
      stateId,
      createdAt: Date.now(),
    };
    this.snapshots.set(stateId, { snapshot: full, consumed: false });
    // Prune AFTER the insert so the cap is EXACT (pruning before left
    // keep+1 live — a test caught it).
    this.pruneSnapshots();
    this.stats.observations += 1;
    return full;
  }

  getSnapshot(stateId: string): StoredSnapshot | undefined {
    return this.snapshots.get(stateId);
  }

  /** Any element WRITE consumes the token (doc 03 §1 — supersession). */
  markConsumed(stateId: string): void {
    const stored = this.snapshots.get(stateId);
    if (stored) stored.consumed = true;
  }

  private pruneSnapshots(): void {
    const now = Date.now();
    for (const [id, stored] of this.snapshots) {
      if (now - stored.snapshot.createdAt > SNAPSHOT_TTL_MS) this.snapshots.delete(id);
    }
    while (this.snapshots.size > SNAPSHOT_KEEP) {
      // Evict the OLDEST non-consumed snapshot first (consumed ones are
      // already dead tokens; keep them until TTL for honest refusal ids).
      const oldest = [...this.snapshots.entries()]
        .filter(([, s]) => !s.consumed)
        .sort((a, b) => a[1].snapshot.createdAt - b[1].snapshot.createdAt)[0];
      if (!oldest) break;
      this.snapshots.delete(oldest[0]);
    }
  }

  /* ── frames (doc 03 §4.1) ────────────────────────────────────────────── */

  registerFrame(raster: { width: number; height: number; scale: number; origin: { x: number; y: number } }, captureScope: FrameInfo["captureScope"], ownerAtCapture: FrameInfo["ownerAtCapture"], displayIndex: number): { frameId: string; meta: RasterMeta } {
    const frameId = `f-${++this.nextFrameId}`;
    const frame: FrameInfo = {
      frameId,
      displayIndex,
      origin: raster.origin,
      scale: raster.scale,
      size: { w: raster.width, h: raster.height },
      capturedAt: Date.now(),
      captureScope,
      ownerAtCapture,
    };
    this.frames.set(frameId, frame);
    // Prune AFTER the insert — the cap is exact (see registerSnapshot).
    this.pruneFrames();
    return {
      frameId,
      meta: { frameId, width: raster.width, height: raster.height, scale: raster.scale },
    };
  }

  getFrame(frameId: string): FrameInfo | undefined {
    return this.frames.get(frameId);
  }

  /** The transport's latest actionable raster (doc 03 §4.1 rule 1). */
  latestFrame(): FrameInfo | undefined {
    let latest: FrameInfo | undefined;
    for (const f of this.frames.values()) {
      if (latest === undefined || f.capturedAt > latest.capturedAt) latest = f;
    }
    return latest;
  }

  frameIsFresh(frame: FrameInfo, now = Date.now()): boolean {
    return now - frame.capturedAt <= MAX_FRAME_AGE_MS;
  }

  private pruneFrames(): void {
    const now = Date.now();
    for (const [id, f] of this.frames) {
      if (now - f.capturedAt > MAX_FRAME_AGE_MS * 3) this.frames.delete(id);
    }
    while (this.frames.size > FRAME_KEEP) {
      const oldest = [...this.frames.entries()].sort(
        (a, b) => a[1].capturedAt - b[1].capturedAt,
      )[0];
      if (!oldest) break;
      this.frames.delete(oldest[0]);
    }
  }

  /** Image px → global pt (doc 03 §4 — the server owns the transform). */
  imageToGlobal(frame: FrameInfo, x: number, y: number): { x: number; y: number } {
    return {
      x: frame.origin.x + Math.round(x / frame.scale),
      y: frame.origin.y + Math.round(y / frame.scale),
    };
  }

  /* ── stats + the monitor ring ────────────────────────────────────────── */

  record(kind: ComputerUseEventKind, label: string, tool?: string, detail?: Record<string, unknown>): ComputerUseEvent {
    const event: ComputerUseEvent = {
      seq: ++this.nextEventSeq,
      ts: Date.now(),
      kind,
      label,
      tool,
      detail,
    };
    this.events.unshift(event);
    if (this.events.length > EVENT_RING_CAP) this.events.length = EVENT_RING_CAP;
    return event;
  }

  countActionSent(): void {
    this.stats.actionsSent += 1;
  }

  countActionRefused(): void {
    this.stats.actionsRefused += 1;
  }

  countVisionCall(): void {
    this.stats.visionCalls += 1;
  }

  state(): ComputerUseSessionState {
    return {
      active: this.active(),
      killSwitch: this.killSwitch,
      backendKind: this.backendKind,
      startedAt: this.startedAt,
      // R61 close-out (docs-round drift fix): the stop reason rides the
      // state snapshot (null while running) — the monitor panel + the
      // mini window render it after the kill switch fires.
      stopReason: this.stopReason,
      stats: { startedAt: this.startedAt ?? 0, ...this.stats },
      events: [...this.events],
    };
  }

  stopReasonOrNull(): string | null {
    return this.stopReason;
  }

  /** Test-only reset (production sessions live with the process). */
  resetForTests(): void {
    this.snapshots.clear();
    this.frames.clear();
    this.events.length = 0;
    this.nextSnapshotId = 0;
    this.nextFrameId = 0;
    this.nextEventSeq = 0;
    this.killSwitch = false;
    this.held = null;
    this.startedAt = null;
    this.stopReason = null;
    this.stats = { actionsSent: 0, actionsRefused: 0, observations: 0, visionCalls: 0 };
    this.backendKind = "unknown";
  }
}

/** The process singleton (doc 01 §4 — one control session per host). */
let session: ComputerSession | null = null;

export function getComputerSession(): ComputerSession {
  if (session === null) session = new ComputerSession();
  return session;
}

/** Test hook: fresh singleton. */
export function resetComputerSessionForTests(): ComputerSession {
  if (session === null) session = new ComputerSession();
  session.resetForTests();
  return session;
}
