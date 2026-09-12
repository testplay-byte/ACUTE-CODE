/**
 * ROUND-61 (R61): the computer-use core data model — TypeScript shapes of
 * the uploaded spec (computer-use-docs 03-state-and-targets.md + 02 §0 +
 * 10 §3), kept dependency-free so every layer (backends, dispatch, tools,
 * server routes, the frontend monitor contract) can import it without
 * cycles. These are the CONTRACT types: the docs are authoritative, this
 * file is their code-side mirror (drift-guarded by computer tests).
 *
 * Two coordinate spaces exist and NEVER mix (doc 03 §4):
 *   · GLOBAL screen points — origin = primary display's virtual-desktop
 *     top-left (secondaries may have negative origins). Used by bounds,
 *     hit-testing, raw input. SERVER-side only.
 *   · IMAGE pixels — origin = top-left of the captured raster. The ONLY
 *     thing the agent ever submits (x, y copied unchanged from the latest
 *     returned image). The server owns image→global conversion.
 */

/* ── App references (doc 02 §0.2) ─────────────────────────────────────────── */

export interface AppRef {
  pid?: number;
  name?: string;
  /** macOS bundle id / Windows AUMID for packaged apps. */
  bundleId?: string;
  /** Scope to a SPECIFIC window (from list_windows / get_app_state). */
  windowId?: number;
}

export interface AppInfo {
  /** The window TITLE of the app's main (largest) window — NOT the exe name. */
  name: string;
  /** R64-a: the OS process/executable name (Windows: ProcessName, e.g.
   * "notepad") — the second resolution key for app refs ("Untitled - Notepad"
   * never exact-matches a model's "Notepad"; "notepad" does). */
  processName?: string;
  bundleId?: string;
  pid: number;
  active: boolean;
}

export interface WindowInfo {
  windowId: number;
  title: string;
  /** [x, y, w, h] in GLOBAL screen points. */
  bounds: [number, number, number, number];
  main: boolean;
  focused: boolean;
}

export interface DisplayInfo {
  /** 1-based. */
  index: number;
  bounds: [number, number, number, number];
  main: boolean;
}

/* ── Targets (doc 02 §0.1) ─────────────────────────────────────────────────── */

export type Target =
  | { type: "element"; stateId: string; index: number }
  | { type: "coordinate"; x: number; y: number; frameId?: string };

export type Strategy = "auto" | "a11y" | "event";

/** `none` (default) | `compact` | `full` — request fresh state in-reply. */
export type ReturnState = "none" | "compact" | "full";

/* ── Snapshots & elements (doc 03 §1–2) ───────────────────────────────────── */

export type ElementKind =
  | "window"
  | "menuitem"
  | "button"
  | "text"
  | "textfield"
  | "combobox"
  | "checkbox"
  | "slider"
  | "tab"
  | "row"
  | "image"
  | "pane"
  | "scrollbar";

export type ElementFlag = "pressable" | "editable" | "has_menu" | "focused";

/**
 * R93 (the computer-use v2 rework): the 11 ClickScope-style CATEGORIES — a
 * coarser, filter-friendly grouping than `kind` (one category per row in
 * the agent-facing filters and the scan's byCategory counts). Derived from
 * the kind by the walkers; "vision" is reserved for future CV detections.
 */
export type ElementCategory =
  | "button"
  | "link"
  | "input"
  | "menu"
  | "tab"
  | "list"
  | "check"
  | "slider"
  | "text"
  | "custom"
  | "vision";

/** R93: kind → category (the mapping the walkers and the store share). */
export function categoryOfKind(kind: ElementKind): ElementCategory {
  switch (kind) {
    case "button":
      return "button";
    case "menuitem":
      return "menu";
    case "textfield":
    case "combobox":
      return "input";
    case "checkbox":
      return "check";
    case "slider":
    case "scrollbar":
      return "slider";
    case "tab":
      return "tab";
    case "row":
      return "list";
    case "text":
    case "image":
      return "text";
    case "window":
    case "pane":
      return "custom";
  }
}

