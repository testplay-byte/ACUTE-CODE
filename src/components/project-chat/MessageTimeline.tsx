import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

// ── ROUND-120 (R120-C-PC, item 34) + ROUND-123 (R123-W-nav) + ROUND-124: ────
// the MESSAGE TIMELINE ──────────────────────────────────────────────────────
// Owner (round-120 §1 I): "The timeline is replaced: remove the current left
// timeline entirely. The new one is a message timeline — one bar per user
// message; hovering grows the bars (the nearest to the pointer largest,
// falloff with distance); the CURRENT message's bar is highlighted; hovering
// a bar shows a 2-line preview of the user's message + 2 lines of the
// agent's response; clicking scrolls to that exchange."
//
// Owner (round-123, the row redesign): "what I was hoping for it to be was
// in a ROW kind of view … the one closer to the mouse pointer is the bigger
// … It should not be shown above the text — there should always be some
// padding on the left side … I can just hover near it on the right side or
// left side and it will still register it well, but there should be a limit
// on it properly."
//
// Owner (round-124, THE FOUR VERDICTS this file answers):
//   1. "if I hover on top of the pill, then the pill does not get wider.
//      Like the pill should get more wider, but apparently it becomes a
//      circle" → WIDTH-DOMINANT growth: the magnified chip is 28px wide ×
//      9px tall (a clearly WIDER pill), never R123's 22×24 near-square that
//      rounded-full read as a circle. Height grows only 6→9.
//   2. "the highlighted pill should be the appropriate one. Because
//      currently when I tried clicking on the very top pill, still the
//      bottom pill was highlighted … if I scrolled manually still, then the
//      bottom pill would always be the highlighted one" → the highlight is
//      SCROLL-OWNED: the active row is the exchange owning the viewport's
//      upper-middle (recomputed on every scroll, rAF-throttled), and a click
//      sets it immediately (the arriving scroll only confirms). The bottom
//      row is highlighted ONLY when the reader actually sits at the bottom —
//      the stick-to-bottom truth, not a hardwired last index.
//   3. "if I click on any one of the pills, it automatically scrolls there,
//      but the message does not automatically disappear" → clicking
//      dismisses the PREVIEW POPOVER on the spot; it stays dismissed until
//      the pointer genuinely moves again (>6px) — browsing continues, the
//      just-used popover does not linger over the jumped-to text.
//   4. "the pills should be fully aligned to the left side, like to the very
//      border of the conversation window, just leaving a small padding" →
//      the rail roots at left-1 (4px) and the chips LEFT-ANCHOR inside it
//      (pl-1.5 → the pill's left edge sits 10px from the border — a small
//      padding, exactly); growth extends RIGHTWARD into the corridor, and
//      the reading column's own minimum left padding (CONTENT_H_PAD_CLASS's
//      pl-11/pl-12 floor, this round) clears the widest magnified chip at
//      EVERY window size, so the pills never ride on top of the text.
//
// The R123 corridor contract stands: the pointer-tracking hit area is an
// invisible w-9 (36px) column WIDER than the visual rows — hovering BESIDE
// a row (left of it in the gutter slack or right of it in the corridor's
// tail) still registers; the corridor's edges are the LIMIT (pointerleave
// restores every row).
//
// The rest of the R120 contract stands unchanged: ONE ROW PER USER
// EXCHANGE — folded user rows + the live turn's opener, each an honest
// <button>; riding the corridor (or keyboard-focusing a row) shows the
// preview popover — the row NEAREST the pointer owns it, the first 2 lines
// of the user's message + 2 lines of the agent's response, plain text,
// clamped; the pointer owns the preview through the SAME pointermove the
// magnification reads (no JS hover handlers — the design audit's R5 law);
// CLICK scrolls the transcript to that exchange (scrollIntoView on the user
// bubble's wrapper — the panel stamps chat-item-* ids on every transcript
// row for exactly this).
//
// Motion vocabulary: the height + width growth are CSS transitions (quick
// tier, 200ms, the app's one ease — MOTION.md §2/§1), collapsed to 0s jumps
// under prefers-reduced-motion (framer-motion's useReducedMotion — MOTION.md
// rule 4). Colors ride the CSS-var leg (bg-muted / bg-ink / bg-accent-deep
// — R126-3d-2: the active bar's DEEP accent marker fill) per TOKENS §1
// rule 4.

