// @vitest-environment happy-dom
/**
 * ROUND-47 (R47-c1) — provider-management consolidation regression tests:
 *
 *  1. KeyPoolSection slot-collision fix: slots 2 & 4 held → the next add
 *     writes slot 3 (the old `slots.length + 2` computed 4 and OVERWROTE
 *     the held slot-4 key).
 *  2. Full pool (slots 2–31) → honest error, no PUT.
 *  3. The connection card's new test surface: key selector (primary + held
 *     pool slots) + model selector (reachability default) → POST
 *     /providers/:id/test carries {slot, model}; ok:false at HTTP 200
 *     renders the honest red message; reachability-only surfaces the
 *     backend's own note.
 *  4. Browser-dev ephemeral-key notes render (isTauri() is false in tests).
 *
 * ROUND-50 (R50-d) — the models/providers page rebuild:
 *  5. Independent scrolling: the provider list (left) and the detail pane
 *     (right) are TWO separate .overflow-y-auto.auto-scroll columns — no
 *     shared page scroll.
 *  6. The detail pane's sectioned cards (Connection / API key pool /
 *     Models / Danger zone).
 *  7. The catalog-driven "Add models" picker: search, free/paid badges,
 *     multi-select bulk add → ONE upsert per selected model with the served
 *     catalog's pricing pre-filled; already-added rows disabled.
 *  8. The per-model configuration dialog round-trips pricing fields through
 *     PATCH /models/:id (empty price → null = unknown, never 0).
 *  9. The manual add-by-id fallback when the live catalog is unreachable.
 *
 * The api-level fns themselves are covered exhaustively in
 * src/lib/api.test.ts; this file covers the WIRING.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { KeyPoolSection, ModelsProvidersTab } from "./ModelsProvidersTab";
import { resetTestState, renderWithProviders } from "../../test-utils";
import type { CatalogModel, KeyPoolSlot, ProviderModelConfig, ProviderView } from "../../lib/api";

/* ── Stateful fetch mock (the sidecar API surface this tab touches) ───────── */

const BASE = "http://127.0.0.1:5178";
const calls: Array<{ method: string; url: string; body?: unknown }> = [];

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

let pool: KeyPoolSlot[] = [];
/** What POST /providers/:id/test answers this test (ok:true / ok:false). */
let testResponse: unknown = {
  ok: true,
  latencyMs: 312,
  message: "Reachable — pick a model for a full key + model test.",
};

/* ── ROUND-50 (R50-d): stateful model-config + catalog mock state ─────────── */

/** GET /providers/:id/models-config rows (POST/PATCH/DELETE mutate this). */
let configured: ProviderModelConfig[] = [];

