// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { BrowserPanel } from "./BrowserPanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { useBrowserTabStore } from "../../lib/browser-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import * as nativeBrowser from "../../lib/native-browser";
// R60-D: the popover-suppression guard the nativeCreate show consults.
import { setPopoverWebviewSuppression } from "./popover-webview-guard";
// R62 (D8): the agent-browser bridge registry — the panel registers its
// handler; these helpers read/inspect it from the tests.
import {
  clearBrowserCommandHandlersForTest,
  getBrowserCommandHandlerForTest,
  hasBrowserCommandHandler,
} from "../../lib/agent-browser-bridge";

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
 *
 * ROUND-50 (R50-a): a second suite covers NATIVE mode — the Tauri child
 * webviews that replace the proxy iframe inside the desktop shell. The
 * ../../lib/native-browser bridge is mocked (the Rust side has no business
 * in a DOM test); `nativeState.available` toggles per test, and
 * `nativeState.navigatedListener` captures the panel's browser-navigated
 * subscription so tests can simulate the Rust on_navigation hook.
 */

/**
 * Shared mutable state for the native-browser module mock (vi.mock factories
 * are hoisted above every import — state they close over must come from
 * vi.hoisted).
 */
const nativeState = vi.hoisted(() => ({
  available: false,
  navigatedListener: null as ((tabId: string, url: string) => void) | null,
  // R62 (D8): the agent-browser command handler's Rust side fakes.
  evalResult: null as { ok: boolean; value?: unknown; error?: string } | null,
  evalScripts: [] as string[],
  windowMetrics: null as { x: number; y: number; scaleFactor: number } | null,
}));

