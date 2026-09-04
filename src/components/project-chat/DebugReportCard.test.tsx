// @vitest-environment happy-dom
/**
 * ROUND-66 (R66-2-c) tests — DebugReportCard, the dedicated debug-report
 * section at the bottom of a turn (the owner's C1 directive: a FRESH
 * context-free analyst streams its analysis after the turn completes; the
 * card renders it live while streaming and folded after reload).
 *
 * Covers: the streaming state (spinner + "Analyzing the last execution…" +
 * the LIVE partial markdown), the done state (full markdown + model chip),
 * the error state (honest amber line, no markdown), the header anatomy
 * (label + "context-free analyst" subtitle), and the quiet
 * streaming-with-no-text-yet placeholder.
 *
 * NOTE: ChatMarkdown renders headings as styled divs (not <h1>..) — the
 * assertions below are text-content based for that reason.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { DebugReportCard } from "./DebugReportCard";
import { resetTestState, renderWithProviders } from "../../test-utils";

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

const REPORT_MD =
  "## What the task was\n\nWrite `a.txt`.\n\n## Failures & anomalies\n\n- write_file failed: no permission";

describe("DebugReportCard (ROUND-66 R66-2-c)", () => {
  it("streaming: shows the loading status + the partial text as live markdown", () => {
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
  });

  it("streaming with NO text yet: the loading placeholder is the whole body", () => {
    renderWithProviders(<DebugReportCard report={{ state: "streaming", text: "" }} />);
    expect(screen.getAllByText("Analyzing the last execution…").length).toBeGreaterThan(0);
    // The quiet placeholder row is rendered inside the body.
    expect(screen.getByTestId("debug-report-body").textContent).toContain("Analyzing the last execution…");
  });

  it("done: renders the full markdown report + the Done status", () => {
    renderWithProviders(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);
    expect(screen.getByTestId("debug-report-status").textContent).toContain("Done");
    const body = screen.getByTestId("debug-report-body");
    expect(body.textContent).toContain("What the task was");
    expect(body.textContent).toContain("Failures & anomalies");
    expect(body.textContent).toContain("no permission");
    expect(screen.queryByText("Analyzing the last execution…")).toBeNull();
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

  it("header: Debug report label + the honest 'context-free analyst' subtitle", () => {
    renderWithProviders(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);
    expect(screen.getAllByText("Debug report").length).toBeGreaterThan(0);
    expect(screen.getByText("context-free analyst")).toBeTruthy();
  });

  it("error: an honest amber line, no markdown, no spinner", () => {
    renderWithProviders(
      <DebugReportCard report={{ state: "error", text: "", error: "provider 'openrouter' call failed: 429" }} />,
    );
    // The amber line carries the reason.
    expect(screen.getByRole("alert").textContent).toContain("429");
    expect(screen.getByTestId("debug-report-status").textContent).toContain("Analysis failed");
    // No markdown body, no streaming placeholder.
    const body = screen.getByTestId("debug-report-body");
    expect(body.textContent).not.toContain("What the task was");
    expect(screen.queryByText("Analyzing the last execution…")).toBeNull();
  });

  it("error without a message: the honest fallback line renders", () => {
    renderWithProviders(<DebugReportCard report={{ state: "error", text: "" }} />);
    expect(screen.getByRole("alert").textContent).toContain("failed to produce a report");
  });

  it("the card carries the data-testids the panel/tests key off", () => {
    renderWithProviders(<DebugReportCard report={{ state: "done", text: REPORT_MD }} />);
    expect(screen.getByTestId("debug-report-card")).toBeTruthy();
    expect(screen.getByTestId("debug-report-status")).toBeTruthy();
    expect(screen.getByTestId("debug-report-body")).toBeTruthy();
  });
});
