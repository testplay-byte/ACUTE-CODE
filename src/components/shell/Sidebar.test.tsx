// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { deriveSessionRowState, Sidebar } from "./Sidebar";
import { ProjectView } from "../projects/ProjectView";
import { getFixtureProjects } from "../../lib/project-fixtures";
import { getFixtureSessions } from "../../lib/session-fixtures";
import { useActiveStreams } from "../../lib/active-streams";
import type { Session } from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  // demoData defaults true → the sidebar reads the fixture ProjectsBackend
  // (re-seeded here: ACUTE-CODE + marketing-site).
  resetTestState();
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

  it("collapsed rail marks the selected project with an INSET ring at the same 36px size (R48-a)", async () => {
    const [project] = await getFixtureProjects().list();
    // Force the collapsed rail (the flag is read on mount).
    localStorage.setItem("acute-code.sidebar.collapsed", "1");
    const { container } = renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
      { route: `/project/${project.id}/chat` },
    );

    // The rail exists, scrolls, and pads top/bottom — long project lists are
    // no longer cut off and the first tile is not clipped.
    const rail = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-testid="collapsed-project-rail"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(rail.className).toContain("overflow-y-auto");
    expect(rail.className).toContain("pt-2");

    // Wait for the fixture projects to land before reading the tiles.
    const activeButton = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-active="true"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const idleButton = container.querySelector<HTMLElement>('[data-active="false"]');
    expect(idleButton).toBeTruthy();
    // NO outside outline — it made the selected tile look bigger and clipped
    // against the overflow-hidden wrapper (the owner's bug report).
    expect(activeButton?.style.outline).toBe("");
    // Both tiles are exactly 36px: selection lives in an INSET ring painted
    // INSIDE the tile, never outside it.
    const activeTile = activeButton?.querySelector<HTMLElement>('span[aria-hidden="true"]');
    const idleTile = idleButton?.querySelector<HTMLElement>('span[aria-hidden="true"]');
    expect(activeTile?.style.width).toBe("36px");
    expect(activeTile?.style.height).toBe("36px");
    expect(idleTile?.style.width).toBe("36px");
    expect(idleTile?.style.height).toBe("36px");
    expect(activeTile?.style.boxShadow).toContain("inset 0 0 0 2px");
    expect(idleTile?.style.boxShadow).not.toContain("inset 0 0 0 2px");
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
    for (const row of rows) {
      expect(row.style.border).not.toBe("");
      expect(row.style.boxShadow).not.toBe("");
    }
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
});
