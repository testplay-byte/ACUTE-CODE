// @vitest-environment node
//
// ROUND-114 (R114-b) — the SYNC FOUNDATION suite (Wave 1, agent-core only).
// Six deliverables, one file, the house DB-fixture-per-test style:
//
//   1. META FRAMES — PATCH /sessions/:id/permissions and PATCH /sessions/:id
//      publish {type:"session",kind:"meta",…} on the events bus the moment
//      the durable row lands (permissionMode / activeMode / selectedModel),
//      and the switch_mode tool rides the same storage choke point; a title
//      PATCH is NOT a preference and publishes no meta frame.
//   2. SERVER-SIDE SELECTED MODEL — PATCH validation (complete pair,
//      configured provider, models-row OR catalog match, null clears), the
//      session views carry selectedModel, and prepareTurn resolves the
//      THREE-tier ladder (per-send override → session.selectedModel → agent
//      row) with GET /sessions/:id/context mirroring it.
//   3. turn.started — the early live-turn frame: FIRST on the initiating
//      SSE stream (before any status/log/queue frame), carrying the user
//      text + the resolved model/provider, mirrored to the events bus, and
//      DEFAULT-OFF on direct runStreamedAgentTurn calls (queue continuations
//      and streamed children must not re-announce).
//   4. APPEARANCE +4 — the five-field domain: defaults, partial PUTs,
//      name-the-field 400s, and the broadcast carrying the full shape.
//   5. VISION "OFF" RETIRED — read coercion off→main, write coercion, the
//      relayVision routing ladder (separate-configured / main-when-marked /
//      separate-unconfigured-falls-back-to-main / the honest two-surface
//      refusal), and sessionHasVisionPath's no-off gate.
//   6. FS BROWSE — GET /system/fs/browse: dirs-first alphabetical,
//      dotfile skip unless hidden=1, the 400-entry cap + truncated flag,
//      home-dir default, honest 404, and DEVICE-TOKEN reachability (the
//      phone's New Project folder picker).
//
// The streamed-turn tests run with ONLY the AI SDK mocked at the module
// boundary (the r113-events-stream pattern) — the REAL route + REAL runtime
// drive the frames.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// Module-boundary mocks — no network, full stack otherwise (the
// r113-events-stream / r78-queue pattern).
const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));
const createOpenAICompatibleMock = vi.hoisted(() =>
  vi.fn((_row: { name: string; baseURL: string }) => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
);
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

import { getEventsBus, type EventsBusFrame } from "../src/lib/events-bus";
import { deviceLinkControllerFor } from "../src/lib/device-link";
import { runSingleAgentTurn, runStreamedAgentTurn } from "../src/agents/runtime";
import { streamAiSdkChat } from "../src/agents/chat";
import type { ChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { createProviderRecord } from "../src/storage/providers";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { upsertModel } from "../src/storage/models";
import { getVisionSettings, setVisionSettings } from "../src/storage/vision";
import {
  getAppearanceSettings,
  setAppearanceSettings,
} from "../src/storage/settings";
import { relayVisionForTests, sessionHasVisionPath } from "../src/tools/plugins/computer-use";
import { modesPlugin } from "../src/tools/plugins/modes";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r114sync";
const KEY = "sk-or-vtest-r114sync";
const GW_ID = "prv_gw";
const GW_BASE = "https://gw.example.test/v1";
const GW_KEY = "sk-gw-vtest-r114sync";
const GW_MODEL = "test/gw-model";
// A catalog model id (no models row needed — the catalog-entry branch).
const CATALOG_MODEL = "z-ai/glm-5.2:free";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r114sync-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  createProviderRecord(db, { id: GW_ID, name: "Test Gateway", baseUrl: GW_BASE });
  app = buildServer({
    token: TOKEN,
    db,
    dataDir,
    keyring: new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY,
      ACUTE_PROVIDER_PRV_GW: GW_KEY,
    }),
  });
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createOpenAICompatibleMock.mockClear();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const link = deviceLinkControllerFor(app);
  if (link !== null) await link.stop();
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort (Windows file-handle lag) */
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
  payloadAsStream?: boolean;
  headers?: Record<string, string>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) },
  })) as LightMyRequestResponse;
}

/** Subscribe to the events bus for one test (the r113-appearance helper). */
function collectFrames(): { frames: EventsBusFrame[]; unsubscribe: () => void } {
  const frames: EventsBusFrame[] = [];
  const unsubscribe = getEventsBus().subscribe((frame) => frames.push(frame));
  return { frames, unsubscribe };
}

