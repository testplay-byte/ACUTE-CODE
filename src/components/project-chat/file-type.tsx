import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileText,
  FileTerminal,
  FileVideo,
  Folder,
  Lock,
  Sheet,
  type LucideIcon,
} from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * ROUND-127 (R127-W5): the FILE-TYPE palette — the fixed per-extension
 * identity colors for the chat's file rows. The owner (verbatim): "in the
 * chat, when it shows the files, then the files should have proper icons
 * and proper colored icons based on their extensions, like HTML, CSS, JS,
 * and various other kinds of files, like Markdown, text, MP4, MP3, MKV, or
 * other kinds of files".
 *
 * TOKENS.md §1 hex-exception #5 (ROUND-127): the same data-encoding class
 * as the MODEL palette (exception #4, src/components/usage/usage-helpers.ts
 * — the precedent) and the segment/syntax palettes before it. A `.html`
 * file reads in its own hue in every theme, on every surface — extension
 * identity IS the encoding, not a surface mood, so it cannot flow from the
 * theme pipeline. The hues are the classic editor conventions (CSS is blue
 * in every icon theme; the encoding IS the convention) at reduced
 * saturation via light/dark pairs, muted enough to sit on clay in both
 * modes. The house's "no new blue surfaces" law governs SURFACES — this is
 * data encoding, the sanctioned exception.
 *
 * 13 pairs cover the owner's named families + the obvious rest; related
 * families SHARE a pair (the lucide glyph differentiates them — the same
 * glyph-different-hue idiom VS Code icon themes use). Unknown extensions
 * fall back to the quiet generic meta at the bottom.
 */
export interface FileTypeHue {
  /** The light-mode identity color (reads on clay-light card surfaces). */
  light: string;
  /** The dark-mode identity color (reads on clay-dark card surfaces). */
  dark: string;
}

/** One file family's identity: extension, display label, hue, glyph. */
export interface FileTypeMeta {
  /** The canonical lowercase extension ("" for the generic fallback). */
  ext: string;
  /** The short display label (chips / titles). */
  label: string;
  /** The FIXED light/dark identity pair (never theme-derived). */
  hue: FileTypeHue;
  /** The lucide glyph, tinted the hue at render time. */
  Icon: LucideIcon;
}

/* The 13 fixed hue pairs — every hex below is a documented TOKENS §1
 * exception #5 literal (comments name the family each pair owns). */
const HUE_HTML: FileTypeHue = { light: "#c2410c", dark: "#fb923c" }; // orange — html (+ rust/java share)
const HUE_CSS: FileTypeHue = { light: "#2563eb", dark: "#60a5fa" }; // blue — css (+ c family share)
const HUE_JS: FileTypeHue = { light: "#a16207", dark: "#facc15" }; // yellow — javascript
const HUE_TS: FileTypeHue = { light: "#6d28d9", dark: "#a78bfa" }; // violet — typescript (+ sql share)
const HUE_DATA: FileTypeHue = { light: "#b45309", dark: "#fbbf24" }; // amber — json/xml/toml/config
const HUE_PROSE: FileTypeHue = { light: "#0f766e", dark: "#2dd4bf" }; // teal — markdown (+ yaml share)
const HUE_TEXT: FileTypeHue = { light: "#475569", dark: "#94a3b8" }; // slate — plain text/log/lock/generic
const HUE_PDF: FileTypeHue = { light: "#b91c1c", dark: "#f87171" }; // red — pdf
const HUE_IMAGE: FileTypeHue = { light: "#a21caf", dark: "#e879f9" }; // magenta — raster/vector images
const HUE_VIDEO: FileTypeHue = { light: "#be123c", dark: "#fb7185" }; // rose — video containers
const HUE_AUDIO: FileTypeHue = { light: "#0e7490", dark: "#22d3ee" }; // cyan — audio (+ go share)
const HUE_ARCHIVE: FileTypeHue = { light: "#78350f", dark: "#d97706" }; // brown — archives
const HUE_SHELL: FileTypeHue = { light: "#15803d", dark: "#4ade80" }; // green — shell (+ python/csv share)

