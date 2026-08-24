// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { ChatFocusLayout } from "./ChatFocusLayout";
import { getFixtureProjects } from "../../lib/project-fixtures";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // chatFocusMode defaults true; tests assert on the layout's structure.
  useProjectChatStore.setState({ chatFocusMode: true });
});

describe("ChatFocusLayout (Round 28 WS-D1)", () => {
  it("renders the ChatTopBar with back-to-dashboard, project name, and Show panels toggle", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);

    // Back-to-dashboard affordance is present (aria-label).
    expect(screen.getByRole("link", { name: /back to dashboard/i })).toBeTruthy();
    // Project name is shown.
    expect(screen.getByText(project.name)).toBeTruthy();
    // "Show panels" toggle is present and labelled.
    expect(screen.getByRole("button", { name: /show panels/i })).toBeTruthy();
  });

  it("the Show-panels button flips chatFocusMode to false (exits focus mode)", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);

    expect(useProjectChatStore.getState().chatFocusMode).toBe(true);
    screen.getByRole("button", { name: /show panels/i }).click();
    expect(useProjectChatStore.getState().chatFocusMode).toBe(false);
  });

  it("renders the agent chip with the agent's initial", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);
    // The agent chip button has aria-label starting "Agent:".
    const chip = screen.getByRole("button", { name: /Agent:/i });
    expect(chip).toBeTruthy();
  });

  it("renders the theme toggle (Sun/Moon)", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);
    // Default mode is dark (resetTestState) → the toggle offers "light".
    expect(screen.getByRole("button", { name: /switch to light mode/i })).toBeTruthy();
  });
});
