/**
 * ROUND-61 (R61): the DISPATCHER — doc 07-dispatch-and-recovery.md. The
 * brain of the computer-use server: given a tool call, resolve the target,
 * run the universal pre-dispatch gates, route through the master matrix
 * (a11y semantic vs raw vs fail-closed), wrap the outcome in a receipt
 * (never a promise), and journal every call.
 *
 * Universal gates (doc 07 §2): killSwitch → session liveness → scope
 * identity → foreground rule (raw on Win/Linux) → held-button consistency.
 *
 * Design notes vs the doc, honestly stated:
 *   · Element staleness is enforced by (a) snapshot supersession (consumed
 *     after any element write) + (b) the backend's identity re-verification
 *     (index → kind+name match) — command capsules cannot hold COM refs.
 *   · Occlusion checks are approximated by owner-scope verification: the
 *     frontmost pid at dispatch time must match the frame's owner pid for
 *     raw paths on Windows/Linux (the foreground gate doubles as the
 *     occlusion guard); macOS rides AX's own scoping.
 *   · `get_app_state` re-observation is the only path to fresh tokens.
 *
 * ROUND-67 (R67-C — the owner's live Windows field report):
 *   · resolveAppRef RETRIES a failed-empty list_apps ONCE before the tier-5
 *     app_not_found, and that refusal's payload gains `probeNote` (the
 *     backend's failure diagnostics) so the agent sees WHY the list is
 *     empty instead of a blind dead-end.
 *   · A resolved pid that owns NO accessible window (a live WebView2
 *     renderer, for example) refuses with the honest helper-process
 *     message — "no running application matches" was misleading for a
 *     live process.
 *   · toolKey splits chords with the plus-preserving splitter and, after a
 *     successful key press, reads back the FOREGROUND element name
 *     (focusedElementName) into the receipt as `focused` — the owner's
 *     Tab-walk element-discovery technique (key "tab" → receipt says what
 *     is now focused). Best-effort: backends that cannot read it return
 *     null and the field is omitted; the key action itself never fails on
 *     a readback failure.
 *
 * ROUND-68 (R68-C — the owner's v0.67.0 live report): FRONTMOST
 * AUTO-RETRY. Edge churned the foreground (our activate verified INACTIVE)
 * and every raw-input tool then REFUSED frontmost_pid_mismatch — the
 * self-teaching recovery the refusal text preached ("activate, then retry
 * once") is now performed AUTOMATICALLY by withForegroundRetry: gate
 * mismatch or a script-level FRONTMOST_MISMATCH error activates the target
 * (the backend's escalated activate ladder) and retries the action ONCE;
 * only when the activation itself fails does the honest refusal remain.
 *
 * ROUND-69 (R69, task 4-c-1) — frame intelligence, two behaviors on the
 * perceptual-hash primitive (framehash.ts):
 *   · STALE-FRAME AUTO-REFRESH: a COORDINATE-anchored pointer action
 *     (click/right/middle/double/triple, drag, scroll, mouse_move — NOT
 *     type/key/set_value, which ride the focus gate, not the frame) on a
 *     frame older than MAX_FRAME_AGE_MS no longer hard-fails frame_stale.
 *     Dispatch re-captures the frame's exact coverage (backend capture
 *     primitive, never a re-implementation), registers the fresh frame
 *     (provenance "auto_refresh" — zoomable immediately, invisible to the
 *     spam guard), and compares: full-frame aHash Hamming ≤ 8 → the screen
 *     is stable → the action PROCEEDS on the model's coordinates (receipt:
 *     frameRefreshed/refreshFrameId/screenStable). Otherwise the TARGET
 *     REGION (element bounds, or a ±48px box around the point) is compared:
 *     Hamming ≤ 6 → proceed (receipt: screenStable:false,
 *     targetRegionStable:true). Genuinely changed → the NEW frame_changed
 *     refusal carrying refreshFrameId (the fresh frame is registered, so
 *     the model zooms it and retries in ONE round-trip). A FAILED refresh
 *     capture falls back to the old frame_stale signal (never lose the
 *     failure).
 *   · SCREENSHOT-SPAM GUARD: the 3rd consecutive model-initiated capture
 *     (screenshot / zoom / get_app_state{includeScreenshot}) whose
 *     full-frame aHash is ≤ 4 bits from the previous registered raster —
 *     with no intervening mutating action — is refused screen_unchanged
 *     BEFORE registration (the raster is identical anyway). Resets: any
 *     mutating dispatch, a capture with Hamming > 4 (screen changed), or a
 *     foreground-app change (pid proxy — the detectable signal without a
 *     new backend primitive).
 *
 * ROUND-69 (R69, task 4-c-2) — AUTO-OBSERVATION RECEIPTS: the #1 field
 * failure was the model re-capturing a screenshot after EVERY action to see
 * what happened (5-25s per vision round-trip). Now every mutating action's
 * receipt AUTOMATICALLY carries a post-action observation: after the action
 * settles (OBSERVATION_SETTLE_MS), dispatch captures a fresh frame via the
 * existing display-capture primitive, registers it with provenance
 * "observation" (invisible to the spam guard — only "model" captures
 * count), diffs its aHash against the last frame registered BEFORE the
 * action (the pre-state is FREE: if 4-c-1's stale-frame auto-refresh just
 * captured, that refresh IS the pre-state), reads the focused element (the
 * same focusedElementName readback the key tool uses) and the frontmost
 * app's title (the list_apps path's active-app marker — titleChanged is the
 * pre-read vs post). The receipt gains `observation` {frameId,
 * screenChanged, focusedElementName?, activeApp, titleChanged}; a capture
 * failure reports {captureFailed:true} and NEVER fails the action itself.
 * OPT-OUT: returnState "none" skips it; "full" keeps the R61 UIA compose
 * (get_app_state); "compact" (the new DEFAULT for these tools) IS the
 * observation. Coordinate-click receipts upgrade targetVerificationStatus
 * "unverified" → "changed"/"unchanged" from screenChanged, and carry
 * hitElementName (the hit-test that already runs at the click site — the
 * model learns WHAT it clicked). wait() builds the same observation after
 * its sleep ("what changed while I waited"). Element targets now route for
 * middle_click and menu-less right_click (bounds → center → raw button).
 */
import type {
  ActionObservation,
  AppInfo,
  Element,
  FrameInfo,
  ObservationInfo,
  Receipt,
  Refusal,
  Snapshot,
  Target,
  ToolOutcome,
  WindowInfo,
} from "./types.js";
import { RECEIPT_SCHEMA_VERSION } from "./types.js";
import {
  ambiguousAppRef,
  appCandidates,
  appNotFound,
  capabilityFailClosed,
  elementStaleChanged,
  elementStaleSuperseded,
  frameChanged,
  frameStale,
  frontmostPidMismatch,
  invalidTarget,
  killSwitchActive,
  rasterOutOfBounds,
  refuse,
  screenUnchanged,
  targetlessInputRefused,
  invalidWindowId,
  type AppCandidate,
  type RefusalOutcome,
} from "./errors.js";
import { getComputerSession, MAX_FRAME_AGE_MS, type ComputerSession } from "./session.js";
import { hamming, hashFrame, hashRegion } from "./framehash.js";
import { appendAudit } from "./audit.js";
import type { CuaBackend, ElementDescriptor, EnumerationDiagnostics, RunCommand, WindowScope } from "./backends/interface.js";

export interface DispatcherOptions {
  backend: CuaBackend;
  run: RunCommand;
  /** Project root — where the audit journal lives. */
  root: string;
  /** Injected for tests; defaults to the process singleton. */
  session?: ComputerSession;
  /** When false, mutating tools refuse with host_policy_denied (observe-only
   * posture). Defaults true (the tools layer enforces the settings gate). */
  allowMutations?: boolean;
}

export type DispatchResult =
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: "receipt"; receipt: Receipt; observation?: Snapshot }
  | { kind: "refusal"; refusal: Refusal };

const MUTATING_TOOLS = new Set([
  "left_click", "right_click", "double_click", "triple_click", "middle_click",
  "mouse_move", "scroll", "left_click_drag", "left_mouse_down", "left_mouse_up",
  "type", "set_value", "select_text", "key", "hold_key", "perform_action",
  "write_clipboard", "open_application",
]);

/** R69 (task 4-c-2): the tools whose SENT receipts automatically carry the
 * post-action observation (the visually-consequential mutating set — the
 * task's exact list; mouse_move/hold_key/clipboard/launch are excluded:
 * they do not change on-screen state worth a 600ms+capture round-trip,
 * and they keep the legacy returnState opt-in semantics). */
const OBSERVATION_TOOLS = new Set([
  "left_click", "double_click", "triple_click", "right_click", "middle_click",
  "scroll", "type", "key", "set_value", "select_text", "left_click_drag",
]);

/** R69 (task 4-c-2): how long the dispatcher waits after an action before
 * capturing the post-action frame — animations, navigation repaints, and
 * focus churn need a moment to land, or the observation would faithfully
 * capture the PRE-action pixels. Exported for the pin tests; the accepted
 * latency cost (settle 600ms + capture ~150-300ms) replaces the 5-25s
 * model screenshot round-trip it exists to kill. Mutable per-dispatcher
 * via `observationSettleMs` (tests set 0 so the suite stays fast). */
export const OBSERVATION_SETTLE_MS = 600;

/* ── R69 (task 4-c-1): the frame-intelligence thresholds ──────────────────
 * Both behaviors compare the 64-bit aHash (framehash.ts). Full-frame ≤ 8
 * of 64 bits: the screen as a whole is stable. Target-region ≤ 6 of 64:
 * the pixels AROUND THE TARGET are stable even though the screen moved
 * elsewhere. Spam guard ≤ 4 of 64: near-identical re-capture. The ±48px
 * box around the click point is the "target region" for coordinate
 * targets without element bounds — 48px covers a button + label with
 * margin, without swallowing a whole toolbar. */
const REFRESH_FULL_STABLE_HAMMING = 8;
const REFRESH_REGION_STABLE_HAMMING = 6;
const REFRESH_REGION_PAD_PX = 48;
const SPAM_IDENTICAL_HAMMING = 4;
const SPAM_CONSECUTIVE_LIMIT = 3;
/** R69 (task 4-c-2): the auto-observation's changed threshold — a
 * full-frame Hamming > 4 bits vs the pre-action frame (the spam guard's
 * near-identical bar) means the screen VISIBLY changed. */
const OBSERVATION_CHANGED_HAMMING = 4;

/** The R69 auto-refresh outcome that rides the receipt (types.ts Receipt). */
export interface FrameRefreshInfo {
  frameId: string;
  screenStable: boolean;
  targetRegionStable?: boolean;
}

function receipt(
  actionSent: boolean,
  dispatchStatus: Receipt["dispatchStatus"],
  retryAction = false,
  targetVerificationStatus?: Receipt["targetVerificationStatus"],
): Receipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    actionSent,
    dispatchStatus,
    retryAction,
    ...(targetVerificationStatus !== undefined ? { targetVerificationStatus } : {}),
  };
}

/** Modifier string → normalized array ("ctrl+shift" → ["ctrl","shift"]). */
export function parseModifiers(mods: unknown): string[] {
  if (typeof mods !== "string" || mods.trim() === "") return [];
  return mods
    .split("+")
    .map((m) => m.trim().toLowerCase())
    .filter((m) => ["ctrl", "shift", "alt", "super", "cmd", "option", "meta"].includes(m))
    .map((m) => (m === "cmd" || m === "meta" ? "super" : m === "option" ? "alt" : m));
}

/**
 * R67-C: split a key chord on '+', PRESERVING a literal plus — '++' is the
 * plus key (the escape convention) and 'ctrl++' is ctrl+plus. The old
 * split+filter-empty dropped every empty segment, so '++' resolved to
 * NOTHING and 'ctrl++' silently became just "ctrl".
 * Named tokens are lowercased for the backends' tables; a '+' token stays
 * verbatim (R68-C: the Windows composeVkChord maps it to VK_OEM_PLUS
 * 0xBB; Linux joins the tokens back into one xdotool chord string exactly
 * as before for ordinary chords like "ctrl+a").
 */
export function splitKeyChord(text: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "+") {
      if (i + 1 < text.length && text[i + 1] === "+") {
        // '++' = an escaped plus key token.
        if (cur.trim() !== "") tokens.push(cur.trim().toLowerCase());
        cur = "";
        tokens.push("+");
        i += 2;
        continue;
      }
      // A separator: close the current token.
      if (cur.trim() !== "") tokens.push(cur.trim().toLowerCase());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim() !== "") tokens.push(cur.trim().toLowerCase());
  return tokens;
}

/**
 * R67-C: attach the backend's failed-empty diagnostics note to an
 * app_not_found refusal as `probeNote` — only when the list is EMPTY and a
 * failure note exists (a non-empty list needs no explanation; a benign
 * empty has no note). The agent then sees WHY there is no app list instead
 * of a blind dead-end.
 */
function withProbeNote(
  outcome: RefusalOutcome,
  apps: AppInfo[],
  diagnostics: EnumerationDiagnostics | undefined,
): Refusal {
  if (apps.length > 0 || diagnostics?.note === undefined) return outcome.refusal;
  return {
    ...outcome.refusal,
    payload: { ...(outcome.refusal.payload ?? {}), probeNote: diagnostics.note },
  };
}

