/**
 * config.test.ts — the config module's pure derivations + wire calls: the
 * new-project body the sheet's create assembles (the POST /projects
 * contract — trimmed name + absolute root, color only when set), the
 * providers screen's two-tier split off the SERVER's configured bit (the
 * desktop R113-d structure, ported), and the R114-f Models & Providers
 * surface — the custom-provider body, the key-pool slot math, the 204-empty
 * key writes, the saved-models-config/model CRUD/test wire shapes, and the
 * add-model sheet's pure math (numeric parsing, add/edit bodies, catalog
 * prefill, capability chips). Injected sender fakes only.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender } from "../api";
import {
  addProviderModel,
  catalogEntriesFromStatic,
  catalogPrefillFor,
  cleanModelName,
  createCustomProvider,
  createProject,
  customProviderBody,
  deleteModel,
  deleteProvider,
  deleteProviderKeySlot,
  fetchModelCatalog,
  fetchProviderKeys,
  fetchProviderModelsConfig,
  modelAddBody,
  modelCapabilityChips,
  modelDraftFromRecord,
  modelEditBody,
  newProjectBody,
  nextFreeKeySlot,
  parseModelNumericField,
  putProviderKeySlot,
  searchCatalogEntries,
  setProviderKey,
  splitProviders,
  testModel,
  updateModel,
  type CatalogModelEntry,
  type ModelFormDraft,
  type ModelRecord,
  type ProviderKeySlot,
  type ProviderRow,
} from "../config";

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

// ── the R114-f surface ──────────────────────────────────────────────────────

/** A route-table sender fake — responds by (path, method); records calls. */
function makeRouteSender(
  routes: Array<{ path: string; method?: string; status: number; bodyText: string }>,
): { sender: ApiSender; calls: Array<{ path: string; init?: Record<string, unknown> }> } {
  const calls: Array<{ path: string; init?: Record<string, unknown> }> = [];
  const sender: ApiSender = {
    async api(path, init = {}) {
      calls.push({ path, init: init as Record<string, unknown> });
      const method = (init.method ?? "GET") as string;
      const route = routes.find((r) => r.path === path && (r.method ?? "GET") === method);
      if (route === undefined) {
        throw new Error(`unexpected api call: ${method} ${path}`);
      }
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        headers: {},
        bodyText: route.bodyText,
      };
    },
  };
  return { sender, calls };
}

function makeKeySlot(slot: number, hasKey: boolean, overrides: Partial<ProviderKeySlot> = {}): ProviderKeySlot {
  return { slot, hasKey, masked: hasKey ? `sk-a…${String(slot).padStart(2, "0")}` : null, ...overrides };
}

function makeModelRecord(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: "mdl_1",
    providerId: "openrouter",
    modelId: "z-ai/glm-4.7",
    displayName: null,
    contextWindow: null,
    maxOutputTokens: null,
    inputPricePerMtok: null,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: null,
    supportsThinking: false,
    supportsVision: false,
    supportsTools: null,
    sizeLabel: null,
    reasoningSupport: null,
    hidden: false,
    createdAt: "2026-09-20T10:00:00Z",
    ...overrides,
  };
}

function makeDraft(overrides: Partial<ModelFormDraft> = {}): ModelFormDraft {
  return {
    modelId: "z-ai/glm-4.7",
    displayName: "",
    contextWindow: "",
    inputPricePerMtok: "",
    outputPricePerMtok: "",
    supportsVision: false,
    supportsThinking: false,
    hidden: false,
    ...overrides,
  };
}

function makeCatalogEntry(overrides: Partial<CatalogModelEntry> = {}): CatalogModelEntry {
  return {
    modelId: "z-ai/glm-4.7",
    displayName: "GLM 4.7",
    contextWindow: 200000,
    maxOutputTokens: 32768,
    inputPricePerMtok: 0.1,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0.6,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
    ...overrides,
  };
}

// ── the custom-provider create (POST /providers) ────────────────────────────

