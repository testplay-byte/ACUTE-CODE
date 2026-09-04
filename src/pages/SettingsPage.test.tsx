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
    fireEvent.click(screen.getByRole("button", { name: /Hidden/ }));
    expect(useThemeStore.getState().activityMode).toBe("hidden");
  });

  it("the Sidebar Tint section is GONE from the UI (store field untouched)", () => {
    renderWithProviders(<SettingsPage />);

    expect(screen.queryByText("Sidebar Tint")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Sidebar tint strength" })).toBeNull();
    expect(screen.queryByRole("radio", { name: /sidebar tint/i })).toBeNull();

    // The tab is exactly THREE sections now: Theme, Chat density, Tool activity.
    expect(document.querySelectorAll("section").length).toBe(3);

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

    // The header copy leads with Debug mode, and the memory card survives.
    expect(screen.getByText(/Debug mode \+ agent memory/)).toBeTruthy();
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
