// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { renderWithProviders, resetTestState } from "./test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

describe("App shell (owner round-8 structure)", () => {
  it("renders the Dashboard shortcut, Navigation + Projects sections, Usage and Settings — and NO app name/logo/brand at the sidebar top", async () => {
    resetTestState();
    renderWithProviders(<App />);

    // Round-28 sidebar redesign: NO app name, logo, or version pill at the
    // top of the sidebar (owner directive). The product name lives in the
    // document <title> and Settings/About surfaces, not the sidebar chrome.
    expect(screen.queryByText("Acute")).toBeNull();
    expect(screen.queryByText("v0.1.0")).toBeNull();

    // Sidebar structure: NAVIGATION section header + Dashboard button + PROJECTS section + Usage + Settings.
    expect(screen.getByText("Navigation")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^dashboard$/i })).toBeTruthy();
    // R97-I part 2 re-pin: the dashboard's stat cards render only after the
    // workspace queries settle (the row is a skeleton while in flight — never
    // false zeros), so await a label that only exists once the row is real
    // before counting "Projects" (sidebar header + the stat card).
    await screen.findByText("Tokens");
    expect(screen.getAllByText("Projects").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: /^usage$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^settings$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Add project$/i })).toBeTruthy();

    // Sessions and Agents are deliberately NOT sidebar entries anymore.
    expect(screen.queryByRole("link", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Agents" })).toBeNull();

    // Index route is the live Dashboard. R113-d: the greeting header is
    // DELETED (owner: page headers are "unnecessary, unneeded, and not
    // required") — the stat cards are the page's first content, so the
    // R97-I stat labels are the route's honest proof.
    await screen.findByText("Turns");
    expect(
      screen
        .queryAllByRole("heading", { level: 1 })
        .find((h) => /Good (morning|afternoon|evening|night)/.test(h.textContent ?? "")),
    ).toBeUndefined();
  });

  it("the dashboard's primary quick action opens the newest project's chat (R48-a: no /sessions link)", async () => {
    resetTestState();
    renderWithProviders(<App />);

    // ROUND-48: the old "Start a session" quick action pointed at /sessions —
    // the screen that left the sidebar nav this round. The primary action is
    // now the workspace continuation (the projects query resolves async, so
    // the primary pill appears after the fixture loads).
    const primary = await screen.findByRole("button", { name: /continue in /i });
    expect(primary.textContent).toContain("ACUTE-CODE");
    // And the sessions link is nowhere in the sidebar chrome.
    expect(screen.queryByRole("button", { name: /^sessions$/i })).toBeNull();
  });

  it("routes /settings?tab=agents to the embedded Agent Registry", async () => {
    resetTestState();
    renderWithProviders(<App />, { route: "/settings?tab=agents" });

    expect(await screen.findByText("Implementer")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new agent/i })).toBeTruthy();
  });
});
