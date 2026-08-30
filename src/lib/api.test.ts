import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  computeUnifiedDiff,
  createProvider,
  deleteProvider,
  deleteProviderModelConfig,
  fetchModelsCatalog,
  fetchOrchestrationSettings,
  fetchProviderModelConfig,
  fetchProviderModelEntries,
  fetchProviders,
  getAgentsBackend,
  httpAgents,
  parseDiffArgs,
  pickFolderViaBackend,
  restoreCheckpoint,
  storeProviderKey,
  testProviderConnection,
  toProjectChatItems,
  updateOrchestrationSettings,
  updateProvider,
  updateProviderModelConfig,
  upsertProviderModelConfig,
  type Agent,
  type ProviderModelConfig,
  type ProviderView,
  type SessionEvent,
} from "./api";
import { createFixtureAgents, getFixtureAgents, resetFixtureAgents } from "./agent-fixtures";
import { useConfigStore } from "./config-store";

const AGENT: Agent = {
  id: "agt_c1",
  name: "Coder",
  role: "coder",
  systemPrompt: "You write precise, minimal diffs.",
  providerId: "openrouter",
  model: "anthropic/claude-sonnet-4",
  visionModel: null,
  allowedTools: ["read_file", "write_file"],
  memoryPolicy: "every-turn",
  skills: ["git-rescue"],
  maxTurns: 40,
  temperature: 0.2,
  isTemplate: false,
  version: 1,
  createdAt: "2026-08-21T09:00:00Z",
  updatedAt: "2026-08-21T09:00:00Z",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetFixtureAgents();
  useConfigStore.setState({
    baseUrl: "http://sidecar.test",
    token: "tok_123",
    demoData: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("http agents client", () => {
  it("lists agents with auth header and envelope unwrapping", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agents: [AGENT] }));
    vi.stubGlobal("fetch", fetchMock);

    const agents = await httpAgents().list(true);

    expect(agents).toEqual([AGENT]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sidecar.test/api/v1/agents?includeTemplates=true",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer tok_123" }),
      }),
    );
  });

  it("creates agents with a JSON body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { ...AGENT, id: "agt_new" }));
    vi.stubGlobal("fetch", fetchMock);

    const created = await httpAgents().create({
      name: "Coder",
      role: "coder",
      systemPrompt: "…",
      providerId: "openrouter",
      model: "m",
      visionModel: null,
      allowedTools: [],
      memoryPolicy: "none",
      skills: [],
      maxTurns: 10,
      temperature: 0.1,
    });

    expect(created.id).toBe("agt_new");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/agents");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string).name).toBe("Coder");
  });

  it("maps the API.md error envelope onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          error: { code: "NOT_FOUND", message: "agent agt_x not found", details: { id: "agt_x" } },
        }),
      ),
    );

    const err = await httpAgents().get("agt_x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("agent agt_x not found");
    expect(err.details).toEqual({ id: "agt_x" });
    expect(err.isNetwork).toBe(false);
  });

  it("falls back to a generic message when the error body is not the envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway blew up", { status: 502 })),
    );

    const err = await httpAgents().list(true).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toContain("502");
  });

  it("surfaces fetch rejection as a NETWORK ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const err = await httpAgents().list(true).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("NETWORK");
    expect(err.isNetwork).toBe(true);
    expect(err.message).toContain("http://sidecar.test");
  });

  it("treats 204 as success with no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(httpAgents().remove("agt_c1")).resolves.toBeUndefined();
  });
});

describe("fixture agents backend", () => {
  it("filters templates out when includeTemplates is false", async () => {
    const backend = createFixtureAgents();
    const all = await backend.list(true);
    const mine = await backend.list(false);
    expect(all.some((a) => a.isTemplate)).toBe(true);
    expect(mine.every((a) => !a.isTemplate)).toBe(true);
  });

  it("creates, duplicates and removes agents", async () => {
    const backend = createFixtureAgents();
    const before = (await backend.list(true)).length;

    const created = await backend.create({
      name: "Scraper",
      role: "researcher",
      systemPrompt: "…",
      providerId: "openrouter",
      model: "openrouter/ox-alpha",
      visionModel: null,
      allowedTools: ["read_file"],
      memoryPolicy: "none",
      skills: [],
      maxTurns: 5,
      temperature: 0,
    });
    expect(created.isTemplate).toBe(false);
    expect((await backend.list(true)).length).toBe(before + 1);

    const copy = await backend.duplicate(created.id, "Scraper 2");
    expect(copy.name).toBe("Scraper 2");
    expect(copy.id).not.toBe(created.id);

    await backend.remove(created.id);
    await expect(backend.get(created.id)).rejects.toBeTruthy();
  });

  it("update bumps version and applies the patch", async () => {
    const backend = createFixtureAgents();
    const [first] = await backend.list(false);
    const updated = await backend.update(first.id, { temperature: 0.9 });
    expect(updated.temperature).toBe(0.9);
    expect(updated.version).toBe(first.version + 1);
  });
});

describe("backend selection", () => {
  it("uses the fixture backend while demoData is on, HTTP when off", () => {
    useConfigStore.setState({ demoData: true });
    const demo = getAgentsBackend();
    expect(demo).toBe(getFixtureAgents());

    useConfigStore.setState({ demoData: false });
    const live = getAgentsBackend();
    expect(live).not.toBe(demo);
  });
});

// --- toProjectChatItems helpers -------------------------------------------