/** The extension → family table. Pure data; every key lowercase. */
const FILE_TYPE_METAS: Record<string, FileTypeMeta> = {
  // web markup
  html: { ext: "html", label: "HTML", hue: HUE_HTML, Icon: FileCode },
  htm: { ext: "html", label: "HTML", hue: HUE_HTML, Icon: FileCode },
  // styles
  css: { ext: "css", label: "CSS", hue: HUE_CSS, Icon: FileCode },
  scss: { ext: "scss", label: "SCSS", hue: HUE_CSS, Icon: FileCode },
  less: { ext: "less", label: "LESS", hue: HUE_CSS, Icon: FileCode },
  // javascript family
  js: { ext: "js", label: "JS", hue: HUE_JS, Icon: FileCode },
  jsx: { ext: "jsx", label: "JSX", hue: HUE_JS, Icon: FileCode },
  mjs: { ext: "mjs", label: "MJS", hue: HUE_JS, Icon: FileCode },
  cjs: { ext: "cjs", label: "CJS", hue: HUE_JS, Icon: FileCode },
  // typescript family
  ts: { ext: "ts", label: "TS", hue: HUE_TS, Icon: FileCode },
  tsx: { ext: "tsx", label: "TSX", hue: HUE_TS, Icon: FileCode },
  // data / config
  json: { ext: "json", label: "JSON", hue: HUE_DATA, Icon: FileJson },
  xml: { ext: "xml", label: "XML", hue: HUE_DATA, Icon: FileCode },
  toml: { ext: "toml", label: "TOML", hue: HUE_DATA, Icon: FileCog },
  ini: { ext: "ini", label: "INI", hue: HUE_DATA, Icon: FileCog },
  cfg: { ext: "cfg", label: "CFG", hue: HUE_DATA, Icon: FileCog },
  conf: { ext: "conf", label: "CONF", hue: HUE_DATA, Icon: FileCog },
  env: { ext: "env", label: "ENV", hue: HUE_DATA, Icon: FileCog },
  // prose
  md: { ext: "md", label: "MD", hue: HUE_PROSE, Icon: FileText },
  mdx: { ext: "mdx", label: "MDX", hue: HUE_PROSE, Icon: FileText },
  yaml: { ext: "yaml", label: "YAML", hue: HUE_PROSE, Icon: FileCog },
  yml: { ext: "yml", label: "YML", hue: HUE_PROSE, Icon: FileCog },
  // plain text family
  txt: { ext: "txt", label: "TXT", hue: HUE_TEXT, Icon: FileText },
  log: { ext: "log", label: "LOG", hue: HUE_TEXT, Icon: FileText },
  lock: { ext: "lock", label: "LOCK", hue: HUE_TEXT, Icon: Lock },
  gitignore: { ext: "gitignore", label: "GIT", hue: HUE_TEXT, Icon: File },
  // documents
  pdf: { ext: "pdf", label: "PDF", hue: HUE_PDF, Icon: FileText },
  // images
  png: { ext: "png", label: "PNG", hue: HUE_IMAGE, Icon: FileImage },
  jpg: { ext: "jpg", label: "JPG", hue: HUE_IMAGE, Icon: FileImage },
  jpeg: { ext: "jpeg", label: "JPEG", hue: HUE_IMAGE, Icon: FileImage },
  gif: { ext: "gif", label: "GIF", hue: HUE_IMAGE, Icon: FileImage },
  webp: { ext: "webp", label: "WEBP", hue: HUE_IMAGE, Icon: FileImage },
  svg: { ext: "svg", label: "SVG", hue: HUE_IMAGE, Icon: FileImage },
  bmp: { ext: "bmp", label: "BMP", hue: HUE_IMAGE, Icon: FileImage },
  ico: { ext: "ico", label: "ICO", hue: HUE_IMAGE, Icon: FileImage },
  // video
  mp4: { ext: "mp4", label: "MP4", hue: HUE_VIDEO, Icon: FileVideo },
  mkv: { ext: "mkv", label: "MKV", hue: HUE_VIDEO, Icon: FileVideo },
  mov: { ext: "mov", label: "MOV", hue: HUE_VIDEO, Icon: FileVideo },
  avi: { ext: "avi", label: "AVI", hue: HUE_VIDEO, Icon: FileVideo },
  webm: { ext: "webm", label: "WEBM", hue: HUE_VIDEO, Icon: FileVideo },
  m4v: { ext: "m4v", label: "M4V", hue: HUE_VIDEO, Icon: FileVideo },
  flv: { ext: "flv", label: "FLV", hue: HUE_VIDEO, Icon: FileVideo },
  // audio
  mp3: { ext: "mp3", label: "MP3", hue: HUE_AUDIO, Icon: FileAudio },
  wav: { ext: "wav", label: "WAV", hue: HUE_AUDIO, Icon: FileAudio },
  ogg: { ext: "ogg", label: "OGG", hue: HUE_AUDIO, Icon: FileAudio },
  flac: { ext: "flac", label: "FLAC", hue: HUE_AUDIO, Icon: FileAudio },
  m4a: { ext: "m4a", label: "M4A", hue: HUE_AUDIO, Icon: FileAudio },
  aac: { ext: "aac", label: "AAC", hue: HUE_AUDIO, Icon: FileAudio },
  // archives
  zip: { ext: "zip", label: "ZIP", hue: HUE_ARCHIVE, Icon: FileArchive },
  tar: { ext: "tar", label: "TAR", hue: HUE_ARCHIVE, Icon: FileArchive },
  gz: { ext: "gz", label: "GZ", hue: HUE_ARCHIVE, Icon: FileArchive },
  tgz: { ext: "tgz", label: "TGZ", hue: HUE_ARCHIVE, Icon: FileArchive },
  "7z": { ext: "7z", label: "7Z", hue: HUE_ARCHIVE, Icon: FileArchive },
  rar: { ext: "rar", label: "RAR", hue: HUE_ARCHIVE, Icon: FileArchive },
  bz2: { ext: "bz2", label: "BZ2", hue: HUE_ARCHIVE, Icon: FileArchive },
  xz: { ext: "xz", label: "XZ", hue: HUE_ARCHIVE, Icon: FileArchive },
  // languages (share hues with their convention-adjacent families; the
  // glyphs differentiate)
  py: { ext: "py", label: "PY", hue: HUE_SHELL, Icon: FileCode },
  rs: { ext: "rs", label: "RS", hue: HUE_HTML, Icon: FileCode },
  go: { ext: "go", label: "GO", hue: HUE_AUDIO, Icon: FileCode },
  java: { ext: "java", label: "JAVA", hue: HUE_HTML, Icon: FileCode },
  c: { ext: "c", label: "C", hue: HUE_CSS, Icon: FileCode },
  cpp: { ext: "cpp", label: "CPP", hue: HUE_CSS, Icon: FileCode },
  h: { ext: "h", label: "H", hue: HUE_CSS, Icon: FileCode },
  hpp: { ext: "hpp", label: "HPP", hue: HUE_CSS, Icon: FileCode },
  sh: { ext: "sh", label: "SH", hue: HUE_SHELL, Icon: FileTerminal },
  bash: { ext: "bash", label: "BASH", hue: HUE_SHELL, Icon: FileTerminal },
  zsh: { ext: "zsh", label: "ZSH", hue: HUE_SHELL, Icon: FileTerminal },
  bat: { ext: "bat", label: "BAT", hue: HUE_SHELL, Icon: FileTerminal },
  ps1: { ext: "ps1", label: "PS1", hue: HUE_SHELL, Icon: FileTerminal },
  csv: { ext: "csv", label: "CSV", hue: HUE_SHELL, Icon: Sheet },
  sql: { ext: "sql", label: "SQL", hue: HUE_TS, Icon: Database },
};

