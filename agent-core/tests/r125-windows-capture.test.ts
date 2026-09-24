/**
 * ROUND-125 (R125-A) — the WINDOWS captureRegion's PRINTWINDOW-FIRST path,
 * pinned BY CONSTRUCTION (the computer-windows-backend.test.ts law: PowerShell
 * is NEVER executed in this sandbox — headless Linux — the emitted capsule
 * text + the JS parse against canned stdout are the contract).
 *
 * THE OWNER'S v0.117.0 VERDICT this suite guards: "the screenshot
 * functionality does not work properly — it takes the screenshot of the whole
 * device rather than the webpage. When I am in some other application, it
 * takes a screenshot of that application rather than the browser window
 * itself." Root cause (verified): the R124 staged capture grabbed the SCREEN
 * REGION with GDI CopyFromScreen — a screen-scrape that photographs whatever
 * ELSE is on top, so an occluded app window leaked the OCCLUDER's pixels.
 *
 * The fix under test, two halves:
 *   · the SCRIPT SHAPE — one capsule that arms the window path ONLY when an
 *     ownerPid is threaded (EnumWindows by pid → the owner top-level window →
 *     the Chrome_WidgetWin_1 child that tightest-matches the region →
 *     PrintWindow(child, hdc, 2) = PW_RENDERFULLCONTENT → the clamped crop),
 *     with the LEGACY CopyFromScreen branch kept VERBATIM as the honest
 *     fallback and the SRC:window / SRC:screen marker distinguishing which
 *     pixels actually got captured;
 *   · the JS PARSE — the raster's `source` (only SRC:window is trusted;
 *     everything else reads as the conservative "screen") and the GEO origin
 *     (the crop's true top-left for the window path).
 *
 * The delegate-lifetime law is pinned too: the Cap class's EnumWindows/
 * EnumChildWindows callbacks are assigned to LOCALS before the native call
 * and collect into STATIC lists (a GC'd delegate mid-enum crashes the
 * process — the classic EnumWindows trap the round's design called out).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { windowsBackend } from "../src/computer/backends/windows";
import type { CommandCapsule, RunCommand, RunResult } from "../src/computer/backends/interface";

type RecordingRun = RunCommand & { capsules: CommandCapsule[] };

/** A fake runner that captures every capsule and returns the given stdout. */
function fakeRun(stdout: string, code = 0): RecordingRun {
  const capsules: CommandCapsule[] = [];
  const run: RunCommand = async (capsule) => {
    capsules.push(capsule);
    return { code, stdout, stderr: "", timedOut: false } satisfies RunResult;
  };
  return Object.assign(run, { capsules }) as RecordingRun;
}

/** Decode a capsule's script back to text — BOTH transports (the R93-C
 * helper mirrored from computer-windows-backend.test.ts; the R125-A capture
 * capsule rides the temp-.ps1 -File branch — see the transport pin below). */
