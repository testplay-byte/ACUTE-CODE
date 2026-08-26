// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { ChatFocusLayout, chatMinWidthFor, sidebarWidthCap } from "./ChatFocusLayout";
import { getFixtureProjects } from "../../lib/project-fixtures";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  useProjectChatStore.setState({ chatFocusMode: true, appSidebarVisible: true });
});

describe("ChatFocusLayout (Round 33 — headerless chat panel)", () => {
  it("renders the chat with NO top navigation bar at all (owner R33)", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);

    // NONE of the old header affordances exist — the owner removed the whole
    // bar: no agent chip, no search button, no theme toggle in the chat.
    expect(screen.queryByRole("button", { name: /Agent:/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /search project/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /switch to (light|dark) mode/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /show panels/i })).toBeNull();
    // The composer is the panel's only chrome at the bottom.
    expect(screen.getByRole("textbox", { name: /message composer/i })).toBeTruthy();
  });

  it("renders the composer for messaging the agent", async () => {
    const projects = await getFixtureProjects().list();
    const project = projects[0];
    renderWithProviders(<ChatFocusLayout project={project} />);
    expect(screen.getByRole("textbox", { name: /message composer/i })).toBeTruthy();
  });
});

// ─── ROUND-43 geometry regressions ──────────────────────────────────────────
//
// Owner bugs this suite pins:
//   1. "a lot of empty space on the right side of the chat window… it added a
//      scroll bar at the bottom" — AgentChatPanel used to shrink-to-fit its
//      content (a 455px panel inside a 1781px card at 2560px) and the message
//      scroller computed overflow-x:auto, minting a bottom scrollbar.
//   2. "the maximum width… gets restricted" + the R42 cap's 280px floor meant
//      chat-floor(480)+handle+gaps+280 ≈ 771px was the layout's minimum — any
//      narrower container overflowed (sidebar clipped off-screen).

describe("ChatFocusLayout geometry math (Round 43)", () => {
  it("sidebarWidthCap has NO floor — the sidebar yields before the chat does", () => {
    // Large container: the cap is generous; the sidebar keeps its stored
    // width and the CHAT absorbs the extra space.
    expect(sidebarWidthCap(2254)).toBe(1763);
    expect(sidebarWidthCap(1134)).toBe(643);
    // Tight container (a 900px window with the app sidebar open ≈ 594px):
    // the cap keeps dropping — the R42 280px floor (→ 771px row, overflow)
    // is gone.
    expect(sidebarWidthCap(594)).toBe(103);
    expect(sidebarWidthCap(491)).toBe(0);
    expect(sidebarWidthCap(300)).toBe(0);
  });

  it("the row can never overflow: chat floor + chrome + sidebar ≤ container (every width)", () => {
    // The full row invariant across the entire width range: whatever the
    // stored sidebar width, the RENDERED row (softened chat floor + chrome +
    // max(sidebar sliver, cap)) always fits the container.
    for (let w = 207; w <= 2560; w += 7) {
      const row = chatMinWidthFor(w) + 11 + Math.max(36, sidebarWidthCap(w));
      expect(row).toBeLessThanOrEqual(w);
    }
    // And while the container can fit the chat floor at all, the cap alone
    // already guarantees it (sidebar yields first — R42 behaviour).
    for (let w = 527; w <= 2560; w += 7) {
      expect(sidebarWidthCap(w) + 480 + 11).toBeLessThanOrEqual(w);
    }
  });

  it("chatMinWidthFor keeps the 480px floor whenever it fits, softening only when physics demands", () => {
    expect(chatMinWidthFor(null)).toBe(480); // pre-measurement render
    expect(chatMinWidthFor(2560)).toBe(480);
    expect(chatMinWidthFor(1134)).toBe(480);
    expect(chatMinWidthFor(594)).toBe(480); // sidebar yields, NOT the chat
    // Below chat(480)+chrome(11)+sidebar-sliver(36)=527 the floor softens so
    // the row still fits rather than overflowing.
    expect(chatMinWidthFor(500)).toBe(453);
    expect(chatMinWidthFor(320)).toBe(273);
    expect(chatMinWidthFor(100)).toBe(160); // hard lower bound
    for (let w = 200; w <= 1200; w += 5) {
      expect(chatMinWidthFor(w) + 11 + 36).toBeLessThanOrEqual(Math.max(w, 207));
    }
  });
});

/** ResizeObserver stub whose callbacks the test fires with synthetic widths. */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    MockResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  static fire(width: number): void {
    for (const inst of MockResizeObserver.instances) {
      inst.cb(
        [{ contentRect: { width } } as unknown as ResizeObserverEntry],
        inst as unknown as ResizeObserver,
      );
    }
  }
}

describe("ChatFocusLayout rendered geometry (Round 43)", () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const chatCard = () =>
    (Array.from(document.querySelectorAll("div")).find((el) =>
      el.className.includes("rounded-[24px]"),
    ) as HTMLElement | undefined) ?? null;

  it("chat keeps its 480px floor at every measured width that can fit it", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);

    // Wide container: floor applies verbatim.
    act(() => MockResizeObserver.fire(1200));
    expect(chatCard()?.style.minWidth).toBe("480px");

    // 900px-window container (594px): the SIDEBAR yields — the chat floor is
    // untouched (R42 behaviour preserved; the R43 fix removed the 280px cap
    // floor that used to make this container overflow).
    act(() => MockResizeObserver.fire(594));
    expect(chatCard()?.style.minWidth).toBe("480px");
  });

  it("softens the chat floor only when the container cannot fit floor+chrome+sliver", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);
    act(() => MockResizeObserver.fire(500));
    expect(chatCard()?.style.minWidth).toBe("453px");
  });

  it("chat panel FILLS its column — no shrink-to-fit dead space at any width (owner R43)", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);
    act(() => MockResizeObserver.fire(2254)); // 2560px-class window

    // The panel root must carry w-full (the measured bug: a 455px panel
    // inside a 1781px card because the flex child shrink-to-fit its content).
    const panel = Array.from(document.querySelectorAll("div")).find((el) =>
      el.className.includes("rounded-[16px]"),
    );
    expect(panel?.className).toContain("w-full");

    // The message scroller must pin overflow-x HIDDEN — `overflow-y-auto`
    // alone computes overflow-x:auto, which is what minted the owner's
    // bottom horizontal scrollbar.
    const scroller = Array.from(document.querySelectorAll("div")).find((el) =>
      el.className.includes("overflow-x-hidden"),
    );
    expect(scroller).toBeTruthy();
    expect(scroller?.className).toContain("overflow-y-auto");
  });

  it("the reading column is capped + centered while the panel fills (readable at 2560px)", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);
    act(() => MockResizeObserver.fire(2254));

    // Messages column AND composer share the SAME capped, centered column.
    const cols = Array.from(document.querySelectorAll("div")).filter((el) =>
      el.className.includes("max-w-[1080px]"),
    );
    expect(cols.length).toBeGreaterThanOrEqual(2);
    for (const col of cols) {
      expect(col.className).toContain("mx-auto");
    }
  });
});
