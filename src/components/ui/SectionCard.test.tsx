// @vitest-environment happy-dom
/**
 * ROUND-100 (R100-C) tests — the SectionCard primitive
 * (src/components/ui/SectionCard.tsx).
 *
 * R126-3f-1 re-pin — the primitive's OWN clay conversion: 16px radius
 * (rounded-2xl, the 4th radius step) + the warm 1px clay-rim hairline on
 * all four sides + bg-card + the `.ac-clay` two-leg depth (TOKENS §5/§9,
 * COMPONENTS §3 species 1). The 1.5px bento border + the softShadow leg
 * RETIRED — `shadow` is a documented NO-OP (callers keep compiling).
 * Tests pin the class contract, the a11y wiring (aria-labelledby → the h3
 * section title), and the theme-utility legs (bg-card / border-clay-rim —
 * the --ac-* bridge, no inline hex).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SectionCard } from "./SectionCard";

afterEach(() => {
  cleanup();
});

describe("R100-C / R126: SectionCard (the settings/panel clay card)", () => {
  it("R126: renders a section with the CLAY contract — rounded-2xl + 1px border-clay-rim + bg-card + .ac-clay + p-5", () => {
    render(
      <SectionCard testId="card">
        <p>content</p>
      </SectionCard>,
    );
    const el = screen.getByTestId("card");
    expect(el.tagName).toBe("SECTION");
    expect(el.className).toContain("rounded-2xl");
    // R126-3f-1: the warm 1px clay rim on all four sides replaces the
    // retired 1.5px bento border (TOKENS §5).
    expect(el.className).toContain("border-clay-rim");
    expect(el.className).not.toContain("border-[1.5px]");
    expect(el.className).toContain("bg-card");
    // The two-leg clay depth rides the pattern class (TOKENS §9) — never
    // an inline boxShadow.
    expect(el.className).toContain("ac-clay");
    expect(el.className).toContain("p-5");
    // The 16px step is a Tailwind SCALE utility — the arbitrary spelling is
    // exactly what audit rule R2 exists to retire.
    expect(el.className).not.toContain("rounded-[");
  });

  it("size='lg' steps the padding to p-6 (the 8px rhythm, TOKENS §3)", () => {
    render(
      <SectionCard size="lg" testId="card">
        <p>content</p>
      </SectionCard>,
    );
    expect(screen.getByTestId("card").className).toContain("p-6");
    expect(screen.getByTestId("card").className).not.toContain("p-5");
  });

  it("rests on the .ac-clay class — NO inline boxShadow (the clay depth is the pattern class, never a style leg)", () => {
    render(
      <SectionCard testId="card">
        <p>content</p>
      </SectionCard>,
    );
    expect((screen.getByTestId("card") as HTMLElement).style.boxShadow).toBe("");
  });

  it("R126: the `shadow` prop is a documented NO-OP — the softShadow leg died with the clay conversion (callers keep compiling)", () => {
    render(
      <SectionCard shadow testId="card">
        <p>content</p>
      </SectionCard>,
    );
    // The clay card's depth is `.ac-clay`; no inline boxShadow ever paints.
    expect((screen.getByTestId("card") as HTMLElement).style.boxShadow).toBe("");
    expect(screen.getByTestId("card").className).toContain("ac-clay");
  });

  it("title renders a 13px/600 section heading and wires aria-labelledby to it", () => {
    render(
      <SectionCard title="Appearance" testId="card">
        <p>content</p>
      </SectionCard>,
    );
    const heading = screen.getByRole("heading", { level: 3, name: "Appearance" });
    expect(heading.className).toContain("text-[13px]");
    expect(heading.className).toContain("font-semibold");
    expect(heading.className).toContain("text-ink");
    const card = screen.getByTestId("card");
    const labelledBy = card.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(heading.getAttribute("id")).toBe(labelledBy);
  });

  it("kicker renders through the Kicker primitive (the one label-tier spelling)", () => {
    render(
      <SectionCard kicker="Models" testId="card">
        <p>content</p>
      </SectionCard>,
    );
    const kicker = screen.getByText("Models");
    expect(kicker.className).toContain("text-[11px]");
    expect(kicker.className).toContain("tracking-[0.08em]");
    // Kicker-only card: no title, so no heading and no aria-labelledby.
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByTestId("card").getAttribute("aria-labelledby")).toBeNull();
  });

  it("kicker + title stack in the header slot, body below", () => {
    render(
      <SectionCard kicker="System" title="Data sources" testId="card">
        <p>body</p>
      </SectionCard>,
    );
    expect(screen.getByText("System")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Data sources" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("renders children verbatim and merges className onto the contract", () => {
    render(
      <SectionCard className="mt-6 w-full" testId="card">
        <button>Retry</button>
      </SectionCard>,
    );
    const el = screen.getByTestId("card");
    expect(el.className).toContain("mt-6");
    expect(el.className).toContain("w-full");
    expect(el.className).toContain("rounded-2xl");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
