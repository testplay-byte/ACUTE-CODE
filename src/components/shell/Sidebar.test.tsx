// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { deriveSessionRowState, Sidebar } from "./Sidebar";
import { ProjectView } from "../projects/ProjectView";
import { createFixtureProjects, getFixtureProjects } from "../../lib/project-fixtures";
import { getFixtureSessions } from "../../lib/session-fixtures";
import { useActiveStreams } from "../../lib/active-streams";
import { useProjectChatStore } from "../../lib/project-chat-store";
// R99-C: the update-pending signal — the Settings dot's store.
import { useUpdateCheckerStore } from "../../lib/update-checker";
// R128-W3: the honest-degradation toast leg's assertion surface (the
// General-workspace-unavailable local toast lands in this store).
import { useNotificationStreamStore } from "../../hooks/use-notifications";
import { ApiError } from "../../lib/api";
import type { Project, ProjectsBackend, Session, SessionsBackend } from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";

/** R97-I part 2: per-test overrides for the sidebar's two list queries. A
 * null holder DELEGATES to the real selector (demo fixtures), so every
 * pre-existing test in this file keeps its exact behavior — the override is
 * only installed to make a query hang/reject/recover on demand. */
const projectsOverride = vi.hoisted((): { backend: ProjectsBackend | null } => ({
  backend: null,
}));
const sessionsOverride = vi.hoisted((): { backend: SessionsBackend | null } => ({
  backend: null,
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    getProjectsBackend: () => projectsOverride.backend ?? original.getProjectsBackend(),
    getSessionsBackend: () => sessionsOverride.backend ?? original.getSessionsBackend(),
  };
});

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  // demoData defaults true → the sidebar reads the fixture ProjectsBackend
  // (re-seeded here: ACUTE-CODE + marketing-site).
  resetTestState();
  // R97-I part 2: start every test on the real fixture backends.
  projectsOverride.backend = null;
  sessionsOverride.backend = null;
});

