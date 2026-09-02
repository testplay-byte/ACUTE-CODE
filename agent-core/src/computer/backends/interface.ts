/**
 * ROUND-61 (R61): the CuaBackend protocol — doc 04-platform-backends.md §1.
 * The dispatcher is OS-agnostic; every OS implements THIS interface. The
 * backend must (doc 04 §6): verify app/window identity immediately before
 * every dispatch, verify activation postconditions and report the truth,
 * own the image↔global transforms, REFUSE (never degrade) when a capability
 * is missing, return structured refusals — never raw OS errors, and never
 * pop permission dialogs from tool code (probe only).
 *
 * Backends are COMMAND-CAPSULE based: every native call is expressed as an
 * opaque `run(cmd: CommandCapsule)` so the same code path is unit-testable
 * via command-construction snapshots (this sandbox is headless Linux — the
 * real GUI paths are exercised on the owner's machines) and injectable for
 * the dispatch tests (a fake backend).
 */
import type {
  AppInfo,
  AppRef,
  DisplayInfo,
  PermissionReport,
  Snapshot,
  WindowInfo,
} from "../types.js";

/** Which OS implementation is live (reported to the monitor + probes). */
export type CuaBackendKind = "linux" | "windows" | "macos" | "fake";

/** One native call: the argv + optional stdin, plus what it counts as. */
export interface CommandCapsule {
  /** Program to run (resolved via PATH or absolute). */
  program: string;
  args: string[];
  /** Text piped to stdin (PowerShell scripts, osascript sources). */
  stdin?: string;
  /** Timeout ms (default 15000; captures get more). */
  timeoutMs?: number;
}

/** A backend capability declaration — the honest matrix (doc 04 §2). */
export interface BackendCapabilities {
  a11yTree: boolean;
  backgroundElementPress: boolean;
  backgroundValueWrite: boolean;
  backgroundRawInput: boolean;
  windowScopedTyping: boolean;
  capture: boolean;
  clipboard: boolean;
  /** Raw input on Win/Linux generally needs the target foreground. */
  rawRequiresForeground: boolean;
  permissionGates: string[];
}

/** Result of running a capsule: exit code + trimmed stdout, never thrown. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** How the backend executes capsules (injected; the real one spawns, tests
 * capture or fake the results). */
export type RunCommand = (capsule: CommandCapsule) => Promise<RunResult>;

/** A captured raster: PNG bytes + its geometry. */
export interface Raster {
  pngBase64: string;
  width: number;
  height: number;
  /** image px per screen pt (1.0 physical, 2.0 retina, 1.5 hi-dpi). */
  scale: number;
  /** Global-screen origin of the raster's top-left pixel. */
  origin: { x: number; y: number };
}

export interface LaunchSpec {
  name?: string;
  bundleId?: string;
  pid?: number;
  url?: string;
  newInstance?: boolean;
  activate: boolean;
}

export interface LaunchOutcome {
  ok: boolean;
  pid?: number;
  /** Honest postcondition: did the app end up frontmost (activate=true)? */
  active?: boolean;
  error?: string;
}

export interface ActivationOutcome {
  ok: boolean;
  active: boolean;
}

/** One resolved element from hit-testing (backend-side, pre-index). */
export interface HitElement {
  kind: string;
  name: string;
  actionable: boolean;
  /** Global bounds, for coordinate mapping in the dispatcher. */
  bounds?: [number, number, number, number];
}

/** An element target as the backend receives it: the snapshot's recorded
 * (index, kind, name) — the backend re-walks the tree and VERIFIES the
 * element at that index still matches kind+name (our cross-process
 * replacement for holding live COM/AX refs: command capsules cannot keep
 * pointers alive, so identity verification IS the staleness check). */
export interface ElementDescriptor {
  index: number;
  kind: string;
  name: string;
}