const TS = (seq: number) => `2026-08-22T09:00:${String(seq).padStart(2, "0")}Z`;

function ev(
  seq: number,
  type: string,
  payload: unknown,
  agentId: string | null = null,
): SessionEvent {
  return { seq, type, agentId, payload, ts: TS(seq) };
}

/** tool.use event exactly as agent-core's runtime appends it. */
function toolUse(seq: number, toolName: string, argsSummary: string, ok = true): SessionEvent {
  return ev(
    seq,
    "tool.use",
    { role: "tool", toolName, argsSummary, ok, agentId: "agt_scribe", ts: TS(seq) },
    "agt_scribe",
  );
}

describe("toProjectChatItems (ROUND-37 turn model)", () => {
  it("folds one user message + its whole iteration into ONE turn: tools in working, answer as finalText", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "Add rate limiting" }, "agt_scribe"),
      ev(2, "message.assistant", { role: "assistant", content: "Let me inspect first.", thinking: "plan: read middleware" }, "agt_scribe"),
      toolUse(3, "list_dir", "path: src"),
      toolUse(4, "write_file", "path: src/middleware.ts, content: 128 chars"),
      ev(5, "message.assistant", { role: "assistant", content: "Done — limiter added." }, "agt_scribe"),
    ]);

    expect(items.map((i) => i.kind)).toEqual(["user", "turn"]);
    const turn = items[1];
    if (turn.kind !== "turn") throw new Error("expected turn");
    // ONE header per turn — the R37 fix for repeated avatars/names.
    expect(turn.seq).toBe(2);
    expect(turn.agentId).toBe("agt_scribe");
    expect(turn.ts).toBe(TS(2));
    expect(turn.endTs).toBe(TS(5));
    // working: the pre-tool narration, both tool calls (in order), and the
    // thinking for the FIRST segment (all thinking folds into working).
    expect(turn.working.map((w) => w.type)).toEqual(["thinking", "text", "tool", "tool"]);
    expect(turn.finalText).toBe("Done — limiter added.");
  });

  it("final answer = text AFTER the last tool; earlier post-tool texts become narration (outer-loop iterations)", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "go" }, "agt_scribe"),
      ev(2, "message.assistant", { role: "assistant", content: "Checking the folder." }, "agt_scribe"),
      toolUse(3, "list_dir", "path: ."),
      // iteration 1 final flush (post-tool narration with stats)
      ev(4, "message.assistant", { role: "assistant", content: "Found 2 files, verifying.", usage: { inputTokens: 10, outputTokens: 5 }, ms: 800, model: "m1" }, "agt_scribe"),
      // iteration 2 (no tools → conversational break): the true answer
      ev(5, "message.assistant", { role: "assistant", content: "The folder has 2 files.", usage: { inputTokens: 12, outputTokens: 7 }, ms: 1100, model: "m1" }, "agt_scribe"),
    ]);

    const turn = items[1];
    if (turn.kind !== "turn") throw new Error("expected turn");
    expect(turn.finalText).toBe("The folder has 2 files.");
    // narration entries: pre-tool + post-tool-iteration-1 text, in order
    const narration = turn.working.filter((w) => w.type === "text").map((w) => (w as { content: string }).content);
    expect(narration).toEqual(["Checking the folder.", "Found 2 files, verifying."]);
    // LAST stats win (turn-level)
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(turn.ms).toBe(1100);
    expect(turn.model).toBe("m1");
  });

  it("ROUND-35 semantics preserved: stats carrier (empty content + usage) merges into TURN stats, no empty bubble", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "go" }, "agt_scribe"),
      ev(2, "message.assistant", { role: "assistant", content: "Creating now.", thinking: "plan first" }, "agt_scribe"),
      toolUse(3, "write_file", "path: a.ts, content: 5 chars"),
      ev(4, "message.assistant", { role: "assistant", content: "", usage: { inputTokens: 7, outputTokens: 3 }, ms: 120, model: "m" }, "agt_scribe"),
    ]);

    expect(items.map((i) => i.kind)).toEqual(["user", "turn"]);
    const turn = items[1];
    if (turn.kind !== "turn") throw new Error("expected turn");
    expect(turn.finalText).toBe(""); // text preceded the tool → narration only
    const thinking = turn.working.find((w) => w.type === "thinking");
    expect(thinking).toMatchObject({ text: "plan first" });
    expect(turn.working.some((w) => w.type === "text" && (w as { content: string }).content === "Creating now.")).toBe(true);
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(turn.ms).toBe(120);
    expect(turn.model).toBe("m");
  });

  it("splits DIFFERENT turns at each user message (one turn per user message)", () => {
    const items = toProjectChatItems([
      toolUse(1, "list_dir", "path: ."),
      ev(2, "message.assistant", { role: "assistant", content: "first done" }, "agt_scribe"),
      ev(3, "message.user", { role: "user", content: "next task" }, "agt_scribe"),
      toolUse(4, "read_file", "path: src/index.ts"),
      ev(5, "message.assistant", { role: "assistant", content: "second done" }, "agt_scribe"),
    ]);

    // leading assistant events → synthetic turn (no user message before it)
    expect(items.map((i) => i.kind)).toEqual(["turn", "user", "turn"]);
    const [first, second] = items.filter((i) => i.kind === "turn");
    if (first.kind !== "turn" || second.kind !== "turn") throw new Error("expected turns");
    expect(first.finalText).toBe("first done");
    expect(first.working).toHaveLength(1); // the tool
    expect(second.finalText).toBe("second done");
  });

  it("turn ending on a tool call has empty finalText (working-only turn)", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "clean up" }, "agt_scribe"),
      ev(2, "message.assistant", { role: "assistant", content: "Removing the file now." }, "agt_scribe"),
      toolUse(3, "delete_file", "path: tmp/old.log"),
    ]);

    expect(items.map((i) => i.kind)).toEqual(["user", "turn"]);
    const turn = items[1];
    if (turn.kind !== "turn") throw new Error("expected turn");
    expect(turn.finalText).toBe("");
    expect(turn.working.map((w) => w.type)).toEqual(["text", "tool"]);
  });

  it("consecutive user messages: empty turns drop, both user items render (failed provider turn)", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "hello?" }, "agt_scribe"),
      // provider failed — no assistant events at all
      ev(2, "message.user", { role: "user", content: "you there?" }, "agt_scribe"),
      ev(3, "message.assistant", { role: "assistant", content: "Yes, sorry." }, "agt_scribe"),
    ]);

    expect(items.map((i) => i.kind)).toEqual(["user", "user", "turn"]);
    expect(items[0]).toMatchObject({ content: "hello?" });
    expect(items[1]).toMatchObject({ content: "you there?" });
  });

  it("failed turn that ran tools renders working-only (user + tools, no assistant)", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "run the build" }, "agt_scribe"),
      toolUse(2, "run_command", "npm test"),
      toolUse(3, "run_command", "npm run build", false),
    ]);

    expect(items.map((i) => i.kind)).toEqual(["user", "turn"]);
    const turn = items[1];
    if (turn.kind !== "turn") throw new Error("expected turn");
    expect(turn.finalText).toBe("");
    expect(turn.working).toHaveLength(2);
  });

  it("thinking-only turn (no tools): thinking folds into working, answer stays finalText", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "hi" }, "agt_scribe"),
      ev(2, "message.assistant", { role: "assistant", content: "Hello!", thinking: "simple greeting", thinkingMs: 3200 }, "agt_scribe"),
    ]);

    const turn = items[1];
    if (turn.kind !== "turn") throw new Error("expected turn");
    expect(turn.working).toHaveLength(1);
    expect(turn.working[0]).toMatchObject({ type: "thinking", text: "simple greeting", thinkingMs: 3200 });
    expect(turn.finalText).toBe("Hello!");
  });

  it("approval.requested/resolved fold into working entries and resolve in place", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "install deps" }, "agt_scribe"),
      ev(2, "approval.requested", { approvalId: "appr_1", toolName: "run_command", argsSummary: "npm install left-pad", category: "confirm" }, "agt_scribe"),
      ev(3, "approval.resolved", { approvalId: "appr_1", decision: "approved", remember: "always" }, "agt_scribe"),
      toolUse(4, "run_command", "npm install left-pad"),
      ev(5, "message.assistant", { role: "assistant", content: "Installed." }, "agt_scribe"),
    ]);

    const turn = items[1];
    if (turn.kind !== "turn") throw new Error("expected turn");
    const approval = turn.working.find((w) => w.type === "approval");
    expect(approval).toMatchObject({
      approvalId: "appr_1",
      toolName: "run_command",
      argsSummary: "npm install left-pad",
      category: "confirm",
      status: "approved",
      remember: "always",
    });
    // a pending (unresolved) approval keeps status pending
    const pending = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "go" }, "agt_scribe"),
      ev(2, "approval.requested", { approvalId: "appr_9", toolName: "run_command", argsSummary: "rm tmp", category: "confirm" }, "agt_scribe"),
    ]);
    const pTurn = pending[1];
    if (pTurn.kind !== "turn") throw new Error("expected turn");
    expect(pTurn.working.find((w) => w.type === "approval")).toMatchObject({ status: "pending" });
  });

  it("keeps write/edit tools inside working with ok flags (diff cards render there) + tolerant argsSummary parse", () => {
    const items = toProjectChatItems([
      toolUse(1, "write_file", "path: src/full.ts, content: 128 chars"),
      toolUse(2, "read_file", "path: b.ts"),
      toolUse(3, "edit_file", "path: c.ts, content: 30 chars", false),
      toolUse(4, "edit_file", "content: 64 chars"),
      toolUse(5, "edit_file", "touched something, details unknown"),
      toolUse(6, "write_file", "path: src/no-chars.ts"),
    ]);

    expect(items.map((i) => i.kind)).toEqual(["turn"]);
    const turn = items[0];
    if (turn.kind !== "turn") throw new Error("expected turn");
    const tools = turn.working.filter((w) => w.type === "tool").map((w) => (w as { tool: { toolName: string; ok: boolean; argsSummary: string } }).tool);
    expect(tools.map((t) => t.toolName)).toEqual(["write_file", "read_file", "edit_file", "edit_file", "edit_file", "write_file"]);
    expect(tools.map((t) => t.ok)).toEqual([true, true, false, true, true, true]);
    const parsed = tools
      .filter((t) => t.toolName === "write_file" || t.toolName === "edit_file")
      .map((t) => parseDiffArgs(t.argsSummary));
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toMatchObject({ path: "src/full.ts", chars: 128 });
    expect(parsed[1]).toMatchObject({ path: "c.ts", chars: 30 });
    expect(parsed[2]).toMatchObject({ path: null, chars: 64 });
    expect(parsed[3]).toMatchObject({ path: null, chars: null });
    expect(parsed[4]).toMatchObject({ path: "src/no-chars.ts", chars: null });
  });

  it("delegate_task tool rows keep their args/output summaries intact (SubAgentCard parses them)", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "delegate" }, "agt_scribe"),
      toolUse(2, "delegate_task", "role: coder, task: write tests"),
    ]);
    const turn = items[1];
    if (turn.kind !== "turn") throw new Error("expected turn");
    const entry = turn.working[0];
    if (entry.type !== "tool") throw new Error("expected tool entry");
    expect(entry.tool.toolName).toBe("delegate_task");
    expect(entry.tool.argsSummary).toBe("role: coder, task: write tests");
  });

  it("ignores unknown event types (and messages without string content)", () => {
    const items = toProjectChatItems([
      ev(1, "session.started", { at: TS(1) }),
      ev(2, "todo.updated", { items: [] }),
      ev(3, "message.user", { role: "user" }),
      ev(4, "message.assistant", { role: "assistant", content: "Still here." }, "agt_scribe"),
    ]);

    expect(items).toEqual([
      { kind: "turn", seq: 4, agentId: "agt_scribe", ts: TS(4), endTs: TS(4), working: [], finalText: "Still here." },
    ]);
  });

  it("drops fully-empty turns (no working, no final text)", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "hi" }, "agt_scribe"),
      ev(2, "message.assistant", { role: "assistant", content: "" }, "agt_scribe"),
      ev(3, "message.user", { role: "user", content: "again" }, "agt_scribe"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "user"]);
  });
});