describe("Sidebar projects section (fixture ProjectsBackend)", () => {
  it("creates a project through the Add Project dialog and navigates to its chat", async () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
    );
    // Sidebar is hidden below md but present in DOM; the dialog is portal-free.
    fireEvent.click(screen.getAllByRole("button", { name: /^Add project$/i, hidden: true })[0]);
    expect(await screen.findByText("Add New Project")).toBeTruthy();
    // ROUND-33: no name field — the project takes the FOLDER's name.
    fireEvent.change(await screen.findByPlaceholderText(/path|folder|project/i), {
      target: { value: "~/projects/acute-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create project/i, hidden: true }));

    // Creating a project navigates straight to its chat screen.
    expect(await screen.findByText("chat stub")).toBeTruthy();

    // The fixture backend persisted exactly the created project on top of the
    // seeds, with a backend id, a palette color — and the NAME derived from
    // the folder basename (owner round-33).
    const projects = await getFixtureProjects().list();
    const created = projects.find((p) => p.rootPath === "~/projects/acute-code");
    expect(created?.name).toBe("acute-code");
    expect(created?.id).toMatch(/^prj_/);
    expect(created?.color).toMatch(/^#/);
  });

  it("R128-W3 (SCREENS §2 law #8): deleting a project rides the danger confirm — cancel keeps it, confirm removes it", async () => {
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    // Fixture seeds include marketing-site (plus the General entry — which
    // never gets a delete affordance); deleting it now ASKS first.
    expect(await screen.findByText("marketing-site")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete marketing-site", hidden: true }),
    );

    // The shared danger dialog appears (cancel takes focus — the R95-A
    // contract); CANCEL keeps the project exactly where it was.
    expect(await screen.findByTestId("confirm-dialog")).toBeTruthy();
    expect(screen.getByText("Delete project?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect(screen.getByText("marketing-site")).toBeTruthy();
    expect((await getFixtureProjects().list()).some((p) => p.name === "marketing-site")).toBe(true);

    // CONFIRM deletes — the row and the backend entry are gone.
    fireEvent.click(
      screen.getByRole("button", { name: "Delete marketing-site", hidden: true }),
    );
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(screen.queryByText("marketing-site")).toBeNull());
    const remaining = await getFixtureProjects().list();
    expect(remaining.some((p) => p.name === "marketing-site")).toBe(false);
    // No dialog lingers after the confirm.
    await waitFor(() => expect(container.querySelector("[data-testid='confirm-dialog']")).toBeNull());
  });

  it("R128-W3 (law #8): the project dialog enumerates the project name + its live session count", async () => {
    const backend = getFixtureSessions();
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: "prj_seed_site", title: "Site audit" });
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: "prj_seed_site", title: "Copy pass" });
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    expect(await screen.findByText("marketing-site")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete marketing-site", hidden: true }),
    );
    // The blast radius is enumerated: the project's name + its session
    // count (from the sessions query data) + what dies with them.
    expect(await screen.findByTestId("confirm-dialog")).toBeTruthy();
    expect(
      screen.getByText(/Delete "marketing-site" and its 2 sessions\? Their messages and tool history will be permanently removed\./),
    ).toBeTruthy();
    // Cancel — the enumeration is an ask, never a side effect.
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect((await getFixtureSessions().list()).filter((s) => s.projectId === "prj_seed_site")).toHaveLength(2);
  });

  it("shows the ApiError message inline when the backend rejects a duplicate root path", async () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /^Add project$/i, hidden: true })[0]);
    expect(await screen.findByText("Add New Project")).toBeTruthy();
    // The seeded fixture already uses this rootPath (409 CONFLICT).
    fireEvent.change(await screen.findByPlaceholderText(/path|folder|project/i), {
      target: { value: "/home/dev/ACUTE-CODE" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create project/i, hidden: true }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByText(/a project already uses the folder \/home\/dev\/ACUTE-CODE/),
    ).toBeTruthy();
    // The modal stays open so the path can be fixed.
    expect(screen.getByText("Add New Project")).toBeTruthy();
  });

  it("sidebar exposes Dashboard/Usage/Settings but no Sessions or Agents nav", () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    expect(screen.getByRole("button", { name: /^dashboard$/i, hidden: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^usage$/i, hidden: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^settings$/i, hidden: true })).toBeTruthy();
    // ROUND-48 (owner: "remove the sessions section completely as it is not
    // needed"): the Sessions nav entry is GONE from the sidebar. The
    // /sessions route + SessionsScreen stay for deep links — only the nav
    // row was removed.
    expect(screen.queryByRole("button", { name: /^sessions$/i, hidden: true })).toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(screen.queryByText("Agents")).toBeNull();
  });

  it("R99-C: the Settings entry carries the update-pending dot while a newer release waits (full panel + the minimized rail)", async () => {
    // No pending update → no dot, no sr-only announcement (the resting nav).
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    expect(screen.queryByTestId("settings-update-dot")).toBeNull();
    expect(screen.queryByText("update available")).toBeNull();

    // A pending update (the update-checker store the auto-check + the
    // About tab sync) → the accent dot + the sr-only reading on the full
    // panel's SettingsButton — the zustand subscription re-renders the
    // entry in place, no remount needed.
    useUpdateCheckerStore.setState({ pendingVersion: "0.99.0" });
    await waitFor(() => {
      expect(screen.getByTestId("settings-update-dot")).toBeTruthy();
    });
    expect(screen.getAllByText("update available").length).toBeGreaterThan(0);

    // …and the minimized rail's gear (the same signal, minimized form).
    useProjectChatStore.setState({ appSidebarMinimized: true });
    await screen.findByTestId("sidebar-rail");
    await waitFor(() => {
      expect(screen.getByTestId("rail-settings").querySelector('[data-testid="settings-update-dot"]')).toBeTruthy();
    });

    // The update lands (the boot self-heal clears the flag) → the dot is gone.
    useUpdateCheckerStore.setState({ pendingVersion: null });
    await waitFor(() => {
      expect(screen.queryByTestId("settings-update-dot")).toBeNull();
    });
  });

  it("R62: the MINIMIZE button lives at the very top; clicking swaps the panel to its 64px icon rail; the rail's top button restores", async () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    // ROUND-62 (owner: "option at the very top to minimize it"): the full
    // panel's first row is the minimize control. (The R60-C
    // expanded-only test is REVERSED by this directive — the old
    // collapse rail was removed because it was redundant with the
    // title-bar hide; minimize is a DIFFERENT, gentler state and lives
    // on a persisted store flag.)
    expect(screen.getByTestId("sidebar-minimize")).toBeTruthy();
    expect(screen.getByText("Navigation")).toBeTruthy();
    // Before minimizing: labels visible, no rail.
    expect(screen.queryByTestId("sidebar-rail")).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-minimize"));

    // Rail state: minimize button + labels are gone, the rail body is
    // present with the restore button at its very top.
    expect(await screen.findByTestId("sidebar-rail")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-minimize")).toBeNull();
    expect(screen.queryByText("Navigation")).toBeNull();
    expect(screen.getByTestId("sidebar-expand")).toBeTruthy();
    expect(screen.getByTestId("rail-dashboard")).toBeTruthy();
    expect(screen.getByTestId("rail-usage")).toBeTruthy();
    expect(screen.getByTestId("rail-settings")).toBeTruthy();
    // The store flag flipped (persisted via the project-chat store).
    expect(useProjectChatStore.getState().appSidebarMinimized).toBe(true);

    // Restore → the full panel (labels + minimize) comes back.
    fireEvent.click(screen.getByTestId("sidebar-expand"));
    expect(await screen.findByText("Navigation")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-rail")).toBeNull();
    expect(useProjectChatStore.getState().appSidebarMinimized).toBe(false);
  });

  it("R62 + R128-W3 (SCREENS §2 law #2): the minimized rail's project tile EXPANDS the sidebar + toggles its session tree — WITHOUT navigating; gear opens settings", async () => {
    // Seed a minimized store BEFORE mount (the persisted-restart path).
    useProjectChatStore.setState({ appSidebarMinimized: true });
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
    );
    const rail = await screen.findByTestId("sidebar-rail");
    expect(rail).toBeTruthy();
    // Fixture projects render as tiles (General pinned first, then the
    // seeds); the tile's click now EXPANDS + TOGGLES instead of navigating.
    const tile = await screen.findByRole("button", { name: /^show marketing-site sessions$/i, hidden: true });
    fireEvent.click(tile);
    // The sidebar expanded (the rail is gone, the full panel is back)...
    expect(await screen.findByText("Navigation")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-rail")).toBeNull();
    expect(useProjectChatStore.getState().appSidebarMinimized).toBe(false);
    // ...the URL did NOT move (the dashboard stub is still the rendered
    // route — a rail tile no longer teleports into a chat)...
    expect(screen.getByText("dashboard stub")).toBeTruthy();
    expect(screen.queryByText("chat stub")).toBeNull();
    // ...and the project's session well OPENED (the tree toggled with the
    // expand — the same expanded-projects state the full panel renders).
    await waitFor(() => {
      expect(container.querySelector("[data-session-well]")).toBeTruthy();
    });
    // Reset for the next assertion path: re-minimize, then gear → settings
    // (the rail's own navigation entries keep navigating).
    act(() => useProjectChatStore.setState({ appSidebarMinimized: true }));
    expect(await screen.findByTestId("sidebar-rail")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rail-settings"));
    expect(await screen.findByText("settings stub")).toBeTruthy();
  });

  // R102-C (owner v0.99.0: "the left sidebar does not change and the
  // settings sidebar shows on the right side of the left sidebar … handle
  // it just like how it was handled previously"): the ROUND-34 settings
  // mode is RESTORED — on /settings the sidebar's whole body becomes the
  // settings nav (back pill + search + the grouped section list) and the
  // settings page renders the content pane ALONE (its own nav column is
  // deleted — the doubled sidebar was the defect).
  it("R102-C: on a settings route the sidebar becomes the SETTINGS NAV — back pill + search + the section list; the normal nav is gone", () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
      { route: "/settings?tab=appearance" },
    );
    // The settings-mode chrome: the back pill, the search box, the section
    // rows, and the minimize control (mode-agnostic, R62).
    expect(screen.getByTestId("sidebar-back-dashboard")).toBeTruthy();
    expect(screen.getByTestId("settings-nav-search")).toBeTruthy();
    expect(screen.getByTestId("sidebar-minimize")).toBeTruthy();
    expect(screen.getByTestId("settings-nav-appearance")).toBeTruthy();
    expect(screen.getByTestId("settings-nav-about")).toBeTruthy();
    // The NORMAL nav is gone — no Navigation heading, no Dashboard row, no
    // projects section (the doubled sidebar was the defect).
    expect(screen.queryByText("Navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: /^dashboard$/i, hidden: true })).toBeNull();
    expect(screen.queryByTestId("rail-projects")).toBeNull();
  });

  // R95-A (the owner: "The left sidebar does have a Back to Dashboard button
  // but it is not proper…"): RESTORED R102-C — the settings-mode back
  // pill is the ONE back-to-dashboard affordance on settings routes.
  it("R95-A (restored R102-C): the settings-mode back pill navigates home — the affordance it owns", async () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
      { route: "/settings?tab=api" },
    );
    fireEvent.click(screen.getByTestId("sidebar-back-dashboard"));
    expect(await screen.findByText("dashboard stub")).toBeTruthy();
  });

  // R66 (B4, owner report: "when I minimize the settings sidebar, it shows
  // me the wrong sidebar — the normal other sidebar with the projects and
  // such"): RESTORED R102-C — the rail's SETTINGS VARIANT: back-to-dashboard
  // + the per-tab settings icons; the projects tiles NEVER render on a
  // settings route.
  it("R66 (B4, restored R102-C): minimizing ON A SETTINGS ROUTE shows the SETTINGS rail — back + per-tab icons, no projects", async () => {
    useProjectChatStore.setState({ appSidebarMinimized: true });
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
      { route: "/settings?tab=vision" },
    );
    const rail = await screen.findByTestId("sidebar-rail");
    expect(rail).toBeTruthy();
    // The SETTINGS rail body — the back button + the per-tab icons with
    // the active section selected by ?tab=.
    expect(screen.getByTestId("rail-back-dashboard")).toBeTruthy();
    expect(screen.getByTestId("rail-settings-vision").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("rail-settings-appearance").getAttribute("aria-current")).toBeNull();
    // The projects tiles are NOT on the settings rail (the R66 report).
    expect(screen.queryByTestId("rail-projects")).toBeNull();
    expect(screen.queryByTestId("rail-dashboard")).toBeNull();
    // Back-to-dashboard from the rail returns home.
    fireEvent.click(screen.getByTestId("rail-back-dashboard"));
    expect(await screen.findByText("dashboard stub")).toBeTruthy();
  });

  // R98-E1: RESTORED R102-C — the sidebar's settings nav carries the
  // per-tab entries (Prompts included) and drives the ?tab= machine.
  it("R98-E1 (restored R102-C): the settings nav carries the Prompts entry — clicking it writes ?tab=prompts (deep links keep working)", async () => {
    function SearchProbe() {
      const { search } = useLocation();
      return <div data-testid="search-probe">{search}</div>;
    }
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/settings" element={<SearchProbe />} />
        </Routes>
      </>,
      { route: "/settings?tab=appearance" },
    );

    // The per-tab settings entries render in the sidebar's settings nav.
    expect(screen.getByRole("button", { name: /^prompts$/i, hidden: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^models & providers$/i, hidden: true })).toBeTruthy();

    // Clicking one drives the SAME tab state machine (the URL param flips).
    fireEvent.click(screen.getByTestId("settings-nav-prompts"));
    await waitFor(() => {
      expect(screen.getByTestId("search-probe").textContent).toContain("tab=prompts");
    });
  });

  // R98-I1 (owner: "separate the different side options into different
  // categories"): RESTORED R102-C — the five group headers render in the
  // SIDEBAR's settings nav (they moved here with the restored mode; the
  // settings page's own nav column is deleted).
  it("R98-I1 (restored R102-C): the five group headers render in the sidebar's settings nav — one kicker per cluster", () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
      { route: "/settings?tab=appearance" },
    );

    expect(document.querySelectorAll('[data-testid^="settings-group-"]')).toHaveLength(5);
    for (const group of [
      "Workspace",
      "Agents & Skills",
      "Integrations",
      "Data & Statistics",
      "System",
    ]) {
      expect(document.querySelectorAll(`[data-testid="settings-group-${group}"]`)).toHaveLength(1);
    }
    // The dashed "more coming" slot stays retired (the R100-E1 cleanup).
    expect(screen.queryByText("More settings coming soon")).toBeNull();
  });

  // R100-E1 → R102-C: the settings SEARCH lives in the sidebar's settings
  // nav now (moved from the retired settings-local nav column — the same
  // VS Code pattern, the same keyword index, the same honest empty note).
  it("R102-C: the settings-nav search filters the section list — label matches, keyword matches, and the honest empty note", () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
      { route: "/settings?tab=appearance" },
    );

    const search = screen.getByTestId("settings-nav-search") as HTMLInputElement;
    expect(search.getAttribute("aria-label")).toBe("Search settings");

    // 'provider' matches the Models & Providers label + Vision's keywords.
    fireEvent.change(search, { target: { value: "provider" } });
    expect(screen.getByTestId("settings-nav-api")).toBeTruthy();
    expect(screen.getByTestId("settings-nav-vision")).toBeTruthy();
    expect(screen.queryByTestId("settings-nav-appearance")).toBeNull();

    // 'api key' rides the per-tab keyword lists.
    fireEvent.change(search, { target: { value: "api key" } });
    expect(screen.getByTestId("settings-nav-subagents")).toBeTruthy();
    expect(screen.getByTestId("settings-nav-api")).toBeTruthy();
    expect(screen.queryByTestId("settings-nav-browser")).toBeNull();

    // Nonsense → the honest empty note, never a blank nav.
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByTestId("settings-nav-empty").textContent).toBe("No settings match");

    // Clearing restores the full list.
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByTestId("settings-nav-appearance")).toBeTruthy();
    expect(screen.queryByTestId("settings-nav-empty")).toBeNull();
  });

  it("R60-C: normal mode has no header row — the nav starts at the panel's top", () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    expect(screen.queryByRole("button", { name: "Back to dashboard", hidden: true })).toBeNull();
    expect(screen.getByText("Navigation")).toBeTruthy();
  });

  it("R60-C: the sidebar renders on chat routes regardless of appSidebarVisible (AppShell owns the mount)", () => {
    // The store flag no longer early-returns inside Sidebar — AppShell's
    // showSidebar gate (the title-bar toggle's state) mounts/unmounts the
    // whole component instead.
    useProjectChatStore.setState({ appSidebarVisible: false });
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
      { route: "/project/prj_x/chat" },
    );
    expect(screen.getByRole("button", { name: /^dashboard$/i, hidden: true })).toBeTruthy();
    expect(screen.getByText("Navigation")).toBeTruthy();
  });

  it("ProjectView shows a not-found state for an unknown id", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/project/:id" element={<ProjectView />} />
      </Routes>,
      { route: "/project/p-missing" },
    );
    expect(await screen.findByText("Project not found")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Back to dashboard")).toBeTruthy());
    // R126 (SCREENS §3, the mobile empty-state law): the not-found state is
    // the minimal-center shape — ONE icon tile (the accentTint icon-chip
    // grammar) + one line + ONE action; "Back to dashboard" is the only
    // button on the screen.
    const tile = document.querySelector("[data-project-empty-tile]");
    expect(tile?.className).toContain("bg-accent-tint");
    expect(screen.queryAllByRole("button")).toHaveLength(1);
  });
});

