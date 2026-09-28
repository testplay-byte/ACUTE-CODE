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
  // R126-3d-1 (the dead-layouts retirement): `chatFocusMode` left the store
  // with the retired 3-panel/experimental gates — ChatFocusLayout is the ONE
  // chat layout now, so there is no flag left to force; only the transient
  // app-sidebar flag needs a deterministic reset here.
  useProjectChatStore.setState({ appSidebarVisible: true });
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

describe("ChatFocusLayout geometry math (Round 43 + R132 360px floor)", () => {
  it("sidebarWidthCap has NO floor — the sidebar yields before the chat does", () => {
    // Large container: the cap is generous; the sidebar keeps its stored
    // width and the CHAT absorbs the extra space. R87-A1 halved the
    // ROUND-42 480px floor to 240; R131-P raised it 240 → 400 (the measured
    // one-line floor for the composer toolbar's WIDEST anchor state);
    // R132 (owner: "a little bit too much… a bit more smaller, like a bit
    // more flexible") dropped it 400 → 360 — measured: at a 360px column
    // the composer @container is ≈ 332, every collapse tier has fired
    // (model logo-only @max-[350px] — the R89-D2 owner-sanctioned tier),
    // and the one-line floor is 242px of toolbar inner width vs ≈ 316
    // available — 74px of daylight, zero new collapse tiers. Every cap
    // grew by the same 40 the floor shrank.
    expect(sidebarWidthCap(2254)).toBe(1881);
    expect(sidebarWidthCap(1134)).toBe(761);
    // Tight container (a 900px window with the app sidebar open ≈ 594px):
    // the cap keeps dropping — the R42 280px floor (→ 771px row, overflow)
    // is gone.
    expect(sidebarWidthCap(594)).toBe(221);
    // The cap only hits 0 when even the 360px floor + 13px chrome can't
    // fit (R131-P: was 253-bound at the R87-A1 240px floor, then 413 at
    // the 400px floor; the R132 boundary moved to 373 = 360 + 13).
    expect(sidebarWidthCap(250)).toBe(0);
    expect(sidebarWidthCap(373)).toBe(0);
    expect(sidebarWidthCap(374)).toBe(1);
    expect(sidebarWidthCap(500)).toBe(127);
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
    // already guarantees it (sidebar yields first — R42 behaviour). R132:
    // floor(360) + chrome(13) fits from 373px up (was 413 at the 400 floor).
    for (let w = 373; w <= 2560; w += 7) {
      expect(sidebarWidthCap(w) + 360 + 13).toBeLessThanOrEqual(w);
    }
  });

  it("chatMinWidthFor keeps the 360px floor whenever it fits, softening only when physics demands", () => {
    expect(chatMinWidthFor(null)).toBe(360); // pre-measurement render
    expect(chatMinWidthFor(2560)).toBe(360);
    expect(chatMinWidthFor(1134)).toBe(360);
    expect(chatMinWidthFor(594)).toBe(360); // sidebar yields, NOT the chat
    expect(chatMinWidthFor(500)).toBe(360); // the one-line floor fits
    expect(chatMinWidthFor(440)).toBe(360); // fits: 440 > 409 (R132 band)
    // Below chat(360)+chrome(13)+sidebar-sliver(36)=409 the floor softens so
    // the row still fits rather than overflowing (R131-P: was 449-bound at
    // the 400px floor; R132 moved the band down 40).
    expect(chatMinWidthFor(390)).toBe(341);
    expect(chatMinWidthFor(320)).toBe(271);
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

describe("ChatFocusLayout clay card material (R126-3d-1)", () => {
  it("the chat window card rides the clay card species — 1px clay rim + .ac-clay + bg-card (the 1.5px bento border + softShadow retired)", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /message composer/i })).toBeTruthy(),
    );

    // The window card (same lookup the geometry tests pin — the first
    // rounded-2xl div carries the inline minWidth).
    const card = Array.from(document.querySelectorAll("div")).find((el) =>
      el.className.includes("rounded-2xl"),
    );
    // R126-3d-1: the clay card species on the CLASS leg (COMPONENTS §3):
    // 1px border-clay-rim rim + .ac-clay two-leg shadow + bg-card fill +
    // the dark-mode-only matte top edge.
    expect(card?.className).toContain("border-clay-rim");
    expect(card?.className).toContain("ac-clay");
    expect(card?.className).toContain("bg-card");
    expect(card?.className).toContain("ac-clay-edge-dark");
    // The pre-R126 inline material legs are gone — the card paints via the
    // pattern classes, not inline borderColor/boxShadow.
    expect(card?.style.borderColor).toBe("");
    expect(card?.style.boxShadow).toBe("");
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

  it("chat keeps its 360px floor at every measured width that can fit it", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);

    // Wide container: floor applies verbatim.
    act(() => MockResizeObserver.fire(1200));
    expect(chatCard()?.style.minWidth).toBe("360px");

    // 900px-window container (594px): the SIDEBAR yields — the chat floor is
    // untouched (R42 behaviour preserved; the R43 fix removed the 280px cap
    // floor that used to make this container overflow).
    act(() => MockResizeObserver.fire(594));
    expect(chatCard()?.style.minWidth).toBe("360px");
  });

  it("softens the chat floor only when the container cannot fit floor+chrome+sliver", async () => {
    const projects = await getFixtureProjects().list();
    renderWithProviders(<ChatFocusLayout project={projects[0]} />);
    // R131-P: with the 400px floor, softening only started below a 449px
    // container; R132 moved the band to 409 (360 + 13 chrome + 36 sliver —
    // R100-D: 13px chrome). The softened VALUE at a given sub-409 width is
    // unchanged by the floor move (container − 49) — only the band that
    // holds the HARD floor narrowed by 40.
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
