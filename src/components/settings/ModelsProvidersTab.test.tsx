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
 *
 * ROUND-59 (R59-C) — the owner's four directives, regressed here:
 *  10. Unconfigured seeded presets are ABSENT from the left list (the R58
 *      "Not configured" group is gone); the count reflects what is shown.
 *  11. Disabling a provider is OUTRIGHT — the PATCH fires immediately, no
 *      confirm box in the DOM (even with agents referencing it).
 *  12. Pre-select: the FIRST provider's detail pane opens without a click;
 *      an explicit selection survives refreshes; deleting the selected
 *      provider falls to the next one; empty list → placeholder card.
 *
 * ROUND-60 (R60-B) — the settings deep-clean, regressed here:
 *  13. The API-key field: ONE unified layout — [input][eye in the EXACT
 *      same DOM slot every state][context action]. Show → revealed +
 *      Copy; Hide → masked again through the same button node; NO rotate
 *      flow — pasting/typing a new key swaps to edit mode (new-key-input +
 *      save-key-button + cancel-key-edit-button, Escape restores), Save
 *      PUTs and the masked view returns with the NEW key's mask.
 *  14. The models list shows CONFIGURED rows ONLY — live catalog entries
 *      never render as rows (no "catalog" badge, no count inflation), and
 *      every configured row — free ones included — is customizable
 *      (FREE badge + pencil + delete).
 *  15. The Add-models picker owns the Free only ↔ All models toggle
 *      (picker-free-only-toggle / picker-all-models-toggle) on the SHARED
 *      persisted modelsFreeOnly pref the chat picker honors; free-only
 *      filters the rows BEFORE the 300 cap; an honest empty note when the
 *      free scope empties the list.
 *
 * ROUND-62 (R62-2b) — the owner's "not proper / doesn't reflect / can't
 * configure per-1M pricing" directive, regressed here:
 *  16. Every mutation (model save/delete/add, provider toggle/delete) fans
 *      its invalidation out to the SESSION PAGE's picker cache families
 *      (["composer-providers"], ["provider-models", id],
 *      ["provider-models-config", id]) — seeded fresh with a 5-minute
 *      staleTime in a local QueryClient, flipped STALE by the mutation.
 *  17. The pricing dialog: the unit is IN every label ("$ per 1M tokens"),
 *      decimals (0.075) round-trip exactly, and the NEW Supports-vision
 *      toggle PATCHes supportsVision.
 *  18. Honest load states: a failed GET /providers renders a red alert (not
 *      the silent "no providers" page); a failed models-config fetch shows
 *      the error line instead of the misleading "No models yet".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { KeyPoolSection, ModelsProvidersTab } from "./ModelsProvidersTab";
import { resetTestState, renderWithProviders } from "../../test-utils";
import { useSettingsStore } from "../../lib/settings-store";
import type { CatalogModel, KeyPoolSlot, ProviderModelConfig, ProviderView } from "../../lib/api";

/* ── Stateful fetch mock (the sidecar API surface this tab touches) ───────── */

const BASE = "http://127.0.0.1:5178";
const calls: Array<{ method: string; url: string; body?: unknown }> = [];
/** ROUND-58 (R58-d): the clipboard stub for the reveal-copy assertions. */
const clipboardWriteText = vi.fn(async (_text: string) => undefined);

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

/* ── ROUND-58 (R58-d) test fixtures ───────────────────────────────────────── */

/** A keyless seeded preset — R59-C: hidden from the list ENTIRELY (the
 * owner deleted the three by hand and wants them never to appear).
 * Still served by GET /providers to prove the hiding is client-side. */
const ANTHROPIC: ProviderView = {
  id: "anthropic",
  name: "Anthropic",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiFormat: "anthropic-messages",
  enabled: true,
  createdAt: "2026-08-21T09:01:00Z",
  hasKey: false,
};
const OPENAI: ProviderView = {
  id: "openai",
  name: "OpenAI",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiFormat: "chat-completions",
  enabled: true,
  createdAt: "2026-08-21T09:02:00Z",
  hasKey: false,
};
const GOOGLE: ProviderView = {
  id: "google",
  name: "Google",
  kind: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiFormat: "chat-completions",
  enabled: true,
  createdAt: "2026-08-21T09:03:00Z",
  hasKey: false,
};

/** A user-created CUSTOM provider (not a reserved id) — always a "live"
 * row, and its Connection card shows Base URL + API format. */
const CUSTOM_PROVIDER: ProviderView = {
  id: "my-gateway",
  name: "My Gateway",
  kind: "openai-compatible",
  baseUrl: "https://gw.example.com/v1",
  apiFormat: "chat-completions",
  enabled: true,
  createdAt: "2026-08-21T09:04:00Z",
  hasKey: true,
};

/** GET /providers response (tests append preset/custom rows). */
let providersList: ProviderView[] = [];
/** PATCH /providers/:id bodies (the disable flow). */
let patchResponses: Array<{ id: string; body: Record<string, unknown> }> = [];
/** POST /providers/:id/keys/reveal response. */
let revealKeys: Array<{ slot: number; value: string }> = [];
/** R59-C: when true, the reveal route answers HTTP 500 (the error path). */
let revealFails = false;
/** R62-2b: when true, GET /providers answers HTTP 500 (the load-error path). */
let providersFail = false;
/** R62-2b: when true, GET /providers/openrouter/models-config answers
 * HTTP 500 (the models-load-error path). */
let modelsConfigFail = false;

let pool: KeyPoolSlot[] = [];
/** What POST /providers/:id/test answers this test (ok:true / ok:false). */
let testResponse: unknown = {
  ok: true,
  latencyMs: 312,
  message: "Reachable — pick a model for a full key + model test.",
};

/* ── ROUND-50 (R50-d): stateful model-config + catalog mock state ─────────── */

/** GET /providers/:id/models-config rows (POST/PATCH/DELETE mutate this) —
 * the openrouter provider's list (the fixture agents' provider). */