/* ── R101-C (owner v0.98.0: the minimized rail "was apparently not handled
 * properly. It was not looking pro-good"): the rail-polish round — styled
 * hover/focus label chips (RailLabel), the active accent bar on rail nav,
 * and the +N projects-overflow affordance. */
describe("Sidebar minimized rail polish (R101-C)", () => {
  /** Render the rail minimized on "/" with the minimal route stubs. */
  function renderMinimizedRail() {
    useProjectChatStore.setState({ appSidebarMinimized: true });
    return renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
  }

  it("R101-C: every rail button renders its styled hover/focus label chip — the affordance the bare rail lacked", async () => {
    renderMinimizedRail();
    await screen.findByTestId("sidebar-rail");

    // The chips render INSIDE their buttons carrying the full label text
    // (the native title tooltips stay, but the VISIBLE chip is the new
    // affordance): CSS-only reveal on group-hover / keyboard focus.
    const chipIn = (text: string) => {
      const chip = screen.getByText(text);
      expect(chip.getAttribute("data-testid")).toBe("rail-label");
      expect(chip.className).toContain("group-hover:opacity-100");
      expect(chip.className).toContain("group-focus-visible:opacity-100");
      expect(chip.className).toContain("opacity-0");
      return chip;
    };
    expect(chipIn("Expand sidebar").closest("button")?.getAttribute("data-testid")).toBe("sidebar-expand");
    expect(chipIn("Dashboard").closest("button")?.getAttribute("data-testid")).toBe("rail-dashboard");
    expect(chipIn("Usage").closest("button")?.getAttribute("data-testid")).toBe("rail-usage");
    expect(chipIn("Settings").closest("button")?.getAttribute("data-testid")).toBe("rail-settings");
    // The project tile's chip carries the FULL untruncated project name —
    // the whole point of the chip (color identity alone was not enough).
    // R128-W3: the tile's aria-label is the new toggle contract ("Show <name>
    // sessions" — expand + toggle, never navigate).
    const projectChip = await screen.findByText("marketing-site");
    expect(projectChip.closest("button")?.getAttribute("aria-label")).toBe(
      "Show marketing-site sessions",
    );
    // The bell keeps its own button; its chip rides the group WRAPPER
    // (group-focus-within covers the bell's keyboard focus through it).
    const bellChip = chipIn("Notifications");
    expect(bellChip.parentElement?.querySelector("[data-notification-bell-button]")).toBeTruthy();
  });

  it("R101-C: the ACTIVE rail nav button carries the 2px leading accent bar (the full NavButton's selection grammar)", async () => {
    renderMinimizedRail();
    await screen.findByTestId("sidebar-rail");

    // "/" is active → the rail's Dashboard button keeps the selection
    // container AND gains the leading accent bar; the resting Usage button
    // has neither bar. R126 re-pin: the selection grammar moved to the Clay
    // Companion spelling — the accent TINT container (bg-accent-tint) + the
    // DEEP accent ink (text-accent-deep) + the 2px accentDeep bar
    // (bg-accent-deep) — TOKENS §1d/§10; the CONTRACT (active row visibly
    // selected + the 2px marker) is what stays pinned.
    const dashboard = screen.getByTestId("rail-dashboard");
    expect(dashboard.className).toContain("bg-accent-tint");
    expect(dashboard.className).toContain("text-accent-deep");
    const bar = dashboard.querySelector(".bg-accent-deep");
    expect(bar).toBeTruthy();
    expect(bar?.className).toContain("w-0.5");
    expect(screen.getByTestId("rail-usage").querySelector(".bg-accent-deep")).toBeNull();
  });

  it("R101-C: >10 projects renders the +N overflow tile; clicking it EXPANDS the sidebar without navigating", async () => {
    // 3 seeds (incl. the R128-W3 General entry) + 10 created = 13 projects
    // → 10 rail tiles + a "+3" tile.
    const backend = getFixtureProjects();
    for (let i = 0; i < 10; i += 1) {
      await backend.create(`extra-${i}`, `/tmp/extra-${i}`);
    }
    renderMinimizedRail();
    await screen.findByTestId("sidebar-rail");

    // The cap stays 10 tiles — never a silent cut.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /^show /i, hidden: true })).toHaveLength(10);
    });
    const overflow = await screen.findByTestId("rail-projects-overflow");
    expect(overflow.textContent).toContain("+3");
    expect(overflow.getAttribute("aria-label")).toBe("3 more projects — expand to see all");
    // The chip carries the same honest copy.
    expect(overflow.querySelector('[data-testid="rail-label"]')?.textContent).toBe(
      "3 more projects — expand to see all",
    );

    // Click → the sidebar EXPANDS (the R87-A1 expand-first pattern) and the
    // URL does NOT move — expanding, not navigating, is the honest behavior.
    fireEvent.click(overflow);
    expect(await screen.findByText("Navigation")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-rail")).toBeNull();
    expect(useProjectChatStore.getState().appSidebarMinimized).toBe(false);
    expect(screen.getByText("dashboard stub")).toBeTruthy();
  });

  it("R101-C: ≤10 projects renders NO overflow tile (the affordance appears only when the cap bites)", async () => {
    renderMinimizedRail();
    await screen.findByTestId("sidebar-rail");
    // 3 fixture projects (the two seeds + the General entry) → 3 tiles, no
    // overflow tile.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /^show /i, hidden: true })).toHaveLength(3);
    });
    expect(screen.queryByTestId("rail-projects-overflow")).toBeNull();
  });
});

