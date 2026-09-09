import { useEffect, useRef, type RefObject } from "react";
import type { MessageAttachment, PermissionMode, ThinkingLevel } from "shared";
import type { AttachmentReadResult, TreeNode } from "../../../lib/api";

/**
 * ROUND-50 (R50-c2): the owner-spec composer — shared types, constants, and
 * small helpers used by every subcomponent under project-chat/composer/.
 *
 * The composer's layout contract (owner, verbatim intent): ONE rounded box
 * (radius 18, warm bg, accent border + soft glow on focus) with the
 * auto-growing textarea on top, an attachment chip row when any, and a
 * TOOLBAR ROW at the bottom INSIDE the box — left: Add Context + mode
 * switcher; right: context donut · model selector · thinking level · Send.
 */

/** One attachment staged in the composer (chips clear on send). */
export interface ComposerAttachment {
  /** Stable react key (path when known, else name + counter). */
  id: string;
  /** Display name (≤200 chars — the backend validates). */
  name: string;
  /** Absolute (picker) or project-relative (@ / project picker) path. */
  path?: string;
  /** File size in bytes (when known). */
  size: number;
  /**
   * The text head the model will see: server-read (≤128KB) for picked /
   * project files, client-read for dropped File objects; null = binary or
   * unreadable ("no readable text" chip).
   */
  text: string | null;
  /** True when only the first 128KB of a larger file is staged. */
  truncated: boolean;
  /** Where the chip came from (title tooltip on the chip). */
  source: "picker" | "project" | "at" | "drop" | "paste";
  /**
   * ROUND-67 (R67-A): the FULL bytes as base64 for a dropped/pasted BINARY
   * file ≤8MB — the send path uploads them (uploadAttachmentBytes →
   * POST /attachments/upload) and replaces this with the returned
   * project-relative `path`, so the model's history can point
   * analyze_image at a REAL file (the owner's #1 v0.66.0 complaint: the
   * bytes used to be discarded right here). null/undefined = nothing to
   * upload (text chip, oversized binary, or already persisted).
   */
  dataBase64?: string | null;
}

/** The per-session model override (persisted in localStorage per session). */
export interface ModelOverride {
  /** The full model id (e.g. "z-ai/glm-5.2:free"). */
  model: string;
  /** The provider whose catalog it was picked from (label + flyout check). */
  providerId: string;
}

/** Convert a staged chip into the wire-format MessageAttachment for sending. */
export function toMessageAttachment(a: ComposerAttachment): MessageAttachment {
  return {
    name: a.name,
    ...(a.path !== undefined ? { path: a.path } : {}),
    ...(a.size !== undefined ? { size: a.size } : {}),
    ...(a.text !== null ? { text: a.text } : {}),
  };
}

/** The backend caps a message at 20 attachments — mirror that in the UI. */
export const MAX_ATTACHMENTS = 20;

/**
 * ROUND-58 (R58-cf): the exact user message the composer's Continue button
 * sends after a user-stopped turn. A plain follow-up message — the backend's
 * history now includes the stopped turn's partial text + tool results (the
 * runtime flushes them on stop), so the model resumes from where it left
 * off. The string is a product decision pinned here (and asserted in tests):
 * do NOT reword it ad hoc.
 */
export const CONTINUE_FROM_STOP_MESSAGE = "Continue from where you left off.";

/** The backend caps attachment text at 128KB — mirrored for dropped files. */
export const ATTACHMENT_TEXT_CAP = 131_072;

/**
 * Stage a server-read file (POST /attachments/read result) as a chip. Error
 * entries are NOT chips — the caller surfaces them (toast/inline note).
 */
