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
 * The api tab's queries ride a deterministic 401-stubbed fetch (retry is
 * off in the test QueryClient) — the page still renders its layout and the
 * empty provider list, which is all these assertions need.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";
import { resetTestState, renderWithProviders } from "../test-utils";

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