describe("Sidebar session rows (R43 depth pass: border + state-aware icons)", () => {
  it("gives every session row a dedicated border — accent on the active row, hairline at rest", async () => {
    const [project] = await getFixtureProjects().list();
    const backend = getFixtureSessions();
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: project.id, title: "Fix login flow" });
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: project.id, title: "Audit deps" });
    const sessions = (await backend.list()).filter((s) => s.projectId === project.id);
    const activeId = sessions.find((s) => s.title === "Fix login flow")?.id;
    expect(activeId).toBeTruthy();

    // The ?session= route auto-expands the project + marks the matching row.
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
      { route: `/project/${project.id}/chat?session=${activeId}` },
    );

    await waitFor(() => {
      expect(container.querySelectorAll("[data-session-row]").length).toBe(2);
    });
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-session-row]"));
    // Every row carries a border + depth (the owner's dedicated-border ask).
    // R100-F re-pin: the border moved to the CSS-class leg (border +
    // border-[color:var(--ac-border-subtle)] — the utility spelling) with
    // the inline leg reserved for the ACTIVE/FAILED dynamic tints; the
    // boxShadow depth idiom moved the same way. The CONTRACT (dedicated
    // border on every row) is what's pinned, not the leg it rides on.
    for (const row of rows) {
      expect(row.className).toContain("border");
    }
    // The dynamic tints still ride the inline leg where they're computed.
    const activeRow0 = rows.find((r) => r.dataset.active === "true");
    expect(activeRow0?.style.borderColor).not.toBe("");
    // Active row is clearly identifiable: data-active + the accent indicator bar.
    const activeRow = rows.find((r) => r.dataset.active === "true");
    expect(activeRow).toBeTruthy();
    expect(activeRow?.dataset.state).toBe("idle");
    // Rest rows: idle chat-bubble state.
    expect(rows.some((r) => r.dataset.state === "idle" && r.dataset.active === "false")).toBe(true);
  });

  it("a streaming session flips its row to the running state with the live icon + pixel-stream", async () => {
    const [project] = await getFixtureProjects().list();
    const backend = getFixtureSessions();
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: project.id, title: "Live run" });
    const [session] = (await backend.list()).filter((s) => s.projectId === project.id);

    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
      { route: `/project/${project.id}/chat?session=${session.id}` },
    );

    // The AgentChatPanel marks streams through this store — simulate it.
    useActiveStreams.setState({ active: new Set([session.id]) });
    await waitFor(() => {
      const row = container.querySelector<HTMLElement>(`[data-session-row][data-state="running"]`);
      expect(row).toBeTruthy();
      // R38 pixel-stream preserved + composing with the R43 running icon.
      expect(row?.querySelector(".ac-pixel-stream")).toBeTruthy();
      expect(row?.querySelector('[aria-label="Session is working"]')).toBeTruthy();
    });
    useActiveStreams.setState({ active: new Set() });
  });

  it("deriveSessionRowState maps session status to the row's icon state", () => {
    const base = { id: "s", projectId: null, agentId: null, mode: "single" as const, title: null, createdAt: "", updatedAt: "" };
    const session = (status: Session["status"]): Session => ({ ...base, status });
    expect(deriveSessionRowState(session("failed"), false)).toBe("failed");
    expect(deriveSessionRowState(session("cancelled"), false)).toBe("failed");
    expect(deriveSessionRowState(session("running"), false)).toBe("running");
    // A stream marked active wins even if the status field lags behind.
    expect(deriveSessionRowState(session("queued"), true)).toBe("running");
    expect(deriveSessionRowState(session("completed"), false)).toBe("idle");
    expect(deriveSessionRowState(session("queued"), false)).toBe("idle");
  });

  it("ROUND-58 (R58-cf): after a deliberate user stop the row no longer derives running — the backend reset the status to 'queued' and the store cleared the active-streams entry", () => {
    const base = { id: "s", projectId: null, agentId: null, mode: "single" as const, title: null, createdAt: "", updatedAt: "" };
    const session = (status: Session["status"]): Session => ({ ...base, status });
    // MID-STREAM: the persisted status says running AND the store's
    // active-streams set still marks the session (the pixel-stream spins).
    expect(deriveSessionRowState(session("running"), true)).toBe("running");
    // The stop flow ends: the stream store's finally cleared the
    // active-streams entry (useActiveStreams.stop) and the ["sessions"]
    // invalidation refetched the backend's reset status ("queued" — the
    // runtime resets it on a user stop). The row returns to idle — the
    // sidebar never shows a phantom running indicator after a stop.
    expect(deriveSessionRowState(session("queued"), false)).toBe("idle");
  });
});

/* ── R97-I part 2 (owner: a UI "aware of its states"): the sidebar + the
 * project view's loading/error states. Loading holds a SKELETON (never a
 * false "Add your first project" / "No sessions yet"); a failed fetch is an
 * honest, retryable error surface (role=alert, the danger token, Retry). */
