// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  clearAll,
  errors,
  reportAppError,
} from "../../lib/error-bus";
import { clearDiagnosticErrors, listDiagnosticErrors } from "../../lib/api";
import { ConsolePanel } from "./ConsolePanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

/**
 * ROUND-59 (R59-E): pins for the right-sidebar Console tab — the owner's
 * "proper console-like error monitoring and error handling". The panel merges
 * the REAL frontend error bus (live module — not mocked, so the merge path is
 * exercised) with the mocked /diagnostics/errors REST surface.
 */

vi.mock("../../lib/api", () => ({
  listDiagnosticErrors: vi.fn(),
  clearDiagnosticErrors: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  resetTestState();
  clearAll();
  vi.mocked(listDiagnosticErrors).mockReset().mockResolvedValue([]);
  vi.mocked(clearDiagnosticErrors).mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });
});

const tab: RightSidebarTab = {
  id: "tab-console",
  type: "console",
  title: "Console",
  createdAt: Date.now(),
};

function sidecarRow(m: {
  id: string;
  message: string;
  statusCode?: number;
  method?: string;
  url?: string;
  code?: string;
  ts?: string;
}) {
  return {
    id: m.id,
    ts: m.ts ?? new Date().toISOString(),
    source: "sidecar" as const,
    kind: "http",
    statusCode: m.statusCode ?? 500,
    code: m.code ?? "INTERNAL",
    message: m.message,
    method: m.method ?? "GET",
    url: m.url ?? "/api/v1/some/route",
    count: 1,
  };
}

