// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { clearAll, errors } from "../../lib/error-bus";

/**
 * ROUND-59 (R59-E): pins for the app-level render error boundary — the
 * owner's "proper console-like error monitoring and error handling": a
 * throwing screen must (1) report kind "render" to the error bus WITH the
 * component stack, (2) render the honest fallback card (never a blank
 * window), (3) recover on Retry, and (4) leave the happy path untouched.
 */

beforeEach(() => {
  clearAll();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  clearAll();
});

/** Throws while `detonate` — otherwise renders a marker. */
function Bomb({ detonate }: { detonate: boolean }) {
  if (detonate) throw new Error("kaboom: render exploded");
  return <div data-testid="safe-child">Child rendered fine</div>;
}

describe("ErrorBoundary (R59-E)", () => {
  it("happy path: renders children untouched, no bus entry, no fallback", () => {
    render(
      <ErrorBoundary>
        <Bomb detonate={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("safe-child")).toBeTruthy();
    expect(screen.queryByTestId("render-error-fallback")).toBeNull();
    expect(errors()).toHaveLength(0);
  });

  it("a throwing child reports kind 'render' to the bus (componentStack included) and renders the fallback card", () => {
    render(
      <ErrorBoundary>
        <Bomb detonate={true} />
      </ErrorBoundary>,
    );

    // Honest fallback, never a white screen.
    const fallback = screen.getByTestId("render-error-fallback");
    expect(fallback.textContent).toContain("Something broke rendering this screen");
    expect(fallback.textContent).toContain("kaboom: render exploded");
    // Points the owner at the Console for the full story.
    expect(fallback.textContent).toContain("Console");

    // The bus received the render error with the component stack.
    expect(errors()).toHaveLength(1);
    const row = errors()[0];
    expect(row).toMatchObject({
      source: "frontend",
      kind: "render",
      message: "kaboom: render exploded",
      count: 1,
    });
    expect(row.componentStack).toContain("Bomb");
    expect(row.detail ?? "").toContain("kaboom");
  });

  it("Retry resets the boundary — recovered children render again", () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb detonate={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("render-error-fallback")).toBeTruthy();

    // The condition heals (parent state changes)…
    rerender(
      <ErrorBoundary>
        <Bomb detonate={false} />
      </ErrorBoundary>,
    );
    // …but the boundary still holds the error until Retry is clicked.
    expect(screen.getByTestId("render-error-fallback")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(screen.getByTestId("safe-child")).toBeTruthy();
    expect(screen.queryByTestId("render-error-fallback")).toBeNull();

    // The bus entry stays (Retry recovers the screen, it does not erase the
    // record — that is what Clear all in the Console is for).
    expect(errors()).toHaveLength(1);
  });

  it("Copy diagnostics writes the error + component stack to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(
      <ErrorBoundary>
        <Bomb detonate={true} />
      </ErrorBoundary>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /copy diagnostics/i }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const payload = writeText.mock.calls[0][0] as string;
    expect(payload).toContain("kaboom: render exploded");
    expect(payload).toContain("Bomb"); // the component stack rides along
    expect(payload).toContain("render error diagnostics");
  });
});
