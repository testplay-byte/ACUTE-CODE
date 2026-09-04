/**
 * ROUND-66 (R66, A4 — the owner's live report: "bot-wall detection
 * (captcha/Cloudflare/age) with a 15s wait the OWNER can solve, shown in
 * chat") — the HUMAN-VERIFICATION CHECKPOINT.
 *
 * browser-command.ts is the pattern: an agent tool needs someone OUTSIDE
 * this sidecar to act while the tool waits. There the someone is the app UI
 * (it runs the script in the live webview); here it is the OWNER — the page
 * hit a bot wall only a human can solve, so `browser_control
 * wait_for_verification` opens a checkpoint:
 *
 *   tool (agent-core)                           chat card (frontend)
 *   ───────────────────────────                 ───────────────────────────
 *   openBrowserCheckpoint(emit,  ──SSE──▶       stream-store intercept
 *   {tabId, kind, url, waitMs})                 → the live countdown card
 *                                                (Mark as done / Stop waiting)
 *   promise pends on this map   ◀──REST──── POST /browser-checkpoints/:id/resolve
 *                                                (api.resolveBrowserCheckpoint)
 *
 * TWO frames ride the turn's SSE stream (`ToolDeps.emit` — the same channel
 * the computer-use monitor + browser-command frames use): "browser-checkpoint"
 * when the wait opens and "browser-checkpoint.resolved" when it settles
 * (done | stop | timeout) so the card collapses even when the WAIT TIMES OUT
 * with no owner click. The frontend's handleStreamEvent takes the session id
 * from its own stream context, so frames carry `sessionId: ""` (the caller
 * may pass one when it knows it — nothing does today).
 *
 * The resolve route answers 200 {ok:true, resolution} / 200 {ok:false,
 * resolution:"timeout"} for unknown ids — exactly the src/lib/api.ts
 * resolveBrowserCheckpoint contract (the card falls back to its own
 * countdown timeout).
 *
 * The 60s HARD CAP: an owner cannot be asked to stare at a countdown longer
 * than a minute — callers asking for more get an honest rejection.
 */

export type BrowserCheckpointKind = "captcha" | "cloudflare" | "age" | "verification";

/** One detected bot wall: the class + the page text that proves it (a short
 * window around the matched marker — what the chat card and the tool result
 * show the owner). */
export interface VerificationWallHit {
  kind: BrowserCheckpointKind;
  evidence: string;
}

/** How a checkpoint can end: the owner marked it solved ("done"), the owner
 * stopped waiting ("stop"), or the countdown ran out ("timeout"). */
export type BrowserCheckpointResolution = "done" | "stop" | "timeout";

/** Hard cap on the owner-facing wait (default waits are ~15s). */
export const BROWSER_CHECKPOINT_MAX_WAIT_MS = 60_000;

// ───────────────────── wall detection (pure, exported for tests) ──────────

/**
 * The marker table, in PRIORITY order: a page that looks like a Cloudflare
 * interstitial is reported as cloudflare even when it also embeds a captcha
 * widget; a captcha beats an age gate; "age verification" is age, not the
 * generic fallback. Markers are matched case-insensitively with word
 * boundaries (so "g-recaptcha" still trips the "recaptcha" marker via its
 * hyphen edge, but "captchasaurus" does not trip "captcha").
 */
const WALL_MARKERS: ReadonlyArray<{ kind: BrowserCheckpointKind; markers: readonly string[] }> = [
  {
    kind: "cloudflare",
    markers: [
      "just a moment",
      "checking your browser",
      "cf-chl",
      "challenge-platform",
      "cf-browser-verification",
      "attention required! | cloudflare",
    ],
  },
  {
    kind: "captcha",
    markers: [
      "recaptcha",
      "g-recaptcha",
      "hcaptcha",
      "h-captcha",
      "turnstile",
      "cf-turnstile",
      "verify you are human",
      "verify you're human",
      "are you a robot",
      "captcha",
    ],
  },
  {
    kind: "age",
    markers: ["are you over 18", "are you 18 or older", "age verification", "age-restricted", "verify your age"],
  },
  { kind: "verification", markers: ["verification"] },
];

/** Escape a literal for embedding into a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The matched evidence — a short window of the SOURCE text around the match
 * (trimmed, ≤120 chars) so the chat card + the tool result can show WHY the
 * wall was flagged, not just that it was.
 */
function evidenceAround(haystack: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(haystack.length, index + length + 80);
  let evidence = haystack.slice(start, end).trim();
  if (evidence.length > 120) evidence = evidence.slice(0, 120);
  return evidence;
}

/**
 * Does this page look like a bot wall? PURE — no IO, no state; the caller
 * feeds it whatever it has (title first, then the page's visible text and/or
 * raw HTML). Returns the highest-priority hit with evidence, or null when
 * nothing matches.
 */
export function detectVerificationWall(input: { title?: string; html?: string; text?: string }): VerificationWallHit | null {
  const title = typeof input.title === "string" ? input.title : "";
  const body = [input.text, input.html]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  // Title first: the wall pages are title-led ("Just a moment…").
  for (const haystack of [title, body]) {
    if (haystack === "") continue;
    for (const group of WALL_MARKERS) {
      for (const marker of group.markers) {
        const match = new RegExp(`\\b${escapeRegExp(marker)}\\b`, "i").exec(haystack);
        if (match !== null) {
          return { kind: group.kind, evidence: evidenceAround(haystack, match.index, match[0].length) };
        }
      }
    }
  }
  return null;
}

