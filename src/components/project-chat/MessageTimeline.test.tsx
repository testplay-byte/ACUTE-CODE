// @vitest-environment happy-dom
/**
 * ROUND-120 (R120-C-PC, item 34) + ROUND-123 (R123-W-nav) + ROUND-124 tests —
 * the MESSAGE TIMELINE: the left-rail quick navigation over the transcript.
 *
 * R120 pinned the contract (one bar per exchange, hover-proximity growth,
 * the pointer-owned preview, click-to-scroll). R123 redesigned the GEOMETRY
 * into rows + the corridor. R124 answers the owner's four verdicts:
 *  · WIDTH-DOMINANT growth — the magnified chip is 20×9 (a clearly WIDER
 *    pill), never R123's 22×24 near-square that rounded-full read as a
 *    circle ("the pill should get more wider");
 *  · the SCROLL-OWNED highlight — activeIndexFromScroll picks the exchange
 *    owning the viewport's upper-middle (or the last while pinned at the
 *    bottom); a click sets it immediately ("the bottom pill would always
 *    be the highlighted one" — dead);
 *  · the CLICK-DISMISSED preview — the popover hides on the spot and stays
 *    hidden until the pointer genuinely moves (>6px) ("the message does
 *    not automatically disappear" — dead);
 *  · the BORDER-HUGGING rail — left-1 + LEFT-ANCHORED chips (pl-1: the
 *    pill's left edge 8px from the border), growth extends RIGHTWARD into
 *    the w-7 corridor ("the pills should be fully aligned to the left
 *    side… just leaving a small padding").
 * R130 (the owner: the quick nav "should utilize a bit less space"): the
 * corridor slims 36→28px, the chips 10→8px rest / 28→20px magnified —
 * the whole rail takes less of the reading column's left floor.
 *
 * The proximity math drives through mocked rects — happy-dom has no layout,
 * so getBoundingClientRect is programmed (see programGeometry). The
 * panel-level integration pins live in AgentChatPanel.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  MessageTimeline,
  activeIndexFromScroll,
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
 * preview's nearest-row pass reads the same rects): the strip is 28×400
 * (the R130 corridor: w-7) at the origin; row i rests at top = 20 + i * 12
 * with the programmed height. programGeometry runs AFTER render (the rows
 * must exist). */
function programGeometry(heights: number[]): void {
  const stripRect = { top: 0, left: 0, right: 28, bottom: 400, width: 28, height: 400, x: 0, y: 0, toJSON: () => ({}) };
  const rectMap = new WeakMap<HTMLElement, DOMRect>();
  const strip = document.querySelector('[data-testid="message-timeline"]') as HTMLElement | null;
  if (strip !== null) rectMap.set(strip, stripRect as DOMRect);
  for (const [i, row] of rows().entries()) {
    const top = 20 + i * 12;
    rectMap.set(row, {
      top,
      left: 0,
      right: 28,
      bottom: top + heights[i % Math.max(heights.length, 1)],
      width: 28,
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="message-timeline-bar"]')) as HTMLElement[];
}

function corridor(): HTMLElement {
  return document.querySelector('[data-testid="message-timeline"] > div') as HTMLElement;
}

/** happy-dom requestAnimationFrame is real but async — the scroll listener's
 * rAF throttle needs one flush. */
const flushRaf = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 16));