let configured: ProviderModelConfig[] = [];
/** The CUSTOM provider's models-config rows (R58-d merge-scoping tests). */
let customConfigured: ProviderModelConfig[] = [];

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
    supportsVision: false,
    // ROUND-82: the tri-state capability flags (null = unknown) — tests
    // that care override them per-row.
    supportsTools: true,
    supportsAudio: null,
    supportsVideo: null,
    supportsPdf: null,
    supportsTextOutput: true,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
    sizeLabel: null,
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
    // R62-2b: the honest failure path (HTTP 500 → ApiError → red alert).
    if (providersFail) {
      return {
        status: 500,
        ok: false,
        text: async () =>
          JSON.stringify({ error: { code: "INTERNAL", message: "providers route exploded" } }),
      } as unknown as Response;
    }
    return jsonResponse({ providers: providersList });
  }
  // ROUND-58 (R58-d): PATCH /providers/:id — the enable/disable toggle.
  const providerPatchMatch = url.match(/\/api\/v1\/providers\/([^/]+)$/);
  if (providerPatchMatch !== null && method === "PATCH") {
    const id = providerPatchMatch[1];
    const patch = (body ?? {}) as Record<string, unknown>;
    patchResponses.push({ id, body: patch });
    const updated = providersList.find((p) => p.id === id);
    if (updated === undefined) {
      return {
        status: 404,
        ok: false,
        text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: `no provider with id ${id}` } }),
      } as unknown as Response;
    }
    Object.assign(updated, patch);
    return jsonResponse(updated);
  }
  // R59-C: DELETE /providers/:id — the delete-selected-falls-to-next flow.
  if (providerPatchMatch !== null && method === "DELETE") {
    const id = providerPatchMatch[1];
    const before = providersList.length;
    providersList = providersList.filter((p) => p.id !== id);
    if (providersList.length === before) {
      return {
        status: 404,
        ok: false,
        text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: `no provider with id ${id}` } }),
      } as unknown as Response;
    }
    return { status: 204, ok: true, text: async () => "" } as unknown as Response;
  }
  // ROUND-58 (R58-d): POST /providers/:id/keys/reveal — the full values.
  const revealMatch = url.match(/\/api\/v1\/providers\/([^/]+)\/keys\/reveal$/);
  if (revealMatch !== null && method === "POST") {
    // R59-C: the honest failure path (HTTP 500 → ApiError → red error line).
    if (revealFails) {
      return {
        status: 500,
        ok: false,
        text: async () =>
          JSON.stringify({ error: { code: "KEYRING", message: "reveal failed (sidecar keyring unavailable)" } }),
      } as unknown as Response;
    }
    return jsonResponse({ keys: revealKeys });
  }
  // R59-C: PUT /providers/:id/key — the paste-to-replace save (browser-dev
  // path). Updates the pool listing's slot-0 masked value (the post-save
  // masked display is honest — the pane invalidates + refetches it) and
  // flips hasKey on the providers row (a stored key makes a keyless preset
  // configured again).
  const keyPutMatch = url.match(/\/api\/v1\/providers\/([^/]+)\/key$/);
  if (keyPutMatch !== null && method === "PUT") {
    const value = String((body as { value: string }).value);
    pool = pool.filter((k) => k.slot !== 0);
    pool.push({ slot: 0, hasKey: true, masked: `${value.slice(0, 5)}…${value.slice(-4)}` });
    pool.sort((a, b) => a.slot - b.slot);
    const saved = providersList.find((p) => p.id === keyPutMatch[1]);
    if (saved !== undefined) saved.hasKey = true;
    return { status: 204, ok: true, text: async () => "" } as unknown as Response;
  }
  // Key pool (GET list + stateful PUT/DELETE per slot) — provider-scoped.
  const keyMatch = url.match(/\/api\/v1\/providers\/([^/]+)\/keys(?:\/(\d+))?$/);
  if (keyMatch !== null) {
    if (keyMatch[2] === undefined) return jsonResponse({ keys: pool });
    const slot = Number(keyMatch[2]);
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
    // R62-2b: the honest failure path (HTTP 500 → ApiError → the red line
    // replaces the misleading "No models yet" empty state).
    if (modelsConfigFail) {
      return {
        status: 500,
        ok: false,
        text: async () =>
          JSON.stringify({ error: { code: "INTERNAL", message: "models-config route exploded" } }),
      } as unknown as Response;
    }
    return jsonResponse({ models: configured });
  }
  // ROUND-58 (R58-d): the custom provider's models-config (merge scoping).
  if (url === `${BASE}/api/v1/providers/my-gateway/models-config` && method === "GET") {
    return jsonResponse({ models: customConfigured });
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
  // ROUND-58 (R58-d): the custom provider's live catalog (served the same,
  // but its entries must NOT merge into the models LIST — only the picker).
  if (url === `${BASE}/api/v1/providers/my-gateway/models` && method === "GET") {
    return jsonResponse({ models: liveCatalog ?? [] });
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
  // R60-B: the shared persisted free-only pref — reset to the owner default
  // for EVERY test (a test that flips it must not leak into the next).
  useSettingsStore.setState({ modelsFreeOnly: true });
  calls.length = 0;
  providersList = [PROVIDER].map((p) => ({ ...p }));
  patchResponses = [];
  revealKeys = [];
  revealFails = false;
  providersFail = false;
  modelsConfigFail = false;
  pool = [];
  configured = [];
  customConfigured = [];
  liveCatalog = [{ id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" }];
  testResponse = { ok: true, latencyMs: 312, message: "Reachable — pick a model for a full key + model test." };
  clipboardWriteText.mockClear();
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: clipboardWriteText },
    configurable: true,
  });
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
  /** Render the tab and open the (single) provider's detail pane — R59-C:
   * pre-select opens the FIRST provider (openrouter) without any click. */
  async function openProviderDetail() {
    renderWithProviders(<ModelsProvidersTab />);
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
    // R59-C: pre-select opens the first provider — no click needed.
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
  /** Open the first provider's detail pane + the picker dialog. */
  async function openPicker() {
    renderWithProviders(<ModelsProvidersTab />);
    // R59-C: pre-select opens the first provider — no click needed.
    await waitFor(() => expect(screen.getByLabelText("Test key")).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: /add models/i }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Add models" })).toBeTruthy());
  }

  it("lists the live catalog with FREE/PAID badges; already-configured rows are disabled + ADDED", async () => {
    // R60-B: paid rows render only in the All-models scope — start there.
    useSettingsStore.setState({ modelsFreeOnly: false });
    liveCatalog = [
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
    ];
    configured = [modelRow({ modelId: "z-ai/glm-5.2:free", displayName: "Z.ai: GLM 5.2" })];
    await openPicker();

    const dialog = screen.getByRole("dialog", { name: "Add models" });
    // ROUND-87 (R87): rows are clean clickable cards — the already-configured
    // one is a DISABLED button carrying the ADDED badge (no checkboxes).
    const addedRow = (await within(dialog).findByLabelText(
      "Configure and add z-ai/glm-5.2:free",
    )) as HTMLButtonElement;
    expect(addedRow.disabled).toBe(true);
    expect(within(dialog).getByText("ADDED")).toBeTruthy();
    expect(within(dialog).getAllByText("FREE").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("PAID")).toBeTruthy();
    // The pickable row is enabled and carries the configure affordance.
    const pickable = within(dialog).getByLabelText("Configure and add openai/gpt-4o") as HTMLButtonElement;
    expect(pickable.disabled).toBe(false);
    expect(within(dialog).getByText("CONFIGURE →")).toBeTruthy();
  });

  it("ROUND-87: clicking a model OPENS THE CONFIGURE DIALOG (never a direct add) — the prefill arrives pre-filled and the save upserts once", async () => {
    // R60-B: All-models scope (the fixture mixes free + paid + unknown).
    useSettingsStore.setState({ modelsFreeOnly: false });
    liveCatalog = [
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
    ];
    await openPicker();

    // Click the paid row — the picker closes and the ADD-mode config dialog
    // opens with the catalog prefill (the owner: "it should give the user
    // the option to set them up").
    fireEvent.click(await screen.findByLabelText("Configure and add openai/gpt-4o"));
    const dialog = await screen.findByRole("dialog", { name: "Add model" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add models" })).toBeNull(),
    );

    // The prefill: the display name + the id (editable in add mode)…
    expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).value).toBe("GPT-4o");
    expect((within(dialog).getByLabelText("Model id") as HTMLInputElement).value).toBe("openai/gpt-4o");
    // …and the served catalog's full pricing + sizing.
    expect((within(dialog).getByLabelText("Input price ($ per 1M tokens)") as HTMLInputElement).value).toBe("2.5");
    expect((within(dialog).getByLabelText("Context window (tokens)") as HTMLInputElement).value).toBe("128000");

    // Save → ONE upsert with the prefill + the R87 capability defaults
    // (text output ON, the rest off — the chip group's honest defaults).
    fireEvent.click(within(dialog).getByRole("button", { name: "Add model" }));
    await waitFor(() => {
      const posts = calls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/models"),
      );
      expect(posts).toHaveLength(1);
    });
    const post = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/models"),
    );
    expect(post?.body).toMatchObject({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      contextWindow: 128000,
      maxOutputTokens: 16384,
      inputPricePerMtok: 2.5,
      inputPriceCachedPerMtok: 1.25,
      outputPricePerMtok: 10,
      supportsTextOutput: true,
      // The served catalog's gpt-4o row carries supportsVision: true — the
      // prefill honors it.
      supportsVision: true,
      hidden: false,
    });

    // The dialog closes on success.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add model" })).toBeNull(),
    );
  });

  it("search filters by model id AND display name", async () => {
    // R60-B: the search fixture mixes free + paid — All-models scope.
    useSettingsStore.setState({ modelsFreeOnly: false });
    liveCatalog = [
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
    ];
    await openPicker();

    fireEvent.change(await screen.findByLabelText("Search catalog models"), {
      target: { value: "gpt" },
    });
    await waitFor(() => expect(screen.getByLabelText("Configure and add openai/gpt-4o")).toBeTruthy());
    expect(screen.queryByLabelText("Configure and add z-ai/glm-5.2:free")).toBeNull();

    // …and by display name ("Inkling" matches the name, not the id).
    fireEvent.change(screen.getByLabelText("Search catalog models"), {
      target: { value: "GLM" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Configure and add z-ai/glm-5.2:free")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Configure and add openai/gpt-4o")).toBeNull();
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
    // ROUND-87 (R87): the by-id path rides the SAME configure flow — no add
    // without configuration.
    fireEvent.click(screen.getByRole("button", { name: /configure & add/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add model" });
    expect((within(dialog).getByLabelText("Model id") as HTMLInputElement).value).toBe("my/custom-model");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add model" }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/models"),
      );
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({ modelId: "my/custom-model" });
    });
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
    // R59-C: pre-select opens the first provider — no click needed.
    await waitFor(() => expect(screen.getByText("$0.15 in / $0.6 out / $0.02 cache")).toBeTruthy());

    fireEvent.click(
      await screen.findByRole("button", { name: "Configure model Z.ai: GLM 5.2" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Configure model" });

    // Pre-filled from the stored row.
    const inputPrice = within(dialog).getByLabelText("Input price ($ per 1M tokens)") as HTMLInputElement;
    expect(inputPrice.value).toBe("0.15");
    expect((within(dialog).getByLabelText("Cache read price ($ per 1M tokens)") as HTMLInputElement).value).toBe("0.02");
    expect((within(dialog).getByLabelText("Context window (tokens)") as HTMLInputElement).value).toBe("256000");

    // Edit the input price; clear the cache price (empty = unknown → null).
    fireEvent.change(inputPrice, { target: { value: "0.5" } });
    fireEvent.change(within(dialog).getByLabelText("Cache read price ($ per 1M tokens)"), {
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
        supportsVision: false, // R62-2b: the dialog PATCHes the vision flag (the Images chip)
        // ROUND-87 (R87): the capability chips PATCH the R82 tri-state flags
        // + the R87 input/output columns. supportsThinking + supportsTools
        // are deliberately ABSENT — the app detects those (the owner's
        // directive); absent = keep stored.
        supportsAudio: null,
        supportsVideo: null,
        supportsPdf: null,
        supportsTextOutput: true,
        supportsImageOutput: null,
        supportsVideoOutput: null,
        supportsAudioOutput: null,
        sizeLabel: null,
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
    // R59-C: pre-select opens the first provider — no click needed.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Configure model Z.ai: GLM 5.2" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Configure model Z.ai: GLM 5.2" }));

    const dialog = await screen.findByRole("dialog", { name: "Configure model" });
    fireEvent.change(within(dialog).getByLabelText("Input price ($ per 1M tokens)"), {
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

/* ── ROUND-62 (R62-2b): the pricing dialog — per-1M clarity + vision toggle ── */

describe("Configure model dialog — per-1M pricing + vision (R62-2b)", () => {
  /** Render + open the single configured row's dialog. */
  async function openDialog(row: ProviderModelConfig) {
    configured = [row];
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `Configure model ${row.displayName}` })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: `Configure model ${row.displayName}` }));
    return screen.findByRole("dialog", { name: "Configure model" });
  }

  it('labels the unit on the section AND every field — "per 1M tokens", with decimal-friendly inputs', async () => {
    const dialog = await openDialog(
      modelRow({ id: "mdl_priced", modelId: "vendor/paid-model", displayName: "Paid Model" }),
    );

    // The section header carries the unit…
    expect(within(dialog).getByText("Pricing — USD per 1M tokens")).toBeTruthy();
    // …and each field's accessible name says it explicitly (the old
    // "($/Mtok)" jargon is gone).
    expect(within(dialog).getByLabelText("Input price ($ per 1M tokens)")).toBeTruthy();
    expect(within(dialog).getByLabelText("Output price ($ per 1M tokens)")).toBeTruthy();
    expect(within(dialog).getByLabelText("Cache read price ($ per 1M tokens)")).toBeTruthy();
    // The helper line pins the unit in plain words too.
    expect(
      within(dialog).getByText(/US dollars per 1 million tokens/i),
    ).toBeTruthy();
  });

  it("decimal per-1M prices round-trip exactly — 0.075 in, 3.5 out (never re-scaled or rejected)", async () => {
    const dialog = await openDialog(
      modelRow({ id: "mdl_priced", modelId: "vendor/paid-model", displayName: "Paid Model" }),
    );

    fireEvent.change(within(dialog).getByLabelText("Input price ($ per 1M tokens)"), {
      target: { value: "0.075" },
    });
    fireEvent.change(within(dialog).getByLabelText("Output price ($ per 1M tokens)"), {
      target: { value: "3.5" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/models/mdl_priced"));
      expect(patch).toBeDefined();
      expect(patch?.body).toMatchObject({
        inputPricePerMtok: 0.075,
        outputPricePerMtok: 3.5,
      });
    });
  });

  it("the Images INPUT chip PATCHes supportsVision (R87 dialog: the capability chip groups)", async () => {
    const dialog = await openDialog(
      modelRow({
        id: "mdl_priced",
        modelId: "vendor/paid-model",
        displayName: "Paid Model",
        supportsVision: false,
      }),
    );

    // ROUND-87 (R87): the capabilities card is now the INPUT/OUTPUT chip
    // groups — vision is the "Images" input chip (aria-pressed flips).
    const imagesChip = within(dialog).getByTestId("model-cap-images-in");
    expect(imagesChip.getAttribute("aria-pressed")).toBe("false");
    // …flip it on.
    fireEvent.click(imagesChip);
    expect(imagesChip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/models/mdl_priced"));
      expect(patch).toBeDefined();
      expect(patch?.body).toMatchObject({ supportsVision: true });
    });
  });
});

/* ── ROUND-59 (R59-C): the left list — CONFIGURED providers only ─────────── */

describe("Left list — configured providers only (R59-C)", () => {
  it("keyless seeded presets are ABSENT entirely — no 'Not configured' group, no preset rows; the header count reflects what is shown", async () => {
    providersList = [PROVIDER, ANTHROPIC, OPENAI, GOOGLE].map((p) => ({ ...p }));
    renderWithProviders(<ModelsProvidersTab />);

    // The configured provider renders as a live row (pre-select opened its
    // pane, so the title also exists on the pane header — scope to the list)…
    const left = document.querySelector(".w-\\[280px\\]") as HTMLElement;
    await waitFor(() =>
      expect(within(left).getByTitle("https://openrouter.ai/api/v1 · Chat completions")).toBeTruthy(),
    );
    // …the three keyless presets appear NOWHERE (the owner deleted them
    // by hand and wants them never to appear — not even collapsed).
    expect(screen.queryByText("Not configured")).toBeNull();
    expect(screen.queryByRole("button", { name: /Not configured providers/ })).toBeNull();
    expect(screen.queryByTitle("https://api.anthropic.com/v1 · Anthropic messages")).toBeNull();
    expect(screen.queryByTitle("https://api.openai.com/v1 · Chat completions")).toBeNull();
    expect(screen.queryByTitle("https://generativelanguage.googleapis.com/v1beta/openai · Chat completions")).toBeNull();
    expect(document.querySelector("[data-not-configured-group]")).toBeNull();
    // The count reflects what the list SHOWS — 1, not 4.
    expect(screen.getByTestId("provider-count").textContent).toBe("1");
  });

  it("a preset that HOLDS a key stays visible — the predicate is hasKey OR custom", async () => {
    providersList = [PROVIDER, { ...ANTHROPIC, hasKey: true }].map((p) => ({ ...p }));
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() =>
      expect(screen.getByTitle("https://api.anthropic.com/v1 · Anthropic messages")).toBeTruthy(),
    );
    expect(screen.getByTestId("provider-count").textContent).toBe("2");
  });

  it("the left column is content-adaptive with a 220px floor, keeping its own scroller", async () => {
    renderWithProviders(<ModelsProvidersTab />);
    const left = document.querySelector(".w-\\[280px\\]") as HTMLElement;
    expect(left).not.toBeNull();
    expect(left.className).toContain("h-fit");
    expect(left.className).toContain("max-h-full");
    expect(left.className).toContain("min-h-[220px]");
    // The inner list keeps its scroll container for the many-providers case.
    expect(left.querySelector(".overflow-y-auto.auto-scroll")).not.toBeNull();
  });

  it("a keyless CUSTOM provider stays a live row — presets are the only hidden rows", async () => {
    providersList = [PROVIDER, { ...CUSTOM_PROVIDER, hasKey: false }];
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() =>
      expect(screen.getByTitle("https://gw.example.com/v1 · Chat completions")).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /Not configured providers/ })).toBeNull();
  });
});

