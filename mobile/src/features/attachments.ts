/**
 * attachments.ts — the composer's FILE WORLD, typed 1:1 against the wires the
 * DESKTOP composer already speaks (R113-c: the owner's Android report — the
 * chat window must offer upload, project-file @-mentions, and everything the
 * PC chat does).
 *
 * THE WIRES (read from agent-core routes/attachments.ts + routes/projects.ts
 * + the desktop's src/lib/api.ts uploadAttachmentBytes/ingestAttachmentPath —
 * nothing invented):
 *
 *   POST /attachments/read   body {paths: string[], projectId?}
 *        → {files: [{path, name, size, text: string|null, truncated, error?}]}
 *          the text heads the model sees (≤128KB head, binary → text: null).
 *   POST /attachments/upload body {projectId, name, dataBase64 | absolutePath}
 *        → {path: "attachments/<final-name>", name, size}
 *          the R67-A ingestion — bytes land in <root>/attachments/ (deduped),
 *          the returned PROJECT-RELATIVE path rides the send's attachments.
 *   GET  /projects/:id/tree  → {tree: TreeNode[], rootPath}
 *          the @ quick-picker's file list (flattenTreeFiles — the desktop's
 *          exact DFS walk).
 *   GET  /projects/:id/modes → {modes: [{id, name, description, source, readOnly}]}
 *          the task-modes index (resolveEffectiveModes — the same resolver
 *          prepareTurn and switch_mode use; METADATA ONLY, bodies are
 *          prompt-side).
 *
 * The staged chip mirrors the desktop's ComposerAttachment (composer-utils):
 * name/path/size/text + the pending `dataBase64` a picked binary carries
 * until send-time upload. Everything here is pure TS over injected senders
 * except the two RN-touching helpers at the bottom (picker + raster cache),
 * which stay injectable for the screen.
 */

import { API_PREFIX, apiJson, type ApiOutcome, type ApiSender } from "./api";

// ── the wire shapes ─────────────────────────────────────────────────────────

/** One POST /attachments/read result (agent-core routes/attachments.ts, 1:1). */
export interface AttachmentReadResult {
  path: string;
  name: string;
  size: number;
  /** The ≤128KB text head, or null for binary/unreadable. */
  text: string | null;
  truncated: boolean;
  error?: string;
}

/** One POST /attachments/upload result. */
export interface AttachmentUploadResult {
  /** PROJECT-RELATIVE (forward slashes) — rides the send's attachments. */
  path: string;
  name: string;
  size: number;
}

/** One tree node (GET /projects/:id/tree — the desktop's TreeNode). */
export interface TreeNode {
  type: "file" | "dir";
  path: string;
  name: string;
  children?: TreeNode[];
}

// ── the staged chip (the desktop's ComposerAttachment semantics) ────────────

/** Where a staged chip came from (the chip's caption). */
export type AttachmentSource = "picker" | "project" | "at";

/** One attachment staged in the composer (chips clear on send). */
export interface ComposerAttachment {
  /** Stable react key (path when known, else name + size). */
  id: string;
  /** Display name (≤200 chars — the backend validates). */
  name: string;
  /** Project-relative path once persisted; undefined until the send uploads. */
  path?: string;
  /** File size in bytes (when known). */
  size: number;
  /** The text head the model will see (server-read); null = binary. */
  text: string | null;
  /** True when only the first 128KB of a larger file is staged. */
  truncated: boolean;
  source: AttachmentSource;
  /**
   * The FULL bytes as base64 for a PICKED binary file ≤8MB — the send path
   * uploads them (uploadAttachmentBytes) and swaps in the returned
   * project-relative `path`, so the model's history can point analyze_image
   * at a REAL file (the desktop's R67-A pipeline, mirrored).
   */
  dataBase64?: string | null;
  /**
   * ── ROUND-120 (why): ── the owner's item 32 — "image attachments get a
   * real preview chip" + "tapping ANY attachment opens a viewer pop-up".
   * A DEVICE-PICKED file's own local URI (the document picker's cache
   * file) — the ONLY bytes the phone ever holds natively. Project-read
   * files never carry one (their bytes live on the desktop host; the wire
   * gives the phone a text head, never pixels) — their chips stay glyph
   * chips and their viewer stays the honest name/size card.
   */
  localUri?: string;
}

/** The backend caps a message at 20 attachments — mirrored (the send 400s above). */
export const MAX_ATTACHMENTS = 20;

/** The desktop's R67-A byte ceiling for a persistable binary attachment. */
export const MAX_BINARY_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// ── pure chip helpers (unit-tested) ─────────────────────────────────────────

/** Stage a server-read file (POST /attachments/read result) as a chip; error
 * entries are NOT chips (the caller surfaces them). */
export function attachmentFromRead(
  result: AttachmentReadResult,
  source: AttachmentSource,
): ComposerAttachment | null {
  if (result.error !== undefined) return null;
  return {
    id: result.path,
    name: result.name,
    path: result.path,
    size: result.size,
    text: result.text,
    truncated: result.truncated,
    source,
  };
}

