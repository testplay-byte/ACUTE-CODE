// @vitest-environment happy-dom
/**
 * ROUND-60 (R60-B) — the settings-page padding directives:
 *
 *  1. The header strip + the content container drop to the tightened
 *     px-4/px-6, py-4 rhythm (the owner: "The whole right side has a lot of
 *     padding on the settings page. All of the settings have a lot of extra
 *     unnecessary padding on the right and left sides… minimize the padding
 *     as much as possible.").
 *  2. The Models & Providers tab fills the FULL available width — no max-w
 *     cap, no mx-auto centering (the master-detail owns every pixel), while
 *     the form tabs keep a readable, tighter max-w-4xl.
 *
 * ROUND-62 (R62-2a) — the appearance-tab simplification (the owner: "in the
 * settings in the appearence make it simple easier and much better and also
 * remove the unnecessary not configured settings"): the Interface Mode +
 * Theme sections are MERGED (one "Theme" section, segmented control directly
 * above the unchanged card grid, no "Changes apply live" helper), Density is
 * "Chat Density" with a one-line hint, "Tool activity" cards are clean
 * radio cards (the mock previews are gone), and the Sidebar Tint section is
 * REMOVED from the UI (the theme-store field survives untouched).
 *
 * The api tab's queries ride a deterministic 401-stubbed fetch (retry is
 * off in the test QueryClient) — the page still renders its layout and the
 * empty provider list, which is all these assertions need.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";
import { resetTestState, renderWithProviders } from "../test-utils";
import { useConfigStore } from "../lib/config-store";
import { useThemeStore } from "../lib/theme-store";

/** Every request 401s (the bearer wall) — queries fail soft, layout renders. */
const fetchMock = vi.fn(
  async () =>
    ({
      status: 401,
      ok: false,
      text: async () =>
        JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no token" } }),
    }) as unknown as Response,
);

beforeEach(() => {
  resetTestState();
  // R62-2a: resetTestState only pins themeId/mode — the appearance tests
  // below also toggle density + activityMode, so the whole store is reset.
  useThemeStore.setState({
    themeId: "nova",
    mode: "dark",
    density: "comfortable",
    activityMode: "detailed",
    sidebarTint: "subtle",
    chatTextSize: "medium",
    timestampsMode: "hidden",
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsPage padding (R60-B)", () => {
  it("the header strip + the content container use the tightened px-4/px-6 rhythm — no px-5/px-8 anywhere", () => {
    renderWithProviders(<SettingsPage />); // default tab: appearance

    // The header strip — the element that owns the "Settings" micro-label.
    const header = screen.getByText("Settings").parentElement as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.className).toContain("px-4 md:px-6");
    expect(header.className).not.toContain("px-5");
    expect(header.className).not.toContain("px-8");

    // The scrollable content container.
    const content = document.querySelector(".overflow-y-auto") as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.className).toContain("px-4 md:px-6");
    expect(content.className).toContain("py-4");
    expect(content.className).not.toContain("px-5");
    expect(content.className).not.toContain("py-5");
  });

  it("form tabs keep a readable (tighter) max-w-4xl centering — the old 5xl cap is gone", () => {
    renderWithProviders(<SettingsPage />); // default tab: appearance

    const content = document.querySelector(".overflow-y-auto") as HTMLElement;
    expect(content.className).toContain("max-w-4xl");
    expect(content.className).toContain("mx-auto");
    expect(content.className).not.toContain("max-w-5xl");
  });

  it("the Models & Providers tab fills the FULL width — no max-w cap, no mx-auto, viewport-locked", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=api" });

    // The api content container is the page-level overflow-hidden element
    // (an ancestor precedes its descendants in document order).
    const content = document.querySelector(".overflow-hidden") as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.className).toContain("px-4 md:px-6");
    expect(content.className).toContain("py-4");
    expect(content.className).toContain("w-full");
    expect(content.className).not.toContain("max-w");
    expect(content.className).not.toContain("mx-auto");

    // The tab actually rendered behind the 401-stubbed queries: the empty
    // provider list is the honest state.
    await screen.findByText("No providers — add one below.");
  });

  // R95-A (the owner: "on any of the pages there is no need to show the Back
  // to Dashboard page button. The only place where the option needs to be
  // shown is in the left sidebar"): the settings page's OWN back pill is GONE.
  it("R95-A: NO 'Back to dashboard' pill in the settings content area — the sidebar owns the back affordance", () => {
    renderWithProviders(<SettingsPage />); // default tab: appearance
    expect(screen.queryByRole("link", { name: /back to dashboard/i })).toBeNull();
    expect(screen.queryByText("Back to dashboard")).toBeNull();

    // And on the Models & Providers tab too.
    cleanup();
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=api" });
    expect(screen.queryByRole("link", { name: /back to dashboard/i })).toBeNull();
  });
});