describe("customProviderBody", () => {
  it("trims name + base URL and carries the apiFormat enum verbatim", () => {
    expect(customProviderBody("  NVIDIA NIM ", " https://integrate.api.nvidia.com/v1 ", "chat-completions")).toEqual({
      name: "NVIDIA NIM",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiFormat: "chat-completions",
    });
    expect(customProviderBody("a", "https://x.test", "anthropic-messages")?.apiFormat).toBe("anthropic-messages");
    expect(customProviderBody("a", "https://x.test", "responses")?.apiFormat).toBe("responses");
  });

  it("a blank name OR blank base URL is an honest null — the sheet refuses before the route 400s", () => {
    expect(customProviderBody("", "https://x.test", "chat-completions")).toBeNull();
    expect(customProviderBody("   ", "https://x.test", "responses")).toBeNull();
    expect(customProviderBody("a", "", "chat-completions")).toBeNull();
    expect(customProviderBody("a", "   ", "chat-completions")).toBeNull();
  });
});

describe("createCustomProvider — the wire call", () => {
  it("POSTs /api/v1/providers with the assembled body and parses the 201 view", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/providers",
        method: "POST",
        status: 201,
        bodyText: JSON.stringify(
          makeProvider({ id: "prv_nim", name: "NVIDIA NIM", configured: true }),
        ),
      },
    ]);
    const body = customProviderBody("NVIDIA NIM", "https://integrate.api.nvidia.com/v1", "chat-completions");
    const outcome = await createCustomProvider(sender, body ?? { name: "", baseUrl: "", apiFormat: "chat-completions" });
    expect(outcome.ok && outcome.data.id).toBe("prv_nim");
    expect(calls[0]?.path).toBe("/api/v1/providers");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({
      name: "NVIDIA NIM",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiFormat: "chat-completions",
    });
  });

  it("the ADOPT case (200 + adopted:true) parses as the same row shape", async () => {
    const { sender } = makeRouteSender([
      {
        path: "/api/v1/providers",
        method: "POST",
        status: 200,
        bodyText: JSON.stringify({ ...makeProvider({ id: "nvidia" }), adopted: true }),
      },
    ]);
    const outcome = await createCustomProvider(sender, {
      name: "NVIDIA",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiFormat: "chat-completions",
    });
    expect(outcome.ok && outcome.data.adopted).toBe(true);
  });

  it("the 409 name-collision envelope surfaces as the error value (the sheet shows it inline)", async () => {
    const { sender } = makeRouteSender([
      {
        path: "/api/v1/providers",
        method: "POST",
        status: 409,
        bodyText: JSON.stringify({
          error: { code: "CONFLICT", message: "provider name 'NVIDIA' is already in use — pick a different display name" },
        }),
      },
    ]);
    const outcome = await createCustomProvider(sender, {
      name: "NVIDIA",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiFormat: "chat-completions",
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.status).toBe(409);
    expect(!outcome.ok && outcome.error.message).toContain("already in use");
  });
});

// ── the key pool (GET/PUT/DELETE + the 204-empty primary write) ─────────────

describe("deleteProvider — the wire call", () => {
  it("DELETEs /api/v1/providers/:id — a 204 with an EMPTY body is ok:true (the no-content twin)", async () => {
    const { sender, calls } = makeRouteSender([
      { path: "/api/v1/providers/prv_1", method: "DELETE", status: 204, bodyText: "" },
    ]);
    const outcome = await deleteProvider(sender, "prv_1");
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.path).toBe("/api/v1/providers/prv_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("force rides as ?force=1 (the R91-A agent-reassign path)", async () => {
    const { sender, calls } = makeRouteSender([
      { path: "/api/v1/providers/openrouter?force=1", method: "DELETE", status: 204, bodyText: "" },
    ]);
    await deleteProvider(sender, "openrouter", true);
    expect(calls[0]?.path).toBe("/api/v1/providers/openrouter?force=1");
  });
});

describe("setProviderKey — the 204-empty regression", () => {
  it("PUT /api/v1/providers/:id/key answers 204 with NO body — ok:true (the old apiJson read it as BAD_JSON)", async () => {
    const { sender, calls } = makeRouteSender([
      { path: "/api/v1/providers/openrouter/key", method: "PUT", status: 204, bodyText: "" },
    ]);
    const outcome = await setProviderKey(sender, "openrouter", "test-primary-key-value");
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({ value: "test-primary-key-value" });
  });
});

