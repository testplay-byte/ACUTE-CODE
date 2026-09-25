// @vitest-environment happy-dom
/**
 * ROUND-95 (R95-F) tests — the context donut's MEASURED-usage prominence
 * (owner: "It does not properly show the actual context which is currently
 * being used or other stuff like that"), pinned against the R83 CONTEXT-METER
 * contract (docs/runbooks/CONTEXT-METER.md — every number carries its BASIS,
 * never present one as the other).
 *
 * ROUND-96 (R96-H) REVERSAL — the owner's seventh report walked the R95-F
 * inline readout BACK: "The context window was showing me how many tokens
 * have been used and such, but it is not how we wanted it to be. It should
 * not show that value alongside it." The toolbar ring now renders ALONE
 * (icon-only, the R51-c contract); the measured number, the % and the
 * breakdown all live in the HOVER POPOVER (+ the button's title). The pins
 * below were flipped in the same round as the behavior (fixture discipline):
 *
 *  · the toolbar shows NO inline value — neither a % (R51-c) nor the measured
 *    count (the R95-F readout removed);
 *  · the measured count still renders in the POPOVER, labeled "measured at
 *    last request" (null before the first reply → the honest "not yet
 *    measured", never 0);
 *  · a per-send model switch shows BOTH models (the `at` + `model` ride —
 *    never silently mixing numbers);
 *  · the ring-grading thresholds (pure fn, exported since R51-c).
 *
 * ROUND-96 (R96-G) — the popover's OVERLAY-WINDOW ladder (owner: "when I try
 * to hover over the total number of token usage that has been done, it
 * apparently hides the browser and says, 'Browser paused while the menu is
 * open.' This is not a great experience."): inside the native shell the
 * usage card rides the menu-overlay OS window (the R90-C2/R92-A vehicle that
 * DOES paint above the browser webview); the DOM portal renders ONLY in web
 * mode or when the overlay command fails. Pinned with both bridges mocked —
 * the ladder's decision table, the payload content, and the hover/close
 * semantics; the pure buildUsageCardSections content is pinned directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import {
  CONTEXT_DONUT_DANGER,
  CONTEXT_DONUT_WARN,
  ContextDonut,
  buildUsageCardSections,
  contextDonutColor,
  type DonutTones,
  usageRingColorKey,
} from "./ContextDonut";
import { fetchSessionContext, type SessionContextReport } from "../../../lib/api";
import { fmtTokens } from "../../../lib/format";
import { renderWithProviders } from "../../../test-utils";

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return { ...actual, fetchSessionContext: vi.fn() };
});

/** R96-G: the two bridges the ladder consults — native availability + the
 * overlay window commands. Defaults keep every LEGACY (DOM-leg) test on
 * exactly its pre-R96 environment: available false → the DOM popover. */
const overlayState = vi.hoisted(() => ({
  available: false,
  showResult: true as boolean,
  showCalls: [] as Array<{
    anchor: { left: number; top: number; width: number; height: number };
    payload: Record<string, unknown>;
  }>,
  hidden: 0,
  hoverHandler: null as ((hovering: boolean) => void) | null,
  closeHandler: null as (() => void) | null,
  pickHandler: null as ((pick: { kind: string; target?: string }) => void) | null,
}));

vi.mock("../../../lib/native-browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/native-browser")>();
  return { ...actual, isNativeBrowserAvailable: () => overlayState.available };
});

vi.mock("../../../lib/menu-overlay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/menu-overlay")>();
  return {
    ...actual,
    showMenuOverlay: vi.fn(
      (
        anchor: { left: number; top: number; width: number; height: number },
        payload: Record<string, unknown>,
      ) => {
        overlayState.showCalls.push({ anchor, payload });
        return Promise.resolve(overlayState.showResult);
      },
    ),
    hideMenuOverlay: vi.fn(() => {
      overlayState.hidden += 1;
    }),
    onMenuOverlayHover: vi.fn((cb: (hovering: boolean) => void) => {
      overlayState.hoverHandler = cb;
      return () => {
        if (overlayState.hoverHandler === cb) overlayState.hoverHandler = null;
      };
    }),
    onMenuOverlayClose: vi.fn((cb: () => void) => {
      overlayState.closeHandler = cb;
      return () => {
        if (overlayState.closeHandler === cb) overlayState.closeHandler = null;
      };
    }),
    onMenuOverlayPick: vi.fn((cb: (pick: { kind: string; target?: string }) => void) => {
      overlayState.pickHandler = cb;
      return () => {
        if (overlayState.pickHandler === cb) overlayState.pickHandler = null;
      };
    }),
  };
});