export interface Element {
  /** Valid ONLY within this snapshot's stateId. */
  index: number;
  kind: ElementKind;
  name: string;
  value?: string;
  flags: ElementFlag[];
  /** detail:"full" only — GLOBAL screen points. */
  bounds?: [number, number, number, number];
  /** detail:"full" only — valid names for perform_action. */
  actions?: string[];
  /** ── R93 (computer-use v2): the hierarchy + identity fields — all
   * OPTIONAL so pre-v2 snapshots and backends that cannot derive them stay
   * valid. See docs/architecture/COMPUTER-USE-V2.md §2.1. ── */
  /** Stable node key within this snapshot ("w7-412" — window ordinal + the
   * walk counter). NEVER the index (indexes are positional; keys survive
   * list edits within the same walk). */
  key?: string;
  /** The window root's key this element lives under. */
  windowKey?: string;
  /** The parent node's key; null on roots (the window). */
  parentKey?: string | null;
  /** ClickScope-style breadcrumb: "Settings › Advanced › Enable logging". */
  path?: string;
  /** Depth in the tree (window roots = 0). */
  treeDepth?: number;
  /** false = a structural container (never click it; walk its children). */
  interactive?: boolean;
  /** The coarse category (see ElementCategory). */
  category?: ElementCategory;
  /** WHICH clickability layer fired: "type" | "pattern" | "action" |
   * "msaa" | "focusable" — the walker records it for the store's `via`. */
  via?: string;
}

export type SurfaceKind =
  | "window"
  | "attached_dialog"
  | "open_panel"
  | "save_panel"
  | "menu";

/**
 * R93 (the computer-use v2 rework): the element-map delta riding every
 * registered observation — what changed in the app's UI since the last
 * registered scan (the model SEES UI churn like ClickScope's panel
 * subtitle "544 elements · +3/−1"). Defined here (the contract-types
 * module) and re-exported by element-map.ts so both import paths work.
 */
export interface MapDelta {
  /** Elements in this scan the registry had never seen (per app+window). */
  newCount: number;
  /** Registry rows for this app+window that this scan did NOT observe. */
  lostCount: number;
  /** The first N new element names (bounded — the model reads them). */
  newNames: string[];
  /** The registry's total for this app+window AFTER the fold (context). */
  knownTotal: number;
  /** R93 §2.4: ghost boxes dropped by verify-rects (bounds that were
   * demonstrably empty against the live raster). */
  droppedGhostCount?: number;
}

export interface Snapshot {
  stateId: string;
  app: { pid: number; name?: string; path?: string; bundleId?: string; title: string };
  window: { title: string; windowId: number; bounds: [number, number, number, number] };
  surface: {
    kind: SurfaceKind;
    actualWindowId: number;
    lifecycle: "stable" | "changing";
  };
  elements: Element[];
  /** Present when include_screenshot was set. */
  raster?: RasterMeta;
  /** R93: the element-map delta (only when the observation was registered
   * against the element map — pre-v2 snapshots and db-less contexts are
   * unaffected). */
  mapDelta?: MapDelta;
  createdAt: number;
}

export interface RasterMeta {
  frameId: string;
  width: number;
  height: number;
  scale: number;
}

/* ── Frames (doc 03 §4.1) ──────────────────────────────────────────────────── */

/**
 * R69 (task 4-c-1): WHO initiated a capture. "model" = a model-facing
 * capture tool (screenshot / zoom / get_app_state{includeScreenshot});
 * "auto_refresh" = a dispatch-INTERNAL refresh capture taken while
 * re-validating a stale coordinate frame; "observation" (task 4-c-2) = the
 * post-action capture that rides every mutating action's receipt. The
 * screenshot-spam guard counts ONLY "model" captures — internal refreshes
 * and post-action observations are not the model spamming.
 */
export type FrameProvenance = "model" | "auto_refresh" | "observation";

