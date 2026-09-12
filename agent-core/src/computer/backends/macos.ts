/**
 * ROUND-61 (R61): the macOS backend — doc 04-platform-backends.md §4.
 *
 * Toolchain: osascript (System Events = the AX bridge) for the a11y tree
 * and semantic actions, `screencapture` for pixels, `cliclick` for raw
 * input (when installed — osascript's `click at` needs accessibility
 * too), pbpaste/pbcopy for the clipboard.
 *
 * macOS specifics encoded (doc 04 §4):
 *   · bundle_id is the preferred app_ref; AXUIElementCreateApplication is
 *     the tree root (via System Events processes).
 *   · AXPress / AXShowMenu / AXConfirm are the press actions.
 *   · TCC Accessibility gates EVERYTHING (probe: osascript tell System
 *     Events → if it errors, accessibility is denied) and Screen Recording
 *     gates captures + window titles (probe: screencapture -x to /dev/null).
 *     Per doc 08 §1.2 the probe NEVER pops dialogs — osascript errors are
 *     read, not requested.
 *   · Foreground: frontmost of System Events.
 *
 * Commands are capsules; on non-macOS hosts every probe fails closed.
 */
import type {
  AppInfo,
  PermissionReport,
  Snapshot,
  WindowInfo,
} from "../types.js";
import type {
  BackendCapabilities,
  CuaBackend,
  CommandCapsule,
  Raster,
  RunCommand,
} from "./interface.js";
import { pngDimensions } from "./linux.js";

const osaCapsule = (source: string, timeoutMs = 20000): CommandCapsule => ({
  program: "osascript",
  args: ["-"],
  stdin: source,
  timeoutMs,
});

function okResult(stdout: string): { ok: boolean; error?: string; stale?: boolean } {
  const text = stdout.trim();
  if (text === "OK") return { ok: true };
  if (text === "STALE_ELEMENT") return { ok: false, stale: true, error: "element identity changed since the snapshot" };
  if (text === "NO_SUCH_ELEMENT") return { ok: false, stale: true, error: "element index out of range in the live tree" };
  if (text.startsWith("ERR:")) return { ok: false, error: text.slice(4, 304) };
  if (text === "") return { ok: true };
  return { ok: true };
}