// Round-28 WS-D3: unified-diff computation for the DiffCard.
describe("computeUnifiedDiff", () => {
  it("returns all-add lines when before is null (file created)", () => {
    const lines = computeUnifiedDiff(null, "line1\nline2\nline3");
    expect(lines).toEqual([
      { type: "add", text: "line1" },
      { type: "add", text: "line2" },
      { type: "add", text: "line3" },
    ]);
  });

  it("returns all-del lines when after is null (file deleted)", () => {
    const lines = computeUnifiedDiff("gone1\ngone2", null);
    expect(lines).toEqual([
      { type: "del", text: "gone1" },
      { type: "del", text: "gone2" },
    ]);
  });

  it("marks changed lines as add/del and unchanged as ctx", () => {
    const before = "keep\nold\nshared";
    const after = "keep\nnew\nshared";
    const lines = computeUnifiedDiff(before, after);
    expect(lines).toEqual([
      { type: "ctx", text: "keep" },
      { type: "del", text: "old" },
      { type: "add", text: "new" },
      { type: "ctx", text: "shared" },
    ]);
  });

  it("handles insertion at the end", () => {
    const before = "a\nb";
    const after = "a\nb\nc";
    const lines = computeUnifiedDiff(before, after);
    expect(lines).toEqual([
      { type: "ctx", text: "a" },
      { type: "ctx", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  it("truncates diffs longer than 200 lines", () => {
    const big = Array.from({ length: 300 }, (_, i) => `line${i}`).join("\n");
    const lines = computeUnifiedDiff(null, big);
    expect(lines).toHaveLength(200);
  });
});

// ROUND-46 (R46-c): the checkpoint-restore client fn (POST /checkpoints/:id/restore).
describe("restoreCheckpoint (ROUND-46 R46-c)", () => {
  it("POSTs /checkpoints/:id/restore and returns the route's response body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { restored: true, message: "restored src/app.ts to previous content" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await restoreCheckpoint("snap_abc123");

    expect(result).toEqual({ restored: true, message: "restored src/app.ts to previous content" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/checkpoints/snap_abc123/restore");
    expect(init.method).toBe("POST");
    // Bodyless POST — the restore route reads nothing from the request.
    expect(init.body).toBeUndefined();
  });

  it("maps the restore error envelope onto ApiError (404 unknown checkpoint)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          error: { code: "NOT_FOUND", message: "no checkpoint with id snap_missing" },
        }),
      ),
    );

    const err = await restoreCheckpoint("snap_missing").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("no checkpoint with id snap_missing");
    expect(err.isNetwork).toBe(false);
  });
});

// ROUND-47 (R47-c1): the consolidated provider-management layer — every fn
// ModelsProvidersTab's local useApi() used to serve, now through request()
// + ApiError (URL, method, body, envelope unwrapping, error mapping).
describe("provider management (ROUND-47 R47-c1)", () => {
  const PROVIDER: ProviderView = {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "chat-completions",
    enabled: true,
    createdAt: "2026-08-21T09:00:00Z",
    hasKey: true,
  };

  const MODEL_ROW: ProviderModelConfig = {
    id: "mdl_1",
    providerId: "openrouter",
    modelId: "z-ai/glm-5.2:free",
    displayName: "Z.ai: GLM 5.2",
    contextWindow: 256000,
    maxOutputTokens: 230400,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    supportsThinking: false,
    hidden: false,
    sortOrder: 0,
    createdAt: "2026-08-22T09:00:00Z",
    updatedAt: "2026-08-22T09:00:00Z",
  };

  /** Assert the single fetch call's URL/method/body in one go. */
  function expectCall(
    fetchMock: ReturnType<typeof vi.fn>,
    url: string,
    method: string,
    body?: unknown,
  ) {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe(method);
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok_123" });
    if (body !== undefined) {
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual(body);
    }
  }

  it("fetchProviders GETs /providers and unwraps the envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { providers: [PROVIDER] }));
    vi.stubGlobal("fetch", fetchMock);

    const providers = await fetchProviders();

    expect(providers).toEqual([PROVIDER]);
    expectCall(fetchMock, "http://sidecar.test/api/v1/providers", "GET");
  });

  it("fetchProviders maps the error envelope onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(502, { error: { code: "PROVIDER_ERROR", message: "upstream down" } }),
      ),
    );

    const err = await fetchProviders().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.message).toBe("upstream down");
  });

  it("createProvider POSTs the Add-Provider payload (no key in the body)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, PROVIDER));
    vi.stubGlobal("fetch", fetchMock);

    const created = await createProvider({
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiFormat: "chat-completions",
      id: "openrouter",
    });

    expect(created).toEqual(PROVIDER);
    expectCall(fetchMock, "http://sidecar.test/api/v1/providers", "POST", {
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiFormat: "chat-completions",
      id: "openrouter",
    });
  });

  it("createProvider surfaces a 409 CONFLICT (preset id already exists)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: "CONFLICT", message: "provider 'openrouter' already exists" },
        }),
      ),
    );

    const err = await createProvider({ name: "OpenRouter", baseUrl: "https://x.dev/v1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("CONFLICT");
  });

  it("updateProvider PATCHes /providers/:id with the patch body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ...PROVIDER, enabled: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateProvider("openrouter", { enabled: false });

    expect(updated.enabled).toBe(false);
    expectCall(fetchMock, "http://sidecar.test/api/v1/providers/openrouter", "PATCH", {
      enabled: false,
    });
  });

  it("updateProvider maps a 404 (unknown provider) onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, { error: { code: "NOT_FOUND", message: "no provider with id ghost" } }),
      ),
    );

    const err = await updateProvider("ghost", { name: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("no provider with id ghost");
  });

  it("deleteProvider DELETEs /providers/:id and resolves on 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteProvider("openrouter")).resolves.toBeUndefined();
    expectCall(fetchMock, "http://sidecar.test/api/v1/providers/openrouter", "DELETE");
  });

  it("deleteProvider surfaces the agents-still-reference 409 honestly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: "CONFLICT", message: "1 agent still uses 'OpenRouter' (Coder)" },
        }),
      ),
    );

    const err = await deleteProvider("openrouter").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toContain("still uses");
  });

  it("storeProviderKey PUTs {value} to /providers/:id/key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(storeProviderKey("openrouter", "sk-or-v1-abc123")).resolves.toBeUndefined();
    expectCall(
      fetchMock,
      "http://sidecar.test/api/v1/providers/openrouter/key",
      "PUT",
      { value: "sk-or-v1-abc123" },
    );
  });

  it("storeProviderKey maps a 400 (empty value) onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          error: { code: "VALIDATION", message: "value must be a non-empty string" },
        }),
      ),
    );

    const err = await storeProviderKey("openrouter", "  ").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION");
  });

  it("testProviderConnection POSTs an empty body by default (primary key, reachability)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, latencyMs: 312, message: "Reachable — pick a model for a full key + model test." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testProviderConnection("openrouter");

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBe(312);
    expect(result.message).toContain("Reachable");
    expectCall(fetchMock, "http://sidecar.test/api/v1/providers/openrouter/test", "POST", {});
  });

  it("testProviderConnection sends {slot, model} when scoped — the R47-b contract body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, latencyMs: 87, model: "z-ai/glm-5.2:free" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testProviderConnection("openrouter", {
      slot: 3,
      model: "z-ai/glm-5.2:free",
    });

    expect(result).toEqual({ ok: true, latencyMs: 87, model: "z-ai/glm-5.2:free" });
    expectCall(fetchMock, "http://sidecar.test/api/v1/providers/openrouter/test", "POST", {
      slot: 3,
      model: "z-ai/glm-5.2:free",
    });
  });

  it("testProviderConnection: ok:false arrives at HTTP 200 and RESOLVES (probe ran, provider said no)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: false, message: "key rejected by provider (HTTP 401)" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(testProviderConnection("openrouter")).resolves.toEqual({
      ok: false,
      message: "key rejected by provider (HTTP 401)",
    });
  });

  it("testProviderConnection maps the empty-slot 409 onto ApiError (R47-b contract)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: {
            code: "CONFLICT",
            message: "no API key stored for provider 'openrouter' slot 7",
          },
        }),
      ),
    );

    const err = await testProviderConnection("openrouter", { slot: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("no API key stored for provider 'openrouter' slot 7");
  });

  it("fetchProviderModelConfig GETs /providers/:id/models-config and unwraps models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { models: [MODEL_ROW] }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchProviderModelConfig("openrouter");

    expect(models).toEqual([MODEL_ROW]);
    expectCall(
      fetchMock,
      "http://sidecar.test/api/v1/providers/openrouter/models-config",
      "GET",
    );
  });

  it("fetchProviderModelConfig maps a 404 (unknown provider) onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, { error: { code: "NOT_FOUND", message: "no provider with id ghost" } }),
      ),
    );

    const err = await fetchProviderModelConfig("ghost").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  it("upsertProviderModelConfig POSTs the model row payload to /providers/:id/models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, MODEL_ROW));
    vi.stubGlobal("fetch", fetchMock);

    const created = await upsertProviderModelConfig("openrouter", {
      modelId: "z-ai/glm-5.2:free",
      displayName: "Z.ai: GLM 5.2",
    });

    expect(created).toEqual(MODEL_ROW);
    expectCall(fetchMock, "http://sidecar.test/api/v1/providers/openrouter/models", "POST", {
      modelId: "z-ai/glm-5.2:free",
      displayName: "Z.ai: GLM 5.2",
    });
  });

  it("upsertProviderModelConfig maps a 400 (missing modelId) onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          error: { code: "VALIDATION", message: "modelId must be a non-empty string" },
        }),
      ),
    );

    const err = await upsertProviderModelConfig("openrouter", { modelId: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION");
  });

  it("updateProviderModelConfig PATCHes /models/:id with the patch body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ...MODEL_ROW, displayName: "Renamed", contextWindow: 128000 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateProviderModelConfig("mdl_1", {
      displayName: "Renamed",
      contextWindow: 128000,
    });

    expect(updated.displayName).toBe("Renamed");
    expectCall(fetchMock, "http://sidecar.test/api/v1/models/mdl_1", "PATCH", {
      displayName: "Renamed",
      contextWindow: 128000,
    });
  });

  // ROUND-50 (R50-d): the per-model config dialog writes the FULL advanced
  // field set — every pricing/limit field + explicit nulls must survive the
  // wire verbatim (null clears to "unknown", never silently dropped).
  it("updateProviderModelConfig round-trips the full advanced config incl. null clears (R50-d)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ...MODEL_ROW,
        displayName: "Priced Model",
        contextWindow: 200000,
        maxOutputTokens: null,
        inputPricePerMtok: 0.15,
        inputPriceCachedPerMtok: null,
        outputPricePerMtok: 0.6,
        supportsThinking: true,
        hidden: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const patch = {
      displayName: "Priced Model",
      contextWindow: 200000,
      maxOutputTokens: null,
      inputPricePerMtok: 0.15,
      inputPriceCachedPerMtok: null,
      outputPricePerMtok: 0.6,
      supportsThinking: true,
      hidden: true,
    };
    const updated = await updateProviderModelConfig("mdl_1", patch);

    expect(updated).toMatchObject({
      inputPricePerMtok: 0.15,
      inputPriceCachedPerMtok: null,
      outputPricePerMtok: 0.6,
      maxOutputTokens: null,
      supportsThinking: true,
      hidden: true,
    });
    expectCall(fetchMock, "http://sidecar.test/api/v1/models/mdl_1", "PATCH", patch);
  });

  it("updateProviderModelConfig maps a 404 (unknown model row) onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, { error: { code: "NOT_FOUND", message: "no model with id mdl_x" } }),
      ),
    );

    const err = await updateProviderModelConfig("mdl_x", { hidden: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("no model with id mdl_x");
  });

  it("deleteProviderModelConfig DELETEs /models/:id and resolves on 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteProviderModelConfig("mdl_1")).resolves.toBeUndefined();
    expectCall(fetchMock, "http://sidecar.test/api/v1/models/mdl_1", "DELETE");
  });

  it("deleteProviderModelConfig maps a 404 onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, { error: { code: "NOT_FOUND", message: "no model with id mdl_x" } }),
      ),
    );

    const err = await deleteProviderModelConfig("mdl_x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  it("fetchModelsCatalog GETs /models/catalog with the R47-b contract payload", async () => {
    const catalog = {
      models: [
        {
          modelId: "z-ai/glm-5.2:free",
          displayName: "Z.ai: GLM 5.2",
          contextWindow: 256000,
          maxOutputTokens: 230400,
          inputPricePerMtok: 0,
          inputPriceCachedPerMtok: null,
          outputPricePerMtok: 0,
          free: true,
          supportsTools: true,
          supportsStructuredOutputs: true,
          supportsVision: false,
        },
      ],
      defaultModelId: "z-ai/glm-5.2:free",
      subagentDefaultModelId: "nvidia/nemotron-3.5-lightning:free",
      recommendedModelIds: ["z-ai/glm-5.2:free"],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, catalog));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchModelsCatalog()).resolves.toEqual(catalog);
    expectCall(fetchMock, "http://sidecar.test/api/v1/models/catalog", "GET");
  });

  it("fetchModelsCatalog maps a non-2xx onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(500, { error: { code: "INTERNAL", message: "catalog unavailable" } }),
      ),
    );

    const err = await fetchModelsCatalog().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });

  // ROUND-50 (R50-d): the "Add models" picker's catalog source — the LIVE
  // provider catalog WITH display names (ids alone can't power a searchable
  // multi-select).
  it("fetchProviderModelEntries GETs /providers/:id/models and keeps id + name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        models: [
          { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
          { id: "openai/gpt-4o" }, // nameless entry falls back to the id
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const entries = await fetchProviderModelEntries("openrouter");

    expect(entries).toEqual([
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "openai/gpt-4o" },
    ]);
    expectCall(fetchMock, "http://sidecar.test/api/v1/providers/openrouter/models", "GET");
  });

  it("fetchProviderModelEntries maps an upstream 502 onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(502, {
          error: { code: "PROVIDER_ERROR", message: "GET https://x/models failed: timeout" },
        }),
      ),
    );

    const err = await fetchProviderModelEntries("openrouter").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
  });
});

