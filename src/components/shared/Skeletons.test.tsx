// @vitest-environment happy-dom
/**
 * ROUND-97 (R97-I): the shared skeleton primitives' contract — decorative
 * (aria-hidden) blocks/rows in the theme's subtle surface, so every loading
 * state in the app speaks the same shape.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { SkeletonBlock, SkeletonRows } from "./Skeletons";
import { renderWithProviders, resetTestState } from "../../test-utils";

beforeEach(() => {
  resetTestState();
});

describe("Skeletons (R97-I)", () => {
  it("SkeletonBlock is decorative + pulsing + theme-surfaced", () => {
    const { container } = renderWithProviders(<SkeletonBlock className="h-10 w-full" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.tagName).toBe("DIV");
    expect(block.getAttribute("aria-hidden")).toBe("true");
    expect(block.className).toContain("animate-pulse");
    expect(block.className).toContain("h-10");
    // The theme bridge supplies the surface color (never a hardcoded hex).
    expect(block.style.background).not.toBe("");
  });

  it("SkeletonRows renders N rows with the caller's shape", () => {
    const { container } = renderWithProviders(<SkeletonRows rows={5} rowClassName="h-8 rounded-lg" />);
    const rows = container.firstElementChild as HTMLElement;
    expect(rows.children).toHaveLength(5);
    for (const row of Array.from(rows.children)) {
      expect((row as HTMLElement).className).toContain("h-8");
      expect((row as HTMLElement).className).toContain("rounded-lg");
      expect((row as HTMLElement).className).toContain("animate-pulse");
    }
    expect(rows.getAttribute("aria-hidden")).toBe("true");
  });
});
