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
      <Route path="/sessions" element={<div>sessions screen stub</div>} />
      <Route path="/agents" element={<div>agents screen stub</div>} />
      <Route path="*" element={<div>not found</div>} />
    </Routes>,
  );
}

describe("DashboardScreen (fixture backend)", () => {
  it("renders the demo-fidelity greeting and stat cards", async () => {
    renderDashboard();

    // Greeting header (time-of-day line + accent welcome line).
    expect(
      await screen.findByText(/Good (morning|afternoon|evening|night)/),
    ).toBeTruthy();
    expect(screen.getByText(/Welcome back to/)).toBeTruthy();

    // All four SPEC F7 stat cards.
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Tokens Used")).toBeTruthy();
    expect(screen.getByText("API Requests")).toBeTruthy();
    expect(screen.getByText("Agents")).toBeTruthy();
  });

  it("stat values come from the fixture backends", async () => {
    renderDashboard();

    // Wait for data-driven content (a session row + an agent name) so both
    // queries have settled before reading the stat card values.
    await screen.findByText("Phase 2 report draft");
    await screen.findByText("Scribe");

    // Fixtures seed exactly 2 sessions and 2 non-template agents (both stat
    // cards read "2"); usage stays empty in demo mode (no usage log), so
    // tokens/requests show zero.
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(2);
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

  it("quick action navigates to the sessions screen", async () => {
    renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: "Start a session" }));
    expect(await screen.findByText("sessions screen stub")).toBeTruthy();
  });
});
