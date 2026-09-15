// @vitest-environment happy-dom
/**
 * ROUND-99 (R99-F) — the Prompts tab's REDESIGN (the owner: "It should be
 * used for the whole project: this will be the whole project system-wide
 * default prompt… learn from the best of the best"): the project-wide
 * FRAMING + the Cursor-Rules-shaped master-detail-lite.
 *
 *  1. The R97-I loading gates (the two-pane skeleton; the framing header
 *     survives them) → the grouped list; the picker defaults to the FIRST
 *     registered project.
 *  2. The framing: the "System prompt" h2 + the project-wide scope line
 *     (the project NAME interpolating) + the honest chips (~tokens
 *     estimated with the tilde · sections · overridden).
 *  3. The bucket-grouped list: label-caps group headers + counts, human
 *     titles (the title-case helper), ONE status chip per row, per-row
 *     ~token estimates (effective chars ÷ 4).
 *  4. The detail pane: the FIRST OVERRIDDEN section is the default
 *     selection; the header carries title + bucket badge + dynamic/static
 *     + status + the mono override-file line + the description.
 *  5. The editor flow: select → edit → Save PUTs the EXACT payload
 *     (projectRoot + content) and invalidates (the GET refetches).
 *  6. The empty-save confirm: the ConfirmDialog carries the DROP warning;
 *     Cancel aborts, Confirm PUTs the empty content.
 *  7. Revert → DELETE (only on overridden rows) + the state flips back —
 *     and the editor STAYS on the reverted section (the sticky selection).
 *  8. The 8,000-char cap: over-cap input is refused outright with the
 *     honest note; at-cap text is accepted and counted.
 *  9. The 401/error card (role=alert, exact cause, one Retry) + recovery.
 * 10. The search filter: matches id AND title (case-insensitive), hides
 *     empty bucket groups, the honest empty state names the query.
 * 11. Revert all…: the ConfirmDialog enumerates every override; Confirm
 *     DELETEs each (Promise.allSettled) and invalidates; Cancel aborts.
 * 12. The promoted preview: "Composed prompt — what the agent actually
 *     receives", ordered sections with chars + ~tokens, OVERRIDDEN marked,
 *     refreshed after every save.
 * 13. The Show-default reference block (collapsed by default).
 * 14. The engine's diagnostics render honestly (role=alert when any).
 * 15. Switching projects refetches with the other root + the scope line
 *     re-frames to the new project's name.
 * 16. A failed projects GET renders the honest picker error card + Retry.
 * 17. Below md the panes stack: the editor opens on row select, the
 *     selected row hides from the list, the back affordance closes it.
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

/** Composite chips render JSX-interleaved numbers — normalize whitespace so
 * the pins stay byte-honest about the CONTENT. */
const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

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

/** The registry picture: FIVE sections across all four buckets — a static
 * default row (identity), a tools pair (tool-use default + skills
 * OVERRIDDEN dynamic), an ABSENT conditional row (project-memory), and a
 * meta row (custom-rules). The ~token pins ride the exact char lengths:
 * "You are ACUTE."=14 → ~4 · "## TOOL USE — call tools deliberately."=38
 * → ~10 · "Custom skills index."=20 → ~5 · absent=0 · "Follow the owner's
 * rules."=25 → ~6 · total 97 → ~24. */