export interface FrameInfo {
  frameId: string;
  displayIndex: number;
  origin: { x: number; y: number };
  scale: number;
  size: { w: number; h: number };
  capturedAt: number;
  captureScope: { kind: "display" | "window"; pid?: number; windowId?: number };
  ownerAtCapture: { pid: number; windowId: number };
  /** R69: the capture initiator (see FrameProvenance). Always set by the
   * session's registerFrame (default "model" — the pre-R69 callers). */
  provenance: FrameProvenance;
  /** R69: the 64-bit perceptual aHash of the full raster (framehash.ts),
   * computed at registration. Undefined when the PNG could not be decoded —
   * every consumer degrades honestly (no comparison → no decision).
   * WIRE HAZARD (verified R69 4-c-2): bigint explodes JSON.stringify —
   * FrameInfo is NEVER serialized today (tool results carry RasterMeta; the
   * SSE/plugin frames carry frameId strings; receipts carry only ids and
   * plain scalars). If a future wire path needs the whole FrameInfo, map
   * aHash to a hex string FIRST. */
  aHash?: bigint;
}

/* ── Receipts (doc 02 §0.5) — never promises ───────────────────────────────── */

export const RECEIPT_SCHEMA_VERSION = "acute-cua-action-receipt-v1" as const;

export type DispatchStatus = "accepted" | "refused" | "possibly_sent";

export interface Receipt {
  schemaVersion: string;
  /** true = the action MAY have happened — never blindly replay. */
  actionSent: boolean;
  dispatchStatus: DispatchStatus;
  /** Server hint whether a fresh-target retry is sensible. */
  retryAction: boolean;
  /** Element targets: matched | unverified. R69 (task 4-c-2, ADDITIVE):
   * coordinate clicks upgrade "unverified" to "changed" | "unchanged" from
   * the post-action observation's screenChanged — the model learns whether
   * its click visibly registered without re-capturing. */
  targetVerificationStatus?: "matched" | "unverified" | "changed" | "unchanged";
  /** R69 (task 4-c-1, ADDITIVE): the stale-frame auto-refresh fired for this
   * action — a fresh frame was captured, registered, and compared before
   * the action ran. Absent on every non-refreshed action. */
  frameRefreshed?: boolean;
  /** R69: frameId of the auto-refresh capture (the frame the model can zoom
   * immediately). Present only with frameRefreshed. */
  refreshFrameId?: string;
  /** R69: full-frame aHash old-vs-new Hamming ≤ 8 — the whole screen is
   * unchanged, the model's coordinates are trustworthy as-is. */
  screenStable?: boolean;
  /** R69: the screen changed elsewhere but the TARGET REGION (element bounds
   * or the ±48px box around the point) is aHash-stable — present only when
   * screenStable is false and the action proceeded anyway. */
  targetRegionStable?: boolean;
  /** R69 (task 4-c-2, ADDITIVE): the post-action AUTO-OBSERVATION — a fresh
   * frame (provenance "observation") captured after the action settled,
   * what changed vs the pre-action frame, the focused element, and the
   * frontmost app's title. Present on every mutating-action receipt unless
   * returnState:"none" opted out or the capture failed (then the honest
   * {captureFailed:true} shape — the action itself never fails on it).
   * This is THE answer to the #1 field failure (screenshot-after-action
   * spam): the model reads the receipt instead of re-capturing. */
  observation?: ActionObservation;
  /** R69 (task 4-c-2, ADDITIVE): the element the point actually landed on,
   * from the hit-test that already runs on the coordinate-click path (the
   * model learns WHAT it clicked — "Search" edit, "Sign in" button). */
  hitElementName?: string;
}

/** R69 (task 4-c-2): the observation that rides a mutating action's receipt.
 * Every optional field is omitted when its source could not honestly
 * produce it (no pre-action frame to diff → no screenChanged; a helper
 * frontmost pid with no window → no activeApp) — never fabricated. */