// ROUND-47 (R47-c1): OrchestrationSettings finally carries subagentModel
// (the backend has sent it since R43-5; SubAgentsTab type-widens locally).
describe("orchestration settings (subagentModel, ROUND-47 R47-c1)", () => {
  it("fetchOrchestrationSettings returns subagentModel verbatim (null default)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { maxParallel: 5, perKeyLimit: 3, subagentModel: null }),
      ),
    );

    await expect(fetchOrchestrationSettings()).resolves.toEqual({
      maxParallel: 5,
      perKeyLimit: 3,
      subagentModel: null,
    });
  });

  it("updateOrchestrationSettings sends subagentModel through (string or null)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        maxParallel: 5,
        perKeyLimit: 3,
        subagentModel: "nvidia/nemotron-3.5-lightning:free",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateOrchestrationSettings({
      subagentModel: "nvidia/nemotron-3.5-lightning:free",
    });

    expect(updated.subagentModel).toBe("nvidia/nemotron-3.5-lightning:free");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/settings/orchestration");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      subagentModel: "nvidia/nemotron-3.5-lightning:free",
    });
  });
});

// ── ROUND-50 (R50-c1): the composer's backend helpers ───────────────────────

import {
  fetchSessionContext,
  httpSessions,
  patchSessionPermissions,
  pickFilesViaBackend,
  readAttachmentFiles,
  streamSessionMessage,
  type SessionContextReport,
} from "./api";

