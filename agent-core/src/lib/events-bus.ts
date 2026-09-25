/**
 * ROUND-113 (R113-a): the in-process EVENT fan-out bus — the "this session
 * just changed" channel the notification bus deliberately is NOT.
 *
 * WHY a second bus: the owner's live test (phone → backend → turn runs, but
 * NOTHING updates on the other device) pinned the root cause — turn deltas
 * ride ONLY the initiating client's own SSE response, and notification-bus
 * only carries end-of-turn toasts (task_complete/task_failed/permission_*
 * /subagent_*). No event ever said "a session you are looking at changed",
 * so the desktop and the phone each saw a frozen world unless they were the
 * one driving the turn.
 *
 * This module is the additive foundation: ONE process-wide pub/sub whose
 * frames are mirrored verbatim to every connected watcher by GET
 * /api/v1/events/stream (routes/events.ts). Publish points (each chosen at
 * its single choke point — see the call sites):
 *   - storage/sessions.ts appendSessionEvent → {type:"session", kind:"event"}
 *   - storage/sessions.ts setSessionStatus   → {type:"session", kind:"status"}
 *   - storage/sessions.ts createSession/forkSession → {type:"session", kind:"created"}
 *   - storage/sessions.ts updateSessionPermissionMode / updateSessionActiveMode
 *     / setSessionSelectedModel → {type:"session", kind:"meta"} (R114-b —
 *     the mode/model live-sync tier: a watcher learns the session's
 *     operating mode, task posture, or selected model changed the MOMENT
 *     the durable row lands, instead of on the next unrelated refetch)
 *   - routes/sse.ts send()                   → {type:"turn"} (the LIVE mirror
 *     of EVERY frame the initiating socket receives — text-delta, tool-*,
 *     meta.*, turn.started, user.queued, error, done, stopped, debug-*,
 *     subagent-status…)
 *   - routes/projects.ts POST /projects      → {type:"project"}
 *   - routes/projects.ts DELETE /projects/:id → {type:"project", kind:"deleted"}
 *     (R128-W3 — the delete announcement; watchers refresh their lists)
 *   - routes/settings.ts every domain PUT    → {type:"settings"}
 *
 * Differences from notification-bus (kept COMPLETELY untouched — the phone
 * and desktop already consume it; this is additive, never a replacement):
 *   - pure in-memory: no SQLite write rides publish (the events it mirrors
 *     are ALREADY durable — session log rows, settings rows — the bus only
 *     announces them; notifications are their own durable rows).
 *   - fire-and-forget by construction: publish never throws into the caller
 *     (a turn, a route, a storage helper) — subscriber calls are wrapped in
 *     try/catch and logged, exactly the notification-bus contract.
 *
 * v1 filtering rule: the bus carries EVERYTHING and the SSE route applies
 * NO server-side session filter — clients filter by sessionId locally (see
 * the comment on the route). Frame volume is bounded by what one sidecar
 * process actually does.
 */
export type EventsBusFrame =
  // Sent once per SSE connection open (routes/events.ts synthesizes it —
  // it is never published ON the bus; the type rides here so the whole wire
  // contract lives in ONE place). Semantics for clients: "resync everything"
  // — a fresh/reconnected watcher refetches its state, then follows frames.
  | { type: "hello" }
  // A session-scoped change. kind:
  //   "event"  — a row was appended to the append-only session log (seq =
  //              the new row's seq; a watcher refetches GET
  //              /sessions/:id/events and folds from its last seen seq).
  //   "status" — session.status flipped (e.g. queued→running at turn start,
  //              running→queued at turn end; status = the NEW value).
  //   "created"— a new session exists (POST /sessions, a delegation child,
  //              a fork) — watchers refresh their session lists.
  //              ROUND-115 (R115-E2): a session created by a request that
  //              authenticated with a DEVICE token (the phone minted it
  //              through POST /sessions) carries source:"device" — the
  //              desktop's events-stream dispatcher routes the user to the
  //              new chat instead of only refreshing the list. Absent on
  //              every shell/CLI/agent-created session (additive; old
  //              clients ignore the unknown field).
  //   "meta"   — ROUND-114 (R114-b): a session-level PREFERENCE changed —
  //              the operating mode (permissionMode), the task posture
  //              (activeMode), and/or the selected model (selectedModel).
  //              One frame per change, written at the storage choke point
  //              the durable row lands through (updateSessionPermissionMode
  //              / updateSessionActiveMode / setSessionSelectedModel), so
  //              the phone + desktop never silently disagree: whichever
  //              field(s) changed ride the frame; a field is ABSENT when
  //              this change did not touch it (never undefined — the wire
  //              stays JSON-clean). Watchers refetch the session row (or
  //              apply the carried value directly — it IS the new truth).
  | {
      type: "session";
      sessionId: string;
      projectId: string | null;
      kind: "event" | "status" | "created" | "meta";
      seq?: number;
      status?: string;
      /** R115-E2: present ONLY on kind:"created" frames whose POST /sessions
       *       rode a device token — "device" (the phone's hand). Absent on
       *       every other creation (shell, CLI, delegation children, forks). */
      source?: "device";
      /** R114-b: the session's NEW operating mode ("full"|"ask"|"plan"),
       *       present only on a permissionMode change. */
      permissionMode?: string;
      /** R114-b: the session's NEW task-posture id (null = cleared back to
       *       the default posture), present only on an activeMode change. */
      activeMode?: string | null;
      /** R114-b: the session's NEW selected model pair (null = cleared back
       *       to the agent default), present only on a selectedModel change. */
      selectedModel?: { providerId: string; model: string } | null;
    }
  // The LIVE turn mirror: `frame` is the EXACT StreamTurnEvent the
  // initiating client's SSE socket received (published pre-serialization).
  // This is what lets the desktop watch a turn the phone started — or the
  // phone watch one the CLI started — with the same delta stream.
  | { type: "turn"; sessionId: string; frame: unknown }
  // A project row was created or deleted (updated reserved for future
  // PATCH surfaces — no project-update route exists today). R128-W3 adds
  // "deleted": DELETE /projects/:id announces it after its cascade commits.
  | { type: "project"; projectId: string; kind: "created" | "updated" | "deleted" }
  // A settings domain was PUT (value = the persisted settings object as the
  // domain's GET serves it — secrets NEVER ride this frame; the
  // cloud-connector domain broadcasts hostKeyPresent, not the key).
  | { type: "settings"; domain: string; value: unknown };

