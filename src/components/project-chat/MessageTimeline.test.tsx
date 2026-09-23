// @vitest-environment happy-dom
/**
 * ROUND-120 (R120-C-PC, item 34) + ROUND-123 (R123-W-nav) tests — the
 * MESSAGE TIMELINE: the left-rail quick navigation over the transcript.
 *
 * R120 pinned the contract (one bar per exchange, hover-proximity growth,
 * the pointer-owned preview, click-to-scroll). R123 redesigned the GEOMETRY
 * per the owner's round-123 verdict ("a ROW kind of view … there should
 * always be some padding on the left side … I can hover near it on the
 * right side or left side, but there should be a limit"):
 *  · ROWS — every exchange is a horizontal chip (a short WIDE row, not a
 *    tall thin bar), and the rows stack vertically in the rail;
 *  · the LEFT GUTTER — the rail roots at left-3 (the always-present
 *    padding) and the rows right-anchor their chips (justify-end + a fixed
 *    pr-2 slack), so growth extends LEFTWARD into the gutter and the edge
 *    facing the transcript text never moves;
 *  · the CORRIDOR — the interactive column (w-8 = 32px) is WIDER than the
 *    visual rows (10px rest / 22px magnified): hovering BESIDE a row
 *    registers, and pointerleave on the corridor is the limit;
 *  · proximity magnification now scales BOTH legs (height AND width) on
 *    the same linear falloff.
 *
 * The proximity math drives through mocked rects — happy-dom has no layout,
 * so getBoundingClientRect is programmed (see programGeometry). The
 * panel-level integration pins live in AgentChatPanel.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  MessageTimeline,
  proximityFactor,
  proximityHeight,
  proximityWidth,
  type TimelineExchange,
} from "./MessageTimeline";

const EXCHANGES: TimelineExchange[] = [
  { anchorId: "chat-item-1", userText: "first question", ts: "2026-09-23T10:00:10Z", agentText: "first answer", agentLabel: "test/model-9" },
  { anchorId: "chat-item-5", userText: "second question\nwith a second line", ts: "2026-09-23T10:01:10Z", agentText: "second answer" },
  { anchorId: "chat-item-echo", userText: "the live question", ts: "2026-09-23T10:02:10Z", agentText: "streaming so far" },
];

/** happy-dom has NO layout — every rect is 0×0 at (0,0). The rail's pointer
 * math reads the strip's + each row's rect, so the tests program a
 * deterministic geometry KEYED BY ELEMENT (call-order-independent — the
 * preview's nearest-row pass reads the same rects): the strip is 32×400
 * (the R123 corridor: w-8) at the origin; row i rests at top = 20 + i * 12
 * with the programmed height. programGeometry runs AFTER render (the rows
 * must exist). */
function programGeometry(heights: number[]): void {
  const stripRect = { top: 0, left: 0, right: 32, bottom: 400, width: 32, height: 400, x: 0, y: 0, toJSON: () => ({}) };
  const rectMap = new WeakMap<HTMLElement, DOMRect>();
  const strip = document.querySelector('[data-testid="message-timeline"]') as HTMLElement | null;
  if (strip !== null) rectMap.set(strip, stripRect as DOMRect);
  for (const [i, row] of rows().entries()) {
    const top = 20 + i * 12;
    rectMap.set(row, {
      top,
      left: 0,
      right: 32,
      bottom: top + heights[i % Math.max(heights.length, 1)],
      width: 32,
      height: heights[i % Math.max(heights.length, 1)],
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return rectMap.get(this) ?? ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  });
}

function renderTimeline(exchanges: TimelineExchange[] = EXCHANGES): HTMLElement {
  const utils = render(<div style={{ position: "relative", height: 400, width: 600 }}><MessageTimeline exchanges={exchanges} /></div>);
  return utils.container;
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="message-timeline-bar"]')) as HTMLElement[];
}

/** The corridor — the interactive column (the root's one interactive
 * child; the pointermove/pointerleave surface). */
