/**
 * transcript-scroll.ts — the transcript's scroll ANCHOR (R125-D): the owner's
 * v0.117.0 device verdict — "on the mobile side … it has auto scroll
 * functionality, which does not stop." The session screen renders the
 * transcript as an INVERTED FlatList (newest row at data[0], the visual
 * BOTTOM); during a live turn every SSE delta PREPENDS/grows rows, and with
 * the numeric contentOffset simply kept, every prepend yanks the viewport
 * toward the newest content — the reader physically cannot scroll up and
 * stay there while a turn streams.
 *
 * THE FIX is RN's own chat-grammar prop, `maintainVisibleContentPosition`,
 * and this module exists so the exact anchor values are a PURE, jest-pinned
 * contract (the screen itself lives outside jest's roots — the repo's
 * mobile suite tests src/ only — so the law is pinned HERE, where the suite
 * can reach it):
 *
 *   · minIndexForVisible: 1 — with the INVERTED list, "top" in the prop's
 *     coordinate space is the VISUAL BOTTOM (the newest content). When a row
 *     is PREPENDED at index 0, the first row the user is actually reading
 *     (index ≥ 1) stays PINNED at its screen position — the reading position
 *     holds still; the scroll finally STOPS following the stream once the
 *     user has scrolled away. (RN's own doc: "the first child that is
 *     partially or fully visible and at or beyond minIndexForVisible will
 *     not change position … useful for lists that are loading content in
 *     both directions, e.g. a chat thread.")
 *   · autoscrollToTopThreshold: 80 — the stick-to-newest behavior survives
 *     ONLY while the user is within 80pt of the newest edge ("top" = the
 *     visual bottom, again): the at-bottom reader still sees new content
 *     scroll into place exactly like before; past 80pt the anchor law above
 *     takes over and the stream stops dragging the viewport.
 *
 * The shape is RN 0.86's own `Readonly<{minIndexForVisible: number,
 * autoscrollToTopThreshold?: number}>` (ScrollView.js) — structural typing
 * makes the constant assignable to the FlatList prop without importing the
 * RN type graph into this pure module.
 */

/**
 * The anchor's own shape — deliberately the exact two fields RN's
 * `maintainVisibleContentPosition` accepts (a third field would be rejected
 * by the native prop at runtime; a missing `minIndexForVisible` would be a
 * native crash — the field is REQUIRED here, optional there).
 */
export interface TranscriptScrollAnchor {
  /** Rows prepended BELOW this index never move the reading position. */
  minIndexForVisible: number;
  /** Stay stick-to-newest only within this many points of the newest edge. */
  autoscrollToTopThreshold: number;
}

/**
 * THE transcript anchor — R125-D. Pinned by
 * src/components/__tests__/transcript-scroll.test.ts; the session screen's
 * FlatList consumes it verbatim (app/session/[id].tsx).
 */
export const TRANSCRIPT_SCROLL_ANCHOR: Readonly<TranscriptScrollAnchor> = {
  minIndexForVisible: 1,
  autoscrollToTopThreshold: 80,
};