export interface ObservationInfo {
  /** The post-action frame's id (registered, raster-cached — zoomable). */
  frameId: string;
  /** Full-frame aHash Hamming > 4 bits vs the pre-action frame. Undefined
   * when no comparable pre-state existed (first action, unhashable raster). */
  screenChanged?: boolean;
  /** The foreground element's a11y name (the focusedElementName readback
   * the key tool already uses), when the target owns the focus. */
  focusedElementName?: string;
  /** The frontmost app (pid + its MAIN WINDOW title), via the list_apps
   * path's active-app marker. */
  activeApp?: { pid: number; title: string };
  /** The frontmost title changed across the action (pre-read vs post). */
  titleChanged?: boolean;
}

/** The receipt's observation field: the honest info shape, or the honest
 * capture-failure marker (the action receipt itself still succeeds). */
export type ActionObservation = ObservationInfo | { captureFailed: true };

/* ── Refusals (doc 11) — named, self-teaching ─────────────────────────────── */

export type RefusalCode =
  | "accessibility_denied"
  | "screen_recording_denied"
  | "permission_denied"
  | "request_access_refused"
  | "host_policy_denied"
  | "could_not_launch"
  | "app_not_found"
  | "ambiguous_app_ref"
  | "invalid_window_id"
  | "frontmost_pid_mismatch"
  | "foreground_required"
  | "uipi_blocked"
  | "targetless_input_refused"
  | "capability_fail_closed"
  | "element_stale"
  | "frame_stale"
  | "frame_changed"
  | "screen_unchanged"
  | "occlusion_owner_mismatch"
  | "raster_out_of_bounds"
  | "kill_switch_active"
  | "computer_use_disabled"
  | "vision_disabled"
  | "unsupported_on_backend";

export interface Refusal {
  error: RefusalCode;
  message: string;
  /** The prescribed recovery (doc 11's template: what/why/nothing-sent/next). */
  recovery?: string;
  payload?: Record<string, unknown>;
}

/** Tool results are EITHER a receipt (+optional observation) or a refusal. */
export type ToolOutcome =
  | { kind: "receipt"; receipt: Receipt; observation?: Snapshot }
  | { kind: "refusal"; refusal: Refusal };

/* ── Permissions probe (doc 02 §1.10) ─────────────────────────────────────── */

export type CapabilityStatus = "granted" | "denied" | "stale" | "unavailable";

export interface PermissionReport {
  accessibility: CapabilityStatus;
  screenCapture: CapabilityStatus;
  backendKind: string;
  notes?: string[];
}

/* ── The monitor event ring (owner's mini-window directive) ───────────────── */

export type ComputerUseEventKind =
  | "session_start"
  | "session_stop"
  | "observe"
  | "intent"
  | "action"
  | "refusal"
  | "vision"
  | "wait";

export interface ComputerUseEvent {
  seq: number;
  ts: number;
  kind: ComputerUseEventKind;
  /** Short human line — what the agent is about to do / did / was refused. */
  label: string;
  tool?: string;
  detail?: Record<string, unknown>;
}

export interface ComputerUseSessionStats {
  startedAt: number;
  actionsSent: number;
  actionsRefused: number;
  observations: number;
  visionCalls: number;
}

export interface ComputerUseSessionState {
  active: boolean;
  killSwitch: boolean;
  backendKind: string;
  startedAt: number | null;
  /** R61 close-out (docs-round drift fix): WHY the session stopped (the
   * kill-switch reason) — null while running/never stopped. The monitor UI
   * + the api.ts client expect it. */
  stopReason: string | null;
  stats: ComputerUseSessionStats;
  /** Newest-first ring (capped) for the monitor UI. */
  events: ComputerUseEvent[];
}

/* ── Vision relay (owner's separate-model directive) ───────────────────────── */

export type VisionMode = "off" | "separate" | "main";

export interface VisionRequest {
  /** Base64 PNG of the raster to describe. */
  imageBase64: string;
  /** What to look for — forwarded as the instruction to the vision model. */
  instruction: string;
}

export interface VisionResult {
  text: string;
  model: string;
  provider: string;
  mode: Exclude<VisionMode, "off">;
  ms: number;
}
