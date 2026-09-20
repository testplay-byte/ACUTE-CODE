// ─────────────────────────────────────────────────────────────────────────────
// R86: the SSE domain — the streamed turn route (POST /sessions/:id/messages/
// stream), the final-phase extraction of the R84 server.ts split.
//
// Registers, in the original server.ts registration order: the ONE streamed
// turn route (round-16 lineage) — the hardest concurrency logic in the HTTP
// layer: the R42 client-gone semantics (a closed window does NOT abort the
// turn — only POST /sessions/:id/stop does), the R78 queue-continuation loop
// (capped at 25 continuations; each consumed queued message runs another full
// turn on the SAME still-open stream, adopting its own R82 model/provider
// override), the R66-2-c post-turn DEBUG ANALYST phase (a context-free model
// call streaming debug-start/delta/done frames before the terminal frame,
// metering its own R83 usage row), and the R43+R80 crash recovery (an
// unexpected route crash persists turn.error + notifies + still terminates
// the stream honestly).
//
// Provenance: extracted verbatim from server.ts in R86 — behavior-identical,
// test-guarded (the r58/r78/r80/r82/composer-attachments suites + the sidecar
// e2e drive this route through buildServer). The sync twin (POST
// /sessions/:id/messages) lives in routes/sessions.ts; the queue REST route
// (POST /sessions/:id/queue) rides this stream's turn registration via
// notifyTurn.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { MessageAttachment } from "shared";
import {
  persistTurnError,
  runStreamedAgentTurn,
  type TurnModelOverride,
} from "../agents/runtime.js";
// ROUND-66 (R66-2-c, C1): the post-turn CONTEXT-FREE DEBUG ANALYST — a
// fresh model call (no tools, no history of its own) that receives the
// session's whole transcript and streams its report back over the SAME
// still-open SSE before the turn's terminal frame.
import { runDebugAnalyst } from "../agents/debug-analyst.js";
import { streamAiSdkChat } from "../agents/chat.js";
import { resolveProvider } from "../providers/registry.js";
import { getAgent } from "../storage/agents.js";
import {
  appendSessionEvent,
  deleteQueuedMessage,
  deliverQueuedMessage,
  getSession,
  listSessionEvents,
  listUndeliveredQueuedMessages,
  recordUsage,
} from "../storage/sessions.js";
import {
  getDebugSettings,
  getRetrySettings,
} from "../storage/settings.js";
import { lookupPricing } from "../storage/models.js";
import { getNotificationBus } from "../lib/notification-bus.js";
// R113-a: the events-bus mirror — every frame this route sends to the
// INITIATING socket is also published to every watcher on
// GET /api/v1/events/stream (see the send() wrapper below).
import { getEventsBus } from "../lib/events-bus.js";
// ROUND-80 (R80): the customizable retry schedule — resolved from the
// settings for the task_failed notification's schedule line.
import { describeRetrySchedule, resolveRetrySchedule } from "../lib/retry.js";
// ROUND-52 (R52-b): the SHARED live-turn registry — powers POST
// /sessions/:id/stop (the UI Stop button); the route's `send` registers as
// the turn's notifier so the queue route's user.queued frames land on this
// still-open stream.
// R107-b (F1): the CONCURRENT-TURN GATE reads it too — a second send while
// a turn is live 409s instead of REPLACING the live entry (the
// "registerTurn replaces a live entry" hazard the R107-b review pinned:
// with three consumers on one session — desktop, CLI, mobile — a second
// send used to interleave event writes and orphan the first turn's
// AbortController, making Stop miss it).
import {
  getTurnController,
  registerTurn,
  unregisterTurn,
} from "../lib/turn-registry.js";
import { readComposerSendFields, readOverrideProviderId } from "./sessions.js";
import type { RouteContext } from "./context.js";
import { errorBody } from "./helpers.js";

