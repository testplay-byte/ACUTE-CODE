// @vitest-environment happy-dom
/**
 * ROUND-43 (R43-5) — the Sub-agents settings section:
 *
 *  1. The section renders (keys card, model card, parallelism card,
 *     supervision card — R58-d order).
 *  2. The keys NOTE points at Models & Providers (R92-D3: sub-agents ride the
 *     provider key pools; nothing on this page writes a key).
 *  3. The model picker's PRIMARY list is the user's CONFIGURED models
 *     (GET /models/configured) — see the R93-A9 block below.
 *  4. The dedicated ?tab=subagents page renders the same section; since
 *     ROUND-58 (R58-d) Advanced NO LONGER duplicates it.
 *  5. ROUND-58 (R58-d): the parallelism card (maxParallel + perKeyLimit
 *     steppers) MOVED here from the old Advanced tab's OrchestrationCard.
 *
 * ROUND-93 (R93-A9, owner directive: "in the sub-agent models only those
 * models should be shown which are available, not the other ones. Currently
 * it is utilizing OpenRouter and showing me all the available OpenRouter
 * models") — the picker is CONFIG-ONLY, re-pinned:
 *   - the primary (and only) row list comes from GET /models/configured,
 *     hidden rows excluded, provider chips resolved from GET /providers;
 *   - the static catalog (GET /models/catalog) is NEVER consulted;
 *   - picking a configured row writes the provider-scoped
 *     {providerId, modelId} pair (the R82 wire, unchanged);
 *   - zero configured rows render the honest hint + the Models & Providers
 *     link (never a fallback catalog);
 *   - the inherit row keeps its exact old behavior (null clears).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import SubAgentsTab, { SubAgentsSection } from "./SubAgentsTab";
import { SettingsPage } from "../../pages/SettingsPage";
import { resetTestState, renderWithProviders } from "../../test-utils";
import type {
  KeyPoolSlot,
  ProviderModelConfig,
  ProviderView,
  SubagentModelRef,
} from "../../lib/api";

/* ── Stateful fetch mock (the sidecar API surface this tab touches) ───────── */

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
let pool: KeyPoolSlot[] = [];
let settings = {
  maxParallel: 5,
  perKeyLimit: 3,
  // ROUND-82: provider-scoped ref (the wire shape GET always returns —
  // legacy strings normalize to openrouter-scoped objects, as the backend
  // readSubagentModel does).
  subagentModel: null as SubagentModelRef | string | null,
  // ROUND-52 (R52-b): the supervisor knobs (GET/PUT /settings/orchestration).
  childWatchdogMs: 15_000,
  childStallTimeoutMs: 300_000,
};

/** ROUND-82: normalize like the backend's readSubagentModel — a legacy
 * plain string reads as the openrouter-scoped ref; the object passes
 * through; anything malformed degrades to null. */
function normalizeSubagentModel(value: unknown): SubagentModelRef | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return { providerId: "openrouter", modelId: value };
  if (typeof value === "object" && value !== null) {
    const ref = value as { providerId?: unknown; modelId?: unknown };
    if (typeof ref.providerId === "string" && typeof ref.modelId === "string") {
      return { providerId: ref.providerId, modelId: ref.modelId };
    }
  }
  return null;
}

/** The live provider registry fixture (GET /providers) — feeds the picker's
 * provider chips (R93-A9: the display name, falling back to the raw id). */
const PROVIDERS: ProviderView[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "chat-completions",
    enabled: true,
    createdAt: "2026-08-21T09:00:00Z",
    hasKey: true,
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    kind: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiFormat: "chat-completions",
    enabled: true,
    createdAt: "2026-08-22T09:00:00Z",
    hasKey: true,
  },
];

/** R93-A9: configured-rows fixture (GET /models/configured) — the picker's
 * PRIMARY list. Covers: a free tool-capable openrouter row, a PAID openrouter
 * row (both must show — the user curated them), a nvidia NIM row (the R82
 * provider-scoped pick), a HIDDEN row (must never render), and a tool-less
 * row (renders disabled with the honest gate). */