describe("Appearance tab simplification (R62-2a)", () => {
  it("ONE Theme section — the segmented control sits directly above the UNCHANGED theme grid; no separate Interface Mode section", () => {
    renderWithProviders(<SettingsPage />); // default tab: appearance

    // The single section title (the old "Interface Mode" title + the
    // redundant "Changes apply live" helper line are gone).
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.queryByText("Interface Mode")).toBeNull();
    expect(screen.queryByText("Changes apply live across the whole app.")).toBeNull();

    // The segmented control and the theme cards share the SAME section, in
    // that order (segmented first, grid directly below).
    const segmented = screen.getByRole("radiogroup", { name: "Theme mode" });
    const firstCard = screen.getByRole("button", { name: "Theme Nova Cream" });
    expect(segmented.closest("section")).toBe(firstCard.closest("section"));
    expect(
      (segmented.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);

    // All 5 theme cards still render (the grid itself was NOT redesigned).
    for (const name of ["Nova Cream", "Bento Blue", "Midnight Lab", "Sunset Pop", "Mono Stone"]) {
      expect(screen.getByRole("button", { name: `Theme ${name}` })).toBeTruthy();
    }
  });

  it("the merged Theme section still toggles light/dark", () => {
    renderWithProviders(<SettingsPage />);

    const light = screen.getByRole("radio", { name: "light mode" });
    expect(light.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(light);
    expect(useThemeStore.getState().mode).toBe("light");
    expect(light.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "dark mode" }).getAttribute("aria-checked")).toBe("false");
  });

  it("the merged Theme section still selects a theme", () => {
    renderWithProviders(<SettingsPage />);

    const card = screen.getByRole("button", { name: "Theme Bento Blue" });
    expect(card.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(card);
    expect(useThemeStore.getState().themeId).toBe("bento");
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Theme Nova Cream" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("Chat Density still toggles — helper text is one short line", () => {
    renderWithProviders(<SettingsPage />);

    expect(screen.getByText("Chat Density")).toBeTruthy();
    expect(screen.getByText("Compact fits more on screen.")).toBeTruthy();
    expect(
      screen.queryByText("Comfortable adds breathing room to the chat; compact fits more on screen."),
    ).toBeNull();

    const compact = screen.getByRole("radio", { name: "compact density" });
    fireEvent.click(compact);
    expect(useThemeStore.getState().density).toBe("compact");
    expect(compact.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "comfortable density" }).getAttribute("aria-checked")).toBe("false");
  });

  it("Tool activity cards are clean radio cards (label + one-line description only) and still switch modes", () => {
    renderWithProviders(<SettingsPage />);

    expect(screen.getByText("Tool activity")).toBeTruthy();
    expect(screen.queryByText("Tool Calls")).toBeNull();

    // The one-line descriptions survive; the tiny inline mock previews
    // (fake bars + the "— none —" block) are GONE.
    expect(screen.getByText("Full timeline with diffs and command output")).toBeTruthy();
    expect(screen.getByText("One-line summary per turn")).toBeTruthy();
    expect(screen.getByText("Never show tool activity")).toBeTruthy();
    expect(screen.queryByText("— none —")).toBeNull();
    expect(document.querySelectorAll('[class*="h-[5px]"]').length).toBe(0);

    const detailed = screen.getByRole("button", { name: /Detailed/ });
    expect(detailed.getAttribute("aria-pressed")).toBe("true"); // store default
    fireEvent.click(screen.getByRole("button", { name: /Compact/ }));
    expect(useThemeStore.getState().activityMode).toBe("compact");
    expect(screen.getByRole("button", { name: /Compact/ }).getAttribute("aria-pressed")).toBe("true");
    expect(detailed.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /^Hidden Never show/ }));
    expect(useThemeStore.getState().activityMode).toBe("hidden");
  });

  // R97-H: the chat customizability sections.
  it("Text Size cards switch the chatTextSize store field (medium default)", () => {
    renderWithProviders(<SettingsPage />);

    expect(screen.getByText("Text Size")).toBeTruthy();
    expect(screen.getByText("The chat's reading surfaces — answers, thinking, narration.")).toBeTruthy();

    // Medium is the active default.
    const medium = screen.getByRole("button", { name: /Medium/ });
    expect(medium.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Large/ }));
    expect(useThemeStore.getState().chatTextSize).toBe("large");
    expect(screen.getByRole("button", { name: /Large/ }).getAttribute("aria-pressed")).toBe("true");
    expect(medium.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /Small/ }));
    expect(useThemeStore.getState().chatTextSize).toBe("small");
  });

  it("Timestamps cards switch the timestampsMode store field (hidden default)", () => {
    renderWithProviders(<SettingsPage />);

    expect(screen.getByText("Timestamps")).toBeTruthy();
    const hidden = screen.getByRole("button", { name: /^Hidden The clean default/ });
    expect(hidden.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /On hover/ }));
    expect(useThemeStore.getState().timestampsMode).toBe("hover");
    expect(screen.getByRole("button", { name: /On hover/ }).getAttribute("aria-pressed")).toBe("true");
    expect(hidden.getAttribute("aria-pressed")).toBe("false");
  });

  it("the Sidebar Tint section is GONE from the UI (store field untouched)", () => {
    renderWithProviders(<SettingsPage />);
    expect(screen.queryByText("Sidebar Tint")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Sidebar tint strength" })).toBeNull();
    expect(screen.queryByRole("radio", { name: /sidebar tint/i })).toBeNull();

    // The tab is FIVE sections now: Theme, Chat density, Text Size (R97-H),
    // Timestamps (R97-H), Tool activity — the R62 three + the R97-H chat
    // customizability pair, each a real wired setting (never a dead card).
    expect(document.querySelectorAll("section").length).toBe(5);

    // The removal is UI-ONLY — the theme-store field + setter survive
    // (useThemeSync/deriveThemeStyles still read sidebarTint).
    const state = useThemeStore.getState();
    expect(state.sidebarTint).toBe("subtle");
    expect(typeof state.setSidebarTint).toBe("function");
  });

  it("the tab reads as ONE simple column with the tighter gap-4 rhythm", () => {
    renderWithProviders(<SettingsPage />);

    const column = document.querySelector(".max-w-3xl") as HTMLElement;
    expect(column).not.toBeNull();
    expect(column.className).toContain("flex-col");
    expect(column.className).toContain("gap-4");
    expect(column.className).not.toContain("gap-5");
  });
});

