import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  getAgentsBackend,
  httpAgents,
  type Agent,
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
  allowedTools: ["file_read", "shell_exec"],
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
      allowedTools: ["file_read"],
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
