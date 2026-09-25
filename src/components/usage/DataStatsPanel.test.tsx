// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { fetchUsageStats, type UsageStats, type UsageStatsDayBucket } from "../../lib/api";
import { DataStatsPanel } from "./DataStatsPanel";
import { useConfigStore } from "../../lib/config-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

/**
 * ROUND-99 (R99-E, owner: "the data and statistics… not that well handled…
 * the clear usage data completely looks out of place… turn errors and tool
 * failures… completely out of order"): the pins for the reordered panel —
 * the GitHub-settings read (stats → heatmap → model charts → ONE unified
 * agent-health section LAST), the quiet health sub-blocks (severity via
 * icon + number color, never a tinted card), the anti-jitter kit (skeleton
 * mirrors the ready geometry; tabular-nums on every number).
 *
 * ROUND-127 (R127-W1): the DANGER-ZONE pins (the quiet red-outlined grammar
 * + the clear-flow contract) MOVED to ClearUsageDataCard.test.tsx — the
 * zone was extracted from the panel into the standalone page-scope card
 * (SCREENS §3 "THE USAGE PAGE ORDER", step 8). The pins here now assert
 * the panel ENDS at agent health and never renders the zone itself.
 *
 * The panel is a VIEW over GET /usage/stats — the api module is mocked
 * exactly as the sidecar shapes it. Both mount sites (settings ?tab=data +
 * the /usage screen) render THIS panel (the danger zone rides the
 * ClearUsageDataCard after it), so these pins hold for both.
 */
vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    fetchUsageStats: vi.fn(),
  };
});

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // The stats hook only runs against the live sidecar (demo mode has no
  // usage log) — flip the store so the mocked fetch actually executes.
  useConfigStore.setState({ demoData: false });
  vi.mocked(fetchUsageStats).mockReset().mockResolvedValue(seedStats());
});

/** A two-week series (one model most days, two on every third day). */
function seriesDays(): UsageStatsDayBucket[] {
  const out: UsageStatsDayBucket[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(2026, 8, 15 - i)).toISOString().slice(0, 10);
    out.push({
      date,
      byModel:
        i % 3 === 0
          ? { "z-ai/glm-5.2:free": 12_000, "openai/gpt-5.1": 4_000 }
          : { "z-ai/glm-5.2:free": 8_000 },
    });
  }
  return out;
}