/** GET /providers/:id/models entries — null ⇒ the route 404s (unreachable). */
let liveCatalog: Array<{ id: string; name?: string }> | null = [
  { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
];

/** GET /models/catalog .models (the served static catalog, R47-b shape). */
const STATIC_CATALOG: CatalogModel[] = [
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
  {
    modelId: "openai/gpt-4o",
    displayName: "OpenAI: GPT-4o",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePerMtok: 2.5,
    inputPriceCachedPerMtok: 1.25,
    outputPricePerMtok: 10,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
];

/** Build a full ProviderModelConfig row the way the sidecar does. */
function modelRow(overrides: Partial<ProviderModelConfig> & { modelId: string }): ProviderModelConfig {
  return {
    id: `mdl_${overrides.modelId}`,
    providerId: "openrouter",
    displayName: overrides.modelId,
    contextWindow: null,
    maxOutputTokens: null,
    inputPricePerMtok: null,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: null,
    supportsThinking: false,
    hidden: false,
    sortOrder: 0,
    createdAt: "2026-08-30T09:00:00Z",
    updatedAt: "2026-08-30T09:00:00Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { status: 200, ok: true, text: async () => JSON.stringify(body) } as unknown as Response;
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : undefined;
  calls.push({ method, url, body });

  if (url === `${BASE}/api/v1/providers` && method === "GET") {
    return jsonResponse({ providers: [PROVIDER] });
  }
  // Key pool (GET list + stateful PUT/DELETE per slot).
  const keyMatch = url.match(/\/api\/v1\/providers\/openrouter\/keys(?:\/(\d+))?$/);
  if (keyMatch !== null) {
    if (keyMatch[1] === undefined) return jsonResponse({ keys: pool });
    const slot = Number(keyMatch[1]);
    if (method === "PUT") {
      const value = String((body as { value: string }).value);
      pool = pool.filter((k) => k.slot !== slot);
      pool.push({ slot, hasKey: true, masked: `${value.slice(0, 5)}…${value.slice(-4)}` });
      pool.sort((a, b) => a.slot - b.slot);
      return jsonResponse({ keys: pool });
    }
    if (method === "DELETE") {
      pool = pool.filter((k) => k.slot !== slot);
      pool.push({ slot, hasKey: false, masked: null });
      pool.sort((a, b) => a.slot - b.slot);
      return jsonResponse({ keys: pool });
    }
  }
  // ROUND-50 (R50-d): the served static catalog (picker free/paid + pricing).
  if (url === `${BASE}/api/v1/models/catalog` && method === "GET") {
    return jsonResponse({
      models: STATIC_CATALOG,
      defaultModelId: "z-ai/glm-5.2:free",
      subagentDefaultModelId: "nvidia/nemotron-3.5-lightning:free",
      recommendedModelIds: ["z-ai/glm-5.2:free"],
    });
  }
  if (url === `${BASE}/api/v1/providers/openrouter/models-config` && method === "GET") {
    return jsonResponse({ models: configured });
  }
  // ROUND-50 (R50-d): model-config upsert (the picker's bulk add + manual id).
  if (url === `${BASE}/api/v1/providers/openrouter/models` && method === "POST") {
    const input = body as Record<string, unknown>;
    const row = modelRow({
      modelId: String(input.modelId),
      displayName: input.displayName === undefined ? String(input.modelId) : String(input.displayName),
      contextWindow: (input.contextWindow as number | null | undefined) ?? null,
      maxOutputTokens: (input.maxOutputTokens as number | null | undefined) ?? null,
      inputPricePerMtok: (input.inputPricePerMtok as number | null | undefined) ?? null,
      inputPriceCachedPerMtok: (input.inputPriceCachedPerMtok as number | null | undefined) ?? null,
      outputPricePerMtok: (input.outputPricePerMtok as number | null | undefined) ?? null,
      supportsThinking: input.supportsThinking === true,
      hidden: input.hidden === true,
    });
    configured = configured.filter((m) => m.modelId !== row.modelId);
    configured.push(row);
    return { status: 201, ok: true, text: async () => JSON.stringify(row) } as unknown as Response;
  }
  // ROUND-50 (R50-d): per-model PATCH (the configuration dialog).
  const patchMatch = url.match(/\/api\/v1\/models\/(mdl_[^/]+)$/);
  if (patchMatch !== null && method === "PATCH") {
    const row = configured.find((m) => m.id === patchMatch[1]);
    if (row === undefined) {
      return {
        status: 404,
        ok: false,
        text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: `no model with id ${patchMatch[1]}` } }),
      } as unknown as Response;
    }
    const patch = body as Record<string, unknown>;
    Object.assign(row, patch);
    row.updatedAt = "2026-08-30T10:00:00Z";
    return jsonResponse(row);
  }
  if (patchMatch !== null && method === "DELETE") {
    configured = configured.filter((m) => m.id !== patchMatch[1]);
    return { status: 204, ok: true, text: async () => "" } as unknown as Response;
  }
  if (url === `${BASE}/api/v1/providers/openrouter/models` && method === "GET") {
    if (liveCatalog === null) {
      return {
        status: 502,
        ok: false,
        text: async () => JSON.stringify({ error: { code: "PROVIDER_ERROR", message: "upstream unreachable" } }),
      } as unknown as Response;
    }
    return jsonResponse({ models: liveCatalog });
  }
  if (url === `${BASE}/api/v1/providers/openrouter/test` && method === "POST") {
    return jsonResponse(testResponse);
  }
  return {
    status: 404,
    ok: false,
    text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: `unmocked ${method} ${url}` } }),
  } as unknown as Response;
});

