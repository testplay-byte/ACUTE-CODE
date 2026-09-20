// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  THEMES,
  applyServerAppearance,
  applyTheme,
  hydrateAppearanceFromServer,
  resetAppearanceHydrationForTest,
  resolveThemeMode,
  usePrefersColorSchemeDark,
  useThemeStore,
} from "./theme-store";
import { useConfigStore } from "./config-store";

function reset() {
  localStorage.clear();
  useThemeStore.setState({
    themeId: "nova",
    mode: "dark",
    density: "comfortable",
    sidebarTint: "subtle",
    activityMode: "detailed",
    chatTextSize: "medium",
    timestampsMode: "hidden",
  });
}

beforeEach(() => {
  reset();
  resetAppearanceHydrationForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  // Back to the demo defaults so nothing after a live-mode test fires PUTs.
  useConfigStore.setState({ demoData: true, token: null });
});

describe("theme store", () => {
  it("defaults to nova dark", () => {
    const { themeId, mode } = useThemeStore.getState();
    expect(themeId).toBe("nova");
    expect(mode).toBe("dark");
  });

  it("toggleMode flips light/dark", () => {
    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe("light");
    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe("dark");
  });

  it("setTheme switches to a catalog theme", () => {
    useThemeStore.getState().setTheme("bento");
    expect(useThemeStore.getState().themeId).toBe("bento");
  });

  it("persists theme and mode to localStorage (zustand persist)", () => {
    useThemeStore.getState().setTheme("bento");
    useThemeStore.getState().setMode("light");
    const raw = localStorage.getItem("acute-code.theme");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state).toEqual({
      themeId: "bento",
      mode: "light",
      density: "comfortable",
      sidebarTint: "subtle",
      activityMode: "detailed",
      chatTextSize: "medium",
      timestampsMode: "hidden",
    });
  });

  // R97-H: the chat customizability pair — text size + timestamps.
  it("defaults to medium text + hidden timestamps (the pre-R97 look)", () => {
    const s = useThemeStore.getState();
    expect(s.chatTextSize).toBe("medium");
    expect(s.timestampsMode).toBe("hidden");
  });

  it("setChatTextSize / setTimestampsMode flip and persist", () => {
    useThemeStore.getState().setChatTextSize("large");
    useThemeStore.getState().setTimestampsMode("hover");
    expect(useThemeStore.getState().chatTextSize).toBe("large");
    expect(useThemeStore.getState().timestampsMode).toBe("hover");
    const raw = JSON.parse(localStorage.getItem("acute-code.theme")!);
    expect(raw.state.chatTextSize).toBe("large");
    expect(raw.state.timestampsMode).toBe("hover");
  });

  it("applyTheme mirrors the store onto the document element", () => {
    applyTheme("bento", "light");
    expect(document.documentElement.dataset.theme).toBe("bento");
    expect(document.documentElement.dataset.mode).toBe("light");
  });

  it("catalog has at least two accent themes including nova", () => {
    expect(THEMES.map((t) => t.id)).toContain("nova");
    expect(THEMES.length).toBeGreaterThanOrEqual(2);
  });
});

// ── ROUND-113 (R113-b): "system" mode resolution ─────────────────────────────

describe("R113-b: system mode resolution", () => {
  it("resolveThemeMode passes concrete light/dark through", () => {
    expect(resolveThemeMode("light")).toBe("light");
    expect(resolveThemeMode("dark")).toBe("dark");
  });

  it("system resolves against prefers-color-scheme", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    expect(resolveThemeMode("system")).toBe("dark");
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    expect(resolveThemeMode("system")).toBe("light");
  });

  it("system without a usable matchMedia resolves LIGHT (the CSS fallback's default)", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue(undefined as unknown as MediaQueryList);
    expect(resolveThemeMode("system")).toBe("light");
  });

  it("applyTheme writes the RESOLVED mode onto data-mode (CSS keys on light/dark only)", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    applyTheme("nova", "system");
    expect(document.documentElement.dataset.mode).toBe("dark");
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    applyTheme("nova", "system");
    expect(document.documentElement.dataset.mode).toBe("light");
  });

  it("usePrefersColorSchemeDark re-renders on a LIVE OS flip (a system desktop follows the OS)", () => {
    const listeners = new Set<() => void>();
    const mql = {
      matches: false,
      addEventListener: (_kind: unknown, cb: () => void) => {
        listeners.add(cb);
      },
      removeEventListener: (_kind: unknown, cb: () => void) => {
        listeners.delete(cb);
      },
    };
    vi.spyOn(window, "matchMedia").mockReturnValue(mql as unknown as MediaQueryList);

    const { result } = renderHook(() => usePrefersColorSchemeDark());
    expect(result.current).toBe(false);

    mql.matches = true;
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(result.current).toBe(true);
  });
});

// ── ROUND-113 (R113-b): the server-backed appearance ─────────────────────────