describe("ConsolePanel (R59-E)", () => {
  it("renders the empty state when neither half has errors", async () => {
    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);

    expect(await screen.findByText("No errors captured")).toBeTruthy();
    expect(
      screen.getByText(/The console records frontend and engine errors as they happen\./),
    ).toBeTruthy();
    expect(screen.getByTestId("console-count").textContent).toBe("0 errors");
    expect(screen.queryByTestId("console-entry")).toBeNull();
  });

  it("renders frontend + engine entries newest-first with kind chips and count badges", async () => {
    vi.mocked(listDiagnosticErrors).mockResolvedValue([
      sidecarRow({ id: "diag_1", message: "boom: the engine tripped", method: "POST", url: "/api/v1/x" }),
    ]);
    reportAppError({ source: "frontend", kind: "query", message: "Could not reach agent-core" });
    // Identical consecutive reports merge into ×3.
    reportAppError({ source: "frontend", kind: "query", message: "Could not reach agent-core" });
    reportAppError({ source: "frontend", kind: "query", message: "Could not reach agent-core" });

    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);

    // Both halves render.
    expect(await screen.findByText("boom: the engine tripped")).toBeTruthy();
    expect(screen.getAllByText("Could not reach agent-core").length).toBeGreaterThanOrEqual(1);

    // Kind chips carry source + kind.
    expect(screen.getByText("sidecar/http")).toBeTruthy();
    expect(screen.getByText("frontend/query")).toBeTruthy();

    // The deduped frontend row shows the ×3 badge; the sidecar row does not.
    const rows = screen.getAllByTestId("console-entry");
    expect(rows).toHaveLength(2);
    const frontendRow = rows.find((r) => r.getAttribute("data-entry-source") === "frontend");
    const sidecarRowEl = rows.find((r) => r.getAttribute("data-entry-source") === "sidecar");
    expect(frontendRow?.querySelector('[data-testid="console-entry-count"]')?.textContent).toBe("×3");
    expect(sidecarRowEl?.querySelector('[data-testid="console-entry-count"]')).toBeNull();

    // Header count chip reflects the merged total.
    expect(screen.getByTestId("console-count").textContent).toBe("2 errors");
  });

  it("click-to-expand reveals the full detail + component stack in a <pre>", async () => {
    vi.mocked(listDiagnosticErrors).mockResolvedValue([]);
    reportAppError({
      source: "frontend",
      kind: "render",
      message: "Something exploded in ProjectView",
      detail: "TypeError: cannot read 'id' of undefined",
      componentStack: "at ProjectView (ProjectView.tsx:42:5)\n  at ErrorBoundary",
    });
    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);

    const row = await screen.findByTestId("console-entry");
    expect(screen.queryByTestId("console-entry-detail")).toBeNull();

    fireEvent.click(row.querySelector('[aria-label^="Toggle detail"]') as HTMLElement);
    const detail = await screen.findByTestId("console-entry-detail");
    expect(detail.tagName).toBe("PRE");
    expect(detail.textContent).toContain("TypeError: cannot read 'id' of undefined");
    expect(detail.textContent).toContain("at ProjectView (ProjectView.tsx:42:5)");
    expect(detail.textContent).toContain("at ErrorBoundary");

    // Click again → collapses.
    fireEvent.click(row.querySelector('[aria-label^="Toggle detail"]') as HTMLElement);
    expect(screen.queryByTestId("console-entry-detail")).toBeNull();
  });

  it("the row Copy button writes the full formatted entry to the clipboard", async () => {
    vi.mocked(listDiagnosticErrors).mockResolvedValue([
      sidecarRow({ id: "diag_2", message: "boom: the engine tripped", method: "POST", url: "/api/v1/x" }),
    ]);
    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);
    await screen.findByText("boom: the engine tripped");

    fireEvent.click(screen.getByRole("button", { name: /Copy error: boom: the engine tripped/i }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1),
    );
    const payload = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(payload).toContain("sidecar/http");
    expect(payload).toContain("boom: the engine tripped");
    // The sidecar detail line (method + url + status) rides along.
    expect(payload).toContain("POST /api/v1/x");
    expect(payload).toContain("HTTP 500");
  });

  it("Clear all DELETEs the engine ring AND empties the frontend bus", async () => {
    // Dynamic listing: the ring empties once the engine-side DELETE lands
    // (the panel invalidates + refetches after clearing).
    let ringRows = [sidecarRow({ id: "diag_3", message: "engine boom" })];
    vi.mocked(listDiagnosticErrors).mockImplementation(async () => ringRows);
    reportAppError({ source: "frontend", kind: "query", message: "frontend boom" });
    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);

    expect(await screen.findByText("engine boom")).toBeTruthy();
    expect(screen.getByText("frontend boom")).toBeTruthy();
    expect(errors()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Clear all errors/i }));
    // The engine ring is empty from this point (the DELETE cleared it) — any
    // subsequent GET (the panel's post-clear invalidate) sees [].
    ringRows = [];
    await waitFor(() => expect(clearDiagnosticErrors).toHaveBeenCalledTimes(1));

    // The frontend bus is empty and the listing is refetched (invalidated).
    await waitFor(() => expect(errors()).toHaveLength(0));
    await waitFor(() => expect(vi.mocked(listDiagnosticErrors).mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByTestId("console-count").textContent).toBe("0 errors"));
    expect(screen.queryByTestId("console-entry")).toBeNull();
  });

  it("per-row dismiss removes the row (frontend rows dismiss in the bus)", async () => {
    vi.mocked(listDiagnosticErrors).mockResolvedValue([]);
    reportAppError({ source: "frontend", kind: "render", message: "dismissable error" });
    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);

    expect(await screen.findByText("dismissable error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss error: dismissable error/i }));

    await waitFor(() => expect(screen.queryByTestId("console-entry")).toBeNull());
    expect(errors()).toHaveLength(0); // the bus row itself is gone
  });

  it("shows the load-error card with Try again when the sidecar fails and nothing else is showing", async () => {
    vi.mocked(listDiagnosticErrors).mockRejectedValue(new Error("sidecar down"));
    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);

    expect(await screen.findByText("Couldn't load engine errors")).toBeTruthy();
    expect(screen.getByText("sidecar down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => expect(listDiagnosticErrors).toHaveBeenCalledTimes(2));
  });

  it("keeps the frontend list visible (with a danger note) when the engine poll fails mid-flight", async () => {
    vi.mocked(listDiagnosticErrors).mockRejectedValue(new Error("sidecar down"));
    reportAppError({ source: "frontend", kind: "window.onerror", message: "frontend-only error" });
    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);

    // The frontend row still renders; the engine failure is a note, not a
    // full-panel takeover.
    expect(await screen.findByText("frontend-only error")).toBeTruthy();
    const note = await screen.findByTestId("console-sidecar-error-note");
    expect(note.textContent).toContain("sidecar down");
    expect(screen.queryByText("Couldn't load engine errors")).toBeNull();
  });

  it("polls the engine ring on the 5s cadence", async () => {
    vi.mocked(listDiagnosticErrors).mockResolvedValue([]);
    vi.useFakeTimers();
    try {
      renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);
      // Initial fetch fires on mount.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(listDiagnosticErrors).toHaveBeenCalledTimes(1);

      // 5s later the refetchInterval timer fires → a second poll.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(vi.mocked(listDiagnosticErrors).mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the query hits GET /diagnostics/errors with the 50-row page", async () => {
    renderWithProviders(<ConsolePanel projectId="prj_1" tab={tab} />);
    await waitFor(() => expect(listDiagnosticErrors).toHaveBeenCalledWith(50));
  });
});
