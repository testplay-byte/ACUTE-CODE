// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ThinkingStoppedCard } from "./AgentChatPanel";
import { renderWithProviders, resetTestState } from "../../test-utils";

/**
 * ROUND-97 (R97-D) — the THINKING-STOPPED card: the thinking-loop guard's OWN
 * presentation. The owner's report, verbatim: "The thinking loop stopping and
 * other things like that should not be shown as errors like 'generation
 * failed.' These should be highlighted in a separate way."
 *
 * Pins:
 *  · role=status (NEVER alert — this is a configured intervention, not a
 *    provider failure), the amber Brain presentation, and the copy carries
 *    NO "Generation failed" text anywhere.
 *  · The Settings pointer (Settings → General — where the guard's switch
 *    lives) + the model chip.
 *  · The Retry affordance wires through when provided; nothing renders when
 *    it is not.
 */
afterEach(cleanup);

const ERROR_FIXTURE = {
  code: "PROVIDER_ERROR",
  message: "the model produced reasoning with no progress",
  ts: "2026-09-14T12:00:00.000Z",
  model: "deepseek/deepseek-v4.1-flash:free",
  errorClass: "thinking_loop",
  attempts: 2,
} as const;

beforeEach(() => {
  resetTestState();
});

describe("ThinkingStoppedCard (ROUND-97 R97-D)", () => {
  it("renders role=status with the amber guard copy — NEVER 'Generation failed'", () => {
    renderWithProviders(<ThinkingStoppedCard error={ERROR_FIXTURE} />);
    const card = screen.getByTestId("thinking-stopped-card");
    expect(card.getAttribute("role")).toBe("status");
    expect(screen.getByText("Thinking stopped by the guard")).toBeTruthy();
    // The exact phrase the owner rejected must appear NOWHERE in the card.
    expect(card.textContent).not.toContain("Generation failed");
    expect(screen.queryByRole("alert")).toBeNull();
    // The guard's own explanation + the thresholds story ride along.
    expect(card.textContent).toContain("one de-escalating retry");
    expect(card.textContent).toContain("not a provider failure");
  });

  it("carries the Settings pointer + the model chip", () => {
    renderWithProviders(<ThinkingStoppedCard error={ERROR_FIXTURE} />);
    const settingsLink = screen.getByText("Settings → General");
    expect(settingsLink.getAttribute("href")).toBe("/settings?tab=advanced");
    expect(screen.getByText(ERROR_FIXTURE.model)).toBeTruthy();
  });

  it("the Retry affordance wires through when provided; absent otherwise", () => {
    const onRetry = vi.fn();
    const first = renderWithProviders(<ThinkingStoppedCard error={ERROR_FIXTURE} onRetry={onRetry} />);
    const retry = screen.getByText("Retry");
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    first.unmount();
    renderWithProviders(<ThinkingStoppedCard error={ERROR_FIXTURE} />);
    expect(screen.queryByText("Retry")).toBeNull();
  });
});