// ── ROUND-65 (R65): the Advanced tab rebuild ────────────────────────────────
// The owner's directive: remove the irrelevant "agent core connection" /
// bearer-token fields from Advanced (the desktop app manages the sidecar
// itself); add the debug-mode switch (R66 rework: the main agent answers
// normally; a context-free post-turn ANALYST streams its execution report
// in a dedicated section). A routed fetch stub serves /settings/debug (mutable — PUT
// patches the state like the server) + /settings/memory; everything else
// 401s like the file-level stub.
describe("Advanced tab (ROUND-65 R65)", () => {
  const state = { debug: false, memory: true };
  const puts: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    state.debug = false;
    state.memory = true;
    puts.length = 0;
    resetTestState();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/v1/settings/debug")) {
          if ((init?.method ?? "GET") === "PUT") {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            puts.push(body);
            if (typeof body.enabled === "boolean") state.debug = body.enabled;
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ enabled: state.debug }),
          } as unknown as Response;
        }
        if (url.includes("/api/v1/settings/memory")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ enabled: state.memory }),
          } as unknown as Response;
        }
        return {
          status: 401,
          ok: false,
          text: async () =>
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no token" } }),
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the agent-core connection card is GONE (Base URL / Bearer token / Demo data / Save connection)", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });

    // The switch renders (the tab is alive) before the removal assertions.
    expect(await screen.findByRole("switch", { name: "Toggle debug mode" })).toBeTruthy();

    // The removed card's unique strings are all gone.
    expect(screen.queryByText("Agent core connection")).toBeNull();
    expect(screen.queryByText("Base URL")).toBeNull();
    expect(screen.queryByText("Bearer token")).toBeNull();
    expect(screen.queryByText("Demo data (fixture adapter when the sidecar is unreachable)")).toBeNull();
    expect(screen.queryByText("Save connection")).toBeNull();

    // R78: the header copy leads with the engine switches (the tab was
    // "General" then). R98-I1: the copy now introduces the two category
    // headers instead of enumerating every card ("grouped by category");
    // the standing Sub-agents pointer survives the rework.
    expect(
      screen.getByText(/The engine's behavior switches, grouped by category/),
    ).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Toggle agent memory" })).toBeTruthy();
  });

  it("toggling debug mode PUTs {enabled:true}, refetches, and the switch flips ON", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });

    const toggle = await screen.findByRole("switch", { name: "Toggle debug mode" });
    expect(toggle.getAttribute("aria-checked")).toBe("false"); // honest default

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    expect(puts).toEqual([{ enabled: true }]);
    expect(screen.getByText("Post-turn debug analyst")).toBeTruthy();
  });

  it("an error from the PUT surfaces on the card (honest failure, not a silent flip)", async () => {
    // The next PUT fails with a 500 envelope.
    const fetchMock = vi.mocked(vi.fn());
    void fetchMock;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/settings/debug") && (init?.method ?? "GET") === "PUT") {
        return {
          ok: false,
          status: 500,
          text: async () =>
            JSON.stringify({ error: { code: "INTERNAL", message: "engine exploded" } }),
        } as unknown as Response;
      }
      return original(input, init);
    }) as typeof fetch;

    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    const toggle = await screen.findByRole("switch", { name: "Toggle debug mode" });
    fireEvent.click(toggle);
    expect(await screen.findByText(/engine exploded/)).toBeTruthy();
    // The switch honestly stays OFF (the server state never changed).
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