/** The wire-format MessageAttachment a send's body carries (the shared
 * MessageAttachment shape: name + optional path/size/text). */
export function toMessageAttachment(a: ComposerAttachment): {
  name: string;
  path?: string;
  size?: number;
  text?: string | null;
} {
  return {
    name: a.name,
    ...(a.path !== undefined ? { path: a.path } : {}),
    ...(a.size !== undefined ? { size: a.size } : {}),
    ...(a.text !== null ? { text: a.text } : {}),
  };
}

/** Add chips to a staged list, capped at MAX_ATTACHMENTS, id-deduped (within
 * the staged list AND within the incoming batch — the desktop's stage
 * semantics: one pick per id, never a doubled chip). */
export function stageAttachments(
  staged: ComposerAttachment[],
  chips: ComposerAttachment[],
): ComposerAttachment[] {
  const seen = new Set(staged.map((a) => a.id));
  const fresh: ComposerAttachment[] = [];
  for (const chip of chips) {
    if (seen.has(chip.id)) continue;
    seen.add(chip.id);
    fresh.push(chip);
  }
  return [...staged, ...fresh].slice(0, MAX_ATTACHMENTS);
}

/** ── ROUND-120 (why): ── the owner's item 32 — image attachments get "a
 *  real preview chip". The image-extension test over the chip's display
 *  name — the same family the transcript's user-bubble thumbnails use.
 *  Pure. */
const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

export function isImageFileName(name: string): boolean {
  return IMAGE_FILE_RE.test(name);
}

/** ── ROUND-120 (why): ── tapping ANY attachment "opens a viewer pop-up"
 *  (item 32) — this pure classifier picks WHICH viewer a staged chip opens:
 *
 *    "image" — an image-extension file whose bytes the phone actually holds
 *              (a picked localUri) → the large ImageViewer preview;
 *    "text"  — a chip carrying a head (picked or server-read) → the
 *              scrollable text view;
 *    "info"  — anything else (a binary over the wire, an image the phone
 *              has no bytes for) → the honest name + size + type card —
 *              never a preview that pretends to have pixels it does not.
 *
 *  Pure. */
export type AttachmentPreviewKind = "image" | "text" | "info";

export function attachmentPreviewKind(chip: ComposerAttachment): AttachmentPreviewKind {
  if (chip.localUri !== undefined && isImageFileName(chip.name)) return "image";
  if (chip.text !== null) return "text";
  return "info";
}

/** ── ROUND-120 (why): ── the owner's item 31 — "Typing @ opens a results
 *  menu ABOVE the input, filtering as the query continues". Android fires
 *  onChangeText BEFORE onSelectionChange, so a caret captured at the last
 *  selection event trails the character just typed — typing "@" into an
 *  empty field read caret 0 and the menu NEVER opened (detectAtToken needs
 *  the caret PAST the "@"). This advances the remembered caret by the
 *  value's length delta (typing inserts at the caret), clamped to the new
 *  length; the authoritative onSelectionChange re-detects right behind it.
 *  Pure. */
export function advancedCaret(prevCaret: number, prevValue: string, nextValue: string): number {
  const delta = nextValue.length - prevValue.length;
  if (delta > 0) return Math.min(prevCaret + delta, nextValue.length);
  return Math.max(0, Math.min(prevCaret, nextValue.length));
}

/** "2.4 MB" / "812 KB" — the chip's size caption (pure). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Flatten a project tree to its FILE paths (DFS, folders skipped) — the
 * desktop's exact walk (composer-utils.flattenTreeFiles). */
export function flattenTreeFiles(nodes: readonly TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === "file") out.push(node.path);
    if (node.children !== undefined) flattenTreeFiles(node.children, out);
  }
  return out;
}

/** Live filter for the @ quick-picker: substring, case-insensitive, capped
 * (the desktop's filterProjectFiles, limit 8). */
export function filterProjectFiles(files: readonly string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  const matched = q === "" ? [...files] : files.filter((f) => f.toLowerCase().includes(q));
  return matched.slice(0, limit);
}

// ── the @ token (the desktop's detectAtToken — typed in the input) ─────────

export interface AtToken {
  /** Index of the "@" character in the input value. */
  at: number;
  /** Index just after the token (the caret when detected). */
  end: number;
  /** The text between "@" and the caret (the live filter query). */
  query: string;
}

/**
 * Find the ACTIVE @ token at `caret`: the nearest "@" before the caret that
 * starts a word (start-of-text or whitespace before it) with no whitespace
 * between it and the caret. Null when the caret is not inside such a token.
 */
export function detectAtToken(value: string, caret: number): AtToken | null {
  if (caret < 0 || caret > value.length) return null;
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(value[at - 1])) return null; // mid-word @ (email etc.)
  const query = value.slice(at + 1, caret);
  if (/[\s]/.test(query)) return null; // token closed by whitespace
  return { at, end: caret, query };
}