describe("fetchProviderKeys — the wire call", () => {
  it("GETs /api/v1/providers/:id/keys and parses the masked pool", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/keys",
        status: 200,
        bodyText: JSON.stringify({
          keys: [makeKeySlot(0, true, { masked: "sk-o…9f2a" }), makeKeySlot(1, true, { masked: "sk-o…11b3" }), makeKeySlot(2, false)],
        }),
      },
    ]);
    const outcome = await fetchProviderKeys(sender, "openrouter");
    expect(outcome.ok && outcome.data.keys.length).toBe(3);
    expect(outcome.ok && outcome.data.keys[0]?.masked).toBe("sk-o…9f2a");
    expect(outcome.ok && outcome.data.keys[2]?.hasKey).toBe(false);
    expect(calls[0]?.path).toBe("/api/v1/providers/openrouter/keys");
    expect(calls[0]?.init?.method).toBeUndefined();
  });
});

describe("putProviderKeySlot — the wire call", () => {
  it("PUTs /api/v1/providers/:id/keys/:slot with {value} and parses the refreshed pool", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/keys/3",
        method: "PUT",
        status: 200,
        bodyText: JSON.stringify({ keys: [makeKeySlot(0, true), makeKeySlot(3, true)] }),
      },
    ]);
    const outcome = await putProviderKeySlot(sender, "openrouter", 3, "test-pool-key-value");
    expect(outcome.ok && outcome.data.keys.length).toBe(2);
    expect(calls[0]?.path).toBe("/api/v1/providers/openrouter/keys/3");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({ value: "test-pool-key-value" });
  });
});

describe("deleteProviderKeySlot — the wire call", () => {
  it("DELETEs /api/v1/providers/:id/keys/:slot — 200 with the emptied slot re-included", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/keys/2",
        method: "DELETE",
        status: 200,
        bodyText: JSON.stringify({ keys: [makeKeySlot(0, true), makeKeySlot(2, false)] }),
      },
    ]);
    const outcome = await deleteProviderKeySlot(sender, "openrouter", 2);
    expect(outcome.ok && outcome.data.keys[1]?.hasKey).toBe(false);
    expect(calls[0]?.path).toBe("/api/v1/providers/openrouter/keys/2");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("the slot-0 409 (the primary is never removed over HTTP) surfaces as the error value", async () => {
    const { sender } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/keys/0",
        method: "DELETE",
        status: 409,
        bodyText: JSON.stringify({
          error: { code: "CONFLICT", message: "the primary key is removed via the main key endpoint" },
        }),
      },
    ]);
    const outcome = await deleteProviderKeySlot(sender, "openrouter", 0);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.message).toContain("primary key");
  });
});

describe("nextFreeKeySlot — the add-a-key slot math", () => {
  it("an empty pool (or a keyless primary) lands the FIRST key on slot 0 — the primary path", () => {
    expect(nextFreeKeySlot([])).toBe(0);
    expect(nextFreeKeySlot([makeKeySlot(0, false)])).toBe(0);
    expect(nextFreeKeySlot([makeKeySlot(0, false), makeKeySlot(2, true)])).toBe(0);
  });

  it("with the primary held, the first free POOL slot in [1,31] wins — gaps never collide", () => {
    expect(nextFreeKeySlot([makeKeySlot(0, true)])).toBe(1);
    // slots 0, 2, 4 held → the first free is 1 (never length+2=3 overwriting… wait, 3 IS free here; the classic collision is slots {0,1,2,4} → 3)
    expect(nextFreeKeySlot([makeKeySlot(0, true), makeKeySlot(2, true), makeKeySlot(4, true)])).toBe(1);
    expect(nextFreeKeySlot([makeKeySlot(0, true), makeKeySlot(1, true), makeKeySlot(2, true), makeKeySlot(4, true)])).toBe(3);
  });

  it("a full pool (0..31 held) answers -1 — the sheet says the pool is full", () => {
    const full = Array.from({ length: 32 }, (_, slot) => makeKeySlot(slot, true));
    expect(nextFreeKeySlot(full)).toBe(-1);
  });

  it("unheld slots never block, duplicates and order are fine (pure)", () => {
    expect(nextFreeKeySlot([makeKeySlot(0, true), makeKeySlot(1, false)])).toBe(1);
    expect(nextFreeKeySlot([makeKeySlot(1, true), makeKeySlot(0, true), makeKeySlot(1, true)])).toBe(2);
  });
});

// ── the saved-models truth (models-config) + model CRUD/test wires ──────────

