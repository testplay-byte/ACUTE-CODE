// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  FOLDER_TYPE_META,
  FILE_TYPE_FALLBACK,
  FILE_TOOL_NAMES,
  FileTypeChip,
  FileTypeIcon,
  fileExtension,
  fileTypeHue,
  fileTypeMeta,
  type FileTypeMeta,
} from "./file-type";
import { useThemeStore } from "../../lib/theme-store";
import {
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileVideo,
  Folder,
} from "lucide-react";

/**
 * ROUND-127 (R127-W5): the FILE-TYPE palette's pins — TOKENS.md §1
 * hex-exception #5 (the model-palette precedent's class: extension identity
 * is the data encoding, so the hues are FIXED light/dark pairs, never
 * theme-derived).
 *
 *   · the extension map — the owner's named families read in their
 *     convention hues (HTML orange, CSS blue, JS yellow, TS violet, MD teal,
 *     MP4/MKV rose, MP3 cyan…);
 *   · the FALLBACK — unknown extensions never crash, never guess;
 *   · CASE-INSENSITIVITY — ".HTML" reads as html;
 *   · the icon/chip components — the tinted stroke resolves the active
 *     mode's leg of the fixed pair.
 */
describe("R127-W5 file-type palette (TOKENS §1 exception #5)", () => {
  beforeEach(() => {
    // nova + dark is the pinned mode for the hue-resolution pins; the
    // light leg gets its own flip below.
    useThemeStore.setState({ themeId: "nova", mode: "dark" });
  });
  afterEach(() => {
    cleanup();
  });

  it("the owner's named families read in their convention hues (fixed light/dark pairs)", () => {
    const html = fileTypeMeta("index.html");
    expect(html.hue).toEqual({ light: "#c2410c", dark: "#fb923c" }); // orange
    expect(html.label).toBe("HTML");
    expect(html.Icon).toBe(FileCode);

    const css = fileTypeMeta("styles/main.css");
    expect(css.hue).toEqual({ light: "#2563eb", dark: "#60a5fa" }); // blue
    expect(css.label).toBe("CSS");

    const js = fileTypeMeta("app.js");
    expect(js.hue).toEqual({ light: "#a16207", dark: "#facc15" }); // yellow
    expect(js.label).toBe("JS");

    const ts = fileTypeMeta("App.tsx");
    expect(ts.hue).toEqual({ light: "#6d28d9", dark: "#a78bfa" }); // violet
    expect(ts.label).toBe("TSX");

    const md = fileTypeMeta("README.md");
    expect(md.hue).toEqual({ light: "#0f766e", dark: "#2dd4bf" }); // teal
    expect(md.label).toBe("MD");

    // The owner's media families: MP4 AND MKV share the video pair, MP3 the
    // audio pair, images the magenta pair.
    expect(fileTypeMeta("clip.mp4").hue).toEqual(fileTypeMeta("movie.mkv").hue);
    expect(fileTypeMeta("clip.mp4").Icon).toBe(FileVideo);
    expect(fileTypeMeta("song.mp3").Icon).toBe(FileAudio);
    expect(fileTypeMeta("photo.png").Icon).toBe(FileImage);
    expect(fileTypeMeta("archive.zip").Icon).toBe(FileArchive);
    expect(fileTypeMeta("data.json").Icon).toBe(FileJson);
    // Same-family aliases agree on hue (scss IS css's family).
    expect(fileTypeMeta("a.scss").hue).toEqual(css.hue);
  });

  it("the FALLBACK: unknown extensions (and extensionless names) read as the quiet generic meta — never a crash, never a guess", () => {
    const weird = fileTypeMeta("mystery.quux");
    expect(weird).toBe(FILE_TYPE_FALLBACK);
    expect(weird.hue).toEqual({ light: "#475569", dark: "#94a3b8" }); // slate
    expect(weird.label).toBe("File");
    expect(weird.ext).toBe("");
    expect(fileTypeMeta("Makefile")).toBe(FILE_TYPE_FALLBACK);
    expect(fileTypeMeta("no-extension")).toBe(FILE_TYPE_FALLBACK);
    expect(fileTypeMeta("")).toBe(FILE_TYPE_FALLBACK);
  });

  it("CASE-INSENSITIVITY: .HTML / .Ts / .JSON read as their families", () => {
    expect(fileTypeMeta("INDEX.HTML").hue).toEqual(fileTypeMeta("index.html").hue);
    expect(fileTypeMeta("INDEX.HTML").label).toBe("HTML");
    expect(fileTypeMeta("main.Ts").label).toBe("TS");
    expect(fileTypeMeta("data.JSON").Icon).toBe(FileJson);
  });

  it("fileExtension: both separators, dotfiles, trailing dots, and case", () => {
    expect(fileExtension("src/app.ts")).toBe("ts");
    expect(fileExtension("app.ts")).toBe("ts");
    expect(fileExtension("C:\\repo\\mod.rs")).toBe("rs");
    expect(fileExtension(".env")).toBe("env");
    expect(fileExtension("trailing.")).toBe("");
    expect(fileExtension("Makefile")).toBe("");
    expect(fileExtension("A.TS")).toBe("ts");
    expect(fileExtension("")).toBe("");
  });

  it("the directory meta: the Folder glyph in the quiet slate pair (a dir is not a file family)", () => {
    expect(FOLDER_TYPE_META.Icon).toBe(Folder);
    expect(FOLDER_TYPE_META.label).toBe("Folder");
    expect(FOLDER_TYPE_META.hue).toEqual(FILE_TYPE_FALLBACK.hue);
  });

  it("fileTypeHue resolves the fixed pair's leg per mode", () => {
    const meta: FileTypeMeta = fileTypeMeta("a.html");
    expect(fileTypeHue(meta, true)).toBe("#fb923c");
    expect(fileTypeHue(meta, false)).toBe("#c2410c");
  });
});

