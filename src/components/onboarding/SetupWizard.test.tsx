// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { SetupWizard } from "./SetupWizard";
import { useOnboardingStore } from "./onboarding-store";
import { THEMES } from "../../lib/themes";

// Vitest globals are off, so RTL's auto-cleanup does not hook in.
afterEach(cleanup);

// ── R98-H: the stateful sidecar stub (rides global fetch) ───────────────────
//
// DEFAULTS to this file's ORIGINAL semantics — every request THROWS (the
// "sidecar unreachable" class the pre-existing tests ran under) — so those
// tests keep their exact behavior. The knobs arm per-test:
//   getProviders  — null (unreachable) or the GET /providers row list;
//   postStatus    — 201 (stateful create) or 409 (conflictMessage override);
//   posts         — every POST /providers body, for the EXACT-body assertions.
// The POST create derives the id exactly like the sidecar's slugifyProviderId.
const sidecar = vi.hoisted(() => ({
  getProviders: null as Array<Record<string, unknown>> | null,
  created: [] as Array<Record<string, unknown>>,
  postStatus: 201,
  conflictMessage: null as string | null,
  posts: [] as Array<{ body: Record<string, unknown> }>,
}));

/** The sidecar's id derivation (storage/providers.ts slugifyProviderId). */
const slugifyLikeSidecar = (name: string): string => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug === "" ? "" : `prv_${slug}`;
};

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/v1/providers") && method === "GET") {
      if (sidecar.getProviders === null) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ providers: [...sidecar.getProviders, ...sidecar.created] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/api/v1/providers") && method === "POST") {
      const body = init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      sidecar.posts.push({ body });
      if (sidecar.postStatus === 409) {
        const message = sidecar.conflictMessage ?? "provider name is already in use";
        return new Response(JSON.stringify({ error: { code: "CONFLICT", message } }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      const name = typeof body.name === "string" ? body.name : "";
      const row = {
        id: slugifyLikeSidecar(name),
        name,
        kind: "openai-compatible",
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
        apiFormat: typeof body.apiFormat === "string" ? body.apiFormat : "chat-completions",
        enabled: true,
        createdAt: new Date().toISOString(),
        hasKey: false,
      };
      sidecar.created.push(row);
      return new Response(JSON.stringify(row), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Everything else keeps the original unreachable semantics.
    throw new TypeError("Failed to fetch");
  }),
);

// The wizard store is module-level; reset it (and the first-run flag + the
// stub's stateful knobs) so each test starts the machine from Welcome.
beforeEach(() => {
  localStorage.clear();
  sidecar.getProviders = null;
  sidecar.created = [];
  sidecar.postStatus = 201;
  sidecar.conflictMessage = null;
  sidecar.posts = [];
  useOnboardingStore.setState({
    step: 0,
    brainChoice: "now",
    providerId: "",
    baseUrl: "",
    apiKey: "",
    showApiKey: false,
    modelId: "",
    showModelDropdown: false,
    contextWindow: 100000,
    contextManual: false,
    maxOutput: 8192,
    temperature: 0.7,
    inputCost: 2.5,
    outputCost: 10,
    reasoning: "med",
  });
});

function renderWizard() {
  // Fresh QueryClient per render: no retry (the sidecar is unreachable here),
  // no cross-test cache. Providers query fails gracefully -> selector shows
  // its offline hint on the PlugBrain step.
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/setup"]}>
        <SetupWizard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The existing four-click walk from Welcome to the PlugBrain step. */
function navigateToPlugBrain() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  fireEvent.click(screen.getByRole("button", { name: /configure now/i }));
  fireEvent.click(screen.getByRole("button", { name: /configure model/i }));
}

/** Open the provider dropdown and click the always-offered custom entry. */
async function openCustomProviderForm() {
  fireEvent.focus(screen.getByPlaceholderText("Search providers..."));
  fireEvent.click(screen.getByRole("button", { name: /custom openai-compatible/i }));
  await waitFor(() => expect(screen.getByLabelText("Display name")).toBeTruthy());
}

describe("Setup wizard", () => {
  it("renders step 0 (Welcome) with Header/Footer chrome", () => {
    renderWizard();
    expect(screen.getByText("WELCOME TO")).toBeTruthy();
    expect(screen.getByText("Get Started")).toBeTruthy();
    expect(screen.getAllByText(/ACUTE-CODE • CRAFTED WITH/).length).toBeGreaterThan(0);
  });

  it("advances to PickFlavor and renders one card per THEMES entry", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(screen.getByText("Pick your flavor.")).toBeTruthy();
    for (const t of THEMES) {
      expect(screen.getByText(t.name)).toBeTruthy();
    }
    expect(screen.getByText("New themes coming soon")).toBeTruthy();
  });

  it("reaches NeedBrain and 'Skip to Finish' lands on AllSet", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText("Need a brain?")).toBeTruthy();
    // Choose "I'll do it later", then take the skip exit.
    fireEvent.click(screen.getByRole("button", { name: /do it later/i }));
    fireEvent.click(screen.getByRole("button", { name: /skip to finish/i }));
    expect(screen.getByText("You're all set!")).toBeTruthy();
    // Completion/dismissal sets the first-run flag.
    expect(localStorage.getItem("acute.setupDone")).toBe("1");
  });

  it("PlugBrain offers OpenRouter by default even when the providers list is empty (owner-reported bug)", async () => {
    renderWizard(); // providers query fails (no sidecar) -> client-side fallback must kick in
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /configure now/i }));
    fireEvent.click(screen.getByRole("button", { name: /configure model/i }));
    // The selector merges OPENROUTER_FALLBACK when the server list is empty —
    // the owner's exact complaint was an empty provider picker on fresh boot.
    const openrouter = await screen.findAllByText(/openrouter/i);
    expect(openrouter.length).toBeGreaterThan(0);
  });
});

