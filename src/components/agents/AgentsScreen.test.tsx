// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    // Template badge appears once per template (3 templates seeded).
    expect(screen.getAllByText("template").length).toBe(3);
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
    // Dialog stays open with the validation errors surfaced.
    expect(screen.getByText("Model is required")).toBeTruthy();
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
});