/** The quiet generic fallback — unknown extensions never crash, never
 * guess: a slate file glyph that reads as "a file" in both modes. */
export const FILE_TYPE_FALLBACK: FileTypeMeta = {
  ext: "",
  label: "File",
  hue: HUE_TEXT,
  Icon: File,
};

/** Directory rows (list_dir/create_dir targets) — the Folder glyph in the
 * quiet slate pair: a directory is not a file family, and the icon says so
 * where the extension cannot. */
export const FOLDER_TYPE_META: FileTypeMeta = {
  ext: "dir",
  label: "Folder",
  hue: HUE_TEXT,
  Icon: Folder,
};

/** The lowercase extension of a path/bare filename ("" when none).
 * Handles both separators, dotfiles (".env" → "env"), and case. Pure. */
export function fileExtension(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed === "") return "";
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * The file family of a filename — the fixed identity (hue + glyph + label)
 * keyed by its extension, case-insensitively; unknown extensions (and
 * extensionless names) fall back to the quiet generic meta. Pure; exported
 * for tests and any future surface (the mobile file chips ride their own
 * wave).
 */
export function fileTypeMeta(filename: string): FileTypeMeta {
  const ext = fileExtension(filename);
  return FILE_TYPE_METAS[ext] ?? FILE_TYPE_FALLBACK;
}

/** The palette slot's resolved color for the active mode (the fixed pair's
 * dark leg in dark mode, light leg otherwise). */
export function fileTypeHue(meta: FileTypeMeta, isDark: boolean): string {
  return isDark ? meta.hue.dark : meta.hue.light;
}

/**
 * The tinted file glyph — the lucide icon stroked in the extension's FIXED
 * identity hue (TOKENS §1 exception #5: extension identity is the data
 * encoding). `dir` swaps in the Folder meta (list_dir/create_dir targets —
 * a directory is not a file family, and the glyph says so where the
 * extension cannot). Decorative by design (the path text beside it carries
 * the meaning) — `aria-hidden`, with data-file-ext for tests/inspection.
 */
export function FileTypeIcon({
  filename,
  size = 12,
  dir = false,
}: {
  filename: string;
  size?: number;
  dir?: boolean;
}) {
  const styles = useThemeStyles();
  const meta = dir ? FOLDER_TYPE_META : fileTypeMeta(filename);
  const Icon = meta.Icon;
  return (
    <span
      className="shrink-0 inline-flex leading-none"
      aria-hidden="true"
      data-testid="file-type-icon"
      data-file-ext={meta.ext}
    >
      <Icon size={size} style={{ color: fileTypeHue(meta, styles.isDark) }} />
    </span>
  );
}

/**
 * The chip treatment — glyph + the family label in the fixed hue, for
 * surfaces that want the identity as a chip rather than a bare glyph (the
 * rows ride FileTypeIcon before the path pill today; this is the available
 * API for denser surfaces).
 */
export function FileTypeChip({ filename }: { filename: string }) {
  const styles = useThemeStyles();
  const meta = fileTypeMeta(filename);
  const hue = fileTypeHue(meta, styles.isDark);
  const Icon = meta.Icon;
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-[10px] font-medium"
      style={{ color: hue }}
      data-testid="file-type-chip"
      data-file-ext={meta.ext}
    >
      <Icon size={11} style={{ color: hue }} />
      <span>{meta.label}</span>
    </span>
  );
}
