// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AgentsScreen } from "./AgentsScreen";
import { renderWithProviders, resetTestState } from "../../test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

describe("AgentsScreen (fixture backend)", () => {
  it("renders the seeded agents with template badges", async () => {
    renderWithProviders(<AgentsScreen />);

    expect(await screen.findByText("Implementer")).toBeTruthy();
    expect(screen.getByText("Scribe")).toBeTruthy();
    expect(screen.getByText("UI Auditor")).toBeTruthy();
    // Template badge appears once per template (4 templates seeded — ROUND-92
    // added the NULL/NULL "Blank Slate" template to cover the R92-C case:
    // editing an unconfigured agent must work).
    expect(screen.getAllByText("template").length).toBe(4);
    // ROUND-92 (R92-C): the unconfigured template renders the honest
    // pick-arms-it note, not a dangling " · " — and is EDITABLE (below).
    expect(screen.getByText("Blank Slate")).toBeTruthy();
    expect(
      screen.getByText("not configured — the first chat pick arms it"),
    ).toBeTruthy();
  });

  it("create flow: dialog → fill required fields → agent appears in the list", async () => {
    renderWithProviders(<AgentsScreen />);
    await screen.findByText("Implementer");

    fireEvent.click(screen.getByRole("button", { name: /new agent/i }));

    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Scraper" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "researcher" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "openrouter/ox-alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(await screen.findByText("Scraper")).toBeTruthy();
    // Dialog closed after a successful create.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull(),
    );
  });

  it("blocks submit when required fields are missing", async () => {
    renderWithProviders(<AgentsScreen />);
    await screen.findByText("Implementer");

    fireEvent.click(screen.getByRole("button", { name: /new agent/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Create agent" }));

    expect(await screen.findByText("Name is required")).toBeTruthy();
    // ROUND-92 (R92-C): the model is OPTIONAL now ("not configured — pick in
    // chat" is a legitimate saved state; the hint text replaces the error).
    // The dialog stays open on the name/role errors only.
    expect(screen.getByText("Role is required")).toBeTruthy();
    expect(screen.queryByText("Model is required")).toBeNull();
  });

  it("duplicate action creates a (copy) row", async () => {
    renderWithProviders(<AgentsScreen />);
    await screen.findByText("Scribe");

    fireEvent.click(screen.getByRole("button", { name: "Duplicate Scribe" }));

    expect(await screen.findByText("Scribe (copy)")).toBeTruthy();
  });

  it("delete asks for confirmation and removes the agent", async () => {
    renderWithProviders(<AgentsScreen />);
    await screen.findByText("UI Auditor");

    fireEvent.click(screen.getByRole("button", { name: "Delete UI Auditor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("UI Auditor")).toBeNull());
  });

  it("template filter: My agents hides templates, Templates shows only templates", async () => {
    renderWithProviders(<AgentsScreen />);
    await screen.findByText("Implementer");

    fireEvent.click(screen.getByRole("button", { name: "My agents" }));
    await waitFor(() => expect(screen.queryByText("Implementer")).toBeNull());
    expect(await screen.findByText("Scribe")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Templates" }));
    await waitFor(() => expect(screen.queryByText("Scribe")).toBeNull());
    expect(await screen.findByText("Implementer")).toBeTruthy();
  });

  // ── ROUND-92 (R92-C): the EDIT FLOW on a template agent — the owner's
  // v0.89.0 report ("I tried to edit the models but the agents were not
  // editable"). Every seeded template carries providerId/model = NULL; the
  // old toFormState crashed during render (the ErrorBoundary ate the screen).
  // The flow must now open the dialog on the NULL pair, accept changes, and
  // PATCH the expected payload through the agents backend.
  it("ROUND-92: edit flow on the NULL-model template — dialog opens, changes save via PATCH", async () => {
    renderWithProviders(<AgentsScreen />);
    await screen.findByText("Blank Slate");

    // The template's own Edit action (not disabled for templates — only
    // DELETE is).
    fireEvent.click(screen.getByRole("button", { name: "Edit Blank Slate" }));

    // The dialog opens ON the unconfigured pair without crashing, and maps
    // null → the form's not-configured state.
    const modelInput = await screen.findByLabelText("Model");
    expect(modelInput).toBeTruthy();
    expect((modelInput as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText("Leave empty to pick the model in chat")).toBeTruthy();

    // Arm it from the dialog: name tweak + a provider + a model.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Armed Slate" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openrouter" } });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "z-ai/glm-5.2:free" },
    });

    // Spy the fixture backend's PATCH (the screen rides getAgentsBackend()
    // → getFixtureAgents(); the shared memoized instance). The spy calls
    // through — the fixture's own update runs, so the flow stays end-to-end.
    const { getFixtureAgents } = await import("../../lib/agent-fixtures");
    const updateSpy = vi.spyOn(getFixtureAgents(), "update");
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
      expect(updateSpy.mock.calls[0][0]).toBe("agt_tpl_blank");
      // THE payload pin: the picked pair + the edited name, everything else
      // carried from the template row.
      expect(updateSpy.mock.calls[0][1]).toMatchObject({
        name: "Armed Slate",
        providerId: "openrouter",
        model: "z-ai/glm-5.2:free",
      });
      // ROUND-92: drain the WHOLE submit chain (the fixture update promise,
      // the dialog's close, the agents refetch) before the test ends — a
      // promise landing after happy-dom teardown was flaking the full-suite
      // run with a caught-after-teardown error. The armed row showing up is
      // the end-to-end proof the update landed.
      await screen.findByText("Armed Slate");
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull(),
      );
    } finally {
      updateSpy.mockRestore();
    }
  });
});
