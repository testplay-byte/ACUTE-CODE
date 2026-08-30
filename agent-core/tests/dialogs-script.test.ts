/**
 * ROUND-48: structural tests for the Windows folder-picker script.
 * ROUND-50 (R50-c1): the same for the multi-FILE picker script.
 *
 * pickFolder()/pickFiles() themselves BLOCK on a human and must never run
 * here — these tests assert the generated .ps1's structure (the modern-picker
 * primary, the topmost-owner z-order fix, the classic fallback, the
 * result-file contract) plus fully mocked win32 routing tests (spawn is
 * mocked; the fake child writes the result file, so no dialog can ever
 * appear).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { PS_SCRIPT, PS_FILES_SCRIPT, pickFolder, pickFiles } from "../src/dialogs.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

describe("windows picker script structure (round 48)", () => {
  it("PRIMARY: drives the modern IFileOpenDialog with FOS_PICKFOLDERS", () => {
    expect(PS_SCRIPT).toContain("IFileOpenDialog");
    expect(PS_SCRIPT).toContain("FOS_PICKFOLDERS");
    expect(PS_SCRIPT).toContain("Add-Type -TypeDefinition");
    // FOS_FORCEFILESYSTEM keeps virtual (non-filesystem) picks out.
    expect(PS_SCRIPT).toContain("FOS_FORCEFILESYSTEM");
  });

  it("Z-ORDER: every dialog is owned by a topmost form", () => {
    expect(PS_SCRIPT).toContain("$owner.TopMost = $true");
    expect(PS_SCRIPT).toContain("$owner.Handle");
    // The modern picker is shown with the owner's handle…
    expect(PS_SCRIPT).toContain("::Show($owner.Handle,");
    // …and the fallback dialog is shown modally against the same owner.
    expect(PS_SCRIPT).toContain("ShowDialog($owner)");
  });

  it("FALLBACK: the classic FolderBrowserDialog survives as the safety net", () => {
    expect(PS_SCRIPT).toContain("FolderBrowserDialog");
    // The fallback lives in the catch block — a failed Add-Type or COM error
    // must degrade to the classic dialog, not to an error.
    expect(PS_SCRIPT).toMatch(/catch\s*\{[\s\S]*FolderBrowserDialog/);
  });

  it("preserves the result-file contract (OK:/CANCEL + round-48 ERROR:)", () => {
    expect(PS_SCRIPT).toContain("'OK:'");
    expect(PS_SCRIPT).toContain("'CANCEL'");
    expect(PS_SCRIPT).toContain("'ERROR:'");
  });
});

describe("pickFolder routing (win32 path, spawn fully mocked)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubGlobal("process", { ...process, platform: "win32" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("spawns powershell -STA with the script + result file and parses CANCEL", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      // Mirror what the real .ps1 does on cancel: write the result file,
      // then exit cleanly. No dialog can ever appear.
      const idx = args.indexOf("-ResultFile");
      writeFileSync(args[idx + 1], "CANCEL", "utf8");
      const child = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    });
    const result = await pickFolder();
    expect(result.path).toBeNull();
    expect(result.error).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("powershell");
    expect(args).toContain("-STA");
    expect(args).toContain("-File");
    expect(args).toContain("-ResultFile");
  });

  it("parses OK:<path> into the picked folder", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const idx = args.indexOf("-ResultFile");
      writeFileSync(args[idx + 1], "OK:C:\\Users\\owner\\Projects\\demo", "utf8");
      const child = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    });
    const result = await pickFolder();
    expect(result.path).toBe("C:\\Users\\owner\\Projects\\demo");
  });

  it("surfaces a nonzero exit code honestly", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
      setTimeout(() => child.emit("close", 1), 0);
      return child;
    });
    const result = await pickFolder();
    expect(result.path).toBeNull();
    expect(result.error ?? "").toMatch(/exited with code 1/);
  });

  it("surfaces the round-48 ERROR: result line as a clean message", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const idx = args.indexOf("-ResultFile");
      writeFileSync(args[idx + 1], "ERROR:modern picker returned an empty path", "utf8");
      const child = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    });
    const result = await pickFolder();
    expect(result.path).toBeNull();
    expect(result.error ?? "").toMatch(/folder dialog failed: modern picker returned an empty path/);
  });
});

// ── ROUND-50 (R50-c1): the composer's multi-FILE picker script ───────────────

describe("windows file-picker script structure (ROUND-50 R50-c1)", () => {
  it("PRIMARY: the modern common OpenFileDialog with Multiselect (no COM interop needed for files)", () => {
    expect(PS_FILES_SCRIPT).toContain("System.Windows.Forms.OpenFileDialog");
    expect(PS_FILES_SCRIPT).toContain("$dialog.Multiselect = $true");
    // The user cannot invent a missing file (picker-side validation).
    expect(PS_FILES_SCRIPT).toContain("$dialog.CheckFileExists = $true");
    // The picks come from FileNames (plural — the multiselect contract).
    expect(PS_FILES_SCRIPT).toContain("$dialog.FileNames");
  });

  it("Z-ORDER: the dialog is OWNED by the same topmost invisible form as the folder picker (round-48 pattern)", () => {
    expect(PS_FILES_SCRIPT).toContain("$owner.TopMost = $true");
    expect(PS_FILES_SCRIPT).toContain("$owner.Handle");
    expect(PS_FILES_SCRIPT).toContain("ShowDialog($owner)");
  });

  it("preserves the result-file contract (multi-line OK:/CANCEL/ERROR:)", () => {
    expect(PS_FILES_SCRIPT).toContain("'OK:'");
    expect(PS_FILES_SCRIPT).toContain("'CANCEL'");
    expect(PS_FILES_SCRIPT).toContain("'ERROR:'");
    // Newline-joined multi-file OK payload.
    expect(PS_FILES_SCRIPT).toContain("-join \"`n\"");
  });
});

describe("pickFiles routing (win32 path, spawn fully mocked — ROUND-50 R50-c1)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubGlobal("process", { ...process, platform: "win32" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Fake child that writes the given result file then exits cleanly. */
  function fakeChildWriting(result: string) {
    return (_cmd: string, args: string[]) => {
      const idx = args.indexOf("-ResultFile");
      writeFileSync(args[idx + 1], result, "utf8");
      const child = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    };
  }

  it("spawns powershell -STA with the script + result file and parses a multi-file OK payload", async () => {
    spawnMock.mockImplementation(
      fakeChildWriting("OK:C:\\Users\\owner\\Docs\\a.md\nC:\\Users\\owner\\Docs\\b.md"),
    );
    const result = await pickFiles();
    expect(result.files).toEqual(["C:\\Users\\owner\\Docs\\a.md", "C:\\Users\\owner\\Docs\\b.md"]);
    expect(result.error).toBeUndefined();
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("powershell");
    expect(args).toContain("-STA");
    expect(args).toContain("-File");
    expect(args).toContain("-ResultFile");
  });

  it("CANCEL resolves to an empty list (a cancel is never an error)", async () => {
    spawnMock.mockImplementation(fakeChildWriting("CANCEL"));
    const result = await pickFiles();
    expect(result.files).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("ERROR: surfaces as a clean message; a nonzero exit code is honest", async () => {
    spawnMock.mockImplementation(fakeChildWriting("ERROR:dialog blew up"));
    const failed = await pickFiles();
    expect(failed.files).toEqual([]);
    expect(failed.error ?? "").toMatch(/file dialog failed: dialog blew up/);

    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
      setTimeout(() => child.emit("close", 1), 0);
      return child;
    });
    const crashed = await pickFiles();
    expect(crashed.files).toEqual([]);
    expect(crashed.error ?? "").toMatch(/exited with code 1/);
  });

  it("a single OK path still parses (one-line payload)", async () => {
    spawnMock.mockImplementation(fakeChildWriting("OK:C:\\Users\\owner\\Docs\\only.md"));
    const result = await pickFiles();
    expect(result.files).toEqual(["C:\\Users\\owner\\Docs\\only.md"]);
  });
});
