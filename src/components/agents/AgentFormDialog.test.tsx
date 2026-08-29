// @vitest-environment happy-dom
/**
 * ROUND-47 (R47-c2) — AgentFormDialog de-drift (focused wiring tests; the
 * submit/validation flow is covered by AgentsScreen.test.tsx):
 *
 *  1. Provider dropdown options come from the LIVE registry (GET /providers,
 *     name + id) — not just the hardcoded PROVIDER_IDS const — and the
 *     default selection (openrouter) is unchanged.
 *  2. Registry unreachable → honest fallback to the PROVIDER_IDS defaults
 *     with the dim "provider list unavailable — showing defaults" note (the
 *     dialog must ALWAYS open).
 *  3. The free-text Model / Vision model inputs gain catalog-fed <datalist>
 *     suggestions (free models first, then paid; value = the exact modelId;
 *     the vision list is vision-capable-only).
 *  4. The dead openrouter/ox-alpha placeholder is gone — the model input
 *     advertises the current default model id from the catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AgentFormDialog } from "./AgentFormDialog";
import { resetTestState, renderWithProviders } from "../../test-utils";
import type { ProviderView, ModelsCatalog } from "../../lib/api";

/* ── Stateful fetch mock (the two endpoints the dialog now touches) ───────── */

const BASE = "http://127.0.0.1:5178";
const calls: Array<{ method: string; url: string }> = [];

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
    id: "acme",
    name: "Acme LLM",
    kind: "openai-compatible",
    baseUrl: "https://api.acme.example/v1",
    apiFormat: "chat-completions",
    enabled: true,
    createdAt: "2026-08-22T09:00:00Z",
    hasKey: false,
  },
];

/** Small catalog fixture: free+tools, free NO-tools, paid, recommended. */
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

/** What GET /providers answers this test (null = 503 failure). */
let providersResponse: ProviderView[] | null = PROVIDERS;

function jsonResponse(body: unknown): Response {
  return { status: 200, ok: true, text: async () => JSON.stringify(body) } as unknown as Response;
}

function errorResponse(message: string): Response {
  return {
    status: 503,
    ok: false,
    text: async () => JSON.stringify({ error: { code: "UNAVAILABLE", message } }),
  } as unknown as Response;
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ method, url });

  if (url === `${BASE}/api/v1/providers` && method === "GET") {
    return providersResponse === null
      ? errorResponse("registry down (fixture)")
      : jsonResponse({ providers: providersResponse });
  }
  if (url === `${BASE}/api/v1/models/catalog` && method === "GET") {
    return jsonResponse(CATALOG);
  }
  return {
    status: 404,
    ok: false,
    text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: `unmocked ${method} ${url}` } }),
  } as unknown as Response;
});

function renderDialog() {
  const onSubmit = vi.fn(async () => {});
  renderWithProviders(
    <AgentFormDialog agent={null} open onOpenChange={() => {}} onSubmit={onSubmit} />,
  );
  return { onSubmit };
}