function configuredRow(
  overrides: Partial<ProviderModelConfig> & Pick<ProviderModelConfig, "id" | "providerId" | "modelId">,
): ProviderModelConfig {
  return {
    displayName: "",
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
    hidden: false,
    sortOrder: 0,
    createdAt: "2026-09-11T09:00:00Z",
    updatedAt: "2026-09-11T09:00:00Z",
    ...overrides,
  };
}

const CONFIGURED_ROWS: ProviderModelConfig[] = [
  configuredRow({
    id: "m1",
    providerId: "openrouter",
    modelId: "z-ai/glm-5.2:free",
    displayName: "Z.ai: GLM 5.2",
    contextWindow: 256000,
    inputPricePerMtok: 0,
    supportsTools: true,
  }),
  configuredRow({
    id: "m2",
    providerId: "openrouter",
    modelId: "openai/gpt-5.2",
    displayName: "OpenAI: GPT-5.2",
    contextWindow: 400000,
    inputPricePerMtok: 1.25,
    supportsTools: true,
  }),
  configuredRow({
    id: "m3",
    providerId: "nvidia",
    modelId: "nim/llama-4-70b",
    displayName: "NIM: Llama 4 70B",
    contextWindow: 131072,
    supportsTools: true,
  }),
  configuredRow({
    id: "m4",
    providerId: "openrouter",
    modelId: "hidden/row",
    displayName: "Hidden Row",
    supportsTools: true,
    hidden: true,
  }),
  configuredRow({
    id: "m5",
    providerId: "openrouter",
    modelId: "toolless/row",
    displayName: "Toolless Row",
    supportsTools: false,
  }),
];

/** What GET /models/configured answers this test (rows list + ok flag). */
let configuredRows: ProviderModelConfig[] = CONFIGURED_ROWS;
let configuredOk = true;

function jsonResponse(body: unknown): Response {
  return { status: 200, ok: true, text: async () => JSON.stringify(body) } as unknown as Response;
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : undefined;
  calls.push({ method, url, body });

  const keyMatch = url.match(/\/api\/v1\/providers\/openrouter\/keys(?:\/(\d+))?$/);
  if (keyMatch !== null) {
    if (keyMatch[1] === undefined && method === "GET") return jsonResponse({ keys: pool });
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
  // R93-A9: the provider registry — feeds the row chips' display names.
  if (url.endsWith("/api/v1/providers") && method === "GET") {
    return jsonResponse({ providers: PROVIDERS });
  }
  // R93-A9: the picker's PRIMARY source — the user's configured rows.
  if (url.endsWith("/api/v1/models/configured") && method === "GET") {
    if (!configuredOk) {
      return {
        status: 503,
        ok: false,
        text: async () =>
          JSON.stringify({ error: { code: "UNAVAILABLE", message: "configured rows down (fixture)" } }),
      } as unknown as Response;
    }
    return jsonResponse({ models: configuredRows });
  }
  if (url.endsWith("/api/v1/settings/orchestration")) {
    if (method === "GET") {
      // ROUND-82: GET answers the NORMALIZED shape (like the backend).
      return jsonResponse({ ...settings, subagentModel: normalizeSubagentModel(settings.subagentModel) });
    }
    if (method === "PUT") {
      const patch = body as Record<string, unknown>;
      if (patch.subagentModel !== undefined) {
        // ROUND-82: accepts the ref object, the legacy string, or null.
        settings = { ...settings, subagentModel: patch.subagentModel as SubagentModelRef | string | null };
      }
      if (typeof patch.childWatchdogMs === "number") {
        settings = { ...settings, childWatchdogMs: patch.childWatchdogMs };
      }
      if (typeof patch.childStallTimeoutMs === "number") {
        settings = { ...settings, childStallTimeoutMs: patch.childStallTimeoutMs };
      }
      // ROUND-58 (R58-d): the parallelism steppers moved onto this tab.
      if (typeof patch.maxParallel === "number") {
        settings = { ...settings, maxParallel: patch.maxParallel };
      }
      if (typeof patch.perKeyLimit === "number") {
        settings = { ...settings, perKeyLimit: patch.perKeyLimit };
      }
      return jsonResponse(settings);
    }
  }
  // Advanced's MemoryCard (GET/PUT /settings/memory) — simple stateful mock.
  let memoryEnabled = true;
  if (url.endsWith("/api/v1/settings/memory")) {
    if (method === "GET") return jsonResponse({ enabled: memoryEnabled });
    if (method === "PUT") {
      memoryEnabled = (body as { enabled?: unknown }).enabled === true;
      return jsonResponse({ enabled: memoryEnabled });
    }
  }
  // ROUND-65 (R65): Advanced's DebugModeCard (GET/PUT /settings/debug) —
  // same stateful mock (default OFF — the honest default).
  let debugEnabled = false;
  if (url.endsWith("/api/v1/settings/debug")) {
    if (method === "GET") return jsonResponse({ enabled: debugEnabled });
    if (method === "PUT") {
      debugEnabled = (body as { enabled?: unknown }).enabled === true;
      return jsonResponse({ enabled: debugEnabled });
    }
  }
  return { status: 404, ok: false, text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: `unmocked ${method} ${url}` } }) } as unknown as Response;
});

