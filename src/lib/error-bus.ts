/**
 * ROUND-59 (R59-E) — the FRONTEND error bus (owner: "proper console-like
 * error monitoring and error handling… If there are any errors along the way
 * then you can easily detect them by yourself").
 *
 * A pure module-level store (NO React — the same discipline as the
 * module-level registries in stream-store/active-streams) that every
 * frontend error capture point funnels into:
 *
 *   - window "error" events (main.tsx — kind "window.onerror")
 *   - unhandled promise rejections (main.tsx — kind "unhandledrejection")
 *   - React render errors (components/shell/ErrorBoundary.tsx — kind "render")
 *   - TanStack Query global failures (main.tsx QueryCache — kind "query")
 *
 * The right-sidebar Console tab reads it (`errors()` snapshot, subscribe)
 * and merges it with the sidecar's error ring (GET /diagnostics/errors), so
 * ONE console shows everything the app knows about. Nothing is persisted —
 * the bus is a live ring (cap 200, oldest dropped): a diagnostic console,
 * not a log file.
 *
 * NO SECRETS RULE: every reported message/detail/stack is passed through
 * scrub() on the way in — bearer tokens, Authorization headers and
 * key-shaped material never land in the ring, because the console renders
 * its rows verbatim and its "Copy" buttons write them to the clipboard.
 */

/** Where an error was captured. Sidecar rows come from GET /diagnostics/errors. */
export type AppErrorSource = "frontend" | "sidecar";

/** One console row. Identical consecutive reports bump `count`, not rows. */
export interface AppError {
  id: string;
  /** Epoch ms of the MOST RECENT occurrence (moved forward on dedupe-hit). */
  ts: number;
  source: AppErrorSource;
  /** Capture point: "window.onerror" | "unhandledrejection" | "render" | "query" | … */
  kind: string;
  /** One-line, already-scrubbed summary (what the row shows). */
  message: string;
  /** Optional longer context (stack, HTTP status, …) — scrubbed + capped. */
  detail?: string;
  /** React component stack (render errors only) — scrubbed + capped. */
  componentStack?: string;
  /** How many times this identical error fired inside the dedupe window. */
  count: number;
}

/** Input to reportAppError — everything the capture site knows. */
export interface ReportAppErrorInput {
  source: AppErrorSource;
  kind: string;
  message: string;
  detail?: string;
  componentStack?: string;
}

/** Ring cap — matches the sidecar's ring (server.ts DIAGNOSTICS_RING_CAP). */
const RING_CAP = 200;
/**
 * Identical consecutive errors (same source+kind+message) within this window
 * increment the newest row's count instead of piling rows — a retry loop
 * firing 40×/second renders as ONE row with ×40, keeping the console legible.
 */
const DEDUPE_WINDOW_MS = 5_000;
/** Hard cap on any captured text field — stacks and blobs stay bounded. */
const TEXT_CAP = 8_000;

// ── Scrubbing ──────────────────────────────────────────────────────────────

/**
 * Redact secret-shaped substrings BEFORE anything enters the ring.
 * Deliberately broad: the ring is rendered verbatim and copied to the
 * clipboard, so a leaked bearer token or provider key would leave the app
 * through the console's own Copy button. Patterns:
 *   - `Bearer <token>` (the sidecar's per-spawn auth token)
 *   - `Authorization: …` header lines (curl-ish dumps)
 *   - `sk-…` OpenAI/OpenRouter-style key prefixes
 *   - `api key = …` / `token: …` / `secret: …` assignments
 */
const SCRUB_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer ***"],
  [/\bAuthorization\s*:\s*[^\s"',;]+/gi, "Authorization: ***"],
  [/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-***"],
  // ROUND-80 (R80): the NVIDIA NIM key prefix (nvapi-…) — same rule,
  // same redaction shape.
  [/\bnvapi-[A-Za-z0-9_-]{6,}\b/g, "nvapi-***"],
  [/\b(api[-_]?key|token|secret|password)\b\s*[:=]\s*["']?[^\s"',;]+/gi, "$1: ***"],
];

/** Scrub + bound a captured text field (undefined stays undefined). */
export function scrub(text: string): string {
  let out = text;
  for (const [re, replacement] of SCRUB_PATTERNS) {
    out = out.replace(re, replacement);
  }
  if (out.length > TEXT_CAP) {
    out = `${out.slice(0, TEXT_CAP)}… (truncated ${out.length - TEXT_CAP} chars)`;
  }
  return out;
}

// ── The store (tiny pubsub + immutable ring snapshot) ──────────────────────

/**
 * The ring as an IMMUTABLE array: every mutation produces a new array, so
 * `errors()` can hand the SAME reference to React's useSyncExternalStore
 * (stable snapshot identity — no render loop) and to plain subscribers.
 * Newest entry is index 0.
 */
let ring: AppError[] = [];
const listeners = new Set<() => void>();
let idCounter = 1;

function nextId(): string {
  return `err-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must never break the capture pipeline.
    }
  }
}

/**
 * Record an error. Returns the row id (the NEW row, or the deduped row that
 * absorbed the occurrence). Identical CONSECUTIVE reports (the newest row
 * has the same source+kind+message and arrived within DEDUPE_WINDOW_MS)
 * bump that row's count and move its ts forward; anything else pushes a new
 * newest-first row, dropping the oldest past RING_CAP.
 */
export function reportAppError(input: ReportAppErrorInput): string {
  const now = Date.now();
  const newest = ring[0];
  if (
    newest !== undefined &&
    newest.source === input.source &&
    newest.kind === input.kind &&
    newest.message === input.message &&
    now - newest.ts <= DEDUPE_WINDOW_MS
  ) {
    const merged: AppError = { ...newest, ts: now, count: newest.count + 1 };
    ring = [merged, ...ring.slice(1)];
    emit();
    return merged.id;
  }
  const entry: AppError = {
    id: nextId(),
    ts: now,
    source: input.source,
    kind: input.kind,
    message: scrub(input.message),
    detail: input.detail === undefined ? undefined : scrub(input.detail),
    componentStack:
      input.componentStack === undefined ? undefined : scrub(input.componentStack),
    count: 1,
  };
  ring = [entry, ...ring].slice(0, RING_CAP);
  emit();
  return entry.id;
}

/** Subscribe to every ring mutation. Returns the unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Latest snapshot (newest first). The array identity is stable between mutations. */
export function errors(): readonly AppError[] {
  return ring;
}

/** Remove one row (the console's per-row dismiss ×). No-op for unknown ids. */
export function dismiss(id: string): void {
  if (!ring.some((e) => e.id === id)) return;
  ring = ring.filter((e) => e.id !== id);
  emit();
}

/** Empty the bus (the console's Clear all — paired with the sidecar DELETE). */
export function clearAll(): void {
  if (ring.length === 0) return;
  ring = [];
  emit();
}

/** Test/maintenance hook: the ring cap, exported for pinning in tests. */
export const ERROR_BUS_RING_CAP = RING_CAP;
/** Test/maintenance hook: the dedupe window in ms. */
export const ERROR_BUS_DEDUPE_WINDOW_MS = DEDUPE_WINDOW_MS;
