// @vitest-environment happy-dom
/**
 * ROUND-43 (R43-5) — the Sub-agents settings section:
 *
 *  1. The section renders (keys card, model card, parallelism card,
 *     supervision card — R58-d order).
 *  2. Key paste slots write the EXISTING pool routes at slots 2/3/4 — never
 *     slot 0 — and removal DELETEs the same slot.
 *  3. The model picker is free-only by default (shared pref), "All models"
 *     escapes it, tool-less entries are disabled with a hint, and picking a
 *     model persists orchestration.subagentModel (null clears it).
 *  4. The dedicated ?tab=subagents page renders the same section; since
 *     ROUND-58 (R58-d) Advanced NO LONGER duplicates it (the owner: "the
 *     subagent and advanced options are apparently mixed up") — Advanced
 *     keeps only the connection + memory cards.
 *  5. ROUND-58 (R58-d): the parallelism card (maxParallel + perKeyLimit
 *     steppers) MOVED here from the old Advanced tab's OrchestrationCard.
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
import type { KeyPoolSlot, ModelsCatalog, SubagentModelRef } from "../../lib/api";

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

describe("SubAgentsTab — rendering (ROUND-43 R43-5 + ROUND-58 R58-d)", () => {
  it("renders the page header + the keys, model, parallelism, and supervision cards", async () => {
    renderWithProviders(<SubAgentsTab />);

    await waitFor(() => expect(screen.getByText("Sub-agent OpenRouter keys")).toBeTruthy());
    // ROUND-58 (R58-d): clean page header — the stale "Temporary setup"
    // banner is GONE.
    expect(screen.getByRole("heading", { level: 2, name: "Sub-agents" })).toBeTruthy();
    expect(screen.queryByText("Temporary setup.")).toBeNull();
    expect(screen.getByText(/everything sub-agent lives on this one page/)).toBeTruthy();
    // The owner-directed context copy.
    expect(
      screen.getByText(/Sub-agent traffic prefers these keys so parallel agents don't compete/),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Sub-agent model")).toBeTruthy());
    // ROUND-58 (R58-d): the stale "(temporary)" card labels are retired too
    // (this page is now the PERMANENT sub-agent home, not a stopgap).
    expect(screen.queryByText("(temporary)")).toBeNull();
    expect(screen.getByText(/permanent home for sub-agent configuration/)).toBeTruthy();
    // ROUND-58 (R58-d): the parallelism card MOVED here from Advanced.
    await waitFor(() => expect(screen.getByText("Sub-agent parallelism")).toBeTruthy());
    expect(screen.getByText("Max parallel sub-agents")).toBeTruthy();
    expect(screen.getByText("Per API-key limit")).toBeTruthy();
    expect(screen.getByText("Sub-agent supervision")).toBeTruthy();
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

  it("is reachable via ?tab=subagents; Advanced NO LONGER duplicates the section (R58-d)", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=subagents" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Sub-agents" })).toBeTruthy());
    expect(screen.getByText("Sub-agent OpenRouter keys")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Sub-agent parallelism")).toBeTruthy());

    // ROUND-58 (R58-d): the owner's "subagent and advanced options are
    // apparently mixed up" — the duplication is GONE. ROUND-65 (R65, owner
    // directive): the agent-core connection card itself is REMOVED from
    // Advanced (irrelevant in the desktop app) — Advanced keeps exactly the
    // debug-mode + memory cards.
    // ROUND-78 (R78-C): the tab's LABEL is "General" now (the URL id stays
    // "advanced" — the deep-link above is unchanged); the heading assertion
    // follows the honest rename, the intent (no sub-agent duplication) stays.
    cleanup();
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Debug mode")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Agent memory")).toBeTruthy());
    expect(screen.queryByText("Agent core connection")).toBeNull();
    expect(screen.queryByText("Sub-agent OpenRouter keys")).toBeNull();
    expect(screen.queryByText("Sub-agent parallelism")).toBeNull();
    expect(screen.queryByText("Sub-Agent Orchestration")).toBeNull();
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
      // ROUND-82: catalog picks write the explicit provider-scoped pair —
      // the orchestrator override routes the child turns to THIS provider
      // (the pre-R82 bare string was openrouter-implied only).
      expect(put?.body).toEqual({
        subagentModel: { providerId: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free" },
      });
    });
    // The refreshed state shows the override as the running model.
    await waitFor(() =>
      expect(screen.getAllByText(/nvidia\/nemotron-3\.5-lightning:free/).length).toBeGreaterThanOrEqual(2),
    );
  });

  it("Inherits main model clears the override with subagentModel: null", async () => {
    settings = { maxParallel: 5, perKeyLimit: 3, subagentModel: "nvidia/nemotron-3.5-lightning:free", childWatchdogMs: 15_000, childStallTimeoutMs: 300_000 };
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
