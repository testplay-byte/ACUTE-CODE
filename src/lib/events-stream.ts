/**
 * ROUND-113 (R113-b): the EVENTS stream client — the desktop's half of the
 * live-sync backbone R113-a landed on the sidecar (GET /api/v1/events/stream
 * + agent-core/src/lib/events-bus.ts). One long-lived SSE subscription fans
 * EVERY process-wide change into this app: session log appends, status
 * flips, session/project creations, the LIVE turn mirror (every frame the
 * initiating socket receives — the phone's turn streams on the desktop), and
 * settings-domain PUTs (another device's theme flip lands here live).
 *
 * Wire contract (R113-a, commit 84f846f — the exact frame shapes):
 *   data: {"type":"hello"}                        — once, on every (re)connect
 *   data: {"type":"session","sessionId","projectId","kind":"event"|"status"|"created","seq?","status?"}
 *   data: {"type":"turn","sessionId","frame":<exact StreamTurnEvent>}
 *   data: {"type":"project","projectId","kind":"created"|"updated"|"deleted"}
 *   data: {"type":"settings","domain","value"}
 *   : ping                                      — comment heartbeat, 10s
 * hello = "resync everything": a fresh/reconnected watcher refetches its
 * state, then follows frames. NO server-side session filtering — frames are
 * filtered by sessionId client-side (a single-owner sidecar; see the route's
 * v1 rule). EventSource cannot set the Authorization header, so this is the
 * same fetch + ReadableStream + TextDecoder pattern streamNotifications uses
 * (src/lib/notifications-api.ts:180-221 — the reader loop is a verbatim
 * mirror; the caller owns the reconnect loop with the 1s→15s backoff).
 *
 * SPLIT (deliberate, for testability + the R113-e mobile port):
 *   · parseEventsFrameLine()  — PURE: one SSE line → one frame (or null for
 *     comments/heartbeats/malformed payloads).
 *   · openEventsStream()      — the transport: fetch-SSE reader, calls the
 *     pure parser per line (the mobile app ports THIS shape).
 *   · handleEventsFrame()     — the dispatch: frame → query invalidations +
 *     the remote-turn mirror + the appearance push. Takes the QueryClient as
 *     a parameter so tests drive it with a mock client and NO network.
 *
 * OWNERSHIP RULE (one place only): ALL react-query refetch side-effects of
 * the events stream live in handleEventsFrame — stream-store's
 * ingestRemoteFrame stays a pure state mirror. The own-stream paths keep
 * their existing invalidations (a device rendering its own turn is the
 * initiator and owns its refetch); duplicate invalidation is a cheap no-op
 * for react-query.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useConfigStore } from "./config-store";
import type { StreamTurnEvent } from "./api";
import { useStreamStore } from "./stream-store";
import { useActiveStreams } from "./active-streams";
import { applyServerAppearance } from "./theme-store";
// R115-E2: the device-created session's navigation bridge (the store the
// AppShell-mounted EventStreamStarter consumes with useNavigate) + the
// local-toast surface for the busy guard (the update-checker precedent).
import { useSessionNavStore } from "./session-nav-store";
import { pushLocalToast } from "../hooks/use-notifications";

// ── The wire shapes (mirrored from agent-core/src/lib/events-bus.ts) ─────────

/** One frame off the events stream. `turn.frame` is untyped on the wire —
 * the bus publishes the exact StreamTurnEvent the initiating socket
 * received, but a defensive shape-check happens at dispatch (below). */
export type EventsStreamFrame =
  | { type: "hello" }
  | {
      type: "session";
      sessionId: string;
      projectId: string | null;
      kind: "event" | "status" | "created" | "meta";
      seq?: number;
      status?: string;
      /** R115-E2 (agent-core events-bus.ts): present ONLY on kind:"created"
       * frames whose POST /sessions rode a device token — "device" (the
       * phone minted the session). Absent on every shell/CLI/agent creation
       * (strictly additive — the pre-R115 wire keeps its exact shape). */
      source?: "device";
      /** ROUND-114 (R114-e, the R114-b wire): meta frames only — the
       * session's NEW operating mode, present only on a permissionMode
       * change. */
      permissionMode?: string;
      /** R114-e: the NEW task-posture id (null = cleared), present only on
       * an activeMode change. */
      activeMode?: string | null;
      /** R114-e: the NEW selected-model pair (null = cleared back to the
       * agent default), present only on a selectedModel change. Absent
       * keys stay absent on the wire — a field this change did not touch
       * never rides as undefined. */
      selectedModel?: { providerId: string; model: string } | null;
    }
  | { type: "turn"; sessionId: string; frame: unknown }
  | { type: "project"; projectId: string; kind: "created" | "updated" | "deleted" }
  | { type: "settings"; domain: string; value: unknown };