/* ── ROUND-58 (R58-d): the Connection card — preset vs custom fields ───────── */

describe("Connection card — preset vs custom fields (ROUND-58 R58-d)", () => {
  it("openrouter (preset): Base URL + API format HIDDEN with the info line; key + test remain", async () => {
    // R59-C: pre-select opens the first provider — no click needed.
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() => expect(screen.getByLabelText("Test key")).toBeTruthy());

    // The fixed-endpoint fields are GONE…
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    expect(screen.queryByText("API format")).toBeNull();
    // …replaced by the muted info line (the owner: "It should only be shown
    // for custom providers").
    expect(screen.getByText("Preset provider — endpoint and format are fixed.")).toBeTruthy();
    // The key field + Test connection stay for EVERY provider — the key
    // field shows the STORED key masked (R59-C).
    expect(screen.getByTestId("stored-key-masked")).toBeTruthy();
    expect(screen.getByRole("button", { name: /test connection/i })).toBeTruthy();
  });

  it("custom provider: Base URL + API format shown as before", async () => {
    providersList = [{ ...CUSTOM_PROVIDER }];
    // R59-C: pre-select opens the (only) provider — no click needed.
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() => expect(screen.getByLabelText("Test key")).toBeTruthy());
    expect(screen.getByLabelText("Base URL")).toBeTruthy();
    expect(screen.getByText("API format")).toBeTruthy();
    expect(screen.queryByText("Preset provider — endpoint and format are fixed.")).toBeNull();
    expect(screen.getByTestId("stored-key-masked")).toBeTruthy();
  });
});