beforeEach(() => {
  resetTestState();
  calls.length = 0;
  pool = [];
  settings = {
    maxParallel: 5,
    perKeyLimit: 3,
    subagentModel: null,
    childWatchdogMs: 15_000,
    childStallTimeoutMs: 300_000,
  };
  configuredRows = CONFIGURED_ROWS;
  configuredOk = true;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SubAgentsTab — rendering (ROUND-43 R43-5 + ROUND-58 R58-d, re-pinned ROUND-93 R93-A9)", () => {
  it("renders the page header + the keys note, model, parallelism, and supervision cards", async () => {
    renderWithProviders(<SubAgentsTab />);

    // ROUND-92 (R92-D3): the old hardcoded "Sub-agent OpenRouter keys"
    // paste-slot card is DELETED — sub-agents ride the provider key pools
    // (juggled automatically). In its place: the compact informational note.
    await waitFor(() => expect(screen.getByTestId("subagent-keys-note")).toBeTruthy());
    expect(
      screen.getByText(/Sub-agents use the API key pool of each provider/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Models and Providers to manage API keys" })).toBeTruthy();
    // The paste-slot UI is gone entirely — no key inputs live on this page.
    expect(screen.queryByLabelText(/Sub-agent key for pool slot/)).toBeNull();
    // ROUND-58 (R58-d): clean page header — the stale "Temporary setup"
    // banner is GONE.
    expect(screen.getByRole("heading", { level: 2, name: "Sub-agents" })).toBeTruthy();
    expect(screen.queryByText("Temporary setup.")).toBeNull();
    // ROUND-92 (R92-D3): the header copy now states the new truth — sub-agents
    // share each provider's API key pool.
    expect(
      screen.getByText(/they share each provider's API key pool/),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Sub-agent model")).toBeTruthy());
    // ROUND-58 (R58-d): the stale "(temporary)" card labels are retired too
    // (this page is now the PERMANENT sub-agent home, not a stopgap).
    expect(screen.queryByText("(temporary)")).toBeNull();
    // ROUND-58 (R58-d): the parallelism card MOVED here from Advanced.
    await waitFor(() => expect(screen.getByText("Sub-agent parallelism")).toBeTruthy());
    expect(screen.getByText("Max parallel sub-agents")).toBeTruthy();
    expect(screen.getByText("Per API-key limit")).toBeTruthy();
    expect(screen.getByText("Sub-agent supervision")).toBeTruthy();
    // R93-A9: the picker rows are FETCHED from GET /models/configured — the
    // user's curated rows, not a served catalog.
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && c.url.endsWith("/api/v1/models/configured")),
      ).toBe(true),
    );
    // Configured rows render from the served fixture (display name + ctx).
    await waitFor(() => expect(screen.getByText("Z.ai: GLM 5.2")).toBeTruthy());
    expect(screen.getByText("256K")).toBeTruthy();
    // R93-A9: the static OpenRouter catalog is NEVER consulted anymore —
    // the owner's "only the models which are available" directive.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Use .* for sub-agents/ }).length).toBeGreaterThanOrEqual(1),
    );
    expect(
      calls.every((c) => !c.url.endsWith("/api/v1/models/catalog")),
    ).toBe(true);
    // Default override state + the inherit picker row (both once the
    // orchestration query lands).
    await waitFor(() =>
      expect(screen.getAllByText(/Inherits main model/).length).toBeGreaterThanOrEqual(2),
    );
  });

  it("is reachable via ?tab=subagents; Advanced NO LONGER duplicates the section (R58-d)", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=subagents" });
    // R113-d: the page-level h1 strip is deleted — the TAB's own h2 is the
    // honest "you are on the Sub-agents tab" signal now.
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Sub-agents" })).toBeTruthy());
    // ROUND-92 (R92-D3): the keys presence on this page is the NOTE now.
    expect(screen.getByTestId("subagent-keys-note")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Sub-agent parallelism")).toBeTruthy());

    // ROUND-58 (R58-d): the owner's "subagent and advanced options are
    // apparently mixed up" — the duplication is GONE. ROUND-65 (R65, owner
    // directive): the agent-core connection card itself is REMOVED from
    // Advanced (irrelevant in the desktop app) — Advanced keeps exactly the
    // debug-mode + memory cards.
    // ROUND-78 (R78-C): the tab's label was "General" then. R98-I1 (the
    // owner: "add a dedicated section for functionality…"): it is
    // "Functionality" now (the URL id stays "advanced" — the deep-link
    // above is unchanged); the heading assertion follows the honest rename,
    // the intent (no sub-agent duplication) stays.
    cleanup();
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Functionality" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Debug mode")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Agent memory")).toBeTruthy());
    expect(screen.queryByText("Agent core connection")).toBeNull();
    expect(screen.queryByText("Sub-agent OpenRouter keys")).toBeNull();
    expect(screen.queryByText("Sub-agent parallelism")).toBeNull();
    expect(screen.queryByText("Sub-Agent Orchestration")).toBeNull();
  });
});

