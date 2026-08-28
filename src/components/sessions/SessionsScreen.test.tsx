// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SessionsScreen } from "./SessionsScreen";
import { renderWithProviders, resetTestState } from "../../test-utils";
import { getFixtureSessions } from "../../lib/session-fixtures";
import { useNotificationStreamStore } from "../../hooks/use-notifications";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

/** The fixture's reply turn takes ~700 ms; give waitFor room beyond the 1 s default. */
const SLOW = { timeout: 5000 };

/**
 * ROUND-45 (R45-c): the search renders TWO inputs bound to one state — the
 * top-bar input (desktop, index 0) and the full-width mobile row under the
 * header (index 1). happy-dom applies no CSS, so both are always in the DOM.
 */
const searchInputs = () => screen.getAllByLabelText("Search sessions");

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

// ── ROUND-44 (R44-c): search + fork ─────────────────────────────────────────
describe("SessionsScreen search + fork (ROUND-44 R44-c, fixture backend)", () => {
  /** The input's 300 ms debounce + the fixture's ~10 ms reply need room. */
  const SEARCH = { timeout: 4000 };

  it("debounced search filters by TITLE, shows the result count, and clears back to the full list", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findAllByText("Phase 2 report draft");

    fireEvent.change(searchInputs()[0], {
      target: { value: "audit" },
    });

    // One match: the audit session (case-insensitive title hit); the report
    // row is filtered OUT while the chat pane keeps the selected conversation.
    expect(await screen.findByText(/1 result for “audit”/i, {}, SEARCH)).toBeTruthy();
    await waitFor(
      () =>
        expect(
          screen.queryByRole("button", { name: /open session phase 2 report draft/i }),
        ).toBeNull(),
      SEARCH,
    );
    expect(
      screen.getByRole("button", { name: /open session audit agents screen visuals/i }),
    ).toBeTruthy();

    // The clear (X) button restores the unfiltered list.
    fireEvent.click(screen.getAllByRole("button", { name: "Clear search" })[0]);
    expect(
      await screen.findByRole(
        "button",
        { name: /open session phase 2 report draft/i },
        SEARCH,
      ),
    ).toBeTruthy();
  });

  it("search also matches EVENT TEXT (message bodies), not just titles", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findAllByText("Phase 2 report draft");

    // "visual regressions" appears only inside the audit session's EVENT LOG.
    fireEvent.change(searchInputs()[0], {
      target: { value: "visual regressions" },
    });

    expect(await screen.findByText(/1 result for “visual regressions”/i, {}, SEARCH)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /open session audit agents screen visuals/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /open session phase 2 report draft/i }),
    ).toBeNull();
  });

  it("empty-search state: no matches renders the explicit miss message", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findAllByText("Phase 2 report draft");

    fireEvent.change(searchInputs()[0], {
      target: { value: "xyzzynomatch" },
    });

    expect(await screen.findByText(/no sessions match “xyzzynomatch”/i, {}, SEARCH)).toBeTruthy();
  });

  it("row Fork action calls the backend, invalidates the list, and toasts", async () => {
    useNotificationStreamStore.getState().reset();
    const backend = getFixtureSessions();
    const forkSpy = vi.spyOn(backend, "fork");
    renderWithProviders(<SessionsScreen />);
    await screen.findAllByText("Phase 2 report draft");

    // Newest row first — the first Fork button forks the report session.
    fireEvent.click(screen.getAllByRole("button", { name: /fork session/i })[0]);

    // The API was called with the row's session id…
    await waitFor(() => expect(forkSpy).toHaveBeenCalledWith("sess_seed_report"), SEARCH);
    // …the invalidated list now shows the fork (fixture creates it)…
    expect(await screen.findByText("Fork · Phase 2 report draft", {}, SEARCH)).toBeTruthy();
    // …and the success toast landed in the notification stream store (the
    // Toaster itself is mounted in AppShell, not in this test tree).
    await waitFor(
      () =>
        expect(useNotificationStreamStore.getState().lastNotification?.title).toBe(
          "Forked: Phase 2 report draft",
        ),
      SEARCH,
    );
  });
});

// ── ROUND-45 (R45-c): mobile search polish — the R44-c deferral ────────────
describe("SessionsScreen mobile search row (ROUND-45 R45-c, fixture backend)", () => {
  /** The input's 300 ms debounce + the fixture's ~10 ms reply need room. */
  const SEARCH = { timeout: 4000 };

  it("renders a second, full-width search input (mobile row) sharing state with the top-bar input", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findAllByText("Phase 2 report draft");

    // Top bar (desktop) input + the mobile row under the header.
    expect(searchInputs().length).toBe(2);
    expect(screen.getByRole("search", { name: "Session search" })).toBeTruthy();

    // Typing in the MOBILE row drives the shared value — both inputs mirror it.
    fireEvent.change(searchInputs()[1], { target: { value: "audit" } });
    await waitFor(
      () => expect((searchInputs()[0] as HTMLInputElement).value).toBe("audit"),
      SEARCH,
    );
    expect((searchInputs()[1] as HTMLInputElement).value).toBe("audit");
  });

  it("typing in the mobile row filters the list and shows the result count", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findAllByText("Phase 2 report draft");

    fireEvent.change(searchInputs()[1], { target: { value: "audit" } });

    // Same debounced query as the desktop input: one result, the other row filtered out.
    expect(await screen.findByText(/1 result for “audit”/i, {}, SEARCH)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /open session audit agents screen visuals/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /open session phase 2 report draft/i }),
    ).toBeNull();
  });

  it("active search switches the horizontal rail to a vertical results list; clearing restores the rail", async () => {
    renderWithProviders(<SessionsScreen />);
    await screen.findAllByText("Phase 2 report draft");

    const list = screen.getByLabelText("Session list");
    expect(list.getAttribute("data-searching")).toBe("false"); // rail (horizontal)

    fireEvent.change(searchInputs()[1], { target: { value: "audit" } });
    expect(await screen.findByText(/1 result for “audit”/i, {}, SEARCH)).toBeTruthy();
    expect(list.getAttribute("data-searching")).toBe("true"); // vertical results

    // Clearing from the MOBILE row's X button restores the rail + full list.
    const mobileRow = screen.getByRole("search", { name: "Session search" });
    fireEvent.click(within(mobileRow).getByRole("button", { name: "Clear search" }));

    await waitFor(
      () => expect(list.getAttribute("data-searching")).toBe("false"),
      SEARCH,
    );
    expect(
      await screen.findByRole(
        "button",
        { name: /open session phase 2 report draft/i },
        SEARCH,
      ),
    ).toBeTruthy();
  });
});
