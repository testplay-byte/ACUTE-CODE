// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ChatView } from "./ChatView";
import { getFixtureAgents } from "../../lib/agent-fixtures";
import { getFixtureSessions } from "../../lib/session-fixtures";
import { renderWithProviders, resetTestState } from "../../test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

/** The fixture's reply turn takes ~700 ms; give waitFor room beyond the 1 s default. */
const SLOW = { timeout: 5000 };

async function renderChatOnNewestSession() {
  const [agents, sessions] = await Promise.all([
    getFixtureAgents().list(false),
    getFixtureSessions().list(),
  ]);
  const session = sessions[0]; // newest-first (sess_seed_report)
  const agent = agents.find((a) => a.id === session.agentId);
  renderWithProviders(<ChatView session={session} agent={agent} />);
  return { session, agent };
}

describe("ChatView (fixture backend, project-chat visual layer)", () => {
  it("renders the panel header with title + model chip and loads history", async () => {
    await renderChatOnNewestSession();

    // Header shows the session title and the bound agent's model as mono chip.
    expect(screen.getAllByText("Phase 2 report draft").length).toBeGreaterThan(0);
    expect(screen.getAllByText("openrouter/ox-alpha").length).toBeGreaterThan(0);

    // History bubbles carry their role for styling/tests.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-role="user"]').length).toBeGreaterThan(0),
    );
    expect(document.querySelectorAll('[data-role="assistant"]').length).toBeGreaterThan(0);
  });

  it("composer flow: optimistic bubble, thinking indicator, then reply + usage chip", async () => {
    await renderChatOnNewestSession();
    await screen.findByText(/Draft the Phase 2 acceptance checklist/);

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Smoke-test message" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    // Optimistic echo appears immediately; the thinking row is in flight.
    expect(screen.getByText("Smoke-test message")).toBeTruthy();
    expect(screen.getByLabelText("Scribe is thinking")).toBeTruthy();

    // The synchronous turn resolves into an assistant bubble with a token chip.
    await waitFor(
      () => expect(document.querySelectorAll('[data-role="assistant"]').length).toBe(3),
      SLOW,
    );
    expect(await screen.findByText(/\d+ → \d+ tok/, {}, SLOW)).toBeTruthy();
    // Thinking indicator cleared once the turn settled.
    expect(screen.queryByLabelText("Scribe is thinking")).toBeNull();
  });

  it("Enter sends the draft, Shift+Enter keeps editing", async () => {
    await renderChatOnNewestSession();
    await screen.findByText(/Draft the Phase 2 acceptance checklist/);

    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Sent via Enter" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("");
    expect(screen.getByText("Sent via Enter")).toBeTruthy();

    await waitFor(
      () => expect(document.querySelectorAll('[data-role="assistant"]').length).toBe(3),
      SLOW,
    );

    fireEvent.change(box, { target: { value: "still drafting" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box.value).toBe("still drafting");
  });
});