// ── ROUND-92 (R92-D3): the separate sub-agent API keys are GONE. The owner's
// rework: "completely remove the separate API keys for the subagents… those
// API keys will be used for the subagents too" — sub-agents ride each
// provider's key pool, juggled automatically on failure. What remains on this
// page: the informational note + its deep link, and NOTHING that writes keys.
describe("SubAgentsTab — the keys note (ROUND-92 R92-D3)", () => {
  it("renders the note with the Models & Providers deep link — and never writes a key from this page", async () => {
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByTestId("subagent-keys-note")).toBeTruthy());
    // The deep link targets the Models & Providers tab (tab=api).
    const link = screen.getByRole("link", { name: "Open Models and Providers to manage API keys" });
    expect(link.getAttribute("href")).toBe("/settings?tab=api");

    // NO key input, NO save/remove button, NO pool mutation ever fires from
    // this page (the old paste-slot card is deleted — keys live in exactly
    // ONE place: Models & Providers → the provider → API keys).
    expect(screen.queryByLabelText(/Sub-agent key for pool slot/)).toBeNull();
    expect(screen.queryByRole("button", { name: /save key/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove pool slot/i })).toBeNull();
    await waitFor(() => expect(screen.getByText("Sub-agent model")).toBeTruthy());
    await waitFor(() => {
      expect(
        calls.every((c) => !(c.method === "PUT" || c.method === "DELETE") || !c.url.includes("/keys/")),
      ).toBe(true);
    });
  });
});

