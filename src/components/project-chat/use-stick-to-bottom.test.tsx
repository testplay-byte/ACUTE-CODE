// @vitest-environment happy-dom
/**
 * ROUND-95 (R95-D) tests — the small-block stick-to-bottom primitive
 * (use-stick-to-bottom.ts): the live thinking block's own follow/detach
 * contract, mirroring the AgentChatPanel R94-D2 suite's LOGIC-over-pixels
 * approach (happy-dom has NO layout — scrollHeight/clientHeight are 0 and
 * scrollTo is a no-op that fires no events — so geometry rides in via
 * Object.defineProperty getters and user gestures are dispatched exactly
 * as the browser would).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useStickToBottom } from "./use-stick-to-bottom";

afterEach(cleanup);

/** A minimal harness: a scroller with one content child (the RO contract)
 * plus the hook's state surfaced as text for assertions. */
function Harness({
  text,
  enabled = true,
}: {
  text: string;
  enabled?: boolean;
}) {
  const { ref, pinned, jumpToBottom, missedContent } = useStickToBottom([text], { enabled });
  return (
    <div>
      <div ref={ref} data-testid="scroller" className="max-h-64 overflow-y-auto">
        <div>{text}</div>
      </div>
      <span data-testid="pinned">{String(pinned)}</span>
      <span data-testid="missed">{String(missedContent)}</span>
      <button data-testid="jump" onClick={() => jumpToBottom()} />
    </div>
  );
}

/** Give the scroller a mutable geometry (defaults: 1000px of content in a
 * 256px viewport — the real thinking block's max-h-64). */
function giveGeometry(el: HTMLElement): { scrollHeight: number; clientHeight: number } {
  const geometry = { scrollHeight: 1000, clientHeight: 256 };
  Object.defineProperty(el, "scrollHeight", { get: () => geometry.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: () => geometry.clientHeight, configurable: true });
  return geometry;
}

const pinned = () => screen.getByTestId("pinned").textContent;
const missed = () => screen.getByTestId("missed").textContent;

describe("useStickToBottom (ROUND-95 R95-D)", () => {
  it("while pinned, every content tick follows to the block's own bottom", () => {
    const { rerender } = render(<Harness text="first chunk" />);
    const el = screen.getByTestId("scroller") as HTMLElement;
    const geometry = giveGeometry(el);

    rerender(<Harness text="first chunk — and then it kept growing" />);
    expect(el.scrollTop).toBe(geometry.scrollHeight);

    // Growth keeps following while the user stays at the bottom.
    geometry.scrollHeight = 1400;
    rerender(<Harness text="first chunk — and then it kept growing even more" />);
    expect(el.scrollTop).toBe(1400);
  });

  it("an upward user scroll detaches: further growth never yanks the viewport, and missedContent arms", () => {
    const { rerender } = render(<Harness text="first chunk" />);
    const el = screen.getByTestId("scroller") as HTMLElement;
    const geometry = giveGeometry(el);
    rerender(<Harness text="first chunk — grown" />);
    expect(el.scrollTop).toBe(geometry.scrollHeight);

    // The user scrolls UP inside the block (300px — far past the 24px
    // threshold, moving up from the followed bottom).
    el.scrollTop = 300;
    fireEvent.scroll(el);
    expect(pinned()).toBe("false");

    // New content lands — their viewport must stay exactly where it is.
    geometry.scrollHeight = 1600;
    rerender(<Harness text="first chunk — grown — and growing still" />);
    expect(el.scrollTop).toBe(300);
    expect(missed()).toBe("true");
  });

  it("scrolling back to the very bottom RE-PINS: the next tick follows again and missedContent resets", () => {
    const { rerender } = render(<Harness text="first chunk" />);
    const el = screen.getByTestId("scroller") as HTMLElement;
    const geometry = giveGeometry(el);
    rerender(<Harness text="first chunk — grown" />);
    el.scrollTop = 300;
    fireEvent.scroll(el);
    expect(pinned()).toBe("false");

    // The user returns to the very bottom (scrollHeight - clientHeight).
    el.scrollTop = geometry.scrollHeight - geometry.clientHeight;
    fireEvent.scroll(el);
    expect(pinned()).toBe("true");
    expect(missed()).toBe("false");

    geometry.scrollHeight = 1800;
    rerender(<Harness text="first chunk — grown — resumed following" />);
    expect(el.scrollTop).toBe(1800);
  });

  it("jumpToBottom re-pins + smooth-scrolls; the flight's downward mid-positions never detach, an upward one does", () => {
    const { rerender } = render(<Harness text="first chunk" />);
    const el = screen.getByTestId("scroller") as HTMLElement;
    const geometry = giveGeometry(el);
    rerender(<Harness text="first chunk — grown" />);
    expect(el.scrollTop).toBe(geometry.scrollHeight);

    // The user leaves the bottom (the honest detach baseline).
    el.scrollTop = 400;
    fireEvent.scroll(el);
    expect(pinned()).toBe("false");

    // The pill: re-pin + smooth flight to the bottom.
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo;
    fireEvent.click(screen.getByTestId("jump"));
    expect(pinned()).toBe("true");
    expect(scrollTo).toHaveBeenCalledWith({ top: geometry.scrollHeight, behavior: "smooth" });

    // Our own smooth flight passing through mid positions (moving DOWN,
    // landing beyond the threshold) must not detach the just-repinned view.
    el.scrollTop = 600;
    fireEvent.scroll(el);
    expect(pinned()).toBe("true");

    // The user FIGHTING the flight (moving UP mid-flight) detaches.
    el.scrollTop = 500;
    fireEvent.scroll(el);
    expect(pinned()).toBe("false");
  });

  it("enabled=false never follows (settled content is read from the top); re-enabling re-pins + follows", () => {
    const { rerender } = render(<Harness text="settled text" enabled={false} />);
    const el = screen.getByTestId("scroller") as HTMLElement;
    const geometry = giveGeometry(el);

    rerender(<Harness text="settled text — edited" enabled={false} />);
    expect(el.scrollTop).toBe(0); // no follow for completed content

    // The user scrolled up while disabled — position tracking still runs.
    el.scrollTop = 200;
    fireEvent.scroll(el);
    expect(pinned()).toBe("false");

    // A fresh stream reaches the same block (enabled flips): re-pin first,
    // then the very next tick follows (the session-switch convention).
    geometry.scrollHeight = 1200;
    rerender(<Harness text="settled text — a new live stream" enabled />);
    expect(pinned()).toBe("true");
    expect(el.scrollTop).toBe(1200);
  });
});
