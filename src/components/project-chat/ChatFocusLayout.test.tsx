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
  useProjectChatStore.setState({ chatFocusMode: true, appSidebarVisible: true });
});

describe("ChatFocusLayout (Round 33 — headerless chat panel)", () => {
  it("renders the chat with NO top navigation bar at all (owner R33)", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);

    // NONE of the old header affordances exist — the owner removed the whole
    // bar: no agent chip, no search button, no theme toggle in the chat.
    expect(screen.queryByRole("button", { name: /Agent:/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /search project/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /switch to (light|dark) mode/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /show panels/i })).toBeNull();
    // The composer is the panel's only chrome at the bottom.
    expect(screen.getByRole("textbox", { name: /message composer/i })).toBeTruthy();
  });

  it("renders the composer for messaging the agent", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);
    expect(screen.getByRole("textbox", { name: /message composer/i })).toBeTruthy();
  });
});