describe("fetchProviderModelsConfig — the wire call", () => {
  it("GETs /api/v1/providers/:id/models-config — the SAVED rows, not the live catalog", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/models-config",
        status: 200,
        bodyText: JSON.stringify({ models: [makeModelRecord({ id: "mdl_a" }), makeModelRecord({ id: "mdl_b", hidden: true })] }),
      },
    ]);
    const outcome = await fetchProviderModelsConfig(sender, "openrouter");
    expect(outcome.ok && outcome.data.models.length).toBe(2);
    expect(calls[0]?.path).toBe("/api/v1/providers/openrouter/models-config");
  });
});

describe("fetchModelCatalog — the wire call", () => {
  it("GETs /api/v1/models/catalog and parses the static rows + defaults", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/models/catalog",
        status: 200,
        bodyText: JSON.stringify({
          models: [makeCatalogEntry()],
          defaultModelId: "z-ai/glm-4.7",
          subagentDefaultModelId: "z-ai/glm-4.7",
          recommendedModelIds: ["z-ai/glm-4.7"],
        }),
      },
    ]);
    const outcome = await fetchModelCatalog(sender);
    expect(outcome.ok && outcome.data.models[0]?.supportsVision).toBe(true);
    expect(calls[0]?.path).toBe("/api/v1/models/catalog");
  });
});

describe("addProviderModel — the wire call", () => {
  it("POSTs /api/v1/providers/:id/models with the assembled body; 201 parses the saved row", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/models",
        method: "POST",
        status: 201,
        bodyText: JSON.stringify(makeModelRecord({ id: "mdl_new" })),
      },
    ]);
    const outcome = await addProviderModel(sender, "openrouter", {
      modelId: "z-ai/glm-4.7",
      contextWindow: 200000,
      supportsVision: true,
    });
    expect(outcome.ok && outcome.data.id).toBe("mdl_new");
    expect(calls[0]?.path).toBe("/api/v1/providers/openrouter/models");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({
      modelId: "z-ai/glm-4.7",
      contextWindow: 200000,
      supportsVision: true,
    });
  });
});

describe("updateModel — the wire call (supportsVision/supportsThinking ride PATCH)", () => {
  it("PATCHes /api/v1/models/:id with only the sheet-owned fields", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/models/mdl_1",
        method: "PATCH",
        status: 200,
        bodyText: JSON.stringify(makeModelRecord({ hidden: true })),
      },
    ]);
    const outcome = await updateModel(sender, "mdl_1", { hidden: true, supportsVision: true });
    expect(outcome.ok && outcome.data.hidden).toBe(true);
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({ hidden: true, supportsVision: true });
  });
});

describe("testModel — the wire call", () => {
  it("POSTs /api/v1/models/:id/test with {} — a probe that ran and got NO is still 200 {ok:false}", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/models/mdl_1/test",
        method: "POST",
        status: 200,
        bodyText: JSON.stringify({
          ok: false,
          latencyMs: 432,
          providerId: "openrouter",
          model: "z-ai/glm-4.7",
          checks: { http: true, auth: true, modelAccepted: false, nonEmptyContent: false },
          reason: "model not found",
        }),
      },
    ]);
    const outcome = await testModel(sender, "mdl_1", {});
    expect(outcome.ok && outcome.data.ok).toBe(false);
    expect(outcome.ok && outcome.data.reason).toBe("model not found");
    expect(calls[0]?.path).toBe("/api/v1/models/mdl_1/test");
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({});
  });

  it("a slot-scoped probe carries {slot} (the R47-b pool contract)", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/models/mdl_1/test",
        method: "POST",
        status: 200,
        bodyText: JSON.stringify({ ok: true, latencyMs: 980, providerId: "openrouter", model: "m", checks: { http: true, auth: true, modelAccepted: true, nonEmptyContent: true } }),
      },
    ]);
    await testModel(sender, "mdl_1", { slot: 3 });
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({ slot: 3 });
  });
});

describe("deleteModel — the wire call", () => {
  it("DELETEs /api/v1/models/:id — a 204 with an EMPTY body is ok:true", async () => {
    const { sender, calls } = makeRouteSender([
      { path: "/api/v1/models/mdl_1", method: "DELETE", status: 204, bodyText: "" },
    ]);
    const outcome = await deleteModel(sender, "mdl_1");
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.path).toBe("/api/v1/models/mdl_1");
  });
});

// ── the add/edit sheet's pure math ──────────────────────────────────────────

