// @vitest-environment happy-dom
/**
 * ROUND-95 (R95-F) tests — the context donut's MEASURED-usage prominence
 * (owner: "It does not properly show the actual context which is currently
 * being used or other stuff like that"), pinned against the R83 CONTEXT-METER
 * contract (docs/runbooks/CONTEXT-METER.md — every number carries its BASIS,
 * never present one as the other):
 *
 *  · the provider's own prompt size (`actual.inputTokens` from
 *    GET /sessions/:id/context) renders AT REST in the toolbar, labeled
 *    "measured" — not buried behind the popover's hover intent;
 *  · null before the first reply → the honest "not yet measured" + the
 *    estimate stays labeled (~ / "estimated");
 *  · a per-send model switch shows BOTH models (the `at` + `model` ride —
 *    never silently mixing numbers);
 *  · the ring-grading thresholds (pure fn, exported since R51-c).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  CONTEXT_DONUT_DANGER,
  CONTEXT_DONUT_WARN,
  ContextDonut,
  contextDonutColor,
} from "./ContextDonut";
import { fetchSessionContext, type SessionContextReport } from "../../../lib/api";
import { renderWithProviders } from "../../../test-utils";

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return { ...actual, fetchSessionContext: vi.fn() };
});

const fetchMock = vi.mocked(fetchSessionContext);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function baseReport(overrides: Partial<SessionContextReport> = {}): SessionContextReport {
  return {
    model: "z-ai/glm-5.2:free",
    providerId: "openrouter",
    contextWindow: 200_000,
    contextWindowSource: "catalog",
    maxOutputTokens: 32_768,
    available: 159_232,
    usedTokens: 40_000,
    usedTokensBasis: "estimated",
    breakdown: {
      systemPrompt: 2_000,
      systemTools: 1_000,
      memory: 500,
      messages: 34_500,
      meta: 500,
      mcpTools: 1_500,
    },
    actual: {
      inputTokens: 45_200,
      outputTokens: 900,
      cachedInputTokens: null,
      at: "2026-09-13T10:00:00Z",
      model: "z-ai/glm-5.2:free",
    },
    cache: { inputTokens: 45_200, cachedInputTokens: 0, hitRate: null },
    sessionTotals: { inputTokens: 45_200, outputTokens: 900, requests: 1, costUsd: 0 },
    ...overrides,
  };
}

function renderDonut(report: SessionContextReport | null): void {
  fetchMock.mockReset();
  if (report !== null) fetchMock.mockResolvedValue(report);
  else fetchMock.mockRejectedValue(new Error("boom"));
  renderWithProviders(
    <ContextDonut
      sessionId="sess_r95f"
      model="z-ai/glm-5.2:free"
      providerId="openrouter"
      transcriptLength={4}
      liveTick={2}
      streaming={false}
      liveMode
    />,
  );
}

/** Click-to-pin the popover open (the instant path — no hover intent):
 *  every test clicks the donut BUTTON (its title = the summary text). */

describe("ROUND-95 (R95-F) measured-usage prominence", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("the MEASURED readout rides the toolbar AT REST — labeled, never hover-only", async () => {
    renderDonut(baseReport());
    const inline = await waitFor(() => {
      const el = document.querySelector("[data-context-measured-inline]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(inline.textContent).toContain("45k");
    expect(inline.textContent).toContain("measured");
    // The basis is never confused: the RING stays the estimate (no number
    // on it), the inline readout is the provider's own count.
    expect(fetchMock).toHaveBeenCalledWith("sess_r95f", "z-ai/glm-5.2:free", "openrouter");
  });

  it("before the first reply (actual = null) the toolbar stays icon-only and the popover says so honestly", async () => {
    renderDonut(baseReport({ actual: null }));
    await waitFor(() => {
      expect(screen.getByTitle(/projected/)).toBeTruthy();
    });
    // No measured readout at rest — nothing to show yet, never a fake 0.
    expect(document.querySelector("[data-context-measured-inline]")).toBeNull();
    // The estimate keeps its labels: title + popover both say projected.
    expect(screen.getByTitle(/projected/).getAttribute("title")).toContain("estimated");
    fireEvent.click(screen.getByTitle(/projected/));
    await waitFor(() => {
      expect(document.querySelector("[data-context-popover]")).not.toBeNull();
    });
    expect(document.querySelector("[data-context-measured]")?.textContent).toContain("not yet measured");
    // The estimate row keeps its basis label (the R83 one-rule).
    expect(document.body.textContent).toContain("tokens · estimated");
    expect(document.body.textContent).toContain("~20% projected");
  });

  it("the popover's measured row is the provider's own number with its basis + the estimate stays labeled", async () => {
    renderDonut(baseReport());
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));
    await waitFor(() => {
      expect(document.querySelector("[data-context-popover]")).not.toBeNull();
    });
    const measured = document.querySelector("[data-context-measured]") as HTMLElement;
    expect(measured.textContent).toContain("45k");
    expect(measured.textContent).toContain("measured at last request");
    // The estimate row keeps its basis label (the R83 one-rule).
    expect(document.body.textContent).toContain("tokens · estimated");
    expect(document.body.textContent).toContain("~20% projected");
  });

  it("a per-send model switch names BOTH models — the measured number's model rides (R83)", async () => {
    renderDonut(
      baseReport({
        model: "z-ai/glm-5.2:free",
        actual: {
          inputTokens: 45_200,
          outputTokens: 900,
          cachedInputTokens: null,
          at: "2026-09-13T10:00:00Z",
          model: "openai/gpt-5.1",
        },
      }),
    );
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));
    await waitFor(() => {
      expect(document.querySelector("[data-context-popover]")).not.toBeNull();
    });
    expect(document.body.textContent).toContain("next send z-ai/glm-5.2:free");
    expect(document.body.textContent).toContain("measured openai/gpt-5.1");
  });
});

describe("ROUND-95 (R95-F) ring grading (R51-c pure fn, pinned)", () => {
  it("accent below the warn threshold, amber at it, danger above the danger threshold", () => {
    const accent = "#3b82f6";
    expect(CONTEXT_DONUT_WARN).toBe(0.6);
    expect(CONTEXT_DONUT_DANGER).toBe(0.85);
    expect(contextDonutColor(50_000, 200_000, accent)).toBe(accent);
    expect(contextDonutColor(120_000, 200_000, accent)).toBe("#f59e0b");
    expect(contextDonutColor(180_000, 200_000, accent)).toBe("#ef4444");
    // Degenerate windows never divide by zero.
    expect(contextDonutColor(10, 0, accent)).toBe(accent);
  });
});
