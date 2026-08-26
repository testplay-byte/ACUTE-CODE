// @vitest-environment happy-dom
/**
 * ROUND-43 frontend tests — the chat error card + retry (owner: failed turns
 * "outright silently die… no error message, no retry option").
 *
 *  1. TurnErrorCard renders (title / model chip / reason / actions), Retry
 *     invokes the bound retry handler, and Copy details writes the model +
 *     error + timestamp + session id to the clipboard.
 *  2. Retry is disabled while the session is mid-stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { TurnErrorCard } from "./AgentChatPanel";
import { resetTestState, renderWithProviders } from "../../test-utils";

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

const ERROR_ITEM = {
  kind: "error" as const,
  seq: 5,
  code: "PROVIDER_ERROR",
  message: "provider 'openrouter' call failed for session sess_x",
  model: "z-ai/glm-5.2:free",
  providerId: "openrouter",
  providerError: "429 Too Many Requests: rate limited",
  userSeq: 4,
  ts: "2026-08-26T14:05:00.000Z",
};

describe("TurnErrorCard (ROUND-43)", () => {
  it("renders the error card with title, model chip, reason, and actions", () => {
    renderWithProviders(
      <TurnErrorCard error={ERROR_ITEM} sessionId="sess_x" onRetry={() => undefined} />,
    );

    expect(screen.getAllByText("Generation failed").length).toBeGreaterThan(0);
    expect(screen.getByText("z-ai/glm-5.2:free")).toBeTruthy();
    expect(screen.getByText(/429 Too Many Requests/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry the failed message/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy error details/i })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("Retry re-invokes the send path with the same failed user message", () => {
    const onRetry = vi.fn();
    renderWithProviders(<TurnErrorCard error={ERROR_ITEM} sessionId="sess_x" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: /retry the failed message/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("Retry is disabled while the session is mid-stream", () => {
    renderWithProviders(
      <TurnErrorCard error={ERROR_ITEM} sessionId="sess_x" onRetry={() => undefined} disabled />,
    );
    const retry = screen.getByRole("button", { name: /retry the failed message/i }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
  });

  it("Copy details writes model, error, timestamp, and session id to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderWithProviders(<TurnErrorCard error={ERROR_ITEM} sessionId="sess_x" />);

    fireEvent.click(screen.getByRole("button", { name: /copy error details/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("z-ai/glm-5.2:free");
    expect(text).toContain("429 Too Many Requests");
    expect(text).toContain("2026-08-26T14:05:00.000Z");
    expect(text).toContain("sess_x");
    // The "Copied" flash replaces the label after the clipboard write.
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
  });
});