/** Live-mode config + a routed fetch stub recording every call. */
function liveModeFetchStub(routes: {
  get?: unknown;
  putStatus?: number;
} = {}): { calls: Array<{ url: string; method: string; body?: string }> } {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/settings/appearance")) {
        if (method === "GET") {
          return new Response(JSON.stringify(routes.get ?? { themeId: null, mode: "system" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ themeId: "x", mode: "system" }), {
          status: routes.putStatus ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }),
  );
  useConfigStore.setState({ demoData: false, baseUrl: "http://sidecar.test", token: "tok_123" });
  return { calls };
}

describe("R113-b: server-backed appearance (hydration + write-through + echo guard)", () => {
  it("hydrateAppearanceFromServer applies the server's themeId and mode on boot", async () => {
    const { calls } = liveModeFetchStub({ get: { themeId: "bento", mode: "light" } });

    await hydrateAppearanceFromServer();

    expect(useThemeStore.getState().themeId).toBe("bento");
    expect(useThemeStore.getState().mode).toBe("light");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://sidecar.test/api/v1/settings/appearance",
      method: "GET",
    });
  });

  it("a server themeId of null keeps the LOCAL flavor (no preference) while mode still applies", async () => {
    liveModeFetchStub({ get: { themeId: null, mode: "dark" } });
    useThemeStore.setState({ themeId: "clay" });

    await hydrateAppearanceFromServer();

    expect(useThemeStore.getState().themeId).toBe("clay");
    expect(useThemeStore.getState().mode).toBe("dark");
  });

  it("the hydration is memoized — a second call never re-fetches", async () => {
    const { calls } = liveModeFetchStub({ get: { themeId: "bento", mode: "light" } });

    await hydrateAppearanceFromServer();
    await hydrateAppearanceFromServer();

    expect(calls).toHaveLength(1);
  });

  it("a failed GET keeps the local values (silent no-op — the offline fallback)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    useConfigStore.setState({ demoData: false, baseUrl: "http://sidecar.test", token: "tok_123" });

    await expect(hydrateAppearanceFromServer()).resolves.toBeUndefined();
    expect(useThemeStore.getState().themeId).toBe("nova");
    expect(useThemeStore.getState().mode).toBe("dark");
  });

  it("demo mode hydrates without any network (the local store stands alone)", async () => {
    useConfigStore.setState({ demoData: true, token: null });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await hydrateAppearanceFromServer();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useThemeStore.getState().themeId).toBe("nova");
  });

  it("local setTheme/setMode write through: an optimistic PUT fires with the new value", () => {
    const { calls } = liveModeFetchStub();

    useThemeStore.getState().setTheme("bento");
    useThemeStore.getState().setMode("system");

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({ url: "http://sidecar.test/api/v1/settings/appearance" });
    expect(JSON.parse(puts[0].body!)).toEqual({ themeId: "bento" });
    expect(JSON.parse(puts[1].body!)).toEqual({ mode: "system" });
  });

  it("a FAILED write-through is a silent no-op — the local flip stays, nothing throws", () => {
    liveModeFetchStub({ putStatus: 400 });

    expect(() => {
      useThemeStore.getState().setTheme("bento");
    }).not.toThrow();
    expect(useThemeStore.getState().themeId).toBe("bento");
  });

  it("toggleMode write-throughs too (the wizard's mode toggle converges like setMode)", () => {
    const { calls } = liveModeFetchStub();

    useThemeStore.getState().toggleMode(); // dark → light

    expect(useThemeStore.getState().mode).toBe("light");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0].body!)).toEqual({ mode: "light" });
  });

  it("applying a SERVER-pushed value does NOT echo the PUT back (infinite-loop guard)", () => {
    const { calls } = liveModeFetchStub();

    applyServerAppearance({ themeId: "clay", mode: "light" });

    expect(useThemeStore.getState().themeId).toBe("clay");
    expect(useThemeStore.getState().mode).toBe("light");
    // The store applied the remote value with ZERO outgoing PUTs.
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("applyServerAppearance is shape-checked: garbage values never touch the store", () => {
    liveModeFetchStub();

    applyServerAppearance("not-an-object");
    applyServerAppearance({ themeId: 42, mode: "neon" });
    applyServerAppearance({ themeId: "bento", mode: "blueprint" });

    expect(useThemeStore.getState().themeId).toBe("nova");
    expect(useThemeStore.getState().mode).toBe("dark");
  });
});

