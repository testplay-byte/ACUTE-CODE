// @vitest-environment happy-dom
/**
 * ROUND-43 (R43-5) — the temporary Sub-agents settings section:
 *
 *  1. The section renders (temporary banner, keys card, model card, the
 *     "Inherits main model" default).
 *  2. Key paste slots write the EXISTING pool routes at slots 2/3/4 — never
 *     slot 0 — and removal DELETEs the same slot.
 *  3. The model picker is free-only by default (shared pref), "All models"
 *     escapes it, tool-less entries are disabled with a hint, and picking a
 *     model persists orchestration.subagentModel (null clears it).
 *  4. The dedicated ?tab=subagents page renders, and Advanced hosts the same
 *     section meanwhile (sidebar entry is a separate owner's file).
 *
 * ROUND-47 (R47-c2) — the picker rows come from GET /models/catalog (the
 * backend's MODEL_CATALOG) instead of a hand-copied local duplicate: rows
 * render from the fixture, the recommended badge is data-driven, and a
 * catalog failure renders an HONEST error + retry (never a hidden fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import SubAgentsTab, { SubAgentsSection } from "./SubAgentsTab";
import { SettingsPage } from "../../pages/SettingsPage";
import { resetTestState, renderWithProviders } from "../../test-utils";
import { useSettingsStore } from "../../lib/settings-store";
import type { KeyPoolSlot, ModelsCatalog } from "../../lib/api";

/* ── Stateful fetch mock (the sidecar API surface this tab touches) ───────── */

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
let pool: KeyPoolSlot[] = [];
let settings = { maxParallel: 5, perKeyLimit: 3, subagentModel: null as string | null };

/** Small realistic GET /models/catalog fixture (R47-b contract shape):
 * free+tools, free+tool-less (must render disabled), paid, and the
 * recommended sub-agent default. */
const CATALOG: ModelsCatalog = {
  models: [
    {
      modelId: "z-ai/glm-5.2:free",
      displayName: "Z.ai: GLM 5.2",
      contextWindow: 256000,
      maxOutputTokens: 65536,
      inputPricePerMtok: 0,
      inputPriceCachedPerMtok: 0,
      outputPricePerMtok: 0,
      free: true,
      supportsTools: true,
      supportsStructuredOutputs: true,
      supportsVision: false,
    },
    {
      modelId: "nvidia/nemotron-3.5-lightning:free",
      displayName: "NVIDIA: Nemotron 3.5 Lightning",
      contextWindow: 1000000,
      maxOutputTokens: 32768,
      inputPricePerMtok: 0,
      inputPriceCachedPerMtok: 0,
      outputPricePerMtok: 0,
      free: true,
      supportsTools: true,
      supportsStructuredOutputs: true,
      supportsVision: true,
    },
    {
      modelId: "nvidia/nemotron-3.5-content-safety:free",
      displayName: "NVIDIA: Nemotron 3.5 Content Safety",
      contextWindow: 128000,
      maxOutputTokens: 16384,
      inputPricePerMtok: 0,
      inputPriceCachedPerMtok: 0,
      outputPricePerMtok: 0,
      free: true,
      supportsTools: false,
      supportsStructuredOutputs: false,
      supportsVision: false,
    },
    {
      modelId: "openai/gpt-5.2",
      displayName: "OpenAI: GPT-5.2",
      contextWindow: 400000,
      maxOutputTokens: 128000,
      inputPricePerMtok: 1.25,
      inputPriceCachedPerMtok: 0.125,
      outputPricePerMtok: 10,
      free: false,
      supportsTools: true,
      supportsStructuredOutputs: true,
      supportsVision: true,
    },
  ],
  defaultModelId: "z-ai/glm-5.2:free",
  subagentDefaultModelId: "nvidia/nemotron-3.5-lightning:free",
  recommendedModelIds: ["z-ai/glm-5.2:free", "nvidia/nemotron-3.5-lightning:free"],
};