/** One user exchange in the transcript — the row's data. */
export interface TimelineExchange {
  /** The DOM anchor id of the exchange's user bubble (chat-item-*). */
  anchorId: string;
  /** The user's message (the preview clamps it to 2 lines). */
  userText: string;
  /** The exchange's wall-clock ts (the row's accessible label). */
  ts?: string;
  /** The agent's response text — finalText of the answering turn, the
   * error card's message, or the LIVE stream's partial answer. */
  agentText: string;
  /** The response's identity label (the turn's model) when known. */
  agentLabel?: string;
}

/** Resting row height (px) — the owner's "a row kind of view" grammar: a
 * short horizontal chip (~6px tall), quiet minimal chrome at rest. */
const REST_HEIGHT = 6;
/** The ACTIVE exchange's resting height — a touch taller at rest too. */
const ACTIVE_REST_HEIGHT = 8;
/** Resting row width (px) — a short horizontal chip, never a tall bar.
 * R130 (the owner: the quick nav "should utilize a bit less space"): the
 * rail slims from 10→8px at rest. */
const REST_WIDTH = 8;
/** The ACTIVE exchange's resting width — a touch wider at rest too. */
const ACTIVE_REST_WIDTH = 11;
/** The nearest-row magnified height (px) — modest: the pill gains 3px of
 * thickness, nothing that could ever read as a circle. */
const MAX_HEIGHT = 9;
/** The nearest-row magnified width (px) — THE dominant leg (R124 verdict
 * 1): 8→20 more than doubles the pill's width, so the grown row reads as a
 * clearly WIDER pill (R123's 22×24 near-square read as a circle). R130:
 * slimmed 28→20 with the corridor (the whole rail "utilizes a bit less
 * space" — the magnified chip + its 8px left anchor now exactly fills the
 * 28px corridor). */
const MAX_WIDTH = 20;
/** The falloff radius (px): at this distance from a row's center the growth
 * has decayed to zero — the owner's "there should be a limit" holds in Y
 * exactly as it did in R120. */
const FALLOFF_PX = 56;
/** The growth tween (ms) — MOTION.md's quick tier. */
const GROW_MS = 200;
/** How far the pointer must travel after a click before the preview
 * popover may return (R124 verdict 3 — the just-used popover dismisses on
 * click and stays dismissed through the jump; a genuine re-hover shows it
 * again). */
const PREVIEW_WAKE_PX = 6;
/** The scroll-ownership threshold: the exchange owning the viewport's
 * upper-middle owns the highlight (R124 verdict 2). */
const ACTIVE_VIEWPORT_FRACTION = 0.45;
/** Pinned-at-bottom slack: within this many px of the bottom, the LAST
 * exchange owns the highlight (the stick-to-bottom truth). */
const ACTIVE_BOTTOM_PX = 72;

/**
 * The proximity falloff (pure, exported for the test): the growth factor a
 * row at `distance` from the pointer earns — 1 at the pointer, decaying
 * linearly to 0 at FALLOFF_PX. Linear (not gaussian) keeps the magnification
 * honest to the pointer's position without overshoot.
 */
export function proximityFactor(distance: number, radius: number = FALLOFF_PX): number {
  if (distance >= radius) return 0;
  return 1 - distance / radius;
}

/** The row's target height for a given pointer distance (pure). */
export function proximityHeight(
  resting: number,
  distance: number,
  radius: number = FALLOFF_PX,
): number {
  return resting + (MAX_HEIGHT - resting) * proximityFactor(distance, radius);
}

