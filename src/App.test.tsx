// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { renderWithProviders, resetTestState } from "./test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

describe("App shell (owner round-8 structure)", () => {
  it("renders the app name, the Dashboard shortcut, Projects section, Usage and Settings — and NO topbar/sessions/agents nav", () => {
    resetTestState();
    renderWithProviders(<App />);

    // Brand area carries the product name.
    expect(screen.getAllByText("Acute").length).toBeGreaterThan(0);

    // Sidebar structure: Dashboard button + PROJECTS section + Usage + Settings.
    expect(screen.getByRole("button", { name: /^dashboard$/i })).toBeTruthy();
    // "Projects" appears in the sidebar section header and the dashboard stat card.
    expect(screen.getAllByText("Projects").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: /^usage$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^settings$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /add project/i })).toBeTruthy();

    // Sessions and Agents are deliberately NOT sidebar entries anymore.
    expect(screen.queryByRole("link", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Agents" })).toBeNull();

    // Index route is the live Dashboard: time-of-day greeting + quick actions.
    const greeting = screen
      .getAllByRole("heading", { level: 1 })
      .find((h) => /Good (morning|afternoon|evening|night)/.test(h.textContent ?? ""));
    expect(greeting).toBeTruthy();
    expect(screen.getByRole("button", { name: /start a session/i })).toBeTruthy();
  });

  it("routes /settings?tab=agents to the embedded Agent Registry", async () => {
    resetTestState();
    renderWithProviders(<App />, { route: "/settings?tab=agents" });

    expect(await screen.findByText("Implementer")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new agent/i })).toBeTruthy();
  });
});
