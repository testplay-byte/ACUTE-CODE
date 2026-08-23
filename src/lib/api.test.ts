import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  getAgentsBackend,
  httpAgents,
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
  it("orders user → grouped tools → diff → ai from an event log", () => {
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

    expect(items.map((item) => item.kind)).toEqual(["user", "tools", "diff", "ai"]);
    expect(items[0]).toEqual({
      kind: "user",
      seq: 1,
      content: "Add rate limiting to the middleware",
      ts: TS(1),
    });
    expect(items[1]).toEqual({
      kind: "tools",
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
    });
    expect(items[2]).toEqual({
      kind: "diff",
      entry: {
        seq: 3,
        toolName: "write_file",
        path: "src/middleware.ts",
        chars: 128,
        ok: true,
        ts: TS(3),
      },
    });
    expect(items[3]).toEqual({
      kind: "ai",
      seq: 4,
      content: "Done — limiter added.",
      agentId: "agt_scribe",
      ts: TS(4),
    });
  });

  it("merges a consecutive tool.use run into ONE tools item; separate runs stay separate", () => {
    const items = toProjectChatItems([
      toolUse(1, "list_dir", "path: ."),
      toolUse(2, "read_file", "path: package.json"),
      ev(3, "message.assistant", { role: "assistant", content: "thinking…" }, "agt_scribe"),
      toolUse(4, "read_file", "path: src/index.ts"),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["tools", "ai", "tools"]);
    const toolsRuns = items.flatMap((item) => (item.kind === "tools" ? [item] : []));
    expect(toolsRuns).toHaveLength(2);
    expect(toolsRuns[0]).toMatchObject({ seqStart: 1, seqEnd: 2 });
    expect(toolsRuns[0].tools).toHaveLength(2);
    expect(toolsRuns[1]).toMatchObject({ seqStart: 4, seqEnd: 4 });
    expect(toolsRuns[1].tools).toHaveLength(1);
  });

  it("emits one diff card per write/edit call in a run, in order", () => {
    const items = toProjectChatItems([
      toolUse(1, "write_file", "path: a.ts, content: 10 chars"),
      toolUse(2, "read_file", "path: b.ts"),
      toolUse(3, "edit_file", "path: c.ts, content: 30 chars", false),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["tools", "diff", "diff"]);
    const entries = items.flatMap((item) => (item.kind === "diff" ? [item.entry] : []));
    expect(entries.map((entry) => entry.path)).toEqual(["a.ts", "c.ts"]);
    expect(entries.map((entry) => entry.ok)).toEqual([true, false]);
  });

  it("parses argsSummary tolerantly (full format, missing chars, missing path)", () => {
    const items = toProjectChatItems([
      toolUse(1, "write_file", "path: src/full.ts, content: 128 chars"),
      toolUse(2, "write_file", "path: src/no-chars.ts"),
      toolUse(3, "edit_file", "content: 64 chars"),
      toolUse(4, "edit_file", "touched something, details unknown"),
    ]);

    const entries = items.flatMap((item) => (item.kind === "diff" ? [item.entry] : []));
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ path: "src/full.ts", chars: 128 });
    expect(entries[1]).toMatchObject({ path: "src/no-chars.ts", chars: null });
    expect(entries[2]).toMatchObject({ path: null, chars: 64 });
    expect(entries[3]).toMatchObject({ path: null, chars: null });
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
