// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { DashboardScreen } from "./DashboardScreen";
import { renderWithProviders, resetTestState } from "../../test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

/** The dashboard at "/" with a stub target so Quick Actions navigation is observable. */
function renderDashboard() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<DashboardScreen />} />
      <Route path="/project/:id/chat" element={<div>project chat stub</div>} />
      <Route path="/settings" element={<div>settings screen stub</div>} />
      <Route path="*" element={<div>not found</div>} />
    </Routes>,
  );
}

describe("DashboardScreen (fixture backend)", () => {
  it("renders the demo-fidelity greeting and stat cards", async () => {
    renderDashboard();

    // Greeting header (time-of-day line + accent welcome line).
    expect(
      await screen.findByText(/Workspace Overview/i),
    ).toBeTruthy();
    expect(screen.getByText(/what.s happening/i)).toBeTruthy();

    // The four stat cards (owner round-8: Projects replaces Agents here —
    // agents management lives in Settings now).
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Tokens")).toBeTruthy();
    // ROUND-83 (R83): "Requests" → "Turns" (the honest relabel).
    expect(screen.getByText("Turns")).toBeTruthy();
  });

  it("stat values come from the fixture backends", async () => {
    renderDashboard();

    // Wait for data-driven content (a session row) so the queries have
    // settled before reading the stat card values.
    await screen.findByText("Phase 2 report draft");

    // Fixtures seed exactly 2 sessions and 2 projects (Sessions/Projects
    // read "2"); usage stays empty in demo mode (no usage log) so
    // tokens/requests read zero.
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(2);
  });

  it("token chart shows the no-usage empty state while the live query is off", async () => {
    renderDashboard();

    // Demo mode disables /usage/summary — the chart must settle on the empty
    // state instead of spinning forever.
    expect(await screen.findByText("No usage recorded yet")).toBeTruthy();
  });

  it("recent activity lists the newest fixture sessions", async () => {
    renderDashboard();

    expect(await screen.findByText("Phase 2 report draft")).toBeTruthy();
    expect(screen.getByText("Audit Agents screen visuals")).toBeTruthy();
  });

  it("quick action continues in the newest project's chat — no /sessions link (R48-a)", async () => {
    renderDashboard();

    // ROUND-48: the primary quick action no longer targets /sessions (the
    // Sessions screen left the sidebar nav); it opens the newest project's
    // chat, where the composer starts the next session.
    const primary = await screen.findByRole("button", { name: /continue in /i });
    expect(primary.textContent).toContain("ACUTE-CODE"); // newest fixture project
    fireEvent.click(primary);
    expect(await screen.findByText("project chat stub")).toBeTruthy();
  });
});