/** What GET /models/catalog answers this test (true = fixture, false = 503). */
let catalogOk = true;

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
  if (url.endsWith("/api/v1/models/catalog") && method === "GET") {
    if (!catalogOk) {
      return {
        status: 503,
        ok: false,
        text: async () =>
          JSON.stringify({ error: { code: "UNAVAILABLE", message: "catalog down (fixture)" } }),
      } as unknown as Response;
    }
    return jsonResponse(CATALOG);
  }
  if (url.endsWith("/api/v1/settings/orchestration")) {
    if (method === "GET") return jsonResponse(settings);
    if (method === "PUT") {
      const patch = body as Record<string, unknown>;
      if (typeof patch.subagentModel === "string" || patch.subagentModel === null) {
        settings = { ...settings, subagentModel: patch.subagentModel as string | null };
      }
      return jsonResponse(settings);
    }
  }
  return { status: 404, ok: false, text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: `unmocked ${method} ${url}` } }) } as unknown as Response;
});

beforeEach(() => {
  resetTestState();
  calls.length = 0;
  pool = [];
  settings = { maxParallel: 5, perKeyLimit: 3, subagentModel: null };
  catalogOk = true;
  useSettingsStore.setState({ modelsFreeOnly: true });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SubAgentsTab — rendering (ROUND-43 R43-5)", () => {
  it("renders the temporary banner, the keys card, the model card, and the inherit default", async () => {
    renderWithProviders(<SubAgentsTab />);

    await waitFor(() => expect(screen.getByText("Sub-agent OpenRouter keys")).toBeTruthy());
    // Clearly labeled temporary (both cards).
    await waitFor(() =>
      expect(screen.getAllByText("(temporary)").length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.getByText("Temporary setup.")).toBeTruthy();
    // The owner-directed context copy.
    expect(
      screen.getByText(/Sub-agent traffic prefers these keys so parallel agents don't compete/),
    ).toBeTruthy();
    expect(screen.getByText("Sub-agent model")).toBeTruthy();
    // ROUND-47 (R47-c2): the rows are FETCHED from GET /models/catalog —
    // the de-drifted single source of truth, not a local copy.
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && c.url.endsWith("/api/v1/models/catalog")),
      ).toBe(true),
    );
    // Catalog rows render from the served fixture (display name + id + ctx).
    await waitFor(() => expect(screen.getByText("Z.ai: GLM 5.2")).toBeTruthy());
    expect(screen.getByText("256K")).toBeTruthy();
    // Default override state + the inherit picker row (both once the
    // orchestration query lands).
    await waitFor(() =>
      expect(screen.getAllByText(/Inherits main model/).length).toBeGreaterThanOrEqual(2),
    );
    // The three dedicated paste slots render as empty inputs.
    expect(screen.getByLabelText("Sub-agent key for pool slot 2")).toBeTruthy();
    expect(screen.getByLabelText("Sub-agent key for pool slot 3")).toBeTruthy();
    expect(screen.getByLabelText("Sub-agent key for pool slot 4")).toBeTruthy();
  });

  it("is reachable via ?tab=subagents and hosted inside Advanced meanwhile", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=subagents" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Sub-agents" })).toBeTruthy());
    expect(screen.getByText("Sub-agent OpenRouter keys")).toBeTruthy();

    cleanup();
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    await waitFor(() => expect(screen.getByText("Sub-agent OpenRouter keys")).toBeTruthy());
    // The Advanced tab still carries the orchestration limits card.
    await waitFor(() => expect(screen.getByText("Sub-Agent Orchestration")).toBeTruthy());
  });
});

describe("SubAgentsTab — key paste slots", () => {
  it("saving a pasted key PUTs pool slot 2 — and slot 0 is never touched", async () => {
    renderWithProviders(<SubAgentsSection />);

    const input = await screen.findByLabelText("Sub-agent key for pool slot 2");
    fireEvent.change(input, { target: { value: "sk-or-v1-testkey-0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key to pool slot 2" }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/keys/2"));
      expect(put).toBeDefined();
      expect(put?.body).toEqual({ value: "sk-or-v1-testkey-0001" });
    });
    // NEVER the owner's primary key slot.
    expect(calls.every((c) => !c.url.includes("/keys/0"))).toBe(true);
    // The saved state re-renders masked.
    await waitFor(() => expect(screen.getByText("sk-or…0001")).toBeTruthy());
  });

  it("shows the masked saved state and DELETEs the slot on remove", async () => {
    pool = [{ slot: 2, hasKey: true, masked: "sk-o…wxyz" }];
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByText("sk-o…wxyz")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove pool slot 2 key" }));

    await waitFor(() => {
      const del = calls.find((c) => c.method === "DELETE" && c.url.endsWith("/keys/2"));
      expect(del).toBeDefined();
    });
    expect(calls.every((c) => !c.url.includes("/keys/0"))).toBe(true);
  });

  it("offers the next free pool slot for extra keys", async () => {
    pool = [
      { slot: 2, hasKey: true, masked: "sk-o…aaaa" },
      { slot: 3, hasKey: true, masked: "sk-o…bbbb" },
      { slot: 4, hasKey: true, masked: "sk-o…cccc" },
    ];
    renderWithProviders(<SubAgentsSection />);

    // All three dedicated slots full → the add row targets slot 5.
    const extra = await screen.findByLabelText("Sub-agent key for pool slot 5");
    fireEvent.change(extra, { target: { value: "sk-or-v1-testkey-0042" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key to pool slot 5" }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/keys/5"))).toBeDefined();
    });
  });
});