describe("ROUND-98 (R98-H) custom OpenAI-compatible providers in the wizard", () => {
  it("(a) the '+ Custom OpenAI-compatible…' entry sits at the top and opens the three-field form without touching the auto-selected OpenRouter row", async () => {
    // The GET resolves an EMPTY list — the entry must be offered anyway.
    sidecar.getProviders = [];
    renderWizard();
    navigateToPlugBrain();
    // The client-side auto-selection landed on OpenRouter.
    await waitFor(() => expect(useOnboardingStore.getState().providerId).toBe("openrouter"));
    expect(useOnboardingStore.getState().baseUrl).toBe("https://openrouter.ai/api/v1");
    await openCustomProviderForm();
    // The three fields are all present (api format defaults to chat-completions).
    expect(screen.getByLabelText("Base URL")).toBeTruthy();
    expect(screen.getByRole("button", { name: /chat completions/i })).toBeTruthy();
    // The OpenRouter row was NOT touched, and NO POST ever fired.
    expect(useOnboardingStore.getState().providerId).toBe("openrouter");
    expect(useOnboardingStore.getState().baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(sidecar.posts).toHaveLength(0);
    // The pre-existing focus-timer bug (fixed in passing): 50ms after the
    // dropdown closed, the stale auto-focus must NOT re-open it over the
    // form — the entry stays gone, the form stays up.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByRole("button", { name: /custom openai-compatible/i })).toBeNull();
    expect(screen.getByLabelText("Display name")).toBeTruthy();
  });

  it("(b) empty name + non-http(s) URL are each refused with their honest alert — ZERO POSTs, the form stays", async () => {
    sidecar.getProviders = [];
    renderWizard();
    navigateToPlugBrain();
    await waitFor(() => expect(useOnboardingStore.getState().providerId).toBe("openrouter"));
    await openCustomProviderForm();
    // Empty display name → the honest refusal.
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://gw.example.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));
    expect((await screen.findByRole("alert")).textContent).toBe("Display name is required.");
    expect(sidecar.posts).toHaveLength(0);
    // A non-http(s) base URL → its honest refusal; the form is still up.
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "My Gateway" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "ftp://gw.example.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));
    expect((await screen.findByRole("alert")).textContent).toBe("Base URL must start with http:// or https://.");
    expect(sidecar.posts).toHaveLength(0);
    expect(screen.getByLabelText("Display name")).toBeTruthy();
  });

  it("(c) a successful create POSTs the EXACT custom body and selects the fresh row", async () => {
    sidecar.getProviders = [];
    renderWizard();
    navigateToPlugBrain();
    await waitFor(() => expect(useOnboardingStore.getState().providerId).toBe("openrouter"));
    await openCustomProviderForm();
    // Whitespace on both text fields — the POST body must be TRIMMED.
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "  My Gateway  " } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "  https://gw.example.com/v1  " } });
    fireEvent.click(screen.getByRole("button", { name: /anthropic messages/i }));
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));
    // The EXACT custom body — {name, baseUrl (trimmed), apiFormat} and
    // NOTHING else (no key, no id, no kind ever rides the body).
    await waitFor(() => expect(sidecar.posts).toHaveLength(1));
    expect(sidecar.posts[0].body).toEqual({
      name: "My Gateway",
      baseUrl: "https://gw.example.com/v1",
      apiFormat: "anthropic-messages",
    });
    // The fresh row is selected exactly like handleSelect: providerId +
    // baseUrl in the store, modelId "" (a non-OpenRouter row).
    await waitFor(() => expect(useOnboardingStore.getState().providerId).toBe("prv_my-gateway"));
    expect(useOnboardingStore.getState().baseUrl).toBe("https://gw.example.com/v1");
    expect(useOnboardingStore.getState().modelId).toBe("");
    // The form collapsed, the trigger shows the fresh row's name, no alert.
    await waitFor(() => expect(screen.queryByLabelText("Display name")).toBeNull());
    expect(screen.getByDisplayValue("My Gateway")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("(d) a 409 fires the POST and renders the server's message VERBATIM inline — the form and the OpenRouter selection stay", async () => {
    sidecar.getProviders = [];
    sidecar.postStatus = 409;
    sidecar.conflictMessage =
      "provider name 'OpenRouter' is already in use — pick a different display name";
    renderWizard();
    navigateToPlugBrain();
    await waitFor(() => expect(useOnboardingStore.getState().providerId).toBe("openrouter"));
    await openCustomProviderForm();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "OpenRouter" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://gw.example.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));
    // The POST fired; the server's exact message renders inline, VERBATIM.
    await waitFor(() => expect(sidecar.posts).toHaveLength(1));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "provider name 'OpenRouter' is already in use — pick a different display name",
    );
    // The form stays; the OpenRouter selection is untouched.
    expect(screen.getByLabelText("Display name")).toBeTruthy();
    expect(useOnboardingStore.getState().providerId).toBe("openrouter");
    expect(useOnboardingStore.getState().baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});
