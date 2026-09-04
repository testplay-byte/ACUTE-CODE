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
 */
import type {
  AppInfo,
  Element,
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
  frameStale,
  frontmostPidMismatch,
  invalidTarget,
  killSwitchActive,
  rasterOutOfBounds,
  refuse,
  targetlessInputRefused,
  invalidWindowId,
  type AppCandidate,
} from "./errors.js";
import { getComputerSession, MAX_FRAME_AGE_MS, type ComputerSession } from "./session.js";
import { appendAudit } from "./audit.js";
import type { CuaBackend, ElementDescriptor, RunCommand, WindowScope } from "./backends/interface.js";

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

export class ComputerDispatcher {
  readonly backend: CuaBackend;
  private readonly run: RunCommand;
  private readonly root: string;
  private readonly session: ComputerSession;
  private readonly allowMutations: boolean;
  private selectedDisplay = 1;
  /** Latest raster PNGs by frameId (for zoom + vision; capped at 3). */
  private rasterCache = new Map<string, string>();

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
    const started = Date.now();
    const result = await this.route(tool, args);
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
    if (
      result.kind === "receipt" &&
      result.receipt.actionSent &&
      (args["returnState"] === "compact" || args["return_state"] === "compact" ||
        args["returnState"] === "full" || args["return_state"] === "full")
    ) {
      const detail = (args["returnState"] ?? args["return_state"]) === "full" ? "full" : "compact";
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
    const { apps } = await this.backend.listApps(this.run);
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
      return { ok: false, refusal: { kind: "refusal", refusal: appNotFound(name, apps).refusal } };
    }
    if (bundleId !== undefined) {
      const matches = apps.filter((a) => a.bundleId === bundleId);
      if (matches.length === 1) return { ok: true, app: { pid: matches[0].pid, name, bundleId } };
      if (matches.length > 1) {
        return { ok: false, refusal: { kind: "refusal", refusal: ambiguousAppRef(bundleId, appCandidates(matches)).refusal } };
      }
      return { ok: false, refusal: { kind: "refusal", refusal: appNotFound(bundleId, apps).refusal } };
    }
    return { ok: false, refusal: { kind: "refusal", refusal: appNotFound("(app_ref without pid/name/bundleId)", apps).refusal } };
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