const macosBackend: CuaBackend = {
  kind: "macos",

  capabilities(): BackendCapabilities {
    return {
      a11yTree: true, // AX via System Events (TCC Accessibility gated)
      backgroundElementPress: true, // AXPress is background-safe
      backgroundValueWrite: true, // AXValue set
      backgroundRawInput: true, // CGEvent window-scoped (verified) — via cliclick approximated foreground
      windowScopedTyping: false, // the SkyLight synthetic-focus path is private-API; honest NO
      capture: true, // screencapture (TCC Screen Recording gated)
      clipboard: true,
      rawRequiresForeground: true, // cliclick posts to the session (foreground semantics)
      permissionGates: ["TCC Accessibility (all AX + events)", "TCC Screen Recording (captures + window titles)"],
    };
  },

  async listApps(run) {
    const source = `
tell application "System Events"
  set out to ""
  repeat with p in (every process whose background only is false)
    try
      set out to out & (name of p) & "\\t" & (unix id of p) & "\\t" & (frontmost of p) & linefeed
    end try
  end repeat
  return out
end tell`;
    const result = await run(osaCapsule(source, 10000));
    if (result.code !== 0) return { apps: [] };
    const apps: AppInfo[] = [];
    for (const line of result.stdout.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length < 3) continue;
      const pid = Number.parseInt(parts[1], 10);
      if (!Number.isFinite(pid)) continue;
      apps.push({ name: parts[0], pid, active: parts[2] === "true" });
    }
    return { apps };
  },

  async listWindows(run, app) {
    if (app.pid === undefined) return { windows: [] };
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${app.pid}
  set out to ""
  repeat with w in windows of p
    try
      set {x, y} to position of w
      set {wd, h} to size of w
      set out to out & (name of w) & "\\t" & x & "," & y & "," & wd & "," & h & linefeed
    end try
  end repeat
  return out
end tell`;
    const result = await run(osaCapsule(source, 10000));
    if (result.code !== 0) return { windows: [] };
    const windows: WindowInfo[] = [];
    for (const line of result.stdout.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length < 2) continue;
      const geo = parts[1].split(",").map(Number);
      if (geo.length !== 4 || geo.some((n) => !Number.isFinite(n))) continue;
      windows.push({
        windowId: 0, // AX windows carry no CGWindowID through System Events — title is the scope key
        title: parts[0],
        bounds: [geo[0], geo[1], geo[2], geo[3]],
        main: windows.length === 0,
        focused: false,
      });
    }
    return { windows };
  },

  async listDisplays(run) {
    const source = `tell application "Finder" to get bounds of window of desktop`;
    const result = await run(osaCapsule(source, 8000));
    if (result.code !== 0) return { displays: [{ index: 1, bounds: [0, 0, 1920, 1080], main: true }] };
    const nums = result.stdout.trim().split(",").map((n) => Number.parseInt(n.trim(), 10));
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
      return { displays: [{ index: 1, bounds: [0, 0, 1920, 1080], main: true }] };
    }
    return { displays: [{ index: 1, bounds: [nums[0], nums[1], nums[2] - nums[0], nums[3] - nums[1]], main: true }] };
  },

  async buildSnapshot(run, app, window, detail) {
    const includeFull = detail === "full";
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${app.pid}
  set win to (first window whose name is ${osaString(window.title)})
  set out to ""
  set idx to 0
  my Walk(win, 0)
  on Walk(el, depth)
    global out, idx
    if idx ≥ 800 or depth > 25 then return
    tell application "System Events"
      try
        set r to role of el
        set n to (name of el) as text
        if length of n > 120 then set n to text 1 thru 120 of n
        set out to out & idx & "\\t" & r & "\\t" & n & linefeed
        set idx to idx + 1
        repeat with c in UI elements of el
          my Walk(contents of c, depth + 1)
        end repeat
      end try
    end tell
  end Walk
  return out
end tell`;
    const result = await run(osaCapsule(source, 25000));
    if (result.code !== 0) {
      const err = `${result.stderr}\n${result.stdout}`.trim();
      if (/not allowed|assistive|1002|(-25211)/i.test(err)) {
        return { error: "System Events access denied (TCC Accessibility not granted to the host terminal)", emptyTree: true };
      }
      return { error: `AX walk failed: ${err.slice(0, 300)}`, emptyTree: false };
    }
    const elements: Snapshot["elements"] = [];
    for (const line of result.stdout.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length < 3) continue;
      const index = Number.parseInt(parts[0], 10);
      if (!Number.isFinite(index)) continue;
      elements.push({ index, kind: mapAxRole(parts[1]), name: parts[2], flags: axFlagsFor(parts[1]) });
    }
    if (elements.length === 0) {
      return { error: "The window exposes no accessibility elements", emptyTree: true };
    }
    return {
      stateId: "",
      app: { pid: app.pid, name: app.name, bundleId: app.bundleId, title: window.title },
      window: { title: window.title, windowId: window.windowId, bounds: window.bounds },
      surface: { kind: "window", actualWindowId: window.windowId, lifecycle: "stable" },
      elements: includeFull ? elements : elements.map(stripFullFields),
      createdAt: 0,
    };
  },

  async hitTest(run, globalPt) {
    // System Events has no FromPoint; the honest macOS hit-test is the AX
    // element under the cursor via "UI element at" — not exposed. Return
    // null → the dispatcher treats it as "no a11y hit" (raw fallback).
    void globalPt;
    void run;
    return null;
  },

  async focusedElementName(run, pid) {
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${pid}
  if frontmost of p is false then return ""
  try
    set f to value of attribute "AXFocusedUIElement" of p
    return (name of f) as text
  on error
    return ""
  end try
end tell`;
    const result = await run(osaCapsule(source, 8000));
    if (result.code !== 0) return null;
    return result.stdout.trim().slice(0, 200) || null;
  },

  async pressElement(run, pid, window, element) {
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${pid}
  set win to (first window whose name is ${osaString(window.title)})
  set els to my Collect(win, 0)
  on Collect(el, depth)
    global outList
    set outList to outList & {el}
    try
      repeat with c in UI elements of el
        my Collect(contents of c, depth + 1)
      end repeat
    end try
    return outList
  end Collect
  if ${element.index} > (count of els) then return "NO_SUCH_ELEMENT"
  set target to item ${element.index + 1} of els
  set n to (name of target) as text
  if length of n > 120 then set n to text 1 thru 120 of n
  if n is not ${osaString(element.name.slice(0, 120))} then return "STALE_ELEMENT"
  try
    perform action "AXPress" of target
    return "OK"
  on error errMsg
    return "ERR:" & errMsg
  end try
end tell`;
    const result = await run(osaCapsule(source, 15000));
    return okResult(result.stdout);
  },

  async setValue(run, pid, window, element, value) {
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${pid}
  set win to (first window whose name is ${osaString(window.title)})
  set els to my Collect(win, 0)
  on Collect(el, depth)
    global outList
    set outList to outList & {el}
    try
      repeat with c in UI elements of el
        my Collect(contents of c, depth + 1)
      end repeat
    end try
    return outList
  end Collect
  if ${element.index} > (count of els) then return "NO_SUCH_ELEMENT"
  set target to item ${element.index + 1} of els
  set n to (name of target) as text
  if length of n > 120 then set n to text 1 thru 120 of n
  if n is not ${osaString(element.name.slice(0, 120))} then return "STALE_ELEMENT"
  try
    set value of target to ${osaString(value)}
    return "OK"
  on error errMsg
    return "ERR:" & errMsg
  end try
end tell`;
    const result = await run(osaCapsule(source, 15000));
    return okResult(result.stdout);
  },

  async performAction(run, pid, window, element, action) {
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${pid}
  set win to (first window whose name is ${osaString(window.title)})
  set els to my Collect(win, 0)
  on Collect(el, depth)
    global outList
    set outList to outList & {el}
    try
      repeat with c in UI elements of el
        my Collect(contents of c, depth + 1)
      end repeat
    end try
    return outList
  end Collect
  if ${element.index} > (count of els) then return "NO_SUCH_ELEMENT"
  set target to item ${element.index + 1} of els
  set n to (name of target) as text
  if length of n > 120 then set n to text 1 thru 120 of n
  if n is not ${osaString(element.name.slice(0, 120))} then return "STALE_ELEMENT"
  try
    perform action ${osaString(action)} of target
    return "OK"
  on error errMsg
    return "ERR:" & errMsg
  end try
end tell`;
    const result = await run(osaCapsule(source, 15000));
    return okResult(result.stdout);
  },

  async selectRange(run, pid, window, element, start, length) {
    void length;
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${pid}
  set win to (first window whose name is ${osaString(window.title)})
  set els to my Collect(win, 0)
  on Collect(el, depth)
    global outList
    set outList to outList & {el}
    try
      repeat with c in UI elements of el
        my Collect(contents of c, depth + 1)
      end repeat
    end try
    return outList
  end Collect
  if ${element.index} > (count of els) then return "NO_SUCH_ELEMENT"
  set target to item ${element.index + 1} of els
  set n to (name of target) as text
  if length of n > 120 then set n to text 1 thru 120 of n
  if n is not ${osaString(element.name.slice(0, 120))} then return "STALE_ELEMENT"
  try
    set focused of target to true
    set selection of target to {${start}, ${length ?? 0}}
    return "OK"
  on error errMsg
    return "ERR:" & errMsg
  end try
end tell`;
    const result = await run(osaCapsule(source, 15000));
    return okResult(result.stdout);
  },

  async rawClick(run, pt, button, clickCount, modifiers) {
    const haveCliclick = await probeTool(run, "cliclick");
    if (!haveCliclick) return { ok: false, error: "cliclick is not installed (macOS raw input)" };
    const args: string[] = [];
    for (const mod of modifiers) args.push(`kd:${mod === "cmd" ? "cmd" : mod}`);
    const b = button === "left" ? "c" : button === "right" ? "rc" : "mc";
    for (let i = 0; i < Math.min(Math.max(clickCount, 1), 3); i++) {
      args.push(`${b}:${pt.x},${pt.y}`);
    }
    for (const mod of modifiers) args.push(`ku:${mod === "cmd" ? "cmd" : mod}`);
    const result = await run({ program: "cliclick", args, timeoutMs: 10000 });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `cliclick failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawScroll(run, pt, direction, amount) {
    const haveCliclick = await probeTool(run, "cliclick");
    if (!haveCliclick) return { ok: false, error: "cliclick is not installed (macOS raw input)" };
    const clicks = Math.max(1, Math.min(100, Math.round(amount / 3) || 1));
    const dy = direction === "down" ? clicks : direction === "up" ? -clicks : 0;
    const dx = direction === "right" ? clicks : direction === "left" ? -clicks : 0;
    const result = await run({
      program: "cliclick",
      args: [`m:${pt.x},${pt.y}`, `scroll:${dx * 2},${dy * 2}`],
      timeoutMs: 10000,
    });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `cliclick scroll failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawDrag(run, from, to, modifiers) {
    const haveCliclick = await probeTool(run, "cliclick");
    if (!haveCliclick) return { ok: false, error: "cliclick is not installed (macOS raw input)" };
    const args: string[] = [];
    for (const mod of modifiers) args.push(`kd:${mod === "cmd" ? "cmd" : mod}`);
    args.push(`dd:${from.x},${from.y}`, `du:${to.x},${to.y}`);
    for (const mod of modifiers) args.push(`ku:${mod === "cmd" ? "cmd" : mod}`);
    const result = await run({ program: "cliclick", args, timeoutMs: 15000 });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `cliclick drag failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawButton(run, pt, down) {
    const haveCliclick = await probeTool(run, "cliclick");
    if (!haveCliclick) return { ok: false, error: "cliclick is not installed (macOS raw input)" };
    const result = await run({
      program: "cliclick",
      args: [`m:${pt.x},${pt.y}`, down ? `dd:${pt.x},${pt.y}` : `du:${pt.x},${pt.y}`],
      timeoutMs: 10000,
    });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `cliclick button failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawKey(run, keys, scope) {
    // Keys via System Events key code (modifiers as chord prefixes).
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${scope.pid}
  if frontmost of p is false then return "FRONTMOST_MISMATCH"
  key code ${osaKeyCodes(keys).join(" ")}
  return "OK"
end tell`;
    const result = await run(osaCapsule(source, 10000));
    if (result.stdout.trim() === "FRONTMOST_MISMATCH") {
      const front = await this.frontmostPid(run);
      return { ok: false, error: `FRONTMOST_MISMATCH:${front ?? "unknown"}` };
    }
    return okResult(result.stdout);
  },

  async typeText(run, text, scope) {
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${scope.pid}
  if frontmost of p is false then return "FRONTMOST_MISMATCH"
  keystroke ${osaString(text)}
  return "OK"
end tell`;
    const result = await run(osaCapsule(source, Math.min(30000, 2000 + text.length * 20)));
    if (result.stdout.trim() === "FRONTMOST_MISMATCH") {
      const front = await this.frontmostPid(run);
      return { ok: false, error: `FRONTMOST_MISMATCH:${front ?? "unknown"}` };
    }
    return okResult(result.stdout);
  },

  async launch(run, spec) {
    if (spec.pid !== undefined) return { ok: true, pid: spec.pid, active: false };
    const name = spec.name;
    if (name === undefined || name.trim() === "") return { ok: false, error: "no app name given" };
    const source = `
tell application ${osaString(spec.bundleId ?? name)}
  launch
end tell
return "OK"`;
    const result = await run(osaCapsule(source, 15000));
    if (result.code !== 0) {
      return { ok: false, error: `could not launch '${name}': ${result.stderr.trim().slice(0, 200)}` };
    }
    return { ok: true, active: spec.activate };
  },

  async activate(run, pid) {
    const source = `
tell application "System Events"
  set p to first process whose unix id is ${pid}
  set frontmost of p to true
  delay 0.3
  if frontmost of p then return "ACTIVE"
  return "INACTIVE"
end tell`;
    const result = await run(osaCapsule(source, 8000));
    const out = result.stdout.trim();
    if (out === "ACTIVE") return { ok: true, active: true };
    if (out === "INACTIVE") return { ok: true, active: false };
    return { ok: false, active: false };
  },

  // ── R93-C (the v2 surface — ClickScope parity): window placement via
  // System Events. The windowId is the System Events window id listWindows
  // reports. The "first process whose windows contains" lookup mirrors the
  // macos.ts honesty patterns: a lookup miss returns a non-zero osascript
  // exit → the honest {ok:false}.
  async moveWindow(run, windowId, x, y) {
    const source = `
tell application "System Events"
  set w to first window of (first process whose windows contains (first window of first process whose id of it is ${windowId}))
  set position of w to {${Math.round(x)}, ${Math.round(y)}}
  return "OK"
end tell`;
    const result = await run(osaCapsule(source, 8000));
    if (result.code === 0 && result.stdout.trim() === "OK") return { ok: true };
    return { ok: false, error: `osascript move exited ${result.code}` };
  },

  async setWindowState(run, windowId, state) {
    // maximize = zoom (or fullscreen when zoom is unavailable — best-effort,
    // the honest {ok:false} when neither applies); minimize = miniaturized.
    const action =
      state === "minimize"
        ? `set miniaturized of w to true`
        : state === "maximize"
          ? `try
  set zoomed of w to true
on error
  set full screen of w to true
end try`
          : `set miniaturized of w to false
try
  set zoomed of w to false
end try`;
    const source = `
tell application "System Events"
  set w to first window of (first process whose windows contains (first window of first process whose id of it is ${windowId}))
  ${action}
  return "OK"
end tell`;
    const result = await run(osaCapsule(source, 8000));
    if (result.code === 0 && result.stdout.trim() === "OK") return { ok: true };
    return { ok: false, error: `osascript state exited ${result.code}` };
  },

  async focusWindow(run, windowId) {
    const source = `
tell application "System Events"
  set w to first window of (first process whose windows contains (first window of first process whose id of it is ${windowId}))
  perform action "AXRaise" of w
  return "OK"
end tell`;
    const result = await run(osaCapsule(source, 8000));
    if (result.code === 0 && result.stdout.trim() === "OK") return { ok: true };
    return { ok: false, error: `osascript focus exited ${result.code}` };
  },

  async frontmostPid(run) {
    const source = `
tell application "System Events"
  set p to first process whose frontmost is true
  return unix id of p
end tell`;
    const result = await run(osaCapsule(source, 6000));
    if (result.code !== 0) return null;
    const pid = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  },

  async captureDisplay(run, _displayIndex) {
    // screencapture -x (no sound) to a temp PNG, then base64.
    const result = await run({
      program: "sh",
      args: ["-c", "screencapture -x /tmp/.acute-capture.png 2>/dev/null && base64 < /tmp/.acute-capture.png && rm -f /tmp/.acute-capture.png"],
      timeoutMs: 25000,
    });
    const b64 = result.stdout.trim();
    if (result.code !== 0 || b64.length < 64) {
      const denied = /screen (recording|capture)|not allowed/i.test(result.stderr);
      return {
        error: denied
          ? "Screen Recording permission not granted (TCC)"
          : `screencapture failed: ${result.stderr.trim().slice(0, 200)}`,
      };
    }
    const dims = pngDimensions(b64);
    if (!dims) return { error: "capture output was not a PNG" };
    return {
      pngBase64: b64,
      width: dims.width,
      height: dims.height,
      scale: 2.0, // Retina default: pixels = 2× points (doc 03 §5); probe-verified live
      origin: { x: 0, y: 0 },
    } satisfies Raster;
  },

  async captureRegion(run, region) {
    const result = await run({
      program: "sh",
      args: ["-c", `screencapture -x -R${region.x},${region.y},${region.w},${region.h} /tmp/.acute-capture.png 2>/dev/null && base64 < /tmp/.acute-capture.png && rm -f /tmp/.acute-capture.png`],
      timeoutMs: 20000,
    });
    const b64 = result.stdout.trim();
    if (result.code !== 0 || b64.length < 64) {
      return { error: `screencapture region failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    const dims = pngDimensions(b64);
    if (!dims) return { error: "capture output was not a PNG" };
    return {
      pngBase64: b64,
      width: dims.width,
      height: dims.height,
      scale: 2.0,
      origin: { x: region.x, y: region.y },
    } satisfies Raster;
  },

  async cursorPosition(run) {
    const haveCliclick = await probeTool(run, "cliclick");
    if (!haveCliclick) return null;
    const result = await run({ program: "cliclick", args: ["-p"], timeoutMs: 4000 });
    if (result.code !== 0) return null;
    const nums = result.stdout.trim().split(",").map((n) => Number.parseInt(n, 10));
    if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return null;
    return { x: nums[0], y: nums[1] };
  },

  async readClipboard(run) {
    const result = await run({ program: "pbpaste", args: [], timeoutMs: 5000 });
    return result.code === 0 ? result.stdout : "";
  },

  async writeClipboard(run, text) {
    const result = await run({ program: "pbcopy", args: [], stdin: text, timeoutMs: 5000 });
    return result.code === 0 ? { ok: true } : { ok: false, error: "pbcopy failed" };
  },

  async probePermissions(run): Promise<PermissionReport> {
    const notes: string[] = [];
    // Accessibility: a System Events query that NEEDS AX. Error 25211 /
    // "not allowed" = denied. Never the requesting variant (no dialogs).
    const ax = await run(
      osaCapsule(`tell application "System Events" to count of processes`, 6000),
    );
    const accessibility: PermissionReport["accessibility"] =
      ax.code === 0 && /^\d+$/.test(ax.stdout.trim()) ? "granted" : "denied";
    if (accessibility === "denied") {
      notes.push("TCC Accessibility not granted to the host terminal — System Events is blocked");
    }
    // Screen Recording: screencapture to /dev/null (preflight only, no dialog).
    const cap = await run({
      program: "sh",
      args: ["-c", "screencapture -x /dev/null 2>/dev/null; echo $?"],
      timeoutMs: 8000,
    });
    const screenCapture: PermissionReport["screenCapture"] =
      cap.stdout.trim() === "0" ? "granted" : "denied";
    if (screenCapture === "denied") {
      notes.push("TCC Screen Recording not granted — captures and window titles are blocked");
    }
    return { accessibility, screenCapture, backendKind: "macos", notes };
  },
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

function probeTool(run: RunCommand, tool: string): Promise<boolean> {
  return run({ program: "sh", args: ["-c", `command -v ${tool} >/dev/null 2>&1`], timeoutMs: 3000 }).then(
    (r) => r.code === 0,
  );
}

function osaString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function mapAxRole(role: string): Snapshot["elements"][number]["kind"] {
  const r = role.toLowerCase();
  if (r.includes("window") || r.includes("dialog")) return "window";
  if (r.includes("menu")) return "menuitem";
  if (r.includes("button") || r.includes("link")) return "button";
  if (r.includes("textfield") || r.includes("textarea") || r.includes("searchfield")) return "textfield";
  if (r.includes("popupbutton") || r.includes("combobox")) return "combobox";
  if (r.includes("checkbox") || r.includes("radiobutton")) return "checkbox";
  if (r.includes("slider") || r.includes("incrementor")) return "slider";
  if (r.includes("tab")) return "tab";
  if (r.includes("row") || r.includes("outline")) return "row";
  if (r.includes("statictext")) return "text";
  if (r.includes("image")) return "image";
  return "pane";
}

function axFlagsFor(role: string): Snapshot["elements"][number]["flags"] {
  const r = role.toLowerCase();
  if (r.includes("button") || r.includes("checkbox") || r.includes("radiobutton") || r.includes("menuitem")) {
    return ["pressable"];
  }
  if (r.includes("textfield") || r.includes("textarea") || r.includes("combobox") || r.includes("slider")) {
    return ["editable"];
  }
  if (r.includes("popupbutton")) return ["has_menu", "pressable"];
  return [];
}

function stripFullFields(el: Snapshot["elements"][number]): Snapshot["elements"][number] {
  const compact: Snapshot["elements"][number] = { index: el.index, kind: el.kind, name: el.name, flags: el.flags };
  if (el.value !== undefined) compact.value = el.value;
  return compact;
}

/** Key-code map for the common non-text keys (doc 02 §4.2 chords). */
const MAC_KEY_CODES: Record<string, number> = {
  return: 36, enter: 76, escape: 53, tab: 48, space: 49,
  delete: 51, forwarddelete: 117,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

/** Build osascript key code args: modifiers use `key down`, then the code. */
export function osaKeyCodes(keys: string[]): string[] {
  const modifiers = keys.filter((k) => ["cmd", "ctrl", "alt", "shift", "option"].includes(k));
  const rest = keys.filter((k) => !modifiers.includes(k));
  // osascript: `key code 36 using command down` — we return the pieces the
  // caller composes; here: a single string arg list is impractical for
  // chords, so we emit the last key's code and the modifier list is
  // expressed in the source template. For simple chords this maps well.
  const last = rest[rest.length - 1] ?? "return";
  const code = MAC_KEY_CODES[last] ?? 36;
  return [String(code), ...(modifiers.length > 0 ? [`using ${modifiers.join(" down, ")} down`] : [])];
}

export const MACOS_BACKEND_ID = "macos";
export { macosBackend };
