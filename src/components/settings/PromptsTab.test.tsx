// @vitest-environment happy-dom
/**
 * ROUND-98 (R98-E1/E3) — the Prompts settings tab (the per-project system
 * prompt section overrides):
 *
 *  1. Loading → data flow (the shared skeletons + role=status, then rows);
 *     the project picker defaults to the FIRST registered project.
 *  2. The rows carry the bucket badge (identity-chip grammar), the
 *     dynamic/static marker, and the ONE status chip — DEFAULT neutral /
 *     OVERRIDDEN accent-tinted / ABSENT amber.
 *  3. The editor flow: expand → edit → Save PUTs the EXACT payload
 *     (projectRoot + content) and invalidates (the GET refetches).
 *  4. The empty-save confirm: the ConfirmDialog carries the DROP warning;
 *     Cancel aborts, Confirm PUTs the empty content.
 *  5. Revert → DELETE (only on overridden rows) + the state flips back.
 *  6. The 8,000-char cap: over-cap input is refused outright with the
 *     honest note; at-cap text is accepted and counted.
 *  7. The 401/error card (role=alert, exact cause, one Retry) + recovery.
 *  8. The live preview: composed effective sections in order, OVERRIDDEN
 *     ones accent-marked, and a REFRESH after every save.
 *  9. The Show default reference block (collapsed by default).
 * 10. The engine's diagnostics render honestly (role=alert when any).
 * 11. Switching projects refetches with the other root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  deletePromptOverride,
  fetchPromptPreview,
  fetchPromptSections,
  getProjectsBackend,
  savePromptOverride,
  type Project,
  type ProjectsBackend,
  type PromptPreviewReport,
  type PromptSectionView,
  type PromptSectionsReport,
} from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";
import PromptsTab from "./PromptsTab";

// The tab is a VIEW over the prompts REST surface + the canonical projects
// query — the api module is mocked exactly as the real sidecar shapes it
// (SkillsTab.test.tsx pattern; useProjects rides getProjectsBackend).
vi.mock("../../lib/api", () => ({
  getProjectsBackend: vi.fn(),
  fetchPromptSections: vi.fn(),
  savePromptOverride: vi.fn(),
  deletePromptOverride: vi.fn(),
  fetchPromptPreview: vi.fn(),
}));

afterEach(cleanup);

const PROJECTS: Project[] = [
  { id: "prj_alpha", name: "Alpha", rootPath: "/tmp/alpha", color: "#5b8def", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "prj_beta", name: "Beta", rootPath: "/tmp/beta", color: "#5b8def", createdAt: "2026-01-01T00:00:00.000Z" },
];

function projectsBackend(projects: Project[] | Error): ProjectsBackend {
  return {
    list: () =>
      projects instanceof Error ? Promise.reject(projects) : Promise.resolve(projects),
    create: () => Promise.reject(new Error("unused")),
    get: () => Promise.reject(new Error("unused")),
    remove: () => Promise.reject(new Error("unused")),
    tree: () => Promise.reject(new Error("unused")),
    file: () => Promise.reject(new Error("unused")),
  } as unknown as ProjectsBackend;
}

function sectionFactory(m: Partial<PromptSectionView> & { id: string }): PromptSectionView {
  return {
    description: "A section.",
    dynamic: false,
    bucket: "identity",
    present: true,
    overridden: false,
    overrideContent: null,
    defaultText: "The built-in text.",
    ...m,
  };
}

/** The registry picture: a static default row, an OVERRIDDEN dynamic row,
 * and an ABSENT (conditional, not composed here) row. */
function sectionsFor(root: string, skillsOverridden = true): PromptSectionsReport {
  return {
    rootPath: root,
    sections: [
      sectionFactory({
        id: "identity",
        description: "Who the agent is.",
        bucket: "identity",
        defaultText: "You are ACUTE.",
      }),
      sectionFactory({
        id: "skills",
        description: "The skills index the agent reads.",
        bucket: "tools",
        dynamic: true,
        overridden: skillsOverridden,
        overrideContent: skillsOverridden ? "Custom skills index." : null,
        defaultText: "## SKILLS (the built-in index)",
      }),
      sectionFactory({
        id: "project-memory",
        description: "The project memory digest.",
        bucket: "memory",
        dynamic: true,
        present: false,
        defaultText: null,
      }),
    ],
    overridden: skillsOverridden ? ["skills"] : [],
    effectiveOrder: skillsOverridden ? ["identity", "skills"] : ["identity", "skills"],
    diagnostics: [],
  };
}