describe("MessageTimeline structure (R120 + R123 + the R124 verdicts)", () => {
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

    // THE ROW GRAMMAR (R124 verdict 4 + R130's slim): a horizontal pill
    // that LEFT-ANCHORS (justify-start + the fixed pl-1 slack — the pill's
    // left edge sits 8px from the viewport's border, "fully aligned to the
    // left side… just leaving a small padding"), so growth extends
    // RIGHTWARD into the corridor, never leftward past the border.
    const corridorEl = corridor();
    expect(corridorEl.className).toContain("flex-col");
    expect(list[0].className).toContain("justify-start");
    expect(list[0].className).toContain("pl-1");
    expect(list[0].style.height).toBe("6px");
    const chip = list[0].querySelector("span") as HTMLElement;
    expect(chip.style.width).toBe("8px");
  });

  it("the BORDER-HUGGING rail + the CORRIDOR — a small left padding, and a hit band wider than the visual rows", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);

    const strip = document.querySelector('[data-testid="message-timeline"]') as HTMLElement;
    // left-1 (4px — "just leaving a small padding") + w-7: the corridor's
    // bound (28px — R130's slim rail). The reading column's own pl floor
    // clears it at every window size, so the pills never ride the text.
    expect(strip.className).toContain("left-1");
    expect(strip.className).toContain("w-7");

    // The corridor is WIDER than the visual rows — at rest AND at full
    // magnification: the rest chip is 8px wide (pinned from the DOM
    // below) and the pure width helper pins the magnified chip at
    // MAX_WIDTH 20px; both sit inside the 28px band, so the grown row
    // never leaves it.
    expect(proximityWidth(8, 0)).toBe(20);
    const chip = rows()[0].querySelector("span") as HTMLElement;
    expect(chip.style.width).toBe("8px");

    // The root never takes pointer events; the corridor is the one
    // interactive surface (the limit the owner asked for rides its edges).
    expect(strip.className).toContain("pointer-events-none");
    expect(corridor().className).toContain("pointer-events-auto");
  });

  it("the ACTIVE row is the LAST exchange by default (no scroller — the pinned-bottom honest default), accent-filled + a touch bigger at rest", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);

    const list = rows();
    expect(list[0].getAttribute("data-current")).toBe("false");
    expect(list[2].getAttribute("data-current")).toBe("true");
    expect(list[2].getAttribute("aria-current")).toBe("true");
    const restingFill = list[0].querySelector("span") as HTMLElement;
    const activeFill = list[2].querySelector("span") as HTMLElement;
    expect(restingFill.className).toContain("bg-muted");
    // R126-3d-2 re-pin: the current exchange's bar rides the DEEP accent
    // marker tier (bg-accent-deep, TOKENS §1d — the bare bg-accent spelling
    // died with the two-tier accent).
    expect(activeFill.className).toContain("bg-accent-deep");
    // The active row rests a touch taller AND wider than the others.
    expect(list[2].style.height).toBe("8px");
    expect(list[0].style.height).toBe("6px");
    expect((list[2].querySelector("span") as HTMLElement).style.width).toBe("11px");
    expect((list[0].querySelector("span") as HTMLElement).style.width).toBe("8px");
  });

  it("an EMPTY exchange list renders nothing (an empty chat is a greeting, not a stack of rows)", () => {
    const { container } = render(<MessageTimeline exchanges={[]} />);
    expect(container.firstElementChild).toBeNull();
  });
});