describe("R127-W5 FileTypeIcon / FileTypeChip (the tinted stroke)", () => {
  beforeEach(() => {
    useThemeStore.setState({ themeId: "nova", mode: "dark" });
  });
  afterEach(() => {
    cleanup();
  });

  it("the icon renders the extension's glyph STROKED in the dark leg's hue (decorative, data-file-ext for inspection)", () => {
    const { container } = render(createElement(FileTypeIcon, { filename: "src/index.html", size: 12 }));
    const wrapper = screen.getByTestId("file-type-icon");
    expect(wrapper.getAttribute("data-file-ext")).toBe("html");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg).not.toBeNull();
    // Dark mode (the pinned theme) → the pair's dark leg paints the stroke.
    expect((svg as unknown as HTMLElement).style.color).toBe("#fb923c");
  });

  it("the LIGHT mode leg: flipping the theme store re-resolves the same family's light hue", () => {
    useThemeStore.setState({ themeId: "nova", mode: "light" });
    const { container } = render(createElement(FileTypeIcon, { filename: "src/index.html" }));
    const svg = container.querySelector("svg") as SVGElement;
    expect((svg as unknown as HTMLElement).style.color).toBe("#c2410c");
  });

  it("the chip: glyph + the family label in the fixed hue, mono, with the ext for inspection", () => {
    useThemeStore.setState({ themeId: "nova", mode: "dark" });
    const chip = render(createElement(FileTypeChip, { filename: "assets/clip.mp4" })).container.firstChild as HTMLElement;
    expect(chip.getAttribute("data-testid")).toBe("file-type-chip");
    expect(chip.getAttribute("data-file-ext")).toBe("mp4");
    expect(chip.textContent).toBe("MP4");
    expect(chip.className).toContain("font-mono");
    const svg = chip.querySelector("svg") as SVGElement;
    expect((svg as unknown as HTMLElement).style.color).toBe("#fb7185");
    // The chip's label ink rides the same fixed hue.
    expect(chip.style.color).toBe("#fb7185");
  });

  it("a plain-text file keeps the FileText glyph (the fallback never leaks onto known text families)", () => {
    const { container } = render(createElement(FileTypeIcon, { filename: "notes.txt" }));
    const svg = container.querySelector("svg") as SVGElement;
    expect((svg as unknown as HTMLElement).style.color).toBe("#94a3b8"); // slate dark leg
  });
});

describe("R128-W5 FILE_TOOL_NAMES (the single-icon anatomy's file-family set)", () => {
  it("the six PATH-TARGETED fs tools are members — their rows drop the generic family glyph for the one FileTypeIcon", () => {
    // The tools whose argsSummary carries the target as a `path:` segment
    // (formatToolTarget's default branch → the FileTypeIcon + PathPill row):
    // the row's ONE file mark is the extension glyph.
    expect(FILE_TOOL_NAMES.has("write_file")).toBe(true);
    expect(FILE_TOOL_NAMES.has("edit_file")).toBe(true);
    expect(FILE_TOOL_NAMES.has("read_file")).toBe(true);
    expect(FILE_TOOL_NAMES.has("delete_file")).toBe(true);
    expect(FILE_TOOL_NAMES.has("create_dir")).toBe(true);
    expect(FILE_TOOL_NAMES.has("list_dir")).toBe(true);
    expect(FILE_TOOL_NAMES.size).toBe(6); // the set is exactly the family — no strays
  });

  it("the search pair is NOT file-family (no path arg — the family glyph stays), nor are the command/delegate/skills rows", () => {
    // search_files/search_code search the WHOLE project tree (query/glob
    // args, never a path): their collapsed target is plain text, so the
    // generic family glyph remains the row's only mark — the letter's
    // "check the actual FILE-family set" resolved to the six above.
    expect(FILE_TOOL_NAMES.has("search_files")).toBe(false);
    expect(FILE_TOOL_NAMES.has("search_code")).toBe(false);
    expect(FILE_TOOL_NAMES.has("run_command")).toBe(false);
    expect(FILE_TOOL_NAMES.has("delegate_task")).toBe(false);
    expect(FILE_TOOL_NAMES.has("read_skill")).toBe(false);
  });
});