/** An agent bound to OPENROUTER + a session (the r82-provider-routing shape). */
function makeSession(agentModel = "test/agent-model"): { sessionId: string; agentId: string } {
  const agent = createAgent(db, {
    name: "R114 Agent",
    providerId: "openrouter",
    model: agentModel,
  });
  const session = createSession(db, { agentId: agent.id, mode: "single" });
  return { sessionId: session.id, agentId: agent.id };
}

/** A ChatFn spy recording the (providerId, model) pair of every turn. */
function spyChat(): { chat: ChatFn; seen: Array<{ providerId: string; model: string }> } {
  const seen: Array<{ providerId: string; model: string }> = [];
  const chat: ChatFn = async (input) => {
    seen.push({ providerId: input.provider.id, model: input.model });
    return {
      text: "r114 reply",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    };
  };
  return { chat, seen };
}

/** Collect a live payloadAsStream body into data frames (comment pings skipped). */
class LiveBody {
  private text = "";
  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer) => {
      this.text += chunk.toString("utf8");
    });
  }
  dataFrames(): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    for (const block of this.text.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
    }
    return frames;
  }
}

/** Flush microtasks/zero-tick until the predicate holds (the r113 settle). */
async function settle(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !predicate(); i += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}

// ── 1. meta frames (both PATCH routes + switch_mode) ────────────────────────

