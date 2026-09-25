// @vitest-environment happy-dom
/**
 * ROUND-61 (R61-2-a) — the Skills settings tab:
 *
 *  1. loading → data flow (the R97-I skeleton gate swaps for the rows).
 *  2. Rows render name + description + source chip; built-ins carry the
 *     "no delete" treatment (a fixed marker + the honest refusal note in
 *     the editor), user rows carry the Trash2 two-step confirm.
 *  3. The enabled Switch PATCHes /skills/:id with {enabled}.
 *  4. The expandable editor saves name/description/body via updateSkill.
 *  5. The New skill form POSTs /skills with enabled:true by default; a 400
 *     (duplicate name / bad slug) surfaces the ApiError message inline.
 *  6. Delete flows (user) + the rejected-delete error surface.
 *  7. Empty state + the load-error card (R97-I: role=alert + exact cause +
 *     Retry — re-pinned R98-E3).
 *
 * ROUND-98 (R98-E3) — the always-load additions:
 *
 *  8. The Always load switch PATCHes {alwaysLoad} + refetch.
 *  9. The pinned-budget readout (24,000 budget; amber past 80%).
 * 10. File-skill rows render read-only (disabled switches + the
 *     "edit the SKILL.md" note; no PATCH on click).
 * 11. The ALWAYS-ON marker rides pinned rows.
 * 12. The composed SKILLS-section preview (index + ALWAYS-ON bodies).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createSkill, deleteSkill, listSkills, updateSkill } from "../../lib/api";
import type { SkillRecord } from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
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

    // The R97-I loading gate: the shared skeletons behind ONE role=status.
    expect(screen.getByRole("status", { name: "Loading skills" })).toBeTruthy();
    // The rows appear once the query resolves.
    expect(await screen.findByText("computer-use")).toBeTruthy();
    expect(screen.getByText("api-testing")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading skills" })).toBeNull();
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

  it("R97-I (re-pinned R98-E3): a failed GET renders the honest error card (role=alert + exact cause + Retry); a successful Retry recovers the rows", async () => {
    let failSkills = true;
    vi.mocked(listSkills).mockImplementation(async () => {
      if (failSkills) throw new Error("sidecar down");
      return SKILLS;
    });
    renderWithProviders(<SkillsTab />);

    const card = await screen.findByTestId("skills-load-error");
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.textContent).toContain("Could not load the skills");
    expect(card.textContent).toContain("sidecar down");
    const retry = screen.getByRole("button", { name: "Retry loading the skills" });
    // No dead rows while the card has nothing real to show.
    expect(screen.queryByText("computer-use")).toBeNull();

    // Phase 2: the sidecar recovers — Retry re-drives the GET.
    failSkills = false;
    fireEvent.click(retry);
    expect(await screen.findByText("computer-use")).toBeTruthy();
    expect(screen.queryByTestId("skills-load-error")).toBeNull();
  });

  /* ── ROUND-98 (R98-E3): the ALWAYS-LOAD additions ──────────────────── */

  it("R98-E3: the Always load switch PATCHes updateSkill(id, {alwaysLoad}) + refetch", async () => {
    vi.mocked(listSkills).mockResolvedValue(SKILLS);
    renderWithProviders(<SkillsTab />);

    await screen.findByText("api-testing");
    const sw = screen.getByTestId("always-load-switch-skl_user");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() => expect(updateSkill).toHaveBeenCalledWith("skl_user", { alwaysLoad: true }));
    // Invalidation refetches the listing.
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
  });

  it("R98-E3: the pinned-budget readout sums the pinned enabled bodies; amber past 80% of the 24,000 budget", async () => {
    // 1,000 chars of pinned body → the neutral readout.
    vi.mocked(listSkills).mockResolvedValue([
      skillFactory({
        id: "skl_pin",
        name: "pinned-flow",
        description: "Always follows the flow.",
        body: "x".repeat(1_000),
        source: "user",
        enabled: true,
        alwaysLoad: true,
      }),
      // A DISABLED pin rides nothing — excluded from the sum.
      skillFactory({
        id: "skl_pin_off",
        name: "pinned-off",
        description: "Pinned but disabled.",
        body: "y".repeat(500),
        source: "user",
        enabled: false,
        alwaysLoad: true,
      }),
    ]);
    renderWithProviders(<SkillsTab />);

    const readout = await screen.findByTestId("pinned-budget");
    expect(readout.textContent).toContain("pinned bodies ≈ 1,000 chars of the 24,000 budget");
    expect(readout.textContent).not.toContain("past 80%");
    expect(readout.style.color).not.toBe(SEMANTIC_COLORS.warning);

    // Over the 80% line (20,000 > 19,200) → the amber readout with the note.
    cleanup(); // unmount the first render — one listing under test at a time
    vi.mocked(listSkills).mockResolvedValue([
      skillFactory({
        id: "skl_pin",
        name: "pinned-flow",
        description: "Always follows the flow.",
        body: "x".repeat(20_000),
        source: "user",
        enabled: true,
        alwaysLoad: true,
      }),
    ]);
    renderWithProviders(<SkillsTab />);
    const amber = await screen.findByTestId("pinned-budget");
    expect(amber.textContent).toContain("pinned bodies ≈ 20,000 chars of the 24,000 budget");
    expect(amber.textContent).toContain("past 80%");
    // R126-3f-3 re-pin: the amber readout's ink moved off the inline
    // SEMANTIC_COLORS.warning leg onto the §11 class leg (text-warning-deep
    // — TOKENS §11's deep/bright warning pair); the truth it asserts is
    // unchanged (the amber tier renders when past 80% of the budget).
    expect(amber.className).toContain("text-warning-deep");
  });

  it("R98-E3: file-skill rows render read-only — disabled switches, the \u201cedit the SKILL.md\u201d note, and no PATCH on click", async () => {
    vi.mocked(listSkills).mockResolvedValue([
      skillFactory({
        id: "fskl_project_marketing_api-conventions",
        name: "api-conventions",
        description: "The house API rules.",
        body: "# API conventions…",
        source: "project-file",
        enabled: true,
        alwaysLoad: true,
        filePath: "/home/dev/marketing-site/.acute/skills/api-conventions/SKILL.md",
        projectName: "marketing-site",
      }),
    ]);
    renderWithProviders(<SkillsTab />);

    await screen.findByText("api-conventions");
    // The provenance chip names the file source.
    expect(screen.getByText("project file")).toBeTruthy();
    // The ALWAYS-ON marker rides the pinned row.
    expect(screen.getByTestId("always-on-marker-fskl_project_marketing_api-conventions")).toBeTruthy();
    // Both switches are READ-ONLY (disabled), showing their frontmatter state.
    const alwaysLoad = screen.getByTestId(
      "always-load-switch-fskl_project_marketing_api-conventions",
    );
    expect(alwaysLoad.getAttribute("aria-checked")).toBe("true");
    expect(alwaysLoad.hasAttribute("disabled")).toBe(true);
    const enabled = screen.getByRole("switch", { name: "Toggle skill api-conventions" });
    expect(enabled.hasAttribute("disabled")).toBe(true);
    // Clicking the read-only pin does NOT PATCH (the server would 409).
    fireEvent.click(alwaysLoad);
    expect(updateSkill).not.toHaveBeenCalled();
    // The honest note: edit the SKILL.md.
    const note = screen.getByTestId("file-skill-note-fskl_project_marketing_api-conventions");
    expect(note.textContent).toContain("edit the SKILL.md");
    expect(note.textContent).toContain("always-load: true");
  });

  it("R98-E3: the ALWAYS-ON marker rides pinned DB rows (absent on unpinned ones)", async () => {
    vi.mocked(listSkills).mockResolvedValue([
      skillFactory({
        id: "skl_pin",
        name: "pinned-flow",
        description: "Always follows the flow.",
        body: "Follow the flow.",
        source: "user",
        enabled: true,
        alwaysLoad: true,
      }),
      skillFactory({ id: "skl_user", name: "api-testing", description: "d", body: "b", source: "user" }),
    ]);
    renderWithProviders(<SkillsTab />);

    await screen.findByText("pinned-flow");
    expect(screen.getByTestId("always-on-marker-skl_pin").textContent).toBe("always-on");
    expect(screen.queryByTestId("always-on-marker-skl_user")).toBeNull();
  });

  it("R98-E3: the composed SKILLS-section preview — the index lines (pinned marked) + the ALWAYS-ON bodies", async () => {
    vi.mocked(listSkills).mockResolvedValue([
      skillFactory({
        id: "skl_pin",
        name: "pinned-flow",
        description: "Always follows the flow.",
        body: "R98E3-PINNED-BODY — always pnpm, always tests.",
        source: "user",
        enabled: true,
        alwaysLoad: true,
      }),
      // A disabled row never reaches the composed index.
      skillFactory({
        id: "skl_off",
        name: "disabled-flow",
        description: "Off.",
        body: "OFF-BODY",
        source: "user",
        enabled: false,
      }),
    ]);
    renderWithProviders(<SkillsTab />);

    await screen.findByText("pinned-flow");
    expect(screen.queryByTestId("skills-section-preview")).toBeNull(); // collapsed by default
    fireEvent.click(screen.getByRole("button", { name: "Show the composed skills section preview" }));

    const preview = await screen.findByTestId("skills-section-preview");
    // The index header + the pinned entry's ALWAYS-ON marker line.
    expect(preview.textContent).toContain("## SKILLS (load with read_skill, search with search_skills)");
    expect(preview.textContent).toContain(
      "- **pinned-flow** — Always follows the flow. (ALWAYS-ON — full body in the ALWAYS-ON SKILLS section below)",
    );
    // The disabled skill is absent from the composition.
    expect(preview.textContent).not.toContain("disabled-flow");
    // The pinned FULL body rides the ALWAYS-ON section verbatim.
    expect(preview.textContent).toContain("## ALWAYS-ON SKILLS (pinned — full bodies ride every turn)");
    expect(preview.textContent).toContain("### Skill: pinned-flow");
    expect(preview.textContent).toContain("R98E3-PINNED-BODY — always pnpm, always tests.");
  });
});
