// @vitest-environment happy-dom
/**
 * ROUND-122 — the SELF-FEEDBACK tab (the owner's directive: "in the
 * settings there will be a dedicated section for it, and in that section
 * I will be able to see the raw file there too, which the agent has been
 * creating"):
 *
 *  1. THE REGISTRY — the dedicated section exists in the ONE list the
 *     nav + the ?tab= machine render from (id "feedback", the System
 *     group, searchable by its keywords).
 *  2. THE MASTER SWITCH — default OFF; a click PUTs {enabled:true} and
 *     the switch reflects the saved answer; a PUT failure renders the
 *     honest error line under the label.
 *  3. THE LEDGER VIEWER — the honest empty state (no fake content, no
 *     Clear button, Copy disabled); the loaded state (the RAW file text
 *     in the read-only block + the honest meta line: entries · size ·
 *     updated); Copy writes the whole file to the clipboard; Clear
 *     rides the styled ConfirmDialog (R95-A — never window.confirm) and
 *     PUTs DELETE /feedback/file, converging back to the empty state.
 *  4. THE HONEST ERROR — a failed ledger GET renders the retryable
 *     error card, never an eternal spinner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  clearFeedbackLedger,
  deleteFeedbackEntry,
  fetchFeedbackLedger,
  fetchFeedbackSettings,
  updateFeedbackSettings,
  type FeedbackLedgerFile,
} from "../../lib/api";
import { resetTestState, renderWithProviders } from "../../test-utils";
import { parseFeedbackEntries, SelfFeedbackTab } from "./SelfFeedbackTab";
import { SETTINGS_SECTIONS, sectionMatchesQuery, type SettingsSectionId } from "./settings-sections";

vi.mock("../../lib/api", () => ({
  fetchFeedbackSettings: vi.fn(),
  updateFeedbackSettings: vi.fn(),
  fetchFeedbackLedger: vi.fn(),
  clearFeedbackLedger: vi.fn(),
  deleteFeedbackEntry: vi.fn(),
}));

const settingsState = { enabled: false };
const puts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetTestState();
  settingsState.enabled = false;
  puts.length = 0;
  vi.mocked(fetchFeedbackSettings).mockReset();
  vi.mocked(updateFeedbackSettings).mockReset();
  vi.mocked(fetchFeedbackLedger).mockReset();
  vi.mocked(clearFeedbackLedger).mockReset();
  vi.mocked(fetchFeedbackSettings).mockImplementation(async () => ({ ...settingsState }));
  vi.mocked(updateFeedbackSettings).mockImplementation(async (patch) => {
    puts.push(patch as Record<string, unknown>);
    if (patch.enabled !== undefined) settingsState.enabled = patch.enabled;
    return { ...settingsState };
  });
  vi.mocked(fetchFeedbackLedger).mockResolvedValue({
    exists: false,
    content: "",
    bytes: 0,
    updatedAt: null,
    entries: 0,
  });
  vi.mocked(clearFeedbackLedger).mockResolvedValue({ cleared: true, entries: 0 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── 1. The registry ─────────────────────────────────────────────────────────

describe("R122: the Self-Feedback section in the ONE settings list", () => {
  it("the dedicated section exists — id feedback, System group, between Functionality and About", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids).toContain("feedback");
    const feedback = SETTINGS_SECTIONS.find((s) => s.id === "feedback");
    expect(feedback?.label).toBe("Self-Feedback");
    expect(feedback?.group).toBe("System");
    expect(ids.indexOf("feedback")).toBeGreaterThan(ids.indexOf("advanced"));
    expect(ids.indexOf("feedback")).toBeLessThan(ids.indexOf("about"));
  });

  it("the section is findable by its search keywords (ledger, glitches, diagnostics)", () => {
    const feedback = SETTINGS_SECTIONS.find((s) => s.id === "feedback") as {
      id: SettingsSectionId;
      label: string;
    };
    expect(sectionMatchesQuery(feedback, "ledger")).toBe(true);
    expect(sectionMatchesQuery(feedback, "glitches")).toBe(true);
    expect(sectionMatchesQuery(feedback, "diagnostics")).toBe(true);
    expect(sectionMatchesQuery(feedback, "printer")).toBe(false);
  });
});

// ── 2. The master switch ────────────────────────────────────────────────────

describe("R122: the Self-Feedback toggle card", () => {
  it("renders the default OFF switch + the explanatory description", async () => {
    renderWithProviders(<SelfFeedbackTab />);
    const toggle = await screen.findByRole("switch", { name: "Toggle self-feedback generation" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // The owner's separation contract is stated in the description.
    expect(screen.getByText(/never feeds back into the conversation/i)).toBeTruthy();
  });

  it("a click PUTs {enabled:true}; the saved answer flips the switch", async () => {
    renderWithProviders(<SelfFeedbackTab />);
    const toggle = await screen.findByRole("switch", { name: "Toggle self-feedback generation" });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(puts).toEqual([{ enabled: true }]);
    });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("a PUT failure renders the honest error line under the label", async () => {
    vi.mocked(updateFeedbackSettings).mockRejectedValue(new Error("sidecar is down"));
    renderWithProviders(<SelfFeedbackTab />);
    const toggle = await screen.findByRole("switch", { name: "Toggle self-feedback generation" });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/sidecar is down/)).toBeTruthy();
    // The switch stays at its last-known state (OFF) — never a fake flip.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

// ── 3. The ledger viewer ────────────────────────────────────────────────────

describe("R122: the feedback ledger viewer card", () => {
  it("R123: the honest empty state — no fake content, the Clear PRESENT-but-disabled (the affordance never vanishes), Copy disabled", async () => {
    renderWithProviders(<SelfFeedbackTab />);
    await screen.findByText("No feedback yet");
    expect(screen.queryByTestId("feedback-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("feedback-ledger-content")).toBeNull();
    // R123: the Clear button is ALWAYS PRESENT — disabled with the honest
    // "nothing to clear yet" tooltip (the owner's first-sight complaint:
    // the delete affordance must not appear only after data exists).
    const clearButton = screen.getByTestId("feedback-clear-button");
    expect(clearButton.hasAttribute("disabled")).toBe(true);
    expect(clearButton.getAttribute("title")).toContain("Nothing to clear yet");
    expect(screen.getByTestId("feedback-copy-button").hasAttribute("disabled")).toBe(true);
  });

  it("R123: the loaded state — the PARSED view is the DEFAULT (the structured entry card), and the RAW toggle keeps the R122 file-as-is block", async () => {
    vi.mocked(fetchFeedbackLedger).mockResolvedValue({
      exists: true,
      content:
        "# ACUTE-CODE — Agent Self-Feedback Ledger\n\n---\n\n## Entry — 2026-09-23T15:04:05Z\n\n- **Session**: \"DASHBOARD\" (sess_1)\n- **Project**: A (a-1)\n- **Agent**: Acute · model-x\n- **Turn outcome**: ok\n- **Transcript**: 12 events · full\n\n### What I was trying to do\nFix the login bug.\n\n### What actually happened\nIt was fixed.",
      bytes: 4321,
      updatedAt: "2026-09-23T15:04:06Z",
      entries: 1,
    });
    renderWithProviders(<SelfFeedbackTab />);
    // The PARSED view renders FIRST (R123's default) — one structured card
    // with the outcome chip, the placement meta, and the labeled sections.
    const list = await screen.findByTestId("feedback-parsed-list");
    expect(list.textContent).toContain("Fix the login bug.");
    expect(list.textContent).toContain("It was fixed.");
    expect(screen.getByTestId("feedback-entry-outcome").textContent).toContain("ok");
    expect(screen.getByTestId("feedback-entry-card").getAttribute("data-entry-index")).toBe("0");
    // The raw block does NOT render until the toggle asks for it.
    expect(screen.queryByTestId("feedback-ledger-content")).toBeNull();
    fireEvent.click(screen.getByTestId("feedback-view-raw"));
    const block = await screen.findByTestId("feedback-ledger-content");
    // The RAW file, as-is — the viewer never re-renders or summarizes it.
    expect(block.textContent).toContain("# ACUTE-CODE — Agent Self-Feedback Ledger");
    expect(block.textContent).toContain("## Entry — 2026-09-23T15:04:05Z");
    expect(block.textContent).toContain("### What I was trying to do");
    expect(block.getAttribute("aria-read-only")).toBe("true");
    const meta = screen.getByTestId("feedback-ledger-meta");
    expect(meta.textContent).toContain("1 entry");
    expect(meta.textContent).toContain("4.2 KB");
    expect(meta.textContent).toContain("updated ");
    // The Clear affordance is present AND enabled with data.
    const clearButton = screen.getByTestId("feedback-clear-button");
    expect(clearButton.hasAttribute("disabled")).toBe(false);
  });

  it("Copy writes the WHOLE raw file to the clipboard", async () => {
    const content = "# ACUTE-CODE — Agent Self-Feedback Ledger\n\n## Entry — x\n\nbody";
    vi.mocked(fetchFeedbackLedger).mockResolvedValue({
      exists: true,
      content,
      bytes: 52,
      updatedAt: "2026-09-23T15:04:06Z",
      entries: 1,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithProviders(<SelfFeedbackTab />);
    // The copy works from the DEFAULT parsed view too (it copies the FILE,
    // never the parse) — wait for the parsed list, then copy.
    await screen.findByTestId("feedback-parsed-list");
    fireEvent.click(screen.getByTestId("feedback-copy-button"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(content);
    });
    await waitFor(() => {
      expect(screen.getByText("Copied")).toBeTruthy();
    });
  });

  it("Clear rides the styled ConfirmDialog (never window.confirm), then DELETEs and converges to the empty state", async () => {
    const first: FeedbackLedgerFile = {
      exists: true,
      content: "# ACUTE-CODE — Agent Self-Feedback Ledger\n\n## Entry — a\n\none\n\n## Entry — b\n\ntwo",
      bytes: 80,
      updatedAt: "2026-09-23T15:04:06Z",
      entries: 2,
    };
    let ledger: FeedbackLedgerFile = { ...first };
    vi.mocked(fetchFeedbackLedger).mockImplementation(async () => ({ ...ledger }));
    vi.mocked(clearFeedbackLedger).mockImplementation(async () => {
      ledger = { exists: false, content: "", bytes: 0, updatedAt: null, entries: 0 };
      return { cleared: true, entries: 2 };
    });
    const windowConfirm = vi.spyOn(window, "confirm").mockImplementation(() => true);
    try {
      renderWithProviders(<SelfFeedbackTab />);
      await screen.findByTestId("feedback-parsed-list");
      fireEvent.click(screen.getByTestId("feedback-clear-button"));
      // The styled dialog — with the honest entry count in the message.
      expect(await screen.findByText("Clear the feedback ledger")).toBeTruthy();
      expect(screen.getByText(/Delete all 2 entries/i)).toBeTruthy();
      expect(windowConfirm).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Clear ledger" }));
      await waitFor(() => {
        expect(clearFeedbackLedger).toHaveBeenCalledTimes(1);
      });
      // The refetch converges to the honest empty state.
      expect(await screen.findByText("No feedback yet")).toBeTruthy();
      expect(windowConfirm).not.toHaveBeenCalled();
    } finally {
      windowConfirm.mockRestore();
    }
  });

  it("R123: the PER-ENTRY delete — the styled confirm, DELETE /feedback/file/entry/:index, and the survivors re-render", async () => {
    const entryA =
      "## Entry — 2026-09-23T15:04:05Z\n\n- **Session**: \"A\" (s1)\n- **Turn outcome**: ok\n\n### What I was trying to do\nFirst.";
    const entryB =
      "## Entry — 2026-09-23T16:04:05Z\n\n- **Session**: \"B\" (s2)\n- **Turn outcome**: failed\n\n### What I was trying to do\nSecond.";
    let content = `# ACUTE-CODE — Agent Self-Feedback Ledger\n\n---\n\n${entryA}\n\n---\n\n${entryB}\n`;
    let entries = 2;
    vi.mocked(fetchFeedbackLedger).mockImplementation(async () => ({
      exists: true,
      content,
      bytes: content.length,
      updatedAt: "2026-09-23T16:04:06Z",
      entries,
    }));
    vi.mocked(deleteFeedbackEntry).mockImplementation(async (index: number) => {
      // The route's own contract: the split/join removes exactly one entry.
      const parts = content.split("\n---\n\n## Entry — ");
      parts.splice(index + 1, 1);
      content = parts.join("\n---\n\n## Entry — ");
      entries -= 1;
      return { removed: true, entries };
    });
    const windowConfirm = vi.spyOn(window, "confirm").mockImplementation(() => true);
    try {
      renderWithProviders(<SelfFeedbackTab />);
      const list = await screen.findByTestId("feedback-parsed-list");
      expect(list.textContent).toContain("First.");
      expect(list.textContent).toContain("Second.");

      // Delete the FIRST entry (index 0) via its card's trash button.
      const cards = screen.getAllByTestId("feedback-entry-delete");
      fireEvent.click(cards[0]!);
      expect(await screen.findByText("Delete this entry")).toBeTruthy();
      expect(screen.getByText(/Delete entry #1/i)).toBeTruthy();
      expect(windowConfirm).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
      await waitFor(() => {
        expect(deleteFeedbackEntry).toHaveBeenCalledWith(0);
      });
      // The refetch re-renders the SURVIVOR only.
      await waitFor(() => {
        expect(screen.queryByText("First.")).toBeNull();
      });
      expect(screen.getByTestId("feedback-parsed-list").textContent).toContain("Second.");
    } finally {
      windowConfirm.mockRestore();
    }
  });

  it("R123: the PARSER — the pure grammar pins (the header fields, the sections, the tolerant nulls)", () => {
    const content =
      "# ACUTE-CODE — Agent Self-Feedback Ledger\n\nSome file header prose.\n\n---\n\n## Entry — 2026-09-23T17:00:00Z\n\n- **Session**: \"Nvd\" (sess_2)\n- **Project**: B (b-1)\n- **Agent**: Acute · openrouter/x\n- **Turn outcome**: ok\n- **Transcript**: 60 events · full\n\n### What I was trying to do\nCreate a claymorphism page.\n\n### Suggested improvements\n1. Add focus styles.\n2. Responsive grids.\n\n---\n\n## Entry — bare\n\nNo fields, no sections.";
    const parsed = parseFeedbackEntries(content);
    expect(parsed).toHaveLength(2);
    const first = parsed[0]!;
    expect(first.index).toBe(0);
    expect(first.timestamp).toBe("2026-09-23T17:00:00Z");
    expect(first.session).toContain("Nvd");
    expect(first.project).toBe("B (b-1)");
    expect(first.agent).toContain("openrouter/x");
    expect(first.outcome).toBe("ok");
    expect(first.transcript).toBe("60 events · full");
    expect(first.sections).toHaveLength(2);
    expect(first.sections[0]!.title).toBe("What I was trying to do");
    expect(first.sections[0]!.body).toContain("claymorphism");
    expect(first.sections[1]!.body).toContain("Responsive grids.");
    // The tolerant second entry: no fields, no sections — nulls, never a crash.
    const second = parsed[1]!;
    expect(second.timestamp).toBe("bare");
    expect(second.session).toBeNull();
    expect(second.outcome).toBeNull();
    expect(second.sections).toHaveLength(0);
    // Empty content parses to nothing.
    expect(parseFeedbackEntries("")).toHaveLength(0);
    expect(parseFeedbackEntries("   ")).toHaveLength(0);
  });

  it("a failed ledger GET renders the retryable error card — never an eternal spinner", async () => {
    vi.mocked(fetchFeedbackLedger).mockRejectedValue(new Error("HTTP 503 — no data directory"));
    renderWithProviders(<SelfFeedbackTab />);
    expect(await screen.findByText("Could not load the feedback ledger")).toBeTruthy();
    expect(screen.getByText(/HTTP 503/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading the feedback ledger" })).toBeTruthy();
    expect(screen.queryByTestId("feedback-ledger-content")).toBeNull();
  });
});