beforeEach(() => {
  resetTestState();
  calls.length = 0;
  pool = [];
  configured = [];
  liveCatalog = [{ id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" }];
  testResponse = { ok: true, latencyMs: 312, message: "Reachable — pick a model for a full key + model test." };
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ── KeyPoolSection: the slot-collision fix (the round's bug) ─────────────── */

describe("KeyPoolSection — next-free-slot (ROUND-47 R47-c1)", () => {
  it("slots 2 & 4 held → the next add PUTs slot 3 (the old code overwrote 4)", async () => {
    pool = [
      { slot: 2, hasKey: true, masked: "sk-o…aaaa" },
      { slot: 4, hasKey: true, masked: "sk-o…cccc" },
    ];
    renderWithProviders(<KeyPoolSection providerId="openrouter" />);

    fireEvent.change(await screen.findByLabelText("New pool key"), {
      target: { value: "sk-or-v1-pool-key-003" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/keys/3"));
      expect(put).toBeDefined();
      expect(put?.body).toEqual({ value: "sk-or-v1-pool-key-003" });
    });
    // The held slot-4 key is NEVER written.
    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/keys/4"))).toBe(false);
    // The saved slot re-renders masked.
    await waitFor(() => expect(screen.getByText("sk-or…-003")).toBeTruthy());
  });

  it("contiguous pool → one past the last (2,3,4 held → slot 5)", async () => {
    pool = [
      { slot: 2, hasKey: true, masked: "sk-o…aaaa" },
      { slot: 3, hasKey: true, masked: "sk-o…bbbb" },
      { slot: 4, hasKey: true, masked: "sk-o…cccc" },
    ];
    renderWithProviders(<KeyPoolSection providerId="openrouter" />);

    fireEvent.change(await screen.findByLabelText("New pool key"), {
      target: { value: "sk-or-v1-pool-key-005" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/keys/5"))).toBeDefined();
    });
  });

  it("full pool (slots 2–31) → honest error, no PUT at all", async () => {
    pool = Array.from({ length: 30 }, (_, i) => ({
      slot: i + 2,
      hasKey: true,
      masked: `sk-o…${String(i).padStart(2, "0")}`,
    }));
    renderWithProviders(<KeyPoolSection providerId="openrouter" />);

    fireEvent.change(await screen.findByLabelText("New pool key"), {
      target: { value: "sk-or-v1-overflow" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));

    await waitFor(() =>
      expect(screen.getByText("the key pool is full (slots 2–31)")).toBeTruthy(),
    );
    expect(calls.every((c) => c.method !== "PUT")).toBe(true);
  });

  it("shows the browser-dev ephemeral-key note (isTauri() false)", async () => {
    renderWithProviders(<KeyPoolSection providerId="openrouter" />);
    await waitFor(() =>
      expect(screen.getByText(/Browser-dev keys live in server memory only/)).toBeTruthy(),
    );
  });
});

/* ── The connection card's explicit test surface (key + model selectors) ──── */

describe("Connection card — key + model scoped test (ROUND-47 R47-c1)", () => {
  /** Render the tab and open the (single) provider's detail pane. */
  async function openProviderDetail() {
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByRole("button", { name: /openrouter/i }));
    await waitFor(() => expect(screen.getByLabelText("Test key")).toBeTruthy());
  }

  it("key selector offers the primary + every HELD pool slot (shared key-pool cache)", async () => {
    pool = [
      { slot: 2, hasKey: true, masked: "sk-o…aaaa" },
      { slot: 3, hasKey: false, masked: null }, // keyless rows are NOT offered
      { slot: 4, hasKey: true, masked: "sk-o…cccc" },
    ];
    await openProviderDetail();

    // The pool query lands async — wait for its options before asserting.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Pool slot 2" })).toBeTruthy(),
    );
    expect(screen.getByRole("option", { name: "Primary key" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Pool slot 4" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Pool slot 3" })).toBeNull();
    // Model selector: the honest reachability default + the live catalog.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "z-ai/glm-5.2:free" })).toBeTruthy(),
    );
    expect(screen.getByRole("option", { name: "(reachability only)" })).toBeTruthy();
  });

  it("default test POSTs an empty body (primary key, reachability only) and surfaces the backend's note", async () => {
    await openProviderDetail();

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/test"),
      );
      expect(post).toBeDefined();
      expect(post?.body).toEqual({});
    });
    // ok + server-measured latency in green…
    await waitFor(() => expect(screen.getByText(/Connected · 312ms/)).toBeTruthy());
    // …plus the backend's OWN reachability-only message (not hardcoded copy).
    expect(screen.getByText(/Reachable — pick a model for a full key \+ model test/)).toBeTruthy();
  });

  it("selecting a pool slot + a model sends {slot, model} — the R47-b contract body", async () => {
    pool = [{ slot: 2, hasKey: true, masked: "sk-o…aaaa" }];
    testResponse = { ok: true, latencyMs: 87, model: "z-ai/glm-5.2:free" };
    await openProviderDetail();

    // The slot option must exist before the select can take its value.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Pool slot 2" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Test key"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Test model"), {
      target: { value: "z-ai/glm-5.2:free" },
    });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/test"),
      );
      expect(post).toBeDefined();
      expect(post?.body).toEqual({ slot: 2, model: "z-ai/glm-5.2:free" });
    });
    await waitFor(() =>
      expect(screen.getByText(/Connected · 87ms · z-ai\/glm-5\.2:free/)).toBeTruthy(),
    );
  });

  it("ok:false at HTTP 200 renders the provider's honest refusal in red — no error toast", async () => {
    testResponse = { ok: false, message: "key rejected by provider (HTTP 401)" };
    await openProviderDetail();

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    const refusal = await screen.findByText("key rejected by provider (HTTP 401)");
    expect(refusal.style.color).toBe("#ef4444");
  });
});