/** The window an element action is scoped to — BOTH the OS window id and
 * the title (the Linux AT-SPI walker matches by title; Windows uses the
 * HWND; macOS the AX window). */
export interface WindowScope {
  windowId: number;
  title: string;
}

export interface CuaBackend {
  readonly kind: CuaBackendKind;
  capabilities(): BackendCapabilities;

  // enumeration
  listApps(run: RunCommand): Promise<AppInfo[]>;
  listWindows(run: RunCommand, app: AppRef): Promise<WindowInfo[]>;
  listDisplays(run: RunCommand): Promise<DisplayInfo[]>;

  // observation
  buildSnapshot(
    run: RunCommand,
    app: { pid: number; name?: string; bundleId?: string },
    window: WindowInfo,
    detail: "compact" | "full",
  ): Promise<Snapshot | { error: string; emptyTree: boolean }>;
  hitTest(run: RunCommand, globalPt: { x: number; y: number }): Promise<HitElement | null>;
  focusedElementName(run: RunCommand, pid: number): Promise<string | null>;

  // semantic actions (a11y) — background-safe
  pressElement(
    run: RunCommand,
    pid: number,
    window: WindowScope,
    element: ElementDescriptor,
  ): Promise<{ ok: boolean; error?: string; stale?: boolean }>;
  setValue(
    run: RunCommand,
    pid: number,
    window: WindowScope,
    element: ElementDescriptor,
    value: string,
  ): Promise<{ ok: boolean; error?: string; stale?: boolean }>;
  performAction(
    run: RunCommand,
    pid: number,
    window: WindowScope,
    element: ElementDescriptor,
    action: string,
  ): Promise<{ ok: boolean; error?: string; stale?: boolean }>;
  selectRange(
    run: RunCommand,
    pid: number,
    window: WindowScope,
    element: ElementDescriptor,
    start: number,
    length: number | null,
  ): Promise<{ ok: boolean; error?: string; stale?: boolean }>;

  // raw input
  rawClick(
    run: RunCommand,
    pt: { x: number; y: number },
    button: "left" | "right" | "middle",
    clickCount: 1 | 2 | 3,
    modifiers: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  rawScroll(
    run: RunCommand,
    pt: { x: number; y: number },
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<{ ok: boolean; error?: string }>;
  rawDrag(
    run: RunCommand,
    from: { x: number; y: number },
    to: { x: number; y: number },
    modifiers: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  rawButton(
    run: RunCommand,
    pt: { x: number; y: number },
    down: boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  rawKey(
    run: RunCommand,
    keys: string[],
    scope: { pid: number; windowId: number },
  ): Promise<{ ok: boolean; error?: string }>;
  typeText(
    run: RunCommand,
    text: string,
    scope: { pid: number; windowId: number },
  ): Promise<{ ok: boolean; error?: string }>;

  // app control
  launch(run: RunCommand, spec: LaunchSpec): Promise<LaunchOutcome>;
  activate(run: RunCommand, pid: number, windowId?: number): Promise<ActivationOutcome>;
  frontmostPid(run: RunCommand): Promise<number | null>;

  // capture
  captureDisplay(run: RunCommand, displayIndex: number): Promise<Raster | { error: string }>;
  /** Region capture (GLOBAL screen points) — the zoom + window-screenshot
   * path (scrot -a / CopyFromScreen rect / screencapture -R). */
  captureRegion(
    run: RunCommand,
    region: { x: number; y: number; w: number; h: number },
  ): Promise<Raster | { error: string }>;
  /** Current pointer position in GLOBAL points (null = unavailable). */
  cursorPosition(run: RunCommand): Promise<{ x: number; y: number } | null>;

  // clipboard
  readClipboard(run: RunCommand): Promise<string>;
  writeClipboard(run: RunCommand, text: string): Promise<{ ok: boolean; error?: string }>;

  // health (probe only — NEVER pops dialogs)
  probePermissions(run: RunCommand): Promise<PermissionReport>;
}
