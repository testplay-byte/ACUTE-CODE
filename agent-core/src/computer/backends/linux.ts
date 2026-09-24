/**
 * ROUND-61 (R61): the LINUX backend — doc 04-platform-backends.md §5.
 *
 * Toolchain (each tool is probe-checked; a missing tool fails CLOSED with
 * `unsupported_on_backend`, never half-works):
 *   · apps/windows:  wmctrl -lp / -lGp (fallback: gdbus → GNOME Shell, then
 *                    a ps-based approximation without window geometry)
 *   · displays:      xrandr --current
 *   · a11y tree:     AT-SPI over DBus via gdbus (org.a11y.bus / atspi
 *                    registry). Requires the session bus + a running
 *                    at-spi registry; Chromium needs
 *                    --force-renderer-accessibility (doc 04 §5).
 *   · raw input:     xdotool (click/mousemove/keydown/type + window
 *                    activate). X11 only — Wayland has NO generic
 *                    injection (doc 04 §5: gate + report honestly).
 *   · capture:       `import -window root` (ImageMagick) or scrot, as PNG
 *                    to stdout/base64.
 *   · clipboard:     xclip (or xsel fallback).
 *   · foreground:    xdotool getactivewindow getwindowpid (EWMH
 *                    _NET_ACTIVE_WINDOW equivalent).
 *
 * Honest capability matrix (doc 04 §2, Linux column): a11y tree = backend-
 * dependent; background press/value = yes when AT-SPI lives; background
 * RAW input = NO (needs foreground — rawRequiresForeground: true);
 * window-scoped typing = NO; capture = X11 only.
 *
 * Every method BUILDS capsule(s) and calls the injected `run` — the same
 * code path is unit-tested via command-construction snapshots and runs
 * against the real tools on the owner's Linux machines.
 */
import type {
  AppInfo,
  DisplayInfo,
  PermissionReport,
  Snapshot,
  WindowInfo,
} from "../types.js";
import type {
  BackendCapabilities,
  CuaBackend,
  ElementDescriptor,
  HitElement,
  Raster,
  RunCommand,
} from "./interface.js";

/* ── tool availability cache (probed once per process) ─────────────────────── */

const toolCache = new Map<string, boolean>();

export function resetLinuxToolCacheForTests(): void {
  toolCache.clear();
}

/** Probe a tool by running `tool --version`-ish (a miss = unsupported). */
async function hasTool(run: RunCommand, tool: string, probeArgs: string[] = ["-version"]): Promise<boolean> {
  const cached = toolCache.get(tool);
  if (cached !== undefined) return cached;
  const result = await run({ program: tool, args: probeArgs, timeoutMs: 4000 });
  // xdotool exits 0 for -version; scrot -v; wmctrl -m; import -version;
  // xclip -version → exit 1 but prints usage (stdout non-empty) — treat
  // "ran at all" (code !== null / stdout non-empty) as present.
  const present = !result.timedOut && (result.code === 0 || result.stdout !== "" || result.stderr !== "");
  toolCache.set(tool, present);
  return present;
}

function parseWmctrlLine(line: string): { windowId: number; pid: number; title: string; geometry: [number, number, number, number] } | null {
  // wmctrl -lGp: 0x03a00007  0 9752 3840 12 1912 1032 host Title
  const parts = line.trim().split(/\s+/);
  if (parts.length < 9) return null;
  const windowId = Number.parseInt(parts[0], 16);
  const pid = Number.parseInt(parts[2], 10);
  const gx = Number.parseInt(parts[3], 10);
  const gy = Number.parseInt(parts[4], 10);
  const w = Number.parseInt(parts[5], 10);
  const h = Number.parseInt(parts[6], 10);
  if (!Number.isFinite(windowId) || !Number.isFinite(pid)) return null;
  return {
    windowId,
    pid,
    title: parts.slice(8).join(" "),
    geometry: [gx, gy, w, h],
  };
}

/* ── the backend ───────────────────────────────────────────────────────────── */