/* ── ROUND-59 (R59-C): the enable/disable toggle — OUTRIGHT ─────────────────── */

describe("Enable/disable toggle (R59-C)", () => {
  it("flipping the switch disables IMMEDIATELY — PATCH {enabled:false}, NO confirm box (the fixture agents DO reference openrouter)", async () => {
    renderWithProviders(<ModelsProvidersTab />);
    const toggle = await screen.findByRole("switch", { name: "Toggle provider OpenRouter" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // Let the agent-registry query land (every fixture agent references
    // openrouter) — the old R58 gate used to arm exactly here.
    await waitFor(() => expect(toggle.getAttribute("title")).toContain("agent(s) use this provider"));

    fireEvent.click(toggle);
    // The PATCH fires with NO gate…
    await waitFor(() => {
      expect(patchResponses).toContainEqual({ id: "openrouter", body: { enabled: false } });
    });
    // …and the R58 confirm box is GONE from the DOM entirely.
    expect(document.querySelector("[data-confirm-disable]")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable anyway" })).toBeNull();
    expect(screen.queryByText(/agents use this provider/)).toBeNull();
  });

  it("re-enabling rides the same immediate path — PATCH {enabled:true}", async () => {
    renderWithProviders(<ModelsProvidersTab />);
    const toggle = await screen.findByRole("switch", { name: "Toggle provider OpenRouter" });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(patchResponses).toContainEqual({ id: "openrouter", body: { enabled: false } }),
    );
    // The stateful mock applied the patch — the refetched switch is OFF…
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    // …and flips straight back on, no questions asked.
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(patchResponses).toContainEqual({ id: "openrouter", body: { enabled: true } }),
    );
  });

  it("the agent count survives only as the quiet hover tooltip — honest, non-blocking", async () => {
    renderWithProviders(<ModelsProvidersTab />);
    const toggle = await screen.findByRole("switch", { name: "Toggle provider OpenRouter" });
    await waitFor(() =>
      expect(toggle.getAttribute("title")).toContain(
        "agent(s) use this provider — disabling takes effect immediately",
      ),
    );
    // Nothing else renders from the agent registry — no warning box.
    expect(document.querySelector("[data-confirm-disable]")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a provider with NO agents disables immediately — the generic tooltip path", async () => {
    providersList = [{ ...CUSTOM_PROVIDER }];
    // R59-C: pre-select opens the (only) provider — no click needed.
    renderWithProviders(<ModelsProvidersTab />);
    const toggle = await screen.findByRole("switch", { name: "Toggle provider My Gateway" });
    // No fixture agent references my-gateway → the tooltip stays generic.
    await waitFor(() => expect(toggle.getAttribute("title")).toBe("Disable this provider"));
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(patchResponses).toContainEqual({ id: "my-gateway", body: { enabled: false } });
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/* ── ROUND-60 (R60-B): the API-key field — unified eye + paste-to-replace ── */

describe("Key field — unified eye + paste-to-replace (R60-B)", () => {
  it("shows the STORED key MASKED at rest with the eye in its ONE slot — no auto-reveal, no rotate affordance", async () => {
    pool = [{ slot: 0, hasKey: true, masked: "sk-o…b4af" }];
    renderWithProviders(<ModelsProvidersTab />);

    const masked = (await screen.findByTestId("stored-key-masked")) as HTMLInputElement;
    // The pool listing lands async — the masked value fills in when it does.
    await waitFor(() => expect(masked.value).toBe("sk-o…b4af"));
    // The eye toggle is present in its one stable slot…
    expect(screen.getByTestId("show-stored-key-button")).toBeTruthy();
    expect(screen.getByLabelText("Show stored key")).toBeTruthy();
    // …and the R59 rotate flow is GONE entirely (the owner: paste the new
    // key directly — no Rotate button, no rotate testids anywhere).
    expect(screen.queryByTestId("rotate-key-button")).toBeNull();
    expect(screen.queryByTestId("rotate-key-input")).toBeNull();
    expect(screen.queryByRole("button", { name: /rotate/i })).toBeNull();
    // No editable "API key" input while at rest — the field IS the stored
    // display until the user types/pastes.
    expect(screen.queryByLabelText("API key")).toBeNull();
    // NEVER auto-fetched on mount — the reveal route is untouched until the
    // explicit eye click.
    expect(calls.every((c) => !c.url.includes("/keys/reveal"))).toBe(true);
  });

  it("Show → the reveal route POSTs, the FULL value renders, Copy copies it, and Hide masks again THROUGH THE SAME BUTTON NODE (the slot never moves)", async () => {
    pool = [{ slot: 0, hasKey: true, masked: "sk-o…b4af" }];
    revealKeys = [
      { slot: 0, value: "sk-or-v1-primary-full" },
      { slot: 2, value: "sk-or-v1-pool-2-full" },
    ];
    renderWithProviders(<ModelsProvidersTab />);

    const eye = await screen.findByTestId("show-stored-key-button");
    fireEvent.click(eye);
    const revealed = (await screen.findByTestId("stored-key-revealed")) as HTMLInputElement;
    expect(revealed.value).toBe("sk-or-v1-primary-full");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/keys/reveal"))).toBe(true),
    );

    // Copy → the clipboard receives the FULL value (the button fades/slides
    // in — AnimatePresence — but is in the DOM and clickable immediately).
    fireEvent.click(screen.getByTestId("copy-stored-key-button"));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith("sk-or-v1-primary-full"));
    await waitFor(() => expect(screen.getByText("Key copied to clipboard.")).toBeTruthy());

    // Hide → masked again — and the Hide button is the SAME DOM NODE as the
    // Show button (React reconciles the eye in place: the exact same slot,
    // the owner's directive #1).
    const hideBtn = screen.getByTestId("hide-stored-key-button");
    expect(hideBtn).toBe(eye);
    fireEvent.click(hideBtn);
    await waitFor(() => expect(screen.getByTestId("stored-key-masked")).toBeTruthy());
    expect(screen.queryByTestId("stored-key-revealed")).toBeNull();
    // The Copy affordance leaves with the reveal (it fades out)…
    await waitFor(
      () => expect(screen.queryByTestId("copy-stored-key-button")).toBeNull(),
      { timeout: 2000 },
    );
    // …and the eye flipped back to the Show identity in the same slot.
    expect(screen.getByTestId("show-stored-key-button")).toBe(eye);
  });

  it("paste-to-replace: typing a new key swaps to edit mode (Save key + Cancel X); Save PUTs and the masked view returns with the NEW key's mask", async () => {
    pool = [{ slot: 0, hasKey: true, masked: "sk-o…b4af" }];
    renderWithProviders(<ModelsProvidersTab />);

    // The user clicks into the stored display and pastes the new key —
    // the field becomes the draft (edit mode) in place.
    const masked = (await screen.findByTestId("stored-key-masked")) as HTMLInputElement;
    await waitFor(() => expect(masked.value).toBe("sk-o…b4af"));
    fireEvent.change(masked, { target: { value: "sk-or-v1-rotated" } });

    const editing = (await screen.findByTestId("new-key-input")) as HTMLInputElement;
    expect(editing.value).toBe("sk-or-v1-rotated");
    // The eye stays in its slot (disabled while editing) and the context
    // action morphs to Save key + Cancel X.
    const eye = screen.getByTestId("show-stored-key-button") as HTMLButtonElement;
    expect(eye.disabled).toBe(true);
    expect(screen.getByTestId("save-key-button")).toBeTruthy();
    expect(screen.getByTestId("cancel-key-edit-button")).toBeTruthy();
    // Copy is gone while editing (it belongs to the REVEALED stored value).
    expect(screen.queryByTestId("copy-stored-key-button")).toBeNull();

    fireEvent.click(screen.getByTestId("save-key-button"));

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.endsWith("/providers/openrouter/key"),
      );
      expect(put).toBeDefined();
      expect(put?.body).toEqual({ value: "sk-or-v1-rotated" });
    });
    await waitFor(() => expect(screen.getByText("Key saved to the secure store.")).toBeTruthy());
    // The block returns to the MASKED stored view — with the NEW key's
    // masked value (the pane invalidated + refetched the pool listing).
    await waitFor(() => {
      expect((screen.getByTestId("stored-key-masked") as HTMLInputElement).value).toBe("sk-or…ated");
    });
  });

  it("Escape cancels the edit — the stored display returns, NO key PUT", async () => {
    pool = [{ slot: 0, hasKey: true, masked: "sk-o…b4af" }];
    renderWithProviders(<ModelsProvidersTab />);

    const masked = await screen.findByTestId("stored-key-masked");
    fireEvent.change(masked, { target: { value: "typed-then-cancelled" } });
    fireEvent.keyDown(screen.getByTestId("new-key-input"), { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("stored-key-masked")).toBeTruthy());
    expect((screen.getByTestId("stored-key-masked") as HTMLInputElement).value).toBe("sk-o…b4af");
    expect(screen.queryByTestId("new-key-input")).toBeNull();
    expect(screen.queryByTestId("save-key-button")).toBeNull();
    expect(calls.every((c) => !(c.method === "PUT" && c.url.endsWith("/key")))).toBe(true);
  });

  it("the Cancel X button restores the stored display — NO key PUT", async () => {
    pool = [{ slot: 0, hasKey: true, masked: "sk-o…b4af" }];
    renderWithProviders(<ModelsProvidersTab />);

    const masked = await screen.findByTestId("stored-key-masked");
    fireEvent.change(masked, { target: { value: "typed-then-cancelled" } });
    fireEvent.click(screen.getByTestId("cancel-key-edit-button"));

    await waitFor(() => expect(screen.getByTestId("stored-key-masked")).toBeTruthy());
    expect((screen.getByTestId("stored-key-masked") as HTMLInputElement).value).toBe("sk-o…b4af");
    expect(screen.queryByTestId("new-key-input")).toBeNull();
    expect(calls.every((c) => !(c.method === "PUT" && c.url.endsWith("/key")))).toBe(true);
  });

  it("no key stored: the field is the plain editable input (new-key-input) with the eye disabled in its slot; paste + Save PUTs", async () => {
    providersList = [{ ...CUSTOM_PROVIDER, hasKey: false }];
    renderWithProviders(<ModelsProvidersTab />);

    const input = (await screen.findByTestId("new-key-input")) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("sk-…");
    // The eye is present but disabled (nothing to reveal) — the slot never
    // moves even for a keyless provider.
    const eye = screen.getByTestId("show-stored-key-button") as HTMLButtonElement;
    expect(eye.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "sk-fresh-key" } });
    fireEvent.click(screen.getByTestId("save-key-button"));

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.endsWith("/providers/my-gateway/key"),
      );
      expect(put).toBeDefined();
      expect(put?.body).toEqual({ value: "sk-fresh-key" });
    });
    // The mock flips hasKey on the saved row — the providers refetch lands
    // and the field settles to the masked stored view of the new key.
    await waitFor(() =>
      expect((screen.getByTestId("stored-key-masked") as HTMLInputElement).value).toBe("sk-fr…-key"),
    );
  });

  it("honestly reports a missing stored key (empty reveal answer)", async () => {
    revealKeys = []; // nothing stored on the server
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByTestId("show-stored-key-button"));
    await waitFor(() => expect(screen.getByText("No key stored for this provider.")).toBeTruthy());
  });

  it("reveal failure → the honest red error line; the masked view stays", async () => {
    revealFails = true;
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByTestId("show-stored-key-button"));
    const err = await screen.findByRole("alert");
    expect(err.textContent).toContain("reveal failed (sidecar keyring unavailable)");
    expect(err.style.color).toBe("#ef4444");
    // The block stays on the masked stored value — nothing half-revealed.
    expect(screen.getByTestId("stored-key-masked")).toBeTruthy();
  });
});

