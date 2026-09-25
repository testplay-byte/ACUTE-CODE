// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import type { DetailedUsageModel, DetailedUsageToolCall, UsageDayBucket } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { InsightsRail } from "./InsightsRail";
import { renderWithProviders, resetTestState } from "../../test-utils";

/**
 * ROUND-127 (R127-W1 — SCREENS §3 "THE USAGE PAGE ORDER", step 3): the pins
 * for the INSIGHTS RAIL — the activity grid's 1-col companion that carries
 * the window's KEY DETAILS (top model + share, peak day, busiest tool,
 * active projects — NEVER the tools leaderboard, the owner's placement
 * complaint). Everything is pure-derived from the props (no queries), so the
 * pins feed fixtures directly: the honest derivations (the TOKEN-heaviest
 * model, not models[0]; the peak DAY with hour buckets grouped; the "—"
 * empty tier), the row grammar (11px label tier + 13px/600 tabular value +
 * clay-rim hairlines + at most ONE icon), and the card contract
 * (data-testid="usage-insights-rail", h-full so it fills the grid cell).
 */

/** Renders children with the live ThemeStyles (rail takes styles as a prop). */
function StylePasser({ children }: { children: (styles: ThemeStyles) => ReactNode }) {
  const styles = useThemeStyles();
  return <>{children(styles)}</>;
}

function renderRail(props: {
  models: DetailedUsageModel[];
  days: UsageDayBucket[];
  tools: DetailedUsageToolCall[];
  projectCount: number;
}) {
  return renderWithProviders(
    <StylePasser>
      {(styles) => <InsightsRail {...props} styles={styles} />}
    </StylePasser>,
  );
}

function model(name: string, calls: number, input: number, output: number, cached = 0): DetailedUsageModel {
  return { model: name, calls, tokens: { input, output, cached }, costUsd: 0 };
}

function day(date: string, input: number, output: number): UsageDayBucket {
  return { date, inputTokens: input, outputTokens: output, requests: 1, costUsd: 0 };
}

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