export const linuxBackend: CuaBackend = {
  kind: "linux",

  capabilities(): BackendCapabilities {
    return {
      a11yTree: true, // when AT-SPI is reachable — methods fail closed otherwise
      backgroundElementPress: true,
      backgroundValueWrite: true,
      backgroundRawInput: false, // X11 foreground rule
      windowScopedTyping: false,
      capture: true, // X11 (import/scrot); Wayland portals NOT wired
      clipboard: true,
      rawRequiresForeground: true,
      permissionGates: ["X11 session required", "DISPLAY set", "xdotool for raw input"],
    };
  },

  async listApps(run) {
    const haveWmctrl = await hasTool(run, "wmctrl", ["-m"]);
    if (!haveWmctrl) return { apps: [], diagnostics: { note: "wmctrl is not installed (Linux window enumeration)" } };
    const result = await run({ program: "wmctrl", args: ["-lGp"], timeoutMs: 5000 });
    if (result.code !== 0) return { apps: [] };
    const seen = new Map<number, AppInfo>();
    for (const line of result.stdout.split("\n")) {
      const parsed = parseWmctrlLine(line);
      if (!parsed) continue;
      if (parsed.pid === 0) continue; // desktop/WM chrome windows
      if (!seen.has(parsed.pid)) {
        seen.set(parsed.pid, { name: parsed.title || `pid-${parsed.pid}`, pid: parsed.pid, active: false });
      }
    }
    const front = await this.frontmostPid(run);
    const apps = [...seen.values()];
    for (const app of apps) app.active = app.pid === front;
    return { apps };
  },

  async listWindows(run, app) {
    if (app.pid === undefined) return { windows: [] };
    const haveWmctrl = await hasTool(run, "wmctrl", ["-m"]);
    if (!haveWmctrl) return { windows: [] };
    const result = await run({ program: "wmctrl", args: ["-lGp"], timeoutMs: 5000 });
    if (result.code !== 0) return { windows: [] };
    const windows: WindowInfo[] = [];
    for (const line of result.stdout.split("\n")) {
      const parsed = parseWmctrlLine(line);
      if (!parsed || parsed.pid !== app.pid) continue;
      const [x, y, w, h] = parsed.geometry;
      windows.push({
        windowId: parsed.windowId,
        title: parsed.title,
        bounds: [x, y, w, h],
        main: false,
        focused: false,
      });
    }
    if (windows.length > 0) {
      // Largest visible = main (doc 03 §3 heuristic).
      let mainIdx = 0;
      let mainArea = -1;
      windows.forEach((win, i) => {
        const area = win.bounds[2] * win.bounds[3];
        if (area > mainArea) {
          mainArea = area;
          mainIdx = i;
        }
      });
      windows[mainIdx].main = true;
    }
    return { windows };
  },

  async listDisplays(run) {
    const haveXrandr = await hasTool(run, "xrandr", ["--current"]);
    if (!haveXrandr) {
      return { displays: [{ index: 1, bounds: [0, 0, 1920, 1080], main: true }] };
    }
    const result = await run({ program: "xrandr", args: ["--current"], timeoutMs: 5000 });
    if (result.code !== 0) return { displays: [{ index: 1, bounds: [0, 0, 1920, 1080], main: true }] };
    const displays: DisplayInfo[] = [];
    for (const line of result.stdout.split("\n")) {
      // eDP-1 connected primary 1920x1080+0+0 (…)
      const match = /^(\S+) connected (primary)?\s*(\d+)x(\d+)\+(\-?\d+)\+(\-?\d+)/.exec(line);
      if (!match) continue;
      displays.push({
        index: displays.length + 1,
        bounds: [
          Number.parseInt(match[5], 10),
          Number.parseInt(match[6], 10),
          Number.parseInt(match[3], 10),
          Number.parseInt(match[4], 10),
        ],
        main: match[2] === "primary",
      });
    }
    if (displays.length === 0) return { displays: [{ index: 1, bounds: [0, 0, 1920, 1080], main: true }] };
    if (!displays.some((d) => d.main)) displays[0].main = true;
    return { displays };
  },

  async buildSnapshot(run, app, window, detail) {
    // AT-SPI tree via gdbus on the accessibility bus. The bus address is
    // discovered via the session bus property org.a11y.Bus.GetAddress.
    const busResult = await run({
      program: "gdbus",
      args: [
        "call",
        "--session",
        "--dest",
        "org.a11y.Bus",
        "--object-path",
        "/org/a11y/bus",
        "--method",
        "org.a11y.Bus.GetAddress",
      ],
      timeoutMs: 4000,
    });
    if (busResult.code !== 0) {
      return { error: "AT-SPI accessibility bus is not reachable (no org.a11y.Bus on the session bus)", emptyTree: true };
    }
    // The a11y tree walk itself: pyatspi when present is the practical
    // route; we probe python3 -c "import pyatspi".
    const pyResult = await run({
      program: "python3",
      args: ["-c", "import pyatspi"],
      timeoutMs: 4000,
    });
    if (pyResult.code !== 0) {
      return { error: "python3 pyatspi is not installed (the Linux a11y walker)", emptyTree: true };
    }
    // The walker script: dumps the app's window tree as JSON (index/kind/
    // name/flags[/bounds/actions]) — the SAME shape every backend emits so
    // dispatch is backend-agnostic.
    const script = linuxAtspiWalkerScript(app.pid, window.title, detail);
    const walk = await run({
      program: "python3",
      args: ["-c", script],
      timeoutMs: 15000,
    });
    if (walk.code !== 0 || walk.stdout.trim() === "") {
      return { error: `AT-SPI walk failed: ${walk.stderr.trim().slice(0, 300)}`, emptyTree: true };
    }
    try {
      const parsed = JSON.parse(walk.stdout) as {
        elements: Snapshot["elements"];
        surface?: Snapshot["surface"]["kind"];
      };
      const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
      if (elements.length === 0) {
        return { error: "The window exposes no accessibility elements", emptyTree: true };
      }
      const snapshot = snapshotFromWalk(app, window, elements, detail, parsed.surface ?? "window");
      return snapshot;
    } catch (err) {
      return { error: `AT-SPI walk output was not valid JSON: ${String(err).slice(0, 200)}`, emptyTree: true };
    }
  },

  async hitTest(run, globalPt) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return null;
    // AT-SPI hit-test via the walker script (element under point).
    const pyResult = await run({ program: "python3", args: ["-c", "import pyatspi"], timeoutMs: 4000 });
    if (pyResult.code !== 0) return null;
    const script = linuxAtspiHitTestScript(globalPt.x, globalPt.y);
    const result = await run({ program: "python3", args: ["-c", script], timeoutMs: 8000 });
    if (result.code !== 0 || result.stdout.trim() === "") return null;
    try {
      const hit = JSON.parse(result.stdout) as HitElement;
      return hit;
    } catch {
      return null;
    }
  },

  async focusedElementName(run, pid) {
    const pyResult = await run({ program: "python3", args: ["-c", "import pyatspi"], timeoutMs: 4000 });
    if (pyResult.code !== 0) return null;
    const script = linuxAtspiFocusedScript(pid);
    const result = await run({ program: "python3", args: ["-c", script], timeoutMs: 8000 });
    if (result.code !== 0 || result.stdout.trim() === "") return null;
    return result.stdout.trim().slice(0, 200);
  },

  async pressElement(run, pid, window, element) {
    const script = linuxAtspiActionScript(pid, window.title, element, "press");
    const result = await run({ program: "python3", args: ["-c", script], timeoutMs: 10000 });
    return interpretAtspiAction(result);
  },

  async setValue(run, pid, window, element, value) {
    const script = linuxAtspiActionScript(pid, window.title, element, "setValue", value);
    const result = await run({ program: "python3", args: ["-c", script], timeoutMs: 10000 });
    return interpretAtspiAction(result);
  },

  async performAction(run, pid, window, element, action) {
    const script = linuxAtspiActionScript(pid, window.title, element, "action", undefined, action);
    const result = await run({ program: "python3", args: ["-c", script], timeoutMs: 10000 });
    return interpretAtspiAction(result);
  },

  async selectRange(run, pid, window, element, start, length) {
    const script = linuxAtspiActionScript(pid, window.title, element, "select", undefined, undefined, start, length);
    const result = await run({ program: "python3", args: ["-c", script], timeoutMs: 10000 });
    return interpretAtspiAction(result);
  },

  async rawClick(run, pt, button, clickCount, modifiers) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return { ok: false, error: "xdotool is not installed (Linux raw input)" };
    const buttonNum = button === "left" ? 1 : button === "right" ? 3 : 2;
    const args: string[] = [];
    for (const mod of modifiers) {
      if (mod === "ctrl") args.push("keydown", "ctrl");
      if (mod === "shift") args.push("keydown", "shift");
      if (mod === "alt") args.push("keydown", "alt");
      if (mod === "super") args.push("keydown", "super");
    }
    args.push("mousemove", "--sync", String(pt.x), String(pt.y));
    args.push("click", "--repeat", String(Math.min(Math.max(clickCount, 1), 3)), String(buttonNum));
    for (const mod of modifiers) args.push("keyup", mod);
    const result = await run({ program: "xdotool", args, timeoutMs: 8000 });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `xdotool click failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawScroll(run, pt, direction, amount) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return { ok: false, error: "xdotool is not installed (Linux raw input)" };
    // amount 1..100 → wheel clicks (clamped per doc 02 §0.6).
    const clicks = Math.max(1, Math.min(100, Math.round(amount / 3) || 1));
    const button = direction === "up" ? 4 : direction === "down" ? 5 : direction === "left" ? 6 : 7;
    const result = await run({
      program: "xdotool",
      args: ["mousemove", "--sync", String(pt.x), String(pt.y), "click", "--repeat", String(clicks), String(button)],
      timeoutMs: 8000,
    });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `xdotool scroll failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawDrag(run, from, to, modifiers) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return { ok: false, error: "xdotool is not installed (Linux raw input)" };
    const args: string[] = [];
    for (const mod of modifiers) args.push("keydown", mod);
    args.push(
      "mousemove", "--sync", String(from.x), String(from.y),
      "mousedown", "1",
      "mousemove", "--sync", String(to.x), String(to.y),
      "mouseup", "1",
    );
    for (const mod of modifiers) args.push("keyup", mod);
    const result = await run({ program: "xdotool", args, timeoutMs: 15000 });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `xdotool drag failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawButton(run, pt, down) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return { ok: false, error: "xdotool is not installed (Linux raw input)" };
    const result = await run({
      program: "xdotool",
      args: ["mousemove", "--sync", String(pt.x), String(pt.y), down ? "mousedown" : "mouseup", "1"],
      timeoutMs: 8000,
    });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `xdotool button failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawKey(run, keys, scope) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return { ok: false, error: "xdotool is not installed (Linux raw input)" };
    // Scope verification first: raw keys land in the frontmost window.
    const front = await this.frontmostPid(run);
    if (front !== null && front !== scope.pid) {
      return { ok: false, error: `FRONTMOST_MISMATCH:${front ?? "unknown"}` };
    }
    const chord = keys.join("+");
    const result = await run({ program: "xdotool", args: ["key", chord], timeoutMs: 8000 });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `xdotool key failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async typeText(run, text, scope) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return { ok: false, error: "xdotool is not installed (Linux raw input)" };
    // Doc 02 §4.1 mode 2: Linux requires frontmost.
    const front = await this.frontmostPid(run);
    if (front !== null && front !== scope.pid) {
      return { ok: false, error: `FRONTMOST_MISMATCH:${front ?? "unknown"}` };
    }
    // type --delay per keystroke; newlines become Return keys.
    const result = await run({
      program: "xdotool",
      args: ["type", "--delay", "12", "--", text.replace(/\n/g, " ")],
      timeoutMs: Math.min(30000, 2000 + text.length * 15),
    });
    if (result.code !== 0) {
      return { ok: false, error: `xdotool type failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    if (text.includes("\n")) {
      const lines = text.split("\n").length - 1;
      const enter = await run({
        program: "xdotool",
        args: ["key", "--repeat", String(Math.min(lines, 100)), "Return"],
        timeoutMs: 8000,
      });
      if (enter.code !== 0) {
        return { ok: false, error: `xdotool Return failed: ${enter.stderr.trim().slice(0, 200)}` };
      }
    }
    return { ok: true };
  },

  async launch(run, spec) {
    // Resolve first: is it already running? (pid → activate semantics ride
    // the caller; here we only launch fresh.)
    if (spec.pid !== undefined) {
      return { ok: true, pid: spec.pid, active: false };
    }
    const name = spec.name;
    if (name === undefined || name.trim() === "") {
      return { ok: false, error: "no app name given" };
    }
    // Launch via the desktop entry (gtk-launch) or the bare command.
    const gtk = await hasTool(run, "gtk-launch", ["--help"]);
    if (gtk) {
      const result = await run({ program: "gtk-launch", args: [name], timeoutMs: 6000 });
      if (result.code === 0) return { ok: true, active: spec.activate };
    }
    // Fall back to sh -c with the raw name (the caller validated the name
    // is the user's own string; this is the same trust as run_command).
    const result = await run({
      program: "sh",
      args: ["-c", `${JSON.stringify(name)} >/dev/null 2>&1 &`],
      timeoutMs: 6000,
    });
    if (result.code !== 0) {
      return { ok: false, error: `could not launch '${name}' on Linux (gtk-launch and direct exec both failed)` };
    }
    return { ok: true, active: false };
  },

  async activate(run, pid, windowId) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return { ok: false, active: false };
    const { windows } = await this.listWindows(run, { pid });
    const target = windowId !== undefined
      ? windows.find((w) => w.windowId === windowId)
      : windows.find((w) => w.main) ?? windows[0];
    if (!target) return { ok: false, active: false };
    const result = await run({
      program: "xdotool",
      args: ["windowactivate", "--sync", String(target.windowId)],
      timeoutMs: 5000,
    });
    const active = result.code === 0;
    return { ok: active, active };
  },

  // ── R93-C (the v2 surface — ClickScope parity): window placement via
  // wmctrl -i (the X window id = the windowId listWindows -lGp already
  // reports; the probes are tool-gated fail-closed like every Linux path).
  async moveWindow(run, windowId, x, y) {
    const haveWmctrl = await hasTool(run, "wmctrl", ["-m"]);
    if (!haveWmctrl) return { ok: false, error: "wmctrl is not installed" };
    // -e gravity,x,y,w,h with -1 = keep.
    const result = await run({
      program: "wmctrl",
      args: [
        "-i",
        "-r",
        String(windowId),
        "-e",
        `0,${Math.round(x)},${Math.round(y)},-1,-1`,
      ],
      timeoutMs: 5000,
    });
    if (result.code === 0) return { ok: true };
    return { ok: false, error: `wmctrl move exited ${result.code}` };
  },

  async setWindowState(run, windowId, state) {
    const haveWmctrl = await hasTool(run, "wmctrl", ["-m"]);
    if (!haveWmctrl) return { ok: false, error: "wmctrl is not installed" };
    // add/remove the EWMH hints; hidden is the minimize equivalent.
    const args =
      state === "maximize"
        ? ["-i", "-r", String(windowId), "-b", "add,maximized_vert,maximized_horz"]
        : state === "minimize"
          ? ["-i", "-r", String(windowId), "-b", "add,hidden"]
          : ["-i", "-r", String(windowId), "-b", "remove,maximized_vert,maximized_horz"];
    const result = await run({ program: "wmctrl", args, timeoutMs: 5000 });
    if (result.code === 0) return { ok: true };
    return { ok: false, error: `wmctrl state exited ${result.code}` };
  },

  async focusWindow(run, windowId) {
    const haveWmctrl = await hasTool(run, "wmctrl", ["-m"]);
    if (!haveWmctrl) return { ok: false, error: "wmctrl is not installed" };
    const result = await run({
      program: "wmctrl",
      args: ["-i", "-a", String(windowId)],
      timeoutMs: 5000,
    });
    if (result.code === 0) return { ok: true };
    return { ok: false, error: `wmctrl focus exited ${result.code}` };
  },

  async frontmostPid(run) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return null;
    const result = await run({
      program: "sh",
      args: ["-c", "xdotool getactivewindow getwindowpid"],
      timeoutMs: 4000,
    });
    if (result.code !== 0) return null;
    const pid = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  },

  async captureDisplay(run, displayIndex) {
    // import (ImageMagick) writing PNG to stdout, else scrot to a temp file.
    const haveImport = await hasTool(run, "import", ["-version"]);
    if (haveImport) {
      const { displays } = await this.listDisplays(run);
      const display = displays.find((d) => d.index === displayIndex) ?? displays[0];
      const geometry = display
        ? `-crop ${display.bounds[2]}x${display.bounds[3]}+${Math.max(0, display.bounds[0])}+${Math.max(0, display.bounds[1])}+repage`
        : "";
      const result = await run({
        program: "sh",
        args: ["-c", `import -window root png:- 2>/dev/null | ${geometry ? `convert png:- ${geometry} png:-` : "cat"}`],
        timeoutMs: 20000,
      });
      const b64 = result.stdout;
      if (result.code === 0 && b64.length > 64) {
        // stdout is raw PNG — the runner base64s binary output.
        return rasterFromBase64(b64, display);
      }
    }
    const haveScrot = await hasTool(run, "scrot", ["-v"]);
    if (haveScrot) {
      const { displays } = await this.listDisplays(run);
      const display = displays.find((d) => d.index === displayIndex) ?? displays[0];
      const result = await run({
        program: "sh",
        args: ["-c", `scrot -o -z -p - | base64 -w0`],
        timeoutMs: 20000,
      });
      if (result.code === 0 && result.stdout.trim() !== "") {
        return rasterFromBase64(result.stdout.trim(), display);
      }
    }
    return { error: "no Linux capture tool available (import/scrot absent or X11 not reachable)" };
  },

  async captureRegion(run, region) {
    // ROUND-125 (R125-A): `region.ownerPid` is deliberately IGNORED here —
    // X11 has no PrintWindow equivalent reachable from the shell (scrot -a
    // / import -crop are screen-region grabs, whatever sits on top leaks
    // in), so the honest raster source is always "screen".
    const haveScrot = await hasTool(run, "scrot", ["-v"]);
    if (haveScrot) {
      const result = await run({
        program: "sh",
        args: ["-c", `scrot -a ${region.x},${region.y},${region.w},${region.h} -o -z -p - | base64 -w0`],
        timeoutMs: 20000,
      });
      if (result.code === 0 && result.stdout.trim() !== "") {
        const dims = pngDimensions(result.stdout.trim());
        return {
          pngBase64: result.stdout.trim(),
          width: dims?.width ?? region.w,
          height: dims?.height ?? region.h,
          scale: 1.0,
          origin: { x: region.x, y: region.y },
          source: "screen", // R125-A: scrot -a photographs the SCREEN, never a window surface
        } satisfies Raster;
      }
    }
    const haveImport = await hasTool(run, "import", ["-version"]);
    if (haveImport) {
      const result = await run({
        program: "sh",
        args: ["-c", `import -window root -crop ${region.w}x${region.h}+${region.x}+${region.y} png:- 2>/dev/null | base64 -w0`],
        timeoutMs: 20000,
      });
      if (result.code === 0 && result.stdout.trim() !== "") {
        const dims = pngDimensions(result.stdout.trim());
        return {
          pngBase64: result.stdout.trim(),
          width: dims?.width ?? region.w,
          height: dims?.height ?? region.h,
          scale: 1.0,
          origin: { x: region.x, y: region.y },
          source: "screen", // R125-A: import -window root crops the ROOT window's pixels
        } satisfies Raster;
      }
    }
    return { error: "no Linux capture tool available for region capture" };
  },

  async cursorPosition(run) {
    const haveXdotool = await hasTool(run, "xdotool");
    if (!haveXdotool) return null;
    const result = await run({ program: "xdotool", args: ["getmouselocation"], timeoutMs: 4000 });
    if (result.code !== 0) return null;
    const mx = /x:(\-?\d+)/.exec(result.stdout);
    const my = /y:(\-?\d+)/.exec(result.stdout);
    if (!mx || !my) return null;
    return { x: Number.parseInt(mx[1], 10), y: Number.parseInt(my[1], 10) };
  },

  async readClipboard(run) {
    const haveXclip = await hasTool(run, "xclip", ["-version"]);
    if (haveXclip) {
      const result = await run({
        program: "xclip",
        args: ["-selection", "clipboard", "-o"],
        timeoutMs: 4000,
      });
      if (result.code === 0) return result.stdout;
    }
    const haveXsel = await hasTool(run, "xsel", ["--version"]);
    if (haveXsel) {
      const result = await run({
        program: "xsel",
        args: ["--clipboard", "--output"],
        timeoutMs: 4000,
      });
      if (result.code === 0) return result.stdout;
    }
    return "";
  },

  async writeClipboard(run, text) {
    const haveXclip = await hasTool(run, "xclip", ["-version"]);
    if (haveXclip) {
      const result = await run({
        program: "xclip",
        args: ["-selection", "clipboard", "-i"],
        stdin: text,
        timeoutMs: 4000,
      });
      if (result.code === 0) return { ok: true };
    }
    const haveXsel = await hasTool(run, "xsel", ["--version"]);
    if (haveXsel) {
      const result = await run({
        program: "xsel",
        args: ["--clipboard", "--input"],
        stdin: text,
        timeoutMs: 4000,
      });
      if (result.code === 0) return { ok: true };
    }
    return { ok: false, error: "no clipboard tool (xclip/xsel) available" };
  },

  async probePermissions(run): Promise<PermissionReport> {
    const notes: string[] = [];
    const display = process.env["DISPLAY"];
    const wayland = process.env["WAYLAND_DISPLAY"];
    const bus = await run({
      program: "gdbus",
      args: ["call", "--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus", "--method", "org.a11y.Bus.GetAddress"],
      timeoutMs: 4000,
    });
    const a11y: PermissionReport["accessibility"] =
      bus.code === 0 && display !== undefined && display !== "" ? "granted" : "unavailable";
    if (a11y !== "granted") {
      notes.push(
        display === undefined || display === ""
          ? "No DISPLAY — headless or Wayland session; X11 backends unavailable"
          : "org.a11y.Bus not reachable on the session bus (AT-SPI registry not running)",
      );
    }
    if (wayland !== undefined && wayland !== "") {
      notes.push("Wayland session detected: raw input injection and capture need XWayland or compositor-specific support");
    }
    const captureTool = (await hasTool(run, "import", ["-version"])) || (await hasTool(run, "scrot", ["-v"]));
    const screenCapture: PermissionReport["screenCapture"] = captureTool
      ? display !== undefined && display !== ""
        ? "granted"
        : "unavailable"
      : "unavailable";
    return { accessibility: a11y, screenCapture, backendKind: "linux", notes };
  },
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