export function attachmentFromRead(
  result: AttachmentReadResult,
  source: ComposerAttachment["source"],
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

// ── Operating modes (ROUND-81, the owner's unified mode picker: ONE selector
//    replacing the old 4-value permission switcher AND the 6-builtin task-mode
//    picker) ──

export interface ModeOption {
  id: PermissionMode;
  label: string;
  description: string;
  /** lucide icon key — resolved in ModeSwitcher (keep this file icon-free). */
  icon: "zap" | "shield" | "clipboard";
}

/** The 3 operating modes with their one-line menu descriptions (owner spec).
 * R81: "editor" is retired (a stale localStorage/session value maps to "ask"
 * via modeOption's fallback — the backend remaps rows the same way). */
export const MODE_OPTIONS: readonly ModeOption[] = [
  {
    id: "full",
    label: "Full Access",
    description: "All tools, no permission asks — the agent decides how to work (research, plan, build, debug) and switches postures itself.",
    icon: "zap",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Full tools; asks before important commands and changes.",
    icon: "shield",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only — research and plan, no edits or commands.",
    icon: "clipboard",
  },
];

export function modeOption(id: PermissionMode): ModeOption {
  return MODE_OPTIONS.find((m) => m.id === id) ?? MODE_OPTIONS[1];
}

// ── Thinking levels (owner: "only four options: The default option, Low,
//    High, Max") ─────────────────────────────────────────────────────────────

export interface ThinkingOption {
  id: ThinkingLevel;
  label: string;
  description: string;
}

/** EXACTLY the four accepted levels (owner directive — no "medium"/"extra"). */
export const THINKING_OPTIONS: readonly ThinkingOption[] = [
  { id: "default", label: "Default", description: "The model's own reasoning default." },
  { id: "low", label: "Low", description: "Light reasoning — fastest replies." },
  { id: "high", label: "High", description: "Deeper reasoning for complex work." },
  { id: "max", label: "Max", description: "Maximum reasoning effort." },
];

export function thinkingOption(id: ThinkingLevel): ThinkingOption {
  return THINKING_OPTIONS.find((t) => t.id === id) ?? THINKING_OPTIONS[0];
}

// ── Per-session localStorage persistence (thinking level + model override) ──

const THINKING_KEY = (sessionId: string): string => `acute-thinking:${sessionId}`;
const MODEL_KEY = (sessionId: string): string => `acute-model:${sessionId}`;

/** Load the session's persisted thinking level (default when absent/invalid). */
export function loadThinkingLevel(sessionId: string | null): ThinkingLevel {
  if (sessionId === null) return "default";
  try {
    const raw = window.localStorage.getItem(THINKING_KEY(sessionId));
    const parsed = THINKING_OPTIONS.find((t) => t.id === raw);
    return parsed?.id ?? "default";
  } catch {
    return "default";
  }
}

/** Persist the session's thinking level (per-session key, survives remounts). */
export function saveThinkingLevel(sessionId: string | null, level: ThinkingLevel): void {
  if (sessionId === null) return;
  try {
    window.localStorage.setItem(THINKING_KEY(sessionId), level);
  } catch {
    /* storage unavailable (private mode) — the in-memory value still works */
  }
}

/** Load the session's persisted model override (null when absent/malformed). */
export function loadModelOverride(sessionId: string | null): ModelOverride | null {
  if (sessionId === null) return null;
  try {
    const raw = window.localStorage.getItem(MODEL_KEY(sessionId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { model?: unknown; providerId?: unknown };
    if (typeof parsed.model !== "string" || parsed.model === "") return null;
    if (typeof parsed.providerId !== "string" || parsed.providerId === "") return null;
    return { model: parsed.model, providerId: parsed.providerId };
  } catch {
    return null;
  }
}

/** Persist the session's model override ({model, providerId} as JSON). */
export function saveModelOverride(sessionId: string | null, v: ModelOverride | null): void {
  if (sessionId === null) return;
  try {
    if (v === null) window.localStorage.removeItem(MODEL_KEY(sessionId));
    else window.localStorage.setItem(MODEL_KEY(sessionId), JSON.stringify(v));
  } catch {
    /* storage unavailable — the in-memory override still works */
  }
}

// ── Project file flattening (@ quick-picker + Add Context → project files) ──

/** Flatten a project tree to its FILE paths (DFS, folders skipped). */
export function flattenTreeFiles(nodes: readonly TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === "file") out.push(node.path);
    if (node.children !== undefined) flattenTreeFiles(node.children, out);
  }
  return out;
}

/** Live filter for the @ quick-picker: substring, case-insensitive, capped. */
export function filterProjectFiles(
  files: readonly string[],
  query: string,
  limit = 8,
): string[] {
  const q = query.trim().toLowerCase();
  const matched = q === "" ? [...files] : files.filter((f) => f.toLowerCase().includes(q));
  return matched.slice(0, limit);
}

// ── @ token detection (typed in the textarea) ────────────────────────────────

export interface AtToken {
  /** Index of the "@" character in the textarea value. */
  at: number;
  /** Index just after the token (the caret when detected). */
  end: number;
  /** The text between "@" and the caret (the live filter query). */
  query: string;
}

/**
 * Find the ACTIVE @ token at `caret`: the nearest "@" before the caret that
 * starts a word (start-of-text or whitespace before it) with no whitespace
 * between it and the caret. Returns null when the caret is not inside such a
 * token (the popup's Esc-dismissal also suppresses the CURRENT token).
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

// ── Model flyout geometry (ROUND-51 R51-c: no more viewport cutoff) ─────────

/**
 * A plain-number rect in VIEWPORT coordinates (a DOMRect stripped to the
 * fields the geometry math needs) — pure in/out keeps the helper testable.
 */
export interface PlainRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Viewport size (window.innerWidth/innerHeight at measure time). */
export interface ViewportSize {
  width: number;
  height: number;
}

/** Gap kept between the flyout and any viewport edge / the popover (px). */
export const FLYOUT_MARGIN = 12;
/** Hard cap on the flyout's height (px) — it scrolls beyond that. */
export const FLYOUT_MAX_HEIGHT = 280;

export type FlyoutSide = "right" | "left" | "inline";

/**
 * ROUND-51 (R51-c): where a provider's model flyout should sit, derived from
 * MEASURED geometry — the fix for the owner's "it gets cut off at the bottom
 * and on the right side. It does not adapt its placement accordingly to the
 * available space."
 *
 *  - side: "right" when the viewport has FLYOUT_WIDTH + margin of space right
 *    of the popover, else "left" when it has that much left of the popover,
 *    else "inline" (the flyout replaces the list — narrow/touch fallback).
 *  - vertical: prefer top-aligning with the hovered ROW, clamped so the
 *    flyout stays inside the viewport with FLYOUT_MARGIN margins:
 *    flyoutViewportTop = clamp(rowTop, 12, viewportH - 12 - flyoutHeight).
 *    `top` is the ROW-RELATIVE offset (can be negative — shifts the flyout UP
 *    alongside the popover) for absolutely-positioned callers;
 *    `viewportTop` is the same value in viewport space for fixed-positioned
 *    callers. `flyoutHeight` defaults to the worst case (maxHeight) so the
 *    clamp can only ever be too conservative, never too loose.
 *  - maxHeight = min(FLYOUT_MAX_HEIGHT, viewportH - 2*margin).
 *
 * Pure: plain numbers in, plain numbers out.
 */
export function computeFlyoutGeometry(
  rowRect: PlainRect,
  popoverRect: PlainRect,
  viewport: ViewportSize,
  flyoutWidth: number,
  flyoutHeight?: number,
): { side: FlyoutSide; left: number | null; top: number; viewportTop: number; maxHeight: number } {
  const side: FlyoutSide =
    viewport.width - popoverRect.right >= flyoutWidth + FLYOUT_MARGIN
      ? "right"
      : popoverRect.left >= flyoutWidth + FLYOUT_MARGIN
        ? "left"
        : "inline";
  const maxHeight = Math.min(FLYOUT_MAX_HEIGHT, viewport.height - 2 * FLYOUT_MARGIN);
  if (side === "inline") {
    // Inline replaces the list content — no side positioning to compute.
    return { side, left: null, top: 0, viewportTop: rowRect.top, maxHeight };
  }
  const left =
    side === "right" ? popoverRect.right + FLYOUT_MARGIN : popoverRect.left - flyoutWidth - FLYOUT_MARGIN;
  // Clamp with a guarded upper bound so a degenerate (tiny) viewport still
  // yields a sane top instead of inverting the range.
  const height = flyoutHeight ?? maxHeight;
  const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(Math.max(value, lo), Math.max(lo, hi));
  const viewportTop = clamp(rowRect.top, FLYOUT_MARGIN, viewport.height - FLYOUT_MARGIN - height);
  return { side, left, top: viewportTop - rowRect.top, viewportTop, maxHeight };
}

// ── Dismissal (click-outside + Escape) shared by every popover/menu ─────────

/**
 * Attach the returned ref to the popover's outermost element; while `open`,
 * a mousedown outside it (or in `extraInside`, when the popover renders in a
 * portal and its trigger lives elsewhere in the DOM) or an Escape keydown
 * calls `onDismiss`. Mirrors the click-outside pattern AgentChatPanel's old
 * model menu used.
 * ROUND-64 (R64-c): the optional second ref — ContextDonut's popover moved
 * to a document.body portal (viewport-clipped positioning), so its TRIGGER
 * button is no longer inside the dismissed element's subtree; passing the
 * trigger's wrapper keeps click-to-pin working (a mousedown on the trigger
 * is NOT an outside-dismiss). Backwards-compatible for every other caller.
 */
export function useDismiss(
  open: boolean,
  onDismiss: () => void,
  extraInside?: RefObject<HTMLElement | null>,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        const extra = extraInside?.current ?? null;
        if (extra !== null && extra.contains(e.target as Node)) return;
        onDismiss();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onDismiss, extraInside]);
  return ref;
}