describe("parseModelNumericField", () => {
  it("blank → null (unknown); a finite number ≥ 0 → the number", () => {
    expect(parseModelNumericField("Context window", "")).toEqual({ ok: true, value: null });
    expect(parseModelNumericField("Context window", "   ")).toEqual({ ok: true, value: null });
    expect(parseModelNumericField("Context window", "2048")).toEqual({ ok: true, value: 2048 });
    expect(parseModelNumericField("Input price", "0.15")).toEqual({ ok: true, value: 0.15 });
    expect(parseModelNumericField("Input price", "0")).toEqual({ ok: true, value: 0 });
  });

  it("negative / non-numeric → the honest per-field error the sheet shows inline", () => {
    expect(parseModelNumericField("Context window", "-1")).toEqual({
      ok: false,
      field: "Context window",
      message: "Context window must be a number ≥ 0 (or blank for unknown)",
    });
    const bad = parseModelNumericField("Input price", "abc");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.message).toContain("Input price");
  });
});

describe("modelAddBody — blank numerics are OMITTED (never a fabricated 0)", () => {
  it("a full draft carries the numbers + the capability booleans verbatim", () => {
    expect(
      modelAddBody(makeDraft({ displayName: "GLM 4.7", contextWindow: "200000", inputPricePerMtok: "0.1", outputPricePerMtok: "0.6", supportsVision: true })),
    ).toEqual({
      modelId: "z-ai/glm-4.7",
      displayName: "GLM 4.7",
      contextWindow: 200000,
      inputPricePerMtok: 0.1,
      outputPricePerMtok: 0.6,
      supportsVision: true,
      supportsThinking: false,
      hidden: false,
    });
  });

  it("blank displayName and blank numerics are omitted — the server's insert defaults decide", () => {
    expect(modelAddBody(makeDraft({ supportsThinking: true }))).toEqual({
      modelId: "z-ai/glm-4.7",
      supportsVision: false,
      supportsThinking: true,
      hidden: false,
    });
  });

  it("a blank model id is an honest null; a malformed numeric is too (the sheet validates first)", () => {
    expect(modelAddBody(makeDraft({ modelId: "   " }))).toBeNull();
    expect(modelAddBody(makeDraft({ contextWindow: "soon" }))).toBeNull();
  });

  it("the model id is trimmed", () => {
    expect(modelAddBody(makeDraft({ modelId: "  vendor/model-x  " }))?.modelId).toBe("vendor/model-x");
  });
});

describe("modelEditBody — blank numerics ride as NULL (the clear-to-unknown contract)", () => {
  it("carries ONLY the sheet-owned fields — modelId (identity) never rides", () => {
    expect(
      modelEditBody(makeDraft({ displayName: "  GLM 4.7  ", contextWindow: "200000", inputPricePerMtok: "0.1", outputPricePerMtok: "0.6", supportsVision: true, hidden: true })),
    ).toEqual({
      displayName: "GLM 4.7",
      contextWindow: 200000,
      inputPricePerMtok: 0.1,
      outputPricePerMtok: 0.6,
      supportsVision: true,
      supportsThinking: false,
      hidden: true,
    });
    expect("modelId" in modelEditBody(makeDraft())).toBe(false);
  });

  it("blank numerics → null (clears to unknown); blank displayName → \"\" (no custom name)", () => {
    const body = modelEditBody(makeDraft());
    expect(body.contextWindow).toBeNull();
    expect(body.inputPricePerMtok).toBeNull();
    expect(body.outputPricePerMtok).toBeNull();
    expect(body.displayName).toBe("");
  });
});

describe("modelDraftFromRecord — the edit sheet's hydration", () => {
  it("nulls become blank strings; the capability booleans carry", () => {
    expect(modelDraftFromRecord(makeModelRecord({ contextWindow: 128000, inputPricePerMtok: 0.2, supportsVision: true, hidden: true }))).toEqual({
      modelId: "z-ai/glm-4.7",
      displayName: "",
      contextWindow: "128000",
      inputPricePerMtok: "0.2",
      outputPricePerMtok: "",
      supportsVision: true,
      supportsThinking: false,
      hidden: true,
    });
  });
});

describe("modelCapabilityChips — the saved-row chip mapping", () => {
  it("vision/thinking show when true; hidden always mirrors the row", () => {
    expect(modelCapabilityChips({ supportsVision: true, supportsThinking: true, hidden: false })).toEqual({
      vision: true,
      thinking: true,
      hidden: false,
    });
    expect(modelCapabilityChips({ supportsVision: false, supportsThinking: false, hidden: true })).toEqual({
      vision: false,
      thinking: false,
      hidden: true,
    });
  });

  it("a null capability (unknown) reads as OFF — never a guess", () => {
    expect(modelCapabilityChips({ supportsVision: null, supportsThinking: null, hidden: false }).vision).toBe(false);
  });
});

