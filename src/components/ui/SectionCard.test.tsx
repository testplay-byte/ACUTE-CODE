// @vitest-environment happy-dom
/**
 * ROUND-100 (R100-C) tests — the SectionCard primitive
 * (src/components/ui/SectionCard.tsx).
 *
 * The settings/panel bento card per research §C1.4 + TOKENS.md §4–5:
 * 16px radius (rounded-2xl — the 4th radius step, NOT an arbitrary value),
 * 1.5px border-line, bg-card, p-5/p-6 density, optional softShadow, and the
 * kicker/title header slot. Tests pin the class contract, the a11y wiring
 * (aria-labelledby → the h3 section title), and the theme-utility legs
 * (bg-card / border-line — the --ac-* bridge, no inline hex).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SectionCard } from "./SectionCard";

afterEach(() => {
  cleanup();
});

describe("R100-C: SectionCard (the settings/panel bento card)", () => {
  it("renders a section with the bento contract: rounded-2xl + 1.5px border-line + bg-card + p-5", () => {
    render(
      <SectionCard testId="card">
        <p>content</p>
      </SectionCard>,
    );
    const el = screen.getByTestId("card");
    expect(el.tagName).toBe("SECTION");
    expect(el.className).toContain("rounded-2xl");
    expect(el.className).toContain("border-[1.5px]");
    expect(el.className).toContain("border-line");
    expect(el.className).toContain("bg-card");
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

  it("rests FLAT by default — no inline boxShadow (cards are surfaces, not floats)", () => {
    render(
      <SectionCard testId="card">
        <p>content</p>
      </SectionCard>,
    );
    expect((screen.getByTestId("card") as HTMLElement).style.boxShadow).toBe("");
  });

  it("shadow adds the softShadow elevation via the theme pipeline (inline style, no hex)", () => {
    render(
      <SectionCard shadow testId="card">
        <p>content</p>
      </SectionCard>,
    );
    expect((screen.getByTestId("card") as HTMLElement).style.boxShadow).not.toBe("");
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