function decodeCapsuleScript(capsule: CommandCapsule): string {
  const i = capsule.args.indexOf("-EncodedCommand");
  if (i !== -1) {
    expect(capsule.args[i + 1]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    return Buffer.from(capsule.args[i + 1]!, "base64").toString("utf16le");
  }
  const f = capsule.args.indexOf("-File");
  expect(f).toBeGreaterThan(-1);
  const path = capsule.args[f + 1]!;
  expect(path).toMatch(/acute-ps-[^\\/]+[\\/]s\.ps1$/);
  return readFileSync(path, "utf8");
}

/** The canned stdout shape the real capsule emits: <base64> / GEO:x,y / SRC:s */
const cannedOutput = (geo: string, src: string): string => `aW1n${"aW1n".repeat(39)}\nGEO:${geo}\nSRC:${src}`;

/* ── the SCRIPT SHAPE (by construction) ──────────────────────────────────── */

describe("R125-A: captureRegion — the PrintWindow-first capsule (script shape)", () => {
  it("interpolates the region AND the threaded ownerPid — the window path is ARMED only when the pid arrives", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 10, y: 20, w: 1280, h: 720, ownerPid: 4242 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("$rx = 10");
    expect(script).toContain("$ry = 20");
    expect(script).toContain("$rw = 1280");
    expect(script).toContain("$rh = 720");
    // THE OWNER PID: the browser-capture route threads process.ppid; the
    // script gates the whole window path on it being > 0.
    expect(script).toContain("$ownerPid = 4242");
    expect(script).toContain("if ($ownerPid -gt 0 -and $script:CAP_OK)");
  });

  it("without an ownerPid the window path is honestly OFF ($ownerPid = 0) — legacy callers (dispatcher zoom, etc.) unchanged", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("$ownerPid = 0");
    // The gate keeps the PrintWindow machinery dead for pid-less callers —
    // they get the legacy screen-region grab, byte-identical semantics.
    expect(script).toContain("if ($ownerPid -gt 0 -and $script:CAP_OK)");
    // A non-integer / non-positive pid is filtered the same way JS-side.
    const run2 = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run2, { x: 0, y: 0, w: 100, h: 100, ownerPid: -3 });
    expect(decodeCapsuleScript(run2.capsules[0]!)).toContain("$ownerPid = 0");
  });

  it("carries the PrintWindow PW_RENDERFULLCONTENT call (flag 2) on the CHILD's own HDC", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    // The P/Invoke declaration + the flag-2 call (PW_RENDERFULLCONTENT —
    // captures DirectX/Chromium content and works while OCCLUDED/unfocused).
    expect(script).toContain("public static extern bool PrintWindow(IntPtr h,IntPtr hdc,uint flags)");
    expect(script).toContain("$pwok = [Cap]::PrintWindow($child, $hdc, 2)");
    // The bitmap HDC plumbing the task's correctness note demanded:
    // GetHdc → PrintWindow → ReleaseHdc → Dispose (a leaked HDC would kill
    // the capsule's GDI handle budget).
    expect(script).toContain("$hdc = $g.GetHdc()");
    expect(script).toContain("$g.ReleaseHdc($hdc)");
    expect(script).toContain("$g.Dispose()");
  });

  it("matches the WebView2 CHILD by class Chrome_WidgetWin_1, with any-overlap children as the fallback", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("[Cap]::GetClassName($kh, $ksb, 64)");
    expect(script).toContain("$ksb.ToString() -eq 'Chrome_WidgetWin_1'");
    // The fallback tracker (any child whose rect overlaps the region) is
    // computed in the SAME walk and consulted only when no widget matched.
    expect(script).toContain("$child = $aHwnd");
  });

  it("resolves the OWNER top-level window by pid with CONTAINMENT preferred over overlap", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("[void][Cap]::GetWindowThreadProcessId($oh, [ref]$opid)");
    expect(script).toContain("if ($opid -ne $ownerPid) { continue }");
    // Containment (the main window) beats a merely-overlapping same-pid
    // window (the pop-out); among equals the larger overlap wins.
    expect(script).toContain("$ocont = ($orect.Left -le $rx -and $orect.Top -le $ry -and $orect.Right -ge ($rx + $rw) -and $orect.Bottom -ge ($ry + $rh))");
    expect(script).toContain("if (($ocont -and -not $ownerContain) -or ($ocont -eq $ownerContain -and $oov -gt $ownerScore))");
  });

  it("scores children by SYMMETRIC DIFFERENCE — the app's own full-client-area UI webview shares the Chrome_WidgetWin_1 class and would WIN any overlap-only rule", async () => {
    // THE LOAD-BEARING SELECTION MATH: the main app's UI webview is ALSO a
    // Chrome_WidgetWin_1 child whose rect CONTAINS the region (overlap is
    // maximal), so a largest-overlap rule would capture the app's React UI
    // instead of the staged tab page. The tightest-fit rule
    // (childArea + regionArea − 2×overlap, minimized) is what makes "the
    // staged tab webview's rect ≈ the region" actually win — pinned here so
    // a future "simplification" back to overlap cannot land silently.
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("$kdiff = ($kw * $khgt) + ($rw * $rh) - (2 * $kox * $koy)");
    expect(script).toContain("if ($kdiff -lt $aDiff -or ($kdiff -eq $aDiff -and $kvis -and -not $aVis))");
  });

  it("keeps the EnumWindows/EnumChildWindows DELEGATE-ALIVE + static-storage contract in the Cap class (a GC'd delegate crashes the process)", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    // The callbacks are ASSIGNED TO LOCALS (cb=delegate…) before the native
    // Enum* call — never passed inline — and they collect into STATIC lists
    // cleared before each enum (the task's correctness requirement).
    expect(script).toContain("EnumProc cb=delegate(IntPtr h,IntPtr lp){capTops.Add(h);return true;};");
    expect(script).toContain("ChildProc cb=delegate(IntPtr h,IntPtr lp){capKids.Add(h);return true;};");
    expect(script).toContain("private static List<IntPtr> capTops=new List<IntPtr>();");
    expect(script).toContain("private static List<IntPtr> capKids=new List<IntPtr>();");
    expect(script).toContain("capTops.Clear();");
    expect(script).toContain("capKids.Clear();");
  });

  it("CLAMPS the crop into the child's bitmap (never negative, never past the edge)", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    // crop origin = region − childTopLeft, floored at 0; the far edge is
    // min(regionRight − childLeft, bitmap width) — a region slightly larger
    // than the child crops honestly, never pads, never throws.
    expect(script).toContain("$ix0 = [int][Math]::Max(0, $rx - $childL)");
    expect(script).toContain("$iy0 = [int][Math]::Max(0, $ry - $childT)");
    expect(script).toContain("$ix1 = [int][Math]::Min($rx + $rw - $childL, $bmp.Width)");
    expect(script).toContain("$iy1 = [int][Math]::Min($ry + $rh - $childT, $bmp.Height)");
    expect(script).toContain("if ($ix1 - $ix0 -ge 1 -and $iy1 - $iy0 -ge 1)");
  });

  it("keeps the LEGACY CopyFromScreen fallback branch in the SAME capsule — the honest degrade, verbatim", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 7, y: 8, w: 100, h: 100, ownerPid: 1 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    // The pre-R125 engine, byte-equivalent: CopyFromScreen at the region
    // origin into a region-sized bitmap → PNG → base64. ANY window-path
    // failure (no owner, no child, PrintWindow false, degenerate crop,
    // dead Cap compile) lands here.
    expect(script).toContain("$g.CopyFromScreen($rx, $ry, 0, 0, $bmp.Size)");
    expect(script).toContain("if ($null -eq $b64out -or $b64out.Length -lt 64)");
    // The Cap compile is GUARDED (the R67-C pattern): a dead csc degrades
    // to the screen path instead of aborting the capsule.
    expect(script).toContain("$script:CAP_OK = $false");
  });

  it("emits the SRC: marker on both paths + the GEO origin line (parse-compatible)", async () => {
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("Write-Output (\"SRC:\" + $src)");
    expect(script).toContain("$src = 'window'");
    expect(script).toContain("$src = 'screen'");
    expect(script).toContain("Write-Output (\"GEO:\" + $geoX + \",\" + $geoY)");
  });

  it("rides the temp-.ps1 -File transport (the R125-A re-measured oversized capsule — no CreateProcess ceiling)", async () => {
    // The psCapsule docblock's law: preamble 8,827 + capture script 7,654
    // chars → 43,952 base64, PAST the 30,000 ARGV switch → buildSnapshot's
    // temp-file transport. Pinned so a future trim that silently drops the
    // capsule under the switch is a CONSCIOUS change, and so a regression
    // past the 32,767 hard ceiling can never kill the spawn.
    const run = fakeRun(cannedOutput("0,0", "screen"));
    await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    const capsule = run.capsules[0]!;
    expect(capsule.program).toBe("powershell.exe");
    expect(capsule.args).toContain("-File");
    expect(capsule.args).not.toContain("-EncodedCommand");
    // The BOM (C5's law: powershell.exe 5.1 decodes BOM-less .ps1 as ANSI —
    // the script's em-dashes would mojibake).
    const file = capsule.args[capsule.args.indexOf("-File") + 1]!;
    const raw = readFileSync(file);
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);
  });
});