type Subscriber = (frame: EventsBusFrame) => void;

class EventsBus {
  private readonly subscribers = new Set<Subscriber>();

  /** Register a live subscriber. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * The ONE egress: fan a frame to every live subscriber. Subscriber errors
   * are logged + skipped — a watcher's dead socket must never propagate into
   * a turn, a route, or a storage helper (the notification-bus contract,
   * verbatim). stderr for the same reason: the structured logger would make
   * this module import-heavy for a leaf that everything else imports.
   */
  private publish(frame: EventsBusFrame): void {
    for (const fn of this.subscribers) {
      try {
        fn(frame);
      } catch (err) {
        // A subscriber error must never propagate into the publisher.
        console.error("[events-bus] subscriber threw:", err);
      }
    }
  }

  /** A session-scoped change (log append / status flip / creation).
   * R115-E2: details.source rides ONLY device-token creations (see the
   * frame type above) — absent keys stay absent on the wire. */
  publishSessionFrame(
    sessionId: string,
    projectId: string | null,
    kind: "event" | "status" | "created",
    details: { seq?: number; status?: string; source?: "device" } = {},
  ): void {
    this.publish({
      type: "session",
      sessionId,
      projectId,
      kind,
      ...(details.seq !== undefined ? { seq: details.seq } : {}),
      ...(details.status !== undefined ? { status: details.status } : {}),
      ...(details.source !== undefined ? { source: details.source } : {}),
    });
  }

  /** ROUND-114 (R114-b): a session-level PREFERENCE changed (operating
   * mode / task posture / selected model). Only the field(s) this change
   * touched ride the frame — absent keys stay absent on the wire (the
   * JSON round-trip contract every other frame follows). */
  publishSessionMetaFrame(
    sessionId: string,
    projectId: string | null,
    changed:
      | { permissionMode: string }
      | { activeMode: string | null }
      | { selectedModel: { providerId: string; model: string } | null },
  ): void {
    this.publish({
      type: "session",
      sessionId,
      projectId,
      kind: "meta",
      ...("permissionMode" in changed ? { permissionMode: changed.permissionMode } : {}),
      ...("activeMode" in changed ? { activeMode: changed.activeMode } : {}),
      ...("selectedModel" in changed ? { selectedModel: changed.selectedModel } : {}),
    });
  }

  /** Mirror one frame of a live streamed turn to every watcher. */
  publishTurnFrame(sessionId: string, frame: unknown): void {
    this.publish({ type: "turn", sessionId, frame });
  }

  /** A project row was created, updated (when such a route exists), or
   * deleted (R128-W3 — the cascade delete's announcement). */
  publishProjectFrame(projectId: string, kind: "created" | "updated" | "deleted"): void {
    this.publish({ type: "project", projectId, kind });
  }

  /** A settings domain was PUT — value is the persisted settings object. */
  publishSettingsFrame(domain: string, value: unknown): void {
    this.publish({ type: "settings", domain, value });
  }
}

let bus: EventsBus | null = null;

/** Process-wide singleton (one sidecar = one bus; tests share it per file). */
export function getEventsBus(): EventsBus {
  if (bus === null) bus = new EventsBus();
  return bus;
}
