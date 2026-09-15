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

    // R78: the header copy leads with the retry card (the tab is "General"
    // now — auto-retry + debug + memory), and the memory card survives.
    // R98-J: desktop notifications joined the list — the pin follows the copy.
    expect(screen.getByText(/Auto-retry, desktop notifications, debug mode, and agent memory/)).toBeTruthy();
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

// ── ROUND-78 (R78-C): the General tab + the Auto-retry card ──────────────────
// The tab's LABEL is "General" (the URL id stays "advanced" — the deep-link
// contract is load-bearing), and the RetryConfigCard (three per-failure-type
// auto-retry switches against GET/PUT /settings/retry) mounts ABOVE the
// DebugModeCard. The routed stub serves /settings/retry (mutable — PUT
// patches the state like the server) + /settings/debug + /settings/memory.
describe("General tab + Auto-retry card (ROUND-78 R78-C)", () => {
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

  it("the tab is GENERAL now (?tab=advanced unchanged): h1 General, the Auto-retry card mounts ABOVE the Debug mode card with all three switches", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=advanced" });

    // The label rename — the h1 reads the TABS entry, the URL id is untouched.
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeTruthy();
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
 * an eternal loader) is exactly what a logged-out browser should see. */
describe("Prompts tab (ROUND-98 R98-E)", () => {
  it("?tab=prompts deep-links to the Prompts tab: the h1 adapts, the tab root mounts, and the 401'd sections GET renders the honest error card + Retry", async () => {
    renderWithProviders(<SettingsPage />, { route: "/settings?tab=prompts" });

    // The header adapts to the section (h1) while the tab renders its own
    // h2; the tab's root mounts in the standard max-w column branch (the
    // form-tabs container, not the api tab's viewport-locked one).
    expect(screen.getByRole("heading", { level: 1, name: "Prompts" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Prompts" })).toBeTruthy();
    expect(screen.getByTestId("prompts-tab")).toBeTruthy();
    // The picker defaults to the FIRST registered project (the demo fixture
    // set rides getProjectsBackend) and the sections GET hits the 401 stub.
    expect(await screen.findByTestId("prompt-sections-error")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading the prompt sections" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading prompt sections" })).toBeNull();
  });
});