// ── ROUND-93 (R93-A9): the CONFIG-ONLY picker. The owner: "in the sub-agent
// models only those models should be shown which are available, not the other
// ones. Currently it is utilizing OpenRouter and showing me all the available
// OpenRouter models." The primary list is the user's CONFIGURED rows (hidden
// excluded); picking writes the provider-scoped pair (R82 wire, unchanged).
describe("SubAgentsTab — model picker (ROUND-93 R93-A9: the configured models are the list)", () => {
  it("shows every configured row — free and paid alike — and never consults the OpenRouter catalog", async () => {
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByText("Sub-agent model")).toBeTruthy());
    // The FREE configured row shows…
    await waitFor(() => expect(screen.getByText("Z.ai: GLM 5.2")).toBeTruthy());
    // …and so does the PAID one (the user curated it — no free-only
    // segmentation hides a configured row anymore)…
    expect(screen.getByText("OpenAI: GPT-5.2")).toBeTruthy();
    // …and the non-openrouter (nvidia NIM) row too — the R82 gap closed.
    expect(screen.getByText("NIM: Llama 4 70B")).toBeTruthy();
    // The provider chips resolve display names from the registry.
    expect(screen.getByText("NVIDIA NIM")).toBeTruthy();
    // The retired catalog-era segment control is GONE.
    expect(screen.queryByRole("button", { name: /all models/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /free only/i })).toBeNull();
    // The static catalog endpoint is never fetched.
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && c.url.endsWith("/api/v1/models/configured")),
      ).toBe(true),
    );
    expect(calls.every((c) => !c.url.endsWith("/api/v1/models/catalog"))).toBe(true);
  });

  it("picking a configured model persists the provider-scoped {providerId, modelId} pair", async () => {
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByText("Sub-agent model")).toBeTruthy());
    // The nvidia NIM row — the R82 §2.4.5 case a catalog-only picker could
    // never serve.
    fireEvent.click(
      screen.getByRole("button", { name: "Use nim/llama-4-70b on nvidia for sub-agents" }),
    );

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.endsWith("/settings/orchestration"),
      );
      // ROUND-82 wire, unchanged by A9: the explicit provider-scoped pair —
      // the orchestrator override routes the child turns to THAT provider.
      expect(put?.body).toEqual({
        subagentModel: { providerId: "nvidia", modelId: "nim/llama-4-70b" },
      });
    });
    // The refreshed state shows the override as the running model.
    await waitFor(() =>
      expect(screen.getAllByText(/nim\/llama-4-70b/).length).toBeGreaterThanOrEqual(2),
    );
  });

  it("a HIDDEN configured row never renders (the hide toggle keeps it out of pickers)", async () => {
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByText("Z.ai: GLM 5.2")).toBeTruthy());
    // The hidden fixture row is nowhere on the page — not by name…
    expect(screen.queryByText("Hidden Row")).toBeNull();
    // …not by its pick affordance.
    expect(
      screen.queryByRole("button", { name: "Use hidden/row on openrouter for sub-agents" }),
    ).toBeNull();
  });

  it("zero configured models — the honest hint renders and links to the Models & Providers page", async () => {
    configuredRows = [];
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByTestId("subagent-no-models-hint")).toBeTruthy());
    expect(
      screen.getByText("No models configured — add them in Settings → Models & Providers."),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Models and Providers to add models" });
    expect(link.getAttribute("href")).toBe("/settings?tab=api");
    // No fallback catalog rows sneak in — the inherit row is the only pick.
    expect(screen.queryByRole("button", { name: /Use .* for sub-agents/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Inherit the main model for sub-agents" })).toBeTruthy();
  });

  it("disables tool-less configured models with the honest hint", async () => {
    renderWithProviders(<SubAgentsSection />);

    const toolless = await screen.findByRole("button", {
      name: "toolless/row on openrouter (unavailable)",
    });
    expect((toolless as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("no tool calling")).toBeTruthy();
  });

  it("Inherits main model clears the override with subagentModel: null", async () => {
    settings = { maxParallel: 5, perKeyLimit: 3, subagentModel: { providerId: "nvidia", modelId: "nim/llama-4-70b" }, childWatchdogMs: 15_000, childStallTimeoutMs: 300_000 };
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() =>
      expect(screen.getAllByText(/nim\/llama-4-70b/).length).toBeGreaterThanOrEqual(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inherit the main model for sub-agents" }));

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.endsWith("/settings/orchestration"),
      );
      expect(put?.body).toEqual({ subagentModel: null });
    });
    await waitFor(() => expect(screen.getByText("Cleared — inherits main model.")).toBeTruthy());
  });

  it("configured-rows fetch failure shows an honest error — never a hidden fallback (R93-A9)", async () => {
    configuredOk = false;
    renderWithProviders(<SubAgentsSection />);

    // The backend's own failure message surfaces verbatim…
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Configured models unavailable — configured rows down (fixture)");
    // …with a visible retry affordance…
    expect(screen.getByRole("button", { name: "Retry loading the configured models" })).toBeTruthy();
    // …and ZERO model rows — no silent fallback to the OpenRouter catalog.
    expect(screen.queryByRole("button", { name: /Use .* for sub-agents/ })).toBeNull();
    expect(screen.queryByText("Z.ai: GLM 5.2")).toBeNull();
  });

  it("retry reloads the configured rows and renders the picker (R93-A9)", async () => {
    configuredOk = false;
    renderWithProviders(<SubAgentsSection />);

    await screen.findByRole("alert");
    // Backend recovers → Retry refetches → the picker rows render from the
    // configured list.
    configuredOk = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading the configured models" }));

    await waitFor(() => expect(screen.getByText("Z.ai: GLM 5.2")).toBeTruthy());
    expect(
      screen.getByRole("button", { name: "Use nim/llama-4-70b on nvidia for sub-agents" }),
    ).toBeTruthy();
  });
});

