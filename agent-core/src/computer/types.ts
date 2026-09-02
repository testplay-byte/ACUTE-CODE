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
  name: string;
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
}

export type SurfaceKind =
  | "window"
  | "attached_dialog"
  | "open_panel"
  | "save_panel"
  | "menu";

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
  createdAt: number;
}

export interface RasterMeta {
  frameId: string;
  width: number;
  height: number;
  scale: number;
}

/* ── Frames (doc 03 §4.1) ──────────────────────────────────────────────────── */

export interface FrameInfo {
  frameId: string;
  displayIndex: number;
  origin: { x: number; y: number };
  scale: number;
  size: { w: number; h: number };
  capturedAt: number;
  captureScope: { kind: "display" | "window"; pid?: number; windowId?: number };
  ownerAtCapture: { pid: number; windowId: number };
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
  /** Element targets: matched | unverified. */
  targetVerificationStatus?: "matched" | "unverified";
}

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