/* ── ROUND-58 (R58-d): the key REVEAL UI (pool rows) ───────────────────────── */

describe("Key reveal (ROUND-58 R58-d)", () => {
  it("pool rows reveal their full value — ONE fetch, per-row toggle, copy, re-mask", async () => {
    pool = [
      { slot: 2, hasKey: true, masked: "sk-o…aaaa" },
      { slot: 4, hasKey: true, masked: "sk-o…cccc" },
    ];
    revealKeys = [
      { slot: 2, value: "sk-or-v1-pool-2-full" },
      { slot: 4, value: "sk-or-v1-pool-4-full" },
    ];
    // R59-C: pre-select opens the first provider — no click needed.
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() => expect(screen.getByText("SLOT 2")).toBeTruthy());

    // Masked by default; still no auto-fetch.
    expect(screen.getByText("sk-o…aaaa")).toBeTruthy();
    expect(calls.every((c) => !c.url.includes("/keys/reveal"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reveal slot 2 key" }));
    await waitFor(() => expect(screen.getByText("sk-or-v1-pool-2-full")).toBeTruthy());
    // Slot 4 stays masked (per-row toggle)…
    expect(screen.getByText("sk-o…cccc")).toBeTruthy();
    // …and reveals from the SAME cached fetch — no second reveal call.
    fireEvent.click(screen.getByRole("button", { name: "Reveal slot 4 key" }));
    await waitFor(() => expect(screen.getByText("sk-or-v1-pool-4-full")).toBeTruthy());
    expect(calls.filter((c) => c.url.includes("/keys/reveal"))).toHaveLength(1);

    // Copy rides the row.
    fireEvent.click(screen.getByRole("button", { name: "Copy slot 4 key" }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith("sk-or-v1-pool-4-full"));

    // Toggle back to masked.
    fireEvent.click(screen.getByRole("button", { name: "Hide slot 4 key" }));
    await waitFor(() => expect(screen.getByText("sk-o…cccc")).toBeTruthy());
    expect(screen.queryByText("sk-or-v1-pool-4-full")).toBeNull();
  });

  it("pool mutations invalidate the reveal cache — a slot added AFTER a reveal re-fetches (never a stale value or a false 'No key stored')", async () => {
    pool = [{ slot: 2, hasKey: true, masked: "sk-o…aaaa" }];
    revealKeys = [{ slot: 2, value: "sk-or-v1-pool-2-full" }];
    // R59-C: pre-select opens the first provider — no click needed.
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() => expect(screen.getByText("SLOT 2")).toBeTruthy());

    // First reveal — one fetch, cache populated.
    fireEvent.click(screen.getByRole("button", { name: "Reveal slot 2 key" }));
    await waitFor(() => expect(screen.getByText("sk-or-v1-pool-2-full")).toBeTruthy());
    expect(calls.filter((c) => c.url.includes("/keys/reveal"))).toHaveLength(1);

    // Add slot 3 through the pool UI (the stateful mock PUTs it) and make the
    // server's reveal answer grow with it.
    fireEvent.change(await screen.findByLabelText("New pool key"), {
      target: { value: "sk-or-v1-pool-3-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));
    await waitFor(() => expect(screen.getByText("SLOT 3")).toBeTruthy());
    revealKeys = [
      { slot: 2, value: "sk-or-v1-pool-2-full" },
      { slot: 3, value: "sk-or-v1-pool-3-new" },
    ];
    // The pool mutation ALSO reset the reveal state — slot 2 masks again
    // (its cached value predates the mutation; never risk a stale reveal).
    await waitFor(() => expect(screen.getByText("sk-o…aaaa")).toBeTruthy());
    expect(screen.queryByText("sk-or-v1-pool-2-full")).toBeNull();

    // Revealing the NEW slot re-fetches (cache-miss, listing says held) and
    // shows its value — the pre-fix bug here was the false "No key stored in
    // slot 3." from the stale first-reveal cache.
    fireEvent.click(screen.getByRole("button", { name: "Reveal slot 3 key" }));
    await waitFor(() => expect(screen.getByText("sk-or-v1-pool-3-new")).toBeTruthy());
    expect(calls.filter((c) => c.url.includes("/keys/reveal"))).toHaveLength(2);
  });
});

/* ── ROUND-60 (R60-B): the models list — CONFIGURED rows only ─────────────── */

describe("Models list — configured rows only (R60-B)", () => {
  it("the list shows ONLY configured rows — live catalog entries NEVER render, even when the catalog query returns them; the free/all toggle lives in the picker, not the list", async () => {
    configured = [modelRow({ modelId: "z-ai/glm-5.2:free", displayName: "Z.ai: GLM 5.2" })];
    liveCatalog = [
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "vendor/other:free", name: "Other" },
    ];
    // R59-C: pre-select opens the first provider — no click needed.
    renderWithProviders(<ModelsProvidersTab />);

    // The count chip shows the CONFIGURED row count only — the two extra
    // live-catalog entries never merge into the list (the owner: "By
    // default there should not be the free models or all models there").
    await waitFor(() => expect(screen.getByTestId("models-count").textContent).toBe("1"));
    await waitFor(() => expect(screen.getByText("Z.ai: GLM 5.2")).toBeTruthy());
    // The catalog-only entries appear NOWHERE in the list…
    expect(screen.queryByText("GPT-4o")).toBeNull();
    expect(screen.queryByText("Other")).toBeNull();
    // …and the R50 "catalog" row badge is gone with the merge.
    expect(screen.queryByText("catalog")).toBeNull();
    // The list header has NO Free only/All models segmented control anymore
    // (it moved into the Add-models picker — R60-B directive 3).
    expect(screen.queryByTestId("picker-free-only-toggle")).toBeNull();
    expect(screen.queryByRole("button", { name: "All models" })).toBeNull();
  });

  it("empty state: zero configured rows → the honest 'No models yet' line, even with a healthy live catalog", async () => {
    configured = [];
    liveCatalog = [{ id: "openai/gpt-4o", name: "GPT-4o" }];
    renderWithProviders(<ModelsProvidersTab />);

    await waitFor(() =>
      expect(
        screen.getByText("No models yet — use “Add models” to pick from the provider's catalog."),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId("models-count").textContent).toBe("0");
  });

  it("every configured row — FREE ones included — is fully customizable: FREE badge + pencil + delete render (the shared free-only pref does not filter the LIST)", async () => {
    // The owner's directive 4: "I told you to give me flexibility on
    // customizing the models properly, even the free models."
    configured = [
      modelRow({
        id: "mdl_z-ai-glm",
        modelId: "z-ai/glm-5.2:free",
        displayName: "Z.ai: GLM 5.2",
        inputPricePerMtok: 0,
        outputPricePerMtok: 0,
      }),
    ];
    renderWithProviders(<ModelsProvidersTab />);

    await waitFor(() => expect(screen.getByTestId("models-count").textContent).toBe("1"));
    await waitFor(() => expect(screen.getByText("Z.ai: GLM 5.2")).toBeTruthy());
    // The FREE badge rides isFreeModelEntry (id heuristic OR $0 price)…
    expect(screen.getByText("FREE")).toBeTruthy();
    // …and the stored row carries the pencil + delete affordances.
    expect(screen.getByRole("button", { name: "Configure model Z.ai: GLM 5.2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete model Z.ai: GLM 5.2" })).toBeTruthy();
  });
});

/* ── ROUND-60 (R60-B): the Add-models picker — Free only ↔ All models ─────── */

describe("Add models picker — Free only ↔ All models toggle (R60-B)", () => {
  /** Open the first provider's detail pane + the picker dialog. */
  async function openPicker() {
    renderWithProviders(<ModelsProvidersTab />);
    // R59-C: pre-select opens the first provider — no click needed.
    await waitFor(() => expect(screen.getByLabelText("Test key")).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: /add models/i }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Add models" })).toBeTruthy());
  }

  it("defaults to FREE-ONLY (the shared persisted pref): paid rows are hidden until the toggle flips — and the choice lands in the store the chat picker honors", async () => {
    liveCatalog = [
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
    ];
    await openPicker();

    const dialog = screen.getByRole("dialog", { name: "Add models" });
    // Free row visible; the PAID row is filtered by the free-only default.
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Configure and add z-ai/glm-5.2:free")).toBeTruthy(),
    );
    expect(within(dialog).queryByLabelText("Configure and add openai/gpt-4o")).toBeNull();
    // The segmented toggle lives IN the picker now.
    expect(within(dialog).getByTestId("picker-free-only-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByTestId("picker-all-models-toggle").getAttribute("aria-pressed")).toBe("false");

    // Flip to All models — the paid row appears.
    fireEvent.click(within(dialog).getByTestId("picker-all-models-toggle"));
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Configure and add openai/gpt-4o")).toBeTruthy(),
    );
    expect(within(dialog).getByTestId("picker-all-models-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByTestId("picker-free-only-toggle").getAttribute("aria-pressed")).toBe("false");
    // ROUND-82: the toggle is dialog-LOCAL scope — the shared persisted pref
    // the chat composer's picker honors is INITIALIZED FROM, never written to
    // (flipping the catalog picker no longer surprises the chat picker —
    // the pre-R82 shared-store write was the removed behavior).
    expect(useSettingsStore.getState().modelsFreeOnly).toBe(true);

    // …and flipping back re-hides the paid row.
    fireEvent.click(within(dialog).getByTestId("picker-free-only-toggle"));
    await waitFor(() =>
      expect(within(dialog).queryByLabelText("Configure and add openai/gpt-4o")).toBeNull(),
    );
    // Still never written: the shared pref carries the pre-dialog value.
    expect(useSettingsStore.getState().modelsFreeOnly).toBe(true);
  });

  it("free-only scope with NO free entries → R82 auto-switches to All (never the confusing empty state)", async () => {
    liveCatalog = [{ id: "openai/gpt-4o", name: "GPT-4o" }];
    await openPicker();

    // ROUND-82 (§2.4.6, the NVIDIA gap): a provider whose catalog has ZERO
    // free-classified entries auto-switches the LOCAL scope to All — the
    // pre-R82 "No free models match — switch to All models" empty state read
    // as broken (every NIM catalog would show it on open). The paid row is
    // visible instead…
    await waitFor(() =>
      expect(screen.getByLabelText("Configure and add openai/gpt-4o")).toBeTruthy(),
    );
    // …the All segment is pressed…
    expect(screen.getByTestId("picker-all-models-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("picker-free-only-toggle").getAttribute("aria-pressed")).toBe("false");
    // …and the SHARED pref is untouched by the auto-switch (the composer's
    // picker keeps its own control — the spec's risk-#8 rule).
    expect(useSettingsStore.getState().modelsFreeOnly).toBe(true);
  });
});

/* ── ROUND-58 (R58-d) → R60-B: the list vs the picker for CUSTOM providers ── */

describe("Models list vs picker for custom providers (R60-B)", () => {
  it("a CUSTOM provider's models list shows ONLY configured rows; its live catalog still feeds the picker", async () => {
    providersList = [{ ...CUSTOM_PROVIDER }];
    customConfigured = [
      modelRow({
        id: "mdl_gw-1",
        providerId: "my-gateway",
        modelId: "gw/model-a",
        displayName: "GW Model A",
      }),
    ];
    liveCatalog = [{ id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" }];
    // R59-C: pre-select opens the (only) provider — no click needed.
    renderWithProviders(<ModelsProvidersTab />);

    // The count chip shows the configured row ONLY (the live catalog entry
    // did not merge in — "1", never 2), and the row renders.
    await waitFor(() => expect(screen.getByTestId("models-count").textContent).toBe("1"));
    await waitFor(() => expect(screen.getByText("GW Model A")).toBeTruthy());
    // The live catalog entry did NOT become a "catalog" row.
    expect(screen.queryByText("catalog")).toBeNull();

    // The "Add models" picker still lists the custom provider's OWN live
    // catalog (the list/picker split is the R60-B design).
    fireEvent.click(screen.getByRole("button", { name: /add models/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add models" });
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Configure and add z-ai/glm-5.2:free")).toBeTruthy(),
    );
  });
});

/* ── ROUND-59 (R59-C): pre-select + selection lifecycle ───────────────────── */

describe("Pre-select + selection lifecycle (R59-C)", () => {
  it("providers load → the FIRST provider's detail pane renders WITHOUT a click", async () => {
    providersList = [PROVIDER, CUSTOM_PROVIDER].map((p) => ({ ...p }));
    renderWithProviders(<ModelsProvidersTab />);

    // No click anywhere — the first row's details open on the right (the
    // owner: "it will pre-select the top provider and open its details").
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Toggle provider OpenRouter" })).toBeTruthy(),
    );
    expect(screen.getByText("Connection")).toBeTruthy();
    // The left row carries the selection marker (the title rides the row's
    // inner span — walk up to the button that owns aria-current).
    const left = document.querySelector(".w-\\[280px\\]") as HTMLElement;
    const row = within(left)
      .getByTitle("https://openrouter.ai/api/v1 · Chat completions")
      .closest("button");
    expect(row?.getAttribute("aria-current")).toBe("true");
  });

  it("an explicit selection is NOT overridden by a later providers refresh", async () => {
    providersList = [PROVIDER, CUSTOM_PROVIDER].map((p) => ({ ...p }));
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Toggle provider OpenRouter" })).toBeTruthy(),
    );

    // The user picks the SECOND row explicitly…
    const left = document.querySelector(".w-\\[280px\\]") as HTMLElement;
    fireEvent.click(within(left).getByTitle("https://gw.example.com/v1 · Chat completions"));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Toggle provider My Gateway" })).toBeTruthy(),
    );

    // …then a providers refresh lands (the toggle PATCH → invalidate →
    // refetch) — the selection must NOT snap back to the first row.
    fireEvent.click(screen.getByRole("switch", { name: "Toggle provider My Gateway" }));
    await waitFor(() =>
      expect(patchResponses).toContainEqual({ id: "my-gateway", body: { enabled: false } }),
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Toggle provider My Gateway" })).toBeTruthy(),
    );
    expect(screen.queryByRole("switch", { name: "Toggle provider OpenRouter" })).toBeNull();
  });

  it("deleting the SELECTED provider selects the next remaining one (not the empty state)", async () => {
    providersList = [PROVIDER, CUSTOM_PROVIDER].map((p) => ({ ...p }));
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Toggle provider OpenRouter" })).toBeTruthy(),
    );

    // The danger-zone two-click confirm flow deletes openrouter…
    fireEvent.click(screen.getByRole("button", { name: "Delete provider OpenRouter" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete provider OpenRouter" }));

    // …and the selection falls to the NEXT remaining provider.
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Toggle provider My Gateway" })).toBeTruthy(),
    );
    expect(screen.queryByRole("switch", { name: "Toggle provider OpenRouter" })).toBeNull();
    const left = document.querySelector(".w-\\[280px\\]") as HTMLElement;
    expect(within(left).queryByTitle("https://openrouter.ai/api/v1 · Chat completions")).toBeNull();
  });

  it("empty provider list → the placeholder card + the empty left list", async () => {
    providersList = [];
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() => expect(screen.getByText("Select a provider")).toBeTruthy());
    // R62-2b: the empty left list now waits for the providers fetch to
    // settle (the loading row renders first — an honest "not loaded YET"
    // state instead of a flash of "No providers").
    await waitFor(() =>
      expect(screen.queryByText("loading providers…")).toBeNull(),
      { timeout: 2000 },
    );
    expect(screen.getByText("No providers — add one below.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByTestId("provider-count").textContent).toBe("0");
  });

  it("a selected provider that LEAVES the configured list (preset key removed) is deselected gracefully — falls to the first remaining", async () => {
    providersList = [PROVIDER, CUSTOM_PROVIDER].map((p) => ({ ...p }));
    renderWithProviders(<ModelsProvidersTab />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Toggle provider OpenRouter" })).toBeTruthy(),
    );

    // The stored key disappears server-side → the preset drops out of the
    // configured list on the next refresh.
    providersList[0].hasKey = false;
    // Trigger the refresh: the toggle PATCH → invalidate → refetch.
    fireEvent.click(screen.getByRole("switch", { name: "Toggle provider OpenRouter" }));
    await waitFor(() =>
      expect(patchResponses).toContainEqual({ id: "openrouter", body: { enabled: false } }),
    );

    // OpenRouter is now hidden everywhere; the selection fell to the next
    // configured provider — the detail pane never lingers on a hidden row.
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Toggle provider My Gateway" })).toBeTruthy(),
    );
    expect(screen.queryByRole("switch", { name: "Toggle provider OpenRouter" })).toBeNull();
    const left = document.querySelector(".w-\\[280px\\]") as HTMLElement;
    expect(within(left).queryByTitle("https://openrouter.ai/api/v1 · Chat completions")).toBeNull();
  });
});

/* ── ROUND-62 (R62-2b): cross-page cache invalidation ───────────────────────
 * The agent session page's model picker (composer/ModelSelector) reads the
 * same providers/models-config resources through ["composer-providers"],
 * ["provider-models", id] and ["provider-models-config", id] with staleTimes
 * of 60s/5min/5min. The settings tab used to invalidate only its own
 * ["settings-*"] keys — everything edited here stayed stale on the session
 * page for minutes. These tests seed the PICKER's families into a local
 * QueryClient (the app's single client, main.tsx) and prove each mutation
 * flips them stale — the staleness fix, pinned. */

describe("Settings mutations refresh the SESSION page's model caches (R62-2b)", () => {
  /** The picker's staleTime — only an invalidation can flip a seeded entry
   * stale mid-test (5 minutes of natural freshness). */
  const PICKER_STALE_MS = 5 * 60_000;

  /** Render the tab against a LOCAL client seeded with the session-page
   * picker's cache families — the entries the chat screen would have left
   * behind in the app's single QueryClient. */
  function renderTabSeedingPickerCaches(): QueryClient {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: PICKER_STALE_MS } },
    });
    client.setQueryData(["composer-providers"], [PROVIDER]);
    client.setQueryData(["provider-models", "openrouter"], ["z-ai/glm-5.2:free"]);
    client.setQueryData(["provider-models-config", "openrouter"], []);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ModelsProvidersTab />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return client;
  }

  const isInvalidated = (client: QueryClient, key: QueryKey): boolean =>
    // v5 QueryState carries no computed isStale — the raw isInvalidated flag
    // is exactly what invalidateQueries sets (and nothing un-sets it for
    // entries with no observers — the picker is unmounted while we're here).
    client.getQueryState(key)?.isInvalidated === true;

  it("saving a model's configuration marks the chat picker's models-config cache STALE (rename/hide/pricing reflect now)", async () => {
    configured = [
      modelRow({ id: "mdl_priced", modelId: "z-ai/glm-5.2:free", displayName: "Z.ai: GLM 5.2" }),
    ];
    const client = renderTabSeedingPickerCaches();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Configure model Z.ai: GLM 5.2" })).toBeTruthy(),
    );

    const key: QueryKey = ["provider-models-config", "openrouter"];
    // Seeded FRESH (the picker fetched a moment ago, 5-minute staleTime) —
    // ONLY the settings mutation's invalidation can flip it this fast.
    expect(isInvalidated(client, key)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Configure model Z.ai: GLM 5.2" }));
    const dialog = await screen.findByRole("dialog", { name: "Configure model" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));

    await waitFor(() => expect(isInvalidated(client, key)).toBe(true));
    // The PATCH itself landed (the save was real, not a cache trick).
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/models/mdl_priced"))).toBe(true),
    );
  });

  it("deleting a model row marks the picker's models-config cache STALE", async () => {
    configured = [
      modelRow({ id: "mdl_priced", modelId: "z-ai/glm-5.2:free", displayName: "Z.ai: GLM 5.2" }),
    ];
    // The row delete asks for a window.confirm — accept it (SubAgentsTab's
    // stub pattern).
    vi.stubGlobal("confirm", vi.fn(() => true));
    const client = renderTabSeedingPickerCaches();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete model Z.ai: GLM 5.2" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete model Z.ai: GLM 5.2" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/models/mdl_priced"))).toBe(true),
    );
    await waitFor(() => expect(isInvalidated(client, ["provider-models-config", "openrouter"])).toBe(true));
  });

  it("adding a model (Add models → Add by id) marks the picker's models-config cache STALE — new models reach the session page", async () => {
    const client = renderTabSeedingPickerCaches();
    await waitFor(() => expect(screen.getByRole("button", { name: /add models/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /add models/i }));
    await screen.findByRole("dialog", { name: "Add models" });
    fireEvent.change(screen.getByLabelText("Model id"), {
      target: { value: "custom/manual-model" },
    });
    // ROUND-87 (R87): the by-id path opens the configure dialog — save there.
    fireEvent.click(screen.getByRole("button", { name: /configure & add/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add model" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add model" }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/models")),
      ).toBe(true),
    );
    await waitFor(() => expect(isInvalidated(client, ["provider-models-config", "openrouter"])).toBe(true));
  });

  it("toggling a provider's enabled switch invalidates the picker's PROVIDER + live-catalog caches", async () => {
    const client = renderTabSeedingPickerCaches();
    const toggle = await screen.findByRole("switch", { name: "Toggle provider OpenRouter" });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(patchResponses).toContainEqual({ id: "openrouter", body: { enabled: false } }),
    );
    // Both session-page families the provider toggle must refresh.
    await waitFor(() => expect(isInvalidated(client, ["composer-providers"])).toBe(true));
    await waitFor(() => expect(isInvalidated(client, ["provider-models", "openrouter"])).toBe(true));
  });

  it("deleting the PROVIDER invalidates the picker's models-config family (its rows cascade away server-side)", async () => {
    const client = renderTabSeedingPickerCaches();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete provider OpenRouter" })).toBeTruthy(),
    );
    // The two-click confirm flow.
    fireEvent.click(screen.getByRole("button", { name: "Delete provider OpenRouter" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete provider OpenRouter" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/providers/openrouter"))).toBe(true),
    );
    await waitFor(() => expect(isInvalidated(client, ["provider-models-config", "openrouter"])).toBe(true));
  });
});

/* ── ROUND-62 (R62-2b): honest load states (the "page is not proper" part) ── */

describe("Honest load states (R62-2b)", () => {
  it("a failed providers load renders the red alert — never the silent 'no providers' page", async () => {
    providersFail = true;
    renderWithProviders(<ModelsProvidersTab />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load providers");
    expect(alert.textContent).toContain("providers route exploded");
    expect(alert.style.color).toBe("#ef4444");
  });

  it("a failed models-config load shows the error line INSTEAD of the misleading 'No models yet'", async () => {
    modelsConfigFail = true;
    renderWithProviders(<ModelsProvidersTab />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load this provider's models/)).toBeTruthy(),
    );
    expect(screen.queryByText(/No models yet/)).toBeNull();
  });
});