describe("MessageTimeline proximity scaling (the R124 width-dominant magnification)", () => {
  it("the pure falloff: 1 at the pointer, linear decay to 0 at the radius — height AND width", () => {
    expect(proximityFactor(0)).toBe(1);
    expect(proximityFactor(28)).toBeCloseTo(0.5, 5);
    expect(proximityFactor(56)).toBe(0);
    expect(proximityFactor(120)).toBe(0);
    // A tighter radius decays faster.
    expect(proximityFactor(10, 20)).toBeCloseTo(0.5, 5);

    // The height leg: rest 6 → max 9 across the same falloff — a MODEST
    // thickness gain (R124 verdict 1: the pill must read as a WIDER pill,
    // never a circle; the near-square 22×24 is dead).
    expect(proximityHeight(6, 0)).toBe(9);
    expect(proximityHeight(6, 56)).toBe(6);
    // The width leg — THE DOMINANT ONE: rest 8 → max 20 (2.5× — the R130
    // slim rail keeps the growth clearly width-dominant).
    expect(proximityWidth(8, 0)).toBe(20);
    expect(proximityWidth(8, 28)).toBeCloseTo(8 + 12 * 0.5, 5);
    expect(proximityWidth(8, 56)).toBe(8);
    expect(proximityWidth(14, 10, 20)).toBeCloseTo(14 + 6 * 0.5, 5);
  });

  it("the nearest row grows WIDER (and only a touch taller); falloff with distance; the pointer leaving restores rest", () => {
    // Resting heights: 6, 6, 8 (the last is active); widths 8, 8, 11.
    // Row centers with the programmed tops 20 + i*12: 23, 35, 48.
    renderTimeline();
    programGeometry([6, 6, 8]);
    const corridorEl = corridor();

    // Pointer EXACTLY at the second row's center (y = 35).
    fireEvent.pointerMove(corridorEl, { clientY: 35, clientX: 20 });

    const list = rows();
    // Row 1 (nearest) grows to the full max on BOTH legs — 9px tall × 20px
    // wide: a clearly WIDER pill, never a circle.
    expect(list[1].style.height).toBe("9px");
    expect((list[1].querySelector("span") as HTMLElement).style.width).toBe("20px");
    // Row 0 (distance 12): 6 + 3 * (44/56) tall, 8 + 12 * (44/56) wide.
    expect(Number.parseFloat(list[0].style.height)).toBeCloseTo(6 + 3 * (44 / 56), 3);
    expect(Number.parseFloat((list[0].querySelector("span") as HTMLElement).style.width)).toBeCloseTo(8 + 12 * (44 / 56), 3);
    // Row 2 (distance 13, resting 8/11): 8 + 1 * (43/56) tall,
    // 11 + 9 * (43/56) wide.
    expect(Number.parseFloat(list[2].style.height)).toBeCloseTo(8 + 1 * (43 / 56), 3);
    expect(Number.parseFloat((list[2].querySelector("span") as HTMLElement).style.width)).toBeCloseTo(11 + 9 * (43 / 56), 3);

    // The pointer leaves the corridor — every row returns to rest (the
    // owner's limit: the effect stops at the corridor's edges).
    fireEvent.pointerLeave(corridorEl);
    expect(list[0].style.height).toBe("6px");
    expect(list[1].style.height).toBe("6px");
    expect(list[2].style.height).toBe("8px");
    expect((list[0].querySelector("span") as HTMLElement).style.width).toBe("8px");
    expect((list[1].querySelector("span") as HTMLElement).style.width).toBe("8px");
    expect((list[2].querySelector("span") as HTMLElement).style.width).toBe("11px");
  });

  it("hovering NEAR a row — beside it on either side of the corridor — still registers (no dead aim needed)", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);
    const corridorEl = corridor();

    // The corridor (28px wide) is wider than the visual chips: beside a
    // rest chip there is the border gutter to its LEFT and the corridor's
    // tail to its RIGHT. A pointer riding that slack — off the chip, still
    // inside the corridor — registers the same magnification (the handler
    // lives on the corridor, and the row buttons tile its full width, so
    // the click lands too). happy-dom has no layout: the corridor IS the
    // element the event lands on, and the magnified chip (20px) stays
    // inside the band.
    fireEvent.pointerMove(corridorEl, { clientY: 35, clientX: 26 });
    const list = rows();
    expect(list[1].style.height).toBe("9px");
    expect((list[1].querySelector("span") as HTMLElement).style.width).toBe("20px");
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

  it("R124 verdict 3 — CLICKING a row DISMISSES the preview on the spot; it stays dismissed until the pointer genuinely moves (>6px)", () => {
    renderTimeline();
    programGeometry([6, 6, 8]);
    const corridorEl = corridor();

    // The preview is open (pointer at row 1's center).
    fireEvent.pointerMove(corridorEl, { clientY: 35, clientX: 20 });
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).not.toBeNull();

    // CLICK row 1 — the popover disappears immediately (the jump's target
    // text is not shadowed by the just-used preview).
    // The click rides the pointer's own position (a real click's coords ARE
    // the hover coords — happy-dom's fireEvent defaults them to 0, so the
    // test passes them explicitly).
    fireEvent.click(rows()[1], { clientX: 20, clientY: 35 });
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).toBeNull();

    // A small pointer jiggle (<6px) keeps the dismissal armed.
    fireEvent.pointerMove(corridorEl, { clientY: 36, clientX: 22 });
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).toBeNull();
    // …while the magnification keeps tracking the corridor the whole time
    // (row 1 is now the ACTIVE row — resting 8 — and the pointer sits 1px
    // from its center: 8 + 1 * (1 - 1/56) ≈ 8.98px tall).
    expect(Number.parseFloat(rows()[1].style.height)).toBeCloseTo(8 + 1 * (55 / 56), 3);

    // A GENUINE move (>6px from the click point) wakes the preview again.
    fireEvent.pointerMove(corridorEl, { clientY: 35, clientX: 40 });
    expect(document.querySelector('[data-testid="message-timeline-preview"]')).not.toBeNull();
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

  it("R124 verdict 2 — clicking a row makes THAT row the active one immediately (not the forever-bottom)", () => {
    programGeometry([6, 6, 8]);
    render(
      <div>
        <div id="chat-item-1">a</div>
        <div id="chat-item-5">b</div>
        <div style={{ position: "relative", height: 400, width: 600 }}>
          <MessageTimeline exchanges={EXCHANGES} />
        </div>
      </div>,
    );

    // Before any click: the last exchange owns the highlight (the default).
    expect(rows()[2].getAttribute("data-current")).toBe("true");
    expect(rows()[0].getAttribute("data-current")).toBe("false");

    // Clicking the TOP row — the highlight follows THE CLICKED row, not the
    // bottom ("when I tried clicking on the very top pill, still the bottom
    // pill was highlighted" — dead).
    fireEvent.click(rows()[0]);
    expect(rows()[0].getAttribute("data-current")).toBe("true");
    expect(rows()[2].getAttribute("data-current")).toBe("false");
    const fill = rows()[0].querySelector("span") as HTMLElement;
    // R126-3d-2 re-pin: the active fill is bg-accent-deep (the deep marker
    // tier) — the bare bg-accent spelling died with TOKENS §1d.
    expect(fill.className).toContain("bg-accent-deep");
  });
});