export class ComputerDispatcher {
  readonly backend: CuaBackend;
  private readonly run: RunCommand;
  private readonly root: string;
  private readonly session: ComputerSession;
  private readonly allowMutations: boolean;
  private selectedDisplay = 1;
  /** Latest raster PNGs by frameId (for zoom + vision; capped at 3). */
  private rasterCache = new Map<string, string>();
  /** R69 (task 4-c-1): consecutive near-identical MODEL-initiated captures
   * (screenshot-spam guard). Auto-refresh captures never touch it; see
   * guardModelCapture for every reset condition. */
  private consecutiveIdenticalCaptures = 0;
  /** R69: the foreground pid seen at the last model capture (the app-switch
   * reset signal — a pid proxy for "foreground app title change", the
   * detectable identity without a new backend primitive). */
  private lastCaptureForegroundPid: number | null = null;
  /** R69 (task 4-c-2): the post-action settle before the observation
   * capture (see OBSERVATION_SETTLE_MS). Public + mutable so the test
   * suite can run hundreds of dispatches without each paying the real
   * 600ms — production never touches it. */
  observationSettleMs = OBSERVATION_SETTLE_MS;

  constructor(opts: DispatcherOptions) {
    this.backend = opts.backend;
    this.run = opts.run;
    this.root = opts.root;
    this.session = opts.session ?? getComputerSession();
    this.allowMutations = opts.allowMutations ?? true;
  }

  /** The single entry point every tool call flows through (audit + gates). */
  async dispatch(tool: string, args: Record<string, unknown>): Promise<DispatchResult> {
    this.session.ensureStarted(this.backend.kind);
    // R69: ANY mutating dispatch resets the screenshot-spam counter — the
    // model acted between captures, so the next capture is a legitimate
    // re-observation of a screen that may have changed (attempt-level: a
    // refused mutation resets too — generous, never over-refusing).
    if (MUTATING_TOOLS.has(tool)) this.consecutiveIdenticalCaptures = 0;
    // R69 (task 4-c-2): the PRE-STATE for the auto-observation — the
    // frontmost title read BEFORE the action (titleChanged's baseline; the
    // pre-FRAME needs no capture: the last registered frame IS the
    // pre-state, read after route so 4-c-1's auto-refresh capture counts as
    // it). Read only when the observation will actually run: the tool is
    // observation-capable AND return_state is the default/"compact" ("none"
    // opts out entirely, "full" asks for the UIA compose instead) AND
    // (posture honesty) not a mutation the observe-only posture will refuse.
    const requestedReturnState = args["returnState"] ?? args["return_state"];
    const autoObserve =
      OBSERVATION_TOOLS.has(tool) &&
      (requestedReturnState === undefined || requestedReturnState === "compact") &&
      !(MUTATING_TOOLS.has(tool) && !this.allowMutations);
    const preTitle = autoObserve ? await this.frontmostAppState() : null;
    const started = Date.now();
    const result = await this.route(tool, args);
    // R69 (task 4-c-2): attach the auto-observation to SENT action receipts
    // (refusals carry none — nothing happened). Attached BEFORE the audit
    // journal line so the journal records the receipt the model actually
    // received; the observation NEVER fails the action (capture failures
    // report {captureFailed:true}).
    if (autoObserve && result.kind === "receipt" && result.receipt.actionSent) {
      await this.attachAutoObservation(tool, args, result, preTitle);
    }
    const ms = Date.now() - started;
    // Journal every call (redaction inside audit.ts; failures fail-soft).
    appendAudit(this.root, {
      ts: started,
      sessionStartedAt: this.session.state().startedAt,
      tool,
      args,
      outcome:
        result.kind === "refusal"
          ? { kind: "refusal", refusal: result.refusal }
          : result.kind === "receipt"
            ? { kind: "receipt", receipt: result.receipt }
            : { kind: "receipt", receipt: receipt(false, "refused") },
    });
    if (result.kind === "receipt" && result.receipt.actionSent) {
      this.session.countActionSent();
    } else if (result.kind === "refusal") {
      this.session.countActionRefused();
    }
    // Monitor events for the ring (owner's mini-window).
    if (result.kind === "refusal") {
      this.session.record("refusal", `${tool}: ${result.refusal.message.split(".")[0]}`, tool, {
        code: result.refusal.error,
        ms,
      });
    } else if (result.kind === "receipt" && result.receipt.actionSent) {
      this.session.record("action", `${tool} dispatched (accepted)`, tool, { ms });
    }
    // ROUND-61: return_state (doc 02 §0.4) — when the next step needs fresh
    // UI state, the receipt carries a compact/full observation composed
    // from the action's scope. Only for SENT actions (refusals don't).
    // R69 (task 4-c-2): for the OBSERVATION_TOOLS, "full" keeps this UIA
    // compose while "compact" is now the raster observation attached above
    // (the default) — the non-observation tools keep the legacy opt-in
    // semantics (explicit compact/full composes a Snapshot).
    if (
      result.kind === "receipt" &&
      result.receipt.actionSent &&
      (requestedReturnState === "full" ||
        (requestedReturnState === "compact" && !OBSERVATION_TOOLS.has(tool)))
    ) {
      const detail = requestedReturnState === "full" ? "full" : "compact";
      const appRef = this.deriveAppRef(tool, args);
      if (appRef !== null) {
        const observation = await this.route("get_app_state", { appRef, detail });
        if (observation.kind === "data") {
          return { ...result, observation: observation.data["state"] as Snapshot };
        }
      }
    }
    return result;
  }

  /** The app scope of an action, for return_state observation. */
  private deriveAppRef(tool: string, args: Record<string, unknown>): Record<string, unknown> | null {
    if (tool === "open_application") {
      const app = (args["app"] ?? {}) as Record<string, unknown>;
      return app["pid"] !== undefined || app["name"] !== undefined || app["bundleId"] !== undefined ? app : null;
    }
    const appRef = args["appRef"] ?? args["app_ref"];
    if (typeof appRef === "object" && appRef !== null) return appRef as Record<string, unknown>;
    const target = args["target"];
    if (typeof target === "object" && target !== null) {
      const t = target as Record<string, unknown>;
      if (t["type"] === "element" && typeof t["stateId"] === "string") {
        const stored = this.session.getSnapshot(t["stateId"]);
        if (stored !== undefined) return { pid: stored.snapshot.app.pid };
      }
    }
    return null;
  }

  /* ── routing ─────────────────────────────────────────────────────────── */

  private async route(tool: string, args: Record<string, unknown>): Promise<DispatchResult> {
    if (this.session.isKillSwitchActive()) return killSwitchActive();
    if (MUTATING_TOOLS.has(tool) && !this.allowMutations) {
      return {
        kind: "refusal",
        refusal: {
          error: "host_policy_denied",
          message: `Observe-only posture: mutating tool ${tool} is refused.`,
          recovery: "The owner can change the posture in Settings → Computer Use (act or auto) to allow this action class.",
        },
      };
    }

    switch (tool) {
      // ── observe & resolve (read-only) ──
      case "list_apps": {
        const { apps, diagnostics } = await this.backend.listApps(this.run);
        // R64-a: diagnostics ride ONLY empty results (a non-empty list needs
        // no explanation; an empty one must be debuggable from the transcript).
        return {
          kind: "data",
          data: apps.length === 0 && diagnostics !== undefined ? { apps, diagnostics } : { apps },
        };
      }
      case "list_windows":
        return this.toolListWindows(args);
      case "list_displays": {
        const { displays, diagnostics } = await this.backend.listDisplays(this.run);
        return {
          kind: "data",
          data: displays.length === 0 && diagnostics !== undefined ? { displays, diagnostics } : { displays },
        };
      }
      case "switch_display":
        return this.toolSwitchDisplay(args);
      case "get_app_state":
        return this.toolGetAppState(args);
      // R66-2-d: server-side tree SEARCH (the Edge fix — see toolFindElements).
      case "find_elements":
        return this.toolFindElements(args);
      case "screenshot":
        return this.toolScreenshot(args);
      case "zoom":
        return this.toolZoom(args);
      case "cursor_position":
        return this.toolCursorPosition();
      case "request_access":
        return {
          kind: "data",
          data: {
            report: await this.backend.probePermissions(this.run),
            capabilities: this.backend.capabilities(),
          },
        };
      case "read_clipboard":
        return { kind: "data", data: { text: await this.backend.readClipboard(this.run) } };

      // ── launch & session ──
      case "open_application":
        return this.toolOpenApplication(args);
      case "stop_computer_control":
        return this.toolStopControl(args);
      case "wait":
        return this.toolWait(args);

      // ── pointer ──
      case "left_click":
        return this.toolClickLike(args, "left", 1);
      case "double_click":
        return this.toolClickLike(args, "left", 2);
      case "triple_click":
        return this.toolClickLike(args, "left", 3);
      case "middle_click":
        return this.toolClickLike(args, "middle", 1);
      case "right_click":
        return this.toolRightClick(args);
      case "mouse_move":
        return this.toolMouseMove(args);
      case "scroll":
        return this.toolScroll(args);
      case "left_click_drag":
        return this.toolDrag(args);
      case "left_mouse_down":
        return this.toolMouseButton(args, true);
      case "left_mouse_up":
        return this.toolMouseButton(args, false);

      // ── text & keyboard ──
      case "type":
        return this.toolType(args);
      case "set_value":
        return this.toolSetValue(args);
      case "select_text":
        return this.toolSelectText(args);
      case "key":
        return this.toolKey(args);
      case "hold_key":
        return this.toolHoldKey(args);

      // ── semantic ──
      case "perform_action":
        return this.toolPerformAction(args);

      // ── misc mutating ──
      case "write_clipboard":
        return this.toolWriteClipboard(args);

      default:
        return refuse(
          "capability_fail_closed",
          `Unknown computer-use tool '${tool}'.`,
          "Call tools/list for the live surface.",
        );
    }
  }

  /* ── target resolution (doc 07 §1) ───────────────────────────────────── */

