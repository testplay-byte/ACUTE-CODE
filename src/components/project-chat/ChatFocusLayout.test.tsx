// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
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
    // R97-I re-pin: the greeting (with its composer) renders only after the
    // session queries settle — await the ready state.
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /message composer/i })).toBeTruthy(),
    );

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
    // R97-I re-pin: same ready-state await.
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /message composer/i })).toBeTruthy(),
    );
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

describe("ChatFocusLayout geometry math (Round 43 + R87-A1 240px floor)", () => {
  it("sidebarWidthCap has NO floor — the sidebar yields before the chat does", () => {
    // Large container: the cap is generous; the sidebar keeps its stored
    // width and the CHAT absorbs the extra space. R87-A1: the chat floor
    // halved 480 → 240, so every cap grew by 240.
    expect(sidebarWidthCap(2254)).toBe(2003);
    expect(sidebarWidthCap(1134)).toBe(883);
    // Tight container (a 900px window with the app sidebar open ≈ 594px):
    // the cap keeps dropping — the R42 280px floor (→ 771px row, overflow)
    // is gone.
    expect(sidebarWidthCap(594)).toBe(343);
    // The cap only hits 0 when even the 240px floor + 11px chrome can't
    // fit (R87-A1: was 491 at the 480px floor).
    expect(sidebarWidthCap(250)).toBe(0);
    expect(sidebarWidthCap(300)).toBe(49);
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
    // already guarantees it (sidebar yields first — R42 behaviour). R87-A1:
    // floor(240) + chrome(11) fits from 251px up (was 527 at the 480 floor).
    for (let w = 251; w <= 2560; w += 7) {
      expect(sidebarWidthCap(w) + 240 + 11).toBeLessThanOrEqual(w);
    }
  });

  it("chatMinWidthFor keeps the 240px floor whenever it fits, softening only when physics demands", () => {
    expect(chatMinWidthFor(null)).toBe(240); // pre-measurement render
    expect(chatMinWidthFor(2560)).toBe(240);
    expect(chatMinWidthFor(1134)).toBe(240);
    expect(chatMinWidthFor(594)).toBe(240); // sidebar yields, NOT the chat
    expect(chatMinWidthFor(500)).toBe(240); // and the halved floor fits
    expect(chatMinWidthFor(320)).toBe(240); // even tighter still
    // Below chat(240)+chrome(11)+sidebar-sliver(36)=287 the floor softens so
    // the row still fits rather than overflowing (R87-A1: was 527 at 480).
    expect(chatMinWidthFor(280)).toBe(233);
    expect(chatMinWidthFor(200)).toBe(160); // the hard lower bound
    expect(chatMinWidthFor(100)).toBe(160);
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

  it("chat keeps its 240px floor at every measured width that can fit it", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);

    // Wide container: floor applies verbatim.
    act(() => MockResizeObserver.fire(1200));
    expect(chatCard()?.style.minWidth).toBe("240px");

    // 900px-window container (594px): the SIDEBAR yields — the chat floor is
    // untouched (R42 behaviour preserved; the R43 fix removed the 280px cap
    // floor that used to make this container overflow).
    act(() => MockResizeObserver.fire(594));
    expect(chatCard()?.style.minWidth).toBe("240px");
  });

  it("softens the chat floor only when the container cannot fit floor+chrome+sliver", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);
    // R87-A1: with the 240px floor, softening only starts below a 287px
    // container (240 + 11 chrome + 36 sliver).
    act(() => MockResizeObserver.fire(280));
    expect(chatCard()?.style.minWidth).toBe("233px");
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
    // R97-I re-pin: await the ready state (the greeting's capped composer
    // column renders only after the session queries settle).
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy());

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