beforeEach(() => {
  resetTestState();
  calls.length = 0;
  providersResponse = PROVIDERS;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentFormDialog — live provider options (ROUND-47 R47-c2)", () => {
  it("loads the dropdown from GET /providers (name + id) and keeps openrouter default-selected", async () => {
    renderDialog();

    // The live registry's providers — including a CUSTOM one — appear.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "OpenRouter (openrouter)" })).toBeTruthy(),
    );
    expect(screen.getByRole("option", { name: "Acme LLM (acme)" })).toBeTruthy();
    expect(
      calls.some((c) => c.method === "GET" && c.url.endsWith("/api/v1/providers")),
    ).toBe(true);
    // Default selection behavior unchanged: openrouter, no agent in context.
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("openrouter");
  });

  it("registry unreachable → falls back to PROVIDER_IDS with the honest dim note", async () => {
    providersResponse = null;
    renderDialog();

    await waitFor(() =>
      expect(screen.getByText("provider list unavailable — showing defaults")).toBeTruthy(),
    );
    // The fallback defaults are the raw PROVIDER_IDS (plain ids, no names)…
    expect(screen.getByRole("option", { name: "openrouter" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "anthropic" })).toBeTruthy();
    // …and the custom provider from the (unreachable) registry never shows.
    expect(screen.queryByRole("option", { name: /Acme LLM/ })).toBeNull();
    // The dialog still works: the default selection survives on the fallback.
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("openrouter");
  });

  it("an agent on a provider missing from the list keeps its selection visible", async () => {
    // openrouter exists, acme does NOT — editing an acme agent must not
    // silently blank the select.
    providersResponse = [PROVIDERS[0]];
    renderWithProviders(
      <AgentFormDialog
        agent={{
          id: "agent-1",
          name: "Scout",
          role: "researcher",
          systemPrompt: "",
          providerId: "acme",
          model: "acme/rocket-1",
          visionModel: null,
          allowedTools: [],
          memoryPolicy: "every-turn",
          skills: [],
          maxTurns: 40,
          temperature: 0.2,
          isTemplate: false,
          version: 1,
          createdAt: "2026-08-22T09:00:00Z",
          updatedAt: "2026-08-22T09:00:00Z",
        }}
        open
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "OpenRouter (openrouter)" })).toBeTruthy(),
    );
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    expect(select.value).toBe("acme");
    expect(screen.getByRole("option", { name: "acme" })).toBeTruthy();
  });
});

describe("AgentFormDialog — catalog-fed model suggestions (ROUND-47 R47-c2)", () => {
  it("feeds both free-text inputs from GET /models/catalog: free first, then paid; exact ids as values", async () => {
    renderDialog();

    // Both inputs stay free-text but reference their datalists.
    const modelInput = screen.getByLabelText("Model") as HTMLInputElement;
    const visionInput = screen.getByLabelText("Vision model (optional)") as HTMLInputElement;
    expect(modelInput.getAttribute("list")).toBe("agent-model-options");
    expect(visionInput.getAttribute("list")).toBe("agent-vision-model-options");

    // The model datalist lands from the served catalog…
    await waitFor(() => {
      const options = Array.from(
        document.querySelectorAll("#agent-model-options option"),
      ) as HTMLOptionElement[];
      expect(options.length).toBe(3);
    });
    const values = Array.from(
      document.querySelectorAll("#agent-model-options option"),
    ).map((o) => (o as HTMLOptionElement).value);
    // …FREE models first, paid last — and the VALUE is the exact modelId, so
    // picking a suggestion pastes the unambiguous id.
    expect(values).toEqual([
      "z-ai/glm-5.2:free",
      "nvidia/nemotron-3.5-lightning:free",
      "openai/gpt-5.2",
    ]);
    // The labels carry the human name + tier.
    expect(
      Array.from(document.querySelectorAll("#agent-model-options option")).map(
        (o) => o.textContent,
      ),
    ).toContain("Z.ai: GLM 5.2 (free)");

    // The vision datalist offers ONLY vision-capable models (glm is not).
    await waitFor(() => {
      const visionValues = Array.from(
        document.querySelectorAll("#agent-vision-model-options option"),
      ).map((o) => (o as HTMLOptionElement).value);
      expect(visionValues).toEqual([
        "nvidia/nemotron-3.5-lightning:free",
        "openai/gpt-5.2",
      ]);
    });
    expect(
      calls.some((c) => c.method === "GET" && c.url.endsWith("/api/v1/models/catalog")),
    ).toBe(true);
  });

  it("model placeholder is the CURRENT default model id — the dead ox-alpha is gone", async () => {
    renderDialog();

    const modelInput = screen.getByLabelText("Model") as HTMLInputElement;
    // The live default from the catalog (z-ai/glm-5.2:free), never the
    // deleted-upstream openrouter/ox-alpha the placeholder used to advertise.
    await waitFor(() => expect(modelInput.placeholder).toBe("z-ai/glm-5.2:free"));
    expect(modelInput.placeholder).not.toBe("openrouter/ox-alpha");
    // Custom models remain enterable — plain free-text, nothing coerced.
    fireEvent.change(modelInput, { target: { value: "acme/rocket-1" } });
    expect(modelInput.value).toBe("acme/rocket-1");
  });
});
