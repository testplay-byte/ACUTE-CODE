// ─────────────────────────────────────────────────────────────────────────────
// R113-a: the EVENT STREAM domain — GET /api/v1/events/stream, the watcher's
// single live channel (the backend event fan-out round).
//
// WHY this route exists: turn deltas previously rode ONLY the initiating
// client's own SSE response (routes/sse.ts), and GET /notifications/stream
// carried only end-of-turn toasts — so the phone could start a turn the
// desktop watched as a FROZEN transcript (and vice versa: no live
// transcript, no thinking indicator, no settings/theme propagation). This
// route subscribes ONE response to the process-wide events bus
// (lib/events-bus.ts) and mirrors EVERY frame: session log appends, status
// flips, session creations, the live turn stream (every frame the
// initiating socket receives), project creations, and settings PUTs.
//
// Wire (the full EventsBusFrame contract lives in lib/events-bus.ts):
//   data: {"type":"hello"}                      — once, immediately on open
//   data: {"type":"session",…}                  — kind event|status|created
//   data: {"type":"turn","sessionId","frame"}   — the live turn mirror
//   data: {"type":"project","projectId","kind"} — created (updated: future)
//   data: {"type":"settings","domain","value"}  — every settings domain PUT
//   : ping                                      — comment heartbeat, 10 s
//
// The GET /notifications/stream pattern verbatim (server.ts ~2020): the
// hijacked reply + raw writeHead (the ROUND-30 lesson — reply.header() is
// dropped after hijack, CORS must ride writeHead), the immediate hello
// frame, the R112-a 10 s comment heartbeat (an idle stream otherwise gets
// reaped by every NAT/proxy/Wi-Fi power-save in the path — the owner's
// R110 disconnect-loop root cause #1), and the close-handler teardown
// (heartbeat + bus subscription die with the socket).
//
// AUTH: the app-level bearer wall like every route in this scope — the
// SHELL token (desktop) and paired DEVICE tokens (phone) both pass. The
// device-token blocklist does NOT include this path (it must not: the
// phone reaches the sidecar through the acute-relay cloud relay, whose
// guest allowlist permits /health and /api/* only — this route IS the
// phone's live view of turns the desktop starts). EventSource cannot set
// an Authorization header, so clients use the same fetch + ReadableStream
// pattern the notifications stream already requires.
//
// v1 FILTERING RULE: NO server-side session filtering. One global channel;
// every connected client filters frames by sessionId LOCALLY (the bus
// already scopes every frame). Deliberate: per-session server-side filters
// would multiply subscriptions and complicate reconnect semantics for zero
// privacy gain on a single-owner sidecar — revisit only if a multi-user
// surface ever appears.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { getEventsBus } from "../lib/events-bus.js";

export function registerEventsRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { corsHeadersFor } = ctx;

  scope.get("/events/stream", async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...corsHeadersFor(request.headers.origin),
    });
    // ── ROUND-117 (R117-e): the WRITE GUARD ─────────────────────────────
    // The subscriber's res.write was previously unguarded: a destroyed
    // socket (the watcher's window killed mid-frame) THREW inside the bus
    // subscriber — the bus's publish try/catch swallowed it, but the
    // subscription + heartbeat survived, so every later frame re-threw and
    // stderr collected the same dead-socket error forever. This is the
    // sse.ts send() idiom (~230-235) applied here: a failing or
    // already-ended write marks the stream dead, tears the heartbeat + bus
    // subscription down IMMEDIATELY (the socket may never emit 'close' —
    // the R112-a lesson), and the close handler stays as the normal-path
    // cleanup. The bus's try/catch remains the belt (events-bus.ts publish).
    let socketDead = false;
    // Assigned immediately after their declarations below — every guarded
    // write happens strictly after (bus frames + timer ticks are async).
    let unsubscribe: () => void = () => {};
    // R117-e lint-fix: the heartbeat timer is a single-assignment const
    // declared at its assignment site below; stopWriting closes over it
    // (only ever invoked after initialization).
    const heartbeatRef: { current: ReturnType<typeof setInterval> | undefined } = { current: undefined };
    const stopWriting = (): void => {
      socketDead = true;
      if (heartbeatRef.current !== undefined) clearInterval(heartbeatRef.current);
      unsubscribe();
    };
    const guardedWrite = (chunk: string): void => {
      if (socketDead) return;
      if (res.writableEnded || res.destroyed) {
        stopWriting();
        return;
      }
      try {
        res.write(chunk);
      } catch {
        // The socket died mid-write — the sse.ts send() idiom: stop writing,
        // drop the subscription, let the close handler finish the teardown.
        stopWriting();
      }
    };
    // The hello frame — live-batteries the stream the instant the route
    // runs (writeHead alone assigns headers; nothing reaches the socket
    // until the first write) and tells the client the channel is open.
    // Semantics for clients: "resync everything" — refetch your state, then
    // follow the frames (the reconnect contract: whatever landed between
    // the last received frame and the hello is caught by that refetch).
    // R117-e: also guarded — a socket that died between the request and the
    // first byte has nothing to stream and nothing to clean yet.
    try {
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    } catch {
      return;
    }
    unsubscribe = getEventsBus().subscribe((frame) => {
      guardedWrite(`data: ${JSON.stringify(frame)}\n\n`);
    });
    // R112-a pattern: the 10 s comment heartbeat — SSE-legal no-op frames
    // that keep NAT/proxy/Wi-Fi power-save from reaping the idle stream.
    // R117-e: rides the SAME guard — a failing ping write tears down exactly
    // like a failing frame write (one dead socket, one teardown).
    const heartbeat: ReturnType<typeof setInterval> = setInterval(() => {
      guardedWrite(": ping\n\n");
    }, 10_000);
    heartbeatRef.current = heartbeat;
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    // Hold the reply open until the client disconnects. Fastify's hijack
    // means we never call reply.send; the SSE stream lives until close.
  });
}
