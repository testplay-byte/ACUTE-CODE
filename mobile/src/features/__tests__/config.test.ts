/**
 * config.test.ts — the config module's pure derivations (R113-e): the
 * new-project body the sheet's create assembles (the POST /projects
 * contract — trimmed name + absolute root, color only when set) and the
 * providers screen's two-tier split off the SERVER's configured bit (the
 * desktop R113-d structure, ported). Injected sender fakes only.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender } from "../api";
import { createProject, newProjectBody, splitProviders, type ProviderRow } from "../config";

// ── fixtures ────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: "prov_1",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    enabled: true,
    hasKey: false,
    keyCount: 0,
    createdAt: "2026-09-18T10:00:00Z",
    ...overrides,
  };
}

function makeApiSender(respond: (path: string) => { status: number; bodyText: string }): {
  sender: ApiSender;
  calls: Array<{ path: string; init?: Record<string, unknown> }>;
} {
  const calls: Array<{ path: string; init?: Record<string, unknown> }> = [];
  const sender: ApiSender = {
    async api(path, init = {}) {
      calls.push({ path, init: init as Record<string, unknown> });
      const res = respond(path);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        headers: {},
        bodyText: res.bodyText,
      };
    },
  };
  return { sender, calls };
}

// ── the new-project body (the POST /projects contract) ─────────────────────

describe("newProjectBody", () => {
  it("trims both fields and carries the payload the route validates", () => {
    expect(newProjectBody("  acute-code ", " /home/z/repos/acute-code ")).toEqual({
      name: "acute-code",
      rootPath: "/home/z/repos/acute-code",
    });
  });

  it("color rides ONLY when set (the server picks its own otherwise)", () => {
    expect(newProjectBody("a", "/tmp", "#22c55e")).toEqual({ name: "a", rootPath: "/tmp", color: "#22c55e" });
    expect(newProjectBody("a", "/tmp", "")).toEqual({ name: "a", rootPath: "/tmp" });
    expect(newProjectBody("a", "/tmp", undefined)).toEqual({ name: "a", rootPath: "/tmp" });
  });

  it("an empty name OR an empty root is an honest null — the sheet refuses before the route 400s", () => {
    expect(newProjectBody("", "/tmp")).toBeNull();
    expect(newProjectBody("   ", "/tmp")).toBeNull();
    expect(newProjectBody("a", "")).toBeNull();
    expect(newProjectBody("a", "   ")).toBeNull();
    expect(newProjectBody("", "")).toBeNull();
  });
});

describe("createProject — the wire call", () => {
  it("POSTs /api/v1/projects with the assembled body", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 201,
      bodyText: JSON.stringify({ id: "proj_9", name: "acute", rootPath: "/x", color: "#f00", createdAt: "t" }),
    }));
    const outcome = await createProject(sender, newProjectBody("acute", "/x") ?? { name: "acute", rootPath: "/x" });
    expect(outcome.ok && outcome.data.id).toBe("proj_9");
    expect(calls[0]?.path).toBe("/api/v1/projects");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({ name: "acute", rootPath: "/x" });
  });
});

// ── the providers two-tier split (the R113-d structure, ported) ────────────

describe("splitProviders", () => {
  it("the SERVER's configured bit owns the split — inventory first, catalog below", () => {
    const rows = [
      makeProvider({ id: "a", name: "OpenRouter", configured: true }),
      makeProvider({ id: "b", name: "Z-AI", configured: false }),
      makeProvider({ id: "c", name: "Anthropic", configured: true }),
      makeProvider({ id: "d", name: "Custom local", configured: false }),
    ];
    const tiers = splitProviders(rows);
    expect(tiers.configured.map((p) => p.id)).toEqual(["a", "c"]);
    expect(tiers.addable.map((p) => p.id)).toEqual(["b", "d"]);
  });

  it("a preset the SERVER marks configured sits in 'Your providers' even when hasKey reads false — the pool-aware truth", () => {
    const rows = [makeProvider({ id: "z", name: "Z-AI", hasKey: false, keyCount: 0, configured: true })];
    expect(splitProviders(rows).configured.map((p) => p.id)).toEqual(["z"]);
  });

  it("configured undefined (an older sidecar) reads UNCONFIGURED — the honest pre-split fallback", () => {
    const rows = [makeProvider({ id: "legacy", configured: undefined }), makeProvider({ id: "new", configured: true })];
    const tiers = splitProviders(rows);
    expect(tiers.configured.map((p) => p.id)).toEqual(["new"]);
    expect(tiers.addable.map((p) => p.id)).toEqual(["legacy"]);
  });

  it("empty input splits to two empty tiers", () => {
    expect(splitProviders([])).toEqual({ configured: [], addable: [] });
  });
});