describe("pickFilesViaBackend (ROUND-50 R50-c1)", () => {
  it("inside Tauri: invokes the Rust pick_files command and returns the paths", async () => {
    const invoke = vi.fn().mockResolvedValue(["C:\\Users\\owner\\Docs\\a.md", "C:\\Users\\owner\\Docs\\b.md"]);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    try {
      const files = await pickFilesViaBackend();
      expect(files).toEqual(["C:\\Users\\owner\\Docs\\a.md", "C:\\Users\\owner\\Docs\\b.md"]);
      expect(invoke).toHaveBeenCalledWith("pick_files");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Tauri invoke with a non-array result resolves to [] (defensive)", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    try {
      await expect(pickFilesViaBackend()).resolves.toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("browser dev: posts to the sidecar /internal/dialog/files with the bearer token and unwraps files", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { files: ["/home/owner/notes.md", "/home/owner/spec.ts"] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const files = await pickFilesViaBackend();
    expect(files).toEqual(["/home/owner/notes.md", "/home/owner/spec.ts"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/internal/dialog/files");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_123");
  });

  it("501 (no dialog backend on this machine) resolves to [] — a cancel, never an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(501, {})));
    await expect(pickFilesViaBackend()).resolves.toEqual([]);
  });

  it("HTTP failure and dialog errors THROW (callers surface the failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    await expect(pickFilesViaBackend()).rejects.toThrow(/HTTP 500/);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { files: [], error: "zenity missing" })));
    await expect(pickFilesViaBackend()).rejects.toThrow(/zenity missing/);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(pickFilesViaBackend()).rejects.toThrow(/could not open the file picker/);
  });
});

describe("pickFolderViaBackend (R54: bounded dialog fetch)", () => {
  it("posts to the sidecar /internal/dialog/folder with the bearer token and unwraps the path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { path: "C:\\Users\\owner\\Projects\\my-app" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const picked = await pickFolderViaBackend();
    expect(picked).toEqual({ path: "C:\\Users\\owner\\Projects\\my-app" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/internal/dialog/folder");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_123");
    // The fetch is bounded — a hung OS dialog must not spin Browse forever.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("501 (no dialog backend) reports unavailable — the caller points at manual entry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(501, {})));
    const picked = await pickFolderViaBackend();
    expect(picked).toEqual({ path: null, unavailable: true });
  });

  it("HTTP failure and dialog errors are surfaced, never silenced as 'cancelled'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    await expect(pickFolderViaBackend()).resolves.toMatchObject({ error: /HTTP 500/ });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { path: null, error: "PowerShell blocked" })));
    await expect(pickFolderViaBackend()).resolves.toMatchObject({ error: /PowerShell blocked/ });
  });

  it("a network failure reports why it could not reach the sidecar", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(pickFolderViaBackend()).resolves.toMatchObject({ error: /could not reach the sidecar/ });
  });

  it("the 2-minute timeout aborts the fetch and tells the owner to paste instead", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
        ),
      );
      const pending = pickFolderViaBackend();
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(pending).resolves.toMatchObject({
        error: /timed out — paste the folder path instead/,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readAttachmentFiles (ROUND-50 R50-c1)", () => {
  it("posts { paths, projectId } and unwraps the files array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        files: [
          { path: "notes.md", name: "notes.md", size: 16, text: "hello attachment", truncated: false },
          { path: "logo.png", name: "logo.png", size: 4096, text: null, truncated: false },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const files = await readAttachmentFiles(["notes.md", "logo.png"], "proj_1");
    expect(files).toHaveLength(2);
    expect(files[0].text).toBe("hello attachment");
    expect(files[1].text).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/attachments/read");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ paths: ["notes.md", "logo.png"], projectId: "proj_1" });
  });

  it("omits projectId when not given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { files: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await readAttachmentFiles(["/abs/path.txt"]);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
      paths: ["/abs/path.txt"],
    });
  });

  it("maps the API.md error envelope onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          error: { code: "VALIDATION", message: "at most 20 paths per request", details: { field: "body.paths" } },
        }),
      ),
    );
    const err = await readAttachmentFiles(Array.from({ length: 21 }, (_, i) => `f${i}`)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("VALIDATION");
  });
});