const PREVIEW: PromptPreviewReport = {
  rootPath: "/tmp/alpha",
  registryOrder: ["identity", "skills", "project-memory"],
  effectiveOrder: ["identity", "skills"],
  totalChars: 35,
  sections: [
    { id: "identity", overridden: false, text: "You are ACUTE." },
    { id: "skills", overridden: true, text: "Custom skills index." },
  ],
  diagnostics: [],
};

beforeEach(() => {
  resetTestState();
  vi.mocked(getProjectsBackend).mockReset().mockReturnValue(projectsBackend(PROJECTS));
  vi.mocked(fetchPromptSections)
    .mockReset()
    .mockImplementation(async (root: string) => sectionsFor(root));
  vi.mocked(savePromptOverride)
    .mockReset()
    .mockResolvedValue({ ok: true, id: "", file: "", dropped: false, content: "" });
  vi.mocked(deletePromptOverride)
    .mockReset()
    .mockResolvedValue({ ok: true, id: "", reverted: true, existed: true });
  vi.mocked(fetchPromptPreview).mockReset().mockResolvedValue(PREVIEW);
});

async function openEditor(sectionId: string): Promise<HTMLTextAreaElement> {
  fireEvent.click(screen.getByRole("button", { name: `Expand section ${sectionId}` }));
  return (await screen.findByLabelText(`Edit the override for ${sectionId}`)) as HTMLTextAreaElement;
}

