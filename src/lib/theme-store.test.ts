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