export function registerSseRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db, keyring, chat, corsHeadersFor } = ctx;
  // STREAMED turn (round-16): same validation + persistence as the sync
  // route, but Server-Sent Events stream out live: {type:'text-delta'},
  // {type:'tool-call'}, {type:'tool-result'}, {type:'finish'} and a
  // terminal {type:'done'|'error'} envelope. Client disconnects (closed
  // tab / stop) abort the provider call via AbortSignal.
  //
  // ROUND-42 (owner: "I sent another message and this time I closed the
  // window so it should send me a notification after it has completed the
  // task"): a client disconnect NO LONGER aborts the turn. The turn runs
  // to completion in the background (events keep persisting to SQLite,
  // the completion notification fires, and Web Push delivers it to the
  // closed window's service worker). Only an explicit POST
  // /sessions/:id/stop (the UI's Stop button) aborts. Live SSE frames
  // are skipped once the client is gone — writing to a destroyed socket
  // would throw.
  scope.post("/sessions/:id/messages/stream", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    const content = raw.content;
    if (typeof content !== "string" || content.trim() === "") {
      return reply.code(400).send(
        errorBody("VALIDATION", "content must be a non-empty string", {
          field: "body.content",
        }),
      );
    }
    const modelOverride =
      typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : undefined;
    // ROUND-82: the send's provider (see the sync route's comment — the
    // same validation, shared by both routes).
    const overrideProviderId = readOverrideProviderId(db, raw);
    if (overrideProviderId.error !== undefined) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", overrideProviderId.error, { field: "body.providerId" }));
    }
    const turnModelOverride =
      modelOverride === undefined
        ? undefined
        : { model: modelOverride, ...(overrideProviderId.value !== undefined ? { providerId: overrideProviderId.value } : {}) };
    // ROUND-82 (R82): the CURRENT turn's override for the queue-
    // continuation loop — starts as the original send's; each
    // continuation adopts the consumed queued message's OWN override
    // (the picker state when it was queued) when it carries one, else
    // keeps the running override (the pre-R82 behavior was to drop the
    // override entirely and fall back to the agent default). Declared
    // OUTSIDE the try so the debug-analyst phase below reads the LAST
    // turn's override (it mirrors the provider that actually served the
    // stream's final turn).
    let currentModelOverride: TurnModelOverride | undefined = turnModelOverride;
    // ROUND-50 (R50-c1): the composer's per-send fields (same validation
    // as the sync route — see the comment there).
    const composer = readComposerSendFields(raw, reply);
    if (!composer.ok) return reply;

    // ── R107-b (F1): the CONCURRENT-TURN GATE. A second send while a turn
    // is LIVE on this session (registered in the shared turn registry by
    // this route, the sync route, or an orchestrated child turn) is a 409,
    // not a parallel turn. Pre-gate, registerTurn below REPLACED the live
    // entry: both turns then interleaved writes into ONE event log and the
    // FIRST turn's AbortController was dropped — POST /stop could never
    // reach it (prepareTurn only refuses TERMINAL statuses, so a `running`
    // session happily started the parallel turn). The designed mid-turn
    // path is the QUEUE: POST /sessions/:id/queue rides the live stream
    // (loop-top + turn-end delivery own it).
    // Placement: after body validation (an invalid body still gets its
    // honest 400) and BEFORE reply.hijack()/registerTurn — everything from
    // here to registerTurn is synchronous on the single Node thread, so no
    // second request can interleave the check-and-register pair. The
    // route's OWN queue-continuation loop never re-enters here (one
    // registration spans the whole loop), so continuations are unaffected.
    if (getTurnController(id) !== undefined) {
      return reply.code(409).send(
        errorBody(
          "CONFLICT",
          `a turn is already in flight for session ${id} — queue the message instead (POST /sessions/${id}/queue), or stop the running turn first (POST /sessions/${id}/stop)`,
          { field: "session" },
        ),
      );
    }

    reply.hijack();
    const res = reply.raw;
    // ROUND-30 FIX (owner Windows bug "Failed to fetch" after every
    // message): headers set via reply.header() in the onRequest hook are
    // dropped once the reply is hijacked, so the SSE response previously
    // shipped WITHOUT Access-Control-Allow-Origin — the browser blocked
    // the cross-origin response and fetch() rejected. Write the CORS
    // headers directly into the raw writeHead here.
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...corsHeadersFor(request.headers.origin),
    });
    let clientGone = false;
    // ROUND-112 (R112-a, the R110 disconnect-loop fix #1): the terminal
    // stream's LIVE-BATTERY flush + 10 s comment heartbeat, verbatim (the
    // terminal route's own pattern — server.ts ~985/995). Pre-fix, a turn
    // whose model was slow to first token wrote NOTHING for seconds: every
    // NAT/proxy/Wi-Fi power-save in the path reaped the idle stream and the
    // phone surfaced the dead socket as "disconnected" — the owner's
    // reconnect loop's root cause #1. The leading `: ping` makes the stream
    // live the instant the route runs (writeHead only ASSIGNS headers —
    // nothing reaches the socket until the first write); the interval keeps
    // it alive between events. Comment frames are SSE-legal no-ops.
    try {
      res.write(": ping\n\n");
    } catch {
      clientGone = true;
    }
    const heartbeat = setInterval(() => {
      if (clientGone || res.writableEnded) return;
      try {
        res.write(": ping\n\n");
      } catch {
        clientGone = true;
      }
    }, 10_000);
    res.on("close", () => {
      // ROUND-42: do NOT abort the turn — it completes in the background
      // (the owner closes the window and still expects the task to finish
      // + a desktop notification). Only mark the socket dead so send()
      // stops writing to it. R112-a: the heartbeat dies with the socket.
      clientGone = true;
      clearInterval(heartbeat);
    });
    const send = (event: unknown) => {
      // ── R113-a (the backend event fan-out): mirror EVERY outgoing frame
      // to the events bus BEFORE the clientGone check — deliberately first,
      // so the mirror survives the initiator's socket dying (the R42 rule:
      // a closed window does NOT abort the turn; the desktop UI / phone
      // watching GET /events/stream keep the LIVE transcript, thinking
      // indicator, tool progress — for a turn ANY device started, the CLI
      // included). The notify callback registered below IS this closure, so
      // queue-route user.queued chips ride the mirror automatically. The
      // object is published PRE-serialization (each watcher serializes for
      // itself); fire-and-forget by construction (publish wraps every
      // subscriber in try/catch — a bus failure can never break the stream).
      getEventsBus().publishTurnFrame(id, event);
      if (clientGone) return;
      try {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // The socket died mid-write — treat the client as gone.
        clientGone = true;
      }
    };
    const abort = new AbortController();
    // ROUND-42 → R52-b: registry for POST /sessions/:id/stop (SHARED with
    // the orchestrator's child turns). One live turn per session — the
    // R107-b (F1) gate above guarantees this registration never REPLACES a
    // live entry (the pre-R107 "the runtime refuses concurrent turns
    // anyway" comment was false: prepareTurn only refuses TERMINAL
    // statuses, so a `running` session could start a parallel turn).
    // ROUND-78 (R78): `send` registers as the turn's NOTIFIER — the queue
    // route (POST /sessions/:id/queue) rides notifyTurn so its
    // user.queued frames land on this still-open stream. The single
    // registration spans the WHOLE queue-continuation loop below (one
    // registration per SSE request; the runtime never re-registers).
    registerTurn(id, abort, send);

    // ── ROUND-66 (R66-2-c, owner's C1 directive): the post-turn DEBUG
    // ANALYST phase. When debug mode (Settings → Advanced) is ON and the
    // turn finished on its own (ok, or a real failure — NEVER a
    // deliberate ABORTED stop), a COMPLETELY NEW context-free agent is
    // launched here: it receives the session's WHOLE transcript (user
    // request, every tool call with its COMPLETE result, errors) and
    // streams its analysis live over this still-open SSE as
    // debug-start / debug-delta* / debug-done (or debug-error) frames,
    // BEFORE the turn's own done/error frame — so the frontend renders
    // the dedicated debug section at the bottom of the LIVE turn. On
    // success the report is ALSO persisted as a `debug.report` session
    // event (assembleHistory skips the type — a follow-up user message
    // NEVER includes it; toProjectChatItems folds it into the turn's
    // AssistantTurnItem.debugReport for reloads). A debug failure must
    // NEVER break the turn's own terminal frame — the phase catches
    // everything it can and the route's try/catch below is the
    // belt-and-suspenders guard.
    const runDebugAnalystPhase = async (): Promise<void> => {
      try {
        // (a) The debug setting — the same accessor the /settings/debug
        // routes use (default OFF → this whole phase is a no-op).
        if (getDebugSettings(db).enabled !== true) return;
        // (c) Minimal provider/model resolution for the session — the
        // exact helpers prepareTurn uses (session → agent → provider →
        // keyring key); the model mirrors the TURN's choice (the
        // per-send override when one was sent, else the agent default).
        const session = getSession(db, id);
        if (session === undefined || session.agentId === null) {
          send({ type: "debug-error", sessionId: id, message: "debug analyst: the session or its agent is gone" });
          return;
        }
        const agent = getAgent(db, session.agentId);
        if (agent === undefined || agent.providerId === null || agent.model === null) {
          send({
            type: "debug-error",
            sessionId: id,
            message: "debug analyst: the session's agent has no provider/model configured",
          });
          return;
        }
        // ROUND-82: the debug run mirrors the LAST turn's provider too —
        // an override that named a provider (the custom-model case)
        // debugs against THAT provider, not the agent's
        // (currentModelOverride tracks the queue-continuation loop).
        const debugProviderId =
          typeof currentModelOverride === "object" && currentModelOverride.providerId !== undefined
            ? currentModelOverride.providerId
            : agent.providerId;
        const provider = resolveProvider(db, debugProviderId);
        if (provider === undefined || provider.baseUrl === null) {
          send({
            type: "debug-error",
            sessionId: id,
            message: `debug analyst: provider '${debugProviderId}' is not resolvable`,
          });
          return;
        }
        const apiKey = keyring.get(provider.id);
        if (apiKey === undefined) {
          send({
            type: "debug-error",
            sessionId: id,
            message: `debug analyst: no API key for provider '${provider.id}'`,
          });
          return;
        }
        // ROUND-82: narrow the union (string | {model, providerId}) —
        // a bare-string override means the model alone (pre-R82 wire).
        const debugOverrideModel =
          typeof currentModelOverride === "object"
            ? currentModelOverride.model
            : typeof currentModelOverride === "string"
              ? currentModelOverride
              : undefined;
        const model = debugOverrideModel ?? agent.model;
        // (d) The live marker — the frontend opens the dedicated
        // streaming section (loading animation while the analyst works).
        send({ type: "debug-start", sessionId: id });
        // (e) The analyst itself — streams debug-delta frames through
        // send and never throws (provider failures come back as
        // { ok: false, error } with the API key scrubbed).
        const result = await runDebugAnalyst(
          { db, keyring, chat, chatStream: streamAiSdkChat },
          {
            sessionId: id,
            provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
            apiKey,
            model,
            emit: send,
          },
        );
        if (result.ok) {
          // (f) Persist the report as a `debug.report` session event —
          // UNCONDITIONALLY (a closed window still gets the folded card
          // on reload; only the SSE frames skip when the client is
          // gone). Payload shape: { content, model, ts } + the storage
          // layer's own agentId/ts stamping.
          appendSessionEvent(db, id, {
            type: "debug.report",
            agentId: agent.id,
            payload: { content: result.content, model, ts: new Date().toISOString() },
          });
          send({ type: "debug-done", sessionId: id, content: result.content, model });
          // ROUND-83 (R83): meter the analyst's own spend (origin
          // "debug", agentId null — the audit's §2.12: real provider
          // spend that previously appeared in NO usage surface).
          // Best-effort: a recording failure never fails the phase.
          if (result.usage !== undefined && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)) {
            try {
              const pricing = lookupPricing(db, provider.id, model);
              const inputCost =
                pricing.inputPricePerMtok === null
                  ? 0
                  : (result.usage.inputTokens / 1_000_000) * pricing.inputPricePerMtok;
              const outputCost =
                pricing.outputPricePerMtok === null
                  ? 0
                  : (result.usage.outputTokens / 1_000_000) * pricing.outputPricePerMtok;
              recordUsage(
                db,
                {
                  agentId: null,
                  sessionId: id,
                  provider: provider.id,
                  model,
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  cachedInputTokens: result.usage.cachedInputTokens,
                  costUsd: inputCost + outputCost,
                  ts: new Date().toISOString(),
                },
                0,
                { providerCalls: 1, origin: "debug" },
              );
            } catch {
              // Best-effort accounting — never a debug-phase failure.
            }
          }
        } else {
          send({ type: "debug-error", sessionId: id, message: result.error });
        }
      } catch (error) {
        // The phase's own guard — an unexpected crash in the closure
        // still produces the honest debug-error frame (and nothing else:
        // the turn's terminal frame below is untouched).
        send({
          type: "debug-error",
          sessionId: id,
          message: `debug analyst failed: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 2000),
        });
      }
    };

    try {
      // ── ROUND-78 (R78, owner: "工作中发送消息（排队）… the agent reads
      // it with full context and continues"): the QUEUE-CONTINUATION
      // loop. After a SUCCESSFUL turn, undelivered queued messages
      // CONTINUE THE SAME SSE STREAM: the FIRST queued event is CONSUMED
      // (deleted — its content/attachments become the next
      // runStreamedAgentTurn call's args), the REST are flipped directly
      // to message.user so the continuation turn's iteration 0 history
      // includes them (no queued.delivered frames for these — the folded
      // log the UI refetches owns their render), a
      // meta.queue_continue frame announces the count, and the loop
      // runs another full turn. One registration + one abort controller
      // span the WHOLE loop (a Stop aborts the in-flight continuation
      // — queued messages STAY queued, pre-flipped on the next send).
      // task_complete fires per successful turn; the debug analyst +
      // terminal frame run ONCE, after the loop exits. ABORTED/error
      // break the loop. Capped at MAX_QUEUE_CONTINUATIONS so a
      // queue→turn→queue cycle can never run forever — the honest break
      // closes the stream normally and leaves the rest queued.
      const MAX_QUEUE_CONTINUATIONS = 25;
      let continuations = 0;
      // R93-B2: the ONE recovery attempt. A transient-class failure
      // (network/timeout) with messages waiting in the queue no longer
      // strands the stream — the first queued message drives exactly one
      // automatic continuation ("it would not even try to continue the
      // session" fixed with a hard bound: a second failure strands the
      // queue and reports honestly via queuedKept). Auth/rate_limit/
      // context failures NEVER auto-continue (a dead key or a spent quota
      // would just burn the queued message into the same wall).
      let recoveryAttempted = false;
      let currentContent = content;
      let currentAttachments = composer.value.attachments;
      // ROUND-114 (R114-b): the opening turn.started frame fires ONCE per
      // POST/stream call — the FIRST runStreamedAgentTurn below passes true;
      // queue-continuation turns keep watching through the frames they
      // already have (user.queued chips + meta.queue_continue), so no
      // re-announcement. Flipped false the moment the first call returns
      // into the loop (the outcome branches below `continue` back around).
      let firstStreamedCall = true;
      // ROUND-82: currentModelOverride is declared above the try (the
      // debug-analyst phase reads the LAST turn's override through it).
      // (while(true) — the loop's exits are the outcome branches below;
      // the queue-continue `continue` is the only loop-around.)
      while (true) {
        const outcome = await runStreamedAgentTurn(
          { db, keyring, chat, chatStream: streamAiSdkChat },
          id,
          currentContent,
          send,
          currentModelOverride,
          abort.signal,
          composer.value.thinkingLevel,
          currentAttachments,
          // R114-b: the early live-turn frame (user text + resolved model) —
          // only the POST's own first turn announces itself.
          firstStreamedCall,
        );
        firstStreamedCall = false;
        if (outcome.ok) {
          // ROUND-42: ALWAYS publish task_complete. The R40 didWork gate
          // (only tool-using turns) left the owner's conversational test
          // ("say hello, close the window") silent — a completed reply IS
          // a completed task from the owner's perspective. The in-page
          // Toaster only fires desktop notifications when the page is
          // hidden; the service worker push only fires when no visible
          // window exists — so an on-screen user still isn't spammed.
          // R78: fires per successful turn — continuations included.
          const session = getSession(db, id);
          getNotificationBus().publish(db, {
            kind: "task_complete",
            title: session?.title ?? "Task complete",
            body: outcome.assistantMessage.content.slice(0, 160),
            sessionId: id,
            projectId: session?.projectId ?? undefined,
          });
          // R78: the queue check — continue the same stream when
          // messages are waiting (and the cap is not reached).
          // ROUND-94 (R94-D1): NO double-consumption race with the new
          // mid-turn STEP-BOUNDARY injection — both consumers claim through
          // the SAME storage pair (listUndeliveredQueuedMessages →
          // deleteQueuedMessage, whose type-guarded WHERE clause is the
          // atomic claim; better-sqlite3 is synchronous on the single Node
          // thread, so a list-then-delete can never interleave). A message
          // consumed mid-turn is already DELETED here, so this loop simply
          // finds an empty queue and closes cleanly; only what the
          // boundaries could not reach (queued during the final tail /
          // after the SDK call returned) still arrives here.
          const queued = listUndeliveredQueuedMessages(db, id);
          if (queued.length > 0 && continuations < MAX_QUEUE_CONTINUATIONS) {
            continuations += 1;
            send({ type: "meta.queue_continue", count: queued.length });
            const first = queued[0];
            // CONSUME the first (delete the row — its content becomes
            // the next turn's user message, appended fresh by the
            // runtime; the stream itself is the notifier, so no
            // notifyTurn here).
            deleteQueuedMessage(db, id, first.seq);
            // DELIVER the rest (type-flip) — the continuation turn's
            // iteration 0 history includes them as ordinary user events
            // (the route flips them directly; loop-top delivery is a
            // no-op for these — no queued.delivered frames).
            for (const q of queued.slice(1)) deliverQueuedMessage(db, id, q.seq);
            const firstPayload =
              first.payload !== null && typeof first.payload === "object"
                ? (first.payload as Record<string, unknown>)
                : null;
            currentContent =
              firstPayload !== null && typeof firstPayload.content === "string"
                ? firstPayload.content
                : "";
            currentAttachments =
              firstPayload !== null && Array.isArray(firstPayload.attachments)
                ? (firstPayload.attachments as MessageAttachment[])
                : undefined;
            // ROUND-82 (R82): the consumed entry's OWN override wins for
            // its continuation turn (the user's picker state when the
            // message was queued — fresher intent than the original
            // send's); absent → the running override stays (the original
            // send's).
            const queuedOverrideModel =
              firstPayload !== null && typeof firstPayload.model === "string"
                ? firstPayload.model.trim()
                : "";
            if (queuedOverrideModel !== "") {
              const queuedOverrideProviderId =
                firstPayload !== null && typeof firstPayload.providerId === "string"
                  ? firstPayload.providerId.trim()
                  : "";
              currentModelOverride =
                queuedOverrideProviderId !== ""
                  ? { model: queuedOverrideModel, providerId: queuedOverrideProviderId }
                  : { model: queuedOverrideModel };
            }
            continue;
          }
          // R66-2-c: the debug analyst runs AFTER the outcome handling
          // (the completion notification fires the moment the turn is
          // done) and BEFORE the done frame — the live turn is still open,
          // so the report streams into the dedicated section under the
          // answer while the owner watches. The debug.report event +
          // debug-done frame land before the terminal done frame.
          // R78: once, after the loop's LAST successful turn (queue empty
          // or the cap's honest break — the remaining chips stay queued).
          await runDebugAnalystPhase();
          // R93-B1: the debug-analyst race. The primary queue check above ran
          // BEFORE the analyst — a message queued DURING the analyst's model
          // call (the turn is still registered; POST /queue succeeds) fell in
          // the gap between the check and the done frame and stranded.
          // Re-check AFTER the analyst: anything that arrived in between
          // continues the stream exactly like a normal queued message.
          // (Cost: the analyst may run again on the next exit — debug mode
          // only, rare.)
          const queuedLate = listUndeliveredQueuedMessages(db, id);
          if (queuedLate.length > 0 && continuations < MAX_QUEUE_CONTINUATIONS) {
            continuations += 1;
            send({ type: "meta.queue_continue", count: queuedLate.length });
            const firstLate = queuedLate[0];
            deleteQueuedMessage(db, id, firstLate.seq);
            for (const q of queuedLate.slice(1)) deliverQueuedMessage(db, id, q.seq);
            const latePayload =
              firstLate.payload !== null && typeof firstLate.payload === "object"
                ? (firstLate.payload as Record<string, unknown>)
                : null;
            currentContent =
              latePayload !== null && typeof latePayload.content === "string"
                ? latePayload.content
                : "";
            currentAttachments =
              latePayload !== null && Array.isArray(latePayload.attachments)
                ? (latePayload.attachments as MessageAttachment[])
                : undefined;
            const lateOverrideModel =
              latePayload !== null && typeof latePayload.model === "string"
                ? latePayload.model.trim()
                : "";
            if (lateOverrideModel !== "") {
              const lateOverrideProviderId =
                latePayload !== null && typeof latePayload.providerId === "string"
                  ? latePayload.providerId.trim()
                  : "";
              currentModelOverride =
                lateOverrideProviderId !== ""
                  ? { model: lateOverrideModel, providerId: lateOverrideProviderId }
                  : { model: lateOverrideModel };
            }
            continue;
          }
          // R93-B1: the honest cap-break — the queue is non-empty but the
          // continuation cap is reached. The done frame carries the count so
          // the UI can say the messages are kept (never a silent strand).
          const queuedKeptCount = queuedLate.length;
          send({
            type: "done",
            assistantMessage: outcome.assistantMessage,
            usage: outcome.usage,
            ...(queuedKeptCount > 0 ? { queuedKept: queuedKeptCount } : {}),
          });
        } else if (outcome.code === "ABORTED") {
          // ROUND-42: the user explicitly stopped the turn — a deliberate
          // stop is not a failure; no task_failed notification, and NO
          // debug analyst either (the owner deliberately stopped — there
          // is no completed turn to analyze; status 499 < 500 keeps the
          // gate below closed for the same reason). R78: the loop breaks
          // here — queued messages STAY queued (Stop does not purge the
          // queue; the chips persist, pre-flipped on the next send).
          send({ type: "stopped" });
        } else {
          // ROUND-40/42: real failures (provider errors, crashes) always
          // notify. Validation conflicts (404 unknown session / 409 wrong
          // state) are request errors, not task failures — no notification.
          // R78: the loop breaks — queued messages stay queued.
          const session = getSession(db, id);
          if (outcome.status >= 500) {
            // ROUND-75 (R75): when the transient-API retry ladder ran and
            // exhausted, the notification body says so — the owner asked
            // to be TOLD when the ladder gives up ("it will stop, notify
            // the user, and show the error message").
            // ROUND-80 (R80): the schedule line is built from the REAL
            // settings (describeRetrySchedule over the resolved
            // schedule) — the owner's customized ladder phrased
            // truthfully, never the hardcoded R75 rungs.
            const attempts = outcome.details?.attempts;
            const scheduleLine = describeRetrySchedule(resolveRetrySchedule(getRetrySettings(db)));
            getNotificationBus().publish(db, {
              kind: "task_failed",
              title: session?.title ?? "Task failed",
              body:
                typeof attempts === "number" && attempts > 1
                  ? `${outcome.message} — auto-retried ${attempts} times (${scheduleLine}) before giving up`
                  : outcome.message,
              sessionId: id,
              projectId: session?.projectId ?? undefined,
            });
          }
          // ── R93-B2: the ONE automatic recovery continuation. A
          // network/timeout failure with messages waiting in the queue
          // continues the session instead of stranding it: the owner's
          // "the generation would fail, and it would not even try to
          // continue the session from there at all". The task_failed
          // notification above already TOLD the owner what happened; the
          // queued message then drives one more turn (its own ladder
          // applies). Only network/timeout qualify — auth (every key
          // failed), rate_limit (the quota is spent), context and
          // validation failures would just hit the same wall and burn the
          // queued message. A second failure breaks here for real.
          // NOTE the window this serves: the ladder's retries are fresh
          // outer-loop iterations, so a message queued during an EARLIER
          // attempt is already flipped into the history by the retry's
          // loop-top delivery (the model saw it). Only a message landing
          // during the FINAL attempt (or after the ladder was disabled
          // per settings) is still queued at the terminal failure —
          // exactly the race this branch recovers.
          const errorClass =
            outcome.details !== undefined && typeof outcome.details === "object"
              ? (outcome.details as { errorClass?: unknown }).errorClass
              : undefined;
          const queuedOnFailure = listUndeliveredQueuedMessages(db, id);
          if (
            queuedOnFailure.length > 0 &&
            !recoveryAttempted &&
            continuations < MAX_QUEUE_CONTINUATIONS &&
            (errorClass === "network" || errorClass === "timeout")
          ) {
            recoveryAttempted = true;
            const firstRecovery = queuedOnFailure[0];
            deleteQueuedMessage(db, id, firstRecovery.seq);
            for (const q of queuedOnFailure.slice(1)) deliverQueuedMessage(db, id, q.seq);
            const recoveryPayload =
              firstRecovery.payload !== null && typeof firstRecovery.payload === "object"
                ? (firstRecovery.payload as Record<string, unknown>)
                : null;
            currentContent =
              recoveryPayload !== null && typeof recoveryPayload.content === "string"
                ? recoveryPayload.content
                : "";
            currentAttachments =
              recoveryPayload !== null && Array.isArray(recoveryPayload.attachments)
                ? (recoveryPayload.attachments as MessageAttachment[])
                : undefined;
            const recoveryOverrideModel =
              recoveryPayload !== null && typeof recoveryPayload.model === "string"
                ? recoveryPayload.model.trim()
                : "";
            if (recoveryOverrideModel !== "") {
              const recoveryOverrideProviderId =
                recoveryPayload !== null && typeof recoveryPayload.providerId === "string"
                  ? recoveryPayload.providerId.trim()
                  : "";
              currentModelOverride =
                recoveryOverrideProviderId !== ""
                  ? { model: recoveryOverrideModel, providerId: recoveryOverrideProviderId }
                  : { model: recoveryOverrideModel };
            }
            send({
              type: "meta.queue_continue",
              count: queuedOnFailure.length,
              recovery: true,
            });
            continue;
          }
          // R93-B1: any stranded queue is REPORTED in the error frame's
          // details (queuedKept) — the error card renders "N messages kept
          // — they'll send with your next message". Never a silent strand.
          const queuedKeptOnFailure = queuedOnFailure.length;
          if (outcome.status >= 500) {
            // R66-2-c: a REAL failure (status >= 500 — provider error,
            // loop guard) still ran real work the analyst can dissect
            // (the turn.error event is already persisted, so the
            // transcript carries the ERROR line). Validation conflicts
            // (404/409) and deliberate stops never reach here.
            await runDebugAnalystPhase();
          }
          send({
            type: "error",
            status: outcome.status,
            code: outcome.code,
            message: outcome.message,
            // R93-B1: the details carry the stranded-queue count whenever
            // messages are kept (the card's "N messages kept" line).
            details: {
              ...(outcome.details ?? {}),
              ...(queuedKeptOnFailure > 0 ? { queuedKept: queuedKeptOnFailure } : {}),
            },
          });
        }
        break; // every terminal branch above ends the loop (queue-continue `continue`s are the only loop-around)
      }
    } catch (routeError) {
      // ROUND-43: an unexpected crash in the route itself (not a provider
      // failure) must still terminate the SSE stream with an error frame —
      // otherwise the client sees the socket end with no terminal event
      // and the turn dies silently (the owner's bug).
      // ROUND-80 (R80, the same silent-stop class): the R43 frame alone
      // was LIVE-ONLY — nothing was persisted, so a reload showed the
      // conversation ending at the user message with no error and the
      // session row stayed `running` until the next boot sweep (a
      // vanished failure). Best-effort persistTurnError (crash-guarded
      // — the handler must never itself throw) + the honest task_failed
      // notification + the session-status reset all ride along now.
      const message =
        routeError instanceof Error ? routeError.message : String(routeError);
      try {
        const session = getSession(db, id);
        const agent =
          session !== undefined && session.agentId !== null
            ? getAgent(db, session.agentId)
            : undefined;
        // The failed turn's user message: the LAST message.user event on
        // the log (best-effort — the crash may have landed anywhere).
        const events = listSessionEvents(db, id);
        let userSeq = 0;
        for (const ev of events) {
          if (ev.type === "message.user") userSeq = ev.seq;
        }
        if (session !== undefined) {
          persistTurnError(db, {
            sessionId: id,
            agentId: agent?.id ?? "unknown",
            userSeq,
            code: "INTERNAL_ERROR",
            message: `route crash: ${message}`,
            model: agent?.model ?? "unknown",
            providerId: agent?.providerId ?? "unknown",
            providerError: message,
            keySecrets: keyring.list().filter((v) => v.length >= 8),
          });
          getNotificationBus().publish(db, {
            kind: "task_failed",
            title: session.title ?? "Task failed",
            body: `route crash: ${message}`.slice(0, 300),
            sessionId: id,
            projectId: session.projectId ?? undefined,
          });
        }
      } catch {
        /* the crash handler never crashes — the error frame below is
           the guaranteed terminal event either way */
      }
      send({ type: "error", status: 500, code: "INTERNAL_ERROR", message });
    } finally {
      unregisterTurn(id, abort);
      clearInterval(heartbeat);
      if (!clientGone) {
        try {
          res.end();
        } catch {
          /* socket already dead */
        }
      }
    }
  });
}