describe("SubAgentsTab — model picker", () => {
  it("is free-only by default; All models escapes the filter", async () => {
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByText("Sub-agent model")).toBeTruthy());
    // Free default: a paid catalog model is hidden…
    expect(screen.queryByText("openai/gpt-5.2")).toBeNull();
    // …while free entries (incl. the recommended sub-agent default) show.
    expect(screen.getByText("NVIDIA: Nemotron 3.5 Lightning")).toBeTruthy();
    // The recommended badge is data-driven (catalog.subagentDefaultModelId).
    expect(screen.getAllByText("recommended").length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /all models/i }));
    await waitFor(() => expect(screen.getByText("openai/gpt-5.2")).toBeTruthy());
  });

  it("disables tool-less models with the required hint", async () => {
    renderWithProviders(<SubAgentsSection />);

    const toolless = await screen.findByRole("button", {
      name: "nvidia/nemotron-3.5-content-safety:free (unavailable)",
    });
    expect((toolless as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("tool calling required")).toBeTruthy();
  });

  it("picking a model persists orchestration.subagentModel and reloads the selection", async () => {
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() => expect(screen.getByText("Sub-agent model")).toBeTruthy());
    fireEvent.click(
      screen.getByRole("button", { name: "Use nvidia/nemotron-3.5-lightning:free for sub-agents" }),
    );

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.endsWith("/settings/orchestration"),
      );
      expect(put?.body).toEqual({ subagentModel: "nvidia/nemotron-3.5-lightning:free" });
    });
    // The refreshed state shows the override as the running model.
    await waitFor(() =>
      expect(screen.getAllByText(/nvidia\/nemotron-3\.5-lightning:free/).length).toBeGreaterThanOrEqual(2),
    );
  });

  it("Inherits main model clears the override with subagentModel: null", async () => {
    settings = { maxParallel: 5, perKeyLimit: 3, subagentModel: "nvidia/nemotron-3.5-lightning:free" };
    renderWithProviders(<SubAgentsSection />);

    await waitFor(() =>
      expect(screen.getAllByText(/nvidia\/nemotron-3\.5-lightning:free/).length).toBeGreaterThanOrEqual(1),
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

  it("catalog fetch failure shows an honest error — never a hidden fallback copy (R47-c2)", async () => {
    catalogOk = false;
    renderWithProviders(<SubAgentsSection />);

    // The backend's own failure message surfaces verbatim…
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Model catalog unavailable — catalog down (fixture)");
    // …with a visible retry affordance…
    expect(screen.getByRole("button", { name: "Retry loading the model catalog" })).toBeTruthy();
    // …and ZERO model rows — no silent fallback to a baked-in catalog.
    expect(screen.queryByRole("button", { name: /Use .* for sub-agents/ })).toBeNull();
    expect(screen.queryByText("Z.ai: GLM 5.2")).toBeNull();
  });

  it("retry reloads the catalog and renders the picker rows (R47-c2)", async () => {
    catalogOk = false;
    renderWithProviders(<SubAgentsSection />);

    await screen.findByRole("alert");
    // Backend recovers → Retry refetches → the picker rows render from the catalog.
    catalogOk = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading the model catalog" }));

    await waitFor(() => expect(screen.getByText("Z.ai: GLM 5.2")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Use nvidia/nemotron-3.5-lightning:free for sub-agents" })).toBeTruthy();
    expect(screen.getByText("recommended")).toBeTruthy();
  });
});
