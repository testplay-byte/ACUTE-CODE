// @vitest-environment happy-dom
/**
 * ROUND-120 (R120-C-PC, item 34) tests — the MESSAGE TIMELINE: the slim bar
 * strip that replaced the R101-D dot rail + spine (the owner's round-120
 * verdict: "remove the current left timeline entirely").
 *
 * Pinned here (the component's own grammar — the panel-level integration
 * pins live in AgentChatPanel.test.tsx):
 *  · ONE BAR PER EXCHANGE, the CURRENT exchange's bar highlighted (accent);
 *  · HOVER-PROXIMITY SCALING — the bar nearest the pointer grows to the max
 *    (28px) with a linear falloff by distance (the pure falloff helpers are
 *    directly exercised; the strip leg drives them through mocked rects —
 *    happy-dom has no layout, so getBoundingClientRect is programmed);
 *  · the HOVER/FOCUS PREVIEW popover — 2-line user preview + 2-line agent
 *    preview, plain text;
 *  · CLICK-TO-SCROLL — the bar jumps to the exchange's DOM anchor
 *    (scrollIntoView; happy-dom implements it as a callable no-op we spy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MessageTimeline, proximityFactor, type TimelineExchange } from "./MessageTimeline";

const EXCHANGES: TimelineExchange[] = [
  { anchorId: "chat-item-1", userText: "first question", ts: "2026-09-23T10:00:10Z", agentText: "first answer", agentLabel: "test/model-9" },
  { anchorId: "chat-item-5", userText: "second question\nwith a second line", ts: "2026-09-23T10:01:10Z", agentText: "second answer" },
  { anchorId: "chat-item-echo", userText: "the live question", ts: "2026-09-23T10:02:10Z", agentText: "streaming so far" },
];

/** happy-dom has NO layout — every rect is 0×0 at (0,0). The strip's pointer
 * math reads the strip's + each bar's rect, so the tests program a
 * deterministic geometry: the strip is 10×400 at the origin; bar i rests at
 * top = 20 + i * 12 (8px bar + gap-ish), growing bars report their animated
 * height. */
function programGeometry(heights: number[]): void {
  const stripRect = { top: 0, left: 0, right: 10, bottom: 400, width: 10, height: 400, x: 0, y: 0, toJSON: () => ({}) };
  const barRects = heights.map((h, i) => ({
    top: 20 + i * 12,
    left: 0,
    right: 10,
    bottom: 20 + i * 12 + h,
    width: 10,
    height: h,
    x: 0,
    y: 20 + i * 12,
    toJSON: () => ({}),
  }));
  let barIndex = -1;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const isStrip = this.hasAttribute("data-testid") && this.getAttribute("data-testid") === "message-timeline";
    if (isStrip) return stripRect as DOMRect;
    const isBar = this.hasAttribute("data-testid") && this.getAttribute("data-testid") === "message-timeline-bar";
    if (isBar) {
      barIndex += 1;
      const idx = barIndex % Math.max(barRects.length, 1);
      return barRects[idx] as DOMRect;
    }
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

function renderTimeline(exchanges: TimelineExchange[] = EXCHANGES): HTMLElement {
  const utils = render(<div style={{ position: "relative", height: 400, width: 600 }}><MessageTimeline exchanges={exchanges} /></div>);
  return utils.container;
}

function bars(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="message-timeline-bar"]')) as HTMLElement[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MessageTimeline structure (ROUND-120 R120-C-PC item 34)", () => {
  it("ONE BAR PER USER EXCHANGE — and every bar is an honest, labeled button", () => {
    programGeometry([8, 8, 12]);
    renderTimeline();

    const strip = document.querySelector('[data-testid="message-timeline"]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.getAttribute("role")).toBe("navigation");
    expect(strip.getAttribute("aria-label")).toBe("Message timeline");

    const list = bars();
    expect(list).toHaveLength(3);
    for (const bar of list) {
      expect(bar.tagName).toBe("BUTTON");
      expect(bar.getAttribute("aria-label")).toContain("Jump to message");
    }
    expect(list[0].getAttribute("aria-label")).toContain("first question");
  });

  it("the CURRENT exchange's bar is highlighted — accent fill + data-current", () => {
    programGeometry([8, 8, 12]);
    renderTimeline();

    const list = bars();
    expect(list[0].getAttribute("data-current")).toBe("false");
    expect(list[2].getAttribute("data-current")).toBe("true");
    const restingFill = list[0].querySelector("span") as HTMLElement;
    const currentFill = list[2].querySelector("span") as HTMLElement;
    expect(restingFill.className).toContain("bg-muted");
    expect(currentFill.className).toContain("bg-accent");
    // The current bar rests a touch taller than the others.
    expect(list[2].style.height).toBe("12px");
    expect(list[0].style.height).toBe("8px");
  });

  it("an EMPTY exchange list renders nothing (an empty chat is a greeting, not a stack of bars)", () => {
    programGeometry([]);
    const { container } = render(<MessageTimeline exchanges={[]} />);
    expect(container.firstElementChild).toBeNull();
  });
});

