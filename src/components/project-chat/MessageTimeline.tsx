import { useCallback, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

// ── ROUND-120 (R120-C-PC, item 34) + ROUND-123 (R123-W-nav): the MESSAGE
// TIMELINE ──────────────────────────────────────────────────────────────────
// Owner (round-120 §1 I): "The timeline is replaced: remove the current left
// timeline entirely. The new one is a message timeline — one bar per user
// message; hovering grows the bars (the nearest to the pointer largest,
// falloff with distance); the CURRENT message's bar is highlighted; hovering
// a bar shows a 2-line preview of the user's message + 2 lines of the
// agent's response; clicking scrolls to that exchange."
//
// Owner (round-123, the redesign verdict — the R120 bar column read as a
// column of vertical pills): "It does show me the column of the
// conversations properly and it expands the one which I am hovering on
// properly, but the overall experience is not that good … what I was hoping
// for it to be was in a ROW kind of view. Like they will be shown in rows
// and when I hover on top of it, then the row will expand bigger … the one
// closer to the mouse pointer is the bigger, and the other ones are smaller
// as they go further away. It should not be shown above the text — there
// should always be some padding on the left side so the distance between
// the things is proper. And I do not need to hover directly on top of it —
// I can just hover near it on the right side or left side and it will still
// register it well, but there should be a limit on it properly."
//
// R123 turns that verdict into GEOMETRY (everything R120 already did right
// — the pointer-owned preview, click-to-scroll, the current-exchange
// highlight, the reduced-motion collapse — is kept as-is):
//   · ROWS, NOT A BAR COLUMN — every exchange is a horizontal ROW CHIP
//     (REST_HEIGHT 6px tall × REST_WIDTH 10px wide at rest, rounded-full)
//     and the chips stack VERTICALLY in the left rail — the dock's
//     magnification grammar rotated into a column (R120's 4px-wide pills
//     are retired with this spelling);
//   · DOCK MAGNIFICATION ON THE Y AXIS — the row NEAREST the pointer grows
//     to MAX_HEIGHT (24px) × MAX_WIDTH (22px) with the same linear falloff
//     over FALLOFF_PX (56px): BOTH legs scale, so the nearest row reads as
//     a grown chip and the neighbors shrink progressively further away;
//   · THE LEFT GUTTER (owner: "it should not be shown above the text …
//     there should always be some padding on the left side") — the rail's
//     interactive column starts at left-3 (12px in from the transcript
//     viewport's left edge: padding that is ALWAYS there) and every row
//     ANCHORS ITS RIGHT EDGE (the row buttons tile the corridor's full
//     width and right-align their chip against a fixed pr-2 slack), so
//     magnification grows LEFTWARD into the gutter and the edge that faces
//     the transcript text NEVER MOVES — the text keeps its distance at
//     every magnification, never just at rest;
//   · THE CORRIDOR (owner: "I can hover near it on the right side or left
//     side … but there should be a limit") — the pointer-tracking hit area
//     is an invisible w-8 (32px) column WIDER than the visual rows (22px
//     at full magnification, 10px at rest): hovering BESIDE a row — left
//     of it in the gutter slack or right of it in the pr-2 slack — still
//     registers, because the row buttons tile the corridor's full width
//     (so a near-hover click lands too). The corridor's own edges are the
//     LIMIT: pointerleave on the corridor restores every row to rest, and
//     the falloff radius bounds the effect in Y — the magnification never
//     bleeds past the band the pointer actually rides.
//
// The rest of the R120 contract stands unchanged: ONE ROW PER USER
// EXCHANGE — folded user rows + the live turn's opener (the optimistic
// echo, the remote mirror's bubble, or a delivered queued message still
// live-rendering), each an honest <button>; the CURRENT exchange's row is
// highlighted (accent fill + a touch taller/wider at rest); riding the
// corridor (or keyboard-focusing a row) shows the preview popover — the
// row NEAREST the pointer owns it, the first 2 lines of the user's message
// + 2 lines of the agent's response, plain text, clamped (line-clamp-2
// owns the "2 lines" law so long single lines wrap honestly); the pointer
// owns the preview through the SAME pointermove the magnification reads
// (no JS hover handlers — the design audit's R5 law: hover is a CSS class
// or a pointer read, never a hover pair); CLICK scrolls the transcript to
// that exchange (scrollIntoView on the user bubble's wrapper — the panel
// stamps chat-item-* ids on every transcript row for exactly this).
//
// Motion vocabulary: the height + width growth are CSS transitions (quick
// tier, 200ms, the app's one ease — MOTION.md §2/§1), collapsed to 0s jumps
// under prefers-reduced-motion (framer-motion's useReducedMotion — MOTION.md
// rule 4: reduced motion is a first-class input; the end-state — the grown
// row — is always visible, never layout-dependent on the tween). Colors ride
// the CSS-var leg (bg-muted / bg-ink / bg-accent) per TOKENS §1 rule 4.

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
/** The CURRENT exchange's resting height — a touch taller at rest too. */
const CURRENT_REST_HEIGHT = 8;
/** Resting row width (px) — a short horizontal chip, never a tall bar. */
const REST_WIDTH = 10;
/** The CURRENT exchange's resting width — a touch wider at rest too. */
const CURRENT_REST_WIDTH = 12;
/** The nearest-row magnified height (px). */
const MAX_HEIGHT = 24;
/** The nearest-row magnified width (px) — a modest width growth (10→22)
 * so the grown row still reads as a chip, never a block. */
const MAX_WIDTH = 22;
/** The falloff radius (px): at this distance from a row's center the growth
 * has decayed to zero — the owner's "there should be a limit" holds in Y
 * exactly as it did in R120. */
const FALLOFF_PX = 56;
/** The growth tween (ms) — MOTION.md's quick tier. */
const GROW_MS = 200;

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
 * The row's target WIDTH for a given pointer distance (pure) — the second
 * leg of the R123 dock magnification: the nearest row grows taller AND
 * wider on the same linear falloff, so the magnified row reads as an
 * expanded chip (the R120 bars scaled height only).
 */
export function proximityWidth(
  resting: number,
  distance: number,
  radius: number = FALLOFF_PX,
): number {
  return resting + (MAX_WIDTH - resting) * proximityFactor(distance, radius);
}

export function MessageTimeline({ exchanges }: { exchanges: TimelineExchange[] }) {
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
  /** The hovered/focused row — owns the preview popover. */
  const previewIndex = pointerIndex ?? focusIndex;

  const restingHeight = useCallback(
    (index: number): number => (index === exchanges.length - 1 ? CURRENT_REST_HEIGHT : REST_HEIGHT),
    [exchanges.length],
  );
  const restingWidth = useCallback(
    (index: number): number => (index === exchanges.length - 1 ? CURRENT_REST_WIDTH : REST_WIDTH),
    [exchanges.length],
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
  // the visual rows, so hovering beside them (gutter side or text side)
  // still registers. Its edges are the limit (onPointerLeave below).
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const strip = stripRef.current;
    if (strip === null) return;
    const rect = strip.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setPointerY(y);
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

  /** Click/Enter/Space on a row: scroll the transcript to the exchange.
   * block:"start" puts the user bubble at the top of the viewport with the
   * whole response below it (the row wrappers carry scroll-mt-1 so the
   * bubble clears the scroller's edge). Reduced motion drops the smooth
   * scroll per MOTION.md rule 4. */
  const jumpTo = (anchorId: string): void => {
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
      // R123-W-nav: left-3 (was R120's left-1) is the ALWAYS-PRESENT LEFT
      // GUTTER — the owner's "there should always be some padding on the
      // left side" — and w-8 bounds the corridor (the widest thing the rail
      // may paint or track; the magnified row at 22px never crosses it).
      // The root itself never takes pointer events; the corridor below is
      // the one interactive surface.
      className="absolute bottom-3 top-3 left-3 z-10 w-8 pointer-events-none"
    >
      {/* THE CORRIDOR — the interactive column: a 32px-wide (w-8) pointer
          band WIDER than the visual rows (10px at rest, 22px magnified).
          Hovering NEAR a row — in the gutter slack to its left or the
          pr-2 slack to its right — registers through this one pointermove
          (the owner's "I can hover near it on the right side or left
          side"), and the corridor's own edges are the LIMIT: pointerleave
          here restores every row (the owner's "there should be a limit on
          it properly"). The rows tile its FULL width, so the same band is
          also the click target — a near-hover click lands on the row. */}
      <div
        className="relative h-full w-full flex flex-col justify-center pointer-events-auto"
        style={{ gap: exchanges.length > 40 ? "1.5px" : exchanges.length > 20 ? "2px" : "3px" }}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        {exchanges.map((ex, i) => {
          const isCurrent = i === exchanges.length - 1;
          const isPreviewed = previewIndex === i;
          return (
            <button
              key={`${ex.anchorId}-${i}`}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              type="button"
              data-testid="message-timeline-bar"
              data-current={isCurrent ? "true" : "false"}
              aria-label={`Jump to message ${i + 1} of ${exchanges.length}: ${ex.userText.slice(0, 80)}`}
              title={`Message ${i + 1} of ${exchanges.length}`}
              // The row BUTTON spans the corridor's full width at its Y
              // (the honest hit target — the 10px chip is the visual, this
              // band is the control), and RIGHT-ANCHORS its chip:
              // justify-end + the fixed pr-2 slack pin the chip's right
              // edge, so the width growth extends LEFTWARD into the
              // gutter — the edge facing the transcript text never moves
              // (the owner's "it should not be shown above the text").
              className="flex w-full items-center justify-end rounded-full pr-2 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              style={{
                height: targets[i].height,
                transitionProperty: reduceMotion ? "none" : "height",
                transitionDuration: reduceMotion ? "0ms" : `${GROW_MS}ms`,
                transitionTimingFunction: "cubic-bezier(0.25, 0.1, 0.25, 1)",
              }}
              onFocus={() => setFocusIndex(i)}
              onBlur={() => setFocusIndex(null)}
              onClick={() => jumpTo(ex.anchorId)}
            >
              {/* THE ROW CHIP — the horizontal row itself (R123: a chip,
                  not R120's tall thin bar): height follows the button's
                  animated box, width animates on the same quick-tier
                  tween, kind-colored on the CSS-var leg — accent for the
                  CURRENT exchange, ink while previewed, muted at rest
                  (TOKENS §1a's quiet neutrals). */}
              <span
                aria-hidden="true"
                className={`h-full rounded-full ${
                  isCurrent ? "bg-accent" : isPreviewed ? "bg-ink" : "bg-muted"
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
            the hovered/focused row and vanishes with it. */}
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