describe("Sidebar + ProjectView state awareness (R97-I part 2)", () => {
  /** The minimal shell the sidebar needs to render its projects section. */
  function renderSidebar() {
    return renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
  }

  it("a pending projects query renders the SKELETON — never the false 'Add your first project'", async () => {
    // list() never settles → the projects query stays pending forever.
    projectsOverride.backend = {
      ...createFixtureProjects([]),
      list: () => new Promise<Project[]>(() => {}),
    };
    renderSidebar();

    // 4 rows in the real ProjectRow's geometry hold the section open.
    await waitFor(() => expect(document.querySelector("[data-projects-skeleton]")).toBeTruthy());
    expect(screen.getByLabelText("Loading projects")).toBeTruthy();
    expect(document.querySelectorAll("[data-projects-skeleton] .animate-pulse").length).toBe(4);
    // The FALSE empty state must not paint while the list is still unknown.
    expect(screen.queryByText("Add your first project")).toBeNull();
  });

  it("the empty state renders only once the list has SETTLED empty", async () => {
    projectsOverride.backend = createFixtureProjects([]);
    renderSidebar();

    expect(await screen.findByText("Add your first project")).toBeTruthy();
    expect(document.querySelector("[data-projects-skeleton]")).toBeNull();
  });

  it("a failed projects query renders the retryable ERROR ROW — retry recovers the list", async () => {
    projectsOverride.backend = {
      ...createFixtureProjects([]),
      list: () => Promise.reject(new Error("sidecar down")),
    };
    renderSidebar();

    await waitFor(() => expect(document.querySelector("[data-projects-load-error]")).toBeTruthy());
    expect(screen.getByText("Projects failed to load")).toBeTruthy();
    expect(screen.getByRole("alert", { hidden: true })).toBeTruthy();
    // Not silently degraded to the empty state.
    expect(screen.queryByText("Add your first project")).toBeNull();

    // Retry re-drives the fetch: flip list() to a resolving backend and the
    // real rows come back (the errored row is gone).
    projectsOverride.backend = createFixtureProjects();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading projects", hidden: true }));
    expect(await screen.findByText("ACUTE-CODE")).toBeTruthy();
    expect(document.querySelector("[data-projects-load-error]")).toBeNull();
  });

  it("a failed SESSIONS query renders the dimmed note — the projects Retry re-drives it too", async () => {
    // Both joins fail together (the sidecar is down); the projects error
    // row's Retry is the ONE retry — it re-drives sessions as well.
    const down = () => Promise.reject(new Error("sidecar down"));
    projectsOverride.backend = { ...createFixtureProjects([]), list: down };
    sessionsOverride.backend = { ...getFixtureSessions(), list: down };
    renderSidebar();

    await waitFor(() => expect(document.querySelector("[data-sessions-load-error]")).toBeTruthy());
    expect(screen.getByText(/Sessions failed to load/i)).toBeTruthy();

    // Recovery rides the SAME button: flip both backends, click Retry.
    projectsOverride.backend = createFixtureProjects();
    sessionsOverride.backend = getFixtureSessions();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading projects", hidden: true }));
    await waitFor(() => expect(document.querySelector("[data-sessions-load-error]")).toBeNull());
    expect(await screen.findByText("ACUTE-CODE")).toBeTruthy();
  });

  it("the minimized rail holds skeleton TILES while the projects load", async () => {
    useProjectChatStore.setState({ appSidebarMinimized: true });
    projectsOverride.backend = {
      ...createFixtureProjects([]),
      list: () => new Promise<Project[]>(() => {}),
    };
    renderSidebar();

    const strip = await screen.findByTestId("rail-projects");
    // 4 tiles in the real rail tile button's geometry (w-10 h-10), and no
    // project tiles rendered beside them.
    expect(strip.querySelectorAll(".animate-pulse").length).toBe(4);
    expect(screen.queryByRole("button", { name: /^open /i, hidden: true })).toBeNull();
  });

  it("ProjectView shows the retryable ERROR CARD on a failed projects fetch — not 'Project not found'", async () => {
    projectsOverride.backend = {
      ...createFixtureProjects([]),
      list: () => Promise.reject(new Error("sidecar down")),
    };
    renderWithProviders(
      <Routes>
        <Route path="/project/:id" element={<ProjectView />} />
      </Routes>,
      { route: "/project/prj_seed_acute" },
    );

    await waitFor(() => expect(document.querySelector("[data-project-load-error]")).toBeTruthy());
    expect(screen.getByText("Could not load projects")).toBeTruthy();
    // The pre-R97 lie: a fetch failure must NOT read as a missing project.
    expect(screen.queryByText("Project not found")).toBeNull();
    // R126 (TOKENS §11): the error card is the DANGER BADGE-TONE container —
    // bg-badge-danger + the deep-on-tint ink pair on the title (the
    // withAlpha washes + the 1.5px bento border retired) — carrying exactly
    // ONE Retry.
    const card = document.querySelector("[data-project-load-error]") as HTMLElement;
    expect(card.className).toContain("bg-badge-danger");
    expect(card.querySelector("p")?.className).toContain("text-badge-danger-fg");
    expect(screen.queryAllByRole("button")).toHaveLength(1);
    // R126-3c (successor): the Retry is the OUTLINED-DANGER species on the
    // class leg — border-danger-deep + text-danger-deep, duration-100 + the
    // §4 press floor (the pre-R126 withAlpha border style retired).
    const retry = screen.getByRole("button", { name: "Retry loading projects" });
    expect(retry.className).toContain("border-danger-deep");
    expect(retry.className).toContain("text-danger-deep");
    expect(retry.className).toContain("active:scale-[0.98]");

    // Retry recovers: with the backend back, the project (a seeded id)
    // honestly renders.
    projectsOverride.backend = createFixtureProjects();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading projects" }));
    expect(await screen.findByText("ACUTE-CODE")).toBeTruthy();
    expect(document.querySelector("[data-project-load-error]")).toBeNull();
  });

  it("ProjectView shows a one-line error note instead of the false 'No sessions yet' on a failed sessions fetch", async () => {
    projectsOverride.backend = createFixtureProjects();
    sessionsOverride.backend = {
      ...getFixtureSessions(),
      list: () => Promise.reject(new Error("sidecar down")),
    };
    renderWithProviders(
      <Routes>
        <Route path="/project/:id" element={<ProjectView />} />
      </Routes>,
      { route: "/project/prj_seed_acute" },
    );

    expect(await screen.findByText(/Could not load sessions/i)).toBeTruthy();
    expect(screen.queryByText("No sessions yet")).toBeNull();
    // The project header itself rendered fine (only the sessions join failed).
    expect(screen.getByText("ACUTE-CODE")).toBeTruthy();
    // R126 (TOKENS §11): the sessions error rides the danger badge-tone
    // container too — and now owns its ONE Retry (the sessions refetch;
    // pre-R126 it was a bare one-line note with no recovery whenever only
    // this join failed while the projects list stayed cached).
    const note = document.querySelector("[data-project-sessions-error]") as HTMLElement;
    expect(note.className).toContain("bg-badge-danger");
    expect(note.querySelector("p")?.className).toContain("text-badge-danger-fg");
    // R126-3c (successor): the section's Retry rides the SAME outlined-danger
    // species as the projects error above — one app-wide Retry spelling.
    const retry = screen.getByRole("button", { name: "Retry loading sessions" });
    expect(retry.className).toContain("border-danger-deep");
    expect(retry.className).toContain("text-danger-deep");
    expect(retry.className).toContain("active:scale-[0.98]");
  });
});

/* ── R113-d: the project view becomes the space-honest project home — the
 * slim identity row (no 44px tile, no 24px title, no CTA card), per-session
 * row navigation (?session=<THAT id> — the owner's flow fix), and the New
 * session affordance the sidebar's project-row + already had. */