/* ── ROUND-50 (R50-d): independent scrolling + the sectioned detail pane ──── */

describe("Independent scroll columns + sectioned detail pane (ROUND-50 R50-d)", () => {
  it("renders TWO separate .overflow-y-auto.auto-scroll columns — the left provider list and the right detail pane scroll independently", async () => {
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByRole("button", { name: /openrouter/i }));
    await waitFor(() => expect(screen.getByLabelText("Test key")).toBeTruthy());

    // The two independent scroll containers (left list body + right pane).
    const scrollables = Array.from(document.querySelectorAll(".overflow-y-auto"));
    expect(scrollables.length).toBeGreaterThanOrEqual(2);
    const autoScrolls = scrollables.filter((el) => el.classList.contains("auto-scroll"));
    expect(autoScrolls.length).toBeGreaterThanOrEqual(2);

    // The LEFT column keeps its natural width; the RIGHT column flexes.
    const left = document.querySelector(".w-\\[280px\\]");
    expect(left).not.toBeNull();
    const right = document.querySelector(".flex-1.min-w-0.min-h-0.flex.flex-col");
    expect(right).not.toBeNull();
  });

  it("sections the detail pane into labeled cards: Connection / API key pool / Models / Danger zone", async () => {
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByRole("button", { name: /openrouter/i }));
    await waitFor(() => expect(screen.getByLabelText("Test key")).toBeTruthy());

    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByText("API key pool")).toBeTruthy();
    expect(screen.getByText("Models")).toBeTruthy();
    expect(screen.getByText("Danger zone")).toBeTruthy();
    // The delete affordance moved into the danger zone (confirm flow intact).
    expect(screen.getByRole("button", { name: "Delete provider OpenRouter" })).toBeTruthy();
  });
});

/* ── ROUND-50 (R50-d): the catalog-driven "Add models" picker ─────────────── */

describe("Add models — catalog picker (ROUND-50 R50-d)", () => {
  /** Open the single provider's detail pane + the picker dialog. */
  async function openPicker() {
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByRole("button", { name: /openrouter/i }));
    fireEvent.click(await screen.findByRole("button", { name: /add models/i }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Add models" })).toBeTruthy());
  }

  it("lists the live catalog with FREE/PAID badges; already-configured rows are disabled + ADDED", async () => {
    liveCatalog = [
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
    ];
    configured = [modelRow({ modelId: "z-ai/glm-5.2:free", displayName: "Z.ai: GLM 5.2" })];
    await openPicker();

    const dialog = screen.getByRole("dialog", { name: "Add models" });
    const freeCheckbox = (await within(dialog).findByLabelText(
      "Select model z-ai/glm-5.2:free",
    )) as HTMLInputElement;
    expect(freeCheckbox.disabled).toBe(true);
    expect(freeCheckbox.checked).toBe(true);
    expect(within(dialog).getByText("ADDED")).toBeTruthy();
    expect(within(dialog).getAllByText("FREE").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("PAID")).toBeTruthy();
  });

  it("multi-select + bulk add: ONE upsert per selected model, pricing pre-filled from the served catalog", async () => {
    liveCatalog = [
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "custom/other", name: "Other" },
    ];
    await openPicker();

    fireEvent.click(await screen.findByLabelText("Select model openai/gpt-4o"));
    fireEvent.click(screen.getByLabelText("Select model custom/other"));

    const bulk = screen.getByRole("button", { name: "Add 2 models" });
    fireEvent.click(bulk);

    await waitFor(() => {
      const posts = calls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/models"),
      );
      expect(posts).toHaveLength(2);
    });
    const bodies = calls
      .filter((c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/models"))
      .map((c) => c.body as Record<string, unknown>);
    // gpt-4o: live-catalog display name + the served catalog's full pricing.
    expect(bodies).toContainEqual({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      contextWindow: 128000,
      maxOutputTokens: 16384,
      inputPricePerMtok: 2.5,
      inputPriceCachedPerMtok: 1.25,
      outputPricePerMtok: 10,
    });
    // custom/other: no catalog metadata → the bare model id + live name.
    expect(bodies).toContainEqual({ modelId: "custom/other", displayName: "Other" });

    // The dialog closes on full success.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add models" })).toBeNull(),
    );
  });

  it("search filters by model id AND display name", async () => {
    liveCatalog = [
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
    ];
    await openPicker();

    fireEvent.change(await screen.findByLabelText("Search catalog models"), {
      target: { value: "gpt" },
    });
    await waitFor(() => expect(screen.getByLabelText("Select model openai/gpt-4o")).toBeTruthy());
    expect(screen.queryByLabelText("Select model z-ai/glm-5.2:free")).toBeNull();

    // …and by display name ("Inkling" matches the name, not the id).
    fireEvent.change(screen.getByLabelText("Search catalog models"), {
      target: { value: "GLM" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Select model z-ai/glm-5.2:free")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Select model openai/gpt-4o")).toBeNull();
  });

  it("manual add-by-id fallback: unreachable live catalog → the by-id form still adds the model", async () => {
    liveCatalog = null; // the provider's /models fetch fails
    await openPicker();

    await waitFor(() =>
      expect(screen.getByText(/live catalog is unreachable for this provider/i)).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText("Model id"), {
      target: { value: "my/custom-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add by id/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/models"),
      );
      expect(post).toBeDefined();
      expect(post?.body).toEqual({ modelId: "my/custom-model" });
    });
    await waitFor(() => expect(screen.getByText("Added my/custom-model.")).toBeTruthy());
  });
});