/**
 * The row's target WIDTH for a given pointer distance (pure) — the DOMINANT
 * leg of the R124 magnification: the nearest row grows mostly WIDER (a
 * wider pill, verdict 1), with the height growing only 6→9 alongside.
 */
export function proximityWidth(
  resting: number,
  distance: number,
  radius: number = FALLOFF_PX,
): number {
  return resting + (MAX_WIDTH - resting) * proximityFactor(distance, radius);
}

/**
 * The scroll-owned ACTIVE index (pure, exported for the test): which
 * exchange owns the highlight given the scroller's geometry + the anchors'
 * tops. Rules, in order:
 *   1. pinned at (or within ACTIVE_BOTTOM_PX of) the bottom → the LAST
 *      exchange (the stick-to-bottom truth — reading the newest turn);
 *   2. otherwise the LAST exchange whose anchor top sits above the
 *      viewport's upper-middle line (ACTIVE_VIEWPORT_FRACTION) — the
 *      exchange the reader is actually reading;
 *   3. nothing above the line yet (scrolled to the very top, or the first
 *      exchange's bubble starts below it) → the FIRST exchange.
 */
export function activeIndexFromScroll(
  anchorTops: Array<number | null>,
  scrollerTop: number,
  scrollerHeight: number,
  scrollerScrollTop: number,
  scrollerScrollHeight: number,
): number {
  const last = anchorTops.length - 1;
  if (last < 0) return -1;
  const atBottom =
    scrollerScrollTop + scrollerHeight >= scrollerScrollHeight - ACTIVE_BOTTOM_PX;
  if (atBottom) return last;
  const line = scrollerTop + scrollerHeight * ACTIVE_VIEWPORT_FRACTION;
  let owner = 0;
  for (let i = 0; i < anchorTops.length; i += 1) {
    const top = anchorTops[i];
    if (top === null) continue;
    if (top <= line) owner = i;
  }
  return owner;
}