vi.mock("../../lib/native-browser", () => ({
  isNativeBrowserAvailable: () => nativeState.available,
  nativeInvoke: () => null,
  nativeTabCreate: vi.fn(() => Promise.resolve()),
  nativeTabNavigate: vi.fn(() => Promise.resolve()),
  nativeTabSetBounds: vi.fn(() => Promise.resolve()),
  nativeTabSetVisible: vi.fn(() => Promise.resolve()),
  // R60: REAL zoom (Rust browser_tab_set_zoom — asserted by the R60 tests).
  nativeTabSetZoom: vi.fn(() => Promise.resolve()),
  nativeTabGo: vi.fn(() => Promise.resolve()),
  nativeTabUrl: vi.fn(() => Promise.resolve(null)),
  nativeTabClose: vi.fn(() => Promise.resolve()),
  nativeTabsCloseAll: vi.fn(() => Promise.resolve()),
  openExternalUrl: vi.fn(() => Promise.resolve()),
  // R62 (D8): eval + screenshot geometry (the panel's bridge handler).
  nativeTabEval: vi.fn((_tabId: string, script: string) => {
    nativeState.evalScripts.push(script);
    return Promise.resolve(nativeState.evalResult);
  }),
  nativeWindowMetrics: vi.fn(() => Promise.resolve(nativeState.windowMetrics)),
  onBrowserNavigated: vi.fn((cb: (tabId: string, url: string) => void) => {
    nativeState.navigatedListener = cb;
    return () => {
      if (nativeState.navigatedListener === cb) nativeState.navigatedListener = null;
    };
  }),
}));

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
  // ROUND-50: fresh native-bridge state + mock call history per test.
  nativeState.available = false;
  nativeState.navigatedListener = null;
  // R60-D: no popover suppression leaks between tests.
  setPopoverWebviewSuppression(null);
  vi.clearAllMocks();
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
    // R60: fit stays fully functional on the PROXY path (native mode
    // disables it — presets are auto-clamped to the panel there).
    expect((screen.getByTestId("browser-fit") as HTMLButtonElement).disabled).toBe(false);
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

  it("R62: the status footnote (engine badge + renderer blurb) is REMOVED — the owner's directive", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    // R62-D7 (owner: "at the bottom this is not needed to be shown so just
    // remove this" — quoting the Chromium (native) blurb): the whole status
    // footnote strip is gone — no engine badge, no "Rendered by the
    // embedded Chromium engine (WebView2)…" text, in either mode.
    expect(screen.queryByTestId("browser-engine-badge")).toBeNull();
    expect(screen.queryByText(/Rendered by the embedded Chromium engine/i)).toBeNull();
    expect(screen.queryByText(/Rendered through the sidecar proxy/i)).toBeNull();
  });

  // ── R58-b: the URL-bar draft must never be stomped mid-typing ──────────

  it("R58-b: the address draft is NOT reset while the input is focused; blur falls back to the live URL", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    // The user starts typing while a navigation is in flight — the pre-R58
    // draft-sync effect fired on every currentUrl change (4s poll,
    // navigation events) and reset the field right here.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "duckduckgo.com/?q=half+typed" } });

    // The live URL moves (navigation event / poll) — the focused field
    // must keep the user's text.
    await act(async () => {
      await useBrowserTabStore.getState().handleLocationMessage(tab.id, "https://example.com/landed");
    });
    expect(useBrowserTabStore.getState().tabs[tab.id]?.currentUrl).toBe("https://example.com/landed");
    expect(input.value).toBe("duckduckgo.com/?q=half+typed");

    // Blur → the draft falls back to the live URL (never stale typing).
    fireEvent.blur(input);
    expect(input.value).toBe("https://example.com/landed");
  });

  // ── R58-b: "Open externally" must actually open something ─────────────

  it("R58-b: 'Open externally' in Tauri mode hands the URL to open_external_url (never window.open — wry swallows it)", async () => {
    // sidecar.ts's isTauri() checks for the global — stub it (the
    // native-browser module is mocked above; this only routes the branch).
    vi.stubGlobal("__TAURI__", { core: { invoke: vi.fn() } });
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.url === "https://example.com")).toBe(true),
    );

    fireEvent.click(screen.getByTestId("browser-open-external"));
    expect(vi.mocked(nativeBrowser.openExternalUrl)).toHaveBeenCalledWith("https://example.com");
    // window.open is NOT used in Tauri mode — that is the whole point of
    // the Rust handoff.
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("R58-b: 'Open externally' in web mode keeps window.open (no Tauri command invoked)", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.url === "https://example.com")).toBe(true),
    );

    fireEvent.click(screen.getByTestId("browser-open-external"));
    expect(openSpy).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    expect(vi.mocked(nativeBrowser.openExternalUrl)).not.toHaveBeenCalled();
  });

  it("R58-b: a REJECTED open_external_url surfaces the error card and falls back to window.open", async () => {
    vi.stubGlobal("__TAURI__", { core: { invoke: vi.fn() } });
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    vi.mocked(nativeBrowser.openExternalUrl).mockRejectedValueOnce(new Error("no default browser"));
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.url === "https://example.com")).toBe(true),
    );

    fireEvent.click(screen.getByTestId("browser-open-external"));
    const card = await screen.findByTestId("browser-error-card");
    expect(card.textContent).toContain("no default browser");
    // The fallback still tried the webview's own window.open.
    expect(openSpy).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
  });
});

