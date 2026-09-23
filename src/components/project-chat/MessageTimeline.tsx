import { useCallback, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

// ── ROUND-120 (R120-C-PC, item 34): the MESSAGE TIMELINE ────────────────────
// Owner (round-120 §1 I): "The timeline is replaced: remove the current left
// timeline entirely. The new one is a message timeline — one bar per user
// message; hovering grows the bars (the nearest to the pointer largest,
// falloff with distance); the CURRENT message's bar is highlighted; hovering
// a bar shows a 2-line preview of the user's message + 2 lines of the
// agent's response; clicking scrolls to that exchange."
//
// The R101-D dot rail + spine are RETIRED with this component. What replaces
// them is a slim VERTICAL BAR STRIP docked at the left edge of the transcript
// viewport (it does NOT scroll with the content — it is a navigational
// minimap: every exchange stays reachable even while reading deep history):
//   · ONE BAR PER USER EXCHANGE — folded user rows + the live turn's opener
//     (the optimistic echo, the remote mirror's bubble, or a delivered
//     queued message still live-rendering), each an honest <button>;
//   · HOVER-PROXIMITY SCALING — the bar nearest the pointer grows to
//     MAX_HEIGHT (28px) with a linear falloff to its resting height over
//     FALLOFF_PX (the dock-magnification grammar, on the house quick tier:
//     a 200ms CSS height transition on the shared ease);
//   · the CURRENT exchange's bar is highlighted (accent fill + a taller
//     resting height);
//   · RIDING THE STRIP (or keyboard-focusing a bar) shows a preview popover:
//     the bar NEAREST the pointer owns it — the first 2 lines of the user's
//     message + 2 lines of the agent's response, plain text, clamped
//     (line-clamp-2 owns the "2 lines" law so long single lines wrap
//     honestly); the pointer owns the preview through the SAME pointermove
//     the magnification reads (no JS hover handlers — the design audit's
//     R5 law: hover is a CSS class or a pointer read, never a hover pair);
//   · CLICK scrolls the transcript to that exchange (scrollIntoView on the
//     user bubble's wrapper — the panel stamps chat-item-* ids on every
//     transcript row for exactly this).
//
// Motion vocabulary: the height growth is a CSS transition (quick tier,
// 200ms, the app's one ease — MOTION.md §2/§1), collapsed to a 0s jump under
// prefers-reduced-motion (framer-motion's useReducedMotion — MOTION.md rule
// 4: reduced motion is a first-class input; the end-state — the grown bar —
// is always visible, never layout-dependent on the tween). Colors ride the
// CSS-var leg (bg-muted / bg-ink / bg-accent) per TOKENS §1 rule 4.

/** One user exchange in the transcript — the bar's data. */
export interface TimelineExchange {
  /** The DOM anchor id of the exchange's user bubble (chat-item-*). */
  anchorId: string;
  /** The user's message (the preview clamps it to 2 lines). */
  userText: string;
  /** The exchange's wall-clock ts (the bar's accessible label). */
  ts?: string;
  /** The agent's response text — finalText of the answering turn, the
   * error card's message, or the LIVE stream's partial answer. */
  agentText: string;
  /** The response's identity label (the turn's model) when known. */
  agentLabel?: string;
}

/** Resting bar height (px) — the round plan's "4-8px wide bars" grammar:
 * quiet, minimal chrome at rest. */
const REST_HEIGHT = 8;
/** The CURRENT exchange's resting height — a touch taller at rest too. */
const CURRENT_REST_HEIGHT = 12;
/** The nearest-bar magnified height (px). */
const MAX_HEIGHT = 28;
/** The falloff radius (px): at this distance from a bar's center the growth
 * has decayed to zero. */
const FALLOFF_PX = 56;
/** The growth tween (ms) — MOTION.md's quick tier. */
const GROW_MS = 200;

/**
 * The proximity falloff (pure, exported for the test): the growth factor a
 * bar at `distance` from the pointer earns — 1 at the pointer, decaying
 * linearly to 0 at FALLOFF_PX. Linear (not gaussian) keeps the magnification
 * honest to the pointer's position without overshoot.
 */
export function proximityFactor(distance: number, radius: number = FALLOFF_PX): number {
  if (distance >= radius) return 0;
  return 1 - distance / radius;
}

/** The bar's target height for a given pointer distance (pure). */
export function proximityHeight(
  resting: number,
  distance: number,
  radius: number = FALLOFF_PX,
): number {
  return resting + (MAX_HEIGHT - resting) * proximityFactor(distance, radius);
}

export function MessageTimeline({ exchanges }: { exchanges: TimelineExchange[] }) {
  const reduceMotion = useReducedMotion() === true;
  const stripRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** The pointer's Y (strip-local) while it rides the strip — null when it
   * left. Drives the per-bar target heights (state per pointermove: a tiny
   * component; the bars themselves never re-render the transcript). */
  const [pointerY, setPointerY] = useState<number | null>(null);
  /** The POINTER-owned preview bar — the bar nearest the pointer (the same
   * bar the magnification grows largest). The design audit's R5 law: hover
   * is NOT a JS handler — the pointer column owns the preview, so no
   * onMouseEnter/Leave anywhere in this file. */
  const [pointerIndex, setPointerIndex] = useState<number | null>(null);
  /** The KEYBOARD-owned preview bar (focus/blur on the bar buttons). The
   * pointer wins while it rides the strip (pointerIndex ?? focusIndex). */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  /** The hovered/focused bar — owns the preview popover. */
  const previewIndex = pointerIndex ?? focusIndex;

  const restingHeight = useCallback(
    (index: number): number => (index === exchanges.length - 1 ? CURRENT_REST_HEIGHT : REST_HEIGHT),
    [exchanges.length],
  );

  // The proximity targets: on each pointermove, read the bars' CURRENT
  // rects (the animated layout — the dock feel: growth pushes neighbors,
  // the falloff tracks it) and re-derive every bar's target height. CSS
  // owns the tween (style.transition below), so this render is a pure
  // target computation, never a per-frame JS animation loop.
  const targets: number[] = exchanges.map((_, i) => {
    const resting = restingHeight(i);
    if (pointerY === null) return resting;
    const strip = stripRef.current;
    const bar = barRefs.current[i];
    if (strip === null || bar === null) return resting;
    const stripTop = strip.getBoundingClientRect().top;
    const barRect = bar.getBoundingClientRect();
    const center = barRect.top - stripTop + barRect.height / 2;
    return proximityHeight(resting, Math.abs(pointerY - center));
  });

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const strip = stripRef.current;
    if (strip === null) return;
    const rect = strip.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setPointerY(y);
    // The preview's pointer owner: the bar whose center is NEAREST the
    // pointer — the same bar the falloff magnifies largest, so the grown
    // bar and the popover always agree (one pointer read, no hover pair).
    let nearest: number | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < barRefs.current.length; i += 1) {
      const bar = barRefs.current[i];
      if (bar === null) continue;
      const barRect = bar.getBoundingClientRect();
      const center = barRect.top - rect.top + barRect.height / 2;
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

  // The popover's top: aligned to the hovered bar's center, clamped inside
  // the strip so a bar near the viewport's top/bottom never clips its
  // preview (the popover's height is bounded by the two 2-line clamps —
  // ~96px; the clamp uses that bound).
  const previewTop = (() => {
    if (previewIndex === null) return 0;
    const strip = stripRef.current;
    const bar = barRefs.current[previewIndex];
    if (strip === null || bar === null) return 0;
    const stripRect = strip.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const center = barRect.top - stripRect.top + barRect.height / 2;
    const stripH = stripRect.height;
    const POPOVER_H = 96;
    return Math.max(2, Math.min(center - POPOVER_H / 2, stripH - POPOVER_H - 2));
  })();

  /** Click/Enter/Space on a bar: scroll the transcript to the exchange.
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
      className="absolute bottom-3 top-3 left-1 z-10 pointer-events-none"
    >
      {/* The interactive column: 10px wide hit area, vertically centered —
          the bars (4px visual) ride inside generous buttons so a resting
          8px bar is still a real target (44px is the touch floor; pointer
          precision + the proximity growth carry the mouse path, and every
          bar is keyboard-focusable with the popover preview on focus). */}
      <div
        className="relative h-full w-2.5 flex flex-col items-center justify-center pointer-events-auto"
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
                barRefs.current[i] = el;
              }}
              type="button"
              data-testid="message-timeline-bar"
              data-current={isCurrent ? "true" : "false"}
              aria-label={`Jump to message ${i + 1} of ${exchanges.length}: ${ex.userText.slice(0, 80)}`}
              title={`Message ${i + 1} of ${exchanges.length}`}
              className="flex w-2.5 items-center justify-center rounded-full transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              style={{
                height: targets[i],
                transitionProperty: reduceMotion ? "none" : "height, background-color",
                transitionDuration: reduceMotion ? "0ms" : `${GROW_MS}ms`,
                transitionTimingFunction: "cubic-bezier(0.25, 0.1, 0.25, 1)",
              }}
              onFocus={() => setFocusIndex(i)}
              onBlur={() => setFocusIndex(null)}
              onClick={() => jumpTo(ex.anchorId)}
            >
              {/* The visual bar: 4px wide, kind-colored on the CSS-var leg —
                  accent for the CURRENT exchange, ink while previewed, muted
                  at rest (TOKENS §1a's quiet neutrals). */}
              <span
                aria-hidden="true"
                className={`h-full w-1 rounded-full transition-colors duration-150 ${
                  isCurrent ? "bg-accent" : isPreviewed ? "bg-ink" : "bg-muted"
                }`}
              />
            </button>
          );
        })}

        {/* The PREVIEW POPOVER — 2 lines of the user's message + 2 lines of
            the agent's response, plain text, clamped. Never a hit target
            (pointer-events-none): it is a preview, not a control; it follows
            the hovered/focused bar and vanishes with it. */}
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
