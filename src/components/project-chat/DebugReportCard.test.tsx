// @vitest-environment happy-dom
/**
 * ROUND-66 (R66-2-c) tests — DebugReportCard, the dedicated debug-report
 * section at the bottom of a turn (the owner's C1 directive: a FRESH
 * context-free analyst streams its analysis after the turn completes; the
 * card renders it live while streaming and folded after reload).
 *
 * ROUND-67 (R67-B) additions — the owner's chat-UX directives:
 * - the card COLLAPSES itself: expanded while streaming, auto-collapses on
 *   the streaming→done flip, a manual header tap wins over the automation
 *   (userTouched), and a folded (done) card mounts collapsed;
 * - "There should be a proper copy button at the very bottom of the debug
 *   report" — the Copy report footer (visible even while collapsed, since
 *   it sits OUTSIDE the collapsible body) writing
 *   buildDebugReportCopyText(report) = "Debug report — model: <model>\n\n<text>".
 *
 * NOTE: ChatMarkdown renders headings as styled divs (not <h1>..) — the
 * assertions below are text-content based for that reason.
 *
 * NOTE (R67-B): AnimatePresence keeps the body mounted through its 220ms
 * exit animation — the collapse assertions use waitFor (real timers), the
 * same class of wait the Copy-details flash test uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { DebugReportCard, buildDebugReportCopyText } from "./DebugReportCard";
import { resetTestState, renderWithProviders } from "../../test-utils";

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

const REPORT_MD =
  "## What the task was\n\nWrite `a.txt`.\n\n## Failures & anomalies\n\n- write_file failed: no permission";

/**
 * R67-B: render with a PERSISTED wrapper so `rerender` keeps the same
 * component instance across prop changes (RTL's plain rerender replaces
 * the inline provider tree that renderWithProviders builds, which would
 * remount the card and reset the collapse state — the flip tests need the
 * REAL streaming→done transition, not a fresh mount).
 */
function renderCardForRerender(initial: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(initial, { wrapper: Wrapper });
}

/** The clipboard mock style TurnErrorCard.test.tsx pins. */
function mockClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

/** The header toggle's accessible name (collapsed form). */
const EXPAND_BUTTON = { name: "Expand debug report" };
const COLLAPSE_BUTTON = { name: "Collapse debug report" };

