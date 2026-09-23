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
  applyModelDetailsToDraft,
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
  fetchProviderModelDetails,
  fetchProviderKeys,
  fetchProviderModelsConfig,
  modelAddBody,
  modelCapabilityChips,
  modelDetailsDraftPatch,
  modelDraftFromRecord,
  modelEditBody,
  modelTestToastText,
  modelTestToolsLegLine,
  newProjectBody,
  nextFreeKeySlot,
  orderedReasoningEfforts,
  parseModelNumericField,
  presetAddPlan,
  putProviderKeySlot,
  reasoningSupportDraftValue,
  remainingReasoningEfforts,
  searchCatalogEntries,
  setProviderKey,
  splitProviders,
  testModel,
  testProvider,
  testTransportFailureMessage,
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
    supportsAudio: null,
    supportsVideo: null,
    supportsPdf: null,
    supportsTextOutput: null,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
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
    sizeLabel: "",
    contextWindow: "",
    maxOutputTokens: "",
    inputPricePerMtok: "",
    outputPricePerMtok: "",
    inputPriceCachedPerMtok: "",
    supportsVision: false,
    supportsTools: null,
    supportsAudio: null,
    supportsVideo: null,
    supportsPdf: null,
    supportsTextOutput: true,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
    hidden: false,
    // R120-M (item 21): the reasoning ladder starts empty/untouched.
    reasoningEfforts: [],
    reasoningTouched: false,
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

describe("presetAddPlan — the preset-add sheet's commit plan (R120-S, round-120 §1 C7)", () => {
  // The owner's verdict: tapping a preset must NOT navigate to the provider
  // page — the add happens IN the sheet. The plan owns the honesty: the key
  // is REQUIRED (the configured bit flips on a held key), the base-URL
  // PATCH rides only on drift, a cleared URL is refused before the route
  // 400s (the customProviderBody discipline).
  const preset = { baseUrl: "https://api.openai.com/v1" };

  it("the untouched URL + a key = a key-only plan (no PATCH — the preset's own URL stands)", () => {
    expect(presetAddPlan(preset, "https://api.openai.com/v1", "  sk-live-abc  ")).toEqual({
      baseUrlPatch: null,
      key: "sk-live-abc",
    });
  });

  it("a drifted URL rides the PATCH (trimmed); the key rides trimmed", () => {
    expect(
      presetAddPlan(preset, " https://mirror.internal/v1 ", "sk-live-abc"),
    ).toEqual({
      baseUrlPatch: "https://mirror.internal/v1",
      key: "sk-live-abc",
    });
    // drift back to the preset's own URL after an edit = no PATCH either
    expect(presetAddPlan(preset, `  ${preset.baseUrl} `, "k")).toEqual({
      baseUrlPatch: null,
      key: "k",
    });
  });

  it("a blank key is refused — a keyless add would leave the row unconfigured (a lie)", () => {
    expect(presetAddPlan(preset, "https://api.openai.com/v1", "")).toEqual({
      error: "paste the provider's API key to add it",
    });
    expect(presetAddPlan(preset, "https://api.openai.com/v1", "   ")).toEqual({
      error: "paste the provider's API key to add it",
    });
  });

  it("a cleared URL is refused before the route 400s", () => {
    expect(presetAddPlan(preset, "", "sk-live-abc")).toEqual({
      error: "a base URL is required",
    });
    expect(presetAddPlan(preset, "   ", "sk-live-abc")).toEqual({
      error: "a base URL is required",
    });
  });

  it("the key check comes FIRST — a blank key with a drifted URL still names the key", () => {
    expect(presetAddPlan(preset, "https://mirror/v1", "")).toEqual({
      error: "paste the provider's API key to add it",
    });
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

  it("rides the 65s two-phase test-call budget (R119-P — the server now runs pong + the tools leg, 30s per leg; the R116-j 35s budget would abort the exchange mid-tools-leg)", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/models/mdl_1/test",
        method: "POST",
        status: 200,
        bodyText: JSON.stringify({ ok: true, latencyMs: 1, providerId: "openrouter", model: "m", checks: { http: true, auth: true, modelAccepted: true, nonEmptyContent: true } }),
      },
    ]);
    await testModel(sender, "mdl_1", {});
    expect(calls[0]?.init?.timeoutMs).toBe(65_000);
  });
});

