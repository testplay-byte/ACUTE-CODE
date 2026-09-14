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

  it("R97-E (M2 pin): the FOLDED error with usage renders the token-spend chip — nothing fabricated without it", () => {
    // The persisted leg: ErrorTurnItem.usage arrives from the folded
    // turn.error payload (the api.ts mapping, pinned in stream-error.test).
    const { unmount } = renderWithProviders(
      <TurnErrorCard error={{ ...ERROR_ITEM, usage: { inputTokens: 3_800, outputTokens: 460 } }} sessionId="sess_x" onRetry={() => undefined} />,
    );
    const chip = document.querySelector("[data-error-usage]") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe("3.8k sent ↑ · 460 received ↓");

    // Copy details carries the exact numbers too.
    expect(chip.title).toContain("tokens this failed turn actually spent");

    // The SAME card without usage renders NO chip (never a fake 0/0).
    unmount();
    cleanup();
    renderWithProviders(<TurnErrorCard error={ERROR_ITEM} sessionId="sess_x" onRetry={() => undefined} />);
    expect(document.querySelector("[data-error-usage]")).toBeNull();
  });

  it("R97-E (M2 pin): the LIVE error shape (the SSE frame's details.usage) renders the same chip", () => {
    // The live leg: the stream-store maps the error frame's details.usage
    // onto the live error card's input (defensively shaped — the same
    // Pick<> the folded item satisfies).
    renderWithProviders(
      <TurnErrorCard
        error={{
          code: "PROVIDER_ERROR",
          message: "provider 'openrouter' call failed for session sess_x",
          model: "z-ai/glm-5.2:free",
          usage: { inputTokens: 1_500, outputTokens: 120 },
          ts: "2026-08-26T14:05:00.000Z",
        }}
        sessionId="sess_x"
        onRetry={() => undefined}
      />,
    );
    const chip = document.querySelector("[data-error-usage]") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe("1.5k sent ↑ · 120 received ↓");
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

  // ── ROUND-77 (R77): the full-error toggle ────────────────────────────────
  it("R77: a SHORT error renders in full with NO toggle; a LONG error collapses to an excerpt with a Show-full-error toggle that expands the COMPLETE text", () => {
    renderWithProviders(<TurnErrorCard error={ERROR_ITEM} sessionId="sess_x" />);
    // Short (< 240 chars): no toggle, no expandable block.
    expect(screen.queryByRole("button", { name: /show full error/i })).toBeNull();
    expect(document.querySelector("[data-error-full-text]")).toBeNull();

    cleanup();

    // A LONG provider payload (the raw OpenRouter body shape — hundreds of
    // chars): collapsed to the excerpt + the toggle.
    const longError = {
      ...ERROR_ITEM,
      providerError: `429 Too Many Requests — the raw provider body: ${"rate-limit detail ".repeat(40)}(trace id ort-1234)`,
    };
    renderWithProviders(<TurnErrorCard error={longError} sessionId="sess_x" />);
    const toggle = screen.getByRole("button", { name: /show full error/i });
    expect(document.querySelector("[data-error-full-text]")).toBeNull();

    // Expand → the COMPLETE raw text renders in the scrollable mono block
    // (the owner's "show the actual error messages too, which were returned
    // from the API").
    fireEvent.click(toggle);
    const full = document.querySelector("[data-error-full-text]") as HTMLElement;
    expect(full).toBeTruthy();
    expect(full.textContent).toContain("ort-1234");
    expect(full.textContent).toContain("rate-limit detail");

    // Collapse back.
    fireEvent.click(screen.getByRole("button", { name: /show less/i }));
    expect(document.querySelector("[data-error-full-text]")).toBeNull();
  });
});
