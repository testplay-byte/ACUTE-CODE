import { useEffect } from "react";

/**
 * ROUND-127 (the overlay-scrollbar law — TOKENS §6 / MOTION §4, the owner:
 * "completely hide those scroll bars… they should only appear when the user
 * tries to scroll"): the GLOBAL scroll-fade listener, mounted ONCE in App.
 *
 * MECHANISM: one document-level `scroll` listener in the CAPTURE phase sees
 * every scroll event from every scroller in the tree (capture fires on the
 * way DOWN, so nested scrollers are observed without per-element
 * listeners). For each event the SCROLLING element itself (or
 * documentElement for the page scroller) is tagged with `.is-scrolling`,
 * and a per-element timer (~700ms) removes the tag after the last scroll
 * event. The CSS (index.css, the R127 block) paints every scrollbar thumb
 * TRANSPARENT at rest and tints it ONLY under `.is-scrolling` — so the
 * resting app shows ZERO scrollbar chrome while the gutter geometry stays
 * reserved (R60-B's no-reflow law: only the INK fades, the layout never
 * moves).
 *
 * The per-component `useScrollFade`/`.auto-scroll` opt-in pattern is
 * SUPERSEDED by this mechanism (kept as compat — it toggles `.scrolling`,
 * which carries the same ink values). The keyboard carve-out lives in CSS
 * (`*:focus-within` keeps a scroller's thumb visible).
 *
 * happy-dom/jsdom note: the listener attaches fine and no-ops — no test
 * geometry is required for the tag to be inert there; the suites that pin
 * this behavior drive scroll events directly (see use-global-scroll-fade.test.ts).
 */

/** How long the thumb stays tinted after the last scroll event. */
export const SCROLL_FADE_HOLD_MS = 700;

/** The class the CSS keys the tinted thumb on. */
export const SCROLLING_CLASS = "is-scrolling";

/** Per-element fade timers (a WeakMap — dead elements take their timers with them). */
const fadeTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** Resolve the element to tag for a scroll event's target. */
export function scrollTagTarget(target: EventTarget | null): Element | null {
  if (target === document || target === window) return document.documentElement;
  return target instanceof Element ? target : null;
}

/** Tag the scroller + arm its fade timer. Pure-DOM helper (test-pinnable). */
export function tagScrolling(el: Element, holdMs: number = SCROLL_FADE_HOLD_MS): void {
  el.classList.add(SCROLLING_CLASS);
  const existing = fadeTimers.get(el);
  if (existing !== undefined) clearTimeout(existing);
  fadeTimers.set(
    el,
    setTimeout(() => {
      el.classList.remove(SCROLLING_CLASS);
      fadeTimers.delete(el);
    }, holdMs),
  );
}

/** Strip the tag + drop the timer (the unmount/handoff path). */
export function untagScrolling(el: Element): void {
  el.classList.remove(SCROLLING_CLASS);
  const existing = fadeTimers.get(el);
  if (existing !== undefined) {
    clearTimeout(existing);
    fadeTimers.delete(el);
  }
}

/**
 * The App-level hook — mounted exactly once (App root). Attaches the
 * capture-phase listener on mount, detaches on unmount. The listener is a
 * stable function over document-level APIs only, so the effect runs once
 * and the DOM node set it touches is whatever scrolls, whenever it does.
 */
export function useGlobalScrollFade(): void {
  useEffect(() => {
    const onScroll = (event: Event): void => {
      const el = scrollTagTarget(event.target);
      if (el !== null) tagScrolling(el);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, []);
}