// ── R119-P (round-119 §1 item F): the tools leg's verdict line — the pure
// formatting behind the model-actions sheet's SECOND note line. The owner's
// TokenHarbor report: plain chat worked while every agent action failed, so
// "test ✓" had to stop hiding the agent's real (tool-carrying) call shape.

describe("modelTestToolsLegLine — the tools leg's one-line verdict (R119-P)", () => {
  it("the model CALLED echo → the good line", () => {
    expect(
      modelTestToolsLegLine({
        checks: {
          http: true,
          auth: true,
          modelAccepted: true,
          nonEmptyContent: true,
          toolsAccepted: true,
          toolCalled: true,
        },
      }),
    ).toEqual({ tone: "good", text: "tools ✓ (called echo)" });
  });

  it("accepted-but-text → the CAUTION line (chat works, agent actions will not)", () => {
    expect(
      modelTestToolsLegLine({
        checks: {
          http: true,
          auth: true,
          modelAccepted: true,
          nonEmptyContent: true,
          toolsAccepted: true,
          toolCalled: false,
        },
      }),
    ).toEqual({
      tone: "caution",
      text: "tools accepted — answered in text, not called — usable for chat, not for agent actions",
    });
  });

  it("rejected → the BAD line carries the reason snippet (110 chars, ellipsized)", () => {
    const reason =
      "the agent tools request was rejected (HTTP 400): tools are not supported for model qwen3.8-flash:free on this route — chat works, but every agent action will fail";
    const line = modelTestToolsLegLine({
      checks: {
        http: true,
        auth: true,
        modelAccepted: true,
        nonEmptyContent: true,
        toolsAccepted: false,
      },
      reason,
    });
    expect(line?.tone).toBe("bad");
    expect(line?.text.startsWith("tools rejected — ")).toBe(true);
    expect(line?.text).toContain("the agent tools request was rejected (HTTP 400)");
    // The snippet is capped: the prefix + 110 chars + the ellipsis.
    expect(line?.text.length).toBeLessThanOrEqual("tools rejected — ".length + 111);
    expect(line?.text.endsWith("…")).toBe(true);
  });

  it("a SHORT rejection reason renders whole — no dead ellipsis", () => {
    expect(
      modelTestToolsLegLine({
        checks: {
          http: true,
          auth: true,
          modelAccepted: true,
          nonEmptyContent: true,
          toolsAccepted: false,
        },
        reason: "the provider refused the tools request",
      }),
    ).toEqual({ tone: "bad", text: "tools rejected — the provider refused the tools request" });
  });

  it("not-run (no tools fields) → null — the base verdict line already tells that story", () => {
    expect(
      modelTestToolsLegLine({
        checks: { http: true, auth: true, modelAccepted: false, nonEmptyContent: false },
        reason: "model not found",
      }),
    ).toBeNull();
  });
});