const fetchMock = vi.mocked(fetchSessionContext);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  overlayState.available = false;
  overlayState.showResult = true;
  overlayState.showCalls = [];
  overlayState.hidden = 0;
  overlayState.hoverHandler = null;
  overlayState.closeHandler = null;
  overlayState.pickHandler = null;
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

  it("ROUND-96 (R96-H) reversal: the toolbar is ICON-ONLY — the measured number does NOT ride beside the ring", async () => {
    renderDonut(baseReport());
    await waitFor(() => {
      expect(screen.getByTitle(/projected/)).toBeTruthy();
    });
    // The owner (R96 seventh report): "It should not show that value
    // alongside it." — the R95-F inline readout is GONE; the ring renders
    // alone (the % was already title/popover-only since R51-c).
    expect(document.querySelector("[data-context-measured-inline]")).toBeNull();
    const donut = screen.getByTitle(/projected/);
    expect(donut.textContent?.trim()).toBe("");
    expect(donut.querySelector("svg")).toBeTruthy();
    // The measured value is hover-ONLY now: it lives in the popover.
    fireEvent.click(donut);
    await waitFor(() => {
      expect(document.querySelector("[data-context-popover]")).not.toBeNull();
    });
    expect(document.querySelector("[data-context-measured]")?.textContent).toContain("45k");
    expect(document.querySelector("[data-context-measured]")?.textContent).toContain("measured at last request");
    expect(fetchMock).toHaveBeenCalledWith("sess_r95f", "z-ai/glm-5.2:free", "openrouter");
  });

  it("before the first reply (actual = null) the toolbar stays icon-only and the popover says so honestly", async () => {
    renderDonut(baseReport({ actual: null }));
    await waitFor(() => {
      expect(screen.getByTitle(/projected/)).toBeTruthy();
    });
    // No measured readout at rest — nothing to show yet, never a fake 0.
    expect(document.querySelector("[data-context-measured-inline]")).toBeNull();
    const donut = screen.getByTitle(/projected/);
    // R96-H: even with a report in hand the ring renders ALONE.
    expect(donut.textContent?.trim()).toBe("");
    // The estimate keeps its labels: title + popover both say projected.
    expect(screen.getByTitle(/projected/).getAttribute("title")).toContain("estimated");
    fireEvent.click(screen.getByTitle(/projected/));
    await waitFor(() => {
      expect(document.querySelector("[data-context-popover]")).not.toBeNull();
    });
    expect(document.querySelector("[data-context-measured]")?.textContent).toContain("not yet measured");
    // R99-D: the big token line is the primary read ("40k of 200k"); the
    // estimate's basis rides the ONE % line ("~20% projected") beside it —
    // the R83 one-rule, one labeled spelling per number.
    expect(document.body.textContent).toContain("40k of 200k");
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
    // R99-D: the big token line + the ONE % line carry the estimate's basis.
    expect(document.body.textContent).toContain("40k of 200k");
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
  it("accent below the warn threshold, the warn tone at it, danger above the danger threshold", () => {
    // R126-3d-4 re-pin: the tones arrive as a THEME triplet (accentDeep
    // primary + warningDeep/dangerDeep tiers — the material spec); the
    // THRESHOLDS are the pure contract, the colors the caller's.
    const tones: DonutTones = { accent: "#3b82f6", warn: "#b45309", danger: "#dc2626" };
    expect(CONTEXT_DONUT_WARN).toBe(0.6);
    expect(CONTEXT_DONUT_DANGER).toBe(0.85);
    expect(contextDonutColor(50_000, 200_000, tones)).toBe(tones.accent);
    expect(contextDonutColor(120_000, 200_000, tones)).toBe(tones.warn);
    expect(contextDonutColor(180_000, 200_000, tones)).toBe(tones.danger);
    // Degenerate windows never divide by zero.
    expect(contextDonutColor(10, 0, tones)).toBe(tones.accent);
  });
});