/* ── the JS PARSE (honest source + GEO origin, against canned stdout) ────── */

describe("R125-A: captureRegion — the parse (source + origin)", () => {
  it("SRC:window → raster.source 'window' and the GEO line's origin wins (the crop's true top-left)", async () => {
    const run = fakeRun(cannedOutput("2080,240", "window"));
    const raster = await windowsBackend.captureRegion(run, { x: 2080, y: 240, w: 2560, h: 1440, ownerPid: 4242 });
    expect("error" in raster).toBe(false);
    if (!("error" in raster)) {
      expect(raster.source).toBe("window");
      expect(raster.origin).toEqual({ x: 2080, y: 240 });
      expect(raster.pngBase64).toBe("aW1n".repeat(40));
    }
  });

  it("SRC:screen → raster.source 'screen' and the origin falls back to the REQUESTED region when GEO is absent", async () => {
    const run = fakeRun(`aW1n${"aW1n".repeat(39)}\nSRC:screen`);
    const raster = await windowsBackend.captureRegion(run, { x: 30, y: 40, w: 640, h: 480, ownerPid: 1 });
    if (!("error" in raster)) {
      expect(raster.source).toBe("screen");
      expect(raster.origin).toEqual({ x: 30, y: 40 });
    } else {
      expect.unreachable("the screen path must parse");
    }
  });

  it("a MISSING SRC marker (an older script / a stripped line) reads as the CONSERVATIVE 'screen' — never a guessed 'window'", async () => {
    const run = fakeRun(`aW1n${"aW1n".repeat(39)}\nGEO:0,0`);
    const raster = await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100 });
    if ("error" in raster) throw new Error(raster.error);
    expect(raster.source).toBe("screen");
  });

  it("a non-zero capsule exit → the honest error, unchanged (the window path never fabricates)", async () => {
    const run = fakeRun("boom", 1);
    const raster = await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    expect("error" in raster).toBe(true);
    if ("error" in raster) expect(raster.error).toContain("region capture failed");
  });

  it("no image bytes → the honest 'produced no image' error, unchanged", async () => {
    const run = fakeRun("GEO:0,0\nSRC:window");
    const raster = await windowsBackend.captureRegion(run, { x: 0, y: 0, w: 100, h: 100, ownerPid: 1 });
    expect("error" in raster).toBe(true);
    if ("error" in raster) expect(raster.error).toContain("produced no image");
  });
});