describe("testProvider — the wire call", () => {
  it("POSTs /api/v1/providers/:id/test with {slot} AND the 35s test-call budget (the slot probe rides the same client)", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/test",
        method: "POST",
        status: 200,
        bodyText: JSON.stringify({ ok: true, latencyMs: 210, message: "pong" }),
      },
    ]);
    const outcome = await testProvider(sender, "openrouter", { slot: 2 });
    expect(outcome.ok && outcome.data.ok).toBe(true);
    expect(calls[0]?.path).toBe("/api/v1/providers/openrouter/test");
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({ slot: 2 });
    expect(calls[0]?.init?.timeoutMs).toBe(35_000);
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
  it("a full draft carries the numbers + the size label + the capability flags verbatim (tri-state nulls ride)", () => {
    expect(
      modelAddBody(
        makeDraft({
          displayName: "GLM 4.7",
          sizeLabel: "70B",
          contextWindow: "200000",
          maxOutputTokens: "32768",
          inputPricePerMtok: "0.1",
          outputPricePerMtok: "0.6",
          inputPriceCachedPerMtok: "0.02",
          supportsVision: true,
          supportsAudio: true,
          supportsTextOutput: false,
        }),
      ),
    ).toEqual({
      modelId: "z-ai/glm-4.7",
      displayName: "GLM 4.7",
      sizeLabel: "70B",
      contextWindow: 200000,
      maxOutputTokens: 32768,
      inputPricePerMtok: 0.1,
      inputPriceCachedPerMtok: 0.02,
      outputPricePerMtok: 0.6,
      supportsVision: true,
      supportsTools: null,
      supportsAudio: true,
      supportsVideo: null,
      supportsPdf: null,
      supportsTextOutput: false,
      supportsImageOutput: null,
      supportsVideoOutput: null,
      supportsAudioOutput: null,
      hidden: false,
    });
  });

  it("blank displayName/sizeLabel/numerics are omitted — the server's insert defaults decide", () => {
    expect(modelAddBody(makeDraft({ supportsVideo: true }))).toEqual({
      modelId: "z-ai/glm-4.7",
      supportsVision: false,
      supportsTools: null,
      supportsAudio: null,
      supportsVideo: true,
      supportsPdf: null,
      supportsTextOutput: true,
      supportsImageOutput: null,
      supportsVideoOutput: null,
      supportsAudioOutput: null,
      hidden: false,
    });
  });

  it("supportsThinking NEVER rides (R116-j — reasoning is detected server-side; absent keeps/derives the value)", () => {
    const body = modelAddBody(makeDraft());
    expect(body !== null && "supportsThinking" in body).toBe(false);
  });

  it("a blank model id is an honest null; a malformed numeric (incl. the new fields) is too (the sheet validates first)", () => {
    expect(modelAddBody(makeDraft({ modelId: "   " }))).toBeNull();
    expect(modelAddBody(makeDraft({ contextWindow: "soon" }))).toBeNull();
    expect(modelAddBody(makeDraft({ maxOutputTokens: "lots" }))).toBeNull();
    expect(modelAddBody(makeDraft({ inputPriceCachedPerMtok: "cheap" }))).toBeNull();
  });

  it("the model id is trimmed", () => {
    expect(modelAddBody(makeDraft({ modelId: "  vendor/model-x  " }))?.modelId).toBe("vendor/model-x");
  });
});

describe("modelEditBody — blank numerics ride as NULL (the clear-to-unknown contract)", () => {
  it("carries ONLY the sheet-owned fields — modelId (identity) and supportsThinking (detected) never ride", () => {
    const body = modelEditBody(
      makeDraft({
        displayName: "  GLM 4.7  ",
        sizeLabel: " 70B ",
        contextWindow: "200000",
        maxOutputTokens: "32768",
        inputPricePerMtok: "0.1",
        outputPricePerMtok: "0.6",
        inputPriceCachedPerMtok: "0.02",
        supportsVision: true,
        supportsAudio: true,
        supportsTextOutput: false,
        hidden: true,
      }),
    );
    expect(body).toEqual({
      displayName: "GLM 4.7",
      sizeLabel: "70B",
      contextWindow: 200000,
      maxOutputTokens: 32768,
      inputPricePerMtok: 0.1,
      outputPricePerMtok: 0.6,
      inputPriceCachedPerMtok: 0.02,
      supportsVision: true,
      supportsTools: null,
      supportsAudio: true,
      supportsVideo: null,
      supportsPdf: null,
      supportsTextOutput: false,
      supportsImageOutput: null,
      supportsVideoOutput: null,
      supportsAudioOutput: null,
      hidden: true,
    });
    expect("modelId" in body).toBe(false);
    expect("supportsThinking" in body).toBe(false);
  });

  it("blank numerics → null (clears to unknown); blank displayName → \"\" (no custom name); blank sizeLabel → null (unspecified)", () => {
    const body = modelEditBody(makeDraft({ supportsTextOutput: null }));
    expect(body.contextWindow).toBeNull();
    expect(body.maxOutputTokens).toBeNull();
    expect(body.inputPricePerMtok).toBeNull();
    expect(body.outputPricePerMtok).toBeNull();
    expect(body.inputPriceCachedPerMtok).toBeNull();
    expect(body.displayName).toBe("");
    expect(body.sizeLabel).toBeNull();
    expect(body.supportsTextOutput).toBeNull();
  });

  it("the untouched tri-state caps round-trip their stored value — unknown stays unknown, never a guessed boolean", () => {
    const body = modelEditBody(
      makeDraft({ supportsTools: true, supportsPdf: false, supportsImageOutput: null }),
    );
    expect(body.supportsTools).toBe(true);
    expect(body.supportsPdf).toBe(false);
    expect(body.supportsImageOutput).toBeNull();
  });
});