describe("ProjectView compact header + per-session rows (R113-d)", () => {
  /** Renders ProjectView with a probe at the chat route that mirrors the
   * real route's URL (pathname + search) into the DOM. */
  function ChatProbe() {
    const { pathname, search } = useLocation();
    return <div data-testid="chat-probe">{`${pathname}${search}`}</div>;
  }

  function renderProjectView() {
    return renderWithProviders(
      <Routes>
        <Route path="/project/:id" element={<ProjectView />} />
        <Route path="/project/:id/chat" element={<ChatProbe />} />
      </Routes>,
      { route: "/project/prj_seed_acute" },
    );
  }

  it("the header is ONE slim row — 13px name + mono rootPath inline + New session; the 44px tile, 24px title and 'Open project chat' CTA are GONE", async () => {
    renderProjectView();

    // The name renders at the ROW tier (13px/600), the rootPath sits INLINE
    // beside it (mono, 11px) — no page-title tier.
    // R126: the identity row now rhymes with the sidebar's project row — the
    // 24px CLAY LETTER-AVATAR rejoins it (flat project color + the clay
    // small shadow, the mobile letter-avatar law). The pin below stays true
    // by construction: it kills the pre-R113 44px BENTO tile (.h-11.w-11),
    // a spelling the 24px clay mark never writes.
    const name = await screen.findByRole("heading", { level: 1, name: "ACUTE-CODE" });
    expect(name.className).toContain("text-[13px]");
    expect(name.className).toContain("font-semibold");
    expect(screen.getByText("/home/dev/ACUTE-CODE")).toBeTruthy();
    // The clay letter-avatar: the project's OWN flat color + the clay small
    // shadow as the tile's edge (the pre-R126 black rim is retired).
    const tile = document.querySelector("[data-project-tile]") as HTMLElement;
    expect(tile?.style.boxShadow).toContain("var(--ac-clay-shadow-sm)");
    const seed = (await getFixtureProjects().list()).find((p) => p.name === "ACUTE-CODE");
    expect(tile?.style.background).toBe(seed?.color);
    // The pre-R113 chrome is deleted outright (the 44px bento tile).
    expect(document.querySelector(".h-11.w-11")).toBeNull();
    expect(screen.queryByText("Open project chat")).toBeNull();
    expect(screen.queryByText("Project chat")).toBeNull();
    // The New session affordance rides the row's right end — R126: the
    // QUIET-SOLID clay primary (COMPONENTS §4 — the accent-soft pill retired)
    // at h-8/rounded-lg/12px/600. Re-pinned with the 3c successor run: the
    // fill moved onto the `bg-accent-deep` CLASS (the one instrument-family
    // spelling) with only the INK on the JS leg — `text-accent-text` is the
    // phantom utility (no @theme mapping), so `styles.accentText` paints it.
    const cta = screen.getByRole("button", { name: "Start a new session in ACUTE-CODE" });
    expect(cta.className).toContain("rounded-lg");
    expect(cta.className).toContain("bg-accent-deep");
    expect(cta.className).not.toContain("bg-accent-soft");
    expect((cta as HTMLElement).style.color).toBeTruthy();
    expect((cta as HTMLElement).style.background).toBe("");
  });

  it("each session row opens THAT session (?session=<its id>) — not the project's latest", async () => {
    const backend = getFixtureSessions();
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: "prj_seed_acute", title: "First chat" });
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: "prj_seed_acute", title: "Second chat" });
    const bound = (await backend.list()).filter((s) => s.projectId === "prj_seed_acute");
    const first = bound.find((s) => s.title === "First chat") as Session;
    const second = bound.find((s) => s.title === "Second chat") as Session;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    // Click the FIRST row → the chat route opens AT THAT session (the
    // pre-R113 bug: every row navigated WITHOUT ?session=, so any click
    // landed on the project's latest conversation).
    renderProjectView();
    fireEvent.click(await screen.findByRole("button", { name: /First chat/ }));
    await waitFor(() => expect(screen.getByTestId("chat-probe")).toBeTruthy());
    expect(screen.getByTestId("chat-probe").textContent).toBe(
      `/project/prj_seed_acute/chat?session=${first.id}`,
    );

    // …and the SECOND row opens the SECOND session — the param is per-row,
    // not a constant (whichever of the two is "latest", at least one click
    // here is NOT the latest, so a param-less navigation cannot pass both).
    cleanup();
    renderProjectView();
    fireEvent.click(await screen.findByRole("button", { name: /Second chat/ }));
    await waitFor(() => expect(screen.getByTestId("chat-probe")).toBeTruthy());
    expect(screen.getByTestId("chat-probe").textContent).toBe(
      `/project/prj_seed_acute/chat?session=${second.id}`,
    );
  });

  it("New session creates the session and lands the chat AT it (?session=<created id>)", async () => {
    const backend = getFixtureSessions();
    const before = (await backend.list()).filter((s) => s.projectId === "prj_seed_acute").length;
    renderProjectView();

    const button = await screen.findByRole("button", { name: "Start a new session in ACUTE-CODE" });
    // Flush the agents query (the fixture backend resolves on the microtask
    // queue — the affordance reads its data on click).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("chat-probe")).toBeTruthy());
    const url = screen.getByTestId("chat-probe").textContent ?? "";
    expect(url).toMatch(/^\/project\/prj_seed_acute\/chat\?session=/);
    // The session REALLY exists in the backend, bound to the project, via
    // the first non-template agent (the sidebar's project-row + recipe).
    const created = (await backend.list()).find(
      (s) => s.title === "New chat · ACUTE-CODE",
    ) as Session | undefined;
    expect(created).toBeTruthy();
    expect(url).toBe(`/project/prj_seed_acute/chat?session=${created?.id}`);
    expect((await backend.list()).filter((s) => s.projectId === "prj_seed_acute").length).toBe(
      before + 1,
    );
    expect(created?.agentId).toBe("agt_scribe");
  });
});

// ── ROUND-128 (R128-W3): THE PROJECT ROW TOGGLES ONLY ─────────────────────────
// SCREENS.md §2 law #2, REWRITTEN (the R128 owner directive, reversing the
// R126 split): "clicking on any of the projects should not automatically
// switch the view to that specific project — it should only expand or
// collapse the sessions of it." The WHOLE row is the tree toggle (the
// dedicated chevron button is RETIRED — no project-toggle testid exists
// anymore); NO navigation fires from the row; entering a conversation is a
// session row's job. The sessions still render in ONE recessed well with
// hairline dividers (the R126 law that survives).
describe("R128-W3: the project row toggles its sessions — nothing else (SCREENS §2 law #2)", () => {
  it("clicking the project row toggles the session well WITHOUT navigating", async () => {
    const [project] = await getFixtureProjects().list();
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
      { route: "/" },
    );

    // The ROW carries the tree's contract now: the Expand/Collapse
    // aria-label + aria-expanded live on the row itself (the chevron button
    // is retired — no project-toggle testid anywhere in the tree).
    const row = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        `[aria-label="Expand ${project.name} sessions"]`,
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid^="project-toggle-"]')).toBeNull();

    // Click → the session well OPENS...
    fireEvent.click(row);
    await waitFor(() => {
      expect(row.getAttribute("aria-expanded")).toBe("true");
    });
    await waitFor(() => {
      expect(container.querySelector("[data-session-well]")).toBeTruthy();
    });
    // ...WITHOUT leaving the dashboard route (the owner's exact directive:
    // the row never switches the view — the chat stub never renders).
    expect(screen.getByText("dashboard stub")).toBeTruthy();
    expect(screen.queryByText("chat stub")).toBeNull();

    // Click again → the well COLLAPSES (a true toggle, still no navigation).
    fireEvent.click(row);
    await waitFor(() => {
      expect(row.getAttribute("aria-expanded")).toBe("false");
    });
    await waitFor(() => {
      expect(container.querySelector("[data-session-well]")).toBeNull();
    });
    expect(screen.getByText("dashboard stub")).toBeTruthy();
  });

  it("keyboard parity: Enter and Space toggle the tree from the row", async () => {
    const [project] = await getFixtureProjects().list();
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
      { route: "/" },
    );

    const row = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        `[aria-label="Expand ${project.name} sessions"]`,
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // Enter opens...
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => {
      expect(container.querySelector("[data-session-well]")).toBeTruthy();
    });
    // ...Space closes (both keys are first-class toggles — no navigation
    // either way).
    fireEvent.keyDown(row, { key: " " });
    await waitFor(() => {
      expect(container.querySelector("[data-session-well]")).toBeNull();
    });
    expect(screen.getByText("dashboard stub")).toBeTruthy();
  });

  it("the session tree renders ONE recessed well with hairline dividers between rows", async () => {
    const [project] = await getFixtureProjects().list();
    const backend = getFixtureSessions();
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: project.id, title: "Fix login flow" });
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: project.id, title: "Audit deps" });

    const sessions = (await backend.list()).filter((s) => s.projectId === project.id);
    const activeId = sessions.find((s) => s.title === "Fix login flow")?.id;
    expect(activeId).toBeTruthy();
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
      { route: `/project/${project.id}/chat?session=${activeId}` },
    );

    // The ?session= route auto-expands the project + marks the matching row;
    // the well owns the recess (bg-well + the rim hairline), rows are FLAT
    // inside it, separated by hairlines.
    const well = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-session-well]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(well.className).toContain("bg-well");
    const rows = well.querySelectorAll("[data-session-row]");
    expect(rows.length).toBe(2);
    // The R43 "dedicated border" contract evolves to the well's DIVIDERS:
    // exactly rows−1 hairlines between them, never after the last row
    // (counted by child iteration — Fragment children land directly in the
    // well, and :scope support in the DOM shim is unreliable).
    const dividerCount = Array.from(well.children).filter(
      (child) => child.tagName === "DIV" && child.getAttribute("aria-hidden") === "true",
    ).length;
    expect(dividerCount).toBe(rows.length - 1);
    // The ACTIVE row still pops: the accent tint + the 2px accentDeep bar.
    const activeRow = Array.from(rows).find((r) => (r as HTMLElement).dataset.active === "true");
    expect(activeRow?.className).toContain("bg-accent-tint");
    expect(activeRow?.querySelector(".bg-accent-deep")).toBeTruthy();
  });
});