describe("patchSessionPermissions (ROUND-50 R50-c1)", () => {
  it("PATCHes { mode } and returns the session-detail shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "sess_1",
        projectId: null,
        agentId: "agt_1",
        mode: "single",
        status: "queued",
        title: null,
        createdAt: "2026-08-30T00:00:00Z",
        updatedAt: "2026-08-30T00:00:00Z",
        parentSessionId: null,
        subRole: null,
        permissionMode: "plan",
        events: [],
        lastSeq: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await patchSessionPermissions("sess_1", "plan");
    expect(updated.permissionMode).toBe("plan");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/sessions/sess_1/permissions");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ mode: "plan" });
  });

  it("400 VALIDATION for an unknown mode surfaces as ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          error: { code: "VALIDATION", message: "mode must be one of full|ask|plan|editor", details: { field: "body.mode" } },
        }),
      ),
    );
    const err = await patchSessionPermissions("sess_1", "yolo" as "plan").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.details).toEqual({ field: "body.mode" });
  });
});

describe("fetchSessionContext (ROUND-50 R50-c1)", () => {
  const report: SessionContextReport = {
    model: "test/model-1",
    providerId: "openrouter",
    contextWindow: 200_000,
    usedTokens: 12_345,
    breakdown: { systemPrompt: 800, systemTools: 4200, memory: 350, messages: 6500, meta: 200, mcpTools: 0 },
    cache: { inputTokens: 50_000, cachedInputTokens: 41_000, hitRate: 0.82 },
    sessionTotals: { inputTokens: 50_000, outputTokens: 12_000, requests: 17, costUsd: 0.42 },
  };

  it("GETs /sessions/:id/context and returns the report verbatim", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, report));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSessionContext("sess_1");
    expect(result).toEqual(report);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/sessions/sess_1/context");
  });

  it("?model= rides the query string (the per-send picker)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, report));
    vi.stubGlobal("fetch", fetchMock);
    await fetchSessionContext("sess_1", "z-ai/glm-5.2:free");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/sessions/sess_1/context?model=z-ai%2Fglm-5.2%3Afree");
  });
});