// ── ROUND-78 (R78-C): the Functionality tab (née General) + the Auto-retry
// card — R98-I1 renamed the label to "Functionality" (the owner's word) and
// added the two category headers. The tab's LABEL is "Functionality" (the
// URL id stays "advanced" — the deep-link
// contract is load-bearing), and the RetryConfigCard (three per-failure-type
// auto-retry switches against GET/PUT /settings/retry) mounts ABOVE the
// DebugModeCard. The routed stub serves /settings/retry (mutable — PUT
// patches the state like the server) + /settings/debug + /settings/memory.
describe("Functionality tab + Auto-retry card (ROUND-78 R78-C, R98-I1)", () => {
  // R80: the state models the CURRENT server shape — the three switches +
  // the customizable schedule (maxAttempts / waitMinutes /
  // providerTimeoutSeconds). The card renders the schedule from THIS data.
  const retryState: {
    autoRetryRateLimit: boolean;
    autoRetryTimeout: boolean;
    autoRetryNetwork: boolean;
    maxAttempts: number;
    waitMinutes: number[];
    providerTimeoutSeconds: number;
  } = {
    autoRetryRateLimit: true,
    autoRetryTimeout: true,
    autoRetryNetwork: true,
    maxAttempts: 6,
    waitMinutes: [0, 1.5, 5, 10, 30],
    providerTimeoutSeconds: 600,
  };
  const retryPuts: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    retryState.autoRetryRateLimit = true;
    retryState.autoRetryTimeout = true;
    retryState.autoRetryNetwork = true;
    retryState.maxAttempts = 6;
    retryState.waitMinutes = [0, 1.5, 5, 10, 30];
    retryState.providerTimeoutSeconds = 600;
    retryPuts.length = 0;
    resetTestState();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/v1/settings/retry")) {
          if ((init?.method ?? "GET") === "PUT") {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            retryPuts.push(body);
            for (const key of ["autoRetryRateLimit", "autoRetryTimeout", "autoRetryNetwork"] as const) {
              if (typeof body[key] === "boolean") retryState[key] = body[key] as boolean;
            }
            if (typeof body.maxAttempts === "number") retryState.maxAttempts = body.maxAttempts;
            if (typeof body.providerTimeoutSeconds === "number") {
              retryState.providerTimeoutSeconds = body.providerTimeoutSeconds;
            }
            if (Array.isArray(body.waitMinutes)) retryState.waitMinutes = body.waitMinutes as number[];
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ...retryState, waitMinutes: [...retryState.waitMinutes] }),
          } as unknown as Response;
        }
        if (url.includes("/api/v1/settings/debug")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ enabled: false }),
          } as unknown as Response;
        }
        if (url.includes("/api/v1/settings/memory")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ enabled: true }),
          } as unknown as Response;
        }
        return {
          status: 401,
          ok: false,
          text: async () =>
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no token" } }),
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("R98-I1: the tab is FUNCTIONALITY now (?tab=advanced unchanged): h1 Functionality, the two category headers, the Auto-retry card ABOVE the Debug card, and the Data & insights cross-link", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });

    // The label rename — the h1 reads the TABS entry, the URL id is untouched.
    expect(screen.getByRole("heading", { level: 1, name: "Functionality" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "General" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "Advanced" })).toBeNull();

    // The card + its three switches (all default ON — the R75 ladder stands).
    // Wait for a SWITCH (the loading branch shares the testid but has none).
    await screen.findByRole("switch", { name: "Toggle auto-retry for rate limits (429)" });
    const card = screen.getByTestId("retry-settings-card");
    expect(card.getAttribute("aria-label")).toBe("Auto-retry");
    for (const name of [
      "Toggle auto-retry for rate limits (429)",
      "Toggle auto-retry for timeouts",
      "Toggle auto-retry for network errors",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeTruthy();
    }
    // The per-switch testids (the browser-verification hooks).
    expect(document.querySelector('[data-testid="retry-switch-autoRetryRateLimit"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="retry-switch-autoRetryTimeout"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="retry-switch-autoRetryNetwork"]')).toBeTruthy();

    // ABOVE the Debug mode card (retry behavior is a general engine setting,
    // not an advanced curiosity — the R78-C order).
    const debugCard = (await screen.findByRole("switch", { name: "Toggle debug mode" }))
      .closest("section") as HTMLElement;
    expect(
      (card.compareDocumentPosition(debugCard) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
    // The honest help text teaches the ladder schedule + the fail-fast trade.
    expect(screen.getByText(/When a switch is off, that failure type shows immediately/)).toBeTruthy();
    // R80: the footnote now renders the schedule FROM THE DATA (the R75
    // rungs no longer hardcoded) — "immediately" (run g 0) + the rest.
    expect(screen.getByText(/6 attempts: immediately, 1\.5 min, 5 min, 10 min, 30 min/)).toBeTruthy();

    // R98-I1: the TWO category headers (the owner's "basic agent capabilities"
    // + "data and statistics" categories) — SectionTitle h2s over the card
    // clusters, "Basic agent capabilities" ABOVE the retry card, "Data &
    // insights" below the memory card.
    const basicHeader = screen.getByRole("heading", { level: 2, name: "Basic agent capabilities" });
    expect(
      (basicHeader.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
    const memoryCard = (await screen.findByRole("switch", { name: "Toggle agent memory" }))
      .closest("section") as HTMLElement;
    const insightsHeader = screen.getByRole("heading", { level: 2, name: "Data & insights" });
    expect(
      (memoryCard.compareDocumentPosition(insightsHeader) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
    // The Data & insights category's ONE card: the cross-link to the Data &
    // Statistics tab (the inline-Link idiom, href ?tab=data — the deep-link
    // contract) — no data logic duplicated on this tab.
    const crossLink = screen.getByTestId("data-insights-crosslink-card");
    const link = crossLink.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/settings?tab=data");
    expect(link?.textContent).toContain("Data & Statistics");
  });

  it("R99-E: the ?tab=data deep-link mounts the shared DataStatsPanel — behind the 401 wall it renders the panel's honest retryable error (no data logic on the page itself)", async () => {
    // The panel's query only runs against the live sidecar — flip the store
    // so the 401-stubbed fetch actually executes (demo mode stays idle and
    // would render the panel's empty state instead).
    useConfigStore.setState({ demoData: false });
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=data" });

    // The shared panel is the tab's whole body (the R98-I2 mount contract;
    // its own pins live in DataStatsPanel.test.tsx).
    expect(await screen.findByTestId("data-stats-panel")).toBeTruthy();

    // The 401-stubbed fetch fails the panel's stats query — the honest
    // error card with ONE Retry (the R97-I state-awareness contract).
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Could not load data & statistics/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading data and statistics" })).toBeTruthy();
  });

  it("toggling a switch PUTs the PARTIAL patch ({autoRetryRateLimit:false}) and the switch flips OFF after the refetch — the other two stay untouched", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    const rateLimit = (await screen.findByTestId("retry-switch-autoRetryRateLimit")) as HTMLElement;
    expect(rateLimit.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(rateLimit);
    await waitFor(() => expect(rateLimit.getAttribute("aria-checked")).toBe("false"));

    // Exactly ONE partial PUT — the per-switch mutation (never the whole object).
    expect(retryPuts).toEqual([{ autoRetryRateLimit: false }]);
    // The siblings honestly stayed ON (the PUT carried nothing for them).
    expect(screen.getByTestId("retry-switch-autoRetryTimeout").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("retry-switch-autoRetryNetwork").getAttribute("aria-checked")).toBe("true");
  });

  it("a FAILED PUT surfaces the honest error line and the switch stays ON (the server state never changed)", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/settings/retry") && (init?.method ?? "GET") === "PUT") {
        return {
          ok: false,
          status: 500,
          text: async () =>
            JSON.stringify({ error: { code: "INTERNAL", message: "settings store exploded" } }),
        } as unknown as Response;
      }
      return original(input, init);
    }) as typeof fetch;

    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    const timeout = (await screen.findByTestId("retry-switch-autoRetryTimeout")) as HTMLElement;
    fireEvent.click(timeout);
    expect(await screen.findByText(/settings store exploded/)).toBeTruthy();
    expect(timeout.getAttribute("aria-checked")).toBe("true");
  });

  /* ── ROUND-80 (R80, owner: "in the settings retry customization is
   * needed"): the customizable schedule — the max-attempts stepper, the
   * per-rung wait inputs, the provider timeout input, and Reset to
   * defaults. Every control PUTs a PARTIAL patch through the same
   * /settings/retry mutation; the card re-renders from the refetched
   * state (the footnote + the rung rows follow the data). */
  it("R80: the schedule section renders from the fetched data (stepper value, rung inputs, timeout) and the max-attempts stepper PUTs {maxAttempts:5}", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    await screen.findByTestId("retry-max-attempts");

    // The default schedule renders: stepper 6, FIVE rung inputs (attempts
    // 2..6), the 600 s timeout.
    expect(screen.getByTestId("retry-max-attempts").textContent).toBe("6");
    for (const i of [0, 1, 2, 3, 4]) {
      expect(screen.getByTestId(`retry-wait-${i}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("retry-wait-5")).toBeNull();
    expect((screen.getByTestId("retry-timeout") as HTMLInputElement).value).toBe("600");

    // The rung rows label the ATTEMPT they precede (#2..#6).
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("#6")).toBeTruthy();

    // Stepper minus → the partial PUT + the refetched state everywhere.
    fireEvent.click(screen.getByTestId("retry-max-attempts-minus"));
    await waitFor(() => expect(screen.getByTestId("retry-max-attempts").textContent).toBe("5"));
    expect(retryPuts).toContainEqual({ maxAttempts: 5 });
    // Five attempts → FOUR rung rows (the footnote follows the data too).
    expect(screen.queryByTestId("retry-wait-4")).toBeNull();
    expect(screen.getByText(/5 attempts: immediately, 1\.5 min, 5 min, 10 min/)).toBeTruthy();
  });

  it("R80: editing a rung wait PUTs the padded {waitMinutes} array and the input refetches", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    await screen.findByTestId("retry-wait-1");
    const rung = screen.getByTestId("retry-wait-1") as HTMLInputElement;
    expect(rung.value).toBe("1.5");

    fireEvent.change(rung, { target: { value: "3" } });
    await waitFor(() => expect(retryPuts).toContainEqual({ waitMinutes: [0, 3, 5, 10, 30] }));
    await waitFor(() => expect((screen.getByTestId("retry-wait-1") as HTMLInputElement).value).toBe("3"));
    // The footnote picked up the new rung.
    expect(screen.getByText(/6 attempts: immediately, 3 min, 5 min, 10 min, 30 min/)).toBeTruthy();
  });

  it("R80: the provider timeout input PUTs {providerTimeoutSeconds:900} (clamped server-side)", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    await screen.findByTestId("retry-timeout");
    const timeoutInput = screen.getByTestId("retry-timeout") as HTMLInputElement;

    fireEvent.change(timeoutInput, { target: { value: "900" } });
    await waitFor(() => expect(retryPuts).toContainEqual({ providerTimeoutSeconds: 900 }));
    await waitFor(() => expect((screen.getByTestId("retry-timeout") as HTMLInputElement).value).toBe("900"));
  });

  it("R80: Reset to defaults PUTs the WHOLE default object (switches + schedule)", async () => {
    // Dirty the state first (maxAttempts 4) so the reset is observable —
    // one step per refetch (the buttons disable while the PUT is pending).
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });
    await screen.findByTestId("retry-max-attempts");
    fireEvent.click(screen.getByTestId("retry-max-attempts-minus"));
    await waitFor(() => expect(screen.getByTestId("retry-max-attempts").textContent).toBe("5"));
    fireEvent.click(screen.getByTestId("retry-max-attempts-minus"));
    await waitFor(() => expect(screen.getByTestId("retry-max-attempts").textContent).toBe("4"));

    fireEvent.click(screen.getByTestId("retry-reset"));
    await waitFor(() =>
      expect(retryPuts).toContainEqual({
        autoRetryRateLimit: true,
        autoRetryTimeout: true,
        autoRetryNetwork: true,
        maxAttempts: 6,
        waitMinutes: [0, 1.5, 5, 10, 30],
        providerTimeoutSeconds: 600,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("retry-max-attempts").textContent).toBe("6"));
  });

  /* ── R97-I part 3 (the state-awareness sweep): the card's honest ERROR
   * gate. The pre-R97 `isLoading || current === undefined` gate swallowed a
   * failed GET into an ETERNAL "loading retry settings…" (data undefined
   * never resolves) — a 401 looked like latency. Now the card renders the
   * retryable error (role=alert, same section testid) and a successful
   * Retry flows back into the normal card. */
  it("R97-I: a 401 on the GET renders the honest error card (role=alert + Retry) instead of hanging on \"loading retry settings…\"; a successful Retry recovers the card", async () => {
    // Phase 1: the retry GET hits the bearer wall. The describe's stub does
    // not serve thinking-loop either — patch that too, so the retry card is
    // the ONE honest error on the tab and the role=alert query stays unique.
    // R98-J: the desktop-notifications GET joins the patched set (its card
    // arrived this round — the same uniqueness rule).
    let failRetryGet = true;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/settings/thinking-loop")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ enabled: false, stallSeconds: 120, reasoningBytesKB: 24 }),
        } as unknown as Response;
      }
      if (url.includes("/api/v1/settings/desktop-notifications")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ enabled: true }),
        } as unknown as Response;
      }
      if (url.includes("/api/v1/settings/retry") && (init?.method ?? "GET") === "GET" && failRetryGet) {
        return {
          ok: false,
          status: 401,
          text: async () =>
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no token" } }),
        } as unknown as Response;
      }
      return original(input, init);
    }) as typeof fetch;

    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });

    // The honest error replaces the eternal loading line — inside the SAME
    // section (the testid survives), carrying the cause + the Retry button.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load retry settings");
    expect(alert.textContent).toContain("no token");
    expect(alert.closest("section")?.getAttribute("data-testid")).toBe("retry-settings-card");
    expect(screen.queryByText("loading retry settings…")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Retry loading retry settings" });
    // No dead switches while the card has nothing real to show.
    expect(screen.queryByTestId("retry-switch-autoRetryRateLimit")).toBeNull();

    // Phase 2: the sidecar recovers — flipping the mock + clicking Retry
    // re-drives the GET and the normal card (switches + schedule) returns.
    failRetryGet = false;
    fireEvent.click(retryButton);
    const rateLimit = await screen.findByRole("switch", { name: "Toggle auto-retry for rate limits (429)" });
    expect(rateLimit.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("retry-max-attempts").textContent).toBe("6");
  });
});

/* ── ROUND-98 (R98-E1/E3): the Prompts tab's deep-link render branch. The
 * describe's 401 stub covers the sections GET — the honest error card (not
 * an eternal loader) is exactly what a logged-out browser should see.
 * ROUND-99 (R99-F): the tab's own h2 is the "System prompt" framing title
 * (the project-wide redesign) and it SURVIVES the error gate. */
describe("Prompts tab (ROUND-98 R98-E / ROUND-99 R99-F)", () => {
  it("?tab=prompts deep-links to the Prompts tab: the h1 adapts, the System prompt framing mounts, and the 401'd sections GET renders the honest error card + Retry", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=prompts" });

    // The header adapts to the section (h1) while the tab renders its own
    // framing h2 (R99-F: "System prompt", the project-wide scope — it mounts
    // with the manager card once the picker's projects resolve); the tab's
    // root mounts in the standard max-w column branch (the form-tabs
    // container, not the api tab's viewport-locked one).
    expect(screen.getByRole("heading", { level: 1, name: "Prompts" })).toBeTruthy();
    expect(screen.getByTestId("prompts-tab")).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 2, name: "System prompt" })).toBeTruthy();
    // The picker defaults to the FIRST registered project (the demo fixture
    // set rides getProjectsBackend) and the sections GET hits the 401 stub.
    expect(await screen.findByTestId("prompt-sections-error")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading the prompt sections" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading prompt sections" })).toBeNull();
  });
});

/* ── ROUND-99 (R99-A): the Browser tab's LINK OPENING preference — where
 * the app's own links open (the central router lib/open-link's truth). The
 * stateful fetch stub models GET/PUT /settings/browser; the pins: the two
 * ChoiceCards with the exact owner-facing copy, the partial PUT, the LIVE
 * push into the router's cache (the very next click obeys — asserted via
 * getLinkOpeningMode), the labeled radio group, and the card's honest
 * loading + 401 gates. */
describe("Browser tab: Link opening preference (ROUND-99 R99-A)", () => {
  const browserState: {
    searchEngine: "duckduckgo" | "google" | "bing" | "brave";
    homepage: string;
    defaultZoom: number;
    quickLinks: Array<{ label: string; url: string }>;
    linkOpeningMode: "in-app" | "system";
  } = {
    searchEngine: "duckduckgo",
    homepage: "acute://home",
    defaultZoom: 1,
    quickLinks: [{ label: "GitHub", url: "https://github.com" }],
    linkOpeningMode: "in-app",
  };
  const browserPuts: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    resetTestState();
    browserState.linkOpeningMode = "in-app";
    browserState.searchEngine = "duckduckgo";
    browserState.homepage = "acute://home";
    browserState.defaultZoom = 1;
    browserPuts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/v1/settings/browser")) {
          if ((init?.method ?? "GET") === "PUT") {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            browserPuts.push(body);
            if (body.linkOpeningMode === "in-app" || body.linkOpeningMode === "system") {
              browserState.linkOpeningMode = body.linkOpeningMode;
            }
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ...browserState, quickLinks: [...browserState.quickLinks] }),
          } as unknown as Response;
        }
        return {
          status: 401,
          ok: false,
          text: async () =>
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no token" } }),
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("R100-A: the ENGINE LINE renders the honest platform answer (no bundled-engine era copy)", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=browser" });

    // The honest-answer note: the panel runs the OS webview, ACUTE's own UA
    // identity, never the device's BROWSER (the app-opens-links distinction).
    const note = await screen.findByTestId("browser-engine-line");
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).toContain("Engine:");
    expect(note.textContent).toContain("WebView2 (Chromium-based");
    expect(note.textContent).toContain("WebKitGTK on Linux");
    expect(note.textContent).toContain("ACUTE Browser");
    // The retired contract must NOT resurface: no "ships with the installer"
    // engine-bundling language anywhere in the tab.
    expect(document.body.textContent ?? "").not.toMatch(/Fixed Version Runtime|ships with the app/i);
  });

  it("the two cards render with the exact owner-facing copy in a LABELED group; the server's mode is the active one", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=browser" });

    const inApp = await screen.findByRole("button", { name: /In-app browser \(recommended\)/ });

    // R100-E1 (research §C2 P1(d)): the Browser tab-intro header — the
    // group-name Kicker + a 13px/600 section title (the old 16px font-black
    // h2 was the spelling the ladder retired). It renders with the loaded
    // branch, so it is pinned after the card resolves. (The nav column's own
    // group kicker carries the same "Integrations" text — no getByText here.)
    const tabIntro = screen.getByRole("heading", { level: 2, name: "Browser" });
    expect(tabIntro.className).toContain("text-[13px]");
    expect(tabIntro.className).toContain("font-semibold");
    expect(inApp.getAttribute("aria-pressed")).toBe("true");
    const system = screen.getByRole("button", { name: /System browser/ });
    expect(system.getAttribute("aria-pressed")).toBe("false");
    expect(inApp.textContent).toContain("Links open in ACUTE-CODE's built-in browser panel, beside your work.");
    expect(system.textContent).toContain("Links open in your device's default browser.");
    // The a11y contract: the pair is ONE labeled radio decision.
    expect(screen.getByRole("group", { name: "Link opening preference" })).toBeTruthy();
  });

  it("picking 'System browser' PUTs the PARTIAL patch and the LIVE push makes the router obey immediately", async () => {
    const { getLinkOpeningMode } = await import("../lib/open-link");
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=browser" });

    await screen.findByRole("button", { name: /System browser/ });
    expect(getLinkOpeningMode()).toBe("in-app"); // the fresh GET seeded the cache

    fireEvent.click(screen.getByRole("button", { name: /System browser/ }));

    await waitFor(() => {
      expect(browserPuts).toEqual([{ linkOpeningMode: "system" }]);
    });
    // The invalidation refetch lands the confirmed value in the router's
    // cache — the very next link click anywhere obeys, no restart.
    await waitFor(() => {
      expect(getLinkOpeningMode()).toBe("system");
    });
    const system = screen.getByRole("button", { name: /System browser/ });
    expect(system.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /In-app browser \(recommended\)/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("re-picking 'In-app browser' PUTs the partial patch back and the cache follows", async () => {
    const { getLinkOpeningMode } = await import("../lib/open-link");
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=browser" });

    await screen.findByRole("button", { name: /System browser/ });
    fireEvent.click(screen.getByRole("button", { name: /System browser/ }));
    await waitFor(() => {
      expect(getLinkOpeningMode()).toBe("system");
    });
    fireEvent.click(screen.getByRole("button", { name: /In-app browser \(recommended\)/ }));

    await waitFor(() => {
      expect(browserPuts).toEqual([{ linkOpeningMode: "system" }, { linkOpeningMode: "in-app" }]);
    });
    await waitFor(() => {
      expect(getLinkOpeningMode()).toBe("in-app");
    });
  });

  it("a 401 on the GET renders the honest error card (role=alert + Retry), never an eternal loader; Retry recovers", async () => {
    let failBrowserGet = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/v1/settings/browser") && !failBrowserGet) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ...browserState }),
          } as unknown as Response;
        }
        return {
          status: 401,
          ok: false,
          text: async () =>
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no token" } }),
        } as unknown as Response;
      }),
    );
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=browser" });

    expect(await screen.findByTestId("browser-settings-card")).toBeTruthy();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading browser settings" })).toBeTruthy();
    expect(screen.queryByText("In-app browser (recommended)")).toBeNull();

    // Retry re-drives the GET — the real card (with the preference) returns.
    failBrowserGet = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading browser settings" }));
    expect(await screen.findByRole("button", { name: /In-app browser \(recommended\)/ })).toBeTruthy();
  });

  it("the loading gate shows honestly while the GET is in flight (no card yet)", async () => {
    let releaseBrowser: ((r: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL) =>
          new Promise<Response>((resolve) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/v1/settings/browser")) {
              releaseBrowser = resolve;
            } else {
              resolve({
                status: 401,
                ok: false,
                text: async () => JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no token" } }),
              } as unknown as Response);
            }
          }),
      ),
    );
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=browser" });

    expect(await screen.findByText("loading browser settings…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /In-app browser \(recommended\)/ })).toBeNull();

    // TS flow-narrows releaseBrowser to null here (the assignment lives in the
    // Promise executor's closure) — the cast re-widens it to the real union.
    const release = releaseBrowser as ((r: Response) => void) | null;
    release?.({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ...browserState }),
    } as unknown as Response);
    expect(await screen.findByRole("button", { name: /In-app browser \(recommended\)/ })).toBeTruthy();
  });
});

/* ── ROUND-100 (R100-E1, research §C2 P1(a) — the VS Code pattern): the
 * settings page's OWN nav column + search box. The page hosts a left nav
 * (role=navigation "Settings navigation", 200px column at lg, horizontal
 * scroll strip below), the five group kickers render between clusters
 * (settings-group-*, moved here from the sidebar this round), the search
 * box filters the tab list by tab label + the SEARCH_KEYWORDS index
 * (case-insensitive substring), and nav clicks drive the SAME ?tab= state
 * machine the deep links have always used. */
describe("R102-C: the settings-local nav column is GONE — the app sidebar owns the settings nav", () => {
  // The owner's v0.99.0 report: "the left sidebar does not change and the
  // settings sidebar shows on the right side of the left sidebar … handle
  // it just like how it was handled previously." The R100-E1 settings-local
  // nav column (its rows, its search, its pane) is DELETED; the restored
  // sidebar settings mode carries all of it (pinned in Sidebar.test.tsx).
  // THIS page is the content pane alone — the tab machine (?tab=) is the
  // one contract that survives unchanged.
  it("renders NO local nav: no nav column, no search box, no section rows — the page is the content pane alone", () => {
    renderWithProviders(<SettingsPage />);

    expect(screen.queryByTestId("settings-nav-column")).toBeNull();
    expect(screen.queryByTestId("settings-nav-pane")).toBeNull();
    expect(screen.queryByTestId("settings-nav")).toBeNull();
    expect(screen.queryByTestId("settings-nav-search")).toBeNull();
    expect(screen.queryByTestId("settings-nav-appearance")).toBeNull();
    expect(screen.queryByTestId("settings-nav-about")).toBeNull();
    expect(document.querySelectorAll('[data-testid^="settings-group-"]')).toHaveLength(0);
    // The page header still renders (Kicker + the active tab's title).
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
  });

  it("the ?tab=browser deep link still selects the Browser tab (the URL contract is untouched)", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=browser" });

    expect(screen.getByRole("heading", { level: 1, name: "Browser" })).toBeTruthy();
    expect(await screen.findByTestId("browser-settings-card")).toBeTruthy();
  });

  it("R100-E1 ladder: the page header is the Kicker + 24px/600 title (no font-black), and the tab-intro headers are Kickers + 13px/600 section titles", () => {
    // The Advanced tab renders its intro header unconditionally (the query
    // gates live INSIDE its cards), so the file-level 401 stub suffices.
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });

    // Page header: the label-tier Kicker + the title tier (24px/600).
    const h1 = screen.getByRole("heading", { level: 1, name: "Functionality" });
    expect(h1.className).toContain("text-[24px]");
    expect(h1.className).toContain("font-semibold");
    expect(h1.className).not.toContain("font-black");

    // The tab-intro header: Kicker (the group name — the nav column's own
    // group kicker carries the same text, so no getByText here) + 13px/600
    // section title — a TAB, not a page (research §C2 P1(d)).
    const tabIntro = screen.getByRole("heading", { level: 2, name: "Functionality" });
    expect(tabIntro.className).toContain("text-[13px]");
    expect(tabIntro.className).toContain("font-semibold");

    // No font-black/font-bold anywhere on the page (the weight law).
    expect(document.body.innerHTML).not.toMatch(/font-black|font-bold/);
  });

  // R101-C's PANE test retired with the nav column itself (R102-C): the
  // pane treatment belonged to the deleted settings-local column; the
  // sidebar's restored settings mode carries the search + rows in the
  // sidebar panel's own body (pinned in Sidebar.test.tsx).
});
