// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ClampedText } from "./ClampedText";
import { renderWithProviders, resetTestState } from "../../test-utils";

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

/** Force the overflow measurement: jsdom lays out nothing, so scrollHeight /
 * clientHeight are 0 by default. forceOverflow(true) makes content "overflow". */
function forceOverflow(overflows: boolean) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    value: overflows ? 500 : 0,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    value: 40,
  });
}

/** happy-dom drops unknown CSS properties from the inline style attribute, so
 * the clamp value can't be read back from the DOM. Intercept the property
 * WRITE instead — React assigns `style.WebkitLineClamp = value` on render. */
let clampWrites: string[] = [];
function interceptClampWrites() {
  clampWrites = [];
  Object.defineProperty(CSSStyleDeclaration.prototype, "WebkitLineClamp", {
    configurable: true,
    set(v: unknown) {
      clampWrites.push(String(v));
    },
    get() {
      return undefined;
    },
  });
}

beforeEach(() => {
  resetTestState();
  forceOverflow(false);
  interceptClampWrites();
});

describe("ClampedText (ROUND-43: 6-line default clamp)", () => {
  it("renders short content with no expand toggle", () => {
    renderWithProviders(<ClampedText text="short message" />);
    expect(screen.getByText("short message")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("clamps overflowing content at SIX lines by default and toggles full text", () => {
    forceOverflow(true);
    renderWithProviders(
      <ClampedText text={"line\n".repeat(30)} expandLabel="Show full message" collapseLabel="Show less" />,
    );

    // ROUND-43 owner directive: minimized mode = 6 lines (was 10 in R42).
    expect(clampWrites.at(-1)).toBe("6");

    // Overflow → the manual expand toggle appears…
    fireEvent.click(screen.getByRole("button", { name: "Show full message" }));
    // …and the clamp is released while expanded (React clears the property).
    expect(clampWrites.at(-1)).toBe("");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();

    // Collapse re-clamps at 6.
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(clampWrites.at(-1)).toBe("6");
  });

  it("honors an explicit lines override", () => {
    forceOverflow(true);
    renderWithProviders(<ClampedText text={"x\n".repeat(40)} lines={3} />);
    expect(clampWrites.at(-1)).toBe("3");
  });

  it("stops click propagation so the toggle never opens a parent row", () => {
    forceOverflow(true);
    const onParentClick = vi.fn();
    renderWithProviders(
      <div onClick={onParentClick}>
        <ClampedText text={"long\n".repeat(20)} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
