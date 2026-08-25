import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  computeUnifiedDiff,
  getAgentsBackend,
  httpAgents,
  parseDiffArgs,
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

describe("toProjectChatItems", () => {
  it("orders user → activity (all tools of the turn) → ai from an event log", () => {
    const items = toProjectChatItems([
      ev(
        1,
        "message.user",
        { role: "user", content: "Add rate limiting to the middleware" },
        "agt_scribe",
      ),
      toolUse(2, "list_dir", "path: src"),
      toolUse(3, "write_file", "path: src/middleware.ts, content: 128 chars"),
      ev(
        4,
        "message.assistant",
        { role: "assistant", content: "Done — limiter added." },
        "agt_scribe",
      ),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["user", "activity", "ai"]);
    expect(items[0]).toEqual({
      kind: "user",
      seq: 1,
      content: "Add rate limiting to the middleware",
      ts: TS(1),
    });
    expect(items[1]).toEqual({
      kind: "activity",
      seqStart: 2,
      seqEnd: 3,
      tools: [
        { seq: 2, toolName: "list_dir", argsSummary: "path: src", ok: true, ts: TS(2) },
        {
          seq: 3,
          toolName: "write_file",
          argsSummary: "path: src/middleware.ts, content: 128 chars",
          ok: true,
          ts: TS(3),
        },
      ],
      ts: TS(2),
      endTs: TS(3),
    });
    expect(items[2]).toEqual({
      kind: "ai",
      seq: 4,
      content: "Done — limiter added.",
      agentId: "agt_scribe",
      ts: TS(4),
    });
  });

  it("interleaves activity blocks at the point tools ran — one block per maximal tool run (round-33)", () => {
    const items = toProjectChatItems([
      toolUse(1, "list_dir", "path: ."),
      toolUse(2, "read_file", "path: package.json"),
      ev(3, "message.assistant", { role: "assistant", content: "continuing…" }, "agt_scribe"),
      toolUse(4, "read_file", "path: src/index.ts"),
      ev(5, "message.assistant", { role: "assistant", content: "done" }, "agt_scribe"),
    ]);

    // Tools split by an interim assistant reply → TWO activity blocks,
    // interleaved exactly where the work happened.
    expect(items.map((item) => item.kind)).toEqual(["activity", "ai", "activity", "ai"]);
    const [first, second] = items.filter((i) => i.kind === "activity");
    expect(first.tools.map((t) => t.seq)).toEqual([1, 2]);
    expect(second.tools.map((t) => t.seq)).toEqual([4]);
    expect(first.seqStart).toBe(1);
    expect(first.seqEnd).toBe(2);
    expect(second.seqStart).toBe(4);
  });

  it("ROUND-35: parses thinking into ai items and merges stats carriers into the previous message", () => {
    const items = toProjectChatItems([
      ev(1, "message.user", { role: "user", content: "go" }, "agt_scribe"),
      ev(2, "message.assistant", { role: "assistant", content: "Creating now.", thinking: "plan first" }, "agt_scribe"),
      toolUse(3, "write_file", "path: a.ts, content: 5 chars"),
      // stats carrier: empty content + usage → merges into item at seq 2
      ev(4, "message.assistant", { role: "assistant", content: "", usage: { inputTokens: 7, outputTokens: 3 }, ms: 120, model: "m" }, "agt_scribe"),
    ]);

    // Chronological: user → ai(segment) → activity; the carrier (seq 4)
    // merged into the ai item and vanished.
    expect(items.map((i) => i.kind)).toEqual(["user", "ai", "activity"]);
    const ai = items[1];
    if (ai.kind !== "ai") throw new Error("expected ai");
    // The carrier vanished; its stats landed on the real message; thinking parsed.
    expect(ai.content).toBe("Creating now.");
    expect(ai.thinking).toBe("plan first");
    expect(ai.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(ai.ms).toBe(120);
    expect(ai.model).toBe("m");
  });

  it("splits tool runs of DIFFERENT turns into separate activity blocks", () => {
    const items = toProjectChatItems([
      toolUse(1, "list_dir", "path: ."),
      ev(2, "message.assistant", { role: "assistant", content: "first done" }, "agt_scribe"),
      ev(3, "message.user", { role: "user", content: "next task" }, "agt_scribe"),
      toolUse(4, "read_file", "path: src/index.ts"),
      ev(5, "message.assistant", { role: "assistant", content: "second done" }, "agt_scribe"),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["activity", "ai", "user", "activity", "ai"]);
    const blocks = items.filter((i) => i.kind === "activity");
    expect(blocks).toHaveLength(2);
  });



  it("keeps write/edit tools inside the activity block (diff cards render there)", () => {
    const items = toProjectChatItems([
      toolUse(1, "write_file", "path: a.ts, content: 10 chars"),
      toolUse(2, "read_file", "path: b.ts"),
      toolUse(3, "edit_file", "path: c.ts, content: 30 chars", false),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["activity"]);
    const activity = items[0];
    if (activity.kind !== "activity") throw new Error("expected activity");
    expect(activity.tools.map((t) => t.toolName)).toEqual([
      "write_file",
      "read_file",
      "edit_file",
    ]);
    expect(activity.tools.map((t) => t.ok)).toEqual([true, true, false]);
  });

  it("parses argsSummary tolerantly (full format, missing chars, missing path)", () => {
    const items = toProjectChatItems([
      toolUse(1, "write_file", "path: src/full.ts, content: 128 chars"),
      toolUse(2, "write_file", "path: src/no-chars.ts"),
      toolUse(3, "edit_file", "content: 64 chars"),
      toolUse(4, "edit_file", "touched something, details unknown"),
    ]);

    const activity = items[0];
    if (activity.kind !== "activity") throw new Error("expected activity");
    const parsed = activity.tools
      .filter((t) => t.toolName === "write_file" || t.toolName === "edit_file")
      .map((t) => parseDiffArgs(t.argsSummary));
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({ path: "src/full.ts", chars: 128 });
    expect(parsed[1]).toMatchObject({ path: "src/no-chars.ts", chars: null });
    expect(parsed[2]).toMatchObject({ path: null, chars: 64 });
    expect(parsed[3]).toMatchObject({ path: null, chars: null });
  });

  it("ignores unknown event types (and messages without string content)", () => {
    const items = toProjectChatItems([
      ev(1, "session.started", { at: TS(1) }),
      ev(2, "todo.updated", { items: [] }),
      ev(3, "message.user", { role: "user" }),
      ev(4, "message.assistant", { role: "assistant", content: "Still here." }, "agt_scribe"),
    ]);

    expect(items).toEqual([
      { kind: "ai", seq: 4, content: "Still here.", agentId: "agt_scribe", ts: TS(4) },
    ]);
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
