// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { BrowserPanel } from "./BrowserPanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { useBrowserTabStore } from "../../lib/browser-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

/**
 * ROUND-43 (R43-10) BrowserPanel — the embedded in-sidebar browser.
 *
 * global.fetch is stubbed with a tiny in-memory implementation of the
 * /api/v1/browser/* route contracts (mint / navigate / history / viewport /
 * the ticket probe) so the REAL store logic runs: optimistic viewport edits,
 * history flags, postMessage folding, ticket recovery.
 *
 * ROUND-48 (R48-d) mock honesty: the old mock returned the SAME ticket from
 * every POST /browser/session and never simulated rotation — which is why
 * this suite could never catch the real backend's rotate-on-navigate bug
 * (the panel adopted a "new" ticket that was still the old one, so recovery
 * always looked successful). The mock now mirrors the REAL backend exactly:
 *   - POST /browser/session ROTATES — a fresh ticket per call, the previous
 *     one dead;
 *   - POST /browser/navigate / PUT /browser/viewport NEVER change ticket
 *     validity (post-R48-d backend semantics);
 *   - the /browser/proxy probe 401s iff the bt is not the session's CURRENT
 *     server-side ticket (a dead/rotated/unknown ticket), else answers the
 *     probe's harmless 400.
 */

const BASE = "http://127.0.0.1:5178";

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let calls: Recorded[];
/** sessionId → history urls; per-test scenario knobs. */
let histories: Record<string, Array<{ url: string; title: string | null }>>;
let viewports: Record<string, Record<string, unknown>>;
/** sessionId → the CURRENT server-side ticket (what the auth hook accepts). */
let serverTickets: Record<string, string>;
/** The latest minted ticket (== serverTickets for the session under test). */
let ticket: string;
let mintCount: number;
let mintFails: boolean;
/** Scenario knob: even freshly minted tickets probe dead (persistent failure). */
let probeAlwaysDead: boolean;

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw);
  const path = url.pathname + (url.searchParams.toString() !== "" ? `?${url.searchParams.toString()}` : "");
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  calls.push({ method, path: url.pathname, body });

  if (url.pathname === "/api/v1/browser/session") {
    if (mintFails) return Promise.resolve(ok({ error: { code: "BOOM", message: "sidecar exploded" } }, 500));
    mintCount += 1;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "anon";
    // R48-d honesty: minting ROTATES — fresh ticket per call, the previous
    // one is dead from this moment (real backend: SessionStore.create()).
    ticket = mintCount.toString(16).padStart(48, "0");
    serverTickets[sessionId] = ticket;
    const history = histories[sessionId] ?? [];
    return Promise.resolve(
      ok({
        sessionId,
        ticket,
        expiresAt: Date.now() + 12 * 3600_000,
        history: { sessionId, entries: history, index: history.length - 1, canBack: history.length > 1, canForward: false },
        viewport: viewports[sessionId] ?? { width: 1280, height: 800, preset: "laptop", zoom: 1, rotate: false },
      }),
    );
  }
  if (url.pathname === "/api/v1/browser/navigate") {
    // R48-d honesty: navigate NEVER changes ticket validity (the pre-R48
    // backend rotated here — the flash-loop bug this suite must now guard).
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "anon";
    const history = (histories[sessionId] ??= []);
    if (typeof body?.direction === "string") {
      // The panel only uses back/forward/reload through go() with a live
      // pointer — emulate the pointer by index math the tests control via
      // navigateStack below.
      const entry = history[history.length - 1] ?? null;
      return Promise.resolve(
        ok({
          sessionId,
          action: body.direction,
          entry,
          index: history.length - 1,
          canBack: history.length > 1,
          canForward: false,
        }),
      );
    }
    const url2 = typeof body?.url === "string" ? body.url : "";
    const existing = history[history.length - 1];
    if (existing !== undefined && existing.url === url2) {
      if (typeof body?.title === "string") existing.title = body.title;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ sessionId, action: "title-update", entry: existing, index: history.length - 1, canBack: history.length > 1, canForward: false }),
        text: async () => "",
      } as unknown as Response);
    }
    history.push({ url: url2, title: typeof body?.title === "string" ? body.title : null });
    return Promise.resolve(
      ok({
        sessionId,
        action: "push",
        entry: history[history.length - 1],
        index: history.length - 1,
        canBack: history.length > 1,
        canForward: false,
      }),
    );
  }
  if (url.pathname === "/api/v1/browser/history") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const history = histories[sessionId] ?? [];
    return Promise.resolve(
      ok({ sessionId, entries: history, index: history.length - 1, canBack: history.length > 1, canForward: false }),
    );
  }
  if (url.pathname === "/api/v1/browser/viewport") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const current = (viewports[sessionId] ??= { width: 1280, height: 800, preset: "laptop", zoom: 1, rotate: false });
    if (method === "PUT" && body !== null) {
      Object.assign(current, body);
      // Mirror the real backend: a named preset also sets its dimensions.
      const PRESETS: Record<string, [number, number]> = {
        "mobile-sm": [375, 667],
        "mobile-md": [390, 844],
        tablet: [768, 1024],
        laptop: [1280, 800],
        desktop: [1440, 900],
        "full-hd": [1920, 1080],
      };
      const preset = typeof body.preset === "string" ? body.preset : undefined;
      if (preset !== undefined && PRESETS[preset] !== undefined) {
        current.width = PRESETS[preset][0];
        current.height = PRESETS[preset][1];
      }
      if (preset === undefined && (body.width !== undefined || body.height !== undefined)) current.preset = "custom";
    }
    return Promise.resolve(ok({ sessionId, viewport: current }));
  }
  if (url.pathname === "/api/v1/browser/proxy") {
    // The ticket probe, with the REAL auth-hook semantics: the session's
    // CURRENT ticket passes (then the probe's bogus ?url= gets the handler's
    // harmless 400 "not a valid absolute URL" page); a dead, rotated or
    // unknown ticket gets the hook's HTML 401. `probeAlwaysDead` simulates
    // an environment that keeps killing even freshly minted tickets.
    const sid = url.searchParams.get("sessionId") ?? "";
    const bt = url.searchParams.get("bt") ?? "";
    const dead = probeAlwaysDead || serverTickets[sid] !== bt;
    const status = dead ? 401 : 400;
    return Promise.resolve({ ok: status < 400, status, json: async () => ({}), text: async () => "" } as unknown as Response);
  }
  return Promise.resolve(ok({ error: { code: "NOT_FOUND", message: `no mock for ${path}` } }, 404));
}

