// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import type { DetailedUsageToolCall } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { ToolsLeaderboard } from "./ToolsLeaderboard";
import { renderWithProviders, resetTestState } from "../../test-utils";

/**
 * ROUND-127 (R127-W1 — SCREENS §3 "THE USAGE PAGE ORDER", step 4): the pins
 * for the tools leaderboard's FULL-WIDTH treatment — the section that used
 * to squat the activity grid's 1-col rail (the owner's placement complaint)
 * now renders BELOW the grid as its own full-width clay card. The data
 * contract is unchanged (top-8 slice of the count-desc server order,
 * failures in the danger tier, the empty one-liner); the new contracts are
 * the data-testid + the w-full card so the rows stretch to the page width.
 */

/** Renders children with the live ThemeStyles (the card takes styles as a prop). */
function StylePasser({ children }: { children: (styles: ThemeStyles) => ReactNode }) {
  const styles = useThemeStyles();
  return <>{children(styles)}</>;
}

function renderLeaderboard(tools: DetailedUsageToolCall[]) {
  return renderWithProviders(
    <StylePasser>{(styles) => <ToolsLeaderboard tools={tools} styles={styles} />}</StylePasser>,
  );
}

function tenTools(): DetailedUsageToolCall[] {
  const out: DetailedUsageToolCall[] = [
    { tool: "read_file", count: 30, failures: 2 },
    { tool: "write_file", count: 12, failures: 0 },
    { tool: "exec", count: 9, failures: 1 },
    { tool: "grep", count: 8, failures: 0 },
    { tool: "glob", count: 7, failures: 0 },
    { tool: "edit_file", count: 6, failures: 3 },
    { tool: "delegate_task", count: 5, failures: 0 },
    { tool: "web_search", count: 4, failures: 0 },
  ];
  for (let i = 9; i <= 10; i += 1) {
    out.push({ tool: `tool_${i}`, count: 1, failures: 0 });
  }
  return out;
}

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

describe("ToolsLeaderboard (R127-W1 — the full-width section below the activity grid)", () => {
  it("ranks the top 8 tools with counts, failures in the danger tier, and the header count badge", () => {
    renderLeaderboard(tenTools());

    // The header: the section title + the honest total count (10 tools —
    // the top-8 slice is the RENDERED rows, never the count badge).
    expect(screen.getByText("Tool Leaderboard")).toBeTruthy();
    expect(screen.getByText("10 tools")).toBeTruthy();

    // The ranked rows: top 8 render…
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem").length).toBe(8);
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText("write_file")).toBeTruthy();
    expect(screen.getByText("web_search")).toBeTruthy();
    // …tools 9 and 10 do NOT.
    expect(screen.queryByText("tool_9")).toBeNull();
    expect(screen.queryByText("tool_10")).toBeNull();

    // Counts + failures (the danger tier rides along in the count line).
    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText("2 ✕")).toBeTruthy();
    expect(screen.getByLabelText("read_file: 30 calls, 2 failed")).toBeTruthy();

    // The bar rows keep the R126 grammar: deep-accent fill over the recessed
    // well track, relative to the most-used tool.
    const bar = screen.getByRole("progressbar", {
      name: "read_file calls relative to the most-used tool",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
    expect(bar.getAttribute("aria-valuemax")).toBe("30");
    expect(bar.className).toContain("bg-well");
  });

  it("the full-width treatment (R127-W1): the clay card carries the tools-leaderboard testid + w-full, hairline row dividers", () => {
    renderLeaderboard(tenTools());

    const card = screen.getByTestId("tools-leaderboard");
    // The same clay card species (data contract unchanged)…
    expect(card.className).toContain("ac-clay");
    // …stretching to the FULL width of its section (the rows widen with it —
    // the leaderboard is never the grid's 1-col rail anymore).
    expect(card.className).toContain("w-full");

    // The R126 flat row grammar survives the move: the 1px inset clay-rim
    // hairline BETWEEN rows (row 1 carries none).
    const rows = screen.getByRole("list").querySelectorAll("li");
    expect(rows[0].className).not.toContain("border-t");
    for (const row of Array.from(rows).slice(1)) {
      expect(row.className).toContain("border-t");
      expect(row.className).toContain("border-clay-rim");
    }
  });

  it("empty state: the honest one-liner, no rows", () => {
    renderLeaderboard([]);

    const card = screen.getByTestId("tools-leaderboard");
    expect(
      screen.getByText("No tool calls yet — they rank here as soon as agents start working."),
    ).toBeTruthy();
    expect(screen.getByText("0 tools")).toBeTruthy();
    expect(card.querySelector("ol")).toBeNull();
  });
});
