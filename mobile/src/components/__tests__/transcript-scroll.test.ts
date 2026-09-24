/**
 * transcript-scroll.test.ts — R125-D's anti-runaway contract: the owner's
 * v0.117.0 device verdict — "on the mobile side … it has auto scroll
 * functionality, which does not stop." The session screen's transcript
 * FlatList (app/session/[id].tsx) is INVERTED with newest-first data, so
 * live-turn SSE deltas prepend rows at index 0 and the kept numeric
 * contentOffset yanked the viewport toward the newest content on every
 * frame. The fix rides RN's maintainVisibleContentPosition, and the exact
 * anchor values live in a PURE module (the screen itself sits outside
 * jest's roots — the mobile suite covers src/ only) so THIS file is the
 * pin: if the anchor drifts, the runaway comes back, and this suite is
 * what says so.
 *
 * Pure value pins, zero mocks — the module imports nothing.
 */

import { describe, expect, it } from "@jest/globals";

import {
  TRANSCRIPT_SCROLL_ANCHOR,
  type TranscriptScrollAnchor,
} from "@/components/transcript-scroll";

// RN 0.86's own prop shape (ScrollView.js): Readonly<{
//   minIndexForVisible: number,
//   autoscrollToTopThreshold?: ?number,
// }>. The anchor must be ASSIGNABLE to it — the compile-time leg of the pin
// (typecheck is the gate that runs it), both directions of drift guarded:
// a missing required field or a renamed key fails HERE first.
type RnAnchorProp = Readonly<{ minIndexForVisible: number; autoscrollToTopThreshold?: number }>;
type AnchorFitsRnProp = TranscriptScrollAnchor extends RnAnchorProp ? true : never;
const anchorFitsRnProp: AnchorFitsRnProp = true;

describe("transcript-scroll — the R125-D scroll anchor (the anti-runaway pin)", () => {
  it("minIndexForVisible is 1 — prepends at index 0 never move the reading position", () => {
    // The inverted list's "top" is the VISUAL BOTTOM (the newest content);
    // pinning the first row the user is actually READING (index ≥ 1) when
    // rows prepend at index 0 is the whole fix — the scroll stops
    // following the stream once the user has scrolled away. 0 would make
    // the newest row itself the anchor (the runaway again, just via the
    // native path).
    expect(TRANSCRIPT_SCROLL_ANCHOR.minIndexForVisible).toBe(1);
  });

  it("autoscrollToTopThreshold is 80 — stick-to-newest ONLY within 80pt of the newest edge", () => {
    // The at-bottom reader still sees new content scroll into place; past
    // 80pt the minIndexForVisible law owns the viewport. Too small a value
    // would flake the follow on tall rows; too large would re-introduce the
    // drag the owner reported.
    expect(TRANSCRIPT_SCROLL_ANCHOR.autoscrollToTopThreshold).toBe(80);
    expect(TRANSCRIPT_SCROLL_ANCHOR.autoscrollToTopThreshold).toBeGreaterThan(0);
  });

  it("the anchor carries EXACTLY the two fields RN's prop accepts — no extras", () => {
    // The native prop rejects unknown keys at runtime; a stray third field
    // here would silently drop the whole anchor on the floor.
    expect(Object.keys(TRANSCRIPT_SCROLL_ANCHOR).sort()).toEqual([
      "autoscrollToTopThreshold",
      "minIndexForVisible",
    ]);
  });

  it("the anchor's shape satisfies RN's maintainVisibleContentPosition type", () => {
    // The runtime mirror of the compile-time pin above (it fails to COMPILE
    // first — that is the point: typecheck is the gate that runs it).
    expect(anchorFitsRnProp).toBe(true);
    const asRnProp: RnAnchorProp = TRANSCRIPT_SCROLL_ANCHOR;
    expect(asRnProp.minIndexForVisible).toBe(1);
  });
});