describe("InsightsRail (R127-W1 — the activity grid's key-details rail)", () => {
  it("renders the four key details: top model + share, peak day, busiest tool, active projects", () => {
    // The models array arrives CALL-count-desc (the server's rollup order):
    // the most-CALLED model is FIRST but the TOKEN-heaviest is second — the
    // rail must derive the token-heaviest honestly, not read models[0].
    const models = [
      model("openai/gpt-5.1", 10, 60, 40),
      model("z-ai/glm-5.2:free", 2, 500, 400, 999),
    ];
    renderRail({
      models,
      days: [day("2025-06-01", 100, 50), day("2025-06-02", 230, 100)],
      tools: [
        { tool: "read_file", count: 3, failures: 1 },
        { tool: "write_file", count: 1, failures: 0 },
      ],
      projectCount: 4,
    });

    const rail = screen.getByTestId("usage-insights-rail");
    expect(rail.getAttribute("aria-label")).toBe("Insights");

    // Top model: the token-heaviest (900 of 1000 tokens — cached counts are
    // NOT part of the share) at 90%, short-named.
    expect(within(rail).getByText("Top model")).toBeTruthy();
    expect(within(rail).getByText("glm-5.2 · 90%")).toBeTruthy();

    // Peak day: the max input+output day of the windowed series.
    expect(within(rail).getByText("Peak day")).toBeTruthy();
    expect(within(rail).getByText("Jun 2 · 330")).toBeTruthy();

    // Busiest tool: tools[0] (the count-desc server order) + its count.
    expect(within(rail).getByText("Busiest tool")).toBeTruthy();
    expect(within(rail).getByText("read_file · 3")).toBeTruthy();

    // Active projects count.
    expect(within(rail).getByText("Active projects")).toBeTruthy();
    expect(within(rail).getByText("4")).toBeTruthy();
  });

  it("the row grammar: 11px label tier + 13px/600 tabular value, clay-rim hairlines between rows, ONE icon (no rainbow), h-full card", () => {
    renderRail({
      models: [model("z-ai/glm-5.2:free", 3, 330, 150)],
      days: [day("2025-06-02", 230, 100)],
      tools: [{ tool: "read_file", count: 3, failures: 1 }],
      projectCount: 1,
    });

    const rail = screen.getByTestId("usage-insights-rail");
    // The card fills the grid cell + matches the activity card's reserved
    // height rhythm (h-full + min-h, clay card material).
    expect(rail.className).toContain("h-full");
    expect(rail.className).toContain("min-h-[248px]");
    expect(rail.className).toContain("ac-clay");

    // ONE quiet icon in the Kicker — never an icon per row.
    expect(rail.querySelectorAll("svg").length).toBe(1);

    // The value tier: 13px/600 tabular; the label tier: 11px kicker grammar.
    const value = within(rail).getByText("glm-5.2 · 100%");
    expect(value.className).toContain("text-[13px]");
    expect(value.className).toContain("font-semibold");
    expect(value.className).toContain("tabular-nums");
    const label = within(rail).getByText("Top model");
    expect(label.className).toContain("text-[11px]");
    expect(label.className).toContain("uppercase");

    // Hairline dividers between rows (border-clay-rim, never per-row cards):
    // the FIRST row carries none (the inset idiom — dividers sit BETWEEN
    // rows), every following one does.
    const rows = within(rail).getAllByText(/^(Top model|Peak day|Busiest tool|Active projects)$/);
    const rowEls = rows.map((el) => el.parentElement as HTMLElement);
    expect(rowEls.length).toBe(4);
    expect(rowEls[0].className).not.toContain("border-t");
    for (const row of rowEls.slice(1)) {
      expect(row.className).toContain("border-t");
      expect(row.className).toContain("border-clay-rim");
    }
  });

  it("empty state: every key detail renders the honest one-liner '—' tier", () => {
    renderRail({
      models: [],
      days: [day("2025-06-01", 0, 0)],
      tools: [],
      projectCount: 0,
    });

    const rail = screen.getByTestId("usage-insights-rail");
    expect(within(rail).getAllByText("—").length).toBe(4);
    // The labels still render (the honest one-liner rows, stable layout).
    expect(within(rail).getByText("Top model")).toBeTruthy();
    expect(within(rail).getByText("Peak day")).toBeTruthy();
    expect(within(rail).getByText("Busiest tool")).toBeTruthy();
    expect(within(rail).getByText("Active projects")).toBeTruthy();
  });

  it("hour buckets group to their DAY (the R127 hourly series stays a day row) and the earliest day wins ties", () => {
    renderRail({
      models: [],
      // Three hour buckets over two days: Jun 1 = 400 + 100 = 500, Jun 2 = 200.
      days: [day("2025-06-01T09", 300, 100), day("2025-06-01T15", 100, 0), day("2025-06-02T03", 150, 50)],
      tools: [],
      projectCount: 1,
    });

    const rail = screen.getByTestId("usage-insights-rail");
    expect(within(rail).getByText("Jun 1 · 500")).toBeTruthy();
  });

  it("peak-day ties keep the EARLIEST day (the stats endpoint's `tokens DESC, date ASC` semantics)", () => {
    renderRail({
      models: [],
      days: [day("2025-06-01", 200, 0), day("2025-06-02", 150, 50)],
      tools: [],
      projectCount: 1,
    });

    const rail = screen.getByTestId("usage-insights-rail");
    expect(within(rail).getByText("Jun 1 · 200")).toBeTruthy();
  });

  it("the share is the all-time model-token share (title-annotated for honesty)", () => {
    renderRail({
      models: [model("z-ai/glm-5.2:free", 3, 330, 150)],
      days: [day("2025-06-02", 230, 100)],
      tools: [{ tool: "read_file", count: 3, failures: 1 }],
      projectCount: 1,
    });

    // The rollups of GET /usage/detailed are WHOLE-HISTORY — the top-model
    // share is the all-time share and the title says so.
    const row = screen.getByText("glm-5.2 · 100%").closest('[title]') as HTMLElement;
    expect(row.title).toContain("all-time tokens");
  });
});
