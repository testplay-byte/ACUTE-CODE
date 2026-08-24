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
  useProjectChatStore.setState({ chatFocusMode: true, appSidebarVisible: true });
});

describe("ChatFocusLayout (Round 32 — no top bar, floating chat panel)", () => {
  it("renders the chat panel WITHOUT the old top navigation bar", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);

    // The removed ChatTopBar's affordances must NOT exist.
    expect(screen.queryByRole("link", { name: /back to dashboard/i })).toBeNull();
    // The agent chip + theme toggle now live INSIDE the chat panel's own
    // slim header (the merged round-32 toolbar).
    expect(screen.getByRole("button", { name: /Agent:/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /switch to light mode/i })).toBeTruthy();
  });

  it("the Show-panels button flips chatFocusMode to false (exits focus mode)", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);

    expect(useProjectChatStore.getState().chatFocusMode).toBe(true);
    screen.getByRole("button", { name: /show panels/i }).click();
    expect(useProjectChatStore.getState().chatFocusMode).toBe(false);
  });

  it("renders the composer (textarea) for messaging the agent", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);
    expect(screen.getByRole("textbox", { name: /message composer/i })).toBeTruthy();
  });

  it("renders the ⌘K search affordance in the panel header", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);
    expect(screen.getByRole("button", { name: /search project/i })).toBeTruthy();
  });
});