describe("cleanModelName — the humanized last segment (the desktop twin)", () => {
  it("strips the provider prefix + the :free suffix, humanizes the tail", () => {
    expect(cleanModelName("openrouter/z-ai/glm-4.7:free")).toBe("GLM 4.7");
    expect(cleanModelName("anthropic/claude-sonnet-4-5")).toBe("Claude Sonnet 4 5");
    expect(cleanModelName("openai/gpt-4o")).toBe("GPT 4o");
    expect(cleanModelName("meta-llama/llama-3.3-70b-instruct")).toBe("Llama 3.3 70b Instruct");
  });

  it("an empty / degenerate id returns itself — never a crash", () => {
    expect(cleanModelName("")).toBe("");
    expect(cleanModelName("a/b/")).toBe("a/b/");
    expect(cleanModelName(":::")).toBe(":::");
  });
});

describe("catalogPrefillFor — the catalog → form prefill", () => {
  const staticCatalog = [makeCatalogEntry(), makeCatalogEntry({ modelId: "vendor/other", displayName: "Other", supportsVision: false })];

  it("the LIVE name wins when it differs from the id; the static row fills context/pricing/vision", () => {
    expect(catalogPrefillFor({ id: "z-ai/glm-4.7", name: "GLM 4.7 (live)" }, staticCatalog)).toEqual({
      modelId: "z-ai/glm-4.7",
      displayName: "GLM 4.7 (live)",
      contextWindow: "200000",
      inputPricePerMtok: "0.1",
      outputPricePerMtok: "0.6",
      supportsVision: true,
      supportsThinking: false,
      hidden: false,
    });
  });

  it("a name equal to the id (or blank) falls to the static displayName, then the humanized tail", () => {
    expect(catalogPrefillFor({ id: "z-ai/glm-4.7", name: "z-ai/glm-4.7" }, staticCatalog).displayName).toBe("GLM 4.7");
    expect(catalogPrefillFor({ id: "z-ai/glm-4.7", name: "" }, staticCatalog).displayName).toBe("GLM 4.7");
    expect(catalogPrefillFor({ id: "unknown/model-9", name: "unknown/model-9" }, staticCatalog).displayName).toBe("Model 9");
  });

  it("an id the static catalog does not know prefills blanks + vision false (honest defaults)", () => {
    expect(catalogPrefillFor({ id: "nim/custom-1", name: "Custom One" }, staticCatalog)).toEqual({
      modelId: "nim/custom-1",
      displayName: "Custom One",
      contextWindow: "",
      inputPricePerMtok: "",
      outputPricePerMtok: "",
      supportsVision: false,
      supportsThinking: false,
      hidden: false,
    });
  });
});

describe("searchCatalogEntries — the add-sheet's query filter", () => {
  const entries = [
    { id: "z-ai/glm-4.7", name: "GLM 4.7" },
    { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "openai/gpt-4o", name: "GPT 4o" },
  ];

  it("a blank query returns everything, order preserved", () => {
    expect(searchCatalogEntries("", entries).map((e) => e.id)).toEqual(["z-ai/glm-4.7", "anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
    expect(searchCatalogEntries("   ", entries).length).toBe(3);
  });

  it("matches case-insensitively on the id OR the name", () => {
    expect(searchCatalogEntries("GLM", entries).map((e) => e.id)).toEqual(["z-ai/glm-4.7"]);
    expect(searchCatalogEntries("claude", entries).map((e) => e.id)).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(searchCatalogEntries("gpt-4o", entries).map((e) => e.id)).toEqual(["openai/gpt-4o"]);
    expect(searchCatalogEntries("zzz", entries)).toEqual([]);
  });
});

describe("catalogEntriesFromStatic — the fallback list shape", () => {
  it("maps the static rows into the live-entry shape ({id, name})", () => {
    expect(catalogEntriesFromStatic([makeCatalogEntry(), makeCatalogEntry({ modelId: "v/x", displayName: "X" })])).toEqual([
      { id: "z-ai/glm-4.7", name: "GLM 4.7" },
      { id: "v/x", name: "X" },
    ]);
  });
});