function makeTab(overrides: Partial<RightSidebarTab> = {}): RightSidebarTab {
  return {
    id: "tab-test-1",
    type: "browser",
    title: "New tab",
    browserUrl: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function seedRightSidebar(tab: RightSidebarTab): void {
  useRightSidebarStore.setState({
    byProject: { "prj_test::default": { open: true, width: 460, tabs: [tab], activeTabId: tab.id, terminalLinesByTab: {} } },
    activeProjectId: "prj_test",
    activeSessionByProject: {},
  });
}

beforeEach(() => {
  resetTestState();
  useBrowserTabStore.getState().resetAll();
  calls = [];
  histories = {};
  viewports = {};
  serverTickets = {};
  ticket = "0".repeat(48);
  mintCount = 0;
  mintFails = false;
  probeAlwaysDead = false;
  vi.stubGlobal("fetch", vi.fn(route));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function postCalls(path: string): Recorded[] {
  return calls.filter((c) => c.path === path);
}

/** Scenario helper: the session's ticket dies server-side (sidecar restart /
 * TTL expiry) — every probe 401s until the next mint rotates in a fresh one. */
function invalidateTicket(sessionId = "tab-test-1"): void {
  delete serverTickets[sessionId];
}

describe("BrowserPanel (R43-10 embedded browser)", () => {
  it("mints a proxy session on mount and shows the empty state with quick links", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);

    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ sessionId: "tab-test-1" });

    // Empty state: quick links + hint copy, no iframe yet.
    expect(screen.getByTestId("browser-empty")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("MDN")).toBeTruthy();
    expect(screen.getByText("This app (dev)")).toBeTruthy();
    expect(screen.queryByTestId("browser-iframe")).toBeNull();
  });

  it("address-bar navigation loads the sandboxed proxy iframe (ticket in the URL, no allow-same-origin)", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "github.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.getByTestId("browser-iframe")).toBeTruthy());
    const iframe = screen.getByTestId("browser-iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain(`${BASE}/api/v1/browser/proxy?`);
    expect(iframe.src).toContain(encodeURIComponent("https://github.com"));
    expect(iframe.src).toContain("sessionId=tab-test-1");
    expect(iframe.src).toContain(`bt=${ticket}`);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");

    // Loading spinner until onLoad fires; back disabled on a fresh history.
    expect(screen.getByTestId("browser-spinner")).toBeTruthy();
    expect((screen.getByTestId("browser-back") as HTMLButtonElement).disabled).toBe(true);
  });

  it("folds acute:title into a server title-update and the tab strip title", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://github.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByTestId("browser-iframe")).toBeTruthy());

    // The backend escape hatch posts from the OPAQUE sandboxed origin ("null").
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "acute:location", url: "https://github.com/" }, origin: "null" }));
      window.dispatchEvent(new MessageEvent("message", { data: { type: "acute:title", title: "GitHub: Let's build from here" }, origin: "null" }));
    });

    await waitFor(() => {
      const titleUpdates = postCalls("/api/v1/browser/navigate").filter((c) => typeof c.body?.title === "string");
      expect(titleUpdates).toHaveLength(1);
      expect(titleUpdates[0]?.body?.title).toBe("GitHub: Let's build from here");
    });
    // The tab-strip effect lands one render after the store update.
    await waitFor(() => {
      const stripTab = useRightSidebarStore.getState().byProject["prj_test::default"]?.tabs.find((t) => t.id === tab.id);
      expect(stripTab?.title).toBe("GitHub: Let's build from here");
    });
  });

  it("back is enabled after history exists and walks to the previous entry", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    for (const url of ["https://a.example/one", "https://a.example/two"]) {
      fireEvent.change(input, { target: { value: url } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      await waitFor(() => expect(screen.getByTestId("browser-iframe").getAttribute("src")).toContain(encodeURIComponent(url)));
    }

    // Our mock reports canBack=true once 2 entries exist.
    await waitFor(() => expect((screen.getByTestId("browser-back") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("browser-back"));
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.direction === "back")).toBe(true),
    );
  });

  it("viewport controls PUT presets/zoom/rotate and the frame geometry follows", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByTestId("browser-iframe")).toBeTruthy());

    // Preset → PUT {preset:"mobile-md"} → 390×844 frame (fit keeps 1:1 at
    // these sizes because the panel area is ~396px wide).
    fireEvent.change(screen.getByTestId("browser-preset-select"), { target: { value: "mobile-md" } });
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/browser/viewport" && c.method === "PUT" && c.body?.preset === "mobile-md")).toBe(true),
    );
    let frame = screen.getByTestId("browser-viewport-frame") as HTMLDivElement;
    expect(frame.style.width).toBe("390px");
    expect(frame.style.height).toBe("844px");

    // Zoom 50% → the footprint halves, the IFRAME itself stays true-size.
    fireEvent.change(screen.getByTestId("browser-zoom-select"), { target: { value: "50" } });
    await waitFor(() => expect((screen.getByTestId("browser-iframe") as HTMLIFrameElement).style.transform).toContain("scale(0.5"));
    frame = screen.getByTestId("browser-viewport-frame") as HTMLDivElement;
    expect(frame.style.width).toBe("195px");
    expect((screen.getByTestId("browser-iframe") as HTMLIFrameElement).style.width).toBe("390px");
    expect(screen.getByTestId("browser-readout").textContent).toContain("390×844 @ 50%");

    // Rotate swaps the display dims (and persists the flag).
    fireEvent.click(screen.getByTestId("browser-rotate"));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/browser/viewport" && c.method === "PUT" && c.body?.rotate === true)).toBe(true),
    );
    await waitFor(() => expect((screen.getByTestId("browser-iframe") as HTMLIFrameElement).style.width).toBe("844px"));
    expect(screen.getByTestId("browser-readout").textContent).toContain("844×390 @ 50%");

    // Fit off → 1:1 (footprint = full 844×420 css px, scrollable).
    fireEvent.click(screen.getByTestId("browser-fit"));
    await waitFor(() => expect((screen.getByTestId("browser-iframe") as HTMLIFrameElement).style.transform).toBe("scale(0.5)"));
    frame = screen.getByTestId("browser-viewport-frame") as HTMLDivElement;
    expect(frame.style.width).toBe("422px"); // 844 × 0.5 zoom, no fit clamp
  });

  it("session-mint failure shows the retry card; Retry re-mints", async () => {
    mintFails = true;
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);

    const card = await screen.findByTestId("browser-error-card");
    expect(card.textContent).toContain("sidecar exploded");

    mintFails = false;
    fireEvent.click(screen.getByTestId("browser-retry"));
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("browser-error-card")).toBeNull());
  });

  it("acute:open (intercepted window.open) navigates IN-PANEL, never externally", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "acute:open", url: "https://example.com/popup" }, origin: "null" }),
      );
    });

    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.url === "https://example.com/popup")).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("browser-iframe").getAttribute("src")).toContain(encodeURIComponent("https://example.com/popup")));
  });

  it("a dead ticket after an iframe load recovers ONCE, adopts the fresh ticket, and does not loop", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));
    const firstTicket = ticket;

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByTestId("browser-iframe")).toBeTruthy());
    expect(screen.getByTestId("browser-iframe").getAttribute("src")).toContain(`bt=${firstTicket}`);

    // Fake timers ONLY for the detection window (waitFor + fake timers hang).
    vi.useFakeTimers();
    try {
      // The ticket dies (e.g. sidecar restart). The load completes but the
      // escape hatch never postMessages (a 401 error page doesn't carry it)
      // and the probe says the ticket is dead.
      invalidateTicket();
      await act(async () => {
        fireEvent.load(screen.getByTestId("browser-iframe"));
        await vi.advanceTimersByTimeAsync(1500);
      });

      // ONE clean recovery: re-mint (2nd session POST — a genuinely FRESH
      // ticket under the honest rotating mock) + a reload navigation.
      expect(postCalls("/api/v1/browser/session")).toHaveLength(2);
      expect(ticket).not.toBe(firstTicket);
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.direction === "reload")).toBe(true);
      // The rebuilt iframe carries the FRESH ticket — the panel adopted it.
      expect(screen.getByTestId("browser-iframe").getAttribute("src")).toContain(`bt=${ticket}`);

      // The recovered load is healthy — firing it must NOT re-mint again
      // (this is exactly where the pre-R48 backend re-killed the ticket).
      await act(async () => {
        fireEvent.load(screen.getByTestId("browser-iframe"));
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(postCalls("/api/v1/browser/session")).toHaveLength(2);
      expect(screen.queryByTestId("browser-error-card")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a persistently dead ticket parks after 3 recoveries (bounded mints/reloads, manual Retry stays available)", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByTestId("browser-iframe")).toBeTruthy());

    vi.useFakeTimers();
    try {
      // The environment keeps killing EVERY ticket, even freshly minted
      // ones — the pre-R48 panel flashed forever here; the R48-d cap must
      // park it instead.
      probeAlwaysDead = true;
      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          fireEvent.load(screen.getByTestId("browser-iframe"));
          await vi.advanceTimersByTimeAsync(1200);
        });
      }

      // Mount mint + EXACTLY 3 recovery mints — cycles 4 and 5 parked.
      expect(postCalls("/api/v1/browser/session")).toHaveLength(4);
      expect(postCalls("/api/v1/browser/navigate").filter((c) => c.body?.direction === "reload")).toHaveLength(3);
      // Parked: the error card with the manual Retry affordance (no flash).
      const card = screen.getByTestId("browser-error-card");
      expect(card.textContent).toContain("automatic recovery paused");
      expect(screen.getByTestId("browser-retry")).toBeTruthy();
      // navSeq stopped advancing: 1 navigation + 3 recovery reloads = 4.
      expect(useBrowserTabStore.getState().tabs[tab.id]?.navSeq).toBe(4);

      // The manual affordance still works (user-paced, never auto-looped):
      // Retry mints once more and reloads with the fresh ticket.
      probeAlwaysDead = false;
      await act(async () => {
        fireEvent.click(screen.getByTestId("browser-retry"));
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(postCalls("/api/v1/browser/session")).toHaveLength(5);
      expect(screen.getByTestId("browser-iframe").getAttribute("src")).toContain(`bt=${ticket}`);
      expect(screen.queryByTestId("browser-error-card")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("paste-and-go: pasting a bare address navigates without editing", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    // happy-dom has no ClipboardEvent data plumbing — define it directly.
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", { value: { getData: () => "mdn.dev" } });
    fireEvent(screen.getByTestId("browser-address-input"), pasteEvent);

    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.url === "https://mdn.dev")).toBe(true),
    );
  });
});