describe("PromptsTab (ROUND-98 R98-E1/E3)", () => {
  it("renders the R97-I loading gates, then the rows with badges + status chips; the picker defaults to the first project", async () => {
    // Hold the sections GET open so BOTH loading gates are observable.
    let resolveSections: (r: PromptSectionsReport) => void = () => {};
    vi.mocked(fetchPromptSections).mockImplementation(
      () =>
        new Promise<PromptSectionsReport>((res) => {
          resolveSections = res;
        }),
    );
    renderWithProviders(<PromptsTab />);

    // The picker's loading gate (the shared skeletons behind ONE role=status).
    expect(screen.getByRole("status", { name: "Loading the projects" })).toBeTruthy();
    // Once the projects land, the sections card mounts into ITS loading gate.
    expect(await screen.findByRole("status", { name: "Loading prompt sections" })).toBeTruthy();
    resolveSections(sectionsFor("/tmp/alpha"));

    // The rows appear once the query resolves.
    expect(await screen.findByTestId("prompt-status-identity")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading prompt sections" })).toBeNull();

    // The picker defaults to the FIRST registered project and the GET rode it.
    const select = screen.getByTestId("prompts-project-select") as HTMLSelectElement;
    expect(select.value).toBe("/tmp/alpha");
    expect(fetchPromptSections).toHaveBeenCalledWith("/tmp/alpha");

    // Bucket badges (the §2 identity-chip grammar).
    expect(screen.getByTestId("prompt-bucket-identity").textContent).toBe("identity");
    expect(screen.getByTestId("prompt-bucket-skills").textContent).toBe("tools");
    expect(screen.getByTestId("prompt-bucket-project-memory").textContent).toBe("memory");

    // The dynamic/static marker (skills + project-memory dynamic, identity static).
    expect(screen.getAllByText("dynamic").length).toBe(2);
    expect(screen.getAllByText("static").length).toBe(1);

    // ONE status chip per row: DEFAULT neutral, OVERRIDDEN accent, ABSENT amber.
    expect(screen.getByTestId("prompt-status-identity").textContent).toBe("default");
    expect(screen.getByTestId("prompt-status-skills").textContent).toBe("overridden");
    expect(screen.getByTestId("prompt-status-project-memory").textContent).toBe("absent");

    // The summary chip.
    expect(screen.getByText("1 overridden · 3 sections")).toBeTruthy();
  });

  it("the editor flow: expand → edit → Save PUTs the EXACT payload and the GET refetches", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    const area = await openEditor("identity");
    // No override yet → the draft starts empty.
    expect(area.value).toBe("");
    fireEvent.change(area, { target: { value: "You are a focused engineer." } });
    fireEvent.click(screen.getByRole("button", { name: "Save the override for identity" }));

    await waitFor(() =>
      expect(savePromptOverride).toHaveBeenCalledWith(
        "/tmp/alpha",
        "identity",
        "You are a focused engineer.",
      ),
    );
    // The invalidation refetches the registry picture.
    await waitFor(() => expect(fetchPromptSections).toHaveBeenCalledTimes(2));
  });

  it("the empty-save confirm: the DROP warning rides the ConfirmDialog — Cancel aborts, Confirm PUTs the empty content", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-skills");

    const area = await openEditor("skills");
    expect(area.value).toBe("Custom skills index.");
    // Clearing to empty shows the standing drop hint.
    fireEvent.change(area, { target: { value: "" } });
    expect(screen.getByTestId("prompt-drop-hint-skills").textContent).toContain(
      "REMOVES the section from the prompt entirely",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save the override for skills" }));
    // The confirm dialog — the exact warning, nothing sent yet.
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain(
      "Saving an empty override REMOVES this section from the prompt entirely",
    );
    expect(savePromptOverride).not.toHaveBeenCalled();

    // Cancel aborts — the dialog closes, no PUT.
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect(savePromptOverride).not.toHaveBeenCalled();

    // Confirm fires the PUT with the empty content (the DROP semantics).
    fireEvent.click(screen.getByRole("button", { name: "Save the override for skills" }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(savePromptOverride).toHaveBeenCalledWith("/tmp/alpha", "skills", ""));
  });

  it("Revert → DELETE on the overridden row, and the state flips back to default", async () => {
    let skillsOverridden = true;
    vi.mocked(fetchPromptSections).mockImplementation(
      async (root: string) => sectionsFor(root, skillsOverridden),
    );
    vi.mocked(deletePromptOverride).mockImplementation(async () => {
      skillsOverridden = false;
      return { ok: true, id: "skills", reverted: true, existed: true };
    });
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-skills");
    expect(screen.getByTestId("prompt-status-skills").textContent).toBe("overridden");

    const area = await openEditor("skills");
    fireEvent.click(screen.getByRole("button", { name: "Revert skills to the default text" }));

    await waitFor(() => expect(deletePromptOverride).toHaveBeenCalledWith("/tmp/alpha", "skills"));
    // The draft resets and the refetched picture reports the section back at
    // its default.
    await waitFor(() => expect((area as HTMLTextAreaElement).value).toBe(""));
    await waitFor(() => expect(screen.getByTestId("prompt-status-skills").textContent).toBe("default"));
  });

  it("the 8,000-char cap: over-cap input is refused with the honest note; at-cap text is accepted and counted", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    const area = await openEditor("identity");
    // 8,001 characters → refused outright: the draft never crosses the cap.
    fireEvent.change(area, { target: { value: "x".repeat(8_001) } });
    expect(area.value).toBe("");
    const note = screen.getByTestId("prompt-cap-note-identity");
    expect(note.textContent).toContain("8,000 characters");
    expect(note.textContent).toContain("refused");
    expect(savePromptOverride).not.toHaveBeenCalled();

    // Exactly 8,000 → accepted, the counter reads the cap.
    fireEvent.change(area, { target: { value: "y".repeat(8_000) } });
    expect(area.value).toBe("y".repeat(8_000));
    expect(screen.getByTestId("prompt-counter-identity").textContent).toContain("8,000 / 8,000");
    expect(screen.queryByTestId("prompt-cap-note-identity")).toBeNull();
  });

  it("a failed GET renders the honest error card (role=alert + exact cause + Retry) and a successful Retry recovers the list", async () => {
    let failSections = true;
    vi.mocked(fetchPromptSections).mockImplementation(async (root: string) => {
      if (failSections) throw new Error("Request failed with HTTP 401");
      return sectionsFor(root);
    });
    renderWithProviders(<PromptsTab />);

    const card = await screen.findByTestId("prompt-sections-error");
    const alert = card.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Could not load the prompt sections");
    expect(alert?.textContent).toContain("Request failed with HTTP 401");
    expect(screen.getByRole("button", { name: "Retry loading the prompt sections" })).toBeTruthy();

    // Phase 2: the sidecar recovers — Retry re-drives the GET.
    failSections = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading the prompt sections" }));
    expect(await screen.findByTestId("prompt-status-identity")).toBeTruthy();
    expect(screen.queryByTestId("prompt-sections-error")).toBeNull();
  });

  it("the live preview: composed sections in order with the OVERRIDDEN marker, refreshed after every save", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    // Collapsed by default — nothing fetched until opened.
    expect(fetchPromptPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show the composed prompt preview" }));

    const body = await screen.findByTestId("prompt-preview-body");
    // The composed sections in EFFECTIVE order, with the size readout.
    expect(screen.getByTestId("prompt-preview-total").textContent).toContain("35 chars");
    const rendered = body.querySelectorAll("[data-preview-section]");
    expect(rendered[0]?.getAttribute("data-preview-section")).toBe("identity");
    expect(rendered[1]?.getAttribute("data-preview-section")).toBe("skills");
    // The overridden section carries the accent marker; the default one doesn't.
    expect(screen.queryByTestId("preview-overridden-identity")).toBeNull();
    expect(screen.getByTestId("preview-overridden-skills")).toBeTruthy();
    expect(body.textContent).toContain("You are ACUTE.");
    expect(body.textContent).toContain("Custom skills index.");
    expect(fetchPromptPreview).toHaveBeenCalledTimes(1);

    // A save invalidates → the OPEN preview refetches.
    const area = await openEditor("identity");
    fireEvent.change(area, { target: { value: "You are a focused engineer." } });
    fireEvent.click(screen.getByRole("button", { name: "Save the override for identity" }));
    await waitFor(() => expect(fetchPromptPreview).toHaveBeenCalledTimes(2));
  });

  it("the DEFAULT text reference block: collapsed by default, toggled open, toggled closed", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    await openEditor("identity");
    expect(screen.queryByTestId("prompt-default-identity")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the default text for identity" }));
    const block = await screen.findByTestId("prompt-default-identity");
    expect(block.textContent).toBe("You are ACUTE.");
    fireEvent.click(screen.getByRole("button", { name: "Show the default text for identity" }));
    await waitFor(() => expect(screen.queryByTestId("prompt-default-identity")).toBeNull());
  });

  it("the engine's diagnostics render honestly (role=alert when any)", async () => {
    vi.mocked(fetchPromptSections).mockResolvedValue({
      ...sectionsFor("/tmp/alpha"),
      diagnostics: [
        ".acute/prompts/skills.md is empty — the section is dropped from the prompt",
        "_order.txt names an unknown section: no-such-section (ignored)",
      ],
    });
    renderWithProviders(<PromptsTab />);

    const box = await screen.findByTestId("prompt-diagnostics");
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.textContent).toContain("dropped from the prompt");
    expect(box.textContent).toContain("no-such-section");
  });

  it("switching projects refetches with the other root", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");
    expect(fetchPromptSections).toHaveBeenCalledWith("/tmp/alpha");

    fireEvent.change(screen.getByTestId("prompts-project-select"), {
      target: { value: "/tmp/beta" },
    });
    await waitFor(() => expect(fetchPromptSections).toHaveBeenCalledWith("/tmp/beta"));
    expect(screen.getByText("/tmp/beta")).toBeTruthy();
  });

  it("a failed projects GET renders the honest picker error card + Retry recovery", async () => {
    let failProjects = true;
    vi.mocked(getProjectsBackend).mockImplementation(() =>
      projectsBackend(failProjects ? new Error("sidecar unreachable") : PROJECTS),
    );
    renderWithProviders(<PromptsTab />);

    const card = await screen.findByTestId("prompts-projects-error");
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.textContent).toContain("Could not load the projects");
    expect(card.textContent).toContain("sidecar unreachable");

    failProjects = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading the projects" }));
    await screen.findByTestId("prompts-project-select");
    expect(await screen.findByTestId("prompt-status-identity")).toBeTruthy();
  });
});