// ─────────────────────── the pending-checkpoint registry ──────────────────

/** One open checkpoint (the wait_for_verification tool's pending promise). */
export interface PendingBrowserCheckpoint {
  checkpointId: string;
  tabId: string;
  kind: BrowserCheckpointKind;
  url: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (resolution: BrowserCheckpointResolution) => void;
}

/** The SSE frame that opens the chat countdown card. */
export interface BrowserCheckpointFrame {
  type: "browser-checkpoint";
  sessionId: string;
  checkpointId: string;
  tabId: string;
  kind: BrowserCheckpointKind;
  url: string;
  waitMs: number;
}

/** The SSE frame that collapses the card (done | stop | timeout). */
export interface BrowserCheckpointResolvedFrame {
  type: "browser-checkpoint.resolved";
  sessionId: string;
  checkpointId: string;
  resolution: BrowserCheckpointResolution;
}

const pending = new Map<string, PendingBrowserCheckpoint>();

let checkpointCounter = 0;
function nextCheckpointId(): string {
  checkpointCounter += 1;
  return `bchk_${Date.now().toString(36)}_${checkpointCounter.toString(36)}`;
}

/**
 * Open a checkpoint: emit the "browser-checkpoint" frame (the chat card
 * mounts), pend on the map, and wait for the owner (REST resolve) or the
 * countdown. `emit` is the turn's SSE emitter (ToolDeps.emit) — without a
 * live stream there is no card, so callers fail closed BEFORE calling this.
 * `waitMs` is a positive number ≤ 60_000 (BROWSER_CHECKPOINT_MAX_WAIT_MS);
 * anything else rejects honestly instead of hanging the turn.
 *
 * On settle the resolved frame is emitted through the SAME channel (best
 * effort — the stream may already be gone, which must never throw).
 */
export function openBrowserCheckpoint(
  emit: (event: unknown) => void,
  params: { tabId: string; kind: BrowserCheckpointKind; url: string; waitMs: number; sessionId?: string },
): Promise<{ resolution: BrowserCheckpointResolution }> {
  const waitMs = params.waitMs;
  if (
    typeof waitMs !== "number" ||
    !Number.isFinite(waitMs) ||
    waitMs <= 0 ||
    waitMs > BROWSER_CHECKPOINT_MAX_WAIT_MS
  ) {
    return Promise.reject(
      new Error(
        `browser checkpoint wait must be 1-${BROWSER_CHECKPOINT_MAX_WAIT_MS}ms (asked for ${String(waitMs)}) — the owner cannot be asked to wait longer than 60s`,
      ),
    );
  }
  const checkpointId = nextCheckpointId();
  const sessionId = params.sessionId ?? "";
  const rounded = Math.round(waitMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settle("timeout");
    }, rounded);
    // A function DECLARATION (hoisted) — the timer callback above may
    // reference it before its textual position.
    function settle(resolution: BrowserCheckpointResolution): void {
      pending.delete(checkpointId);
      clearTimeout(timer);
      try {
        const frame: BrowserCheckpointResolvedFrame = {
          type: "browser-checkpoint.resolved",
          sessionId,
          checkpointId,
          resolution,
        };
        emit(frame);
      } catch {
        // The stream may already be closed — the card's own countdown is
        // the fallback. Never let the resolution path throw.
      }
      resolve({ resolution });
    }
    pending.set(checkpointId, {
      checkpointId,
      tabId: params.tabId,
      kind: params.kind,
      url: params.url,
      startedAt: Date.now(),
      timer,
      settle,
    });
    try {
      const frame: BrowserCheckpointFrame = {
        type: "browser-checkpoint",
        sessionId,
        checkpointId,
        tabId: params.tabId,
        kind: params.kind,
        url: params.url,
        waitMs: rounded,
      };
      emit(frame);
    } catch (error) {
      // The frame never reached the frontend — no card, no one to resolve.
      clearTimeout(timer);
      pending.delete(checkpointId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * The REST resolve entry point (POST /browser-checkpoints/:id/resolve).
 * "done" = the owner solved the wall; "stop" = stop waiting. Returns false
 * when the id is unknown/expired (the route answers the {ok:false,
 * resolution:"timeout"} contract) or the action is not one of the two.
 */
export function resolveBrowserCheckpoint(checkpointId: string, action: "done" | "stop"): boolean {
  if (action !== "done" && action !== "stop") return false;
  const entry = pending.get(checkpointId);
  if (entry === undefined) return false;
  entry.settle(action);
  return true;
}

/** Test/inspection hook: how many checkpoints are in flight. */
export function pendingBrowserCheckpointCount(): number {
  return pending.size;
}

/**
 * Test hook: drop everything in flight — each pending wait resolves as a
 * "timeout" (the honest no-owner-answer outcome) instead of rejecting, so a
 * mid-test reset never crashes a tool that legitimately handles timeouts.
 */
export function resetBrowserCheckpointsForTest(): void {
  for (const entry of pending.values()) {
    entry.settle("timeout");
  }
  pending.clear();
}
