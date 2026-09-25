// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelDonut } from "./ModelDonut";
import { deriveThemeStyles } from "../../lib/themes";
import type { UsageStatsModel } from "../../lib/api";

/** R127-W2 — the DONUT GAUGE LAW (COMPONENTS §6, binding): a share donut the
 *  owner squints at is a defect. The owner's complaint: "about the Model
 *  Usage… the donut shape is not proper. It is way too thin. It needs to be
 *  bigger." The law's pins:
 *   · SIZE 160 / STROKE 14 (a ~9% ring ratio — the 6px hairline survives
 *     only for micro-meters like the composer's ContextDonut);
 *   · the center stat at DISPLAY tier (the share % at 30px/700 tabular);
 *   · the card's reserved height grows with the gauge (min-h-[224px] /
 *     md:232px);
 *   · the R121-d mutual hover-highlight (pointer-owned, data-donut-idx on
 *     the arcs AND the legend rows) stays byte-identical — pinned so the
 *     gauge rework can never regress it. */

const GAUGE_SIZE = 160;
const GAUGE_STROKE = 14;
const GAUGE_R = (GAUGE_SIZE - GAUGE_STROKE) / 2; // 73

const styles = deriveThemeStyles("nova", true);

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

function makeModels(): UsageStatsModel[] {
  return [
    {
      model: "z-ai/glm-5.2:free",
      inputTokens: 3_000,
      outputTokens: 1_500,
      tokens: 4_500,
      costUsd: 1,
      calls: 30,
      requests: 25,
      providers: ["z-ai"],
    },
    {
      model: "openai/gpt-4o",
      inputTokens: 2_000,
      outputTokens: 1_000,
      tokens: 3_000,
      costUsd: 2,
      calls: 20,
      requests: 18,
      providers: ["openai"],
    },
    {
      model: "anthropic/claude-sonnet-4",
      inputTokens: 1_000,
      outputTokens: 500,
      tokens: 1_500,
      costUsd: 3,
      calls: 10,
      requests: 9,
      providers: ["anthropic"],
    },
  ];
}

function renderDonut() {
  return render(<ModelDonut models={makeModels()} styles={styles} />);
}

describe("ModelDonut (R127-W2 — the DONUT GAUGE LAW)", () => {
  it("the gauge ring: a 160px svg with a 14px stroke (a ~9% ring ratio — never the 6px hairline)", () => {
    renderDonut();

    const card = screen.getByTestId("model-donut");
    // The gauge svg — the card's Kicker also carries a 12px lucide icon svg,
    // so the gauge is selected through its own circles (the icon is
    // path-only).
    const track = card.querySelector<SVGCircleElement>("svg circle");
    expect(track).not.toBeNull();
    const svg = track!.closest("svg");
    expect(svg).not.toBeNull();
    // SIZE 160 — the gauge law's floor.
    expect(svg!.getAttribute("width")).toBe(String(GAUGE_SIZE));
    expect(svg!.getAttribute("height")).toBe(String(GAUGE_SIZE));

    // STROKE 14 on the recessed track AND every painted segment; the radius
    // is the (160 − 14) / 2 = 73 gauge radius.
    expect(track!.getAttribute("stroke-width")).toBe(String(GAUGE_STROKE));
    expect(track!.getAttribute("r")).toBe(String(GAUGE_R));

    const arcs = svg!.querySelectorAll("circle[data-donut-idx]");
    expect(arcs).toHaveLength(3);
    for (const arc of Array.from(arcs)) {
      expect(arc.getAttribute("stroke-width")).toBe(String(GAUGE_STROKE));
      expect(arc.getAttribute("r")).toBe(String(GAUGE_R));
    }
  });

  it("the center stat at DISPLAY tier: the top model's short name + its share at 30px/700 tabular", () => {
    renderDonut();

    // The top model (tokens-desc: 4,500 of 9,000 = 50%) carries the
    // headline. The short name keeps its 10px mono tier; the share % is the
    // display tier the gauge law mandates (30px/700 tabular).
    expect(screen.getByText("glm-5.2")).toBeTruthy();
    const share = screen.getByText("50%");
    expect(share.className).toContain("text-[30px]");
    expect(share.className).toContain("font-bold");
    expect(share.className).toContain("tabular-nums");
    expect(share.className).not.toContain("text-[22px]");
  });

  it("the card reserves the gauge's height (min-h-[224px] md:232px — the skeleton's exact geometry)", () => {
    renderDonut();
    const card = screen.getByTestId("model-donut");
    expect(card.className).toContain("min-h-[224px]");
    expect(card.className).toContain("md:min-h-[232px]");
  });

  it("the R121-d mutual hover-highlight stays: one pointer read dims every OTHER arc and legend row", () => {
    renderDonut();

    const arcs = document.querySelectorAll<SVGCircleElement>("circle[data-donut-idx]");
    const rows = document.querySelectorAll<HTMLElement>("[data-donut-row]");
    expect(rows).toHaveLength(3);

    // At rest everything is lit.
    for (const arc of Array.from(arcs)) {
      expect(arc.getAttribute("opacity")).toBe("1");
    }

    // Hovering the SECOND legend row (pointer-owned — data-donut-idx on the
    // rows AND the arcs) lights that model and dims every other arc AND row
    // (the round-97 mutual-highlight contract, unchanged by the gauge pass).
    fireEvent.pointerMove(rows[1]);
    expect(arcs[0].getAttribute("opacity")).toBe("0.3");
    expect(arcs[1].getAttribute("opacity")).toBe("1");
    expect(arcs[2].getAttribute("opacity")).toBe("0.3");
    expect(rows[0].style.opacity).toBe("0.35");
    expect(rows[1].style.opacity).toBe("1");
    expect(rows[2].style.opacity).toBe("0.35");

    // Pointer-out clears the highlight (everything back to 1).
    fireEvent.pointerLeave(screen.getByTestId("model-donut"));
    for (const arc of Array.from(arcs)) {
      expect(arc.getAttribute("opacity")).toBe("1");
    }
    for (const row of Array.from(rows)) {
      expect(row.style.opacity).toBe("1");
    }
  });

  it("the legend stays: one row per model with the stable palette dot, tokens and cost", () => {
    renderDonut();
    expect(screen.getByText("z-ai/glm-5.2:free")).toBeTruthy();
    expect(screen.getByText("openai/gpt-4o")).toBeTruthy();
    expect(screen.getByText("anthropic/claude-sonnet-4")).toBeTruthy();
    expect(screen.getByText("4.5k")).toBeTruthy();
    expect(screen.getByText("$1.00")).toBeTruthy();
    expect(screen.getByText("$3.00")).toBeTruthy();
  });
});
