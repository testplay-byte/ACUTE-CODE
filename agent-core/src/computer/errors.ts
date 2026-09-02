/**
 * ROUND-61 (R61): the refusal factory — doc 11-error-catalog.md's contract:
 * every refusal (a) names the reason machine-readably, (b) explains it in
 * one sentence, (c) states that nothing was sent when true, and (d)
 * prescribes the EXACT next step. "Refusals are the system's richest
 * signal" — the message templates below follow doc 11 §7's shape so the
 * agent can recover instead of flail. One factory, used by dispatch.ts and
 * the tools layer; tests pin every message's self-teaching shape.
 */
import type { Refusal, RefusalCode } from "./types.js";

/** Receipt-shaped refusal outcome (actionSent always false). */
export interface RefusalOutcome {
  kind: "refusal";
  refusal: Refusal;
}

export function refuse(
  error: RefusalCode,
  message: string,
  recovery: string,
  payload?: Record<string, unknown>,
): RefusalOutcome {
  return { kind: "refusal", refusal: { error, message, recovery, payload } };
}

/* The catalog (doc 11). Each helper: what was refused, why, nothing sent,
 * the exact next step. */

export function killSwitchActive(): RefusalOutcome {
  return refuse(
    "kill_switch_active",
    "The computer-control session was stopped: every further computer-use action is refused.",
    "End the turn. Do not call any further computer-use tools; report the stop honestly to the user.",
  );
}

export function computerUseDisabled(): RefusalOutcome {
  return refuse(
    "computer_use_disabled",
    "Computer use is turned OFF in Settings (the master switch).",
    "Tell the user to enable it in Settings → Computer Use if they want desktop control, then end the turn. Do not retry.",
  );
}

export function hostPolicyDenied(tool: string, why: string): RefusalOutcome {
  return refuse(
    "host_policy_denied",
    `Host policy refused ${tool}: ${why}`,
    "Continue with a background-safe path (element targets / read-only tools) or ask the user to adjust the posture in Settings → Computer Use.",
  );
}

export function appNotFound(ref: string): RefusalOutcome {
  return refuse(
    "app_not_found",
    `No running application matches '${ref}'.`,
    "Call list_apps to see what is actually running; re-resolve the app_ref from that list. Never guess a new pid.",
    { requested: ref },
  );
}

export function ambiguousAppRef(name: string, pids: number[]): RefusalOutcome {
  return refuse(
    "ambiguous_app_ref",
    `The name '${name}' matches multiple running applications.`,
    "Scope with pid (or bundle_id) instead of the ambiguous name.",
    { candidates: pids },
  );
}

export function couldNotLaunch(name: string): RefusalOutcome {
  return refuse(
    "could_not_launch",
    `open_application could not launch '${name}'.`,
    "Verify the EXACT app name/bundle_id the user gave (character-for-character; never translate, shorten, or retry variant spellings), then launch once more via the resolved identity. Do not substitute a different app.",
    { name },
  );
}

export function invalidWindowId(windowId: number): RefusalOutcome {
  return refuse(
    "invalid_window_id",
    `window_id ${windowId} is invented, unowned, or no longer valid.`,
    "Use a real id from list_windows or get_app_state. Never use a placeholder such as 1.",
    { windowId },
  );
}

export function elementStaleSuperseded(stateId: string): RefusalOutcome {
  return refuse(
    "element_stale",
    `Element target state_id '${stateId}' was superseded by an action that may already have changed the app.`,
    "Call get_app_state and use the returned fresh state_id; do not retry the previous action. action_sent=false.",
    { stateId, cause: "superseded" },
  );
}

export function elementStaleChanged(stateId: string): RefusalOutcome {
  return refuse(
    "element_stale",
    `The element under state_id '${stateId}' no longer resolves — the UI changed.`,
    "Re-observe with get_app_state, re-locate the element in the fresh tree, and issue a NEW action only if still needed.",
    { stateId, cause: "ui_changed" },
  );
}

export function elementStaleScope(stateId: string, now: string): RefusalOutcome {
  return refuse(
    "element_stale",
    `The surface for state_id '${stateId}' changed (${now}); the snapshot's scope no longer matches.`,
    "Re-observe the app; a dialog may have opened or the tab/surface switched. Work the frontmost surface first if it is a dialog.",
    { stateId, cause: "scope_drift", surface: now },
  );
}

export function frameStale(frameId: string, why: string): RefusalOutcome {
  return refuse(
    "frame_stale",
    `The coordinate frame '${frameId}' is stale: ${why}`,
    "Take a fresh screenshot (or get_app_state with include_screenshot), choose new pixels from THAT image, and submit them unchanged.",
    { frameId },
  );
}

export function occlusionOwnerMismatch(covering: string): RefusalOutcome {
  return refuse(
    "occlusion_owner_mismatch",
    `Another window now covers the target point: '${covering}'.`,
    "Raise the window you meant to act on with open_application(activate=true), re-observe, and retry. NEVER move, resize, or close the reported window — it may be an invisible overlay belonging to the user's environment.",
    { coveringWindow: covering },
  );
}

