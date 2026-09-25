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
  it("renders the bold lead heading + the stat cards — the R113-d greeting hero stays GONE", async () => {
    renderDashboard();

    // R113-d (owner: the page headers are "unnecessary, unneeded, and not
    // required"): the Kicker + 24px greeting + description block is deleted —
    // nothing of it renders, and NO greeting copy ever returns.
    expect(screen.queryByText(/Workspace Overview/i)).toBeNull();
    expect(screen.queryByText(/what.s happening/i)).toBeNull();
    expect(screen.queryByText(/good (morning|afternoon|evening|night)/i)).toBeNull();

    // R127 (SCREENS §3 — THE DASHBOARD BOLDNESS LAW): the greeting tier
    // returns as a CONTENT heading, not chrome — "Workspace" at the 32px/800
    // display tier (font-extrabold, the law's 28–34px band) in the theme's
    // text ink, with ONE honest 12px secondary scope line under it. It is
    // the page's first content (always rendered — the scope line held the
    // honest "—" while the sources loaded).
    const lead = await screen.findByRole("heading", { level: 1, name: "Workspace" });
    expect(lead.className).toContain("text-[32px]");
    expect(lead.className).toContain("font-extrabold");
    expect(lead.style.color).not.toBe("");
    await waitFor(() =>
      expect(lead.parentElement?.textContent).toMatch(
        /\d+ projects? · \d+ sessions? · last 14 days/,
      ),
    );

    // The four stat cells (owner round-8: Projects replaces Agents here —
    // agents management lives in Settings now), now UNDER the lead heading.
    // R97-I part 2 re-pin: the stat row is a SKELETON until every source
    // settles (never false zeros) — await a label instead of reading it at
    // first paint.
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
    // R126-3a (COMPONENTS §4): the primary is the QUIET-SOLID clay species —
    // accentDeep fill + accentText ink, no glow/gradients — and it is the
    // screen's ONE filled action (the secondaries ride the outlined species).
    // R126 re-pin: the ink assertion moved from the class list to the inline
    // color — `text-accent-text` was a PHANTOM utility (the @theme leg never
    // gained --color-accent-text, so the class painted no ink and the label
    // silently inherited the ambient text color on the ember fill); the JS
    // leg `styles.accentText` is TOKENS §1d's documented spelling for the
    // pair, so the pin now proves the inline ink actually painted.
    expect(primary.className).toContain("bg-accent-deep");
    expect(primary.style.color).not.toBe("");
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
    // R126-3a (SCREENS §3 — the one-card stat row): the skeleton mirrors the
    // READY shape — ONE h-[92px] card-shaped block, not four separate cards
    // (the anti-jitter mirror law; pre-R126 it was 4 StatCard blocks).
    expect(document.querySelectorAll("[data-stats-skeleton] .animate-pulse").length).toBe(1);
    // The stat labels are NOT painted — pre-R97 this row read false zeros
    // ("0" Projects / "0" Sessions) while the fetch was still in flight.
    expect(screen.queryByText("Tokens")).toBeNull();
    expect(screen.queryByText("Turns")).toBeNull();
  });

  it("R126: the stat row is ONE clay card with four inset-divided cells — no icon chips, no accent fill", async () => {
    renderDashboard();

    const row = await screen.findByTestId("dashboard-stat-row");
    // The clay material (COMPONENTS §3 / TOKENS §5+§9): card surface + the
    // warm rim hairline + the .ac-clay two-leg shadow — and NEVER the solid
    // accent fill the VLM flagged as an anomaly (the highlight is ink-only).
    expect(row.className).toContain("ac-clay");
    expect(row.className).toContain("border-clay-rim");
    expect(row.className).not.toContain("bg-accent");
    // Four cells, counted by child iteration (the mobile stat-grid law) —
    // and NO icon chips anywhere in the row (the mobile law: stat grids
    // carry no icon chips; the icon tiles retired with the redesign).
    const cells = Array.from(row.children);
    expect(cells).toHaveLength(4);
    expect(row.querySelectorAll("svg").length).toBe(0);
    // The 1px inset dividers: the first three cells carry the trailing
    // border (cell 2's only at md — the 4-across tier), the last never.
    expect(cells.filter((c) => c.className.includes("border-r")).length).toBe(3);
    expect(cells[3].className.includes("border-r")).toBe(false);
    // The Tokens cell is the highlight: kicker + value in accentDeep ink
    // (TOKENS §1d — accent-as-text, INK-ONLY), the value on the R127 display
    // tier — 26px/700 tabular (SCREENS §3: "the stat row's numbers at display
    // weight"; re-pinned from the R126 22px/600 this wave). The pin: the
    // highlight value's ink differs from a plain cell's (accentDeep vs text)
    // while the card itself never fills.
    const tokensCell = cells.find((c) => c.textContent?.includes("Tokens")) as HTMLElement;
    const projectsCell = cells.find((c) => c.textContent?.includes("Projects")) as HTMLElement;
    const value = tokensCell.querySelector('[class*="tabular-nums"]') as HTMLElement;
    const plainValue = projectsCell.querySelector('[class*="tabular-nums"]') as HTMLElement;
    expect(value.className).toContain("text-[26px]");
    expect(value.className).toContain("font-bold");
    expect(value.style.color).not.toBe("");
    expect(value.style.color).not.toBe(plainValue.style.color);
  });

  it("R126: session status rides the badge tone containers (TOKENS §11)", async () => {
    renderDashboard();

    // The fixture seeds a RUNNING session ("Phase 2 report draft") and a
    // COMPLETED one — the statuses paint as tinted badge containers, never
    // flat-hue text.
    const running = await screen.findByText("running");
    expect(running.className).toContain("bg-badge-running");
    expect(running.className).toContain("text-badge-running-fg");
    const completed = screen.getByText("completed");
    expect(completed.className).toContain("bg-badge-success");
    expect(completed.className).toContain("text-badge-success-fg");
  });

  it("R127: recent activity reads as a TIMELINE — the spine, day dividers, and node glyphs", async () => {
    renderDashboard();

    expect(await screen.findByText("Phase 2 report draft")).toBeTruthy();

    // SCREENS §3 (THE DASHBOARD BOLDNESS LAW): the sessions list inside the
    // section card hangs off ONE vertical spine. The fixture's two newest
    // sessions fall on two distinct UTC days (2026-08-22 + 2026-08-21), so
    // the timeline renders two day-divider groups (the label text is
    // now-relative — TODAY/YESTERDAY/short date — so the pin counts groups,
    // never the literal label), each row carrying its node glyph on the
    // spine (accentDeep for TODAY's rows, clay-rim otherwise).
    expect(document.querySelectorAll("[data-timeline-spine]")).toHaveLength(1);
    const dividers = document.querySelectorAll("[data-timeline-day]");
    expect(dividers).toHaveLength(2);
    const nodes = document.querySelectorAll("[data-timeline-node]");
    expect(nodes).toHaveLength(2);
    // Every node is a round glyph sitting at the spine's x (left-0 on the
    // pl-6 row wrapper).
    for (const node of Array.from(nodes)) {
      expect(node.className).toContain("rounded-full");
      expect((node as HTMLElement).style.backgroundColor).not.toBe("");
    }
    // The row contract survives the restructure: the open-session aria is
    // the R126 spelling verbatim.
    expect(
      screen.getByRole("button", { name: "Open session Phase 2 report draft" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open session Audit Agents screen visuals" })).toBeTruthy();
  });

  it("a failed projects fetch joins the loadError banner — Retry re-drives it", async () => {
    projectsOverride.backend = {
      ...createFixtureProjects([]),
      list: () => Promise.reject(new Error("sidecar down")),
    };
    renderDashboard();

    // The banner (role=alert) now also covers the PROJECTS source, and is
    // retryable in place. R126-3a (TOKENS §11): the banner is the danger
    // badge-tone container (tinted fill + deep-on-tint ink — never the
    // flat-hue-on-alpha-wash idiom), and the Retry button is the outlined
    // danger species (COMPONENTS §4).
    const banner = await screen.findByRole("alert");
    expect(banner.className).toContain("bg-badge-danger");
    expect(banner.className).toContain("text-badge-danger-fg");
    expect(screen.getByText(/Could not load live workspace data/i)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry loading workspace data" });
    expect(retry.className).toContain("border-danger-deep");
    expect(retry.className).toContain("text-danger-deep");

    // Retry re-drives the FAILED source: flip the backend to a resolving one
    // and click — the banner clears and the real stat cards render.
    projectsOverride.backend = createFixtureProjects();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("Projects")).toBeTruthy();
  });
});
