import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  computeUnifiedDiff,
  getAgentsBackend,
  httpAgents,
  parseDiffArgs,
  restoreCheckpoint,
  toProjectChatItems,
  type Agent,
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