export function frontmostPidMismatch(scopePid: number, activePid: number | null): RefusalOutcome {
  return refuse(
    "frontmost_pid_mismatch",
    `Raw input scoped to app pid ${scopePid} was refused because the live frontmost application is pid ${activePid ?? "unknown"}. action_sent=false.`,
    "Re-activate the target with open_application(activate=true), refresh state with get_app_state, then retry once with the fresh target. Do not replay blindly.",
    { scopePid, activePid },
  );
}

export function foregroundRequired(why: string): RefusalOutcome {
  return refuse(
    "foreground_required",
    `The event-strategy path requires the target app/window to already be frontmost and focused: ${why}`,
    "Repeat the confirmed activation (open_application activate=true) and a fresh observation, then retry. Do not retry the key blindly.",
  );
}

export function uipiBlocked(name: string): RefusalOutcome {
  return refuse(
    "uipi_blocked",
    `The target '${name}' runs at a higher integrity level (elevated); the OS would silently swallow the input.`,
    "Report to the user — a human step is needed (run the target non-elevated, or run ACUTE elevated). Retrying is pointless: Windows discards the input without an error.",
    { target: name },
  );
}

export function targetlessInputRefused(tool: string): RefusalOutcome {
  return refuse(
    "targetless_input_refused",
    `${tool} without a target was refused: a global keystroke could land in the user's frontmost app.`,
    "Scope the input with an element target or an app_ref (pid + window_id).",
  );
}

export function capabilityFailClosed(what: string, actions?: string[]): RefusalOutcome {
  return refuse(
    "capability_fail_closed",
    `The target does not support the requested semantic action: ${what}.`,
    "Re-observe with detail:'full' to list the element's advertised actions; choose an expressive tool (perform_action with a listed action, set_value, or the event path where the tool allows it) instead of forcing it.",
    actions ? { availableActions: actions } : undefined,
  );
}

export function unsupportedOnBackend(what: string, backend: string): RefusalOutcome {
  return refuse(
    "unsupported_on_backend",
    `${what} is not supported by the ${backend} backend.`,
    "Do not retry on this platform. Report the limitation honestly and continue with the accessibility path or end the step.",
    { backend },
  );
}

export function visionDisabled(why: string): RefusalOutcome {
  return refuse(
    "vision_disabled",
    `Vision is not available: ${why}.`,
    "Configure the vision model in Settings → Computer Use (a separate vision model, or main-model vision when the row supports it), or proceed with the accessibility tree only. action_sent=false.",
  );
}

export function rasterOutOfBounds(x: number, y: number, w: number, h: number): RefusalOutcome {
  return refuse(
    "raster_out_of_bounds",
    `Coordinate (${x}, ${y}) lies outside the latest raster (${w}×${h}).`,
    "Re-look at the returned image and resubmit pixels chosen from it. Never scale or transform coordinates yourself.",
    { x, y, raster: { w, h } },
  );
}

export function accessibilityDenied(): RefusalOutcome {
  return refuse(
    "accessibility_denied",
    "OS accessibility permission is not granted to the automation process.",
    "Tell the user authorization is required (macOS: System Settings → Privacy & Security → Accessibility; Linux: AT-SPI availability) and END the turn. Do not call other computer-use actions or retry the probe.",
  );
}

export function screenRecordingDenied(): RefusalOutcome {
  return refuse(
    "screen_recording_denied",
    "OS screen-recording permission is not granted; captures and window titles are unavailable.",
    "Tell the user authorization is required (macOS: Privacy & Security → Screen Recording) and end the turn. Continue with accessibility-tree data only if the task allows.",
  );
}

export function permissionDenied(why: string): RefusalOutcome {
  return refuse(
    "permission_denied",
    `The OS or policy layer refused: ${why}`,
    "Read the message and follow the named reason. Do NOT infer macOS permission loss from a generic refusal — only request_access reports TCC state.",
  );
}

export function requestAccessRefused(why: string): RefusalOutcome {
  return refuse(
    "request_access_refused",
    `The readiness probe itself failed: ${why}`,
    "Report and end the turn. Do not loop-probe.",
  );
}

export function emptyTree(appName: string): RefusalOutcome {
  return refuse(
    "capability_fail_closed",
    `'${appName}' exposes no accessibility tree (empty).`,
    "Fall back to the visual pipeline: screenshot + frame-bound coordinate actions. Do not assume the tools are broken.",
    { appName, emptyTree: true },
  );
}

export function invalidTarget(why: string): RefusalOutcome {
  return refuse(
    "capability_fail_closed",
    `Invalid target: ${why}`,
    "Use {type:'element', state_id, index} from a live get_app_state, or {type:'coordinate', x, y} copied unchanged from the latest raster.",
  );
}