function corridor(): HTMLElement {
  return document.querySelector('[data-testid="message-timeline"] > div') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MessageTimeline structure (R120 item 34 + the R123-W-nav row redesign)", () => {
  it("ONE ROW PER USER EXCHANGE — horizontal chips stacked in a vertical rail, every row an honest, labeled button", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);

    const strip = document.querySelector('[data-testid="message-timeline"]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.getAttribute("role")).toBe("navigation");
    expect(strip.getAttribute("aria-label")).toBe("Message timeline");

    const list = rows();
    expect(list).toHaveLength(3);
    for (const row of list) {
      expect(row.tagName).toBe("BUTTON");
      expect(row.getAttribute("aria-label")).toContain("Jump to message");
    }
    expect(list[0].getAttribute("aria-label")).toContain("first question");

    // THE ROW GRAMMAR (R123): a horizontal chip — a short WIDE row (10px
    // wide × 6px tall at rest), not R120's tall thin bar. The rows stack
    // vertically (the corridor is a flex-col) and right-anchor their
    // chips (justify-end + the fixed pr-2 slack): growth extends
    // LEFTWARD into the gutter, never rightward toward the text.
    const corridorEl = corridor();
    expect(corridorEl.className).toContain("flex-col");
    expect(list[0].className).toContain("justify-end");
    expect(list[0].className).toContain("pr-2");
    expect(list[0].style.height).toBe("6px");
    const chip = list[0].querySelector("span") as HTMLElement;
    expect(chip.style.width).toBe("10px");
  });

  it("the LEFT GUTTER + the CORRIDOR — the rail keeps always-present padding and a hit band wider than the visual rows", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);

    const strip = document.querySelector('[data-testid="message-timeline"]') as HTMLElement;
    // left-3: the always-present left gutter (12px in from the transcript
    // viewport's edge — the owner's "there should always be some padding
    // on the left side"). w-8: the corridor's bound (32px).
    expect(strip.className).toContain("left-3");
    expect(strip.className).toContain("w-8");

    // The corridor is WIDER than the visual rows — at rest AND at full
    // magnification: the rest chip is 10px wide (pinned from the DOM
    // below) and the pure width helper pins the magnified chip at
    // MAX_WIDTH 22px; both sit inside the 32px band, so the grown row
    // never leaves it.
    expect(proximityWidth(10, 0)).toBe(22);
    const chip = rows()[0].querySelector("span") as HTMLElement;
    expect(chip.style.width).toBe("10px");

    // The root never takes pointer events; the corridor is the one
    // interactive surface (the limit the owner asked for rides its edges).
    expect(strip.className).toContain("pointer-events-none");
    expect(corridor().className).toContain("pointer-events-auto");
  });

  it("the CURRENT exchange's row is highlighted — accent fill + data-current + a touch bigger at rest", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);

    const list = rows();
    expect(list[0].getAttribute("data-current")).toBe("false");
    expect(list[2].getAttribute("data-current")).toBe("true");
    const restingFill = list[0].querySelector("span") as HTMLElement;
    const currentFill = list[2].querySelector("span") as HTMLElement;
    expect(restingFill.className).toContain("bg-muted");
    expect(currentFill.className).toContain("bg-accent");
    // The current row rests a touch taller AND wider than the others.
    expect(list[2].style.height).toBe("8px");
    expect(list[0].style.height).toBe("6px");
    expect((list[2].querySelector("span") as HTMLElement).style.width).toBe("12px");
    expect((list[0].querySelector("span") as HTMLElement).style.width).toBe("10px");
  });

  it("an EMPTY exchange list renders nothing (an empty chat is a greeting, not a stack of rows)", () => {
    const { container } = render(<MessageTimeline exchanges={[]} />);
    expect(container.firstElementChild).toBeNull();
  });
});

