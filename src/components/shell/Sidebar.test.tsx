// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { Sidebar } from "./Sidebar";
import { ProjectView } from "../projects/ProjectView";
import { useProjectsStore } from "../../lib/projects-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  useProjectsStore.setState({ projects: [], selectedProjectId: null });
});

describe("Sidebar projects section", () => {
  it("creates a project through the Add Project dialog and navigates to its view", async () => {
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
          <Route path="/project/:id" element={<ProjectView />} />
        </Routes>
      </>,
    );
    // Sidebar is hidden below md but present in DOM; the dialog is portal-free.
    fireEvent.click(screen.getByRole("button", { name: /add project/i, hidden: true }));
    expect(await screen.findByText("Add New Project")).toBeTruthy();
    fireEvent.change(
      await screen.findByPlaceholderText("my-awesome-project"),
      { target: { value: "acute-code" } },
    );
    fireEvent.change(screen.getByPlaceholderText("~/projects/my-awesome-project"), {
      target: { value: "~/projects/acute-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create project/i, hidden: true }));

    // The project view opens with the honest orchestration note.
    expect(await screen.findByText("Project chat")).toBeTruthy();
    // The path shows in both the sidebar item and the project view header.
    expect(screen.getAllByText("~/projects/acute-code").length).toBeGreaterThanOrEqual(2);

    // The store persisted exactly one project with a slug id and a color.
    const { projects } = useProjectsStore.getState();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("acute-code");
    expect(projects[0].id).toMatch(/^p-/);
    expect(projects[0].color).toMatch(/^#/);
  });

  it("deletes a project from the sidebar list", async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: "p-test1",
          name: "demo",
          path: "~/demo",
          color: "#FF6B2C",
          createdAt: new Date().toISOString(),
        },
      ],
      selectedProjectId: null,
    });
    renderWithProviders(
      <>
        <Sidebar />
        <Routes>
          <Route path="/" element={<div>dashboard stub</div>} />
        </Routes>
      </>,
    );
    expect(screen.getByText("demo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete demo", hidden: true }));
    expect(screen.queryByText("demo")).toBeNull();
    expect(useProjectsStore.getState().projects).toHaveLength(0);
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
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(screen.queryByText("Agents")).toBeNull();
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