/* ── ROUND-50 (R50-d): the per-model configuration dialog ─────────────────── */

describe("Configure model dialog — pricing round-trip (ROUND-50 R50-d)", () => {
  it("pre-fills every field, PATCHes edited pricing, and clears a price with empty → null (never 0)", async () => {
    configured = [
      modelRow({
        id: "mdl_z-ai-glm",
        modelId: "z-ai/glm-5.2:free",
        displayName: "Z.ai: GLM 5.2",
        contextWindow: 256000,
        maxOutputTokens: 230400,
        inputPricePerMtok: 0.15,
        inputPriceCachedPerMtok: 0.02,
        outputPricePerMtok: 0.6,
        supportsThinking: true,
        hidden: false,
      }),
    ];
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByRole("button", { name: /openrouter/i }));

    // The row shows the compact pricing summary (mono micro-type).
    await waitFor(() => expect(screen.getByText("$0.15 in / $0.6 out / $0.02 cache")).toBeTruthy());

    fireEvent.click(
      await screen.findByRole("button", { name: "Configure model Z.ai: GLM 5.2" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Configure model" });

    // Pre-filled from the stored row.
    const inputPrice = within(dialog).getByLabelText("Input price ($/Mtok)") as HTMLInputElement;
    expect(inputPrice.value).toBe("0.15");
    expect((within(dialog).getByLabelText("Cache read price ($/Mtok)") as HTMLInputElement).value).toBe("0.02");
    expect((within(dialog).getByLabelText("Context window (tokens)") as HTMLInputElement).value).toBe("256000");

    // Edit the input price; clear the cache price (empty = unknown → null).
    fireEvent.change(inputPrice, { target: { value: "0.5" } });
    fireEvent.change(within(dialog).getByLabelText("Cache read price ($/Mtok)"), {
      target: { value: "" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/models/mdl_z-ai-glm"));
      expect(patch).toBeDefined();
      expect(patch?.body).toEqual({
        displayName: "Z.ai: GLM 5.2",
        contextWindow: 256000,
        maxOutputTokens: 230400,
        inputPricePerMtok: 0.5,
        inputPriceCachedPerMtok: null, // cleared — unknown, NOT $0.02 and NOT 0
        outputPricePerMtok: 0.6,
        supportsThinking: true,
        hidden: false,
      });
    });
    // The dialog closes on save.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Configure model" })).toBeNull(),
    );
  });

  it("rejects junk input inline — no PATCH leaves the page", async () => {
    configured = [
      modelRow({ id: "mdl_z-ai-glm", modelId: "z-ai/glm-5.2:free", displayName: "Z.ai: GLM 5.2" }),
    ];
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByRole("button", { name: /openrouter/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Configure model Z.ai: GLM 5.2" }));

    const dialog = await screen.findByRole("dialog", { name: "Configure model" });
    fireEvent.change(within(dialog).getByLabelText("Input price ($/Mtok)"), {
      target: { value: "cheap" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));

    await waitFor(() =>
      expect(screen.getByText("Input price must be a number ≥ 0 (or empty for unknown).")).toBeTruthy(),
    );
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Configure model" })).toBeTruthy();
  });
});