// ─── ROUND-52 (R52-b): the supervisor knobs ──────────────────────────────────

describe("SubAgentsTab — supervisor knobs (ROUND-52 R52-b)", () => {
  it("renders the card with the current values converted ms→seconds/minutes", async () => {
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByText("Sub-agent supervision")).toBeTruthy());
    const heartbeat = screen.getByLabelText("Supervisor heartbeat seconds") as HTMLInputElement;
    const stall = screen.getByLabelText("Stall timeout minutes") as HTMLInputElement;
    // 15000ms → 15s; 300000ms → 5min (conversion ONLY at the boundary).
    expect(heartbeat.value).toBe("15");
    expect(stall.value).toBe("5");
    // The helper texts render verbatim.
    expect(screen.getByText("How often running sub-agents report what they're doing")).toBeTruthy();
    expect(
      screen.getByText("A sub-agent with no activity for this long is stopped and reported"),
    ).toBeTruthy();
    // Save is disabled until something changes.
    expect(
      (screen.getByRole("button", { name: "Save sub-agent supervision settings" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("editing + Save PUTs the converted ms values and the refreshed state round-trips", async () => {
    renderWithProviders(<SubAgentsSection />);
    await waitFor(() => expect(screen.getByText("Sub-agent supervision")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Supervisor heartbeat seconds"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Stall timeout minutes"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save sub-agent supervision settings" }));

    // One PUT carrying BOTH knobs converted to ms.
    await waitFor(() => {
      const put = calls.find(
        (c) =>
          c.method === "PUT" &&
          c.url.endsWith("/settings/orchestration") &&
          typeof (c.body as Record<string, unknown> | undefined)?.childWatchdogMs === "number",
      );
      expect(put?.body).toEqual({ childWatchdogMs: 30_000, childStallTimeoutMs: 600_000 });
    });
    // The refreshed GET lands back in the inputs (30s / 10min).
    await waitFor(() =>
      expect((screen.getByLabelText("Supervisor heartbeat seconds") as HTMLInputElement).value).toBe("30"),
    );
    expect((screen.getByLabelText("Stall timeout minutes") as HTMLInputElement).value).toBe("10");
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
  });

  it("out-of-range values show validation errors and disable Save; fixing re-enables it", async () => {
    renderWithProviders(<SubAgentsSection />);
    await waitFor(() => expect(screen.getByText("Sub-agent supervision")).toBeTruthy());
    const save = screen.getByRole("button", { name: "Save sub-agent supervision settings" }) as HTMLButtonElement;
    const heartbeat = screen.getByLabelText("Supervisor heartbeat seconds") as HTMLInputElement;
    const stall = screen.getByLabelText("Stall timeout minutes") as HTMLInputElement;

    // Below the heartbeat floor (5s) — the error shows, Save stays disabled.
    fireEvent.change(heartbeat, { target: { value: "3" } });
    expect(screen.getByTestId("supervisor-heartbeat-field-error").textContent).toBe(
      "Heartbeat must be 5–60 seconds",
    );
    expect(save.disabled).toBe(true);

    // Fix the heartbeat, break the stall ceiling (60min) — same story.
    fireEvent.change(heartbeat, { target: { value: "15" } });
    expect(screen.queryByTestId("supervisor-heartbeat-field-error")).toBeNull();
    fireEvent.change(stall, { target: { value: "90" } });
    expect(screen.getByTestId("supervisor-stall-field-error").textContent).toBe(
      "Stall timeout must be 1–60 minutes",
    );
    expect(save.disabled).toBe(true);
    expect(calls.every((c) => !(c.method === "PUT" && c.body && typeof (c.body as Record<string, unknown>).childWatchdogMs === "number"))).toBe(true);

    // Both valid + dirty → Save enables and a clean value PUTs.
    fireEvent.change(stall, { target: { value: "2" } });
    expect(screen.queryByTestId("supervisor-stall-field-error")).toBeNull();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => {
      const put = calls.find(
        (c) =>
          c.method === "PUT" &&
          typeof (c.body as Record<string, unknown> | undefined)?.childStallTimeoutMs === "number",
      );
      expect(put?.body).toEqual({ childStallTimeoutMs: 120_000 });
    });
  });
});

// ─── ROUND-58 (R58-d): the parallelism card (moved from Advanced) ────────────

describe("SubAgentsTab — parallelism card (ROUND-58 R58-d)", () => {
  it("renders the current maxParallel + perKeyLimit; Save disabled until dirty", async () => {
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByText("Sub-agent parallelism")).toBeTruthy());
    expect(screen.getByLabelText("Max parallel sub-agents value").textContent).toBe("5");
    expect(screen.getByLabelText("Per API-key limit value").textContent).toBe("3");
    const save = screen.getByRole("button", { name: "Save sub-agent parallelism settings" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("steppers clamp to their ranges and Save PUTs the draft values", async () => {
    renderWithProviders(<SubAgentsSection />);
    await waitFor(() => expect(screen.getByText("Sub-agent parallelism")).toBeTruthy());

    // 5 → 6 (max parallel)…
    fireEvent.click(screen.getByRole("button", { name: "Increase Max parallel sub-agents" }));
    // 3 → 4 (per key limit)…
    fireEvent.click(screen.getByRole("button", { name: "Increase Per API-key limit" }));
    expect(screen.getByLabelText("Max parallel sub-agents value").textContent).toBe("6");
    expect(screen.getByLabelText("Per API-key limit value").textContent).toBe("4");

    const save = screen.getByRole("button", { name: "Save sub-agent parallelism settings" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.endsWith("/api/v1/settings/orchestration"),
      );
      expect(put?.body).toEqual({ maxParallel: 6, perKeyLimit: 4 });
    });
    // The refreshed state round-trips into the steppers.
    await waitFor(() =>
      expect(screen.getByLabelText("Max parallel sub-agents value").textContent).toBe("6"),
    );
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
  });

  it("steppers clamp at the min (1) — never below", async () => {
    renderWithProviders(<SubAgentsSection />);
    await waitFor(() => expect(screen.getByText("Sub-agent parallelism")).toBeTruthy());

    // Click decrease 5 times from 3 → floor at 1.
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Decrease Per API-key limit" }));
    }
    expect(screen.getByLabelText("Per API-key limit value").textContent).toBe("1");
  });
});