/** Strip the picked @token from the input (the pick replaces it with a chip). */
export function stripAtToken(value: string, token: AtToken): string {
  return value.slice(0, token.at) + value.slice(token.end);
}

// ── the typed clients (injected senders — zero React Native) ───────────────

/** POST /attachments/read — the text heads (per-file outcomes, never a 500). */
export async function readAttachmentFiles(
  sender: ApiSender,
  paths: string[],
  projectId?: string,
): Promise<ApiOutcome<{ files: AttachmentReadResult[] }>> {
  return apiJson<{ files: AttachmentReadResult[] }>(sender, "/attachments/read", {
    method: "POST",
    bodyText: JSON.stringify({ paths, ...(projectId !== undefined ? { projectId } : {}) }),
  });
}

/** POST /attachments/upload — the R67-A ingestion (bytes → project file). */
export async function uploadAttachmentBytes(
  sender: ApiSender,
  projectId: string,
  name: string,
  dataBase64: string,
): Promise<ApiOutcome<AttachmentUploadResult>> {
  return apiJson<AttachmentUploadResult>(sender, "/attachments/upload", {
    method: "POST",
    bodyText: JSON.stringify({ projectId, name, dataBase64 }),
  });
}

/** GET /projects/:id/tree — the @ picker's file list. */
export async function fetchProjectTree(
  sender: ApiSender,
  projectId: string,
): Promise<ApiOutcome<{ tree: TreeNode[]; rootPath: string }>> {
  return apiJson<{ tree: TreeNode[]; rootPath: string }>(
    sender,
    `/projects/${encodeURIComponent(projectId)}/tree`,
  );
}

// R115-p: fetchProjectModes (GET /projects/:id/modes) was DELETED with the
// task-mode picker (R115-i) — it had no remaining production consumer. The
// endpoint itself still exists for the desktop's own picker; mobile re-adds
// a client only if a future wave needs it.

// ── ROUND-121 (R121-c — the pixels round): the display bytes ────────────────

/** One image-attachment fetch outcome — the raw display bytes, or the
 * honest miss. The CACHE-FILE write is the screen's half (the RN-touching
 * seam this file's header pins) — this module stays pure TS. */
export type AttachmentImageBytes = { base64: string | null; miss: boolean };

/** The cache-file name for one fetched attachment — content-keyed (path
 * slug + size): the upload route's dedupe-never-overwrite law makes a
 * path's bytes stable, so a re-render of the same attachment hits the same
 * cache file. Exported for the screen + the tests. */
export function attachmentCacheFileName(path: string, size?: number): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "img";
  const slug = path.replaceAll("/", "-").replaceAll("..", "");
  return `att-${slug}${size !== undefined ? `-${size}` : ""}.${ext}`;
}

/**
 * ROUND-121 (R121-c): GET /projects/:id/attachments/bytes?path=<rel> — one
 * user-sent image attachment's display bytes, fetched through the link as
 * base64 (`responseBase64` — the R113-c native leg the rasters proved; the
 * default UTF-8 bodyText would mojibake PNG bytes).
 *
 * A NON-IMAGE path never fetches (the route's allowlist mirrored
 * client-side — a doomed fetch for a .log is a wasted round trip). A 404
 * (deleted file / foreign project) resolves MISS (permanent — the frame
 * stands); a transport failure resolves base64-null / not-miss so the
 * caller may retry on its own cadence. The screen's resolver writes the
 * bytes into the cache directory and feeds RN <Image> the file URI (data
 * URIs carry a size ceiling on Android; a cache file does not).
 */
export async function fetchAttachmentImageBase64(
  sender: ApiSender,
  projectId: string,
  path: string,
): Promise<AttachmentImageBytes> {
  // Only DISPLAY-IMAGE paths ride this fetch — the route's allowlist is the
  // same set, and a doomed fetch for a .log is a wasted round trip.
  const dot = path.lastIndexOf(".");
  if (dot < 0) return { base64: null, miss: true };
  const ext = path.slice(dot + 1).toLowerCase();
  if (ATTACHMENT_IMAGE_MIME[ext] === undefined) return { base64: null, miss: true };

  let res;
  try {
    res = await sender.api(
      `${API_PREFIX}/projects/${encodeURIComponent(projectId)}/attachments/bytes?path=${encodeURIComponent(path)}`,
      { responseBase64: true },
    );
  } catch {
    // Transport loss — transient; the caller may retry on its own cadence.
    return { base64: null, miss: false };
  }
  if (!res.ok) {
    // The honest 404 (and any other refusal) — no pixels for this one.
    return { base64: null, miss: true };
  }
  const base64 = res.bodyBase64;
  if (base64 === undefined || base64 === "") {
    return { base64: null, miss: true };
  }
  return { base64, miss: false };
}

/** The display-image MIME by extension — the bytes route's allowlist,
 * mirrored client-side so non-images never spawn a doomed fetch. */
const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};
