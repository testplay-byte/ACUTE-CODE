// @vitest-environment happy-dom
/**
 * ROUND-61 (R61-2-a) — the Skills settings tab:
 *
 *  1. loading → data flow (the mono loader swaps for the rows).
 *  2. Rows render name + description + source chip; built-ins carry the
 *     "no delete" treatment (a fixed marker + the honest refusal note in
 *     the editor), user rows carry the Trash2 two-step confirm.
 *  3. The enabled Switch PATCHes /skills/:id with {enabled}.
 *  4. The expandable editor saves name/description/body via updateSkill.
 *  5. The New skill form POSTs /skills with enabled:true by default; a 400
 *     (duplicate name / bad slug) surfaces the ApiError message inline.
 *  6. Delete flows (user) + the rejected-delete error surface.
 *  7. Empty state + the load-error hint (coreUnreachableHint).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createSkill, deleteSkill, listSkills, updateSkill } from "../../lib/api";
import type { SkillRecord } from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";
import SkillsTab from "./SkillsTab";

// The tab is a VIEW over the skills REST surface — the api module is mocked
// exactly as the real sidecar shapes it (MemoryPanel.test.tsx pattern).
vi.mock("../../lib/api", () => ({
  listSkills: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  vi.mocked(listSkills).mockReset().mockResolvedValue([]);
  vi.mocked(createSkill).mockReset().mockResolvedValue(undefined as unknown as SkillRecord);
  vi.mocked(updateSkill).mockReset().mockResolvedValue(undefined as unknown as SkillRecord);
  vi.mocked(deleteSkill).mockReset().mockResolvedValue(undefined);
});

function skillFactory(m: Partial<SkillRecord> & { id: string; name: string }): SkillRecord {
  return {
    ...m,
    description: m.description ?? "",
    body: m.body ?? "",
    source: m.source ?? "user",
    enabled: m.enabled ?? true,
    sortOrder: m.sortOrder ?? 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const SKILLS: SkillRecord[] = [
  skillFactory({
    id: "skl_builtin",
    name: "computer-use",
    description: "Operate the host desktop for the user — screenshots, windows, input.",
    body: "Long built-in instructions…",
    source: "builtin",
    enabled: true,
  }),
  skillFactory({
    id: "skl_user",
    name: "api-testing",
    description: "Design and run REST API test suites from an OpenAPI spec.",
    body: "Old body.",
    source: "user",
    enabled: false,
  }),
];

describe("SkillsTab (ROUND-61 R61-2-a)", () => {
  it("renders the loading state, then the rows (loading → data flow)", async () => {
    vi.mocked(listSkills).mockResolvedValue(SKILLS);
    renderWithProviders(<SkillsTab />);

    // The mono loader shows before the data lands.
    expect(screen.getByText("loading skills…")).toBeTruthy();
    // The rows appear once the query resolves.
    expect(await screen.findByText("computer-use")).toBeTruthy();
    expect(screen.getByText("api-testing")).toBeTruthy();
    expect(screen.queryByText("loading skills…")).toBeNull();
  });

  it("renders rows with source chips and the built-in's no-delete treatment", async () => {
    vi.mocked(listSkills).mockResolvedValue(SKILLS);
    renderWithProviders(<SkillsTab />);

    expect(await screen.findByText("computer-use")).toBeTruthy();
    // Source chips.
    expect(screen.getByText("built-in")).toBeTruthy();
    expect(screen.getByText("user")).toBeTruthy();
    // Descriptions render.
    expect(
      screen.getByText("Design and run REST API test suites from an OpenAPI spec."),
    ).toBeTruthy();
    // User rows have a delete button; built-ins do NOT (the server refuses
    // deletion — the honest refusal rides the marker's tooltip + editor note).
    expect(screen.queryByRole("button", { name: "Delete skill computer-use" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete skill api-testing" })).toBeTruthy();
    expect(screen.getByTitle(/built-in skills can be disabled or edited, not deleted/i)).toBeTruthy();
  });

  it("renders the empty state when no skills exist", async () => {
    vi.mocked(listSkills).mockResolvedValue([]);
    renderWithProviders(<SkillsTab />);

    expect(
      await screen.findByText(/No skills yet — create one below/),
    ).toBeTruthy();
    // The footer hint is always present.
    expect(
      screen.getByText(/Enabled skills appear in every agent turn's system prompt/),
    ).toBeTruthy();
  });

  it("flips the enabled Switch → updateSkill(id, {enabled}) + refetch", async () => {
    vi.mocked(listSkills).mockResolvedValue(SKILLS);
    renderWithProviders(<SkillsTab />);

    await screen.findByText("api-testing");
    const sw = screen.getByRole("switch", { name: "Toggle skill api-testing" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() => expect(updateSkill).toHaveBeenCalledWith("skl_user", { enabled: true }));
    // Invalidation refetches the listing.
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
  });

  it("expands the editor, edits the body, and saves via updateSkill", async () => {
    vi.mocked(listSkills).mockResolvedValue(SKILLS);
    renderWithProviders(<SkillsTab />);

    await screen.findByText("api-testing");
    fireEvent.click(screen.getByRole("button", { name: /Expand skill api-testing/i }));
    const bodyBox = await screen.findByLabelText("Edit body for skill api-testing");
    expect((bodyBox as HTMLTextAreaElement).value).toBe("Old body.");
    fireEvent.change(bodyBox, { target: { value: "New body instructions." } });
    fireEvent.click(screen.getByRole("button", { name: /Save skill api-testing/i }));
    await waitFor(() =>
      expect(updateSkill).toHaveBeenCalledWith("skl_user", {
        name: "api-testing",
        description: "Design and run REST API test suites from an OpenAPI spec.",
        body: "New body instructions.",
      }),
    );
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
  });

  it("shows the built-in note inside the expanded editor", async () => {
    vi.mocked(listSkills).mockResolvedValue(SKILLS);
    renderWithProviders(<SkillsTab />);

    await screen.findByText("computer-use");
    fireEvent.click(screen.getByRole("button", { name: /Expand skill computer-use/i }));
    const note = await screen.findByTestId("builtin-note");
    expect(note.textContent).toContain("built-in skills can be disabled or edited, not deleted");
    // The built-in editor still exposes the body (updateSkill works on it).
    expect(screen.getByLabelText("Edit body for skill computer-use")).toBeTruthy();
  });

  it("creates a skill from the New skill form (enabled by default) and refetches", async () => {
    vi.mocked(listSkills).mockResolvedValue([]);
    renderWithProviders(<SkillsTab />);

    await screen.findByText(/No skills yet/);
    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    fireEvent.change(screen.getByLabelText("New skill name"), { target: { value: "api-testing" } });
    fireEvent.change(screen.getByLabelText("New skill description"), {
      target: { value: "Design and run REST suites." },
    });
    fireEvent.change(screen.getByLabelText("New skill body"), {
      target: { value: "The full instructions…" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
    await waitFor(() =>
      expect(createSkill).toHaveBeenCalledWith({
        name: "api-testing",
        description: "Design and run REST suites.",
        body: "The full instructions…",
        enabled: true,
      }),
    );
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
    // Success collapses the form.
    await waitFor(() => expect(screen.queryByTestId("new-skill-form")).toBeNull());
  });

  it("surfaces the ApiError message inline when the create is rejected (400)", async () => {
    vi.mocked(listSkills).mockResolvedValue([]);
    vi.mocked(createSkill).mockRejectedValue(
      new Error("skill 'api-testing' already exists — names must be unique"),
    );
    renderWithProviders(<SkillsTab />);

    await screen.findByText(/No skills yet/);
    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    fireEvent.change(screen.getByLabelText("New skill name"), { target: { value: "api-testing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
    expect(await screen.findByTestId("new-skill-error")).toBeTruthy();
    expect(screen.getByText(/skill 'api-testing' already exists/)).toBeTruthy();
    // The form stays open for a fix.
    expect(screen.getByTestId("new-skill-form")).toBeTruthy();
  });

  it("deletes a user skill via the two-step confirm and refetches", async () => {
    vi.mocked(listSkills).mockResolvedValue(SKILLS);
    renderWithProviders(<SkillsTab />);

    await screen.findByText("api-testing");
    fireEvent.click(screen.getByRole("button", { name: "Delete skill api-testing" }));
    // Two-step: the confirm row appears BEFORE anything is sent.
    expect(screen.getByTestId("confirm-delete-skl_user")).toBeTruthy();
    expect(deleteSkill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete skill api-testing" }));
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith("skl_user"));
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
  });

  it("surfaces the server's refusal message when a delete is rejected", async () => {
    vi.mocked(listSkills).mockResolvedValue(SKILLS);
    vi.mocked(deleteSkill).mockRejectedValue(
      new Error(
        "built-in skills can be disabled or edited, not deleted — remove computer-use from the database and the seed recreates it",
      ),
    );
    renderWithProviders(<SkillsTab />);

    await screen.findByText("api-testing");
    fireEvent.click(screen.getByRole("button", { name: "Delete skill api-testing" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete skill api-testing" }));
    const rowError = await screen.findByTestId("row-error-skl_user");
    expect(rowError.textContent).toContain("built-in skills can be disabled or edited, not deleted");
  });

  it("shows the load-error hint when the sidecar fails", async () => {
    vi.mocked(listSkills).mockRejectedValue(new Error("sidecar down"));
    renderWithProviders(<SkillsTab />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Agent core unreachable");
    expect(alert.textContent).toContain("to manage skills.");
  });
});