describe("modelDraftFromRecord — the edit sheet's hydration (the FULL R87 field set)", () => {
  it("round-trips a FULL record — numerics → strings, nulls preserved, lossless through the PATCH body", () => {
    const record = makeModelRecord({
      displayName: "GLM 4.7",
      sizeLabel: "70B MoE",
      contextWindow: 131072,
      maxOutputTokens: 8192,
      inputPricePerMtok: 0.14,
      inputPriceCachedPerMtok: 0.014,
      outputPricePerMtok: 0.6,
      supportsVision: true,
      supportsTools: true,
      supportsAudio: false,
      supportsVideo: true,
      supportsPdf: null,
      supportsTextOutput: true,
      supportsImageOutput: false,
      supportsVideoOutput: null,
      supportsAudioOutput: null,
      hidden: true,
      // R120-M (item 21): the stored ladder rides the round-trip — out of
      // wire order on purpose (the draft canonicalizes lowest→highest).
      reasoningSupport: { supported: true, efforts: ["high", "low", "medium"], defaultEffort: "medium" },
    });
    const draft = modelDraftFromRecord(record);
    expect(draft).toEqual({
      modelId: "z-ai/glm-4.7",
      displayName: "GLM 4.7",
      sizeLabel: "70B MoE",
      contextWindow: "131072",
      maxOutputTokens: "8192",
      inputPricePerMtok: "0.14",
      inputPriceCachedPerMtok: "0.014",
      outputPricePerMtok: "0.6",
      supportsVision: true,
      supportsTools: true,
      supportsAudio: false,
      supportsVideo: true,
      supportsPdf: null,
      supportsTextOutput: true,
      supportsImageOutput: false,
      supportsVideoOutput: null,
      supportsAudioOutput: null,
      hidden: true,
      // R120-M (item 21): the hydration ORDERS the ladder + resets touched.
      reasoningEfforts: ["low", "medium", "high"],
      reasoningTouched: false,
    });
    // the round-trip is LOSSLESS through the edit body: the set stays set,
    // the unknown stays unknown.
    const body = modelEditBody(draft, record);
    expect(body.supportsTools).toBe(true);
    expect(body.supportsPdf).toBeNull();
    expect(body.sizeLabel).toBe("70B MoE");
    expect(body.inputPriceCachedPerMtok).toBe(0.014);
    // R120-M: the ladder rides the PATCH canonically ordered, the
    // defaultEffort surviving on its own rung.
    expect(body.reasoningSupport).toEqual({
      supported: true,
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
  });

  it("nulls become blank strings; an unknown vision reads OFF; supportsThinking never enters the draft", () => {
    const draft = modelDraftFromRecord(makeModelRecord());
    expect(draft.displayName).toBe("");
    expect(draft.sizeLabel).toBe("");
    expect(draft.contextWindow).toBe("");
    expect(draft.maxOutputTokens).toBe("");
    expect(draft.inputPriceCachedPerMtok).toBe("");
    expect(draft.supportsVision).toBe(false);
    expect(draft.supportsTextOutput).toBeNull();
    expect("supportsThinking" in draft).toBe(false);
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

  it("the LIVE name wins when it differs from the id; the static row fills sizing + the pricing trio + vision", () => {
    expect(catalogPrefillFor({ id: "z-ai/glm-4.7", name: "GLM 4.7 (live)" }, staticCatalog)).toEqual({
      modelId: "z-ai/glm-4.7",
      displayName: "GLM 4.7 (live)",
      sizeLabel: "",
      contextWindow: "200000",
      maxOutputTokens: "32768",
      inputPricePerMtok: "0.1",
      inputPriceCachedPerMtok: "",
      outputPricePerMtok: "0.6",
      supportsVision: true,
      supportsTools: null,
      supportsAudio: null,
      supportsVideo: null,
      supportsPdf: null,
      supportsTextOutput: true,
      supportsImageOutput: null,
      supportsVideoOutput: null,
      supportsAudioOutput: null,
      hidden: false,
      reasoningEfforts: [],
      reasoningTouched: false,
    });
  });

  it("a name equal to the id (or blank) falls to the static displayName, then the humanized tail", () => {
    expect(catalogPrefillFor({ id: "z-ai/glm-4.7", name: "z-ai/glm-4.7" }, staticCatalog).displayName).toBe("GLM 4.7");
    expect(catalogPrefillFor({ id: "z-ai/glm-4.7", name: "" }, staticCatalog).displayName).toBe("GLM 4.7");
    expect(catalogPrefillFor({ id: "unknown/model-9", name: "unknown/model-9" }, staticCatalog).displayName).toBe("Model 9");
  });

  it("an id the static catalog does not know prefills blanks + vision false; text output still defaults ON", () => {
    expect(catalogPrefillFor({ id: "nim/custom-1", name: "Custom One" }, staticCatalog)).toEqual({
      modelId: "nim/custom-1",
      displayName: "Custom One",
      sizeLabel: "",
      contextWindow: "",
      maxOutputTokens: "",
      inputPricePerMtok: "",
      inputPriceCachedPerMtok: "",
      outputPricePerMtok: "",
      supportsVision: false,
      supportsTools: null,
      supportsAudio: null,
      supportsVideo: null,
      supportsPdf: null,
      supportsTextOutput: true,
      supportsImageOutput: null,
      supportsVideoOutput: null,
      supportsAudioOutput: null,
      hidden: false,
      reasoningEfforts: [],
      reasoningTouched: false,
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

// ── the honest test-failure copy (R116-j §1.8) ──────────────────────────────

/** A structural NetError stand-in (the real class lives in the native
 * module — kind + message is all the mapper reads). */
function netError(kind: string, message: string): Error {
  return Object.assign(new Error(message), { kind });
}

describe("testTransportFailureMessage — the class-based one-liner", () => {
  it("network kind + a timeout-shaped message → the 30s reasoning-model reality", () => {
    expect(testTransportFailureMessage(netError("network", "timeout"))).toBe(
      "The test timed out — reasoning models can take 30s.",
    );
    expect(testTransportFailureMessage(netError("network", "Read timed out"))).toBe(
      "The test timed out — reasoning models can take 30s.",
    );
    expect(testTransportFailureMessage(netError("network", "connect timed out"))).toBe(
      "The test timed out — reasoning models can take 30s.",
    );
  });

  it("network kind otherwise → the plain unreachable retry line", () => {
    expect(testTransportFailureMessage(netError("network", "Failed to connect to /192.168.1.4:8443"))).toBe(
      "Couldn't reach the desktop — try again.",
    );
  });

  it("a canceled exchange reads as unreachable (retry-shaped)", () => {
    expect(testTransportFailureMessage(netError("canceled", "call was canceled"))).toBe(
      "Couldn't reach the desktop — try again.",
    );
  });

  it("NotConnectedError (the link already fell) → the unreachable retry line", () => {
    const err = new Error("not connected to the host");
    err.name = "NotConnectedError";
    expect(testTransportFailureMessage(err)).toBe("Couldn't reach the desktop — try again.");
  });

  it("every other class surfaces the REAL message — never the blanket host-dropped line", () => {
    expect(testTransportFailureMessage(netError("tls", "certificate mismatch"))).toBe(
      "The test failed — certificate mismatch",
    );
    expect(testTransportFailureMessage(netError("unknown", "boom"))).toBe("The test failed — boom");
    expect(testTransportFailureMessage(new Error("bridge went away"))).toBe(
      "The test failed — bridge went away",
    );
  });

  it("a message-less failure reads as unreachable; a novel is scrubbed to one line", () => {
    expect(testTransportFailureMessage(netError("network", ""))).toBe(
      "Couldn't reach the desktop — try again.",
    );
    const novel = testTransportFailureMessage(netError("unknown", `${"x".repeat(300)}`));
    expect(novel.startsWith("The test failed — ")).toBe(true);
    expect(novel.length).toBeLessThan(140);
    const collapsed = testTransportFailureMessage(netError("unknown", "line\n  broken   tail"));
    expect(collapsed).toBe("The test failed — line broken tail");
  });
});

// ── R120-M: the reasoning vocabulary + the ladder editor's derivations ──────

describe("R120-M: orderedReasoningEfforts / remainingReasoningEfforts — the ladder grammar", () => {
  it("canonicalizes: vocabulary members only, deduped, lowest→highest", () => {
    expect(orderedReasoningEfforts(["high", "low", "max", "low"])).toEqual(["low", "high", "max"]);
    expect(orderedReasoningEfforts(["turbo", "minimal"])).toEqual(["minimal"]);
    expect(orderedReasoningEfforts([])).toEqual([]);
  });

  it("the remaining list is the vocabulary minus the rungs already configured", () => {
    expect(remainingReasoningEfforts(["low", "high"])).toEqual(["minimal", "medium", "xhigh", "max"]);
    expect(remainingReasoningEfforts([])).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("R120-M: reasoningSupportDraftValue — the save's write gate (R95-B contract)", () => {
  it("levels that SHOW ride even untouched — the editor owns the section", () => {
    expect(reasoningSupportDraftValue(["low", "high"], false, null)).toEqual({
      supported: true,
      efforts: ["low", "high"],
    });
  });

  it("an untouched EMPTY ladder on an unknown record writes NOTHING (undefined keeps the stored value)", () => {
    expect(reasoningSupportDraftValue([], false, null)).toBeUndefined();
    expect(reasoningSupportDraftValue([], false, { reasoningSupport: null })).toBeUndefined();
  });

  it("a TOUCHED empty ladder is an explicit write: supported keeps the record's bit (false when unknown)", () => {
    expect(reasoningSupportDraftValue([], true, null)).toEqual({ supported: false, efforts: [] });
    expect(reasoningSupportDraftValue([], true, { reasoningSupport: { supported: true, efforts: ["low"] } })).toEqual({
      supported: true,
      efforts: [],
    });
  });

  it("the record's defaultEffort survives only while its rung still stands", () => {
    expect(
      reasoningSupportDraftValue(["high"], false, {
        reasoningSupport: { supported: true, efforts: ["low", "high"], defaultEffort: "high" },
      }),
    ).toEqual({ supported: true, efforts: ["high"], defaultEffort: "high" });
    expect(
      reasoningSupportDraftValue(["medium"], false, {
        reasoningSupport: { supported: true, efforts: ["low", "high"], defaultEffort: "high" },
      }),
    ).toEqual({ supported: true, efforts: ["medium"] });
  });
});

describe("R120-M: applyModelDetailsToDraft / modelDetailsDraftPatch — the smart fetch's apply", () => {
  const details = {
    contextWindow: 256000,
    maxOutputTokens: 230400,
    inputPricePerMtok: 2.5,
    outputPricePerMtok: 10,
    inputPriceCachedPerMtok: 1.25,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: false,
  };
  const seeded = catalogPrefillFor({ id: "test/vision", name: "Vision" }, []);

  it("ADD mode: the provider's own numbers OVERRIDE the static prefill", () => {
    const applied = applyModelDetailsToDraft(seeded, details, false);
    expect(applied.contextWindow).toBe("256000");
    expect(applied.maxOutputTokens).toBe("230400");
    expect(applied.inputPricePerMtok).toBe("2.5");
    expect(applied.outputPricePerMtok).toBe("10");
    expect(applied.inputPriceCachedPerMtok).toBe("1.25");
    expect(applied.supportsVision).toBe(true);
    expect(applied.supportsTools).toBe(true);
    expect(applied.supportsAudio).toBe(true);
    expect(applied.supportsVideo).toBe(false);
  });

  it("EDIT mode: only BLANK fields take the served value — the owner's saved configuration outranks the catalog", () => {
    const ownerSet = { ...seeded, contextWindow: "100000", supportsTools: false };
    const applied = applyModelDetailsToDraft(ownerSet, details, true);
    expect(applied.contextWindow).toBe("100000");
    expect(applied.maxOutputTokens).toBe("230400");
    expect(applied.supportsTools).toBe(false);
  });

  it("EDIT mode: a record that never said vision (the draft's false) takes the catalog's bit", () => {
    expect(applyModelDetailsToDraft(seeded, details, true).supportsVision).toBe(true);
  });

  it("absent fields stay absent — never a fabricated 0", () => {
    const applied = applyModelDetailsToDraft(seeded, { contextWindow: 131072 }, false);
    expect(applied.maxOutputTokens).toBe("");
    expect(applied.supportsTools).toBeNull();
  });

  it("modelDetailsDraftPatch maps the numerics to strings + the capability hints verbatim", () => {
    expect(modelDetailsDraftPatch(details)).toEqual({
      contextWindow: "256000",
      maxOutputTokens: "230400",
      inputPricePerMtok: "2.5",
      inputPriceCachedPerMtok: "1.25",
      outputPricePerMtok: "10",
      supportsVision: true,
      supportsTools: true,
      supportsAudio: true,
      supportsVideo: false,
    });
    expect(modelDetailsDraftPatch({})).toEqual({});
  });
});

describe("R120-M: fetchProviderModelDetails — the smart fetch's wire call", () => {
  it("GETs /api/v1/providers/:id/models and finds the one entry (details + cached ride along)", async () => {
    const { sender, calls } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/models",
        status: 200,
        bodyText: JSON.stringify({
          models: [
            { id: "test/other", name: "Other" },
            {
              id: "test/vision",
              name: "Vision",
              details: { contextWindow: 256000, supportsVision: true },
            },
          ],
          cached: false,
        }),
      },
    ]);
    const outcome = await fetchProviderModelDetails(sender, "openrouter", "test/vision");
    expect(outcome.ok && outcome.data.entry?.details?.contextWindow).toBe(256000);
    expect(outcome.ok && outcome.data.cached).toBe(false);
    expect(calls[0]?.path).toBe("/api/v1/providers/openrouter/models");
  });

  it("a model the listing does not know answers entry:null — the graceful no-op, not an error", async () => {
    const { sender } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/models",
        status: 200,
        bodyText: JSON.stringify({ models: [{ id: "test/other", name: "Other" }], cached: true }),
      },
    ]);
    const outcome = await fetchProviderModelDetails(sender, "openrouter", "custom/unknown");
    expect(outcome.ok && outcome.data.entry).toBeNull();
    expect(outcome.ok && outcome.data.cached).toBe(true);
  });

  it("transport errors propagate (the screen's loader owns the offline render)", async () => {
    const { sender } = makeRouteSender([
      {
        path: "/api/v1/providers/openrouter/models",
        status: 503,
        bodyText: JSON.stringify({ error: { message: "the sidecar is restarting" } }),
      },
    ]);
    const outcome = await fetchProviderModelDetails(sender, "openrouter", "test/vision");
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.status).toBe(503);
  });
});

describe("R120-M: modelTestToastText — the ONE toast line (item 16)", () => {
  const base = {
    ok: true,
    latencyMs: 1234,
    providerId: "openrouter",
    model: "z-ai/glm-4.7",
    checks: { http: true, auth: true, modelAccepted: true, nonEmptyContent: true },
  } as const;

  it("a clean pass without the tools leg is the saved one-liner", () => {
    expect(modelTestToastText(base)).toEqual({ kind: "saved", text: "ok · 1234ms" });
  });

  it("the tools verdict joins the line — called reads saved, text-answered reads caution", () => {
    expect(
      modelTestToastText({ ...base, checks: { ...base.checks, toolsAccepted: true, toolCalled: true } }),
    ).toEqual({ kind: "saved", text: "ok · 1234ms · tools ✓ (called echo)" });
    expect(
      modelTestToastText({ ...base, checks: { ...base.checks, toolsAccepted: true, toolCalled: false } }).kind,
    ).toBe("caution");
  });

  it("a failed base or a rejected tools leg fails the whole line — the worst news sets the tone", () => {
    expect(modelTestToastText({ ...base, ok: false, reason: "401 unauthorized" })).toEqual({
      kind: "error",
      text: "failed — 401 unauthorized",
    });
    expect(
      modelTestToastText({ ...base, ok: false, reason: "401 unauthorized", checks: { ...base.checks, toolsAccepted: false } }).kind,
    ).toBe("error");
  });

  it("the joined line caps at 140 chars — a verdict is a line, never a wall", () => {
    const long = modelTestToastText({
      ...base,
      ok: false,
      reason: "x".repeat(300),
      checks: { ...base.checks, toolsAccepted: false },
    });
    expect(long.text.length).toBeLessThanOrEqual(140);
    expect(long.text.endsWith("…")).toBe(true);
  });
});
