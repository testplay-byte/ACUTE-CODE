// @vitest-environment happy-dom
/**
 * ROUND-127 (the overlay-scrollbar law — TOKENS §6): the GLOBAL scroll-fade
 * mechanism's pins. The owner's directive verbatim: "I would like you to
 * completely hide those scroll bars, and those scroll bars should only
 * appear when the user tries to scroll." The law as code:
 *
 *   · tagScrolling adds `.is-scrolling` to the element it is given — the
 *     ONLY class the CSS tints a thumb under (outside the focus carve-out);
 *   · the tag HOLDS while scroll events keep arriving (the timer re-arms —
 *     one long scroll never flickers);
 *   · the tag fades SCROLL_FADE_HOLD_MS after the LAST event (fake timers);
 *   · untagScrolling strips it + cancels the pending fade (the handoff path);
 *   · the App-level listener sees NESTED scrollers through the capture
 *     phase and tags the scrolling element itself (not the document);
 *   · the document-level scroll tags documentElement (the page scroller);
 *   · mounting the hook twice (a dev-mode double-invoke) never double-tags.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCROLLING_CLASS,
  SCROLL_FADE_HOLD_MS,
  scrollTagTarget,
  tagScrolling,
  untagScrolling,
  useGlobalScrollFade,
} from "./use-global-scroll-fade";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.removeEventListener(
    "scroll",
    vi.fn(),
    { capture: true } as EventListenerOptions,
  );
});

describe("R127 global scroll-fade — the tag primitives", () => {
  it("tagScrolling adds the class; the fade strips it after the hold window", () => {
    const el = document.createElement("div");
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(false);
    tagScrolling(el);
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(true);
    // Held before the hold window elapses…
    vi.advanceTimersByTime(SCROLL_FADE_HOLD_MS - 10);
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(true);
    // …faded exactly at it.
    vi.advanceTimersByTime(10);
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(false);
  });

  it("a FOLLOW-UP scroll re-arms the timer — one long scroll never flickers", () => {
    const el = document.createElement("div");
    tagScrolling(el);
    vi.advanceTimersByTime(SCROLL_FADE_HOLD_MS - 10);
    tagScrolling(el); // the scroll continues
    vi.advanceTimersByTime(SCROLL_FADE_HOLD_MS - 10);
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(true);
    vi.advanceTimersByTime(10);
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(false);
  });

  it("untagScrolling strips immediately + cancels the pending fade", () => {
    const el = document.createElement("div");
    tagScrolling(el);
    untagScrolling(el);
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(false);
    // No zombie timer fires later (class stays absent past the window).
    vi.advanceTimersByTime(SCROLL_FADE_HOLD_MS * 2);
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(false);
  });

  it("scrollTagTarget: the document scroller resolves to documentElement; elements to themselves; null otherwise", () => {
    expect(scrollTagTarget(document)).toBe(document.documentElement);
    expect(scrollTagTarget(window)).toBe(document.documentElement);
    const el = document.createElement("div");
    expect(scrollTagTarget(el)).toBe(el);
    expect(scrollTagTarget(null)).toBe(null);
    expect(scrollTagTarget({} as EventTarget)).toBe(null);
  });
});

describe("R127 global scroll-fade — the App-level listener", () => {
  function Probe() {
    useGlobalScrollFade();
    return null;
  }

  it("a NESTED scroller's scroll event tags that scroller (capture phase), then fades", () => {
    const { unmount } = render(<Probe />);
    const inner = document.createElement("div");
    document.body.appendChild(inner);
    inner.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(inner.classList.contains(SCROLLING_CLASS)).toBe(true);
    expect(document.documentElement.classList.contains(SCROLLING_CLASS)).toBe(false);
    vi.advanceTimersByTime(SCROLL_FADE_HOLD_MS);
    expect(inner.classList.contains(SCROLLING_CLASS)).toBe(false);
    inner.remove();
    unmount();
  });

  it("the PAGE scroller's scroll event tags documentElement", () => {
    const { unmount } = render(<Probe />);
    document.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.classList.contains(SCROLLING_CLASS)).toBe(true);
    vi.advanceTimersByTime(SCROLL_FADE_HOLD_MS);
    expect(document.documentElement.classList.contains(SCROLLING_CLASS)).toBe(false);
    unmount();
  });

  it("unmount detaches the listener — later scrolls never tag", () => {
    const { unmount } = render(<Probe />);
    unmount();
    const inner = document.createElement("div");
    document.body.appendChild(inner);
    inner.dispatchEvent(new Event("scroll"));
    expect(inner.classList.contains(SCROLLING_CLASS)).toBe(false);
    inner.remove();
  });
});

describe("R127 global scroll-fade — re-mount safety (StrictMode double-invoke)", () => {
  it("double mount + double unmount leaves the mechanism inert", () => {
    const first = render(
      <div>
        <ProbeInner />
      </div>,
    );
    act(() => {
      // no-op; the double-invoke happens through two mounts instead
    });
    const second = render(<ProbeInner />);
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.dispatchEvent(new Event("scroll"));
    expect(el.classList.contains(SCROLLING_CLASS)).toBe(true);
    first.unmount();
    second.unmount();
    // After BOTH unmount, a fresh scroll tags nothing.
    const fresh = document.createElement("div");
    document.body.appendChild(fresh);
    fresh.dispatchEvent(new Event("scroll"));
    expect(fresh.classList.contains(SCROLLING_CLASS)).toBe(false);
    el.remove();
    fresh.remove();
  });
});

function ProbeInner() {
  useGlobalScrollFade();
  return null;
}
