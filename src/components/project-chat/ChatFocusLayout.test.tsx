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
    // R100-D re-pin (§C1.2): SEAM_GAP 3→4 (the 4px base grid) grew the
    // chrome 11→13px — every cap shrank by 2.
    expect(sidebarWidthCap(2254)).toBe(2001);
    expect(sidebarWidthCap(1134)).toBe(881);
    // Tight container (a 900px window with the app sidebar open ≈ 594px):
    // the cap keeps dropping — the R42 280px floor (→ 771px row, overflow)
    // is gone.
    expect(sidebarWidthCap(594)).toBe(341);
    // The cap only hits 0 when even the 240px floor + 13px chrome can't
    // fit (R87-A1: was 491 at the 480px floor).
    expect(sidebarWidthCap(250)).toBe(0);
    expect(sidebarWidthCap(300)).toBe(47);
  });

  it("the row can never overflow: chat floor + chrome + sidebar ≤ container (every width)", () => {
    // The full row invariant across the entire width range: whatever the
    // stored sidebar width, the RENDERED row (softened chat floor + chrome +
    // max(sidebar sliver, cap)) always fits the container.
    // R100-D re-pin (§C1.2): the chrome row-math rides 13px (SEAM_GAP 3→4);
    // the loop now starts at the new hard bound 209 = chat(160) + 13 + 36
    // (below it the row deliberately overflows rather than shrinking the
    // chat under its 160px floor — unchanged behavior, shifted 2px).
    for (let w = 209; w <= 2560; w += 7) {
      const row = chatMinWidthFor(w) + 13 + Math.max(36, sidebarWidthCap(w));
      expect(row).toBeLessThanOrEqual(w);
    }
    // And while the container can fit the chat floor at all, the cap alone
    // already guarantees it (sidebar yields first — R42 behaviour). R87-A1:
    // floor(240) + chrome(13) fits from 253px up (was 527 at the 480 floor).
    for (let w = 253; w <= 2560; w += 7) {
      expect(sidebarWidthCap(w) + 240 + 13).toBeLessThanOrEqual(w);
    }
  });

  it("chatMinWidthFor keeps the 240px floor whenever it fits, softening only when physics demands", () => {
    expect(chatMinWidthFor(null)).toBe(240); // pre-measurement render
    expect(chatMinWidthFor(2560)).toBe(240);
    expect(chatMinWidthFor(1134)).toBe(240);
    expect(chatMinWidthFor(594)).toBe(240); // sidebar yields, NOT the chat
    expect(chatMinWidthFor(500)).toBe(240); // and the halved floor fits
    expect(chatMinWidthFor(320)).toBe(240); // even tighter still
    // Below chat(240)+chrome(13)+sidebar-sliver(36)=289 the floor softens so
    // the row still fits rather than overflowing (R87-A1: was 527 at 480).
    // R100-D re-pin (§C1.2): the soften point moved with the 13px chrome.
    expect(chatMinWidthFor(280)).toBe(231);
    expect(chatMinWidthFor(200)).toBe(160); // the hard lower bound
    expect(chatMinWidthFor(100)).toBe(160);
    for (let w = 200; w <= 1200; w += 5) {
      // R100-D re-pin (§C1.2): the hard lower bound moved 207 → 209 with the
      // 13px chrome (chat floor 160 + 13 + 36).
      expect(chatMinWidthFor(w) + 13 + 36).toBeLessThanOrEqual(Math.max(w, 209));
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
      // R100-D re-pin (§C4.1): the window card's 24px arbitrary radius became
      // rounded-2xl (the 16px scale step — same lookup, new spelling).
      el.className.includes("rounded-2xl"),
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
    // R87-A1: with the 240px floor, softening only starts below a 289px
    // container (240 + 13 chrome + 36 sliver — R100-D: 13px chrome).
    act(() => MockResizeObserver.fire(280));
    expect(chatCard()?.style.minWidth).toBe("231px");
  });

  it("chat panel FILLS its column — no shrink-to-fit dead space at any width (owner R43)", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);
    act(() => MockResizeObserver.fire(2254)); // 2560px-class window

    // The panel root must carry w-full (the measured bug: a 455px panel
    // inside a 1781px card because the flex child shrink-to-fit its content).
    // R100-D re-pin (§C4.1): the root's 16px radius is now rounded-2xl — the
    // window card shares the spelling, so the lookup pins the w-full combo.
    const panel = Array.from(document.querySelectorAll("div")).find((el) =>
      el.className.includes("rounded-2xl") && el.className.includes("w-full"),
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