/* ── ROUND-126 (the Clay Companion redesign): the ProjectView landing
 * re-skin — SCREENS.md §3's Instrument archetype as a THIN landing. The
 * sessions list rhymes with the sidebar's session well (ONE bg-well recess +
 * the rim hairline + inset hairline dividers, flat rows, ACTIVE = the
 * accentTint fill + the 2px accentDeep bar); the honest states ride the clay
 * materials (bg-well skeletons, danger badge-tone containers — pinned in the
 * R97-I block above — and the minimal-center empty shapes). */
describe("R126: ProjectView clay landing (the well grammar)", () => {
  /** Mirrors the route's URL (pathname + search) into the DOM. */
  function ChatProbe() {
    const { pathname, search } = useLocation();
    return <div data-testid="chat-probe">{`${pathname}${search}`}</div>;
  }

  function renderProjectView(route = "/project/prj_seed_acute") {
    return renderWithProviders(
      <Routes>
        <Route path="/project/:id" element={<ProjectView />} />
        <Route path="/project/:id/chat" element={<ChatProbe />} />
      </Routes>,
      { route },
    );
  }

  it("the sessions render in ONE recessed well — flat rows, hairline dividers, the ACTIVE row pops (tint + the 2px accentDeep bar)", async () => {
    const backend = getFixtureSessions();
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: "prj_seed_acute", title: "Fix login flow" });
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: "prj_seed_acute", title: "Audit deps" });
    const sessions = (await backend.list()).filter((s) => s.projectId === "prj_seed_acute");
    const activeId = sessions.find((s) => s.title === "Fix login flow")?.id;
    expect(activeId).toBeTruthy();

    const { container } = renderProjectView(`/project/prj_seed_acute?session=${activeId}`);

    // The well owns the recess (bg-well + the rim hairline + rounded-lg) —
    // the R113 per-row bordered cards retire; rows are FLAT inside it.
    const well = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-project-sessions-well]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(well.className).toContain("bg-well");
    expect(well.className).toContain("rounded-lg");
    expect(well.className).toContain("border");
    // R126-3c (successor): the rim rides the `border-clay-rim` CLASS — the
    // one instrument-family spelling (the inline borderColor leg retired).
    expect(well.className).toContain("border-clay-rim");
    const rows = well.querySelectorAll("[data-project-session-row]");
    expect(rows.length).toBe(2);
    // Exactly rows−1 hairline dividers between rows, never after the last
    // (counted by child iteration — Fragment children land directly in the
    // well; the rows are BUTTONs, the dividers the only aria-hidden DIVs).
    const dividerCount = Array.from(well.children).filter(
      (child) => child.tagName === "DIV" && child.getAttribute("aria-hidden") === "true",
    ).length;
    expect(dividerCount).toBe(rows.length - 1);
    // The ACTIVE row (?session=) pops: the accentTint fill + the 2px
    // accentDeep leading bar (the selection grammar); the inactive row
    // carries the hover wash only — flat, never a tint at rest.
    const activeRow = Array.from(rows).find((r) => (r as HTMLElement).dataset.active === "true");
    expect(activeRow?.className).toContain("bg-accent-tint");
    expect(activeRow?.querySelector(".bg-accent-deep")).toBeTruthy();
    const inactiveRow = Array.from(rows).find((r) => (r as HTMLElement).dataset.active === "false");
    expect(inactiveRow?.className).toContain("hover:bg-hover");
    expect(inactiveRow?.className).not.toContain("bg-accent-tint");
  });

  it("each row carries the state-aware icon — running spinner (accent) / failed alert / idle chat-bubble (tertiary)", async () => {
    const now = new Date().toISOString();
    const mk = (id: string, status: Session["status"], title: string): Session => ({
      id, projectId: "prj_seed_acute", agentId: "agt_scribe", mode: "single", status, title,
      createdAt: now, updatedAt: now,
    });
    sessionsOverride.backend = {
      ...getFixtureSessions(),
      list: () =>
        Promise.resolve([
          mk("s_lag", "completed", "Stream live"),
          mk("s_fail", "failed", "Broken build"),
          mk("s_idle", "queued", "Quiet chat"),
        ]),
    };
    // The completed row flips to running ONLY through the live-streams store
    // (the R58-cf law, shared verbatim with the sidebar via
    // deriveSessionRowState: the stream wins even when the status lags).
    useActiveStreams.setState({ active: new Set(["s_lag"]) });

    const { container } = renderProjectView();

    const rows = await waitFor(() => {
      const found = container.querySelectorAll<HTMLElement>("[data-project-session-row]");
      expect(found.length).toBe(3);
      return found;
    });
    const byState = (state: string) => Array.from(rows).find((r) => r.dataset.state === state);
    // Running: the accent spinner (the only icon that animates).
    const spinner = byState("running")?.querySelector('[aria-label="Session is working"]');
    expect(spinner?.className).toContain("text-accent");
    expect(spinner?.className).toContain("animate-spin");
    // Failed: the alert glyph on the danger hue.
    expect(byState("failed")?.querySelector('[aria-label="Session failed"]')).toBeTruthy();
    // Idle: the plain chat bubble (tertiary at rest — no state label).
    const idle = byState("idle");
    expect(idle?.querySelector("svg")).toBeTruthy();
    expect(idle?.querySelector('[aria-label="Session is working"]')).toBeNull();
    expect(idle?.querySelector('[aria-label="Session failed"]')).toBeNull();
  });

  it("a pending sessions query renders the WELL skeleton — bg-well rows breathing in the rim footprint (never the false 'No sessions yet')", async () => {
    sessionsOverride.backend = {
      ...getFixtureSessions(),
      list: () => new Promise<Session[]>(() => {}),
    };
    const { container } = renderProjectView();

    // The identity row rendered (projects settled) while the sessions ghost
    // holds the well's shape: the rim outline + pulsing bg-well rows, ONE
    // role=status announcement for the region.
    expect(await screen.findByText("ACUTE-CODE")).toBeTruthy();
    const skeleton = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-project-sessions-skeleton]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(skeleton.getAttribute("role")).toBe("status");
    expect(skeleton.getAttribute("aria-label")).toBe("Loading sessions");
    expect(skeleton.querySelectorAll(".animate-pulse.bg-well").length).toBe(3);
    expect(skeleton.className).toContain("border-clay-rim");
    expect(screen.queryByText("No sessions yet")).toBeNull();
    expect(container.querySelector("[data-project-sessions-well]")).toBeNull();
  });

  it("a pending PROJECTS query renders the mirrored landing skeleton — the identity ghosts + the well ghost, never 'Project not found'", async () => {
    projectsOverride.backend = {
      ...createFixtureProjects([]),
      list: () => new Promise<Project[]>(() => {}),
    };
    renderProjectView();

    // ONE announcement owns the whole loading page; the anti-jitter mirror
    // (the identity-row ghosts + the kicker ghost + the well ghost) holds
    // the ready layout's shape; no false state paints while unknown.
    expect(await screen.findByLabelText("Loading project")).toBeTruthy();
    expect(document.querySelectorAll(".animate-pulse.bg-well").length).toBeGreaterThan(3);
    expect(screen.queryByText("Project not found")).toBeNull();
    expect(document.querySelector("[data-project-load-error]")).toBeNull();
  });

  it("the settled-empty sessions section renders the minimal-center empty — one icon tile + one line + one action", async () => {
    // The default fixture sessions are project-less: prj_seed_acute settles
    // EMPTY once the list resolves.
    const { container } = renderProjectView();

    expect(await screen.findByText("No sessions yet")).toBeTruthy();
    const tile = container.querySelector("[data-project-empty-tile]");
    expect(tile?.className).toContain("bg-accent-tint");
    // One line + one action — the empty's action is the SECONDARY species
    // (the identity row's quiet-solid CTA above stays the screen's ONE
    // primary, the mobile law).
    const action = screen.getByRole("button", { name: "Start a session" });
    expect(action.className).toContain("rounded-lg");
    expect(action.className).toContain("border-line-strong");
    // R126-3c (successor): the §4 secondary species — the bg-subtle hover
    // wash + the press floor at duration-100 (the row-grammar hover:bg-hover
    // retired from buttons).
    expect(action.className).toContain("hover:bg-subtle");
    expect(action.className).toContain("active:scale-[0.98]");
  });

  afterEach(() => {
    // The live-streams store is transient but shared with every other
    // describe in this file — never leak a running-state set across tests.
    useActiveStreams.setState({ active: new Set() });
  });
});

