import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ROUND-95 (R95-D, owner: "The thinking area was not auto-scrolling to the
 * very bottom… If I scroll up in the thinking area, then it should not
 * auto-scroll again. It should only scroll if I scroll to the very bottom
 * and leave it there."): the SMALL-BLOCK stick-to-bottom primitive — the
 * same reasoning as AgentChatPanel's R94-D2 transcript machinery, shrunk to
 * a single scrolling card (the live thinking block's max-h-64 body):
 *
 *   • PINNED = the viewport sits within `threshold` px (default 24 — the
 *     LiveOutputTail/LiveWritePreview small-block convention in this
 *     folder) of the block's own bottom. While pinned, every deps change
 *     and every content growth (a ResizeObserver on the content wrapper)
 *     snaps to the new bottom — INSTANT, never smooth: a streaming tail
 *     must not lag behind its own ticks.
 *   • A scroll event that LANDS within the threshold pins (however it got
 *     there); one that lands beyond it detaches — UNLESS our own SMOOTH
 *     jump flight is armed (jumpToBottom is the only smooth scroll here;
 *     every content tick is an instant landing at the bottom), in which
 *     case only an UPWARD move detaches (the user fighting the flight —
 *     the panel's R94-D2 rule exactly; the flight clears on arrival, on
 *     `scrollend`, and on the next instant tick, which cancels it).
 *   • `enabled: false` (a COMPLETED thought the user tapped open) never
 *     follows — settled text is read from the top, manual tap wins.
 *     Re-enabling (a fresh stream reaching the same row) re-pins first —
 *     the panel's session-switch convention: a new stream starts followed.
 *   • jumpToBottom() re-pins + SMOOTH-scrolls (the explicit user ask gets
 *     the soft landing); `missedContent` arms when content landed below
 *     while the user reads higher up (the pill's second trigger — mirrors
 *     the panel's contract).
 *
 * happy-dom note: no layout exists there (scrollHeight/clientHeight are 0),
 * so pinned starts true and every follow is a no-op — suites drive the
 * states with Object.defineProperty geometry + dispatched scroll events
 * (the AgentChatPanel R94-D2 convention).
 *
 * Callers: ThoughtRow's expanded body (WorkingSection). The transcript
 * keeps its own R94-D2 machinery (carefully engineered for smooth-scroll
 * flights + scrollend + container resizes — see its full contract in
 * AgentChatPanel); LiveOutputTail/LiveWritePreview keep their simpler
 * inline pin-check (verified R95-D, pinned by their own suites, and they
 * have no jump-pill surface to serve).
 */

/** R95-D: the small-block near-bottom threshold (see the header). */
const STICK_THRESHOLD_PX = 24;

export interface StickToBottomOptions {
  /** A viewport within this many pixels of the block bottom counts as
   * PINNED. Generous enough that a growing last line doesn't instantly
   * detach the follower, strict enough that reading mid-text does. */
  threshold?: number;
  /** The follow gate. false = position-tracking only (nothing streams —
   * the user is reading settled content); a later false→true transition
   * re-pins, because a fresh stream starts followed. Default true. */
  enabled?: boolean;
}

export interface StickToBottomApi {
  /** Attach to the scrollable element (a callback ref + state — the
   * scroller MOUNTS/UNMOUNTS with the expand/collapse animation, and
   * every effect below must re-arm on attach; a plain useRef cannot
   * re-run them). */
  ref: (node: HTMLDivElement | null) => void;
  /** Whether the viewport currently sits at (near) the bottom. */
  pinned: boolean;
  /** Re-pin + smooth-scroll to the bottom — the jump pill's click. */
  jumpToBottom: () => void;
  /** Content landed below since the user left the bottom (while enabled). */
  missedContent: boolean;
}

/**
 * Stick a small scrolling block to its own growing content. `deps` is the
 * list of values whose change means NEW CONTENT (the streaming text) — its
 * LENGTH must be stable across renders (React's hook rules); the scroller's
 * mount/unmount and the enabled gate's transitions are tracked internally.
 */
export function useStickToBottom(
  deps: readonly unknown[],
  { threshold = STICK_THRESHOLD_PX, enabled = true }: StickToBottomOptions = {},
): StickToBottomApi {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((next: HTMLDivElement | null) => setNode(next), []);
  const [pinned, setPinned] = useState(true);
  const [missedContent, setMissedContent] = useState(false);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const prevEnabledRef = useRef(enabled);
  // The smooth-jump flight marker (the panel's programmaticScrollRef):
  // armed only by jumpToBottom, cleared by arrival, `scrollend`, or the
  // next instant tick (an instant scrollTop assignment cancels a smooth
  // scroll per spec).
  const flightRef = useRef(false);

  const applyPinned = useCallback((next: boolean): void => {
    pinnedRef.current = next;
    setPinned((prev) => (prev === next ? prev : next));
    if (next) setMissedContent(false);
  }, []);

  /** The one follow primitive: INSTANT (see the header — streaming ticks
   * must not smooth-lag) and it CANCELS any in-flight smooth jump (an
   * instant assignment aborts the animation; the newest bottom wins).
   * No-ops when the scroller is not mounted. */
  const follow = useCallback((): void => {
    if (node === null) return;
    flightRef.current = false;
    node.scrollTop = node.scrollHeight;
  }, [node]);

  /** Re-pin + smooth-scroll — the user's explicit ask gets the soft landing. */
  const jumpToBottom = useCallback((): void => {
    if (node === null) return;
    applyPinned(true);
    lastScrollTopRef.current = node.scrollTop;
    flightRef.current = true;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [applyPinned, node]);

  // Position tracking: landing near the bottom PINS; landing beyond it
  // detaches — except while our own smooth-jump flight is armed (then only
  // an upward move — the user fighting it — detaches; see the header).
  useEffect(() => {
    if (node === null) return;
    const onScroll = (): void => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (distance < threshold) {
        // Arrived at (or near) the bottom — our follow landing or the user.
        flightRef.current = false;
        applyPinned(true);
      } else if (flightRef.current) {
        // Our own smooth jump on the way down: only an UPWARD move is the
        // user fighting it (jumps only ever target the maximum top).
        if (node.scrollTop < lastScrollTopRef.current) {
          flightRef.current = false;
          applyPinned(false);
        }
      } else {
        applyPinned(false);
      }
      lastScrollTopRef.current = node.scrollTop;
    };
    const onScrollEnd = (): void => {
      // The browser settled the scroll (ours or the user's): the flight is
      // over — from here every scroll event is user/layout movement.
      flightRef.current = false;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("scrollend", onScrollEnd);
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("scrollend", onScrollEnd);
    };
  }, [node, threshold, applyPinned]);

  // The follow itself: the deps changes (the streaming text), the
  // scroller's (re)mount, and the enabled gate's transitions all land here.
  useEffect(() => {
    const wasEnabled = prevEnabledRef.current;
    prevEnabledRef.current = enabled;
    // (Re)enabled → a FRESH stream: re-pin first (a new stream starts
    // followed — the panel's session-switch convention).
    if (enabled && !wasEnabled) applyPinned(true);
    if (node === null || !enabled) return;
    if (pinnedRef.current) {
      follow();
    } else {
      // Content grew while the user reads higher up — arm the pill's
      // second trigger (mirrors the panel's missedContent contract).
      setMissedContent(true);
    }
  }, [node, enabled, applyPinned, follow, ...deps]);

  // Content-growth robustness: the deps effect covers the streaming text;
  // the ResizeObserver covers everything else that can grow/shrink the
  // content (wraps reflowing on a resize, non-text children settling…).
  // Observing the CONTENT wrapper (the scroller's single element child),
  // never the scroller itself — the max-h-* scroller's box stops at its
  // cap while the content keeps growing past it. happy-dom's observer
  // never fires; harmless there.
  useEffect(() => {
    if (node === null) return;
    const content = node.firstElementChild;
    if (content === null) return;
    const observer = new ResizeObserver(() => {
      if (enabled && pinnedRef.current) follow();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [node, enabled, follow]);

  return { ref, pinned, jumpToBottom, missedContent };
}