function seedStats(overrides: Partial<UsageStats> = {}): UsageStats {
  return {
    months: 12,
    totals: {
      inputTokens: 420_000,
      outputTokens: 210_000,
      totalTokens: 630_000,
      costUsd: 12.34,
      requests: 321,
      providerCalls: 456,
    },
    peak: { date: "2026-08-14", tokens: 90_000 },
    series: seriesDays(),
    models: [
      {
        model: "z-ai/glm-5.2:free",
        inputTokens: 300_000,
        outputTokens: 150_000,
        tokens: 450_000,
        costUsd: 10,
        calls: 200,
        requests: 180,
        providers: ["z-ai"],
      },
      {
        model: "openai/gpt-5.1",
        inputTokens: 120_000,
        outputTokens: 60_000,
        tokens: 180_000,
        costUsd: 2.34,
        calls: 100,
        requests: 141,
        providers: ["openai"],
      },
    ],
    health: {
      turnErrors: [{ name: "rate_limit", count: 3 }],
      toolFailures: [{ name: "read_file", count: 2 }],
    },
    generatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function renderPanel() {
  return renderWithProviders(<DataStatsPanel />);
}

/** a precedes b in document order. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("DataStatsPanel (R99-E — the section order; R127-W1 — the zone extracted)", () => {
  it("renders the GitHub-settings order: stat cards → heatmap → stack chart → donut → agent health LAST — and no longer renders the danger zone", async () => {
    renderPanel();
    const statValue = await screen.findByText("630K"); // the Tokens StatCard value
    const heatmap = screen.getByTestId("usage-heatmap");
    const stack = screen.getByTestId("model-stack-chart");
    const donut = screen.getByTestId("model-donut");
    const health = screen.getByTestId("agent-health-section");
    const turnErrors = screen.getByTestId("stats-turn-errors");
    const toolFailures = screen.getByTestId("stats-tool-failures");

    expect(precedes(statValue, heatmap)).toBe(true);
    expect(precedes(heatmap, stack)).toBe(true);
    expect(precedes(stack, donut)).toBe(true);
    expect(precedes(donut, health)).toBe(true);
    expect(precedes(health, turnErrors)).toBe(true);
    expect(precedes(turnErrors, toolFailures)).toBe(true);

    // R127-W1 (SCREENS §3 — DANGER ZONE LAST at PAGE scope): the danger
    // zone moved byte-wholesale into the standalone ClearUsageDataCard —
    // agent health is now the panel's final section, and the zone's pins
    // live in ClearUsageDataCard.test.tsx.
    const panel = screen.getByTestId("data-stats-panel");
    expect(panel.lastElementChild).toBe(health);
    expect(screen.queryByTestId("clear-usage-card")).toBeNull();
    expect(screen.queryByTestId("clear-usage-button")).toBeNull();
  });

  it("the unified Agent health section: one micro-header, both sub-blocks, their counts + issue rows + window aria-labels", async () => {
    renderPanel();
    await screen.findByTestId("agent-health-section");

    // ONE section header (the 10–11px label-caps grammar — a styled div,
    // never an invented h-tag).
    expect(screen.getByText("Agent health")).toBeTruthy();
    expect(screen.queryByText("Clear usage data")).toBeNull(); // no per-card title — the zone owns it

    // Both sub-blocks keep their R98 testids + labels (deep-links ride).
    const turnErrors = screen.getByTestId("stats-turn-errors");
    const toolFailures = screen.getByTestId("stats-tool-failures");
    expect(turnErrors.getAttribute("aria-label")).toBe("Turn errors");
    expect(toolFailures.getAttribute("aria-label")).toBe("Tool failures");

    // The counts — mono tabular-nums, severity color only on the number;
    // the count line carries the window aria-label (the issue-row counts
    // are plain mono numbers without one).
    const turnCount = turnErrors.querySelector('[aria-label="3 turn errors in the last 12 months"]');
    expect(turnCount).not.toBeNull();
    expect(turnCount?.className).toContain("tabular-nums");
    expect(turnCount?.textContent).toBe("3");
    const toolCount = toolFailures.querySelector('[aria-label="2 tool failures in the last 12 months"]');
    expect(toolCount).not.toBeNull();
    expect(toolCount?.className).toContain("tabular-nums");
    expect(toolCount?.textContent).toBe("2");

    // The issue rows — compact mono rows (agent/tool name + count).
    expect(within(turnErrors).getByText("rate_limit")).toBeTruthy();
    expect(within(turnErrors).getAllByText("3").length).toBe(2); // the count line + the row
    expect(within(toolFailures).getByText("read_file")).toBeTruthy();
    expect(within(toolFailures).getAllByText("2").length).toBe(2);

    // QUIET sub-blocks: plain card surface + hairline border — no semantic
    // tint anywhere near the background (the R99-E "looks bad" smell).
    expect(turnErrors.style.backgroundColor).not.toContain("rgba(245, 158, 11");
    expect(toolFailures.style.backgroundColor).not.toContain("rgba(239, 68, 68");
    expect(turnErrors.style.borderColor).not.toContain("245, 158, 11");
    expect(toolFailures.style.borderColor).not.toContain("239, 68, 68");
  });

  it("clean window: both health sub-blocks stay rendered with their honest empty one-liners (stable layout, no content jumping)", async () => {
    vi.mocked(fetchUsageStats).mockResolvedValue(
      seedStats({ health: { turnErrors: [], toolFailures: [] } }),
    );
    renderPanel();
    await screen.findByTestId("agent-health-section");

    const turnErrors = screen.getByTestId("stats-turn-errors");
    const toolFailures = screen.getByTestId("stats-tool-failures");
    expect(within(turnErrors).getByText("No turn errors in the window — clean run.")).toBeTruthy();
    expect(within(toolFailures).getByText("No tool failures in the window — clean run.")).toBeTruthy();

    // The zero counts ride the window aria-label + tabular-nums.
    const zero = turnErrors.querySelector('[aria-label="No turn errors in the last 12 months"]');
    expect(zero?.className).toContain("tabular-nums");
    expect(zero?.textContent).toBe("0");
    expect(within(toolFailures).getByText("0")).toBeTruthy();
  });

  /* R127-W1: the two danger-zone tests that lived here (the QUIET GitHub
   * grammar pin + the clear-flow contract pin) MOVED verbatim to
   * ClearUsageDataCard.test.tsx — the zone's new home. Nothing was deleted:
   * the assertions re-live there against the extracted card. */

  it("the months picker drives the windowed query (12 default → 6) without a skeleton flash (keepPreviousData)", async () => {
    renderPanel();
    await screen.findByTestId("usage-heatmap");
    expect(vi.mocked(fetchUsageStats)).toHaveBeenCalledWith(12);

    // tabular-nums on the picker digits (the anti-jitter discipline).
    const sixMonths = screen.getByRole("button", { name: "Last 6 months" });
    expect(sixMonths.className).toContain("tabular-nums");

    fireEvent.click(sixMonths);
    expect(vi.mocked(fetchUsageStats)).toHaveBeenLastCalledWith(6);

    // No skeleton flash mid-switch — the charts region stays mounted.
    expect(screen.getByTestId("usage-heatmap")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading data and statistics" })).toBeNull();
  });

  it("tabular-nums discipline: the StatCard values + the pinned 92px height (the skeleton's exact geometry)", async () => {
    renderPanel();
    // The Tokens card — its title rides the card element itself.
    const card = await screen.findByTitle(/Input \+ output tokens in the window/);
    expect(card.className).toContain("h-[92px]");
    const statValue = within(card).getByText("630K");
    expect(statValue.className).toContain("tabular-nums");
  });

  it("the loading skeleton mirrors the READY geometry section-for-section (no layout shift on load)", async () => {
    let resolveStats: (value: UsageStats) => void = () => {};
    vi.mocked(fetchUsageStats).mockImplementationOnce(
      () => new Promise<UsageStats>((resolve) => {
        resolveStats = resolve;
      }),
    );
    const { container } = renderPanel();

    expect(await screen.findByRole("status", { name: "Loading data and statistics" })).toBeTruthy();
    const panel = screen.getByTestId("data-stats-panel");

    // The reserved heights — one block per ready section, in order (the
    // bracket-bearing arbitrary classes are matched on className, not via
    // the selector engine). R127-W1: the trailing h-[96px] danger-zone block
    // DIED with the zone's extraction into ClearUsageDataCard — the
    // skeleton no longer reserves it.
    const pulses = Array.from(panel.querySelectorAll(".animate-pulse"));
    expect(pulses.filter((el) => el.className.includes("h-[92px]")).length).toBe(4); // the stat cards
    expect(pulses.some((el) => el.className.includes("h-[264px]"))).toBe(true); // the stack chart
    expect(pulses.some((el) => el.className.includes("h-[96px]"))).toBe(false); // the zone block is GONE (R127-W1)
    expect(container.querySelector('[data-testid="usage-heatmap"]')).toBeNull(); // no real charts yet

    resolveStats(seedStats());
    expect(await screen.findByTestId("usage-heatmap")).toBeTruthy();
    // R127-W1: the panel stays zone-less after load too (the card is
    // ClearUsageDataCard's contract now).
    expect(screen.queryByTestId("clear-usage-card")).toBeNull();
  });

  it("a failed GET renders the honest retryable error card — Retry re-drives the query", async () => {
    vi.mocked(fetchUsageStats).mockRejectedValueOnce(new Error("sidecar exploded"));
    renderPanel();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/sidecar exploded/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry loading data and statistics" });

    vi.mocked(fetchUsageStats).mockResolvedValueOnce(seedStats());
    fireEvent.click(retry);
    expect(await screen.findByTestId("usage-heatmap")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("demo mode (the idle query): the honest empty panel, no fetch fired", async () => {
    useConfigStore.setState({ demoData: true });
    renderPanel();

    expect(await screen.findByText(/No usage statistics available/i)).toBeTruthy();
    expect(vi.mocked(fetchUsageStats)).not.toHaveBeenCalled();
    // R127-W1: still true (and now true at every gate) — the panel never
    // renders the zone; the standalone card owns it.
    expect(screen.queryByTestId("clear-usage-card")).toBeNull();
  });
});

/* ── ROUND-126 (R126-3b, the Clay Companion redesign): the pins for the
 * panel's new material contracts — the SEGMENTED-CONTROL months picker
 * (bg-well track + the gliding bg-accent-deep knob), the ONE-clay-card
 * 4-cell stat row (SCREENS §3 — inset dividers, NO icon chips), the
 * well-pulsing loading skeleton (TOKENS §10 law 4), and the compact clay
 * health tiles. The section order, danger-zone grammar, and clear-flow
 * contracts above are unchanged (the settings tab shares this panel — its
 * props surface stays exactly what it was). */
describe("DataStatsPanel ROUND-126 (R126-3b — the clay materials)", () => {
  it("the months picker is the segmented control: bg-well track + ONE bg-accent-deep knob", async () => {
    const { container } = renderPanel();
    await screen.findByTestId("usage-heatmap");

    const track = container.querySelector<HTMLElement>('[data-testid="stats-months-selector"]');
    expect(track).toBeTruthy();
    expect(track?.className).toContain("bg-well");
    expect(track?.className).toContain("border-clay-rim");
    const knob = track?.querySelector<HTMLElement>('[data-testid="range-selector-knob"]');
    expect(knob).toBeTruthy();
    expect(knob?.className).toContain("bg-accent-deep");
    // The a11y contract rides the buttons (aria-pressed + tabular-nums —
    // the pre-R126 pin, re-pinned against the new grammar).
    const twelve = within(track as HTMLElement).getByRole("button", { name: "Last 12 months" });
    expect(twelve.getAttribute("aria-pressed")).toBe("true");
    expect(twelve.className).toContain("tabular-nums");
  });

  it("the stat row is ONE clay card with four h-[92px] cells and NO icon chips", async () => {
    renderPanel();
    const row = await screen.findByTestId("data-stats-stat-row");

    expect(row.className).toContain("ac-clay");
    const cells = row.querySelectorAll<HTMLElement>("[data-stat-cell]");
    expect(cells.length).toBe(4);
    for (const cell of Array.from(cells)) {
      expect(cell.className).toContain("h-[92px]");
    }
    const dividerCells = Array.from(cells).filter((c) => c.className.includes("border-l"));
    expect(dividerCells.length).toBe(3);
    expect(row.querySelectorAll("svg").length).toBe(0);
    // The pre-R126 title + tabular pins ride the cell now (re-pinned).
    const tokensCell = await screen.findByTitle(/Input \+ output tokens in the window/);
    expect(tokensCell.className).toContain("h-[92px]");
    expect(within(tokensCell).getByText("630K").className).toContain("tabular-nums");
  });

  it("the loading skeleton pulses in the WELL (bg-well), mirroring the one-card stat row", async () => {
    vi.mocked(fetchUsageStats).mockImplementationOnce(
      () => new Promise<UsageStats>(() => {}),
    );
    const { container } = renderPanel();
    await screen.findByRole("status", { name: "Loading data and statistics" });

    const panel = screen.getByTestId("data-stats-panel");
    const pulses = Array.from(panel.querySelectorAll<HTMLElement>(".animate-pulse"));
    // Every pulse block rides the well (TOKENS §10 law 4 — never bg-subtle).
    expect(pulses.length).toBeGreaterThan(0);
    expect(pulses.every((el) => el.className.includes("bg-well"))).toBe(true);
    expect(pulses.filter((el) => el.className.includes("h-[92px]")).length).toBe(4);
    expect(pulses.some((el) => el.className.includes("h-[264px]"))).toBe(true);
    // R127-W1: the danger-zone skeleton block died with the extraction.
    expect(pulses.some((el) => el.className.includes("h-[96px]"))).toBe(false);
    expect(container.querySelector('[data-testid="usage-heatmap"]')).toBeNull();
  });

  it("the agent-health sub-blocks are compact clay tiles (rim + .ac-clay-sm, no tint)", async () => {
    renderPanel();
    const turnErrors = await screen.findByTestId("stats-turn-errors");
    const toolFailures = screen.getByTestId("stats-tool-failures");

    expect(turnErrors.className).toContain("ac-clay-sm");
    expect(toolFailures.className).toContain("ac-clay-sm");
    // The QUIET contract (R99-E) stands — no semantic tint near the surface.
    expect(turnErrors.style.backgroundColor).toBe("");
    expect(toolFailures.style.backgroundColor).toBe("");
  });

  it("R126-3b successor pass: the retryable error card is the TOKENS §11 danger badge-tone container + the outlined-danger Retry", async () => {
    vi.mocked(fetchUsageStats).mockRejectedValueOnce(new Error("sidecar exploded"));
    renderPanel();

    const card = await screen.findByRole("alert");
    // R126 (TOKENS §11): the error card rides the tinted container + the
    // deep-on-tint ink pair — the pre-R126 flat-hue danger text on a
    // withAlpha wash died with §11 (re-pinned in this successor run).
    expect(card.className).toContain("bg-badge-danger");
    expect(card.className).toContain("text-badge-danger-fg");
    // The Retry button is the outlined danger species (COMPONENTS §4).
    const retry = screen.getByRole("button", { name: "Retry loading data and statistics" });
    expect(retry.className).toContain("border-danger-deep");
    expect(retry.className).toContain("text-danger-deep");
    expect(retry.className).toContain("active:scale-[0.98]");
  });
});