function sectionsFor(root: string, overriddenIds: string[] = ["skills"]): PromptSectionsReport {
  const overridden = (id: string): boolean => overriddenIds.includes(id);
  return {
    rootPath: root,
    sections: [
      sectionFactory({
        id: "identity",
        description: "Who the agent is.",
        bucket: "identity",
        overridden: overridden("identity"),
        overrideContent: overridden("identity") ? "Custom identity." : null,
        defaultText: "You are ACUTE.",
      }),
      sectionFactory({
        id: "tool-use",
        description: "The live tool list + the call discipline.",
        bucket: "tools",
        defaultText: "## TOOL USE — call tools deliberately.",
      }),
      sectionFactory({
        id: "skills",
        description: "The skills index the agent reads.",
        bucket: "tools",
        dynamic: true,
        overridden: overridden("skills"),
        overrideContent: overridden("skills") ? "Custom skills index." : null,
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
      sectionFactory({
        id: "custom-rules",
        description: "The project's own rules file.",
        bucket: "meta",
        defaultText: "Follow the owner's rules.",
      }),
    ],
    overridden: overriddenIds,
    effectiveOrder: ["identity", "tool-use", "skills", "custom-rules"],
    diagnostics: [],
  };
}

const PREVIEW: PromptPreviewReport = {
  rootPath: "/tmp/alpha",
  registryOrder: ["identity", "tool-use", "skills", "project-memory", "custom-rules"],
  effectiveOrder: ["identity", "skills"],
  totalChars: 34,
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

async function selectSection(sectionId: string): Promise<HTMLTextAreaElement> {
  fireEvent.click(screen.getByRole("button", { name: `Select section ${sectionId}` }));
  return (await screen.findByLabelText(`Edit the override for ${sectionId}`)) as HTMLTextAreaElement;
}

describe("PromptsTab (ROUND-99 R99-F — the project-wide system prompt redesign)", () => {
  it("renders the R97-I loading gates (framing + two-pane skeleton), then the grouped list; the picker defaults to the first project", async () => {
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
    // Once the projects land, the manager mounts into ITS loading gate.
    expect(await screen.findByRole("status", { name: "Loading prompt sections" })).toBeTruthy();
    expect(screen.getByTestId("prompt-sections-loading")).toBeTruthy();
    // The framing header SURVIVES the gate — the scope line says what loads.
    expect(screen.getByTestId("prompt-framing-title").textContent).toBe("System prompt");
    expect(screen.getByTestId("prompt-scope-line").textContent).toContain(
      "every agent turn in Alpha starts from this prompt",
    );
    resolveSections(sectionsFor("/tmp/alpha"));

    // The rows appear once the query resolves.
    expect(await screen.findByTestId("prompt-status-identity")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading prompt sections" })).toBeNull();

    // The picker defaults to the FIRST registered project and the GET rode it.
    const select = screen.getByTestId("prompts-project-select") as HTMLSelectElement;
    expect(select.value).toBe("/tmp/alpha");
    expect(fetchPromptSections).toHaveBeenCalledWith("/tmp/alpha");
  });

  it("the framing: the System prompt h2 + the project-wide scope line (the project name interpolating) + the honest chips", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    expect(screen.getByRole("heading", { level: 2, name: "System prompt" })).toBeTruthy();
    const scope = screen.getByTestId("prompt-scope-line");
    expect(scope.textContent).toContain("The project-wide default instructions");
    expect(scope.textContent).toContain("every agent turn in Alpha starts from this prompt");

    // The honest chips: the ~token estimate (97 composed chars ÷ 4 → ~24,
    // tilde — never false precision) + the sections · overridden counts.
    expect(norm(screen.getByTestId("prompt-scope-tokens").textContent)).toBe("~24 tokens estimated");
    expect(norm(screen.getByTestId("prompt-scope-counts").textContent)).toBe("5 sections · 1 overridden");
  });

  it("the bucket-grouped list: label-caps group headers + counts, human titles, status chips, per-row ~token estimates", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    // The four bucket groups (Cursor's scope-grouped list), each + its count.
    expect(norm(screen.getByTestId("prompt-bucket-group-identity").textContent)).toBe("System prompt 1");
    expect(norm(screen.getByTestId("prompt-bucket-group-tools").textContent)).toBe("Tools 2");
    expect(norm(screen.getByTestId("prompt-bucket-group-memory").textContent)).toBe("Memory 1");
    expect(norm(screen.getByTestId("prompt-bucket-group-meta").textContent)).toBe("Meta 1");

    // Human titles — the title-case helper (`tool-use` → "Tool use").
    expect(screen.getByRole("button", { name: "Select section tool-use" }).textContent).toContain("Tool use");
    expect(screen.getByRole("button", { name: "Select section project-memory" }).textContent).toContain(
      "Project memory",
    );

    // ONE status chip per row: DEFAULT neutral, OVERRIDDEN accent, ABSENT amber.
    expect(screen.getByTestId("prompt-status-identity").textContent).toBe("default");
    expect(screen.getByTestId("prompt-status-tool-use").textContent).toBe("default");
    expect(screen.getByTestId("prompt-status-skills").textContent).toBe("overridden");
    expect(screen.getByTestId("prompt-status-project-memory").textContent).toBe("absent");

    // Per-row ~token estimates: effective chars ÷ 4 (override when present).
    expect(screen.getByTestId("prompt-row-tokens-identity").textContent).toBe("~4");
    expect(screen.getByTestId("prompt-row-tokens-tool-use").textContent).toBe("~10");
    expect(screen.getByTestId("prompt-row-tokens-skills").textContent).toBe("~5");
    expect(screen.getByTestId("prompt-row-tokens-project-memory").textContent).toBe("~0");
    expect(screen.getByTestId("prompt-row-tokens-custom-rules").textContent).toBe("~6");
  });

  it("the detail pane: the first OVERRIDDEN section is the default selection — header (title + bucket + dynamic/static + status), the mono file line, the description; selecting swaps the editor", async () => {
    renderWithProviders(<PromptsTab />);
    // No click — the first overridden row (skills) is the default selection.
    const area = (await screen.findByLabelText("Edit the override for skills")) as HTMLTextAreaElement;
    expect(area.value).toBe("Custom skills index.");

    const pane = screen.getByTestId("prompt-detail-pane");
    expect(norm(pane.textContent)).toContain("Skills");
    expect(screen.getByTestId("prompt-bucket-skills").textContent).toBe("tools");
    expect(screen.getByTestId("prompt-detail-kind-skills").textContent).toBe("dynamic");
    expect(screen.getByTestId("prompt-detail-status-skills").textContent).toBe("overridden");
    // The mono anchor: the override FILE this editor writes.
    expect(norm(pane.textContent)).toContain(".acute/prompts/skills.md");
    // The registry's own description line.
    expect(norm(pane.textContent)).toContain("The skills index the agent reads.");

    // Selecting another row swaps the editor + the header + the active row.
    fireEvent.click(screen.getByRole("button", { name: "Select section identity" }));
    expect(await screen.findByLabelText("Edit the override for identity")).toBeTruthy();
    expect(screen.queryByLabelText("Edit the override for skills")).toBeNull();
    expect(screen.getByTestId("prompt-bucket-identity").textContent).toBe("identity");
    expect(screen.getByTestId("prompt-detail-kind-identity").textContent).toBe("static");
    const identityRow = screen.getByRole("button", { name: "Select section identity" });
    expect(identityRow.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Select section skills" }).getAttribute("aria-current")).toBeNull();
  });

  it("the editor flow: select → edit → Save PUTs the EXACT payload and the GET refetches", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    const area = await selectSection("identity");
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

    const area = (await screen.findByLabelText("Edit the override for skills")) as HTMLTextAreaElement;
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

  it("Revert → DELETE on the overridden row, the state flips back to default, and the editor STAYS on the reverted section", async () => {
    let currentOverridden = ["skills"];
    vi.mocked(fetchPromptSections).mockImplementation(
      async (root: string) => sectionsFor(root, currentOverridden),
    );
    vi.mocked(deletePromptOverride).mockImplementation(async () => {
      currentOverridden = [];
      return { ok: true, id: "skills", reverted: true, existed: true };
    });
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-skills");
    expect(screen.getByTestId("prompt-status-skills").textContent).toBe("overridden");

    fireEvent.click(screen.getByRole("button", { name: "Revert skills to the default text" }));

    await waitFor(() => expect(deletePromptOverride).toHaveBeenCalledWith("/tmp/alpha", "skills"));
    // The refetched picture reports the section back at its default.
    await waitFor(() => expect(screen.getByTestId("prompt-status-skills").textContent).toBe("default"));
    // The sticky selection keeps the editor ON the reverted section (the
    // default would otherwise yank it to the next overridden/identity row).
    const area = screen.getByLabelText("Edit the override for skills") as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe(""));
  });

  it("the 8,000-char cap: over-cap input is refused with the honest note; at-cap text is accepted and counted", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    const area = await selectSection("identity");
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

  it("a failed GET renders the honest error card (role=alert + exact cause + Retry) under the surviving framing, and a successful Retry recovers the list", async () => {
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
    // The framing header survives the error gate — the scope line says WHAT
    // failed to load.
    expect(screen.getByTestId("prompt-framing-title").textContent).toBe("System prompt");

    // Phase 2: the sidecar recovers — Retry re-drives the GET.
    failSections = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading the prompt sections" }));
    expect(await screen.findByTestId("prompt-status-identity")).toBeTruthy();
    expect(screen.queryByTestId("prompt-sections-error")).toBeNull();
  });

  it("the search filter: matches id AND title case-insensitively, hides empty bucket groups, and the empty state is honest", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");
    const input = screen.getByTestId("prompt-search-input") as HTMLInputElement;

    // "tool" matches tool-use (id AND title) — only the Tools group survives.
    fireEvent.change(input, { target: { value: "tool" } });
    expect(screen.getByTestId("prompt-bucket-group-tools")).toBeTruthy();
    expect(screen.queryByTestId("prompt-bucket-group-identity")).toBeNull();
    expect(screen.queryByTestId("prompt-bucket-group-memory")).toBeNull();
    expect(screen.queryByTestId("prompt-bucket-group-meta")).toBeNull();
    expect(screen.queryByTestId("prompt-status-identity")).toBeNull();
    expect(screen.queryByTestId("prompt-status-skills")).toBeNull();
    expect(screen.getByTestId("prompt-status-tool-use").textContent).toBe("default");

    // Title matching (the hyphen vs the space): "PROJECT MEMORY" matches the
    // human title "Project memory", case-insensitively.
    fireEvent.change(input, { target: { value: "PROJECT MEMORY" } });
    expect(screen.getByTestId("prompt-status-project-memory")).toBeTruthy();
    expect(screen.queryByTestId("prompt-status-identity")).toBeNull();

    // Nothing matches → the honest empty state names the query.
    fireEvent.change(input, { target: { value: "zzz" } });
    const empty = screen.getByTestId("prompt-search-empty");
    expect(empty.textContent).toContain("No section matches");
    expect(empty.textContent).toContain("zzz");

    // Clearing the filter restores every group.
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByTestId("prompt-status-identity")).toBeTruthy();
    expect(screen.getByTestId("prompt-bucket-group-meta")).toBeTruthy();
    expect(screen.queryByTestId("prompt-search-empty")).toBeNull();
  });

  it("Revert all…: the ConfirmDialog enumerates every override, Confirm DELETEs each and invalidates, Cancel aborts", async () => {
    let currentOverridden = ["identity", "skills"];
    vi.mocked(fetchPromptSections).mockImplementation(
      async (root: string) => sectionsFor(root, currentOverridden),
    );
    vi.mocked(deletePromptOverride).mockImplementation(async (_root: string, id: string) => {
      currentOverridden = currentOverridden.filter((x) => x !== id);
      return { ok: true, id, reverted: true, existed: true };
    });
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");
    expect(screen.getByTestId("prompt-overridden-count").textContent).toBe("2 overridden");

    fireEvent.click(screen.getByTestId("prompt-revert-all"));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("removes the 2 override files");
    // The exact enumeration of what reverts.
    expect(screen.getByTestId("prompt-revert-all-item-identity").textContent).toBe("identity");
    expect(screen.getByTestId("prompt-revert-all-item-skills").textContent).toBe("skills");

    // Cancel aborts — nothing deleted.
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect(deletePromptOverride).not.toHaveBeenCalled();

    // Confirm — every overridden section DELETEs (allSettled), then the
    // invalidation refetches the registry picture.
    fireEvent.click(screen.getByTestId("prompt-revert-all"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(deletePromptOverride).toHaveBeenCalledWith("/tmp/alpha", "identity"));
    await waitFor(() => expect(deletePromptOverride).toHaveBeenCalledWith("/tmp/alpha", "skills"));
    await waitFor(() => expect(fetchPromptSections).toHaveBeenCalledTimes(2));

    // The refetched picture: every row back at default, the footer gone.
    await waitFor(() => expect(screen.getByTestId("prompt-status-skills").textContent).toBe("default"));
    expect(screen.getByTestId("prompt-status-identity").textContent).toBe("default");
    await waitFor(() => expect(screen.queryByTestId("prompt-revert-all")).toBeNull());
    expect(norm(screen.getByTestId("prompt-scope-counts").textContent)).toContain("5 sections");
    expect(norm(screen.getByTestId("prompt-scope-counts").textContent)).toContain("0 overridden");
  });

  it("the promoted preview: Composed prompt — what the agent actually receives; ordered sections with chars + ~tokens, refreshed after every save", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    // Collapsed by default — nothing fetched until opened.
    expect(fetchPromptPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show the composed prompt preview" }));

    const body = await screen.findByTestId("prompt-preview-body");
    // The promoted header — the composed prompt's own card title.
    const previewCard = screen.getByTestId("prompt-preview-card");
    expect(norm(previewCard.textContent)).toContain("Composed prompt");
    expect(norm(previewCard.textContent)).toContain("what the agent actually receives");
    // The total readout carries chars + the ~token estimate (34 ÷ 4 → ~9).
    expect(norm(screen.getByTestId("prompt-preview-total").textContent)).toBe("34 chars · ~9 tokens");
    // The composed sections in EFFECTIVE order.
    const rendered = body.querySelectorAll("[data-preview-section]");
    expect(rendered[0]?.getAttribute("data-preview-section")).toBe("identity");
    expect(rendered[1]?.getAttribute("data-preview-section")).toBe("skills");
    // Per-section metrics: chars + ~tokens beside them.
    expect(norm(screen.getByTestId("prompt-preview-metrics-identity").textContent)).toBe("14 chars · ~4 tokens");
    expect(norm(screen.getByTestId("prompt-preview-metrics-skills").textContent)).toBe("20 chars · ~5 tokens");
    // The overridden section carries the accent marker; the default one doesn't.
    expect(screen.queryByTestId("preview-overridden-identity")).toBeNull();
    expect(screen.getByTestId("preview-overridden-skills")).toBeTruthy();
    expect(body.textContent).toContain("You are ACUTE.");
    expect(body.textContent).toContain("Custom skills index.");
    expect(fetchPromptPreview).toHaveBeenCalledTimes(1);

    // A save invalidates → the OPEN preview refetches.
    const area = await selectSection("identity");
    fireEvent.change(area, { target: { value: "You are a focused engineer." } });
    fireEvent.click(screen.getByRole("button", { name: "Save the override for identity" }));
    await waitFor(() => expect(fetchPromptPreview).toHaveBeenCalledTimes(2));
  });

  it("the DEFAULT text reference block: collapsed by default, toggled open, toggled closed", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    await selectSection("identity");
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

  it("switching projects refetches with the other root and the scope line re-frames to the new project's name", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");
    expect(fetchPromptSections).toHaveBeenCalledWith("/tmp/alpha");
    expect(screen.getByTestId("prompt-scope-line").textContent).toContain(
      "every agent turn in Alpha starts from this prompt",
    );

    fireEvent.change(screen.getByTestId("prompts-project-select"), {
      target: { value: "/tmp/beta" },
    });
    await waitFor(() => expect(fetchPromptSections).toHaveBeenCalledWith("/tmp/beta"));
    expect(screen.getByText("/tmp/beta")).toBeTruthy();
    expect(screen.getByTestId("prompt-scope-line").textContent).toContain(
      "every agent turn in Beta starts from this prompt",
    );
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

  it("below md the panes stack: the editor opens on row select, the selected row hides from the list, the back affordance closes it", async () => {
    renderWithProviders(<PromptsTab />);
    await screen.findByTestId("prompt-status-identity");

    // Initially the editor pane is closed below md (`hidden md:flex`) — the
    // list stands alone; ≥md the pane is always rendered.
    const pane = screen.getByTestId("prompt-detail-pane");
    expect(pane.className).toContain("hidden md:flex");
    // The back affordance is a <md-only control.
    expect(screen.getByRole("button", { name: "Back to all sections" }).className).toContain("md:hidden");

    // Selecting a row opens the editor below the list and hides the row
    // itself (the editor right under it says it all).
    fireEvent.click(screen.getByRole("button", { name: "Select section identity" }));
    expect(screen.getByTestId("prompt-detail-pane").className).not.toContain("hidden md:flex");
    expect(
      screen.getByRole("button", { name: "Select section identity" }).className,
    ).toContain("hidden md:flex");
    expect(await screen.findByLabelText("Edit the override for identity")).toBeTruthy();

    // The back affordance closes the editor and restores the row.
    fireEvent.click(screen.getByRole("button", { name: "Back to all sections" }));
    expect(screen.getByTestId("prompt-detail-pane").className).toContain("hidden md:flex");
    expect(
      screen.getByRole("button", { name: "Select section identity" }).className,
    ).not.toContain("hidden md:flex");
  });
});