// ── ROUND-114 (R114-e): the appearance domain's four CHAT fields go live-synced
// (owner: PC settings should propagate to the phone — and vice versa). The
// setters write through under the SERVER field spellings, the server value
// applies all five fields under one echo guard, and a present-but-invalid
// value rejects the WHOLE frame (a half-applied patch would leave the devices
// disagreeing). ──
describe("R114-e: the four chat fields join the synced appearance domain", () => {
  it("setDensity/setChatTextSize/setTimestampsMode/setActivityMode write through ONE-FIELD partial PUTs under the server spellings", () => {
    const { calls } = liveModeFetchStub();

    useThemeStore.getState().setDensity("compact");
    useThemeStore.getState().setChatTextSize("large");
    useThemeStore.getState().setTimestampsMode("hover");
    useThemeStore.getState().setActivityMode("compact");

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(4);
    // The server domain spells density "chatDensity" and activity "toolActivity"
    // (R114-b); text size + timestamps keep their local names.
    expect(JSON.parse(puts[0].body!)).toEqual({ chatDensity: "compact" });
    expect(JSON.parse(puts[1].body!)).toEqual({ chatTextSize: "large" });
    expect(JSON.parse(puts[2].body!)).toEqual({ timestampsMode: "hover" });
    expect(JSON.parse(puts[3].body!)).toEqual({ toolActivity: "compact" });
    // Optimistic first: every local flip landed before the PUT fired.
    expect(useThemeStore.getState().density).toBe("compact");
    expect(useThemeStore.getState().chatTextSize).toBe("large");
    expect(useThemeStore.getState().timestampsMode).toBe("hover");
    expect(useThemeStore.getState().activityMode).toBe("compact");
  });

  it("setSidebarTint stays LOCAL-ONLY (not part of the server domain — zero PUTs)", () => {
    const { calls } = liveModeFetchStub();

    useThemeStore.getState().setSidebarTint("bold");

    expect(useThemeStore.getState().sidebarTint).toBe("bold");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("hydrateAppearanceFromServer converges the chat fields on boot (the server wins when reachable)", async () => {
    liveModeFetchStub({
      get: {
        themeId: "bento",
        mode: "light",
        chatDensity: "compact",
        chatTextSize: "small",
        timestampsMode: "hover",
        toolActivity: "hidden",
      },
    });

    await hydrateAppearanceFromServer();

    expect(useThemeStore.getState().themeId).toBe("bento");
    expect(useThemeStore.getState().mode).toBe("light");
    expect(useThemeStore.getState().density).toBe("compact");
    expect(useThemeStore.getState().chatTextSize).toBe("small");
    expect(useThemeStore.getState().timestampsMode).toBe("hover");
    expect(useThemeStore.getState().activityMode).toBe("hidden");
  });

  it("a pre-R114-b server row (the four fields ABSENT) leaves every local value standing", async () => {
    liveModeFetchStub({ get: { themeId: "bento", mode: "light" } });
    useThemeStore.setState({
      density: "compact",
      chatTextSize: "large",
      timestampsMode: "hover",
      activityMode: "hidden",
    });

    await hydrateAppearanceFromServer();

    // Backward compat: an absent field never touches its local twin.
    expect(useThemeStore.getState().density).toBe("compact");
    expect(useThemeStore.getState().chatTextSize).toBe("large");
    expect(useThemeStore.getState().timestampsMode).toBe("hover");
    expect(useThemeStore.getState().activityMode).toBe("hidden");
  });

  it("applyServerAppearance applies ALL FIVE fields live with ZERO echo PUTs (a phone flip lands on the desktop)", () => {
    const { calls } = liveModeFetchStub();

    applyServerAppearance({
      themeId: "clay",
      mode: "dark",
      chatDensity: "compact",
      chatTextSize: "large",
      timestampsMode: "hover",
      toolActivity: "compact",
    });

    expect(useThemeStore.getState().themeId).toBe("clay");
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().density).toBe("compact");
    expect(useThemeStore.getState().chatTextSize).toBe("large");
    expect(useThemeStore.getState().timestampsMode).toBe("hover");
    expect(useThemeStore.getState().activityMode).toBe("compact");
    // The echo guard: nothing bounced back to the bus.
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("a PARTIAL live frame (one field) applies just that field — the rest stand", () => {
    liveModeFetchStub();
    useThemeStore.setState({ density: "comfortable", chatTextSize: "large" });

    applyServerAppearance({ chatTextSize: "small" });

    expect(useThemeStore.getState().chatTextSize).toBe("small");
    expect(useThemeStore.getState().density).toBe("comfortable");
  });

  it("a present-but-INVALID chat field rejects the WHOLE frame (malformed is malformed — no half-applied patch)", () => {
    liveModeFetchStub();

    applyServerAppearance({ themeId: "bento", chatDensity: "cozy" });
    applyServerAppearance({ chatTextSize: "XL" });
    applyServerAppearance({ timestampsMode: "always" });
    applyServerAppearance({ toolActivity: "verbose" });

    // themeId was valid in the first frame but rides the same rejection.
    expect(useThemeStore.getState().themeId).toBe("nova");
    expect(useThemeStore.getState().chatTextSize).toBe("medium");
    expect(useThemeStore.getState().timestampsMode).toBe("hidden");
    expect(useThemeStore.getState().activityMode).toBe("detailed");
    expect(useThemeStore.getState().density).toBe("comfortable");
  });
});