// ── The pure parser ──────────────────────────────────────────────────────────

/**
 * ONE SSE line → one frame. Returns null for everything that is not a
 * `data: {json}` frame: the `: ping` heartbeat comments, blank separators,
 * unknown event fields, and payloads that fail JSON.parse (the same
 * skip-malformed-frame guard every reader in this codebase carries — a
 * partial write must never kill the stream). Pure on purpose: the mobile
 * port (R113-e) and the tests below consume it without a transport.
 */
export function parseEventsFrameLine(line: string): EventsStreamFrame | null {
  if (!line.startsWith("data: ")) return null;
  try {
    return JSON.parse(line.slice(6)) as EventsStreamFrame;
  } catch {
    return null;
  }
}

// ── The transport ────────────────────────────────────────────────────────────

/**
 * Live SSE subscription: GET /api/v1/events/stream with the bearer token in
 * the Authorization header. Held open until `signal` aborts or the server
 * closes the stream; every parsed frame fires `onFrame`. Throws on non-2xx
 * (so the caller's reconnect loop can retry after backoff) and on reader
 * errors; a normal server-side close returns cleanly (the caller still
 * reconnects — the sidecar probably restarted).
 *
 * The reader loop is the VERBATIM streamNotifications pattern
 * (notifications-api.ts:180-221): getReader() + TextDecoder + `\n\n` split;
 * each frame's payload is a single `data: {json}` line; `: ping` comment
 * heartbeats fall out of the parser as nulls.
 */
