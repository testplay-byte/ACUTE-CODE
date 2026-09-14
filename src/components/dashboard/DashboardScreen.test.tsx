// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { DashboardScreen } from "./DashboardScreen";
import { createFixtureProjects } from "../../lib/project-fixtures";
import { getFixtureSessions } from "../../lib/session-fixtures";
import { renderWithProviders, resetTestState } from "../../test-utils";
import type { ProjectsBackend, Session, SessionsBackend } from "../../lib/api";

/** R97-I part 2: per-test overrides for the dashboard's list queries. A null
 * holder DELEGATES to the real selector (demo fixtures) — pre-existing tests
 * keep their exact behavior; the override makes a source hang/reject on
 * demand so the loading/error states are observable. */
const sessionsOverride = vi.hoisted((): { backend: SessionsBackend | null } => ({
  backend: null,
}));
const projectsOverride = vi.hoisted((): { backend: ProjectsBackend | null } => ({
  backend: null,
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    getSessionsBackend: () => sessionsOverride.backend ?? original.getSessionsBackend(),
    getProjectsBackend: () => projectsOverride.backend ?? original.getProjectsBackend(),
  };
});

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // R97-I part 2: start every test on the real fixture backends.
  sessionsOverride.backend = null;
  projectsOverride.backend = null;
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
    // R97-I part 2 re-pin: the stat row is a SKELETON until every source
    // settles (never false zeros) — await a label instead of reading it at
    // first paint (the greeting renders one commit before the queries do).
    expect(await screen.findByText("Projects")).toBeTruthy();
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
    // R97-I part 2 re-pin: the stat cards also wait on the AGENTS query (a
    // loading source keeps the whole row a skeleton) — await a stat label
    // before reading the values so the row is guaranteed rendered.
    await screen.findByText("Tokens");

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

  // ── R97-I part 2 (owner: a UI "aware of its states") ─────────────────────

  it("while a stat source is still loading the row is a SKELETON — never false zeros", async () => {
    // The sessions list never settles → one of the four stat sources stays
    // pending, so the whole row holds its shape.
    sessionsOverride.backend = {
      ...getFixtureSessions(),
      list: () => new Promise<Session[]>(() => {}),
    };
    renderDashboard();

    await waitFor(() => expect(document.querySelector("[data-stats-skeleton]")).toBeTruthy());
    expect(screen.getByLabelText("Loading workspace stats")).toBeTruthy();
    // 4 StatCard-shaped blocks in the same grid.
    expect(document.querySelectorAll("[data-stats-skeleton] .animate-pulse").length).toBe(4);
    // The stat labels are NOT painted — pre-R97 this row read false zeros
    // ("0" Projects / "0" Sessions) while the fetch was still in flight.
    expect(screen.queryByText("Tokens")).toBeNull();
    expect(screen.queryByText("Turns")).toBeNull();
  });

  it("a failed projects fetch joins the loadError banner — Retry re-drives it", async () => {
    projectsOverride.backend = {
      ...createFixtureProjects([]),
      list: () => Promise.reject(new Error("sidecar down")),
    };
    renderDashboard();

    // The banner (role=alert) now also covers the PROJECTS source, and is
    // retryable in place.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Could not load live workspace data/i)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry loading workspace data" });

    // Retry re-drives the FAILED source: flip the backend to a resolving one
    // and click — the banner clears and the real stat cards render.
    projectsOverride.backend = createFixtureProjects();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("Projects")).toBeTruthy();
  });
});
