// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { SessionsScreen } from "./SessionsScreen";
import { renderWithProviders, resetTestState } from "../../test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

/** The fixture's reply turn takes ~700 ms; give waitFor room beyond the 1 s default. */
const SLOW = { timeout: 5000 };

describe("SessionsScreen (fixture backend)", () => {
  it("renders the seeded fixture session list", async () => {
    renderWithProviders(<SessionsScreen />);

    // The title shows in the list row (and the auto-selected chat header).
    expect((await screen.findAllByText("Phase 2 report draft")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Audit Agents screen visuals").length).toBeGreaterThan(0);
  });

  it("opens a session and shows its event history", async () => {
    renderWithProviders(<SessionsScreen />);
    // Newest session is auto-followed, so its events are already visible.
    expect(await screen.findByText(/Draft the Phase 2 acceptance checklist/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open session audit agents screen/i }));

    expect(await screen.findByText(/list any visual regressions/)).toBeTruthy();
    // The previous session's events are swapped out.
    expect(screen.queryByText(/Draft the Phase 2 acceptance checklist/)).toBeNull();
  });

  it("composer flow: type, send, assistant reply and usage line appear", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findByText(/Draft the Phase 2 acceptance checklist/);

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Summarize the open questions." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    // Optimistic user bubble shows immediately while the turn is in flight.
    expect(screen.getByText("Summarize the open questions.")).toBeTruthy();

    // Seeded history has 2 assistant messages; the reply makes it 3.
    await waitFor(
      () => expect(document.querySelectorAll('[data-role="assistant"]').length).toBe(3),
      SLOW,
    );
    expect(await screen.findByText(/\d+ → \d+ tok/, {}, SLOW)).toBeTruthy();
  });

  it("Enter sends, Shift+Enter leaves the draft untouched", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findByText(/Draft the Phase 2 acceptance checklist/);

    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Sent from the keyboard" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe(""); // the send consumed the draft

    await waitFor(
      () => expect(document.querySelectorAll('[data-role="assistant"]').length).toBe(3),
      SLOW,
    );

    // Shift+Enter must not trigger a send — the textarea handles the newline natively.
    const settled = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(settled, { target: { value: "line one" } });
    fireEvent.keyDown(settled, { key: "Enter", shiftKey: true });
    expect(settled.value).toBe("line one");
    expect(document.querySelectorAll('[data-role="assistant"]').length).toBe(3);
  });

  it("shows an inline error banner with retry when the adapter rejects with a 502 envelope", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findByText(/Draft the Phase 2 acceptance checklist/);

    // Fixture affordance: a "/error" prefix fails the simulated provider call.
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "/error make it fail" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    const banner = await screen.findByRole("alert", {}, SLOW);
    expect(banner.textContent).toContain("PROVIDER_ERROR");
    expect(banner.textContent).toContain("provider 'openrouter' call failed");
    // The failed turn's user message still landed in the event log (ADR-0010).
    expect(screen.getByText("/error make it fail")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("new session: pick an agent, session is created and selected", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findAllByText("Phase 2 report draft");

    fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /start session with scribe/i }));

    // The new session is selected with an empty chat (status queued, composer ready).
    expect(await screen.findByText(/queued/i, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.queryByText(/is thinking/i)).toBeNull(); // nothing in flight
  });
});