// ── Dropped/pasted-file client-side reads (FileReader — no usable path on File) ────

/**
 * ROUND-67 (R67-A): the byte ceiling for a persistable binary attachment —
 * the same 8MB POST /attachments/upload and analyze_image enforce. Larger
 * binary drops keep the R50 behavior (text: null, no bytes to persist).
 */
export const MAX_BINARY_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * ROUND-67 (R67-A): does this path look ABSOLUTE (a POSIX root or a Windows
 * drive)? Mirrors the server-side check in POST /attachments/read — the
 * composer uses it to decide whether a binary read result is an OS-picker
 * file the sidecar should COPY into the project (ingestAttachmentPath).
 * Project-relative reads ("@" / project picker) never match and stay as-is.
 */
export function isAbsoluteLikePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

/**
 * Base64 of a full ArrayBuffer — CHUNKED (String.fromCharCode chokes on a
 * spread larger than ~100k args; an 8MB image needs 256 chunks of 32k).
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * ROUND-67 (R67-A): the full bytes of a File as base64 — the wire format
 * POST /attachments/upload takes for dropped/pasted attachments. Rejects on
 * a read failure (callers decide whether that is fatal).
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error(`could not read '${file.name}'`));
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) resolve(arrayBufferToBase64(reader.result));
        else reject(new Error(`could not read '${file.name}'`));
      };
      reader.readAsArrayBuffer(file);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Read a dropped File client-side: NUL-sniff the first 8KB (binary → chip
 * with "no readable text"), decode up to 128KB of UTF-8 text (the same cap
 * the backend enforces on server reads). Never rejects — a read failure
 * becomes a null-text chip.
 *
 * ROUND-67 (R67-A): a binary file ≤8MB now ALSO keeps its bytes — the full
 * ArrayBuffer lands on the chip as `dataBase64`, and the composer's send
 * path uploads them into the project (uploadAttachmentBytes) so the model
 * gets a REAL path to analyze instead of the old "no readable text" dead
 * end (the owner's #1 complaint). Oversized binaries keep the R50 behavior.
 */