export async function openEventsStream(
  onFrame: (frame: EventsStreamFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = useConfigStore.getState();
  const res = await fetch(`${baseUrl}/api/v1/events/stream`, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  });
  if (!res.ok || !res.body) {
    // Non-2xx: surface as a thrown error so the caller's reconnect loop can
    // retry after backoff.
    throw new Error(`events stream failed with HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        const frame = parseEventsFrameLine(line);
        if (frame !== null) onFrame(frame);
      }
      sep = buffer.indexOf("\n\n");
    }
  }
}

// ── The dispatch (queryClient as a parameter — no singleton capture) ─────────

/**
 * Debounce window for `session` frames (ms). A streaming turn appends log
 * rows continuously (every tool result, every text event → a session frame),
 * and status flips bracket the turn — collapsing the burst into ONE
 * trailing refetch keeps the events stream from machine-gunning
 * invalidateQueries at per-token speed. 300ms: long enough to swallow a
 * fast tool loop's frames, short enough that a turn's START (status flip →
 * the sidebar spinner + "running" row) still feels instant.
 */
const SESSION_INVALIDATE_DEBOUNCE_MS = 300;

/** The module-level debounce timer (one for the whole stream — the frames
 * all collapse into the same invalidation set regardless of session). */
let sessionInvalidateTimer: ReturnType<typeof setTimeout> | undefined;

/** Test hook: drop a pending debounced invalidation (between test cases the
 * captured QueryClient would otherwise fire into a detached client). */
export function resetEventsStreamStateForTest(): void {
  if (sessionInvalidateTimer !== undefined) {
    clearTimeout(sessionInvalidateTimer);
    sessionInvalidateTimer = undefined;
  }
}

/** Schedule the debounced session-list/detail refetch. */
function scheduleSessionInvalidation(qc: QueryClient): void {
  if (sessionInvalidateTimer !== undefined) clearTimeout(sessionInvalidateTimer);
  sessionInvalidateTimer = setTimeout(() => {
    sessionInvalidateTimer = undefined;
    // ["session"] is the PREFIX of the detail key ["session", source, id]
    // (hooks/use-sessions.ts) — one prefix invalidation covers every
    // mounted session view; ["sessions"] refreshes the sidebar's list (its
    // status:"running" rows + auto-renamed titles).
    void qc.invalidateQueries({ queryKey: ["session"] });
    void qc.invalidateQueries({ queryKey: ["sessions"] });
  }, SESSION_INVALIDATE_DEBOUNCE_MS);
}

/**
 * A `turn` frame's terminal verdict (the exact terminal StreamTurnEvent
 * types — api.ts's union): the server's own word that the turn is over.
 * Terminal frames ALSO refetch the folded log (the mirror retires; the
 * event log becomes truth), the usage ledger and the context meter — the
 * same set the own-stream finally invalidates.
 */
function isTerminalTurnFrame(frame: unknown): frame is
  | { type: "done" }
  | { type: "error" }
  | { type: "stopped" } {
  return (
    typeof frame === "object" &&
    frame !== null &&
    ((frame as { type: unknown }).type === "done" ||
      (frame as { type: unknown }).type === "error" ||
      (frame as { type: unknown }).type === "stopped")
  );
}

/**
 * The settings-domain → query-key table. The settings tabs each own a
 * domain-scoped key (NOT a shared ["settings"] prefix — first array elements
 * differ), so a pushed PUT must invalidate the domain's OWN key to land on
 * an open tab. An unknown domain (future sidecar) falls back to the literal
 * ["settings"] prefix — harmless, and correct the day a query actually
 * carries it.
 */
const SETTINGS_DOMAIN_QUERY_KEYS: Record<string, readonly (readonly unknown[])[]> = {
  orchestration: [["orchestration-settings"]],
  memory: [["memory-settings"]],
  debug: [["debug-settings"]],
  // R122: the self-feedback domain — the toggle AND the ledger file
  // viewer (a settings-domain frame fires on every PUT and on every
  // ledger append/clear, so an open Self-Feedback tab live-refreshes
  // both cards — the R113 invalidation pattern applied to the file).
  feedback: [["feedback-settings"], ["feedback-file"]],
  retry: [["retry-settings"]],
  "thinking-loop": [["thinking-loop-settings"]],
  browser: [["browser-settings"]],
  "desktop-notifications": [["desktop-notifications-settings"]],
  "device-link": [["device-link-settings"], ["mobile-link-info"]],
  "cloud-connector": [["cloud-connector-settings"]],
  // R114-e: the vision tab's model lists ride the SHARED ["models-configured"]
  // cache now (["vision-model-rows"] retired with the per-provider fetch
  // sweep) — a pushed vision-domain PUT refreshes it alongside the settings.
  vision: [["vision-settings"], ["vision-key"], ["models-configured"]],
};

/**
 * The frame dispatcher — the ONE place the events stream touches react-query.
 * Pure-ish by design: every side-effect routes through the passed
 * QueryClient / the theme store / the stream store, so tests (and the R113-e
 * mobile port's own dispatcher) can verify the full fan-out without a
 * sidecar.
 *
 *   hello    → the resync: sessions + projects + session details + settings
 *              all refetch (whatever landed between the last received frame
 *              and this reconnect is caught by exactly this sweep).
 *   session  → DEBOUNCED session-detail + session-list invalidation (the
 *              sidebar's status/running rows + the open panel's folded log
 *              converge without a per-token refetch storm); kind:"created"
 *              additionally refreshes the projects list (a new session may
 *              belong to a project the client doesn't know yet).
 *              ROUND-115 (R115-E2): kind:"created" + source:"device" (the
 *              phone minted the session) ALSO routes the desktop to the
 *              new chat — via the session-nav store when idle, or a linked
 *              local toast ("New session from your phone", the Toaster's
 *              actionable R99-C idiom) when a turn is streaming here.
 *              ROUND-114 (R114-e): kind:"meta" skips the debounce ENTIRELY —
 *              a preference patch (permissionMode / activeMode /
 *              selectedModel) is ONE tiny row write, never a per-token
 *              burst, and the phone's model pick should flip the desktop's
 *              composer display the moment the frame lands (the debounced
 *              path would eat up to 300ms for no dedupe value).
 *   turn     → stream-store.ingestRemoteFrame (the live mirror — IGNORED
 *              while this device's own stream renders the same turn).
 *              Terminal frames ALSO invalidate the folded log + usage +
 *              context meter: the mirror retires, the event log is truth.
 *              R114-e: turn.started opens the mirror INSTANTLY with the user
 *              text + resolved model (see stream-store).
 *   project  → the projects list (a new project appears in the sidebar).
 *   settings → "appearance" applies straight into the theme store (the
 *              palette shifts live; the echo guard there suppresses the
 *              write-back PUT); any other domain invalidates its tab's
 *              query so an open Settings page converges immediately.
 */
export function handleEventsFrame(qc: QueryClient, frame: EventsStreamFrame): void {
  switch (frame.type) {
    case "hello": {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
      return;
    }
    case "session": {
      // R114-e: a META frame is a preference patch (mode / posture / model)
      // written at a storage choke point — one tiny row, never a burst.
      // Refetch the session views IMMEDIATELY: the composer's model display
      // seeds from session.selectedModel (AgentChatPanel), so a phone-side
      // pick flips the desktop's pill the moment this frame lands, and the
      // 300ms debounce would only add latency with zero dedupe value.
      // ["session"] is the PREFIX of the detail key ["session", source, id]
      // (hooks/use-sessions.ts); ["sessions"] refreshes the list rows the
      // sidebar + this panel's session picker read.
      if (frame.kind === "meta") {
        void qc.invalidateQueries({ queryKey: ["session"] });
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        return;
      }
      scheduleSessionInvalidation(qc);
      if (frame.kind === "created") {
        // A new session row (POST /sessions, a delegation child, a fork) —
        // its project may itself be new to this client.
        void qc.invalidateQueries({ queryKey: ["projects"] });
        // R115-E2 (E2b): THE PHONE'S HAND — a created frame sourced from a
        // device token. After the invalidations, route the desktop to the
        // new chat (the Toaster openSession URL shape, verbatim). GUARD:
        // only when NO turn is streaming here (useActiveStreams — own
        // stream or remote mirror, either way the screen is busy); a busy
        // desktop gets the linked local toast instead (click = the Open
        // action; the toast stays until dismissed — the R99-C idiom).
        // projectId null = nowhere to route (the chat route is
        // project-scoped) — the invalidations above are the whole story.
        if (frame.source === "device" && frame.projectId !== null) {
          const url = `/project/${encodeURIComponent(frame.projectId)}/chat?session=${encodeURIComponent(frame.sessionId)}`;
          if (useActiveStreams.getState().active.size > 0) {
            pushLocalToast("New session from your phone", "Tap to open it.", "task_complete", url);
          } else {
            useSessionNavStore.getState().requestNav(url);
          }
        }
      }
      return;
    }
    case "turn": {
      // Defensive shape-check: the wire field is untyped by contract; a
      // frame without a string type is a malformed mirror, never a guess.
      if (
        typeof frame.frame !== "object" ||
        frame.frame === null ||
        typeof (frame.frame as { type?: unknown }).type !== "string"
      ) {
        return;
      }
      useStreamStore
        .getState()
        .ingestRemoteFrame(frame.sessionId, frame.frame as StreamTurnEvent);
      if (isTerminalTurnFrame(frame.frame)) {
        // The folded log becomes truth (the mirror retires after a beat):
        // the same terminal set the own-stream finally invalidates — minus
        // ["subagents"], which the mirrored subagent-status frames already
        // invalidate per-parent as they land.
        void qc.invalidateQueries({ queryKey: ["session"] });
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        void qc.invalidateQueries({ queryKey: ["usage"] });
        void qc.invalidateQueries({ queryKey: ["session-context"] });
      }
      return;
    }
    case "project": {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      return;
    }
    case "settings": {
      if (frame.domain === "appearance") {
        // Live theme sync — applies through the theme store (which guards
        // against echoing the PUT back). No query to invalidate: the
        // appearance state IS the store, and the Settings tab renders from
        // it reactively.
        applyServerAppearance(frame.value);
        return;
      }
      const keys = SETTINGS_DOMAIN_QUERY_KEYS[frame.domain];
      if (keys !== undefined) {
        for (const key of keys) {
          void qc.invalidateQueries({ queryKey: [...key] });
        }
      } else {
        // Unknown domain (a future sidecar's new settings surface): the
        // literal ["settings"] prefix — a no-op today, correct the day a
        // query actually carries the key.
        void qc.invalidateQueries({ queryKey: ["settings"] });
      }
      return;
    }
  }
}