// ── ROUND-96 (R96-G): the popover's overlay-window ladder ────────────────────
describe("ROUND-96 (R96-G) — the usage popover rides the overlay window (no browser pause)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("native mode: opening the popover calls showMenuOverlay with the usage payload — the DOM portal never renders (the browser never pauses)", async () => {
    overlayState.available = true;
    renderDonut(baseReport());
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));

    await waitFor(() => expect(overlayState.showCalls.length).toBeGreaterThan(0));
    const { anchor, payload } = overlayState.showCalls[0]!;
    // The overlay payload: the usage kind, the DOM popover's width, and the
    // SAME build the DOM popover renders from (R99-D: the payload IS the
    // single source — the overview hero + the bar-with-legend + the Cache /
    // Session sections; the note row is retired). R98-C3: the width is the
    // 420px sectioned card (the owner's wider-aspect ask).
    expect(payload.kind).toBe("usage");
    expect(payload.width).toBe(420);
    // R99-D: the OVERVIEW HERO — typed views over the JSON-safe record.
    const overview = payload.overview as {
      bigUsed: string;
      bigLimit: string;
      pctLine: string;
      meta: Array<{ id?: string; label: string; value: string }>;
      budgetLine?: string;
      ringColor: string;
    } | undefined;
    expect(overview).toBeDefined();
    expect(overview!.bigUsed).toBe(fmtTokens(40_000));
    expect(overview!.bigLimit).toBe(fmtTokens(200_000));
    expect(overview!.pctLine).toBe("~20% projected"); // the ONE % line, % first
    expect(overview!.meta.map((m) => m.id)).toEqual(["measured", "model", "window"]);
    expect(overview!.meta[0]!.value).toBe(fmtTokens(45_200)); // MEASURED — the provider's own count
    expect(overview!.meta[2]!.value).toContain("catalog default"); // window provenance (ex-note)
    expect(overview!.budgetLine).toContain("compaction line");
    expect(overview!.ringColor).toBe("accent");
    // R99-D: the context bar's segments ARE the legend rows.
    const contextBar = payload.contextBar as {
      windowTokens: number;
      usedTokens: number;
      reservedTokens: number;
      segments: Array<{
        label: string;
        color: string;
        tokensLabel: string;
        pctOfUsed: string;
        manage?: { target: string };
      }>;
    } | undefined;
    expect(contextBar).toBeDefined();
    expect(contextBar!.segments.map((s) => s.label)).toEqual([
      "Messages",
      "System prompt",
      "System tools",
      "MCP tools",
      "Memory & skills",
      "Meta & project",
    ]);
    expect(contextBar!.segments[0]!.tokensLabel).toBe(fmtTokens(34_500));
    expect(contextBar!.segments[0]!.pctOfUsed).toBe("86%"); // of USED (34.5k / 40k)
    expect(contextBar!.segments.find((s) => s.label === "System prompt")!.manage?.target).toBe(
      "/settings?tab=prompts",
    );
    expect(contextBar!.segments.find((s) => s.label === "MCP tools")!.manage?.target).toBe("/settings?tab=mcp");
    expect(contextBar!.segments.find((s) => s.label === "Messages")!.manage).toBeUndefined(); // honest: no surface
    // The sections are Cache (ONE row) + Session totals (the table).
    expect((payload.sections as Array<{ title: string }>).map((s) => s.title)).toEqual([
      "Cache",
      "Session totals",
    ]);
    // The anchor: the card's window — width = card + the page's 6px paddings,
    // positioned above the trigger, never off the top of the screen.
    expect(anchor.width).toBe(420 + 12);
    expect(anchor.top).toBeGreaterThanOrEqual(0);
    expect(anchor.height).toBeGreaterThanOrEqual(40);
    // THE point: no DOM popover portal exists to intersect the browser.
    expect(document.querySelector("[data-context-popover]")).toBeNull();
  });

  it("R99-D: a usage-link pick from the overlay leg closes the popover + router-navigates (the legend's manage chips work on BOTH legs)", async () => {
    overlayState.available = true;
    function SearchProbe() {
      const { search } = useLocation();
      return <div data-testid="search-probe">{search}</div>;
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(baseReport());
    renderWithProviders(
      <>
        <ContextDonut
          sessionId="sess_r95f"
          model="z-ai/glm-5.2:free"
          providerId="openrouter"
          transcriptLength={4}
          liveTick={2}
          streaming={false}
          liveMode
        />
        <Routes>
          <Route path="/settings" element={<SearchProbe />} />
        </Routes>
      </>,
    );
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));
    await waitFor(() => expect(overlayState.showCalls.length).toBeGreaterThan(0));
    expect(overlayState.pickHandler).not.toBeNull();
    act(() => {
      overlayState.pickHandler!({ kind: "usage-link", target: "/settings?tab=prompts" });
    });
    // The popover closed (the overlay window hides with it) + the router
    // navigated to the management surface.
    await waitFor(() => expect(overlayState.hidden).toBeGreaterThan(0));
    expect((await screen.findByTestId("search-probe")).textContent).toContain("tab=prompts");
    expect(document.querySelector("[data-context-popover]")).toBeNull();
  });

  it("native mode + a REJECTED overlay command: the DOM popover is the honest fallback (the R92-A ladder)", async () => {
    overlayState.available = true;
    overlayState.showResult = false;
    renderDonut(baseReport());
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));
    await waitFor(() => expect(document.querySelector("[data-context-popover]")).not.toBeNull());
    expect(document.body.textContent).toContain("~20% projected");
  });

  it("web mode: the DOM popover renders and the overlay bridge is never called", async () => {
    renderDonut(baseReport());
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));
    await waitFor(() => expect(document.querySelector("[data-context-popover]")).not.toBeNull());
    expect(overlayState.showCalls).toHaveLength(0);
  });

  it("closing takes the overlay window down: an outside mousedown, and the button's own unpin click", async () => {
    overlayState.available = true;
    renderDonut(baseReport());
    const button = await waitFor(() => screen.getByTitle(/measured at last request/));
    fireEvent.click(button); // pin open
    await waitFor(() => expect(overlayState.showCalls.length).toBeGreaterThan(0));

    // A mousedown on the donut itself is the TOGGLE, not a dismiss.
    const before = overlayState.hidden;
    fireEvent.mouseDown(button);
    expect(overlayState.hidden).toBe(before);

    // An outside mousedown closes both legs.
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(overlayState.hidden).toBeGreaterThan(before));
    expect(document.querySelector("[data-context-popover]")).toBeNull();

    // Re-open, then unpin via the button's click — the overlay hides too.
    fireEvent.click(button);
    await waitFor(() => expect(overlayState.showCalls.length).toBeGreaterThan(1));
    const hiddenBeforeUnpin = overlayState.hidden;
    fireEvent.click(button);
    await waitFor(() => expect(overlayState.hidden).toBeGreaterThan(hiddenBeforeUnpin));
  });

  it("Escape closes the overlay leg (the main window's keyboard, via useDismiss)", async () => {
    overlayState.available = true;
    renderDonut(baseReport());
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));
    await waitFor(() => expect(overlayState.showCalls.length).toBeGreaterThan(0));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(overlayState.hidden).toBeGreaterThan(0));
  });

  it("the overlay page's own close report (its Escape) closes the popover too", async () => {
    overlayState.available = true;
    renderDonut(baseReport());
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));
    await waitFor(() => expect(overlayState.showCalls.length).toBeGreaterThan(0));
    expect(overlayState.closeHandler).not.toBeNull();
    overlayState.closeHandler!();
    await waitFor(() => expect(overlayState.hidden).toBeGreaterThan(0));
  });

  it("the HOVER bridge: parking the pointer on the overlay card cancels the close grace; leaving re-arms it", async () => {
    overlayState.available = true;
    renderDonut(baseReport());
    const button = await waitFor(() => screen.getByTitle(/measured at last request/));

    vi.useFakeTimers();
    try {
      // Open via HOVER INTENT (the real pointer path — NOT the pin): the
      // popover is UNPINNED, so the close-grace semantics are live.
      fireEvent.mouseEnter(button);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(overlayState.showCalls.length).toBeGreaterThan(0);
      expect(overlayState.hoverHandler).not.toBeNull();

      // The pointer left the trigger (crossing toward the card): the 220ms
      // grace arms — then the card's hover report CANCELS it.
      fireEvent.mouseLeave(button);
      overlayState.hoverHandler!(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(overlayState.hidden).toBe(0);

      // The pointer left the card: the grace re-arms and the window hides.
      overlayState.hoverHandler!(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(overlayState.hidden).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmount while the overlay is up takes the window down (no orphaned card over the browser)", async () => {
    overlayState.available = true;
    renderDonut(baseReport());
    fireEvent.click(await waitFor(() => screen.getByTitle(/measured at last request/)));
    await waitFor(() => expect(overlayState.showCalls.length).toBeGreaterThan(0));
    cleanup();
    await waitFor(() => expect(overlayState.hidden).toBeGreaterThan(0));
  });
});

describe("ROUND-96 (R96-G) → R99-D — buildUsageCardSections (the pure payload builder)", () => {
  it("the OVERVIEW HERO: the big token line is the primary read + the honesty meta pairs + the compacted badge", () => {
    const built = buildUsageCardSections(
      baseReport({
        compaction: { throughSeq: 30, droppedMessages: 12, tokensSaved: 18_400 },
        actual: null,
      }),
      { isError: false, sessionId: "s1" },
    );
    expect(built).not.toBeNull();
    // R99-D: what the old donut header carried as five label/value lines is
    // now the hero — the big line, ONE % line (percentage first), ≤3 meta
    // pairs, and the compaction note promoted to the header-row badge.
    expect(built!.overview!.bigUsed).toBe(fmtTokens(40_000));
    expect(built!.overview!.bigLimit).toBe(fmtTokens(200_000));
    expect(built!.overview!.pctLine).toBe("~20% projected");
    const measured = built!.overview!.meta.find((m) => m.id === "measured")!;
    expect(measured.value).toBe("not yet measured"); // honest pre-first-reply
    const windowPair = built!.overview!.meta.find((m) => m.id === "window")!;
    expect(windowPair.value).toBe(`${fmtTokens(200_000)} · catalog default`);
    expect(built!.overview!.budgetLine).toBe(
      `compaction line ${fmtTokens(159_232)} · reserve ${fmtTokens(32_768)} output`,
    );
    expect(built!.overview!.compactedBadge!.label).toBe("Context compacted");
    expect(built!.overview!.compactedBadge!.detail).toContain("12 messages summarized");
    expect(built!.overview!.compactedBadge!.detail).toContain(fmtTokens(18_400));
    // Never more than three honesty pairs (the R99-D contract).
    expect(built!.overview!.meta.length).toBeLessThanOrEqual(3);
  });

  it("the empty/loading states stay honest (same copy as the DOM popover)", () => {
    expect(buildUsageCardSections(null, { isError: true, sessionId: "s1" })!.sections[0]!.lines[0]!.value).toBe(
      "context report unavailable",
    );
    expect(buildUsageCardSections(null, { isError: false, sessionId: null })!.sections[0]!.lines[0]!.value).toBe(
      "starts with the first message",
    );
    expect(buildUsageCardSections(null, { isError: false, sessionId: "s1" })!.sections[0]!.lines[0]!.value).toBe(
      "loading context report…",
    );
  });

  it("a per-send model switch names BOTH models (the R83 rule, carried into the hero's model pair)", () => {
    const built = buildUsageCardSections(
      baseReport({
        actual: {
          inputTokens: 45_200,
          outputTokens: 900,
          cachedInputTokens: null,
          at: "2026-09-13T10:00:00Z",
          model: "openai/gpt-5.1",
        },
      }),
      { isError: false, sessionId: "s1" },
    );
    const model = built!.overview!.meta.find((m) => m.id === "model")!;
    expect(model.value).toBe("next send z-ai/glm-5.2:free · measured openai/gpt-5.1");
  });

  it("R97-C → R99-D: the session split is the compact TABLE (Turns/Calls/Sent/Received/Cost per group)", () => {
    const built = buildUsageCardSections(
      baseReport({
        usage: {
          main: { inputTokens: 45_200, outputTokens: 900, requests: 3, costUsd: 0.0123, providerCalls: 7 },
          subagents: { inputTokens: 1_000, outputTokens: 200, requests: 1, costUsd: 0 },
          combined: { inputTokens: 46_200, outputTokens: 1_100, requests: 4, costUsd: 0.0123, providerCalls: 9 },
        },
      }),
      { isError: false, sessionId: "s1" },
    );
    const session = built!.sections.find((s) => s.title === "Session totals")!;
    expect(session.table).toBeDefined();
    expect(session.table!.columns).toEqual(["Group", "Turns", "Calls", "Sent ↑", "Received ↓", "Cost"]);
    expect(session.table!.rows.map((r) => r.label)).toEqual(["Main agent", "Sub-agents", "Combined"]);
    expect(session.table!.rows[0]!.cells).toEqual(["3", "7", `${fmtTokens(45_200)} ↑`, `${fmtTokens(900)} ↓`, "$0.0123"]);
    // A pre-R83 sidecar without providerCalls reads the honest em-dash.
    expect(session.table!.rows[1]!.cells[1]).toBe("—");
    expect(session.table!.rows[1]!.cells[4]).toBe("—"); // zero cost renders the em-dash
    // The Combined row is the strong one, and the R99-D retirement holds:
    // the session-cost HEADLINE is gone — the table's Cost column carries
    // the combined truth (one source of truth per number).
    expect(session.table!.rows[2]!.strong).toBe(true);
    expect(session.table!.rows[2]!.cells).toEqual([
      "4",
      "9",
      `${fmtTokens(46_200)} ↑`,
      `${fmtTokens(1_100)} ↓`,
      "$0.0123",
    ]);
  });

  it("R99-D: the context bar is the star — full-width segments with legend rows (tokens/%/manage links)", () => {
    const built = buildUsageCardSections(
      baseReport({ maxOutputTokens: 16_000 }),
      { isError: false, sessionId: "s1" },
    );
    expect(built!.contextBar).toBeDefined();
    // The pane's label — both legs (DOM popover + overlay window) paint it
    // as the pane header; the R98-C3 "Breakdown" section is GONE (merged
    // into the bar's legend) and the overview is the unboxed head.
    expect(built!.contextBar!.label).toBe("Window composition");
    expect(built!.overview).toBeDefined();
    expect(built!.sections.map((s) => s.title)).toEqual(["Cache", "Session totals"]);
    expect(built!.contextBar!.windowTokens).toBe(200_000);
    expect(built!.contextBar!.usedTokens).toBe(40_000);
    expect(built!.contextBar!.reservedTokens).toBe(16_000);
    expect(built!.contextBar!.usedPct).toBe(20);
    expect(built!.contextBar!.segments.map((s) => s.label)).toEqual([
      "Messages",
      "System prompt",
      "System tools",
      "MCP tools",
      "Memory & skills",
      "Meta & project",
    ]);
    // The legend rows ARE the segments now — each carries its pre-formatted
    // tokens + its share of the USED context (the fixture's Messages =
    // 34_500 of 40_000 used → 86%).
    expect(built!.contextBar!.segments[0]!.tokens).toBe(34_500);
    expect(built!.contextBar!.segments[0]!.tokensLabel).toBe(fmtTokens(34_500));
    expect(built!.contextBar!.segments[0]!.pctOfUsed).toBe("86%");
    // The palette keys ride the segments (the mutual hover-highlight
    // contract between a segment and its legend row).
    expect(built!.contextBar!.segments.map((s) => s.color)).toEqual([
      "accent",
      "blue",
      "teal",
      "violet",
      "amber",
      "rose",
    ]);
    // The management links — ONLY where a real surface exists (the Claude
    // Code /context pattern): prompts/mcp targets present, the others
    // honestly absent (no dead links).
    const byLabel = (label: string) => built!.contextBar!.segments.find((s) => s.label === label)!;
    expect(byLabel("System prompt").manage?.target).toBe("/settings?tab=prompts");
    expect(byLabel("Memory & skills").manage?.target).toBe("/settings?tab=prompts");
    expect(byLabel("MCP tools").manage?.target).toBe("/settings?tab=mcp");
    expect(byLabel("Messages").manage).toBeUndefined();
    expect(byLabel("System tools").manage).toBeUndefined();
    expect(byLabel("Meta & project").manage).toBeUndefined();
    // The hero's ring color follows the graded thresholds (20% → accent).
    expect(built!.overview!.ringColor).toBe("accent");
    expect(usageRingColorKey(130_000, 200_000)).toBe("warn");
    expect(usageRingColorKey(195_000, 200_000)).toBe("danger");
  });

  it("the legend + the ONE-row cache section mirror the popover's rows (cache honesty included)", () => {
    const built = buildUsageCardSections(baseReport(), { isError: false, sessionId: "s1" });
    // The legend's MCP row: the fixture's 1_500 reads its tokens; a ZERO
    // override reads the honest "none configured" (both spellings pinned).
    expect(built!.contextBar!.segments.find((s) => s.label === "MCP tools")!.tokensLabel).toBe(
      fmtTokens(1_500),
    );
    const zeroMcp = buildUsageCardSections(
      baseReport({ breakdown: { ...baseReport().breakdown, mcpTools: 0 } }),
      { isError: false, sessionId: "s1" },
    );
    expect(zeroMcp!.contextBar!.segments.find((s) => s.label === "MCP tools")!.tokensLabel).toBe(
      "none configured",
    );
    // The Cache section is ONE row now (the R83 §2.10 null-rate honesty
    // rides the value itself — the old two-row split is gone).
    const cache = built!.sections.find((s) => s.title === "Cache")!;
    expect(cache.lines).toHaveLength(1);
    expect(cache.lines[0]!.label).toBe("Hit rate");
    expect(cache.lines[0]!.value).toBe("— · not reported by this provider");
    expect(cache.lines[0]!.barColor).toBe("teal");
  });
});