export function readDroppedFile(
  file: File,
  source: ComposerAttachment["source"] = "drop",
): Promise<ComposerAttachment> {
  return new Promise((resolve) => {
    const done = (text: string | null, dataBase64: string | null = null): void =>
      resolve({
        id: `${file.name}:${file.size}:${file.lastModified}`,
        name: file.name,
        size: file.size,
        text,
        truncated: file.size > ATTACHMENT_TEXT_CAP,
        source,
        ...(dataBase64 !== null ? { dataBase64 } : {}),
      });
    try {
      const reader = new FileReader();
      reader.onerror = () => done(null);
      reader.onload = () => {
        const buf = reader.result;
        if (!(buf instanceof ArrayBuffer)) {
          done(null);
          return;
        }
        const sniff = new Uint8Array(buf.slice(0, 8192));
        for (let i = 0; i < sniff.length; i++) {
          if (sniff[i] === 0) {
            // Binary — no readable text. ≤8MB: keep the bytes for the
            // send-time upload; bigger: the old placeholder-only chip.
            done(
              null,
              file.size <= MAX_BINARY_ATTACHMENT_BYTES ? arrayBufferToBase64(buf) : null,
            );
            return;
          }
        }
        const bytes = new Uint8Array(buf.slice(0, ATTACHMENT_TEXT_CAP));
        try {
          done(new TextDecoder().decode(bytes));
        } catch {
          done(null);
        }
      };
      reader.readAsArrayBuffer(file);
    } catch {
      done(null);
    }
  });
}

/**
 * ROUND-67 (R67-A): stage a PASTED image (e.clipboardData.files) — clipboard
 * files are binary blobs without paths, so this is the drop-style read with
 * the "paste" source: the chip carries the base64 bytes the send path
 * uploads. (A weird text-bearing clipboard file still gets its text head —
 * the same handling drops get.)
 */
export function readClipboardImageFile(file: File): Promise<ComposerAttachment> {
  return readDroppedFile(file, "paste");
}
