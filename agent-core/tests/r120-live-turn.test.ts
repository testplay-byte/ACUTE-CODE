// @vitest-environment node
//
// ROUND-120 (R120-C-PC, items 37+38 — the sync/state law): the LIVE-TURN
// truth surface, GET /api/v1/sessions/:id/live → {live: boolean}.
//
// The owner's verdict on v0.113.0: "the frontend claims completion while the
// backend still works; the stop button disappears mid-processing; a refresh
// makes everything look finished until the next agent frame arrives." The
// frontend's working state derived from SSE frame ARRIVAL; this route is the
// honest correction — a read-only view of the SHARED turn registry
// (lib/turn-registry.ts), the same map registerTurn/unregisterTurn/abortTurn
// maintain for POST /sessions/:id/stop and the queue route's notifyTurn.
//
// Coverage:
//  · no live turn → {live: false} (the resting answer).
//  · unknown session → 404 NOT_FOUND (the sessions-domain convention).
//  · registerTurn → {live: true}; unregisterTurn (identity-guarded, the
//    route finally's own call) → {live: false} again.
//  · a STOPPED-but-resolving turn (abortTurn fired, the route's finally not
//    yet run) stays {live: true} — the resolving window is still live, which
//    is exactly when the frontend must keep the stop affordance honest.
//  · the bearer wall applies (401 without the token — every route's law).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  getTurnController,
  liveTurnIds,
  registerTurn,
  unregisterTurn,
} from "../src/lib/turn-registry";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r120-live";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r120live-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
});

afterEach(async () => {
  await app.close();
  db.close();
  // No live turn may leak across tests (the registry is module-global —
  // the same hermeticity rule r107-turn-gate pins).
  for (const id of liveTurnIds()) {
    const controller = getTurnController(id);
    if (controller !== undefined) unregisterTurn(id, controller);
  }
  expect(liveTurnIds()).toEqual([]);
});

afterAll(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** A session through the real routes (the r78/r107 pattern — no provider
 * calls needed: this suite never runs a turn, it registers turns directly
 * in the shared registry the way the send routes do). */
async function makeSessionViaApi(): Promise<string> {
  const agentRes = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: { name: "R120 Live Agent", systemPrompt: "You are terse.", providerId: "openrouter", model: "test/r120-1" },
  });
  expect(agentRes.statusCode).toBe(201);
  const sessionRes = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { agentId: (agentRes.json() as { id: string }).id, mode: "single" },
  });
  expect(sessionRes.statusCode).toBe(202);
  return (sessionRes.json() as { id: string }).id;
}

describe("GET /sessions/:id/live (R120-C-PC — the turn-registry truth surface)", () => {
  it("no live turn → {live: false} (the resting answer)", async () => {
    const sessionId = await makeSessionViaApi();
    const res = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/live` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ live: false });
  });

  it("unknown session → 404 NOT_FOUND (the sessions-domain convention)", async () => {
    const res = await authInject({ method: "GET", url: "/api/v1/sessions/no-such-session/live" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("no session with id no-such-session");
  });

  it("registerTurn → {live: true}; the route finally's unregisterTurn → {live: false} again", async () => {
    const sessionId = await makeSessionViaApi();
    // The registration the send routes perform (sse.ts line ~261 / the sync
    // route's finally-guarded pair).
    const controller = new AbortController();
    registerTurn(sessionId, controller);

    const live = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/live` });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ live: true });

    // The route's own finally-block unregister (identity-guarded — the SAME
    // controller, exactly as the routes call it).
    unregisterTurn(sessionId, controller);
    const settled = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/live` });
    expect(settled.json()).toEqual({ live: false });
  });

  it("a STOPPED-but-resolving turn stays {live: true} until the route's finally unregisters it", async () => {
    const sessionId = await makeSessionViaApi();
    const controller = new AbortController();
    registerTurn(sessionId, controller);

    // POST /sessions/:id/stop — the UI Stop button's server-side leg. The
    // abort resolves the turn asynchronously; between the abort and the
    // route's finally the turn is STILL resolving — the honest answer is
    // live:true, and that is exactly the window where the frontend must not
    // flip to a finished look.
    const stop = await authInject({ method: "POST", url: `/api/v1/sessions/${sessionId}/stop` });
    expect(stop.statusCode).toBe(200);
    expect((stop.json() as { ok: boolean; stopped: boolean }).stopped).toBe(true);
    expect(controller.signal.aborted).toBe(true);

    const resolving = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/live` });
    expect(resolving.json()).toEqual({ live: true });

    unregisterTurn(sessionId, controller);
    const done = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/live` });
    expect(done.json()).toEqual({ live: false });
  });

  it("the bearer wall applies — 401 without the token", async () => {
    const sessionId = await makeSessionViaApi();
    const res = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/live` });
    expect(res.statusCode).toBe(401);
  });

  it("the endpoint never mutates the session or writes events (a read-only view of the registry)", async () => {
    const sessionId = await makeSessionViaApi();
    const controller = new AbortController();
    registerTurn(sessionId, controller);
    const before = (await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })) as LightMyRequestResponse;
    const eventsBefore = ((before.json() as { events: unknown[] }).events ?? []).length;

    await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/live` });
    await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/live` });

    const after = (await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })) as LightMyRequestResponse;
    expect(((after.json() as { events: unknown[] }).events ?? []).length).toBe(eventsBefore);
    unregisterTurn(sessionId, controller);
  });
});
