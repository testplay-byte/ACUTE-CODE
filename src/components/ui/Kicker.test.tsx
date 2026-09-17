// @vitest-environment happy-dom
/**
 * ROUND-100 (R100-C) tests — the Kicker primitive (src/components/ui/Kicker.tsx).
 *
 * The ONE label-tier heading per research §C1.1 + TOKENS.md §2 (the revised
 * ladder): 11px / 500 / uppercase / tracking-[0.08em] / tertiary ink, with
 * the optional 12px lucide glyph. These tests pin the size/weight/tracking
 * CONTRACT as class names (the repo way — no getComputedStyle) plus the
 * a11y behavior of the `as` polymorphism and the data-testid passthrough.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { Kicker } from "./Kicker";

afterEach(() => {
  cleanup();
});

describe("R100-C: Kicker (the one label-tier spelling)", () => {
  it("renders its text with the label-tier class contract: 11px / 500 / uppercase / 0.08em", () => {
    render(<Kicker>Session</Kicker>);
    const el = screen.getByText("Session");
    expect(el.className).toContain("text-[11px]");
    expect(el.className).toContain("font-medium");
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("tracking-[0.08em]");
  });

  it("carries tertiary ink from the theme pipeline (inline style — the JS leg, no hex)", () => {
    render(<Kicker>Session</Kicker>);
    // deriveThemeStyles paints textTertiary per mode; presence (not the exact
    // rgba — that is themes.ts's own contract) is this primitive's contract.
    expect((screen.getByText("Session") as HTMLElement).style.color).not.toBe("");
  });

  it("defaults to a div — NOT a heading (in-card labels don't join the outline)", () => {
    render(<Kicker>Session</Kicker>);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Session").tagName).toBe("DIV");
  });

  it("as='h2' / as='h3' render real headings with the right level (section kickers)", () => {
    const { rerender } = render(<Kicker as="h2">Models</Kicker>);
    expect(screen.getByRole("heading", { level: 2, name: "Models" })).toBeTruthy();
    rerender(<Kicker as="h3">Models</Kicker>);
    expect(screen.getByRole("heading", { level: 3, name: "Models" })).toBeTruthy();
  });

  it("renders the optional lucide icon at 12px, aria-hidden (decorative)", () => {
    render(<Kicker icon={Settings}>General</Kicker>);
    const icon = screen.getByText("General").querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.classList.contains("shrink-0")).toBe(true);
  });

  it("omits the icon slot entirely when none is passed", () => {
    render(<Kicker>General</Kicker>);
    expect(screen.getByText("General").querySelector("svg")).toBeNull();
  });

  it("passes data-testid through and merges className onto the contract", () => {
    render(
      <Kicker className="mt-4" testId="settings-kicker">
        Appearance
      </Kicker>,
    );
    const el = screen.getByTestId("settings-kicker");
    expect(el.className).toContain("mt-4");
    expect(el.className).toContain("text-[11px]");
    expect(el.textContent).toBe("Appearance");
  });
});