describe("DebugReportCard (ROUND-66 R66-2-c + ROUND-67 R67-B)", () => {
  it("streaming: shows the loading status + the partial text as live markdown (expanded)", () => {
    renderWithProviders(
      <DebugReportCard report={{ state: "streaming", text: "## What the task was\n\nWrite `a.txt`." }} />,
    );

    expect(screen.getByTestId("debug-report-card")).toBeTruthy();
    expect(screen.getByTestId("debug-report-status").textContent).toContain("Analyzing the last execution…");
    // The partial markdown renders (heading + inline code) — the owner
    // watches the analysis stream in.
    const body = screen.getByTestId("debug-report-body");
    expect(body.textContent).toContain("What the task was");
    expect(body.textContent).toContain("a.txt");
    // No terminal state yet.
    expect(screen.queryByText("Done")).toBeNull();
    // R67-B: expanded WHILE streaming (the owner watches it type).
    expect(screen.getByRole("button", COLLAPSE_BUTTON).getAttribute("aria-expanded")).toBe("true");
  });

  it("streaming with NO text yet: the loading placeholder is the whole body", () => {
    renderWithProviders(<DebugReportCard report={{ state: "streaming", text: "" }} />);
    expect(screen.getAllByText("Analyzing the last execution…").length).toBeGreaterThan(0);
    // The quiet placeholder row is rendered inside the body.
    expect(screen.getByTestId("debug-report-body").textContent).toContain("Analyzing the last execution…");
    // R67-B: no Copy report button until the report is DONE.
    expect(screen.queryByRole("button", { name: /copy debug report/i })).toBeNull();
  });

  it("done: COLLAPSED by default — the header status shows Done, the body is minimized", async () => {
    renderWithProviders(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);
    expect(screen.getByTestId("debug-report-status").textContent).toContain("Done");
    // Collapsed: the toggle reads Expand, the markdown body is gone (the
    // card minimized itself — the folded/reloaded card mounts minimized).
    expect(screen.getByRole("button", EXPAND_BUTTON).getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(screen.queryByText("What the task was")).toBeNull());
    expect(screen.queryByTestId("debug-report-body")).toBeNull();
    expect(screen.queryByText("Analyzing the last execution…")).toBeNull();
  });

  it("done: expanding the header renders the full markdown report", async () => {
    renderWithProviders(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);
    fireEvent.click(screen.getByRole("button", EXPAND_BUTTON));
    expect(screen.getByTestId("debug-report-status").textContent).toContain("Done");
    const body = screen.getByTestId("debug-report-body");
    expect(body.textContent).toContain("What the task was");
    expect(body.textContent).toContain("Failures & anomalies");
    expect(body.textContent).toContain("no permission");
    expect(screen.queryByText("Analyzing the last execution…")).toBeNull();
    // The toggle flips (aria-expanded + the accessible name).
    expect(screen.getByRole("button", COLLAPSE_BUTTON).getAttribute("aria-expanded")).toBe("true");
    // Collapsing again hides the body (AnimatePresence keeps the exit child
    // mounted through its 220ms animation — waitFor for the removal).
    fireEvent.click(screen.getByRole("button", COLLAPSE_BUTTON));
    await waitFor(() => expect(screen.queryByTestId("debug-report-body")).toBeNull());
  });

  it("R67-B: auto-collapse — the streaming→done flip collapses the card by itself", async () => {
    const { rerender } = renderCardForRerender(
      <DebugReportCard report={{ state: "streaming", text: "## What the task was" }} />,
    );
    // Streaming: expanded, body visible.
    expect(screen.getByRole("button", COLLAPSE_BUTTON).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("What the task was")).toBeTruthy();

    // The store patches the SAME card in place (state streaming → done).
    rerender(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);

    // "when it has properly typed it will collapse… by itself."
    expect(screen.getByRole("button", EXPAND_BUTTON).getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(screen.queryByText("What the task was")).toBeNull());
  });

  it("R67-B: a manual tap WINS over the auto-collapse (userTouched)", async () => {
    const { rerender } = renderCardForRerender(
      <DebugReportCard report={{ state: "done", text: REPORT_MD }} />,
    );
    // Collapsed by default → the user EXPANDS it (userTouched from now on).
    fireEvent.click(screen.getByRole("button", EXPAND_BUTTON));
    expect(screen.getByTestId("debug-report-body").textContent).toContain("What the task was");

    // A later streaming→done flip must NOT collapse the user's card.
    rerender(<DebugReportCard report={{ state: "streaming", text: "## What the task was" }} />);
    rerender(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);

    expect(screen.getByRole("button", COLLAPSE_BUTTON).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("debug-report-body").textContent).toContain("What the task was");
  });

  it("done: the model chip shows the analysis model (absent → no chip)", () => {
    const { unmount } = renderWithProviders(
      <DebugReportCard report={{ state: "done", text: REPORT_MD, model: "test/analyst-1" }} />,
    );
    expect(screen.getByText("test/analyst-1")).toBeTruthy();

    unmount();
    cleanup();
    renderWithProviders(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);
    expect(screen.queryByText("test/analyst-1")).toBeNull();
  });

  it("header: Debug report label + the honest 'context-free analyst' subtitle (collapsed too)", () => {
    renderWithProviders(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);
    expect(screen.getAllByText("Debug report").length).toBeGreaterThan(0);
    expect(screen.getByText("context-free analyst")).toBeTruthy();
  });

  it("error: an honest amber line (expand to read), no markdown, no spinner", () => {
    renderWithProviders(
      <DebugReportCard report={{ state: "error", text: "", error: "provider 'openrouter' call failed: 429" }} />,
    );
    // The header carries the amber status even while collapsed.
    expect(screen.getByTestId("debug-report-status").textContent).toContain("Analysis failed");
    fireEvent.click(screen.getByRole("button", EXPAND_BUTTON));
    // The amber line carries the reason.
    expect(screen.getByRole("alert").textContent).toContain("429");
    // No markdown body, no streaming placeholder.
    const body = screen.getByTestId("debug-report-body");
    expect(body.textContent).not.toContain("What the task was");
    expect(screen.queryByText("Analyzing the last execution…")).toBeNull();
  });

  it("error without a message: the honest fallback line renders", () => {
    renderWithProviders(<DebugReportCard report={{ state: "error", text: "" }} />);
    fireEvent.click(screen.getByRole("button", EXPAND_BUTTON));
    expect(screen.getByRole("alert").textContent).toContain("failed to produce a report");
  });

  it("the card carries the data-testids the panel/tests key off (body when open)", () => {
    renderWithProviders(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);
    expect(screen.getByTestId("debug-report-card")).toBeTruthy();
    expect(screen.getByTestId("debug-report-status")).toBeTruthy();
    // R67-B: the body testid rides the collapsible region — present when
    // open, absent when minimized.
    expect(screen.queryByTestId("debug-report-body")).toBeNull();
    fireEvent.click(screen.getByRole("button", EXPAND_BUTTON));
    expect(screen.getByTestId("debug-report-body")).toBeTruthy();
  });

  it("R67-B: Copy report writes the model + the full text to the clipboard (works while collapsed)", async () => {
    const writeText = mockClipboard();
    renderWithProviders(
      <DebugReportCard report={{ state: "done", text: REPORT_MD, model: "test/analyst-1" }} />,
    );

    // The button sits at the very bottom of the card, OUTSIDE the
    // collapsible body — the minimized card still offers the copy.
    const copyButton = screen.getByRole("button", { name: /copy debug report/i });
    expect(copyButton.textContent).toContain("Copy report");
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toBe("Debug report — model: test/analyst-1\n\n" + REPORT_MD);
    // The owner's "properly show the details… which model was being used":
    // the copy carries the model + the report's section headings.
    expect(text).toContain("test/analyst-1");
    expect(text).toContain("Failures & anomalies");
    // The "Copied" flash replaces the label after the clipboard write.
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
  });

  it("R67-B: NO copy button while the report is still streaming (nothing final to copy)", () => {
    renderWithProviders(
      <DebugReportCard report={{ state: "streaming", text: "## What the task was" }} />,
    );
    expect(screen.queryByRole("button", { name: /copy debug report/i })).toBeNull();
  });

  it("R67-B: an error or an empty done report offers no copy (honest empty payload)", () => {
    renderWithProviders(<DebugReportCard report={{ state: "error", text: "", error: "boom" }} />);
    expect(screen.queryByRole("button", { name: /copy debug report/i })).toBeNull();
    cleanup();
    renderWithProviders(<DebugReportCard report={{ state: "done", text: "" }} />);
    expect(screen.queryByRole("button", { name: /copy debug report/i })).toBeNull();
  });
});

describe("buildDebugReportCopyText (ROUND-67 R67-B — exported for the exact format)", () => {
  it("done + text → the model header line + the full report body", () => {
    expect(buildDebugReportCopyText({ state: "done", text: REPORT_MD, model: "m/x" })).toBe(
      `Debug report — model: m/x\n\n${REPORT_MD}`,
    );
  });

  it("missing model → honest 'unknown' (the owner still sees which slot ran)", () => {
    expect(buildDebugReportCopyText({ state: "done", text: "report" })).toBe(
      "Debug report — model: unknown\n\nreport",
    );
  });

  it("streaming / error / empty-text done → \"\" (nothing final to copy)", () => {
    expect(buildDebugReportCopyText({ state: "streaming", text: "partial" })).toBe("");
    expect(buildDebugReportCopyText({ state: "error", text: "", error: "x" })).toBe("");
    expect(buildDebugReportCopyText({ state: "done", text: "" })).toBe("");
  });
});