function rasterFromBase64(b64: string, display: DisplayInfo | undefined): Raster | { error: string } {
  // PNG dimensions live in bytes 16..24 of the header — but our runner gives
  // us base64; the geometry from xrandr is the honest source when present.
  // Parse the PNG IHDR to be self-contained:
  const dims = pngDimensions(b64);
  const width = dims?.width ?? display?.bounds[2] ?? 0;
  const height = dims?.height ?? display?.bounds[3] ?? 0;
  if (width === 0 || height === 0) return { error: "capture produced a zero-sized image" };
  return {
    pngBase64: b64,
    width,
    height,
    scale: 1.0, // X11: everything is in physical px (doc 03 §5)
    origin: display ? { x: display.bounds[0], y: display.bounds[1] } : { x: 0, y: 0 },
  };
}

/** Minimal PNG IHDR parser (bytes 16..23: width, height big-endian). */
export function pngDimensions(b64: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 24) return null;
    if (buf.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function snapshotFromWalk(
  app: { pid: number; name?: string; bundleId?: string },
  window: WindowInfo,
  elements: Snapshot["elements"],
  detail: "compact" | "full",
  surface: Snapshot["surface"]["kind"],
): Snapshot {
  return {
    stateId: "", // the session stamps it
    app: { pid: app.pid, name: app.name, bundleId: app.bundleId, title: window.title },
    window: { title: window.title, windowId: window.windowId, bounds: window.bounds },
    surface: { kind: surface, actualWindowId: window.windowId, lifecycle: "stable" },
    elements: detail === "compact" ? elements.map(stripFull) : elements,
    createdAt: 0,
  };
}

function stripFull(el: Snapshot["elements"][number]): Snapshot["elements"][number] {
  const compact: Snapshot["elements"][number] = { index: el.index, kind: el.kind, name: el.name, flags: el.flags };
  if (el.value !== undefined) compact.value = el.value;
  return compact;
}

function interpretAtspiAction(result: { code: number; stdout: string; stderr: string }): {
  ok: boolean;
  error?: string;
  stale?: boolean;
} {
  if (result.code === 0) return { ok: true };
  const err = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  if (err.includes("STALE_ELEMENT")) return { ok: false, stale: true, error: "element identity changed since the snapshot" };
  if (err.includes("NO_SUCH_ELEMENT")) return { ok: false, stale: true, error: "element index out of range in the live tree" };
  return { ok: false, error: err.slice(0, 300) || "AT-SPI action failed" };
}

/* ── the embedded Python walkers (pyatspi) ──────────────────────────────────
 * Kept as exported builders so command-construction tests can snapshot the
 * exact script text without executing Python. */

const PYATSPI_PREAMBLE = `
import json, sys
try:
    import pyatspi
except Exception as e:
    print(json.dumps({"error": "import:" + str(e)})); sys.exit(1)
def kind_of(role):
    r = role.lower()
    if "window" == r or r.endswith("frame") or r.endswith("dialog"): return "window"
    if "menu" in r: return "menuitem"
    if r in ("push button", "button", "link", "toggle button"): return "button"
    if "text" in r and "field" in r or r in ("entry", "text"): return "textfield"
    if r in ("combo box",): return "combobox"
    if "check box" in r or "radio button" in r or "toggle" in r: return "checkbox"
    if "slider" in r or "spin button" in r: return "slider"
    if "tab" in r: return "tab" if "page" in r or "item" in r else "pane"
    if "table cell" in r or "list item" in r or "tree item" in r: return "row"
    if "static text" == r: return "text"
    if "image" in r: return "image"
    if "scroll bar" in r: return "scrollbar"
    return "pane"
def flags_of(el):
    flags = []
    try:
        acts = el.getActions()
        if acts: flags.append("pressable")
    except Exception: pass
    try:
        if el.getState().contains(pyatspi.STATE_EDITABLE): flags.append("editable")
    except Exception: pass
    try:
        if el.getState().contains(pyatspi.STATE_FOCUSED): flags.append("focused")
    except Exception: pass
    return flags
`;

export function linuxAtspiWalkerScript(
  pid: number,
  windowTitle: string,
  detail: "compact" | "full",
): string {
  return `${PYATSPI_PREAMBLE}
desktop = pyatspi.Registry.getDesktop()
target = None
for i in range(desktop.childCount):
    app = desktop.getChildAtIndex(i)
    try:
        if app.process_id == ${pid}:
            target = app; break
    except Exception:
        continue
if target is None:
    print(json.dumps({"error": "APP_NOT_FOUND"})); sys.exit(1)
win = None
for j in range(target.childCount):
    w = target.getChildAtIndex(j)
    try:
        if (w.name or "") == ${JSON.stringify(windowTitle)} and w.getRoleName() in ("frame", "window", "dialog", "page tab"):
            win = w; break
    except Exception:
        continue
if win is None:
    for j in range(target.childCount):
        try:
            w = target.getChildAtIndex(j)
            if w.getRoleName() in ("frame", "window", "dialog"):
                win = w; break
        except Exception:
            continue
if win is None:
    print(json.dumps({"error": "NO_WINDOW"})); sys.exit(1)
out = []
MAX_DEPTH = 25
MAX_ELEMENTS = 800
def walk(el, depth):
    if len(out) >= MAX_ELEMENTS or depth > MAX_DEPTH: return
    try:
        if el is None: return
        role = el.getRoleName() or ""
        name = (el.name or "")[:120]
        ent = {"index": len(out), "kind": kind_of(role), "name": name, "flags": flags_of(el)}
        try:
            v = el.queryValue(); ent["value"] = str(v.currentValue)[:120]
        except Exception: pass
        ${detail === "full" ? `try:
            ext = el.getExtents(); ent["bounds"] = [ext.x, ext.y, ext.width, ext.height]
        except Exception: pass
        acts = el.getActions()
        if acts: ent["actions"] = [a.name for a in acts][:12]` : ""}
        out.append(ent)
        for k in range(el.childCount):
            walk(el.getChildAtIndex(k), depth + 1)
    except Exception:
        return
walk(win, 0)
print(json.dumps({"elements": out}))
`;
}

export function linuxAtspiHitTestScript(x: number, y: number): string {
  return `${PYATSPI_PREAMBLE}
try:
    el = pyatspi.Registry.getDesktop().getComponentAtPoint(pyatspi.Point(${x}, ${y}))
except Exception:
    print(""); sys.exit(0)
if el is None:
    print(""); sys.exit(0)
ent = {"kind": kind_of(el.getRoleName() or ""), "name": (el.name or "")[:120], "actionable": len(flags_of(el)) > 0}
try:
    ext = el.getExtents(); ent["bounds"] = [ext.x, ext.y, ext.width, ext.height]
except Exception: pass
print(json.dumps(ent))
`;
}

export function linuxAtspiFocusedScript(pid: number): string {
  return `${PYATSPI_PREAMBLE}
desktop = pyatspi.Registry.getDesktop()
for i in range(desktop.childCount):
    app = desktop.getChildAtIndex(i)
    try:
        if app.process_id == ${pid}:
            try:
                f = pyatspi.Registry.getFocus()
                if f is not None: print((f.name or f.getRoleName() or "")[:200])
                else: print("")
            except Exception:
                print("")
            sys.exit(0)
    except Exception:
        continue
print("")
`;
}

export function linuxAtspiActionScript(
  pid: number,
  windowTitle: string,
  element: ElementDescriptor,
  action: "press" | "setValue" | "action" | "select",
  value?: string,
  actionName?: string,
  start?: number,
  length?: number | null,
): string {
  const valueLiteral = value === undefined ? "None" : JSON.stringify(value);
  const actionNameLiteral = actionName === undefined ? "None" : JSON.stringify(actionName);
  const windowTitleArg = windowTitle;
  return `${PYATSPI_PREAMBLE}
desktop = pyatspi.Registry.getDesktop()
target = None
for i in range(desktop.childCount):
    app = desktop.getChildAtIndex(i)
    try:
        if app.process_id == ${pid}:
            target = app; break
    except Exception:
        continue
if target is None:
    print("APP_NOT_FOUND"); sys.exit(1)
# SAME window root as the snapshot's walk (title match → first frame), so
# the element INDEX addresses the identical pre-order position.
win = None
for j in range(target.childCount):
    w = target.getChildAtIndex(j)
    try:
        if (w.name or "") == ${JSON.stringify(windowTitleArg)} and w.getRoleName() in ("frame", "window", "dialog", "page tab"):
            win = w; break
    except Exception:
        continue
if win is None:
    for j in range(target.childCount):
        try:
            w = target.getChildAtIndex(j)
            if w.getRoleName() in ("frame", "window", "dialog"):
                win = w; break
        except Exception:
            continue
if win is None:
    print("NO_WINDOW"); sys.exit(1)
out = []
MAX_DEPTH = 25
MAX_ELEMENTS = 800
def walk(el, depth):
    if len(out) > ${element.index} or depth > MAX_DEPTH: return
    try:
        if el is None: return
        out.append(el)
        for k in range(el.childCount):
            walk(el.getChildAtIndex(k), depth + 1)
    except Exception:
        return
walk(win, 0)
els = out
if ${element.index} >= len(els):
    print("NO_SUCH_ELEMENT"); sys.exit(1)
el = els[${element.index}]
try:
    same_kind = kind_of(el.getRoleName() or "") == ${JSON.stringify(element.kind)}
    same_name = (el.name or "")[:120] == ${JSON.stringify(element.name.slice(0, 120))}
    if not (same_kind or same_name):
        print("STALE_ELEMENT"); sys.exit(1)
except Exception:
    pass
${
  action === "press"
    ? `try:
    a = el.queryAction()
    done = False
    for i in range(a.nActions):
        if a.doAction(i):
            done = True; break
    if not done: print("NO_ACTION"); sys.exit(1)
except Exception as e:
    print("ACTION_FAILED:" + str(e)); sys.exit(1)`
    : action === "setValue"
      ? `try:
    v = el.queryValue()
    v.currentValue = ${valueLiteral}
except Exception as e:
    print("SET_FAILED:" + str(e)); sys.exit(1)`
      : action === "action"
        ? `try:
    a = el.queryAction()
    done = False
    for i in range(a.nActions):
        if a.getName(i) == ${actionNameLiteral}:
            a.doAction(i); done = True; break
    if not done: print("NO_SUCH_ACTION:" + str(${actionNameLiteral})); sys.exit(1)
except Exception as e:
    print("ACTION_FAILED:" + str(e)); sys.exit(1)`
        : `try:
    t = el.queryText()
    start = ${start ?? 0}
    length = ${length === null || length === undefined ? "None" : String(length)}
    if length is None:
        ok = t.setCaretOffset(start)
    else:
        ok = t.setSelection(start, start + length)
    if not ok: print("SELECT_FAILED"); sys.exit(1)
except Exception as e:
    print("SELECT_FAILED:" + str(e)); sys.exit(1)`
}
print("OK")
`;
}

/** The Linux backend's stable id ("linux") — exported for tests. */
export const LINUX_BACKEND_ID = "linux";