  private resolveTarget(target: unknown): { ok: true; target: Target } | { ok: false; refusal: DispatchResult } {
    if (typeof target !== "object" || target === null) {
      return { ok: false, refusal: { kind: "refusal", refusal: invalidTarget("target must be an object").refusal } };
    }
    const t = target as Record<string, unknown>;
    if (t["type"] === "element") {
      const stateId = typeof t["stateId"] === "string" ? (t["stateId"] as string) : (t["state_id"] as string);
      const index = Number(t["index"]);
      if (typeof stateId !== "string" || !Number.isInteger(index) || index < 0) {
        return { ok: false, refusal: { kind: "refusal", refusal: invalidTarget("element target needs stateId + index").refusal } };
      }
      return { ok: true, target: { type: "element", stateId, index } };
    }
    if (t["type"] === "coordinate") {
      const x = Number(t["x"]);
      const y = Number(t["y"]);
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        return { ok: false, refusal: { kind: "refusal", refusal: invalidTarget("coordinate target needs integer x + y").refusal } };
      }
      return { ok: true, target: { type: "coordinate", x, y } };
    }
    return { ok: false, refusal: { kind: "refusal", refusal: invalidTarget("type must be 'element' or 'coordinate'").refusal } };
  }

  /**
   * Resolve the app_ref → {pid, name?} (doc 03 §3). R64-a: the TIERED
   * matcher — the owner's live failure was get_app_state("Notepad") →
   * app_not_found because "Notepad" never EXACT-matched the window title
   * "Untitled - Notepad". Tiers (first hit wins):
   *   1. exact pid (unchanged — never consults the list)
   *   2. exact window-title match (case-insensitive)
   *   3. exact processName match (e.g. "notepad" — AppInfo.processName, R64-a)
   *   4. unique substring/contains on title OR processName — exactly one
   *      resolves; several → ambiguous refusal LISTING the candidates
   *   5. none → app_not_found whose payload carries `runningApps` (capped)
   *      so the model picks the right pid and retries in one step.
   *
   * R67-C: a FAILED-EMPTY list (empty apps + a diagnostics note — e.g. the
   * owner's "the PowerShell session died before emitting JSON") is retried
   * ONCE before the tiers run; if the retry still comes back
   * empty-with-failure, the tier-5 refusal payload carries `probeNote`
   * (the note) so the agent sees WHY there is no list. A benign empty
   * (no note — a genuinely bare desktop) is not retried.
   */
  private async resolveAppRef(ref: unknown): Promise<
    { ok: true; app: { pid: number; name?: string; bundleId?: string } } | { ok: false; refusal: DispatchResult }
  > {
    if (typeof ref !== "object" || ref === null) {
      return { ok: false, refusal: { kind: "refusal", refusal: appNotFound("(no app_ref)").refusal } };
    }
    const r = ref as Record<string, unknown>;
    const pid = r["pid"] !== undefined ? Number(r["pid"]) : undefined;
    const name = typeof r["name"] === "string" ? (r["name"] as string) : undefined;
    const bundleId =
      typeof r["bundleId"] === "string"
        ? (r["bundleId"] as string)
        : typeof r["bundle_id"] === "string"
          ? (r["bundle_id"] as string)
          : undefined;
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
      return { ok: true, app: { pid, name, bundleId } };
    }
    let { apps, diagnostics } = await this.backend.listApps(this.run);
    if (apps.length === 0 && diagnostics?.note !== undefined) {
      const retried = await this.backend.listApps(this.run);
      apps = retried.apps;
      diagnostics = retried.diagnostics;
    }
    if (name !== undefined && name.trim() !== "") {
      const want = name.trim().toLowerCase();
      const describe = (list: AppInfo[]): AppCandidate[] => appCandidates(list);
      // Tier 2 — exact window title.
      const byTitle = apps.filter((a) => a.name.trim().toLowerCase() === want);
      if (byTitle.length === 1) return { ok: true, app: { pid: byTitle[0].pid, name: byTitle[0].name, bundleId } };
      if (byTitle.length > 1) {
        return { ok: false, refusal: { kind: "refusal", refusal: ambiguousAppRef(name, describe(byTitle)).refusal } };
      }
      // Tier 3 — exact processName.
      const byProcess = apps.filter((a) => a.processName !== undefined && a.processName.trim().toLowerCase() === want);
      if (byProcess.length === 1) return { ok: true, app: { pid: byProcess[0].pid, name: byProcess[0].name, bundleId } };
      if (byProcess.length > 1) {
        return { ok: false, refusal: { kind: "refusal", refusal: ambiguousAppRef(name, describe(byProcess)).refusal } };
      }
      // Tier 4 — unique substring on title OR processName.
      const partial = apps.filter(
        (a) =>
          a.name.toLowerCase().includes(want) ||
          (a.processName !== undefined && a.processName.toLowerCase().includes(want)),
      );
      if (partial.length === 1) return { ok: true, app: { pid: partial[0].pid, name: partial[0].name, bundleId } };
      if (partial.length > 1) {
        return { ok: false, refusal: { kind: "refusal", refusal: ambiguousAppRef(name, describe(partial)).refusal } };
      }
      // Tier 5 — nothing matched: the running apps ride the refusal.
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: withProbeNote(appNotFound(name, apps), apps, diagnostics) },
      };
    }
    if (bundleId !== undefined) {
      const matches = apps.filter((a) => a.bundleId === bundleId);
      if (matches.length === 1) return { ok: true, app: { pid: matches[0].pid, name, bundleId } };
      if (matches.length > 1) {
        return { ok: false, refusal: { kind: "refusal", refusal: ambiguousAppRef(bundleId, appCandidates(matches)).refusal } };
      }
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: withProbeNote(appNotFound(bundleId, apps), apps, diagnostics) },
      };
    }
    return {
      ok: false,
      refusal: {
        kind: "refusal",
        refusal: withProbeNote(appNotFound("(app_ref without pid/name/bundleId)", apps), apps, diagnostics),
      },
    };
  }

  /** Element freshness gate (doc 03 §6) + scope/window extraction. */
  private resolveElementScope(
    target: { type: "element"; stateId: string; index: number },
  ): { ok: true; snapshot: Snapshot; element: Element; window: WindowScope } | { ok: false; refusal: DispatchResult } {
    const stored = this.session.getSnapshot(target.stateId);
    if (stored === undefined) {
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: elementStaleChanged(target.stateId).refusal },
      };
    }
    if (stored.consumed) {
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: elementStaleSuperseded(target.stateId).refusal },
      };
    }
    const element = stored.snapshot.elements[target.index];
    if (element === undefined) {
      return { ok: false, refusal: { kind: "refusal", refusal: invalidTarget(`index ${target.index} is out of range in ${target.stateId}`).refusal } };
    }
    return {
      ok: true,
      snapshot: stored.snapshot,
      element,
      window: {
        windowId: stored.snapshot.window.windowId,
        title: stored.snapshot.window.title,
      },
    };
  }

  /** Coordinate freshness gate: frame binding + age + bounds (doc 03 §4/§6).
   *
   * R69: the HARD frame_stale fail here remains ONLY for the actions the
   * spec excludes from auto-refresh (set_value, left_mouse_down — they ride
   * the focus gate, not the frame) and for the no-frame/bounds errors that
   * no refresh can heal. The coordinate-anchored pointer tools (click
   * family, drag, scroll, mouse_move) resolve through
   * resolveCoordinateAction instead — staleness becomes auto-refresh. */
  private resolveCoordinate(
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
  ): { ok: true; frame: FrameInfo; global: { x: number; y: number } } | { ok: false; refusal: DispatchResult } {
    const frame =
      target.frameId !== undefined
        ? this.session.getFrame(target.frameId)
        : this.session.latestFrame();
    if (frame === undefined) {
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: frameStale(target.frameId ?? "latest", "no raster exists yet — take a screenshot first").refusal },
      };
    }
    if (!this.session.frameIsFresh(frame)) {
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: frameStale(frame.frameId, `captured ${Math.round((Date.now() - frame.capturedAt) / 1000)}s ago (max ${MAX_FRAME_AGE_MS / 1000}s)`).refusal },
      };
    }
    if (target.x < 0 || target.y < 0 || target.x >= frame.size.w || target.y >= frame.size.h) {
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: rasterOutOfBounds(target.x, target.y, frame.size.w, frame.size.h).refusal },
      };
    }
    return { ok: true, frame, global: this.session.imageToGlobal(frame, target.x, target.y) };
  }

  /**
   * R69 (task 4-c-1): the coordinate-anchored pointer tools' resolver — the
   * same binding/age/bounds rules as resolveCoordinate, but an AGED frame no
   * longer hard-fails: autoRefreshStaleFrame re-captures, registers the
   * fresh frame (provenance "auto_refresh"), and decides proceed vs
   * frame_changed by perceptual comparison. `elementBounds` (GLOBAL points,
   * detail:"full" element bounds) becomes the target region when present —
   * otherwise the region is the ±48px box around the action's own point.
   */
  private async resolveCoordinateAction(
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
    elementBounds?: [number, number, number, number] | null,
  ): Promise<
    { ok: true; frame: FrameInfo; global: { x: number; y: number }; refresh?: FrameRefreshInfo } | { ok: false; refusal: DispatchResult }
  > {
    const frame =
      target.frameId !== undefined
        ? this.session.getFrame(target.frameId)
        : this.session.latestFrame();
    if (frame === undefined) {
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: frameStale(target.frameId ?? "latest", "no raster exists yet — take a screenshot first").refusal },
      };
    }
    if (this.session.frameIsFresh(frame)) {
      return this.boundsChecked(frame, target);
    }
    const refreshed = await this.autoRefreshStaleFrame(frame, target, elementBounds ?? null);
    return refreshed;
  }

  /** Shared bounds gate (image px against the resolved frame — doc 03 §4). */
  private boundsChecked(
    frame: FrameInfo,
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
  ): { ok: true; frame: FrameInfo; global: { x: number; y: number } } | { ok: false; refusal: DispatchResult } {
    if (target.x < 0 || target.y < 0 || target.x >= frame.size.w || target.y >= frame.size.h) {
      return {
        ok: false,
        refusal: { kind: "refusal", refusal: rasterOutOfBounds(target.x, target.y, frame.size.w, frame.size.h).refusal },
      };
    }
    return { ok: true, frame, global: this.session.imageToGlobal(frame, target.x, target.y) };
  }

  /**
   * R69 (task 4-c-1): the auto-refresh itself. Captures the STALE frame's
   * exact global coverage (the same backend captureRegion primitive the
   * zoom / get_app_state paths use — called, never re-implemented; a
   * region capture of the old coverage reproduces the old scope, so old vs
   * new hashes are apples-to-apples), registers the fresh frame as
   * "auto_refresh", then decides:
   *   1. full-frame Hamming ≤ 8 → screen stable → PROCEED (the model's
   *      coordinates map through the new frame identically).
   *   2. else the target region (element bounds, or the ±48px box around
   *      the point): Hamming ≤ 6 → target stable → PROCEED.
   *   3. else → frame_changed (the fresh frame is registered; the model
   *      zooms it and retries in one round-trip).
   * A failed capture (or unhashable rasters — no comparison possible) falls
   * back to the honest frame_stale signal so the failure is never lost.
   */
  private async autoRefreshStaleFrame(
    frame: FrameInfo,
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
    elementBounds: [number, number, number, number] | null,
  ): Promise<
    { ok: true; frame: FrameInfo; global: { x: number; y: number }; refresh: FrameRefreshInfo } | { ok: false; refusal: DispatchResult }
  > {
    const ageS = Math.round((Date.now() - frame.capturedAt) / 1000);
    // The old raster's GLOBAL coverage (image px ÷ scale = screen pt) — a
    // region capture of that coverage reproduces the old scope.
    const coverage = {
      x: frame.origin.x,
      y: frame.origin.y,
      w: coverageWidth(frame),
      h: coverageHeight(frame),
    };
    const raster = await this.backend.captureRegion(this.run, coverage);
    if ("error" in raster) {
      // NEVER lose the failure signal: the old frame_stale shape, with the
      // refresh attempt named honestly in the why.
      return {
        ok: false,
        refusal: {
          kind: "refusal",
          refusal: frameStale(frame.frameId, `captured ${ageS}s ago (max ${MAX_FRAME_AGE_MS / 1000}s); the automatic refresh capture failed: ${raster.error}`).refusal,
        },
      };
    }
    const frontPid = await this.backend.frontmostPid(this.run);
    const { frameId: refreshFrameId } = this.session.registerFrame(
      raster,
      { kind: "display", pid: frontPid ?? frame.ownerAtCapture.pid },
      { pid: frontPid ?? frame.ownerAtCapture.pid, windowId: frame.ownerAtCapture.windowId },
      frame.displayIndex,
      "auto_refresh",
    );
    this.cacheRaster(refreshFrameId, raster.pngBase64);
    this.session.record(
      "observe",
      `Auto-refreshed stale frame ${frame.frameId} → ${refreshFrameId} (screen comparison in flight)`,
      "auto_refresh",
      { refreshFrameId, staleFrameId: frame.frameId },
    );
    const newFrame = this.session.getFrame(refreshFrameId)!;
    const oldHash = frame.aHash;
    const newHash = newFrame.aHash;
    if (oldHash === undefined || newHash === undefined) {
      // No comparison possible (an undecodable raster on either side) —
      // the honest fallback is the staleness signal, not a guess.
      return {
        ok: false,
        refusal: {
          kind: "refusal",
          refusal: frameStale(frame.frameId, `captured ${ageS}s ago (max ${MAX_FRAME_AGE_MS / 1000}s); the refreshed frame could not be perceptually verified`).refusal,
        },
      };
    }
    if (hamming(oldHash, newHash) <= REFRESH_FULL_STABLE_HAMMING) {
      const checked = this.boundsChecked(newFrame, target);
      if (!checked.ok) return checked;
      return { ...checked, refresh: { frameId: refreshFrameId, screenStable: true } };
    }
    // Screen moved — does the TARGET region still match?
    const oldPng = this.rasterFor(frame.frameId);
    const oldRegion = oldPng === undefined ? null : hashRegion(oldPng, this.regionRectFor(frame, target, elementBounds), frame.frameId);
    const newRegion = hashRegion(raster.pngBase64, this.regionRectFor(newFrame, target, elementBounds), refreshFrameId);
    if (
      oldRegion !== null &&
      newRegion !== null &&
      hamming(oldRegion.aHash, newRegion.aHash) <= REFRESH_REGION_STABLE_HAMMING
    ) {
      const checked = this.boundsChecked(newFrame, target);
      if (!checked.ok) return checked;
      return { ...checked, refresh: { frameId: refreshFrameId, screenStable: false, targetRegionStable: true } };
    }
    // Genuinely changed (or the old raster was evicted and the region is
    // unverifiable — the screen DID move, the refusal is honest either way).
    return {
      ok: false,
      refusal: {
        kind: "refusal",
        refusal: frameChanged(refreshFrameId, `the frame was captured ${ageS}s ago (max ${MAX_FRAME_AGE_MS / 1000}s) and the target region differs now.`).refusal,
      },
    };
  }

  /**
   * The target-region rect (IMAGE px of the given frame) for the region
   * comparison: the element's bounds when the action carries one, else the
   * ±48px box around the action's own point, clamped to the frame. The
   * global rect is mapped per-frame (the old and new frames share the old
   * coverage, but each maps with its own origin/scale).
   */
  private regionRectFor(
    frame: FrameInfo,
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
    elementBounds: [number, number, number, number] | null,
  ): { x: number; y: number; w: number; h: number } {
    let globalRect: { x: number; y: number; w: number; h: number };
    if (elementBounds !== null) {
      globalRect = { x: elementBounds[0], y: elementBounds[1], w: elementBounds[2], h: elementBounds[3] };
    } else {
      // The action point in GLOBAL space, padded ±48pt, clamped to the
      // frame's coverage.
      const pt = this.session.imageToGlobal(frame, target.x, target.y);
      const x0 = Math.max(frame.origin.x, pt.x - REFRESH_REGION_PAD_PX);
      const y0 = Math.max(frame.origin.y, pt.y - REFRESH_REGION_PAD_PX);
      const x1 = Math.min(frame.origin.x + coverageWidth(frame), pt.x + REFRESH_REGION_PAD_PX);
      const y1 = Math.min(frame.origin.y + coverageHeight(frame), pt.y + REFRESH_REGION_PAD_PX);
      globalRect = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    }
    // GLOBAL → image px for THIS frame (the inverse of imageToGlobal).
    const ix = Math.round((globalRect.x - frame.origin.x) * frame.scale);
    const iy = Math.round((globalRect.y - frame.origin.y) * frame.scale);
    const iw = Math.max(1, Math.round(globalRect.w * frame.scale));
    const ih = Math.max(1, Math.round(globalRect.h * frame.scale));
    return {
      x: Math.min(Math.max(0, ix), Math.max(0, frame.size.w - 1)),
      y: Math.min(Math.max(0, iy), Math.max(0, frame.size.h - 1)),
      w: Math.min(iw, frame.size.w),
      h: Math.min(ih, frame.size.h),
    };
  }

  /** Attach the R69 auto-refresh outcome to an action receipt (additive). */
  private applyRefresh(result: DispatchResult, refresh: FrameRefreshInfo | undefined): DispatchResult {
    if (refresh === undefined || result.kind !== "receipt") return result;
    return {
      ...result,
      receipt: {
        ...result.receipt,
        frameRefreshed: true,
        refreshFrameId: refresh.frameId,
        screenStable: refresh.screenStable,
        ...(refresh.targetRegionStable !== undefined ? { targetRegionStable: refresh.targetRegionStable } : {}),
      },
    };
  }

  /* ── R69 (task 4-c-2): the post-action AUTO-OBSERVATION ────────────────── */

  /**
   * The frontmost app's {pid, title} via the LIST_APPS path's own frontmost
   * marker: every backend's listApps flags the app whose pid owns the
   * foreground window (`active: true`, with `name` = its MAIN WINDOW
   * title) — the existing frontmost/window-title identity, reused, never
   * re-implemented. Null when no active app resolves (an empty list, or a
   * frontmost helper pid that owns no window) — every consumer degrades
   * honestly (activeApp omitted, never fabricated).
   */
  private async frontmostAppState(): Promise<{ pid: number; title: string } | null> {
    try {
      const { apps } = await this.backend.listApps(this.run);
      const active = apps.find((a) => a.active);
      return active === undefined ? null : { pid: active.pid, title: active.name };
    } catch {
      return null;
    }
  }

  /**
   * Capture + compose the compact post-action observation (the shape every
   * OBSERVATION_TOOLS receipt and the wait() receipt carry):
   *   1. settle OBSERVATION_SETTLE_MS (configurable; wait() passes none —
   *      its duration already settled the screen);
   *   2. captureDisplay (the same primitive toolScreenshot rides) and
   *      register it with provenance "observation" + raster-cache it (the
   *      frame is zoomable/vision-servable immediately — the plugins also
   *      SSE it as an inline thumbnail);
   *   3. screenChanged: the new frame's aHash vs the LAST frame registered
   *      before it (the pre-action state — includes 4-c-1's auto-refresh
   *      capture when one fired; FREE, no extra pre-capture). Hamming > 4
   *      of 64 bits = changed (the spam guard's near-identical threshold);
   *   4. focusedElementName: the key tool's readback primitive, scoped on
   *      the post-action frontmost pid (best-effort, omitted on null);
   *   5. activeApp {pid, title} + titleChanged (pre-action read vs post).
   * EVERY failure path degrades honestly: a failed capture returns
   * {captureFailed:true}; a thrown backend call is swallowed the same way —
   * the observation NEVER fails the action receipt it rides.
   */
  private async captureAutoObservation(
    toolName: string,
    preTitle: { pid: number; title: string } | null,
    settle: boolean,
  ): Promise<ActionObservation> {
    try {
      if (settle && this.observationSettleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.observationSettleMs));
      }
      // The pre-state: the last registered frame BEFORE this capture (an
      // auto-refresh frame from 4-c-1's resolution counts — it IS the
      // pre-action truth). Read HERE, not before the action: nothing the
      // action itself registers, so latestFrame() is still pre-action.
      const preFrame = this.session.latestFrame();
      const raster = await this.backend.captureDisplay(this.run, this.selectedDisplay);
      if ("error" in raster) {
        return { captureFailed: true };
      }
      const front = await this.frontmostAppState();
      const ownerPid = front?.pid ?? preFrame?.ownerAtCapture.pid ?? 0;
      const { frameId } = this.session.registerFrame(
        raster,
        { kind: "display", pid: ownerPid },
        { pid: ownerPid, windowId: 0 },
        this.selectedDisplay,
        "observation",
      );
      this.cacheRaster(frameId, raster.pngBase64);
      const newFrame = this.session.getFrame(frameId)!;
      let screenChanged: boolean | undefined;
      if (preFrame?.aHash !== undefined && newFrame.aHash !== undefined) {
        screenChanged = hamming(preFrame.aHash, newFrame.aHash) > OBSERVATION_CHANGED_HAMMING;
      }
      // The focused readback (the key tool's primitive, on the post-action
      // frontmost pid — the impl itself refuses '' when the pid lost the
      // foreground, which is exactly the honest scoping).
      let focusedElementName: string | undefined;
      const focusPid = front?.pid ?? preFrame?.ownerAtCapture.pid;
      if (focusPid !== undefined) {
        try {
          const focused = await this.backend.focusedElementName(this.run, focusPid);
          if (focused !== null && focused.trim() !== "") focusedElementName = focused.trim().slice(0, 200);
        } catch {
          // best-effort — the field is omitted, never a failure
        }
      }
      const observation: ObservationInfo = {
        frameId,
        ...(screenChanged !== undefined ? { screenChanged } : {}),
        ...(focusedElementName !== undefined ? { focusedElementName } : {}),
        ...(front !== null ? { activeApp: { pid: front.pid, title: front.title } } : {}),
        ...(front !== null && preTitle !== null ? { titleChanged: front.title !== preTitle.title } : {}),
      };
      this.session.record(
        "observe",
        `Auto-observed post-action frame ${frameId}${
          screenChanged === true ? " (screen changed)" : screenChanged === false ? " (screen unchanged)" : ""
        }`,
        toolName,
        { frameId, screenChanged: screenChanged ?? null },
      );
      return observation;
    } catch {
      // The observation is an enhancement riding the receipt — never a
      // failure channel for the action itself.
      return { captureFailed: true };
    }
  }

  /**
   * Attach the auto-observation to a SENT action receipt (dispatch's only
   * caller; wait() builds its own via captureAutoObservation). Also upgrades
   * a coordinate click's targetVerificationStatus "unverified" →
   * "changed"/"unchanged" from screenChanged — the receipt then TELLS the
   * model whether its click visibly registered. Element/a11y receipts keep
   * "matched" (their actuation was identity-verified by the backend).
   */
  private async attachAutoObservation(
    toolName: string,
    args: Record<string, unknown>,
    result: { kind: "receipt"; receipt: Receipt; observation?: Snapshot },
    preTitle: { pid: number; title: string } | null,
  ): Promise<void> {
    const observation = await this.captureAutoObservation(toolName, preTitle, true);
    result.receipt.observation = observation;
    if ("captureFailed" in observation) return;
    const target = args["target"];
    const coordinateTarget =
      typeof target === "object" && target !== null && (target as Record<string, unknown>)["type"] === "coordinate";
    if (
      observation.screenChanged !== undefined &&
      coordinateTarget &&
      result.receipt.targetVerificationStatus === "unverified"
    ) {
      result.receipt.targetVerificationStatus = observation.screenChanged ? "changed" : "unchanged";
    }
  }


  /**
   * R68-C (C2): the Win/Linux raw foreground rule (doc 07 §5) + the
   * self-healing recovery, folded into ONE wrapper (the old standalone
   * requireForegroundForRaw plain-refusal gate is GONE — every caller now
   * wants the heal). Run the backend's escalated activation and RE-READ the
   * frontmost pid — the activation is trusted only when the OS confirms
   * it (activate's own {active} receipt is checked first, then the
   * independent frontmost read; a null read means "cannot verify", which
   * the caller treats as not-healed — honest, never assumed).
   */
  private async activateAndRecheck(pid: number, windowId: number | undefined): Promise<boolean> {
    try {
      const activated = await this.backend.activate(this.run, pid, windowId);
      if (!activated.ok || activated.active !== true) return false;
    } catch {
      return false;
    }
    const front = await this.backend.frontmostPid(this.run);
    return front === pid;
  }

  /**
   * R68-C (C2): FRONTMOST AUTO-RETRY — the self-healing wrapper for every
   * raw-input backend call. Runs the foreground rule; on a mismatch (OR a
   * FRONTMOST_MISMATCH error from the backend's own script-level check —
   * the focus can churn between the gate and the SendInput) it ACTIVATES
   * the target once (the backend's escalated ladder) and retries fn ONCE.
   * If the activation fails, the ORIGINAL mismatch is returned so the
   * caller shapes the honest frontmost_pid_mismatch refusal.
   *
   * CONSENT REASONING (the design note this file owes the owner): the model
   * already declared intent to act on THIS app — the tool call named the
   * appRef/element/frame, the tool-level consent gate (ask-mode risk
   * classes) already ran on exactly that action, and the refusal text has
   * ALWAYS told the model to re-activate and retry. Performing that
   * recovery automatically is not a new capability: it is the SAME action,
   * on the SAME target, completing the SAME consented intent — the only
   * visible difference is the window coming forward (which the
   * open_application(activate:true) path the model was told to call would
   * have done anyway). Non-mismatch errors NEVER retry here (one retry,
   * mismatch-class only — no retry storms).
   */
  private async withForegroundRetry(
    pid: number,
    windowId: number | undefined,
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ): Promise<{ ok: boolean; error?: string }> {
    // Step 1 — the foreground rule (doc 07 §5): mismatch → self-heal once.
    if (this.backend.capabilities().rawRequiresForeground) {
      const front = await this.backend.frontmostPid(this.run);
      if (front !== null && front !== pid) {
        if (!(await this.activateAndRecheck(pid, windowId))) {
          // Activation failed or the foreground is STILL someone else's —
          // the ORIGINAL mismatch error (the caller shapes the honest
          // refusal; the recovery text names the failed auto-activation).
          return { ok: false, error: `FRONTMOST_MISMATCH:${front}` };
        }
      }
    }
    // Step 2 — the action itself.
    const first = await fn();
    if (first.ok || !first.error?.startsWith("FRONTMOST_MISMATCH:")) return first;
    // Step 3 — the script-level check raced the focus churn: heal + retry ONCE.
    if (!(await this.activateAndRecheck(pid, windowId))) return first;
    return fn();
  }

  /* ── read tools ───────────────────────────────────────────────────────── */

  private async toolListWindows(args: Record<string, unknown>): Promise<DispatchResult> {
    const resolved = await this.resolveAppRef(args["appRef"] ?? args["app_ref"]);
    if (!resolved.ok) return resolved.refusal;
    const { windows, diagnostics } = await this.backend.listWindows(this.run, { pid: resolved.app.pid });
    return {
      kind: "data",
      data: windows.length === 0 && diagnostics !== undefined ? { windows, diagnostics } : { windows },
    };
  }

  private toolSwitchDisplay(args: Record<string, unknown>): DispatchResult {
    const index = Number(args["index"]);
    if (!Number.isInteger(index) || index < 1) {
      return { kind: "refusal", refusal: invalidTarget("display index must be a 1-based integer").refusal };
    }
    this.selectedDisplay = index;
    return { kind: "data", data: { selectedDisplay: index } };
  }

  private async toolGetAppState(args: Record<string, unknown>): Promise<DispatchResult> {
    const resolved = await this.resolveAppWindow(args);
    if (!resolved.ok) return resolved.refusal;
    const { app, window } = resolved;
    const detail = args["detail"] === "full" ? "full" : "compact";
    const includeScreenshot = args["includeScreenshot"] === true || args["include_screenshot"] === true;

    const built = await this.backend.buildSnapshot(this.run, app, window, detail);
    if ("error" in built) {
      return {
        kind: "refusal",
        refusal: {
          error: "capability_fail_closed",
          message: built.error,
          recovery: built.emptyTree
            ? "Fall back to the visual pipeline: screenshot + frame-bound coordinate actions. Do not assume the tools are broken."
            : "Read the message; retry observation only after the stated cause is addressed.",
          payload: built.emptyTree ? { emptyTree: true } : undefined,
        },
      };
    }
    const snapshot = this.session.registerSnapshot(built);
    this.session.record(
      "observe",
      `Observed '${snapshot.window.title}' (${snapshot.elements.length} elements)`,
      "get_app_state",
      { stateId: snapshot.stateId, elements: snapshot.elements.length },
    );

    // Optional window-screenshot: region capture over the window bounds.
    if (includeScreenshot) {
      const raster = await this.backend.captureRegion(this.run, {
        x: window.bounds[0],
        y: window.bounds[1],
        w: window.bounds[2],
        h: window.bounds[3],
      });
      if (!("error" in raster)) {
        // R69: includeScreenshot is a MODEL capture — the spam guard
        // applies (the observed app's pid is the foreground identity).
        const guard = this.guardModelCapture(raster.pngBase64, app.pid);
        if (guard !== null) return { kind: "refusal", refusal: guard };
        const { frameId, meta } = this.session.registerFrame(
          raster,
          { kind: "window", pid: app.pid, windowId: window.windowId },
          { pid: app.pid, windowId: window.windowId },
          this.selectedDisplay,
          "model",
        );
        this.cacheRaster(frameId, raster.pngBase64);
        snapshot.raster = meta;
      }
      // A failed window capture is NOT fatal — the tree is the observation.
    }

    const data: Record<string, unknown> = { state: snapshot };
    if (snapshot.raster) data["raster"] = snapshot.raster;
    return { kind: "data", data };
  }

  /** R66-2-d: the app_ref → tiered resolution → window pick that
   * get_app_state performs (extracted so find_elements rides the EXACT
   * same code path — same tiers, same refusal shapes, same windowId
   * scoping). */
  private async resolveAppWindow(
    args: Record<string, unknown>,
  ): Promise<
    { ok: true; app: { pid: number; name?: string; bundleId?: string }; window: WindowInfo } | { ok: false; refusal: DispatchResult }
  > {
    const resolved = await this.resolveAppRef(args["appRef"] ?? args["app_ref"]);
    if (!resolved.ok) return { ok: false, refusal: resolved.refusal };
    const ref = (args["appRef"] ?? args["app_ref"]) as Record<string, unknown>;
    const { windows, diagnostics } = await this.backend.listWindows(this.run, { pid: resolved.app.pid });
    let window = windows[0];
    if (ref["windowId"] !== undefined || ref["window_id"] !== undefined) {
      const wantId = Number(ref["windowId"] ?? ref["window_id"]);
      const match = windows.find((w) => w.windowId === wantId);
      if (match === undefined) {
        return { ok: false, refusal: { kind: "refusal", refusal: invalidWindowId(wantId).refusal } };
      }
      window = match;
    } else if (windows.length === 0) {
      // R67-C: the WebView2-helper live failure — a LIVE process that owns
      // no accessible top-level window is NOT "no running application
      // matches". The honest refusal names the helper-process cause and
      // redirects to the host app (list_apps). A confirmed-not-running pid
      // keeps the plain app_not_found shape.
      return { ok: false, refusal: this.noAccessibleWindowRefusal(resolved.app.pid, diagnostics?.processRunning) };
    }
    return { ok: true, app: resolved.app, window };
  }

  /**
   * R67-C: the pid resolved but owns no accessible top-level window — the
   * owner's live failure (get_app_state(pid of msedgewebview2) → "no running
   * application matches" for a LIVE helper). `processRunning === false`
   * (the backend checked Get-Process and found the pid dead) keeps the
   * plain app_not_found shape; anything else gets the honest
   * helper-process message. Shared by resolveAppWindow, toolType and
   * toolKey (all three used to emit the misleading generic shape).
   */
  private noAccessibleWindowRefusal(pid: number, processRunning: boolean | undefined): DispatchResult {
    if (processRunning === false) {
      return { kind: "refusal", refusal: appNotFound(`pid ${pid} (not running)`).refusal };
    }
    return {
      kind: "refusal",
      refusal: {
        error: "app_not_found",
        message: `process ${pid} is running but owns no accessible top-level window — it may be a helper/child process (e.g. a WebView2 renderer); target the HOST application instead (see list_apps).`,
        recovery:
          "Call list_apps and re-issue the action against the host application's pid (its `name` is the top-level window title — e.g. the browser or app hosting the WebView2, not the renderer).",
        payload: { pid, processRunning: processRunning ?? null, ownsAccessibleWindow: false },
      },
    };
  }

  /**
   * R66-2-d (owner directive B2, the live Edge failure): SEARCH the
   * accessibility tree instead of ingesting it. A Chromium-sized window
   * returns thousands of elements — get_app_state detail:full is unusable
   * and the agent drifted into a screenshot loop. This resolves the app +
   * window exactly like get_app_state, builds the SAME full-detail snapshot
   * (bounds are the point), then filters server-side: name contains query
   * (case-insensitive) AND — when kind is given — the snapshot's mapped kind
   * matches. The returned indexes are REAL snapshot indexes: the snapshot is
   * registered, its stateId rides the result, and left_click/set_value/
   * perform_action accept {type:"element", stateId, index} directly.
   * Read-only (never in MUTATING_TOOLS), kill-switch-gated like every other
   * observe tool.
   */
  private async toolFindElements(args: Record<string, unknown>): Promise<DispatchResult> {
    const rawQuery = typeof args["query"] === "string" ? (args["query"] as string) : "";
    if (rawQuery.trim() === "") {
      return {
        kind: "refusal",
        refusal: invalidTarget("find_elements needs a non-empty query (a case-insensitive name substring)").refusal,
      };
    }
    const rawKind = typeof args["kind"] === "string" ? (args["kind"] as string).trim().toLowerCase() : "";
    const kind = rawKind !== "" ? rawKind : undefined;
    const rawLimit = Number(args["limit"]);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 40) : 20;

    const resolved = await this.resolveAppWindow(args);
    if (!resolved.ok) return resolved.refusal;
    const { app, window } = resolved;

    const built = await this.backend.buildSnapshot(this.run, app, window, "full");
    if ("error" in built) {
      return {
        kind: "refusal",
        refusal: {
          error: "capability_fail_closed",
          message: built.error,
          recovery: built.emptyTree
            ? "Fall back to the visual pipeline: screenshot + frame-bound coordinate actions. Do not assume the tools are broken."
            : "Read the message; retry observation only after the stated cause is addressed.",
          payload: built.emptyTree ? { emptyTree: true } : undefined,
        },
      };
    }
    const snapshot = this.session.registerSnapshot(built);
    const want = rawQuery.trim().toLowerCase();
    const matched = snapshot.elements.filter(
      (el) => el.name.toLowerCase().includes(want) && (kind === undefined || el.kind === kind),
    );
    this.session.record(
      "observe",
      `Searched '${snapshot.window.title}' for '${rawQuery.trim()}'${kind !== undefined ? ` (kind ${kind})` : ""} — ${matched.length}/${snapshot.elements.length} match`,
      "find_elements",
      { stateId: snapshot.stateId, matches: matched.length },
    );
    if (matched.length === 0) {
      // An honest ok:false-shaped empty — WHAT was searched (the element count
      // walked, the query) and the exact retry, never a silent [] (the model
      // would flail to screenshots, the exact failure this tool fixes). Reuses
      // capability_fail_closed like the sibling empty-tree refusal; the
      // message + payload carry the real no-match semantics.
      return {
        kind: "refusal",
        refusal: {
          error: "capability_fail_closed",
          message: `find_elements: none of the ${snapshot.elements.length} elements in '${snapshot.window.title}' has a name containing '${rawQuery.trim()}'${kind !== undefined ? ` with kind '${kind}'` : ""}.`,
          recovery:
            "Try a shorter or looser substring (names match case-insensitively), drop the kind filter, or get_app_state to read the tree. Nothing was sent.",
          payload: {
            query: rawQuery.trim(),
            ...(kind !== undefined ? { kind } : {}),
            elementsWalked: snapshot.elements.length,
            stateId: snapshot.stateId,
          },
        },
      };
    }
    const matches = matched.slice(0, limit).map((el) => ({
      index: el.index,
      kind: el.kind,
      name: el.name,
      flags: el.flags,
      ...(el.bounds !== undefined ? { bounds: el.bounds } : {}),
      ...(el.actions !== undefined ? { actions: el.actions } : {}),
    }));
    return {
      kind: "data",
      data: {
        matches,
        total: matched.length,
        stateId: snapshot.stateId,
        app: { pid: app.pid, name: app.name },
        window: { title: snapshot.window.title, windowId: snapshot.window.windowId },
        note: "indexes are get_app_state/left_click element target indexes — use them directly",
      },
    };
  }

  private async toolScreenshot(_args: Record<string, unknown>): Promise<DispatchResult> {
    const raster = await this.backend.captureDisplay(this.run, this.selectedDisplay);
    if ("error" in raster) {
      return {
        kind: "refusal",
        refusal: {
          error: "capability_fail_closed",
          message: `Capture failed: ${raster.error}`,
          recovery: "Check the probe (request_access) for screen-capture capability; switch_display to a valid display; continue with the accessibility tree if the task allows.",
        },
      };
    }
    const { displays } = await this.backend.listDisplays(this.run);
    const display = displays.find((d) => d.index === this.selectedDisplay) ?? displays[0];
    const frontPid = await this.backend.frontmostPid(this.run);
    // R69: the spam guard runs AFTER the bytes arrive, BEFORE registration —
    // a refused capture registers/streams nothing.
    const guard = this.guardModelCapture(raster.pngBase64, frontPid);
    if (guard !== null) return { kind: "refusal", refusal: guard };
    const { frameId, meta } = this.session.registerFrame(
      raster,
      { kind: "display", pid: frontPid ?? undefined },
      { pid: frontPid ?? 0, windowId: 0 },
      this.selectedDisplay,
      "model",
    );
    this.cacheRaster(frameId, raster.pngBase64);
    this.session.record("observe", `Captured display ${this.selectedDisplay} (${meta.width}×${meta.height})`, "screenshot", {
      frameId,
    });
    // pngBase64 rides the INTERNAL cache only — the agent gets metadata;
    // vision (describe flag) is appended by the tools layer.
    return {
      kind: "data",
      data: { frame: meta, display: display ?? null },
    };
  }

  private async toolZoom(args: Record<string, unknown>): Promise<DispatchResult> {
    const region = args["region"];
    if (!Array.isArray(region) || region.length !== 4 || region.some((n) => !Number.isInteger(n))) {
      return { kind: "refusal", refusal: invalidTarget("region must be [x0, y0, x1, y1] integers (image pixels of the latest raster)").refusal };
    }
    // Doc 02 §1.7: crop OF THE LATEST RASTER — map image px → global, then
    // region-capture that global rect (a fresh, crisper crop).
    const frame = this.session.latestFrame();
    if (frame === undefined) {
      return { kind: "refusal", refusal: frameStale("latest", "no raster exists yet — take a screenshot first").refusal };
    }
    const [x0, y0, x1, y1] = region as [number, number, number, number];
    const g0 = this.session.imageToGlobal(frame, Math.min(x0, x1), Math.min(y0, y1));
    const g1 = this.session.imageToGlobal(frame, Math.max(x0, x1), Math.max(y0, y1));
    const raster = await this.backend.captureRegion(this.run, {
      x: g0.x,
      y: g0.y,
      w: Math.max(1, g1.x - g0.x),
      h: Math.max(1, g1.y - g0.y),
    });
    if ("error" in raster) {
      return {
        kind: "refusal",
        refusal: {
          error: "capability_fail_closed",
          message: `Zoom capture failed: ${raster.error}`,
          recovery: "Re-check the region against the current raster; take a fresh screenshot if the frame is stale.",
        },
      };
    }
    // R69: zoom-with-capture is a MODEL capture — the spam guard applies
    // (the source frame's owner pid is the foreground identity here).
    const guard = this.guardModelCapture(raster.pngBase64, frame.ownerAtCapture.pid);
    if (guard !== null) return { kind: "refusal", refusal: guard };
    const { frameId, meta } = this.session.registerFrame(
      raster,
      { kind: "display", pid: frame.ownerAtCapture.pid },
      frame.ownerAtCapture,
      frame.displayIndex,
      "model",
    );
    this.cacheRaster(frameId, raster.pngBase64);
    return { kind: "data", data: { frame: meta } };
  }

  private async toolCursorPosition(): Promise<DispatchResult> {
    const pos = await this.backend.cursorPosition(this.run);
    if (pos === null) {
      return {
        kind: "refusal",
        refusal: {
          error: "unsupported_on_backend",
          message: "Cursor position is unavailable on this backend.",
          recovery: "Proceed with frame-bound coordinates from the latest raster.",
          payload: { backend: this.backend.kind },
        },
      };
    }
    return { kind: "data", data: { position: pos, selectedDisplay: this.selectedDisplay } };
  }

  /* ── session tools ────────────────────────────────────────────────────── */

  private async toolOpenApplication(args: Record<string, unknown>): Promise<DispatchResult> {
    const app = (args["app"] ?? {}) as Record<string, unknown>;
    const spec = {
      name: typeof app["name"] === "string" ? app["name"] : typeof args["name"] === "string" ? (args["name"] as string) : undefined,
      bundleId:
        typeof app["bundleId"] === "string"
          ? app["bundleId"]
          : typeof app["bundle_id"] === "string"
            ? app["bundle_id"]
            : typeof args["bundleId"] === "string"
              ? (args["bundleId"] as string)
              : undefined,
      pid: app["pid"] !== undefined ? Number(app["pid"]) : undefined,
      url: typeof args["url"] === "string" ? (args["url"] as string) : undefined,
      activate: args["activate"] === true,
    };
    this.session.record(
      "intent",
      spec.activate ? `Activating '${spec.name ?? spec.bundleId ?? spec.pid}'` : `Launching '${spec.name ?? spec.bundleId ?? spec.pid}'`,
      "open_application",
      { activate: spec.activate },
    );
    const outcome = await this.backend.launch(this.run, spec);
    if (!outcome.ok) {
      return {
        kind: "refusal",
        refusal: {
          error: "could_not_launch",
          message: `open_application could not launch '${spec.name ?? spec.bundleId}': ${outcome.error ?? "unknown"}`,
          recovery: "Verify the EXACT app name/bundle_id the user gave (character-for-character; never translate, shorten, or retry variant spellings), then launch once more via the resolved identity. Do not substitute a different app.",
          payload: { name: spec.name },
        },
      };
    }
    if (spec.activate && outcome.pid !== undefined) {
      const act = await this.backend.activate(this.run, outcome.pid);
      return {
        kind: "receipt",
        receipt: receipt(true, act.active ? "accepted" : "possibly_sent", false),
      };
    }
    return {
      kind: "receipt",
      receipt: receipt(true, "accepted", false),
    };
  }

  private toolStopControl(_args: Record<string, unknown>): DispatchResult {
    const args = _args ?? {};
    const reason = typeof args?.["reason"] === "string" ? (args["reason"] as string) : "session stopped";
    const { releasedHeld } = this.session.stop(reason);
    if (releasedHeld) {
      // The only sanctioned auto-release (doc 08 §2): this session's held
      // button gets a real mouse-up at the recorded point.
      void this.backend.rawButton(this.run, releasedHeld.point, false);
    }
    return {
      kind: "receipt",
      receipt: receipt(true, "accepted", false),
    };
  }

  private async toolWait(args: Record<string, unknown>): Promise<DispatchResult> {
    const duration = Math.max(0, Math.min(30, Number(args["duration"]) || 0));
    this.session.record("wait", `Waiting ${duration}s`, "wait");
    // R69 (task 4-c-2): the pre-wait frontmost title — the baseline for
    // titleChanged ("what changed while I waited"), read before the sleep.
    const preTitle = await this.frontmostAppState();
    await new Promise((resolve) => setTimeout(resolve, duration * 1000));
    // R69 (task 4-c-2): wait()'s receipt carries the SAME compact
    // observation the mutating actions get — after the sleep, capture
    // (provenance "observation"), diff vs the last registered frame, read
    // the focused element + the frontmost title. A wait() result is now a
    // real answer ("the screen changed / the app switched / focus moved")
    // instead of a bare "ok". No extra settle: the duration already settled
    // whatever was animating. actionSent stays false (waiting sent
    // nothing); the observation is the payload.
    const observation = await this.captureAutoObservation("wait", preTitle, false);
    return { kind: "receipt", receipt: { ...receipt(false, "accepted", false), observation } };
  }

  /* ── pointer tools (doc 07 §2 matrix) ─────────────────────────────────── */

  private async toolClickLike(
    args: Record<string, unknown>,
    button: "left" | "middle",
    clickCount: 1 | 2 | 3,
  ): Promise<DispatchResult> {
    const strategy = parseStrategy(args["strategy"]);
    const modifiers = parseModifiers(args["modifiers"]);
    const targetRes = this.resolveTarget(args["target"]);
    if (!targetRes.ok) return targetRes.refusal;

    // double/triple: NO a11y equivalent — element fails closed under
    // auto; coordinate goes raw (raster-bound).
    // R69 (task 4-c-2, D5): MIDDLE-click element targets no longer fail
    // closed — they route exactly like left_click's event path (resolve the
    // element's bounds → click the CENTER with the raw middle button), so
    // middle_click{target:element} works for "open in new tab" flows. The
    // receipt carries hitElementName (the element we resolved) + the
    // post-action observation.
    if (clickCount > 1 || button === "middle") {
      if (targetRes.target.type === "element") {
        if (button === "middle") {
          const scope = this.resolveElementScope(targetRes.target);
          if (!scope.ok) return scope.refusal;
          const center = elementCenter(scope.element);
          if (center === null) {
            return { kind: "refusal", refusal: capabilityFailClosed("the element has no bounds in this snapshot; re-observe with detail:'full'").refusal };
          }
          return this.rawClickAt(center, scope.snapshot.app.pid, 1, modifiers, targetRes.target, scope.element, "middle");
        }
        return {
          kind: "refusal",
          refusal: capabilityFailClosed(
            `${clickCount === 2 ? "double" : "triple"}_click has no accessibility equivalent for element targets`,
          ).refusal,
        };
      }
      return this.rawCoordinateClick(targetRes.target, button, clickCount, modifiers);
    }

    // left_click element → a11y press (strategy auto/a11y); event → raw at center.
    if (targetRes.target.type === "element") {
      if (strategy === "event") {
        const scope = this.resolveElementScope(targetRes.target);
        if (!scope.ok) return scope.refusal;
        const center = elementCenter(scope.element);
        if (center === null) {
          return { kind: "refusal", refusal: capabilityFailClosed("the element has no bounds in this snapshot; re-observe with detail:'full'").refusal };
        }
        return this.rawClickAt(center, scope.snapshot.app.pid, 1, modifiers, targetRes.target, scope.element);
      }
      return this.semanticPress(targetRes.target);
    }

    // left_click coordinate → hit-test first (auto), else raw.
    return this.coordinateClick(targetRes.target, strategy, modifiers);
  }

  private async toolRightClick(args: Record<string, unknown>): Promise<DispatchResult> {
    const strategy = parseStrategy(args["strategy"]);
    const modifiers = parseModifiers(args["modifiers"]);
    const targetRes = this.resolveTarget(args["target"]);
    if (!targetRes.ok) return targetRes.refusal;

    if (targetRes.target.type === "element") {
      const scope = this.resolveElementScope(targetRes.target);
      if (!scope.ok) return scope.refusal;
      const hasMenu = scope.element.flags.includes("has_menu");
      if (hasMenu && strategy !== "event") {
        // Menu open via the backend's perform-action "Expand"/showMenu.
        const descriptor: ElementDescriptor = {
          index: scope.element.index,
          kind: scope.element.kind,
          name: scope.element.name,
        };
        this.session.record("intent", `Opening menu on '${scope.element.name}'`, "right_click");
        const result = await this.backend.performAction(
          this.run,
          scope.snapshot.app.pid,
          scope.window,
          descriptor,
          "Expand",
        );
        this.session.markConsumed(targetRes.target.stateId);
        if (!result.ok) {
          if (result.stale) return { kind: "refusal", refusal: elementStaleChanged(targetRes.target.stateId).refusal };
          return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "menu open failed").refusal };
        }
        return { kind: "receipt", receipt: receipt(true, "accepted", false, "matched") };
      }
      // R69 (task 4-c-2, D5): NO menu advertised (or the event strategy
      // forces raw input — the old path oddly ran Expand even then): route
      // like left_click's event path — element bounds → center → RAW
      // right-click (the real context-menu gesture at the element, e.g. a
      // link's "open in new tab" menu). The old fail-closed cell is GONE.
      const center = elementCenter(scope.element);
      if (center === null) {
        return { kind: "refusal", refusal: capabilityFailClosed("the element has no bounds in this snapshot; re-observe with detail:'full'").refusal };
      }
      return this.rawClickAt(center, scope.snapshot.app.pid, 1, modifiers, targetRes.target, scope.element, "right");
    }

    // Coordinate: hit-test for a menu-capable element; else raw right-click.
    // R69: stale frames auto-refresh here (resolveCoordinateAction).
    const resolved = await this.resolveCoordinateAction(targetRes.target);
    if (!resolved.ok) return resolved.refusal;
    // R69 (task 4-c-2, D3): the hit-test already runs here — its element
    // name rides the receipt as hitElementName (the model learns WHAT it
    // right-clicked), instead of being computed then discarded.
    const hit = await this.backend.hitTest(this.run, resolved.global);
    return this.applyRefresh(
      withHitElementName(
        await this.rawClickAt(resolved.global, resolved.frame.ownerAtCapture.pid, 1, modifiers, targetRes.target, undefined, "right"),
        hit,
      ),
      resolved.refresh,
    );
  }

  private async toolMouseMove(args: Record<string, unknown>): Promise<DispatchResult> {
    const targetRes = this.resolveTarget(args["target"]);
    if (!targetRes.ok) return targetRes.refusal;
    if (targetRes.target.type === "element") {
      return { kind: "refusal", refusal: capabilityFailClosed("mouse_move refuses element targets — use left_click to actuate").refusal };
    }
    // R69: stale frames auto-refresh here (resolveCoordinateAction).
    const resolved = await this.resolveCoordinateAction(targetRes.target);
    if (!resolved.ok) return resolved.refusal;
    // R68-C: frontmost auto-retry (the frame-owner pid scopes the gate).
    // Raw hover = move without click. Linux: xdotool mousemove. Windows:
    // SetCursorPos. macOS: cliclick m. Approximate with rawButton-less move
    // via a zero-press click? No — honest: use the backend's rawScroll-free
    // path: click count 0 isn't expressible; dispatch a move-only capsule
    // through rawButton(down=false)? That synthesizes nothing. The clean
    // route: not all backends expose move; approximate as accepted no-op
    // when the backend lacks it.
    const caps = this.backend.capabilities();
    if (!caps.backgroundRawInput && caps.rawRequiresForeground) {
      // Windows/Linux: SetCursorPos/xdotool mousemove IS the move; we
      // express it as a click with 0 clicks via rawClick repetition 1 but
      // no press is wrong. The honest implementation: backends treat
      // rawButton(false) after a move as the move primitive.
      const moved = await this.withForegroundRetry(resolved.frame.ownerAtCapture.pid, undefined, () =>
        this.backend.rawButton(this.run, resolved.global, false),
      );
      if (!moved.ok) {
        if (moved.error?.startsWith("FRONTMOST_MISMATCH:")) {
          const active = Number.parseInt(moved.error.split(":")[1] ?? "", 10);
          return { kind: "refusal", refusal: frontmostPidMismatch(resolved.frame.ownerAtCapture.pid, Number.isFinite(active) ? active : null).refusal };
        }
        return { kind: "refusal", refusal: capabilityFailClosed(`hover failed: ${moved.error}`).refusal };
      }
      return this.applyRefresh({ kind: "receipt", receipt: receipt(true, "accepted", false) }, resolved.refresh);
    }
    return this.applyRefresh({ kind: "receipt", receipt: receipt(false, "accepted", false) }, resolved.refresh);
  }

  private async toolScroll(args: Record<string, unknown>): Promise<DispatchResult> {
    const direction =
      args["scrollDirection"] === "up" || args["scroll_direction"] === "up"
        ? "up"
        : args["scrollDirection"] === "left" || args["scroll_direction"] === "left"
          ? "left"
          : args["scrollDirection"] === "right" || args["scroll_direction"] === "right"
            ? "right"
            : "down";
    const amount = Math.max(0, Math.min(100, Number(args["scrollAmount"] ?? args["scroll_amount"]) || 3));
    const targetRes = this.resolveTarget(args["target"]);
    if (!targetRes.ok) return targetRes.refusal;
    if (targetRes.target.type === "element") {
      return { kind: "refusal", refusal: capabilityFailClosed("scroll has NO accessibility actuation — use a coordinate target (the point from the latest raster)").refusal };
    }
    // R69: stale frames auto-refresh here (resolveCoordinateAction).
    const resolved = await this.resolveCoordinateAction(targetRes.target);
    if (!resolved.ok) return resolved.refusal;
    this.session.record("intent", `Scrolling ${direction} at (${targetRes.target.x},${targetRes.target.y})`, "scroll");
    // R68-C: frontmost auto-retry (the frame-owner pid scopes the gate).
    const result = await this.withForegroundRetry(resolved.frame.ownerAtCapture.pid, undefined, () =>
      this.backend.rawScroll(this.run, resolved.global, direction, amount),
    );
    if (!result.ok) {
      if (result.error?.startsWith("FRONTMOST_MISMATCH:")) {
        const active = Number.parseInt(result.error.split(":")[1] ?? "", 10);
        return { kind: "refusal", refusal: frontmostPidMismatch(resolved.frame.ownerAtCapture.pid, Number.isFinite(active) ? active : null).refusal };
      }
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "scroll failed").refusal };
    }
    return this.applyRefresh({ kind: "receipt", receipt: receipt(true, "accepted", false) }, resolved.refresh);
  }

  private async toolDrag(args: Record<string, unknown>): Promise<DispatchResult> {
    const fromRes = this.resolveTarget(args["fromTarget"] ?? args["from_target"]);
    const toRes = this.resolveTarget(args["to"] ?? args["toTarget"] ?? args["to_target"]);
    if (!fromRes.ok) return fromRes.refusal;
    if (!toRes.ok) return toRes.refusal;
    const modifiers = parseModifiers(args["modifiers"]);

    // From may be an element (for scoping) — resolve its center as global.
    // R69: both COORDINATE endpoints auto-refresh a stale frame
    // (resolveCoordinateAction); an element FROM endpoint supplies its
    // bounds as the to-side's target-region hint (the dragged source is
    // the thing whose stability matters).
    let fromGlobal: { x: number; y: number };
    let scopePid: number;
    let consumedStateId: string | undefined;
    let fromRefresh: FrameRefreshInfo | undefined;
    let fromElementBounds: [number, number, number, number] | null = null;
    if (fromRes.target.type === "element") {
      const scope = this.resolveElementScope(fromRes.target);
      if (!scope.ok) return scope.refusal;
      const center = elementCenter(scope.element);
      if (center === null) {
        return { kind: "refusal", refusal: capabilityFailClosed("the drag source element has no bounds; re-observe with detail:'full'").refusal };
      }
      fromGlobal = center;
      scopePid = scope.snapshot.app.pid;
      consumedStateId = fromRes.target.stateId;
      if (scope.element.bounds !== undefined) fromElementBounds = scope.element.bounds;
    } else {
      const resolved = await this.resolveCoordinateAction(fromRes.target);
      if (!resolved.ok) return resolved.refusal;
      fromGlobal = resolved.global;
      scopePid = resolved.frame.ownerAtCapture.pid;
      fromRefresh = resolved.refresh;
    }
    let toGlobal: { x: number; y: number };
    let toRefresh: FrameRefreshInfo | undefined;
    if (toRes.target.type === "element") {
      const scope = this.resolveElementScope(toRes.target);
      if (!scope.ok) return scope.refusal;
      const center = elementCenter(scope.element);
      if (center === null) {
        return { kind: "refusal", refusal: capabilityFailClosed("the drag target element has no bounds; re-observe with detail:'full'").refusal };
      }
      toGlobal = center;
      if (scope.snapshot.app.pid !== scopePid) {
        return refuse(
          "capability_fail_closed",
          `Drag endpoints must scope to the SAME app (from pid ${scopePid}, to pid ${scope.snapshot.app.pid}).`,
          "Re-choose the endpoints within one app.",
        );
      }
      consumedStateId = toRes.target.stateId;
    } else {
      const resolved = await this.resolveCoordinateAction(toRes.target, fromElementBounds);
      if (!resolved.ok) return resolved.refusal;
      toGlobal = resolved.global;
      toRefresh = resolved.refresh;
    }

    if (consumedStateId !== undefined) this.session.markConsumed(consumedStateId);
    this.session.record("intent", `Dragging to (${toGlobal.x},${toGlobal.y})`, "left_click_drag");
    // R68-C: frontmost auto-retry — the drag scope's window (element path)
    // or the frame owner (coordinate path) scopes the gate + activation.
    const scopeWindowId = fromRes.target.type === "element" ? this.session.getSnapshot(fromRes.target.stateId)?.snapshot.window.windowId : undefined;
    const result = await this.withForegroundRetry(scopePid, scopeWindowId, () =>
      this.backend.rawDrag(this.run, fromGlobal, toGlobal, modifiers),
    );
    if (!result.ok) {
      if (result.error?.startsWith("FRONTMOST_MISMATCH:")) {
        const active = Number.parseInt(result.error.split(":")[1] ?? "", 10);
        return { kind: "refusal", refusal: frontmostPidMismatch(scopePid, Number.isFinite(active) ? active : null).refusal };
      }
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "drag failed").refusal };
    }
    return this.applyRefresh(
      { kind: "receipt", receipt: receipt(true, "accepted", false) },
      fromRefresh ?? toRefresh,
    );
  }

  private async toolMouseButton(args: Record<string, unknown>, down: boolean): Promise<DispatchResult> {
    if (down) {
      const targetRes = this.resolveTarget(args["target"]);
      if (!targetRes.ok) return targetRes.refusal;
      let global: { x: number; y: number };
      let pid: number;
      if (targetRes.target.type === "element") {
        const scope = this.resolveElementScope(targetRes.target);
        if (!scope.ok) return scope.refusal;
        const center = elementCenter(scope.element);
        if (center === null) {
          return { kind: "refusal", refusal: capabilityFailClosed("the element has no bounds; re-observe with detail:'full'").refusal };
        }
        global = center;
        pid = scope.snapshot.app.pid;
      } else {
        const resolved = this.resolveCoordinate(targetRes.target);
        if (!resolved.ok) return resolved.refusal;
        global = resolved.global;
        pid = resolved.frame.ownerAtCapture.pid;
      }
      this.session.record("intent", `Pressing mouse down at (${global.x},${global.y})`, "left_mouse_down");
      // R68-C: frontmost auto-retry (element path: the snapshot's window;
      // coordinate path: the frame owner).
      const scopeWindowId = targetRes.target.type === "element" ? this.session.getSnapshot(targetRes.target.stateId)?.snapshot.window.windowId : undefined;
      const result = await this.withForegroundRetry(pid, scopeWindowId, () =>
        this.backend.rawButton(this.run, global, true),
      );
      if (!result.ok) {
        if (result.error?.startsWith("FRONTMOST_MISMATCH:")) {
          const active = Number.parseInt(result.error.split(":")[1] ?? "", 10);
          return { kind: "refusal", refusal: frontmostPidMismatch(pid, Number.isFinite(active) ? active : null).refusal };
        }
        return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "mouse down failed").refusal };
      }
      this.session.holdButton({ pid, windowId: 0 }, global);
      return { kind: "receipt", receipt: receipt(true, "accepted", false) };
    }
    // UP: cleanup-release only (doc 02 §3.9) — must follow OUR down.
    const held = this.session.takeHeldForRelease();
    if (held === null) {
      return refuse(
        "capability_fail_closed",
        "left_mouse_up refused: this session has no successful left_mouse_down to release.",
        "An accidental up cannot release the user's physical mouse press. Call left_mouse_down first.",
      );
    }
    const result = await this.backend.rawButton(this.run, held.point, false);
    this.session.clearHeld();
    if (!result.ok) {
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "mouse up failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false) };
  }

  /* ── text & keyboard ──────────────────────────────────────────────────── */

  private async toolType(args: Record<string, unknown>): Promise<DispatchResult> {
    const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
    const strategy = parseStrategy(args["strategy"]);
    const targetRes = this.resolveTarget(args["target"]);
    if (targetRes.ok && targetRes.target.type === "element") {
      // Mode 1: a11y value write (REPLACES content — doc 02 §4.1).
      const scope = this.resolveElementScope(targetRes.target);
      if (!scope.ok) return scope.refusal;
      if (!scope.element.flags.includes("editable")) {
        return { kind: "refusal", refusal: capabilityFailClosed("the element is not editable (set_value applies to editable fields)").refusal };
      }
      this.session.record("intent", `Typing into '${scope.element.name}' (a11y value write)`, "type");
      const descriptor: ElementDescriptor = {
        index: scope.element.index,
        kind: scope.element.kind,
        name: scope.element.name,
      };
      const result = await this.backend.setValue(
        this.run,
        scope.snapshot.app.pid,
        scope.window,
        descriptor,
        text,
      );
      this.session.markConsumed(targetRes.target.stateId);
      if (!result.ok) {
        if (result.stale) return { kind: "refusal", refusal: elementStaleChanged(targetRes.target.stateId).refusal };
        return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "value write failed").refusal };
      }
      return { kind: "receipt", receipt: receipt(true, "accepted", false, "matched") };
    }
    // Mode 2: app-scoped typing — Win/Linux require frontmost.
    const appRef = args["appRef"] ?? args["app_ref"];
    if (appRef === undefined) {
      return { kind: "refusal", refusal: targetlessInputRefused("type").refusal };
    }
    const resolved = await this.resolveAppRef(appRef);
    if (!resolved.ok) return resolved.refusal;
    const ref = appRef as Record<string, unknown>;
    void ref;
    const { windows, diagnostics } = await this.backend.listWindows(this.run, { pid: resolved.app.pid });
    const window = windows[0];
    if (window === undefined) {
      // R67-C: live-but-windowless pid → the honest helper-process refusal.
      return this.noAccessibleWindowRefusal(resolved.app.pid, diagnostics?.processRunning);
    }
    this.session.record("intent", `Typing into '${window.title}' (app-scoped)`, "type");
    // R68-C (C2): the frontmost auto-retry — a gate mismatch or a
    // script-level FRONTMOST_MISMATCH activates the target app (the
    // escalated ladder) and retries ONCE; the OLD behavior refused and
    // told the model to do exactly this by hand (the owner's live trace:
    // repeated frontmost_pid_mismatch refusals mid-flow).
    const result = await this.withForegroundRetry(resolved.app.pid, window.windowId, () =>
      this.backend.typeText(this.run, text, {
        pid: resolved.app.pid,
        windowId: window.windowId,
      }),
    );
    if (!result.ok && result.error?.startsWith("FRONTMOST_MISMATCH:")) {
      const active = Number.parseInt(result.error.split(":")[1] ?? "", 10);
      return { kind: "refusal", refusal: frontmostPidMismatch(resolved.app.pid, Number.isFinite(active) ? active : null).refusal };
    }
    if (!result.ok) {
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "typing failed").refusal };
    }
    if (strategy === "event") {
      // Doc 02 §4.1 mode 3 semantics: honestly reported possibly_sent.
      return { kind: "receipt", receipt: receipt(true, "possibly_sent", false) };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false) };
  }

  private async toolSetValue(args: Record<string, unknown>): Promise<DispatchResult> {
    const value = typeof args["value"] === "string" ? (args["value"] as string) : "";
    const targetRes = this.resolveTarget(args["target"]);
    if (!targetRes.ok) return targetRes.refusal;
    if (targetRes.target.type !== "element") {
      // Coordinate → hit-test through a11y to the owning editable.
      const resolved = this.resolveCoordinate(targetRes.target);
      if (!resolved.ok) return resolved.refusal;
      const hit = await this.backend.hitTest(this.run, resolved.global);
      if (hit === null || !hit.actionable) {
        return { kind: "refusal", refusal: capabilityFailClosed("no editable element owns that point (hit-test miss)").refusal };
      }
      return {
        kind: "refusal",
        refusal: capabilityFailClosed(
          "coordinate set_value needs the owning element's snapshot — observe the app and target the element",
        ).refusal,
      };
    }
    const scope = this.resolveElementScope(targetRes.target);
    if (!scope.ok) return scope.refusal;
    this.session.record("intent", `Setting value of '${scope.element.name}'`, "set_value");
    const descriptor: ElementDescriptor = {
      index: scope.element.index,
      kind: scope.element.kind,
      name: scope.element.name,
    };
    const result = await this.backend.setValue(
      this.run,
      scope.snapshot.app.pid,
      scope.window,
      descriptor,
      value,
    );
    this.session.markConsumed(targetRes.target.stateId);
    if (!result.ok) {
      if (result.stale) return { kind: "refusal", refusal: elementStaleChanged(targetRes.target.stateId).refusal };
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "set_value failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false, "matched") };
  }

  private async toolSelectText(args: Record<string, unknown>): Promise<DispatchResult> {
    const targetRes = this.resolveTarget(args["target"]);
    if (!targetRes.ok) return targetRes.refusal;
    if (targetRes.target.type !== "element") {
      return { kind: "refusal", refusal: capabilityFailClosed("select_text requires an element target (or hit-test via an element observation)").refusal };
    }
    const scope = this.resolveElementScope(targetRes.target);
    if (!scope.ok) return scope.refusal;
    const textRange = args["textRange"] ?? args["text_range"];
    let start = 0;
    let length: number | null = null;
    if (Array.isArray(textRange) && textRange.length === 2) {
      start = Number(textRange[0]) || 0;
      const len = Number(textRange[1]);
      length = Number.isInteger(len) && len >= 0 ? len : null;
    }
    this.session.record("intent", `Selecting text in '${scope.element.name}'`, "select_text");
    const descriptor: ElementDescriptor = {
      index: scope.element.index,
      kind: scope.element.kind,
      name: scope.element.name,
    };
    const result = await this.backend.selectRange(
      this.run,
      scope.snapshot.app.pid,
      scope.window,
      descriptor,
      start,
      length,
    );
    this.session.markConsumed(targetRes.target.stateId);
    if (!result.ok) {
      if (result.stale) return { kind: "refusal", refusal: elementStaleChanged(targetRes.target.stateId).refusal };
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "select failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false, "matched") };
  }

  private async toolKey(args: Record<string, unknown>): Promise<DispatchResult> {
    const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
    if (text.trim() === "") {
      return { kind: "refusal", refusal: invalidTarget("key text must name a key or chord, e.g. 'return' or 'ctrl+a'").refusal };
    }
    const repeat = Math.max(0, Math.min(100, Number(args["repeat"]) || 1));
    // R67-C: the plus-preserving splitter — '++' is the plus key, 'ctrl+a'
    // is a chord the backend composes (Windows: one SendInput VK chord,
    // R68-C — [U32]::Chord; Linux: one xdotool key string — the exact
    // tokens as before for ordinary chords).
    const keys = splitKeyChord(text);
    if (keys.length === 0) {
      return { kind: "refusal", refusal: invalidTarget("key text must name a key or chord, e.g. 'return' or 'ctrl+a'").refusal };
    }
    const appRef = args["appRef"] ?? args["app_ref"];
    if (appRef === undefined) {
      return { kind: "refusal", refusal: targetlessInputRefused("key").refusal };
    }
    const resolved = await this.resolveAppRef(appRef);
    if (!resolved.ok) return resolved.refusal;
    const ref = appRef as Record<string, unknown>;
    void ref;
    const { windows, diagnostics } = await this.backend.listWindows(this.run, { pid: resolved.app.pid });
    const window = windows[0];
    if (window === undefined) {
      // R67-C: live-but-windowless pid → the honest helper-process refusal.
      return this.noAccessibleWindowRefusal(resolved.app.pid, diagnostics?.processRunning);
    }
    this.session.record("intent", `Sending key '${text}'${repeat > 1 ? ` ×${repeat}` : ""}`, "key");
    let lastResult: { ok: boolean; error?: string } | undefined;
    for (let i = 0; i < Math.max(1, repeat); i++) {
      // R68-C (C2): each rawKey call rides the frontmost auto-retry — the
      // gate (which key never had before), the script-level mismatch
      // response, and the retry are all inside withForegroundRetry. The
      // chord composition itself stays the backend's job (one [U32]::Chord
      // per call — never tokens as text).
      lastResult = await this.withForegroundRetry(resolved.app.pid, window.windowId, () =>
        this.backend.rawKey(this.run, keys, {
          pid: resolved.app.pid,
          windowId: window.windowId,
        }),
      );
      if (lastResult && !lastResult.ok) break;
    }
    if (lastResult && !lastResult.ok && lastResult.error?.startsWith("FRONTMOST_MISMATCH:")) {
      const active = Number.parseInt(lastResult.error.split(":")[1] ?? "", 10);
      return { kind: "refusal", refusal: frontmostPidMismatch(resolved.app.pid, Number.isFinite(active) ? active : null).refusal };
    }
    if (!lastResult?.ok) {
      return { kind: "refusal", refusal: capabilityFailClosed(lastResult?.error ?? "key dispatch failed").refusal };
    }
    // R67-C: the Tab-walk readback — after a successful key press, read the
    // FOREGROUND app's focused element name. Best-effort on every path: a
    // null/empty/throwing readback is OMITTED, never a key failure (the
    // focusedElementName impls themselves scope on the foreground pid, so
    // the readback is honest only when the target still owns the focus).
    let focused: string | null = null;
    try {
      focused = await this.backend.focusedElementName(this.run, resolved.app.pid);
    } catch {
      focused = null;
    }
    const keyReceipt: Receipt & { focused?: string } = receipt(true, "accepted", false);
    if (focused !== null && focused.trim() !== "") {
      keyReceipt.focused = focused.trim().slice(0, 200);
    }
    return { kind: "receipt", receipt: keyReceipt };
  }

  private async toolHoldKey(args: Record<string, unknown>): Promise<DispatchResult> {
    const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
    const duration = Math.max(0, Math.min(30, Number(args["duration"]) || 1));
    const appRef = args["appRef"] ?? args["app_ref"];
    if (appRef === undefined) {
      return { kind: "refusal", refusal: targetlessInputRefused("hold_key").refusal };
    }
    const resolved = await this.resolveAppRef(appRef);
    if (!resolved.ok) return resolved.refusal;
    this.session.record("wait", `Holding '${text}' for ${duration}s`, "hold_key");
    // Hold = key down, wait, key up (composed from rawKey). R67-C: the same
    // plus-preserving splitter as the key tool. R68-C: the down call rides
    // the frontmost auto-retry (the up call is best-effort cleanup).
    const keys = splitKeyChord(text);
    const down = await this.withForegroundRetry(resolved.app.pid, undefined, () =>
      this.backend.rawKey(this.run, keys, { pid: resolved.app.pid, windowId: 0 }),
    );
    if (!down.ok) {
      if (down.error?.startsWith("FRONTMOST_MISMATCH:")) {
        const active = Number.parseInt(down.error.split(":")[1] ?? "", 10);
        return { kind: "refusal", refusal: frontmostPidMismatch(resolved.app.pid, Number.isFinite(active) ? active : null).refusal };
      }
      return { kind: "refusal", refusal: capabilityFailClosed(down.error ?? "hold failed").refusal };
    }
    await new Promise((resolve) => setTimeout(resolve, duration * 1000));
    await this.backend.rawKey(this.run, keys, { pid: resolved.app.pid, windowId: 0 });
    return { kind: "receipt", receipt: receipt(true, "possibly_sent", false) };
  }

  private async toolPerformAction(args: Record<string, unknown>): Promise<DispatchResult> {
    const action = typeof args["action"] === "string" ? (args["action"] as string) : "";
    const targetRes = this.resolveTarget(args["target"]);
    if (!targetRes.ok) return targetRes.refusal;
    if (targetRes.target.type !== "element") {
      return { kind: "refusal", refusal: capabilityFailClosed("perform_action requires an element target").refusal };
    }
    const scope = this.resolveElementScope(targetRes.target);
    if (!scope.ok) return scope.refusal;
    if (scope.element.actions !== undefined && !scope.element.actions.includes(action)) {
      return {
        kind: "refusal",
        refusal: capabilityFailClosed(
          `action '${action}' is not advertised by this element`,
          scope.element.actions,
        ).refusal,
      };
    }
    this.session.record("intent", `Performing '${action}' on '${scope.element.name}'`, "perform_action");
    const descriptor: ElementDescriptor = {
      index: scope.element.index,
      kind: scope.element.kind,
      name: scope.element.name,
    };
    const result = await this.backend.performAction(
      this.run,
      scope.snapshot.app.pid,
      scope.window,
      descriptor,
      action,
    );
    this.session.markConsumed(targetRes.target.stateId);
    if (!result.ok) {
      if (result.stale) return { kind: "refusal", refusal: elementStaleChanged(targetRes.target.stateId).refusal };
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "action failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false, "matched") };
  }

  private async toolWriteClipboard(args: Record<string, unknown>): Promise<DispatchResult> {
    const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
    const result = await this.backend.writeClipboard(this.run, text);
    if (!result.ok) {
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "clipboard write failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false) };
  }

  /* ── shared click paths ───────────────────────────────────────────────── */

  /** Coordinate click: hit-test (auto) → semantic press; else raw.
   * R69: stale frames auto-refresh here (resolveCoordinateAction).
   * R69 (task 4-c-2, D3): the hit-test's element name rides the receipt as
   * hitElementName — the model learns WHAT it clicked ("Search" edit,
   * "Sign in" button) without an extra round-trip. */
  private async coordinateClick(
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
    strategy: "auto" | "a11y" | "event",
    modifiers: string[],
  ): Promise<DispatchResult> {
    const resolved = await this.resolveCoordinateAction(target);
    if (!resolved.ok) return resolved.refusal;
    if (modifiers.length > 0 || strategy === "event") {
      return this.applyRefresh(
        await this.rawClickAt(resolved.global, resolved.frame.ownerAtCapture.pid, 1, modifiers, target),
        resolved.refresh,
      );
    }
    // R69 (4-c-2): the hit-test result is no longer discarded — its name
    // rides the receipt (see rawClickAt: the raw click actuates whatever is
    // at the point; hitTest tells the model what that IS).
    const hit = await this.backend.hitTest(this.run, resolved.global);
    if (hit !== null && hit.actionable) {
      if (strategy === "a11y" || strategy === "auto") {
        // Doc 07 §3: press the actionable element the point lands on.
        // We can't press by pointer identity across capsules — the honest
        // route is the raw click (the hit-test confirms the point is
        // actionable, the raw click actuates it). On macOS (background raw)
        // this is window-scoped anyway.
      }
    }
    return this.applyRefresh(
      withHitElementName(
        await this.rawClickAt(resolved.global, resolved.frame.ownerAtCapture.pid, 1, modifiers, target),
        hit,
      ),
      resolved.refresh,
    );
  }

  /** Raw click at global point, with the Win/Linux foreground gate. */
  private async rawClickAt(
    global: { x: number; y: number },
    scopePid: number,
    clickCount: 1 | 2 | 3,
    modifiers: string[],
    target: Target,
    element?: Element,
    button: "left" | "right" | "middle" = "left",
  ): Promise<DispatchResult> {
    if (target.type === "element") this.session.markConsumed(target.stateId);
    this.session.record(
      "intent",
      `Clicking ${button === "right" ? "right" : ""}(${global.x},${global.y})${element ? ` — '${element.name}'` : ""}`,
      button === "right" ? "right_click" : "left_click",
    );
    // R68-C (C2): the frontmost auto-retry — the OLD plain gate refusal is
    // replaced by activate + gate-retry ONCE (the frame-owner pid scopes
    // the recovery; a failed activation keeps the honest refusal).
    const result = await this.withForegroundRetry(scopePid, undefined, () =>
      this.backend.rawClick(this.run, global, button, clickCount, modifiers),
    );
    if (!result.ok) {
      if (result.error?.startsWith("FRONTMOST_MISMATCH:")) {
        const active = Number.parseInt(result.error.split(":")[1] ?? "", 10);
        return { kind: "refusal", refusal: frontmostPidMismatch(scopePid, Number.isFinite(active) ? active : null).refusal };
      }
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "click failed").refusal };
    }
    // R69 (4-c-2, D5): element-routed raw clicks (middle/right on element
    // targets, left_click's event path) carry the element's name — the model
    // learns what the click actuated.
    const clicked: Receipt = receipt(true, "accepted", false, "unverified");
    if (element !== undefined && element.name.trim() !== "") {
      clicked.hitElementName = element.name.trim().slice(0, 120);
    }
    return { kind: "receipt", receipt: clicked };
  }

  /** Raw coordinate click without element context.
   * R69: stale frames auto-refresh here (resolveCoordinateAction). */
  private async rawCoordinateClick(
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
    button: "left" | "middle",
    clickCount: 1 | 2 | 3,
    modifiers: string[],
  ): Promise<DispatchResult> {
    const resolved = await this.resolveCoordinateAction(target);
    if (!resolved.ok) return resolved.refusal;
    return this.applyRefresh(
      await this.rawClickAt(
        resolved.global,
        resolved.frame.ownerAtCapture.pid,
        clickCount,
        modifiers,
        target,
        undefined,
        button === "middle" ? "middle" : "left",
      ),
      resolved.refresh,
    );
  }

  /** The semantic press path (element target, strategy auto/a11y). */
  private async semanticPress(target: { type: "element"; stateId: string; index: number }): Promise<DispatchResult> {
    const scope = this.resolveElementScope(target);
    if (!scope.ok) return scope.refusal;
    if (!scope.element.flags.includes("pressable")) {
      return {
        kind: "refusal",
        refusal: capabilityFailClosed(
          `the element '${scope.element.name}' is not pressable (no pressable flag)`,
          scope.element.actions,
        ).refusal,
      };
    }
    this.session.record("intent", `Pressing '${scope.element.name}'`, "left_click");
    const descriptor: ElementDescriptor = {
      index: scope.element.index,
      kind: scope.element.kind,
      name: scope.element.name,
    };
    const result = await this.backend.pressElement(
      this.run,
      scope.snapshot.app.pid,
      scope.window,
      descriptor,
    );
    this.session.markConsumed(target.stateId);
    if (!result.ok) {
      if (result.stale) return { kind: "refusal", refusal: elementStaleChanged(target.stateId).refusal };
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "press failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false, "matched") };
  }

  /* ── raster cache (zoom + vision) ─────────────────────────────────────── */

  private cacheRaster(frameId: string, pngBase64: string): void {
    this.rasterCache.set(frameId, pngBase64);
    while (this.rasterCache.size > 3) {
      const oldest = this.rasterCache.keys().next().value;
      if (oldest === undefined) break;
      this.rasterCache.delete(oldest);
    }
  }

  /** The PNG for a frame (the tools layer uses this for vision). */
  rasterFor(frameId: string): string | undefined {
    return this.rasterCache.get(frameId);
  }

  /* ── R69 (task 4-c-1): the screenshot-spam guard ───────────────────────── */

  /**
   * The gate every MODEL-initiated capture (screenshot / zoom /
   * get_app_state{includeScreenshot}) passes AFTER the backend returns the
   * bytes and BEFORE the frame is registered: a refused capture registers
   * nothing, caches nothing, streams nothing (the raster is near-identical
   * to the previous one anyway). Auto-refresh captures never come through
   * here — only the model's own re-observation can spam.
   *
   * The counter resets on: (a) any mutating dispatch (dispatch()), (b) a
   * capture whose full-frame aHash is > SPAM_IDENTICAL_HAMMING bits from the
   * previous registered raster (the screen changed), (c) a foreground-app
   * change (pid proxy for a title change — the detectable identity without
   * a new backend primitive; a same-pid title change is still caught by (b)
   * when it moves title-bar pixels), (d) an unhashable/first capture (no
   * comparison possible — never a false refusal). Once the 3rd consecutive
   * near-identical capture is refused the counter STAYS saturated: every
   * further identical capture refuses until a real reset happens (the
   * refusal's alternatives are act/wait/change-strategy — heeding any of
   * them resets).
   */
  private guardModelCapture(pngBase64: string, foregroundPid: number | null): Refusal | null {
    if (
      foregroundPid !== null &&
      this.lastCaptureForegroundPid !== null &&
      foregroundPid !== this.lastCaptureForegroundPid
    ) {
      this.consecutiveIdenticalCaptures = 0;
    }
    if (foregroundPid !== null) this.lastCaptureForegroundPid = foregroundPid;
    const prevFrame = this.session.latestFrame();
    const newHash = hashFrame(pngBase64);
    if (newHash === null) {
      // Unhashable bytes — never a false refusal, never counted.
      this.consecutiveIdenticalCaptures = 0;
      return null;
    }
    if (prevFrame === undefined || prevFrame.aHash === undefined) {
      // The FIRST judgeable capture starts the run at length 1 (the "3
      // identical frames" in the refusal message count the baseline).
      this.consecutiveIdenticalCaptures = 1;
      return null;
    }
    if (hamming(newHash.aHash, prevFrame.aHash) > SPAM_IDENTICAL_HAMMING) {
      // The screen changed — a legitimate re-observation; this capture is
      // the FIRST of a new run.
      this.consecutiveIdenticalCaptures = 1;
      return null;
    }
    this.consecutiveIdenticalCaptures += 1;
    if (this.consecutiveIdenticalCaptures >= SPAM_CONSECUTIVE_LIMIT) {
      return screenUnchanged().refusal;
    }
    return null;
  }

  /** Test hook: fresh dispatcher on the same session. */
  resetForTests(): void {
    this.rasterCache.clear();
    this.selectedDisplay = 1;
    this.consecutiveIdenticalCaptures = 0;
    this.lastCaptureForegroundPid = null;
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function parseStrategy(raw: unknown): "auto" | "a11y" | "event" {
  return raw === "a11y" || raw === "event" ? raw : "auto";
}

/**
 * R69 (task 4-c-2, D3): stamp a hit-test's element name onto a click
 * receipt as hitElementName (the hit-test that already runs at the
 * coordinate-click site was computed-then-discarded; the model now learns
 * WHAT it clicked). A refusal, a null hit, or an empty name passes through
 * unchanged — the field is additive, never fabricated.
 */
function withHitElementName(
  result: DispatchResult,
  hit: { name: string } | null,
): DispatchResult {
  if (result.kind !== "receipt" || hit === null || hit.name.trim() === "") return result;
  return {
    ...result,
    receipt: {
      ...result.receipt,
      hitElementName: hit.name.trim().slice(0, 120),
    },
  };
}

function elementCenter(el: Element): { x: number; y: number } | null {
  if (el.bounds === undefined) return null;
  return { x: Math.round(el.bounds[0] + el.bounds[2] / 2), y: Math.round(el.bounds[1] + el.bounds[3] / 2) };
}

/** R69: a frame's raster coverage in GLOBAL points (image px ÷ scale). */
function coverageWidth(frame: FrameInfo): number {
  return Math.max(1, Math.round(frame.size.w / frame.scale));
}

/** R69: see coverageWidth. */
function coverageHeight(frame: FrameInfo): number {
  return Math.max(1, Math.round(frame.size.h / frame.scale));
}

/** Type re-export for the tools layer. */
export type { ToolOutcome };