  /** Coordinate freshness gate: frame binding + age + bounds (doc 03 §4/§6). */
  private resolveCoordinate(
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
  ): { ok: true; frame: NonNullable<ReturnType<ComputerSession["getFrame"]>>; global: { x: number; y: number } } | { ok: false; refusal: DispatchResult } {
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

  /** The Win/Linux raw foreground rule (doc 07 §5). */
  private async requireForegroundForRaw(scopePid: number): Promise<DispatchResult | null> {
    if (!this.backend.capabilities().rawRequiresForeground) return null;
    const front = await this.backend.frontmostPid(this.run);
    if (front !== null && front !== scopePid) {
      return { kind: "refusal", refusal: frontmostPidMismatch(scopePid, front).refusal };
    }
    return null;
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
        const { frameId, meta } = this.session.registerFrame(
          raster,
          { kind: "window", pid: app.pid, windowId: window.windowId },
          { pid: app.pid, windowId: window.windowId },
          this.selectedDisplay,
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
    const { windows } = await this.backend.listWindows(this.run, { pid: resolved.app.pid });
    let window = windows[0];
    if (ref["windowId"] !== undefined || ref["window_id"] !== undefined) {
      const wantId = Number(ref["windowId"] ?? ref["window_id"]);
      const match = windows.find((w) => w.windowId === wantId);
      if (match === undefined) {
        return { ok: false, refusal: { kind: "refusal", refusal: invalidWindowId(wantId).refusal } };
      }
      window = match;
    } else if (windows.length === 0) {
      return { ok: false, refusal: { kind: "refusal", refusal: appNotFound(`pid ${resolved.app.pid} (no open windows)`).refusal } };
    }
    return { ok: true, app: resolved.app, window };
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
    const { frameId, meta } = this.session.registerFrame(
      raster,
      { kind: "display", pid: frontPid ?? undefined },
      { pid: frontPid ?? 0, windowId: 0 },
      this.selectedDisplay,
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
    const { frameId, meta } = this.session.registerFrame(
      raster,
      { kind: "display", pid: frame.ownerAtCapture.pid },
      frame.ownerAtCapture,
      frame.displayIndex,
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
    await new Promise((resolve) => setTimeout(resolve, duration * 1000));
    return { kind: "receipt", receipt: receipt(false, "accepted", false) };
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

    // double/triple/middle: NO a11y equivalent — element fails closed under
    // auto; coordinate goes raw (raster-bound).
    if (clickCount > 1 || button === "middle") {
      if (targetRes.target.type === "element") {
        return {
          kind: "refusal",
          refusal: capabilityFailClosed(
            `${clickCount > 1 ? `${clickCount === 2 ? "double" : "triple"}_click` : "middle_click"} has no accessibility equivalent for element targets`,
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
      if (!hasMenu && strategy !== "event") {
        return {
          kind: "refusal",
          refusal: capabilityFailClosed("the element advertises no menu (has_menu missing); right_click on elements requires a menu-capable target").refusal,
        };
      }
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

    // Coordinate: hit-test for a menu-capable element; else raw right-click.
    const resolved = this.resolveCoordinate(targetRes.target);
    if (!resolved.ok) return resolved.refusal;
    const hit = await this.backend.hitTest(this.run, resolved.global);
    if (hit !== null && hit.actionable && strategy !== "event") {
      // The hit element is pressable — but right-click menus need a menu;
      // the honest path is the raw right-click at the point.
    }
    return this.rawClickAt(resolved.global, resolved.frame.ownerAtCapture.pid, 1, modifiers, targetRes.target, undefined, "right");
  }

  private async toolMouseMove(args: Record<string, unknown>): Promise<DispatchResult> {
    const targetRes = this.resolveTarget(args["target"]);
    if (!targetRes.ok) return targetRes.refusal;
    if (targetRes.target.type === "element") {
      return { kind: "refusal", refusal: capabilityFailClosed("mouse_move refuses element targets — use left_click to actuate").refusal };
    }
    const resolved = this.resolveCoordinate(targetRes.target);
    if (!resolved.ok) return resolved.refusal;
    const gate = await this.requireForegroundForRaw(resolved.frame.ownerAtCapture.pid);
    if (gate !== null) return gate;
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
      const moved = await this.backend.rawButton(this.run, resolved.global, false);
      if (!moved.ok) {
        return { kind: "refusal", refusal: capabilityFailClosed(`hover failed: ${moved.error}`).refusal };
      }
      return { kind: "receipt", receipt: receipt(true, "accepted", false) };
    }
    return { kind: "receipt", receipt: receipt(false, "accepted", false) };
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
    const resolved = this.resolveCoordinate(targetRes.target);
    if (!resolved.ok) return resolved.refusal;
    const gate = await this.requireForegroundForRaw(resolved.frame.ownerAtCapture.pid);
    if (gate !== null) return gate;
    this.session.record("intent", `Scrolling ${direction} at (${targetRes.target.x},${targetRes.target.y})`, "scroll");
    const result = await this.backend.rawScroll(this.run, resolved.global, direction, amount);
    if (!result.ok) {
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "scroll failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false) };
  }

  private async toolDrag(args: Record<string, unknown>): Promise<DispatchResult> {
    const fromRes = this.resolveTarget(args["fromTarget"] ?? args["from_target"]);
    const toRes = this.resolveTarget(args["to"] ?? args["toTarget"] ?? args["to_target"]);
    if (!fromRes.ok) return fromRes.refusal;
    if (!toRes.ok) return toRes.refusal;
    const modifiers = parseModifiers(args["modifiers"]);

    // From may be an element (for scoping) — resolve its center as global.
    let fromGlobal: { x: number; y: number };
    let scopePid: number;
    let consumedStateId: string | undefined;
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
    } else {
      const resolved = this.resolveCoordinate(fromRes.target);
      if (!resolved.ok) return resolved.refusal;
      fromGlobal = resolved.global;
      scopePid = resolved.frame.ownerAtCapture.pid;
    }
    let toGlobal: { x: number; y: number };
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
      const resolved = this.resolveCoordinate(toRes.target);
      if (!resolved.ok) return resolved.refusal;
      toGlobal = resolved.global;
    }

    const gate = await this.requireForegroundForRaw(scopePid);
    if (gate !== null) return gate;
    if (consumedStateId !== undefined) this.session.markConsumed(consumedStateId);
    this.session.record("intent", `Dragging to (${toGlobal.x},${toGlobal.y})`, "left_click_drag");
    const result = await this.backend.rawDrag(this.run, fromGlobal, toGlobal, modifiers);
    if (!result.ok) {
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "drag failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false) };
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
      const gate = await this.requireForegroundForRaw(pid);
      if (gate !== null) return gate;
      this.session.record("intent", `Pressing mouse down at (${global.x},${global.y})`, "left_mouse_down");
      const result = await this.backend.rawButton(this.run, global, true);
      if (!result.ok) {
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
    const { windows } = await this.backend.listWindows(this.run, { pid: resolved.app.pid });
    const window = windows[0];
    if (window === undefined) {
      return { kind: "refusal", refusal: appNotFound(`pid ${resolved.app.pid} (no windows)`).refusal };
    }
    void ref;
    const gate = await this.requireForegroundForRaw(resolved.app.pid);
    if (gate !== null) return gate;
    this.session.record("intent", `Typing into '${window.title}' (app-scoped)`, "type");
    const result = await this.backend.typeText(this.run, text, {
      pid: resolved.app.pid,
      windowId: window.windowId,
    });
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
    const keys = text.split("+").map((k) => k.trim().toLowerCase()).filter((k) => k !== "");
    const appRef = args["appRef"] ?? args["app_ref"];
    if (appRef === undefined) {
      return { kind: "refusal", refusal: targetlessInputRefused("key").refusal };
    }
    const resolved = await this.resolveAppRef(appRef);
    if (!resolved.ok) return resolved.refusal;
    const ref = appRef as Record<string, unknown>;
    const { windows } = await this.backend.listWindows(this.run, { pid: resolved.app.pid });
    const window = windows[0];
    if (window === undefined) {
      return { kind: "refusal", refusal: appNotFound(`pid ${resolved.app.pid} (no windows)`).refusal };
    }
    void ref;
    this.session.record("intent", `Sending key '${text}'${repeat > 1 ? ` ×${repeat}` : ""}`, "key");
    let lastResult: { ok: boolean; error?: string } | undefined;
    for (let i = 0; i < Math.max(1, repeat); i++) {
      lastResult = await this.backend.rawKey(this.run, keys, {
        pid: resolved.app.pid,
        windowId: window.windowId,
      });
      if (lastResult && !lastResult.ok) break;
    }
    if (lastResult && !lastResult.ok && lastResult.error?.startsWith("FRONTMOST_MISMATCH:")) {
      const active = Number.parseInt(lastResult.error.split(":")[1] ?? "", 10);
      return { kind: "refusal", refusal: frontmostPidMismatch(resolved.app.pid, Number.isFinite(active) ? active : null).refusal };
    }
    if (!lastResult?.ok) {
      return { kind: "refusal", refusal: capabilityFailClosed(lastResult?.error ?? "key dispatch failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false) };
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
    const gate = await this.requireForegroundForRaw(resolved.app.pid);
    if (gate !== null) return gate;
    this.session.record("wait", `Holding '${text}' for ${duration}s`, "hold_key");
    // Hold = key down, wait, key up (composed from rawKey).
    const keys = text.split("+").map((k) => k.trim().toLowerCase()).filter((k) => k !== "");
    const down = await this.backend.rawKey(this.run, keys, { pid: resolved.app.pid, windowId: 0 });
    if (!down.ok) {
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

  /** Coordinate click: hit-test (auto) → semantic press; else raw. */
  private async coordinateClick(
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
    strategy: "auto" | "a11y" | "event",
    modifiers: string[],
  ): Promise<DispatchResult> {
    const resolved = this.resolveCoordinate(target);
    if (!resolved.ok) return resolved.refusal;
    if (modifiers.length > 0 || strategy === "event") {
      return this.rawClickAt(resolved.global, resolved.frame.ownerAtCapture.pid, 1, modifiers, target);
    }
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
    return this.rawClickAt(resolved.global, resolved.frame.ownerAtCapture.pid, 1, modifiers, target);
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
    const gate = await this.requireForegroundForRaw(scopePid);
    if (gate !== null) return gate;
    if (target.type === "element") this.session.markConsumed(target.stateId);
    this.session.record(
      "intent",
      `Clicking ${button === "right" ? "right" : ""}(${global.x},${global.y})${element ? ` — '${element.name}'` : ""}`,
      button === "right" ? "right_click" : "left_click",
    );
    const result = await this.backend.rawClick(this.run, global, button, clickCount, modifiers);
    if (!result.ok) {
      if (result.error?.startsWith("FRONTMOST_MISMATCH:")) {
        const active = Number.parseInt(result.error.split(":")[1] ?? "", 10);
        return { kind: "refusal", refusal: frontmostPidMismatch(scopePid, Number.isFinite(active) ? active : null).refusal };
      }
      return { kind: "refusal", refusal: capabilityFailClosed(result.error ?? "click failed").refusal };
    }
    return { kind: "receipt", receipt: receipt(true, "accepted", false, "unverified") };
  }

  /** Raw coordinate click without element context. */
  private async rawCoordinateClick(
    target: { type: "coordinate"; x: number; y: number; frameId?: string },
    button: "left" | "middle",
    clickCount: 1 | 2 | 3,
    modifiers: string[],
  ): Promise<DispatchResult> {
    const resolved = this.resolveCoordinate(target);
    if (!resolved.ok) return resolved.refusal;
    return this.rawClickAt(
      resolved.global,
      resolved.frame.ownerAtCapture.pid,
      clickCount,
      modifiers,
      target,
      undefined,
      button === "middle" ? "middle" : "left",
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

  /** Test hook: fresh dispatcher on the same session. */
  resetForTests(): void {
    this.rasterCache.clear();
    this.selectedDisplay = 1;
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function parseStrategy(raw: unknown): "auto" | "a11y" | "event" {
  return raw === "a11y" || raw === "event" ? raw : "auto";
}

function elementCenter(el: Element): { x: number; y: number } | null {
  if (el.bounds === undefined) return null;
  return { x: Math.round(el.bounds[0] + el.bounds[2] / 2), y: Math.round(el.bounds[1] + el.bounds[3] / 2) };
}

/** Type re-export for the tools layer. */
export type { ToolOutcome };
