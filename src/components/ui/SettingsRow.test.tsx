// @vitest-environment happy-dom
/**
 * ROUND-100 (R100-C) tests — the SettingsRow primitive
 * (src/components/ui/SettingsRow.tsx).
 *
 * The label+control row per research §C1.2 + TOKENS.md §3 (the row-height
 * table's "Settings control row: 36px"): 36px min-height flex row, 13px/400
 * label (the weight law — chrome text is regular), optional 11px tertiary
 * description, flex-1 min-w-[200px] label block, right-aligned shrink-0
 * control slot, optional 1px border-line top divider. NO JS hover — a
 * layout row never owns interaction (hover is the parent's CSS class).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsRow } from "./SettingsRow";

afterEach(() => {
  cleanup();
});

describe("R100-C: SettingsRow (the label + control row)", () => {
  it("renders the 36px flex row with the label at body weight (13px/400 — the weight law)", () => {
    render(<SettingsRow label="Auto-retry" testId="row" />);
    const row = screen.getByTestId("row");
    expect(row.className).toContain("min-h-[36px]");
    expect(row.className).toContain("flex");
    const label = screen.getByText("Auto-retry");
    expect(label.className).toContain("text-[13px]");
    expect(label.className).toContain("font-normal");
    expect(label.className).toContain("text-ink");
  });

  it("the label block owns the flexible space with the 200px floor", () => {
    render(<SettingsRow label="Auto-retry" testId="row" />);
    const block = screen.getByText("Auto-retry").parentElement;
    expect(block?.className).toContain("flex-1");
    expect(block?.className).toContain("min-w-[200px]");
  });

  it("renders the optional description at 11px tertiary ink, ONE LINE (R126: truncate — the 36px row never inflates)", () => {
    render(<SettingsRow label="Auto-retry" description="Retry failed tool calls" testId="row" />);
    const desc = screen.getByText("Retry failed tool calls");
    expect(desc.className).toContain("text-[11px]");
    // R126-3f-1: the description ellipsizes instead of wrapping (the IDE
    // row stays 36px; the full text stays in the DOM).
    expect(desc.className).toContain("truncate");
    expect((desc as HTMLElement).style.color).not.toBe("");
  });

  it("omits the description node entirely when none is passed", () => {
    render(<SettingsRow label="Auto-retry" testId="row" />);
    const block = screen.getByText("Auto-retry").parentElement;
    expect(block?.children.length).toBe(1);
  });

  it("places the control in the right-aligned shrink-0 slot", () => {
    render(
      <SettingsRow label="Timestamps" testId="row">
        <button>Toggle</button>
      </SettingsRow>,
    );
    const control = screen.getByRole("button", { name: "Toggle" }).parentElement;
    expect(control?.className).toContain("shrink-0");
    expect(control?.className).toContain("justify-end");
  });

  it("no divider by default; divider adds the 1px border-line hairline for stacked rows", () => {
    const { rerender } = render(<SettingsRow label="First" testId="row" />);
    expect(screen.getByTestId("row").className).not.toContain("border-t");
    rerender(<SettingsRow label="Second" divider testId="row" />);
    const row = screen.getByTestId("row");
    expect(row.className).toContain("border-t");
    expect(row.className).toContain("border-line");
    // The hairline is 1px (TOKENS §5) — the divider never inherits a border
    // weight from elsewhere.
    expect(row.className).not.toContain("border-[1.5px]");
  });

  it("is a LAYOUT row — no heading, no button, no listitem role of its own", () => {
    render(
      <SettingsRow label="Theme" testId="row">
        <span>Light</span>
      </SettingsRow>,
    );
    expect(screen.getByTestId("row").tagName).toBe("DIV");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("merges className and passes data-testid through", () => {
    render(<SettingsRow label="Density" className="px-2" testId="density-row" />);
    const row = screen.getByTestId("density-row");
    expect(row.className).toContain("px-2");
    expect(row.className).toContain("min-h-[36px]");
  });
});
