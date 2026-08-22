// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { renderWithProviders, resetTestState } from "./test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

describe("App shell", () => {
  it("renders the app name in the topbar and all six F9 screens in the sidebar", () => {
    resetTestState();
    renderWithProviders(<App />);

    // Topbar carries the product name.
    expect(screen.getAllByText("ACUTE-CODE").length).toBeGreaterThan(0);

    // Sidebar: the six SPEC F9 screens.
    for (const label of ["Dashboard", "Project", "Agents", "Sessions", "Usage", "Settings"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }

    // Index route is the Dashboard placeholder.
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  });

  it("routes /agents to the Agent Registry", async () => {
    resetTestState();
    renderWithProviders(<App />, { route: "/agents" });

    expect(await screen.findByText("Implementer")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new agent/i })).toBeTruthy();
  });
});