describe("R114-b: session meta frames", () => {
  it("PATCH /sessions/:id/permissions publishes {kind:'meta', permissionMode} the moment the row lands", async () => {
    const { sessionId } = makeSession();
    const { frames, unsubscribe } = collectFrames();
    try {
      const response = await authInject({
        method: "PATCH",
        url: `/api/v1/sessions/${sessionId}/permissions`,
        payload: { mode: "full" },
      });
      expect(response.statusCode).toBe(200);
      expect(frames).toEqual([
        {
          type: "session",
          sessionId,
          projectId: null,
          kind: "meta",
          permissionMode: "full",
        },
      ]);
      // JSON round-trip: the untouched optional fields stay ABSENT (never
      // undefined) — the wire contract every other frame follows.
      expect(JSON.parse(JSON.stringify(frames[0]))).toEqual({
        type: "session",
        sessionId,
        projectId: null,
        kind: "meta",
        permissionMode: "full",
      });
    } finally {
      unsubscribe();
    }
  });

  it("PATCH /sessions/:id {activeMode} publishes {kind:'meta', activeMode}; null clears with activeMode:null", async () => {
    const { sessionId } = makeSession();
    const { frames, unsubscribe } = collectFrames();
    try {
      const set = await authInject({
        method: "PATCH",
        url: `/api/v1/sessions/${sessionId}`,
        payload: { activeMode: "build" },
      });
      expect(set.statusCode).toBe(200);
      const clear = await authInject({
        method: "PATCH",
        url: `/api/v1/sessions/${sessionId}`,
        payload: { activeMode: null },
      });
      expect(clear.statusCode).toBe(200);
      expect(frames).toEqual([
        { type: "session", sessionId, projectId: null, kind: "meta", activeMode: "build" },
        { type: "session", sessionId, projectId: null, kind: "meta", activeMode: null },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("PATCH /sessions/:id {model} publishes {kind:'meta', selectedModel} (null clear included)", async () => {
    const { sessionId } = makeSession();
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    const { frames, unsubscribe } = collectFrames();
    try {
      const set = await authInject({
        method: "PATCH",
        url: `/api/v1/sessions/${sessionId}`,
        payload: { model: { providerId: GW_ID, model: GW_MODEL } },
      });
      expect(set.statusCode).toBe(200);
      const clear = await authInject({
        method: "PATCH",
        url: `/api/v1/sessions/${sessionId}`,
        payload: { model: null },
      });
      expect(clear.statusCode).toBe(200);
      expect(frames).toEqual([
        {
          type: "session",
          sessionId,
          projectId: null,
          kind: "meta",
          selectedModel: { providerId: GW_ID, model: GW_MODEL },
        },
        { type: "session", sessionId, projectId: null, kind: "meta", selectedModel: null },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("a title PATCH is NOT a preference — no meta frame for it", async () => {
    const { sessionId } = makeSession();
    const { frames, unsubscribe } = collectFrames();
    try {
      const response = await authInject({
        method: "PATCH",
        url: `/api/v1/sessions/${sessionId}`,
        payload: { title: "renamed" },
      });
      expect(response.statusCode).toBe(200);
      expect(frames).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("the switch_mode tool rides the same storage choke point — activate + deactivate publish meta frames", async () => {
    const { sessionId, agentId } = makeSession();
    const tools = await modesPlugin.createTools({
      root: tempDir,
      toolDeps: { db, sessionId, agentId },
    });
    const switchMode = tools.find((t) => t.name === "switch_mode")!;
    const { frames, unsubscribe } = collectFrames();
    try {
      const on = await switchMode.execute({ mode: "build" }, { root: tempDir });
      expect(on.ok).toBe(true);
      const off = await switchMode.execute({ mode: "none" }, { root: tempDir });
      expect(off.ok).toBe(true);
      expect(frames).toEqual([
        { type: "session", sessionId, projectId: null, kind: "meta", activeMode: "build" },
        { type: "session", sessionId, projectId: null, kind: "meta", activeMode: null },
      ]);
    } finally {
      unsubscribe();
    }
  });
});

// ── 2. the server-side selected model ───────────────────────────────────────

describe("R114-b: PATCH selected-model validation + views", () => {
  it("rejects an incomplete pair (either side missing) with a 400 naming body.model", async () => {
    const { sessionId } = makeSession();
    for (const payload of [
      { model: { model: GW_MODEL } },
      { model: { providerId: GW_ID } },
      { model: { providerId: "", model: GW_MODEL } },
      { model: { providerId: GW_ID, model: "  " } },
    ]) {
      const response = await authInject({
        method: "PATCH",
        url: `/api/v1/sessions/${sessionId}`,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "VALIDATION", details: { field: "body.model" } },
      });
    }
    expect((await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}` })).json().selectedModel).toBeNull();
  });

  it("rejects a non-object model value with the honest 400", async () => {
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: "test/gw-model" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION", details: { field: "body.model" } },
    });
  });

  it("rejects an unknown provider, and a known-but-unconfigured one (no baseUrl)", async () => {
    const { sessionId } = makeSession();
    const unknown = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: "prv_not-a-provider", model: GW_MODEL } },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toContain("prv_not-a-provider");

    // A row with baseUrl NULL = not configured (the R91-A shape).
    db.prepare("UPDATE providers SET base_url = NULL WHERE id = ?").run(GW_ID);
    const unconfigured = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: GW_ID, model: GW_MODEL } },
    });
    expect(unconfigured.statusCode).toBe(400);
    expect(unconfigured.json().error.message).toContain("not a configured provider");
  });

  it("rejects a model with NEITHER a models row NOR a catalog entry — then accepts it once the row exists", async () => {
    const { sessionId } = makeSession();
    const before = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: GW_ID, model: "test/never-heard-of" } },
    });
    expect(before.statusCode).toBe(400);
    expect(before.json().error.message).toContain("no models row and no catalog entry");

    upsertModel(db, GW_ID, { modelId: "test/never-heard-of" });
    const after = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: GW_ID, model: "test/never-heard-of" } },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().selectedModel).toEqual({ providerId: GW_ID, model: "test/never-heard-of" });
  });

  it("accepts a CATALOG entry with no models row (the picker's other surface)", async () => {
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: "openrouter", model: CATALOG_MODEL } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().selectedModel).toEqual({ providerId: "openrouter", model: CATALOG_MODEL });
  });

  it("session views carry selectedModel (list + detail), null clears it, and both PATCH routes accept the pair", async () => {
    const { sessionId } = makeSession();
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    // The permissions route accepts the model field too (one composer breath).
    const viaPermissions = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}/permissions`,
      payload: { mode: "ask", model: { providerId: GW_ID, model: GW_MODEL } },
    });
    expect(viaPermissions.statusCode).toBe(200);
    expect(viaPermissions.json().permissionMode).toBe("ask");
    expect(viaPermissions.json().selectedModel).toEqual({ providerId: GW_ID, model: GW_MODEL });

    // The LIST carries it.
    const list = await authInject({ method: "GET", url: "/api/v1/sessions" });
    const row = (list.json() as { sessions: Array<{ id: string; selectedModel: unknown }> }).sessions.find(
      (s) => s.id === sessionId,
    );
    expect(row?.selectedModel).toEqual({ providerId: GW_ID, model: GW_MODEL });

    // The DETAIL carries it; null clears it back to the agent default.
    const detail = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}` });
    expect(detail.json().selectedModel).toEqual({ providerId: GW_ID, model: GW_MODEL });
    const cleared = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().selectedModel).toBeNull();
    expect((await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}` })).json().selectedModel).toBeNull();
  });
});

// ── 3. prepareTurn's three-tier ladder (+ the context meter's mirror) ───────

describe("R114-b: prepareTurn resolves per-send override → session.selectedModel → agent row", () => {
  it("(a) no override, no session model → the AGENT row's pair (the pre-R114 behavior)", async () => {
    const { sessionId } = makeSession("test/agent-model");
    const spy = spyChat();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: spy.chat },
      sessionId,
      "hello",
    );
    expect(outcome.ok).toBe(true);
    expect(spy.seen).toEqual([{ providerId: "openrouter", model: "test/agent-model" }]);
  });

  it("(b) a session selectedModel beats the agent row (both sides switch)", async () => {
    const { sessionId } = makeSession("test/agent-model");
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    const patched = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: GW_ID, model: GW_MODEL } },
    });
    expect(patched.statusCode).toBe(200);
    const spy = spyChat();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY, ACUTE_PROVIDER_PRV_GW: GW_KEY }), chat: spy.chat },
      sessionId,
      "hello",
    );
    expect(outcome.ok).toBe(true);
    // THE pin: the session row routed the turn — provider AND model.
    expect(spy.seen).toEqual([{ providerId: GW_ID, model: GW_MODEL }]);
  });

  it("(c) a per-send override still wins over the session model (the override-first gate)", async () => {
    const { sessionId } = makeSession("test/agent-model");
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: GW_ID, model: GW_MODEL } },
    });
    const spy = spyChat();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: spy.chat },
      sessionId,
      "hello",
      { model: "test/one-shot", providerId: "openrouter" },
    );
    expect(outcome.ok).toBe(true);
    expect(spy.seen).toEqual([{ providerId: "openrouter", model: "test/one-shot" }]);
  });

  it("(d) clearing the session model falls back to the agent row again", async () => {
    const { sessionId } = makeSession("test/agent-model");
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: GW_ID, model: GW_MODEL } },
    });
    await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: null },
    });
    const spy = spyChat();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: spy.chat },
      sessionId,
      "hello",
    );
    expect(outcome.ok).toBe(true);
    expect(spy.seen).toEqual([{ providerId: "openrouter", model: "test/agent-model" }]);
  });

  it("GET /sessions/:id/context mirrors the SAME three-tier fallback on its effective-model line", async () => {
    const { sessionId } = makeSession("test/agent-model");
    // (a) agent default.
    const agentTier = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(agentTier.statusCode).toBe(200);
    expect(agentTier.json()).toMatchObject({ providerId: "openrouter", model: "test/agent-model" });

    // (b) session tier.
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: GW_ID, model: GW_MODEL } },
    });
    const sessionTier = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(sessionTier.statusCode).toBe(200);
    expect(sessionTier.json()).toMatchObject({ providerId: GW_ID, model: GW_MODEL });

    // (c) query pair (the live per-send pick) beats the session tier.
    const overrideTier = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/context?providerId=openrouter&model=test/pick`,
    });
    expect(overrideTier.statusCode).toBe(200);
    expect(overrideTier.json()).toMatchObject({ providerId: "openrouter", model: "test/pick" });
  });
});

// ── 4. turn.started — the early live-turn frame ─────────────────────────────

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

/** A streamText result that completes immediately with one text-delta. */
function completingStream() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "The turn completed." };
      yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
    })(),
    totalUsage: Promise.resolve(USAGE),
    usage: Promise.resolve(USAGE),
  };
}

describe("R114-b: turn.started — the early live-turn frame", () => {
  it("is the FIRST frame on the initiating stream (text + model + providerId) and rides the events-bus mirror", async () => {
    const { sessionId } = makeSession("test/agent-model");
    streamTextMock.mockImplementation(() => completingStream());
    const { frames, unsubscribe } = collectFrames();
    try {
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages/stream`,
        payload: { content: "the watched turn" },
        payloadAsStream: true,
      });
      expect(response.statusCode).toBe(200);
      const initiator = new LiveBody(response.stream());

      // The initiator's own stream: turn.started FIRST, before any other
      // data frame (status flips and log appends ride the BUS, not this
      // socket — the first thing this socket ever hears is the opening).
      await settle(() => initiator.dataFrames().some((f) => f.type === "done"));
      const types = initiator.dataFrames().map((f) => f.type);
      expect(types[0]).toBe("turn.started");
      const started = initiator.dataFrames()[0]!;
      expect(started).toEqual({
        type: "turn.started",
        text: "the watched turn",
        model: "test/agent-model",
        providerId: "openrouter",
      });
      // It is NOT persisted as its own event (the message.user append is the
      // durable record — turn.started is a live-only announcement).
      expect(types).toContain("text-delta");
      expect(types).toContain("done");

      // The bus mirror carried the same frame verbatim (the OTHER device's
      // early signal — pre-R114 nothing reached it until the first delta).
      const mirrored = frames.find(
        (f) =>
          f.type === "turn" &&
          (f.frame as { type?: string }).type === "turn.started",
      );
      expect(mirrored).toEqual({
        type: "turn",
        sessionId,
        frame: { type: "turn.started", text: "the watched turn", model: "test/agent-model", providerId: "openrouter" },
      });
    } finally {
      unsubscribe();
    }
  });

  it("carries the SESSION tier's model when no per-send override was sent", async () => {
    const { sessionId } = makeSession("test/agent-model");
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: { providerId: GW_ID, model: GW_MODEL } },
    });
    streamTextMock.mockImplementation(() => completingStream());
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "which model am i on" },
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    const initiator = new LiveBody(response.stream());
    await settle(() => initiator.dataFrames().some((f) => f.type === "done"));
    expect(initiator.dataFrames()[0]).toEqual({
      type: "turn.started",
      text: "which model am i on",
      model: GW_MODEL,
      providerId: GW_ID,
    });
  });

  it("is DEFAULT-OFF on direct runStreamedAgentTurn calls (queue continuations + streamed children stay quiet)", async () => {
    const { sessionId } = makeSession("test/agent-model");
    streamTextMock.mockImplementation(() => completingStream());
    const captured: Array<{ type: string }> = [];
    const emit = (event: unknown): void => {
      captured.push(event as { type: string });
    };
    // Without the flag: a normal streamed child / continuation call shape.
    const quiet = await runStreamedAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: spyChat().chat, chatStream: streamAiSdkChat },
      sessionId,
      "a continuation-shaped call",
      emit,
    );
    expect(quiet.ok).toBe(true);
    expect(captured.some((f) => f.type === "turn.started")).toBe(false);

    // With the flag: the frame is FIRST among everything the call emits.
    captured.length = 0;
    const announced = await runStreamedAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: spyChat().chat, chatStream: streamAiSdkChat },
      sessionId,
      "an announced call",
      emit,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(announced.ok).toBe(true);
    expect(captured[0]).toEqual({
      type: "turn.started",
      text: "an announced call",
      model: "test/agent-model",
      providerId: "openrouter",
    });
  });
});