describe("composer send passthrough (ROUND-50 R50-c1)", () => {
  it("httpSessions().sendMessage threads attachments + thinkingLevel into the POST body (and omits defaults)", async () => {
    // A fresh Response per call (a body can only be read once).
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse(200, {
        assistantMessage: { seq: 2, role: "assistant", agentId: "a", content: "ok", ts: "t" },
        usage: { agentId: "a", sessionId: "s", provider: "p", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, ts: "t" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await httpSessions().sendMessage("sess_1", "review this", {
      attachments: [{ name: "a.ts", path: "src/a.ts", size: 11, text: "const a=1;" }],
      thinkingLevel: "high",
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/sessions/sess_1/messages");
    let init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      content: "review this",
      attachments: [{ name: "a.ts", path: "src/a.ts", size: 11, text: "const a=1;" }],
      thinkingLevel: "high",
    });

    // Defaults are NOT shipped: absent extras → a plain {content} body.
    fetchMock.mockClear();
    await httpSessions().sendMessage("sess_1", "plain", { thinkingLevel: "default" });
    init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ content: "plain" });
  });

  it("streamSessionMessage threads attachments + thinkingLevel into the stream POST body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("data: {\"type\":\"done\"}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: string[] = [];
    await streamSessionMessage("sess_1", "review this", (e) => events.push(e.type), {
      model: "test/model-1",
      thinkingLevel: "max",
      attachments: [{ name: "spec.md", size: 6, text: "# spec" }],
    });
    expect(events).toContain("done");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar.test/api/v1/sessions/sess_1/messages/stream");
    expect(JSON.parse(init.body as string)).toEqual({
      content: "review this",
      model: "test/model-1",
      thinkingLevel: "max",
      attachments: [{ name: "spec.md", size: 6, text: "# spec" }],
    });
  });
});

describe("toProjectChatItems attachment passthrough (ROUND-50 R50-c1)", () => {
  it("user items carry DISPLAY-ONLY AttachmentRefs — the file text never ships back to the UI", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", {
        role: "user",
        content: "review these",
        attachments: [
          { name: "a.ts", path: "src/a.ts", size: 11, text: "SECRET-FILE-CONTENT" },
          { name: "logo.png", path: "assets/logo.png", size: 4096, text: null },
          { name: "no-meta.md" },
          // Junk entries are dropped, never crash the fold.
          { path: "no-name.txt" },
          "garbage",
        ],
      }, "agt_scribe"),
      ev(2, "message.assistant", { role: "assistant", content: "Reviewed." }, "agt_scribe"),
    ]);

    expect(items.map((i) => i.kind)).toEqual(["user", "turn"]);
    const user = items[0];
    if (user.kind !== "user") throw new Error("expected user item");
    expect(user.content).toBe("review these");
    expect(user.attachments).toEqual([
      { name: "a.ts", path: "src/a.ts", size: 11 },
      { name: "logo.png", path: "assets/logo.png", size: 4096 },
      { name: "no-meta.md" },
    ]);
    // The TEXT is never echoed into the UI item (display-only contract).
    expect(JSON.stringify(user.attachments)).not.toContain("SECRET-FILE-CONTENT");

    // No attachments on the payload → no attachments key on the item.
    const plain = toProjectChatItems([ev(1, "message.user", { role: "user", content: "hi" }, "agt_scribe")]);
    const plainUser = plain[0];
    if (plainUser.kind !== "user") throw new Error("expected user item");
    expect(plainUser.attachments).toBeUndefined();
  });
});
