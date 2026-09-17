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

  it("deletes a project from the sidebar list", async () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    // Fixture seeds include marketing-site; deleting it clears list + backend.
    expect(await screen.findByText("marketing-site")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete marketing-site", hidden: true }),
    );
    await waitFor(() => expect(screen.queryByText("marketing-site")).toBeNull());
    const remaining = await getFixtureProjects().list();
    expect(remaining.some((p) => p.name === "marketing-site")).toBe(false);
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

  it("R62 + R87-A1: the minimized rail navigates — a project tile EXPANDS the sidebar first, then opens its chat; gear opens settings", async () => {
    // Seed a minimized store BEFORE mount (the persisted-restart path).
    useProjectChatStore.setState({ appSidebarMinimized: true });
    renderWithProviders(
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
    // Fixture projects render as tiles with their names as tooltips/labels.
    const tile = await screen.findByRole("button", { name: /^open marketing-site$/i, hidden: true });
    fireEvent.click(tile);
    expect(await screen.findByText("chat stub")).toBeTruthy();
    // R87-A1 (owner: "if I click on any one of the projects, then the left
    // sidebar should apparently expand fully"): the tile click flipped the
    // persisted minimize flag — the rail is gone, the full panel is back.
    expect(useProjectChatStore.getState().appSidebarMinimized).toBe(false);
    expect(screen.queryByTestId("sidebar-rail")).toBeNull();
    // Reset for the next assertion path: re-minimize, then gear → settings.
    act(() => useProjectChatStore.setState({ appSidebarMinimized: true }));
    expect(await screen.findByTestId("sidebar-rail")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rail-settings"));
    expect(await screen.findByText("settings stub")).toBeTruthy();
  });

  // R100-E1 (research §C2 P1(a)): RE-PINNED — the ROUND-34 settings mode
  // is RETIRED. The settings page owns its own nav column + search now, so
  // the sidebar renders the NORMAL nav on /settings routes: the Navigation
  // heading + the Dashboard row (the R95-A back affordance) + the minimize
  // control. No settings-mode header, no per-tab section list.
  it("R100-E1: on a settings route the sidebar renders the NORMAL nav — the settings page owns its own nav column now", () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
      { route: "/settings?tab=appearance" },
    );
    expect(screen.getByText("Navigation")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^dashboard$/i, hidden: true })).toBeTruthy();
    // The minimize control still lives at the very top (R62, mode-agnostic now).
    expect(screen.getByTestId("sidebar-minimize")).toBeTruthy();
    // The retired settings-mode chrome is GONE.
    expect(screen.queryByTestId("sidebar-back-dashboard")).toBeNull();
    expect(screen.queryByRole("button", { name: /^appearance$/i, hidden: true })).toBeNull();
    expect(document.querySelectorAll('[data-testid^="settings-group-"]')).toHaveLength(0);
  });

  // R95-A (the owner: "The left sidebar does have a Back to Dashboard button
  // but it is not proper…"): RE-PINNED R100-E1 — the dedicated settings-mode
  // back pill is gone with the settings-mode sidebar itself; the left
  // sidebar STILL owns the back-to-dashboard affordance on settings routes,
  // via the normal nav's Dashboard row.
  it("R95-A (re-pinned R100-E1): on settings routes the left sidebar's Dashboard row navigates home — the back affordance it owns", async () => {
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
    // The old settings-mode back pill is gone; the Dashboard nav row is the affordance.
    expect(screen.queryByTestId("sidebar-back-dashboard")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^dashboard$/i, hidden: true }));
    expect(await screen.findByText("dashboard stub")).toBeTruthy();
  });

  // R66 (B4, owner report: "when I minimize the settings sidebar, it shows
  // me the wrong sidebar — the normal other sidebar with the projects and
  // such"): RE-PINNED R100-E1 — the rail's settings VARIANT is retired with
  // the sidebar's settings mode. The rail now renders the NORMAL body
  // (dashboard/usage/projects) on settings routes too; the per-tab settings
  // icons (rail-settings-<id>) are gone — the gear (rail-settings) is the
  // one "Settings" entry and the page's own nav owns ?tab=.
  it("R66 (B4, re-pinned R100-E1): minimizing ON A SETTINGS ROUTE shows the normal rail — dashboard/usage/projects, no per-tab settings icons", async () => {
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
    // The NORMAL rail body — dashboard/usage present and navigable.
    expect(screen.getByTestId("rail-dashboard")).toBeTruthy();
    expect(screen.getByTestId("rail-usage")).toBeTruthy();
    // The retired per-tab settings rail icons are gone.
    expect(screen.queryByTestId("rail-settings-vision")).toBeNull();
    expect(screen.queryByTestId("rail-back-dashboard")).toBeNull();
    // Dashboard from the minimized rail still returns home.
    fireEvent.click(screen.getByTestId("rail-dashboard"));
    expect(await screen.findByText("dashboard stub")).toBeTruthy();
  });

  // R98-E1: RE-PINNED R100-E1 — the sidebar carries NO per-tab settings
  // entries anymore (the settings page's own nav column lists Prompts and
  // deep-links ?tab=prompts — pinned in SettingsPage.test.tsx). The footer's
  // ONE "Settings" entry navigates to the page.
  it("R98-E1 (re-pinned R100-E1): NO Prompts entry in the sidebar — the footer Settings entry opens the settings page (its nav owns ?tab=)", async () => {
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

    // No per-tab settings entries in the sidebar at all.
    expect(screen.queryByRole("button", { name: /^prompts$/i, hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /^models & providers$/i, hidden: true })).toBeNull();

    // The ONE Settings entry navigates to /settings (the page's own nav
    // takes over from there — the probe's search drops the ?tab= param).
    fireEvent.click(screen.getByRole("button", { name: /^settings$/i, hidden: true }));
    await waitFor(() => {
      expect((screen.getByTestId("search-probe")).textContent).not.toContain("tab=");
    });
  });

  // R98-I1 (owner: "separate the different side options into different
  // categories"): RE-PINNED R100-E1 — the five group headers moved WITH the
  // settings nav into the settings page's own nav column (pinned in
  // SettingsPage.test.tsx: settings-group-Workspace … settings-group-System).
  // The sidebar carries ZERO settings chrome.
  it("R98-I1 (re-pinned R100-E1): ZERO group headers / settings entries in the sidebar — the five groups render in the settings page's own nav column", () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
      { route: "/settings?tab=appearance" },
    );

    expect(document.querySelectorAll('[data-testid^="settings-group-"]')).toHaveLength(0);
    for (const group of [
      "Workspace",
      "Agents & Skills",
      "Integrations",
      "Data & Statistics",
      "System",
    ]) {
      expect(screen.queryByText(group)).toBeNull();
    }
    // The dashed "more coming" slot went with the settings nav.
    expect(screen.queryByText("More settings coming soon")).toBeNull();
    // The normal nav is what renders on the settings route instead.
    expect(screen.getByText("Navigation")).toBeTruthy();
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
    const projectChip = await screen.findByText("marketing-site");
    expect(projectChip.closest("button")?.getAttribute("aria-label")).toBe("Open marketing-site");
    // The bell keeps its own button; its chip rides the group WRAPPER
    // (group-focus-within covers the bell's keyboard focus through it).
    const bellChip = chipIn("Notifications");
    expect(bellChip.parentElement?.querySelector("[data-notification-bell-button]")).toBeTruthy();
  });

  it("R101-C: the ACTIVE rail nav button carries the 2px leading accent bar (the full NavButton's selection grammar)", async () => {
    renderMinimizedRail();
    await screen.findByTestId("sidebar-rail");

    // "/" is active → the rail's Dashboard button keeps bg-accent-soft AND
    // gains the leading accent bar; the resting Usage button has neither bar.
    const dashboard = screen.getByTestId("rail-dashboard");
    expect(dashboard.className).toContain("bg-accent-soft");
    const bar = dashboard.querySelector(".bg-accent");
    expect(bar).toBeTruthy();
    expect(bar?.className).toContain("w-0.5");
    expect(screen.getByTestId("rail-usage").querySelector(".bg-accent")).toBeNull();
  });

  it("R101-C: >10 projects renders the +N overflow tile; clicking it EXPANDS the sidebar without navigating", async () => {
    // 2 seeds + 10 created = 12 projects → 10 rail tiles + a "+2" tile.
    const backend = getFixtureProjects();
    for (let i = 0; i < 10; i += 1) {
      await backend.create(`extra-${i}`, `/tmp/extra-${i}`);
    }
    renderMinimizedRail();
    await screen.findByTestId("sidebar-rail");

    // The cap stays 10 tiles — never a silent cut.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /^open /i, hidden: true })).toHaveLength(10);
    });
    const overflow = await screen.findByTestId("rail-projects-overflow");
    expect(overflow.textContent).toContain("+2");
    expect(overflow.getAttribute("aria-label")).toBe("2 more projects — expand to see all");
    // The chip carries the same honest copy.
    expect(overflow.querySelector('[data-testid="rail-label"]')?.textContent).toBe(
      "2 more projects — expand to see all",
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
    // 2 fixture projects → 2 tiles, no overflow tile.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /^open /i, hidden: true })).toHaveLength(2);
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
  });
});