// ── 5. the appearance domain's five fields ─────────────────────────────────

describe("R114-b: appearance +4 (chat density / text size / timestamps / tool activity)", () => {
  it("GET serves the full five-field default on a fresh database (backward compatible)", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/settings/appearance" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      themeId: null,
      mode: "system",
      chatDensity: "comfortable",
      chatTextSize: "medium",
      timestampsMode: "hover",
      toolActivity: "detailed",
    });
    // The storage accessor agrees (one truth).
    expect(getAppearanceSettings(db)).toEqual({
      themeId: null,
      mode: "system",
      chatDensity: "comfortable",
      chatTextSize: "medium",
      timestampsMode: "hover",
      toolActivity: "detailed",
    });
  });

  it("round-trips each new field independently (partial patches leave the others alone)", async () => {
    setAppearanceSettings(db, { chatDensity: "compact" });
    expect(getAppearanceSettings(db).chatDensity).toBe("compact");
    expect(getAppearanceSettings(db).chatTextSize).toBe("medium");
    setAppearanceSettings(db, { chatTextSize: "large" });
    expect(getAppearanceSettings(db)).toMatchObject({ chatDensity: "compact", chatTextSize: "large" });
    setAppearanceSettings(db, { timestampsMode: "hidden" });
    expect(getAppearanceSettings(db)).toMatchObject({ timestampsMode: "hidden", toolActivity: "detailed" });
    setAppearanceSettings(db, { toolActivity: "compact" });
    expect(getAppearanceSettings(db).toolActivity).toBe("compact");
    expect(getAppearanceSettings(db).mode).toBe("system");
  });

  it("PUT persists a valid patch for each field and returns the updated object", async () => {
    const response = await authInject({
      method: "PUT",
      url: "/api/v1/settings/appearance",
      payload: { chatDensity: "compact", chatTextSize: "small", timestampsMode: "hidden", toolActivity: "hidden" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      themeId: null,
      mode: "system",
      chatDensity: "compact",
      chatTextSize: "small",
      timestampsMode: "hidden",
      toolActivity: "hidden",
    });
    expect(
      (await authInject({ method: "GET", url: "/api/v1/settings/appearance" })).json(),
    ).toEqual(response.json());
  });

  it("PUT with a value outside any of the four vocabularies 400s naming the field — nothing persisted", async () => {
    for (const [field, value] of [
      ["chatDensity", "cozy"],
      ["chatTextSize", "huge"],
      ["timestampsMode", "always"],
      ["toolActivity", "verbose"],
    ] as const) {
      const response = await authInject({
        method: "PUT",
        url: "/api/v1/settings/appearance",
        payload: { [field]: value },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "VALIDATION", details: { field: `body.${field}` } },
      });
    }
    expect(getAppearanceSettings(db)).toEqual({
      themeId: null,
      mode: "system",
      chatDensity: "comfortable",
      chatTextSize: "medium",
      timestampsMode: "hover",
      toolActivity: "detailed",
    });
  });

  it("every successful PUT broadcasts the FULL five-field shape; a rejected PUT broadcasts nothing", async () => {
    const { frames, unsubscribe } = collectFrames();
    try {
      const rejected = await authInject({
        method: "PUT",
        url: "/api/v1/settings/appearance",
        payload: { chatDensity: "cozy" },
      });
      expect(rejected.statusCode).toBe(400);
      expect(frames).toHaveLength(0);

      const accepted = await authInject({
        method: "PUT",
        url: "/api/v1/settings/appearance",
        payload: { chatDensity: "compact" },
      });
      expect(accepted.statusCode).toBe(200);
      expect(frames).toEqual([
        {
          type: "settings",
          domain: "appearance",
          value: {
            themeId: null,
            mode: "system",
            chatDensity: "compact",
            chatTextSize: "medium",
            timestampsMode: "hover",
            toolActivity: "detailed",
          },
        },
      ]);
    } finally {
      unsubscribe();
    }
  });
});