describe("R124 verdict 2 — the SCROLL-OWNED active row", () => {
  it("activeIndexFromScroll (pure): pinned at the bottom → the LAST exchange; otherwise the last anchor above the upper-middle line; nothing above → the first", () => {
    // Pinned at the bottom: scrollTop + height ≥ scrollHeight - 72.
    expect(activeIndexFromScroll([100, 300, 500], 0, 400, 1600, 2000)).toBe(2);
    expect(activeIndexFromScroll([100, 300, 500], 0, 400, 1528, 2000)).toBe(2);
    // Mid-scroll: the line sits at top + 400*0.45 = 180; anchors 50 and 100
    // sit above it, anchor 500 below → the LAST above the line owns (1).
    expect(activeIndexFromScroll([50, 100, 500], 0, 400, 800, 2000)).toBe(1);
    // Reading the first exchange (anchor 0 above the line, anchor 1 below).
    expect(activeIndexFromScroll([100, 300, 500], 0, 400, 200, 2000)).toBe(0);
    // Nothing above the line yet → the first exchange.
    expect(activeIndexFromScroll([400, 800, 1200], 0, 400, 0, 2000)).toBe(0);
    // A null anchor (an anchor not yet in the DOM) is skipped, not fatal —
    // anchor 1 (top 100, above the line) still owns the highlight.
    expect(activeIndexFromScroll([null, 100, 500], 0, 400, 800, 2000)).toBe(1);
    // ALL anchors null → the first exchange is the honest default.
    expect(activeIndexFromScroll([null, null, null], 0, 400, 800, 2000)).toBe(0);
    // Empty list → -1 (no highlight to own).
    expect(activeIndexFromScroll([], 0, 400, 0, 2000)).toBe(-1);
  });

  it("the scroll listener moves the highlight as the reader scrolls (rAF-throttled), and the bottom pin restores the LAST row", async () => {
    // The scroller + the anchors + the rail, all under one program of
    // rects: the scroller is 400 tall at the origin; anchor tops 100/300/500.
    const scrollerRef = { current: null as HTMLDivElement | null };
    const anchorTops = new WeakMap<HTMLElement, number>();
    const { container } = render(
      <div>
        <div id="chat-item-1">a</div>
        <div id="chat-item-5">b</div>
        <div id="chat-item-echo">c</div>
        <div ref={(el: HTMLDivElement | null) => { scrollerRef.current = el; }} style={{ position: "relative", height: 400, width: 600 }}>
          <MessageTimeline exchanges={EXCHANGES} scrollContainer={scrollerRef} />
        </div>
      </div>,
    );
    const scroller = scrollerRef.current as HTMLDivElement;
    expect(scroller).not.toBeNull();
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => 800 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2000 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === scroller) {
        return { top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      const anchorTop = anchorTops.get(this);
      if (anchorTop !== undefined) {
        return { top: anchorTop, left: 0, right: 100, bottom: anchorTop + 20, width: 100, height: 20, x: 0, y: anchorTop, toJSON: () => ({}) } as DOMRect;
      }
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    for (const [id, top] of [
      ["chat-item-1", 100],
      ["chat-item-5", 300],
      ["chat-item-echo", 500],
    ] as Array<[string, number]>) {
      anchorTops.set(container.querySelector(`#${id}`) as HTMLElement, top);
    }

    // Mid-scroll (scrollTop 800): the upper-middle line sits at 180 —
    // anchor 0 (top 100) is above it, anchor 1 (300) below → owner 0.
    fireEvent.scroll(scroller);
    await flushRaf();
    await vi.waitFor(() => {
      expect(rows()[0].getAttribute("data-current")).toBe("true");
      expect(rows()[2].getAttribute("data-current")).toBe("false");
    });

    // Scrolled deep (scrollTop 1528 — within 72px of the bottom pin):
    // the LAST exchange owns the highlight.
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => 1528 });
    fireEvent.scroll(scroller);
    await flushRaf();
    await vi.waitFor(() => {
      expect(rows()[2].getAttribute("data-current")).toBe("true");
      expect(rows()[0].getAttribute("data-current")).toBe("false");
    });
  });
});