/* ── ROUND-128 (R128-W3, SCREENS.md §2 law #9): THE GENERAL CONVERSATION ──────
 * The projects section carries a persistent General entry — conversations
 * that need no folder, living in the app's internal workspace (backend-boot
 * seeded, delete-protected). The sidebar pins it FIRST, hides its delete
 * affordance, and the section header offers the start-a-general-conversation
 * button (the wave's ONE navigation trigger). */
describe("R128-W3: the General conversation (SCREENS §2 law #9)", () => {
  it("General is pinned FIRST in the projects list and carries NO delete affordance", async () => {
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    // The fixture seeds General (id "general") LAST; the SIDEBAR pins it
    // first — the row order is [General, ACUTE-CODE, marketing-site].
    const rows = await waitFor(() => {
      const found = container.querySelectorAll<HTMLElement>('[role="button"][aria-expanded]');
      expect(found.length).toBe(3);
      return found;
    });
    expect(rows[0].getAttribute("aria-label")).toBe("Expand General sessions");
    expect(rows[1].getAttribute("aria-label")).toBe("Expand ACUTE-CODE sessions");
    // Every OTHER project row keeps its delete affordance (hover-revealed
    // in the overlay cluster); General NEVER offers one — the backend
    // refuses its deletion (409 general_protected) and the UI agrees.
    expect(screen.queryByRole("button", { name: "Delete General", hidden: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete ACUTE-CODE", hidden: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete marketing-site", hidden: true })).toBeTruthy();
  });

  it("the header's start-general button creates a General session and navigates to its chat", async () => {
    const backend = getFixtureSessions();
    const before = (await backend.list()).filter((s) => s.projectId === "general").length;
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
    );
    // Flush the agents query (the fixture backend resolves on the microtask
    // queue — the affordance reads its data on click).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(await screen.findByTestId("start-general-conversation"));

    // The session landed in the backend, bound to the General project, and
    // the app navigated to its chat — the ONE navigation this wave adds.
    expect(await screen.findByText("chat stub")).toBeTruthy();
    const created = (await backend.list()).find(
      (s) => s.projectId === "general" && s.title === "New chat · General",
    ) as Session | undefined;
    expect(created).toBeTruthy();
    expect((await backend.list()).filter((s) => s.projectId === "general").length).toBe(
      before + 1,
    );
  });

  it("honest degradation: with no General project and a refusing backend, the button toasts instead of navigating", async () => {
    // An OLDER sidecar shape: the projects list has no "general" row, and
    // the sessions backend refuses the create (the live POST /sessions
    // 404s on an unknown projectId — mirrored here).
    projectsOverride.backend = createFixtureProjects([
      {
        id: "prj_seed_acute",
        name: "ACUTE-CODE",
        rootPath: "/home/dev/ACUTE-CODE",
        color: "#FF6B2C",
        createdAt: "2026-08-20T08:00:00Z",
      },
    ]);
    sessionsOverride.backend = {
      ...getFixtureSessions(),
      create: () =>
        Promise.reject(new ApiError(404, "NOT_FOUND", "no project with id general")),
    };
    useNotificationStreamStore.setState({ lastNotification: null });
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(await screen.findByTestId("start-general-conversation"));

    // The quiet toast (the app's local-toast channel) — never a dead silent
    // button, never an auto-create from the frontend.
    await waitFor(() => {
      expect(useNotificationStreamStore.getState().lastNotification?.title).toBe(
        "General workspace unavailable",
      );
    });
    expect(screen.getByText("dashboard stub")).toBeTruthy();
    expect(screen.queryByText("chat stub")).toBeNull();
  });
});

/* ── ROUND-128 (R128-W3, SCREENS.md §2 law #8): the SESSION delete confirm ────
 * Deleting a session ALWAYS asks first (the shared danger ConfirmDialog);
 * only the confirm reaches deleteSession.mutate; deleting the ACTIVE
 * session navigates the chat pane away from the dead conversation. */
describe("R128-W3: the session delete confirm (SCREENS §2 law #8)", () => {
  /** Mirrors the route's URL (pathname + search) into the DOM. */
  function ChatProbe() {
    const { pathname, search } = useLocation();
    return <div data-testid="chat-probe">{`${pathname}${search}`}</div>;
  }

  it("cancel keeps the session; confirm deletes it — and navigates away ONLY when it was the active session", async () => {
    const [project] = await getFixtureProjects().list();
    const backend = getFixtureSessions();
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: project.id, title: "Active chat" });
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: project.id, title: "Idle chat" });
    const sessions = (await backend.list()).filter((s) => s.projectId === project.id);
    const active = sessions.find((s) => s.title === "Active chat") as Session;
    const idle = sessions.find((s) => s.title === "Idle chat") as Session;

    // LEG 1 — the ACTIVE session: the ?session= route auto-expands the
    // project; deleting the active session must navigate the chat pane to
    // the project's chat root (replace) so it never points at a dead
    // conversation.
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<ChatProbe />} />
        </Routes>
      </>,
      { route: `/project/${project.id}/chat?session=${active.id}` },
    );
    await waitFor(() => {
      expect(container.querySelectorAll("[data-session-row]").length).toBe(2);
    });

    // The delete button ARMS the dialog; CANCEL keeps the session.
    fireEvent.click(
      screen.getByRole("button", { name: "Delete session Active chat", hidden: true }),
    );
    expect(await screen.findByTestId("confirm-dialog")).toBeTruthy();
    expect(screen.getByText("Delete session?")).toBeTruthy();
    expect(
      screen.getByText(/Delete "Active chat"\? This permanently removes the session's messages, tool history, and usage rows\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect((await backend.list()).some((s) => s.id === active.id)).toBe(true);

    // CONFIRM deletes — and because it was the ACTIVE session, the URL
    // moved off the dead ?session= param.
    fireEvent.click(
      screen.getByRole("button", { name: "Delete session Active chat", hidden: true }),
    );
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(screen.getByTestId("chat-probe").textContent).toBe(`/project/${project.id}/chat`);
    });
    expect((await backend.list()).some((s) => s.id === active.id)).toBe(false);
    cleanup();

    // LEG 2 — an IDLE session: the ?session= param points at a DIFFERENT
    // (surviving) session, so deleting the idle one must NOT navigate.
    // Seed one more idle session on the surviving fixture backend BEFORE
    // the second render (the deleted active session stays deleted; the
    // fresh query reads the post-delete, post-create list).
    await backend.create({ mode: "single", agentId: "agt_scribe", projectId: project.id, title: "Idle chat 2" });
    const idle2 = (await backend.list()).find((s) => s.title === "Idle chat 2") as Session;
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id/chat" element={<ChatProbe />} />
        </Routes>
      </>,
      { route: `/project/${project.id}/chat?session=${idle.id}` },
    );
    await waitFor(() => {
      expect(document.querySelectorAll("[data-session-row]").length).toBe(2);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Delete session Idle chat 2", hidden: true }),
    );
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(async () => {
      expect((await backend.list()).some((s) => s.id === idle2.id)).toBe(false);
    });
    // The active session's URL param is UNTOUCHED — no navigation away.
    await waitFor(() => {
      expect(screen.getByTestId("chat-probe").textContent).toBe(
        `/project/${project.id}/chat?session=${idle.id}`,
      );
    });
  });
});