// ── 6. vision: "off" retired — model-flag vision always works ───────────────

/** A fetch stub answering the relay's provider POST with a fixed completion. */
function visionFetchStub(reply: string) {
  // The (url, init) parameters are declared so mock.calls carries the
  // RequestInit (the key-bearing headers the tests assert on).
  return vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(reply, { status: 200, statusText: "OK" }),
  );
}

const PNG_BASE64 = "aGVsbG8=";
const VISION_COMPLETION = JSON.stringify({ choices: [{ message: { content: "A panel is open." } }] });
const MARKED_MAIN = { providerId: "openrouter", modelId: "vision-model" };
const UNMARKED_MAIN = { providerId: "openrouter", modelId: "text-only-model" };

describe("R114-b: vision read coercion — a stored 'off' reads as 'main'", () => {
  it("the default is 'main'; a raw stored 'off' row reads as 'main'; unknown values read as 'main'", () => {
    expect(getVisionSettings(db).mode).toBe("main");
    db.prepare("INSERT INTO settings (key, value) VALUES ('vision.mode', 'off')").run();
    expect(getVisionSettings(db).mode).toBe("main");
    db.prepare("UPDATE settings SET value = 'banana' WHERE key = 'vision.mode'").run();
    expect(getVisionSettings(db).mode).toBe("main");
    // The provider/modelId halves survive untouched.
    expect(getVisionSettings(db).provider).toBeNull();
    expect(getVisionSettings(db).modelId).toBeNull();
  });

  it("setVisionSettings coerces a legacy 'off' to 'main' (wire compat), rejects anything else unknown", () => {
    expect(setVisionSettings(db, { mode: "off" as never }).mode).toBe("main");
    expect(db.prepare("SELECT value FROM settings WHERE key = 'vision.mode'").get()).toEqual({
      value: "main",
    });
    expect(() => setVisionSettings(db, { mode: "banana" as never })).toThrow(/mode must be one of/);
  });

  it("PUT /vision/settings accepts the legacy 'off' and answers the coerced settings", async () => {
    const response = await authInject({
      method: "PUT",
      url: "/api/v1/vision/settings",
      payload: { mode: "off" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "main" });
  });
});

describe("R114-b: relayVision's routing ladder (off-branch deleted)", () => {
  beforeEach(() => {
    upsertModel(db, "openrouter", { modelId: "vision-model", supportsVision: true });
    upsertModel(db, "openrouter", { modelId: "text-only-model", supportsVision: false });
  });

  it("main mode + a MARKED model → the image relays to the MAIN model (the owner's directive)", async () => {
    const fetchMock = visionFetchStub(VISION_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    setVisionSettings(db, { mode: "main" });
    const result = await relayVisionForTests(
      db,
      new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-main" }),
      MARKED_MAIN,
      PNG_BASE64,
      "what do you see",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("main");
      expect(result.model).toBe("vision-model");
      expect(result.text).toContain("panel is open");
    }
    // The relay POST used the provider's PRIMARY key (main path).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-main");
  });

  it("separate chosen but NOT fully configured → falls back to the MAIN model when it is marked", async () => {
    const fetchMock = visionFetchStub(VISION_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    setVisionSettings(db, { mode: "separate" }); // provider/modelId left null
    const result = await relayVisionForTests(
      db,
      new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-main" }),
      MARKED_MAIN,
      PNG_BASE64,
      "what do you see",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe("main");
  });

  it("separate FULLY configured → the dedicated pair + the <id>-vision keyring slot wins", async () => {
    const fetchMock = visionFetchStub(VISION_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    setVisionSettings(db, { mode: "separate", provider: "openrouter", modelId: "google/gemini-vision-x" });
    const result = await relayVisionForTests(
      db,
      new ProviderKeyring({
        ACUTE_PROVIDER_OPENROUTER: "sk-main",
        ACUTE_PROVIDER_OPENROUTER_VISION: "sk-vision",
      }),
      MARKED_MAIN,
      PNG_BASE64,
      "what do you see",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("separate");
      expect(result.model).toBe("google/gemini-vision-x");
    }
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-vision");
  });

  it("NEITHER path works → the honest refusal naming BOTH fixes (no 'off' refusal exists)", async () => {
    const fetchMock = visionFetchStub(VISION_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    setVisionSettings(db, { mode: "main" });
    const result = await relayVisionForTests(
      db,
      new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-main" }),
      UNMARKED_MAIN,
      PNG_BASE64,
      "what do you see",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not marked supports_vision");
      expect(result.error).toContain("Models & Providers");
      expect(result.error).toContain("Settings → Image Analysis");
      expect(result.error).not.toContain("vision is OFF");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // The separate-unconfigured variant says WHY no fallback happened.
    setVisionSettings(db, { mode: "separate" });
    const separateResult = await relayVisionForTests(
      db,
      new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-main" }),
      UNMARKED_MAIN,
      PNG_BASE64,
      "what do you see",
    );
    expect(separateResult.ok).toBe(false);
    if (!separateResult.ok) expect(separateResult.error).toContain("not fully configured");
  });

  it("sessionHasVisionPath: main-marked OR separate-configured — the off gate is gone", () => {
    // A stored 'off' row + a MARKED model → TRUE (the R114-b rule).
    db.prepare("INSERT INTO settings (key, value) VALUES ('vision.mode', 'off')").run();
    expect(sessionHasVisionPath(db, MARKED_MAIN)).toBe(true);
    expect(sessionHasVisionPath(db, UNMARKED_MAIN)).toBe(false);
    expect(sessionHasVisionPath(db, undefined)).toBe(false);
    // Separate fully configured → TRUE even with an unmarked main model.
    setVisionSettings(db, { mode: "separate", provider: "openrouter", modelId: "google/gemini-vision-x" });
    expect(sessionHasVisionPath(db, UNMARKED_MAIN)).toBe(true);
    expect(sessionHasVisionPath(db, undefined)).toBe(true);
    // Separate chosen but incomplete + MARKED main → TRUE — the gate mirrors
    // relayVision's fallback (a half-built separate picker must not blind a
    // vision-capable session; a marked model MUST be able to see).
    setVisionSettings(db, { mode: "separate", provider: null, modelId: null });
    expect(sessionHasVisionPath(db, MARKED_MAIN)).toBe(true);
    // Separate chosen but incomplete + unmarked main → FALSE.
    expect(sessionHasVisionPath(db, UNMARKED_MAIN)).toBe(false);
  });
});

// ── 7. GET /system/fs/browse (the phone's New Project folder picker) ────────

describe("R114-b: GET /system/fs/browse", () => {
  let browseRoot = "";
  beforeEach(() => {
    browseRoot = mkdtempSync(join(tempDir, "browse-"));
    // A deterministic tree: dirs + files + a dotfile + a dotdir.
    for (const name of ["zeta", "alpha", "mid"]) mkdirSync(join(browseRoot, name));
    mkdirSync(join(browseRoot, ".hidden-dir"));
    for (const name of ["readme.md", "app.ts", "notes.txt"]) writeFileSync(join(browseRoot, name), "x");
    writeFileSync(join(browseRoot, ".env"), "secret");
  });

  it("answers directories first then files, each alphabetical, with absolute paths + the parent", async () => {
    const response = await authInject({
      method: "GET",
      url: `/api/v1/system/fs/browse?path=${encodeURIComponent(browseRoot)}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      path: string;
      parent: string | null;
      truncated: boolean;
      entries: Array<{ name: string; path: string; dir: boolean }>;
    };
    expect(body.path).toBe(browseRoot);
    expect(body.parent).toBe(join(browseRoot, ".."));
    expect(body.truncated).toBe(false);
    // Dotfiles skipped by default; dirs before files; alphabetical in each group.
    expect(body.entries.map((e) => e.name)).toEqual(["alpha", "mid", "zeta", "app.ts", "notes.txt", "readme.md"]);
    expect(body.entries[0]!.dir).toBe(true);
    expect(body.entries[3]!.dir).toBe(false);
    expect(body.entries[0]!.path).toBe(join(browseRoot, "alpha"));
  });

  it("hidden=1 includes the dotfiles and dot-directories", async () => {
    const response = await authInject({
      method: "GET",
      url: `/api/v1/system/fs/browse?path=${encodeURIComponent(browseRoot)}&hidden=1`,
    });
    expect(response.statusCode).toBe(200);
    const names = (response.json() as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    expect(names).toContain(".hidden-dir");
    expect(names).toContain(".env");
    // The dot-DIRECTORY sorts within the directory group.
    expect(names.indexOf(".hidden-dir")).toBeLessThan(names.indexOf("alpha"));
  });

  it("path omitted → the user's HOME directory; a filesystem root answers parent:null", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/system/fs/browse" });
    expect(response.statusCode).toBe(200);
    expect(response.json().path).toBe(homedir());
    expect(Array.isArray(response.json().entries)).toBe(true);
    // The root of the tree (POSIX "/" in this sandbox): no parent above it.
    const root = await authInject({ method: "GET", url: "/api/v1/system/fs/browse?path=%2F" });
    expect(root.statusCode).toBe(200);
    expect(root.json().parent).toBeNull();
    expect((root.json() as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
  });

  it("caps at 400 entries and flags the truncation honestly", async () => {
    const bigRoot = mkdtempSync(join(tempDir, "big-"));
    for (let i = 0; i < 401; i += 1) {
      writeFileSync(join(bigRoot, `file-${String(i).padStart(4, "0")}.txt`), "x");
    }
    const response = await authInject({
      method: "GET",
      url: `/api/v1/system/fs/browse?path=${encodeURIComponent(bigRoot)}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: unknown[]; truncated: boolean };
    expect(body.entries).toHaveLength(400);
    expect(body.truncated).toBe(true);
    // The cut is at the sort order's head — the first 400 names.
    expect((body.entries[0] as { name: string }).name).toBe("file-0000.txt");
    expect((body.entries[399] as { name: string }).name).toBe("file-0399.txt");
  });

  it("404s a non-existent path with the OS's own message; 400s a file path", async () => {
    const missing = await authInject({
      method: "GET",
      url: `/api/v1/system/fs/browse?path=${encodeURIComponent(join(browseRoot, "no-such-dir"))}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toContain("no-such-dir");
    expect(missing.json().error.message).toContain("ENOENT");

    const file = await authInject({
      method: "GET",
      url: `/api/v1/system/fs/browse?path=${encodeURIComponent(join(browseRoot, "readme.md"))}`,
    });
    expect(file.statusCode).toBe(400);
    expect(file.json().error.message).toContain("not a directory");
  });
});

// ── 8. the device-token seat (the phone) ────────────────────────────────────

/** A REAL TLS request against the device listener (the r109/r113 pattern). */
function tlsRequest(
  port: number,
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = opts?.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(payload !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(opts?.headers ?? {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* non-JSON body — the status carries it */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("R114-b: fs browse is reachable with a DEVICE token (the phone's picker)", () => {
  it("a paired device token browses; a blocked route (computer control) still refuses it", async () => {
    // Pair a real device through the mobile routes (the r113 pattern).
    const put = await authInject({ method: "PUT", url: "/api/v1/settings/device-link", payload: { enabled: true } });
    expect(put.statusCode).toBe(200);
    const start = await authInject({ method: "POST", url: "/api/v1/mobile/pair/start" });
    expect(start.statusCode).toBe(200);
    const qr = start.json() as { pin: string; port: number };
    const claim = await tlsRequest(qr.port, "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: qr.pin, label: "the owner's phone" },
    });
    expect(claim.status).toBe(200);
    const deviceToken = (claim.json as { deviceToken: string }).deviceToken;

    // The phone's seat reaches the browse route (NOT on the blocklist).
    const browse = await app.inject({
      method: "GET",
      url: "/api/v1/system/fs/browse",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(browse.statusCode).toBe(200);
    expect(browse.json().path).toBe(homedir());

    // The contrast leg: the SAME token cannot reach computer control —
    // the blocklist is intact and fs/browse's openness is deliberate.
    const blocked = await app.inject({
      method: "GET",
      url: "/api/v1/computer-use/config",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});
