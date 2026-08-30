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
  source: "picker" | "project" | "at" | "drop";
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

// ── Permission modes (owner: "Switch between the access I want to grant it") ──

export interface ModeOption {
  id: PermissionMode;
  label: string;
  description: string;
  /** lucide icon key — resolved in ModeSwitcher (keep this file icon-free). */
  icon: "zap" | "shield" | "clipboard" | "editor";
}

/** The 4 permission modes with their one-line menu descriptions (owner spec). */
export const MODE_OPTIONS: readonly ModeOption[] = [
  {
    id: "full",
    label: "Full Access",
    description: "All tools auto-approved. No permission asks.",
    icon: "zap",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Asks before commands and external sites.",
    icon: "shield",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only. Research and plan, no edits.",
    icon: "clipboard",
  },
  {
    id: "editor",
    label: "Editor",
    description: "Edits files freely. No terminal. Deletes still ask.",
    icon: "editor",
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

// ── Dismissal (click-outside + Escape) shared by every popover/menu ─────────

/**
 * Attach the returned ref to the popover's outermost element; while `open`,
 * a mousedown outside it or an Escape keydown calls `onDismiss`. Mirrors the
 * click-outside pattern AgentChatPanel's old model menu used.
 */
export function useDismiss(
  open: boolean,
  onDismiss: () => void,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onDismiss();
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
  }, [open, onDismiss]);
  return ref;
}

// ── Dropped-file client-side reads (FileReader — no usable path on File) ────

/**
 * Read a dropped File client-side: NUL-sniff the first 8KB (binary → chip
 * with "no readable text"), decode up to 128KB of UTF-8 text (the same cap
 * the backend enforces on server reads). Never rejects — a read failure
 * becomes a null-text chip.
 */
export function readDroppedFile(
  file: File,
  source: ComposerAttachment["source"] = "drop",
): Promise<ComposerAttachment> {
  return new Promise((resolve) => {
    const fallback = (text: string | null): void =>
      resolve({
        id: `${file.name}:${file.size}:${file.lastModified}`,
        name: file.name,
        size: file.size,
        text,
        truncated: file.size > ATTACHMENT_TEXT_CAP,
        source,
      });
    try {
      const reader = new FileReader();
      reader.onerror = () => fallback(null);
      reader.onload = () => {
        const buf = reader.result;
        if (!(buf instanceof ArrayBuffer)) {
          fallback(null);
          return;
        }
        const sniff = new Uint8Array(buf.slice(0, 8192));
        for (let i = 0; i < sniff.length; i++) {
          if (sniff[i] === 0) {
            fallback(null); // binary — no readable text
            return;
          }
        }
        const bytes = new Uint8Array(buf.slice(0, ATTACHMENT_TEXT_CAP));
        try {
          fallback(new TextDecoder().decode(bytes));
        } catch {
          fallback(null);
        }
      };
      reader.readAsArrayBuffer(file);
    } catch {
      fallback(null);
    }
  });
}