describe("MessageTimeline proximity scaling (the dock magnification, both legs)", () => {
  it("the pure falloff: 1 at the pointer, linear decay to 0 at the radius — height AND width", () => {
    expect(proximityFactor(0)).toBe(1);
    expect(proximityFactor(28)).toBeCloseTo(0.5, 5);
    expect(proximityFactor(56)).toBe(0);
    expect(proximityFactor(120)).toBe(0);
    // A tighter radius decays faster.
    expect(proximityFactor(10, 20)).toBeCloseTo(0.5, 5);

    // The height leg: rest 6 → max 24 across the same falloff.
    expect(proximityHeight(6, 0)).toBe(24);
    expect(proximityHeight(6, 56)).toBe(6);
    // The width leg: rest 10 → max 22 (a modest growth — a grown chip,
    // never a block).
    expect(proximityWidth(10, 0)).toBe(22);
    expect(proximityWidth(10, 28)).toBeCloseTo(10 + 12 * 0.5, 5);
    expect(proximityWidth(10, 56)).toBe(10);
    expect(proximityWidth(12, 10, 20)).toBeCloseTo(12 + 10 * 0.5, 5);
  });

  it("the nearest row grows to the max (height AND width); falloff with distance; the pointer leaving restores rest", () => {
    // Resting heights: 6, 6, 8 (the last is current); widths 10, 10, 12.
    // Row centers with the programmed tops 20 + i*12: 23, 35, 48.
    renderTimeline();
    programGeometry([6, 6, 8]);
    const corridorEl = corridor();

    // Pointer EXACTLY at the second row's center (y = 35).
    fireEvent.pointerMove(corridorEl, { clientY: 35, clientX: 20 });

    const list = rows();
    // Row 1 (nearest) grows to the full max on BOTH legs.
    expect(list[1].style.height).toBe("24px");
    expect((list[1].querySelector("span") as HTMLElement).style.width).toBe("22px");
    // Row 0 (distance 12): 6 + 18 * (1 - 12/56) ≈ 20.14px tall, and
    // 10 + 12 * (44/56) ≈ 19.43px wide.
    expect(Number.parseFloat(list[0].style.height)).toBeCloseTo(6 + 18 * (44 / 56), 3);
    expect(Number.parseFloat((list[0].querySelector("span") as HTMLElement).style.width)).toBeCloseTo(10 + 12 * (44 / 56), 3);
    // Row 2 (distance 13, resting 8/12): 8 + 16 * (43/56) ≈ 20.29px tall,
    // 12 + 10 * (43/56) ≈ 19.68px wide.
    expect(Number.parseFloat(list[2].style.height)).toBeCloseTo(8 + 16 * (43 / 56), 3);
    expect(Number.parseFloat((list[2].querySelector("span") as HTMLElement).style.width)).toBeCloseTo(12 + 10 * (43 / 56), 3);

    // The pointer leaves the corridor — every row returns to rest (the
    // owner's limit: the effect stops at the corridor's edges).
    fireEvent.pointerLeave(corridorEl);
    expect(list[0].style.height).toBe("6px");
    expect(list[1].style.height).toBe("6px");
    expect(list[2].style.height).toBe("8px");
    expect((list[0].querySelector("span") as HTMLElement).style.width).toBe("10px");
    expect((list[1].querySelector("span") as HTMLElement).style.width).toBe("10px");
    expect((list[2].querySelector("span") as HTMLElement).style.width).toBe("12px");
  });

  it("hovering NEAR a row — beside it on either side of the corridor — still registers (no dead aim needed)", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);
    const corridorEl = corridor();

    // The corridor (32px wide) is wider than the visual chips: beside a
    // rest chip there is gutter slack to its LEFT and pr-2 slack to its
    // RIGHT. A pointer riding that slack — off the chip, still inside the
    // corridor — registers the same magnification (the handler lives on
    // the corridor, and the row buttons tile its full width, so the click
    // lands too). happy-dom has no layout: the corridor IS the element the
    // event lands on, and the magnified chip (22px) stays inside the band.
    fireEvent.pointerMove(corridorEl, { clientY: 35, clientX: 40 });
    const list = rows();
    expect(list[1].style.height).toBe("24px");
    expect((list[1].querySelector("span") as HTMLElement).style.width).toBe("22px");
    // The preview follows the nearest row from the slack too.
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).not.toBeNull();

    // The LIMIT: the pointer leaving the corridor stops the effect.
    fireEvent.pointerLeave(corridorEl);
    expect(list[1].style.height).toBe("6px");
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).toBeNull();
  });
});

describe("MessageTimeline preview popover (2 lines user + 2 lines agent)", () => {
  it("riding the corridor shows the preview of the NEAREST row — user text + the agent's response; moving swaps it; leaving hides it", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);
    const corridorEl = corridor();
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).toBeNull();

    // The pointer rides the corridor at row 1's center (35) — the NEAREST
    // row owns the preview (the same row the magnification grows largest;
    // one pointer read, no hover pair — the design audit's R5 law).
    fireEvent.pointerMove(corridorEl, { clientY: 35, clientX: 20 });
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

    // The pointer moves UP the rail to row 0's center (23) — the preview
    // SWAPS to the nearest row.
    fireEvent.pointerMove(corridorEl, { clientY: 23, clientX: 20 });
    const swapped = document.querySelector('[data-testid="message-timeline-preview"]') as HTMLElement;
    expect(swapped.textContent).toContain("first question");
    expect(swapped.textContent).toContain("test/model-9");

    // The pointer LEAVES the corridor — the pointer-owned preview hides (a
    // focus-owned preview would survive the pointer leaving; none here).
    fireEvent.pointerLeave(corridorEl);
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).toBeNull();
  });

  it("KEYBOARD: focusing a row shows the preview; blurring hides it", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);

    fireEvent.focus(rows()[0]);
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).not.toBeNull();
    fireEvent.blur(rows()[0]);
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).toBeNull();
  });
});

describe("MessageTimeline click-to-scroll", () => {
  it("clicking a row scrolls the exchange's DOM anchor into view", () => {
    programGeometry([6, 6, 8]);
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

    fireEvent.click(rows()[0]);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    // A row whose anchor is NOT in the DOM is a quiet no-op (never a crash).
    fireEvent.click(rows()[2]);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