export function MessageTimeline({
  exchanges,
  scrollContainer,
}: {
  exchanges: TimelineExchange[];
  /** The transcript's scroller (AgentChatPanel's scrollRef) — the source
   * the scroll-owned highlight listens to. Optional: without it the last
   * exchange stays the active row (the pinned-bottom default) so the rail
   * degrades honestly in isolation (tests, embeds). */
  scrollContainer?: React.RefObject<HTMLDivElement | null>;
}) {
  const reduceMotion = useReducedMotion() === true;
  const stripRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** The pointer's Y (strip-local) while it rides the corridor — null when
   * it left. Drives the per-row target heights + widths (state per
   * pointermove: a tiny component; the rows themselves never re-render the
   * transcript). */
  const [pointerY, setPointerY] = useState<number | null>(null);
  /** The POINTER-owned preview row — the row nearest the pointer (the same
   * row the magnification grows largest). The design audit's R5 law: hover
   * is NOT a JS handler — the pointer corridor owns the preview, so no
   * onMouseEnter/Leave anywhere in this file. */
  const [pointerIndex, setPointerIndex] = useState<number | null>(null);
  /** The KEYBOARD-owned preview row (focus/blur on the row buttons). The
   * pointer wins while it rides the corridor (pointerIndex ?? focusIndex). */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  /** R124 verdict 3 — the click's dismissal point: non-null while the
   * preview is suppressed (the pointer has not genuinely moved since the
   * click). Cleared by the first pointermove beyond PREVIEW_WAKE_PX. */
  const clickDismissRef = useRef<{ x: number; y: number } | null>(null);
  /** R124 verdict 2 — the SCROLL-OWNED active row (the exchange owning the
   * viewport's upper-middle; the LAST exchange while pinned at the bottom).
   * Clicks set it immediately; the scroll listener confirms/refines it. */
  const [activeIndex, setActiveIndex] = useState<number>(exchanges.length - 1);

  const previewIndex =
    clickDismissRef.current !== null ? focusIndex : (pointerIndex ?? focusIndex);

  // Keep the active row honest when the exchange list itself changes (a new
  // turn landed while the reader sits at the bottom → the new last row owns
  // the highlight; the scroll effect below refines within a frame).
  useEffect(() => {
    setActiveIndex((prev) => (prev > exchanges.length - 1 ? exchanges.length - 1 : prev));
  }, [exchanges.length]);

  // ── R124 verdict 2: the scroll-owned highlight ──────────────────────────
  // One rAF-throttled passive listener on the transcript's scroller. On each
  // frame it reads every exchange anchor's top and applies
  // activeIndexFromScroll's rules. Without the scrollContainer prop (or
  // while the anchors are absent) this is a no-op and the last exchange
  // stays the active row — the pinned-bottom default.
  useEffect(() => {
    const scroller = scrollContainer?.current ?? null;
    if (scroller === null || exchanges.length === 0) return;
    let raf = 0;
    const recompute = (): void => {
      raf = 0;
      const scrollerRect = scroller.getBoundingClientRect();
      const anchorTops = exchanges.map((ex) => {
        const el = document.getElementById(ex.anchorId);
        return el === null ? null : el.getBoundingClientRect().top;
      });
      const next = activeIndexFromScroll(
        anchorTops,
        scrollerRect.top,
        scrollerRect.height,
        scroller.scrollTop,
        scroller.scrollHeight,
      );
      if (next >= 0) setActiveIndex(next);
    };
    const onScroll = (): void => {
      if (raf === 0) raf = requestAnimationFrame(recompute);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // The first read (mount + every exchange-list change): the highlight
    // starts honest instead of waiting for the reader to scroll.
    recompute();
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [exchanges, scrollContainer]);

  const restingHeight = useCallback(
    (index: number): number => (index === activeIndex ? ACTIVE_REST_HEIGHT : REST_HEIGHT),
    [activeIndex],
  );
  const restingWidth = useCallback(
    (index: number): number => (index === activeIndex ? ACTIVE_REST_WIDTH : REST_WIDTH),
    [activeIndex],
  );

  // The proximity targets: on each pointermove, read the rows' CURRENT
  // rects (the animated layout — the dock feel: growth pushes neighbors,
  // the falloff tracks it) and re-derive every row's target height AND
  // width in one pass. CSS owns the tween (style.transition below), so this
  // render is a pure target computation, never a per-frame JS loop.
  const targets: Array<{ height: number; width: number }> = exchanges.map((_, i) => {
    const restHeight = restingHeight(i);
    const restWidth = restingWidth(i);
    if (pointerY === null) return { height: restHeight, width: restWidth };
    const strip = stripRef.current;
    const row = rowRefs.current[i];
    if (strip === null || row === null) return { height: restHeight, width: restWidth };
    const stripTop = strip.getBoundingClientRect().top;
    const rowRect = row.getBoundingClientRect();
    const center = rowRect.top - stripTop + rowRect.height / 2;
    const distance = Math.abs(pointerY - center);
    return {
      height: proximityHeight(restHeight, distance),
      width: proximityWidth(restWidth, distance),
    };
  });

  // The corridor's pointer read — one handler for the whole strip (the R5
  // law's sanctioned shape: a container pointermove, never a hover pair).
  // The pointer does NOT need to sit on a row: the corridor is wider than
  // the visual rows, so hovering beside them still registers. Its edges
  // are the limit (onPointerLeave below). R124 verdict 3: while the click
  // dismissal is armed, a pointermove only WAKES the preview once the
  // pointer has genuinely traveled (>PREVIEW_WAKE_PX) — the magnification
  // keeps tracking the whole time.
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const strip = stripRef.current;
    if (strip === null) return;
    const rect = strip.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setPointerY(y);
    const dismissal = clickDismissRef.current;
    if (dismissal !== null) {
      const moved = Math.hypot(e.clientX - dismissal.x, e.clientY - dismissal.y);
      if (moved > PREVIEW_WAKE_PX) clickDismissRef.current = null;
    }
    // The preview's pointer owner: the row whose center is NEAREST the
    // pointer — the same row the falloff magnifies largest, so the grown
    // row and the popover always agree (one pointer read, no hover pair).
    let nearest: number | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rowRefs.current.length; i += 1) {
      const row = rowRefs.current[i];
      if (row === null) continue;
      const rowRect = row.getBoundingClientRect();
      const center = rowRect.top - rect.top + rowRect.height / 2;
      const distance = Math.abs(y - center);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    }
    setPointerIndex(nearest);
  };

  const onPointerLeave = (): void => {
    setPointerY(null);
    setPointerIndex(null);
    // Leaving the corridor disarms the click dismissal too — the next
    // genuine hover starts fresh.
    clickDismissRef.current = null;
  };

  // The popover's top: aligned to the previewed row's center, clamped inside
  // the strip so a row near the viewport's top/bottom never clips its
  // preview (the popover's height is bounded by the two 2-line clamps —
  // ~96px; the clamp uses that bound).
  const previewTop = (() => {
    if (previewIndex === null) return 0;
    const strip = stripRef.current;
    const row = rowRefs.current[previewIndex];
    if (strip === null || row === null) return 0;
    const stripRect = strip.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const center = rowRect.top - stripRect.top + rowRect.height / 2;
    const stripH = stripRect.height;
    const POPOVER_H = 96;
    return Math.max(2, Math.min(center - POPOVER_H / 2, stripH - POPOVER_H - 2));
  })();

  /** Click/Enter/Space on a row: scroll the transcript to the exchange and
   * dismiss the preview (R124 verdict 3) + set the highlight immediately
   * (verdict 2 — the arriving scroll only confirms it). block:"start" puts
   * the user bubble at the top of the viewport with the whole response
   * below it (the row wrappers carry scroll-mt-1 so the bubble clears the
   * scroller's edge). Reduced motion drops the smooth scroll per MOTION.md
   * rule 4. */
  const jumpTo = (anchorId: string, index: number, e: React.MouseEvent<HTMLButtonElement>): void => {
    setActiveIndex(index);
    setPointerIndex(null);
    clickDismissRef.current = { x: e.clientX, y: e.clientY };
    const el = document.getElementById(anchorId);
    if (el === null) return;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  };

  if (exchanges.length === 0) return null;

  return (
    <div
      ref={stripRef}
      data-testid="message-timeline"
      role="navigation"
      aria-label="Message timeline"
      // R124 verdict 4 + R130: left-1 (4px — "just leaving a small padding")
      // is the rail's whole left inset from the transcript viewport's
      // border, and w-7 bounds the corridor (28px: the widest thing the
      // rail may paint or track — the magnified 20px chip + its 8px
      // left-anchor slack exactly fills it; the corridor SLIMMED from w-9
      // per the owner's "utilizes a bit less space" directive, and the
      // reading column's own pl floor clears it at EVERY window size —
      // the pills never ride the text). The root itself never takes
      // pointer events; the corridor below is the one interactive surface.
      className="absolute bottom-3 top-3 left-1 z-10 w-7 pointer-events-none"
    >
      {/* THE CORRIDOR — the interactive column: a 28px-wide (w-7) pointer
          band WIDER than the visual rows (8px at rest, 20px magnified).
          Hovering NEAR a row — in the gutter slack to its left or the tail
          to its right — registers through this one pointermove (the
          owner's "I can hover near it on the right side or left side"),
          and the corridor's own edges are the LIMIT: pointerleave here
          restores every row. The rows tile its FULL width, so the same band
          is also the click target — a near-hover click lands on the row. */}
      <div
        className="relative h-full w-full flex flex-col justify-center pointer-events-auto"
        style={{ gap: exchanges.length > 40 ? "1.5px" : exchanges.length > 20 ? "2px" : "3px" }}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        {exchanges.map((ex, i) => {
          const isActive = i === activeIndex;
          const isPreviewed = previewIndex === i;
          return (
            <button
              key={`${ex.anchorId}-${i}`}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              type="button"
              data-testid="message-timeline-bar"
              data-current={isActive ? "true" : "false"}
              aria-label={`Jump to message ${i + 1} of ${exchanges.length}: ${ex.userText.slice(0, 80)}`}
              aria-current={isActive ? "true" : undefined}
              title={`Message ${i + 1} of ${exchanges.length}`}
              // The row BUTTON spans the corridor's full width at its Y
              // (the honest hit target — the 8px chip is the visual, this
              // band is the control), and LEFT-ANCHORS its chip (R124
              // verdict 4 + R130's slimmer rail): justify-start + the
              // fixed pl-1 slack pin the chip's LEFT edge 8px from the
              // viewport's border — the pills hug the very left side —
              // so the width growth extends RIGHTWARD, into the
              // corridor's tail, never leftward past the border.
              className="flex w-full items-center justify-start rounded-full pl-1 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              style={{
                height: targets[i].height,
                transitionProperty: reduceMotion ? "none" : "height",
                transitionDuration: reduceMotion ? "0ms" : `${GROW_MS}ms`,
                transitionTimingFunction: "cubic-bezier(0.25, 0.1, 0.25, 1)",
              }}
              onFocus={() => setFocusIndex(i)}
              onBlur={() => setFocusIndex(null)}
              onClick={(e) => jumpTo(ex.anchorId, i, e)}
            >
              {/* THE ROW CHIP — the horizontal pill itself (R124: a WIDER
                  pill on hover, never a circle): height follows the
                  button's animated box (6→9), width animates on the same
                  quick-tier tween (8→20, the dominant leg), kind-colored
                  on the CSS-var leg — the DEEP accent tier for the ACTIVE
                  exchange (R126-3d-2: bg-accent-deep, TOKENS §1d's marker
                  fill — the scroll-owned highlight), ink while previewed,
                  muted at rest (TOKENS §1a's quiet neutrals). */}
              <span
                aria-hidden="true"
                className={`h-full rounded-full ${
                  isActive ? "bg-accent-deep" : isPreviewed ? "bg-ink" : "bg-muted"
                }`}
                style={{
                  width: targets[i].width,
                  transitionProperty: reduceMotion ? "none" : "width, background-color",
                  transitionDuration: reduceMotion ? "0ms" : `${GROW_MS}ms`,
                  transitionTimingFunction: "cubic-bezier(0.25, 0.1, 0.25, 1)",
                }}
              />
            </button>
          );
        })}

        {/* The PREVIEW POPOVER — 2 lines of the user's message + 2 lines of
            the agent's response, plain text, clamped. Never a hit target
            (pointer-events-none): it is a preview, not a control; it follows
            the hovered/focused row and vanishes with it — and (R124 verdict
            3) it vanishes on the spot when a row is CLICKED, staying hidden
            until the pointer genuinely moves again. */}
        {previewIndex !== null && exchanges[previewIndex] !== undefined ? (
          <div
            data-testid="message-timeline-preview"
            role="group"
            aria-label="Message preview"
            className="pointer-events-none absolute left-full ml-2 w-max max-w-[300px] rounded-xl border border-line bg-card px-3 py-2.5 shadow-lg"
            style={{ top: previewTop }}
          >
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted">You</div>
            <div className="mt-0.5 line-clamp-2 break-words whitespace-pre-line text-[12px] leading-snug text-ink">
              {exchanges[previewIndex].userText.trim() !== "" ? exchanges[previewIndex].userText : "(empty message)"}
            </div>
            <div className="mt-2 font-mono text-[10px] uppercase tracking-wide text-muted">
              {exchanges[previewIndex].agentLabel ?? "Agent"}
            </div>
            <div className="mt-0.5 line-clamp-2 break-words whitespace-pre-line text-[12px] leading-snug text-muted">
              {exchanges[previewIndex].agentText.trim() !== "" ? exchanges[previewIndex].agentText : "…"}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