describe("BrowserPanel native mode (R50-a child webviews over the panel)", () => {
  /** The mocked bridge's command fns, for call assertions. */
  const create = () => vi.mocked(nativeBrowser.nativeTabCreate);
  const setBounds = () => vi.mocked(nativeBrowser.nativeTabSetBounds);
  const setVisible = () => vi.mocked(nativeBrowser.nativeTabSetVisible);
  const setZoom = () => vi.mocked(nativeBrowser.nativeTabSetZoom);
  const nativeGo = () => vi.mocked(nativeBrowser.nativeTabGo);
  const nativeNavigate = () => vi.mocked(nativeBrowser.nativeTabNavigate);
  const nativeClose = () => vi.mocked(nativeBrowser.nativeTabClose);

  /** A fixed 400×900 page-area rect (mobile-md 390×844 fits; full-hd and the
   * default laptop 1280×800 clamp) — the honest-readout + bounds tests. */
  function mockAreaRect() {
    return vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        left: 80,
        top: 120,
        width: 400,
        height: 900,
        right: 480,
        bottom: 1020,
        x: 80,
        y: 120,
        toJSON: () => ({}),
      } as DOMRect);
  }

  beforeEach(() => {
    nativeState.available = true;
    // R62: the rejected-create test ABOVE leaves a sticky mockRejectedValue
    // on nativeTabCreate (it used to be the suite's LAST test — the R62
    // bridge tests that follow would inherit the broken backend and flip
    // into proxy mode, never registering their command handler). Reset the
    // command fns to the healthy default before every native test.
    nativeState.evalResult = null;
    nativeState.evalScripts = [];
    nativeState.windowMetrics = null;
    create().mockReset();
    create().mockImplementation(() => Promise.resolve());
    nativeNavigate().mockReset();
    nativeNavigate().mockImplementation(() => Promise.resolve());
    nativeGo().mockReset();
    nativeGo().mockImplementation(() => Promise.resolve());
    clearBrowserCommandHandlersForTest();
  });

  it("activates the tab webview: create with the tab's URL, then show (no iframe)", async () => {
    const tab = makeTab({ browserUrl: "https://github.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    // The persisted URL drives BOTH the store and the native webview.
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://github.com"));
    await waitFor(() => expect(setVisible()).toHaveBeenCalledWith("tab-test-1", true));

    // Native mode renders the PLACEHOLDER (the OS webview floats above it),
    // never the proxy iframe.
    expect(screen.getByTestId("browser-native-placeholder")).toBeTruthy();
    expect(screen.queryByTestId("browser-iframe")).toBeNull();
  });

  it("address-bar submit drives BOTH the store (server history) and the native webview", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    // Store: server-side history entry (the agent's browser_control truth).
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.url === "https://example.com")).toBe(true),
    );
    // Native: the child webview (create is create-OR-navigate in Rust).
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));
    await waitFor(() => expect(setVisible()).toHaveBeenCalledWith("tab-test-1", true));
  });

  it("unmount (tab switch / sidebar collapse) HIDES the webview — session persists, nothing is closed", async () => {
    const tab = makeTab({ browserUrl: "https://github.com" });
    seedRightSidebar(tab);
    const { unmount } = renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://github.com"));

    unmount();
    await waitFor(() => expect(setVisible()).toHaveBeenCalledWith("tab-test-1", false));
    // Hidden ≠ closed — the tab's browsing session stays alive.
    expect(nativeClose()).not.toHaveBeenCalledWith("tab-test-1");
  });

  it("bounds sync pushes the placeholder's measured rect (natural mode = fill)", async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        left: 80,
        top: 120,
        width: 400,
        height: 500,
        right: 480,
        bottom: 620,
        x: 80,
        y: 120,
        toJSON: () => ({}),
      } as DOMRect);
    try {
      const tab = makeTab({ browserUrl: "https://example.com" });
      seedRightSidebar(tab);
      renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
      await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));

      // After the webview exists, the rAF-debounced sync positions it exactly
      // over the (mocked) placeholder rect — natural mode fills it.
      await waitFor(
        () => expect(setBounds()).toHaveBeenCalledWith("tab-test-1", 80, 120, 400, 500),
        { timeout: 2500 },
      );
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("agent-driven navigation (browser_control) reconciles the native webview through the live-follow poll", async () => {
    // Fake timers from the START — the poll interval must be created under
    // them so a single advance fires it (an interval created before
    // useFakeTimers stays real and never fires inside the test).
    vi.useFakeTimers();
    try {
      const tab = makeTab();
      seedRightSidebar(tab);
      renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
      // Mount effects + the mint POST resolve on microtasks — one advance
      // flushes them (waitFor would hang under fake timers).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(postCalls("/api/v1/browser/session")).toHaveLength(1);

      const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "https://a.example/one" } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(create()).toHaveBeenCalledWith("tab-test-1", "https://a.example/one");

      // The AGENT navigates the server-side session behind our back —
      // exactly what browser_control does. The next poll (POLL_MS=4000)
      // must follow it in the native webview.
      (histories["tab-test-1"] ??= []).push({ url: "https://a.example/two", title: null });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });
      expect(nativeNavigate()).toHaveBeenCalledWith("tab-test-1", "https://a.example/two");
    } finally {
      vi.useRealTimers();
    }
  });

  it("user navigation INSIDE the webview records into server history + the address bar; our own commands don't double-record", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").filter((c) => c.body?.url === "https://example.com")).toHaveLength(1),
    );

    // The Rust on_navigation hook echoes OUR command back (same URL) — the
    // panel must NOT record a second server entry for it.
    await act(async () => {
      nativeState.navigatedListener?.("tab-test-1", "https://example.com");
    });
    expect(postCalls("/api/v1/browser/navigate").filter((c) => c.body?.url === "https://example.com")).toHaveLength(1);

    // A link click INSIDE the page (a URL we never commanded) — recorded so
    // the agent's browser_control get_state stays truthful, and the address
    // bar follows.
    await act(async () => {
      nativeState.navigatedListener?.("tab-test-1", "https://example.com/page2");
    });
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.url === "https://example.com/page2")).toBe(true),
    );
    await waitFor(() =>
      expect((screen.getByTestId("browser-address-input") as HTMLInputElement).value).toBe("https://example.com/page2"),
    );
  });

  it("back walks BOTH histories: the webview's own (history.back) and the server's", async () => {
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    for (const url of ["https://a.example/one", "https://a.example/two"]) {
      fireEvent.change(input, { target: { value: url } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", url));
    }
    await waitFor(() => expect((screen.getByTestId("browser-back") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId("browser-back"));
    await waitFor(() => expect(nativeGo()).toHaveBeenCalledWith("tab-test-1", "back"));
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.direction === "back")).toBe(true),
    );
  });

  it("closing a browser tab in the strip destroys its webview (the reaper) — even while mounted", async () => {
    const tabA = makeTab({ id: "tab-a", browserUrl: "https://a.example" });
    const tabB = makeTab({ id: "tab-b", browserUrl: "https://b.example" });
    useRightSidebarStore.setState({
      byProject: {
        "prj_test::default": { open: true, width: 460, tabs: [tabA, tabB], activeTabId: tabA.id, terminalLinesByTab: {} },
      },
      activeProjectId: "prj_test",
      activeSessionByProject: {},
    });
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tabA} />);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-a", "https://a.example"));

    // The user closes tab A in the tab strip (the panel is mounted directly,
    // so only the reaper sees it).
    act(() => {
      useRightSidebarStore.getState().closeTab("prj_test", "tab-a");
    });
    await waitFor(() => expect(nativeClose()).toHaveBeenCalledWith("tab-a"));
    // The OTHER browser tab's webview is untouched.
    expect(nativeClose()).not.toHaveBeenCalledWith("tab-b");
  });

  it("non-Tauri fallback: the proxy iframe renders and NO native command is invoked", async () => {
    nativeState.available = false;
    const tab = makeTab();
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "github.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.getByTestId("browser-iframe")).toBeTruthy());
    expect(screen.queryByTestId("browser-native-placeholder")).toBeNull();
    expect(create()).not.toHaveBeenCalled();
    expect(setVisible()).not.toHaveBeenCalled();
  });

  it("R62: native mode renders NO engine badge either — the footnote strip is fully gone", async () => {
    const tab = makeTab({ browserUrl: "https://github.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://github.com"));

    expect(screen.queryByTestId("browser-engine-badge")).toBeNull();
    expect(screen.queryByText(/Rendered by the embedded Chromium engine/i)).toBeNull();
  });

  it("R58-b: the readout reports the CLAMPED size when the panel can't fit the preset (honest readout)", async () => {
    // 400×900 area: full-hd (1920×1080) clamps both ways, mobile-md
    // (390×844) fits — both states of the honest readout in one test.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        left: 80,
        top: 120,
        width: 400,
        height: 900,
        right: 480,
        bottom: 1020,
        x: 80,
        y: 120,
        toJSON: () => ({}),
      } as DOMRect);
    try {
      const tab = makeTab({ browserUrl: "https://example.com" });
      seedRightSidebar(tab);
      renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
      await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));
      // Natural mode first: the bounds sync lands (rAF), the readout has a
      // rendered size to be honest about.
      await waitFor(
        () => expect(setBounds()).toHaveBeenCalledWith("tab-test-1", 80, 120, 400, 900),
        { timeout: 2500 },
      );

      // R62 (owner: "the view is actually not respecting the dimensions set
      // by the user"): full-hd (1920×1080) in the 400×900 panel is now
      // ASPECT-FIT, not clamped — the bounds shrink to a scaled-down VIEW
      // (400×225), the DPI zoom composes the fit (0.2083), and the readout
      // keeps claiming the TRUE preset the page sees + a fit note.
      fireEvent.change(screen.getByTestId("browser-preset-select"), { target: { value: "full-hd" } });
      await waitFor(() =>
        expect(calls.some((c) => c.path === "/api/v1/browser/viewport" && c.method === "PUT" && c.body?.preset === "full-hd")).toBe(true),
      );
      await waitFor(() => {
        const text = screen.getByTestId("browser-readout").textContent ?? "";
        expect(text).toContain("1920×1080");
        expect(text).toContain("fits");
        expect(text).not.toContain("clamped");
      });
      // The webview itself renders the SCALED footprint (400 wide, aspect
      // 1920:1080 → 225 high), centered in the 900-tall area.
      await waitFor(() =>
        expect(setBounds()).toHaveBeenLastCalledWith("tab-test-1", 80, 120 + (900 - 225) / 2, 400, 225),
      );
      // And the composed DPI zoom (fit 0.2083) was pushed to Rust — that is
      // what makes the PAGE see the full 1920×1080 CSS px.
      await waitFor(() =>
        expect(setZoom()).toHaveBeenCalledWith("tab-test-1", 0.20833333333333334),
      );

      // A preset that FITS (390×844 ≤ 400×900) keeps the plain readout and
      // a 1:1 footprint (no fit note, zoom stays the user's 1×).
      fireEvent.change(screen.getByTestId("browser-preset-select"), { target: { value: "mobile-md" } });
      await waitFor(() => {
        const text = screen.getByTestId("browser-readout").textContent ?? "";
        expect(text).toContain("390×844");
        expect(text).not.toContain("fits");
      });
      await waitFor(() =>
        expect(setBounds()).toHaveBeenLastCalledWith("tab-test-1", 80 + (400 - 390) / 2, 120 + (900 - 844) / 2, 390, 844),
      );
    } finally {
      rectSpy.mockRestore();
    }
  });

  // ── R60: REAL zoom (the Rust browser_tab_set_zoom command) ─────────────

  it("R60: zoom is REAL — creation re-asserts it, a zoom-select change drives browser_tab_set_zoom, and the bounds are NOT divided", async () => {
    const rectSpy = mockAreaRect();
    try {
      const tab = makeTab({ browserUrl: "https://example.com" });
      seedRightSidebar(tab);
      renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
      await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));
      // nativeCreate re-asserts the store's zoom (1× by default) right after
      // the webview exists — a re-created webview must be told the zoom.
      await waitFor(() => expect(setZoom()).toHaveBeenCalledWith("tab-test-1", 1));

      // Pick a preset that fits the 400×900 area, then zoom to 150%.
      fireEvent.change(screen.getByTestId("browser-preset-select"), { target: { value: "mobile-md" } });
      await waitFor(() =>
        expect(calls.some((c) => c.path === "/api/v1/browser/viewport" && c.method === "PUT" && c.body?.preset === "mobile-md")).toBe(true),
      );
      fireEvent.change(screen.getByTestId("browser-zoom-select"), { target: { value: "150" } });
      await waitFor(() => expect(setZoom()).toHaveBeenCalledWith("tab-test-1", 1.5));
      // The zoom PUT lands server-side (the agent's browser_control reads it).
      await waitFor(() =>
        expect(calls.some((c) => c.path === "/api/v1/browser/viewport" && c.method === "PUT" && c.body?.zoom === 1.5)).toBe(true),
      );

      // The webview keeps the preset's TRUE dims — the R50 divide-by-zoom
      // approximation is retired (390 stays 390, never 390/1.5 = 260).
      await waitFor(
        () => expect(setBounds()).toHaveBeenLastCalledWith("tab-test-1", 85, 148, 390, 844),
        { timeout: 2500 },
      );
      expect(setBounds().mock.calls.some((c) => c[3] < 300)).toBe(false);
      // …and the readout reports zoom as a DPI layer on top of the size.
      expect(screen.getByTestId("browser-readout").textContent).toContain("390×844 @ 150%");
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("R60/R62: the FIT button is honestly disabled in native mode — presets are auto-fitted to the panel (true size, scaled view)", async () => {
    const tab = makeTab({ browserUrl: "https://example.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));

    const fit = screen.getByTestId("browser-fit") as HTMLButtonElement;
    expect(fit.disabled).toBe(true);
    // The title explains WHY instead of leaving a dead button.
    expect(fit.title).toContain("automatically scaled to fit");
  });

  it("R60-D: a webview created while a popover suppresses the tab stays HIDDEN (the sidebar restores it later)", async () => {
    // An agent-driven tab open landing while the owner browses the quick
    // menu: the sidebar's hide invoke already fired as a Rust no-op (no
    // webview yet), so nativeCreate itself must refuse to show over the
    // popover — the module guard is the shared truth it consults.
    setPopoverWebviewSuppression("tab-test-1");
    const tab = makeTab({ browserUrl: "https://example.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));
    await waitFor(() => expect(setZoom()).toHaveBeenCalledWith("tab-test-1", 1));
    // Create resolved — but NO show over the popover.
    expect(setVisible()).not.toHaveBeenCalledWith("tab-test-1", true);

    // The popover closes (suppression cleared) → the next activation shows.
    setPopoverWebviewSuppression(null);
    fireEvent.change(screen.getByTestId("browser-address-input"), { target: { value: "https://example.com/two" } });
    fireEvent.submit((screen.getByTestId("browser-address-input") as HTMLInputElement).closest("form") as HTMLFormElement);
    await waitFor(() => expect(setVisible()).toHaveBeenCalledWith("tab-test-1", true));
  });

  it("R60: bounds re-sync IMMEDIATELY on preset changes and natural↔preset flips (deterministic sizing)", async () => {
    const rectSpy = mockAreaRect();
    vi.useFakeTimers();
    try {
      const tab = makeTab({ browserUrl: "https://example.com" });
      seedRightSidebar(tab);
      renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
      // Flush the mount + mint + create promise chain (microtask rounds),
      // then the rAF-debounced first sync. 20ms of fake time is FAR below
      // the 500ms safety-net interval — only the effect-driven re-sync
      // (deps: viewW/viewH/rotate/naturalSize) can land changes this fast.
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com");
      // Natural mode: the webview fills the area exactly.
      expect(setBounds()).toHaveBeenLastCalledWith("tab-test-1", 80, 120, 400, 900);

      // Preset mobile-md (390×844) fits → centered in the area.
      fireEvent.change(screen.getByTestId("browser-preset-select"), { target: { value: "mobile-md" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(setBounds()).toHaveBeenLastCalledWith("tab-test-1", 85, 148, 390, 844);

      // Back to natural → fills again, same immediacy (no waiting for the
      // 500ms safety net — the naturalSize dep re-syncs right away).
      fireEvent.change(screen.getByTestId("browser-preset-select"), { target: { value: "natural" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(setBounds()).toHaveBeenLastCalledWith("tab-test-1", 80, 120, 400, 900);
    } finally {
      vi.useRealTimers();
      rectSpy.mockRestore();
    }
  });

  it("ROUND-51: a REJECTED nativeTabCreate flips the panel into the proxy path for the rest of the mount", async () => {
    // The native backend is broken in this scenario (e.g. WebView2 runtime
    // missing): every create rejects.
    create().mockRejectedValue(new Error("webview2 backend gone"));
    const tab = makeTab({ browserUrl: "https://github.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));

    // The failure surfaces as an EXPLANATORY error card (R51-a copy), not
    // the old bare "Native browser failed: …" dead-end.
    const card = await screen.findByTestId("browser-error-card");
    expect(card.textContent).toContain("Native browser unavailable (webview2 backend gone)");
    expect(card.textContent).toContain("fell back to the proxied renderer");

    // The panel FLIPPED into web mode: the iframe renders the URL (the
    // store kept it), the placeholder is gone, and the badge is honest.
    await waitFor(() => expect(screen.getByTestId("browser-iframe")).toBeTruthy());
    expect(screen.getByTestId("browser-iframe").getAttribute("src")).toContain(encodeURIComponent("https://github.com"));
    expect(screen.queryByTestId("browser-native-placeholder")).toBeNull();

    // Further navigations stay on the proxy path — no more native calls.
    create().mockClear();
    const input = screen.getByTestId("browser-address-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(postCalls("/api/v1/browser/navigate").some((c) => c.body?.url === "https://example.com")).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("browser-iframe").getAttribute("src")).toContain(encodeURIComponent("https://example.com")));
    expect(create()).not.toHaveBeenCalled();
    // The mode-flip re-runs the mount effect, whose CLEANUP hides the
    // (never-created) webview — setVisible(tabId, false) once is expected
    // (Rust side: not-found = Ok, idempotent). What must NOT happen is any
    // further SHOW attempt: no setVisible(tabId, true) after the flip.
    expect(setVisible()).not.toHaveBeenCalledWith("tab-test-1", true);
  });

  // ── R62 (D8): the agent-browser command bridge handler ─────────────────

  it("R62: the native panel REGISTERS the bridge handler; eval runs browser_tab_eval and returns its envelope", async () => {
    nativeState.evalResult = { ok: true, value: { title: "Example Domain" } };
    nativeState.evalScripts = [];
    const tab = makeTab({ browserUrl: "https://example.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));
    await waitFor(() => expect(hasBrowserCommandHandler("tab-test-1")).toBe(true));

    // The agent's eval dispatch: script in, {ok,value} envelope out (the
    // bridge posts this as the command result; agent-core reads data.ok).
    const reply = await getBrowserCommandHandlerForTest("tab-test-1")!("eval", {
      script: "return document.title",
    });
    expect(reply.ok).toBe(true);
    expect(reply.data).toEqual({ ok: true, value: { title: "Example Domain" } });
    expect(nativeState.evalScripts).toEqual(["return document.title"]);
    expect(vi.mocked(nativeBrowser.nativeTabEval)).toHaveBeenCalledWith("tab-test-1", "return document.title");

    // Unmount unregisters — a stale handler must never answer for a gone
    // webview.
    cleanup();
    expect(hasBrowserCommandHandler("tab-test-1")).toBe(false);
  });

  it("R62: eval failures surface the page's error honestly (the {ok:false} envelope)", async () => {
    nativeState.evalResult = { ok: false, error: "SyntaxError: unexpected token" };
    const tab = makeTab({ browserUrl: "https://example.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));
    const reply = await getBrowserCommandHandlerForTest("tab-test-1")!("eval", {
      script: "return nope(",
    });
    expect(reply.ok).toBe(true); // the BRIDGE call worked…
    expect((reply.data as { ok: boolean; error: string }).ok).toBe(false); // …the PAGE rejected the script
    expect((reply.data as { error: string }).error).toContain("SyntaxError");
  });

  it("R62: screenshot_meta reports the panel's PHYSICAL-px region (rect × scale + window origin)", async () => {
    const rectSpy = mockAreaRect(); // 80,120 → 480,1020 (400×900 logical)
    nativeState.windowMetrics = { x: 1920, y: 0, scaleFactor: 2 };
    try {
      const tab = makeTab({ browserUrl: "https://example.com" });
      seedRightSidebar(tab);
      renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
      await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));

      const reply = await getBrowserCommandHandlerForTest("tab-test-1")!("screenshot_meta", {});
      expect(reply.ok).toBe(true);
      const data = reply.data as { supported: boolean; region: { x: number; y: number; w: number; h: number }; scaleFactor: number; mode: string };
      expect(data.supported).toBe(true);
      expect(data.mode).toBe("native");
      expect(data.scaleFactor).toBe(2);
      // (1920 + 80×2, 0 + 120×2, 400×2, 900×2) — the physical region the
      // computer-use backends capture (scrot/PowerShell are pixel-space).
      expect(data.region).toEqual({ x: 2080, y: 240, w: 800, h: 1800 });
    } finally {
      rectSpy.mockRestore();
      nativeState.windowMetrics = null;
    }
  });

  it("R62: screenshot_meta without window metrics still answers supported (region null → full-display fallback)", async () => {
    nativeState.windowMetrics = null;
    const tab = makeTab({ browserUrl: "https://example.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(create()).toHaveBeenCalledWith("tab-test-1", "https://example.com"));
    const reply = await getBrowserCommandHandlerForTest("tab-test-1")!("screenshot_meta", {});
    expect(reply.ok).toBe(true);
    expect((reply.data as { supported: boolean; region: unknown }).supported).toBe(true);
    expect((reply.data as { region: unknown }).region).toBeNull();
  });

  it("R62: web/proxy mode registers NO handler (eval is native-only; the bridge answers honestly instead)", async () => {
    nativeState.available = false;
    clearBrowserCommandHandlersForTest();
    const tab = makeTab({ browserUrl: "https://example.com" });
    seedRightSidebar(tab);
    renderWithProviders(<BrowserPanel projectId="prj_test" tab={tab} />);
    await waitFor(() => expect(postCalls("/api/v1/browser/session")).toHaveLength(1));
    expect(hasBrowserCommandHandler("tab-test-1")).toBe(false);
  });
});