describe("MessageTimeline proximity scaling (the hover growth)", () => {
  it("the pure falloff: 1 at the pointer, linear decay to 0 at the radius", () => {
    expect(proximityFactor(0)).toBe(1);
    expect(proximityFactor(28)).toBeCloseTo(0.5, 5);
    expect(proximityFactor(56)).toBe(0);
    expect(proximityFactor(120)).toBe(0);
    // A tighter radius decays faster.
    expect(proximityFactor(10, 20)).toBeCloseTo(0.5, 5);
  });

  it("the nearest bar grows to the max; falloff with distance; the pointer leaving restores rest", () => {
    // Resting: 8, 8, 12 (the last is current). Bar centers: 24, 36, 50.
    programGeometry([8, 8, 12]);
    renderTimeline();
    const stripColumn = document.querySelector('[data-testid="message-timeline"] > div') as HTMLElement;

    // Pointer EXACTLY on the second bar's center (y = 24 + 36 / 2... bar 1:
    // top 32? — center = top + h/2 → bar0: 24, bar1: 36, bar2: 50 with the
    // programmed tops 20 + i*12 + h/2.
    const pointerY = 36; // bar 1's center
    fireEvent.pointerMove(stripColumn, { clientY: pointerY, clientX: 5 });

    const list = bars();
    // Bar 1 (nearest) grows to the full max.
    expect(list[1].style.height).toBe("28px");
    // Bar 0 (distance 12): 8 + 20 * (1 - 12/56) = 8 + 20 * 0.7857… ≈ 23.71px.
    expect(Number.parseFloat(list[0].style.height)).toBeCloseTo(8 + 20 * (44 / 56), 3);
    // Bar 2 (distance 14, resting 12): 12 + 16 * (1 - 14/56) = 12 + 12 = 24px.
    expect(Number.parseFloat(list[2].style.height)).toBeCloseTo(12 + 16 * (42 / 56), 3);

    // The pointer leaves — every bar returns to its resting height.
    fireEvent.pointerLeave(stripColumn);
    expect(list[0].style.height).toBe("8px");
    expect(list[1].style.height).toBe("8px");
    expect(list[2].style.height).toBe("12px");
  });
});

describe("MessageTimeline preview popover (2 lines user + 2 lines agent)", () => {
  it("hovering a bar shows the preview — user text + the agent's response", () => {
    programGeometry([8, 8, 12]);
    renderTimeline();
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).toBeNull();

    fireEvent.mouseEnter(bars()[1]);
    const popover = document.querySelector('[data-testid="message-timeline-preview"]') as HTMLElement;
    expect(popover).not.toBeNull();
    // The USER's message (plain text — full content rides the DOM; the
    // line-clamp owns the 2-line law visually).
    expect(popover.textContent).toContain("second question");
    expect(popover.textContent).toContain("with a second line");
    // The AGENT's response preview + the identity label (the model when
    // known, "Agent" when not).
    expect(popover.textContent).toContain("second answer");
    const labels = Array.from(popover.querySelectorAll(".font-mono")).map((el) => el.textContent);
    expect(labels).toContain("Agent");
    // Never a hit target — a preview, not a control.
    expect(popover.className).toContain("pointer-events-none");

    fireEvent.mouseLeave(bars()[1]);
    // The popover follows the hover out (mouseenter/leave pairs fire blur
    // only for focus — the mouse path clears via the bar swap or leave of
    // the strip; a second bar's hover SWAPS the preview).
    fireEvent.mouseEnter(bars()[0]);
    const swapped = document.querySelector('[data-testid="message-timeline-preview"]') as HTMLElement;
    expect(swapped.textContent).toContain("first question");
    expect(swapped.textContent).toContain("test/model-9");
  });

  it("KEYBOARD: focusing a bar shows the preview; blurring hides it", () => {
    programGeometry([8, 8, 12]);
    renderTimeline();

    fireEvent.focus(bars()[0]);
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).not.toBeNull();
    fireEvent.blur(bars()[0]);
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).toBeNull();
  });
});

describe("MessageTimeline click-to-scroll", () => {
  it("clicking a bar scrolls the exchange's DOM anchor into view", () => {
    programGeometry([8, 8, 12]);
    const container = render(
      <div>
        <div id="chat-item-1">the first exchange's user bubble</div>
        <div style={{ position: "relative", height: 400, width: 600 }}>
          <MessageTimeline exchanges={EXCHANGES} />
        </div>
      </div>,
    );
    const anchor = container.container.querySelector("#chat-item-1") as HTMLElement;
    const scrollIntoView = vi.fn();
    anchor.scrollIntoView = scrollIntoView;

    fireEvent.click(bars()[0]);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    // A bar whose anchor is NOT in the DOM is a quiet no-op (never a crash).
    fireEvent.click(bars()[2]);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
